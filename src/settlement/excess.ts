/**
 * Lyra · 逐日累计超额序列（P3 W13: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md SR-3.3（窗口计时：参考价日=第 1 个有成交交易日，
 * 窗口结束日=第 20 个该股有成交的交易日，停牌日不计时）/ SR-3.4（逐日累计超额序列：
 * e_d = (P_d_close/P_ref − 1) − (I_d_close/I_ref − 1)；MAE、失效触发、e_window 三字段
 * 均取自该序列，不另行计算口径）/ SR-3.5（行业基准按结论资料截点当时申万版本冻结）；
 * docs/specs/ASHARE-RULES.md §7（后复权=原始价×复权因子链，本层自算，不采信数据源
 * 复权价列；两时点：事件统计按公告日，价格计算按除权日）。
 *
 * 复权因子链（自算，核心实现声明）：
 * - 除权日清单 = ADJUST_FACTOR 事实的 dividOperateDate（事件日期，唯一采信的字段）；
 * - 每事件因子 r(e) = close(e 前最近有成交日) / preclose(e 日或其后首个有成交日)——
 *   交易所除权除息参考价（preclose 字段）与前一收盘的精确十进制定点比，非数据源复权列
 *   （实测对 600519 全部 31 事件与数据源累计 backAdjustFactor 链差 ≤ 3.9e-7 相对量级，
 *   即 6 位小数舍入差；含 2023-06-30/07-03 重复事件行时后者 r 恰为 1，天然免疫）；
 * - F(x) = Π r(e)，e ≤ x——**全链重算**：每次从该股全部事件（上市至 x）重算累积乘积，
 *   参考价日与窗口各日都用各自的全链因子换算成后复权价再作比（P_d×F(d) / P_ref×F(ref)），
 *   不做"窗口前段原始价、窗口后段乘因子"的逐段拼接——除权日落在窗口内时全链在两侧
 *   同时生效（F(d)/F(ref) 恰为窗口内事件链），除权日在参考价日之前时 F(ref) 与 F(d)
 *   同基消去（原始价比即可），两条路径同一实现，无分支拼接。
 *
 * 行业基准身份（SR-3.5 + W7 冻结语义）：INDUSTRY_CLASS_VERSION（sw@p1 轴）按 as-of
 * 截点取"区间含截点的链头行"，行前缀在**读取窗口体系**下解释——2021 窗口（截点 ≥
 * 2021-07-30）用 SW2021_PREFIX_L1，2014 窗口（2014-02-21 ≤ 截点 < 2021-07-30）用
 * SW2014_PREFIX_L1（跨体系携带行，如 600519 2001 行在 2014 窗口按前缀 34 → 801120）；
 * 表为 W7 冻结核验映射（src/adapters/sw.ts，只读依赖）。pre2014 窗口无核验映射 → null。
 */
import type { Pool } from 'pg';
import { asOfFacts } from '../pintime/facts.js';
import { SW_2014_EFFECTIVE, SW2014_PREFIX_L1, SW_2021_CLASSIFY_EFFECTIVE, SW2021_PREFIX_L1 } from '../adapters/sw.js';
import {
  DEC_ONE,
  SettlementError,
  decDiv,
  decFrom,
  decMul,
  decSub,
  decToString,
  type Dec,
} from './decimal.js';
import { countTradingDaysBetween, loadDailyBars, loadTradingDays, type DailyBarView } from './reference.js';

export const DEFAULT_WINDOW = 20; // SR-3.3：20 个该股有成交交易日

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ===== 行业基准冻结（SR-3.5）=====

export type SwWindowSystem = 'pre2014' | '2014' | '2021';

/** 读取窗口体系（按截点日，与铸造体系同边界；W7 冻结：前缀按读取窗口体系解释）。 */
export function swWindowSystem(cutoffDay: string): SwWindowSystem {
  if (cutoffDay >= SW_2021_CLASSIFY_EFFECTIVE) return '2021';
  if (cutoffDay >= SW_2014_EFFECTIVE) return '2014';
  return 'pre2014';
}

export interface IndustryBenchmark {
  subject: string;
  /** 截点当时归属的申万一级行业指数代码（如 801080）。 */
  industryIndexCode: string;
  /** 读取窗口体系（截点当时申万版本：2014 / 2021）。 */
  system: '2014' | '2021';
  /** 链头行的铸造体系（携带行早于读取窗口体系）。 */
  mintedSystem: string;
  /** 链头行行业代码（前缀供审计重放）。 */
  industryCode: string;
  /** l1IndexCode 来源：ROW=链头行自带；WINDOW_TABLE=按读取窗口体系前缀映射（携带行）。 */
  l1IndexCodeSource: 'ROW' | 'WINDOW_TABLE';
  /** 链头行 factId。 */
  factId: string;
}

/**
 * 截点当时申万一级行业指数身份（SR-3.5：结算只读取冻结值——as-of 截点解析可重放）。
 * 无区间含截点的申万轴行、pre2014 窗口、或前缀无核验映射 → null（具名登记于调用方）。
 */
export async function industryBenchmarkAt(
  pool: Pool,
  args: { subject: string; cutoff: string | Date; asOf?: Date },
): Promise<IndustryBenchmark | null> {
  const cutoffDate = args.cutoff instanceof Date ? args.cutoff : new Date(args.cutoff);
  if (Number.isNaN(cutoffDate.getTime())) {
    throw new SettlementError('DATE_INVALID', `cutoff: ${String(args.cutoff)}`);
  }
  const cutoffMs = cutoffDate.getTime();
  const cutoffDay = new Date(cutoffMs + 8 * 3600_000).toISOString().slice(0, 10); // Asia/Shanghai 日
  const windowSystem = swWindowSystem(cutoffDay);
  if (windowSystem === 'pre2014') return null; // pre2014 窗口无核验映射（2015 前研究窗口外）
  const system: '2014' | '2021' = windowSystem;
  const facts = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: args.subject,
    factKind: 'INDUSTRY_CLASS_VERSION',
    asOf: cutoffDate,
  });
  // sw@p1 轴行带「体系」字段；csrc@current 轴（classVersion）不参与申万基准选择。
  const swRows = facts.filter((f) => typeof (f.typedValue as Record<string, unknown>).体系 === 'string');
  const covering = swRows.filter((f) => {
    const from = f.validFrom === null ? null : new Date(f.validFrom).getTime();
    const to = f.validTo === null ? null : new Date(f.validTo).getTime();
    if (from !== null && from > cutoffMs) return false;
    if (to !== null && cutoffMs >= to) return false;
    return true;
  });
  if (covering.length === 0) return null;
  // 入库构造的区间按股互斥；多行并存（数据异常）时确定性取：体系同读取窗口优先 → validFrom 最新。
  covering.sort((a, b) => {
    const ra = (a.typedValue as Record<string, unknown>).体系 === system ? 0 : 1;
    const rb = (b.typedValue as Record<string, unknown>).体系 === system ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const fa = new Date(a.validFrom ?? a.availableAt).getTime();
    const fb = new Date(b.validFrom ?? b.availableAt).getTime();
    if (fa !== fb) return fb - fa;
    return a.factId < b.factId ? -1 : 1;
  });
  const head = covering[0] as (typeof covering)[number];
  const tv = head.typedValue as Record<string, unknown>;
  const mintedSystem = String(tv.体系);
  const industryCode = typeof tv.行业代码 === 'string' ? (tv.行业代码 as string) : '';
  let l1: string | null = null;
  let source: IndustryBenchmark['l1IndexCodeSource'] = 'WINDOW_TABLE';
  if (mintedSystem === system) {
    l1 = typeof tv.l1IndexCode === 'string' && tv.l1IndexCode.length > 0 ? (tv.l1IndexCode as string) : null;
    source = 'ROW';
  } else if (system === '2021') {
    l1 = SW2021_PREFIX_L1[industryCode.slice(0, 2)] ?? null;
  } else if (system === '2014') {
    l1 = SW2014_PREFIX_L1[industryCode.slice(0, 2)] ?? null;
  }
  if (l1 === null) return null;
  return { subject: args.subject, industryIndexCode: l1, system, mintedSystem, industryCode, l1IndexCodeSource: source, factId: head.factId };
}

// ===== 指数行情视图（SW_INDEX_BAR）=====

export interface IndexBarView {
  factId: string;
  date: string;
  open: string;
  close: string;
}

export function toIndexBarView(typedValue: unknown, factId: string): IndexBarView {
  const v = typedValue as Record<string, unknown>;
  const date = typeof v.日期 === 'string' && DATE_RE.test(v.日期) ? (v.日期 as string) : null;
  if (date === null) {
    throw new SettlementError('BAR_FIELD_INVALID', `SW_INDEX_BAR ${factId} 日期: ${String(v.日期)}`);
  }
  // jsonb number（pg float64）经 String() 最短往返表示精确取回（指数点位 ≤ 7 位有效数字）。
  const open = decFrom(v.开盘 as string | number, `SW_INDEX_BAR ${factId} 开盘`);
  const close = decFrom(v.收盘 as string | number, `SW_INDEX_BAR ${factId} 收盘`);
  return { factId, date, open: decToString(open), close: decToString(close) };
}

/** 行业指数 as-of 可见行情（date → 行视图）。 */
export async function loadIndexBars(pool: Pool, industryIndexCode: string, asOf: Date): Promise<Map<string, IndexBarView>> {
  const facts = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: industryIndexCode,
    factKind: 'SW_INDEX_BAR',
    asOf,
  });
  const byDate = new Map<string, IndexBarView>();
  for (const f of facts) {
    const bar = toIndexBarView(f.typedValue, f.factId);
    const existing = byDate.get(bar.date);
    if (existing !== undefined && existing.factId !== bar.factId) {
      throw new SettlementError('BAR_DATE_CONFLICT', `SW_INDEX_BAR ${industryIndexCode} ${bar.date} 多事实（${existing.factId} / ${bar.factId}）`);
    }
    byDate.set(bar.date, bar);
  }
  return byDate;
}

// ===== 复权因子链（自算，ASHARE-RULES §7）=====

export interface FactorEvent {
  /** 除权日（YYYY-MM-DD）。 */
  day: string;
  /** 事件因子 r(e)（scale-12 定点字符串）。 */
  ratio: string;
  /** r(e) 的分子：e 前最近有成交日收盘（原始价；上市基准事件为 null）。 */
  prevClose: string | null;
  /** r(e) 的分母：e 日或其后首个有成交日 preclose（原始价；上市基准事件为 null）。 */
  preclose: string | null;
}

export interface FactorChain {
  /** 全部事件（升序；含参考价日之前的事件——全链口径）。 */
  events: FactorEvent[];
  /** F(x) = Π r(e)，e ≤ x；无事件 ≤ x 时为 1。 */
  factorAt(day: string): Dec;
  factorAtString(day: string): string;
}

/** 事件日期装载：ADJUST_FACTOR 事实只取 dividOperateDate/divideOperateDate（as-of 链头解析）。 */
export async function loadFactorEventDates(pool: Pool, subject: string, asOf: Date): Promise<string[]> {
  const facts = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: subject, factKind: 'ADJUST_FACTOR', asOf });
  const dates = new Set<string>();
  for (const f of facts) {
    const v = f.typedValue as Record<string, unknown>;
    const d = typeof v.dividOperateDate === 'string' ? v.dividOperateDate : typeof v.divideOperateDate === 'string' ? v.divideOperateDate : null;
    if (d === null || !DATE_RE.test(d)) {
      throw new SettlementError('FACTOR_INPUT_INVALID', `ADJUST_FACTOR ${f.factId} dividOperateDate: ${String(d)}`);
    }
    dates.add(d);
  }
  return [...dates].sort();
}

/**
 * 构造全链因子（纯函数）：r(e) = close(最后有成交日 < e) / preclose(首个有成交日 ≥ e)。
 * e 前无有成交日（上市基准事件）→ r=1；事件晚于最后一根有成交行情 → 与任何 ≤ 末日的
 * F(x) 无关，跳过（不猜）。分母为零/字段缺失 → 具名错误（SR-10.4 结算异常，不静默）。
 */
export function buildFactorChain(bars: Map<string, DailyBarView>, eventDates: readonly string[]): FactorChain {
  const tradedDates = [...bars.values()].filter((b) => b.tradestatus === '1').map((b) => b.date).sort();
  if (tradedDates.length === 0) {
    throw new SettlementError('FACTOR_INPUT_INVALID', '无有成交行情行，无法构造因子链');
  }
  const lastTradedDate = tradedDates[tradedDates.length - 1] as string;
  const events: FactorEvent[] = [];
  let cumulative = DEC_ONE;
  for (const day of eventDates) {
    if (day > lastTradedDate) break; // 事件晚于最后一根有成交行情：对任何可见 F(x) 无贡献
    // close(e 前最近有成交日)
    let prevIdx = -1;
    for (let i = tradedDates.length - 1; i >= 0; i -= 1) {
      if ((tradedDates[i] as string) < day) {
        prevIdx = i;
        break;
      }
    }
    // preclose(e 日或其后首个有成交日)
    let nextIdx = -1;
    for (let i = 0; i < tradedDates.length; i += 1) {
      if ((tradedDates[i] as string) >= day) {
        nextIdx = i;
        break;
      }
    }
    let ratio: Dec;
    let prevClose: string | null = null;
    let preclose: string | null = null;
    if (prevIdx < 0) {
      ratio = DEC_ONE; // 上市基准事件（e 前 无有成交日）
    } else {
      const prevBar = bars.get(tradedDates[prevIdx] as string) as DailyBarView;
      prevClose = prevBar.close;
      const nextBar = bars.get(tradedDates[nextIdx] as string);
      if (nextBar === undefined) {
        throw new SettlementError('FACTOR_INPUT_INVALID', `事件 ${day} 后无有成交行情行（preclose 不可得）`);
      }
      preclose = nextBar.preclose;
      ratio = decDiv(decFrom(prevClose, 'close'), decFrom(preclose, 'preclose'));
    }
    cumulative = decMul(cumulative, ratio);
    events.push({ day, ratio: decToString(ratio), prevClose, preclose });
  }
  // 累积前缀表：cum[i] = Π_{j≤i} r_j；factorAt(x) = cum[最后 day ≤ x 的下标]（无则 1）。
  const cumulativeAt: Dec[] = [];
  let acc = DEC_ONE;
  for (const ev of events) {
    acc = decMul(acc, decFrom(ev.ratio, 'ratio'));
    cumulativeAt.push(acc);
  }
  const factorAt = (day: string): Dec => {
    let idx = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if ((events[i] as FactorEvent).day <= day) {
        idx = i;
        break;
      }
    }
    return idx < 0 ? DEC_ONE : (cumulativeAt[idx] as Dec);
  };
  return {
    events,
    factorAt,
    factorAtString: (day: string) => decToString(factorAt(day)),
  };
}

// ===== 逐日累计超额序列（SR-3.3/3.4）=====

export interface ExcessDay {
  /** 窗口序（1 起；1 = 参考价日）。 */
  index: number;
  day: string;
  stockRawClose: string;
  /** F(d)（全链累积，审计重放用）。 */
  stockFactor: string;
  /** 后复权收盘 = close × F(d)。 */
  stockAdjClose: string;
  indexClose: string;
  /** e_d（scale-12 定点字符串）。 */
  e: string;
}

export interface SuspensionGap {
  /** 间隔前一有成交日。 */
  from: string;
  /** 间隔后一有成交日；null = 未复牌（窗口未满时的尾部停牌，仅诊断）。 */
  to: string | null;
  /** (from, to) 内市场交易日数（停牌跨度计时口径，ASHARE-RULES §6）。 */
  tradingDays: number;
}

export interface ExcessSeriesResult {
  refDay: string;
  window: number;
  /** 窗口结束日（第 window 个有成交交易日；不足为 null）。 */
  windowEndDay: string | null;
  /** 20 日（window 参数值）是否已满。 */
  complete: boolean;
  /** 逐日序列（day1 = 参考价日；不足 window 个时为可得部分）。 */
  days: ExcessDay[];
  /** e_window = e_(窗口结束日)；未满为 null。 */
  eWindow: string | null;
  /** 后复权参考价（open_ref × F(ref)）。 */
  referenceOpenAdj: string;
  /** 指数参考（参考价日指数开盘点位——与个股参考价同一开盘时点）。 */
  indexOpenRef: string;
  industryIndexCode: string;
  /** 窗口内逐段停牌间隔（含未满时的尾部停牌，to=null）。 */
  suspensionGaps: SuspensionGap[];
  /** 全部除权事件与因子（审计重放用）。 */
  factorEvents: FactorEvent[];
}

/**
 * 纯计算核心：从参考价日起 window 个该股有成交交易日的逐日累计超额序列。
 * e_d = (close_d×F(d) / (open_ref×F(ref)) − 1) − (I_close_d / I_open_ref − 1)；
 * I 为申万一级行业指数点位，I_open_ref 取参考价日指数开盘（与个股参考价同一时点）。
 * 指数在消费日缺行情 → INDEX_BAR_MISSING（SR-10.4 具名异常，不用替代数据补算）。
 */
export function computeExcessSeries(args: {
  tradingDays: string[];
  bars: Map<string, DailyBarView>;
  indexBars: Map<string, IndexBarView>;
  factorEventDates: readonly string[];
  refDay: string;
  window?: number;
}): ExcessSeriesResult {
  const window = args.window ?? DEFAULT_WINDOW;
  const refBar = args.bars.get(args.refDay);
  if (refBar === undefined || refBar.tradestatus !== '1') {
    throw new SettlementError('SETTLE_INPUT_INVALID', `refDay ${args.refDay} 非该股有成交交易日`);
  }
  const refIndex = args.indexBars.get(args.refDay);
  if (refIndex === undefined) {
    throw new SettlementError('INDEX_BAR_MISSING', `行业指数在参考价日 ${args.refDay} 无行情（不用替代数据补算，SR-10.4）`);
  }
  const chain = buildFactorChain(args.bars, args.factorEventDates);
  const tradedFrom = [...args.bars.values()]
    .filter((b) => b.tradestatus === '1' && b.date >= args.refDay)
    .map((b) => b.date)
    .sort();
  const windowDays = tradedFrom.slice(0, window);
  const referenceOpenAdj = decMul(decFrom(refBar.open, 'open'), chain.factorAt(args.refDay));
  const indexOpenRef = decFrom(refIndex.open, '指数开盘');
  const stockBase = referenceOpenAdj;
  const days: ExcessDay[] = [];
  for (let i = 0; i < windowDays.length; i += 1) {
    const day = windowDays[i] as string;
    const bar = args.bars.get(day) as DailyBarView;
    const indexBar = args.indexBars.get(day);
    if (indexBar === undefined) {
      throw new SettlementError('INDEX_BAR_MISSING', `行业指数在窗口日 ${day} 无行情（不用替代数据补算，SR-10.4）`);
    }
    const adjClose = decMul(decFrom(bar.close, 'close'), chain.factorAt(day));
    const stockReturn = decSub(decDiv(adjClose, stockBase), DEC_ONE); // P_d/P_ref − 1（后复权同链）
    const indexReturn = decSub(decDiv(decFrom(indexBar.close, '指数收盘'), indexOpenRef), DEC_ONE); // I_d/I_ref − 1
    const e = decSub(stockReturn, indexReturn);
    days.push({
      index: i + 1,
      day,
      stockRawClose: bar.close,
      stockFactor: chain.factorAtString(day),
      stockAdjClose: decToString(adjClose),
      indexClose: indexBar.close,
      e: decToString(e),
    });
  }
  // 窗口内逐段停牌间隔：相邻有成交日之间的市场交易日数（尾部停牌 to=null，仅诊断）。
  const suspensionGaps: SuspensionGap[] = [];
  for (let i = 1; i < windowDays.length; i += 1) {
    const from = windowDays[i - 1] as string;
    const to = windowDays[i] as string;
    const n = countTradingDaysBetween(args.tradingDays, from, to);
    if (n > 0) suspensionGaps.push({ from, to, tradingDays: n });
  }
  const complete = windowDays.length >= window;
  if (!complete) {
    const last = windowDays[windowDays.length - 1];
    if (last !== undefined) {
      const tail = countTradingDaysBetween(args.tradingDays, last, null);
      if (tail > 0) suspensionGaps.push({ from: last, to: null, tradingDays: tail });
    }
  }
  const windowEndDay = complete ? (windowDays[window - 1] as string) : null;
  const eWindow = complete ? (days[window - 1] as ExcessDay).e : null;
  return {
    refDay: args.refDay,
    window,
    windowEndDay,
    complete,
    days,
    eWindow,
    referenceOpenAdj: decToString(referenceOpenAdj),
    indexOpenRef: refIndex.open,
    industryIndexCode: '',
    suspensionGaps,
    factorEvents: chain.events,
  };
}

/** DB 入口：装载该股行情、指数行情、除权事件与交易日历后走纯计算核心。 */
export async function excessSeries(
  pool: Pool,
  args: {
    subject: string;
    industryIndexCode: string;
    refDay: string;
    window?: number;
    asOf?: Date;
  },
): Promise<ExcessSeriesResult> {
  const asOf = args.asOf ?? new Date();
  const [tradingDays, bars, indexBars, factorEventDates] = await Promise.all([
    loadTradingDays(pool, asOf),
    loadDailyBars(pool, args.subject, asOf),
    loadIndexBars(pool, args.industryIndexCode, asOf),
    loadFactorEventDates(pool, args.subject, asOf),
  ]);
  const result = computeExcessSeries({
    tradingDays,
    bars,
    indexBars,
    factorEventDates,
    refDay: args.refDay,
    window: args.window ?? DEFAULT_WINDOW,
  });
  return { ...result, industryIndexCode: args.industryIndexCode };
}
