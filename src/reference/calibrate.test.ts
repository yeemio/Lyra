/**
 * Lyra · 历史参照库 · 价格失效阈值校准单测（P4 / W18）。不碰网络不碰 DB：合成序列与合成行情注入。
 * 口径合同：HISTORICAL-REFERENCE §4/§9〔R3〕、SETTLEMENT-REVIEW SR-2.2（定点比较）/SR-6.1（两侧触发定义）/
 * SR-6.3（只推荐不生效）；样本三分类与剔除规则见 calibrate.ts 模块头。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  eventWindowReturns,
  parseFixed,
  fCmp,
  type DailyBarInput,
  type IndexBarInput,
} from './excess.js';
import { REVISION_NOTICE } from './groups.js';
import {
  BROAD_BASE_RESERVED_PCT,
  CALIBRATION_THRESHOLDS_PCT,
  EARLY_DAY_CAP,
  PROGRESS_EVENT_KEY,
  STOCK_RESERVED_PCT,
  TAIL_BAND_ANY_PCT,
  TYPE_CAP_ANY_PCT,
  aggregateTriggerStats,
  buildCalibrationReport,
  classifyWindow,
  crossCheckReserved10,
  firstTrigger,
  pctRate,
  recommendThreshold,
  sampleOf,
  thetaOf,
  type CalibrationSample,
  type TriggerStatCell,
} from './calibrate.js';

// ===== 阈值与定点纪律 =====

test('thetaOf：百分数 → θ 定点，10% 无浮点漂移（SR-2.2）', () => {
  const t10 = thetaOf('10')!;
  assert.equal(fCmp(t10, parseFixed('0.1')!), 0);
  assert.equal(fCmp(thetaOf('5')!, parseFixed('0.05')!), 0);
  assert.equal(fCmp(thetaOf('15')!, parseFixed('0.15')!), 0);
  assert.equal(thetaOf('abc'), null);
});

test('pctRate：定点恒两位小数百分率；分母 0 → null 不虚构 0%', () => {
  assert.equal(pctRate(1, 3), '33.33');
  assert.equal(pctRate(1, 2), '50.00');
  assert.equal(pctRate(0, 7), '0.00');
  assert.equal(pctRate(3, 0), null);
});

// ===== 首个触发日扫描（合成序列：已知触发日）=====

function seriesOf(values: number[]): { date: string; e: string }[] {
  return values.map((v, i) => ({
    date: `2026-03-${String(i + 2).padStart(2, '0')}`,
    e: v.toFixed(6),
  }));
}

test('firstTrigger：下行首个触发日 = 序列内首个 e ≤ −θ 的 1 基序', () => {
  const s = seriesOf([-0.02, -0.04, -0.06, -0.04, -0.11, -0.03]);
  const t5 = thetaOf('5')!;
  const hit = firstTrigger(s, t5, 'down');
  assert.equal(hit?.dayIndex, 3); // -0.06 首个 ≤ -0.05
  assert.equal(hit?.date, '2026-03-04');
  assert.equal(firstTrigger(s, t5, 'down')?.dayIndex, 3); // 后续更深不再前移
  const t12 = thetaOf('12')!;
  assert.equal(firstTrigger(s, t12, 'down'), null); // 最深 -0.11 未达 -0.12
});

test('firstTrigger：上行首个触发日 = 首个 e ≥ +θ；恰等触发（SR-6.1"达到"）', () => {
  const s = seriesOf([0.01, 0.08, 0.05, 0.1, 0.03]);
  assert.equal(firstTrigger(s, thetaOf('8')!, 'up')?.dayIndex, 2);
  const hit10 = firstTrigger(s, thetaOf('10')!, 'up');
  assert.equal(hit10?.dayIndex, 4); // 恰等 +0.1 触发
  const notHit = firstTrigger(seriesOf([0.099999, 0.05]), thetaOf('10')!, 'up');
  assert.equal(notHit, null); // 0.099999 < 0.1 不触发（定点精确）
  const downEdge = firstTrigger(seriesOf(['-0.1', '-0.05'].map(Number)), thetaOf('10')!, 'down');
  assert.equal(downEdge?.dayIndex, 1); // 恰等 −0.1 触发
});

test('firstTrigger：两侧同一序列各自独立扫描', () => {
  const s = seriesOf([0.06, -0.13, 0.02, 0.14]);
  assert.equal(firstTrigger(s, thetaOf('10')!, 'down')?.dayIndex, 2);
  assert.equal(firstTrigger(s, thetaOf('10')!, 'up')?.dayIndex, 4);
});

// ===== 样本三分类（合成行情经 W15 eventWindowReturns）=====

function tradingDates(n: number, start = '2026-03-02'): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const day = d.toISOString().slice(0, 10);
    if (!/Sat|Sun/.test(new Date(day).toUTCString().slice(0, 3))) out.push(day);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function windowInput(barsN: number, opts?: { dropIndexDates?: string[]; noIndex?: boolean }) {
  const dates = tradingDates(barsN);
  const bars: DailyBarInput[] = dates.map((date, i) => ({
    date,
    open: '100',
    close: String(100 + i), // 逐日 +1% 量级
    volume: '1000000',
  }));
  const indexBars: IndexBarInput[] = (opts?.noIndex ? [] : dates)
    .filter((d) => !(opts?.dropIndexDates ?? []).includes(d))
    .map((date) => ({ date, open: '5000', close: '5000' }));
  return {
    subject: '600000',
    eventTime: '2026-02-27T16:00:00+08:00', // 首个 bar 前一交易日收盘后
    industryL1AsOf: '801010',
    bars,
    factors: [],
    indexBars,
  };
}

test('classifyWindow/sampleOf：USABLE（20 点完整）', () => {
  const win = eventWindowReturns(windowInput(25));
  assert.equal(win.cumulativeExcess.length, 20);
  const s = sampleOf('600000', win.eventTime, 'HOLDER_TRADE:DECREASE', win);
  assert.equal(s.cls, 'USABLE');
  assert.equal(s.eventType, 'HOLDER_TRADE');
  assert.equal(s.reserved10.down !== null && s.reserved10.up !== null, true);
});

test('classifyWindow：WINDOW_INCOMPLETE（序列可用前缀 < 20 点）', () => {
  const win = eventWindowReturns(windowInput(12));
  assert.equal(win.referenceDate !== null, true);
  assert.equal(win.invalidation.downTriggered, false); // 完整前缀未触发（前缀判定有效）
  assert.ok(win.cumulativeExcess.length < 20);
  assert.equal(classifyWindow(win), 'WINDOW_INCOMPLETE');
});

test('classifyWindow：DATA_GAP（超额序列中断——指数缺行）', () => {
  const dates = tradingDates(25);
  const win = eventWindowReturns(windowInput(25, { dropIndexDates: [dates[5]!] }));
  assert.equal(win.invalidation.downTriggered, null); // W15 口径：中断两侧置 null
  assert.equal(classifyWindow(win), 'DATA_GAP');
});

test('classifyWindow：DATA_GAP（参考价不可得——事件后无交易日）', () => {
  const win = eventWindowReturns({ ...windowInput(5), eventTime: '2026-12-31T15:30:00+08:00' });
  assert.equal(win.referenceDate, null);
  assert.equal(classifyWindow(win), 'DATA_GAP');
});

// ===== 聚合（分母只含 USABLE；两侧边际/仅单侧/bothSides；中位日；直方图）=====

function sampleWith(
  cls: CalibrationSample['cls'],
  values: number[],
  eventKey = 'HOLDER_TRADE:DECREASE',
  reserved10: { down: boolean | null; up: boolean | null } = cls === 'DATA_GAP' ? { down: null, up: null } : { down: false, up: false },
): CalibrationSample {
  return {
    subject: '600000',
    eventTime: '2026-03-02T00:00:00Z',
    eventKey,
    eventType: eventKey.split(':')[0] ?? eventKey,
    cls,
    series: seriesOf(values),
    reserved10,
    dataGaps: [],
  };
}

test('aggregateTriggerStats：已知触发样本的计数/率/中位日/直方图', () => {
  const t10 = '10';
  const s1 = sampleWith('USABLE', [0.01, -0.11, ...Array<number>(18).fill(0.03)]); // 第 2 日下行触发（余程 ±0.03 不触）
  const s2 = sampleWith('USABLE', [0.05, 0.06, 0.07, 0.13, ...Array<number>(16).fill(0.02)]); // 第 4 日上行触发
  const s3 = sampleWith('USABLE', Array<number>(20).fill(0.02)); // 不触发
  const s4 = sampleWith('USABLE', [-0.05, 0.12, -0.12, 0.02, ...Array<number>(16).fill(0)]); // 第 2 日上行、第 3 日下行（both）
  const cell = aggregateTriggerStats([s1, s2, s3, s4], t10);
  assert.equal(cell.n, 4);
  assert.equal(cell.downTriggered, 2); // s1 d2、s4 d3（边际）
  assert.equal(cell.upTriggered, 2); // s2 d4、s4 d2（边际）
  assert.equal(cell.anyTriggered, 3); // s1/s2/s4
  assert.equal(cell.bothSides, 1); // s4
  assert.equal(cell.downOnly, 1); // s1
  assert.equal(cell.upOnly, 1); // s2
  assert.equal(cell.anyRatePct, '75.00');
  assert.equal(cell.noTriggerRatePct, '25.00');
  // 首个任一侧触发日：s1=2、s2=4、s4=2 → 中位 2；直方图第 2 日 2 笔、第 4 日 1 笔
  assert.equal(cell.medianFirstAnyDay, 2);
  assert.equal(cell.firstAnyDayHistogram[1], 2);
  assert.equal(cell.firstAnyDayHistogram[3], 1);
  assert.equal(cell.firstAnyDayHistogram.reduce((a, b) => a + b, 0), 3);
  // 中位触发日：下行 {2,3} → 2.5；上行 {4,2} → 3
  assert.equal(cell.medianFirstDownDay, 2.5);
  assert.equal(cell.medianFirstUpDay, 3);
});

test('aggregateTriggerStats：DATA_GAP / WINDOW_INCOMPLETE 不进分母；n=0 率为 null', () => {
  const cell = aggregateTriggerStats(
    [sampleWith('DATA_GAP', Array<number>(20).fill(-0.5)), sampleWith('WINDOW_INCOMPLETE', Array<number>(5).fill(-0.5))],
    '10',
  );
  assert.equal(cell.n, 0);
  assert.equal(cell.anyRatePct, null);
  assert.equal(cell.noTriggerRatePct, null);
  assert.equal(cell.medianFirstAnyDay, null);
});

// ===== 交叉核对（θ=10 重扫 vs W15 落库）=====

test('crossCheckReserved10：非空判定人群逐值比对，一致与不一致两态', () => {
  // reserved10 非 null 才入 W15 同口径核对人群（含窗口未走完前缀判定；DATA_GAP null 不入）。
  const trig = sampleWith('USABLE', [-0.11, ...Array<number>(19).fill(0)], 'HOLDER_TRADE:DECREASE', { down: true, up: false });
  const notrig = sampleWith('USABLE', Array<number>(20).fill(0.01), 'HOLDER_TRADE:DECREASE', { down: false, up: false });
  const gap = sampleWith('DATA_GAP', [-0.5, ...Array<number>(19).fill(0)]); // 不入核对人群
  const ok = crossCheckReserved10([trig, notrig, gap], { n: 2, downTriggered: 1, upTriggered: 0 });
  assert.equal(ok.match, true);
  assert.equal(ok.recomputedN, 2);
  assert.equal(ok.recomputedDown, 1);
  const bad = crossCheckReserved10([trig, notrig, gap], { n: 2, downTriggered: 2, upTriggered: 0 });
  assert.equal(bad.match, false);
});

// ===== 推荐规则（规则先声明后取数；测试锚定导出常量而非魔数）=====

function mkCell(pct: string, anyRate: number, medianDay: number | null): TriggerStatCell {
  const any = anyRate; // n 固定 100，anyRate% 即命中数
  return {
    thresholdPct: pct,
    n: 100,
    downTriggered: Math.round(any * 0.4),
    upTriggered: Math.round(any * 0.7),
    anyTriggered: any,
    bothSides: 1,
    downOnly: Math.round(any * 0.4) - 1,
    upOnly: Math.round(any * 0.7) - 1,
    downRatePct: pctRate(Math.round(any * 0.4), 100),
    upRatePct: pctRate(Math.round(any * 0.7), 100),
    anyRatePct: pctRate(any, 100),
    noTriggerRatePct: pctRate(100 - any, 100),
    medianFirstDownDay: medianDay,
    medianFirstUpDay: medianDay,
    medianFirstAnyDay: medianDay,
    firstAnyDayHistogram: new Array<number>(20).fill(0),
  };
}

function recInput(overallAny: Record<string, number>, worstTypeAny: Record<string, number>) {
  const pcts = Object.keys(overallAny);
  return {
    overall: pcts.map((pct) => ({ pct, cell: mkCell(pct, overallAny[pct]!, 10) })),
    byType: pcts.flatMap((pct) =>
      ['A_TYPE', 'B_TYPE'].map((type) => ({ pct, type, cell: mkCell(pct, type === 'A_TYPE' ? worstTypeAny[pct]! : 10, 10) })),
    ),
  };
}

test('recommendThreshold：10% 过 A 但被 B（单类超上限）击穿 → 取 12%', () => {
  const r = recommendThreshold(recInput(
    { '5': 77, '8': 51, '10': TAIL_BAND_ANY_PCT - 1, '12': 30, '15': 20 },
    { '5': 83, '8': 60, '10': TYPE_CAP_ANY_PCT + 1, '12': 37, '15': 23 },
  ));
  assert.equal(r.stock.recommendedPct, '12');
  assert.equal(r.stock.reservedPct, STOCK_RESERVED_PCT);
  assert.equal(r.stock.calibrationOnly, true); // 只推荐不生效（SR-6.3）
  assert.equal(r.stock.effectiveAt, 'P5 冻结');
  const c10 = r.stock.ruleCheck.find((c) => c.pct === '10')!;
  assert.equal(c10.passA, true);
  assert.equal(c10.passB, false);
  assert.equal(c10.worstType, 'A_TYPE');
  assert.ok(r.stock.rationale.includes('B（A_TYPE'));
});

test('recommendThreshold：全档过 A/B → 取最小档；A/B 全崩 → 取最大档并声明带外', () => {
  const passAll = recommendThreshold(recInput({ '10': 20, '12': 15 }, { '10': 25, '12': 12 }));
  assert.equal(passAll.stock.recommendedPct, '10');
  const failAll = recommendThreshold(recInput({ '10': 90, '12': 60 }, { '10': 95, '12': 70 }));
  assert.equal(failAll.stock.recommendedPct, '12');
  assert.ok(failAll.stock.rationale.includes('带外'));
});

test('recommendThreshold：C（中位首触发日超限）未过时如实标注但仍可入选（A/B 优先）', () => {
  const input = recInput({ '10': 30, '12': 20 }, { '10': 40, '12': 15 });
  input.overall = input.overall.map((o) => ({ pct: o.pct, cell: { ...o.cell, medianFirstAnyDay: EARLY_DAY_CAP + 1, medianFirstDownDay: null, medianFirstUpDay: null } }));
  const r = recommendThreshold(input);
  assert.equal(r.stock.recommendedPct, '10');
  assert.equal(r.stock.ruleCheck.find((c) => c.pct === '10')!.passC, false);
  assert.ok(r.stock.rationale.includes('规则 C 未过'));
});

test('recommendThreshold：宽基不可校准结论（不编造）', () => {
  const r = recommendThreshold(recInput({ '10': 30 }, { '10': 40 }));
  assert.equal(r.broadBase.reservedPct, BROAD_BASE_RESERVED_PCT);
  assert.equal(r.broadBase.status, 'NOT_CALIBRATABLE');
  assert.ok(r.broadBase.conclusion.includes('宽基不可校准'));
  assert.ok(r.broadBase.conclusion.includes('5%'));
});

// ===== 报告结构完整性（HISTORICAL-REFERENCE §8 精神：强制字段缺失即不得出库）=====

function reportSamples(): CalibrationSample[] {
  return [
    sampleWith('USABLE', [-0.11, ...Array<number>(19).fill(0)], 'HOLDER_TRADE:DECREASE', { down: true, up: false }),
    sampleWith('USABLE', [0.13, ...Array<number>(19).fill(0)], 'HOLDER_TRADE:INCREASE', { down: false, up: true }),
    sampleWith('USABLE', Array<number>(20).fill(0.01), 'BUYBACK:FIRST'),
    sampleWith('USABLE', [0.12, ...Array<number>(19).fill(0)], PROGRESS_EVENT_KEY, { down: false, up: true }), // 进展子类：审计面在场
    sampleWith('WINDOW_INCOMPLETE', Array<number>(8).fill(0.05), 'BUYBACK:FIRST'),
    sampleWith('DATA_GAP', [-0.5, ...Array<number>(19).fill(0)], 'EARNINGS_FORECAST:FIRST'),
  ];
}

test('buildCalibrationReport：结构完整性 + 三套口径样本算术（R25）', () => {
  const samples = reportSamples();
  // R25.1 后交叉核对人群剔进展：库侧 4 例（USABLE 3 + WINDOW_INCOMPLETE 1），down 1 / up 1（进展的 up 不再计入）
  const cc = crossCheckReserved10(samples, { n: 4, downTriggered: 1, upTriggered: 1 });
  const report = buildCalibrationReport(samples, cc, {
    thresholdsPct: CALIBRATION_THRESHOLDS_PCT,
    materializedAt: '2026-10-25T12:00:00.000Z',
    methodVersion: 'reference-calibration@w18-test',
    adapterVersion: 'sw@p1;baostock@0.9.40-p1',
    inputAvailableAtMax: '2026-10-25T12:00:00.000Z',
  });
  assert.equal(report.result, 'REFERENCE CALIBRATION OK');
  assert.equal(report.procedure.calibrationOnly, true);
  assert.equal(report.procedure.freezeAt, 'P5');
  assert.deepEqual(report.thresholdsPct, [...CALIBRATION_THRESHOLDS_PCT]);
  // 样本三分类计数如实：6 = 4 USABLE + 1 WINDOW_INCOMPLETE + 1 DATA_GAP
  assert.deepEqual(report.sampleScope.byClass, { USABLE: 4, WINDOW_INCOMPLETE: 1, DATA_GAP: 1 });
  // R25：六类 BUYBACK 行剔进展（FIRST 2 例，USABLE 1）；统计口径整体剔进展（5 例，其中 USABLE 3）；
  // 审计面 allEvents 含进展（6 例，其中 USABLE 4）；进展子类随 supplementary 可见。
  assert.equal(report.matrix.byEventType.BUYBACK!['10']!.n, 1);
  assert.equal(report.matrix.overall.statisticsScopeExProgress['10']!.n, 3);
  assert.equal(report.matrix.overall.allEvents['10']!.n, 4); // DATA_GAP/WINDOW_INCOMPLETE 不进任何分母
  assert.equal(report.sampleScope.eventsTotal, 6);
  assert.ok(report.supplementaryByEventKey[PROGRESS_EVENT_KEY] !== undefined);
  assert.equal(report.supplementaryByEventKey[PROGRESS_EVENT_KEY]!['10']!.n, 1);
  // 触发率矩阵： HOLDER_TRADE 两例一上一下 → any 100%
  assert.equal(report.matrix.byEventType.HOLDER_TRADE!['10']!.anyRatePct, '100.00');
  // 强制字段：修订口径声明原样、限制声明、版本绑定、交叉核对、触发口径定义
  assert.equal(report.revisionNotice, REVISION_NOTICE);
  assert.ok(report.limitations.length >= 5);
  assert.ok(report.limitations.some((l) => l.includes('2015–2026 市场状态分布不均匀')));
  assert.equal(report.versionBinding.methodVersion, 'reference-calibration@w18-test');
  assert.equal(report.consistencyCheck.match, true);
  for (const key of ['series', 'down', 'up', 'any', 'downUpMarginal', 'dayIndex', 'arithmetic'] as const) {
    assert.ok(report.triggerDefinition[key].length > 0, `triggerDefinition.${key} 缺失`);
  }
  assert.ok(report.recommendation.broadBase.status === 'NOT_CALIBRATABLE');
  assert.ok(report.sampleScope.scopeArithmetic.statisticsScopeExProgress.includes('R25'));
});

test('buildCalibrationReport：全 DATA_GAP 样本不产出任何比例数字冒充分母', () => {
  const samples = [sampleWith('DATA_GAP', Array<number>(20).fill(-0.5))];
  const report = buildCalibrationReport(samples, crossCheckReserved10(samples, { n: 0, downTriggered: 0, upTriggered: 0 }), {
    thresholdsPct: ['10'],
    materializedAt: '2026-10-25T12:00:00.000Z',
    methodVersion: 't',
    adapterVersion: 't',
    inputAvailableAtMax: null,
  });
  const cell = report.matrix.overall.statisticsScopeExProgress['10']!;
  assert.equal(cell.n, 0);
  assert.equal(cell.anyRatePct, null);
  assert.equal(cell.noTriggerRatePct, null);
});
