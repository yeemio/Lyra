/**
 * Lyra · A 股交易日历（P1 W6: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 3/4（日历时点对象与任意日期封存的日历底座）、
 * docs/specs/DATA-SOURCES.md §2.3（BaoStock query_trade_dates）、§6（适配器取数）。
 *
 * 两层：
 * 1. 回填：backfillTradeCalendar 经 BaoStockAdapter.fetchTradeDates 一次真实调用
 *    （2015-01-01 → 今天）落 TRADE_CALENDAR 事实（W4 映射：availableAt=当日 15:00+08），
 *    行含交易日与非交易日（is_trading_day 0/1）。
 * 2. 纯函数：以注入的内存表（升序交易日数组）回答 isTradingDay / nextTradingDay /
 *    prevTradingDay / tradingDaysBetween / lastTradingDayOfMonth——不碰网络、单测可注入
 *    真实形状夹具（节假日跨月）。
 *
 * 覆盖边界诚实规则：表只覆盖 [首交易日, 末交易日]；界外日期抛具名 CalendarError，
 * 不猜测（宁可失败不编造）。
 */
import type { Pool } from 'pg';
import type { ArtifactRef } from '../contracts.js';
import { asOfFacts } from '../pintime/facts.js';
import type { BridgeRow } from './adapter-types.js';
import { BAOSTOCK_ADAPTER_VERSION, type BaoStockAdapter, type FetchResult } from './baostock.js';

/** 交易日历具名错误。code 为稳定错误名。 */
export class CalendarError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'CalendarError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidDate(date: string, field: string): void {
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())) {
    throw new CalendarError('CALENDAR_DATE_INVALID', `${field}=${date}`);
  }
}

/** 内存交易日历表：升序、去重的交易日 YYYY-MM-DD。 */
export interface TradeCalendarTable {
  readonly tradingDays: readonly string[];
}

/**
 * 由 TRADE_CALENDAR 事实行（calendar_date / is_trading_day 字符串）构建内存表（纯函数）。
 * 只取 is_trading_day='1' 的行；交易日行日期缺失/畸形抛 CALENDAR_ROW_INVALID。
 */
export function buildTradeCalendarTable(
  rows: Iterable<{ calendar_date?: string; is_trading_day?: string }>,
): TradeCalendarTable {
  const days = new Set<string>();
  for (const row of rows) {
    if (row.is_trading_day !== '1') continue;
    const date = row.calendar_date;
    if (typeof date !== 'string' || !DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())) {
      throw new CalendarError('CALENDAR_ROW_INVALID', `calendar_date=${String(date)}`);
    }
    days.add(date);
  }
  if (days.size === 0) throw new CalendarError('CALENDAR_EMPTY', '无任何 is_trading_day=1 行');
  return { tradingDays: [...days].sort() };
}

/** 从 DB 读全部 TRADE_CALENDAR 事实（as-of 现在）构建内存表。 */
export async function loadTradeCalendarTable(pool: Pool): Promise<TradeCalendarTable> {
  const facts = await asOfFacts(pool, {
    subjectType: 'RULE',
    subjectId: 'ashare-calendar',
    factKind: 'TRADE_CALENDAR',
    asOf: new Date(),
  });
  return buildTradeCalendarTable(facts.map((f) => f.typedValue as BridgeRow));
}

export function calendarCoverage(table: TradeCalendarTable): { first: string; last: string } {
  const first = table.tradingDays[0];
  const last = table.tradingDays[table.tradingDays.length - 1];
  if (first === undefined || last === undefined) throw new CalendarError('CALENDAR_EMPTY');
  return { first, last };
}

function assertInRange(table: TradeCalendarTable, date: string): void {
  const { first, last } = calendarCoverage(table);
  if (date < first || date > last) {
    throw new CalendarError('CALENDAR_RANGE', `${date} 超出日历覆盖 [${first}, ${last}]`);
  }
}

/** 是否交易日；界外日期抛 CALENDAR_RANGE（不猜测）。 */
export function isTradingDay(table: TradeCalendarTable, date: string): boolean {
  assertValidDate(date, 'date');
  assertInRange(table, date);
  return binarySearch(table.tradingDays, date) >= 0;
}

/** date 之后（严格大于）的下一个交易日；无（超出表尾）抛 CALENDAR_RANGE。 */
export function nextTradingDay(table: TradeCalendarTable, date: string): string {
  assertValidDate(date, 'date');
  assertInRange(table, date);
  const next = table.tradingDays[upperBound(table.tradingDays, date)];
  if (next === undefined) throw new CalendarError('CALENDAR_RANGE', `${date} 之后无覆盖交易日`);
  return next;
}

/** date 之前（严格小于）的上一个交易日；无（超出表头）抛 CALENDAR_RANGE。 */
export function prevTradingDay(table: TradeCalendarTable, date: string): string {
  assertValidDate(date, 'date');
  assertInRange(table, date);
  const i = lowerBound(table.tradingDays, date) - 1;
  const prev = i >= 0 ? table.tradingDays[i] : undefined;
  if (prev === undefined) throw new CalendarError('CALENDAR_RANGE', `${date} 之前无覆盖交易日`);
  return prev;
}

/** [from, to] 闭区间内的全部交易日（升序）；from>to 抛 CALENDAR_RANGE。 */
export function tradingDaysBetween(table: TradeCalendarTable, from: string, to: string): string[] {
  assertValidDate(from, 'from');
  assertValidDate(to, 'to');
  if (from > to) throw new CalendarError('CALENDAR_RANGE', `from ${from} > to ${to}`);
  assertInRange(table, from);
  assertInRange(table, to);
  return table.tradingDays.slice(lowerBound(table.tradingDays, from), upperBound(table.tradingDays, to));
}

/** ≤ date 的最近一个交易日（date 本身是交易日则返回 date）；无抛 CALENDAR_RANGE。 */
export function lastTradingDayOnOrBefore(table: TradeCalendarTable, date: string): string {
  assertValidDate(date, 'date');
  assertInRange(table, date);
  const i = upperBound(table.tradingDays, date) - 1;
  const prev = i >= 0 ? table.tradingDays[i] : undefined;
  if (prev === undefined) throw new CalendarError('CALENDAR_RANGE', `${date} 及之前无覆盖交易日`);
  return prev;
}

/**
 * 某年某月内的最后一个交易日 = 月内 ∩ 表覆盖 的最大交易日。当月未结束（覆盖尾在月内）
 * 时自然返回截至覆盖尾的最近交易日（即"截至今天的本月最后交易日"）；月内无覆盖交易日
 * （如未来月份）抛 CALENDAR_RANGE。
 */
export function lastTradingDayOfMonth(table: TradeCalendarTable, year: number, month: number): string {
  if (!Number.isInteger(year) || year < 1990 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new CalendarError('CALENDAR_MONTH_INVALID', `${String(year)}-${String(month)}`);
  }
  const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
  const last = table.tradingDays.filter((d) => d.startsWith(prefix)).at(-1);
  if (last === undefined) throw new CalendarError('CALENDAR_RANGE', `${prefix.slice(0, 7)} 月内无覆盖交易日`);
  return last;
}

// ===== 二分查找（tradingDays 升序）=====

function binarySearch(days: readonly string[], date: string): number {
  let lo = 0;
  let hi = days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = days[mid];
    if (v === date) return mid;
    if (v !== undefined && v < date) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 首个 > date 的下标。 */
function upperBound(days: readonly string[], date: string): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] !== undefined && days[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 首个 >= date 的下标。 */
function lowerBound(days: readonly string[], date: string): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] !== undefined && days[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ===== 真实回填（1 次真实调用）=====

export interface CalendarBackfillReport {
  adapterVersion: string;
  from: string;
  to: string;
  rowCount: number;
  calendarFacts: number;
  insertedFacts: number;
  identicalFacts: number;
  artifact: ArtifactRef;
}

/** 经适配器一次真实调用落日历事实（rows 含交易日与非交易日，全部映射为 TRADE_CALENDAR 事实）。 */
export async function backfillTradeCalendar(
  adapter: BaoStockAdapter,
  from: string,
  to: string,
): Promise<CalendarBackfillReport> {
  const result: FetchResult = await adapter.fetchTradeDates(from, to);
  return {
    adapterVersion: result.adapterVersion,
    from,
    to,
    rowCount: result.rowCount,
    calendarFacts: result.insertedFactIds.length + result.identicalFactIds.length,
    insertedFacts: result.insertedFactIds.length,
    identicalFacts: result.identicalFactIds.length,
    artifact: result.artifact,
  };
}

// ===== CLI（直接执行本文件时跑一次真实回填；被 import 时不执行）=====

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('adapters/calendar.ts');

if (isMain) {
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('./backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { BaoStockAdapter } = await import('./baostock.js');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new BaoStockAdapter({ pool, store: new ArtifactStore(artifactsDir) });
    const from = '2015-01-01';
    const to = new Date().toISOString().slice(0, 10);
    const report = await backfillTradeCalendar(adapter, from, to);
    const table = await loadTradeCalendarTable(pool);
    const { first, last } = calendarCoverage(table);
    console.log(JSON.stringify({
      result: 'CALENDAR BACKFILL OK',
      ...report,
      tableTradingDays: table.tradingDays.length,
      coverage: { first, last },
      realRequests: 1,
      declaredAdapterVersion: BAOSTOCK_ADAPTER_VERSION,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
