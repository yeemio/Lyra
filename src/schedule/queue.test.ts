/**
 * Lyra · 队列准入与优先级单测（P3 W17: code-writer-pro）。纯函数，日历/时钟注入。
 * 合同判定：SCHEDULING.md SC-3.1（检测时刻记录）、SC-3.2（同股合并/另立）、SC-4.1（宽基不进事件研究）、
 * SC-5.1（固定序）、SC-5.2（预留名额）、SC-5.3（周度顺延不跳过）、SC-7.1（准入时继承声明）、
 * SC-8.1/8.4（预算守卫）、SC-9.3（原件缺失阻断与次日并入）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTradeCalendarTable } from '../adapters/calendar.js';
import type { AdmissionRecord, QueueClass } from './queue.js';
import {
  admissionIdOf,
  admitPostEvent,
  assertReservedSlot,
  blockPostEventMaterialMissing,
  budgetGuard,
  declarePostEventInheritance,
  deferUnstartedWeekly,
  materialRecoveredMerge,
  mergePostEventAdmissions,
  nextStartable,
  QUEUE_PRIORITY,
  sortAdmissionQueue,
} from './queue.js';
import { ScheduleError, shanghaiInstant } from './windows.js';

const CAL = buildTradeCalendarTable(
  ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
    .map((d) => ({ calendar_date: d, is_trading_day: '1' })),
);

const at = (date: string, time: string): string => shanghaiInstant(date, time).toISOString();

function weeklyEntry(subject: string, queueClass: QueueClass, cutoff: string, extra?: Partial<AdmissionRecord>): AdmissionRecord {
  return {
    admissionId: admissionIdOf(queueClass, 'STOCK', subject, cutoff),
    queueClass,
    subjectKind: 'STOCK',
    subject,
    researchKind: queueClass === 'POST_EVENT' ? 'POST_EVENT' : queueClass === 'PRE_EVENT' ? 'PRE_EVENT' : 'WEEKLY',
    cutoff,
    firstQueuedAt: cutoff,
    detectedAt: null,
    triggerEventIds: [],
    annotation: null,
    source: queueClass === 'WEEKLY_DEFERRED' ? 'WEEKLY_DEFERRED' : queueClass === 'WEEKLY_ROTATION' ? 'WEEKLY_ROTATION' : 'PRE_EVENT_FALLBACK',
    started: false,
    sent: false,
    notes: [],
    ...extra,
  };
}

// ===== SC-3.1 检测命中 → 准入记录（记录检测时刻）=====

test('SC-3.1 证伪：22:45 与次日 07:20 两条公告均有准入记录且记录了检测时刻', () => {
  const a = admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '22:40:00'), detectedAt: at('2026-10-08', '22:45:00'), triggerEventIds: ['evt:1'] }, at('2026-10-08', '22:45:00'));
  const b = admitPostEvent({ subject: '000938', subjectKind: 'STOCK', publishedAt: at('2026-10-09', '07:10:00'), detectedAt: at('2026-10-09', '07:20:00'), triggerEventIds: ['evt:2'] }, at('2026-10-09', '07:20:00'));
  assert.equal(a.detectedAt, at('2026-10-08', '22:45:00'));
  assert.equal(a.cutoff, at('2026-10-08', '22:40:00')); // 截点 = 发布时刻（SC-3.2）
  assert.equal(b.detectedAt, at('2026-10-09', '07:20:00'));
  assert.equal(a.queueClass, 'POST_EVENT');
  assert.equal(a.researchKind, 'POST_EVENT');
});

// ===== SC-4.1 宽基不进事件后研究 =====

test('SC-4.1：宽基 ETF 事件后准入具名拒绝', () => {
  assert.throws(
    () => admitPostEvent({ subject: '510300', subjectKind: 'BROAD_ETF', publishedAt: at('2026-10-08', '20:00:00'), detectedAt: at('2026-10-08', '20:05:00'), triggerEventIds: [] }, at('2026-10-08', '20:05:00')),
    (e: unknown) => e instanceof ScheduleError && e.code === 'POST_EVENT_ETF_NOT_ELIGIBLE',
  );
});

// ===== SC-3.2 同股合并 / 已启动另立 =====

test('SC-3.2 证伪：同股两份公告 16:00 与 21:30 → 仅一个未启动键且截点 = 21:30', () => {
  const r1 = admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '16:00:00'), detectedAt: at('2026-10-08', '16:00:00'), triggerEventIds: ['evt:a'] }, at('2026-10-08', '16:00:00'));
  const r2 = admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '21:30:00'), detectedAt: at('2026-10-08', '21:30:00'), triggerEventIds: ['evt:b'] }, at('2026-10-08', '21:30:00'));
  const merged = mergePostEventAdmissions([r1, r2]);
  const mine = merged.filter((m) => m.subject === '600519');
  assert.equal(mine.length, 1);
  const m = mine[0] as AdmissionRecord;
  assert.equal(m.cutoff, at('2026-10-08', '21:30:00'));
  assert.equal(m.detectedAt, at('2026-10-08', '16:00:00')); // 检测时刻保留最早（溢出早者优先锚）
  assert.deepEqual(m.triggerEventIds, ['evt:a', 'evt:b']);
  assert.equal(m.admissionId, admissionIdOf('POST_EVENT', 'STOCK', '600519', m.cutoff));
});

test('SC-3.2：研究已启动后又发布的公告按新截点另立准入（不合并）', () => {
  const started: AdmissionRecord = {
    ...admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '16:00:00'), detectedAt: at('2026-10-08', '16:00:00'), triggerEventIds: ['evt:a'] }, at('2026-10-08', '16:00:00')),
    started: true,
    sent: true,
  };
  const fresh = admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '21:30:00'), detectedAt: at('2026-10-08', '21:30:00'), triggerEventIds: ['evt:b'] }, at('2026-10-08', '21:30:00'));
  const merged = mergePostEventAdmissions([started, fresh]);
  assert.equal(merged.filter((m) => m.subject === '600519').length, 2);
});

// ===== SC-5.1 优先级序 =====

test('SC-5.1 证伪：四类条目同时在场时顺序 = 事件后 → ①顺延补齐 → ②降级并入 → ③当日轮转 → ④事件前', () => {
  const cutoff = at('2026-10-12', '18:30:00');
  const entries: AdmissionRecord[] = [
    weeklyEntry('600183', 'WEEKLY_ROTATION', cutoff),
    weeklyEntry('000977', 'PRE_EVENT', cutoff),
    weeklyEntry('002384', 'POST_EVENT_DEGRADED', cutoff),
    admitPostEvent({ subject: '603986', subjectKind: 'STOCK', publishedAt: at('2026-10-09', '20:00:00'), detectedAt: at('2026-10-09', '20:00:00'), triggerEventIds: ['evt:x'] }, cutoff),
    weeklyEntry('600176', 'WEEKLY_DEFERRED', cutoff),
  ];
  const sorted = sortAdmissionQueue(entries);
  assert.deepEqual(
    sorted.map((e) => e.queueClass),
    ['POST_EVENT', 'WEEKLY_DEFERRED', 'POST_EVENT_DEGRADED', 'WEEKLY_ROTATION', 'PRE_EVENT'],
  );
  assert.deepEqual(sorted.map((e) => e.subject), ['603986', '600176', '002384', '600183', '000977']);
  assert.deepEqual(QUEUE_PRIORITY, { POST_EVENT: 0, WEEKLY_DEFERRED: 1, POST_EVENT_DEGRADED: 2, WEEKLY_ROTATION: 3, PRE_EVENT: 4 });
});

// ===== SC-5.2 预留名额 =====

test('SC-5.2 证伪：给定在途 permit 集 → 事件后待研非空期间周度在途 ≤ 1', () => {
  assert.deepEqual(assertReservedSlot({ postEventPendingCount: 1, inFlight: [{ researchKind: 'WEEKLY' }, { researchKind: 'WEEKLY' }] }), {
    violated: true, postEventPending: true, weeklyInFlight: 2, weeklyLimit: 1,
  });
  assert.equal(assertReservedSlot({ postEventPendingCount: 1, inFlight: [{ researchKind: 'WEEKLY' }, { researchKind: 'POST_EVENT' }] }).violated, false);
  // 事件后自身无周度在途时可占满 2
  assert.equal(assertReservedSlot({ postEventPendingCount: 1, inFlight: [{ researchKind: 'POST_EVENT' }, { researchKind: 'POST_EVENT' }] }).violated, false);
  // 事件后队列空：周度可占满 2
  assert.equal(assertReservedSlot({ postEventPendingCount: 0, inFlight: [{ researchKind: 'WEEKLY' }, { researchKind: 'WEEKLY' }] }).violated, false);
});

test('SC-5.2 证伪：周度在途 2 时注入 1 只事件后 → 释放后下一个启动的是事件后', () => {
  const cutoff = at('2026-10-12', '18:30:00');
  const entries: AdmissionRecord[] = [
    weeklyEntry('603986', 'WEEKLY_ROTATION', cutoff),
    weeklyEntry('002384', 'WEEKLY_ROTATION', cutoff),
    weeklyEntry('600176', 'WEEKLY_ROTATION', cutoff),
    admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-12', '19:00:00'), detectedAt: at('2026-10-12', '19:00:00'), triggerEventIds: ['evt:p'] }, cutoff),
  ];
  assert.deepEqual(nextStartable(entries, [{ researchKind: 'WEEKLY' }, { researchKind: 'WEEKLY' }]), { none: true, reason: 'IN_FLIGHT_FULL' });
  const after = nextStartable(entries, [{ researchKind: 'WEEKLY' }]);
  assert.equal(after.none, false);
  assert.equal(!after.none && after.entry.subject, '600519'); // 下一个启动的是事件后
  const weeklyOnly = nextStartable(entries.filter((e) => e.queueClass !== 'POST_EVENT'), [{ researchKind: 'WEEKLY' }]);
  assert.equal(!weeklyOnly.none && weeklyOnly.entry.queueClass, 'WEEKLY_ROTATION');
});

// ===== SC-5.3 周度顺延 =====

test('SC-5.3 证伪：未启动的周度条目次日全部出现在队首且无条目被静默丢弃；已启动者不自动重研', () => {
  const cutoff = at('2026-10-12', '18:30:00');
  const entries: AdmissionRecord[] = [
    weeklyEntry('603986', 'WEEKLY_ROTATION', cutoff),
    weeklyEntry('002384', 'WEEKLY_ROTATION', cutoff),
    weeklyEntry('600519', 'WEEKLY_ROTATION', cutoff),
    { ...weeklyEntry('600176', 'WEEKLY_ROTATION', cutoff), started: true, sent: true },
    weeklyEntry('000977', 'PRE_EVENT', cutoff),
    { ...weeklyEntry('002008', 'POST_EVENT_DEGRADED', cutoff), annotation: '事件后研究未按最高优先窗完成' },
  ];
  const { deferred, keptInDenominator } = deferUnstartedWeekly(entries, CAL, '2026-10-12', at('2026-10-12', '22:01:00'));
  assert.equal(deferred.length, 5);
  assert.equal(keptInDenominator.length, 1);
  assert.equal(keptInDenominator[0]?.subject, '600176');
  assert.equal(deferred[0]?.queueClass, 'WEEKLY_DEFERRED');
  assert.equal(deferred[0]?.notes.some((n) => n.includes('顺延至 2026-10-13')), true); // 下一交易日 = 10-13
  const degraded = deferred.find((d) => d.subject === '002008');
  assert.equal(degraded?.annotation, '事件后研究未按最高优先窗完成'); // 降级标注在顺延中保留
  const nextNight = at('2026-10-13', '18:30:00');
  const queue = sortAdmissionQueue([...deferred, weeklyEntry('601899', 'WEEKLY_ROTATION', nextNight)]);
  assert.equal(queue[0]?.queueClass, 'WEEKLY_DEFERRED'); // 队首
  assert.equal(queue[queue.length - 1]?.queueClass, 'WEEKLY_ROTATION');
  assert.equal(deferred.length + keptInDenominator.length, entries.length); // 无静默丢弃
});

// ===== SC-7.1 准入时继承声明 =====

test('SC-7.1 证伪：本周已研股票读回 INHERITED + 被继承结论引用；未研股票读回 STANDALONE 标注原文', () => {
  const inherited = declarePostEventInheritance('600519', [
    { subject: '600519', conclusionId: 'c:1', conclusionHash: 'h:1', completedAt: at('2026-10-12', '21:00:00') },
    { subject: '600519', conclusionId: 'c:2', conclusionHash: 'h:2', completedAt: at('2026-10-13', '21:00:00') },
  ]);
  assert.deepEqual(inherited, { basis: 'INHERITED', fromConclusionId: 'c:2', fromConclusionHash: 'h:2' }); // 最近一次
  const standalone = declarePostEventInheritance('600519', [
    { subject: '000938', conclusionId: 'c:3', conclusionHash: 'h:3', completedAt: at('2026-10-13', '21:00:00') },
  ]);
  assert.deepEqual(standalone, { basis: 'STANDALONE', standaloneNote: '无基础结论可继承' });
});

// ===== SC-9.3 原件不可得阻断与恢复 =====

test('SC-9.3 证伪：原件缺失 → 具名阻断、登记缺口；次日取得 → 并入次日周度队列（顺延不属补跑）', () => {
  const rec = admitPostEvent({ subject: '600519', subjectKind: 'STOCK', publishedAt: at('2026-10-08', '20:00:00'), detectedAt: at('2026-10-08', '20:05:00'), triggerEventIds: ['evt:m'] }, at('2026-10-08', '20:05:00'));
  const blocked = blockPostEventMaterialMissing(rec, at('2026-10-08', '23:50:00'));
  assert.equal(blocked.blockedCode, 'MATERIAL_MISSING');
  assert.equal(blocked.gapRegistered, true);
  assert.equal(blocked.weeklyReportVisible, true);
  assert.deepEqual(blocked.triggerEventIds, ['evt:m']);
  // 原件次日（10-09）取得 → 并入下一交易日 10-12 周度队列，以 WEEKLY 类型执行
  const merged = materialRecoveredMerge(blocked, CAL, at('2026-10-09', '10:00:00'));
  assert.equal(merged.queueClass, 'WEEKLY_DEFERRED');
  assert.equal(merged.researchKind, 'WEEKLY');
  assert.equal(merged.cutoff, at('2026-10-12', '18:00:00'));
  assert.deepEqual(merged.triggerEventIds, ['evt:m']);
});

// ===== SC-8.1/8.4 预算守卫 =====

test('SC-8.4 证伪：超限只走顺延/暂停上报，无扩容与降档', () => {
  assert.deepEqual(
    budgetGuard({ weeklyUsed: 60, postEventUsed: 5, postEventAuthCap: 10 }),
    { ok: false, scope: 'WEEKLY', action: 'DEFER', noAutoScale: true, noModelDowngrade: true },
  );
  assert.deepEqual(
    budgetGuard({ weeklyUsed: 30, postEventUsed: 10, postEventAuthCap: 10 }),
    { ok: false, scope: 'POST_EVENT', action: 'STOP_AND_PAUSE_REPORT', noAutoScale: true, noModelDowngrade: true },
  );
  assert.deepEqual(budgetGuard({ weeklyUsed: 30, postEventUsed: 5, postEventAuthCap: 10 }), { ok: true });
});
