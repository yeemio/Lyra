/**
 * Lyra · 行情表格化无损表示单测（P2 W11）。纯函数用例：不碰网络、不碰 DB。
 * 覆盖：往返逐值无损（含尾部零字符串/数字双精度/缺键 null 语义）、复权因子按日期连接、
 * 列序与行序确定性、SW_INDEX_BAR 中文键同构、具名拒绝（混合类型/非行情/null 值/手造表）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimePointFact } from '../contracts.js';
import { canonicalJsonString } from '../canonical.js';
import {
  ADJUST_FACTOR_COLUMN,
  assertRoundTrip,
  barsToTable,
  TableError,
  tableToBars,
} from './tables.js';

// ===== 夹具 =====

let seq = 0;
function barFact(overrides: Partial<TimePointFact> & { typedValue: Record<string, unknown> }): TimePointFact {
  seq += 1;
  return {
    factId: `fact-bar-${seq}`,
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DAILY_BAR',
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: '2022-07-01T00:00:00.000Z',
    availableAt: '2022-07-01T00:00:00.000Z',
    supersedesFactId: null,
    artifactSha256: 'ab'.repeat(32),
    adapterVersion: 'baostock@0.9.40-p1',
    ...overrides,
  };
}

function adjustFact(dividOperateDate: string, adjustFactor: string): TimePointFact {
  return barFact({
    factKind: 'ADJUST_FACTOR',
    typedValue: { code: 'sh.600519', dividOperateDate, adjustFactor, foreAdjustFactor: '1.000000', backAdjustFactor: adjustFactor },
  });
}

const BARS: TimePointFact[] = [
  // 乱序给入，验证行序按日期升序确定
  barFact({
    factId: 'bar-3',
    typedValue: {
      code: 'sh.600519', date: '2022-06-30', open: '1311.8400', high: '1343.8800', low: '1310.0000',
      close: '1335.0000', preclose: '1318.4900', volume: '5768593', amount: '7677216282.6900',
      turn: '0.461500', pctChg: '1.252200', isST: '0', tradestatus: '1', adjustflag: '3',
    },
  }),
  barFact({
    factId: 'bar-1',
    // 缺 turn / pctChg 两键 → 该行 null 单元格；其余行有值
    typedValue: {
      code: 'sh.600519', date: '2022-06-28', open: '1300.0000', high: '1310.0000', low: '1299.0000',
      close: '1305.0000', preclose: '1298.0000', volume: '5000000', amount: '6500000000.0000',
      isST: '0', tradestatus: '1', adjustflag: '3',
    },
  }),
  barFact({
    factId: 'bar-2',
    typedValue: {
      code: 'sh.600519', date: '2022-06-29', open: '1306.0000', high: '1312.0000', low: '1300.5000',
      close: '1309.0000', preclose: '1305.0000', volume: '5200000', amount: '6800000000.0000',
      turn: '0.400000', pctChg: '0.306513', isST: '0', tradestatus: '1', adjustflag: '3',
    },
  }),
];

// ===== 往返无损 =====

test('DAILY_BAR 往返逐值无损（含尾部零字符串、缺键 null、时间字段全等）', () => {
  const table = barsToTable(BARS);
  const rebuilt = tableToBars(table);
  assert.equal(rebuilt.length, BARS.length);
  const byId = new Map(rebuilt.map((f) => [f.factId, f]));
  for (const original of BARS) {
    const got = byId.get(original.factId);
    assert.ok(got, original.factId);
    assert.deepEqual(got, original); // 逐值全等（deepEqual 对字符串/数字/null 逐值比较）
  }
  // 尾部零不被数值化改写：字符串原样保留
  const row1 = table.rows[0] as (string | number | null)[];
  const closeIdx = table.header.indexOf('close');
  assert.equal(row1[closeIdx], '1305.0000');
  // 缺键 → null
  const turnIdx = table.header.indexOf('turn');
  assert.equal(row1[turnIdx], null);
  assertRoundTrip(BARS, table); // 断言器自身不抛
});

test('行序按日期升序、列序确定（date 前置 + 额外键字典序）', () => {
  const table = barsToTable(BARS);
  const dateIdx = table.header.indexOf('date');
  const dates = table.rows.map((r) => r[dateIdx]);
  assert.deepEqual(dates, ['2022-06-28', '2022-06-29', '2022-06-30']);
  assert.equal(table.header[0], 'date');
  // 额外键：注入一个非首选序键，应按字典序排在首选序之后
  const extra = barFact({
    typedValue: { code: 'sh.600519', date: '2022-06-27', zExtra: 'x', aExtra: 1, close: '1.0' },
  });
  const t2 = barsToTable([extra]);
  assert.ok(t2.header.indexOf('aExtra') < t2.header.indexOf('zExtra'), '额外键按字典序');
  assert.ok(t2.header.indexOf('zExtra') > t2.header.indexOf('date'), '额外键排在首选序之后');
  // 同输入同输出（确定性）
  assert.equal(canonicalJsonString(barsToTable(BARS)), canonicalJsonString(barsToTable(BARS)));
});

test('复权因子按日期连接：取 dividOperateDate<=行日期的最近一次，缺历史因子为 null', () => {
  const factors = [
    adjustFact('2022-06-01', '7.500000'),
    adjustFact('2022-06-29', '7.669257'),
  ];
  const table = barsToTable(BARS, { adjustFactors: factors });
  const afIdx = table.header.indexOf(ADJUST_FACTOR_COLUMN);
  assert.ok(afIdx >= 0, '应设复权因子列');
  assert.deepEqual(
    table.rows.map((r) => r[afIdx]),
    ['7.500000', '7.669257', '7.669257'],
  );
  // 连接列不参与重建：往返仍与原 bar 事实逐值一致
  assertRoundTrip(BARS, table);
  // 无因子事实 → 不设列
  const noJoin = barsToTable(BARS);
  assert.equal(noJoin.header.includes(ADJUST_FACTOR_COLUMN), false);
  // 历史更早的 bar（因子都晚于它）→ null
  const early = barFact({
    typedValue: { code: 'sh.600519', date: '2022-05-01', close: '1200.0000' },
  });
  const t3 = barsToTable([early], { adjustFactors: factors });
  assert.equal((t3.rows[0] as (string | number | null)[])[t3.header.indexOf(ADJUST_FACTOR_COLUMN)], null);
});

test('SW_INDEX_BAR 中文键同构往返无损（数字双精度原样）', () => {
  const sw: TimePointFact[] = [
    barFact({
      subjectType: 'INDEX',
      subjectId: '801120',
      factKind: 'SW_INDEX_BAR',
      typedValue: { 代码: '801120', 日期: '2022-06-29', 开盘: 13594.38, 最高: 13600.5, 最低: 13590.1, 收盘: 13599.25, 成交量: 17.22417524, 成交额: 342.63278547, swIndexCode: '801120' },
    }),
    barFact({
      subjectType: 'INDEX',
      subjectId: '801120',
      factKind: 'SW_INDEX_BAR',
      typedValue: { 代码: '801120', 日期: '2022-06-30', 开盘: 13600.0, 最高: 13885.15, 最低: 13594.38, 收盘: 13885.15, 成交量: 18.5, 成交额: 351.2, swIndexCode: '801120' },
    }),
  ];
  const table = barsToTable(sw);
  assert.equal(table.meta.factKind, 'SW_INDEX_BAR');
  assert.equal(table.header[0], '日期');
  assertRoundTrip(sw, table);
  // 双精度数字经 canonical JSON 往返不变
  const rebuilt = tableToBars(table);
  const vol = (rebuilt[0]?.typedValue as Record<string, unknown>)['成交量'];
  assert.equal(vol, 17.22417524);
});

test('具名拒绝：混合 factKind / 非行情类型 / typedValue null 值 / 手造不可逆表', () => {
  assert.throws(() => barsToTable([BARS[0] as TimePointFact, adjustFact('2022-06-01', '1.0')]), /TABLE_FACT_KIND_MIXED/);
  assert.throws(
    () => barsToTable([barFact({ factKind: 'FINANCIAL', typedValue: { statDate: '2022-06-30' } })]),
    /TABLE_FACT_KIND_UNSUPPORTED/,
  );
  assert.throws(
    () => barsToTable([barFact({ typedValue: { date: '2022-06-30', close: null } })]),
    /TABLE_NULL_IN_TYPED_VALUE/,
  );
  assert.throws(
    () => tableToBars({ header: ['date'], rows: [['x']], reversible: false, meta: { factKind: 'DAILY_BAR', columns: [{ name: 'date', source: 'typedValue' }], rowFacts: [] } } as never),
    /TABLE_NOT_REVERSIBLE/,
  );
  assert.throws(
    () => barsToTable([barFact({ typedValue: { code: 'sh.600519' } })]), // 缺日期键
    /TABLE_DATE_COLUMN_MISSING/,
  );
  // 行宽与列数不一致
  const t = barsToTable(BARS);
  assert.throws(
    () => tableToBars({ ...t, rows: [...t.rows, ['x']] }),
    /TABLE_MALFORMED/,
  );
});

test('空事实集 → 空表（可逆平凡成立）', () => {
  const t = barsToTable([]);
  assert.deepEqual(t.header, []);
  assert.deepEqual(t.rows, []);
  assert.deepEqual(tableToBars(t), []);
});
