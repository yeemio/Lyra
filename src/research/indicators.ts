/**
 * Lyra · 技术指标纯函数库（B 类 B3 / W40: code-writer）。纯函数：不碰网络、不碰 DB。
 * 目的：D5 材料增强——程序复算的确定性特征（非判断），减少模型算术负担。
 * 反过度工程边界：只做三样经典指标 MA（5/20/60）、RSI(14)、MACD(12,26,9)，不做更多。
 *
 * 数值纪律：全部走 src/settlement/decimal.ts 的 scale-12 BigInt 定点（half-up），
 * 无浮点。输出为定点字符串（decToString 去尾零，兼容 /^-?\d+(\.\d+)?$/）或 null
 * （数据不足该窗口，如实缺口，不编造）。
 *
 * 公式按版本冻结；旧 P5 方法显式选 LEGACY_INDICATOR_VERSION，新方法选 EMA_INDICATOR_VERSION。
 * - MA(n)：最近 n 根收盘的简单均值；不足 n 根 → null。
 * - RSI(14)：Wilder 经典口径——涨幅/跌幅取逐日差分，种子 = 首 14 个差分的简单均值，
 *   之后 Wilder 平滑 avg = (prev×13 + x) / 14；RSI = 100 × avgGain / (avgGain + avgLoss)；
 *   avgLoss = 0 约定输出 '100'（全程无跌）。收盘不足 15 根（差分不足 14 个）→ null。
 *   注：与 A 股行情软件的 SMA(X,N,1) 变体（种子取首个差分）不同，此处为 Wilder 原始口径。
 * - MACD(12,26,9)：EMA 递推 seed 用首值 SMA 法（EMA 种子 = 前 N 根收盘简单均值），
 *   之后 EMA[i] = (EMA[i-1]×(N-1) + 2×close[i]) / (N+1)（合并式，每步仅一次 scale-12
 *   half-up 舍入，与逐项 k×(close−prev)+prev 数学等价）；DIF = EMA12 − EMA26（自第 26 根）；
 *   DEA = DIF 的 EMA9，种子 = 首 9 个 DIF 的简单均值（自第 34 根），递推
 *   (prev×8 + 2×dif) / 10；histogram = 2×(DIF − DEA)（A 股软件惯例口径）。
 *   旧版仅供冻结样本复现，保留非 EMA9 的 (prev×8 + dif) / 9，不冒称修正后方法。
 *   DIF 不足 26 根 → null；DEA/histogram 不足 34 根 → null。
 *
 * 输入纪律：bars 为 {date, close} 数组，close 为定点字符串（DAILY_BAR 原始字段口径；
 * 数字入参具名拒绝，调用方自行 String() 归一）。输出值取 as-of 过滤后（date ≤ asOf）
 * 最新一根收盘处。乱序输入选择"内部按日期升序排序"（而非拒绝）——调用方来自 DB 读取，
 * 排序消除一种失败模式；重复日期具名拒绝（同一业务键两根 bar 输入有歧义）。
 */
import {
  DEC_ZERO,
  type Dec,
  decAdd,
  decDiv,
  decFromInt,
  decFromString,
  decMul,
  decSub,
  decToString,
} from '../settlement/decimal.js';

export class IndicatorError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'IndicatorError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TWO = decFromInt(2);

export const LEGACY_INDICATOR_VERSION = 'indicators@p2-v1-legacy';
export const EMA_INDICATOR_VERSION = 'indicators@p2-v2-ema9';
export const RESEARCH_REPAIR_METHOD_VERSION = 'method@p2-v2-20261103';
export type IndicatorVersion = typeof LEGACY_INDICATOR_VERSION | typeof EMA_INDICATOR_VERSION;

/** 未知方法不得默默采用新公式；冻结 P5 的方法入口仍明确保留旧值。 */
export function indicatorVersionForMethod(methodVersion: string): IndicatorVersion {
  if (methodVersion === 'method@p2-v1') return LEGACY_INDICATOR_VERSION;
  if (methodVersion === RESEARCH_REPAIR_METHOD_VERSION) return EMA_INDICATOR_VERSION;
  throw new IndicatorError('INDICATOR_METHOD_UNSUPPORTED', methodVersion);
}

export interface IndicatorBar {
  /** 交易日 YYYY-MM-DD（零填充，字典序 = 时间序）。 */
  date: string;
  /** 收盘价定点字符串（DAILY_BAR 原始 close 字段）。 */
  close: string;
}

export interface MacdResult {
  dif: string | null;
  dea: string | null;
  histogram: string | null;
}

export interface IndicatorResult {
  ma5: string | null;
  ma20: string | null;
  ma60: string | null;
  rsi14: string | null;
  macd: MacdResult;
}

const ALL_NULL: IndicatorResult = {
  ma5: null,
  ma20: null,
  ma60: null,
  rsi14: null,
  macd: { dif: null, dea: null, histogram: null },
};

/** n 个 Dec 的简单均值（求和精确，仅除法一次 scale-12 half-up 舍入）。 */
function meanOf(values: readonly Dec[]): Dec {
  let sum = DEC_ZERO;
  for (const v of values) sum = decAdd(sum, v);
  return decDiv(sum, decFromInt(values.length));
}

/** EMA 递推一步（首值 SMA 种子法）：(prev×(n−1) + 2×x) / (n+1)，一次 half-up 舍入。 */
function emaStep(prev: Dec, x: Dec, period: number): Dec {
  return decDiv(
    decAdd(decMul(prev, decFromInt(period - 1)), decMul(x, TWO)),
    decFromInt(period + 1),
  );
}

/**
 * 计算三样经典指标在 as-of 截点的值。纯函数：不改写入参、不碰外部状态。
 * bars 可乱序（内部升序排序）；date > asOf 的行被过滤；数据不足的窗口为 null。
 */
export function computeIndicators(bars: readonly IndicatorBar[], asOf: string, version: IndicatorVersion = EMA_INDICATOR_VERSION): IndicatorResult {
  if (version !== LEGACY_INDICATOR_VERSION && version !== EMA_INDICATOR_VERSION) {
    throw new IndicatorError('INDICATOR_VERSION_UNSUPPORTED', String(version));
  }
  if (!DATE_RE.test(asOf)) {
    throw new IndicatorError('INDICATOR_INVALID_DATE', `asOf: "${asOf}"（须为 YYYY-MM-DD）`);
  }
  const seen = new Set<string>();
  for (const bar of bars) {
    if (!DATE_RE.test(bar.date)) {
      throw new IndicatorError('INDICATOR_INVALID_DATE', `bar.date: "${bar.date}"（须为 YYYY-MM-DD）`);
    }
    if (seen.has(bar.date)) {
      throw new IndicatorError('INDICATOR_DUPLICATE_DATE', `date "${bar.date}" 出现多次`);
    }
    seen.add(bar.date);
    // close 非定点字符串（含 number / 指数形式）由 decFromString 具名拒绝（DECIMAL_INVALID）。
    decFromString(bar.close, `close@${bar.date}`);
  }
  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const series = sorted.filter((b) => b.date <= asOf).map((b) => decFromString(b.close, `close@${b.date}`));
  const m = series.length;
  if (m === 0) return ALL_NULL;

  // ===== MA(5/20/60)：最近 n 根简单均值 =====
  const ma = (n: number): string | null =>
    m >= n ? decToString(meanOf(series.slice(m - n))) : null;

  // ===== RSI(14)：Wilder 口径（种子 = 首 14 个差分简单均值） =====
  let rsi14: string | null = null;
  if (m >= 15) {
    let avgGain = DEC_ZERO;
    let avgLoss = DEC_ZERO;
    for (let i = 1; i <= 14; i++) {
      const chg = decSub(series[i] as Dec, series[i - 1] as Dec); // i ≤ 14 < m ⇒ 索引有效
      if (chg.scaled > 0n) avgGain = decAdd(avgGain, chg);
      else if (chg.scaled < 0n) avgLoss = decAdd(avgLoss, decSub(DEC_ZERO, chg));
    }
    avgGain = decDiv(avgGain, decFromInt(14));
    avgLoss = decDiv(avgLoss, decFromInt(14));
    for (let i = 15; i < m; i++) {
      const chg = decSub(series[i] as Dec, series[i - 1] as Dec);
      const gain = chg.scaled > 0n ? chg : DEC_ZERO;
      const loss = chg.scaled < 0n ? decSub(DEC_ZERO, chg) : DEC_ZERO;
      avgGain = decDiv(decAdd(decMul(avgGain, decFromInt(13)), gain), decFromInt(14));
      avgLoss = decDiv(decAdd(decMul(avgLoss, decFromInt(13)), loss), decFromInt(14));
    }
    rsi14 = avgLoss.scaled === 0n ? '100' : decToString(decDiv(decMul(avgGain, decFromInt(100)), decAdd(avgGain, avgLoss)));
  }

  // ===== MACD(12,26,9)：EMA 首值 SMA 种子 + 合并式递推 =====
  const macd: MacdResult = { dif: null, dea: null, histogram: null };
  if (m >= 26) {
    let e12 = meanOf(series.slice(0, 12));
    const e12s: Dec[] = [e12]; // e12s[j] = 收盘索引 j+11 处的 EMA12
    for (let i = 12; i < m; i++) {
      e12 = emaStep(e12, series[i] as Dec, 12);
      e12s.push(e12);
    }
    let e26 = meanOf(series.slice(0, 26));
    // e12s[j] = EMA12 在收盘索引 j+11 处 ⇒ DIF(i) = e12s[i−11] − EMA26(i)（i ≥ 25）。
    const difs: Dec[] = [decSub(e12s[25 - 11] as Dec, e26)];
    for (let i = 26; i < m; i++) {
      e26 = emaStep(e26, series[i] as Dec, 26);
      difs.push(decSub(e12s[i - 11] as Dec, e26)); // i−11 ≤ m−12 < e12s.length（= m−11）
    }
    const difLast = difs[difs.length - 1] as Dec; // m ≥ 26 ⇒ difs 非空
    macd.dif = decToString(difLast);
    if (m >= 34) {
      let dea = meanOf(difs.slice(0, 9)); // 种子 = 首 9 个 DIF 简单均值（索引 25..33）
      for (let i = 9; i < difs.length; i++) {
        dea = version === LEGACY_INDICATOR_VERSION
          ? decDiv(decAdd(decMul(dea, decFromInt(8)), difs[i] as Dec), decFromInt(9))
          : emaStep(dea, difs[i] as Dec, 9);
      }
      macd.dea = decToString(dea);
      macd.histogram = decToString(decMul(decSub(difLast, dea), TWO));
    }
  }

  return { ma5: ma(5), ma20: ma(20), ma60: ma(60), rsi14, macd };
}
