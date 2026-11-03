/**
 * Lyra · 结算主函数单测（P3 W13: code-writer-pro）。DB 用例走本地 lyra-pg 隔离 schema，
 * 不碰网络；合成事实覆盖 SR-2.2 全字段、SR-2.4 未到期证伪（12 交易日）、SR-3.3 窗口
 * 停牌顺延、除权日落例、一字板方向阻断、失效触发两侧与边界、结算异常具名
 * （指数缺口/行业缺失）、重放确定性。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import { settleConclusion, type SettleOutcome } from './settle.js';
import { SettlementError, decFrom, decMin, decToString } from './decimal.js';

// ===== 隔离 schema =====

const SCHEMA = `w13_set_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;

// ===== 夹具 =====

function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  let day = start;
  while (out.length < n) {
    const dow = new Date(`${day}T00:00:00.00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day);
    day = nextDay(day);
  }
  return out;
}

const CAL = weekdays('2024-01-02', 60); // 2024-01-02(二) 起 60 个工作日
const REF = CAL[0] as string; // 参考价日（conclusionTime 取 2024-01-01 晚 → 首候选 = REF）
const LAST_20TH = CAL[19] as string; // 无停牌时第 20 个有成交交易日
const AS_OF = new Date('2024-06-01T00:00:00.000Z');
const CUTOFF = '2024-01-01T15:00:00+08:00';
const CONCLUSION_T0 = '2024-01-01T20:00:00+08:00'; // 非交易日完成 → 下一交易日开盘
const ART = 'ab'.repeat(32);

/** 共享基准：801120 全程平价（1000/1000）；801221 第 20 日 +10%（1100）。 */
const FLAT_INDEX = '801120';
const UP_TENTH_INDEX = '801221';

function shClose(day: string): string {
  return new Date(`${day}T15:00:00+08:00`).toISOString();
}

async function insertCalendar(days: string[]): Promise<void> {
  for (const d of days) {
    await insertFact(pool, {
      factId: `cal-${d}`,
      subjectType: 'RULE',
      subjectId: 'ashare-calendar',
      factKind: 'TRADE_CALENDAR',
      typedValue: { calendar_date: d, is_trading_day: '1' },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'test@w13',
    });
  }
}

async function insertIndexBars(code: string, days: string[], closeOf: (day: string) => number, openOfFirst: number): Promise<void> {
  await Promise.all(days.map((d, i) =>
    insertFact(pool, {
      factId: `ix-${code}-${d}`,
      subjectType: 'INDEX',
      subjectId: code,
      factKind: 'SW_INDEX_BAR',
      typedValue: { 日期: d, 开盘: i === 0 ? openOfFirst : closeOf(d), 收盘: closeOf(d), swIndexCode: code },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'sw@p1',
    }),
  ));
}

interface StockSpec {
  open?: string;
  high?: string;
  low?: string;
  close: string;
  preclose?: string;
  isST?: '0' | '1';
}

/** 插入个股行情（默认可成交、四价=收盘、preclose=收盘）。 */
async function insertStock(subject: string, specs: Record<string, StockSpec>): Promise<void> {
  for (const [day, s] of Object.entries(specs)) {
    const p = (v: string | undefined): string => v ?? s.close;
    await insertFact(pool, {
      factId: `sb-${subject}-${day}`,
      subjectType: 'STOCK',
      subjectId: subject,
      factKind: 'DAILY_BAR',
      typedValue: {
        code: `sh.${subject}`, date: day,
        open: p(s.open), high: p(s.high), low: p(s.low), close: s.close, preclose: s.preclose ?? s.close,
        volume: '1000', amount: '10000.0000', adjustflag: '3', tradestatus: '1', isST: s.isST ?? '0',
      },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(day),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'baostock@0.9.40-p1',
    });
  }
}

async function insertFactorEvent(subject: string, day: string): Promise<void> {
  await insertFact(pool, {
    factId: `af-${subject}-${day}`,
    subjectType: 'STOCK',
    subjectId: subject,
    factKind: 'ADJUST_FACTOR',
    typedValue: { code: `sh.${subject}`, dividOperateDate: day, adjustFactor: '2.000000', backAdjustFactor: '2.000000', foreAdjustFactor: '0.500000' },
    validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
    firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(day),
    supersedesFactId: null, artifactSha256: ART, adapterVersion: 'baostock@0.9.40-p1',
  });
}

async function insertIndustry2021(subject: string, l1: string): Promise<void> {
  await insertFact(pool, {
    factId: `sw-${subject}-2021`,
    subjectType: 'STOCK',
    subjectId: subject,
    factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: {
      股票代码: subject, 计入日期: 0, 行业代码: '340501', 更新日期: 0,
      计入日期ISO: '2021-07-30', 更新日期ISO: '2021-07-30 00:00:00', 体系: '2021', l1IndexCode: l1,
    },
    validFrom: '2021-07-29T16:00:00.000Z', validTo: null,
    eventAt: '2021-07-29T16:00:00.000Z', sourcePublishedAt: '2021-07-29T16:00:00.000Z',
    firstObservedAt: '2026-10-25T00:00:00.000Z', availableAt: '2021-07-30T16:00:00.000Z',
    supersedesFactId: null, artifactSha256: ART, adapterVersion: 'sw@p1',
  });
}

/** 平价行情：ref 开盘 open、各日收盘 close、第 count 日 closeLast（preclose 全 close）。 */
function flatSpecs(open: string, close: string, closeLast: string, from = 0, count = 20): Record<string, StockSpec> {
  const specs: Record<string, StockSpec> = {};
  CAL.slice(from, from + count).forEach((d, i) => {
    specs[d] = { open: i === 0 ? open : close, close: i === count - 1 ? closeLast : close, preclose: close };
  });
  return specs;
}

function settleArgs(
  subject: string,
  disposition: 'RESEARCH_OUTPERFORM' | 'RESEARCH_UNDERPERFORM' | 'ABSTAIN',
  overrides: Record<string, unknown> = {},
) {
  return { subject, disposition, conclusionTime: CONCLUSION_T0, cutoff: CUTOFF, asOf: AS_OF, ...overrides };
}

/** SETTLED 形态收窄助手（非 SETTLED 直接失败并给出原因）。 */
function settled(o: SettleOutcome): Extract<SettleOutcome, { state: 'SETTLED' }> {
  if (o.state !== 'SETTLED') throw new Error(`期望 SETTLED，实际 ${o.state}（${'reason' in o ? o.reason : ''} ${'code' in o ? o.code : ''}）`);
  return o;
}

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
  await insertCalendar(CAL);
  await insertIndexBars(FLAT_INDEX, CAL, () => 1000, 1000); // 平价基准
  await insertIndexBars(UP_TENTH_INDEX, CAL, (d) => (d === LAST_20TH ? 1100 : 1000), 1000); // 第 20 日 +10%
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
});

// ===== SR-2.2 六结算字段 =====

test('正常跑赢：全字段手算对照（e=0.2−0.1=0.1；MAE 同源重算；未触发失效；FILLABLE）', async () => {
  await insertIndustry2021('600101', UP_TENTH_INDEX);
  await insertStock('600101', flatSpecs('100.00', '100.00', '120.00'));
  const o = settled(await settleConclusion(pool, settleArgs('600101', 'RESEARCH_OUTPERFORM')));
  assert.equal(o.zone.directionHit, true); // e=0.1 > 0
  assert.equal(o.zone.excessReturn, '0.1'); // (120/100 − 1) − (1100/1000 − 1)
  assert.equal(o.zone.maxAdverse, '0'); // e_1..e_19 = 0、e_20 = 0.1 → min = 0（如实记录不截断）
  assert.equal(o.zone.invalidationTriggered, false);
  assert.equal(o.zone.tradability, 'FILLABLE');
  assert.equal(o.diagnostics.referenceDay, REF);
  assert.equal(o.diagnostics.referenceOpen, '100.00');
  assert.equal(o.diagnostics.windowEndDay, LAST_20TH);
  assert.equal(o.diagnostics.tradedDays, 20);
  assert.equal(o.diagnostics.industry.industryIndexCode, UP_TENTH_INDEX);
  assert.equal(o.diagnostics.invalidationFirstDay, null);
  // SR-3.4 证伪：e_window 与 MAE 可由同一逐日序列独立重算
  const eList = o.diagnostics.series.map((d) => d.e);
  assert.equal(eList[19], o.zone.excessReturn); // e_window = e_(窗口结束日)
  let m = decFrom(eList[0] as string);
  for (const e of eList.slice(1)) m = decMin(m, decFrom(e));
  assert.equal(decToString(m), o.zone.maxAdverse);
});

test('e_window 恰为 0：严格不等，两侧均不命中（OUTPERFORM 与 UNDERPERFORM 皆 MISS）', async () => {
  await insertIndustry2021('600102', UP_TENTH_INDEX);
  await insertStock('600102', flatSpecs('100.00', '100.00', '110.00')); // 股票 +10% = 指数 +10%
  const up = settled(await settleConclusion(pool, settleArgs('600102', 'RESEARCH_OUTPERFORM')));
  assert.equal(up.zone.excessReturn, '0');
  assert.equal(up.zone.directionHit, false); // = 0 两侧不命中（SR-2.2 取值表）
  const down = settled(await settleConclusion(pool, settleArgs('600102', 'RESEARCH_UNDERPERFORM')));
  assert.equal(down.zone.directionHit, false);
});

test('放弃结论：超额收益照常计算；方向命中 N/A；maxAdverse/失效/可成交 N/A', async () => {
  await insertIndustry2021('600103', UP_TENTH_INDEX);
  await insertStock('600103', flatSpecs('100.00', '100.00', '120.00'));
  const o = settled(await settleConclusion(pool, settleArgs('600103', 'ABSTAIN')));
  assert.equal(o.zone.directionHit, null); // N_A
  assert.equal(o.zone.excessReturn, '0.1'); // 照常计算并记录（SR-2.2 放弃列）
  assert.equal(o.zone.maxAdverse, null);
  assert.equal(o.zone.tradability, 'N_A');
  assert.equal('invalidationTriggered' in o.zone, false); // N/A：字段缺席
});

test('除权日在窗口内：全链重算（e = 0.2；逐段拼接的 −0.4 为错误路径）', async () => {
  await insertIndustry2021('600104', FLAT_INDEX);
  const specs = flatSpecs('100.00', '100.00', '120.00');
  const d2 = CAL[1] as string;
  specs[d2] = { open: '50.00', close: '50.00', preclose: '50.00' }; // r = close(d1)/preclose(d2) = 100/50 = 2
  for (let i = 2; i < 19; i += 1) specs[CAL[i] as string] = { close: '50.00', preclose: '50.00' };
  specs[LAST_20TH] = { close: '60.00', preclose: '50.00' };
  await insertStock('600104', specs);
  await insertFactorEvent('600104', d2);
  const o = settled(await settleConclusion(pool, settleArgs('600104', 'RESEARCH_OUTPERFORM')));
  assert.equal(o.zone.excessReturn, '0.2'); // (60×2)/(100×1) − 1；指数平价
  assert.equal(o.zone.directionHit, true);
  assert.equal(o.diagnostics.series[19]?.stockAdjClose, '120'); // 60 × 2（后复权）
  assert.equal(o.diagnostics.series[19]?.stockFactor, '2');
  assert.equal(o.diagnostics.series[0]?.stockFactor, '1');
});

test('窗口内停牌：窗口结束日 = 第 25 个市场交易日；间隔计数入诊断', async () => {
  await insertIndustry2021('600105', FLAT_INDEX);
  const specs = flatSpecs('100.00', '100.00', '100.00', 0, 30);
  for (const d of CAL.slice(3, 8)) delete specs[d]; // 5 个交易日停牌
  await insertStock('600105', specs);
  const o = settled(await settleConclusion(pool, settleArgs('600105', 'RESEARCH_UNDERPERFORM')));
  assert.equal(o.diagnostics.windowEndDay, CAL[24]); // 参考价日起第 25 个市场交易日（停牌不计时）
  assert.equal(o.diagnostics.tradedDays, 20);
  assert.deepEqual(
    o.diagnostics.suspensionGaps.map((g) => ({ from: g.from, to: g.to, n: g.tradingDays })),
    [{ from: CAL[2] as string, to: CAL[8] as string, n: 5 }], // to = 复牌首个有成交日
  );
  assert.equal(o.zone.tradability, 'FILLABLE'); // 参考价日本身可成交
});

test('参考价顺延：首候选日停牌 → 复牌首日参考价，UNFILLABLE_SUSPENDED，仍照常结算', async () => {
  await insertIndustry2021('600106', FLAT_INDEX);
  // 结论 2024-01-02 收盘后完成 → 首候选 = CAL[1]；CAL[1..3] 停牌，CAL[4] 复牌
  await insertStock('600106', flatSpecs('100.00', '100.00', '100.00', 4, 26));
  const o = settled(await settleConclusion(pool, settleArgs('600106', 'RESEARCH_OUTPERFORM', { conclusionTime: '2024-01-02T16:00:00+08:00' })));
  assert.equal(o.diagnostics.referenceDay, CAL[4]); // 复牌首日
  assert.equal(o.diagnostics.deferredBySuspension, true);
  assert.equal(o.diagnostics.suspensionSpanTradingDays, 3); // CAL[1..3] 三个市场交易日
  assert.equal(o.zone.tradability, 'UNFILLABLE_SUSPENDED'); // SR-3.2 末行
  assert.equal(o.zone.excessReturn, '0'); // 平价：e = 0
  assert.equal(o.zone.directionHit, false); // = 0 不命中
});

test('长期顺延（跨度 25 > 20）→ SUSPENDED_OVER_20D 单独类', async () => {
  await insertIndustry2021('600107', FLAT_INDEX);
  // 结论 2024-01-02 收盘后完成 → 首候选 = CAL[1]；CAL[1..25] 停牌（25 个市场交易日），CAL[26] 复牌
  await insertStock('600107', flatSpecs('100.00', '100.00', '100.00', 26, 24));
  const o = settled(await settleConclusion(pool, settleArgs('600107', 'RESEARCH_OUTPERFORM', { conclusionTime: '2024-01-02T16:00:00+08:00' })));
  assert.equal(o.diagnostics.suspensionSpanTradingDays, 25);
  assert.equal(o.zone.tradability, 'SUSPENDED_OVER_20D'); // ASHARE §6 长期停牌
});

test('参考价日一字涨停：跑赢 → UNFILLABLE_LIMIT_UP（原始价 + limitPrice 到分判定），仍照常结算', async () => {
  await insertIndustry2021('600108', FLAT_INDEX);
  const specs = flatSpecs('11.00', '11.00', '12.10');
  const refBar = specs[REF] as StockSpec;
  refBar.high = '11.00';
  refBar.low = '11.00';
  refBar.preclose = '10.00'; // 涨停价 = 10.00 × 1.1 = 11.00（四价 11.00 一字板）
  await insertStock('600108', specs);
  const o = settled(await settleConclusion(pool, settleArgs('600108', 'RESEARCH_OUTPERFORM')));
  assert.equal(o.zone.tradability, 'UNFILLABLE_LIMIT_UP');
  assert.equal(o.diagnostics.tradability.oneWordBoard, 'LIMIT_UP');
  assert.equal(o.diagnostics.tradability.limit?.up, '11.00');
  assert.equal(o.zone.excessReturn, '0.1'); // 12.10/11 − 1（不可成交仍照常结算，SR-4.3）
  assert.equal(o.zone.directionHit, true);
  const down = settled(await settleConclusion(pool, settleArgs('600108', 'RESEARCH_UNDERPERFORM')));
  assert.equal(down.zone.tradability, 'FILLABLE'); // 一字涨停不挡跑输侧（ASHARE §5）
});

// ===== SR-2.4 未到期 =====

test('SR-2.4 证伪：窗口仅 12 个有成交交易日 → 未到期，不产生任何结算字段', async () => {
  await insertIndustry2021('600109', FLAT_INDEX);
  await insertStock('600109', flatSpecs('100.00', '100.00', '100.00', 0, 12)); // 仅 12 日
  const outcome = await settleConclusion(pool, settleArgs('600109', 'RESEARCH_OUTPERFORM'));
  assert.equal(outcome.state, 'UNSETTLED');
  if (outcome.state !== 'UNSETTLED') return;
  assert.equal(outcome.reason, 'WINDOW_INCOMPLETE');
  assert.match(outcome.detail, /12\/20/);
  assert.equal('zone' in outcome, false); // 结算字段全空（不提前结算、不做预测性回填）
});

test('SR-2.4：结论太新（参考价日都未到）→ NOT_DUE', async () => {
  await insertIndustry2021('600110', FLAT_INDEX);
  await insertStock('600110', flatSpecs('100.00', '100.00', '100.00'));
  const outcome = await settleConclusion(pool, settleArgs('600110', 'RESEARCH_OUTPERFORM', { conclusionTime: '2024-05-01T12:00:00+08:00' }));
  assert.equal(outcome.state, 'UNSETTLED');
  if (outcome.state !== 'UNSETTLED') return;
  assert.equal(outcome.reason, 'REFERENCE_NOT_DUE');
});

// ===== 结算异常（SR-10.4 具名登记，不用替代数据补算）=====

test('指数窗口日缺行情 → ANOMALY INDEX_BAR_MISSING', async () => {
  await insertIndustry2021('600111', '801999'); // 该基准缺一天行情
  await insertIndexBars('801999', CAL.filter((d) => d !== (CAL[10] as string)), () => 1000, 1000);
  await insertStock('600111', flatSpecs('100.00', '100.00', '110.00'));
  const outcome = await settleConclusion(pool, settleArgs('600111', 'RESEARCH_OUTPERFORM'));
  assert.equal(outcome.state, 'ANOMALY');
  if (outcome.state !== 'ANOMALY') return;
  assert.equal(outcome.code, 'INDEX_BAR_MISSING');
});

test('行业基准身份缺失 → ANOMALY INDUSTRY_BENCHMARK_MISSING（不用替代基准）', async () => {
  await insertStock('600112', flatSpecs('100.00', '100.00', '110.00'));
  const outcome = await settleConclusion(pool, settleArgs('600112', 'RESEARCH_OUTPERFORM'));
  assert.equal(outcome.state, 'ANOMALY');
  if (outcome.state !== 'ANOMALY') return;
  assert.equal(outcome.code, 'INDUSTRY_BENCHMARK_MISSING');
});

// ===== SR-6.1 失效触发（两侧与边界）=====

test('跑赢方向失效：e_d ≤ −12% 触发 + 首个触发日（MAE 同源；R29.3 冻结 12%）', async () => {
  await insertIndustry2021('600113', FLAT_INDEX);
  const specs = flatSpecs('100.00', '100.00', '80.00');
  for (let i = 4; i < 19; i += 1) specs[CAL[i] as string] = { close: '80.00', preclose: '80.00' };
  specs[CAL[4] as string] = { close: '80.00', preclose: '100.00' }; // 第 5 日：e_5 = −0.2
  await insertStock('600113', specs);
  const o = settled(await settleConclusion(pool, settleArgs('600113', 'RESEARCH_OUTPERFORM')));
  assert.equal(o.zone.invalidationTriggered, true);
  assert.equal(o.diagnostics.invalidationFirstDay, CAL[4]);
  assert.equal(o.zone.maxAdverse, '-0.2'); // min(e_d)
  assert.equal(o.zone.excessReturn, '-0.2'); // e_window = e_20
  assert.equal(o.zone.directionHit, false); // −0.2 ≤ 0 → MISS
});

test('跑输方向失效：e_d ≥ +12% 触发（e_window 为正 → 跑输 MISS；R29.3 冻结 12%）', async () => {
  await insertIndustry2021('600114', FLAT_INDEX);
  const specs = flatSpecs('100.00', '100.00', '120.00');
  for (let i = 4; i < 19; i += 1) specs[CAL[i] as string] = { close: '120.00', preclose: '120.00' };
  specs[CAL[4] as string] = { close: '120.00', preclose: '100.00' }; // e_5 = +0.2
  await insertStock('600114', specs);
  const o = settled(await settleConclusion(pool, settleArgs('600114', 'RESEARCH_UNDERPERFORM')));
  assert.equal(o.zone.invalidationTriggered, true);
  assert.equal(o.diagnostics.invalidationFirstDay, CAL[4]);
  assert.equal(o.zone.maxAdverse, '0.2'); // 跑输取 max(e_d)
  assert.equal(o.zone.excessReturn, '0.2');
  assert.equal(o.zone.directionHit, false); // +0.2 ≥ 0 → MISS
});

test('阈值边界：e_d = −0.12 精确触发（≤ 含等号，精确十进制比较；R29.3 冻结 12%，原预留 10% 下 −0.1 边界随之失效）', async () => {
  await insertIndustry2021('600115', FLAT_INDEX);
  const specs = flatSpecs('100.00', '100.00', '88.00');
  for (let i = 4; i < 19; i += 1) specs[CAL[i] as string] = { close: '88.00', preclose: '88.00' };
  specs[CAL[4] as string] = { close: '88.00', preclose: '100.00' }; // e_5 = −0.12
  await insertStock('600115', specs);
  const o = settled(await settleConclusion(pool, settleArgs('600115', 'RESEARCH_OUTPERFORM')));
  assert.equal(o.zone.invalidationTriggered, true);
  assert.equal(o.diagnostics.invalidationFirstDay, CAL[4]);
});

// ===== 其他纪律 =====

test('重放确定性：同参数两次结算逐字段一致（SR-3.5/4.6 重放语义）', async () => {
  await insertIndustry2021('600116', FLAT_INDEX);
  await insertStock('600116', flatSpecs('100.00', '100.00', '130.00'));
  const a = await settleConclusion(pool, settleArgs('600116', 'RESEARCH_OUTPERFORM'));
  const b = await settleConclusion(pool, settleArgs('600116', 'RESEARCH_OUTPERFORM'));
  assert.deepEqual(a, b);
  assert.equal(settled(a).zone.excessReturn, '0.3'); // 130/100 − 1
});

test('跨类 disposition（宽基 UP）具名拒绝（R18；SR-8A 不在本实现面）', async () => {
  await assert.rejects(
    () => settleConclusion(pool, settleArgs('600116', 'RESEARCH_UP' as never)),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
});

test('非法阈值/代码具名拒绝', async () => {
  await assert.rejects(
    () => settleConclusion(pool, settleArgs('600116', 'RESEARCH_OUTPERFORM', { invalidationThreshold: '0' })),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
  await assert.rejects(
    () => settleConclusion(pool, settleArgs('60011', 'RESEARCH_OUTPERFORM')),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
});

test('夹具自检：CAL/REF 形状（周末跳过、首末对齐）', () => {
  assert.equal(REF, '2024-01-02');
  assert.equal(CAL[1], '2024-01-03');
  assert.equal(CAL[4], '2024-01-08'); // 跳过周末
  assert.equal(CAL[59] !== undefined, true);
});
