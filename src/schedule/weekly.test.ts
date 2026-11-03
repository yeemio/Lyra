/**
 * Lyra · 滚动周度轮转单测（P3 W17: code-writer-pro）。纯函数，日历注入。
 * 合同判定：SCHEDULING.md SC-4.1（每晚 6 只 × 5 交易日覆盖 30；宽基只进周度轮转）、
 * SC-4.2（顺序固定可读回、随池版本冻结）、SC-4.3（节假日跨周补齐排队首）。
 * 池夹具 = data/research-pool.json 冻结顺序（26 个股 + 4 宽基，文件顺序）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTradeCalendarTable } from '../adapters/calendar.js';
import type { RotationSubject } from './weekly.js';
import {
  fullWeekSubjects,
  nightSubjects,
  planWeeklyNights,
  rotationTableFromPool,
  weekTradingDaysOf,
  whichNight,
  NIGHTS_PER_WEEK,
  ROTATION_PER_NIGHT,
} from './weekly.js';

const STOCKS = ['603986', '002384', '600176', '600183', '000938', '603259', '601899', '600522', '002281', '000977',
  '600105', '000988', '600519', '000657', '002407', '002008', '601318', '603993', '600276', '600150',
  '002851', '603019', '600036', '600900', '603256', '600030'];
const ETFS = ['510050', '510300', '510500', '512100'];

const POOL = {
  frozenAt: '2026-10-25',
  stocks: STOCKS.map((code) => ({ code })),
  etfs: ETFS.map((code) => ({ code })),
};

const TABLE = rotationTableFromPool(POOL);

// 国庆缺口日历：09-28/29/30 交易（周 1），10-08/09 交易（国庆周 2 天），10-12..16、10-19..23 交易
const CAL = buildTradeCalendarTable(
  ['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-08', '2026-10-09',
   '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
   '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
    .map((d) => ({ calendar_date: d, is_trading_day: '1' })),
);

const sub = (code: string): RotationSubject => ({
  subjectKind: code.startsWith('51') ? 'BROAD_ETF' : 'STOCK',
  subject: code,
});

// ===== SC-4.1 覆盖与池规模 =====

test('SC-4.1：池 30 只（26 个股 + 4 宽基），5 桶 × 6 只；一个完整周去重后覆盖全部 30', () => {
  assert.equal(TABLE.order.length, 30);
  assert.equal(TABLE.buckets.length, NIGHTS_PER_WEEK);
  assert.equal(fullWeekSubjects(TABLE).length, 30);
  assert.deepEqual(
    [...new Set(fullWeekSubjects(TABLE).map((s) => s.subject))].sort(),
    [...STOCKS, ...ETFS].sort(),
  );
  // 宽基只进周度轮转（SC-4.1 后半句由 queue 层具名拒绝落实，见 queue.test）
  assert.deepEqual(TABLE.buckets[4]?.map((s) => s.subject), ['603256', '600030', '510050', '510300', '510500', '512100']);
});

test('池规模异常具名拒绝（≠30 不构建顺序表）', () => {
  assert.throws(
    () => rotationTableFromPool({ frozenAt: 'x', stocks: STOCKS.slice(0, 25).map((code) => ({ code })), etfs: ETFS.map((code) => ({ code })) }),
    (e: unknown) => e instanceof Error && e.message.includes('ROTATION_POOL_SIZE_INVALID'),
  );
});

// ===== SC-4.2 顺序固定可读回 =====

test('SC-4.2：第 1 交易日 → 第 1–6 只，依次类推；顺序 = 池文件顺序', () => {
  assert.deepEqual(nightSubjects(TABLE, 1).map((s) => s.subject), STOCKS.slice(0, 6));
  assert.deepEqual(nightSubjects(TABLE, 2).map((s) => s.subject), STOCKS.slice(6, 12));
  assert.deepEqual(nightSubjects(TABLE, 5).map((s) => s.subject), [...STOCKS.slice(24, 26), ...ETFS]);
  assert.equal(TABLE.order[0]?.subject, '603986'); // 文件顺序第一位
  assert.equal(TABLE.order[26]?.subject, '510050'); // 宽基紧随个股之后
});

test('SC-4.2 证伪：同一日期与池版本两次读回名单一致（确定性）', () => {
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  const a = planWeeklyNights(TABLE, week);
  const b = planWeeklyNights(TABLE, week);
  assert.deepEqual(a, b);
  assert.deepEqual(a.nights.map((n) => n.rotation.map((s) => s.subject)), [
    STOCKS.slice(0, 6), STOCKS.slice(6, 12), STOCKS.slice(12, 18), STOCKS.slice(18, 24), [...STOCKS.slice(24, 26), ...ETFS],
  ]);
  assert.deepEqual(a.newLeftover, []);
});

test('SC-4.2：任意给定股票可查询"本周哪晚研"', () => {
  assert.deepEqual(whichNight(TABLE, '600519'), { nth: 3, subjectKind: 'STOCK' }); // 第 13 只
  assert.deepEqual(whichNight(TABLE, '512100'), { nth: 5, subjectKind: 'BROAD_ETF' });
  assert.equal(whichNight(TABLE, '999999'), null);
});

// ===== 周归属 =====

test('weekTradingDaysOf：周一至周日窗口内的交易日（SC-10.1 排程基准）', () => {
  assert.deepEqual(weekTradingDaysOf(CAL, '2026-10-08'), ['2026-10-08', '2026-10-09']); // 国庆周
  assert.deepEqual(weekTradingDaysOf(CAL, '2026-10-12'), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.deepEqual(weekTradingDaysOf(CAL, '2026-10-14'), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.deepEqual(weekTradingDaysOf(CAL, '2026-10-17'), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']); // 周六归属当周
});

// ===== SC-4.3 节假日跨周补齐 =====

test('SC-4.3 证伪（国庆周 2 个交易日）：该周仅研究 12 只，未轮到名单整体顺延', () => {
  const week = weekTradingDaysOf(CAL, '2026-10-08');
  assert.equal(week.length, 2);
  const plan = planWeeklyNights(TABLE, week);
  assert.equal(plan.nights.length, 2);
  assert.equal(plan.studiedThisWeek.length, 12);
  assert.equal(plan.newLeftover.length, 18); // 桶 3/4/5 整体顺延
  assert.deepEqual(plan.newLeftover.map((s) => s.subject), [...STOCKS.slice(12, 26), ...ETFS]);
  // 各晚名单 = 固定映射
  assert.deepEqual(plan.nights[0]?.rotation.map((s) => s.subject), STOCKS.slice(0, 6));
  assert.deepEqual(plan.nights[1]?.rotation.map((s) => s.subject), STOCKS.slice(6, 12));
});

test('SC-4.3 证伪（遗留 6 只入次周）：次周前 3 晚各含 2 只补齐条目且排于轮转条目之前', () => {
  const leftover = STOCKS.slice(12, 18).map(sub); // 上周（4 个交易日）未轮到的 6 只
  const nextWeek = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  const plan = planWeeklyNights(TABLE, nextWeek, leftover);
  assert.deepEqual(plan.nights[0]?.catchUp.map((s) => s.subject), STOCKS.slice(12, 14));
  assert.deepEqual(plan.nights[1]?.catchUp.map((s) => s.subject), STOCKS.slice(14, 16));
  assert.deepEqual(plan.nights[2]?.catchUp.map((s) => s.subject), STOCKS.slice(16, 18));
  assert.deepEqual(plan.nights[3]?.catchUp, []);
  assert.deepEqual(plan.nights[4]?.catchUp, []);
  assert.deepEqual(plan.newLeftover, []); // 遗留全部消化
  // 补齐优先：被补齐提前研究的同名轮转条目让位、具名登记（第 3 晚轮转=同一桶 → 全部让位）
  assert.deepEqual(plan.nights[2]?.rotation, []);
  assert.deepEqual(plan.coveredByCatchUp.map((s) => s.subject), STOCKS.slice(12, 18));
  // 一周仍覆盖全部 30 只（每标的一周至多研一次）
  assert.equal(plan.studiedThisWeek.length, 30);
  assert.equal(new Set(plan.studiedThisWeek.map((s) => s.subject)).size, 30);
  // 排队首：补齐条目经 WEEKLY_DEFERRED 类（priority ①）先于轮转（queue 层排序，见 queue.test SC-5.1）
});

test('SC-4.3（遗留 18 只入次周）：跨周堆积整体补齐、总量守恒、每标的至多一次', () => {
  const leftover = [...STOCKS.slice(12, 26), ...ETFS].map(sub); // 国庆周遗留 18 只
  const nextWeek = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  const plan = planWeeklyNights(TABLE, nextWeek, leftover);
  const catchUpTotal = plan.nights.reduce((n, night) => n + night.catchUp.length, 0);
  assert.equal(catchUpTotal, 18); // 全部消化（chunk=4：4/4/4/4/2）
  assert.deepEqual(plan.nights.map((n) => n.catchUp.length), [4, 4, 4, 4, 2]);
  assert.deepEqual(plan.newLeftover, []);
  assert.equal(plan.coveredByCatchUp.length, 18); // 18 个轮转名额让位
  assert.equal(plan.studiedThisWeek.length, 30); // 12 轮转 + 18 补齐 = 30 唯一标的
  assert.equal(new Set(plan.studiedThisWeek.map((s) => s.subject)).size, 30);
});

test('SC-4.3（整周休市）：零晚、零研究、全部顺延', () => {
  const plan = planWeeklyNights(TABLE, [], STOCKS.slice(0, 6).map(sub));
  assert.equal(plan.nights.length, 0);
  assert.equal(plan.studiedThisWeek.length, 0);
  assert.equal(plan.newLeftover.length, 36); // 6 遗留 + 30 全池
});

test('补齐与本周轮转同名时不重复研（轮转让位、具名登记，不顺延）', () => {
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  const leftover = STOCKS.slice(0, 3).map(sub); // 恰为次周第 1 晚轮转名单前 3 只
  const plan = planWeeklyNights(TABLE, week, leftover);
  assert.deepEqual(plan.nights[0]?.catchUp.map((s) => s.subject), [STOCKS[0]]); // chunk=1：前 3 晚各 1 只
  assert.deepEqual(plan.nights[1]?.catchUp.map((s) => s.subject), [STOCKS[1]]);
  assert.deepEqual(plan.nights[2]?.catchUp.map((s) => s.subject), [STOCKS[2]]);
  assert.deepEqual(plan.nights[0]?.rotation.map((s) => s.subject), STOCKS.slice(3, 6)); // 同名 3 只让位
  assert.deepEqual(plan.coveredByCatchUp.map((s) => s.subject), STOCKS.slice(0, 3));
  assert.deepEqual(plan.newLeftover, []);
  assert.equal(new Set(plan.studiedThisWeek.map((s) => s.subject)).size, 30);
});

test('常量冻结：每晚 6 只、每周 5 晚', () => {
  assert.equal(ROTATION_PER_NIGHT, 6);
  assert.equal(NIGHTS_PER_WEEK, 5);
});
