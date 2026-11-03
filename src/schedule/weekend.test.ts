/**
 * Lyra · 周末复盘编排单测（P3 W17: code-writer-pro）。端口注入替身，无网络无 DB。
 * 合同判定：SCHEDULING.md §3.4（周六/周五收盘）、SC-11.1（零模型调用）、SC-11.2（结算接线）、
 * SC-11.3（原件核对/缺口刷新）、SC-11.4（周报零效果评价字段）。
 * W13 探测：settleConclusion 已交付（SETTLEMENT_READY），默认端口需 pool；替身注入时直连编排。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTradeCalendarTable } from '../adapters/calendar.js';
import type { SettleOutcome } from '../settlement/settle.js';
import {
  assertZeroModelCalls,
  buildWeekendReport,
  planWeekendReview,
  runWeekendReview,
  SETTLEMENT_BASIS,
  SETTLEMENT_READY,
  validateWeekendReportNoEffectFields,
  type DueStockConclusion,
  type WeekendDeps,
  type WeekendProcessMetrics,
} from './weekend.js';
import { ScheduleError, shanghaiInstant } from './windows.js';

const CAL = buildTradeCalendarTable(
  ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
    .map((d) => ({ calendar_date: d, is_trading_day: '1' })),
);

const METRICS: WeekendProcessMetrics = {
  windowCompletion: { onWindowCompleted: 28, total: 30 },
  overflowDegraded: 3,
  notOnWindow: 1,
  unknown: 0,
  paused: 1,
  blocked: 1,
  weeklyModelCalls: 62,
  postEventModelCalls: 8,
  deferredBacklog: 4,
  gapListPrevious: ['gap:sw2014', 'gap:margin'],
};

function fakeDeps(over?: Partial<WeekendDeps>): WeekendDeps {
  return {
    listDueStockConclusions: async (): Promise<DueStockConclusion[]> => [
      { conclusionId: 'c:1', subject: '600519', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2026-09-14T13:00:00.000Z', cutoff: '2026-09-12T10:00:00.000Z' },
      { conclusionId: 'c:2', subject: '000938', disposition: 'RESEARCH_UNDERPERFORM', conclusionTime: '2026-09-15T13:00:00.000Z', cutoff: '2026-09-12T10:00:00.000Z' },
      // 宽基 disposition 走窄类型之外的值（越界数据防御）：运行时具名跳过
      { conclusionId: 'c:3', subject: '600176', disposition: 'RESEARCH_UP' as DueStockConclusion['disposition'], conclusionTime: '2026-09-16T13:00:00.000Z', cutoff: '2026-09-12T10:00:00.000Z' },
    ],
    settle: async (): Promise<SettleOutcome> => ({ state: 'SETTLED', zone: { state: 'SETTLED', directionHit: true, excessReturn: '0.05', maxAdverse: '-0.01', tradability: 'NORMAL' }, diagnostics: {} as never }),
    checkArtifactIntegrity: async () => ({ checked: 42, missing: [{ sha256: 'ab', label: 'seal:600519' }], corrupted: [] }),
    refreshGapList: async () => ['gap:sw2014', 'gap:new'],
    collectProcessMetrics: async () => METRICS,
    permitsCreatedDuringReview: async () => 0,
    ...over,
  };
}

// ===== §3.4 周末计划 =====

test('§3.4：计划对象 = 周六触发、周五收盘截点、固定四步、零模型调用声明、结算就绪探测', () => {
  assert.equal(SETTLEMENT_READY, true);
  assert.ok(SETTLEMENT_BASIS.includes('settleConclusion'));
  const plan = planWeekendReview(CAL, '2026-10-10');
  assert.equal(plan.saturday, '2026-10-10');
  assert.equal(plan.cutoffDay, '2026-10-09'); // 周五收盘
  assert.equal(plan.zeroModelCalls, true);
  assert.deepEqual(plan.steps, ['SETTLEMENT', 'ARTIFACT_INTEGRITY', 'GAP_LIST_REFRESH', 'WEEKLY_REPORT']);
  assert.equal(plan.settlementReady, true);
});

test('§3.4：非周六具名拒绝', () => {
  assert.throws(
    () => planWeekendReview(CAL, '2026-10-12'),
    (e: unknown) => e instanceof ScheduleError && e.code === 'WEEKEND_NOT_SATURDAY',
  );
});

// ===== SC-11.2 结算接线 =====

test('SC-11.2：结算步骤消费到期个股结论；宽基 disposition 具名跳过不猜', async () => {
  const outcomes: Record<string, SettleOutcome> = {
    'c:1': { state: 'SETTLED', zone: { state: 'SETTLED', directionHit: true, excessReturn: '0.05', maxAdverse: '-0.01', tradability: 'NORMAL' }, diagnostics: {} as never },
    'c:2': { state: 'UNSETTLED', reason: 'WINDOW_INCOMPLETE', detail: '窗口未走完', reference: {} as never },
  };
  const seen: string[] = [];
  const deps = fakeDeps({
    settle: async (c) => {
      seen.push(c.conclusionId);
      return outcomes[c.conclusionId] ?? ({ state: 'ANOMALY', code: 'INDUSTRY_BENCHMARK_MISSING', detail: 'x' } as SettleOutcome);
    },
  });
  const plan = planWeekendReview(CAL, '2026-10-10');
  const out = await runWeekendReview(plan, deps);
  assert.deepEqual(seen, ['c:1', 'c:2']); // c:3 宽基未进结算
  assert.deepEqual(out.settlement, { attempted: 2, settled: 1, unsettled: 1, anomaly: 0, skipped: [{ conclusionId: 'c:3', reason: 'NON_STOCK_DISPOSITION' }] });
});

test('SC-11.2：默认端口接线 W13 需 pool，缺 pool 且无替身具名报错（不猜）', async () => {
  const plan = planWeekendReview(CAL, '2026-10-10');
  const { settle: _omitSettle, ...depsNoSettle } = fakeDeps();
  await assert.rejects(
    () => runWeekendReview(plan, depsNoSettle),
    (e: unknown) => e instanceof ScheduleError && e.code === 'SETTLEMENT_POOL_REQUIRED',
  );
});

// ===== SC-11.3 档案更新 =====

test('SC-11.3 证伪：抽走一份已登记原件 → 复盘点名清单出现该件具名缺失；缺口清单刷新可读回', async () => {
  const plan = planWeekendReview(CAL, '2026-10-10');
  const out = await runWeekendReview(plan, fakeDeps());
  assert.deepEqual(out.artifactIntegrity, { checked: 42, missing: [{ sha256: 'ab', label: 'seal:600519' }], corrupted: [] });
  assert.deepEqual(out.gapList.current, ['gap:sw2014', 'gap:new']);
  assert.deepEqual(out.gapList.added, ['gap:new']);
  assert.deepEqual(out.gapList.resolved, ['gap:margin']);
});

// ===== SC-11.1 零模型调用 =====

test('SC-11.1 证伪：复盘时段 permit 新增 > 0 即具名违约', () => {
  assert.throws(
    () => assertZeroModelCalls(1),
    (e: unknown) => e instanceof ScheduleError && e.code === 'WEEKEND_MODEL_CALL_VIOLATION',
  );
  assert.doesNotThrow(() => assertZeroModelCalls(0));
});

test('SC-11.1：runWeekendReview 收口断言零调用；探针报 1 → 整体违约', async () => {
  const plan = planWeekendReview(CAL, '2026-10-10');
  const ok = await runWeekendReview(plan, fakeDeps());
  assert.equal(ok.zeroModelCallsVerified, true);
  await assert.rejects(
    () => runWeekendReview(plan, fakeDeps({ permitsCreatedDuringReview: async () => 1 })),
    (e: unknown) => e instanceof ScheduleError && e.code === 'WEEKEND_MODEL_CALL_VIOLATION',
  );
});

// ===== SC-11.4 周报 =====

test('SC-11.4 证伪：周报只含工程与流程质量字段，无任何收益、命中率类字段', async () => {
  const plan = planWeekendReview(CAL, '2026-10-10');
  const out = await runWeekendReview(plan, fakeDeps());
  const report = out.report;
  assert.equal(report.reportKind, 'WEEKLY_PROCESS_REPORT');
  assert.equal(report.onWindowCompletionRate.rate, (28 / 30).toFixed(4));
  assert.equal(report.overflowDegradedCount, 3);
  assert.deepEqual(report.budgetUsage, { weeklyModelCalls: 62, postEventModelCalls: 8, weeklyBaseline: 60, postEventBaseline: 10 });
  assert.equal(report.effectEvaluationFields, 'NONE');
  assert.equal(validateWeekendReportNoEffectFields(report as unknown as Record<string, unknown>).ok, true);
  // 注入效果类字段 → 白名单拒绝
  const withExcess = { ...report, excessReturn: '0.12' } as unknown as Record<string, unknown>;
  assert.deepEqual(validateWeekendReportNoEffectFields(withExcess), { ok: false, offending: ['excessReturn'] });
  const withHit = { ...report, directionHitRate: '0.67' } as unknown as Record<string, unknown>;
  assert.deepEqual(validateWeekendReportNoEffectFields(withHit), { ok: false, offending: ['directionHitRate'] });
});

test('SC-11.4：分母为 0 时按窗完成率 rate 为 null（不造数）', () => {
  const plan = planWeekendReview(CAL, '2026-10-10');
  const report = buildWeekendReport({ ...METRICS, windowCompletion: { onWindowCompleted: 0, total: 0 } }, plan, []);
  assert.equal(report.onWindowCompletionRate.rate, null);
});
