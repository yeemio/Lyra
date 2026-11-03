/**
 * Lyra · 事件后溢出判定单测（P3 W17: code-writer-pro）。纯函数，日历/时钟注入。
 * 合同判定：SCHEDULING.md SC-6.1（容量 4、判定时点交易日 08:00、早者优先、三组证伪）、
 * SC-6.2（降级处置四属性）、SC-6.3（财报季容量不上调）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTradeCalendarTable } from '../adapters/calendar.js';
import type { PostEventOverflowCandidate } from './overflow.js';
import {
  degradedToAdmissionRecord,
  isEarningsSeason,
  judgePostEventOverflow,
  MORNING_WINDOW_CAPACITY,
} from './overflow.js';
import { ScheduleError, shanghaiInstant } from './windows.js';

// 国庆缺口日历：10-08/10-09 交易、10-12..10-16 交易
const CAL = buildTradeCalendarTable(
  ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
    .map((d) => ({ calendar_date: d, is_trading_day: '1' })),
);

// 4 月日历（财报季预期月，周一至周五）
const APRIL_DAYS: string[] = [];
for (let d = new Date('2026-03-30T00:00:00+08:00'); d <= new Date('2026-04-30T00:00:00+08:00'); d = new Date(d.getTime() + 86_400_000)) {
  const day = d.getUTCDay();
  if (day !== 0 && day !== 6) APRIL_DAYS.push(d.toISOString().slice(0, 10));
}
const CAL_APRIL = buildTradeCalendarTable(APRIL_DAYS.map((d) => ({ calendar_date: d, is_trading_day: '1' })));

const at = (date: string, time: string): Date => shanghaiInstant(date, time);

let seq = 0;
/** 归属 judgeDay 的候选（publishedAt = 前一交易日晚间）。 */
function candidate(judgeDay: string, subject: string, eveningTime: string, state: PostEventOverflowCandidate['state']): PostEventOverflowCandidate {
  seq += 1;
  const dayIndex = ['2026-10-09', '2026-04-07'].indexOf(judgeDay);
  const publishedDay = dayIndex === 0 ? '2026-10-08' : '2026-04-06';
  return {
    admissionId: `adm:${subject}:${String(seq)}`,
    subject,
    detectedAt: shanghaiInstant(publishedDay, eveningTime).toISOString(),
    publishedAt: shanghaiInstant(publishedDay, eveningTime).toISOString(),
    state,
    triggerEventIds: [`evt:${subject}`],
  };
}

test('SC-6.1 证伪一：7 只均未启动 → 4 进窗、3 降级', () => {
  const cands = ['603986', '002384', '600176', '600183', '000938', '603259', '601899']
    .map((s, i) => candidate('2026-10-09', s, `${String(16 + i).padStart(2, '0')}:00:00`, 'UNSTARTED'));
  const j = judgePostEventOverflow(CAL, at('2026-10-09', '08:00:00'), cands);
  assert.equal(j.capacity, 4);
  assert.equal(j.inFlight, 0);
  assert.equal(j.canStartNew, 4);
  assert.equal(j.admitted.length, 4);
  assert.equal(j.degraded.length, 3);
  assert.equal(j.earningsSeason, true); // 10 月属财报季预期月（SC-6.3），容量仍 4（下方专测）
});

test('SC-6.1 证伪二：7 只中 3 只已于前晚完成 → 4 待研、0 降级', () => {
  const states: PostEventOverflowCandidate['state'][] = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'UNSTARTED', 'UNSTARTED', 'UNSTARTED', 'UNSTARTED'];
  const cands = ['603986', '002384', '600176', '600183', '000938', '603259', '601899'].map((s, i) => candidate('2026-10-09', s, `${String(16 + i).padStart(2, '0')}:00:00`, states[i] as PostEventOverflowCandidate['state']));
  const j = judgePostEventOverflow(CAL, at('2026-10-09', '08:00:00'), cands);
  assert.equal(j.belongingCount, 7);
  assert.equal(j.unstartedCount, 4);
  assert.equal(j.canStartNew, 4);
  assert.equal(j.admitted.length, 4);
  assert.equal(j.degraded.length, 0);
});

test('SC-6.1 证伪三：7 只中 2 只在途 → 可新启动 2、降级 3', () => {
  const states: PostEventOverflowCandidate['state'][] = ['IN_FLIGHT', 'IN_FLIGHT', 'UNSTARTED', 'UNSTARTED', 'UNSTARTED', 'UNSTARTED', 'UNSTARTED'];
  const cands = ['603986', '002384', '600176', '600183', '000938', '603259', '601899'].map((s, i) => candidate('2026-10-09', s, `${String(16 + i).padStart(2, '0')}:00:00`, states[i] as PostEventOverflowCandidate['state']));
  const j = judgePostEventOverflow(CAL, at('2026-10-09', '08:00:00'), cands);
  assert.equal(j.inFlight, 2);
  assert.equal(j.canStartNew, 2);
  assert.equal(j.admitted.length, 2);
  assert.equal(j.degraded.length, 3);
});

test('SC-6.1：按检测命中时刻早者优先；归属外的候选不参与本日判定', () => {
  // detectedAt 乱序给出
  const cands = [
    candidate('2026-10-09', '601899', '21:00:00', 'UNSTARTED'),
    candidate('2026-10-09', '603986', '16:00:00', 'UNSTARTED'),
    candidate('2026-10-09', '600519', '17:30:00', 'UNSTARTED'),
    candidate('2026-10-09', '002384', '16:30:00', 'UNSTARTED'),
    candidate('2026-10-09', '600176', '19:00:00', 'UNSTARTED'),
    // 归属外：10-09 晨间增补检测的公告 → 次日 10-12 截止
    { admissionId: 'adm:other:99', subject: '000977', detectedAt: at('2026-10-09', '07:20:00').toISOString(), publishedAt: at('2026-10-09', '07:10:00').toISOString(), state: 'UNSTARTED' as const, triggerEventIds: [] },
  ];
  const j = judgePostEventOverflow(CAL, at('2026-10-09', '08:00:00'), cands);
  assert.equal(j.belongingCount, 5);
  // 早者优先：16:00 < 16:30 < 17:30 < 19:00 < 21:00 → 前 4 进窗、最晚命中者降级
  assert.deepEqual(j.admitted.map((a) => a.subject), ['603986', '002384', '600519', '600176']);
  assert.equal(j.degraded.length, 1);
  assert.equal(j.degraded[0]?.subject, '601899'); // 21:00 命中最晚 → 降级
});

test('SC-6.1：判定时点校验——非 08:00 或非交易日具名拒绝', () => {
  const cands = [candidate('2026-10-09', '603986', '16:00:00', 'UNSTARTED')];
  for (const bad of [at('2026-10-09', '07:59:00'), at('2026-10-09', '08:01:00'), at('2026-10-10', '08:00:00')]) {
    assert.throws(
      () => judgePostEventOverflow(CAL, bad, cands),
      (e: unknown) => e instanceof ScheduleError && e.code === 'OVERFLOW_JUDGE_TIME_INVALID',
    );
  }
  // 08:00:00–08:00:59 秒级抖动按同一判定时点接受
  assert.doesNotThrow(() => judgePostEventOverflow(CAL, at('2026-10-09', '08:00:30'), cands));
});

test('SC-6.2 证伪：降级条目读回标注原文、触发公告引用、次日以 W 类型执行、截点为并入日周度截点', () => {
  const cands = ['603986', '002384', '600176', '600183', '000938', '603259'].map((s, i) => candidate('2026-10-09', s, `${String(16 + i).padStart(2, '0')}:00:00`, 'UNSTARTED'));
  const j = judgePostEventOverflow(CAL, at('2026-10-09', '08:00:00'), cands);
  assert.equal(j.degraded.length, 2);
  const d = j.degraded[0];
  assert.ok(d !== undefined);
  assert.equal(d.annotation, '事件后研究未按最高优先窗完成'); // 标注原文（复盘独立类别）
  assert.equal(d.executedAs, 'WEEKLY');
  assert.equal(d.inheritanceBasis, 'POST_EVENT'); // SC-7.1 继承仍按事件后语义
  assert.equal(d.mergeIntoTradingDay, '2026-10-12'); // 并入次日（下一交易日）
  assert.deepEqual(d.triggerEventIds, [`evt:${d.subject}`]);
  const rec = degradedToAdmissionRecord(d, at('2026-10-09', '08:00:05').toISOString());
  assert.equal(rec.queueClass, 'POST_EVENT_DEGRADED'); // SC-5.1 ② 晚间队列位次
  assert.equal(rec.researchKind, 'WEEKLY'); // 以周度类型执行
  assert.equal(rec.cutoff, shanghaiInstant('2026-10-12', '18:00:00').toISOString()); // 截点 = 并入日周度截点口径
  assert.equal(rec.annotation, '事件后研究未按最高优先窗完成');
  assert.equal(rec.notes.some((n) => n.includes('SC-6.2 降级')), true);
});

test('SC-6.3 证伪：财报季（4 月）6 只待研 → 仍 4 进窗 2 降级，容量常数不因财报季上调', () => {
  assert.equal(isEarningsSeason('2026-04-07'), true);
  assert.equal(isEarningsSeason('2026-08-20'), true);
  assert.equal(isEarningsSeason('2026-10-09'), true);
  assert.equal(isEarningsSeason('2026-06-15'), false);
  const cands = ['603986', '002384', '600176', '600183', '000938', '603259'].map((s, i) => candidate('2026-04-07', s, `${String(16 + i).padStart(2, '0')}:00:00`, 'UNSTARTED'));
  const j = judgePostEventOverflow(CAL_APRIL, at('2026-04-07', '08:00:00'), cands);
  assert.equal(j.earningsSeason, true);
  assert.equal(MORNING_WINDOW_CAPACITY, 4); // 冻结计划常数
  assert.equal(j.capacity, 4); // 不上调
  assert.equal(j.admitted.length, 4);
  assert.equal(j.degraded.length, 2); // 溢出照走降级通道
});
