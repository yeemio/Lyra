/**
 * Lyra · 宽基 ETF 结算（P3 W19: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md §8A（SR-8A.1 结算标的为跟踪指数点位
 * r_window = I_end/I_ref − 1，I_ref 为参考价日指数开盘点位——R26.1 口径冻结：与 ETF
 * 参考价同一开盘时点；逐日序列 r_d 同 SR-3.4 结构、无行业项；SR-8A.2 方向命中
 * RESEARCH_UP/DOWN 严格不等、=0 两侧均 MISS、ABSTAIN N_A；SR-8A.3 ETF 不复权原始价
 * 判一字板；SR-8A.4 失效预留 5%（P4 校准 P5 冻结）；SR-8A.5 宽基不进 SR-7.1 主指标）
 * + 沿用条款（SR-2.1 模型不参与、SR-2.4 未到期不提前结算、SR-3.1/3.2 参考价锚定结论
 * 完成时刻、SR-3.3 窗口计时停牌不计时、SR-10.4 异常具名登记不补算）+
 * docs/specs/ASHARE-RULES.md §2.1（宽基 ETF（股票型）全区间 10%、无 ST——限系数表
 * ETF 行在本模块内联为常量，不借用 limit.ts 的 MAINBOARD 行语义，该文件不在本派发面）/
 * §2.2–2.4（涨跌停价前收盘×(1±c) 四舍五入到分、四价按分相等 + 收盘=板价、判定用
 * 不复权原始价）/§5（方向绑定：一字涨停挡 UP 买入侧、一字跌停挡 DOWN 回避侧、停牌
 * 两侧皆不可成交、ABSTAIN N/A）/§6（停牌顺延与 SUSPENDED_OVER_20D 单独类）+
 * docs/REVISION-LOG.md R26（R26.1 I_ref 时点；R26.3 指数缺行情日 = 具名异常
 * INDEX_BAR_MISSING，不顺延、不静默、不用替代数据补算）。
 *
 * 与个股结算（settle.ts，W13 冻结面）的分工：本文件只处理宽基 disposition
 * （RESEARCH_UP / RESEARCH_DOWN / ABSTAIN），个股 disposition 进本函数、宽基
 * disposition 进 settleConclusion 皆跨类具名拒绝（R18）；收益按跟踪指数点位计算
 * （避开 ETF 折溢价与分红除息，SR-8A.1），ETF 自身价格收益仅作诊断字段输出
 * （不参与命中判定；库内 ETF 无 ADJUST_FACTOR 事实，诊断口径为不复权原始价收益）。
 *
 * 库内事实形态（2026-10-25 实测探明）：ETF DAILY_BAR（subject_type='ETF'，subject_id
 * 裸 6 位如 510050）与跟踪指数 DAILY_BAR（subject_type='INDEX'，subject_id 裸 6 位
 * 000016/000300/000905/000852）的 typedValue 同构（英文键、字符串价格、tradestatus），
 * 故复用 reference.ts 的 toDailyBarView 行视图与 resolveReferenceOpen 纯函数；
 * ETF→跟踪指数映射解析自冻结池 data/research-pool.json（etfs[].tracks）。
 * 注意：ETF 行情行的 isST 字段是数据源占位（实测 510050 行 isST='1'），ETF 无 ST
 * 概念（ASHARE-RULES §2.1），本模块一切判定不消费 isST。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { asOfFacts } from '../pintime/facts.js';
import { fenOf, limitPrice, LimitRuleError } from '../rules/limit.js';
import type { SettlementZone } from '../contracts.js';
import type { TradabilityClass } from './tradability.js';
import {
  DEC_ONE,
  SettlementError,
  decCmp,
  decDiv,
  decFrom,
  decFromString,
  decMax,
  decMin,
  decNeg,
  decSub,
  decToString,
  type Dec,
} from './decimal.js';
import {
  barTraded,
  countTradingDaysBetween,
  loadTradingDays,
  resolveReferenceOpen,
  toDailyBarView,
  type DailyBarView,
  type ReferenceOpenResult,
} from './reference.js';
import { LONG_SUSPENSION_TRADING_DAYS } from './tradability.js';

export const DEFAULT_WINDOW = 20; // SR-3.3 沿用（SR-8A 未另定窗口）
/** SR-8A.4 失效触发预留阈值 5%（P4 以跟踪指数自身历史实测触发率后校准、P5 冻结）。 */
export const DEFAULT_ETF_INVALIDATION_THRESHOLD = '0.05';
/** ASHARE-RULES §2.1 宽基 ETF（股票型）行：全区间 10%、无 ST（limit.ts 表无 ETF 行，内联不借 MAINBOARD 语义）。 */
export const ETF_LIMIT_COEFFICIENT = 0.1;
/** 上述系数行的稳定标识（审计留痕用；ASHARE-RULES §2.1 ETF 行，P0 冻结无时点切换）。 */
export const ETF_LIMIT_RULE_VERSION_ID = 'ASHARE-RULES-2.1-BROAD-ETF-10';

/** 宽基结论 disposition（RESEARCH-METHOD §3；R18）。 */
export type EtfDisposition = 'RESEARCH_UP' | 'RESEARCH_DOWN' | 'ABSTAIN';

export interface EtfSettleArgs {
  /** ETF 代码（裸 6 位，如 510050；51/15 开头基金代码段，ASHARE-RULES §2.1）。 */
  subject: string;
  disposition: EtfDisposition;
  /** 结论完成时刻（SR-3.1 参考价锚点；沿用个股裁定，不得改锚事件时刻）。 */
  conclusionTime: string | Date;
  /** 事实读取 as-of（默认当前时刻；只消费窗口内各日事实）。 */
  asOf?: Date;
  /** 窗口长度（默认 20；测试注入用）。 */
  window?: number;
  /** 失效触发阈值（默认 '0.05' 预留值；定点字符串）。 */
  invalidationThreshold?: string;
  /**
   * 跟踪指数代码（裸 6 位）。缺省时从冻结池 data/research-pool.json 的 etfs[].tracks
   * 解析（R24 冻结单一事实源）；显式注入供测试与审计重放。
   */
  trackedIndex?: string;
}

// ===== ETF → 跟踪指数映射（data/research-pool.json，R24 冻结）=====

/** tracks 字符串（如 '上证50(000016)'）→ 指数代码；括号内非 6 位数字即具名拒绝，不猜。 */
export function parseTrackedIndex(tracks: string): string {
  const m = /\((\d{6})\)/.exec(tracks);
  if (m === null) {
    throw new SettlementError('ETF_TRACKS_UNPARSEABLE', `tracks: "${tracks}"（须形如 名称(6位指数代码)）`);
  }
  return m[1] as string;
}

/** 冻结池 etfs 段 → ETF 代码 → 跟踪指数代码映射。 */
export async function loadEtfIndexMap(): Promise<Map<string, string>> {
  const poolPath = join(fileURLToPath(new URL('../../data/research-pool.json', import.meta.url)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(poolPath, 'utf8')) as unknown;
  } catch (error) {
    throw new SettlementError(
      'ETF_INDEX_MAP_UNREADABLE',
      `data/research-pool.json 不可读（${error instanceof Error ? error.message : String(error)}）：R24 冻结池是 ETF→指数映射的单一事实源`,
    );
  }
  const etfs = (parsed as { etfs?: unknown }).etfs;
  if (!Array.isArray(etfs)) throw new SettlementError('ETF_INDEX_MAP_UNREADABLE', 'data/research-pool.json 缺 etfs 数组');
  const map = new Map<string, string>();
  for (const e of etfs) {
    const row = e as { code?: unknown; tracks?: unknown };
    if (typeof row.code !== 'string' || typeof row.tracks !== 'string') {
      throw new SettlementError('ETF_INDEX_MAP_UNREADABLE', `etfs 行形不符: ${JSON.stringify(e)}`);
    }
    map.set(row.code, parseTrackedIndex(row.tracks));
  }
  return map;
}

// ===== ETF / 指数 DAILY_BAR 装载（typedValue 与个股同构，subject_type 不同）=====

/**
 * as-of 可见 DAILY_BAR（date → 行视图）。与 reference.ts loadDailyBars 同构，但该函数
 * 写死 subject_type='STOCK'（W13 冻结面不改）；ETF 侧（'ETF'）与跟踪指数侧（'INDEX'）
 * 走本装载。同日多事实 = 来源冲突，具名暴露不猜（SR-10.4）。
 */
export async function loadDailyBarsFor(pool: Pool, subjectType: 'ETF' | 'INDEX', subjectId: string, asOf: Date): Promise<Map<string, DailyBarView>> {
  const facts = await asOfFacts(pool, { subjectType, subjectId, factKind: 'DAILY_BAR', asOf });
  const byDate = new Map<string, DailyBarView>();
  for (const f of facts) {
    const bar = toDailyBarView(f.typedValue, f.factId);
    const existing = byDate.get(bar.date);
    if (existing !== undefined && existing.factId !== bar.factId) {
      throw new SettlementError(
        'BAR_DATE_CONFLICT',
        `${subjectId} ${bar.date} 存在多个行情事实（${existing.factId} / ${bar.factId}）：来源冲突不静默合并（DATA-SOURCES §6.5）`,
      );
    }
    byDate.set(bar.date, bar);
  }
  return byDate;
}

// ===== 逐日指数收益序列（SR-8A.1；纯函数，单测直接注入）=====

export interface EtfDay {
  /** 窗口序（1 起；1 = 参考价日）。 */
  index: number;
  day: string;
  /** ETF 当日原始收盘价（不复权；诊断路径，不参与命中判定）。 */
  etfRawClose: string;
  /** 跟踪指数当日收盘点位。 */
  indexClose: string;
  /** r_d = I_d_close / I_ref_open − 1（scale-12 定点字符串）。 */
  r: string;
}

export interface EtfSeriesResult {
  refDay: string;
  window: number;
  /** 窗口结束日（第 window 个 ETF 有成交交易日；不足为 null）。 */
  windowEndDay: string | null;
  /** 窗口（window 参数值）个有成交交易日是否已满。 */
  complete: boolean;
  /** 逐日序列（day1 = 参考价日；不足 window 个时为可得部分）。 */
  days: EtfDay[];
  /** r_window = r_(窗口结束日)；未满为 null。 */
  rWindow: string | null;
  /** ETF 参考价（参考价日开盘，不复权原始价；一字板判定与诊断收益的基准）。 */
  etfReferenceOpen: string;
  /** I_ref：参考价日跟踪指数开盘点位（R26.1：与 ETF 参考价同一开盘时点）。 */
  indexOpenRef: string;
  /** 诊断字段：ETF 自身不复权价格 20 日收益（不参与命中判定；含折溢价与分红除息影响）。 */
  etfPriceReturn: string | null;
  /** 跟踪指数代码。 */
  indexCode: string;
  /** 窗口内逐段 ETF 停牌间隔（同 SR-3.3 计时口径）。 */
  suspensionGaps: { from: string; to: string | null; tradingDays: number }[];
}

/**
 * 纯计算核心：从参考价日起 window 个 ETF 有成交交易日的逐日跟踪指数收益序列。
 * r_d = I_d_close / I_ref_open − 1（无行业项；SR-8A.1）。窗口计时以 ETF 有成交日为准
 * （SR-3.3 停牌不计时）；指数在参考价日或任一窗口日缺行情 → INDEX_BAR_MISSING
 * （R26.3：不顺延、不静默、不用替代数据补算）。指数行存在即消费（指数随市场存在，
 * 不施加 tradestatus 判定）。
 */
export function computeEtfSeries(args: {
  tradingDays: string[];
  etfBars: Map<string, DailyBarView>;
  indexBars: Map<string, DailyBarView>;
  refDay: string;
  window?: number;
}): EtfSeriesResult {
  const window = args.window ?? DEFAULT_WINDOW;
  const refBar = args.etfBars.get(args.refDay);
  if (refBar === undefined || !barTraded(refBar)) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `refDay ${args.refDay} 非该 ETF 有成交交易日`);
  }
  const refIndex = args.indexBars.get(args.refDay);
  if (refIndex === undefined) {
    throw new SettlementError('INDEX_BAR_MISSING', `跟踪指数在参考价日 ${args.refDay} 无行情（不用替代数据补算，SR-10.4/R26.3）`);
  }
  const tradedFrom = [...args.etfBars.values()]
    .filter((b) => barTraded(b) && b.date >= args.refDay)
    .map((b) => b.date)
    .sort();
  const windowDays = tradedFrom.slice(0, window);
  const indexOpenRef = decFrom(refIndex.open, '指数开盘');
  const days: EtfDay[] = [];
  for (let i = 0; i < windowDays.length; i += 1) {
    const day = windowDays[i] as string;
    const bar = args.etfBars.get(day) as DailyBarView;
    const indexBar = args.indexBars.get(day);
    if (indexBar === undefined) {
      throw new SettlementError('INDEX_BAR_MISSING', `跟踪指数在窗口日 ${day} 无行情（不用替代数据补算，SR-10.4/R26.3）`);
    }
    const r = decSub(decDiv(decFrom(indexBar.close, '指数收盘'), indexOpenRef), DEC_ONE);
    days.push({ index: i + 1, day, etfRawClose: bar.close, indexClose: indexBar.close, r: decToString(r) });
  }
  // 窗口内逐段停牌间隔（与个股 excessSeries 同构口径）
  const suspensionGaps: EtfSeriesResult['suspensionGaps'] = [];
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
  const rWindow = complete ? (days[window - 1] as EtfDay).r : null;
  const etfPriceReturn = complete
    ? decToString(decSub(decDiv(decFrom((args.etfBars.get(windowEndDay as string) as DailyBarView).close, 'ETF收盘'), decFrom(refBar.open, 'ETF参考开盘')), DEC_ONE))
    : null;
  return {
    refDay: args.refDay,
    window,
    windowEndDay,
    complete,
    days,
    rWindow,
    etfReferenceOpen: refBar.open,
    indexOpenRef: refIndex.open,
    etfPriceReturn,
    indexCode: '',
    suspensionGaps,
  };
}

// ===== ETF 可成交性（SR-8A.3；镜像 tradability.ts 结构，参数面不同不共用）=====

export interface EtfTradabilityInput {
  disposition: EtfDisposition;
  /** 参考价日因停牌顺延（SR-3.2 末行 → UNFILLABLE_SUSPENDED 系）。 */
  deferredBySuspension: boolean;
  /** 顺延跨度（市场交易日数；未顺延为 0）。 */
  suspensionSpanTradingDays: number;
  /** 参考价日 ETF 行情行（未顺延时必有）。 */
  refDayBar: DailyBarView | null;
  /** 窗口内逐段停牌间隔（任一间隔 > 20 → SUSPENDED_OVER_20D）。 */
  windowSuspensionGaps: readonly { tradingDays: number }[];
}

export interface EtfTradabilityResult {
  tradability: TradabilityClass;
  /** 参考价日一字板方向（非一字板为 null）。 */
  oneWordBoard: 'LIMIT_UP' | 'LIMIT_DOWN' | null;
  /** 涨跌停价与系数（判定输入审计；未做板判定为 null）。 */
  limit: { up: string; down: string; coefficient: number; ruleVersionId: string } | null;
  reason: string;
}

/**
 * ETF 可成交性分类（ASHARE-RULES §5 方向绑定在 ETF 侧的同构落点：UP=买入侧被一字
 * 涨停挡、DOWN=回避/卖出侧被一字跌停挡；停牌两侧皆不可成交）。与个股
 * classifyTradability 的差异写死：disposition 空间（UP/DOWN/ABSTAIN）、限系数恒 10%
 * 无 ST（ETF 行情行 isST 是数据源占位，不消费）、无 ST 时点表查询。优先级同个股：
 * N_A > 一字板方向阻断 > 参考价顺延停牌（>20 → SUSPENDED_OVER_20D）> 窗口内长停牌 >
 * FILLABLE。一字板判定：四价按分取整相等且收盘=当日涨跌停价（前收盘×1.1/0.9
 * 四舍五入到分，limitPrice 冻结口径；不复权原始价，§2.3）。
 */
export function classifyEtfTradability(input: EtfTradabilityInput): EtfTradabilityResult {
  if (input.disposition === 'ABSTAIN') {
    return { tradability: 'N_A', oneWordBoard: null, limit: null, reason: '放弃结论无交易意图，不参与可成交性判定（ASHARE-RULES §5 沿用）' };
  }
  if (input.disposition !== 'RESEARCH_UP' && input.disposition !== 'RESEARCH_DOWN') {
    throw new SettlementError('SETTLE_INPUT_INVALID', `disposition: ${input.disposition}（宽基结算空间外，R18 跨类拒绝）`);
  }
  if (input.deferredBySuspension) {
    if (input.suspensionSpanTradingDays > LONG_SUSPENSION_TRADING_DAYS) {
      return {
        tradability: 'SUSPENDED_OVER_20D',
        oneWordBoard: null,
        limit: null,
        reason: `参考价顺延跨度 ${String(input.suspensionSpanTradingDays)} 个市场交易日 > ${String(LONG_SUSPENSION_TRADING_DAYS)}（ASHARE-RULES §6 长期停牌单独类）`,
      };
    }
    return {
      tradability: 'UNFILLABLE_SUSPENDED',
      oneWordBoard: null,
      limit: null,
      reason: `参考价日因停牌顺延（跨度 ${String(input.suspensionSpanTradingDays)} 个市场交易日，SR-3.2/ASHARE-RULES §6）`,
    };
  }
  const bar = input.refDayBar;
  if (bar === null) {
    throw new SettlementError('REFDAY_BAR_MISSING', '未顺延但参考价日行情行缺失（输入不一致）');
  }
  const up = limitPrice(Number(bar.preclose), 'UP', ETF_LIMIT_COEFFICIENT);
  const down = limitPrice(Number(bar.preclose), 'DOWN', ETF_LIMIT_COEFFICIENT);
  const limit = { up, down, coefficient: ETF_LIMIT_COEFFICIENT, ruleVersionId: ETF_LIMIT_RULE_VERSION_ID };
  const fen = (p: string, field: string): number => {
    const n = Number(p);
    if (!Number.isFinite(n)) {
      throw new SettlementError('BAR_FIELD_INVALID', `DAILY_BAR ${bar.factId} ${field} 不可数值化: ${p}`);
    }
    return fenOf(n);
  };
  const openFen = fen(bar.open, 'open');
  const highFen = fen(bar.high, 'high');
  const lowFen = fen(bar.low, 'low');
  const closeFen = fen(bar.close, 'close');
  const fourEqual = openFen === highFen && highFen === lowFen && lowFen === closeFen;
  const oneWordUp = fourEqual && closeFen === fen(up, '涨停价');
  const oneWordDown = fourEqual && closeFen === fen(down, '跌停价');
  if (oneWordUp) {
    return input.disposition === 'RESEARCH_UP'
      ? {
          tradability: 'UNFILLABLE_LIMIT_UP',
          oneWordBoard: 'LIMIT_UP',
          limit,
          reason: `参考价日一字涨停（四价 ${bar.open} = 涨停价 ${up}，前收盘 ${bar.preclose}×1.1 到分，${ETF_LIMIT_RULE_VERSION_ID}）：UP 买入侧不可成交（ASHARE-RULES §5）`,
        }
      : {
          tradability: 'FILLABLE',
          oneWordBoard: 'LIMIT_UP',
          limit,
          reason: `参考价日一字涨停但结论方向为 DOWN（回避侧）：可成交（ASHARE-RULES §5）`,
        };
  }
  if (oneWordDown) {
    return input.disposition === 'RESEARCH_DOWN'
      ? {
          tradability: 'UNFILLABLE_LIMIT_DOWN',
          oneWordBoard: 'LIMIT_DOWN',
          limit,
          reason: `参考价日一字跌停（四价 ${bar.open} = 跌停价 ${down}，前收盘 ${bar.preclose}×0.9 到分，${ETF_LIMIT_RULE_VERSION_ID}）：DOWN 回避侧不可成交（ASHARE-RULES §5）`,
        }
      : {
          tradability: 'FILLABLE',
          oneWordBoard: 'LIMIT_DOWN',
          limit,
          reason: `参考价日一字跌停但结论方向为 UP（买入侧）：可成交（ASHARE-RULES §5）`,
        };
  }
  const longGap = input.windowSuspensionGaps.find((g) => g.tradingDays > LONG_SUSPENSION_TRADING_DAYS);
  if (longGap !== undefined) {
    return {
      tradability: 'SUSPENDED_OVER_20D',
      oneWordBoard: null,
      limit,
      reason: `窗口内停牌间隔 ${String(longGap.tradingDays)} 个市场交易日 > ${String(LONG_SUSPENSION_TRADING_DAYS)}（ASHARE-RULES §6；窗口照走不并入主统计）`,
    };
  }
  return {
    tradability: 'FILLABLE',
    oneWordBoard: null,
    limit,
    reason: `参考价日非一字板（四价 ${bar.open}/${bar.high}/${bar.low}/${bar.close}；涨停 ${up} / 跌停 ${down}，${ETF_LIMIT_RULE_VERSION_ID}）：可成交`,
  };
}

// ===== 结算主函数 =====

/** 宽基结算占位区 SETTLED 形态（SettlementZone 兼容；excessReturn 字段承载 r_window=跟踪指数 20 日收益，SR-8A.1）。 */
export interface EtfSettledZone extends SettlementZone {
  state: 'SETTLED';
  /** HIT=true / MISS=false（严格不等，=0 两侧均 MISS）；ABSTAIN → null（N_A）。 */
  directionHit: boolean | null;
  /** r_window（跟踪指数 20 日收益，scale-12 定点字符串）。 */
  excessReturn: string;
  /** UP 侧 min(r_d) / DOWN 侧 max(r_d)；ABSTAIN → null（N/A）。 */
  maxAdverse: string | null;
  /** ABSTAIN 时字段缺席（N/A）。 */
  invalidationTriggered?: boolean;
  /** ASHARE-RULES §5/§6 分类（ETF ±10% 一字板；无 ST）；ABSTAIN → 'N_A'。 */
  tradability: string;
}

export interface EtfSettleDiagnostics {
  subject: string;
  /** 跟踪指数代码（裸 6 位；R24 冻结池解析或显式注入）。 */
  trackedIndex: string;
  disposition: EtfDisposition;
  conclusionTime: string;
  asOf: string;
  window: number;
  referenceDay: string;
  /** ETF 参考价（参考价日开盘，不复权原始价）。 */
  referenceOpen: string;
  deferredBySuspension: boolean;
  suspensionSpanTradingDays: number;
  windowEndDay: string;
  tradedDays: number;
  /** I_ref（R26.1：参考价日指数开盘点位）。 */
  indexOpenRef: string;
  /** 诊断：ETF 自身不复权价格 20 日收益（不参与命中判定，SR-8A.1）。 */
  etfPriceReturn: string | null;
  series: EtfDay[];
  suspensionGaps: EtfSeriesResult['suspensionGaps'];
  invalidationThreshold: string;
  invalidationFirstDay: string | null;
  tradability: EtfTradabilityResult;
}

export type EtfSettleOutcome =
  | { state: 'UNSETTLED'; reason: 'REFERENCE_NOT_DUE' | 'WINDOW_INCOMPLETE'; detail: string; reference: ReferenceOpenResult }
  | { state: 'ANOMALY'; code: string; detail: string }
  | { state: 'SETTLED'; zone: EtfSettledZone; diagnostics: EtfSettleDiagnostics };

function toDate(value: string | Date, field: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new SettlementError('DATE_INVALID', `${field}: ${String(value)}`);
  return d;
}

/**
 * 结算一个宽基 ETF 结论（窗口走完后调用；未到期返回 UNSETTLED，原样不提前结算）。
 * 收益按跟踪指数点位计算（SR-8A.1），ETF 价格收益仅诊断；宽基结论不进 SR-7.1 主指标
 * 与其分母（SR-8A.5，统计隔离由消费侧分母视图执行）。
 */
export async function settleEtfConclusion(pool: Pool, args: EtfSettleArgs): Promise<EtfSettleOutcome> {
  const asOf = args.asOf ?? new Date();
  const conclusionTime = toDate(args.conclusionTime, 'conclusionTime');
  const window = args.window ?? DEFAULT_WINDOW;
  const thresholdStr = args.invalidationThreshold ?? DEFAULT_ETF_INVALIDATION_THRESHOLD;
  if (args.disposition !== 'RESEARCH_UP' && args.disposition !== 'RESEARCH_DOWN' && args.disposition !== 'ABSTAIN') {
    throw new SettlementError(
      'SETTLE_INPUT_INVALID',
      `disposition ${args.disposition} 不在宽基结算空间（个股结算走 settleConclusion，R18 跨类拒绝）`,
    );
  }
  if (typeof args.subject !== 'string' || !/^(51|15)\d{4}$/.test(args.subject)) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `subject: ${String(args.subject)}（须 51/15 开头 6 位 ETF 代码，ASHARE-RULES §2.1）`);
  }
  if (args.trackedIndex !== undefined && !/^\d{6}$/.test(args.trackedIndex)) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `trackedIndex: ${String(args.trackedIndex)}（须裸 6 位指数代码）`);
  }
  let threshold: Dec;
  try {
    threshold = decFromString(thresholdStr, 'invalidationThreshold');
  } catch (error) {
    if (error instanceof SettlementError) throw new SettlementError('SETTLE_INPUT_INVALID', error.message);
    throw error;
  }
  if (decCmp(threshold, { scaled: 0n }) <= 0) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `invalidationThreshold 须为正: ${thresholdStr}`);
  }
  const trackedIndex = args.trackedIndex ?? (await loadEtfIndexMap()).get(args.subject);
  if (trackedIndex === undefined) {
    throw new SettlementError('ETF_NOT_IN_POOL', `subject ${args.subject} 不在冻结池 data/research-pool.json（R24）；宽基结算仅覆盖池内 4 只，未知标的具名拒绝不猜`);
  }

  try {
    // 1) 参考价（SR-3.1/3.2 沿用：结论完成后首个 ETF 有成交交易日开盘价，停牌顺延）
    const [tradingDays, etfBars] = await Promise.all([
      loadTradingDays(pool, asOf),
      loadDailyBarsFor(pool, 'ETF', args.subject, asOf),
    ]);
    const reference = resolveReferenceOpen(tradingDays, etfBars, conclusionTime);
    if (reference.state === 'NOT_DUE') {
      return { state: 'UNSETTLED', reason: 'REFERENCE_NOT_DUE', detail: reference.detail, reference };
    }
    // 2) 逐日跟踪指数收益序列（SR-8A.1；I_ref=参考价日指数开盘，R26.1）
    const indexBars = await loadDailyBarsFor(pool, 'INDEX', trackedIndex, asOf);
    const series = computeEtfSeries({ tradingDays, etfBars, indexBars, refDay: reference.referenceDay, window });
    if (!series.complete) {
      return {
        state: 'UNSETTLED',
        reason: 'WINDOW_INCOMPLETE',
        detail: `窗口仅走 ${String(series.days.length)}/${String(window)} 个 ETF 有成交交易日（参考价日 ${reference.referenceDay}），SR-2.4 未到期不提前结算`,
        reference,
      };
    }
    // 3) 可成交性（SR-8A.3：ETF ±10% 无 ST；不可成交仍照常结算，SR-4.3 沿用）
    const tradability = classifyEtfTradability({
      disposition: args.disposition,
      deferredBySuspension: reference.deferredBySuspension,
      suspensionSpanTradingDays: reference.suspensionSpanTradingDays,
      refDayBar: reference.bar,
      windowSuspensionGaps: series.suspensionGaps,
    });
    // 4) 结算字段（SR-8A.1/8A.2/8A.4；全部由同一份逐日序列导出）
    const rWindow = decFromString(series.rWindow as string, 'rWindow');
    const directionHit =
      args.disposition === 'RESEARCH_UP'
        ? decCmp(rWindow, { scaled: 0n }) > 0
        : args.disposition === 'RESEARCH_DOWN'
          ? decCmp(rWindow, { scaled: 0n }) < 0
          : null; // ABSTAIN → N_A
    let maxAdverse: Dec | null = null;
    let invalidationTriggered: boolean | undefined;
    let invalidationFirstDay: string | null = null;
    const firstDay = series.days[0] as EtfDay; // complete=true ⇒ 序列非空
    const firstR = decFromString(firstDay.r, 'r_d');
    if (args.disposition === 'RESEARCH_UP') {
      maxAdverse = series.days.reduce((m, d) => decMin(m, decFromString(d.r, 'r_d')), firstR);
      const triggerLevel = decNeg(threshold); // UP 侧不利方向：r_d ≤ −5%（按指数口径）
      const hit = series.days.find((d) => decCmp(decFromString(d.r, 'r_d'), triggerLevel) <= 0);
      invalidationTriggered = hit !== undefined;
      invalidationFirstDay = hit?.day ?? null;
    } else if (args.disposition === 'RESEARCH_DOWN') {
      maxAdverse = series.days.reduce((m, d) => decMax(m, decFromString(d.r, 'r_d')), firstR);
      const hit = series.days.find((d) => decCmp(decFromString(d.r, 'r_d'), threshold) >= 0); // DOWN 侧：r_d ≥ +5%
      invalidationTriggered = hit !== undefined;
      invalidationFirstDay = hit?.day ?? null;
    } // ABSTAIN：maxAdverse null、invalidationTriggered 缺席（N/A，SR-2.2 沿用）

    const zone: EtfSettledZone =
      args.disposition === 'ABSTAIN'
        ? {
            state: 'SETTLED',
            directionHit: null,
            excessReturn: decToString(rWindow),
            maxAdverse: null,
            tradability: 'N_A',
          }
        : {
            state: 'SETTLED',
            directionHit,
            excessReturn: decToString(rWindow),
            maxAdverse: decToString(maxAdverse as Dec),
            ...(invalidationTriggered === undefined ? {} : { invalidationTriggered }),
            tradability: tradability.tradability,
          };
    const diagnostics: EtfSettleDiagnostics = {
      subject: args.subject,
      trackedIndex,
      disposition: args.disposition,
      conclusionTime: conclusionTime.toISOString(),
      asOf: asOf.toISOString(),
      window,
      referenceDay: reference.referenceDay,
      referenceOpen: reference.referenceOpen,
      deferredBySuspension: reference.deferredBySuspension,
      suspensionSpanTradingDays: reference.suspensionSpanTradingDays,
      windowEndDay: series.windowEndDay as string,
      tradedDays: series.days.length,
      indexOpenRef: series.indexOpenRef,
      etfPriceReturn: series.etfPriceReturn,
      series: series.days,
      suspensionGaps: series.suspensionGaps,
      invalidationThreshold: thresholdStr,
      invalidationFirstDay,
      tradability,
    };
    return { state: 'SETTLED', zone, diagnostics };
  } catch (error) {
    if (error instanceof SettlementError) {
      return { state: 'ANOMALY', code: error.code, detail: error.message };
    }
    if (error instanceof LimitRuleError) {
      return { state: 'ANOMALY', code: error.code, detail: error.message };
    }
    throw error; // 基础设施故障（DB 等）不冒充结算异常，如实上抛（与 settle.ts 同构）
  }
}
