/**
 * Lyra · 财报质量确定性指标库单测（B4 / W35: code-writer-pro）。纯合成事实，不碰网络、不碰 DB。
 * 覆盖：scale-12 定点断言（独立手算预言，非调用被测函数复算）、缺列/空值/分母 0 的 null 语义
 * （null 不为 0）、as-of 过滤（截点后事实不进任何序列、截点恰等于可见）、8 期窗口截断、
 * 同比报告期对齐（错位拒绝：上年缺期不与相邻季度配对；上年空值/为 0 拒绝）、
 * 同报告期多行取 availableAt 最新（修订口径）、方向/差值（首非空 vs 末非空）、
 * 非标准季末行跳过并具名计数、空输入诚实空结果、value=最新报告期值语义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimePointFact } from '../contracts.js';
import {
  FORMULA_EARNING_REVENUE_DIVERGENCE,
  FORMULA_GOODWILL_INTENSITY,
  FORMULA_LIABILITY_ASSET_RATIO,
  FORMULA_NET_MARGIN_TREND,
  QUALITY_LIBRARY_VERSION,
  QUALITY_WINDOW_PERIODS,
  QualityError,
  qualityIndicators,
} from './quality.js';

// ===== 夹具 =====

let seq = 0;

function baseFact(factKind: string, typedValue: Record<string, unknown>, availableAt: string): TimePointFact {
  seq += 1;
  return {
    factId: `fact-${factKind.toLowerCase()}-${seq}`,
    subjectType: 'STOCK',
    subjectId: '000001',
    factKind,
    typedValue,
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: availableAt,
    availableAt,
    supersedesFactId: null,
    artifactSha256: 'ab'.repeat(32),
    adapterVersion: 'fixture@w35',
  };
}

function profitRow(statDate: string, fields: Record<string, unknown>, availableAt = '2025-08-01T00:00:00.000Z'): TimePointFact {
  return baseFact('FINANCIAL', { bsQuery: 'profit', statDate, pubDate: statDate, ...fields }, availableAt);
}

function growthRow(statDate: string, fields: Record<string, unknown>, availableAt = '2025-08-01T00:00:00.000Z'): TimePointFact {
  return baseFact('FINANCIAL', { bsQuery: 'growth', statDate, pubDate: statDate, ...fields }, availableAt);
}

function balanceRow(reportDate: string, fields: Record<string, unknown>, availableAt = '2025-08-01T00:00:00.000Z'): TimePointFact {
  return baseFact('BALANCE', { REPORT_DATE_ISO: reportDate, NOTICE_DATE_ISO: reportDate, ...fields }, availableAt);
}

const AS_OF = '2026-06-30T00:00:00.000Z';

// ===== 场景 A：四指标定点断言（独立手算预言）=====

test('场景 A：背离度/净利率/资产负债率/商誉强度的 scale-12 定点值与方向（手算预言）', () => {
  const fin = [
    growthRow('2025-06-30', { YOYNI: '0.750000' }, '2025-08-14T00:00:00.000Z'),
    growthRow('2026-03-31', { YOYNI: '0.100000' }, '2026-04-26T00:00:00.000Z'),
    profitRow('2024-06-30', { MBRevenue: '200.00', npMargin: '0.100000' }, '2024-08-10T00:00:00.000Z'),
    // 2025-06-30 两行：修订口径——availableAt 最新者胜（npMargin 0.2 而非 0.15）
    profitRow('2025-06-30', { MBRevenue: '300.00', npMargin: '0.150000' }, '2025-08-10T00:00:00.000Z'),
    profitRow('2025-06-30', { MBRevenue: '300.00', npMargin: '0.200000' }, '2025-11-01T00:00:00.000Z'),
    profitRow('2026-03-31', { MBRevenue: '', npMargin: '0.250000' }, '2026-04-26T00:00:00.000Z'),
  ];
  const bal = [
    balanceRow('2025-06-30', { TOTAL_LIABILITIES: '2000000000000', TOTAL_ASSETS: '3000000000000', GOODWILL: null, TOTAL_PARENT_EQUITY: '1000' }, '2025-08-14T00:00:00.000Z'),
    balanceRow('2026-03-31', { TOTAL_LIABILITIES: '25000000000', TOTAL_ASSETS: '100000000000', GOODWILL: '500', TOTAL_PARENT_EQUITY: '2000' }, '2026-04-26T00:00:00.000Z'),
  ];
  const r = qualityIndicators(fin, bal, AS_OF);

  assert.equal(r.libraryVersion, QUALITY_LIBRARY_VERSION);
  assert.equal(r.windowLimit, QUALITY_WINDOW_PERIODS);
  assert.equal(r.asOf, AS_OF);

  // 指标 1：营收同比 300/200 − 1 = 0.5；背离度 0.75 − 0.5 = 0.25（手算）
  // 轴 = profit ∪ growth 报告期：2024-06-30（仅作上年输入，无 growth 行/无 2023-06-30 行 ⇒ null）也入序列
  const d = r.earningRevenueGrowthDivergence;
  assert.equal(d.formulaRef, FORMULA_EARNING_REVENUE_DIVERGENCE);
  assert.deepEqual(
    d.series.map((p) => [p.statDate, p.yoyNi, p.revenueYoY, p.value]),
    [
      ['2024-06-30', null, null, null],
      ['2025-06-30', '0.75', '0.5', '0.25'],
      ['2026-03-31', '0.1', null, null], // Q1 MBRevenue 空 ⇒ 营收同比 null ⇒ 背离度 null（不为 0）
    ],
  );
  assert.equal(d.value, null); // value = 最新报告期值；最新期不可算 ⇒ null（历史可算值在 series，不回填）
  assert.equal(d.window, 3);

  // 指标 2：npMargin as-reported 归一（"0.100000" → "0.1"）；修订行 0.2 胜出
  const n = r.netMarginTrend;
  assert.equal(n.formulaRef, FORMULA_NET_MARGIN_TREND);
  assert.deepEqual(n.series, [
    { statDate: '2024-06-30', value: '0.1' },
    { statDate: '2025-06-30', value: '0.2' },
    { statDate: '2026-03-31', value: '0.25' },
  ]);
  assert.equal(n.value, '0.25');
  assert.equal(n.direction, 'UP');
  assert.equal(n.delta, '0.15'); // 首非空 0.1（2024-06-30）→ 末非空 0.25，scale-12 BigInt 精确
  assert.equal(n.directionBasis, 'WINDOW_FIRST_NON_NULL_VS_LAST_NON_NULL');

  // 指标 3：2/3 scale-12 half-up = 0.666666666667；250/1000 = 0.25；方向 DOWN，差值精确
  const la = r.liabilityToAssetTrend;
  assert.equal(la.formulaRef, FORMULA_LIABILITY_ASSET_RATIO);
  assert.deepEqual(la.series, [
    { statDate: '2025-06-30', value: '0.666666666667' },
    { statDate: '2026-03-31', value: '0.25' },
  ]);
  assert.equal(la.value, '0.25');
  assert.equal(la.direction, 'DOWN');
  assert.equal(la.delta, '-0.416666666667');

  // 指标 4：GOODWILL null ⇒ null（非 0）；500/2000 = 0.25；非空值仅 1 ⇒ 方向 null
  const gw = r.goodwillIntensity;
  assert.equal(gw.formulaRef, FORMULA_GOODWILL_INTENSITY);
  assert.deepEqual(gw.series, [
    { statDate: '2025-06-30', value: null },
    { statDate: '2026-03-31', value: '0.25' },
  ]);
  assert.equal(gw.value, '0.25');
  assert.equal(gw.direction, null);
  assert.equal(gw.delta, null);
});

test('scale-12 舍入方向：1/3 与 2/3 的 half-up（half 远离零）与负值尾零', () => {
  const bal = [
    balanceRow('2025-03-31', { TOTAL_LIABILITIES: '1000000000000', TOTAL_ASSETS: '3000000000000', GOODWILL: '0', TOTAL_PARENT_EQUITY: '100' }, '2025-04-30T00:00:00.000Z'),
    balanceRow('2025-06-30', { TOTAL_LIABILITIES: '-2000000000000', TOTAL_ASSETS: '3000000000000', GOODWILL: '10', TOTAL_PARENT_EQUITY: '300' }, '2025-08-30T00:00:00.000Z'),
  ];
  const r = qualityIndicators([], bal, AS_OF);
  // 1/3 = 0.333333333333（1 < half 截断）；2/3 = 0.666666666667（6…6 7 进位）；负比 −0.666666666667
  assert.deepEqual(r.liabilityToAssetTrend.series, [
    { statDate: '2025-03-31', value: '0.333333333333' },
    { statDate: '2025-06-30', value: '-0.666666666667' },
  ]);
  // GOODWILL '0'（真实零值，非缺失）⇒ 比率 '0'；10/300 = 0.033333333333
  assert.deepEqual(r.goodwillIntensity.series, [
    { statDate: '2025-03-31', value: '0' },
    { statDate: '2025-06-30', value: '0.033333333333' },
  ]);
  assert.equal(r.goodwillIntensity.value, '0.033333333333');
  assert.equal(r.goodwillIntensity.direction, 'UP');
});

// ===== 场景 B：as-of 过滤与 8 期窗口截断 =====

test('截点后事实不进任何序列；可见期超 8 截为最近 8 期（升序）', () => {
  const statDates = [
    '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31',
    '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31',
    '2026-03-31',
    '2026-06-30', // pubDate 2026-08（截点后）——必须不可见
  ];
  const fin = statDates.map((sd) =>
    profitRow(sd, { MBRevenue: '100.00', npMargin: '0.100000' }, sd === '2026-06-30' ? '2026-08-16T00:00:00.000Z' : `${sd}T00:00:00.000Z`),
  );
  const bal = statDates.map((sd) =>
    balanceRow(sd, { TOTAL_LIABILITIES: '1', TOTAL_ASSETS: '2', GOODWILL: '1', TOTAL_PARENT_EQUITY: '10' }, sd === '2026-06-30' ? '2026-08-16T00:00:00.000Z' : `${sd}T00:00:00.000Z`),
  );
  const r = qualityIndicators(fin, bal, AS_OF);

  // 可见期 9 个（2024-03-31..2026-03-31）→ 窗口取最近 8：2024-06-30..2026-03-31，升序
  const expectWindow = ['2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'];
  assert.equal(r.netMarginTrend.window, 8);
  assert.deepEqual(r.netMarginTrend.series.map((p) => p.statDate), expectWindow);
  assert.deepEqual(r.liabilityToAssetTrend.series.map((p) => p.statDate), expectWindow);
  assert.deepEqual(r.goodwillIntensity.series.map((p) => p.statDate), expectWindow);
  assert.deepEqual(r.earningRevenueGrowthDivergence.series.map((p) => p.statDate), expectWindow);
  // 截点后报告期（2026-06-30）绝不出现在任何序列
  for (const ind of [r.netMarginTrend, r.liabilityToAssetTrend, r.goodwillIntensity]) {
    assert.equal(ind.series.some((p) => p.statDate === '2026-06-30'), false);
  }
  assert.equal(r.netMarginTrend.value, '0.1'); // 最新可见期 2026-03-31 的值
});

test('as-of 边界：availableAt 恰等于截点可见（<=），晚 1ms 不可见；asOf 接受 Date 实例', () => {
  const atCutoff = profitRow('2026-03-31', { npMargin: '0.111111' }, AS_OF);
  const after = profitRow('2026-03-31', { npMargin: '0.999999' }, '2026-06-30T00:00:00.001Z');
  const viaString = qualityIndicators([atCutoff, after], [], AS_OF);
  assert.deepEqual(viaString.netMarginTrend.series, [{ statDate: '2026-03-31', value: '0.111111' }]);
  const viaDate = qualityIndicators([atCutoff, after], [], new Date(AS_OF));
  assert.deepEqual(viaDate.netMarginTrend.series, [{ statDate: '2026-03-31', value: '0.111111' }]);
});

// ===== 场景 C：同比报告期对齐（错位拒绝）与除零 =====

test('同比配对只认同月日跨年：上年缺期不与相邻季度配对；上年空值/为 0 拒绝', () => {
  // 2025-06-30 有营收与 YOYNI；上年 2024-06-30 缺，只有 2024-03-31/2025-03-31（错位）→ 营收同比 null
  const finMisaligned = [
    growthRow('2025-06-30', { YOYNI: '0.300000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { MBRevenue: '100.00', npMargin: '0.100000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2024-03-31', { MBRevenue: '80.00', npMargin: '0.090000' }, '2024-04-30T00:00:00.000Z'),
    profitRow('2025-03-31', { MBRevenue: '90.00', npMargin: '0.095000' }, '2025-04-30T00:00:00.000Z'),
  ];
  const r1 = qualityIndicators(finMisaligned, [], AS_OF);
  const p1 = r1.earningRevenueGrowthDivergence.series.find((x) => x.statDate === '2025-06-30');
  assert.ok(p1 !== undefined);
  assert.equal(p1.yoyNi, '0.3');
  assert.equal(p1.revenueYoY, null); // 未与 2024-03-31 或 2025-03-31 配对
  assert.equal(p1.value, null);
  assert.ok(r1.earningRevenueGrowthDivergence.notes.some((s) => s.includes('上年对齐行缺失')));

  // 上年行在但 MBRevenue 为空串 → null
  const finEmptyPrev = [
    growthRow('2025-06-30', { YOYNI: '0.100000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { MBRevenue: '100.00' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2024-06-30', { MBRevenue: '' }, '2024-08-14T00:00:00.000Z'),
  ];
  const r2 = qualityIndicators(finEmptyPrev, [], AS_OF);
  const p2 = r2.earningRevenueGrowthDivergence.series.find((x) => x.statDate === '2025-06-30');
  assert.ok(p2 !== undefined);
  assert.equal(p2.revenueYoY, null);
  assert.ok(r2.earningRevenueGrowthDivergence.notes.some((s) => s.includes('MBRevenue 任一侧为空/缺失 1 期')));

  // 上年为 0 → 除零拒绝
  const finZeroPrev = [
    growthRow('2025-06-30', { YOYNI: '0.100000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { MBRevenue: '100.00' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2024-06-30', { MBRevenue: '0.00' }, '2024-08-14T00:00:00.000Z'),
  ];
  const r3 = qualityIndicators(finZeroPrev, [], AS_OF);
  const p3 = r3.earningRevenueGrowthDivergence.series.find((x) => x.statDate === '2025-06-30');
  assert.ok(p3 !== undefined);
  assert.equal(p3.revenueYoY, null);
  assert.ok(r3.earningRevenueGrowthDivergence.notes.some((s) => s.includes('上年 MBRevenue 为 0 1 期')));

  // 负同比精确：50/200 − 1 = −0.75；背离度 0.1 − (−0.75) = 0.85
  const finNegative = [
    growthRow('2025-06-30', { YOYNI: '0.100000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { MBRevenue: '50.00' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2024-06-30', { MBRevenue: '200.00' }, '2024-08-14T00:00:00.000Z'),
  ];
  const r4 = qualityIndicators(finNegative, [], AS_OF);
  const p4 = r4.earningRevenueGrowthDivergence.series.find((x) => x.statDate === '2025-06-30');
  assert.ok(p4 !== undefined);
  assert.equal(p4.revenueYoY, '-0.75');
  assert.equal(p4.value, '0.85');
});

test('上年行在 8 期窗口之外仍作同比输入（不占窗口）', () => {
  // 轴 9 期：2023-06-30（仅作 2024-06-30 的同比上年输入）+ 窗口 8 期 2024-06-30..2026-03-31
  const periods = ['2023-06-30', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'];
  const fin = [
    growthRow('2024-06-30', { YOYNI: '0.500000' }, '2024-08-14T00:00:00.000Z'),
    ...periods.map((sd) => profitRow(sd, { MBRevenue: sd === '2024-06-30' ? '400.00' : sd === '2023-06-30' ? '200.00' : '100.00' }, `${sd}T00:00:00.000Z`)),
  ];
  const r = qualityIndicators(fin, [], AS_OF);
  // 窗口首期 2024-06-30：MBRevenue 400/200 − 1 = 1；背离度 0.5 − 1 = −0.5
  const first = r.earningRevenueGrowthDivergence.series[0];
  assert.ok(first !== undefined);
  assert.equal(first.statDate, '2024-06-30');
  assert.equal(first.revenueYoY, '1');
  assert.equal(first.value, '-0.5');
  // 2023-06-30 只作输入：不进序列
  assert.equal(r.earningRevenueGrowthDivergence.series.some((p) => p.statDate === '2023-06-30'), false);
});

// ===== 场景 D：缺列 / 空值 / 分母 0 的 null 语义（不为 0）=====

test('资产负债率：任一侧缺列 ⇒ null；TOTAL_ASSETS 为 0 ⇒ 除零拒绝；两列同在才算', () => {
  const bal = [
    balanceRow('2025-03-31', { TOTAL_LIABILITIES: '100', TOTAL_ASSETS: '400' }, '2025-04-30T00:00:00.000Z'),
    balanceRow('2025-06-30', { TOTAL_LIABILITIES: '100' }, '2025-08-30T00:00:00.000Z'), // 缺 TOTAL_ASSETS
    balanceRow('2025-09-30', { TOTAL_ASSETS: '400' }, '2025-10-30T00:00:00.000Z'), // 缺 TOTAL_LIABILITIES
    balanceRow('2025-12-31', { TOTAL_LIABILITIES: '100', TOTAL_ASSETS: '0' }, '2026-01-30T00:00:00.000Z'), // 分母 0
  ];
  const r = qualityIndicators([], bal, AS_OF);
  assert.deepEqual(r.liabilityToAssetTrend.series, [
    { statDate: '2025-03-31', value: '0.25' },
    { statDate: '2025-06-30', value: null },
    { statDate: '2025-09-30', value: null },
    { statDate: '2025-12-31', value: null },
  ]);
  assert.equal(r.liabilityToAssetTrend.value, null);
  assert.equal(r.liabilityToAssetTrend.direction, null); // 非空值仅 1
  assert.ok(r.liabilityToAssetTrend.notes.some((s) => s.includes('任一侧缺列/为空 2 期'))); // 分母 0 另计
  assert.ok(r.liabilityToAssetTrend.notes.some((s) => s.includes('TOTAL_ASSETS 为 0 1 期')));
});

test('商誉强度：GOODWILL null/缺失 ⇒ null 非 0；分母缺/为 0 ⇒ null', () => {
  const bal = [
    balanceRow('2025-03-31', { GOODWILL: '100', TOTAL_PARENT_EQUITY: '400' }, '2025-04-30T00:00:00.000Z'),
    balanceRow('2025-06-30', { GOODWILL: null, TOTAL_PARENT_EQUITY: '400' }, '2025-08-30T00:00:00.000Z'), // 源无商誉 → null
    balanceRow('2025-09-30', { TOTAL_PARENT_EQUITY: '400' }, '2025-10-30T00:00:00.000Z'), // GOODWILL 键缺失 → null
    balanceRow('2025-12-31', { GOODWILL: '100', TOTAL_PARENT_EQUITY: '0' }, '2026-01-30T00:00:00.000Z'), // 分母 0
  ];
  const r = qualityIndicators([], bal, AS_OF);
  assert.deepEqual(r.goodwillIntensity.series, [
    { statDate: '2025-03-31', value: '0.25' },
    { statDate: '2025-06-30', value: null },
    { statDate: '2025-09-30', value: null },
    { statDate: '2025-12-31', value: null },
  ]);
  assert.ok(r.goodwillIntensity.notes.some((s) => s.includes('GOODWILL null/缺失 2 期：比率 null（非 0）')));
  assert.ok(r.goodwillIntensity.notes.some((s) => s.includes('TOTAL_PARENT_EQUITY 缺/为 0 1 期')));
});

test('净利率：无 profit 行的期 value null；npMargin 为空串 null；jsonb 数值列可解析（BALANCE 数值以 number 传入）', () => {
  const fin = [
    growthRow('2025-06-30', { YOYNI: '0.100000' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { npMargin: '' }, '2025-08-14T00:00:00.000Z'),
    growthRow('2025-09-30', { YOYNI: '0.100000' }, '2025-10-30T00:00:00.000Z'), // 该期无 profit 行
  ];
  const r1 = qualityIndicators(fin, [], AS_OF);
  assert.deepEqual(r1.netMarginTrend.series, [
    { statDate: '2025-06-30', value: null },
    { statDate: '2025-09-30', value: null },
  ]);
  // BALANCE 数值列为 jsonb number（东财行实测）：number 输入路径
  const bal = [balanceRow('2025-06-30', { TOTAL_LIABILITIES: 38782958469.89, TOTAL_ASSETS: 319918844905.58, GOODWILL: 4387401.63, TOTAL_PARENT_EQUITY: 8770393355.02 }, '2025-08-30T00:00:00.000Z')];
  const r2 = qualityIndicators([], bal, AS_OF);
  assert.equal(r2.liabilityToAssetTrend.series[0]?.value, '0.121227489682'); // 38782958469.89/319918844905.58 独立 BigInt 预言
  assert.equal(r2.goodwillIntensity.series[0]?.value, '0.000500251409'); // 4387401.63/8770393355.02
});

// ===== 场景 E：非标准季末行跳过、非 FINANCIAL/BALANCE 事实忽略、垃圾数值计数 =====

test('非标准季末报告期行跳过并具名计数；无关 factKind 忽略；不可解析数值按 null 计数', () => {
  const fin = [
    profitRow('2025-05-30', { npMargin: '0.100000' }, '2025-06-30T00:00:00.000Z'), // 非季末
    profitRow('2025-06-30', { npMargin: 'not-a-number' }, '2025-08-14T00:00:00.000Z'), // 垃圾数值
    baseFact('DAILY_BAR', { date: '2025-06-30', close: '1.0' }, '2025-06-30T00:00:00.000Z'), // 无关 kind
    baseFact('FINANCIAL', { bsQuery: 'operation', statDate: '2025-06-30' }, '2025-08-14T00:00:00.000Z'), // 非 profit/growth
  ];
  const bal = [
    balanceRow('2026-13-31', { TOTAL_LIABILITIES: '1', TOTAL_ASSETS: '2' }, '2026-01-30T00:00:00.000Z'), // 月 13 非法
    balanceRow('2025-06-30', { TOTAL_LIABILITIES: '1', TOTAL_ASSETS: '2' }, '2025-08-30T00:00:00.000Z'),
  ];
  const r = qualityIndicators(fin, bal, AS_OF);
  assert.deepEqual(r.netMarginTrend.series, [{ statDate: '2025-06-30', value: null }]);
  assert.ok(r.netMarginTrend.notes.some((s) => s.includes('非标准季末 statDate 跳过 1 行')));
  assert.ok(r.netMarginTrend.notes.some((s) => s.includes('npMargin 不可解析 1 处')));
  assert.deepEqual(r.liabilityToAssetTrend.series, [{ statDate: '2025-06-30', value: '0.5' }]);
  assert.ok(r.liabilityToAssetTrend.notes.some((s) => s.includes('非标准季末 REPORT_DATE_ISO 跳过 1 行')));
});

// ===== 场景 F：空输入诚实空结果；asOf 非法拒绝 =====

test('空输入：全指标 value null / window 0 / series 空 / 方向 null，缺口如实声明', () => {
  const r = qualityIndicators([], [], AS_OF);
  assert.equal(r.earningRevenueGrowthDivergence.value, null);
  assert.equal(r.earningRevenueGrowthDivergence.window, 0);
  assert.deepEqual(r.earningRevenueGrowthDivergence.series, []);
  assert.ok(r.earningRevenueGrowthDivergence.notes.some((s) => s.includes('无 as-of 可见 growth 行')));
  assert.ok(r.earningRevenueGrowthDivergence.notes.some((s) => s.includes('无 as-of 可见 profit 行')));
  for (const ind of [r.netMarginTrend, r.liabilityToAssetTrend, r.goodwillIntensity]) {
    assert.equal(ind.value, null);
    assert.equal(ind.window, 0);
    assert.deepEqual(ind.series, []);
    assert.equal(ind.direction, null);
    assert.equal(ind.delta, null);
  }
});

test('asOf 非法（不可解析）具名拒绝', () => {
  assert.throws(() => qualityIndicators([], [], 'not-a-date'), (e: unknown) => e instanceof QualityError && e.code === 'INVALID_ASOF');
});

// ===== 场景 G：方向语义边界（FLAT / 乱序输入 / 修订行不进窗口）=====

test('方向 FLAT（首末非空相等）；事实输入乱序不影响结果（确定性）', () => {
  const mk = () => [
    profitRow('2024-06-30', { npMargin: '0.123456' }, '2024-08-14T00:00:00.000Z'),
    profitRow('2025-06-30', { npMargin: '0.133456' }, '2025-08-14T00:00:00.000Z'),
    profitRow('2026-03-31', { npMargin: '0.123456' }, '2026-04-26T00:00:00.000Z'),
  ];
  const r1 = qualityIndicators(mk(), [], AS_OF);
  assert.equal(r1.netMarginTrend.direction, 'FLAT');
  assert.equal(r1.netMarginTrend.delta, '0');
  const reversed = [...mk()].reverse();
  const r2 = qualityIndicators(reversed, [], AS_OF);
  assert.deepEqual(r2.netMarginTrend.series, r1.netMarginTrend.series);
});
