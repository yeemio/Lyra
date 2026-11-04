/**
 * Lyra · 技术指标纯函数库单测（B 类 B3 / W40: code-writer）。纯函数用例：不碰网络、不碰 DB。
 * 覆盖：
 * 1. Python 独立对照——60 根合成收盘，内嵌 Python decimal 脚本按同一冻结公式独立复算
 *    （独立实现、独立语言运行时），七值逐字符串断言 + 定点格式断言；
 * 2. 数据不足边界——4/5/14/15/25/26/33/34 根的 null 精确边界（MA5≥5、MA20≥20、MA60≥60、
 *    RSI14≥15、DIF≥26、DEA/histogram≥34）；
 * 3. as-of 过滤——date > asOf 的行不参与，截断序列与全量+早 asOf 结果全等；早于首根 → 全 null；
 * 4. 乱序策略——选定"内部升序排序"（乱序入参与升序入参结果全等，入参不被改写）；
 *    重复日期 / 非法日期具名拒绝；非定点 close 沿用 SettlementError 具名拒绝；
 * 5. 常量序列性质——MA=收盘、RSI='100'（无跌约定）、DIF/DEA/histogram='0'。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { SettlementError } from '../settlement/decimal.js';
import { computeIndicators, indicatorVersionForMethod, LEGACY_INDICATOR_VERSION, EMA_INDICATOR_VERSION,
  RESEARCH_REPAIR_METHOD_VERSION, type IndicatorBar, type IndicatorResult } from './indicators.js';

/** 60 根确定性合成收盘（两位小数；生成后固化为字面量，双语言共以此为准）。 */
const SYN_CLOSES: string[] = [
  '19.98', '20.67', '19.92', '19.60', '20.44', '20.77', '20.19', '19.98', '20.68', '20.63',
  '19.88', '20.60', '20.02', '20.31', '20.56', '20.54', '21.38', '20.88', '21.11', '20.50',
  '21.34', '20.79', '20.86', '21.48', '22.18', '21.55', '22.24', '22.87', '22.61', '23.10',
  '22.69', '22.15', '21.63', '21.35', '21.95', '21.94', '22.82', '23.54', '23.10', '23.04',
  '22.35', '22.54', '22.78', '22.98', '22.33', '22.57', '21.96', '22.59', '22.57', '21.94',
  '22.80', '23.60', '23.36', '24.14', '23.82', '23.93', '24.10', '24.64', '23.96', '23.22',
];

/** 从 2026-01-01 起按日生成 n 个合成 bar（日期仅作排序键，非真实交易日历）。 */
function synthBars(n: number, closes?: string[]): IndicatorBar[] {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
    close: closes?.[i] ?? '10.50',
  }));
}

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** 内嵌 Python 独立实现（decimal + ROUND_HALF_UP，量化点与 TS 冻结公式一一对应）。 */
const PY_INDEPENDENT = `
import sys, json
from decimal import Decimal, ROUND_HALF_UP, getcontext

getcontext().prec = 60
Q = Decimal('1e-12')

def q(x):
    return x.quantize(Q, rounding=ROUND_HALF_UP)

def dstr(x):
    if x == 0:
        return '0'
    s = format(x, 'f')
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s

def mean(vs):
    return q(sum(vs) / Decimal(len(vs)))

def ema_step(prev, x, n):
    return q((prev * (n - 1) + 2 * x) / (n + 1))

def compute(closes):
    m = len(closes)
    out = {'ma5': None, 'ma20': None, 'ma60': None, 'rsi14': None,
           'macd': {'dif': None, 'dea': None, 'histogram': None}}
    for n, key in ((5, 'ma5'), (20, 'ma20'), (60, 'ma60')):
        if m >= n:
            out[key] = dstr(mean(closes[m - n:]))
    if m >= 15:
        g = Decimal(0); l = Decimal(0)
        for i in range(1, 15):
            c = closes[i] - closes[i - 1]
            if c > 0: g += c
            elif c < 0: l += -c
        avg_g = q(g / Decimal(14)); avg_l = q(l / Decimal(14))
        for i in range(15, m):
            c = closes[i] - closes[i - 1]
            gain = c if c > 0 else Decimal(0)
            loss = -c if c < 0 else Decimal(0)
            avg_g = q((avg_g * 13 + gain) / 14)
            avg_l = q((avg_l * 13 + loss) / 14)
        out['rsi14'] = '100' if avg_l == 0 else dstr(q(avg_g * 100 / (avg_g + avg_l)))
    if m >= 26:
        e12 = mean(closes[:12])
        e12s = [e12]
        for i in range(12, m):
            e12 = ema_step(e12, closes[i], 12)
            e12s.append(e12)
        e26 = mean(closes[:26])
        difs = [e12s[25 - 11] - e26]
        for i in range(26, m):
            e26 = ema_step(e26, closes[i], 26)
            difs.append(e12s[i - 11] - e26)
        out['macd']['dif'] = dstr(difs[-1])
        if m >= 34:
            dea = mean(difs[:9])
            for i in range(9, len(difs)):
                dea = ema_step(dea, difs[i], 9)
            out['macd']['dea'] = dstr(dea)
            out['macd']['histogram'] = dstr(q((difs[-1] - dea) * 2))
    return out

print(json.dumps(compute([Decimal(s) for s in json.loads(sys.argv[1])])))
`;

test('Python 独立对照：60 根合成收盘七值逐字符串一致', () => {
  const bars = synthBars(60, SYN_CLOSES);
  const asOf = bars[59]!.date;
  const actual = computeIndicators(bars, asOf);
  const stdout = execFileSync('python3', ['-c', PY_INDEPENDENT, JSON.stringify(SYN_CLOSES)], {
    encoding: 'utf8',
  });
  const expected = JSON.parse(stdout) as IndicatorResult;
  for (const key of ['ma5', 'ma20', 'ma60', 'rsi14'] as const) {
    assert.equal(actual[key], expected[key], `${key}`);
    assert.match(actual[key] as string, DECIMAL_STRING_RE);
  }
  for (const key of ['dif', 'dea', 'histogram'] as const) {
    assert.equal(actual.macd[key], expected.macd[key], `macd.${key}`);
    assert.match(actual.macd[key] as string, DECIMAL_STRING_RE);
  }
});

test('I-14：非线性平方序列的 SMA 种子与首个 EMA9 递推；新旧方法分流', () => {
  const closes = Array.from({ length: 60 }, (_, i) => String((i + 1) ** 2 + (i % 4) * 3));
  for (const n of [33, 34, 35, 60]) {
    const bars = synthBars(n, closes), expected = JSON.parse(execFileSync('python3', ['-c', PY_INDEPENDENT, JSON.stringify(closes.slice(0, n))], { encoding: 'utf8' })) as IndicatorResult;
    assert.deepEqual(computeIndicators(bars, '2026-12-31', EMA_INDICATOR_VERSION), expected);
    const oldPython = PY_INDEPENDENT.replace('dea = ema_step(dea, difs[i], 9)', 'dea = q((dea * 8 + difs[i]) / 9)');
    const legacy = JSON.parse(execFileSync('python3', ['-c', oldPython, JSON.stringify(closes.slice(0, n))], { encoding: 'utf8' })) as IndicatorResult;
    assert.deepEqual(computeIndicators(bars, '2026-12-31', LEGACY_INDICATOR_VERSION), legacy);
  }
  const bars = synthBars(60, closes);
  assert.equal(computeIndicators(bars.slice(0, 33), '2026-12-31').macd.dea, null);
  assert.equal(computeIndicators(bars.slice(0, 34), '2026-12-31').macd.dea, '244.029724355442');
  assert.equal(computeIndicators(bars.slice(0, 35), '2026-12-31').macd.dea, '252.573340169807');
  assert.equal(computeIndicators(bars, '2026-12-31', LEGACY_INDICATOR_VERSION).macd.dea, '490.417071752968');
  assert.equal(computeIndicators(bars, '2026-12-31').macd.dea, '537.092127779934');
  assert.equal(indicatorVersionForMethod('method@p2-v1'), LEGACY_INDICATOR_VERSION);
  assert.equal(indicatorVersionForMethod(RESEARCH_REPAIR_METHOD_VERSION), EMA_INDICATOR_VERSION);
  assert.throws(() => indicatorVersionForMethod('unknown'), /INDICATOR_METHOD_UNSUPPORTED/);
  assert.throws(() => computeIndicators(bars, '2026-12-31', 'unknown' as never), /INDICATOR_VERSION_UNSUPPORTED/);
});

test('数据不足边界：各窗口 null 精确边界', () => {
  const cases: Array<{ n: number; expect: Partial<Record<'ma5' | 'ma20' | 'ma60' | 'rsi14' | 'dif' | 'dea' | 'histogram', boolean>> }> = [
    { n: 4, expect: { ma5: false, ma20: false, ma60: false, rsi14: false, dif: false, dea: false, histogram: false } },
    { n: 5, expect: { ma5: true, ma20: false, ma60: false, rsi14: false, dif: false, dea: false, histogram: false } },
    { n: 14, expect: { ma5: true, ma20: false, ma60: false, rsi14: false, dif: false, dea: false, histogram: false } },
    { n: 15, expect: { ma5: true, ma20: false, ma60: false, rsi14: true, dif: false, dea: false, histogram: false } },
    { n: 25, expect: { ma5: true, ma20: true, ma60: false, rsi14: true, dif: false, dea: false, histogram: false } },
    { n: 26, expect: { ma5: true, ma20: true, ma60: false, rsi14: true, dif: true, dea: false, histogram: false } },
    { n: 33, expect: { ma5: true, ma20: true, ma60: false, rsi14: true, dif: true, dea: false, histogram: false } },
    { n: 34, expect: { ma5: true, ma20: true, ma60: false, rsi14: true, dif: true, dea: true, histogram: true } },
    { n: 60, expect: { ma5: true, ma20: true, ma60: true, rsi14: true, dif: true, dea: true, histogram: true } },
  ];
  for (const { n, expect } of cases) {
    const r = computeIndicators(synthBars(n), '2026-12-31');
    for (const [key, present] of Object.entries(expect)) {
      const v = key === 'ma5' || key === 'ma20' || key === 'ma60' || key === 'rsi14' ? r[key] : r.macd[key as 'dif' | 'dea' | 'histogram'];
      assert.equal(v === null, !present, `n=${n} ${key} 应为 ${present ? '非 null' : 'null'}，实际 ${String(v)}`);
    }
  }
  // 空入参：全 null（不抛错，如实缺口）。
  assert.deepStrictEqual(computeIndicators([], '2026-06-30'), {
    ma5: null, ma20: null, ma60: null, rsi14: null, macd: { dif: null, dea: null, histogram: null },
  });
});

test('as-of 过滤：未来 bar 不参与；早于首根全 null', () => {
  const bars = synthBars(60, SYN_CLOSES);
  const asOf = bars[29]!.date;
  assert.deepStrictEqual(
    computeIndicators(bars, asOf),
    computeIndicators(bars.slice(0, 30), asOf),
    '截点后的 30 根不应影响结果',
  );
  assert.deepStrictEqual(computeIndicators(bars, '2025-12-31'), {
    ma5: null, ma20: null, ma60: null, rsi14: null, macd: { dif: null, dea: null, histogram: null },
  });
});

test('乱序策略：内部升序排序（选定并写明）；重复/非法输入具名拒绝', () => {
  const bars = synthBars(60, SYN_CLOSES);
  const asOf = bars[59]!.date;
  const baseline = computeIndicators(bars, asOf);
  const reversed = [...bars].reverse();
  assert.deepStrictEqual(computeIndicators(reversed, asOf), baseline, '乱序入参应与升序结果全等');
  assert.equal(reversed[0]!.date, bars[59]!.date, '入参数组不得被改写');
  // 重复日期（同一业务键两根 bar 有歧义）。
  assert.throws(
    () => computeIndicators([bars[0]!, bars[0]!], asOf),
    (e: unknown) => e instanceof Error && 'code' in e && (e as { code: string }).code === 'INDICATOR_DUPLICATE_DATE',
  );
  // 非法日期格式。
  assert.throws(
    () => computeIndicators([{ date: '2026/01/05', close: '10.00' }], asOf),
    (e: unknown) => e instanceof Error && 'code' in e && (e as { code: string }).code === 'INDICATOR_INVALID_DATE',
  );
  // close 非定点字符串（指数形式）→ 沿用结算域具名拒绝。
  assert.throws(
    () => computeIndicators([{ date: '2026-01-05', close: '1e5' }], asOf),
    (e: unknown) => e instanceof SettlementError && e.code === 'DECIMAL_INVALID',
  );
  // asOf 非法格式。
  assert.throws(
    () => computeIndicators(bars, '2026-6-30'),
    (e: unknown) => e instanceof Error && 'code' in e && (e as { code: string }).code === 'INDICATOR_INVALID_DATE',
  );
});

test('常量序列性质：MA=收盘、RSI=100（无跌约定）、MACD 三值全 0', () => {
  const bars = synthBars(40);
  const r = computeIndicators(bars, bars[39]!.date);
  assert.equal(r.ma5, '10.5');
  assert.equal(r.ma20, '10.5');
  assert.equal(r.rsi14, '100');
  assert.equal(r.macd.dif, '0');
  assert.equal(r.macd.dea, '0');
  assert.equal(r.macd.histogram, '0');
});

test('非循环锚点：EMA 错位检测（前 26 平后 4 跳升 ⇒ dif>0）与 RSI 单调端点', () => {
  // 34 根：前 26 根收 100，末 8 根收 200。EMA12 比 EMA26 更快吸收跳升 ⇒ DIF > 0；
  // 若 EMA12 配对错位（取到 14 根前的 EMA12 = 100），DIF 必为负——符号即可手推判定。
  const closes = [...Array<string>(26).fill('100'), ...Array<string>(8).fill('200')];
  const r = computeIndicators(synthBars(34, closes), '2026-12-31');
  assert.ok(r.macd.dif !== null && !r.macd.dif.startsWith('-'), `dif 应为正，实际 ${String(r.macd.dif)}`);
  assert.ok(r.macd.dea !== null && !r.macd.dea.startsWith('-'), `dea 应为正，实际 ${String(r.macd.dea)}`);
  assert.ok(r.macd.histogram !== null && !r.macd.histogram.startsWith('-'), `histogram 应为正，实际 ${String(r.macd.histogram)}`);
  // RSI 单调端点（手推精确值）：15 根全涨 → 无跌 → '100'；15 根全跌 → 无涨 → '0'。
  const up = synthBars(15, Array.from({ length: 15 }, (_, i) => (10 + i).toFixed(2)));
  assert.equal(computeIndicators(up, '2026-12-31').rsi14, '100');
  const down = synthBars(15, Array.from({ length: 15 }, (_, i) => (24 - i).toFixed(2)));
  assert.equal(computeIndicators(down, '2026-12-31').rsi14, '0');
});
