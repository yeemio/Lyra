/**
 * Lyra · 申万一级行业中位估值（B 类 W36: code-writer-pro）。
 * 合同：D2 个体股估值的"行业分位"缺口解法（外部行业 PE 历史源不存在已实证，W31 登记；
 * 总控口径裁定 2026-10-25）——**行业中位 PE = 该行业 as-of 成分股"股价/每股收益TTM"的
 * 中位数**，免股本加权的稳健口径。纯本地计算、零新数据源。
 *
 * 数据基础（全部在库，本模块只读）：
 * - INDUSTRY_CLASS_VERSION（sw@p1 分类史）→ as-of 行业归属；
 * - DAILY_BAR（BaoStock）→ 个股 as-of 收盘价；
 * - FINANCIAL（profit 表，epsTTM）→ as-of 按 pubDate 口径可见的最新报告期。
 *
 * 行业归属规则（W7 冻结语义，adapters/sw.ts 头注 + data/sw-semantics-report.json）：
 * 日期 D 的分类 = 计入 ≤ D 的最新行（链头，区间 [validFrom, validTo) 含截点；体系序
 * pre2014<2014<2021 最末、同序 validFrom 最新——与 inputs.ts pickSwIndustryAt 的选择规则
 * 逐字一致，单测钉扎等价，避免循环依赖不 import 之），**行的前缀在读取窗口所属体系下
 * 解释**：行业代码前 2 位按 asOf 窗口体系的前缀表（SW2021_PREFIX_L1 / SW2014_PREFIX_L1）
 * 映射到一级行业指数代码；携带行（跨体系未变更，如 pre2014 铸造行在 2021 窗口）由此
 * 取得归属，窗口表无该前缀（如 2014 的 21 采掘 / 51 综合在 2021 窗口）→ 归属不可定，
 * 剔除并如实计数（sw.ts 明示"消费方按读取窗口体系解释前缀时用前缀表自行判定"）。
 *
 * 数值口径（全部 scale-12 定点，复用 settlement/decimal.ts，无浮点）：
 * - 个股 PE = as-of 收盘 / epsTTM（decDiv half-up）；
 * - 行业中位 PE = 成分 PE 升序取中位：奇数个取正中；偶数个取中间两数均值（和÷2，
 *   scale-12 half-up）；n=0（样本全被剔除）→ medianPE=null 照常出行；
 * - epsTTM≤0 或收盘≤0 的样本剔除并逐行业计数（亏损/异常不虚构不插补）；
 * - n<LOW_COVERAGE_MIN(5) 的行业 lowCoverage=true 照常输出；体系内无样本行业列入
 *   missingIndustries（缺行如实，不以他体系顶替——rotation.ts 同纪律）；
 * - pePercentileOf：个股 PE 对本行业 as-of **截面**分位（非历史时序分位——历史每时点
 *   中位序列首版冻结不自算）：PERCENTRANK 口径 = 严格小于该值的样本数 / (n−1)，
 *   同值同分位，截面唯一最小值=0、唯一最大值=1；n=1（分母 0）与空截面具名拒绝；
 *   值超出截面 [min,max] 具名拒绝（样本外无截面分位意义）。
 *
 * as-of 可见性口径（装载器；P1 冻结 availableAt 规则）：
 * - 截点 = asOf 15:00 Asia/Shanghai（收盘；与 settlement/real-samples.cli.ts 口径一致）；
 * - DAILY_BAR：availableAt=交易日 15:00+08 → date ≤ asOf 的收盘可见（含当日）；
 * - FINANCIAL：availableAt=pubDate 次日 00:00+08 → pubDate ≤ asOf−1 可见（当日披露的
 *   报表次日才可得，保守不前视）；纯函数日期级校验（pubDate/statDate/barDate ≤ asOf）
 *   是弱后备，时间戳级过滤以装载器为准；
 * - 样本宇宙 = 库内 as-of 可见 FINANCIAL(profit) + DAILY_BAR 的股票集（当前 = 冻结池
 *   26 股 + 池候选股的 DAILY_BAR——候选股无 FINANCIAL 则不入宇宙；非全市场成分，
 *   覆盖限制随表注记如实声明）。
 */
import type { Pool } from 'pg';
import { selectIndustryBenchmark } from '../conclusion/benchmark.js';
import type { TimePointFact } from '../contracts.js';
import { asOfFacts } from '../pintime/facts.js';
import {
  SW_2014_EFFECTIVE,
  SW_2021_CLASSIFY_EFFECTIVE,
  SW2014_PREFIX_L1,
  SW2021_PREFIX_L1,
} from '../adapters/sw.js';
import {
  decAdd,
  decCmp,
  decDiv,
  decFromInt,
  decFromString,
  decToString,
  type Dec,
} from '../settlement/decimal.js';

/** 行业估值域具名错误（code 为稳定错误名，不携带实现细节）。 */
export class IndustryValuationError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'IndustryValuationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^\d{6}$/;

/** 低覆盖阈值：行业有效样本 n < 5 → lowCoverage=true（照常输出）。 */
export const LOW_COVERAGE_MIN = 5;

const DEC_TWO: Dec = decFromInt(2);

// ===== 体系判定（W7 冻结边界，只读复用；错误名为本域具名）=====

export type ValuationSystem = '2014' | '2021';

/** as-of 当时的申万一级行业体系（分类生效边界 2021-07-30；早于 2014 体系具名拒绝）。 */
export function valuationSystemOf(asOf: string): ValuationSystem {
  if (!DATE_RE.test(asOf)) {
    throw new IndustryValuationError('INDUSTRY_VALUATION_AS_OF_INVALID', `asOf: ${asOf}（须 YYYY-MM-DD）`);
  }
  if (asOf < SW_2014_EFFECTIVE) {
    throw new IndustryValuationError(
      'INDUSTRY_VALUATION_AS_OF_PRE_2014',
      `asOf ${asOf} 早于 2014 体系生效日 ${SW_2014_EFFECTIVE}：老申万 23 前缀体系无核验一级指数映射（sw-semantics-report），如实具名拒绝不猜`,
    );
  }
  return asOf >= SW_2021_CLASSIFY_EFFECTIVE ? '2021' : '2014';
}

/** 体系内申万一级行业指数代码全集（冻结前缀表的值域去重升序；2014=28 / 2021=31）。 */
export function valuationIndustryCodes(system: ValuationSystem): string[] {
  const table = system === '2021' ? SW2021_PREFIX_L1 : SW2014_PREFIX_L1;
  return [...new Set(Object.values(table))].sort();
}

// ===== 样本（纯函数输入）=====

/**
 * 个股 as-of 估值样本：装载器已按 as-of 可见性解出最新收盘与最新可见报告期 epsTTM，
 * 纯函数只做确定性校验与计算（日期级校验 ≤ asOf 是装载漏未来数据的防御后备）。
 */
export interface StockPESample {
  /** 裸 6 位股票代码（如 600519）。 */
  code: string;
  /** as-of 申万一级行业指数代码（裸 6 位，如 801120；须属 asOf 窗口体系）。 */
  industryIndexCode: string;
  /** as-of 最新收盘价（十进制定点字符串）。 */
  close: string;
  /** 该收盘的交易日（YYYY-MM-DD，须 ≤ asOf）。 */
  barDate: string;
  /** as-of 可见最新报告期每股收益 TTM（十进制定点字符串）。 */
  epsTTM: string;
  /** 报告期（YYYY-MM-DD，须 ≤ asOf）。 */
  statDate: string;
  /** 披露日（YYYY-MM-DD，须 ≤ asOf；pubDate 口径可见性见头部注记）。 */
  pubDate: string;
}

function validateSample(sample: StockPESample, asOf: string): void {
  if (!CODE_RE.test(sample.code)) {
    throw new IndustryValuationError('INDUSTRY_VALUATION_SAMPLE_CODE_INVALID', `code: "${sample.code}"（须 6 位数字）`);
  }
  if (!CODE_RE.test(sample.industryIndexCode)) {
    throw new IndustryValuationError(
      'INDUSTRY_VALUATION_INDUSTRY_CODE_INVALID',
      `${sample.code} industryIndexCode: "${sample.industryIndexCode}"（须 6 位数字）`,
    );
  }
  for (const [field, value] of [['barDate', sample.barDate], ['statDate', sample.statDate], ['pubDate', sample.pubDate]] as const) {
    if (!DATE_RE.test(value)) {
      throw new IndustryValuationError('INDUSTRY_VALUATION_SAMPLE_DATE_INVALID', `${sample.code} ${field}: "${value}"（须 YYYY-MM-DD）`);
    }
    if (value > asOf) {
      throw new IndustryValuationError(
        'INDUSTRY_VALUATION_SAMPLE_FUTURE_DATED',
        `${sample.code} ${field} ${value} 晚于 asOf ${asOf}——装载漏入未来数据（as-of 纪律，防御性拒绝）`,
      );
    }
  }
}

/**
 * 个股 PE = close / epsTTM（scale-12 定点 half-up）。非正 close/epsTTM 具名拒绝
 * （单股 PE 无意义口径；行业表内剔除路径见 industryMedianPE 的 excludedNonPositive）。
 */
export function stockPEOf(sample: StockPESample, asOf: string): Dec {
  validateSample(sample, asOf);
  const close = decFromString(sample.close, `${sample.code} close`);
  const eps = decFromString(sample.epsTTM, `${sample.code} epsTTM`);
  if (close.scaled <= 0n || eps.scaled <= 0n) {
    throw new IndustryValuationError(
      'INDUSTRY_VALUATION_SAMPLE_NON_POSITIVE',
      `${sample.code} close=${sample.close} epsTTM=${sample.epsTTM}（须均为正）`,
    );
  }
  return decDiv(close, eps);
}

// ===== 行业中位 PE 表（纯函数）=====

export interface IndustryMedianPERow {
  /** 申万一级行业指数代码（升序输出）。 */
  industryIndexCode: string;
  /** 行业名称标签（SW_INDEX_LIST 当前快照注入的便捷标签，非时点事实；缺省 null）。 */
  name: string | null;
  /** 有效样本数（剔除非正后）。 */
  n: number;
  /** n < LOW_COVERAGE_MIN 时 true（照常输出）。 */
  lowCoverage: boolean;
  /** 行业中位 PE（scale-12 定点字符串；样本全被剔除的 n=0 行为 null）。 */
  medianPE: string | null;
  /** epsTTM≤0 或收盘≤0 剔除计数（逐行业如实）。 */
  excludedNonPositive: number;
  /** 本行业有效 PE 升序序列（分位上下文：pePercentileOf 的截面输入）。 */
  peSeries: string[];
}

export interface IndustryMedianPETable {
  /** 资料截点（YYYY-MM-DD；行业身份按该时点窗口体系冻结）。 */
  asOf: string;
  /** 所用申万一级行业体系。 */
  system: ValuationSystem;
  /** 输入样本总数。 */
  inputCount: number;
  /** 有效样本总数（剔除非正后 = Σrows[].n）。 */
  eligibleCount: number;
  /** 非正剔除总数（= Σrows[].excludedNonPositive）。 */
  excludedNonPositiveTotal: number;
  /** 代码升序的行（体系内至少 1 个输入样本的行业；含全剔除 n=0 行）。 */
  rows: IndustryMedianPERow[];
  /** 体系内应有指数中无任何输入样本的代码（升序；缺行如实）。 */
  missingIndustries: string[];
  /** 口径注记（材料嵌入用）。 */
  note: string;
}

export interface IndustryMedianPEOptions {
  /** 行业代码 → 名称标签（SW_INDEX_LIST 当前快照；名称是便捷标签非时点事实，缺省 null）。 */
  names?: ReadonlyMap<string, string>;
}

/**
 * 行业中位 PE 表（纯函数）：输入 as-of 已解的个股估值样本，按行业归并计算确定性中位。
 * 校验具名拒绝：代码重复 / 行业不在 asOf 窗口体系 / 未来日期 / 非法定点格式（后者由
 * decFromString 抛 SettlementError('DECIMAL_INVALID')，字段名自含上下文）。
 */
export function industryMedianPE(
  inputs: readonly StockPESample[],
  asOf: string,
  options?: IndustryMedianPEOptions,
): IndustryMedianPETable {
  const system = valuationSystemOf(asOf);
  const universe = new Set(valuationIndustryCodes(system));

  const seenCodes = new Set<string>();
  const byIndustry = new Map<string, { pes: Dec[]; excluded: number }>();
  for (const sample of inputs) {
    validateSample(sample, asOf);
    if (seenCodes.has(sample.code)) {
      throw new IndustryValuationError('INDUSTRY_VALUATION_SAMPLE_DUPLICATE_CODE', `code ${sample.code} 重复输入`);
    }
    seenCodes.add(sample.code);
    if (!universe.has(sample.industryIndexCode)) {
      throw new IndustryValuationError(
        'INDUSTRY_VALUATION_INDUSTRY_OUT_OF_SYSTEM',
        `${sample.code} industryIndexCode ${sample.industryIndexCode} 不在 as-of ${asOf} 窗口 ${system} 体系行业全集（${String(universe.size)} 码）内`,
      );
    }
    const close = decFromString(sample.close, `${sample.code} close`);
    const eps = decFromString(sample.epsTTM, `${sample.code} epsTTM`);
    let entry = byIndustry.get(sample.industryIndexCode);
    if (entry === undefined) {
      entry = { pes: [], excluded: 0 };
      byIndustry.set(sample.industryIndexCode, entry);
    }
    if (close.scaled <= 0n || eps.scaled <= 0n) {
      entry.excluded += 1; // 亏损/异常样本剔除，逐行业计数如实
      continue;
    }
    entry.pes.push(decDiv(close, eps));
  }

  const rows: IndustryMedianPERow[] = [];
  const missing: string[] = [];
  let eligibleTotal = 0;
  let excludedTotal = 0;
  for (const code of valuationIndustryCodes(system)) {
    const entry = byIndustry.get(code);
    if (entry === undefined) {
      missing.push(code); // 缺行如实：体系内应有而无任何输入样本
      continue;
    }
    const pes = [...entry.pes].sort((a, b) => decCmp(a, b));
    const n = pes.length;
    let median: Dec | null = null;
    if (n % 2 === 1) {
      median = pes[(n - 1) / 2] as Dec;
    } else if (n >= 2) {
      median = decDiv(decAdd(pes[n / 2 - 1] as Dec, pes[n / 2] as Dec), DEC_TWO); // 偶数个取中间两数均值
    }
    rows.push({
      industryIndexCode: code,
      name: options?.names?.get(code) ?? null,
      n,
      lowCoverage: n < LOW_COVERAGE_MIN,
      medianPE: median === null ? null : decToString(median),
      excludedNonPositive: entry.excluded,
      peSeries: pes.map((p) => decToString(p)),
    });
    eligibleTotal += n;
    excludedTotal += entry.excluded;
  }

  const note =
    `行业中位 PE 表：as-of ${asOf}；申万一级行业体系 ${system}` +
    (system === '2021' ? '（2021-07-30 起现行 31 行业）' : '（2014-02-21~2021-07-29 旧体系 28 行业，含 801020 采掘）') +
    '；口径：行业中位 PE = 该行业 as-of 可见成分股"收盘价/每股收益TTM"的中位数（免股本加权的稳健口径；样本宇宙 = 装载器 as-of 可见 FINANCIAL(profit)+DAILY_BAR 的股票集，非全市场成分——覆盖限制如实随行）' +
    `；剔除：epsTTM≤0 或收盘≤0 的样本剔除并逐行业计数；覆盖：n<${String(LOW_COVERAGE_MIN)} 的行业 lowCoverage=true 照常输出；` +
    '体系内无样本行业列于 missingIndustries（缺行如实）；分位：pePercentileOf 为本行业 as-of 截面分位（PERCENTRANK 口径 i/(n−1)，非历史时序分位）。';

  return {
    asOf,
    system,
    inputCount: inputs.length,
    eligibleCount: eligibleTotal,
    excludedNonPositiveTotal: excludedTotal,
    rows,
    missingIndustries: missing,
    note,
  };
}

// ===== 截面分位（纯函数）=====

/**
 * 个股 PE 对行业 as-of 截面的分位（PERCENTRANK 口径）：严格小于 value 的样本数 / (n−1)。
 * 同值样本取同分位；截面唯一最小值 = 0、唯一最大值 = 1；序列含自身（口径：截面 = 本行业
 * 全部有效样本）。空截面 / 单样本（分母 0）/ 值超出 [min,max] 具名拒绝。
 */
export function pePercentileOf(value: Dec, series: readonly Dec[]): Dec {
  const n = series.length;
  if (n === 0) {
    throw new IndustryValuationError('INDUSTRY_VALUATION_PERCENTILE_EMPTY', '截面序列为空');
  }
  if (n === 1) {
    throw new IndustryValuationError('INDUSTRY_VALUATION_PERCENTILE_SINGLE_SAMPLE', '截面仅 1 个样本（分母 n−1=0，分位无意义）');
  }
  let below = 0;
  let min = series[0] as Dec;
  let max = series[0] as Dec;
  for (const x of series) {
    if (decCmp(x, min) < 0) min = x;
    if (decCmp(x, max) > 0) max = x;
    if (decCmp(x, value) < 0) below += 1;
  }
  if (decCmp(value, min) < 0 || decCmp(value, max) > 0) {
    throw new IndustryValuationError(
      'INDUSTRY_VALUATION_PERCENTILE_OUT_OF_RANGE',
      `value ${decToString(value)} 超出截面 [${decToString(min)}, ${decToString(max)}]（样本外无截面分位意义）`,
    );
  }
  return decDiv(decFromInt(below), decFromInt(n - 1));
}

// ===== 装载器（DB as-of 装载；纯函数不含本节）=====

/** 申万体系序（D6/链头规则同款；与 inputs.ts SW_SYSTEM_RANK 逐字一致）。 */
const SW_SYSTEM_RANK: Record<string, number> = { pre2014: 0, '2014': 1, '2021': 2 };

function tvOf(fact: TimePointFact): Record<string, unknown> {
  return fact.typedValue as Record<string, unknown>;
}

export interface SwChainHead {
  fact: TimePointFact;
  /** 链头行的铸造体系（typedValue.体系）。 */
  system: string;
}

/**
 * 截点当时的申万轴链头行（选择规则与 inputs.ts pickSwIndustryAt 逐字一致：区间
 * [validFrom, validTo) 含截点 → 体系序最末 → 同序 validFrom 最新 → factId 最大；
 * 证监会轴行〔体系 字段缺失〕不参与）。本副本为免循环依赖（inputs.ts 未来接线本模块），
 * 等价性由单测钉扎；D6 规则演进须同步本副本。
 */
export function pickSwChainHeadAt(facts: readonly TimePointFact[], cutoff: Date): SwChainHead | null {
  const valid = facts.filter((f) => {
    if (f.factKind !== 'INDUSTRY_CLASS_VERSION') return false;
    const system = tvOf(f).体系;
    if (typeof system !== 'string') return false; // 证监会轴（classVersion）不参与
    const from = f.validFrom === null ? null : new Date(f.validFrom).getTime();
    const to = f.validTo === null ? null : new Date(f.validTo).getTime();
    const c = cutoff.getTime();
    if (from !== null && from > c) return false;
    if (to !== null && to <= c) return false;
    return true;
  });
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const ra = SW_SYSTEM_RANK[String(tvOf(a).体系)] ?? -1;
    const rb = SW_SYSTEM_RANK[String(tvOf(b).体系)] ?? -1;
    if (ra !== rb) return ra - rb;
    const fa = new Date(a.validFrom ?? a.availableAt).getTime();
    const fb = new Date(b.validFrom ?? b.availableAt).getTime();
    if (fa !== fb) return fa - fb;
    return a.factId < b.factId ? -1 : 1;
  });
  const fact = valid[valid.length - 1] as TimePointFact;
  return { fact, system: String(tvOf(fact).体系) };
}

/**
 * 链头行在读取窗口体系下的一级行业指数代码（W7 语义：前缀在读取窗口所属体系下解释；
 * sw.ts 明示消费方用 SW2014/SW2021_PREFIX_L1 自行判定）。窗口表无该前缀 → null（不猜）。
 */
export function swL1OfWindow(head: SwChainHead, system: ValuationSystem): string | null {
  const industryCode = tvOf(head.fact).行业代码;
  if (typeof industryCode !== 'string' || industryCode.length < 2) return null;
  const table = system === '2021' ? SW2021_PREFIX_L1 : SW2014_PREFIX_L1;
  return table[industryCode.slice(0, 2)] ?? null;
}

/** 装载结果：样本 + 宇宙与逐级跳过清单（覆盖限制如实）。 */
export interface StockPESamplesLoad {
  asOf: string;
  /** 调用方的精确截点，不提升到当日收盘。 */
  cutoffIso: string;
  inputFacts: TimePointFact[];
  /** as-of 可见 FINANCIAL(profit) 股票数（样本宇宙上界）。 */
  universe: number;
  samples: StockPESample[];
  /** 最新可见 profit 行缺/空 epsTTM 的股票（跳过，不用旧报告期补——不混期）。 */
  skippedNoEpsTTM: string[];
  /** 有 epsTTM 但无 as-of 可见收盘（date ≤ asOf 无行情行）的股票。 */
  skippedNoBar: string[];
  /** 链头行前缀在窗口体系无映射（或无申万轴链头）的股票。 */
  skippedNoAttribution: string[];
  /** 行业代码 → 名称标签（截点内 SW_INDEX_LIST 标签；不将当前标签补入旧材料）。 */
  names: ReadonlyMap<string, string> | null;
  note: string;
}

/**
 * 装载 as-of 估值样本（DB）：每股取 as-of 可见最新 FINANCIAL(profit)（statDate 最大，
 * 同报告期 pubDate 最新）+ as-of 最新收盘（date ≤ asOf 最大）+ as-of 链头行读取窗口
 * 前缀归属。同日重复行情行不同收盘具名拒绝（来源冲突不静默合并，DATA-SOURCES §6.5）。
 */
export async function loadStockPESamples(pool: Pool, cutoffInstant: string | Date): Promise<StockPESamplesLoad> {
  const cutoff = new Date(cutoffInstant);
  if (Number.isNaN(cutoff.getTime()) || (typeof cutoffInstant === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(cutoffInstant))) {
    throw new IndustryValuationError('INDUSTRY_VALUATION_AS_OF_INVALID', 'cutoff 必须为带时区的精确时刻');
  }
  const asOf = new Date(cutoff.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const system = valuationSystemOf(asOf);
  const cutoffIso = cutoff.toISOString();
  const used = new Map<string, TimePointFact>();

  // ---- FINANCIAL(profit) as-of 可见 → 每股最新报告期（pubDate 口径可见性由 availableAt 过滤承载）----
  const fins = await asOfFacts(pool, { subjectType: 'STOCK', factKind: 'FINANCIAL', asOf: cutoff });
  interface ProfitEntry { code: string; factId: string; fact: TimePointFact; statDate: string; pubDate: string; tv: Record<string, unknown> }
  const latestByStock = new Map<string, ProfitEntry>();
  for (const f of fins) {
    const v = tvOf(f);
    if (v.bsQuery !== 'profit') continue;
    const codeRaw = v.code;
    if (typeof codeRaw !== 'string') continue;
    const code = codeRaw.replace(/^(?:sh|sz|bj)\./, '');
    if (!CODE_RE.test(code)) continue;
    const statDate = typeof v.statDate === 'string' ? v.statDate : '';
    const pubDate = typeof v.pubDate === 'string' ? v.pubDate : '';
    const cur = latestByStock.get(code);
    const better =
      cur === undefined ||
      statDate > cur.statDate ||
      (statDate === cur.statDate && (pubDate > cur.pubDate || (pubDate === cur.pubDate && f.factId > cur.factId)));
    if (better) latestByStock.set(code, { code, factId: f.factId, fact: f, statDate, pubDate, tv: v });
  }
  const universe = latestByStock.size;

  // ---- 逐股：收盘 + 行业归属 → 样本 ----
  const samples: StockPESample[] = [];
  const skippedNoEpsTTM: string[] = [];
  const skippedNoBar: string[] = [];
  const skippedNoAttribution: string[] = [];
  for (const code of [...latestByStock.keys()].sort()) {
    const entry = latestByStock.get(code) as ProfitEntry;
    used.set(entry.factId, entry.fact);
    const epsTTM = entry.tv.epsTTM;
    if (typeof epsTTM !== 'string' || epsTTM === '') {
      skippedNoEpsTTM.push(code); // 最新可见报告期无 epsTTM：如实跳过，不以旧报告期补值（不混期）
      continue;
    }

    const bars = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: code, factKind: 'DAILY_BAR', asOf: cutoff });
    const closesByDate = new Map<string, string>();
    for (const b of bars) {
      const v = tvOf(b);
      const date = v.date;
      const close = v.close;
      if (typeof date !== 'string' || !DATE_RE.test(date) || date > asOf) continue;
      if (typeof close !== 'string' || close === '') {
        throw new IndustryValuationError('INDUSTRY_VALUATION_CLOSE_INVALID', `${code} ${date} 收盘字段缺失/非字符串`);
      }
      const seen = closesByDate.get(date);
      if (seen !== undefined && seen !== close) {
        throw new IndustryValuationError('INDUSTRY_VALUATION_BAR_CONFLICT', `${code} ${date} 同日重复行情行不同收盘（来源冲突不静默合并）`);
      }
      closesByDate.set(date, close);
    }
    const dates = [...closesByDate.keys()].sort();
    const latestDate = dates[dates.length - 1];
    if (latestDate === undefined) {
      skippedNoBar.push(code);
      continue;
    }
    const close = closesByDate.get(latestDate) as string;
    for (const b of bars.filter((f) => tvOf(f).date === latestDate)) used.set(b.factId, b);

    const classFacts = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: code, factKind: 'INDUSTRY_CLASS_VERSION', asOf: cutoff });
    const attribution = selectIndustryBenchmark(classFacts, code, cutoff);
    if (attribution !== null) used.set(attribution.fact.factId, attribution.fact);
    const l1 = attribution?.industry?.industryIndexCode ?? null;
    if (l1 === null) {
      skippedNoAttribution.push(code); // 链头前缀在窗口体系无核验映射——不猜
      continue;
    }

    samples.push({
      code,
      industryIndexCode: l1,
      close,
      barDate: latestDate,
      epsTTM,
      statDate: entry.statDate,
      pubDate: entry.pubDate,
    });
  }

  // ---- 截点内行业名称标签；精确输入身份随材料封存 ----
  let names: ReadonlyMap<string, string> | null = null;
  try {
    const lists = await asOfFacts(pool, { factKind: 'SW_INDEX_LIST', asOf: cutoff });
    const list = lists.at(-1);
    const rows = (list?.typedValue as { rows?: unknown } | undefined)?.rows;
    if (Array.isArray(rows)) {
      used.set(list!.factId, list!);
      const m = new Map<string, string>();
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const codeRaw = (row as Record<string, unknown>)['行业代码'];
        const name = (row as Record<string, unknown>)['行业名称'];
        if (typeof codeRaw === 'string' && typeof name === 'string' && name !== '') {
          m.set(codeRaw.replace(/\.SI$/, ''), name);
        }
      }
      names = m;
    }
  } catch {
    names = null;
  }

  const note =
    `估值样本装载：上海业务日 ${asOf}，精确截点 ${cutoffIso}（不推进到当日收盘）；` +
    '可见性：DAILY_BAR date ≤ asOf（availableAt=当日 15:00+08），FINANCIAL availableAt=pubDate 次日 00:00+08（pubDate ≤ asOf−1 可见，当日披露次日可得）；' +
    `样本宇宙 = 库内 as-of 可见 FINANCIAL(profit) 股票（${String(universe)} 股，非全市场成分）；` +
    `逐级跳过：无 epsTTM ${String(skippedNoEpsTTM.length)} / 无收盘 ${String(skippedNoBar.length)} / 行业归属不可定 ${String(skippedNoAttribution.length)}` +
    '；行业归属与冻结基准共用读取窗口体系（' + system + '）的归属行/跨体系前缀规则。';

  return {
    asOf,
    cutoffIso,
    inputFacts: [...used.values()].sort((a, b) => a.factId.localeCompare(b.factId)),
    universe,
    samples,
    skippedNoEpsTTM,
    skippedNoBar,
    skippedNoAttribution,
    names,
    note,
  };
}
