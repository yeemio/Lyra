/**
 * Lyra · 行业轮动监测表单测（B 类 B5 / W34: code-writer-pro）。纯函数用例：不碰网络、不碰 DB。
 * 覆盖：定点数学原语基准（ln/√，期望值由 Python Fraction/Decimal 高精度独立生成）、
 * 合成 bars 收益/波动定点断言（常量/几何/交替三型）、as-of 过滤、体系切换取数
 * （2014/2021 边界、指数切换窗口缺行如实）、空行业缺行、排序稳定（同收益代码序、
 * 不可得列末）、名称注入、IndexBarView 结构相容（接线契约）、具名拒绝。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IndexBarView } from '../settlement/excess.js';
import { decFromString, decToString } from '../settlement/decimal.js';
import {
  RotationError,
  decLnRatio,
  decSqrt,
  industryMomentumTable,
  rotationIndustryCodes,
  rotationSystemOf,
  type IndustryIndexBarView,
} from './rotation.js';

// ===== 夹具 =====

/** 连续 n 个日历日（升序，止于 last）；纯函数只要求日期升序去重，不要求交易日历。 */
function isoDays(n: number, last: string): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return days;
}

/** closes[i] 对应止于 last 的第 i 个交易日（升序）。 */
function bars(closes: readonly string[], last: string): IndustryIndexBarView[] {
  const dates = isoDays(closes.length, last);
  return closes.map((close, i) => ({ date: dates[i] as string, close }));
}

/** 21 根恒定行情（首根 baseStart，其余 base）→ r20 = base/baseStart − 1 精确可控。 */
function flatBars(base: string, baseStart: string, last: string): IndustryIndexBarView[] {
  return bars([baseStart, ...Array.from({ length: 20 }, () => base)], last);
}

/** 全体系注入同一份行情（每码一份新数组，避免共享引用干扰）。 */
function mapOf(codes: readonly string[], make: (code: string) => IndustryIndexBarView[]): Map<string, IndustryIndexBarView[]> {
  const m = new Map<string, IndustryIndexBarView[]>();
  for (const c of codes) m.set(c, make(c));
  return m;
}

const ALL_2021 = rotationIndustryCodes('2021');
const ALL_2014 = rotationIndustryCodes('2014');

// ===== 定点数学原语基准（期望值：Python Fraction/Decimal 60 位精度独立生成后 half-up 到 scale 12）=====

test('decLnRatio 基准：ln(3/2)/ln(2/3)/ln(2)/ln(4)/ln(5/4)/ln(1)（含 sqrt 归约路径）', () => {
  const ln = (a: string, b: string) => decToString(decLnRatio(decFromString(a), decFromString(b)));
  assert.equal(ln('3', '2'), '0.405465108108');
  assert.equal(ln('2', '3'), '-0.405465108108');
  assert.equal(ln('2', '1'), '0.69314718056'); // 2 → √2（一次 sqrt 归约）
  assert.equal(ln('4', '1'), '1.38629436112'); // 4 → 2 → √2（两次 sqrt 归约）
  assert.equal(ln('5', '4'), '0.223143551314');
  assert.equal(ln('1000', '1000'), '0'); // 比值恰为 1
});

test('decLnRatio 具名拒绝：零/负定义域', () => {
  for (const [a, b] of [['0', '5'], ['-2', '5'], ['5', '0'], ['5', '-2']] as const) {
    assert.throws(
      () => decLnRatio(decFromString(a), decFromString(b)),
      (e: unknown) => e instanceof RotationError && e.code === 'ROTATION_LN_DOMAIN',
    );
  }
});

test('decSqrt 基准：√2/√9/√0.000004/√0 单次 half-up 舍入', () => {
  const sq = (a: string) => decToString(decSqrt(decFromString(a)));
  assert.equal(sq('2'), '1.414213562373');
  assert.equal(sq('9'), '3');
  assert.equal(sq('0.000004'), '0.002');
  assert.equal(sq('0'), '0');
  assert.throws(
    () => decSqrt(decFromString('-1')),
    (e: unknown) => e instanceof RotationError && e.code === 'ROTATION_SQRT_DOMAIN',
  );
});

// ===== 合成 bars：收益/波动定点断言 =====

test('常量收盘：r20=0、波动=0、r60/r120 缺省 null（乱序输入结果不变）', () => {
  const flat = bars(Array.from({ length: 21 }, () => '1000'), '2026-06-30');
  const table = industryMomentumTable(new Map([['801010', [...flat].reverse()]]), '2026-06-30'); // 乱序喂入
  assert.equal(table.rows.length, 1);
  const row = table.rows[0] as (typeof table.rows)[number];
  assert.equal(row.industryIndexCode, '801010');
  assert.equal(row.return20, '0');
  assert.equal(row.volatility20, '0');
  assert.equal(row.return60, null);
  assert.equal(row.return120, null);
  assert.equal(row.barsUsed, 21);
  assert.equal(row.lastBarDate, '2026-06-30');
  assert.equal(row.rank, 1);
});

test('几何整数序列（×3/2 连乘 21 根）：r20 精确舍入、逐日同比对数收益波动恒 0', () => {
  // closes_k = 3^k·2^(20−k)：相邻比恰为 3/2，全部整数字符串，scale 12 内精确
  const closes = Array.from({ length: 21 }, (_, k) => String(3 ** k * 2 ** (20 - k)));
  const table = industryMomentumTable(new Map([['801050', bars(closes, '2026-06-30')]]), '2026-06-30');
  const row = table.rows[0] as (typeof table.rows)[number];
  assert.equal(row.return20, '3324.256730079651'); // (3/2)^20 − 1 = 3485735825/1048576，half-up 到 scale 12
  assert.equal(row.volatility20, '0'); // 对数收益全等 → 离差恒 0
  assert.equal(row.return60, null);
  assert.equal(row.return120, null);
});

test('交替 ×5/4/×4/5（21 根整数）：对数收益 ±ln(5/4) 交替，波动定点精确还原', () => {
  // c0 = 4^10，此后交替 ×5/4、×4/5（全整数）；r20 = 0；波动 = √(round12(L12²))，L12 = 0.223143551314
  const closes: string[] = ['1048576'];
  for (let i = 0; i < 20; i += 1) {
    const prev = Number(closes[closes.length - 1]);
    closes.push(String(i % 2 === 0 ? (prev * 5) / 4 : (prev * 4) / 5));
  }
  const table = industryMomentumTable(new Map([['801080', bars(closes, '2026-06-30')]]), '2026-06-30');
  const row = table.rows[0] as (typeof table.rows)[number];
  assert.equal(row.return20, '0'); // 偶数步回到起点
  assert.equal(row.volatility20, '0.223143551314'); // 期望值 Python Fraction 精确复算（含管线各步舍入）
});

// ===== as-of 过滤 =====

test('as-of 过滤：date > asOf 的行情行不入计算', () => {
  const visible = flatBars('100', '50', '2026-06-30'); // r20 = 100/50 − 1 = 1
  const leaked = bars(['1'], '2026-07-15'); // 若泄漏则 r20 = 1/50 − 1 = -0.98
  const table = industryMomentumTable(new Map([['801010', [...visible, ...leaked]]]), '2026-06-30');
  const row = table.rows[0] as (typeof table.rows)[number];
  assert.equal(row.return20, '1');
  assert.equal(row.barsUsed, 21);
  assert.equal(row.lastBarDate, '2026-06-30');
});

test('as-of 落在行情日之间：取 ≤ asOf 的最后一根', () => {
  const visible = flatBars('100', '50', '2026-06-28');
  const table = industryMomentumTable(new Map([['801010', visible]]), '2026-06-30'); // 30 日无新行情
  const row = table.rows[0] as (typeof table.rows)[number];
  assert.equal(row.lastBarDate, '2026-06-28');
  assert.equal(row.return20, '1');
});

// ===== 体系切换取数 =====

test('体系全集：2014=28（含 801020、不含 801950-801980）；2021=31（反之）', () => {
  assert.equal(ALL_2014.length, 28);
  assert.ok(ALL_2014.includes('801020'));
  for (const c of ['801950', '801960', '801970', '801980']) assert.ok(!ALL_2014.includes(c));
  assert.equal(ALL_2021.length, 31);
  assert.ok(!ALL_2021.includes('801020'));
  for (const c of ['801950', '801960', '801970', '801980']) assert.ok(ALL_2021.includes(c));
  assert.equal(rotationSystemOf('2021-07-29'), '2014');
  assert.equal(rotationSystemOf('2021-07-30'), '2021');
});

test('体系切换：as-of 2021-07-29 按 2014 体系（801020 入表，2021 新增指数即使有数据也不入表）', () => {
  const m = mapOf(ALL_2014, () => flatBars('100', '50', '2021-07-29'));
  m.set('801960', flatBars('100', '50', '2021-07-29')); // 体系外代码，供而不入
  const table = industryMomentumTable(m, '2021-07-29');
  assert.equal(table.system, '2014');
  assert.equal(table.rows.length, 28);
  assert.ok(table.rows.some((r) => r.industryIndexCode === '801020'));
  assert.ok(!table.rows.some((r) => r.industryIndexCode === '801960'));
  assert.deepEqual(table.missingIndustries, []);
});

test('体系切换：as-of 2021-07-30 按 2021 体系（801020 有数据也不入表）', () => {
  const m = mapOf(ALL_2021, () => flatBars('100', '50', '2021-07-30'));
  m.set('801020', flatBars('100', '50', '2021-07-30')); // 已退役旧体系指数，供而不入
  const table = industryMomentumTable(m, '2021-07-30');
  assert.equal(table.system, '2021');
  assert.equal(table.rows.length, 31);
  assert.ok(!table.rows.some((r) => r.industryIndexCode === '801020'));
  assert.deepEqual(table.missingIndustries, []);
});

test('2021 窗口早于指数切换（2021-12-10）：801960/801970/801980 缺行如实', () => {
  const provided = ALL_2021.filter((c) => c !== '801960' && c !== '801970' && c !== '801980');
  const m = mapOf(provided, () => flatBars('100', '50', '2021-12-10'));
  const table = industryMomentumTable(m, '2021-12-10');
  assert.equal(table.system, '2021');
  assert.equal(table.rows.length, 28);
  assert.deepEqual(table.missingIndustries, ['801960', '801970', '801980']);
  assert.ok(table.note.includes('2021-12-13'));
});

// ===== 空行业缺行 / 排序稳定 / 名称注入 =====

test('空行业缺行：只供 1 个行业，其余 30 个按缺行如实列出（升序）', () => {
  const table = industryMomentumTable(new Map([['801010', flatBars('100', '50', '2026-06-30')]]), '2026-06-30');
  assert.equal(table.rows.length, 1);
  assert.equal(table.missingIndustries.length, 30);
  assert.equal(table.missingIndustries[0], '801030');
  assert.ok(table.missingIndustries.includes('801980'));
  const sorted = [...table.missingIndustries].sort();
  assert.deepEqual(table.missingIndustries, sorted);
  // 键存在但空数组 = 无行情，同样缺行
  const t2 = industryMomentumTable(new Map([['801010', []], ['801030', flatBars('100', '50', '2026-06-30')]]), '2026-06-30');
  assert.deepEqual(t2.missingIndustries, ALL_2021.filter((c) => c !== '801030'));
});

test('排序稳定：20 日收益降序 → 同值按代码升序 → 不可得（<21 根）列末；rank 连续', () => {
  const m = new Map<string, IndustryIndexBarView[]>([
    ['801120', flatBars('150', '100', '2026-06-30')], // r20 = 0.5
    ['801030', flatBars('150', '100', '2026-06-30')], // r20 = 0.5（同值，代码序应先于 801120）
    ['801040', flatBars('190', '100', '2026-06-30')], // r20 = 0.9（最高，rank 1）
    ['801050', bars(['100', '101', '102', '103', '104'], '2026-06-30')], // 仅 5 根 → r20 null 列末
  ]);
  const table = industryMomentumTable(m, '2026-06-30');
  assert.deepEqual(
    table.rows.map((r) => [r.rank, r.industryIndexCode, r.return20]),
    [
      [1, '801040', '0.9'],
      [2, '801030', '0.5'],
      [3, '801120', '0.5'],
      [4, '801050', null],
    ],
  );
  const tail = table.rows[3] as (typeof table.rows)[number];
  assert.equal(tail.volatility20, null);
  assert.equal(tail.barsUsed, 5);
  assert.equal(tail.return60, null);
  assert.equal(tail.return120, null);
});

test('名称注入：标签表命中给名称，未命中为 null；缺省选项名称列全 null', () => {
  const m = new Map<string, IndustryIndexBarView[]>([
    ['801030', flatBars('150', '100', '2026-06-30')],
    ['801040', flatBars('190', '100', '2026-06-30')],
  ]);
  const names = new Map([['801030', '基础化工']]);
  const table = industryMomentumTable(m, '2026-06-30', { names });
  const byCode = new Map(table.rows.map((r) => [r.industryIndexCode, r]));
  assert.equal(byCode.get('801030')?.name, '基础化工');
  assert.equal(byCode.get('801040')?.name, null);
  const noNames = industryMomentumTable(m, '2026-06-30');
  assert.equal(noNames.rows[0]?.name, null);
});

// ===== 接线契约与具名拒绝 =====

test('接线契约：settlement/excess.ts 的 IndexBarView 结构相容，直接可传', () => {
  const indexBars: IndexBarView[] = flatBars('150', '100', '2026-06-30').map((b, i) => ({
    factId: `f-${i}`,
    date: b.date,
    open: '100',
    close: b.close,
  }));
  const table = industryMomentumTable(new Map([['801120', indexBars]]), '2026-06-30');
  assert.equal(table.rows[0]?.return20, '0.5');
});

test('具名拒绝：as-of 格式 / pre-2014 / 同日重复 / 非正收盘 / 非定点收盘 / 非法行情日', () => {
  const good = flatBars('100', '50', '2026-06-30');
  const cases: [string, () => unknown, string][] = [
    ['as-of 格式', () => industryMomentumTable(new Map([['801010', good]]), '2026/06/30'), 'ROTATION_AS_OF_INVALID'],
    ['pre-2014 as-of', () => industryMomentumTable(new Map([['801010', good]]), '2014-02-20'), 'ROTATION_AS_OF_PRE_2014'],
    [
      '同日重复行情行',
      () => industryMomentumTable(new Map([['801010', [...good, { date: '2026-06-30', close: '101' }]]]), '2026-06-30'),
      'ROTATION_BAR_DATE_CONFLICT',
    ],
    [
      '非正收盘',
      () => industryMomentumTable(new Map([['801010', bars(['0', ...Array.from({ length: 20 }, () => '100')], '2026-06-30')]]), '2026-06-30'),
      'ROTATION_CLOSE_INVALID',
    ],
    [
      '非定点收盘（指数形式）',
      () => industryMomentumTable(new Map([['801010', bars(['1e3', ...Array.from({ length: 20 }, () => '100')], '2026-06-30')]]), '2026-06-30'),
      'DECIMAL_INVALID',
    ],
    [
      '非法行情日',
      () => {
        const bad = flatBars('100', '50', '2026-06-30').map((b, i) => (i === 0 ? { ...b, date: '20260630' } : b));
        return industryMomentumTable(new Map([['801010', bad]]), '2026-06-30');
      },
      'ROTATION_BAR_DATE_INVALID',
    ],
  ];
  for (const [label, fn, code] of cases) {
    assert.throws(fn, (e: unknown) => (e instanceof Error && 'code' in e && e.code === code) || false, label);
  }
});

test('表注记：注明 as-of 与体系', () => {
  const table = industryMomentumTable(new Map([['801010', flatBars('100', '50', '2019-03-29')]]), '2019-03-29');
  assert.equal(table.asOf, '2019-03-29');
  assert.equal(table.system, '2014');
  assert.ok(table.note.includes('2019-03-29'));
  assert.ok(table.note.includes('2014'));
  assert.ok(table.note.includes('801020'));
});
