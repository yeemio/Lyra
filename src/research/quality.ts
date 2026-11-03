/**
 * Lyra · 财报质量确定性指标库（B 类 B4 / W35: code-writer-pro）。
 * 需求：docs/REQUIREMENTS-BACKLOG.md B4（应计比率的确定性替代指标；命名避免定性指控）。
 * 纯本地计算零新数据源：只消费既有 FINANCIAL（BaoStock profit/growth）与 BALANCE
 * （东财 embalance@p1）时点事实，全部公式常量写死、scale-12 定点（复用
 * src/settlement/decimal.ts 冻结内核，SETTLEMENT-REVIEW 未决 3 落地值）。
 *
 * 指标与口径（全部中性命名：背离度/比率/趋势；定性判断属方法正文，本库不出）：
 * 1. 盈利与收入增长背离度 = YOYNI(报告期 T) − REVENUE_YOY(T)。
 *    - YOYNI：BaoStock growth 行原值（比值口径，如 "0.013653"）；
 *    - REVENUE_YOY：growth 源无营收同比字段（W14 实证，events/detect.ts 同款具名缺口）；
 *      派发预设 BALANCE.TOTAL_OPERATE_INCOME 经 W35 实库探测**不在资产负债表行内**
 *      （2026-10-25 查 600519 BALANCE 全 322 列无营业收入科目——资产负债表本无该科目），
 *      回落到 FINANCIAL(profit).MBRevenue 序列同报告期对齐派生：T 与 T−1 年
 *      （同月日跨年）两侧均在且非空且上年非 0 才算，任一不满足该期 null；
 *    - 应计比率的现金流口径不可算（无现金流量表数据源），此为派发明示的替代口径。
 * 2. 净利率趋势：FINANCIAL(profit).npMargin 原样值（as-reported 比值）近 8 期序列 + 方向。
 * 3. 资产负债率趋势：BALANCE.TOTAL_LIABILITIES / TOTAL_ASSETS（两列相除，scale-12 定点；
 *    源无比率列，比率由本库算——W30 实证两列均在东财行内）近 8 期序列 + 方向。
 * 4. 商誉强度：BALANCE.GOODWILL / TOTAL_PARENT_EQUITY 近 8 期序列（D7 已有原始材料，
 *    本库只算比率，供 D1/D7 双引用；分母口径冻结为归母权益，与派发一致）。
 *
 * 纪律：
 * - null 语义：缺输入列/空值/分母 0 ⇒ 该期指标 null，绝不为 0（源未披露与零值不作区分）；
 * - as-of：函数自过滤 availableAt <= asOf，晚于截点的事实不进任何序列；
 * - 修订口径：同报告期多行取 availableAt 最新（events/detect.ts 同法；supersedes 链解析
 *   后仍并存的分叉行按此确定性收敛，tie-break factId 大者胜）；
 * - 报告期对齐：报告期须为标准季末（03-31/06-30/09-30/12-31），非季末行跳过并计数；
 *   同比配对只认同月日跨年，错位（相邻季度等）一律拒绝配对；
 * - 窗口：as-of 可见最近 8 个报告期（不足如实），序列升序（旧→新）；同比的上年行
 *   只作输入不占窗口；
 * - 指标 value 一律 = 最新报告期该指标的值（最新期不可算则 value=null，历史可算值在
 *   series 中可见，不回填）。
 */
import type { TimePointFact } from '../contracts.js';
import {
  DEC_ONE,
  DEC_ZERO,
  decCmp,
  decDiv,
  decFrom,
  decIsZero,
  decSub,
  decToString,
  type Dec,
} from '../settlement/decimal.js';

/** 本库版本（消费方登记用）。 */
export const QUALITY_LIBRARY_VERSION = 'research-quality@b4-v1';
/** 序列窗口：as-of 可见最近 8 个报告期（inputs.ts RECENT_REPORT_PERIODS 同款口径，本地冻结不跨模块依赖）。 */
export const QUALITY_WINDOW_PERIODS = 8;

// ===== 公式常量（写死，随结果携带 formulaRef）=====

export const FORMULA_EARNING_REVENUE_DIVERGENCE =
  'EARNING_REVENUE_GROWTH_DIVERGENCE = YOYNI(T) - REVENUE_YOY(T)；' +
  'REVENUE_YOY = MBRevenue(T)/MBRevenue(T-1y) - 1（同报告期对齐：同月日跨年；' +
  '错位/缺期/任一侧为空/上年为 0 ⇒ 该期 null）；YOYNI 为 growth 行原值（比值口径）';
export const FORMULA_NET_MARGIN_TREND =
  'NET_MARGIN_TREND = FINANCIAL(profit).npMargin 原样值（as-reported 比值，scale-12 定点归一）';
export const FORMULA_LIABILITY_ASSET_RATIO =
  'LIABILITY_TO_ASSET_RATIO = BALANCE.TOTAL_LIABILITIES / BALANCE.TOTAL_ASSETS' +
  '（两列相除 scale-12 定点 half-up；缺列/空值/分母 0 ⇒ 该期 null）';
export const FORMULA_GOODWILL_INTENSITY =
  'GOODWILL_INTENSITY = BALANCE.GOODWILL / BALANCE.TOTAL_PARENT_EQUITY' +
  '（GOODWILL null/缺失 ⇒ 该期 null 而非 0；分母缺/为 0 ⇒ null）';

/** BALANCE 行报告期列名（embalance 桥自加 ISO 前缀列；不 import 适配器模块以保持本库零 DB/进程依赖）。 */
const BALANCE_REPORT_DATE_ISO = 'REPORT_DATE_ISO';

export class QualityError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'QualityError';
  }
}

// ===== 结果对象 =====

export interface TrendPoint {
  statDate: string;
  /** scale-12 定点十进制字符串；null ⇔ 该期缺输入（绝不为 0 冒充）。 */
  value: string | null;
}

export type TrendDirection = 'UP' | 'DOWN' | 'FLAT';

export interface TrendIndicator {
  /** 最新报告期值（非最近可算值；最新期不可算为 null，见模块头纪律）。 */
  value: string | null;
  /** 实际纳入序列的报告期数（≤ windowLimit，不足如实）。 */
  window: number;
  formulaRef: string;
  series: TrendPoint[];
  /** 首非空值 vs 末非空值的方向；非空值 < 2 时 null。 */
  direction: TrendDirection | null;
  /** 末非空 − 首非空（scale-12 定点字符串）；非空值 < 2 时 null。 */
  delta: string | null;
  directionBasis: 'WINDOW_FIRST_NON_NULL_VS_LAST_NON_NULL';
  notes: string[];
}

export interface DivergencePoint {
  statDate: string;
  /** 净利同比（growth.YOYNI 原值归一）；该期无 growth 行或值为空则 null。 */
  yoyNi: string | null;
  /** 营收同比（MBRevenue 同报告期对齐派生）；不可算则 null。 */
  revenueYoY: string | null;
  /** yoyNi − revenueYoY；任一侧 null 则 null。 */
  value: string | null;
}

export interface DivergenceIndicator {
  value: string | null;
  window: number;
  formulaRef: string;
  series: DivergencePoint[];
  notes: string[];
}

export interface QualityIndicators {
  libraryVersion: string;
  asOf: string;
  windowLimit: number;
  earningRevenueGrowthDivergence: DivergenceIndicator;
  netMarginTrend: TrendIndicator;
  liabilityToAssetTrend: TrendIndicator;
  goodwillIntensity: TrendIndicator;
}

// ===== 内部工具 =====

const QUARTER_END_RE = /^\d{4}-(03-31|06-30|09-30|12-31)$/;

interface ParseCounters {
  malformed: number;
}

function tvOf(fact: TimePointFact): Record<string, unknown> {
  return (fact.typedValue ?? {}) as Record<string, unknown>;
}

function visibleAsOf(fact: TimePointFact, asOfMs: number): boolean {
  const t = new Date(fact.availableAt).getTime();
  return Number.isFinite(t) && t <= asOfMs;
}

/** 标准季末报告期（YYYY-MM-DD 且为 03-31/06-30/09-30/12-31）；否则 null（行跳过并计数）。 */
function quarterEndOf(value: unknown): string | null {
  return typeof value === 'string' && QUARTER_END_RE.test(value) ? value : null;
}

/** 数值列 → Dec。null/undefined/空串 ⇒ null（缺值）；格式不可解析 ⇒ null + 计数（不猜）。 */
function decOf(value: unknown, counters: ParseCounters): Dec | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      counters.malformed += 1;
      return null;
    }
  } else if (typeof value === 'string') {
    if (value.trim() === '') return null;
  } else {
    counters.malformed += 1;
    return null;
  }
  try {
    return decFrom(typeof value === 'string' ? value.trim() : value);
  } catch {
    counters.malformed += 1;
    return null;
  }
}

/** 同报告期多行收敛：availableAt 最新胜；tie-break factId 大者（确定性）。 */
function keepLatestRow(map: Map<string, TimePointFact>, statDate: string, fact: TimePointFact): void {
  const cur = map.get(statDate);
  if (cur === undefined) {
    map.set(statDate, fact);
    return;
  }
  const ta = new Date(cur.availableAt).getTime();
  const tb = new Date(fact.availableAt).getTime();
  if (tb > ta || (tb === ta && fact.factId > cur.factId)) map.set(statDate, fact);
}

/** as-of 可见报告期全集 → 最近 limit 期，升序（旧→新）输出。 */
function windowPeriods(periods: Iterable<string>, limit: number): string[] {
  const desc = [...periods].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return desc.slice(0, limit).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 同比配对的上年报告期：同月日跨年（唯一合法配对；相邻季度等错位由查表落空自然拒绝）。 */
function priorYear(statDate: string): string {
  const year = Number(statDate.slice(0, 4)) - 1;
  return `${String(year).padStart(4, '0')}${statDate.slice(4)}`;
}

interface TrendComputation {
  series: TrendPoint[];
  direction: TrendDirection | null;
  delta: string | null;
  latestValue: string | null;
}

function buildTrend(periods: string[], valueOf: (statDate: string) => Dec | null): TrendComputation {
  const decs: (Dec | null)[] = periods.map((sd) => valueOf(sd));
  const series: TrendPoint[] = periods.map((sd, i) => ({
    statDate: sd,
    value: decs[i] === null ? null : decToString(decs[i] as Dec),
  }));
  let direction: TrendDirection | null = null;
  let delta: string | null = null;
  const nonNull = decs.filter((d): d is Dec => d !== null);
  if (nonNull.length >= 2) {
    const first = nonNull[0] as Dec;
    const last = nonNull[nonNull.length - 1] as Dec;
    const d = decSub(last, first);
    delta = decToString(d);
    direction = decCmp(d, DEC_ZERO) > 0 ? 'UP' : decCmp(d, DEC_ZERO) < 0 ? 'DOWN' : 'FLAT';
  }
  const lastPoint = series[series.length - 1] ?? null;
  return { series, direction, delta, latestValue: lastPoint === null ? null : lastPoint.value };
}

// ===== 主入口 =====

/**
 * 财报质量确定性指标（纯函数；调用方传入该股的 FINANCIAL / BALANCE 事实全集，
 * 本函数按 asOf 自过滤——晚于截点的事实不进任何序列）。
 */
export function qualityIndicators(
  financialFacts: TimePointFact[],
  balanceFacts: TimePointFact[],
  asOf: string | Date,
): QualityIndicators {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new QualityError('INVALID_ASOF', String(asOf));

  // ---- 报告期 → 最新行 收敛 ----
  const profitRows = new Map<string, TimePointFact>();
  const growthRows = new Map<string, TimePointFact>();
  let malformedFinancialRows = 0;
  for (const fact of financialFacts) {
    if (fact.factKind !== 'FINANCIAL' || !visibleAsOf(fact, asOfMs)) continue;
    const v = tvOf(fact);
    const query = v.bsQuery;
    if (query !== 'profit' && query !== 'growth') continue;
    const sd = quarterEndOf(v.statDate);
    if (sd === null) {
      malformedFinancialRows += 1;
      continue;
    }
    keepLatestRow(query === 'profit' ? profitRows : growthRows, sd, fact);
  }
  const balanceRows = new Map<string, TimePointFact>();
  let malformedBalanceRows = 0;
  for (const fact of balanceFacts) {
    if (fact.factKind !== 'BALANCE' || !visibleAsOf(fact, asOfMs)) continue;
    const sd = quarterEndOf(tvOf(fact)[BALANCE_REPORT_DATE_ISO]);
    if (sd === null) {
      malformedBalanceRows += 1;
      continue;
    }
    keepLatestRow(balanceRows, sd, fact);
  }

  const finPeriods = windowPeriods(new Set([...profitRows.keys(), ...growthRows.keys()]), QUALITY_WINDOW_PERIODS);
  const balPeriods = windowPeriods(balanceRows.keys(), QUALITY_WINDOW_PERIODS);

  // ---- 指标 1：盈利与收入增长背离度 ----
  const divCounters: ParseCounters = { malformed: 0 };
  let priorMissing = 0;
  let revenueSideEmpty = 0;
  let revenueDenZero = 0;
  const divSeries: DivergencePoint[] = finPeriods.map((sd) => {
    const growth = growthRows.get(sd) ?? null;
    const yoyNi = growth === null ? null : decOf(tvOf(growth).YOYNI, divCounters);
    let revenueYoY: Dec | null = null;
    const curRow = profitRows.get(sd) ?? null;
    const prevRow = profitRows.get(priorYear(sd)) ?? null;
    if (curRow === null || prevRow === null) {
      priorMissing += 1;
    } else {
      const cur = decOf(tvOf(curRow).MBRevenue, divCounters);
      const prev = decOf(tvOf(prevRow).MBRevenue, divCounters);
      if (cur === null || prev === null) revenueSideEmpty += 1;
      else if (decIsZero(prev)) revenueDenZero += 1;
      else revenueYoY = decSub(decDiv(cur, prev), DEC_ONE);
    }
    return {
      statDate: sd,
      yoyNi: yoyNi === null ? null : decToString(yoyNi),
      revenueYoY: revenueYoY === null ? null : decToString(revenueYoY),
      value: yoyNi !== null && revenueYoY !== null ? decToString(decSub(yoyNi, revenueYoY)) : null,
    };
  });
  const divNotes: string[] = [
    '口径：YOYNI 为 BaoStock growth 行原值（比值口径，最新修订行）；growth 源无营收同比字段（W14 实证），'
      + '营收同比由 FINANCIAL(profit).MBRevenue 同报告期对齐派生（上年行只作输入不占 8 期窗口）；'
      + 'BALANCE 行内无营业收入科目（W35 实库探测），不参与营收口径。',
    'null 语义：任一侧缺失/为空/上年营收为 0/报告期错位 ⇒ 该期背离度 null（不为 0）；'
      + 'value 为最新报告期的值，最新期不可算时 value=null，历史可算值见 series（不回填）。',
    '应计比率的现金流口径不可算（无现金流量表数据源），本指标为派发冻结的替代口径（盈利与收入增长背离度）。',
  ];
  if (growthRows.size === 0) divNotes.push('无 as-of 可见 growth 行：YOYNI 全 null');
  if (profitRows.size === 0) divNotes.push('无 as-of 可见 profit 行：营收同比全 null');
  if (priorMissing > 0) divNotes.push(`上年对齐行缺失（同月日跨年无 profit 行）${String(priorMissing)} 期：该期营收同比 null`);
  if (revenueSideEmpty > 0) divNotes.push(`MBRevenue 任一侧为空/缺失 ${String(revenueSideEmpty)} 期：该期营收同比 null（Q1/Q3 报告源常不披露该字段，如实为空）`);
  if (revenueDenZero > 0) divNotes.push(`上年 MBRevenue 为 0 ${String(revenueDenZero)} 期：除零拒绝，该期营收同比 null`);
  if (divCounters.malformed > 0) divNotes.push(`数值列不可解析 ${String(divCounters.malformed)} 处按 null（不猜）`);
  if (malformedFinancialRows > 0) divNotes.push(`非标准季末 statDate 跳过 ${String(malformedFinancialRows)} 行`);
  const lastDiv = divSeries[divSeries.length - 1] ?? null;
  const divergence: DivergenceIndicator = {
    value: lastDiv === null ? null : lastDiv.value,
    window: divSeries.length,
    formulaRef: FORMULA_EARNING_REVENUE_DIVERGENCE,
    series: divSeries,
    notes: divNotes,
  };

  // ---- 指标 2：净利率趋势 ----
  const npmCounters: ParseCounters = { malformed: 0 };
  const npmTrend = buildTrend(finPeriods, (sd) => {
    const row = profitRows.get(sd);
    if (row === undefined) return null;
    return decOf(tvOf(row).npMargin, npmCounters);
  });
  const npmNotes: string[] = [
    '口径：npMargin 为 FINANCIAL(profit) 行原值（BaoStock as-reported，比值口径，最新修订行）；'
      + '序列为 as-of 可见最近报告期（≤ 8 期，不足如实）；null ⇔ 该期无 profit 行或字段为空。',
  ];
  if (npmCounters.malformed > 0) npmNotes.push(`npMargin 不可解析 ${String(npmCounters.malformed)} 处按 null（不猜）`);
  if (malformedFinancialRows > 0) npmNotes.push(`非标准季末 statDate 跳过 ${String(malformedFinancialRows)} 行`);
  const netMarginTrend: TrendIndicator = {
    value: npmTrend.latestValue,
    window: npmTrend.series.length,
    formulaRef: FORMULA_NET_MARGIN_TREND,
    series: npmTrend.series,
    direction: npmTrend.direction,
    delta: npmTrend.delta,
    directionBasis: 'WINDOW_FIRST_NON_NULL_VS_LAST_NON_NULL',
    notes: npmNotes,
  };

  // ---- 指标 3：资产负债率趋势 ----
  const laCounters: ParseCounters = { malformed: 0 };
  let laColMissing = 0;
  let laDenZero = 0;
  const laTrend = buildTrend(balPeriods, (sd) => {
    const row = balanceRows.get(sd);
    if (row === undefined) return null;
    const v = tvOf(row);
    const tl = decOf(v.TOTAL_LIABILITIES, laCounters);
    const ta = decOf(v.TOTAL_ASSETS, laCounters);
    if (tl === null || ta === null) {
      laColMissing += 1;
      return null;
    }
    if (decIsZero(ta)) {
      laDenZero += 1;
      return null;
    }
    return decDiv(tl, ta);
  });
  const laNotes: string[] = [
    '口径：比率由本库计算（源无比率列）：TOTAL_LIABILITIES / TOTAL_ASSETS，scale-12 定点 half-up；'
      + '行取报告期最新修订（embalance@p1，报告期列 REPORT_DATE_ISO）。',
  ];
  if (laColMissing > 0) laNotes.push(`任一侧缺列/为空 ${String(laColMissing)} 期：该期比率 null（不为 0）`);
  if (laDenZero > 0) laNotes.push(`TOTAL_ASSETS 为 0 ${String(laDenZero)} 期：除零拒绝，该期 null`);
  if (laCounters.malformed > 0) laNotes.push(`数值列不可解析 ${String(laCounters.malformed)} 处按 null（不猜）`);
  if (malformedBalanceRows > 0) laNotes.push(`非标准季末 REPORT_DATE_ISO 跳过 ${String(malformedBalanceRows)} 行`);
  const liabilityToAssetTrend: TrendIndicator = {
    value: laTrend.latestValue,
    window: laTrend.series.length,
    formulaRef: FORMULA_LIABILITY_ASSET_RATIO,
    series: laTrend.series,
    direction: laTrend.direction,
    delta: laTrend.delta,
    directionBasis: 'WINDOW_FIRST_NON_NULL_VS_LAST_NON_NULL',
    notes: laNotes,
  };

  // ---- 指标 4：商誉强度 ----
  const gwCounters: ParseCounters = { malformed: 0 };
  let gwNumeratorMissing = 0;
  let gwDenInvalid = 0;
  const gwTrend = buildTrend(balPeriods, (sd) => {
    const row = balanceRows.get(sd);
    if (row === undefined) return null;
    const v = tvOf(row);
    const gw = decOf(v.GOODWILL, gwCounters);
    const pe = decOf(v.TOTAL_PARENT_EQUITY, gwCounters);
    if (gw === null) {
      gwNumeratorMissing += 1;
      return null;
    }
    if (pe === null || decIsZero(pe)) {
      gwDenInvalid += 1;
      return null;
    }
    return decDiv(gw, pe);
  });
  const gwNotes: string[] = [
    '口径：GOODWILL / TOTAL_PARENT_EQUITY（分母冻结为归母股东权益，派发口径；TOTAL_EQUITY 候选分母'
      + '属研究语义不由本库裁定，见 D7 材料）；与 D7 商誉原始材料同源，本库只算比率（D1/D7 双引用）。',
    'null 语义：GOODWILL 为 null/缺失 ⇒ 该期比率 null 而非 0（源未披露商誉与零商誉不作区分）；'
      + '分母缺/为 0 ⇒ null。',
  ];
  if (gwNumeratorMissing > 0) gwNotes.push(`GOODWILL null/缺失 ${String(gwNumeratorMissing)} 期：比率 null（非 0）`);
  if (gwDenInvalid > 0) gwNotes.push(`TOTAL_PARENT_EQUITY 缺/为 0 ${String(gwDenInvalid)} 期：比率 null`);
  if (gwCounters.malformed > 0) gwNotes.push(`数值列不可解析 ${String(gwCounters.malformed)} 处按 null（不猜）`);
  if (malformedBalanceRows > 0) gwNotes.push(`非标准季末 REPORT_DATE_ISO 跳过 ${String(malformedBalanceRows)} 行`);
  const goodwillIntensity: TrendIndicator = {
    value: gwTrend.latestValue,
    window: gwTrend.series.length,
    formulaRef: FORMULA_GOODWILL_INTENSITY,
    series: gwTrend.series,
    direction: gwTrend.direction,
    delta: gwTrend.delta,
    directionBasis: 'WINDOW_FIRST_NON_NULL_VS_LAST_NON_NULL',
    notes: gwNotes,
  };

  return {
    libraryVersion: QUALITY_LIBRARY_VERSION,
    asOf: new Date(asOfMs).toISOString(),
    windowLimit: QUALITY_WINDOW_PERIODS,
    earningRevenueGrowthDivergence: divergence,
    netMarginTrend,
    liabilityToAssetTrend,
    goodwillIntensity,
  };
}
