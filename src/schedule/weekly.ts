/**
 * Lyra · 滚动周度轮转（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §4（SC-4.1 每晚 6 只覆盖 30、SC-4.2 顺序固定可读回、
 * SC-4.3 节假日跨周补齐）与 §10.1/10.2（交易日历为排程基准、休市顺延）。
 *
 * 轮转顺序表 = 研究池顺序（文件顺序：stocks 后 etfs）× 周内第 n 个交易日的固定映射，
 * 顺序表随研究池版本冻结（poolVersion = data/research-pool.json 的 frozenAt）。
 * 纯函数：同一日期与池版本两次读回名单一致（SC-4.2 证伪）。
 */
import { tradingDaysBetween, type TradeCalendarTable } from '../adapters/calendar.js';
import type { SubjectKind } from '../contracts.js';
import { ScheduleError, shanghaiInstant, shanghaiWall, shanghaiWeekday } from './windows.js';

export const ROTATION_PER_NIGHT = 6; // SC-4.1
export const NIGHTS_PER_WEEK = 5; // SC-4.1

export interface RotationSubject {
  subjectKind: SubjectKind;
  subject: string;
}

/** 池文件的最小视图（顺序 = 文件顺序：先 stocks 后 etfs）。 */
export interface PoolOrderSource {
  frozenAt: string;
  stocks: readonly { code: string }[];
  etfs: readonly { code: string }[];
}

export interface RotationTable {
  /** 池版本（= frozenAt）；顺序表随池版本冻结（SC-4.2）。 */
  poolVersion: string;
  /** 全池顺序（30 个：26 个股 + 4 宽基，文件顺序）。 */
  order: readonly RotationSubject[];
  /** 周内第 n 个交易日 → 名单的固定映射（5 × 6）。 */
  buckets: readonly (readonly RotationSubject[])[];
}

/** 由池文件构建轮转顺序表：顺序 = 文件顺序（stocks 在前、etfs 在后），映射 = 第 n 交易日 → 第 (n−1)*6+1 .. n*6 只。 */
export function rotationTableFromPool(pool: PoolOrderSource): RotationTable {
  const order: RotationSubject[] = [
    ...pool.stocks.map((s) => ({ subjectKind: 'STOCK' as const, subject: s.code })),
    ...pool.etfs.map((e) => ({ subjectKind: 'BROAD_ETF' as const, subject: e.code })),
  ];
  if (order.length !== ROTATION_PER_NIGHT * NIGHTS_PER_WEEK) {
    throw new ScheduleError(
      'ROTATION_POOL_SIZE_INVALID',
      `研究池 ${String(order.length)} 只 ≠ 30（SC-4.1：个股 26 + 宽基 4，5 晚 × 6 只）`,
    );
  }
  const buckets: RotationSubject[][] = [];
  for (let n = 0; n < NIGHTS_PER_WEEK; n += 1) {
    buckets.push(order.slice(n * ROTATION_PER_NIGHT, (n + 1) * ROTATION_PER_NIGHT));
  }
  return { poolVersion: pool.frozenAt, order, buckets };
}

/** 周内第 nth 个交易日晚间应研名单（nth ∈ 1..5）。 */
export function nightSubjects(table: RotationTable, nth: number): readonly RotationSubject[] {
  if (!Number.isInteger(nth) || nth < 1 || nth > NIGHTS_PER_WEEK) {
    throw new ScheduleError('ROTATION_NIGHT_INVALID', `nth=${String(nth)}（须 1..${String(NIGHTS_PER_WEEK)}）`);
  }
  return table.buckets[nth - 1] as readonly RotationSubject[];
}

/** 任意给定标的查询"本周第几晚研"（SC-4.2 读回义务）；不在池内返回 null。 */
export function whichNight(table: RotationTable, subject: string): { nth: number; subjectKind: SubjectKind } | null {
  for (let n = 0; n < table.buckets.length; n += 1) {
    const bucket = table.buckets[n];
    if (bucket === undefined) continue;
    const hit = bucket.find((s) => s.subject === subject);
    if (hit !== undefined) return { nth: n + 1, subjectKind: hit.subjectKind };
  }
  return null;
}

/** 一个完整周（5 个交易日）的执行名单去重后应覆盖池内全部 30 只（SC-4.1 证伪的判定函数）。 */
export function fullWeekSubjects(table: RotationTable): readonly RotationSubject[] {
  return table.buckets.flat();
}

// ===== 周内排程与节假日跨周补齐（SC-4.3）=====

export interface WeekNightPlan {
  tradingDay: string;
  /** 周内第几个交易日（1 起）。 */
  nth: number;
  /** 当晚轮转名单（SC-4.2 固定映射）。 */
  rotation: RotationSubject[];
  /** 补齐条目（SC-4.3：排当晚队首——经 queue 层 WEEKLY_DEFERRED 类实现排队首）。 */
  catchUp: RotationSubject[];
}

export interface WeeklyNightPlanning {
  weekTradingDays: string[];
  nights: WeekNightPlan[];
  /** 本周实际研究名单（补齐 + 轮转去覆盖后；同标的一周至多一次）。 */
  studiedThisWeek: RotationSubject[];
  /** 因本周补齐已提前研究而让位的轮转条目（不重复研；具名登记可读回）。 */
  coveredByCatchUp: RotationSubject[];
  /** 未轮到而整体顺延至再下一周的名单（SC-4.3"整体顺延"；跨周堆积入周报，SC-8.1）。 */
  newLeftover: RotationSubject[];
}

/**
 * 一周排程（SC-4.1–4.3）：weekTradingDays = 本周（周一起）的交易日序列。
 * 交易日不足 5 个时，未轮到的名单整体顺延；上周遗留 leftover 自本周首几晚补齐，
 * 补齐条目排当晚队首（经 queue 层 WEEKLY_DEFERRED 类落实）。
 *
 * 同股碰撞消解（补齐优先）：补齐是排队首义务，轮转中同名标的本周已被补齐提前研究，
 * 该轮转条目让位（coveredByCatchUp 具名登记），不重复研、不浪费预算。
 *
 * 补齐分布（确定性）：chunk = ceil(leftover / 当周晚数)，自首晚起顺序装填（合同例：
 * 遗留 6 只、次周 5 晚 → 前 3 晚各 2 只补齐且排于轮转条目之前）。
 */
export function planWeeklyNights(
  table: RotationTable,
  weekTradingDays: readonly string[],
  leftoverFromPrevWeek: readonly RotationSubject[] = [],
): WeeklyNightPlanning {
  if (weekTradingDays.length > NIGHTS_PER_WEEK) {
    throw new ScheduleError('ROTATION_WEEK_INVALID', `一周交易日 ${String(weekTradingDays.length)} > 5`);
  }
  const nightsCount = weekTradingDays.length;
  const newLeftover: RotationSubject[] = [];

  if (nightsCount === 0) {
    return {
      weekTradingDays: [],
      nights: [],
      studiedThisWeek: [],
      coveredByCatchUp: [],
      newLeftover: [...leftoverFromPrevWeek, ...fullWeekSubjects(table)],
    };
  }

  // 遗留去重（跨周堆积可能重复）后按 chunk 均匀自首晚装填
  const dedupedLeftover: RotationSubject[] = [];
  const seenLeftover = new Set<string>();
  for (const s of leftoverFromPrevWeek) {
    if (seenLeftover.has(s.subject)) continue;
    seenLeftover.add(s.subject);
    dedupedLeftover.push(s);
  }
  const chunk = Math.max(1, Math.ceil(dedupedLeftover.length / nightsCount));
  const catchUpByNight: RotationSubject[][] = Array.from({ length: nightsCount }, () => []);
  let cursor = 0;
  for (let n = 0; n < nightsCount && cursor < dedupedLeftover.length; n += 1) {
    const target = catchUpByNight[n];
    if (target === undefined) break;
    for (let k = 0; k < chunk && cursor < dedupedLeftover.length; k += 1) {
      target.push(dedupedLeftover[cursor] as RotationSubject);
      cursor += 1;
    }
  }
  // 剩余未装填的 leftover（chunk 策略下理论不发生，防御性保留）
  while (cursor < dedupedLeftover.length) {
    newLeftover.push(dedupedLeftover[cursor] as RotationSubject);
    cursor += 1;
  }

  const nights: WeekNightPlan[] = [];
  const studied: RotationSubject[] = [];
  const coveredByCatchUp: RotationSubject[] = [];
  // 整周前瞻：本周全部补齐标的先入"已研"集合（无论落在哪一晚），轮转逐晚对照让位
  const studiedSubjects = new Set<string>();
  for (const list of catchUpByNight) {
    for (const s of list) studiedSubjects.add(s.subject);
  }
  for (let i = 0; i < nightsCount; i += 1) {
    const tradingDay = weekTradingDays[i];
    if (tradingDay === undefined) break;
    const catchUp = catchUpByNight[i] ?? [];
    // 轮转中已被本周补齐覆盖者让位（补齐优先，不重复研；coveredByCatchUp 具名登记）
    const rotation = nightSubjects(table, i + 1).filter((s) => {
      if (studiedSubjects.has(s.subject)) {
        coveredByCatchUp.push(s);
        return false;
      }
      return true;
    });
    for (const s of rotation) studiedSubjects.add(s.subject);
    nights.push({ tradingDay, nth: i + 1, rotation: [...rotation], catchUp: [...catchUp] });
    studied.push(...catchUp, ...rotation);
  }

  // 交易日不足 5：未轮到的桶整体顺延（SC-4.3）；已被本周补齐覆盖的标的不再顺延
  for (let n = nightsCount; n < NIGHTS_PER_WEEK; n += 1) {
    for (const s of nightSubjects(table, n + 1)) {
      if (!studiedSubjects.has(s.subject)) newLeftover.push(s);
    }
  }

  return { weekTradingDays: [...weekTradingDays], nights, studiedThisWeek: studied, coveredByCatchUp, newLeftover };
}

/** 所属自然周（周一至周日）内的全部交易日（SC-10.1 排程以交易日历为基准）。 */
export function weekTradingDaysOf(calendar: TradeCalendarTable, anyDayOfWeek: string): string[] {
  const weekday = shanghaiWeekday(anyDayOfWeek);
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  const monday = shanghaiWall(new Date(shanghaiInstant(anyDayOfWeek, '00:00:00').getTime() - mondayOffset * 86_400_000)).date;
  const sunday = shanghaiWall(new Date(shanghaiInstant(monday, '00:00:00').getTime() + 6 * 86_400_000)).date;
  return tradingDaysBetween(calendar, monday, sunday);
}
