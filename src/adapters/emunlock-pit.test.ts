/** I-01：仅合成来源行/交易日历，无采集、无 DB。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimePointFact } from '../contracts.js';
import { EMUNLOCK_ADAPTER_VERSION, mapUnlockRowsToFacts, unlockEventFields } from './emunlock.js';

const DAY = 86_400_000;
const start = Date.parse('2026-01-05T00:00:00Z');
const day = (n: number) => new Date(start + n * DAY).toISOString().slice(0, 10);
const calendar: TimePointFact[] = Array.from({ length: 40 }, (_, i) => {
  const dow = new Date(start + (i + 1) * DAY).getUTCDay();
  return { factId: `cal-${day(i + 1)}`, subjectType: 'RULE', subjectId: 'ashare-calendar', factKind: 'TRADE_CALENDAR',
    typedValue: { calendar_date: day(i + 1), is_trading_day: dow === 0 || dow === 6 ? '0' : '1' },
    validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
    firstObservedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z',
    artifactSha256: 'a'.repeat(64), adapterVersion: 'synthetic-calendar@1', supersedesFactId: null };
});
const row = { 解禁时间: day(0), 解禁股东数: 2, 解禁数量: 10000, 实际解禁数量: 10000,
  未解禁数量: 0, 实际解禁数量市值: 100000, 限售股类型: '合成限售', 解禁前20日涨跌幅: -1,
  解禁后20日涨跌幅: 77.7, 新增事后字段: 88.8 };
function mapped(at: string, value: unknown = 77.7, days = calendar) {
  return mapUnlockRowsToFacts([{ ...row, 解禁后20日涨跌幅: value }], '600101', {
    adapterVersion: EMUNLOCK_ADAPTER_VERSION, fetchedAt: at, artifactSha256: 'b'.repeat(64), calendarFacts: days,
  });
}

test('I-01：事件白名单拒绝已知和新增事后列，结果变更不改变事件 factId', () => {
  assert.equal(Object.hasOwn(unlockEventFields(row), '解禁后20日涨跌幅'), false);
  assert.equal(Object.hasOwn(unlockEventFields(row), '新增事后字段'), false);
  const first = mapped('2026-02-10T08:00:00Z');
  const later = mapped('2026-02-11T08:00:00Z', 99.9);
  assert.equal(first.facts[0]!.fact.factId, later.facts[0]!.fact.factId);
  assert.notEqual(first.facts[1]!.fact.factId, later.facts[1]!.fact.factId);
  assert.equal(first.facts[0]!.fact.availableAt, '2026-01-05T16:00:00.000Z');
  assert.equal(Object.hasOwn(first.facts[0]!.fact.typedValue as object, '解禁后20日涨跌幅'), false);
});

test('I-01：D+1/D+19 交易日、成熟日收盘前不发布 D+20；成熟后取数才可见', () => {
  const trading = calendar.filter((f) => (f.typedValue as Record<string, unknown>).is_trading_day === '1');
  const first = (trading[0]!.typedValue as Record<string, string>).calendar_date!;
  const nineteenth = (trading[18]!.typedValue as Record<string, string>).calendar_date!;
  const twentieth = (trading[19]!.typedValue as Record<string, string>).calendar_date!;
  for (const at of [`${first}T08:00:00Z`, `${nineteenth}T08:00:00Z`, `${twentieth}T06:59:59Z`]) {
    assert.deepEqual(mapped(at).facts.map((m) => m.fact.factKind), ['UNLOCK_DETAIL']);
  }
  const result = mapped(`${twentieth}T08:00:00Z`).facts[1]!.fact;
  assert.equal(result.factKind, 'UNLOCK_OUTCOME');
  assert.equal(result.availableAt, `${twentieth}T08:00:00.000Z`);
  assert.equal(result.eventAt, `${twentieth}T07:00:00.000Z`);
  assert.equal(result.firstObservedAt, `${twentieth}T08:00:00Z`);
  assert.equal((result.typedValue as Record<string, unknown>).horizonTradingDays, 20);
  assert.equal((result.typedValue as Record<string, unknown>).eventFactId, mapped(`${twentieth}T08:00:00Z`).facts[0]!.fact.factId);
});

test('I-01：日历缺日、冲突、观察在未来均不猜成熟；不能用20自然日替代', () => {
  assert.equal(mapped('2026-01-25T08:00:00Z').facts.length, 1);
  assert.equal(mapped('2026-02-10T08:00:00Z', 1, calendar.filter((_, i) => i !== 4)).facts.length, 1);
  const conflict = { ...calendar[0]!, factId: 'conflicting-calendar', typedValue: { calendar_date: day(1), is_trading_day: '0' } };
  assert.equal(mapped('2026-02-10T08:00:00Z', 1, [...calendar, conflict]).facts.length, 1);
  assert.equal(mapped('2026-02-10T08:00:00Z', 1, calendar.map((f) => ({ ...f, firstObservedAt: '2027-01-01T00:00:00Z' }))).facts.length, 1);
});

test('I-01：缺失结果不生成，非法标量具名拒绝；合法零结果保留', () => {
  for (const value of [null, '']) assert.equal(mapped('2026-02-10T08:00:00Z', value).facts.length, 1);
  const { 解禁后20日涨跌幅: _post, ...absent } = row;
  assert.equal(mapUnlockRowsToFacts([absent], '600101', { adapterVersion: EMUNLOCK_ADAPTER_VERSION, fetchedAt: '2026-02-10T08:00:00Z', artifactSha256: 'b'.repeat(64), calendarFacts: calendar }).facts.length, 1);
  for (const value of [true, false, [7], {}, '0x10', 'NaN', Infinity]) {
    const out = mapped('2026-02-10T08:00:00Z', value);
    assert.equal(out.facts.length, 1);
    assert.equal(out.rejections[0]?.code, 'EMUNLOCK_OUTCOME_INVALID');
  }
  for (const value of [0, '0', '-0.25', 7.5]) assert.equal(mapped('2026-02-10T08:00:00Z', value).facts.length, 2);
});
