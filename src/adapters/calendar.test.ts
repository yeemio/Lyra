/**
 * Lyra · 交易日历纯函数单测（P1 W6）。不碰网络、不碰 DB：真实形状夹具注入
 * （含节假日跨月：2015 国庆跨 9→10 月、2020 春节延休跨 1→2 月）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CalendarError,
  buildTradeCalendarTable,
  calendarCoverage,
  isTradingDay,
  lastTradingDayOfMonth,
  lastTradingDayOnOrBefore,
  nextTradingDay,
  prevTradingDay,
  tradingDaysBetween,
  type TradeCalendarTable,
} from './calendar.js';

/** 夹具：取材真实 A 股日历区段（升序交易日）。 */
const TRADING_DAYS = [
  '2015-06-29', '2015-06-30', // 6 月尾（封存演示日 2015-06-30 为交易日）
  '2015-09-28', '2015-09-29', '2015-09-30', // 国庆前最后三交易日
  '2015-10-08', '2015-10-09', // 国庆休 10-01..10-07 后首两交易日（跨月长假）
  '2015-10-12', '2015-10-13', '2015-10-30', // 10-10/10-11 周末休；10-30 月末
  '2020-01-20', '2020-01-21', '2020-01-22', '2020-01-23', // 春节前（01-23 为节前最后交易日）
  '2020-02-03', '2020-02-04', '2020-02-28', // 延休跨月后首两交易日 + 2 月末
];

function fixture(): TradeCalendarTable {
  return { tradingDays: [...TRADING_DAYS] };
}

test('buildTradeCalendarTable：只取 is_trading_day=1，排序去重，坏行拒绝，空表拒绝', () => {
  const rows = [
    { calendar_date: '2015-06-30', is_trading_day: '1' },
    { calendar_date: '2015-06-29', is_trading_day: '1' }, // 乱序入
    { calendar_date: '2015-06-30', is_trading_day: '1' }, // 重复入
    { calendar_date: '2015-07-01', is_trading_day: '0' }, // 非交易日不入表
    { calendar_date: '2015-07-04', is_trading_day: '0' },
  ];
  const table = buildTradeCalendarTable(rows);
  assert.deepEqual(table.tradingDays, ['2015-06-29', '2015-06-30']);
  assert.throws(() => buildTradeCalendarTable([{ calendar_date: '2015-06-3', is_trading_day: '1' }]), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_ROW_INVALID');
    return true;
  });
  assert.throws(() => buildTradeCalendarTable([{ calendar_date: '2015-07-01', is_trading_day: '0' }]), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_EMPTY');
    return true;
  });
});

test('isTradingDay：交易日/节假日/周末；界外抛 CALENDAR_RANGE', () => {
  const t = fixture();
  assert.equal(isTradingDay(t, '2015-06-30'), true);
  assert.equal(isTradingDay(t, '2015-09-30'), true);
  assert.equal(isTradingDay(t, '2015-10-01'), false, '国庆休市');
  assert.equal(isTradingDay(t, '2015-10-10'), false, '周六');
  assert.equal(isTradingDay(t, '2020-01-23'), true, '春节前最后交易日');
  assert.equal(isTradingDay(t, '2020-01-31'), false, '春节延休');
  assert.equal(isTradingDay(t, '2020-02-03'), true, '延休后首交易日');
  for (const out of ['2015-06-28', '2020-03-02', '2014-12-31']) {
    assert.throws(() => isTradingDay(t, out), (e: unknown) => {
      assert.ok(e instanceof CalendarError);
      assert.equal(e.code, 'CALENDAR_RANGE');
      return true;
    }, out);
  }
  assert.throws(() => isTradingDay(t, '2015-6-30'), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_DATE_INVALID');
    return true;
  });
});

test('nextTradingDay：跨月长假/跨周末/跨季；表尾无覆盖抛错', () => {
  const t = fixture();
  assert.equal(nextTradingDay(t, '2015-09-30'), '2015-10-08', '国庆跨月长假');
  assert.equal(nextTradingDay(t, '2020-01-23'), '2020-02-03', '春节延休跨月');
  assert.equal(nextTradingDay(t, '2015-10-09'), '2015-10-12', '跨周末');
  assert.equal(nextTradingDay(t, '2015-06-30'), '2015-09-28', '夹具内跨季');
  assert.equal(nextTradingDay(t, '2015-10-01'), '2015-10-08', '休市日入参同样给出下一交易日');
  assert.throws(() => nextTradingDay(t, '2020-02-28'), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_RANGE');
    return true;
  }, '表尾之后无覆盖');
});

test('prevTradingDay：跨月回看/跨周末；表头之前抛错', () => {
  const t = fixture();
  assert.equal(prevTradingDay(t, '2015-10-08'), '2015-09-30', '跨月回看');
  assert.equal(prevTradingDay(t, '2020-02-03'), '2020-01-23', '延休跨月回看');
  assert.equal(prevTradingDay(t, '2015-10-12'), '2015-10-09', '跨周末回看');
  assert.throws(() => prevTradingDay(t, '2015-06-29'), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_RANGE');
    return true;
  }, '表头之前无覆盖');
});

test('tradingDaysBetween：闭区间含端点，跳节假日；from>to 拒绝', () => {
  const t = fixture();
  assert.deepEqual(
    tradingDaysBetween(t, '2015-09-28', '2015-10-12'),
    ['2015-09-28', '2015-09-29', '2015-09-30', '2015-10-08', '2015-10-09', '2015-10-12'],
    '跨国庆跨月区间',
  );
  assert.deepEqual(tradingDaysBetween(t, '2020-01-23', '2020-02-03'), ['2020-01-23', '2020-02-03']);
  assert.deepEqual(tradingDaysBetween(t, '2015-10-12', '2015-10-12'), ['2015-10-12'], '端点交易日含端点');
  assert.deepEqual(tradingDaysBetween(t, '2015-10-10', '2015-10-11'), [], '纯周末区间为空');
  assert.throws(() => tradingDaysBetween(t, '2015-10-12', '2015-10-08'), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_RANGE');
    return true;
  });
});

test('lastTradingDayOnOrBefore：长假回看跨月；当日即交易日返回当日', () => {
  const t = fixture();
  assert.equal(lastTradingDayOnOrBefore(t, '2015-10-07'), '2015-09-30', '国庆假期内回看跨月');
  assert.equal(lastTradingDayOnOrBefore(t, '2020-02-02'), '2020-01-23', '延休跨月回看');
  assert.equal(lastTradingDayOnOrBefore(t, '2015-10-30'), '2015-10-30', '交易日返回当日');
});

test('lastTradingDayOfMonth：月末交易日；当月无覆盖交易日拒绝', () => {
  const t = fixture();
  assert.equal(calendarCoverage(t).first, '2015-06-29');
  assert.equal(lastTradingDayOfMonth(t, 2015, 9), '2015-09-30');
  assert.equal(lastTradingDayOfMonth(t, 2015, 10), '2015-10-30');
  assert.equal(lastTradingDayOfMonth(t, 2020, 1), '2020-01-23', '春节月提前收尾');
  assert.equal(lastTradingDayOfMonth(t, 2020, 2), '2020-02-28');
  for (const [y, m] of [[2015, 7] as const, [2015, 8] as const, [2020, 3] as const]) {
    assert.throws(() => lastTradingDayOfMonth(t, y, m), (e: unknown) => {
      assert.ok(e instanceof CalendarError);
      assert.equal(e.code, 'CALENDAR_RANGE');
      return true;
    }, `${y}-${m}`);
  }
  assert.throws(() => lastTradingDayOfMonth(t, 2015, 13), (e: unknown) => {
    assert.ok(e instanceof CalendarError);
    assert.equal(e.code, 'CALENDAR_MONTH_INVALID');
    return true;
  });
});
