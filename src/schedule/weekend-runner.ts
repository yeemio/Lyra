/**
 * Lyra · 周末复盘真实接线（P3 W20: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §11（SC-11.1 零模型调用、SC-11.2 结算、SC-11.3 档案更新、
 * SC-11.4 周报只含工程与流程质量字段）；§3.4（触发周六、截点周五收盘）；
 * docs/specs/P3-EVENTS-REVIEW.md Done-when 4（周末复盘编排 + 结算回填接线到结论对象占位区）；
 * 占位区回填纪律：docs/specs/RESEARCH-METHOD.md §8（回填只写占位区，研究字段不可变）。
 *
 * 与 W17 weekend.ts 的分工：W17 冻结计划形态与端口协议（planWeekendReview /
 * buildWeekendReport / validateWeekendReportNoEffectFields / assertZeroModelCalls），本模块
 * 做**真实接线**——个股结论接 W13 settleConclusion、宽基结论接 W19 settleEtfConclusion，
 * 结算产物经 R26.2 backfillSettlement 回填到结论对象占位区（SETTLED 定点字符串或
 * ANOMALY 具名，不做预测性回填），并复核研究字段未被触碰。
 *
 * 跨库接线：结算引擎只读事实（fact 表），结论落库在结论库。生产两者同一 public 库；
 * 测试可注入 factPool 指向真实事实库（public），结论库用隔离 schema。
 * 全程零模型调用（SC-11.1）：本模块不构造任何 permit/调用合同；收口以
 * exec_permit 计数差（或注入探针）断言。
 */
import type { Pool } from 'pg';
import type { TradeCalendarTable } from '../adapters/calendar.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { Disposition, SettlementZone, SubjectKind } from '../contracts.js';
import { validDispositions } from '../contracts.js';
import { readConclusion } from '../db/conclusion.js';
import { backfillSettlement } from '../conclusion/settlement.js';
import { canonicalJsonString } from '../canonical.js';
import { researchCoreOf } from '../conclusion/object.js';
import { settleConclusion, type SettleOutcome } from '../settlement/settle.js';
import { settleEtfConclusion, type EtfSettleOutcome } from '../settlement/etf.js';
import {
  assertZeroModelCalls,
  buildWeekendReport,
  planWeekendReview,
  validateWeekendReportNoEffectFields,
  type IntegrityCheckResult,
  type WeekendProcessMetrics,
  type WeekendReport,
  type WeekendReviewPlan,
} from './weekend.js';
import { ScheduleError } from './windows.js';
// W27 追加：metrics.ts 真实指标端口的默认接线（collectProcessMetrics / checkArtifactIntegrity /
// refreshGapList 三端口的库面真实实现；仅当调用方未注入且提供 store 时生效，注入优先）。
import {
  checkArtifactIntegrityFromDb,
  collectProcessMetrics as collectProcessMetricsImpl,
  refreshGapList as refreshGapListImpl,
  weekWindowOfSaturday,
} from './metrics.js';

/** 到期未结算结论视图（调度侧按"已到期未结算"筛好传入；字段取结论对象读回值）。 */
export interface DueConclusionView {
  conclusionId: string;
  subjectKind: SubjectKind;
  subject: string;
  disposition: Disposition;
  /** 结论完成时刻（SR-3.1 参考价锚点）。 */
  conclusionTime: string;
  /** 资料截点（SR-3.5 行业基准身份冻结时点；宽基结算不消费）。 */
  cutoff: string;
}

export interface WeekendRunnerDeps {
  /** 结论库（结算回填写 conclusion 表 + 零调用计数读 exec_permit）。 */
  pool: Pool;
  /** 结算事实读取库（缺省同 pool；测试可指向 public 真实事实）。 */
  factPool?: Pool;
  calendar: TradeCalendarTable;
  /**
   * SC-11.4 工程与流程质量指标（W27 起可选：未注入且提供 store 时默认接线
   * metrics.ts 真实采集，周窗口 = weekWindowOfSaturday(saturday)；两者皆缺具名拒绝）。
   */
  collectProcessMetrics?(): Promise<WeekendProcessMetrics>;
  /** SC-11.3 ① 原件完整性核对（可选端口；缺省接线 metrics.ts 抽查，无 store 记 null 不猜）。 */
  checkArtifactIntegrity?(): Promise<IntegrityCheckResult>;
  /** SC-11.3 ② 缺口清单刷新（可选端口；缺省接线 metrics.ts（seal 缺口并集）；无 store 时空清单）。 */
  refreshGapList?(): Promise<string[]>;
  /** 复盘运行时段 permit 新增数探针（缺省实测 exec_permit 计数差）。 */
  permitsCreatedDuringReview?(): Promise<number>;
  /** W27 追加：原件库（真实指标端口的默认接线条件；测试注入替身时不需）。 */
  store?: ArtifactStore;
}

export interface WeekendRunnerOptions {
  /** 触发周六（YYYY-MM-DD；非周六具名拒绝，§3.4）。 */
  saturday: string;
  /** 已到期未结算结论（由调用方按到期筛选注入）。 */
  conclusions: readonly DueConclusionView[];
  /** 结算事实读取 as-of（默认当前时刻）。 */
  asOf?: Date;
  /** 结算窗口长度（默认 SR-3.3 的 20）。 */
  window?: number;
}

/** 单条结论的结算与回填结果（占位区回填形态可读回）。 */
export interface WeekendConclusionEntry {
  conclusionId: string;
  subjectKind: SubjectKind;
  subject: string;
  outcome: 'SETTLED' | 'ANOMALY' | 'UNSETTLED' | 'SKIPPED';
  /** UNSETTLED 的 reason / SKIPPED 的原因 / ANOMALY 的具名 code。 */
  code: string | null;
  detail: string | null;
  /** 占位区回填形态（SETTLED / ANOMALY）；未回填为 null（未到期不预测性回填）。 */
  backfilled: 'SETTLED' | 'ANOMALY' | null;
  /** 回填后的占位区（未回填为 null）。 */
  settlement: SettlementZone | null;
  /** 研究字段快照全等复核（回填前后 researchCore canonical 一致）。 */
  researchFieldsUnchanged: boolean;
}

export interface WeekendSettlementTally {
  attempted: number;
  settled: number;
  anomaly: number;
  unsettled: number;
  skipped: number;
}

export interface WeekendRunOutcome {
  plan: WeekendReviewPlan;
  settlement: { tally: WeekendSettlementTally; entries: WeekendConclusionEntry[] };
  artifactIntegrity: IntegrityCheckResult | null;
  gapList: { current: string[]; added: string[]; resolved: string[] } | null;
  report: WeekendReport;
  permitsCreatedDuringReview: number;
  zeroModelCallsVerified: true;
}

async function countPermits(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>('select count(*)::text as n from exec_permit');
  return Number(r.rows[0]?.n ?? 0);
}

function tallyOf(entries: readonly WeekendConclusionEntry[]): WeekendSettlementTally {
  const t: WeekendSettlementTally = { attempted: 0, settled: 0, anomaly: 0, unsettled: 0, skipped: 0 };
  for (const e of entries) {
    if (e.outcome === 'SKIPPED') t.skipped += 1;
    else {
      t.attempted += 1;
      if (e.outcome === 'SETTLED') t.settled += 1;
      else if (e.outcome === 'ANOMALY') t.anomaly += 1;
      else t.unsettled += 1;
    }
  }
  return t;
}

/**
 * 执行周末复盘（真实接线）：planWeekendReview → 逐条结算（个股 W13 / 宽基 W19）→
 * backfillSettlement 回填占位区（SETTLED / ANOMALY 具名；UNSETTLED 不回填）→
 * 周报（W17 白名单校验）→ 零模型调用断言（SC-11.1）。
 * 结算异常不中断复盘（SR-10.4 具名登记）；基础设施故障如实上抛不冒充结算异常。
 */
export async function runWeekend(
  deps: WeekendRunnerDeps,
  opts: WeekendRunnerOptions,
): Promise<WeekendRunOutcome> {
  // 0) 计划（§3.4：周六触发、周五收盘截点、固定步骤、零调用声明）。
  const plan = planWeekendReview(deps.calendar, opts.saturday);
  const factPool = deps.factPool ?? deps.pool;
  const asOfField = opts.asOf === undefined ? {} : { asOf: opts.asOf };
  const permitsBefore = await countPermits(deps.pool);

  // W27 追加（默认端口接线，一处）：SC-11.3/11.4 三端口未注入且提供 store 时默认用
  // metrics.ts 真实实现（注入替身优先——测试与定制面行为不变）。
  const window = weekWindowOfSaturday(plan.saturday);
  const collectProcessMetrics: () => Promise<WeekendProcessMetrics> =
    deps.collectProcessMetrics ??
    (deps.store === undefined
      ? (() => {
          throw new ScheduleError(
            'METRICS_PORT_REQUIRED',
            'collectProcessMetrics 未注入且未提供 store（W27 默认接线条件）；二者其一必选',
          );
        })()
      : () => collectProcessMetricsImpl(deps.pool, { ...window, store: deps.store as ArtifactStore }));
  const checkArtifactIntegrity: (() => Promise<IntegrityCheckResult>) | undefined =
    deps.checkArtifactIntegrity ?? (deps.store === undefined ? undefined : () => checkArtifactIntegrityFromDb(deps.pool, deps.store as ArtifactStore));
  const refreshGapListPort: (() => Promise<string[]>) | undefined =
    deps.refreshGapList ?? (deps.store === undefined ? undefined : () => refreshGapListImpl(deps.pool));

  // ① 结算 + 回填（SC-11.2；结算异常具名登记，不中断其余结论）。
  const entries: WeekendConclusionEntry[] = [];
  for (const c of opts.conclusions) {
    const base = { conclusionId: c.conclusionId, subjectKind: c.subjectKind, subject: c.subject };
    const existing = await readConclusion(deps.pool, c.conclusionId);
    if (existing === null) {
      entries.push({ ...base, outcome: 'SKIPPED', code: 'CONCLUSION_MISSING', detail: `结论 ${c.conclusionId} 不在结论库`, backfilled: null, settlement: null, researchFieldsUnchanged: true });
      continue;
    }
    if (existing.settlement.state !== 'UNSETTLED') {
      entries.push({ ...base, outcome: 'SKIPPED', code: 'ALREADY_BACKFILLED', detail: `占位区 ${existing.settlement.state}，非未结算`, backfilled: null, settlement: existing.settlement, researchFieldsUnchanged: true });
      continue;
    }
    if (!validDispositions(c.subjectKind).includes(c.disposition)) {
      entries.push({ ...base, outcome: 'SKIPPED', code: 'DISPOSITION_SPACE_INVALID', detail: `${c.subjectKind} 结论 ${c.disposition} 跨类（R18）`, backfilled: null, settlement: null, researchFieldsUnchanged: true });
      continue;
    }
    const coreBefore = canonicalJsonString(researchCoreOf(existing));
    let outcome: SettleOutcome | EtfSettleOutcome;
    if (existing.businessKey.subjectKind === 'STOCK') {
      // 上面 validDispositions(STOCK) 已含跨类拒绝；收窄到个股结算空间后交 W13。
      outcome = await settleConclusion(factPool, {
        subject: existing.businessKey.subject,
        disposition: existing.disposition as 'RESEARCH_OUTPERFORM' | 'RESEARCH_UNDERPERFORM' | 'ABSTAIN',
        conclusionTime: c.conclusionTime,
        benchmark: existing.evidence.benchmark,
        cutoff: existing.businessKey.cutoff,
        ...asOfField,
        ...(opts.window === undefined ? {} : { window: opts.window }),
      });
    } else {
      outcome = await settleEtfConclusion(factPool, {
        subject: existing.businessKey.subject,
        disposition: existing.disposition as 'RESEARCH_UP' | 'RESEARCH_DOWN' | 'ABSTAIN',
        cutoff: existing.businessKey.cutoff,
        conclusionTime: c.conclusionTime,
        benchmark: existing.evidence.benchmark,
        ...asOfField,
        ...(opts.window === undefined ? {} : { window: opts.window }),
      });
    }

    if (outcome.state === 'UNSETTLED') {
      // 未到期不提前结算（SR-2.4）：不回填、原样保留占位区。
      entries.push({ ...base, outcome: 'UNSETTLED', code: outcome.reason, detail: outcome.detail, backfilled: null, settlement: null, researchFieldsUnchanged: true });
      continue;
    }
    const backfill =
      outcome.state === 'SETTLED'
        ? outcome.zone
        : { state: 'ANOMALY' as const, anomalyCode: outcome.code, anomalyDetail: outcome.detail };
    const after = await backfillSettlement(deps.pool, c.conclusionId, backfill);
    const researchFieldsUnchanged = canonicalJsonString(researchCoreOf(after)) === coreBefore;
    entries.push({
      ...base,
      outcome: outcome.state,
      code: outcome.state === 'ANOMALY' ? outcome.code : null,
      detail: outcome.state === 'ANOMALY' ? outcome.detail : null,
      backfilled: outcome.state,
      settlement: after.settlement,
      researchFieldsUnchanged,
    });
  }

  // ② SC-11.3 ① 原件完整性核对（可选端口；未接线如实记 null，不猜）。
  const artifactIntegrity = checkArtifactIntegrity === undefined ? null : await checkArtifactIntegrity();

  // ③ SC-11.3 ② 缺口清单刷新（可选端口；缺省空清单，读回可见）。
  const gapListCurrent = refreshGapListPort === undefined ? [] : await refreshGapListPort();

  // ④ 周报（SC-11.4：复用 W17 buildWeekendReport + 白名单校验——不含任何效果评价字段）。
  const metrics = await collectProcessMetrics();
  const report = buildWeekendReport(metrics, plan, gapListCurrent);
  const validation = validateWeekendReportNoEffectFields(report as unknown as Record<string, unknown>);
  if (!validation.ok) {
    throw new ScheduleError('WEEKEND_REPORT_FIELD_INVALID', `周报出现白名单外字段：${validation.offending.join(', ')}`);
  }

  // 零模型调用断言（SC-11.1）：permit 新增数 > 0 即违约（具名抛错，不静默）。
  const permitsCreated = deps.permitsCreatedDuringReview === undefined
    ? (await countPermits(deps.pool)) - permitsBefore
    : await deps.permitsCreatedDuringReview();
  assertZeroModelCalls(permitsCreated);

  return {
    plan,
    settlement: { tally: tallyOf(entries), entries },
    artifactIntegrity,
    gapList:
      refreshGapListPort === undefined
        ? null
        : { current: gapListCurrent, added: report.gapListDelta.added, resolved: report.gapListDelta.resolved },
    report,
    permitsCreatedDuringReview: permitsCreated,
    zeroModelCallsVerified: true,
  };
}
