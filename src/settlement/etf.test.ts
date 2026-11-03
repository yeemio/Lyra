/**
 * Lyra · 宽基 ETF 结算单测（P3 W19: code-writer-pro）。DB 用例走本地 lyra-pg 隔离
 * schema，不碰网络；合成事实覆盖 SR-8A 全形态：UP/DOWN/ABSTAIN 三态命中、=0 两侧
 * 不命中、5% 失效边界（恰触发两侧 + 边界外不触发）、ETF 一字板（涨停/跌停 ×
 * 方向绑定）、参考价停牌顺延、窗口内停牌不计时、未到期、指数缺日具名异常
 * （窗口日/参考价日）、ETF→跟踪指数映射解析与默认路径、跨类 disposition 具名拒绝。
 * 全部断言为精确十进制定点字符串（scale-12），无浮点相等比较。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import { settleEtfConclusion, parseTrackedIndex, loadEtfIndexMap, type EtfSettleOutcome } from './etf.js';
import { SettlementError, decFrom, decMin, decToString } from './decimal.js';

// ===== 隔离 schema =====

const SCHEMA = `w19_etf_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
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
const REF = CAL[0] as string; // 参考价日（conclusionTime 2024-01-01 晚 → 首候选 = REF）
const LAST_20TH = CAL[19] as string; // 无停牌时第 20 个有成交交易日
const AS_OF = new Date('2024-06-01T00:00:00.000Z');
const CONCLUSION_T0 = '2024-01-01T20:00:00+08:00'; // 非交易日完成 → 下一交易日开盘
const ART = 'cd'.repeat(32);
const IDX = '000300'; // 合成跟踪指数（显式注入用）
const TRACKS_510050 = '000016'; // 默认映射路径用（R24 冻结池 510050 → 上证50）

function shClose(day: string): string {
  return new Date(`${day}T15:00:00+08:00`).toISOString();
}

async function insertCalendar(days: readonly string[]): Promise<void> {
  for (const d of days) {
    await insertFact(pool, {
      factId: `cal-${d}`,
      subjectType: 'RULE',
      subjectId: 'ashare-calendar',
      factKind: 'TRADE_CALENDAR',
      typedValue: { calendar_date: d, is_trading_day: '1' },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'test@w19',
    });
  }
}

/** ETF 行情（默认可成交、四价=收盘、preclose=收盘；停牌日不插行 = §6 正常表现）。 */
async function insertEtf(subject: string, specs: Record<string, { open?: string; high?: string; low?: string; close: string; preclose?: string }>): Promise<void> {
  for (const [day, s] of Object.entries(specs)) {
    const p = (v: string | undefined): string => v ?? s.close;
    await insertFact(pool, {
      factId: `eb-${subject}-${day}`,
      subjectType: 'ETF',
      subjectId: subject,
      factKind: 'DAILY_BAR',
      typedValue: {
        code: `sh.${subject}`, date: day,
        open: p(s.open), high: p(s.high), low: p(s.low), close: s.close, preclose: s.preclose ?? s.close,
        volume: '1000', amount: '10000.0000', adjustflag: '3', tradestatus: '1', isST: '0',
      },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(day),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'baostock@0.9.40-p1',
    });
  }
}

/** 跟踪指数 DAILY_BAR（subject_type='INDEX'，英文键——与 SW_INDEX_BAR 中文键不同）。 */
async function insertIndex(code: string, days: readonly string[], closeOf: (day: string) => string, openOfFirst: string): Promise<void> {
  await Promise.all(days.map((d) =>
    insertFact(pool, {
      factId: `ib-${code}-${d}`,
      subjectType: 'INDEX',
      subjectId: code,
      factKind: 'DAILY_BAR',
      typedValue: {
        code: `sh.${code}`, date: d,
        open: d === days[0] ? openOfFirst : closeOf(d), high: closeOf(d), low: closeOf(d),
        close: closeOf(d), preclose: closeOf(d),
        volume: '1', amount: '1.0000', adjustflag: '3', tradestatus: '1', isST: '0',
      },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'baostock@0.9.40-p1',
    }),
  ));
}

/** 平价 ETF 行情：ref 开盘 refOpen、各日收盘 close、第 count 日 closeLast。 */
function flatEtf(refOpen: string, close: string, closeLast: string, days: readonly string[] = CAL, count = 20): Record<string, { open?: string; high?: string; low?: string; close: string; preclose?: string }> {
  const specs: Record<string, { open?: string; high?: string; low?: string; close: string; preclose?: string }> = {};
  days.slice(0, count).forEach((d, i) => {
    specs[d] = { open: i === 0 ? refOpen : close, close: i === count - 1 ? closeLast : close, preclose: close };
  });
  return specs;
}

function etfArgs(subject: string, disposition: 'RESEARCH_UP' | 'RESEARCH_DOWN' | 'ABSTAIN', overrides: Record<string, unknown> = {}) {
  return { subject, disposition, conclusionTime: CONCLUSION_T0, asOf: AS_OF, trackedIndex: IDX, ...overrides };
}

/** SETTLED 形态收窄助手。 */
function settled(o: EtfSettleOutcome): Extract<EtfSettleOutcome, { state: 'SETTLED' }> {
  if (o.state !== 'SETTLED') throw new Error(`期望 SETTLED，实际 ${o.state}（${'reason' in o ? o.reason : ''} ${'code' in o ? o.code : ''}）`);
  return o;
}

// ===== 定点断言基准（指数 3000.0000 开盘；close/3000 − 1 全为精确有限小数）=====

const IDX_BASE = '3000.0000';
const closeOfIndex = (close: string) => () => close;

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
  await insertCalendar(CAL);
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
});

// ===== SR-8A.2 三态方向命中 =====

test('UP 命中：全字段手算对照（r=0.1；MAE=−0.02 同源重算；未触发失效；FILLABLE；诊断收益独立）', async () => {
  // 指数：ref 开盘 3000；第 5 日（CAL[4]）收盘 2940 → r_5 = −0.02；第 20 日收盘 3300 → r = 0.1
  await insertIndex(IDX, CAL, (d) => (d === CAL[4] ? '2940.0000' : d === LAST_20TH ? '3300.0000' : '3000.0000'), IDX_BASE);
  // ETF：ref 开盘 2.7500、末日收盘 2.9000 → 诊断价格收益 = 2.9/2.75 − 1 = 0.054545454545（≠ r）
  await insertEtf('510300', flatEtf('2.7500', '2.7600', '2.9000'));
  const o = settled(await settleEtfConclusion(pool, etfArgs('510300', 'RESEARCH_UP')));
  assert.equal(o.zone.directionHit, true); // r = 0.1 > 0
  assert.equal(o.zone.excessReturn, '0.1'); // 3300/3000 − 1
  assert.equal(o.zone.maxAdverse, '-0.02'); // min r_d = r_5（如实记录不截断）
  assert.equal(o.zone.invalidationTriggered, false); // −0.02 > −0.05 未触发（SR-8A.4）
  assert.equal(o.zone.tradability, 'FILLABLE');
  assert.equal(o.diagnostics.referenceDay, REF);
  assert.equal(o.diagnostics.referenceOpen, '2.7500');
  assert.equal(o.diagnostics.windowEndDay, LAST_20TH);
  assert.equal(o.diagnostics.tradedDays, 20);
  assert.equal(o.diagnostics.indexOpenRef, IDX_BASE); // R26.1：I_ref = 参考价日指数开盘
  assert.equal(o.diagnostics.trackedIndex, IDX);
  assert.equal(o.diagnostics.etfPriceReturn, '0.054545454545'); // 诊断字段独立于指数口径
  assert.equal(o.diagnostics.invalidationFirstDay, null);
  // SR-8A.1 证伪：r_window、MAE、失效可由同一逐日序列独立重算
  const rList = o.diagnostics.series.map((d) => d.r);
  assert.equal(rList[19], o.zone.excessReturn);
  let m = decFrom(rList[0] as string);
  for (const r of rList.slice(1)) m = decMin(m, decFrom(r));
  assert.equal(decToString(m), o.zone.maxAdverse);
  assert.equal(rList.some((r) => decFrom(r).scaled < 0n), true); // 序列含负值（第 5 日）
});

test('DOWN 命中（r=−0.1 < 0 HIT）；同一行情 UP 视角 MISS', async () => {
  const DOWN_IDX = '000905';
  await insertIndex(DOWN_IDX, CAL, (d) => (d === LAST_20TH ? '2700.0000' : '3000.0000'), IDX_BASE);
  await insertEtf('510500', flatEtf('7.0000', '7.0000', '6.3000'));
  const down = settled(await settleEtfConclusion(pool, etfArgs('510500', 'RESEARCH_DOWN', { trackedIndex: DOWN_IDX })));
  assert.equal(down.zone.excessReturn, '-0.1'); // 2700/3000 − 1
  assert.equal(down.zone.directionHit, true); // r < 0
  assert.equal(down.zone.maxAdverse, '0'); // DOWN 侧 max r_d：平价日 r=0
  assert.equal(down.zone.invalidationTriggered, false); // 无 r_d ≥ +0.05
  const up = settled(await settleEtfConclusion(pool, etfArgs('510500', 'RESEARCH_UP', { trackedIndex: DOWN_IDX })));
  assert.equal(up.zone.directionHit, false); // r = −0.1 ≤ 0 → UP MISS
});

test('r_window 恰为 0：严格不等，UP 与 DOWN 两侧均 MISS', async () => {
  const ZERO_IDX = '000852';
  await insertIndex(ZERO_IDX, CAL, () => '3000.0000', IDX_BASE); // 末日收盘 = ref 开盘 → r = 0
  await insertEtf('512100', flatEtf('1.0000', '1.0000', '1.0000'));
  const up = settled(await settleEtfConclusion(pool, etfArgs('512100', 'RESEARCH_UP', { trackedIndex: ZERO_IDX })));
  assert.equal(up.zone.excessReturn, '0');
  assert.equal(up.zone.directionHit, false); // SR-8A.2 严格不等
  const down = settled(await settleEtfConclusion(pool, etfArgs('512100', 'RESEARCH_DOWN', { trackedIndex: ZERO_IDX })));
  assert.equal(down.zone.directionHit, false);
});

test('ABSTAIN：r_window 照常计算记录；directionHit/maxAdverse/失效 N/A；tradability N/A', async () => {
  const subject = '510050';
  await insertEtf(subject, flatEtf('3.0000', '3.0000', '3.3000')); // 复用第一测试的 000300 指数（r=0.1）
  const o = settled(await settleEtfConclusion(pool, etfArgs(subject, 'ABSTAIN')));
  assert.equal(o.zone.directionHit, null); // N_A
  assert.equal(o.zone.excessReturn, '0.1'); // 照常计算并记录（SR-2.2 放弃列沿用）
  assert.equal(o.zone.maxAdverse, null);
  assert.equal(o.zone.tradability, 'N_A');
  assert.equal('invalidationTriggered' in o.zone, false); // N/A：字段缺席
  assert.equal(o.diagnostics.etfPriceReturn, '0.1'); // 诊断照常（3.3/3.0 − 1）
});

// ===== SR-8A.4 失效触发 5% 边界 =====

test('UP 侧失效恰 −5% 触发（r_d = −0.05，≤ 含等号）；首触发日与 MAE 记录', async () => {
  const B_IDX = '399018';
  // 第 5 日收盘 2850 → r_5 = −0.05 恰触发；末日 3300 → r = 0.1（UP 命中但已触发失效记录）
  await insertIndex(B_IDX, CAL, (d) => (d === CAL[4] ? '2850.0000' : d === LAST_20TH ? '3300.0000' : '3000.0000'), IDX_BASE);
  await insertEtf('510050', flatEtf('3.0000', '3.0000', '3.3000'));
  const o = settled(await settleEtfConclusion(pool, etfArgs('510050', 'RESEARCH_UP', { trackedIndex: B_IDX })));
  assert.equal(o.zone.directionHit, true);
  assert.equal(o.zone.invalidationTriggered, true);
  assert.equal(o.diagnostics.invalidationFirstDay, CAL[4]); // 首个 r_d ≤ −0.05 的日
  assert.equal(o.zone.maxAdverse, '-0.05');
  assert.equal(o.diagnostics.invalidationThreshold, '0.05'); // 默认值（SR-8A.4 预留）
});

test('DOWN 侧失效恰 +5% 触发（r_d = +0.05，≥ 含等号）', async () => {
  // 独立指数代码（000300 已有形态不同行情，同 factId 异内容会 FACT_CONFLICT，POINT-IN-TIME §4）
  const D_IDX = '399905';
  await insertIndex(D_IDX, CAL, (d) => (d === CAL[4] ? '3150.0000' : d === LAST_20TH ? '2700.0000' : '3000.0000'), IDX_BASE);
  await insertEtf('159901', flatEtf('1.0000', '1.0000', '0.9000'));
  const o = settled(await settleEtfConclusion(pool, etfArgs('159901', 'RESEARCH_DOWN', { trackedIndex: D_IDX })));
  assert.equal(o.zone.directionHit, true); // r = −0.1 < 0
  assert.equal(o.zone.invalidationTriggered, true);
  assert.equal(o.diagnostics.invalidationFirstDay, CAL[4]); // 首个 r_d ≥ +0.05 的日
  assert.equal(o.zone.maxAdverse, '0.05'); // DOWN 侧 max r_d
});

test('边界外不触发：min r_d = −0.048 > −0.05', async () => {
  const E_IDX = '399852';
  await insertIndex(E_IDX, CAL, (d) => (d === CAL[4] ? '2856.0000' : d === LAST_20TH ? '3300.0000' : '3000.0000'), IDX_BASE);
  await insertEtf('510900', flatEtf('1.0000', '1.0000', '1.1000'));
  const o = settled(await settleEtfConclusion(pool, etfArgs('510900', 'RESEARCH_UP', { trackedIndex: E_IDX })));
  assert.equal(o.zone.invalidationTriggered, false); // 2856/3000 − 1 = −0.048 精确，不越 −5%
  assert.equal(o.zone.maxAdverse, '-0.048');
});

// ===== SR-8A.3 ETF 一字板（±10%，无 ST）=====

test('参考价日一字涨停：UP 侧 UNFILLABLE_LIMIT_UP、DOWN 侧 FILLABLE；结算照常', async () => {
  const F_IDX = '399300';
  await insertIndex(F_IDX, CAL, (d) => (d === LAST_20TH ? '3300.0000' : '3000.0000'), IDX_BASE);
  // ETF 参考价日：前收盘 10.0000 → 涨停价 11.00（10.00×1.1 到分）；四价 11.0000 一字
  const specs = flatEtf('11.0000', '11.0000', '12.0000');
  specs[REF] = { open: '11.0000', high: '11.0000', low: '11.0000', close: '11.0000', preclose: '10.0000' };
  await insertEtf('510880', specs);
  const up = settled(await settleEtfConclusion(pool, etfArgs('510880', 'RESEARCH_UP', { trackedIndex: F_IDX })));
  assert.equal(up.zone.tradability, 'UNFILLABLE_LIMIT_UP'); // 买入侧被一字涨停挡
  assert.equal(up.diagnostics.tradability.oneWordBoard, 'LIMIT_UP');
  assert.equal(up.diagnostics.tradability.limit?.up, '11.00');
  assert.equal(up.diagnostics.tradability.limit?.ruleVersionId, 'ASHARE-RULES-2.1-BROAD-ETF-10');
  assert.equal(up.zone.directionHit, true); // 不可成交仍照常结算（SR-4.3 沿用）
  assert.equal(up.zone.excessReturn, '0.1');
  const down = settled(await settleEtfConclusion(pool, etfArgs('510880', 'RESEARCH_DOWN', { trackedIndex: F_IDX })));
  assert.equal(down.zone.tradability, 'FILLABLE'); // DOWN（回避侧）不被涨停挡
  assert.equal(down.diagnostics.tradability.oneWordBoard, 'LIMIT_UP');
});

test('参考价日一字跌停：DOWN 侧 UNFILLABLE_LIMIT_DOWN、UP 侧 FILLABLE', async () => {
  const G_IDX = '399016';
  await insertIndex(G_IDX, CAL, (d) => (d === LAST_20TH ? '2700.0000' : '3000.0000'), IDX_BASE);
  // 前收盘 10.0000 → 跌停价 9.00（10.00×0.9 到分）；四价 9.0000 一字
  const specs = flatEtf('9.0000', '9.0000', '8.0000');
  specs[REF] = { open: '9.0000', high: '9.0000', low: '9.0000', close: '9.0000', preclose: '10.0000' };
  await insertEtf('510810', specs);
  const down = settled(await settleEtfConclusion(pool, etfArgs('510810', 'RESEARCH_DOWN', { trackedIndex: G_IDX })));
  assert.equal(down.zone.tradability, 'UNFILLABLE_LIMIT_DOWN');
  assert.equal(down.diagnostics.tradability.oneWordBoard, 'LIMIT_DOWN');
  assert.equal(down.diagnostics.tradability.limit?.down, '9.00');
  assert.equal(down.zone.directionHit, true); // r = −0.1
  const up = settled(await settleEtfConclusion(pool, etfArgs('510810', 'RESEARCH_UP', { trackedIndex: G_IDX })));
  assert.equal(up.zone.tradability, 'FILLABLE'); // UP（买入侧）不被跌停挡
});

// ===== SR-3.2/3.3 停牌（顺延与窗口计时，沿用个股口径）=====

test('完成后首交易日停牌：参考价顺延至复牌日，UNFILLABLE_SUSPENDED，跨度 1', async () => {
  const H_IDX = '399100';
  await insertIndex(H_IDX, CAL, (d) => (d === CAL[20] ? '3300.0000' : '3000.0000'), IDX_BASE);
  // ETF CAL[0]（首候选日）停牌（无行）→ 参考价日 = CAL[1]；窗口从 CAL[1] 起第 20 日 = CAL[20]
  const specs = flatEtf('2.0000', '2.0000', '2.2000', CAL.slice(1));
  await insertEtf('512880', specs);
  const o = settled(await settleEtfConclusion(pool, etfArgs('512880', 'RESEARCH_UP', { trackedIndex: H_IDX })));
  assert.equal(o.diagnostics.referenceDay, CAL[1]); // 顺延
  assert.equal(o.diagnostics.deferredBySuspension, true);
  assert.equal(o.diagnostics.suspensionSpanTradingDays, 1);
  assert.equal(o.zone.tradability, 'UNFILLABLE_SUSPENDED');
  assert.equal(o.diagnostics.windowEndDay, CAL[20]); // 停牌日不计时：窗口右移一日
  assert.equal(o.diagnostics.tradedDays, 20);
  assert.equal(o.zone.directionHit, true); // 顺延后照常结算（SR-4.3 沿用）
});

test('窗口内停牌 5 个交易日：窗口结束日 = 第 25 个市场交易日；间隔入诊断', async () => {
  const I_IDX = '399333';
  await insertIndex(I_IDX, CAL, (d) => (d === CAL[24] ? '3300.0000' : '3000.0000'), IDX_BASE);
  const specs = flatEtf('2.0000', '2.0000', '2.2000', CAL, 30);
  for (const d of CAL.slice(3, 8)) delete specs[d]; // 5 个交易日停牌
  await insertEtf('512690', specs);
  const o = settled(await settleEtfConclusion(pool, etfArgs('512690', 'RESEARCH_UP', { trackedIndex: I_IDX })));
  assert.equal(o.diagnostics.windowEndDay, CAL[24]); // 参考价日起第 25 个市场交易日
  assert.equal(o.diagnostics.tradedDays, 20);
  assert.deepEqual(
    o.diagnostics.suspensionGaps.map((g) => ({ from: g.from, to: g.to, n: g.tradingDays })),
    [{ from: CAL[2] as string, to: CAL[8] as string, n: 5 }],
  );
  assert.equal(o.zone.tradability, 'FILLABLE'); // 短停牌不阻断参考价日可成交性
  assert.equal(o.zone.excessReturn, '0.1');
});

// ===== SR-2.4 未到期 / SR-10.4 具名异常 =====

test('未到期：窗口仅 12/20 → UNSETTLED（WINDOW_INCOMPLETE），不提前结算', async () => {
  const J_IDX = '399005';
  await insertIndex(J_IDX, CAL, () => '3000.0000', IDX_BASE);
  await insertEtf('159915', flatEtf('1.0000', '1.0000', '1.0000', CAL, 12)); // 仅 12 个有成交日
  const o = await settleEtfConclusion(pool, etfArgs('159915', 'RESEARCH_UP', { trackedIndex: J_IDX }));
  assert.equal(o.state, 'UNSETTLED');
  assert.equal(o.reason, 'WINDOW_INCOMPLETE');
  assert.match(o.detail, /12\/20/);
});

test('指数在窗口日缺行情：ANOMALY（INDEX_BAR_MISSING），不用替代数据补算', async () => {
  const K_IDX = '399006';
  const daysWithoutGap = CAL.filter((d) => d !== CAL[10]); // 指数缺窗口第 11 日
  await insertIndex(K_IDX, daysWithoutGap, () => '3000.0000', IDX_BASE);
  await insertEtf('159995', flatEtf('1.0000', '1.0000', '1.0000'));
  const o = await settleEtfConclusion(pool, etfArgs('159995', 'RESEARCH_UP', { trackedIndex: K_IDX }));
  assert.equal(o.state, 'ANOMALY');
  assert.equal(o.code, 'INDEX_BAR_MISSING');
  assert.match(o.detail, /CAL|2024/); // 异常 detail 含缺行情日
});

test('指数在参考价日缺行情：ANOMALY（INDEX_BAR_MISSING，R26.3 不顺延不静默）', async () => {
  const L_IDX = '399007';
  const daysWithoutRef = CAL.filter((d) => d !== REF);
  await insertIndex(L_IDX, daysWithoutRef, () => '3000.0000', IDX_BASE);
  await insertEtf('159998', flatEtf('1.0000', '1.0000', '1.0000'));
  const o = await settleEtfConclusion(pool, etfArgs('159998', 'RESEARCH_UP', { trackedIndex: L_IDX }));
  assert.equal(o.state, 'ANOMALY');
  assert.equal(o.code, 'INDEX_BAR_MISSING');
});

test('结论太新（日历内已无后续交易日）：UNSETTLED（REFERENCE_NOT_DUE）', async () => {
  await insertEtf('159999', flatEtf('1.0000', '1.0000', '1.0000', CAL, 5));
  const o = await settleEtfConclusion(pool, etfArgs('159999', 'RESEARCH_UP', {
    trackedIndex: IDX,
    conclusionTime: '2024-04-01T20:00:00+08:00', // CAL 最后交易日之后 → 无候选日
  }));
  assert.equal(o.state, 'UNSETTLED');
  assert.equal(o.reason, 'REFERENCE_NOT_DUE');
});

// ===== ETF → 跟踪指数映射（R24 冻结池）=====

test('parseTrackedIndex：冻结池 tracks 字符串解析与具名拒绝', () => {
  assert.equal(parseTrackedIndex('上证50(000016)'), '000016');
  assert.equal(parseTrackedIndex('沪深300(000300)'), '000300');
  assert.equal(parseTrackedIndex('中证500(000905)'), '000905');
  assert.equal(parseTrackedIndex('中证1000(000852)'), '000852');
  assert.throws(() => parseTrackedIndex('无括号字符串'), (e: unknown) => e instanceof SettlementError && e.code === 'ETF_TRACKS_UNPARSEABLE');
  assert.throws(() => parseTrackedIndex('错误(12345)'), (e: unknown) => e instanceof SettlementError && e.code === 'ETF_TRACKS_UNPARSEABLE');
});

test('loadEtfIndexMap：R24 冻结池 4 只 ETF 全解析', async () => {
  const map = await loadEtfIndexMap();
  assert.equal(map.get('510050'), '000016');
  assert.equal(map.get('510300'), '000300');
  assert.equal(map.get('510500'), '000905');
  assert.equal(map.get('512100'), '000852');
  assert.equal(map.size, 4);
});

test('默认映射路径：不传 trackedIndex 时按冻结池解析（510050 → 000016）并全链结算', async () => {
  await insertIndex(TRACKS_510050, CAL, (d) => (d === LAST_20TH ? '3300.0000' : '3000.0000'), IDX_BASE);
  await insertEtf('510050', flatEtf('3.0000', '3.0000', '3.3000'));
  const o = settled(await settleEtfConclusion(pool, {
    subject: '510050', disposition: 'RESEARCH_UP', conclusionTime: CONCLUSION_T0, asOf: AS_OF, // 不传 trackedIndex
  }));
  assert.equal(o.diagnostics.trackedIndex, '000016'); // 来自 data/research-pool.json
  assert.equal(o.zone.excessReturn, '0.1');
  assert.equal(o.zone.directionHit, true);
});

// ===== R18 跨类与输入校验 =====

test('个股 disposition / 非 ETF 代码段 / 池外 ETF：具名拒绝', async () => {
  await assert.rejects(
    settleEtfConclusion(pool, etfArgs('510300', 'RESEARCH_OUTPERFORM' as 'RESEARCH_UP')),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
  await assert.rejects(
    settleEtfConclusion(pool, etfArgs('600519', 'RESEARCH_UP')),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
  await assert.rejects(
    // 不注入 trackedIndex：走冻结池解析，池外标的具名拒绝
    settleEtfConclusion(pool, { subject: '519999', disposition: 'RESEARCH_UP', conclusionTime: CONCLUSION_T0, asOf: AS_OF }),
    (e: unknown) => e instanceof SettlementError && e.code === 'ETF_NOT_IN_POOL',
  );
  await assert.rejects(
    settleEtfConclusion(pool, etfArgs('510300', 'RESEARCH_UP', { invalidationThreshold: '-0.05' })),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
});
