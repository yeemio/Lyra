/**
 * Lyra · 周末复盘编排（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §11（SC-11.1 零模型调用、SC-11.2 结算、SC-11.3 档案更新、
 * SC-11.4 周报只含工程与流程质量字段）；§3.4（触发周六、截点周五收盘）。
 *
 * 编排边界：本模块只提供时点入口与步骤编排，端口（到期结论清单、原件完整性核对、
 * 缺口清单刷新、过程指标、permit 计数探针）由调用方注入。结算引擎按派发要求先探测——
 * W13 已交付（src/settlement/settle.ts settleConclusion，tsc 基线绿），据此接线为默认端口；
 * 若未来结算面不可用，抛具名 SETTLEMENT_NOT_READY 登记不猜。
 * 全程零模型调用：编排结构上不构造任何 permit/调用合同，并以探针计数断言（SC-11.1）。
 */
import { lastTradingDayOnOrBefore, type TradeCalendarTable } from '../adapters/calendar.js';
import type { Pool } from 'pg';
import { settleConclusion, type SettleOutcome } from '../settlement/settle.js';
import { ScheduleError, shanghaiInstant, shanghaiWall, shanghaiWeekday } from './windows.js';
import { POST_EVENT_BASELINE_PER_WEEK, WEEKLY_BASELINE_PER_WEEK } from './queue.js';

// ===== W13 就绪探测（派发要求：先探测，不猜）=====

export const SETTLEMENT_READY = true as const;
export const SETTLEMENT_BASIS =
  'src/settlement/settle.ts settleConclusion（P3 W13 已交付：个股六结算字段 + 参考价/窗口/逐日序列；宽基 SR-8A 未在本实现面）';

/** 接口位：结算面不可用时的具名登记（当前接线为 W13 默认端口，正常路径不抛）。 */
export class SettlementNotReadyError extends Error {
  readonly code = 'SETTLEMENT_NOT_READY';
  constructor(detail: string) {
    super(`SETTLEMENT_NOT_READY: ${detail}`);
    this.name = 'SettlementNotReadyError';
  }
}

// ===== 编排计划 =====

export type WeekendStepKind = 'SETTLEMENT' | 'ARTIFACT_INTEGRITY' | 'GAP_LIST_REFRESH' | 'WEEKLY_REPORT';

export interface WeekendReviewPlan {
  planKind: 'WEEKEND_REVIEW';
  saturday: string;
  /** 资料截点日：周五（或其前最近交易日）收盘。 */
  cutoffDay: string;
  zeroModelCalls: true;
  steps: WeekendStepKind[];
  settlementReady: typeof SETTLEMENT_READY;
}

/** 周末复盘计划：触发周六、截点周五收盘、固定四步（SC-11.2/11.3/11.4）。 */
export function planWeekendReview(calendar: TradeCalendarTable, saturday: string): WeekendReviewPlan {
  if (shanghaiWeekday(saturday) !== 6) {
    throw new ScheduleError('WEEKEND_NOT_SATURDAY', `${saturday} 非周六（周末复盘触发周六，§3.4）`);
  }
  const friday = shanghaiWall(new Date(shanghaiInstant(saturday, '00:00:00').getTime() - 86_400_000)).date; // 上海墙钟日（非 UTC）
  return {
    planKind: 'WEEKEND_REVIEW',
    saturday,
    cutoffDay: lastTradingDayOnOrBefore(calendar, friday),
    zeroModelCalls: true,
    steps: ['SETTLEMENT', 'ARTIFACT_INTEGRITY', 'GAP_LIST_REFRESH', 'WEEKLY_REPORT'],
    settlementReady: SETTLEMENT_READY,
  };
}

// ===== 端口 =====

/** 到期个股结论（结算输入；宽基 SR-8A 未实现，具名跳过不猜）。 */
export interface DueStockConclusion {
  conclusionId: string;
  subject: string;
  disposition: 'RESEARCH_OUTPERFORM' | 'RESEARCH_UNDERPERFORM' | 'ABSTAIN';
  conclusionTime: string;
  cutoff: string;
}

/** 原件完整性核对结果（SC-11.3 ①；机制见 POINT-IN-TIME §9，哈希核对由端口实现）。 */
export interface IntegrityCheckResult {
  checked: number;
  missing: { sha256: string; label: string }[];
  corrupted: { sha256: string; label: string }[];
}

/** 工程与流程质量指标（SC-11.4；不含任何效果评价字段）。 */
export interface WeekendProcessMetrics {
  windowCompletion: { onWindowCompleted: number; total: number };
  /** 溢出降级计数（SC-6.2 独立类别）。 */
  overflowDegraded: number;
  notOnWindow: number;
  unknown: number;
  paused: number;
  blocked: number;
  weeklyModelCalls: number;
  postEventModelCalls: number;
  /** 顺延堆积（跨周）。 */
  deferredBacklog: number;
  gapListPrevious: string[];
}

export interface WeekendDeps {
  /** 默认结算端口（W13 settleConclusion 直连）所需的 PG 连接池；注入 settle 替身时可不带。 */
  pool?: Pool;
  listDueStockConclusions(): Promise<DueStockConclusion[]>;
  /** 默认接线 W13（需 pool）；测试注入替身。 */
  settle?(c: DueStockConclusion): Promise<SettleOutcome>;
  checkArtifactIntegrity(): Promise<IntegrityCheckResult>;
  refreshGapList(): Promise<string[]>;
  collectProcessMetrics(): Promise<WeekendProcessMetrics>;
  /** 复盘运行时段新增 permit 数探针（零调用断言依据）。 */
  permitsCreatedDuringReview(): Promise<number>;
}

// ===== 周报对象（SC-11.4）=====

export interface WeekendReport {
  reportKind: 'WEEKLY_PROCESS_REPORT';
  saturday: string;
  cutoffDay: string;
  /** 按窗完成率（工程质量；分母 0 时 rate 为 null）。 */
  onWindowCompletionRate: { completed: number; total: number; rate: string | null };
  overflowDegradedCount: number;
  notOnWindowCount: number;
  unknownCount: number;
  pausedCount: number;
  blockedCount: number;
  budgetUsage: {
    weeklyModelCalls: number;
    postEventModelCalls: number;
    weeklyBaseline: typeof WEEKLY_BASELINE_PER_WEEK;
    postEventBaseline: typeof POST_EVENT_BASELINE_PER_WEEK;
  };
  deferredBacklog: number;
  gapListCurrent: string[];
  gapListDelta: { added: string[]; resolved: string[] };
  zeroModelCalls: true;
  /** 显式声明：不做效果评价（PLAN §7：2027 年 5 月底前只评价工程与流程质量）。 */
  effectEvaluationFields: 'NONE';
}

/** 周报字段冻结白名单（SC-11.4 证伪：模板中不存在任何收益、命中率类字段）。 */
export const WEEKEND_REPORT_FIELDS: readonly string[] = [
  'reportKind', 'saturday', 'cutoffDay', 'onWindowCompletionRate', 'overflowDegradedCount',
  'notOnWindowCount', 'unknownCount', 'pausedCount', 'blockedCount', 'budgetUsage',
  'deferredBacklog', 'gapListCurrent', 'gapListDelta', 'zeroModelCalls', 'effectEvaluationFields',
];

export function buildWeekendReport(metrics: WeekendProcessMetrics, plan: WeekendReviewPlan, gapListCurrent: string[]): WeekendReport {
  const { onWindowCompleted, total } = metrics.windowCompletion;
  const rate = total === 0 ? null : (onWindowCompleted / total).toFixed(4);
  const prev = new Set(metrics.gapListPrevious);
  const curr = new Set(gapListCurrent);
  return {
    reportKind: 'WEEKLY_PROCESS_REPORT',
    saturday: plan.saturday,
    cutoffDay: plan.cutoffDay,
    onWindowCompletionRate: { completed: onWindowCompleted, total, rate },
    overflowDegradedCount: metrics.overflowDegraded,
    notOnWindowCount: metrics.notOnWindow,
    unknownCount: metrics.unknown,
    pausedCount: metrics.paused,
    blockedCount: metrics.blocked,
    budgetUsage: {
      weeklyModelCalls: metrics.weeklyModelCalls,
      postEventModelCalls: metrics.postEventModelCalls,
      weeklyBaseline: WEEKLY_BASELINE_PER_WEEK,
      postEventBaseline: POST_EVENT_BASELINE_PER_WEEK,
    },
    deferredBacklog: metrics.deferredBacklog,
    gapListCurrent: [...gapListCurrent],
    gapListDelta: {
      added: gapListCurrent.filter((g) => !prev.has(g)),
      resolved: metrics.gapListPrevious.filter((g) => !curr.has(g)),
    },
    zeroModelCalls: true,
    effectEvaluationFields: 'NONE',
  };
}

/** SC-11.4 程序校验：字段超出冻结白名单（含任何效果类字段）即拒绝。 */
export function validateWeekendReportNoEffectFields(report: Record<string, unknown>): { ok: true } | { ok: false; offending: string[] } {
  const allowed = new Set(WEEKEND_REPORT_FIELDS);
  const offending = Object.keys(report).filter((k) => !allowed.has(k));
  return offending.length === 0 ? { ok: true } : { ok: false, offending };
}

// ===== 零模型调用断言（SC-11.1）=====

/** 复盘运行时段 permit 新增数 > 0 即违约（具名抛错，不静默）。 */
export function assertZeroModelCalls(permitsCreatedDuringReview: number): void {
  if (permitsCreatedDuringReview > 0) {
    throw new ScheduleError(
      'WEEKEND_MODEL_CALL_VIOLATION',
      `周末复盘新增 permit ${String(permitsCreatedDuringReview)} 个（SC-11.1：周末复盘全程零模型调用）`,
    );
  }
}

// ===== 编排执行 =====

export interface WeekendSettlementTally {
  attempted: number;
  settled: number;
  unsettled: number;
  anomaly: number;
  skipped: { conclusionId: string; reason: 'NON_STOCK_DISPOSITION' }[];
}

export interface WeekendReviewOutcome {
  plan: WeekendReviewPlan;
  settlement: WeekendSettlementTally;
  artifactIntegrity: IntegrityCheckResult;
  gapList: { current: string[]; added: string[]; resolved: string[] };
  report: WeekendReport;
  zeroModelCallsVerified: true;
}

/**
 * 执行周末复盘（固定四步）：结算到期个股结论 → 原件完整性核对 → 缺口清单刷新 → 周报。
 * 收口断言零模型调用（SC-11.1）。宽基结论不在 W13 结算面，具名跳过不猜。
 */
export async function runWeekendReview(plan: WeekendReviewPlan, deps: WeekendDeps): Promise<WeekendReviewOutcome> {
  if (!plan.settlementReady) {
    throw new SettlementNotReadyError('结算引擎未就绪（接口位保留，具名登记不猜）');
  }
  const settle =
    deps.settle ??
    (() => {
      if (deps.pool === undefined) {
        throw new ScheduleError(
          'SETTLEMENT_POOL_REQUIRED',
          '默认结算端口接线 W13 settleConclusion 需要 pool（或注入 settle 替身）',
        );
      }
      const pool = deps.pool;
      return (c: DueStockConclusion): Promise<SettleOutcome> =>
        settleConclusion(pool, {
          subject: c.subject,
          disposition: c.disposition,
          conclusionTime: c.conclusionTime,
          cutoff: c.cutoff,
        });
    })();

  // ① 结算（SC-11.2：调度只提供时点入口，口径归 SETTLEMENT-REVIEW）
  const due = await deps.listDueStockConclusions();
  const tally: WeekendSettlementTally = { attempted: 0, settled: 0, unsettled: 0, anomaly: 0, skipped: [] };
  for (const c of due) {
    const isStockDisposition =
      c.disposition === 'RESEARCH_OUTPERFORM' || c.disposition === 'RESEARCH_UNDERPERFORM' || c.disposition === 'ABSTAIN';
    if (!isStockDisposition) {
      tally.skipped.push({ conclusionId: c.conclusionId, reason: 'NON_STOCK_DISPOSITION' });
      continue;
    }
    tally.attempted += 1;
    const outcome = await settle(c);
    if (outcome.state === 'SETTLED') tally.settled += 1;
    else if (outcome.state === 'UNSETTLED') tally.unsettled += 1;
    else tally.anomaly += 1;
  }

  // ② 原件完整性核对（SC-11.3 ①）
  const artifactIntegrity = await deps.checkArtifactIntegrity();

  // ③ 缺口清单刷新（SC-11.3 ②：读回与界面可见）
  const gapListCurrent = await deps.refreshGapList();

  // ④ 周报（SC-11.4）
  const metrics = await deps.collectProcessMetrics();
  const report = buildWeekendReport(metrics, plan, gapListCurrent);
  const validation = validateWeekendReportNoEffectFields(report as unknown as Record<string, unknown>);
  if (!validation.ok) {
    throw new ScheduleError('WEEKEND_REPORT_FIELD_INVALID', `周报出现白名单外字段：${validation.offending.join(', ')}`);
  }

  // 零模型调用断言（SC-11.1）
  assertZeroModelCalls(await deps.permitsCreatedDuringReview());

  return {
    plan,
    settlement: tally,
    artifactIntegrity,
    gapList: { current: gapListCurrent, added: report.gapListDelta.added, resolved: report.gapListDelta.resolved },
    report,
    zeroModelCallsVerified: true,
  };
}
