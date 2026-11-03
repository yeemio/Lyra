/**
 * Lyra · 参考价与窗口单测（P3 W13: code-writer-pro）。
 * 合同判定：SETTLEMENT-REVIEW SR-3.1（统一参考价裁定）/ SR-3.2（四类情形实例化，
 * 含溢出降级者证伪与停牌顺延）/ SR-2.4（未到期）；ASHARE-RULES §4（open_time > t 严格）/
 * §6（停牌行/无行皆为未成交）。
 * 纯函数用例注入日历与行情；DB 用例走本地 lyra-pg 隔离 schema（不碰网络）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import type { TimePointFact } from '../contracts.js';
import {
  countTradingDaysBetween,
  resolveReferenceOpen,
  shanghaiOpenMs,
  type DailyBarView,
  type ReferenceOpenResult,
} from './reference.js';

/** OK 形态收窄助手（非 OK 直接失败）。 */
function okRef(r: ReferenceOpenResult): Extract<ReferenceOpenResult, { state: 'OK' }> {
  if (r.state !== 'OK') throw new Error(`期望 OK，实际 ${r.state}（${r.detail}）`);
  return r;
}

// ===== 夹具：连续工作日交易日历 + 行情行 =====

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.00Z`);
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** 从 start 起取 n 个工作日（跳过周六日；节假日按无行情行/停牌语义另行注入）。 */
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

function bar(day: string, open: string, overrides: Partial<DailyBarView> = {}): DailyBarView {
  return {
    factId: `bar-${day}`,
    date: day,
    open,
    high: open,
    low: open,
    close: open,
    preclose: open,
    volume: '1000000',
    amount: '1000000.0000',
    isST: '0',
    tradestatus: '1',
    ...overrides,
  };
}

const CAL = weekdays('2024-01-02', 40); // 2024-01-02(二) 起 40 个工作日

function barsFor(days: string[]): Map<string, DailyBarView> {
  return new Map(days.map((d, i) => [d, bar(d, `${10 + i}.00`)]));
}

// ===== SR-3.1/3.2 裁定（纯函数）=====

test('SR-3.2 情形 1：交易日 08:00–09:15 完成 → 当日开盘价（t 早于开盘）', () => {
  const r = resolveReferenceOpen(CAL, barsFor(CAL), new Date('2024-01-03T08:00:00+08:00'));
  assert.equal(okRef(r).referenceDay, '2024-01-03');
  assert.equal(okRef(r).deferredBySuspension, false);
  assert.equal(okRef(r).suspensionSpanTradingDays, 0);
});

test('ASHARE §4 严格不等：t 恰为开盘时刻不计当日；盘中/收盘后 → 下一交易日', () => {
  const bars = barsFor(CAL);
  const atOpen = resolveReferenceOpen(CAL, bars, new Date('2024-01-03T09:30:00+08:00'));
  assert.equal(okRef(atOpen).referenceDay, '2024-01-04');
  const midDay = resolveReferenceOpen(CAL, bars, new Date('2024-01-03T10:30:00+08:00'));
  assert.equal(okRef(midDay).referenceDay, '2024-01-04');
  const afterClose = resolveReferenceOpen(CAL, bars, new Date('2024-01-03T16:00:00+08:00'));
  assert.equal(okRef(afterClose).referenceDay, '2024-01-04');
});

test('SR-3.2 情形 3：周末完成 → 下一交易日开盘价', () => {
  const r = resolveReferenceOpen(CAL, barsFor(CAL), new Date('2024-01-06T12:00:00+08:00'));
  assert.equal(okRef(r).referenceDay, '2024-01-08');
});

test('SR-3.2 溢出降级者证伪：事件日 D、D+1 晚完成周度研究 → 参考价 = D+2 开盘（不回溯 D/D+1）', () => {
  const D = '2024-01-03';
  const bars = barsFor(CAL);
  const r = resolveReferenceOpen(CAL, bars, new Date('2024-01-04T20:00:00+08:00')); // D+1 当晚完成
  const ok = okRef(r);
  assert.equal(ok.referenceDay, '2024-01-05'); // D+1 之后首个交易日（D=03、D+1=04 均不回溯）
  assert.notEqual(ok.referenceDay, D);
  assert.notEqual(ok.referenceDay, '2024-01-04');
});

test('SR-3.2 情形 4：完成后首交易日停牌 → 顺延至复牌首日，跨度计数（无行与停牌行同义）', () => {
  const bars = barsFor(CAL);
  bars.delete('2024-01-03'); // 无行情行（停牌日无行，ASHARE §6 正常表现）
  bars.set('2024-01-04', bar('2024-01-04', '11.00', { tradestatus: '0', volume: '', amount: '' })); // 停牌行
  const r = resolveReferenceOpen(CAL, bars, new Date('2024-01-02T16:00:00+08:00'));
  const ok = okRef(r);
  assert.equal(ok.referenceDay, '2024-01-05'); // 复牌首日
  assert.equal(ok.deferredBySuspension, true);
  assert.equal(ok.suspensionSpanTradingDays, 2); // 01-03（无行）+ 01-04（停牌行）
  assert.equal(ok.referenceOpen, '13.00'); // barsFor：CAL[3] = 10 + 3
});

test('长期顺延跨度计数：25 个市场交易日停牌（SUSPENDED_OVER_20D 分类输入）', () => {
  const bars = barsFor(CAL);
  for (const d of CAL.slice(1, 26)) bars.delete(d); // 首候选日起连续 25 个交易日停牌
  const r = resolveReferenceOpen(CAL, bars, new Date('2024-01-02T16:00:00+08:00'));
  const ok = okRef(r);
  assert.equal(ok.referenceDay, CAL[26] as string);
  assert.equal(ok.suspensionSpanTradingDays, 25); // > 20（ASHARE §6 长期停牌）
});

test('SR-2.4 NOT_DUE：t 后无市场交易日（太新）', () => {
  const last = CAL[CAL.length - 1] as string;
  const r = resolveReferenceOpen(CAL, barsFor(CAL), new Date(`${nextDay(last)}T10:00:00+08:00`));
  assert.equal(r.state, 'NOT_DUE');
  if (r.state === 'NOT_DUE') assert.equal(r.reason, 'AFTER_LAST_MARKET_DAY');
});

test('NOT_DUE：有市场交易日但该股其后均无成交（停牌未复牌/停止交易）', () => {
  const bars = barsFor(CAL.slice(0, 4)); // 01-05（最后有成交日）后无行情
  const r = resolveReferenceOpen(CAL, bars, new Date('2024-01-05T16:00:00+08:00')); // 最后有成交日收盘后
  assert.equal(r.state, 'NOT_DUE');
  if (r.state === 'NOT_DUE') assert.equal(r.reason, 'NO_TRADED_DAY_AFTER');
});

test('countTradingDaysBetween：(from, to) 开区间计数；to=null 数到日历尾', () => {
  assert.equal(countTradingDaysBetween(CAL, '2024-01-03', '2024-01-08'), 2); // 01-04、01-05（周末不计数）
  assert.equal(countTradingDaysBetween(CAL, '2024-01-03', '2024-01-04'), 0);
  assert.equal(countTradingDaysBetween(CAL, '2024-01-03', null), CAL.length - 2); // 01-03 为 CAL[1]，其后 38 个交易日
  assert.equal(shanghaiOpenMs('2024-01-03'), new Date('2024-01-03T09:30:00+08:00').getTime());
});

// ===== DB 用例（隔离 schema；referenceOpen 装载 → 纯函数裁定接线）=====

const SCHEMA = `w13_ref_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
});

const ART = 'cd'.repeat(32);

function calendarFact(day: string, isTrading: '0' | '1'): TimePointFact {
  return {
    factId: `cal-${day}-${isTrading}`,
    subjectType: 'RULE',
    subjectId: 'ashare-calendar',
    factKind: 'TRADE_CALENDAR',
    typedValue: { calendar_date: day, is_trading_day: isTrading },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: '2023-12-31T00:00:00.000Z',
    availableAt: new Date(`${day}T15:00:00+08:00`).toISOString(),
    supersedesFactId: null,
    artifactSha256: ART,
    adapterVersion: 'test@w13',
  };
}

function dailyBarFact(subjectId: string, day: string, price: string, tradestatus: '0' | '1'): TimePointFact {
  const p = `${price}.0000`; // 元价 → BaoStock 风格 4 位小数字符串
  return {
    factId: `sb-${subjectId}-${day}-${tradestatus}`,
    subjectType: 'STOCK',
    subjectId,
    factKind: 'DAILY_BAR',
    typedValue: {
      code: `sh.${subjectId}`,
      date: day,
      open: p,
      high: p,
      low: p,
      close: p,
      preclose: p,
      volume: tradestatus === '1' ? '1000' : '0',
      amount: tradestatus === '1' ? '10000.0000' : '0.0000',
      adjustflag: '3',
      tradestatus,
      isST: '0',
    },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: '2023-12-31T00:00:00.000Z',
    availableAt: new Date(`${day}T15:00:00+08:00`).toISOString(),
    supersedesFactId: null,
    artifactSha256: ART,
    adapterVersion: 'test@w13',
  };
}

test('DB：referenceOpen 接线（含停牌顺延 + 停牌行/无行同义 + 非交易日行过滤）', async () => {
  const days = weekdays('2024-01-02', 10);
  for (const d of days) {
    await insertFact(pool, calendarFact(d, '1'));
    // 周六也插一行非交易日日历（证明 is_trading_day='0' 过滤）
    const dow = new Date(`${d}T00:00:00.00Z`).getUTCDay();
    if (dow === 5) {
      const sat = nextDay(d);
      await insertFact(pool, calendarFact(sat, '0'));
    }
  }
  // 600001：正常交易（每天 traded）
  for (const d of days) await insertFact(pool, dailyBarFact('600001', d, '10', '1'));
  // 600002：首个候选日（01-03）停牌行、次交易日（01-04）无行、01-05 复牌
  await insertFact(pool, dailyBarFact('600002', '2024-01-02', '10', '1'));
  await insertFact(pool, dailyBarFact('600002', '2024-01-03', '10', '0'));
  await insertFact(pool, dailyBarFact('600002', '2024-01-05', '11', '1'));
  for (const d of days.slice(4)) await insertFact(pool, dailyBarFact('600002', d, '12', '1'));

  const { referenceOpen } = await import('./reference.js');
  const asOf = new Date('2024-02-01T00:00:00.000Z');

  const normal = await referenceOpen(pool, { subject: '600001', conclusionTime: '2024-01-03T08:00:00+08:00', asOf });
  assert.equal(okRef(normal).referenceDay, '2024-01-03'); // t 早于开盘 → 当日
  assert.equal(okRef(normal).referenceOpen, '10.0000'); // 原始价字符串原样

  const deferred = await referenceOpen(pool, { subject: '600002', conclusionTime: '2024-01-02T16:00:00+08:00', asOf });
  const okDeferred = okRef(deferred);
  assert.equal(okDeferred.referenceDay, '2024-01-05');
  assert.equal(okDeferred.deferredBySuspension, true);
  assert.equal(okDeferred.suspensionSpanTradingDays, 2);
  assert.equal(okDeferred.referenceOpen, '11.0000');

  const tooNew = await referenceOpen(pool, { subject: '600001', conclusionTime: '2024-01-20T10:00:00+08:00', asOf });
  assert.equal(tooNew.state, 'NOT_DUE');
  if (tooNew.state === 'NOT_DUE') assert.equal(tooNew.reason, 'AFTER_LAST_MARKET_DAY');
});

test('DB：同日多行情事实（来源冲突）具名暴露，不静默合并', async () => {
  const days = weekdays('2024-03-04', 3);
  for (const d of days) await insertFact(pool, calendarFact(d, '1'));
  await insertFact(pool, dailyBarFact('600003', '2024-03-04', '10', '1'));
  const conflicting: TimePointFact = {
    ...dailyBarFact('600003', '2024-03-04', '20', '1'),
    factId: 'sb-600003-2024-03-04-conflict',
  };
  await insertFact(pool, conflicting);
  const { referenceOpen } = await import('./reference.js');
  await assert.rejects(
    () => referenceOpen(pool, { subject: '600003', conclusionTime: '2024-03-04T16:00:00+08:00', asOf: new Date('2024-04-01T00:00:00Z') }),
    (e: unknown) => (e as { code?: string }).code === 'BAR_DATE_CONFLICT',
  );
});
