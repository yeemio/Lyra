/**
 * Lyra · 四时段窗口判定（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §2–§4、§10（SC-2 总表、SC-3.1–3.7、SC-4.3 联动、SC-10.1–10.3）。
 *
 * 纯函数：交易日历注入（src/adapters/calendar.ts 的 TradeCalendarTable）、时钟注入（调用方传 Date），
 * 本模块不读系统时钟、不碰网络、不碰 DB。口径约定：
 * - 时区一律 Asia/Shanghai 固定 +08:00（A 股无夏令时），时刻比较用绝对毫秒；
 * - "次日"一律指下一个交易日（SC-2 术语约定；周末/节假日公告的次日 09:15 = 下一交易日 09:15）；
 * - 事件后窗口锚定触发公告的发布时刻（SC-3.2 资料截点 = 发布时刻），检测时刻只作记录（SC-3.1）；
 * - 时钟校准（SC-10.3）：本地时钟 + 交易日历校准，漂移容忍 ±60 秒；超容忍只允许让截止提前（保守方向）。
 */
import {
  isTradingDay,
  lastTradingDayOnOrBefore,
  nextTradingDay,
  tradingDaysBetween,
  type TradeCalendarTable,
} from '../adapters/calendar.js';

/** 调度具名错误（code 为稳定错误名，供旅程测试与验收断言）。 */
export class ScheduleError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ScheduleError';
  }
}

// ===== 上海墙钟（固定 +08:00）=====

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

export interface ShanghaiWall {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0=周日 … 6=周六
  minutesOfDay: number;
}

/** 时刻 → 上海墙钟分量（纯换算，无 DST）。 */
export function shanghaiWall(now: Date): ShanghaiWall {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const iso = shifted.toISOString();
  const hh = Number(iso.slice(11, 13));
  const mm = Number(iso.slice(14, 16));
  const ss = Number(iso.slice(17, 19));
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    hh,
    mm,
    ss,
    weekday: shifted.getUTCDay(),
    minutesOfDay: hh * 60 + mm,
  };
}

/** 上海日期 + 时刻 → 绝对时刻。 */
export function shanghaiInstant(date: string, time = '00:00:00'): Date {
  if (!DATE_RE.test(date)) throw new ScheduleError('SCHEDULE_DATE_INVALID', `date=${date}`);
  if (!TIME_RE.test(time)) throw new ScheduleError('SCHEDULE_TIME_INVALID', `time=${time}`);
  const at = new Date(`${date}T${time}+08:00`);
  if (Number.isNaN(at.getTime())) throw new ScheduleError('SCHEDULE_DATE_INVALID', `${date}T${time}`);
  return at;
}

/** 上海日期的星期（0=周日 … 6=周六）。 */
export function shanghaiWeekday(date: string): number {
  return shanghaiInstant(date, '12:00:00').getUTCDay();
}

function toDate(value: string | Date, field: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ScheduleError('SCHEDULE_TIME_INVALID', `${field}=${String(value)}`);
  return d;
}

// ===== 冻结窗口常量（SC-2 总表；变更须走 PLAN 修订程序）=====

export const POST_EVENT_LATEST_START = '08:00:00'; // SC-3.3 次日 08:00
export const POST_EVENT_DEADLINE = '09:15:00'; // SC-3.3 次日 09:15（集合竞价开始）
export const WEEKLY_OPEN = '18:00:00'; // SC-3.4 每个交易日 18:00 之后
export const WEEKLY_LATEST_START = '22:00:00'; // SC-3.5
export const WEEKLY_DEADLINE = '23:30:00'; // SC-3.5
export const PRE_EVENT_FALLBACK_TRADING_DAYS = 5; // SC-3.6 法定截止日前 5 个交易日（兜底）
export const CLOCK_TOLERANCE_MS = 60_000; // SC-10.3 漂移容忍 ±60 秒

// ===== 事件后研究窗口（SC-3.1–3.3、SC-10.2）=====

export interface PostEventWindow {
  /** 窗口锚点 = 触发公告发布时刻（SC-3.2 截点同源）。 */
  publishedAt: string;
  publishedDay: string;
  publishedOnTradingDay: boolean;
  /** 次日（下一交易日，SC-2 术语）。 */
  nextTradingDay: string;
  /** 最晚启动：次日 08:00（SC-3.3）。 */
  latestStart: string;
  /** 完成截止：次日 09:15（写入 permit 的取值来源，EK-6.1）。 */
  deadline: string;
}

/** 事件后研究窗口：锚定公告发布时刻；非交易日发布亦允许（SC-3.3），截止仍解析到下一交易日 09:15（SC-10.2）。 */
export function postEventWindowOf(calendar: TradeCalendarTable, publishedAt: string | Date): PostEventWindow {
  const at = toDate(publishedAt, 'publishedAt');
  const wall = shanghaiWall(at);
  const nextTd = nextTradingDay(calendar, wall.date);
  return {
    publishedAt: at.toISOString(),
    publishedDay: wall.date,
    publishedOnTradingDay: isTradingDay(calendar, wall.date),
    nextTradingDay: nextTd,
    latestStart: shanghaiInstant(nextTd, POST_EVENT_LATEST_START).toISOString(),
    deadline: shanghaiInstant(nextTd, POST_EVENT_DEADLINE).toISOString(),
  };
}

export type PostEventStartCheck =
  | { allowed: true; latestStart: string; deadline: string }
  | { allowed: false; code: 'POST_EVENT_START_LATE' | 'NOW_BEFORE_EVENT'; latestStart: string; deadline: string };

/** 事件后启动闸（SC-3.3）：检测命中后即可启动（含非交易日夜间提前研），不晚于次日 08:00；之后新启动具名拒绝。 */
export function canStartPostEvent(
  calendar: TradeCalendarTable,
  publishedAt: string | Date,
  now: Date,
): PostEventStartCheck {
  const at = toDate(publishedAt, 'publishedAt');
  const w = postEventWindowOf(calendar, at);
  const base = { latestStart: w.latestStart, deadline: w.deadline };
  if (now.getTime() < at.getTime()) return { allowed: false, code: 'NOW_BEFORE_EVENT', ...base };
  if (now.getTime() <= new Date(w.latestStart).getTime()) return { allowed: true, ...base };
  return { allowed: false, code: 'POST_EVENT_START_LATE', ...base };
}

// ===== 公告检测节拍（SC-3.1）=====

export const DETECTION_EVENING_START = '15:30:00';
export const DETECTION_EVENING_END = '23:00:00';
export const DETECTION_SLOT_MINUTES = 30;
export const DETECTION_MORNING_FROM = '07:00:00'; // 次日 07:00–08:00 增补一次检测
export const DETECTION_MORNING_TO = '08:00:00';

/** 晚间检测槽位（每个日历日同一组；非交易日同样检测，SC-2 术语约定）。 */
export function eveningDetectionSlots(): string[] {
  const out: string[] = [];
  const start = 15 * 60 + 30;
  const end = 23 * 60;
  for (let m = start; m <= end; m += DETECTION_SLOT_MINUTES) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
  }
  return out;
}

export interface DetectionCadence {
  /** 晚间窗口 15:30–23:00（含端点，任意日历日）。 */
  withinEvening: boolean;
  /** 次日晨间增补窗 07:00–08:00（左闭右开）。 */
  withinMorningSupplement: boolean;
  /** 命中的晚间槽位（HH:MM:00）；不在晚间窗口时为 null。 */
  slot: string | null;
}

/** 检测时刻的节拍归属（SC-3.1 证伪基础：22:45 属晚间窗口、07:20 属次日增补窗，均产生准入并记录检测时刻）。秒级边界：晚间窗口含 23:00:00 整点。 */
export function detectionCadenceOf(detectedAt: string | Date): DetectionCadence {
  const wall = shanghaiWall(toDate(detectedAt, 'detectedAt'));
  const seconds = wall.hh * 3600 + wall.mm * 60 + wall.ss;
  const eveningStart = 15 * 3600 + 30 * 60;
  const eveningEnd = 23 * 3600;
  const withinEvening = seconds >= eveningStart && seconds <= eveningEnd;
  const morningFrom = 7 * 3600;
  const morningTo = 8 * 3600;
  const withinMorning = seconds >= morningFrom && seconds < morningTo;
  let slot: string | null = null;
  if (withinEvening) {
    const slotSecond = Math.floor((seconds - eveningStart) / (DETECTION_SLOT_MINUTES * 60)) * DETECTION_SLOT_MINUTES * 60 + eveningStart;
    const slotMinute = Math.floor(slotSecond / 60);
    slot = `${String(Math.floor(slotMinute / 60)).padStart(2, '0')}:${String(slotMinute % 60).padStart(2, '0')}:00`;
  }
  return { withinEvening, withinMorningSupplement: withinMorning, slot };
}

// ===== 周度研究窗口（SC-3.4、SC-3.5）=====

export interface WeeklyWindow {
  tradingDay: string;
  open: string; // 18:00
  cutoffLatest: string; // 准入排程时刻上界 22:00（SC-3.4 证伪：截点必须落在交易日 18:00–22:00 内）
  latestStart: string; // 22:00
  deadline: string; // 23:30
}

/** 周度窗口边界（tradingDay 须为交易日，由调用方保证或经 weeklyAdmissionAt 校验）。 */
export function weeklyWindowOf(tradingDay: string): WeeklyWindow {
  return {
    tradingDay,
    open: shanghaiInstant(tradingDay, WEEKLY_OPEN).toISOString(),
    cutoffLatest: shanghaiInstant(tradingDay, WEEKLY_LATEST_START).toISOString(),
    latestStart: shanghaiInstant(tradingDay, WEEKLY_LATEST_START).toISOString(),
    deadline: shanghaiInstant(tradingDay, WEEKLY_DEADLINE).toISOString(),
  };
}

export type WeeklyAdmission =
  | { open: true; tradingDay: string; cutoff: string } // cutoff = 准入排程时刻（SC-3.4）
  | { open: false; code: 'NOT_TRADING_DAY' | 'BEFORE_OPEN' | 'AFTER_ADMISSION' };

/** 周度准入判定（SC-3.4）：交易日 18:00 ≤ now < 22:00 产生当晚队列，资料截点 = 排程时刻；节假日/休市日不开放（SC-10.1/10.2）。 */
export function weeklyAdmissionAt(calendar: TradeCalendarTable, now: Date): WeeklyAdmission {
  const wall = shanghaiWall(now);
  if (!isTradingDay(calendar, wall.date)) return { open: false, code: 'NOT_TRADING_DAY' };
  const w = weeklyWindowOf(wall.date);
  const t = now.getTime();
  if (t < new Date(w.open).getTime()) return { open: false, code: 'BEFORE_OPEN' };
  if (t >= new Date(w.cutoffLatest).getTime()) return { open: false, code: 'AFTER_ADMISSION' };
  return { open: true, tradingDay: wall.date, cutoff: now.toISOString() };
}

export type WeeklyStartCheck =
  | { allowed: true; deadline: string }
  | { allowed: false; code: 'WEEKLY_START_LATE' | 'NOT_TRADING_DAY' | 'BEFORE_OPEN'; deadline: string };

/** 周度启动闸（SC-3.5）：21:59 合法、22:01 新启动具名拒绝；22:00 前未启动者转顺延（SC-5.3，处置在 queue 层）。 */
export function weeklyCanStartAt(calendar: TradeCalendarTable, now: Date): WeeklyStartCheck {
  const wall = shanghaiWall(now);
  if (!isTradingDay(calendar, wall.date)) return { allowed: false, code: 'NOT_TRADING_DAY', deadline: shanghaiInstant(nextTradingDay(calendar, wall.date), WEEKLY_DEADLINE).toISOString() };
  const w = weeklyWindowOf(wall.date);
  if (now.getTime() < new Date(w.open).getTime()) return { allowed: false, code: 'BEFORE_OPEN', deadline: w.deadline };
  if (now.getTime() <= new Date(w.latestStart).getTime()) return { allowed: true, deadline: w.deadline };
  return { allowed: false, code: 'WEEKLY_START_LATE', deadline: w.deadline };
}

// ===== 事件前研究触发（SC-3.6、SC-3.7）=====

/** 兜底触发日判定：day 为法定截止日前第 5 个交易日（day 之后、截止日止恰有 5 个交易日）。 */
export function isFifthTradingDayBefore(calendar: TradeCalendarTable, day: string, statutoryDeadline: string): boolean {
  if (!isTradingDay(calendar, day)) return false;
  const span = tradingDaysBetween(calendar, day, statutoryDeadline); // 闭区间，含 day
  return span.length - 1 === PRE_EVENT_FALLBACK_TRADING_DAYS;
}

/** 事件前"同一报告期至多触发一次"（SC-3.6）的去重键。 */
export function preEventDedupeKey(subject: string, reportPeriod: string): string {
  return `pre:${subject}:${reportPeriod}`;
}

export interface PreEventAssessmentInput {
  calendar: TradeCalendarTable;
  /** 今晚所属交易日。 */
  tradingDay: string;
  subject: string;
  /** 交易所预约披露日（按当时已知最新版本 as-of 读取，ASHARE-RULES §8）；无预约记录为 null。 */
  scheduledDate: string | null;
  /** 法定截止日。 */
  statutoryDeadline: string;
  /** 截至今晚该报告期实际披露是否已发生（含今晚披露）。 */
  disclosed: boolean;
}

export type PreEventTrigger =
  | { trigger: 'SCHEDULED'; scheduledDate: string }
  | { trigger: 'DEADLINE_FALLBACK'; reason: 'NO_SCHEDULE' | 'SCHEDULE_PASSED_NOT_DISCLOSED'; statutoryDeadline: string }
  | {
      trigger: 'NONE';
      reason:
        | 'NOT_SCHEDULED_DAY' // 非预约日且未到兜底日
        | 'SCHEDULE_IN_FUTURE' // 预约日在未来：主触发按预约日走，兜底不启用
        | 'DISCLOSED_AS_OF_TONIGHT' // 已披露：事件检测捕获后按事件后研究处理（SC-3.7）
        | 'FALLBACK_NOT_DUE'; // 到达预约日之外的普通日
    };

/**
 * 事件前触发判定（SC-3.6）：主触发 = 预约披露日当日；兜底 = 法定截止日前 5 个交易日，
 * 仅当主触发未发生（无预约记录，或预约日已过仍未披露）时启用。
 */
export function assessPreEventTrigger(input: PreEventAssessmentInput): PreEventTrigger {
  const { calendar, tradingDay, scheduledDate, statutoryDeadline, disclosed } = input;
  if (!isTradingDay(calendar, tradingDay)) {
    throw new ScheduleError('SCHEDULE_NOT_TRADING_DAY', `tradingDay=${tradingDay}`);
  }
  if (disclosed) return { trigger: 'NONE', reason: 'DISCLOSED_AS_OF_TONIGHT' };
  if (scheduledDate === tradingDay) return { trigger: 'SCHEDULED', scheduledDate };
  if (scheduledDate !== null && scheduledDate > tradingDay) {
    return { trigger: 'NONE', reason: 'SCHEDULE_IN_FUTURE' };
  }
  const fifth = isFifthTradingDayBefore(calendar, tradingDay, statutoryDeadline);
  if (scheduledDate === null) {
    return fifth
      ? { trigger: 'DEADLINE_FALLBACK', reason: 'NO_SCHEDULE', statutoryDeadline }
      : { trigger: 'NONE', reason: 'NOT_SCHEDULED_DAY' };
  }
  // 预约日已过仍未披露 → 兜底（若恰在兜底日）
  return fifth
    ? { trigger: 'DEADLINE_FALLBACK', reason: 'SCHEDULE_PASSED_NOT_DISCLOSED', statutoryDeadline }
    : { trigger: 'NONE', reason: 'FALLBACK_NOT_DUE' };
}

export interface PostEventCaptureRef {
  subject: string;
  /** 事件后准入的检测命中时刻。 */
  detectedAt: string;
}

export type PreEventDedupe =
  | { action: 'KEEP' }
  | { action: 'REVOKE'; reason: 'DISCLOSED_AND_CAPTURED_BY_POST_EVENT'; capturedByDetectedAt: string };

/**
 * 事件前 vs 事件后去重（SC-3.7）：触发日当晚实际披露已发生并被事件检测捕获（存在同股、
 * 检测时刻落在当晚的事件后准入）→ 事件前准入撤销，同一公告不产生两份研究。
 */
export function dedupePreEventVsPostEvent(
  preEvent: { subject: string; tradingDay: string },
  postEventCaptures: readonly PostEventCaptureRef[],
): PreEventDedupe {
  for (const cap of postEventCaptures) {
    if (cap.subject !== preEvent.subject) continue;
    if (shanghaiWall(toDate(cap.detectedAt, 'detectedAt')).date === preEvent.tradingDay) {
      return { action: 'REVOKE', reason: 'DISCLOSED_AND_CAPTURED_BY_POST_EVENT', capturedByDetectedAt: cap.detectedAt };
    }
  }
  return { action: 'KEEP' };
}

// ===== 周末复盘窗口（§3.4、§11）=====

export interface WeekendWindow {
  isReviewDay: boolean;
  saturday: string | null;
  /** 资料截点 = 周五收盘；周五非交易日时取其前最近交易日收盘（休市顺延精神，SC-10.2）。 */
  cutoffDay: string | null;
}

/** 周末复盘窗口判定：触发周六（weekday=6），截点为周五（或其前最近交易日）收盘。 */
export function weekendReviewWindow(calendar: TradeCalendarTable, now: Date): WeekendWindow {
  const wall = shanghaiWall(now);
  return weekendReviewWindowForDate(calendar, wall.date);
}

export function weekendReviewWindowForDate(calendar: TradeCalendarTable, date: string): WeekendWindow {
  if (!DATE_RE.test(date)) throw new ScheduleError('SCHEDULE_DATE_INVALID', `date=${date}`);
  if (shanghaiWeekday(date) !== 6) return { isReviewDay: false, saturday: null, cutoffDay: null };
  const friday = shanghaiWall(new Date(shanghaiInstant(date, '00:00:00').getTime() - 86_400_000)).date;
  return { isReviewDay: true, saturday: date, cutoffDay: lastTradingDayOnOrBefore(calendar, friday) };
}

// ===== 时钟与漂移容忍（SC-10.3）=====

export interface ClockCalibration {
  /** offsetMs = 本地时钟 − 校准源（正 = 本地快）。 */
  offsetMs: number;
  withinTolerance: boolean;
  warning: string | null;
  recordedAt: string;
  /** 截止比较方向的修正量（毫秒，仅负值/零：只允许让截止提前）。 */
  comparisonAdjustmentMs: number;
}

/**
 * 记录一次校准（SC-10.3）：偏差 ≤ 60 秒照常；> 60 秒记录并告警，当日排程不中止（不抛错）。
 */
export function recordCalibration(now: Date, offsetMs: number): ClockCalibration {
  const within = Math.abs(offsetMs) <= CLOCK_TOLERANCE_MS;
  const adjust = offsetMs > CLOCK_TOLERANCE_MS ? -offsetMs : 0;
  return {
    offsetMs,
    withinTolerance: within,
    warning: within ? null : `CLOCK_DRIFT_EXCEEDED:${offsetMs > 0 ? 'FAST' : 'SLOW'}:${String(offsetMs)}ms`,
    recordedAt: now.toISOString(),
    comparisonAdjustmentMs: adjust,
  };
}

/**
 * 截止比较时刻（SC-10.3）：截止判定使用本地时钟；已知偏差超容忍且本地偏快时，
 * 比较值按"本地时钟 − 偏差"方向修正（只允许让截止提前，保守方向），不延后。
 */
export function deadlineComparisonInstant(now: Date, offsetMs: number): Date {
  return offsetMs > CLOCK_TOLERANCE_MS ? new Date(now.getTime() - offsetMs) : now;
}

/** 截止是否已到（用修正后的比较时刻判定）。 */
export function deadlineExceeded(now: Date, deadline: string | Date, offsetMs = 0): boolean {
  const dl = toDate(deadline, 'deadline');
  return deadlineComparisonInstant(now, offsetMs).getTime() > dl.getTime();
}
