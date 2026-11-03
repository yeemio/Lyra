/**
 * Lyra · 队列准入与优先级（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §5（SC-5.1–5.3）、§3.2（SC-3.2 合并）、§7（SC-7.1 准入时继承声明）、
 * §8（SC-8.1/8.4 预算守卫）、§9.3（SC-9.3 原件不可得阻断）、SC-4.1（宽基不进事件研究）。
 *
 * 调度只产出"该研究谁、什么窗口"的准入记录；执行（permit/send-once/模型调用）由 kernel 层消费，
 * 本模块不触碰 permit、不调组装器（派发冻结边界）。
 */
import { nextTradingDay, type TradeCalendarTable } from '../adapters/calendar.js';
import type { ResearchKind, SubjectKind } from '../contracts.js';
import { ScheduleError, shanghaiInstant, WEEKLY_OPEN } from './windows.js';

// ===== 队列类与优先级（SC-5.1）=====

/**
 * SC-5.1 优先级序：事件后 > 周度 > 事件前。
 * 同一晚周度队列内固定序：① 前日顺延的周度补齐 → ② 降级并入的事件后（SC-6.2）
 * → ③ 当日周度轮转（SC-4.2 顺序）→ ④ 当日事件前。priority 数值小者先。
 */
export type QueueClass = 'POST_EVENT' | 'WEEKLY_DEFERRED' | 'POST_EVENT_DEGRADED' | 'WEEKLY_ROTATION' | 'PRE_EVENT';

export const QUEUE_PRIORITY: Readonly<Record<QueueClass, number>> = {
  POST_EVENT: 0,
  WEEKLY_DEFERRED: 1,
  POST_EVENT_DEGRADED: 2,
  WEEKLY_ROTATION: 3,
  PRE_EVENT: 4,
};

export type AdmissionSource =
  | 'DETECTION' // SC-3.1 检测命中
  | 'WEEKLY_ROTATION' // SC-4.2 当晚轮转
  | 'WEEKLY_DEFERRED' // SC-4.3 补齐 / SC-5.3 顺延 / SC-9.3 原件次日并入
  | 'PRE_EVENT_SCHEDULED' // SC-3.6 主触发
  | 'PRE_EVENT_FALLBACK' // SC-3.6 兜底
  | 'POST_EVENT_DEGRADED' // SC-6.2 溢出降级
  | 'MATERIAL_RECOVERED'; // SC-9.3 原件次日取得

/** 准入记录（调度层对象；kernel 据此创建 permit，写回 started/sent 供顺延与合并判定）。 */
export interface AdmissionRecord {
  admissionId: string;
  queueClass: QueueClass;
  subjectKind: SubjectKind;
  subject: string;
  researchKind: ResearchKind;
  /** 资料截点（ISO）：事件后 = 触发公告发布时刻（SC-3.2）；周度 = 排程时刻（SC-3.4）。 */
  cutoff: string;
  firstQueuedAt: string;
  /** 检测命中时刻（SC-3.1 记录义务；事件类准入必填）。 */
  detectedAt: string | null;
  /** 触发公告/事件引用（SC-6.2 保留触发公告引用）。 */
  triggerEventIds: string[];
  /** 降级标注（SC-6.2 独立类别原文）等具名标注。 */
  annotation: string | null;
  source: AdmissionSource;
  /** 是否已启动（SC-3.2：已启动后新公告另立准入）。 */
  started: boolean;
  /** 是否已发送（SC-5.3：顺延仅适用从未发送者）。 */
  sent: boolean;
  notes: string[];
}

export function admissionIdOf(queueClass: QueueClass, subjectKind: SubjectKind, subject: string, cutoff: string): string {
  return `adm:${queueClass}:${subjectKind}:${subject}:${cutoff}`;
}

// ===== 事件后准入（SC-3.1/3.2、SC-4.1）=====

export interface PostEventDetectionHit {
  subject: string;
  subjectKind: SubjectKind;
  /** 触发公告发布时刻（= 资料截点，SC-3.2）。 */
  publishedAt: string;
  /** 检测命中时刻（SC-3.1 记录义务）。 */
  detectedAt: string;
  /** 触发公告/事件实例引用。 */
  triggerEventIds: string[];
}

/**
 * 检测命中 → 事件后准入记录。宽基 ETF 不进事件后研究（SC-4.1：公告检测与事件后/事件前只针对个股），
 * 具名拒绝不猜。截点 = 公告发布时刻；窗口边界由 windows.postEventWindowOf 按需计算。
 */
export function admitPostEvent(hit: PostEventDetectionHit, firstQueuedAt: string): AdmissionRecord {
  if (hit.subjectKind !== 'STOCK') {
    throw new ScheduleError(
      'POST_EVENT_ETF_NOT_ELIGIBLE',
      `宽基 ${hit.subject} 不进事件后研究（SC-4.1：公告检测与事件后/事件前研究只针对个股）`,
    );
  }
  const cutoff = new Date(hit.publishedAt);
  if (Number.isNaN(cutoff.getTime())) throw new ScheduleError('SCHEDULE_TIME_INVALID', `publishedAt=${hit.publishedAt}`);
  return {
    admissionId: admissionIdOf('POST_EVENT', hit.subjectKind, hit.subject, cutoff.toISOString()),
    queueClass: 'POST_EVENT',
    subjectKind: hit.subjectKind,
    subject: hit.subject,
    researchKind: 'POST_EVENT',
    cutoff: cutoff.toISOString(),
    firstQueuedAt,
    detectedAt: hit.detectedAt,
    triggerEventIds: [...hit.triggerEventIds],
    annotation: null,
    source: 'DETECTION',
    started: false,
    sent: false,
    notes: [],
  };
}

/**
 * SC-3.2 合并：同一股票同一事件窗内多份触发公告合并为一次研究——截点取最晚一份发布时刻，
 * 检测时刻保留最早一次（溢出早者优先的排序锚），触发引用并集。
 * 仅合并未启动者；已启动后又发布的公告按新截点另立准入（不合并，send-once 对不同键不拦）。
 */
export function mergePostEventAdmissions(records: readonly AdmissionRecord[]): AdmissionRecord[] {
  const out: AdmissionRecord[] = [];
  const bySubject = new Map<string, AdmissionRecord>();
  const order: string[] = [];
  for (const r of records) {
    if (r.queueClass !== 'POST_EVENT' || r.started) {
      out.push({ ...r, triggerEventIds: [...r.triggerEventIds], notes: [...r.notes] });
      continue;
    }
    const existing = bySubject.get(r.subject);
    if (existing === undefined) {
      const copy: AdmissionRecord = { ...r, triggerEventIds: [...r.triggerEventIds], notes: [...r.notes] };
      bySubject.set(r.subject, copy);
      order.push(r.subject);
      continue;
    }
    // 合并：截点取最晚发布时刻；detectedAt 保留最早；引用并集
    if (r.cutoff > existing.cutoff) existing.cutoff = r.cutoff;
    if ((r.detectedAt ?? '') < (existing.detectedAt ?? '')) existing.detectedAt = r.detectedAt;
    for (const id of r.triggerEventIds) {
      if (!existing.triggerEventIds.includes(id)) existing.triggerEventIds.push(id);
    }
    const note = `SC-3.2 合并：${r.admissionId} 并入（截点取最晚）`;
    if (!existing.notes.includes(note)) existing.notes.push(note);
  }
  const merged = order.map((s) => bySubject.get(s) as AdmissionRecord);
  // 合并后 id 按最终截点重算（幂等身份随截点收敛）
  for (const m of merged) {
    m.admissionId = admissionIdOf(m.queueClass, m.subjectKind, m.subject, m.cutoff);
  }
  return [...out, ...merged];
}

// ===== 优先级排序（SC-5.1）=====

/** 固定序排序：queueClass 优先级 → 首次入队时刻 → admissionId（确定性，同一输入两次读回一致）。 */
export function sortAdmissionQueue<T extends { queueClass: QueueClass; firstQueuedAt: string; admissionId: string }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => {
    const pa = QUEUE_PRIORITY[a.queueClass];
    const pb = QUEUE_PRIORITY[b.queueClass];
    if (pa !== pb) return pa - pb;
    if (a.firstQueuedAt !== b.firstQueuedAt) return a.firstQueuedAt < b.firstQueuedAt ? -1 : 1;
    return a.admissionId < b.admissionId ? -1 : 1;
  });
}

// ===== 预留名额（SC-5.2）=====

/** 在途视图（调用方从 permit 表取 state=SENT 的行；调度不直接读 permit）。 */
export interface InFlightView {
  researchKind: ResearchKind;
}

/** 周度类 = 除 POST_EVENT 外全部（WEEKLY、PRE_EVENT 并入周度预算；降级者次日以 WEEKLY 类型执行，SC-6.2）。 */
export function isWeeklyClass(researchKind: ResearchKind): boolean {
  return researchKind !== 'POST_EVENT';
}

export function weeklyInFlightCount(inFlight: readonly InFlightView[]): number {
  return inFlight.filter((p) => isWeeklyClass(p.researchKind)).length;
}

export interface ReservedSlotAssertion {
  violated: boolean;
  postEventPending: boolean;
  weeklyInFlight: number;
  weeklyLimit: 1;
}

/**
 * SC-5.2 预留名额断言：事件后队列非空（待研或在途）期间，周度类在途模型调用 ≤ 1。
 * 给定在途 permit 集（researchKind 视图）与事件后待研数即可断言是否违约。
 */
export function assertReservedSlot(input: {
  postEventPendingCount: number;
  inFlight: readonly InFlightView[];
}): ReservedSlotAssertion {
  const weekly = weeklyInFlightCount(input.inFlight);
  const pending = input.postEventPendingCount > 0;
  return { violated: pending && weekly > 1, postEventPending: pending, weeklyInFlight: weekly, weeklyLimit: 1 };
}

export type NextStartable<T> =
  | { none: false; entry: T }
  | { none: true; reason: 'QUEUE_EMPTY' | 'IN_FLIGHT_FULL' | 'WEEKLY_BLOCKED_BY_RESERVATION' };

/**
 * 下一个可启动条目：按 SC-5.1 固定序取首个满足并发与预留名额约束者。
 * 事件后可占满 2；事件后待研非空时周度类在途须 ≤ 1（SC-5.2 证伪：周度在途释放后下一个启动的是事件后）。
 */
export function nextStartable<T extends AdmissionRecord>(
  entries: readonly T[],
  inFlight: readonly InFlightView[],
  maxInFlight = 2,
): NextStartable<T> {
  const sorted = sortAdmissionQueue(entries.filter((e) => !e.started && !e.sent));
  if (sorted.length === 0) return { none: true, reason: 'QUEUE_EMPTY' };
  const total = inFlight.length;
  const weekly = weeklyInFlightCount(inFlight);
  const postEventPending = sorted.some((e) => e.queueClass === 'POST_EVENT');
  for (const e of sorted) {
    if (total >= maxInFlight) return { none: true, reason: 'IN_FLIGHT_FULL' };
    if (isWeeklyClass(e.researchKind)) {
      if (postEventPending && weekly >= 1) continue; // 预留名额被事件后占用
      return { none: false, entry: e };
    }
    return { none: false, entry: e };
  }
  return { none: true, reason: 'WEEKLY_BLOCKED_BY_RESERVATION' };
}

// ===== 周度顺延（SC-5.3）=====

export interface WeeklyDeferResult {
  /** 顺延至下一交易日队首的条目（从未发送者；class → WEEKLY_DEFERRED，SC-5.1 ①）。 */
  deferred: AdmissionRecord[];
  /** 已启动/已发送者：计入分母，不自动重研（SC-12.2 有界人工决策），不静默丢弃。 */
  keptInDenominator: AdmissionRecord[];
}

/**
 * SC-5.3 周度不跳过：因事件挤占或 22:00 截止而未启动的周度条目自动顺延至下一交易日队首；
 * 顺延仅适用从未发送（!sent 且未启动）者。无任何条目被静默丢弃。
 */
export function deferUnstartedWeekly(
  entries: readonly AdmissionRecord[],
  calendar: TradeCalendarTable,
  currentTradingDay: string,
  now: string,
): WeeklyDeferResult {
  const nextDay = nextTradingDay(calendar, currentTradingDay);
  const deferred: AdmissionRecord[] = [];
  const kept: AdmissionRecord[] = [];
  for (const e of entries) {
    const weeklyQueueMember =
      e.queueClass === 'WEEKLY_ROTATION' || e.queueClass === 'WEEKLY_DEFERRED' || e.queueClass === 'POST_EVENT_DEGRADED' || e.queueClass === 'PRE_EVENT';
    if (!weeklyQueueMember || e.sent || e.started) {
      kept.push(e);
      continue;
    }
    deferred.push({
      ...e,
      admissionId: admissionIdOf('WEEKLY_DEFERRED', e.subjectKind, e.subject, e.cutoff),
      queueClass: 'WEEKLY_DEFERRED',
      firstQueuedAt: e.firstQueuedAt,
      notes: [...e.notes, `SC-5.3 顺延：${currentTradingDay} 未启动，顺延至 ${nextDay} 队首`],
    });
  }
  return { deferred, keptInDenominator: kept };
}

// ===== 准入时继承声明（SC-7.1）=====

export interface CompletedWeeklyRef {
  subject: string;
  conclusionId: string;
  conclusionHash: string;
  completedAt: string;
}

export type InheritanceDeclaration =
  | { basis: 'INHERITED'; fromConclusionId: string; fromConclusionHash: string }
  | { basis: 'STANDALONE'; standaloneNote: '无基础结论可继承' };

/**
 * SC-7.1 继承判定（判定时机 = 准入时刻）：事件后研究优先继承本周该股最近一次已完成的周度结论；
 * 无可继承时标注 STANDALONE（标注原文见 RESEARCH-METHOD §7）。先验结论不构成自动选择。
 */
export function declarePostEventInheritance(
  subject: string,
  completedWeeklyThisWeek: readonly CompletedWeeklyRef[],
): InheritanceDeclaration {
  const mine = completedWeeklyThisWeek
    .filter((c) => c.subject === subject)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0));
  const latest = mine[0];
  if (latest === undefined) return { basis: 'STANDALONE', standaloneNote: '无基础结论可继承' };
  return { basis: 'INHERITED', fromConclusionId: latest.conclusionId, fromConclusionHash: latest.conclusionHash };
}

// ===== 触发公告原件不可得阻断（SC-9.3）=====

export interface BlockedAdmission {
  admissionId: string;
  subject: string;
  triggerEventIds: string[];
  blockedCode: 'MATERIAL_MISSING';
  blockedAt: string;
  /** 登记缺口清单、周报可见（SC-9.3 记录义务）。 */
  gapRegistered: true;
  weeklyReportVisible: true;
}

/** SC-9.3：检测命中但触发公告 PDF 原件未取得且退避重试穷尽 → 该事件后研究不启动，落具名阻断。 */
export function blockPostEventMaterialMissing(record: AdmissionRecord, blockedAt: string): BlockedAdmission {
  if (record.queueClass !== 'POST_EVENT') {
    throw new ScheduleError('BLOCK_TARGET_INVALID', `仅事件后准入可因原件缺失阻断（${record.admissionId} 为 ${record.queueClass}）`);
  }
  return {
    admissionId: record.admissionId,
    subject: record.subject,
    triggerEventIds: [...record.triggerEventIds],
    blockedCode: 'MATERIAL_MISSING',
    blockedAt,
    gapRegistered: true,
    weeklyReportVisible: true,
  };
}

/**
 * SC-9.3 恢复路径：原件次日取得且预算允许 → 按新截点并入次日周度队列（从未发送，属顺延不属补跑）。
 * 截点 = 并入日周度截点（18:00 起的排程时刻，SC-3.4/6.2 同口径）。
 */
export function materialRecoveredMerge(
  blocked: BlockedAdmission,
  calendar: TradeCalendarTable,
  recoveredAt: string,
): AdmissionRecord {
  const day = new Date(recoveredAt);
  if (Number.isNaN(day.getTime())) throw new ScheduleError('SCHEDULE_TIME_INVALID', `recoveredAt=${recoveredAt}`);
  const mergeDay = nextTradingDay(calendar, day.toISOString().slice(0, 10));
  const cutoff = shanghaiInstant(mergeDay, WEEKLY_OPEN).toISOString();
  return {
    admissionId: admissionIdOf('WEEKLY_DEFERRED', 'STOCK', blocked.subject, cutoff),
    queueClass: 'WEEKLY_DEFERRED',
    subjectKind: 'STOCK',
    subject: blocked.subject,
    researchKind: 'WEEKLY',
    cutoff,
    firstQueuedAt: day.toISOString(),
    detectedAt: null,
    triggerEventIds: [...blocked.triggerEventIds],
    annotation: null,
    source: 'MATERIAL_RECOVERED',
    started: false,
    sent: false,
    notes: [`SC-9.3：${blocked.admissionId} 原件于 ${recoveredAt} 取得，并入 ${mergeDay} 周度队列（顺延不属补跑）`],
  };
}

// ===== 调用量预算守卫（SC-8.1、SC-8.4）=====

export const WEEKLY_BASELINE_PER_WEEK = 60; // 30 只 × A+J
export const POST_EVENT_BASELINE_PER_WEEK = 10;

export type BudgetGuardOutcome =
  | {
      ok: true;
    }
  | {
      ok: false;
      scope: 'WEEKLY' | 'POST_EVENT';
      action: 'DEFER' | 'STOP_AND_PAUSE_REPORT';
      /** SC-8.4 超限统一纪律：不自动扩容、不自动降级模型档位；提额是人工授权动作（新授权版本）。 */
      noAutoScale: true;
      noModelDowngrade: true;
    };

/** 预算守卫：周度超限 → 顺延（SC-5.3，不扩容）；事件后达授权上限 → 停止自动启动 + 暂停上报（EK-7.3 四要素在 kernel 侧）。 */
export function budgetGuard(input: {
  weeklyUsed: number;
  postEventUsed: number;
  /** 常态周与财报季的事件上限分别登记于授权文件（SC-8.2），由调用方按当前授权版本注入。 */
  postEventAuthCap: number;
}): BudgetGuardOutcome {
  if (input.postEventUsed >= input.postEventAuthCap) {
    return { ok: false, scope: 'POST_EVENT', action: 'STOP_AND_PAUSE_REPORT', noAutoScale: true, noModelDowngrade: true };
  }
  if (input.weeklyUsed >= WEEKLY_BASELINE_PER_WEEK) {
    return { ok: false, scope: 'WEEKLY', action: 'DEFER', noAutoScale: true, noModelDowngrade: true };
  }
  return { ok: true };
}
