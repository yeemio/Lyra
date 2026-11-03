/**
 * Lyra · 历史参照库 · 事件窗口收益单测（W15）。不碰网络不碰 DB：合成行情/因子/指数注入。
 * 口径合同：HISTORICAL-REFERENCE §4；与 SETTLEMENT-REVIEW SR-3 同构（口径互指，P3 验收对齐）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  eventWindowReturns,
  parseFixed,
  fAdd,
  fSub,
  fMul,
  fDiv,
  fCmp,
  fixedToString,
  type DailyBarInput,
  type IndexBarInput,
  type AdjustFactorInput,
} from './excess.js';

// ===== 定点工具 =====

test('parseFixed/fixedToString：字符串与数值往返、负数、尾零', () => {
  assert.equal(fixedToString(parseFixed('1311.8400')!), '1311.84');
  assert.equal(fixedToString(parseFixed('-0.5')!), '-0.5');
  assert.equal(fixedToString(parseFixed(1000)!), '1000');
  assert.equal(fixedToString(parseFixed('0.100')!), '0.1');
  assert.equal(fixedToString(parseFixed('-0.000')!), '0');
  assert.equal(parseFixed(''), null);
  assert.equal(parseFixed('abc'), null);
  assert.equal(parseFixed(NaN), null);
});

test('定点四则与比较：0.1 阈值精确（无浮点漂移）', () => {
  const a = parseFixed('11')!;
  const b = parseFixed('10')!;
  const ratio = fDiv(a, b)!; // 1.1
  const ret = fSub(ratio, parseFixed('1')!); // 0.1
  assert.equal(fixedToString(ret), '0.1');
  assert.equal(fCmp(ret, parseFixed('0.1')!), 0); // 恰好等于阈值
  assert.equal(fCmp(fMul(parseFixed('0.3')!, parseFixed('3')!), parseFixed('0.9')!), 0);
  assert.equal(fixedToString(fAdd(parseFixed('-0.45')!, parseFixed('0.45')!)), '0');
  assert.equal(fDiv(parseFixed('1')!, parseFixed('0')!), null);
});

// ===== 行情夹具 =====

function bar(date: string, open: string, close: string, opts?: { volume?: string; tradestatus?: string }): DailyBarInput {
  return { date, open, close, volume: opts?.volume ?? '1000000', tradestatus: opts?.tradestatus ?? '1' };
}

function suspendedBar(date: string): DailyBarInput {
  return bar(date, '0.0000', '0.0000', { volume: '0', tradestatus: '0' });
}

function flatIndex(dates: string[], open: string, close: string): IndexBarInput[] {
  return dates.map((d) => ({ date: d, open, close }));
}

/** 夹具 A：事件时点 2020-03-02 16:00+08（盘后公告，保守口径 D+1 语义等价）→ 起算日 03-03。
 * 有成交日 20 个（03-03..03-23 去掉停牌 03-05）：03-03 开盘 10、其后收盘恒 11；停牌日不计窗口。 */
const DATES_A = Array.from({ length: 21 }, (_, i) => `2020-03-${String(3 + i).padStart(2, '0')}`);
const TRADED_A = DATES_A.filter((d) => d !== '2020-03-05');
const BARS_A: DailyBarInput[] = [
  bar('2020-02-28', '10.0000', '10.0000'), // 事件前（不得作参考价）
  ...TRADED_A.map((d, i) => bar(d, '10.0000', '11.0000')),
  suspendedBar('2020-03-05'),
];

test('基本窗口：起算日=事件时点后首个有成交交易日开盘；停牌日不计窗口计时', () => {
  const r = eventWindowReturns({
    subject: '600000',
    eventTime: '2020-03-02T16:00:00+08:00',
    industryL1AsOf: '801010',
    bars: BARS_A,
    factors: [],
    indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.equal(r.referenceDate, '2020-03-03');
  assert.equal(r.referenceOpenRaw, '10');
  // h1 = 第 1 有成交日（03-03）收盘：11/10 − 1 = 0.1；指数 flat → 超额 0.1
  const h1 = r.windows.find((w) => w.h === 1)!;
  assert.equal(h1.status, 'OK');
  assert.equal(h1.endDate, '2020-03-03');
  assert.equal(h1.absReturn, '0.1');
  assert.equal(h1.excessReturn, '0.1');
  // h5 = 第 5 有成交日：03-03,04,06,07,08 → 03-08（停牌 03-05 跳过）
  const h5 = r.windows.find((w) => w.h === 5)!;
  assert.equal(h5.endDate, '2020-03-08');
  assert.equal(h5.absReturn, '0.1');
  // h20 = 第 20 有成交日 = 03-23
  const h20 = r.windows.find((w) => w.h === 20)!;
  assert.equal(h20.endDate, '2020-03-23');
  assert.equal(h20.status, 'OK');
  // +0.1 低于冻结阈值 12%（R29.3，原预留 10% 时恰触发）→ 两侧均不触发
  assert.equal(r.invalidation.upTriggered, false);
  assert.equal(r.invalidation.firstUpDate, null);
  assert.equal(r.invalidation.downTriggered, false);
  assert.equal(r.invalidation.thresholdPct, '12');
  assert.equal(r.invalidation.reserved, true);
  assert.deepEqual(r.dataGaps, []);
});

test('事件时点盘中 → 当日不作起算日；盘前（08:00）→ 当日作起算日（ASHARE-RULES §4 两情形）', () => {
  const intraday = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-03T10:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A, factors: [], indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.equal(intraday.referenceDate, '2020-03-04'); // 03-03 09:30 开盘 < 10:00 → 下一日
  const preOpen = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-03T08:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A, factors: [], indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.equal(preOpen.referenceDate, '2020-03-03'); // 09:30 > 08:00 → 当日
});

test('跑赢侧不利触发：累计超额 ≤ −12%（含等号；R29.3 冻结 12%），firstDownDate 记首个触发日', () => {
  // 03-03 开盘 10 → 03-04 收盘 8.8（−12%），指数 flat → e = −0.12
  const bars = [
    bar('2020-03-03', '10.0000', '10.0000'),
    bar('2020-03-04', '10.0000', '8.8000'),
    ...TRADED_A.slice(2).map((d) => bar(d, '10.0000', '8.8000')),
  ];
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars, factors: [], indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.equal(r.invalidation.downTriggered, true);
  assert.equal(r.invalidation.firstDownDate, '2020-03-04');
  assert.equal(r.invalidation.upTriggered, false);
});

test('除权落例：窗口跨除权日必须后复权（原始 × 因子链），不复权收益失真', () => {
  // 除权日 2020-03-08（第 5 有成交日，10 送 10）：raw 5.2 × 因子 2.0 = 10.4；起算 03-03 开盘 10 × 因子 1.0。
  // h5 绝对收益 = 10.4/10 − 1 = 0.04（不复权口径会是 5.2/10 − 1 = −0.48）。
  const factors: AdjustFactorInput[] = [
    { operateDate: '2015-06-30', backAdjustFactor: '1.000000' },
    { operateDate: '2020-03-08', backAdjustFactor: '2.000000' },
  ];
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A.map((b) => (b.date === '2020-03-08' ? bar(b.date, '5.1000', '5.2000') : b)),
    factors,
    indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.equal(r.referenceAdjustedOpen, '10');
  const h5 = r.windows.find((w) => w.h === 5)!;
  assert.equal(h5.endDate, '2020-03-08');
  assert.equal(h5.absReturn, '0.04');
  assert.equal(h5.excessReturn, '0.04');
  assert.deepEqual(r.dataGaps, []); // 起算日前有因子行（1.0 基准），无截断缺口
});

test('因子基准截断：窗口跨除权且起算日前库内无因子行 → ADJUST_FACTOR_BASE_TRUNCATED', () => {
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A.map((b) => (b.date === '2020-03-08' ? bar(b.date, '5.1000', '5.2000') : b)),
    factors: [{ operateDate: '2020-03-08', backAdjustFactor: '2.000000' }],
    indexBars: flatIndex(DATES_A, '1000', '1000'),
  });
  assert.ok(r.dataGaps.includes('ADJUST_FACTOR_BASE_TRUNCATED'));
});

test('窗口未走完：h5/h20 = WINDOW_INCOMPLETE 数值 null；前缀序列的触发判定保留', () => {
  const bars = [
    bar('2020-03-03', '10.0000', '10.0000'),
    bar('2020-03-04', '10.0000', '8.8000'), // e = −0.12 → 前缀内已触发
    bar('2020-03-06', '10.0000', '8.8000'),
  ];
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars, factors: [],
    indexBars: flatIndex(['2020-03-03', '2020-03-04', '2020-03-06'], '1000', '1000'),
  });
  const h1 = r.windows.find((w) => w.h === 1)!;
  assert.equal(h1.status, 'OK');
  const h5 = r.windows.find((w) => w.h === 5)!;
  assert.equal(h5.status, 'WINDOW_INCOMPLETE');
  assert.equal(h5.absReturn, null);
  assert.equal(h5.excessReturn, null);
  assert.equal(r.invalidation.downTriggered, true); // 已完成前缀内的触发是事实（§7 第 1 条）
});

test('指数缺行：INDUSTRY 层不可得 → INDEX_GAP + invalidation 整体 null + 具名缺口', () => {
  const noIndustry = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: null,
    bars: BARS_A, factors: [], indexBars: [],
  });
  assert.ok(noIndustry.dataGaps.includes('INDUSTRY_L1_UNAVAILABLE_AT_EVENT'));
  assert.equal(noIndustry.windows.find((w) => w.h === 20)!.status, 'INDEX_GAP');
  assert.equal(noIndustry.invalidation.upTriggered, null);
  assert.equal(noIndustry.invalidation.downTriggered, null);

  const missingBar = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A, factors: [], indexBars: flatIndex(DATES_A.slice(1), '1000', '1000'), // 起算日行缺失
  });
  assert.ok(missingBar.dataGaps.includes('SW_INDEX_BAR_MISSING:801010:2020-03-03'));
  assert.equal(missingBar.invalidation.upTriggered, null);
});

test('事件后无成交交易日（长期停牌）→ NO_REFERENCE，窗口全空并具名缺口', () => {
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars: [bar('2020-02-28', '10.0000', '10.0000')], factors: [], indexBars: [],
  });
  assert.equal(r.referenceDate, null);
  assert.ok(r.dataGaps.includes('NO_TRADING_DAY_AFTER_EVENT'));
  assert.ok(r.windows.every((w) => w.status === 'NO_REFERENCE'));
});

test('超额 = 个股 − 行业指数：指数非 flat 时的手算基准', () => {
  // 个股 03-03 收盘 11（+10%）；指数 03-03 开盘 1000 收盘 1050（+5%）→ e1 = 0.05
  const r = eventWindowReturns({
    subject: '600000', eventTime: '2020-03-02T16:00:00+08:00', industryL1AsOf: '801010',
    bars: BARS_A, factors: [],
    indexBars: flatIndex(DATES_A, '1000', '1050'),
  });
  const h1 = r.windows.find((w) => w.h === 1)!;
  assert.equal(h1.absReturn, '0.1');
  assert.equal(h1.excessReturn, '0.05');
});
