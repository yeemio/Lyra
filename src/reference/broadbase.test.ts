/**
 * Lyra · 宽基状态参照库单测（W23: code-writer-pro）。不碰网络不碰 DB：合成 K 线注入。
 * 覆盖：月末抽样、趋势边界（端点相等）、波动序量与三档边界、后续收益定点精确、
 * 失效触发两侧（恰好 ±5% 的定点判定）、前缀口径、样本组装端到端、群组下限与
 * 统计聚合精确、声明强制携带（估值分位档缺口存在且明示"不是估值档"）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFixed, type DailyBarInput, type Fixed } from './excess.js';
import { NESTED_GROUP_DECLARATION, REVISION_NOTICE } from './groups.js';
import {
  BROADBASE_INVALIDATION_THRESHOLD_PCT,
  VALUATION_TIER_GAP_DECLARATION,
  broadbaseSamplesOf,
  buildBroadbaseLibrary,
  dispersionAt,
  forwardOutcomeAt,
  monthEndIndices,
  prepareIndexSeries,
  trendWindowAt,
  volTierBoundsOf,
  volTierOf,
  type BroadbaseBuildOptions,
  type BroadbaseSample,
} from './broadbase.js';

// ===== 合成工具 =====

function bar(date: string, close: string, extra?: { tradestatus?: string; volume?: string }): DailyBarInput {
  return {
    date,
    open: close,
    close,
    volume: extra?.volume ?? '1',
    tradestatus: extra?.tradestatus ?? '1',
  };
}

function closesOf(values: string[]): Fixed[] {
  return values.map((v) => parseFixed(v)).filter((v): v is Fixed => v !== null);
}

/** n 天顺序日期（同月内，day 1..n，n ≤ 28）。 */
function seqDates(year: number, month: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
}

const OPTS: BroadbaseBuildOptions = {
  minGroupSample: 30,
  methodVersion: 'broadbase-test@1',
  adapterVersion: 'test-adapter',
  inputAvailableAtMax: null,
  materializedAt: '2026-10-25T00:00:00Z',
};

// ===== 月末抽样 =====

test('月末抽样：每日历月最后一根 K 线；首月窗口不足不抽；序列末月（无法证明已完结）不抽', () => {
  const dates = [...seqDates(2022, 1, 15), ...seqDates(2022, 2, 21), ...seqDates(2022, 3, 21)];
  // 月末原始下标：1 月末 14（<19 剔除）、2 月末 35（可抽）；3 月为序列末月不抽。
  assert.deepEqual(monthEndIndices(dates), [35]);
  const full = [...seqDates(2022, 1, 21), ...seqDates(2022, 2, 21), ...seqDates(2022, 3, 21)];
  assert.deepEqual(monthEndIndices(full), [20, 41]); // 1、2 月末可抽；末月 3 月不抽
  assert.deepEqual(monthEndIndices([]), []);
});

// ===== 趋势状态边界 =====

test('趋势：端点相等归 UP（≥ 算子）；下降 DOWN；窗口不足 null', () => {
  const flat = closesOf(Array.from({ length: 20 }, () => '4000'));
  const dates = seqDates(2022, 1, 20);
  assert.equal(trendWindowAt(dates, flat, 19)?.state, 'UP');
  assert.equal(trendWindowAt(dates, flat, 19)?.from, '2022-01-01');
  assert.equal(trendWindowAt(dates, flat, 19)?.to, '2022-01-20');
  const up = closesOf(Array.from({ length: 20 }, (_, i) => String(4000 + i)));
  assert.equal(trendWindowAt(dates, up, 19)?.state, 'UP');
  const down = closesOf(Array.from({ length: 20 }, (_, i) => String(4000 - i)));
  assert.equal(trendWindowAt(dates, down, 19)?.state, 'DOWN');
  // 窗口不足（idx=18 只有 19 根）与越界 → null
  assert.equal(trendWindowAt(dates, down, 18), null);
  assert.equal(trendWindowAt(dates, down, 20), null);
});

// ===== 波动序量与三档边界 =====

test('波动序量：常数序列 D=0；离散更大的序列 D 严格更大（与标准差单调同序，定点不开方）', () => {
  const dates = seqDates(2022, 1, 20);
  const constant = dispersionAt(closesOf(Array.from({ length: 20 }, () => '1000')), 19);
  assert.ok(constant !== null);
  assert.equal(String(constant.int), '0'); // 全零收益 → 平方偏差和 = 0
  const smallWiggle = closesOf(Array.from({ length: 20 }, (_, i) => String(1000 + (i % 2 === 0 ? 1 : -1))));
  const bigWiggle = closesOf(Array.from({ length: 20 }, (_, i) => String(1000 + (i % 2 === 0 ? 15 : -15))));
  const dSmall = dispersionAt(smallWiggle, 19);
  const dBig = dispersionAt(bigWiggle, 19);
  assert.ok(dSmall !== null && dBig !== null);
  const fCmpLocal = (a: { int: bigint }, b: { int: bigint }): number => (a.int < b.int ? -1 : a.int > b.int ? 1 : 0);
  assert.ok(fCmpLocal(dBig, dSmall) > 0);
  assert.ok(fCmpLocal(dSmall, constant!) > 0);
  assert.equal(dispersionAt(smallWiggle, 18), null); // 窗口不足
});

test('波动三档边界：等分界值归上档（==b1 → MID，==b2 → HIGH）；分界倒序/缺失 → null', () => {
  const bounds: [string, string] = ['5', '10'];
  assert.equal(volTierOf(parseFixed('4.99'), bounds), 'LOW');
  assert.equal(volTierOf(parseFixed('5'), bounds), 'MID'); // 等分界归上档（同市值档约定）
  assert.equal(volTierOf(parseFixed('9.99'), bounds), 'MID');
  assert.equal(volTierOf(parseFixed('10'), bounds), 'HIGH');
  assert.equal(volTierOf(parseFixed('10.01'), bounds), 'HIGH');
  assert.equal(volTierOf(parseFixed('5'), ['10', '5']), null); // 分界倒序
  assert.equal(volTierOf(parseFixed('5'), null), null);
  assert.equal(volTierOf(null, bounds), null);
});

test('波动分界 = 全史序量三等分位（次序统计量，不插值）', () => {
  const values = closesOf(Array.from({ length: 9 }, (_, i) => String(i + 1)));
  assert.deepEqual(volTierBoundsOf(values), ['3', '6']);
  assert.equal(volTierBoundsOf([null, null]), null);
});

// ===== 后续收益与失效触发（定点）=====

test('后续 1 日收益定点精确：+5% 恰好触发上涨侧（≥ 含等号）；未走完窗口 = WINDOW_INCOMPLETE 非缺口', () => {
  const dates = ['2022-01-03', '2022-01-04'];
  const closes = closesOf(['100', '105']);
  const fwd = forwardOutcomeAt(dates, closes, 0);
  const h1 = fwd.windows.find((w) => w.h === 1)!;
  assert.equal(h1.status, 'OK');
  assert.equal(h1.absReturn, '0.05');
  assert.equal(h1.endDate, '2022-01-04');
  assert.equal(fwd.windows.find((w) => w.h === 5)?.status, 'WINDOW_INCOMPLETE');
  assert.equal(fwd.windows.find((w) => w.h === 20)?.status, 'WINDOW_INCOMPLETE');
  assert.equal(fwd.invalidation.upTriggered, true); // 0.05 ≥ 0.05 精确触发
  assert.equal(fwd.invalidation.downTriggered, false);
  assert.equal(fwd.forwardBars, 1);
  assert.equal(fwd.windowIncomplete, true);
});

test('失效触发定点判定：恰好 −5% 触发下跌侧（≤ 含等号）；−4.99% 不触发（浮点阈值禁用，全程定点）', () => {
  const hit = forwardOutcomeAt(['2022-01-03', '2022-01-04'], closesOf(['100', '95']), 0);
  assert.equal(hit.invalidation.downTriggered, true);
  assert.equal(hit.invalidation.upTriggered, false);
  assert.equal(hit.invalidation.firstDownDate, '2022-01-04');
  const miss = forwardOutcomeAt(['2022-01-03', '2022-01-04'], closesOf(['100', '95.01']), 0);
  assert.equal(miss.invalidation.downTriggered, false); // −0.0499 > −0.05，不触发
  assert.equal(miss.invalidation.upTriggered, false);
});

test('前缀口径：不足 20 根时触发判定在已完成前缀上有效；零前缀 → 两侧 null（不可判定）', () => {
  const dates = ['2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06'];
  const fwd = forwardOutcomeAt(dates, closesOf(['100', '101', '102', '103']), 0);
  assert.equal(fwd.forwardBars, 3);
  assert.equal(fwd.windowIncomplete, true);
  assert.equal(fwd.invalidation.downTriggered, false); // 前缀完整未触发 → false（null 只留零前缀）
  assert.equal(fwd.invalidation.upTriggered, false);
  assert.equal(fwd.windows.find((w) => w.h === 1)?.status, 'OK');
  assert.equal(fwd.windows.find((w) => w.h === 5)?.status, 'WINDOW_INCOMPLETE');
  const none = forwardOutcomeAt(['2022-01-03'], closesOf(['100']), 0);
  assert.equal(none.forwardBars, 0);
  assert.equal(none.invalidation.downTriggered, null);
  assert.equal(none.invalidation.upTriggered, null);
  assert.equal(none.windows.every((w) => w.status === 'WINDOW_INCOMPLETE'), true);
});

// ===== 序列清洗 =====

test('清洗：日期非法/停牌/收盘不可解析剔除并具名登记；同日重复后到者胜', () => {
  const bars = [
    bar('2022-01-03', '1000'),
    { date: 'bad-date', open: '1', close: '1', volume: '1' },
    bar('2022-01-04', '1001', { tradestatus: '0', volume: '0' }),
    bar('2022-01-05', 'abc'),
    bar('2022-01-05', '1010'), // 同日有效行覆盖无效行之后
  ];
  const prep = prepareIndexSeries('000300', bars);
  assert.deepEqual(prep.series.dates, ['2022-01-03', '2022-01-05']);
  assert.equal(prep.series.closes[1] !== null && String(prep.series.closes[1]!.int) !== '', true);
  assert.equal(prep.excludedRows, 3);
  assert.ok(prep.dataGaps.includes('DAILY_BAR_DATE_INVALID:bad-date'));
  assert.ok(prep.dataGaps.includes('DAILY_BAR_NOT_TRADED:2022-01-04'));
  assert.ok(prep.dataGaps.includes('DAILY_BAR_CLOSE_INVALID:2022-01-05'));
});

// ===== 样本组装端到端（合成 36 个月：月奇偶定趋势、月内摆幅三档定波动）=====

/** 某月前 count 个交易日（跳周末）。 */
function tradingDaysOf(year: number, month0: number, count: number): string[] {
  const out: string[] = [];
  const dim = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  for (let d = 1; d <= dim && out.length < count; d++) {
    const wd = new Date(Date.UTC(year, month0, d)).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      out.push(`${year}-${String(month0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return out;
}

/**
 * 合成序列：月 m 漂移 step = ±1（偶月升、奇月降），日内摆幅 wiggle 按月轮换 1/6/15。
 * 月末 20 收盘窗净变动 = 19·step ± wiggle，|19·step| > max(wiggle) → 趋势严格由月奇偶决定；
 * 波动序量以 wiggle 为主（量级 ~wiggle²，三组无重叠）→ 三档由月 mod 3 决定。
 */
function synthBars(months: number, startYear = 2015, startMonth0 = 0): DailyBarInput[] {
  const bars: DailyBarInput[] = [];
  let close = 1000;
  for (let m = 0; m < months; m++) {
    const year = startYear + Math.floor((startMonth0 + m) / 12);
    const month0 = (startMonth0 + m) % 12;
    const step = m % 2 === 0 ? 1 : -1;
    const wiggle = [1, 6, 15][m % 3]!;
    const dates = tradingDaysOf(year, month0, 23);
    for (let i = 0; i < dates.length; i++) {
      close += step + (i % 2 === 0 ? wiggle : -wiggle);
      bars.push(bar(dates[i]!, String(close)));
    }
  }
  return bars;
}

test('样本组装端到端：36 个月 → 35 个月末样本（末月不抽）；趋势严格按月奇偶；三档波动齐备；全部样本前缀判定有效', () => {
  const build = broadbaseSamplesOf('000300', synthBars(36));
  assert.equal(build.samples.length, 35); // 2015-01..2017-11 的月末；2017-12 为序列末月不抽
  assert.ok(build.samples[0]!.date.startsWith('2015-01'));
  assert.ok(build.samples[34]!.date.startsWith('2017-11'));
  assert.equal(build.volBounds !== null, true);
  const ups = build.samples.filter((s) => s.trend === 'UP');
  const downs = build.samples.filter((s) => s.trend === 'DOWN');
  assert.equal(ups.length, 18); // 偶月（step=+1）严格 UP（2015-01 至 2017-11 共 35 个月：偶月 18、奇月 17）
  assert.equal(downs.length, 17);
  const tiers = new Set(build.samples.map((s) => s.volTier));
  assert.deepEqual([...tiers].sort(), ['HIGH', 'LOW', 'MID']);
  // 末月不抽 → 每个样本都有后继 K 线，前缀判定全部有效（非 null）
  for (const s of build.samples) {
    assert.notEqual(s.invalidationDown, null);
    assert.notEqual(s.invalidationUp, null);
  }
  assert.notEqual(build.samples[34]!.h1, null);
});

// ===== 群组构建：下限、统计精确、声明强制携带 =====

function fakeSample(
  indexCode: string,
  date: string,
  trend: 'UP' | 'DOWN',
  vol: 'LOW' | 'MID' | 'HIGH' | null,
  h1: string | null,
  inv: { down?: boolean; up?: boolean } = {},
): BroadbaseSample {
  return {
    indexCode,
    date,
    trend,
    dispersion: '1',
    volTier: vol,
    h1,
    h5: h1,
    h20: h1,
    invalidationDown: inv.down ?? false,
    invalidationUp: inv.up ?? false,
    forwardBars: 20,
    windowIncomplete: false,
    dataGaps: [],
  };
}

test('群组构建：不足下限不产出该层块且不向下钻；恰 30 进入、29 不进入', () => {
  const samples: BroadbaseSample[] = [];
  for (let i = 0; i < 10; i++) samples.push(fakeSample('000300', `2020-${String(i % 12 + 1).padStart(2, '0')}-28`, 'UP', 'LOW', '0.01'));
  for (let i = 0; i < 15; i++) samples.push(fakeSample('000300', `2021-${String(i % 12 + 1).padStart(2, '0')}-28`, 'UP', 'MID', '0.02'));
  for (let i = 0; i < 15; i++) samples.push(fakeSample('000300', `2022-${String(i % 12 + 1).padStart(2, '0')}-28`, 'UP', 'HIGH', '0.03'));
  for (let i = 0; i < 5; i++) samples.push(fakeSample('000300', `2023-0${i + 1}-28`, 'DOWN', 'LOW', '-0.01'));
  const lib = buildBroadbaseLibrary(new Map([['000300', samples]]), OPTS);
  // BASE(40) + trend:UP(40)；DOWN(5)<30 不产出；三档均 <30 不产出 → 无 VOL_TIER 块
  assert.deepEqual(
    lib.blocks.map((b) => b.groupKey).sort(),
    ['idx:000300|all-months', 'idx:000300|trend:UP'],
  );
  assert.equal(lib.blocks.find((b) => b.layers[0] === 'BASE')?.sampleCount, 45); // BASE = 全指数月末样本（含 DOWN 5 例）
  assert.equal(lib.blocks.find((b) => b.groupKey === 'idx:000300|trend:UP')?.sampleCount, 40);
  assert.equal(lib.totalSamples, 45);

  // 恰 30：进入；29：不进入
  const exact30 = Array.from({ length: 30 }, (_, i) => fakeSample('000905', `2020-${String((i % 12) + 1).padStart(2, '0')}-28`, 'UP', 'LOW', '0.01'));
  const lib30 = buildBroadbaseLibrary(new Map([['000905', exact30]]), OPTS);
  assert.deepEqual(
    lib30.blocks.map((b) => b.groupKey).sort(),
    ['idx:000905|all-months', 'idx:000905|trend:UP', 'idx:000905|trend:UP|vol:LOW'], // 30=30 恰好进入 VOL 层
  );
  const just29 = exact30.slice(0, 29);
  const lib29 = buildBroadbaseLibrary(new Map([['000905', just29]]), OPTS);
  assert.deepEqual(
    lib29.blocks.map((b) => b.groupKey).sort(),
    ['idx:000905|all-months'], // TREND 29<30 不产出、VOL 不钻；BASE 29 仍在（library.ts 同构：BASE 不设下限）——不降档凑样本
  );
});

test('统计聚合精确：均值/中位数定点（奇偶各验）；失效触发两侧分列计数', () => {
  const odd = ['0.1', '0.2', '0.3'].map((v, i) => fakeSample('000300', `2020-01-0${i + 1}`, 'UP', 'LOW', v));
  const even = ['0.1', '0.2', '0.3', '0.4'].map((v, i) => fakeSample('000905', `2020-01-0${i + 1}`, 'UP', 'LOW', v));
  const opts = { ...OPTS, minGroupSample: 2 };
  const lib = buildBroadbaseLibrary(
    new Map([
      ['000300', odd],
      ['000905', even],
    ]),
    opts,
  );
  const oddBase = lib.blocks.find((b) => b.groupKey === 'idx:000300|all-months')!;
  assert.equal(oddBase.stats.h1.mean, '0.2');
  assert.equal(oddBase.stats.h1.median, '0.2');
  assert.equal(oddBase.stats.h1.n, 3);
  assert.equal(oddBase.stats.h5.mean, '0.2'); // h1/h5/h20 同值注入
  const evenBase = lib.blocks.find((b) => b.groupKey === 'idx:000905|all-months')!;
  assert.equal(evenBase.stats.h1.mean, '0.25');
  assert.equal(evenBase.stats.h1.median, '0.25'); // 偶数样本取中间两数均值
  assert.equal(evenBase.stats.h1.n, 4);

  // 失效触发聚合：down 7 例、up 11 例分列
  const mixed: BroadbaseSample[] = [];
  for (let i = 0; i < 40; i++) {
    mixed.push(
      fakeSample('000016', `2020-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 'UP', 'MID', '0.01', {
        down: i < 7,
        up: i >= 29, // 40−29 = 11 例
      }),
    );
  }
  const libMix = buildBroadbaseLibrary(new Map([['000016', mixed]]), OPTS);
  const blk = libMix.blocks.find((b) => b.groupKey === 'idx:000016|trend:UP')!;
  assert.equal(blk.invalidation.downTriggered, 7);
  assert.equal(blk.invalidation.upTriggered, 11);
  assert.equal(blk.invalidation.n, 40);
  assert.equal(blk.invalidation.thresholdPct, '5');
  assert.equal(blk.invalidation.reserved, true);
});

test('声明强制携带：每块嵌套声明/R4 修订声明与个股库同文；估值分位档缺口声明存在且明示不是估值档', () => {
  const samples = Array.from({ length: 31 }, (_, i) => fakeSample('000300', `2020-${String((i % 12) + 1).padStart(2, '0')}-28`, 'UP', 'LOW', '0.01'));
  samples[0]!.dataGaps = ['DISPERSION_UNAVAILABLE'];
  const lib = buildBroadbaseLibrary(new Map([['000300', samples]]), OPTS);
  assert.ok(lib.blocks.length >= 1);
  for (const b of lib.blocks) {
    assert.equal(b.nestedDeclaration, NESTED_GROUP_DECLARATION); // 与个股库同文同源
    assert.equal(b.revisionNotice, REVISION_NOTICE);
    assert.equal(b.valuationTierGapDeclaration, VALUATION_TIER_GAP_DECLARATION);
    assert.equal(b.invalidation.thresholdPct, BROADBASE_INVALIDATION_THRESHOLD_PCT);
    assert.equal(b.versionBinding.methodVersion, OPTS.methodVersion);
    assert.ok(b.reservedParams.some((p) => p.startsWith('BROADBASE_INVALIDATION_THRESHOLD_PCT=5')));
    assert.ok(b.reservedParams.some((p) => p.startsWith('MIN_GROUP_SAMPLE=30')));
  }
  // 缺口文本本身：登记估值分位档不可得，且禁止冒充
  assert.ok(VALUATION_TIER_GAP_DECLARATION.includes('估值分位档缺口'));
  assert.ok(VALUATION_TIER_GAP_DECLARATION.includes('不是估值档'));
  assert.ok(VALUATION_TIER_GAP_DECLARATION.includes('FREEZE-P0-20261025'));
  // 样本级缺口随块携带（带指数@日期前缀）
  const base = lib.blocks.find((x) => x.groupKey === 'idx:000300|all-months')!;
  assert.ok(base.dataGaps.some((g) => g.endsWith(':DISPERSION_UNAVAILABLE')));
});

test('空指数与层输入缺失：无样本不产出块、登记 NO_SAMPLES；volTier null 计入 layerInputMissing', () => {
  const empty = buildBroadbaseLibrary(new Map([['000016', []]]), OPTS);
  assert.equal(empty.blocks.length, 0);
  assert.deepEqual(empty.dataGaps, ['NO_SAMPLES:000016']);
  const withNullVol = Array.from({ length: 30 }, (_, i) => fakeSample('000300', `2020-${String((i % 12) + 1).padStart(2, '0')}-28`, 'UP', null, '0.01'));
  const lib = buildBroadbaseLibrary(new Map([['000300', withNullVol]]), OPTS);
  assert.equal(lib.layerInputMissing.volTier, 30);
  assert.equal(lib.layerInputMissing.trend, 0);
  // 趋势块仍在（趋势可得），VOL 层无输入不钻
  assert.deepEqual(
    lib.blocks.map((b) => b.groupKey).sort(),
    ['idx:000300|all-months', 'idx:000300|trend:UP'],
  );
});
