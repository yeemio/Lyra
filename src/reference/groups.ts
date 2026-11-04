/**
 * Lyra · 历史参照库 · 主群组机械选定（P3 随轮提前 / W15: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §5（逐层收窄顺序、下限、嵌套声明、不降档凑样本）
 * 与 §8（群组匹配结果对象）逐条款：
 * 1. 事件类型层（六类 + 子类：预告更正上修/下修、回购首次/重要变更）；
 * 2. 申万一级行业层（事件时点 as-of 当时版本：2015–2021 用 2014 版分类与对应指数，
 *    之后用 2021 版；版本切换点在群组路径显式登记；切换后不回溯重分类）；
 * 3. 市值档层（事件时点当时市值三档；分界为 P4 冻结参数 MARKET_CAP_TIERS，默认预留等分位；
 *    总股本不可得时用成交额代理档位并如实标记 proxy=true，不编造股本）；
 * 4. 市场状态层（沪深 300 近 20 个交易日端点比较：期末收盘 ≥ 期初收盘为向上）。
 * 收窄规则：加入该层后样本数 ≥ MIN_GROUP_SAMPLE（P4 冻结参数，默认预留 30）才进入；
 * 主群组 = 满足下限的最深层；同时输出每一父层（含事件类型层、全库基础层）样本数与基础比例；
 * 不降档凑样本：不足只停在上层或报缺口。
 *
 * 嵌套声明（固定文本，随产出物与 A/J 参照块强制携带）与修订口径声明（R4 原文）见常量。
 * 单测不碰网络不碰 DB：合成事实注入。
 */
import type { TimePointFact } from '../contracts.js';
import { parseFixed, fCmp, fixedToString, shanghaiDate, type DailyBarInput, type Fixed } from './excess.js';

// ===== 声明原文（固定文本）=====

/** §5 嵌套声明固定文本。 */
export const NESTED_GROUP_DECLARATION =
  '群组路径上各层相互嵌套，是同一证据的逐次切片，不是独立证据；多个嵌套群组的相似比例不构成独立确认。';

/**
 * §6 修订口径声明原文（与 docs/specs/DATA-SOURCES.md §5、src/adapters/adapter-types.ts
 * BACKFILL_REVISION_NOTICE 同源同文；W15 派发只读依赖不含 adapter-types，故原样自持，
 * P3 验收可 diff 对齐）。
 */
export const REVISION_NOTICE =
  '修订口径声明：一次性回填 2015–2026 拿到的是当前最新修订值，与当时公告值可能不同且不可复原；历史参照库的事件主证据以公告 PDF 原文为准，结构化数据做辅助。';

/** §5 MIN_GROUP_SAMPLE 预留默认（P4 冻结参数；冻结前一切查询只用本默认值，不临时设定）。 */
export const DEFAULT_MIN_GROUP_SAMPLE = 30;

// ===== 申万体系边界与前缀 → 一级指数映射（自持副本，注明同源）=====

/**
 * 以下三常量与 src/adapters/sw.ts 的 SW_2014_EFFECTIVE / SW_2021_CLASSIFY_EFFECTIVE /
 * SW2021_PREFIX_L1 / SW2014_PREFIX_L1 同源冻结值（W7 核验，证据 data/sw-semantics-report.json）。
 * W15 派发的只读依赖清单不含 adapters/sw.ts，故按其公开导出值原样自持；任何不一致以
 * adapters/sw.ts 为准并上报总控。801020（2014 采掘）全史已事实化入 SW_INDEX_BAR。
 */
export const SW_2014_EFFECTIVE = '2014-02-21';
export const SW_2021_CLASSIFY_EFFECTIVE = '2021-07-30';

export const SW2021_PREFIX_L1: Readonly<Record<string, string>> = {
  '11': '801010', '22': '801030', '23': '801040', '24': '801050', '27': '801080',
  '28': '801880', '33': '801110', '34': '801120', '35': '801130', '36': '801140',
  '37': '801150', '41': '801160', '42': '801170', '43': '801180', '45': '801200',
  '46': '801210', '48': '801780', '49': '801790', '51': '801230', '61': '801710',
  '62': '801720', '63': '801730', '64': '801890', '65': '801740', '71': '801750',
  '72': '801760', '73': '801770', '74': '801950', '75': '801960', '76': '801970',
  '77': '801980',
};

export const SW2014_PREFIX_L1: Readonly<Record<string, string>> = {
  '11': '801010', '21': '801020', '22': '801030', '23': '801040', '24': '801050',
  '27': '801080', '28': '801880', '33': '801110', '34': '801120', '35': '801130',
  '36': '801140', '37': '801150', '41': '801160', '42': '801170', '43': '801180',
  '45': '801200', '46': '801210', '48': '801780', '49': '801790', '51': '801230',
  '61': '801710', '62': '801720', '63': '801730', '64': '801890', '65': '801740',
  '71': '801750', '72': '801760', '73': '801770',
};

export type SwSystem = 'pre2014' | '2014' | '2021';

/** 读取窗口（事件时点）所属申万体系（行只在代码变更时产生、跨体系携带——按窗口解释前缀）。 */
export function swSystemOf(dateISO: string): SwSystem {
  if (dateISO >= SW_2021_CLASSIFY_EFFECTIVE) return '2021';
  if (dateISO >= SW_2014_EFFECTIVE) return '2014';
  return 'pre2014';
}

// ===== 行业 as-of（事件时点当时申万一级；HISTORICAL-REFERENCE §5 层 2）=====

export interface IndustryAsOf {
  /** 行业代码前 2 位前缀（在事件窗口体系下解释）。 */
  prefix: string;
  /** 事件窗口所属体系（非行的铸造体系）。 */
  system: SwSystem;
  /** 前缀按窗口体系映射的申万一级指数码；pre2014 / 未知前缀 → null（缺口，不猜）。 */
  l1IndexCode: string | null;
  industryCode: string;
  /** 现行行计入日。 */
  inDate: string;
}

/**
 * 事件时点 as-of 行业归属：INDUSTRY_CLASS_VERSION（sw@p1）行中 availableAt ≤ 事件时点的
 * 计入日最大行（POINT-IN-TIME §5.2 as-of；行的 supersedes 链由 asOfFacts 调用方解析，
 * sw@p1 分类行无链，多版本并行并存按来源冲突处置，此处取现行行）。
 * 输入应为**单股**的 sw@p1 INDUSTRY_CLASS_VERSION 事实集（baostock csrc@current 快照行
 * 由调用方按 adapter_version 排除，混入时按缺字段拒绝）。
 */
export function industryAsOf(rows: TimePointFact[], eventTime: string): IndustryAsOf | null {
  const eventDate = shanghaiDate(eventTime);
  if (eventDate === null) return null;
  const eventMs = new Date(eventTime).getTime();
  if (Number.isNaN(eventMs)) return null;
  let best: { inDate: string; industryCode: string } | null = null;
  for (const fact of rows) {
    if (fact.availableAt !== null && new Date(fact.availableAt).getTime() > eventMs) continue;
    const tv = fact.typedValue as Record<string, unknown>;
    const inDate = tv['计入日期ISO'];
    const ind = tv['行业代码'];
    if (typeof inDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(inDate)) continue;
    if (typeof ind !== 'string' || !/^\d{6}$/.test(ind)) continue;
    if (inDate > eventDate) continue; // 生效性：计入日 > 事件日（as-of 保守口径下已被可得性蕴含，双保险）
    if (best === null || inDate > best.inDate) best = { inDate, industryCode: ind };
  }
  if (best === null) return null;
  const system = swSystemOf(eventDate);
  const prefix = best.industryCode.slice(0, 2);
  const table = system === '2021' ? SW2021_PREFIX_L1 : system === '2014' ? SW2014_PREFIX_L1 : null;
  return {
    prefix,
    system,
    l1IndexCode: table === null ? null : table[prefix] ?? null,
    industryCode: best.industryCode,
    inDate: best.inDate,
  };
}

// ===== 市值档（事件时点当时市值三档；§5 层 3）=====

export type MarketCapTier = 'T1' | 'T2' | 'T3';

export interface MarketCapTierInput {
  /** 事件时点最近已收盘（15:00 ≤ 事件时点）的有成交交易日。 */
  date: string;
  /** 该日收盘价（原始）。 */
  close: string | number | null;
  /** 总股本（股）。库内无股本事实 → null（代理档位，不编造股本）。 */
  totalShares: string | number | null;
  /** 该日成交额（元），代理基准。 */
  amount: string | number | null;
}

export interface MarketCapTierResult {
  tier: MarketCapTier;
  /** true = 成交额代理档位（总股本不可得）。 */
  proxy: boolean;
  basis: 'marketCap' | 'amount';
  /** 档位判定输入值（定点字符串；市值=元、代理=元成交额）。 */
  value: string;
  /** 三档分界 [b1, b2]（与 value 同域；定点字符串）。 */
  bounds: [string, string];
  boundsMethod: 'fixed' | 'tercile-reserved';
  date: string;
}

/**
 * 市值档判定：value = close × totalShares（总股本可得）或 amount（代理，proxy=true）。
 * 三档：value < b1 → T1；< b2 → T2；否则 T3。分界为 P4 冻结参数 MARKET_CAP_TIERS——
 * 调用方传 fixed（已冻结值）或 tercile（等分位预留值，bounds 由全库样本三等分位算出后传入，
 * 全库统一、逐群组不重算）。分界倒序 / 输入值不可得 → null（缺口，不推算）。
 */
export function marketCapTierOf(
  input: MarketCapTierInput,
  bounds: [string, string],
  boundsMethod: 'fixed' | 'tercile-reserved',
): MarketCapTierResult | null {
  const b1 = parseFixed(bounds[0]);
  const b2 = parseFixed(bounds[1]);
  if (b1 === null || b2 === null || fCmp(b1, b2) > 0) return null;
  if (input.totalShares !== null && input.totalShares !== undefined && String(input.totalShares).trim() !== '') {
    const close = parseFixed(input.close);
    const shares = parseFixed(input.totalShares);
    if (close === null || shares === null) return null;
    return finishTier(input, { int: close.int * shares.int, scale: close.scale + shares.scale }, false, 'marketCap', bounds, boundsMethod);
  }
  const amount = parseFixed(input.amount);
  if (amount === null) return null;
  return finishTier(input, amount, true, 'amount', bounds, boundsMethod);
}

function finishTier(
  input: MarketCapTierInput,
  value: Fixed,
  proxy: boolean,
  basis: 'marketCap' | 'amount',
  bounds: [string, string],
  boundsMethod: 'fixed' | 'tercile-reserved',
): MarketCapTierResult {
  const b1 = parseFixed(bounds[0])!;
  const b2 = parseFixed(bounds[1])!;
  const tier: MarketCapTier = fCmp(value, b1) < 0 ? 'T1' : fCmp(value, b2) < 0 ? 'T2' : 'T3';
  return { tier, proxy, basis, value: fixedToString(value), bounds, boundsMethod, date: input.date };
}

/**
 * 等分位（三等分位 P33/P67）预留默认分界：对全库样本 basis 值排序取分位。
 * 返回 null 当样本不足以定分位（<2 个有效值）。定点输出；分位点插值不外推（取次序统计量）。
 */
export function tercileBounds(values: (string | number | null | undefined)[]): [string, string] | null {
  const parsed = values
    .map((v) => parseFixed(v))
    .filter((v): v is Fixed => v !== null)
    .sort((a, b) => fCmp(a, b));
  if (parsed.length < 2) return null;
  const q = (p: number): Fixed => {
    const idx = Math.min(parsed.length - 1, Math.floor(p * (parsed.length - 1)));
    return parsed[idx]!;
  };
  return [fixedToString(q(1 / 3)), fixedToString(q(2 / 3))];
}

// ===== 市场状态（沪深 300 近 20 个交易日端点比较；§5 层 4）=====

export interface MarketStateResult {
  state: 'UP' | 'DOWN';
  /** 趋势窗（20 个已收盘指数交易日，升序首末日期）。 */
  from: string;
  to: string;
  firstClose: string;
  lastClose: string;
}

/**
 * 市场状态：事件时点已收盘（availableAt = 交易日 15:00+08 ≤ 事件时点）的最近 20 个
 * 沪深 300 交易日，端点比较：期末收盘 ≥ 期初收盘 → UP，否则 DOWN。
 * 不足 20 个已收盘交易日 → null（缺口，不推算）。
 */
export function marketStateOf(hs300Bars: DailyBarInput[], eventTime: string): MarketStateResult | null {
  const eventMs = new Date(eventTime).getTime();
  if (Number.isNaN(eventMs)) return null;
  const closed = hs300Bars
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && new Date(`${b.date}T15:00:00+08:00`).getTime() <= eventMs)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (closed.length < 20) return null;
  const last20 = closed.slice(closed.length - 20);
  const firstClose = parseFixed(last20[0]!.close);
  const lastClose = parseFixed(last20[last20.length - 1]!.close);
  if (firstClose === null || lastClose === null) return null;
  return {
    state: fCmp(lastClose, firstClose) >= 0 ? 'UP' : 'DOWN',
    from: last20[0]!.date,
    to: last20[last20.length - 1]!.date,
    firstClose: fixedToString(firstClose),
    lastClose: fixedToString(lastClose),
  };
}

// ===== 样本层元数据（构建方按上述工具组装；selectGroups 只做机械收窄）=====

export interface ReferenceEventLayers {
  /** 发布版本所需的原事件及成熟窗口；纯统计可缺省，持久发布必须齐备。 */
  lineage?: {
    eventId: string;
    evidenceFactId: string;
    windows: { h: 1 | 5 | 20; status: string; endDate: string | null; maturedAt: string | null }[];
  };
  subject: string;
  eventTime: string;
  /** 事件类型层键（六类 + 子类，如 'PERF_FORECAST' / 'PERF_FORECAST:REVISE_UP'）。 */
  eventKey: string;
  industry: IndustryAsOf | null;
  marketCap: MarketCapTierResult | null;
  marketState: 'UP' | 'DOWN' | null;
  /** 1/5/20 日超额（定点字符串；null = 窗口未完/缺口）。 */
  h1Excess: string | null;
  h5Excess: string | null;
  h20Excess: string | null;
  /** 失效触发两侧（null = 序列不可得）。 */
  invalidationDown: boolean | null;
  invalidationUp: boolean | null;
  /** 样本级具名缺口（逐一刻面，不静默）。 */
  dataGaps: string[];
}

// ===== 基础比例（§8：方向分布 + 失效触发比例两侧；=0 两侧不命中，严格不等）=====

export interface DirectionDist {
  up: number;
  down: number;
  flat: number;
  /** 有效样本数（excess 非 null）；null 样本计入 dataGapCount。 */
  n: number;
}

export interface BaseRateBlock {
  sampleCount: number;
  h1: DirectionDist;
  h5: DirectionDist;
  h20: DirectionDist;
  invalidation: {
    downTriggered: number;
    upTriggered: number;
    /** 可判样本数（两侧均非 null）。 */
    n: number;
    thresholdPct: '10';
    reserved: true;
  };
  /** 缺失样本（任一窗口/触发不可判）计数与具名缺口汇总。 */
  incompleteCount: number;
  dataGaps: string[];
}

function directionDistOf(samples: ReferenceEventLayers[], pick: (s: ReferenceEventLayers) => string | null): DirectionDist {
  let up = 0;
  let down = 0;
  let flat = 0;
  let n = 0;
  const zero = { int: 0n, scale: 0 };
  for (const s of samples) {
    const v = pick(s);
    if (v === null) continue;
    const f = parseFixed(v);
    if (f === null) continue;
    n += 1;
    const c = fCmp(f, zero);
    if (c > 0) up += 1;
    else if (c < 0) down += 1;
    else flat += 1;
  }
  return { up, down, flat, n };
}

export function baseRateOf(samples: ReferenceEventLayers[]): BaseRateBlock {
  const gaps = new Set<string>();
  let incomplete = 0;
  let downN = 0;
  let downHit = 0;
  let upHit = 0;
  for (const s of samples) {
    const missing =
      s.h1Excess === null || s.h5Excess === null || s.h20Excess === null ||
      s.invalidationDown === null || s.invalidationUp === null;
    if (missing) incomplete += 1;
    for (const g of s.dataGaps) gaps.add(`${s.subject}@${s.eventTime}:${g}`);
    if (s.invalidationDown !== null && s.invalidationUp !== null) {
      downN += 1;
      if (s.invalidationDown) downHit += 1;
      if (s.invalidationUp) upHit += 1;
    }
  }
  return {
    sampleCount: samples.length,
    h1: directionDistOf(samples, (s) => s.h1Excess),
    h5: directionDistOf(samples, (s) => s.h5Excess),
    h20: directionDistOf(samples, (s) => s.h20Excess),
    invalidation: { downTriggered: downHit, upTriggered: upHit, n: downN, thresholdPct: '10', reserved: true },
    incompleteCount: incomplete,
    dataGaps: [...gaps].sort(),
  };
}

// ===== 群组匹配（§8 产出物）=====

export type GroupLayerName = 'BASE' | 'EVENT_TYPE' | 'INDUSTRY' | 'MARKET_CAP' | 'MARKET_STATE';

export type LayerStopReason =
  | 'DRILL' // 继续下钻（满足下限）
  | 'STOP_MIN_SAMPLE' // 下一层样本数低于下限，停在本层
  | 'STOP_MISSING_INPUT' // 下一层输入缺失（行业/市值/市场状态不可得），停在本层并具名缺口
  | 'STOP_NO_SAMPLE'; // 事件类型层即无样本（空匹配）

export interface GroupLayerOutcome {
  layer: GroupLayerName;
  key: string;
  sampleCount: number;
  reason: LayerStopReason;
  note: string | null;
  /** 父层基础比例（DRILL 层与 BASE 层携带；STOP 层只给样本数与原因，不给比例）。 */
  baseRate: BaseRateBlock | null;
}

export interface GroupMatchResult {
  /** 匹配请求身份（§8）：股票代码、事件类型（含子类）、事件时点、资料截点。 */
  request: {
    subject: string;
    eventKey: string;
    eventTime: string;
    cutoff: string;
  };
  /** 空匹配时为空数组（§8：只有缺口、没有群组）。 */
  groupPath: GroupLayerOutcome[];
  /** 满足下限的最深层标识与样本数；空匹配为 null。 */
  primaryGroup: { layer: GroupLayerName; key: string; sampleCount: number } | null;
  nestedDeclaration: string;
  revisionNotice: string;
  dataGaps: string[];
  /** 版本绑定（§8：三条版本轴 + 输入事实 available_at 上限 + materialized_at）。 */
  versionBinding: {
    methodVersion: string;
    adapterVersion: string;
    inputAvailableAtMax: string | null;
    materializedAt: string;
  };
}

export interface GroupSelectOptions {
  minGroupSample: number;
  methodVersion: string;
  adapterVersion: string;
  /** 输入事实 available_at 上限（构建读数时点）。 */
  inputAvailableAtMax: string | null;
  materializedAt: string;
}

/** 群组层键（嵌套标识，供 library.ts 的 group_key / path）。 */
export function industryLayerKey(industry: IndustryAsOf): string | null {
  return industry.l1IndexCode === null ? null : `sw${industry.system}:${industry.l1IndexCode}`;
}

export function marketCapLayerKey(cap: MarketCapTierResult): string {
  return `cap:${cap.tier}${cap.proxy ? ':proxy-amount' : ''}`;
}

/**
 * 主群组机械选定（§5 逐层收窄，程序执行、无人工裁量）。
 * query 携带目标事件的各层标签（匹配精确：股票、行业当时版本、时间窗口，§7 第 2 条）；
 * samples 为全库样本层元数据。事件类型层即无样本 → §8 空匹配规则（空路径 + 缺口 + 声明，
 * 不出现任何样本数 ≥ 1 的群组行与任何比例数字）。
 */
export function selectGroups(
  query: {
    subject: string;
    eventKey: string;
    eventTime: string;
    cutoff: string;
    industry: IndustryAsOf | null;
    marketCap: MarketCapTierResult | null;
    marketState: 'UP' | 'DOWN' | null;
  },
  samples: ReferenceEventLayers[],
  opts: GroupSelectOptions,
): GroupMatchResult {
  const dataGaps = new Set<string>();
  const empty: GroupMatchResult = {
    request: { subject: query.subject, eventKey: query.eventKey, eventTime: query.eventTime, cutoff: query.cutoff },
    groupPath: [],
    primaryGroup: null,
    nestedDeclaration: NESTED_GROUP_DECLARATION,
    revisionNotice: REVISION_NOTICE,
    dataGaps: [],
    versionBinding: {
      methodVersion: opts.methodVersion,
      adapterVersion: opts.adapterVersion,
      inputAvailableAtMax: opts.inputAvailableAtMax,
      materializedAt: opts.materializedAt,
    },
  };

  const sameType = samples.filter((s) => s.eventKey === query.eventKey);
  if (sameType.length === 0) {
    // §8 匹配为空：只有缺口、没有群组；不虚构全库比例冒充群组基础比例。
    empty.dataGaps = [`NO_SAMPLE_AT_EVENT_TYPE_LAYER:${query.eventKey}`];
    return empty;
  }

  const layers: GroupLayerOutcome[] = [
    {
      layer: 'BASE',
      key: 'all-events',
      sampleCount: samples.length,
      reason: 'DRILL',
      note: null,
      baseRate: baseRateOf(samples),
    },
    {
      layer: 'EVENT_TYPE',
      key: `type:${query.eventKey}`,
      sampleCount: sameType.length,
      reason: 'DRILL',
      note: null,
      baseRate: baseRateOf(sameType),
    },
  ];

  let current = sameType;
  let drillDeepest: { layer: GroupLayerName; key: string; sampleCount: number } = {
    layer: 'EVENT_TYPE',
    key: `type:${query.eventKey}`,
    sampleCount: sameType.length,
  };

  const tryLayer = (
    layer: GroupLayerName,
    missingGap: string,
    queryValue: string | null,
    note: string | null,
    matchOf: (s: ReferenceEventLayers) => string | null,
  ): boolean => {
    if (queryValue === null) {
      layers.push({
        layer,
        key: '(missing)',
        sampleCount: 0,
        reason: 'STOP_MISSING_INPUT',
        note: null,
        baseRate: null,
      });
      dataGaps.add(missingGap);
      return false;
    }
    const next = current.filter((s) => matchOf(s) === queryValue);
    if (next.length < opts.minGroupSample) {
      layers.push({
        layer,
        key: queryValue,
        sampleCount: next.length,
        reason: 'STOP_MIN_SAMPLE',
        note,
        baseRate: null,
      });
      return false;
    }
    layers.push({ layer, key: queryValue, sampleCount: next.length, reason: 'DRILL', note, baseRate: baseRateOf(next) });
    current = next;
    drillDeepest = { layer, key: queryValue, sampleCount: next.length };
    return true;
  };

  const industryKey = query.industry === null ? null : industryLayerKey(query.industry);
  const indOk = tryLayer(
    'INDUSTRY',
    `INDUSTRY_L1_UNAVAILABLE_AT_EVENT:${query.subject}@${query.eventTime}`,
    industryKey,
    query.industry === null
      ? null
      : `申万${query.industry.system}版（事件时点 as-of；2015–2021 用 2014 版，之后 2021 版，切换点 ${SW_2021_CLASSIFY_EFFECTIVE}；现行行计入 ${query.industry.inDate}）`,
    (s) => (s.industry === null ? null : industryLayerKey(s.industry)),
  );
  if (indOk) {
    const capOk = tryLayer(
      'MARKET_CAP',
      `MARKET_CAP_UNAVAILABLE:${query.subject}@${query.eventTime}`,
      query.marketCap === null ? null : marketCapLayerKey(query.marketCap),
      query.marketCap === null
        ? null
        : `分界 [${query.marketCap.bounds[0]}, ${query.marketCap.bounds[1]}]（${query.marketCap.boundsMethod === 'fixed' ? '固定值' : '等分位预留值，待 P4 校准冻结'}）${query.marketCap.proxy ? '；总股本不可得，成交额代理档位 proxy=true' : ''}`,
      (s) => (s.marketCap === null ? null : marketCapLayerKey(s.marketCap)),
    );
    if (capOk) {
      tryLayer(
        'MARKET_STATE',
        `MARKET_STATE_UNAVAILABLE:${query.subject}@${query.eventTime}`,
        query.marketState === null ? null : `mkt:${query.marketState}`,
        '沪深300 近 20 交易日端点比较（默认算子，§5 层 4）',
        (s) => (s.marketState === null ? null : `mkt:${s.marketState}`),
      );
    }
  }

  for (const s of samples) {
    if (s.eventKey !== query.eventKey) continue;
    for (const g of s.dataGaps) dataGaps.add(`${s.subject}@${s.eventTime}:${g}`);
  }

  return { ...empty, groupPath: layers, primaryGroup: drillDeepest, dataGaps: [...dataGaps].sort() };
}
