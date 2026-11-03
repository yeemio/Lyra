/**
 * Lyra · 宽基状态参照库（P4 / W23: code-writer-pro）。
 * 合同：docs/FREEZE-P0-20261025.md §四第 7 维（历史状态参照：指数自身历史在同类状态下的
 * 后续表现，P4 构建，判断义务同方法 14）；docs/PLAN.md §5（宽基状态参照〔R18〕：四只宽基的
 * 跟踪指数自身历史，按趋势状态 → 估值分位档机械选定，统计后续 1、5、20 日绝对收益；
 * 与六类事件库分开）。
 *
 * 状态定义（参数化、可测、依据如下）：
 * - 主层 = 趋势状态：20 个已收盘交易日的端点比较，期末收盘 ≥ 期初收盘 → UP，否则 DOWN
 *   （端点相等归 UP——与个股参照库市场状态层 HISTORICAL-REFERENCE §5 层 4 同一默认算子，
 *   groups.marketStateOf 口径一致，跨库可比）。依据：R18 指定"趋势状态"为第一层；端点比较
 *   是最简、无参数拟合的趋势算子，库内已有先例口径。
 * - 次层 = 20 日已实现波动三档 LOW/MID/HIGH：序量 = 同一 20 收盘日窗口内 19 个日收益对
 *   均值的平方偏差和（与已实现方差/标准差单调同序；全程精确十进制定点，不开方——开方
 *   不保定点精确，分层只需序；均值在统一截断精度 scale=10 下计算，序量全程确定）。
 *   分界 = 逐指数**自身全史**三等分位（全库统一、逐群组不重算——与市值档分界纪律同构
 *   groups.ts；且研究时点的现场判定与库内分组必须用同一套分界才可比，全史等分位在每次
 *   重建时重算并作为预留参数登记）。
 *   【缺口声明】估值分位档（PLAN §5 原定次层）库内不可得：指数估值历史（PE/PB 分位）为
 *   P1 后置缺口（docs/FREEZE-P0-20261025.md §五"留给后续阶段的事项"）。本层是**可得替代层**，
 *   不是估值档；一切产出强制携带 VALUATION_TIER_GAP_DECLARATION，禁止把波动档说成估值档。
 *
 * 抽样时点：每月末交易日（该指数 DAILY_BAR 中每个日历月最后一根有成交 K 线）；首个抽样点
 * 需此前已有 ≥ 19 根 K 线（20 收盘日窗口完整）；**序列末月不抽**——末月末根 K 线即序列
 * 末端，无法证明该月已完结（构建时点的截断末端≠月末状态，其序量亦不得进入分位分界）。
 * 选月末而非每 20 收盘日滚动：相邻月末约隔
 * 20–23 个交易日，后续 20 日窗口基本不重叠，避免滚动日抽样的高序列相关虚增证据密度
 * （嵌套声明另作证据独立性约束）；月末时点在交易所日历上确定、无参数。
 *
 * 统计口径：后续 1/5/20 日绝对收益（收盘/收盘 − 1；指数点位值无复权问题；定点）。每状态组：
 * 样本数、均值/中位数（描述性统计，非预测概率）、失效触发比例（宽基预留 5% 两侧分列：
 * 窗口内累计绝对收益 ≤ −5% / ≥ +5%；SR-2.2 定点纪律，触发判定精确十进制、禁止浮点阈值
 * 比较）。20 日窗口未走完 = WINDOW_INCOMPLETE（非缺口）；触发判定在已完成前缀上有效
 * （同 excess.ts 前缀口径，null 只留给"零前缀不可判定"）。
 * MIN_GROUP_SAMPLE 预留 30——与个股库 DEFAULT_MIN_GROUP_SAMPLE 同源常量；不足下限不产出
 * 该群组块，不降档凑样本（§5 纪律平行适用）。
 *
 * 与六类事件库分开：独立模块、独立表 broadbase_reference_library。不用 reference_group_library
 * 加前缀共存——该表归 W15，其全量构建会剪除不在本轮事件库键集中的行（build.cli.ts 剪枝
 * 逻辑），前缀共存会被兄弟 writer 误删；分表消除跨 writer 生命周期耦合。表结构 DDL 常量
 * 自持于本模块（派发文件清单未含新 sql 文件；幂等 create if not exists，列结构参照
 * src/db/reference-migration.sql 同构：key/path/sample_count/stats/声明列/created_at）。
 *
 * 复用纪律（派发冻结）：只 import 定点工具（excess.ts Fixed 族——非个股专用）、通用序统计
 * tercileBounds、固定声明文本与预留下限常量（groups.ts——同文同源，避免文本漂移）；
 * 不 import 个股专用逻辑（事件窗口/行业/市值/市场状态），结构平行。
 * 单测不碰网络不碰 DB：合成 K 线注入。
 */
import type { Pool } from 'pg';
import {
  fAdd,
  fCmp,
  fDiv,
  fMul,
  fSub,
  fixedToString,
  parseFixed,
  type DailyBarInput,
  type Fixed,
} from './excess.js';
import {
  DEFAULT_MIN_GROUP_SAMPLE,
  NESTED_GROUP_DECLARATION,
  REVISION_NOTICE,
  tercileBounds,
} from './groups.js';

// ===== 常量与声明 =====

/** 四只宽基的跟踪指数码（R18：上证50/沪深300/中证500/中证1000）。 */
export const BROADBASE_INDEX_CODES = ['000016', '000300', '000905', '000852'] as const;
export type BroadbaseIndexCode = (typeof BROADBASE_INDEX_CODES)[number];

export const BROADBASE_INDEX_NAMES: Readonly<Record<BroadbaseIndexCode, string>> = {
  '000016': '上证50',
  '000300': '沪深300',
  '000905': '中证500',
  '000852': '中证1000',
};

/** 方法版本轴（本模块三版本轴之一：方法版本）。 */
export const METHOD_VERSION = 'broadbase-reference@w23.1';

/** 趋势/波动窗口长度（收盘日数；预留参数）。 */
export const TREND_WINDOW_DAYS = 20;

/** 后续收益窗口。 */
export const BROADBASE_HORIZONS = [1, 5, 20] as const;
export type BroadbaseHorizon = (typeof BROADBASE_HORIZONS)[number];
const H_MAX: BroadbaseHorizon = 20;

/** 宽基失效阈值预留值 5%（FREEZE-P0 §五：与个股 10% 同程序 P4 校准、P5 冻结）。 */
export const BROADBASE_INVALIDATION_THRESHOLD_PCT = '5';
const INVALIDATION_THRESHOLD = parseFixed('0.05')!;

/** 估值分位档缺口声明（固定文本，随一切产出强制携带；波动档 ≠ 估值档）。 */
export const VALUATION_TIER_GAP_DECLARATION =
  '估值分位档缺口：指数估值历史（PE/PB 分位）为 P1 后置缺口（docs/FREEZE-P0-20261025.md §五），本轮按可得层实现，次层改用 20 日已实现波动三档——它是可得替代层，不是估值档；禁止把波动档解读或表述为估值分位。';

const ONE: Fixed = { int: 1n, scale: 0 };
const ZERO: Fixed = { int: 0n, scale: 0 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function byDate(a: DailyBarInput, b: DailyBarInput): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

// ===== 序列准备（清洗：日期合法、有成交、收盘可解析；同日去重后到者胜）=====

export interface IndexSeries {
  indexCode: string;
  /** 升序交易日（YYYY-MM-DD）。 */
  dates: string[];
  /** 与 dates 对齐的收盘定点数。 */
  closes: Fixed[];
}

export interface SeriesPrepareResult {
  series: IndexSeries;
  /** 清洗期具名缺口（去重）。 */
  dataGaps: string[];
  /** 清洗剔除行数。 */
  excludedRows: number;
}

export function prepareIndexSeries(indexCode: string, bars: DailyBarInput[]): SeriesPrepareResult {
  const gaps = new Set<string>();
  const byDateMap = new Map<string, Fixed>();
  for (const b of [...bars].sort(byDate)) {
    if (!DATE_RE.test(b.date)) {
      gaps.add(`DAILY_BAR_DATE_INVALID:${b.date}`);
      continue;
    }
    if (String(b.tradestatus ?? '1') === '0' || Number(b.volume) <= 0) {
      gaps.add(`DAILY_BAR_NOT_TRADED:${b.date}`);
      continue;
    }
    const close = parseFixed(b.close);
    if (close === null) {
      gaps.add(`DAILY_BAR_CLOSE_INVALID:${b.date}`);
      continue;
    }
    byDateMap.set(b.date, close); // 同日重复行：排序后后到者胜（确定性）
  }
  const dates = [...byDateMap.keys()].sort();
  return {
    series: { indexCode, dates, closes: dates.map((d) => byDateMap.get(d)!) },
    dataGaps: [...gaps].sort(),
    excludedRows: bars.length - dates.length,
  };
}

// ===== 抽样时点（每月末交易日）=====

/**
 * 每个日历月最后一根 K 线的下标（升序去重日期）；仅保留下标 ≥ TREND_WINDOW_DAYS−1 者
 * （此前须有完整 20 收盘日窗口）。序列最后一根 K 线**不**作为月末抽样点：末月的末根
 * K 线无法证明该月已完结（构建时点的截断末端≠月末状态；真实月末样本必有后继月份 K 线，
 * 其序量也不得进入三等分位分界）。
 */
export function monthEndIndices(dates: string[]): number[] {
  const ends: number[] = [];
  let currentMonth = '';
  for (let i = 0; i < dates.length; i++) {
    const month = dates[i]!.slice(0, 7);
    if (month !== currentMonth) {
      if (i > 0) ends.push(i - 1); // 下一月开始 → 上一月月末
      currentMonth = month;
    }
  }
  // 末月不压栈：其"末根 K 线"即序列末端，无法证明该月已完结。
  return ends.filter((i) => i >= TREND_WINDOW_DAYS - 1);
}

// ===== 主层：趋势状态（20 收盘日端点比较；相等归 UP）=====

export type TrendState = 'UP' | 'DOWN';

export interface TrendWindowInfo {
  state: TrendState;
  from: string;
  to: string;
  firstClose: string;
  lastClose: string;
}

export function trendWindowAt(dates: string[], closes: Fixed[], idx: number): TrendWindowInfo | null {
  if (idx < TREND_WINDOW_DAYS - 1 || idx >= dates.length) return null;
  const first = closes[idx - TREND_WINDOW_DAYS + 1]!;
  const last = closes[idx]!;
  return {
    state: fCmp(last, first) >= 0 ? 'UP' : 'DOWN',
    from: dates[idx - TREND_WINDOW_DAYS + 1]!,
    to: dates[idx]!,
    firstClose: fixedToString(first),
    lastClose: fixedToString(last),
  };
}

// ===== 次层：20 日已实现波动（平方偏差和为序，定点；可得替代层，非估值档）=====

/**
 * 序量 D = Σ_i (r_i − mean(r))²，r_i = C_i/C_{i−1} − 1（i 遍历窗口 19 个日收益，
 * 收益与均值 scale=10 截断，偏差/平方/求和精确）。与已实现方差单调同序；不开方。
 * 窗口不完整或窗口内收盘为零 → null（缺口，不推算）。
 */
export function dispersionAt(closes: Fixed[], idx: number): Fixed | null {
  if (idx < TREND_WINDOW_DAYS - 1 || idx >= closes.length) return null;
  const window = closes.slice(idx - TREND_WINDOW_DAYS + 1, idx + 1);
  const returns: Fixed[] = [];
  for (let i = 1; i < window.length; i++) {
    const ratio = fDiv(window[i]!, window[i - 1]!, 10);
    if (ratio === null) return null;
    returns.push(fSub(ratio, ONE));
  }
  let sum = ZERO;
  for (const r of returns) sum = fAdd(sum, r);
  const mean = fDiv(sum, { int: BigInt(returns.length), scale: 0 }, 10);
  if (mean === null) return null;
  let d = ZERO;
  for (const r of returns) {
    const dev = fSub(r, mean);
    d = fAdd(d, fMul(dev, dev));
  }
  return d;
}

export type VolTier = 'LOW' | 'MID' | 'HIGH';

/**
 * 波动三档：D < b1 → LOW；< b2 → MID；否则 HIGH（等分界值归上档，与市值档
 * marketCapTierOf 同约定）。bounds 倒序 / 输入缺失 → null（缺口，不推算）。
 */
export function volTierOf(dispersion: Fixed | null, bounds: [string, string] | null): VolTier | null {
  if (dispersion === null || bounds === null) return null;
  const b1 = parseFixed(bounds[0]);
  const b2 = parseFixed(bounds[1]);
  if (b1 === null || b2 === null || fCmp(b1, b2) > 0) return null;
  if (fCmp(dispersion, b1) < 0) return 'LOW';
  if (fCmp(dispersion, b2) < 0) return 'MID';
  return 'HIGH';
}

/** 波动分界 = 逐指数全史抽样点序量 D 的三等分位（次序统计量，不插值；同 groups.tercileBounds）。 */
export function volTierBoundsOf(dispersions: Array<Fixed | null>): [string, string] | null {
  return tercileBounds(dispersions.map((d) => (d === null ? null : fixedToString(d))));
}

// ===== 后续 1/5/20 日绝对收益 + 失效触发（前缀口径）=====

export type ForwardWindowStatus = 'OK' | 'WINDOW_INCOMPLETE';

export interface ForwardWindow {
  h: BroadbaseHorizon;
  status: ForwardWindowStatus;
  endDate: string | null;
  /** 绝对收益（定点字符串；status 非 OK 为 null）。 */
  absReturn: string | null;
}

export interface ForwardOutcome {
  windows: ForwardWindow[];
  invalidation: {
    thresholdPct: '5';
    reserved: true;
    /** 下跌侧触发：窗口内累计绝对收益 ≤ −5%（null = 零前缀不可判定）。 */
    downTriggered: boolean | null;
    /** 上涨侧触发：窗口内累计绝对收益 ≥ +5%（null = 零前缀不可判定）。 */
    upTriggered: boolean | null;
    firstDownDate: string | null;
    firstUpDate: string | null;
  };
  /** 已走完的窗口 K 线数（≤ 20）。 */
  forwardBars: number;
  /** forwardBars < 20（非缺口；触发判定在已完成前缀上有效）。 */
  windowIncomplete: boolean;
}

export function forwardOutcomeAt(dates: string[], closes: Fixed[], idx: number): ForwardOutcome {
  const base = closes[idx]!;
  const available = Math.max(0, Math.min(H_MAX, closes.length - 1 - idx));
  let downTriggered: boolean | null = null;
  let upTriggered: boolean | null = null;
  let firstDownDate: string | null = null;
  let firstUpDate: string | null = null;
  for (let k = 1; k <= available; k++) {
    const ratio = fDiv(closes[idx + k]!, base, 10);
    if (ratio === null) break; // 基准为零等异常：前缀到此为止（真实指数不出现）
    const e = fSub(ratio, ONE);
    if (downTriggered !== true && fCmp(e, fSub(ZERO, INVALIDATION_THRESHOLD)) <= 0) {
      downTriggered = true;
      firstDownDate = dates[idx + k]!;
    }
    if (upTriggered !== true && fCmp(e, INVALIDATION_THRESHOLD) >= 0) {
      upTriggered = true;
      firstUpDate = dates[idx + k]!;
    }
  }
  if (available > 0) {
    downTriggered ??= false;
    upTriggered ??= false;
  }
  const windows: ForwardWindow[] = BROADBASE_HORIZONS.map((h) => {
    if (idx + h < closes.length) {
      const ratio = fDiv(closes[idx + h]!, base, 10);
      return {
        h,
        status: ratio === null ? ('WINDOW_INCOMPLETE' as const) : ('OK' as const),
        endDate: dates[idx + h]!,
        absReturn: ratio === null ? null : fixedToString(fSub(ratio, ONE)),
      };
    }
    return { h, status: 'WINDOW_INCOMPLETE' as const, endDate: null, absReturn: null };
  });
  return {
    windows,
    invalidation: { thresholdPct: '5', reserved: true, downTriggered, upTriggered, firstDownDate, firstUpDate },
    forwardBars: available,
    windowIncomplete: available < H_MAX,
  };
}

// ===== 样本组装（两遍：先全史序量定分界，再逐月末时点定型）=====

export interface BroadbaseSample {
  indexCode: string;
  /** 状态判定时点（月末交易日，YYYY-MM-DD）。 */
  date: string;
  trend: TrendState | null;
  /** 20 日平方偏差和（定点字符串；null = 不可得，样本级缺口）。 */
  dispersion: string | null;
  volTier: VolTier | null;
  h1: string | null;
  h5: string | null;
  h20: string | null;
  invalidationDown: boolean | null;
  invalidationUp: boolean | null;
  forwardBars: number;
  windowIncomplete: boolean;
  dataGaps: string[];
}

export interface BroadbaseSampleBuild {
  samples: BroadbaseSample[];
  /** 本指数全史三等分位分界（定点字符串对；样本 < 2 → null）。 */
  volBounds: [string, string] | null;
  /** 构建（清洗 + 抽样）期具名缺口汇总。 */
  dataGaps: string[];
  /** 参与序列的有效 K 线数。 */
  barsUsable: number;
  firstDate: string | null;
  lastDate: string | null;
}

export function broadbaseSamplesOf(indexCode: string, bars: DailyBarInput[]): BroadbaseSampleBuild {
  const prep = prepareIndexSeries(indexCode, bars);
  const { dates, closes } = prep.series;
  const ends = monthEndIndices(dates);
  const dispersions = ends.map((i) => dispersionAt(closes, i));
  const volBounds = volTierBoundsOf(dispersions);
  const samples: BroadbaseSample[] = [];
  for (let j = 0; j < ends.length; j++) {
    const i = ends[j]!;
    const trend = trendWindowAt(dates, closes, i)?.state ?? null;
    const d = dispersions[j] ?? null;
    const fwd = forwardOutcomeAt(dates, closes, i);
    const windowOf = (h: BroadbaseHorizon): string | null => {
      const w = fwd.windows.find((x) => x.h === h);
      return w !== undefined && w.status === 'OK' ? w.absReturn : null;
    };
    samples.push({
      indexCode,
      date: dates[i]!,
      trend,
      dispersion: d === null ? null : fixedToString(d),
      volTier: volTierOf(d, volBounds),
      h1: windowOf(1),
      h5: windowOf(5),
      h20: windowOf(20),
      invalidationDown: fwd.invalidation.downTriggered,
      invalidationUp: fwd.invalidation.upTriggered,
      forwardBars: fwd.forwardBars,
      windowIncomplete: fwd.windowIncomplete,
      dataGaps: d === null ? ['DISPERSION_UNAVAILABLE'] : [],
    });
  }
  const gaps = new Set(prep.dataGaps);
  if (dispersions.some((d) => d === null)) gaps.add(`DISPERSION_UNAVAILABLE:${indexCode}`);
  return {
    samples,
    volBounds,
    dataGaps: [...gaps].sort(),
    barsUsable: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.length > 0 ? dates[dates.length - 1]! : null,
  };
}

// ===== 群组统计块（机械枚举；不足下限不产出，不降档）=====

export type BroadbaseLayerName = 'BASE' | 'TREND' | 'VOL_TIER';

export interface BroadbaseWindowStat {
  mean: string | null;
  median: string | null;
  n: number;
}

export interface BroadbaseStatBlock {
  indexCode: string;
  groupKey: string;
  path: string[];
  layers: BroadbaseLayerName[];
  sampleCount: number;
  stats: { h1: BroadbaseWindowStat; h5: BroadbaseWindowStat; h20: BroadbaseWindowStat };
  invalidation: { downTriggered: number; upTriggered: number; n: number; thresholdPct: '5'; reserved: true };
  incompleteWindows: { h1: number; h5: number; h20: number };
  nestedDeclaration: string;
  revisionNotice: string;
  valuationTierGapDeclaration: string;
  reservedParams: string[];
  dataGaps: string[];
  versionBinding: {
    methodVersion: string;
    adapterVersion: string;
    inputAvailableAtMax: string | null;
    materializedAt: string;
  };
}

export interface BroadbaseBuildOptions {
  minGroupSample: number;
  methodVersion: string;
  adapterVersion: string;
  inputAvailableAtMax: string | null;
  materializedAt: string;
}

export interface BroadbaseLibraryBuildResult {
  blocks: BroadbaseStatBlock[];
  totalSamples: number;
  dataGaps: string[];
  layerInputMissing: { trend: number; volTier: number };
}

function windowStatOf(samples: BroadbaseSample[], pick: (s: BroadbaseSample) => string | null): BroadbaseWindowStat {
  const values = samples
    .map((s) => pick(s))
    .filter((v): v is string => v !== null)
    .map((v) => parseFixed(v))
    .filter((v): v is Fixed => v !== null);
  if (values.length === 0) return { mean: null, median: null, n: 0 };
  const sorted = [...values].sort(fCmp);
  let sum = ZERO;
  for (const v of values) sum = fAdd(sum, v);
  const mean = fDiv(sum, { int: BigInt(values.length), scale: 0 }, 10);
  const mid = Math.floor(sorted.length / 2);
  let median: string | null;
  if (sorted.length % 2 === 1) {
    median = fixedToString(sorted[mid]!);
  } else {
    const m = fDiv(fAdd(sorted[mid - 1]!, sorted[mid]!), { int: 2n, scale: 0 }, 10);
    median = m === null ? null : fixedToString(m);
  }
  return { mean: mean === null ? null : fixedToString(mean), median, n: values.length };
}

function reservedParamsOf(opts: BroadbaseBuildOptions): string[] {
  return [
    `BROADBASE_INVALIDATION_THRESHOLD_PCT=${BROADBASE_INVALIDATION_THRESHOLD_PCT}（宽基失效阈值，预留值，P4 校准、P5 冻结，FREEZE-P0 §五）`,
    `MIN_GROUP_SAMPLE=${opts.minGroupSample}（群组样本下限，预留值，与个股库同源默认，P4 冻结）`,
    `TREND_WINDOW_DAYS=${TREND_WINDOW_DAYS}（趋势/波动窗口收盘日数，预留值）`,
    'VOL_TIER_BOUNDS（波动三档分界=逐指数自身全史三等分位，等分位预留值，重建时重算，P4/P5 校准冻结）',
    'SAMPLING=month-end（月末交易日抽样，预留口径；相邻月末 20 日窗口基本不重叠）',
  ];
}

function blockOf(
  indexCode: string,
  path: string[],
  layers: BroadbaseLayerName[],
  samples: BroadbaseSample[],
  opts: BroadbaseBuildOptions,
): BroadbaseStatBlock {
  const gaps = new Set<string>();
  let invN = 0;
  let invDown = 0;
  let invUp = 0;
  const incomplete = { h1: 0, h5: 0, h20: 0 };
  for (const s of samples) {
    if (s.h1 === null) incomplete.h1 += 1;
    if (s.h5 === null) incomplete.h5 += 1;
    if (s.h20 === null) incomplete.h20 += 1;
    if (s.invalidationDown !== null && s.invalidationUp !== null) {
      invN += 1;
      if (s.invalidationDown) invDown += 1;
      if (s.invalidationUp) invUp += 1;
    }
    for (const g of s.dataGaps) gaps.add(`${s.indexCode}@${s.date}:${g}`);
  }
  return {
    indexCode,
    groupKey: path.join('|'),
    path,
    layers,
    sampleCount: samples.length,
    stats: {
      h1: windowStatOf(samples, (s) => s.h1),
      h5: windowStatOf(samples, (s) => s.h5),
      h20: windowStatOf(samples, (s) => s.h20),
    },
    invalidation: {
      downTriggered: invDown,
      upTriggered: invUp,
      n: invN,
      thresholdPct: BROADBASE_INVALIDATION_THRESHOLD_PCT,
      reserved: true,
    },
    incompleteWindows: incomplete,
    nestedDeclaration: NESTED_GROUP_DECLARATION,
    revisionNotice: REVISION_NOTICE,
    valuationTierGapDeclaration: VALUATION_TIER_GAP_DECLARATION,
    reservedParams: reservedParamsOf(opts),
    dataGaps: [...gaps].sort(),
    versionBinding: {
      methodVersion: opts.methodVersion,
      adapterVersion: opts.adapterVersion,
      inputAvailableAtMax: opts.inputAvailableAtMax,
      materializedAt: opts.materializedAt,
    },
  };
}

/**
 * 全量宽基状态参照库构建（机械枚举，程序执行、无人工裁量）：
 * 逐指数 BASE（全部月末样本）→ TREND（UP/DOWN）→ TREND×VOL（LOW/MID/HIGH）；
 * 加入某层后样本数 ≥ minGroupSample 才进入并产出该节点块；子节点不足下限即停止下钻
 * （与 library.ts buildGroupLibrary 同构：不降档凑样本）。空指数不产出块（缺口合法产出）。
 */
export function buildBroadbaseLibrary(
  samplesByIndex: ReadonlyMap<string, BroadbaseSample[]>,
  opts: BroadbaseBuildOptions,
): BroadbaseLibraryBuildResult {
  const blocks: BroadbaseStatBlock[] = [];
  const gaps = new Set<string>();
  const layerInputMissing = { trend: 0, volTier: 0 };
  let totalSamples = 0;
  for (const code of [...samplesByIndex.keys()].sort()) {
    const samples = samplesByIndex.get(code) ?? [];
    totalSamples += samples.length;
    for (const s of samples) {
      if (s.trend === null) layerInputMissing.trend += 1;
      if (s.volTier === null) layerInputMissing.volTier += 1;
      for (const g of s.dataGaps) gaps.add(`${s.indexCode}@${s.date}:${g}`);
    }
    if (samples.length === 0) {
      gaps.add(`NO_SAMPLES:${code}`);
      continue;
    }
    blocks.push(blockOf(code, [`idx:${code}`, 'all-months'], ['BASE'], samples, opts));
    for (const t of ['DOWN', 'UP'] as const) {
      const trendSamples = samples.filter((s) => s.trend === t);
      if (trendSamples.length < opts.minGroupSample) continue;
      blocks.push(blockOf(code, [`idx:${code}`, `trend:${t}`], ['TREND'], trendSamples, opts));
      for (const v of ['HIGH', 'LOW', 'MID'] as const) {
        const volSamples = trendSamples.filter((s) => s.volTier === v);
        if (volSamples.length < opts.minGroupSample) continue;
        blocks.push(blockOf(code, [`idx:${code}`, `trend:${t}`, `vol:${v}`], ['TREND', 'VOL_TIER'], volSamples, opts));
      }
    }
  }
  return { blocks, totalSamples, dataGaps: [...gaps].sort(), layerInputMissing };
}

// ===== 持久化（broadbase_reference_library；DDL 自持，幂等）=====

/** 表结构（列结构参照 src/db/reference-migration.sql 同构；分表理由见模块头）。 */
export const BROADBASE_LIBRARY_DDL = `create table if not exists broadbase_reference_library (
  block_key                      text primary key,
  path                           jsonb not null,
  index_code                     text not null,
  sample_count                   integer not null,
  stats                          jsonb not null,
  nested_declaration             text not null,
  valuation_tier_gap_declaration text not null,
  created_at                     timestamptz not null default now()
)`;

/** 幂等应用宽基参照库迁移（只建自有新表）。 */
export async function applyBroadbaseMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(BROADBASE_LIBRARY_DDL);
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时忽略。
    }
    throw error;
  } finally {
    client.release();
  }
}

/** 统计块落库（upsert：block_key 恒可解析；版本绑定随 stats jsonb 更新，created_at 保留首建）。 */
export async function saveBroadbaseStats(pool: Pool, blocks: BroadbaseStatBlock[]): Promise<number> {
  let saved = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const b of blocks) {
      await client.query(
        `insert into broadbase_reference_library
          (block_key, path, index_code, sample_count, stats, nested_declaration, valuation_tier_gap_declaration)
         values ($1, $2::jsonb, $3, $4, $5::jsonb, $6, $7)
         on conflict (block_key) do update set
           path = excluded.path,
           index_code = excluded.index_code,
           sample_count = excluded.sample_count,
           stats = excluded.stats,
           nested_declaration = excluded.nested_declaration,
           valuation_tier_gap_declaration = excluded.valuation_tier_gap_declaration`,
        [
          b.groupKey,
          JSON.stringify(b.path),
          b.indexCode,
          b.sampleCount,
          JSON.stringify({ stats: b.stats, invalidation: b.invalidation, incompleteWindows: b.incompleteWindows, versionBinding: b.versionBinding, reservedParams: b.reservedParams, dataGaps: b.dataGaps }),
          b.nestedDeclaration,
          b.valuationTierGapDeclaration,
        ],
      );
      saved += 1;
    }
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 同上。
    }
    throw error;
  } finally {
    client.release();
  }
  return saved;
}

export interface BroadbaseLibraryRow {
  block_key: string;
  path: unknown;
  index_code: string;
  sample_count: number;
  stats: unknown;
  nested_declaration: string;
  valuation_tier_gap_declaration: string;
  created_at: Date;
}

export async function loadBroadbaseLibraryRows(pool: Pool): Promise<BroadbaseLibraryRow[]> {
  const res = await pool.query(
    'select block_key, path, index_code, sample_count, stats, nested_declaration, valuation_tier_gap_declaration, created_at from broadbase_reference_library order by block_key asc',
  );
  return res.rows as BroadbaseLibraryRow[];
}
