/**
 * Lyra · 事件后溢出判定与降级（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §6（SC-6.1 容量常数与判定时点、SC-6.2 降级处置、SC-6.3 财报季联动）。
 *
 * 冻结计划常数：晨窗容量 4（75 分钟窗 08:00–09:15 × 并发 2 ÷ 每对约 30–35 分钟 ≈ 4；
 * 常数不随运行时实测快慢浮动，不因财报季自动上调——上调走 PLAN 修订程序）。
 * 判定时点 = 每个交易日 08:00；超额者即时降级，不在窗口内等待重试。
 */
import { isTradingDay, nextTradingDay, type TradeCalendarTable } from '../adapters/calendar.js';
import type { AdmissionRecord } from './queue.js';
import { admissionIdOf } from './queue.js';
import { POST_EVENT_DEADLINE, ScheduleError, shanghaiInstant, shanghaiWall } from './windows.js';
import { postEventWindowOf } from './windows.js';

/** 晨窗容量（SC-6.1 冻结计划常数）。 */
export const MORNING_WINDOW_CAPACITY = 4;
/** 溢出判定时点（SC-6.1：每个交易日 08:00）。 */
export const MORNING_JUDGE_TIME = '08:00:00';

/** 财报季预期月（SC-6.3：4 月、8 月、10 月）。 */
export function isEarningsSeason(date: string): boolean {
  const month = Number(date.slice(5, 7));
  return month === 4 || month === 8 || month === 10;
}

export type PostEventCandidateState = 'UNSTARTED' | 'IN_FLIGHT' | 'COMPLETED';

/** 08:00 判定输入：归属当日 09:15 截止的事件后研究候选及其此刻状态。 */
export interface PostEventOverflowCandidate {
  admissionId: string;
  subject: string;
  /** 检测命中时刻（早者优先的排序锚，SC-6.1）。 */
  detectedAt: string;
  /** 触发公告发布时刻（归属日判定的窗口锚，SC-3.2）。 */
  publishedAt: string;
  state: PostEventCandidateState;
  triggerEventIds: string[];
}

export interface OverflowAdmitted {
  admissionId: string;
  subject: string;
  detectedAt: string;
}

/** SC-6.2 降级处置对象。 */
export interface OverflowDegraded {
  admissionId: string;
  subject: string;
  detectedAt: string;
  /** 原事件键截点（从未 SENT，无 send-once 冲突）。 */
  originalCutoff: string;
  triggerEventIds: string[];
  /** 并入的下一交易日（次日周度队列）。 */
  mergeIntoTradingDay: string;
  /** 次日以周度类型执行（EK-9.1）。 */
  executedAs: 'WEEKLY';
  /** 落库标注原文（复盘独立类别，EK-9.2）。 */
  annotation: '事件后研究未按最高优先窗完成';
  /** 降级者的继承判定仍按事件后研究语义（SC-7.1）。 */
  inheritanceBasis: 'POST_EVENT';
}

export interface OverflowJudgement {
  judgeDay: string;
  judgeAt: string;
  /** 冻结容量常数（SC-6.3：财报季也不上调）。 */
  capacity: typeof MORNING_WINDOW_CAPACITY;
  earningsSeason: boolean;
  belongingCount: number;
  inFlight: number;
  unstartedCount: number;
  canStartNew: number;
  admitted: OverflowAdmitted[];
  degraded: OverflowDegraded[];
}

/**
 * SC-6.1 溢出判定（每个交易日 08:00 执行）：
 * 归属当日 09:15 截止、尚未启动者可新启动数 = 4 − 此刻在途数；
 * 未启动数超过可新启动数时，按检测命中时刻早者优先取前 N 只进窗，其余即时降级。
 * 归属判定按候选自身的窗口锚（publishedAt → 次日 09:15）计算，不信任调用方传入的归属日。
 */
export function judgePostEventOverflow(
  calendar: TradeCalendarTable,
  judgeAt: Date,
  candidates: readonly PostEventOverflowCandidate[],
): OverflowJudgement {
  const wall = shanghaiWall(judgeAt);
  if (!isTradingDay(calendar, wall.date)) {
    throw new ScheduleError('OVERFLOW_JUDGE_TIME_INVALID', `${wall.date} 非交易日，溢出判定只在交易日 08:00 执行`);
  }
  if (wall.hh !== 8 || wall.mm !== 0) {
    throw new ScheduleError('OVERFLOW_JUDGE_TIME_INVALID', `判定时点须为交易日 08:00（收到 ${wall.date}T${wall.time}）`);
  }
  const judgeDay = wall.date;
  const deadlineOfDay = shanghaiInstant(judgeDay, POST_EVENT_DEADLINE).toISOString();

  const belonging = candidates.filter((c) => {
    try {
      return postEventWindowOf(calendar, c.publishedAt).deadline === deadlineOfDay;
    } catch {
      return false; // 窗口锚不可解析（界外等）：不属本日判定，不猜
    }
  });
  const inFlight = belonging.filter((c) => c.state === 'IN_FLIGHT').length;
  const unstarted = belonging
    .filter((c) => c.state === 'UNSTARTED')
    .sort((a, b) => (a.detectedAt !== b.detectedAt ? (a.detectedAt < b.detectedAt ? -1 : 1) : a.admissionId < b.admissionId ? -1 : 1));
  const canStartNew = Math.max(0, MORNING_WINDOW_CAPACITY - inFlight);

  const admitted: OverflowAdmitted[] = unstarted.slice(0, canStartNew).map((c) => ({
    admissionId: c.admissionId,
    subject: c.subject,
    detectedAt: c.detectedAt,
  }));

  const mergeDay = nextTradingDay(calendar, judgeDay);
  const degraded: OverflowDegraded[] = unstarted.slice(canStartNew).map((c) => ({
    admissionId: c.admissionId,
    subject: c.subject,
    detectedAt: c.detectedAt,
    originalCutoff: postEventWindowOf(calendar, c.publishedAt).publishedAt,
    triggerEventIds: [...c.triggerEventIds],
    mergeIntoTradingDay: mergeDay,
    executedAs: 'WEEKLY',
    annotation: '事件后研究未按最高优先窗完成',
    inheritanceBasis: 'POST_EVENT',
  }));

  return {
    judgeDay,
    judgeAt: judgeAt.toISOString(),
    capacity: MORNING_WINDOW_CAPACITY,
    earningsSeason: isEarningsSeason(judgeDay),
    belongingCount: belonging.length,
    inFlight,
    unstartedCount: unstarted.length,
    canStartNew,
    admitted,
    degraded,
  };
}

/**
 * 降级对象 → 次日周度队列准入（SC-5.1 ②、SC-6.2）：
 * 截点更新为并入日周度截点（18:00 起排程时刻），以 WEEKLY 类型执行，保留触发公告引用与降级标注原文。
 */
export function degradedToAdmissionRecord(degraded: OverflowDegraded, now: string): AdmissionRecord {
  const cutoff = shanghaiInstant(degraded.mergeIntoTradingDay, '18:00:00').toISOString();
  return {
    admissionId: admissionIdOf('POST_EVENT_DEGRADED', 'STOCK', degraded.subject, cutoff),
    queueClass: 'POST_EVENT_DEGRADED',
    subjectKind: 'STOCK',
    subject: degraded.subject,
    researchKind: 'WEEKLY',
    cutoff,
    firstQueuedAt: now,
    detectedAt: degraded.detectedAt,
    triggerEventIds: [...degraded.triggerEventIds],
    annotation: degraded.annotation,
    source: 'POST_EVENT_DEGRADED',
    started: false,
    sent: false,
    notes: [
      `SC-6.2 降级：原事件后准入 ${degraded.admissionId}（原截点 ${degraded.originalCutoff}，检测命中 ${degraded.detectedAt}）并入 ${degraded.mergeIntoTradingDay} 周度队列；继承判定仍按事件后研究语义（SC-7.1）`,
    ],
  };
}
