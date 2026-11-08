/**
 * Lyra · 每交易日晚间研究循环骨架（P5 准备 W27: code-writer-pro）。
 * 补 W17 登记缺口："晚间研究循环的生产接线属总控整合面"——本模块给出 P5 前瞻观察的
 * 日引擎骨架：W17 轮转（当晚 6 只）+ 当日事件命中合并（SC-3.2）+ 预算闸与 holder 纪律
 * + A→程序清单→J→结论落库（复用 W11 组装器 / W12 传输选择 / W3 结论对象 / W20 事件后编排）。
 *
 * 两级安全设计（派发冻结）：
 *   - --dry（缺省）：全链到 prompt 为止（组装 + 输入哈希/字节），零 permit、零结论、
 *     零调度表写入；不做任何模型调用。组装本身经 W26 幂等封存（同材料复用，不重复落行）。
 *   - --commit（显式）：真实落 permit + 结论，一切落库物带 planAuthVersion=pa-p5-skeleton
 *     演练身份（conclusion 表无演练标记列，版本轴前缀即约定标识，CLI 输出注明）；
 *     调度准入（schedule_plan / schedule_admission）同版本落档，供周末指标真实采集。
 *     周度截点 = 当晚 18:00:00+08 的确定性排程时刻（重放可复现；生产语义 = 实际排程时刻，
 *     SC-3.4）——同晚重复 --commit 同标的会被 send-once 拒绝（FAILED 具名，不重发）。
 *     注意：POST_EVENT 业务键（标的 × 事件时点）被 skeleton 结论占用后，该事件的真实
 *     研究将被 send-once 拒绝——CLI 输出显式告警。
 *
 * 真实通道永不隐式调用：transport=real 时 selectTransport('real') 得 UnauthorizedTransport，
 * 每标的记 BLOCKED / MODEL_PROVIDER_UNAUTHORIZED（不入 permit 表，不组装），继续下一标的。
 * holder 纪律（EK-2.1）：commit 模式整晚持执行锁（条目间心跳续租），runModelCall 带 holderId。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { calendarCoverage, isTradingDay, loadTradeCalendarTable, tradingDaysBetween, type TradeCalendarTable } from '../adapters/calendar.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createPool } from '../db/pool.js';
import { canonicalSha256 } from '../canonical.js';
import { withTransaction } from '../db/exec.js';
import { assertLease } from '../kernel/lease.js';
import { loadPriorResearch, validatePostEventContext, withPostEventContext, type PostEventContext } from '../research/inheritance.js';
import { loadFact } from '../pintime/facts.js';
import { type ResearchSnapshot } from '../research/gate-m-checkpoint.js';
import { validDispositions, type AOutput, type JOutput, type PlanAuthBudget, type SubjectKind } from '../contracts.js';
import { readConclusion } from '../db/conclusion.js';
import { persistResearchConclusion } from '../research/trace.js';
import { buildARequest, buildJRequest } from '../research/requests.js';
import { validateResearchA, validateResearchJ } from '../research/validation.js';
import { backfillSettlement } from '../conclusion/settlement.js';
import { runGateM } from '../research/gate-m.js';
import { acquireExecutorLock, releaseExecutorLock } from '../kernel/lock.js';
import { keepLeaseAlive, type ExecutionLease } from '../kernel/lease.js';
import { preflightTransport, selectTransport, UnauthorizedTransport, type ModelTransport } from '../kernel/transport.js';
import { SolTransport } from '../kernel/sol-transport.js';
import { deriveChecklist } from '../research/checklist.js';
import { assembleResearchInput, type InputBudget } from '../research/inputs.js';
import { runPostEventResearch, type PostEventTriggerEvent } from '../research/post-event.js';
import { settleConclusion, type SettleOutcome } from '../settlement/settle.js';
import { settleEtfConclusion, type EtfSettleOutcome } from '../settlement/etf.js';
import { canStartPostEvent, shanghaiInstant, shanghaiWall, WEEKLY_DEADLINE, WEEKLY_OPEN } from './windows.js';
import {
  admissionIdOf,
  admitPostEvent,
  budgetGuard,
  mergePostEventAdmissions,
  POST_EVENT_BASELINE_PER_WEEK,
  type AdmissionRecord,
  type CompletedWeeklyRef,
  type QueueClass,
} from './queue.js';
import {
  buildSchedulePlan,
  persistAdmissions,
  loadAdmissions,
  persistSchedulePlan,
} from './plan.js';
import { nightSubjects, rotationTableFromPool, type PoolOrderSource, type RotationSubject } from './weekly.js';

// ===== 冻结常量（P5 骨架身份与预算）=====

/** 演练身份：一切 skeleton 落库物（permit / 结论 / 封存 / 调度计划）的版本轴前缀。 */
export const SKELETON_PLAN_AUTH_VERSION = 'pa-p5-skeleton';
/** 真实运行身份（R30 授权后）：真实通道 commit 的结论/permit 版本轴。 */
export const REAL_PLAN_AUTH_VERSION = 'pa-nightly-v1';
/** 方法版本（P5 冻结清单 §4：method@p2-v1）。 */
export const SKELETON_METHOD_VERSION = 'method@p2-v1';
/** 数据与适配器版本（P1 冻结）。 */
export const SKELETON_ADAPTER_VERSION = 'data@p1';
/** 调度量预算：~70 次/周基线（PLAN §1；SC-8.1 周度 60 + 事件后 10）。 */
export const SKELETON_BUDGET: PlanAuthBudget = {
  planAuthVersion: SKELETON_PLAN_AUTH_VERSION,
  maxModelCallsPerWeek: 70,
  maxInputBytes: 5_000_000,
  maxInFlight: 2,
};
/** 输入分层预算（P2 旅程在真实 600519 数据上验证过的量级）。 */
export const NIGHTLY_INPUT_BUDGET: InputBudget = {
  l0Bytes: 20_000,
  l1Bytes: 140_000,
  l2Bytes: 160_000,
  totalBytes: 300_000,
};

const DEFAULT_POOL_INFO_FILE = fileURLToPath(new URL('../../data/research-pool.json', import.meta.url));

/** 晚间循环具名错误。 */
export class NightlyError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'NightlyError';
  }
}

// ===== 池顺序（轮转输入）=====

async function loadPoolOrder(file: string): Promise<PoolOrderSource> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new NightlyError('POOL_INFO_INVALID', `${file}: ${String(error)}`);
  }
  const info = parsed as Partial<PoolOrderSource>;
  if (typeof info.frozenAt !== 'string' || !Array.isArray(info.stocks) || !Array.isArray(info.etfs)) {
    throw new NightlyError('POOL_INFO_INVALID', `${file}: 缺 frozenAt/stocks/etfs`);
  }
  return info as PoolOrderSource;
}

// ===== 当日事件（SC-3.2 合并输入）=====

interface EventRow {
  event_id: string;
  subject: string;
  type: string;
  subtype: string | null;
  event_time: Date;
  evidence_fact_id: string;
  attrs?: unknown;
}

export interface MergedPostEvent {
  subject: string;
  /** 截点 = 最晚一份触发公告发布时刻（SC-3.2）。 */
  cutoff: string;
  detectedAt: string | null;
  triggerEventIds: string[];
  inPool: boolean;
}

async function mergedPostEventsOfDay(
  dataPool: Pool,
  date: string,
  now: Date,
  excluded: ReadonlySet<string> = new Set(),
): Promise<{ merged: MergedPostEvent[]; skippedSubjects: { subject: string; code: string }[]; anchors: Map<string, PostEventTriggerEvent> }> {
  const dayStart = shanghaiInstant(date, '00:00:00');
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const res = await dataPool.query<EventRow>(
    `select event_id, subject, type, subtype, event_time, evidence_fact_id, attrs
     from events where event_time >= $1 and event_time < $2 order by event_time, event_id`,
    [dayStart, dayEnd],
  );
  const skippedSubjects: { subject: string; code: string }[] = [];
  const admitted: AdmissionRecord[] = [];
  const byId = new Map<string, PostEventTriggerEvent>();
  for (const row of res.rows) {
    if (excluded.has(row.event_id)) continue;
    if (!/^\d{6}$/.test(row.subject)) {
      skippedSubjects.push({ subject: row.subject, code: 'EVENT_SUBJECT_MALFORMED' });
      continue;
    }
    const event: PostEventTriggerEvent = {
      eventId: row.event_id,
      subject: row.subject,
      type: row.type,
      subtype: row.subtype,
      eventTime: row.event_time.toISOString(),
      evidenceFactId: row.evidence_fact_id,
      ...(row.attrs === undefined ? {} : { attrs: row.attrs as Record<string, unknown> }),
    };
    byId.set(row.event_id, event);
    admitted.push(
      admitPostEvent(
        {
          subject: row.subject,
          subjectKind: 'STOCK',
          publishedAt: event.eventTime,
          detectedAt: event.eventTime, // 事件时点 = available_at 基准（W14 口径）；created_at 整批回填下失真
          triggerEventIds: [row.event_id],
        },
        now.toISOString(),
      ),
    );
  }
  const merged = mergePostEventAdmissions(admitted)
    .filter((r) => r.queueClass === 'POST_EVENT')
    .map((r) => ({
      subject: r.subject,
      cutoff: r.cutoff,
      detectedAt: r.detectedAt,
      triggerEventIds: [...r.triggerEventIds],
      inPool: false,
    }));
  const anchors = new Map<string, PostEventTriggerEvent>();
  for (const m of merged) {
    const anchor = [...byId.values()]
      .filter((e) => m.triggerEventIds.includes(e.eventId))
      .sort((a, b) => (a.eventTime < b.eventTime ? 1 : -1))[0];
    if (anchor !== undefined) anchors.set(m.subject, anchor);
  }
  return { merged, skippedSubjects, anchors };
}

// ===== 先验周度结论（SC-7.1 继承声明输入）=====

async function priorWeeklyConclusion(
  execPool: Pool,
  subject: string,
  weekStart: string,
): Promise<CompletedWeeklyRef | null> {
  const res = await execPool.query<{ conclusion_id: string; conclusion_hash: string; created_at: Date }>(
    `select conclusion_id, conclusion_hash, created_at from conclusion
     where business_key->>'subject' = $1 and business_key->>'researchKind' = 'WEEKLY' and created_at >= $2
     order by created_at desc limit 1`,
    [subject, weekStart],
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return { subject, conclusionId: row.conclusion_id, conclusionHash: row.conclusion_hash, completedAt: row.created_at.toISOString() };
}

// ===== 条目计划与结果 =====

export interface NightlyEntryPlan {
  entryId: string;
  queueClass: QueueClass;
  subjectKind: SubjectKind;
  subject: string;
  researchKind: 'WEEKLY' | 'POST_EVENT';
  cutoff: string;
  detectedAt: string | null;
  triggerEventIds: string[];
}

export type NightlyEntryStatus = 'DRY' | 'PASS' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface NightlyEntryResult {
  entryId: string;
  queueClass: QueueClass;
  subjectKind: SubjectKind;
  subject: string;
  researchKind: 'WEEKLY' | 'POST_EVENT';
  status: NightlyEntryStatus;
  code: string | null;
  detail: string | null;
  inputHash: string | null;
  inputBytes: number | null;
  permitIds: string[];
  conclusionId: string | null;
}

export interface NightlyBudgetView {
  weekStart: string;
  weeklyUsedBefore: number;
  postEventUsedBefore: number;
  guardOk: boolean;
  guardScope: 'WEEKLY' | 'POST_EVENT' | null;
  guardAction: 'DEFER' | 'STOP_AND_PAUSE_REPORT' | null;
}

export interface NightlyDeps {
  /** 事实 + 封存 + 事件读取库（生产 public）。 */
  dataPool: Pool;
  /** 执行内核 + 结论 + 调度表库（生产 public；测试隔离 schema）。 */
  execPool: Pool;
  store: ArtifactStore;
  calendar: TradeCalendarTable;
  /** 缺省 selectTransport({provider})。 */
  transport?: ModelTransport;
}

export interface NightlyOptions {
  /** 交易日晚（YYYY-MM-DD，上海墙钟）。 */
  date: string;
  /** dry（缺省语义，仍须显式传 'dry'）或 commit。 */
  mode: 'dry' | 'commit';
  /** 传输配置（缺省 simulated；real 得 UnauthorizedTransport，全部 BLOCKED 不调用）。 */
  transportProvider?: 'simulated' | 'real';
  /** 结算回填独立开关（真实写 settlement 列；与 dry/commit 正交）。 */
  settleDue?: boolean;
  poolInfoFile?: string;
  /** 时钟注入（测试/重放；缺省真实时钟）。 */
  now?: Date;
  /** 结算 as-of 注入（测试；缺省当前时刻）。 */
  settleAsOf?: Date;
  /** 结算窗口长度（缺省 SR-3.3 的 20）。 */
  settleWindow?: number;
  /** 日志输出（缺省收集进 outcome.lines 不外发）。 */
  log?: (line: string) => void;
}

export interface NightlyRunOutcome {
  date: string;
  nth: number;
  mode: 'dry' | 'commit';
  transportProvider: 'simulated' | 'real';
  planAuthVersion: string;
  poolVersion: string;
  weekTradingDays: string[];
  rotation: RotationSubject[];
  eventsOfDay: number;
  postEventMerged: MergedPostEvent[];
  entries: NightlyEntryResult[];
  tally: Record<NightlyEntryStatus, number>;
  budget: NightlyBudgetView;
  permitsCreated: number;
  conclusionsCreated: number;
  /** dry 恒 0/0；commit = 实际新增数。 */
  zeroRealModelCalls: true;
  settleDue: SettleDueTally | null;
  lines: string[];
}

// ===== 周度条目执行（commit：A → 清单 → J → 结论）=====

interface CommitContext {
  deadline: string;
  lease: ExecutionLease;
  /** 结论/permit 版本轴（skeleton 或 R30 真实身份，由 runNightly 按传输推导）。 */
  planAuthVersion: string;
  transport: ModelTransport;
  poolInfoFile: string;
}

async function commitWeeklySubject(
  deps: NightlyDeps,
  ctx: CommitContext,
  plan: NightlyEntryPlan,
): Promise<{ inputHash: string; inputBytes: number; permitIds: string[]; conclusionId: string; note: string }> {
  const done = await runGateM({ ...deps, transport: ctx.transport }, {
    subjectKind: plan.subjectKind, subject: plan.subject, cutoff: plan.cutoff, execute: true,
    budget: { ...SKELETON_BUDGET, planAuthVersion: ctx.planAuthVersion },
    versions: { methodVersion: SKELETON_METHOD_VERSION, adapterVersion: SKELETON_ADAPTER_VERSION, planAuthVersion: ctx.planAuthVersion },
    inputBudget: NIGHTLY_INPUT_BUDGET, poolInfoFile: ctx.poolInfoFile, deadline: ctx.deadline, lease: ctx.lease,
    validatePackage: false,
  });
  if (done.mode !== 'execute') throw new NightlyError('EXECUTION_MODE_INVALID', 'Weekly commit returned a preview');
  return { inputHash: done.assembled.inputHash, inputBytes: done.assembled.inputBytes,
    permitIds: [done.permits.a!.permitId, done.permits.j.permitId], conclusionId: done.conclusion.conclusionId,
    note: '周度轮转（原业务检查点可核验恢复；STANDALONE）' };
}

// ===== 主循环 =====

/** 所属自然周的周一（上海墙钟；日期换算经 shanghaiWall，避免 UTC 差一天）。 */
function mondayOfWeek(date: string): string {
  const d = shanghaiInstant(date, '00:00:00');
  const weekday = shanghaiWall(d).weekday;
  const offset = weekday === 0 ? 6 : weekday - 1;
  return shanghaiWall(new Date(d.getTime() - offset * 86_400_000)).date;
}

export async function runNightly(deps: NightlyDeps, opts: NightlyOptions): Promise<NightlyRunOutcome> {
  // 新校验/送达协议不得借冻结 P5 的方法与运行授权写新真实样本。
  // 本修复不迁移、不激活 P5；迁移须由总控在单独授权后显式建立新身份。
  if (opts.mode === 'commit' && !(deps.transport ?? selectTransport({ provider: opts.transportProvider ?? 'simulated' })).describe().simulated) {
    throw new NightlyError('P5_PROTOCOL_FROZEN', '冻结 P5 真实入口未迁移到 traditional-research@2；拒绝沿旧身份发送');
  }
  const now = opts.now ?? new Date();
  const mode = opts.mode;
  const provider = opts.transportProvider ?? 'simulated';
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
    if (opts.log !== undefined) opts.log(line);
  };

  // 0) 交易日语义 + 周度窗口准入判定（SC-3.4：节假日/休市日不开放）——重放按日期给定判定
  if (!isTradingDay(deps.calendar, opts.date)) {
    throw new NightlyError('NIGHTLY_NOT_TRADING_DAY', `${opts.date} 非交易日（SC-10.1/10.2：晚间循环只排交易日）`);
  }
  // 周内交易日（覆盖安全）：周日可能越出日历覆盖尾（重放历史尾周），截到覆盖尾不影响 nth
  //（nth = 本周第几个交易日，只依赖 date 之前的天）。
  const { last } = calendarCoverage(deps.calendar);
  const monday = mondayOfWeek(opts.date);
  const sunday = shanghaiWall(new Date(shanghaiInstant(monday, '00:00:00').getTime() + 6 * 86_400_000)).date;
  const weekDays = tradingDaysBetween(deps.calendar, monday, sunday > last ? last : sunday);
  const nth = weekDays.indexOf(opts.date) + 1;
  if (nth < 1) {
    throw new NightlyError('NIGHTLY_NOT_TRADING_DAY', `${opts.date} 不在本周交易日序列内`);
  }

  // 1) 轮转（W17）：当晚 6 只
  const poolInfoFile = opts.poolInfoFile ?? DEFAULT_POOL_INFO_FILE;
  const poolOrder = await loadPoolOrder(poolInfoFile);
  const table = rotationTableFromPool(poolOrder);
  const rotation = [...nightSubjects(table, nth)];
  const poolStocks = new Set(poolOrder.stocks.map((s) => s.code));
  const weekStart = shanghaiInstant(mondayOfWeek(opts.date), '00:00:00').toISOString();

  // 2) 当日事件（SC-3.2 合并）
  const previousAdmissions = mode === 'commit' ? (await loadAdmissions(deps.execPool)).filter((a) =>
    a.planId === `plan:${SKELETON_PLAN_AUTH_VERSION}:${table.poolVersion}` && a.started &&
    a.queueClass === 'POST_EVENT' && shanghaiWall(new Date(a.cutoff)).date === opts.date) : [];
  const excluded = new Set(previousAdmissions.flatMap((a) => a.triggerEventIds));
  const { merged, skippedSubjects, anchors } = await mergedPostEventsOfDay(deps.dataPool, opts.date, now, excluded);
  for (const m of merged) m.inPool = poolStocks.has(m.subject);

  log(
    `[lyra-nightly] date=${opts.date} mode=${mode} transport=${provider} planAuth=${SKELETON_PLAN_AUTH_VERSION}` +
      ` pool=${table.poolVersion}`,
  );
  log(`[lyra-nightly] 轮转：本周第 ${String(nth)} 个交易日晚 / 6 只：${rotation.map((s) => `${s.subjectKind} ${s.subject}`).join('、')}`);
  log(
    `[lyra-nightly] 事件后准入：当日命中 ${String(merged.length)} 标的（SC-3.2 合并后），池内 ` +
      `${String(merged.filter((m) => m.inPool).length)} / 池外 ${String(merged.filter((m) => !m.inPool).length)}` +
      (skippedSubjects.length > 0 ? `；畸形主体跳过 ${String(skippedSubjects.length)}` : ''),
  );

  // 3) 预算闸（SC-8.1/8.4）：本周已用量按 exec_permit 真实计数（dry 不增量，如实注明）
  const budgetWeekStart = mode === 'commit' ? (await deps.execPool.query<{ start: Date }>("select date_trunc('week',clock_timestamp() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' as start")).rows[0]!.start.toISOString() : weekStart;
  const usedRes = await deps.execPool.query<{ research_kind: string; n: string }>(
    "select research_kind,count(*)::text as n from exec_permit where sent_at >= $1::timestamptz and sent_at < $1::timestamptz+interval '7 days' group by research_kind",
    [budgetWeekStart],
  );
  let weeklyUsed = 0;
  let postEventUsed = 0;
  for (const row of usedRes.rows) {
    if (row.research_kind === 'POST_EVENT') postEventUsed += Number(row.n);
    else weeklyUsed += Number(row.n);
  }
  const weeklyUsedBefore = weeklyUsed;
  const postEventUsedBefore = postEventUsed;
  const guard0 = budgetGuard({ weeklyUsed, postEventUsed, postEventAuthCap: POST_EVENT_BASELINE_PER_WEEK });
  const budgetView: NightlyBudgetView = {
    weekStart: budgetWeekStart,
    weeklyUsedBefore,
    postEventUsedBefore,
    guardOk: guard0.ok,
    guardScope: guard0.ok ? null : guard0.scope,
    guardAction: guard0.ok ? null : guard0.action,
  };
  if (!guard0.ok) {
    log(
      `[lyra-nightly] 预算闸：${guard0.scope} 已达上限（weekly=${String(weeklyUsed)} postEvent=${String(postEventUsed)}）` +
        ` → ${guard0.action}（SC-8.4：不自动扩容、不自动降档；提额是人工授权动作）`,
    );
  }

  // 4) 传输解析（R30：授权真实通道可执行——CLI --real 直接构造 SolTransport 传入 deps.transport；
  //     selectTransport('real') 无配置仍得 UnauthorizedTransport 占位，隐式防线不变）
  const transport = deps.transport ?? selectTransport({ provider });
  const transportSimulated = transport.describe().simulated;
  const planAuthVersion = transportSimulated ? SKELETON_PLAN_AUTH_VERSION : REAL_PLAN_AUTH_VERSION;
  if (transport instanceof UnauthorizedTransport) {
    log(
      `[lyra-nightly] transport=real → UnauthorizedTransport（真实模型通道未授权，Gate-M 有界授权另立合同）；` +
        `本骨架对全部标的记 BLOCKED/MODEL_PROVIDER_UNAUTHORIZED，不组装、不落 permit、不调用`,
    );
  }

  // 5) commit 前置：晚间执行截止（SC-3.5 的 23:30；EK-6.1 显式计算，不从模板继承）
  const deadline = shanghaiInstant(opts.date, WEEKLY_DEADLINE).toISOString();

  // 条目队列：事件后（SC-5.1 优先）→ 轮转
  interface Runnable {
    plan: NightlyEntryPlan;
    anchor: PostEventTriggerEvent | null;
  }
  const runnable: Runnable[] = [];
  const entries: NightlyEntryResult[] = [];
  const base = (plan: NightlyEntryPlan): NightlyEntryResult => ({
    entryId: plan.entryId,
    queueClass: plan.queueClass,
    subjectKind: plan.subjectKind,
    subject: plan.subject,
    researchKind: plan.researchKind,
    status: 'FAILED',
    code: null,
    detail: null,
    inputHash: null,
    inputBytes: null,
    permitIds: [],
    conclusionId: null,
  });
  const pushEntry = (e: NightlyEntryResult): number => entries.push(e) - 1;

  // 池外事件标的：准入已合并登记，研究面 SKIPPED（研究宇宙 = 冻结池 30 标的，R24）
  for (const admission of previousAdmissions) {
    if ((admission.subjectKind !== 'STOCK' && admission.subjectKind !== 'BROAD_ETF') || admission.researchKind !== 'POST_EVENT') throw new NightlyError('NIGHTLY_ADMISSION_INVALID');
    const saved = (await deps.execPool.query<{ snapshot: ResearchSnapshot }>(`select snapshot from research_execution
      where business_key->>'subject'=$1 and business_key->>'researchKind'='POST_EVENT'
        and (business_key->>'cutoff')::timestamptz=$2::timestamptz`, [admission.subject, admission.cutoff])).rows[0];
    let anchor = saved ? validatePostEventContext(saved.snapshot.assembled.package)?.event ?? null : null;
    if (!anchor) {
      const row = (await deps.dataPool.query<EventRow>(`select event_id,subject,type,subtype,event_time,evidence_fact_id,attrs
        from events where event_id=any($1::text[]) and event_time=$2::timestamptz order by event_id limit 1`, [admission.triggerEventIds, admission.cutoff])).rows[0];
      if (row) anchor = { eventId: row.event_id, subject: row.subject, type: row.type, subtype: row.subtype,
        eventTime: row.event_time.toISOString(), evidenceFactId: row.evidence_fact_id, attrs: row.attrs as Record<string, unknown> };
    }
    if (!runnable.some((r) => r.plan.entryId === admission.admissionId)) runnable.push({ plan: {
      entryId: admission.admissionId, queueClass: admission.queueClass, subjectKind: admission.subjectKind,
      subject: admission.subject, researchKind: admission.researchKind, cutoff: admission.cutoff,
      detectedAt: admission.detectedAt, triggerEventIds: admission.triggerEventIds }, anchor });
  }
  for (const m of merged.filter((x) => !x.inPool)) {
    const plan: NightlyEntryPlan = {
      entryId: `adm:POST_EVENT:STOCK:${m.subject}:${m.cutoff}`,
      queueClass: 'POST_EVENT',
      subjectKind: 'STOCK',
      subject: m.subject,
      researchKind: 'POST_EVENT',
      cutoff: m.cutoff,
      detectedAt: m.detectedAt,
      triggerEventIds: [...m.triggerEventIds],
    };
    const idx = pushEntry({ ...base(plan), status: 'SKIPPED', code: 'SUBJECT_NOT_IN_POOL', detail: `事件标的 ${m.subject} 不在冻结池（R24 研究宇宙）` });
    log(entryLine(entries[idx] as NightlyEntryResult, idx + 1));
  }
  for (const m of merged.filter((x) => x.inPool)) {
    runnable.push({
      plan: {
        entryId: `adm:POST_EVENT:STOCK:${m.subject}:${m.cutoff}`,
        queueClass: 'POST_EVENT',
        subjectKind: 'STOCK',
        subject: m.subject,
        researchKind: 'POST_EVENT',
        cutoff: m.cutoff,
        detectedAt: m.detectedAt,
        triggerEventIds: [...m.triggerEventIds],
      },
      anchor: anchors.get(m.subject) ?? null,
    });
  }
  for (const s of rotation) {
    runnable.push({
      plan: {
        entryId: `adm:WEEKLY_ROTATION:${s.subjectKind}:${s.subject}:${shanghaiInstant(opts.date, WEEKLY_OPEN).toISOString()}`,
        queueClass: 'WEEKLY_ROTATION',
        subjectKind: s.subjectKind,
        subject: s.subject,
        researchKind: 'WEEKLY',
        cutoff: shanghaiInstant(opts.date, WEEKLY_OPEN).toISOString(),
        detectedAt: null,
        triggerEventIds: [],
      },
      anchor: null,
    });
  }

  if (mode === 'commit' && now.getTime() >= Date.parse(deadline)) {
    // Late deterministic publication is allowed only when every queued A/J already has a successful checkpoint.
    // New/unfinished work retains the scheduling deadline, in addition to the database SENT guard.
    for (const { plan } of runnable) {
      const done = await deps.execPool.query<{ n: string }>(`select count(*)::text as n from exec_permit
        where subject_kind=$1 and subject=$2 and research_kind=$3 and cutoff=$4::timestamptz
          and state='SUCCEEDED' and response_checkpoint is not null and response_hash is not null`,
      [plan.subjectKind, plan.subject, plan.researchKind, plan.cutoff]);
      if (Number(done.rows[0]!.n) !== 2) throw new NightlyError('NIGHTLY_COMMIT_DEADLINE_PAST', '晚间截止已过，仍有缺少成功 A/J 检查点的任务');
    }
  }

  // 6) 执行（holder 纪律：commit 整晚持锁，条目间心跳）
  const schedulePlan = buildSchedulePlan({ planAuthVersion,
    poolInfo: { frozenAt: poolOrder.frozenAt, stocks: poolOrder.stocks, etfs: poolOrder.etfs }, createdAt: now.toISOString() });
  const holderId = `nightly-skeleton-${randomUUID()}`;
  const lease = mode === 'commit' ? (await acquireExecutorLock(deps.execPool, holderId)).lease : undefined;
  const keeper = lease ? keepLeaseAlive(deps.execPool, lease) : undefined;
  const ownedWrite = <T>(fn: (tx: Pool) => Promise<T>) => withTransaction(deps.execPool, async (tx) => {
    await assertLease(tx, lease!, true); const value = await fn(tx as unknown as Pool); await assertLease(tx, lease!); return value;
  });
  const admissionRecords: AdmissionRecord[] = [];
  let permitsCreated = 0;
  let conclusionsCreated = 0;
  try {
    if (mode === 'commit') await ownedWrite((tx) => persistSchedulePlan(tx, schedulePlan));
    const ctx: CommitContext = { deadline, lease: lease!, transport, poolInfoFile, planAuthVersion };
    for (let i = 0; i < runnable.length; i += 1) {
      const r = runnable[i] as Runnable;
      const plan = r.plan;
      const seq = entries.length + 1;

      // 真实通道未授权占位（deps.transport 未注入授权实例）：具名 BLOCKED，不组装、不入 permit（继续下一标的）
      if (!transportSimulated && transport instanceof UnauthorizedTransport) {
        const idx = pushEntry({
          ...base(plan),
          status: 'BLOCKED',
          code: 'MODEL_PROVIDER_UNAUTHORIZED',
          detail: '真实模型通道未授权（selectTransport(real)=UnauthorizedTransport）；骨架永不隐式调用真实通道',
        });
        admissionRecords.push(admissionRecordOf(plan, false, false, 'BLOCKED:MODEL_PROVIDER_UNAUTHORIZED'));
        log(entryLine(entries[idx] as NightlyEntryResult, seq));
        continue;
      }

      // 预算闸复查（commit 模式下逐条目以真实增量重估）
      const guard = budgetGuard({ weeklyUsed, postEventUsed, postEventAuthCap: POST_EVENT_BASELINE_PER_WEEK,
        scope: plan.researchKind === 'POST_EVENT' ? 'POST_EVENT' : 'WEEKLY', requiredCalls: 2 });
      // Commit admission is enforced atomically with SENT; an existing A/J checkpoint may need zero/one new calls.
      if (mode === 'dry' && !guard.ok) {
        const code = guard.scope === 'POST_EVENT' ? 'BUDGET_STOPPED_POST_EVENT' : 'BUDGET_DEFERRED';
        const idx = pushEntry({
          ...base(plan),
          status: 'SKIPPED',
          code,
          detail: `${guard.scope} 已达上限（weekly=${String(weeklyUsed)} postEvent=${String(postEventUsed)}）→ ${guard.action}（SC-8.4 不扩容不降档）`,
        });
        admissionRecords.push(admissionRecordOf(plan, false, false, null));
        log(entryLine(entries[idx] as NightlyEntryResult, seq));
        continue;
      }

      if (mode === 'dry') {
        // dry：全链到 prompt 为止（组装 + 哈希/字节；零 permit 零结论零调度写入）
        try {
          const preview = await dryPreview(deps, plan, r.anchor, { poolInfoFile, now, weekStart, planAuthVersion });
          const idx = pushEntry({
            ...base(plan),
            status: 'DRY',
            code: null,
            detail: preview.note,
            inputHash: preview.inputHash,
            inputBytes: preview.inputBytes,
          });
          log(entryLine(entries[idx] as NightlyEntryResult, seq));
        } catch (error) {
          const idx = pushEntry({ ...base(plan), status: 'FAILED', code: errorCode(error), detail: errorMessage(error) });
          log(entryLine(entries[idx] as NightlyEntryResult, seq));
        }
        continue;
      }

      // Persist admission before execution; actual receipts, including a partially failed chain, are reconciled below.
      await keeper!.assert();
      const receiptArgs = [plan.subjectKind, plan.subject, plan.researchKind, plan.cutoff];
      const receipts = async () => (await deps.execPool.query<{ permit_id: string; sent_at: Date | null }>(
        'select permit_id,sent_at from exec_permit where subject_kind=$1 and subject=$2 and research_kind=$3 and cutoff=$4', receiptArgs)).rows;
      const beforeReceipts = await receipts();
      const beforeConclusion = await deps.execPool.query("select conclusion_id from conclusion where business_key->>'subjectKind'=$1 and business_key->>'subject'=$2 and business_key->>'researchKind'=$3 and (business_key->>'cutoff')::timestamptz=$4::timestamptz", receiptArgs);
      await ownedWrite((tx) => persistAdmissions(tx, schedulePlan.planId, [admissionRecordOf(plan, true, beforeReceipts.some((p) => p.sent_at !== null), null)]));
      try {
        const done =
          plan.researchKind === 'POST_EVENT'
            ? await commitPostEvent(deps, ctx, plan, r.anchor, { now, weekStart })
            : await commitWeeklySubject(deps, ctx, plan);
        pushEntry({
          ...base(plan),
          status: 'PASS',
          code: null,
          detail: done.note,
          inputHash: done.inputHash,
          inputBytes: done.inputBytes,
          permitIds: done.permitIds,
          conclusionId: done.conclusionId,
        });
        if (beforeConclusion.rowCount === 0) conclusionsCreated += 1;
        admissionRecords.push(admissionRecordOf(plan, true, true, null));
      } catch (error) {
        pushEntry({ ...base(plan), status: 'FAILED', code: errorCode(error), detail: errorMessage(error) });
        admissionRecords.push(admissionRecordOf(plan, true, false, null));
      }
      const afterReceipts = await receipts();
      permitsCreated += afterReceipts.filter((p) => !beforeReceipts.some((b) => b.permit_id === p.permit_id)).length;
      const lastEntry = entries[entries.length - 1]!;
      lastEntry.permitIds = afterReceipts.map((p) => p.permit_id);
      const lastAdmission = admissionRecords[admissionRecords.length - 1]!;
      lastAdmission.sent = afterReceipts.some((p) => p.sent_at !== null);
      await keeper!.assert();
      await ownedWrite((tx) => persistAdmissions(tx, schedulePlan.planId, [lastAdmission]));
      log(entryLine(lastEntry, seq));
      const actualUsage = await deps.execPool.query<{ research_kind: string; n: string }>(
        "select research_kind,count(*)::text as n from exec_permit where sent_at >= $1::timestamptz and sent_at < $1::timestamptz+interval '7 days' group by research_kind", [budgetWeekStart]);
      weeklyUsed = actualUsage.rows.filter((x) => x.research_kind !== 'POST_EVENT').reduce((n, x) => n + Number(x.n), 0);
      postEventUsed = actualUsage.rows.filter((x) => x.research_kind === 'POST_EVENT').reduce((n, x) => n + Number(x.n), 0);
    }

    // 7) 调度落档（仅 commit）：W17 计划 + 本晚准入（blocked 带 BLOCKED: 标注，供周末指标采集）
    if (mode === 'commit') {
      const plan = buildSchedulePlan({
        planAuthVersion,
        poolInfo: { frozenAt: poolOrder.frozenAt, stocks: poolOrder.stocks, etfs: poolOrder.etfs },
        createdAt: now.toISOString(),
      });
      await ownedWrite(async (tx) => {
        await persistSchedulePlan(tx, plan);
        await persistAdmissions(tx, plan.planId, admissionRecords);
      });
      log(
        `[lyra-nightly] 调度落档：plan=${plan.planId}（${SKELETON_PLAN_AUTH_VERSION}）准入 ${String(admissionRecords.length)} 条` +
          `（blocked ${String(admissionRecords.filter((a) => a.annotation !== null && a.annotation.startsWith('BLOCKED:')).length)}）`,
      );
    }
  } finally {
    await keeper?.stop();
    if (lease) await releaseExecutorLock(deps.execPool, lease);
  }

  // 8) 小结
  const tally: Record<NightlyEntryStatus, number> = { DRY: 0, PASS: 0, FAILED: 0, BLOCKED: 0, SKIPPED: 0 };
  for (const e of entries) tally[e.status] += 1;
  log(
    `[lyra-nightly] 小结：entries=${String(entries.length)}（PASS=${String(tally.PASS)} DRY=${String(tally.DRY)} ` +
      `FAILED=${String(tally.FAILED)} BLOCKED=${String(tally.BLOCKED)} SKIPPED=${String(tally.SKIPPED)}）；` +
      `permits新增=${String(permitsCreated)} conclusions新增=${String(conclusionsCreated)}` +
      (mode === 'dry' ? '（dry：零 permit 零结论）' : `（commit：全部带 ${SKELETON_PLAN_AUTH_VERSION} 演练身份）`),
  );
  if (mode === 'commit' && merged.some((m) => m.inPool)) {
    log(
      `[lyra-nightly] 告警：POST_EVENT 业务键（标的 × 事件时点）已被 skeleton 结论占用，该事件的真实研究将被 send-once 拒绝；` +
        `P5 正式启用前如需真实重跑该事件，属 Owner 决策（清理或另立键），本骨架不自动处理`,
    );
  }
  log(
    `[lyra-nightly] 身份声明：${mode === 'dry' ? 'dry 演练（不落 permit/结论/调度表）' : `commit 演练（一切落库物 planAuthVersion=${SKELETON_PLAN_AUTH_VERSION}）`}；` +
      `真实通道${transportSimulated ? '未接入（simulated）' : '未授权（BLOCKED）'}，本骨架零真实模型调用`,
  );

  // 9) settle-due（独立开关：真实回填 settlement 列，零模型调用）
  let settleDue: SettleDueTally | null = null;
  if (opts.settleDue === true) {
    settleDue = await settleDueConclusions(deps.execPool, deps.dataPool, {
      ...(opts.settleAsOf === undefined ? {} : { asOf: opts.settleAsOf }),
      ...(opts.settleWindow === undefined ? {} : { window: opts.settleWindow }),
    });
    log(
      `[lyra-nightly] settle-due：attempted=${String(settleDue.attempted)} settled=${String(settleDue.settled)} ` +
        `anomaly=${String(settleDue.anomaly)} unsettled=${String(settleDue.unsettled)} skipped=${String(settleDue.skipped)}`,
    );
  }

  return {
    date: opts.date,
    nth,
    mode,
    transportProvider: provider,
    planAuthVersion,
    poolVersion: table.poolVersion,
    weekTradingDays: weekDays,
    rotation,
    eventsOfDay: merged.length + skippedSubjects.length,
    postEventMerged: merged,
    entries,
    tally,
    budget: budgetView,
    permitsCreated,
    conclusionsCreated,
    zeroRealModelCalls: true,
    settleDue,
    lines,
  };
}

// ===== dry 预览（组装到 prompt 为止）=====

async function dryPreview(
  deps: NightlyDeps,
  plan: NightlyEntryPlan,
  anchor: PostEventTriggerEvent | null,
  ctx: { poolInfoFile: string; now: Date; weekStart: string; planAuthVersion: string },
): Promise<{ inputHash: string; inputBytes: number; note: string }> {
  const notes: string[] = [];
  if (plan.researchKind === 'POST_EVENT') {
    if (anchor === null) throw new NightlyError('POST_EVENT_ANCHOR_MISSING', `${plan.subject} 缺少事件锚点`);
    // SC-3.3 启动闸预览 + SC-7.1 继承声明预览（dry 不执行，只如实标注）。
    // 预览不承重：历史尾周（日历覆盖尾当日事件，无下一交易日）等预览失败只记录，不阻断组装。
    try {
      const gate = canStartPostEvent(deps.calendar, anchor.eventTime, ctx.now);
      notes.push(
        `启动闸=${gate.allowed ? `ALLOWED` : gate.code}(latestStart=${gate.latestStart}${gate.allowed ? '' : '；重放预览非执行闸'})`,
      );
    } catch (error) {
      notes.push(`启动闸=PREVIEW_UNAVAILABLE(${errorCode(error)}；重放预览非执行闸)`);
    }
  }
  const assembled = await assembleResearchInput(deps.dataPool, deps.store, {
    subjectKind: plan.subjectKind,
    subject: plan.subject,
    cutoff: plan.cutoff,
    budget: NIGHTLY_INPUT_BUDGET,
    versions: {
      methodVersion: SKELETON_METHOD_VERSION,
      adapterVersion: SKELETON_ADAPTER_VERSION,
      planAuthVersion: ctx.planAuthVersion,
    },
    researchKind: plan.researchKind,
    poolInfoFile: ctx.poolInfoFile,
  });
  let pkg = assembled.package;
  if (plan.researchKind === 'POST_EVENT' && anchor !== null) {
    const priorRef = await priorWeeklyConclusion(deps.execPool, plan.subject, ctx.weekStart);
    const prior = priorRef === null ? null : await readConclusion(deps.execPool, priorRef.conclusionId);
    const resolved = await loadPriorResearch(deps.execPool, deps.store, prior, anchor, SKELETON_METHOD_VERSION, ctx.now.toISOString());
    const eventFact = await loadFact(deps.dataPool, anchor.evidenceFactId);
    if (eventFact === null) throw new NightlyError('EVENT_FACT_MISSING', anchor.evidenceFactId);
    const context: PostEventContext = resolved.prior === null
      ? { kind: 'POST_EVENT_CONTEXT_V2', basis: 'STANDALONE', prior: null, event: anchor, eventFact, admittedAt: ctx.now.toISOString(), reason: resolved.reason }
      : { kind: 'POST_EVENT_CONTEXT_V2', basis: 'INHERITED', prior: resolved.prior, event: anchor, eventFact, admittedAt: ctx.now.toISOString(), reason: resolved.reason };
    // Same fact/seal/delivery and prior-evidence checks as runPostEventResearch; no execution checkpoint or admission write.
    pkg = withPostEventContext(pkg, context, NIGHTLY_INPUT_BUDGET);
    notes.push(`继承=${context.basis}${context.prior === null ? '' : `(${context.prior.conclusion.conclusionId})`}`);
  }
  const transport = deps.transport ?? selectTransport({ provider: 'simulated' });
  const request = buildARequest(pkg, transport.describe().simulated);
  await preflightTransport(transport, { businessKey: pkg.businessKey, stage: 'A',
    inputHash: request.inputHash, inputBytes: request.inputBytes, methodVersion: SKELETON_METHOD_VERSION,
    planAuthVersion: ctx.planAuthVersion, deadline: shanghaiInstant(shanghaiWall(ctx.now).date, WEEKLY_DEADLINE).toISOString() }, request.payload);
  if (plan.researchKind === 'POST_EVENT') notes.push('事件上下文已实际送达L0；本预览不替代执行准入与J复核');
  return {
    inputHash: request.inputHash,
    inputBytes: request.inputBytes,
    note: notes.join(' ') + (notes.length > 0 ? ' ' : '') + `A prompt=${String(request.inputBytes)} UTF-8字节（含指令与实际输入；已无外发预检）`,
  };
}

// ===== commit 事件后（复用 W20 runPostEventResearch）=====

async function commitPostEvent(
  deps: NightlyDeps,
  ctx: CommitContext,
  plan: NightlyEntryPlan,
  anchor: PostEventTriggerEvent | null,
  meta: { now: Date; weekStart: string },
): Promise<{ inputHash: string; inputBytes: number; permitIds: string[]; conclusionId: string; note: string }> {
  if (anchor === null) {
    throw new NightlyError('POST_EVENT_ANCHOR_MISSING', `${plan.subject} 合并准入缺少锚定事件（截点 ${plan.cutoff}）`);
  }
  const priorRef = await priorWeeklyConclusion(deps.execPool, plan.subject, meta.weekStart);
  const prior = priorRef === null ? null : await readConclusion(deps.execPool, priorRef.conclusionId);
  const outcome = await runPostEventResearch(
    { dataPool: deps.dataPool, execPool: deps.execPool, store: deps.store, transport: ctx.transport, calendar: deps.calendar },
    {
      event: anchor,
      inheritance: prior === null ? null : { priorConclusion: prior },
      budget: { ...SKELETON_BUDGET, planAuthVersion: ctx.planAuthVersion },
      lease: ctx.lease,
      versions: { methodVersion: SKELETON_METHOD_VERSION, adapterVersion: SKELETON_ADAPTER_VERSION },
      inputBudget: NIGHTLY_INPUT_BUDGET,
      detectedAt: plan.detectedAt ?? anchor.eventTime,
      now: meta.now,
      deadline: ctx.deadline, // 显式截止（EK-6.1）：当晚 23:30，比窗口 09:15 保守，原样落 permit 可审计
      poolInfoFile: ctx.poolInfoFile,
    },
  );
  return {
    inputHash: outcome.inputHash,
    inputBytes: outcome.inputBytes,
    permitIds: [outcome.permits.aPermitId, outcome.permits.jPermitId],
    conclusionId: outcome.conclusion.conclusionId,
    note: `继承=${outcome.declaration.basis}${outcome.conclusion.inheritance ? `(${outcome.conclusion.inheritance.fromConclusionId})` : ''}`,
  };
}

function admissionRecordOf(plan: NightlyEntryPlan, started: boolean, sent: boolean, annotation: string | null): AdmissionRecord {
  return {
    admissionId: admissionIdOf(plan.queueClass, plan.subjectKind, plan.subject, plan.cutoff),
    queueClass: plan.queueClass,
    subjectKind: plan.subjectKind,
    subject: plan.subject,
    researchKind: plan.researchKind,
    cutoff: plan.cutoff,
    firstQueuedAt: new Date().toISOString(),
    detectedAt: plan.detectedAt,
    triggerEventIds: [...plan.triggerEventIds],
    annotation,
    source: plan.queueClass === 'POST_EVENT' ? 'DETECTION' : 'WEEKLY_ROTATION',
    started,
    sent,
    notes: [],
  };
}

function entryLine(e: NightlyEntryResult, seq: number): string {
  const parts = [
    `[lyra-nightly] ${String(seq).padStart(2, '0')} ${e.queueClass} ${e.subjectKind} ${e.subject}`,
    `→ ${e.status}`,
  ];
  if (e.code !== null) parts.push(`${e.code}`);
  if (e.inputBytes !== null) parts.push(`bytes=${String(e.inputBytes)}`);
  if (e.inputHash !== null) parts.push(`hash=${e.inputHash.slice(0, 12)}`);
  if (e.conclusionId !== null) parts.push(`conclusion=${e.conclusionId}`);
  if (e.permitIds.length > 0) parts.push(`permits=${String(e.permitIds.length)}`);
  if (e.detail !== null && e.detail.length > 0) parts.push(`；${e.detail}`);
  return parts.join(' ');
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'INTERNAL';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

// ===== settle-due：到期未结算结论批量结算回填（复用 W20 逻辑形态）=====

export interface SettleDueEntry {
  conclusionId: string;
  subjectKind: SubjectKind;
  subject: string;
  outcome: 'SETTLED' | 'ANOMALY' | 'UNSETTLED' | 'SKIPPED';
  code: string | null;
  backfilled: 'SETTLED' | 'ANOMALY' | null;
}

export interface SettleDueTally {
  attempted: number;
  settled: number;
  anomaly: number;
  unsettled: number;
  skipped: number;
  entries: SettleDueEntry[];
}

export interface SettleDueOptions {
  asOf?: Date;
  window?: number;
}

/**
 * 对全部占位区 UNSETTLED 的结论尝试结算回填（结算引擎权威判定到期与否：
 * REFERENCE_NOT_DUE / WINDOW_INCOMPLETE 维持 UNSETTLED 不回填，SR-2.4 不预测性回填）。
 * 零模型调用；研究字段不可变由 backfillSettlement 内建断言保证。
 */
export async function settleDueConclusions(
  execPool: Pool,
  factPool: Pool,
  opts?: SettleDueOptions,
): Promise<SettleDueTally> {
  const res = await execPool.query<{ conclusion_id: string }>(
    `select conclusion_id from conclusion where settlement->>'state' = 'UNSETTLED' order by created_at`,
  );
  const tally: SettleDueTally = { attempted: 0, settled: 0, anomaly: 0, unsettled: 0, skipped: 0, entries: [] };
  const asOfField = opts?.asOf === undefined ? {} : { asOf: opts.asOf };
  const windowField = opts?.window === undefined ? {} : { window: opts.window };
  for (const row of res.rows) {
    const c = await readConclusion(execPool, row.conclusion_id);
    const entryBase = {
      conclusionId: row.conclusion_id,
      subjectKind: (c?.businessKey.subjectKind ?? 'STOCK') as SubjectKind,
      subject: c?.businessKey.subject ?? '?',
    };
    if (c === null) {
      tally.skipped += 1;
      tally.entries.push({ ...entryBase, outcome: 'SKIPPED', code: 'CONCLUSION_MISSING', backfilled: null });
      continue;
    }
    if (!validDispositions(c.businessKey.subjectKind).includes(c.disposition)) {
      tally.skipped += 1;
      tally.entries.push({ ...entryBase, outcome: 'SKIPPED', code: 'DISPOSITION_SPACE_INVALID', backfilled: null });
      continue;
    }
    tally.attempted += 1;
    const outcome: SettleOutcome | EtfSettleOutcome =
      c.businessKey.subjectKind === 'STOCK'
        ? await settleConclusion(factPool, {
            subject: c.businessKey.subject,
            disposition: c.disposition as 'RESEARCH_OUTPERFORM' | 'RESEARCH_UNDERPERFORM' | 'ABSTAIN',
            conclusionTime: c.createdAt,
            benchmark: c.evidence.benchmark,
            cutoff: c.businessKey.cutoff,
            ...asOfField,
            ...windowField,
          })
        : await settleEtfConclusion(factPool, {
            subject: c.businessKey.subject,
            disposition: c.disposition as 'RESEARCH_UP' | 'RESEARCH_DOWN' | 'ABSTAIN',
            cutoff: c.businessKey.cutoff,
            conclusionTime: c.createdAt,
            benchmark: c.evidence.benchmark,
            ...asOfField,
            ...windowField,
          });
    if (outcome.state === 'UNSETTLED') {
      tally.unsettled += 1;
      tally.entries.push({ ...entryBase, outcome: 'UNSETTLED', code: outcome.reason, backfilled: null });
      continue;
    }
    const backfill =
      outcome.state === 'SETTLED'
        ? outcome.zone
        : { state: 'ANOMALY' as const, anomalyCode: outcome.code, anomalyDetail: outcome.detail };
    await backfillSettlement(execPool, row.conclusion_id, backfill);
    if (outcome.state === 'SETTLED') tally.settled += 1;
    else tally.anomaly += 1;
    tally.entries.push({ ...entryBase, outcome: outcome.state, code: outcome.state === 'ANOMALY' ? outcome.code : null, backfilled: outcome.state });
  }
  return tally;
}

// ===== CLI =====

interface CliArgs {
  date?: string;
  commit: boolean;
  dry: boolean;
  settleDue: boolean;
  transport: 'simulated' | 'real';
  poolInfo?: string;
  artifactsDir?: string;
  now?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { commit: false, dry: false, settleDue: false, transport: 'simulated' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (arg === '--date' && next !== undefined) {
      args.date = next;
      i += 1;
    } else if (arg === '--commit') {
      args.commit = true;
    } else if (arg === '--dry') {
      args.dry = true;
    } else if (arg === '--settle-due') {
      args.settleDue = true;
    } else if (arg === '--transport' && (next === 'simulated' || next === 'real')) {
      args.transport = next;
      i += 1;
    } else if (arg === '--pool-info' && next !== undefined) {
      args.poolInfo = next;
      i += 1;
    } else if (arg === '--artifacts-dir' && next !== undefined) {
      args.artifactsDir = next;
      i += 1;
    } else if (arg === '--now' && next !== undefined) {
      args.now = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new NightlyError('CLI_ARGS_INVALID', `无法识别的参数：${arg}（--help 查看用法）`);
    }
  }
  if (args.commit && args.dry) throw new NightlyError('CLI_ARGS_INVALID', '--commit 与 --dry 互斥');
  return args;
}

const USAGE = `Lyra 每交易日晚间研究循环骨架（P5 准备 W27）

用法：
  node --import tsx src/schedule/nightly.ts --date <YYYY-MM-DD> [--dry|--commit] [--settle-due]
      [--transport simulated|real] [--pool-info <file>] [--artifacts-dir <dir>] [--now <ISO>]

  --date        交易日晚（YYYY-MM-DD，上海墙钟；缺省今天）
  --dry         全链到 prompt 为止：组装 + 输入哈希/字节，零模型调用、零 permit、零结论（缺省）
  --commit      显式真实落库：permit + 结论 + 调度落档，全部带 planAuthVersion=pa-p5-skeleton 演练身份
  --settle-due  对占位区 UNSETTLED 结论批量结算回填（真实写 settlement 列，零模型调用；与 dry/commit 正交）
  --transport   simulated（缺省）| real（dry 可预检；P5 commit 仍由 P5_PROTOCOL_FROZEN 拒绝）
  --pool-info   冻结池文件（缺省 data/research-pool.json）
  --artifacts-dir 原件库根（缺省 data/artifacts）
  --now         时钟注入（测试/重放；生产不传）

安全边界：真实模型通道永不被本骨架隐式调用；--commit 对 POST_EVENT 事件键的占用会阻断该事件
后续真实研究（send-once），CLI 输出告警，清理由 Owner 决策。`;

/** The production CLI and the isolated no-egress test use this same argument-to-dependency wiring. */
export function runNightlyCli(argv: string[], deps: NightlyDeps, realTransport: () => ModelTransport = () => new SolTransport(), log?: (line: string) => void) {
  const args = parseCliArgs(argv);
  return runNightly({ ...deps, transport: args.transport === 'real' ? realTransport() : (deps.transport ?? selectTransport()) }, {
    date: args.date ?? shanghaiWall(new Date()).date, mode: args.commit ? 'commit' : 'dry', transportProvider: args.transport,
    ...(args.settleDue ? { settleDue: true } : {}), ...(args.poolInfo === undefined ? {} : { poolInfoFile: args.poolInfo }),
    ...(args.now === undefined ? {} : { now: new Date(args.now) }), ...(log === undefined ? {} : { log }),
  });
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const date = args.date ?? shanghaiWall(new Date()).date;
  const pool = createPool(); // 生产 public（事实 + 封存 + 执行 + 结论 + 调度同库）
  try {
    const calendar = await loadTradeCalendarTable(pool);
    const store = new ArtifactStore(args.artifactsDir ?? 'data/artifacts');
    const outcome = await runNightlyCli(process.argv.slice(2), { dataPool: pool, execPool: pool, store, calendar }, undefined,
      (line) => console.log(line));
    console.log(`[lyra-nightly] 完成（exit 0）：${outcome.date} 第 ${String(outcome.nth)} 晚，` +
      `rot=${outcome.rotation.length} postEvent=${outcome.postEventMerged.length} permits=${String(outcome.permitsCreated)} ` +
      `conclusions=${String(outcome.conclusionsCreated)} settleDue=${outcome.settleDue === null ? 'off' : 'on'}`);
  } finally {
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('schedule/nightly.ts');
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[lyra-nightly] FATAL ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
