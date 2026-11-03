/**
 * Lyra · 四时段窗口判定单测（P3 W17: code-writer-pro）。纯函数，日历/时钟注入，无网络无 DB。
 * 合同判定：SCHEDULING.md SC-3.1（检测节拍）、SC-3.3（启动/截止/非交易日/08:01 拒绝）、
 * SC-3.4（周度截点界）、SC-3.5（22:01 拒绝）、SC-3.6（主触发/兜底）、SC-3.7（去重）、
 * §3.4（周六/周五收盘）、SC-10.1/10.2（节假日/休市顺延）、SC-10.3（时钟 ±60s 容忍与保守修正）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTradeCalendarTable } from '../adapters/calendar.js';
import {
  canStartPostEvent,
  deadlineComparisonInstant,
  deadlineExceeded,
  detectionCadenceOf,
  eveningDetectionSlots,
  assessPreEventTrigger,
  dedupePreEventVsPostEvent,
  postEventWindowOf,
  preEventDedupeKey,
  recordCalibration,
  shanghaiInstant,
  shanghaiWeekday,
  weeklyAdmissionAt,
  weeklyCanStartAt,
  weekendReviewWindow,
  weekendReviewWindowForDate,
  CLOCK_TOLERANCE_MS,
} from './windows.js';

// ===== 日历夹具：含国庆缺口（10-01..10-07 休市；10-10/10-11 周末）=====
const CAL = buildTradeCalendarTable(
  [
    '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30',
    '2026-10-08', '2026-10-09',
    '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
  ].map((d) => ({ calendar_date: d, is_trading_day: '1' })),
);

const at = (date: string, time: string): Date => shanghaiInstant(date, time);

test('夹具星期数核对（2026-10-10 周六、10-01 周四、10-03 周六）', () => {
  assert.equal(shanghaiWeekday('2026-10-10'), 6);
  assert.equal(shanghaiWeekday('2026-10-01'), 4);
  assert.equal(shanghaiWeekday('2026-10-03'), 6);
});

// ===== SC-3.1 检测节拍 =====

test('SC-3.1：晚间槽位 15:30–23:00 每 30 分钟共 16 个', () => {
  const slots = eveningDetectionSlots();
  assert.equal(slots.length, 16);
  assert.equal(slots[0], '15:30:00');
  assert.equal(slots[15], '23:00:00');
});

test('SC-3.1 证伪：22:45 与次日 07:20 两条公告均在检测节拍内', () => {
  const evening = detectionCadenceOf(at('2026-10-08', '22:45:00'));
  assert.equal(evening.withinEvening, true);
  assert.equal(evening.slot, '22:30:00');
  const morning = detectionCadenceOf(at('2026-10-09', '07:20:00'));
  assert.equal(morning.withinMorningSupplement, true);
  assert.equal(morning.withinEvening, false);
  // 节拍外（如 07:00 前、23:00 后）不属检测时刻
  assert.equal(detectionCadenceOf(at('2026-10-09', '06:59:59')).withinMorningSupplement, false);
  assert.equal(detectionCadenceOf(at('2026-10-08', '23:00:01')).withinEvening, false);
});

// ===== SC-3.3 / SC-10.2 事件后窗口 =====

test('SC-3.3：交易日夜间公告 → 次日 08:00/09:15（次日=下一交易日）', () => {
  const w = postEventWindowOf(CAL, at('2026-10-08', '21:30:00'));
  assert.equal(w.nextTradingDay, '2026-10-09');
  assert.equal(w.latestStart, at('2026-10-09', '08:00:00').toISOString());
  assert.equal(w.deadline, at('2026-10-09', '09:15:00').toISOString());
});

test('SC-2/10.2：周五与周末公告的次日 09:15 = 下周一 09:15；节假日发布解析到下一交易日', () => {
  assert.equal(postEventWindowOf(CAL, at('2026-10-09', '20:00:00')).nextTradingDay, '2026-10-12');
  assert.equal(postEventWindowOf(CAL, at('2026-10-10', '20:00:00')).deadline, at('2026-10-12', '09:15:00').toISOString());
  assert.equal(postEventWindowOf(CAL, at('2026-10-01', '10:00:00')).nextTradingDay, '2026-10-08');
});

test('SC-3.3 证伪：检测命中后即可启动（含周末提前研）；次日 08:01 新启动具名拒绝', () => {
  const published = at('2026-10-10', '20:00:00'); // 周六公告
  assert.deepEqual(canStartPostEvent(CAL, published, at('2026-10-10', '20:05:00')).allowed, true);
  assert.deepEqual(canStartPostEvent(CAL, published, at('2026-10-12', '07:59:59')).allowed, true);
  assert.deepEqual(canStartPostEvent(CAL, published, at('2026-10-12', '08:00:00')).allowed, true);
  const late = canStartPostEvent(CAL, published, at('2026-10-12', '08:01:00'));
  assert.equal(late.allowed, false);
  assert.equal(late.allowed === false && late.code, 'POST_EVENT_START_LATE');
});

// ===== SC-3.4 / SC-3.5 周度窗口 =====

test('SC-3.4 证伪：截点=排程时刻且落在交易日 18:00–22:00 内', () => {
  const ok = weeklyAdmissionAt(CAL, at('2026-10-12', '18:30:00'));
  assert.deepEqual(ok, { open: true, tradingDay: '2026-10-12', cutoff: at('2026-10-12', '18:30:00').toISOString() });
  const lastMinute = weeklyAdmissionAt(CAL, at('2026-10-12', '21:59:59'));
  assert.equal(lastMinute.open, true);
  assert.equal(weeklyAdmissionAt(CAL, at('2026-10-12', '22:00:00')).open, false); // 截点须 < 22:00
  assert.equal(weeklyAdmissionAt(CAL, at('2026-10-12', '17:59:59')).open, false);
});

test('SC-10.1/10.2 证伪：法定节假日与休市日无周度准入', () => {
  assert.deepEqual(weeklyAdmissionAt(CAL, at('2026-10-01', '19:00:00')), { open: false, code: 'NOT_TRADING_DAY' });
  assert.deepEqual(weeklyAdmissionAt(CAL, at('2026-10-10', '19:00:00')), { open: false, code: 'NOT_TRADING_DAY' });
});

test('SC-3.5 证伪：21:59 合法启动、22:01 新启动具名拒绝（截止 23:30）', () => {
  assert.deepEqual(weeklyCanStartAt(CAL, at('2026-10-12', '21:59:00')), { allowed: true, deadline: at('2026-10-12', '23:30:00').toISOString() });
  const late = weeklyCanStartAt(CAL, at('2026-10-12', '22:01:00'));
  assert.equal(late.allowed, false);
  assert.equal(late.allowed === false && late.code, 'WEEKLY_START_LATE');
});

// ===== SC-3.6 事件前主触发与兜底 =====

test('SC-3.6：主触发 = 预约披露日当日', () => {
  const r = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: '2026-10-12', statutoryDeadline: '2026-10-30', disclosed: false });
  assert.deepEqual(r, { trigger: 'SCHEDULED', scheduledDate: '2026-10-12' });
});

test('SC-3.6 证伪：无预约记录 + 截止前 5 个交易日 → 兜底触发', () => {
  // 10-12 之后至 10-19（含）恰有 5 个交易日（13/14/15/16/19）
  const r = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: null, statutoryDeadline: '2026-10-19', disclosed: false });
  assert.deepEqual(r, { trigger: 'DEADLINE_FALLBACK', reason: 'NO_SCHEDULE', statutoryDeadline: '2026-10-19' });
  // 非第 5 交易日不触发
  const notDue = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: null, statutoryDeadline: '2026-10-20', disclosed: false });
  assert.equal(notDue.trigger, 'NONE');
});

test('SC-3.6 证伪：预约日已过仍未披露 → 兜底；主触发已完成（已披露）→ 无第二次事件前准入', () => {
  const fallback = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: '2026-10-08', statutoryDeadline: '2026-10-19', disclosed: false });
  assert.deepEqual(fallback, { trigger: 'DEADLINE_FALLBACK', reason: 'SCHEDULE_PASSED_NOT_DISCLOSED', statutoryDeadline: '2026-10-19' });
  const disclosed = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: '2026-10-12', statutoryDeadline: '2026-10-30', disclosed: true });
  assert.equal(disclosed.trigger, 'NONE');
  // 预约日在未来：主触发按预约日走，兜底不启用
  const future = assessPreEventTrigger({ calendar: CAL, tradingDay: '2026-10-12', subject: '600519', scheduledDate: '2026-10-15', statutoryDeadline: '2026-10-30', disclosed: false });
  assert.deepEqual(future, { trigger: 'NONE', reason: 'SCHEDULE_IN_FUTURE' });
});

test('SC-3.6：同一报告期同一股票至多触发一次的去重键稳定', () => {
  assert.equal(preEventDedupeKey('600519', '2026Q3'), 'pre:600519:2026Q3');
});

// ===== SC-3.7 事件前 vs 事件后去重 =====

test('SC-3.7 证伪：预约日晚间披露并被检测捕获 → 事件前准入撤销', () => {
  const r = dedupePreEventVsPostEvent(
    { subject: '600519', tradingDay: '2026-10-12' },
    [{ subject: '600519', detectedAt: at('2026-10-12', '19:05:00').toISOString() }],
  );
  assert.equal(r.action, 'REVOKE');
  assert.deepEqual(r.action === 'REVOKE' && { reason: r.reason, at: r.capturedByDetectedAt }, {
    reason: 'DISCLOSED_AND_CAPTURED_BY_POST_EVENT',
    at: at('2026-10-12', '19:05:00').toISOString(),
  });
  // 其他日捕获 / 其他股票 → 保留
  assert.equal(dedupePreEventVsPostEvent({ subject: '600519', tradingDay: '2026-10-12' }, [{ subject: '600519', detectedAt: at('2026-10-09', '19:05:00').toISOString() }]).action, 'KEEP');
  assert.equal(dedupePreEventVsPostEvent({ subject: '600519', tradingDay: '2026-10-12' }, [{ subject: '000938', detectedAt: at('2026-10-12', '19:05:00').toISOString() }]).action, 'KEEP');
});

// ===== §3.4 周末窗口 =====

test('§3.4：触发周六、截点周五收盘；周五休市取其前最近交易日', () => {
  assert.deepEqual(weekendReviewWindowForDate(CAL, '2026-10-10'), { isReviewDay: true, saturday: '2026-10-10', cutoffDay: '2026-10-09' });
  // 10-03 周六的周五（10-02）在国庆休市内 → 截点 09-30 收盘
  assert.deepEqual(weekendReviewWindowForDate(CAL, '2026-10-03'), { isReviewDay: true, saturday: '2026-10-03', cutoffDay: '2026-09-30' });
  assert.deepEqual(weekendReviewWindow(CAL, at('2026-10-12', '12:00:00')), { isReviewDay: false, saturday: null, cutoffDay: null });
});

// ===== SC-10.3 时钟与漂移容忍 =====

test('SC-10.3：偏差 ≤ 60 秒照常（无告警无修正）；±60 秒为容忍边界', () => {
  const now = at('2026-10-12', '07:30:00');
  assert.deepEqual(recordCalibration(now, 59_000), { offsetMs: 59_000, withinTolerance: true, warning: null, recordedAt: now.toISOString(), comparisonAdjustmentMs: 0 });
  assert.equal(recordCalibration(now, CLOCK_TOLERANCE_MS).withinTolerance, true);
  assert.equal(recordCalibration(now, -60_000).withinTolerance, true);
});

test('SC-10.3 证伪：+90 秒偏差 → 记录与告警，比较值按本地时钟 − 90 秒方向修正，排程不中止', () => {
  const now = at('2026-10-12', '07:30:00');
  const rec = recordCalibration(now, 90_000);
  assert.equal(rec.withinTolerance, false);
  assert.equal(rec.warning, 'CLOCK_DRIFT_EXCEEDED:FAST:90000ms');
  assert.equal(rec.comparisonAdjustmentMs, -90_000);
  assert.equal(deadlineComparisonInstant(now, 90_000).getTime(), now.getTime() - 90_000);
  // 本地偏慢（−90 秒）：不修正（只允许让截止提前，不延后）
  assert.equal(deadlineComparisonInstant(now, -90_000).getTime(), now.getTime());
  assert.equal(deadlineComparisonInstant(now, 30_000).getTime(), now.getTime()); // 容忍内不修正
});

test('SC-10.3：截止判定使用修正后比较时刻', () => {
  const now = at('2026-10-12', '09:14:30');
  const deadline = at('2026-10-12', '09:15:00');
  assert.equal(deadlineExceeded(now, deadline, 90_000), false); // 本地快 90s：真实 09:13:00 未到截止
  assert.equal(deadlineExceeded(now, deadline, 0), false);
  const late = at('2026-10-12', '09:16:31');
  assert.equal(deadlineExceeded(late, deadline, 90_000), true); // 修正后 09:15:01 > 截止 09:15:00
});
