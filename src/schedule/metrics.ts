/**
 * Lyra · 周末复盘工程指标真实采集（P5 准备 W27: code-writer-pro）。
 * 补 W20 登记缺口："真实指标采集不在本面"——本模块把 weekend-runner 的三个注入端口
 * （collectProcessMetrics / checkArtifactIntegrity / refreshGapList）落为真实实现：
 *   - permit 各态计数 / 按窗完成：exec_permit 本周行（分母 = 本周出现过的业务键数，
 *     分子 = J permit 窗内 SUCCEEDED 的业务键数——A+J 恰两次调用构成一次研究）；
 *   - 事件检测命中：events 本周新增行（created_at 口径；整批回填日失真如实注明，
 *     生产语义 = 检测落库时刻）；
 *   - 封存新增数：seal_manifest 本周新行——W26 幂等复用下新行 ⇔ 材料真实变化，
 *     故新增行数即"材料变化才计"的封存新增数；
 *   - DATA_GAP 刷新：具名缺口清单 = seal_manifest.gaps 的去重并集（封存 manifest 的
 *     显式缺口列表是 DATA-SOURCES §3 的登记面）；本周新增 = 本周新封存中出现而
 *     本周前未登记过的具名缺口；
 *   - 原件完整性抽查：随机（种子化，同窗可复现）抽 N 个 seal_manifest（N 默认 5），
 *     每个封存的全部 artifact 哈希在原件库做哈希校验读（readBytes 内建重算比对）。
 * SC-11.4 纪律：本模块只产出工程与流程质量指标，不含任何效果评价字段；
 * 不可从库面观测的量（send-once 拒绝：拒绝抛错不落行）显式置 null 并注明，不猜零。
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ArtifactStore } from '../artifacts/store.js';
import type { PermitState } from '../contracts.js';
import { ScheduleError, shanghaiInstant, shanghaiWall, shanghaiWeekday } from './windows.js';
import type { IntegrityCheckResult, WeekendProcessMetrics } from './weekend.js';

/** 指标采集具名错误（code 为稳定错误名）。 */
export class MetricsError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'MetricsError';
  }
}

/** 周窗口：[weekStart, weekEnd) 半开区间，ISO 时刻。 */
export interface MetricsWeekWindow {
  weekStart: string;
  weekEnd: string;
}

/**
 * 周六复盘日的所属周窗口（上海墙钟）：weekStart = 本周一 00:00+08，
 * weekEnd = 下周一 00:00+08（含周六复盘触发日全天， permi 周六晚产生仍计入本周）。
 */
export function weekWindowOfSaturday(saturday: string): MetricsWeekWindow {
  const weekday = shanghaiWeekday(saturday);
  if (weekday !== 6) {
    throw new ScheduleError('WEEKEND_NOT_SATURDAY', `${saturday} 非周六（周窗口按周六复盘日归属计算）`);
  }
  // 周六回退 5 天为周一；日期换算走上海墙钟（toISOString 是 UTC，会差一天）
  const monday = shanghaiWall(new Date(shanghaiInstant(saturday, '00:00:00').getTime() - 5 * 86_400_000)).date;
  const nextMonday = shanghaiWall(new Date(shanghaiInstant(monday, '00:00:00').getTime() + 7 * 86_400_000)).date;
  return { weekStart: shanghaiInstant(monday, '00:00:00').toISOString(), weekEnd: shanghaiInstant(nextMonday, '00:00:00').toISOString() };
}

/** 抽查缺省抽样数（派发冻结：N=5）。 */
export const DEFAULT_INTEGRITY_SAMPLE_SEALS = 5;

// ===== 端口 ①：原件完整性抽查 =====

/** 抽查输入的最小封存视图（seal_id + 全部原件哈希）。 */
export interface IntegritySealSample {
  sealId: string;
  artifactSha256s: readonly string[];
}

export interface IntegrityCheckOptions {
  /** 抽样数（默认 5）；大于候选集时全查。 */
  sampleSize?: number;
  /** 抽样种子（默认空串；同种子同候选集 → 同样本，可复现）。 */
  seed?: string;
}

/**
 * 原件完整性抽查（SC-11.3 ①）：从候选封存集中种子化随机抽 sampleSize 个，
 * 对每个封存的全部 artifact 哈希做哈希校验读（store.readBytes 重算 sha256 比对，
 * 不符 HASH_MISMATCH / 缺失 ARTIFACT_MISSING）。checked = 实际校验的原件个数。
 */
export async function checkArtifactIntegrity(
  store: ArtifactStore,
  seals: readonly IntegritySealSample[],
  options?: IntegrityCheckOptions,
): Promise<IntegrityCheckResult> {
  const sampleSize = options?.sampleSize ?? DEFAULT_INTEGRITY_SAMPLE_SEALS;
  const seed = options?.seed ?? '';
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new MetricsError('INTEGRITY_SAMPLE_INVALID', `sampleSize=${String(sampleSize)}`);
  }
  // 种子化随机抽样：按 sha256(seed:sealId) 排序取前 N（确定性可复现的"随机"）
  const ordered = [...seals].sort((a, b) => {
    const ha = createHash('sha256').update(`${seed}:${a.sealId}`).digest('hex');
    const hb = createHash('sha256').update(`${seed}:${b.sealId}`).digest('hex');
    return ha === hb ? (a.sealId < b.sealId ? -1 : 1) : ha < hb ? -1 : 1;
  });
  const sampled = ordered.slice(0, sampleSize);
  const result: IntegrityCheckResult = { checked: 0, missing: [], corrupted: [] };
  for (const seal of sampled) {
    for (const sha256 of seal.artifactSha256s) {
      try {
        await store.readBytes(sha256); // 内建哈希重算比对，不符即抛
        result.checked += 1;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const entry = { sha256, label: seal.sealId };
        if (code === 'ARTIFACT_MISSING') result.missing.push(entry);
        else result.corrupted.push(entry);
      }
    }
  }
  return result;
}

// ===== 端口 ②：缺口清单刷新 =====

interface SealGapRow {
  seal_id: string;
  gaps: unknown;
  created_at: Date;
  artifact_refs: unknown;
}

function namedGapsOf(row: SealGapRow): string[] {
  if (!Array.isArray(row.gaps)) throw new MetricsError('SEAL_ROW_CORRUPT', `seal ${row.seal_id} gaps 非数组`);
  return (row.gaps as unknown[]).filter((g): g is string => typeof g === 'string');
}

/**
 * 缺口清单刷新（SC-11.3 ②）：当前具名缺口清单 = 全部封存 manifest 显式缺口列表的
 * 去重并集（DATA-SOURCES §3 登记面），字典序稳定输出（读回可见）。
 */
export async function refreshGapList(pool: Pool): Promise<string[]> {
  const res = await pool.query<SealGapRow>('select seal_id, gaps, created_at, artifact_refs from seal_manifest');
  const names = new Set<string>();
  for (const row of res.rows) {
    for (const g of namedGapsOf(row)) names.add(g);
  }
  return [...names].sort();
}

// ===== 端口 ③：过程指标（SC-11.4）=====

/** 本周 permit 面明细（exec_permit 真实行聚合）。 */
export interface PermitWeekStats {
  total: number;
  byState: Record<PermitState, number>;
  simulatedTrue: number;
  simulatedFalse: number;
  /** 周度类调用量（research_kind ≠ POST_EVENT；含 WEEKLY / PRE_EVENT）。 */
  weeklyCalls: number;
  /** 事件后调用量（research_kind = POST_EVENT）。 */
  postEventCalls: number;
  /** 本周出现过的业务键数（一次研究 = 同键 A+J 两次调用）。 */
  researchKeys: number;
  /** 其中 J permit 窗内 SUCCEEDED（且非 LATE_COMPLETED）的业务键数。 */
  researchKeysOnWindowCompleted: number;
  /** 未按窗完成：FAILED/DEADLINE_EXCEEDED + SUCCEEDED/LATE_COMPLETED（迟到诚实记时）。 */
  notOnWindow: number;
  /**
   * send-once 拒绝计数。null = 库面不可观测：BUSINESS_KEY_ALREADY_SENT 抛错不落行
   * （EK-4.1 唯一约束兜底，拒绝无行可数）——如实声明，不猜零。运行期观测归执行器日志。
   */
  sendOnceRejections: number | null;
}

export interface AdmissionWeekStats {
  /** SC-6.2 溢出降级（POST_EVENT_DEGRADED 本周新增准入数）。 */
  overflowDegraded: number;
  /** 具名阻断准入数（annotation 以 BLOCKED: 开头；W27 nightly commit 落 BLOCKED:MODEL_PROVIDER_UNAUTHORIZED）。 */
  blocked: number;
  /** 顺延堆积（全库未发送的 WEEKLY_DEFERRED 数；跨周口径）。 */
  deferredPending: number;
}

/** 采集明细（工程面；不进周报字段白名单，供审计与日志）。 */
export interface ProcessMetricsDetail {
  weekStart: string;
  weekEnd: string;
  permits: PermitWeekStats;
  /** 事件检测命中（events 本周 created_at 新增）。 */
  eventsDetected: number;
  /** 封存新增（seal_manifest 本周新行；W26 下 ⇔ 材料真实变化）。 */
  sealsAdded: number;
  gaps: { previousNamed: string[]; addedThisWeek: string[] };
  admissions: AdmissionWeekStats;
  /** 本次顺带执行的完整性抽查（store 未提供时为 null，不猜）。 */
  integrity: IntegrityCheckResult | null;
  /** 口径与不可观测面声明（诚实边界）。 */
  honestyNotes: string[];
}

/** 周报工程指标对象：W17 WeekendProcessMetrics 端口字段 + W27 采集明细。 */
export interface WeeklyProcessMetricsReport extends WeekendProcessMetrics {
  detail: ProcessMetricsDetail;
}

export interface CollectProcessMetricsOptions extends MetricsWeekWindow {
  /** 原件库（提供则顺带执行完整性抽查，计入 detail.integrity）。 */
  store?: ArtifactStore;
  /** 抽样数（默认 5）。 */
  integritySampleSize?: number;
}

interface PermitWeekRow {
  state: string;
  fail_code: string | null;
  simulated: boolean;
  research_kind: string;
  subject_kind: string;
  subject: string;
  cutoff: Date;
  stage: string;
  deadline: Date;
  settled_at: Date | null;
}

function emptyByState(): Record<PermitState, number> {
  return { PREPARED: 0, SENT: 0, UNKNOWN: 0, SUCCEEDED: 0, FAILED: 0 };
}

/** permit 周内行 → 周统计（小行数全量拉取后内存聚合，口径集中一处）。 */
function permitStatsOf(rows: readonly PermitWeekRow[]): PermitWeekStats {
  const byState = emptyByState();
  const stats: PermitWeekStats = {
    total: rows.length,
    byState,
    simulatedTrue: 0,
    simulatedFalse: 0,
    weeklyCalls: 0,
    postEventCalls: 0,
    researchKeys: 0,
    researchKeysOnWindowCompleted: 0,
    notOnWindow: 0,
    sendOnceRejections: null,
  };
  // 业务键 → J permit 是否窗内 SUCCEEDED
  const keys = new Map<string, boolean>();
  for (const r of rows) {
    const state = r.state as PermitState;
    if (state in byState) byState[state] += 1;
    if (r.simulated) stats.simulatedTrue += 1;
    else stats.simulatedFalse += 1;
    if (r.research_kind === 'POST_EVENT') stats.postEventCalls += 1;
    else stats.weeklyCalls += 1;
    if (
      (state === 'FAILED' && r.fail_code === 'DEADLINE_EXCEEDED') ||
      (state === 'SUCCEEDED' && r.fail_code === 'LATE_COMPLETED')
    ) {
      stats.notOnWindow += 1;
    }
    const key = `${r.subject_kind}/${r.subject}/${r.research_kind}/${r.cutoff.toISOString()}`;
    if (!keys.has(key)) keys.set(key, false);
    if (r.stage === 'J' && state === 'SUCCEEDED' && r.fail_code !== 'LATE_COMPLETED' && r.settled_at !== null) {
      const inWindow = r.settled_at.getTime() <= r.deadline.getTime();
      if (inWindow) keys.set(key, true);
    }
  }
  stats.researchKeys = keys.size;
  for (const done of keys.values()) {
    if (done) stats.researchKeysOnWindowCompleted += 1;
  }
  return stats;
}

/**
 * 真实工程指标采集（SC-11.4 端口实现；SC-11 白名单内——不含任何效果评价字段）。
 * window = [weekStart, weekEnd)；建议经 weekWindowOfSaturday 由周六复盘日推导。
 */
export async function collectProcessMetrics(
  pool: Pool,
  opts: CollectProcessMetricsOptions,
): Promise<WeeklyProcessMetricsReport> {
  for (const field of ['weekStart', 'weekEnd'] as const) {
    const v = new Date(opts[field]);
    if (Number.isNaN(v.getTime())) throw new MetricsError('METRICS_WINDOW_INVALID', `${field}=${opts[field]}`);
  }
  if (new Date(opts.weekStart).getTime() >= new Date(opts.weekEnd).getTime()) {
    throw new MetricsError('METRICS_WINDOW_INVALID', `weekStart >= weekEnd（${opts.weekStart} / ${opts.weekEnd}）`);
  }

  // ① permit 面（exec_permit 本周行；created_at = 当前尝试时刻，冲突替换时刷新）
  const permits = await pool.query<PermitWeekRow>(
    `select state, fail_code, simulated, research_kind, subject_kind, subject, cutoff, stage, deadline, settled_at
     from exec_permit where created_at >= $1 and created_at < $2 order by created_at, permit_id`,
    [opts.weekStart, opts.weekEnd],
  );
  const permitStats = permitStatsOf(permits.rows);

  // ② 事件检测命中（events 本周新增；created_at 口径）
  const events = await pool.query<{ n: string }>(
    'select count(*)::text as n from events where created_at >= $1 and created_at < $2',
    [opts.weekStart, opts.weekEnd],
  );

  // ③ 封存新增 + 具名缺口（本周前登记 vs 本周新登记）
  const seals = await pool.query<SealGapRow>('select seal_id, gaps, created_at, artifact_refs from seal_manifest');
  const previousNamed = new Set<string>();
  const thisWeekNamed = new Set<string>();
  let sealsAdded = 0;
  for (const row of seals.rows) {
    const created = row.created_at.getTime();
    const inWeek = created >= new Date(opts.weekStart).getTime() && created < new Date(opts.weekEnd).getTime();
    if (inWeek) sealsAdded += 1;
    for (const g of namedGapsOf(row)) {
      if (created < new Date(opts.weekStart).getTime()) previousNamed.add(g);
      else if (inWeek) thisWeekNamed.add(g);
    }
  }

  // ④ 准入面（schedule_admission：溢出降级 / 具名阻断 / 顺延堆积）
  const admissionsWeek = await pool.query<{ queue_class: string; annotation: string | null }>(
    `select queue_class, annotation from schedule_admission where first_queued_at >= $1 and first_queued_at < $2`,
    [opts.weekStart, opts.weekEnd],
  );
  let overflowDegraded = 0;
  let blocked = 0;
  for (const row of admissionsWeek.rows) {
    if (row.queue_class === 'POST_EVENT_DEGRADED') overflowDegraded += 1;
    if (row.annotation !== null && row.annotation.startsWith('BLOCKED:')) blocked += 1;
  }
  const deferred = await pool.query<{ n: string }>(
    `select count(*)::text as n from schedule_admission where queue_class = 'WEEKLY_DEFERRED' and sent = false`,
  );

  // ⑤ 原件完整性抽查（store 提供时顺带执行；种子 = weekStart，同窗可复现）
  let integrity: IntegrityCheckResult | null = null;
  if (opts.store !== undefined) {
    const candidates: IntegritySealSample[] = seals.rows.map((row) => ({
      sealId: row.seal_id,
      artifactSha256s: Array.isArray(row.artifact_refs)
        ? (row.artifact_refs as { sha256?: unknown }[]).map((r) => String(r.sha256 ?? ''))
        : [],
    }));
    integrity = await checkArtifactIntegrity(opts.store, candidates, {
      sampleSize: opts.integritySampleSize ?? DEFAULT_INTEGRITY_SAMPLE_SEALS,
      seed: opts.weekStart,
    });
  }

  const honestyNotes = [
    'paused 恒 0：暂停上报（SC-8.4 STOP_AND_PAUSE_REPORT）无落库登记面，未观测 ≠ 无暂停',
    'sendOnceRejections 为 null：send-once 拒绝抛错不落行，库面不可观测（EK-4.1 唯一约束兜底）',
    '事件命中按 events.created_at（检测落库时刻）；整批回填日该口径失真，如实注明',
    '封存新增按 seal_manifest 新行计数（W26 幂等复用下新行 ⇔ 材料真实变化）',
  ];

  const detail: ProcessMetricsDetail = {
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
    permits: permitStats,
    eventsDetected: Number(events.rows[0]?.n ?? 0),
    sealsAdded,
    gaps: {
      previousNamed: [...previousNamed].sort(),
      addedThisWeek: [...thisWeekNamed].filter((g) => !previousNamed.has(g)).sort(),
    },
    admissions: {
      overflowDegraded,
      blocked,
      deferredPending: Number(deferred.rows[0]?.n ?? 0),
    },
    integrity,
    honestyNotes,
  };

  return {
    windowCompletion: {
      onWindowCompleted: permitStats.researchKeysOnWindowCompleted,
      total: permitStats.researchKeys,
    },
    overflowDegraded: detail.admissions.overflowDegraded,
    notOnWindow: permitStats.notOnWindow,
    unknown: permitStats.byState.UNKNOWN,
    paused: 0,
    blocked: detail.admissions.blocked,
    weeklyModelCalls: permitStats.weeklyCalls,
    postEventModelCalls: permitStats.postEventCalls,
    deferredBacklog: detail.admissions.deferredPending,
    gapListPrevious: detail.gaps.previousNamed,
    detail,
  };
}

/** 从库内封存集抽查（weekend-runner 默认端口形态：无参调用；种子缺省取当前时刻，每次抽查样本轮换）。 */
export async function checkArtifactIntegrityFromDb(
  pool: Pool,
  store: ArtifactStore,
  options?: IntegrityCheckOptions,
): Promise<IntegrityCheckResult> {
  const res = await pool.query<SealGapRow>('select seal_id, gaps, created_at, artifact_refs from seal_manifest');
  const candidates: IntegritySealSample[] = res.rows.map((row) => ({
    sealId: row.seal_id,
    artifactSha256s: Array.isArray(row.artifact_refs)
      ? (row.artifact_refs as { sha256?: unknown }[]).map((r) => String(r.sha256 ?? ''))
      : [],
  }));
  return checkArtifactIntegrity(store, candidates, {
    ...options,
    seed: options?.seed ?? new Date().toISOString(),
  });
}
