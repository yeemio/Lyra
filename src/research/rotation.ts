/**
 * Lyra · 行业轮动监测表（B 类 B5 / W34: code-writer-pro）。
 * 合同：docs/specs/RESEARCH-METHOD.md §4 维度 6（行业景气与政策：行业指数趋势）——
 * B 类需求（总控登记批准实施），纯本地计算、零新数据源：库内 SW_INDEX_BAR 已有
 * 申万一级行业指数全史（31 现行体系 + 801020 旧体系指数），本模块只做确定性汇总。
 *
 * 体系切换纪律（adapters/sw.ts W7 冻结边界）：
 * - as-of < 2021-07-30（SW_2021_CLASSIFY_EFFECTIVE）按 2014 体系 28 行业
 *   （含 801020 采掘；801950/801960/801970/801980 属 2021 体系，不入表）；
 * - as-of ≥ 2021-07-30 按 2021 体系 31 行业（801020 已退役，不入表）；
 * - 分类生效（2021-07-30）与指数切换（2021-12-13）是两条官方时间线：窗口落在其间时
 *   新体系应有而尚无行情的行业按缺行如实呈现（missingIndustries），不以旧体系指数顶替；
 * - as-of < 2014-02-21（SW_2014_EFFECTIVE）：老申万 23 前缀体系无核验一级指数映射，
 *   具名拒绝不猜（sw-semantics-report；2015 前研究窗口外）。
 *
 * 数值口径（全部 scale-12 定点，复用 settlement/decimal.ts）：
 * - 近 N 收盘日收益 = P_t / P_{t−N} − 1（N ∈ {20,60,120}；t = as-of 前最后一根收盘，
 *   收盘原值比——行业指数无复权概念；不足 N+1 根为 null，如实缺省不外推）；
 * - 20 日波动 = 最近 20 个收盘对数收益 r_i = ln(P_i/P_{i−1}) 的**总体**标准差
 *   （÷N 描述性口径，窗口实现值的标准差，不作样本估计量推断）；
 * - ln 与 √ 是 decimal.ts 未提供的两个原语，本模块以 BigInt 定点自实现：
 *   decLnRatio 内部工作精度 scale 24（比值在 24 位上取回 → 平方根折半归约到
 *   [1/√2, √2] → atanh 级数，|z| ≤ 0.1716 至多约 32 项收敛到 10^−24），结果单次
 *   half-up 舍入到 scale 12；decSqrt 用整数牛顿开方后单次 half-up 舍入到 scale 12。
 *   两者对真值误差 ≤ 1 ulp，全程 BigInt 无浮点，确定性（同输入恒同输出）。
 *
 * 排名规则（写死）：按 20 日收益降序；同值按行业代码升序；20 日收益不可得（不足
 * 21 根）的行列于全部可得行之后（按代码升序）；rank = 行序 1..n。
 *
 * 反过度工程（派发冻结）：行业间两两相对强度（industryRelativeTable）与热力图类
 * 复杂度不做——一张表 + 排名即交付。
 */
import {
  SW_2014_EFFECTIVE,
  SW_2021_CLASSIFY_EFFECTIVE,
  SW2014_PREFIX_L1,
  SW2021_PREFIX_L1,
} from '../adapters/sw.js';
import {
  DEC_ONE,
  DEC_ZERO,
  decAdd,
  decCmp,
  decDiv,
  decFromInt,
  decFromString,
  decMul,
  decSub,
  decToString,
  type Dec,
} from '../settlement/decimal.js';

/** 轮动域具名错误（code 为稳定错误名，不携带实现细节）。 */
export class RotationError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RotationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 20 日波动窗口（对数收益个数；与近 20 收盘日收益共用 21 根行情下界）。 */
const VOLATILITY_WINDOW = 20;

// ===== 定点原语（decimal.ts 未提供的 ln 与 √；BigInt 全程无浮点）=====

const WORK_SCALE = 24; // 内部工作精度（12 位守卫位，只在结果处单次舍入）
const WORK_POW = 10n ** BigInt(WORK_SCALE);
/** ln 归约区间 [1/√2, √2] 的 scale-24 整数边界（isqrt 精确导出，无魔法小数常量）。 */
const LN_LOWER = isqrtFloor(5n * 10n ** 47n); // floor(10^24/√2)
const LN_UPPER = isqrtFloor(2n * 10n ** 48n); // floor(√2·10^24)

/** 整数平方根（下取整；牛顿迭代，v ≥ 0）。 */
function isqrtFloor(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length + 1) >> 1); // 初值 ≥ √v
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** 正整数域 half-up 整除（与 decimal.ts divRoundHalfUp 的正数分支同式）。 */
function halfUpDivPos(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/** scale-24 定点 → scale-12 定点（half 远离零，与 decimal.ts 舍入方向一致）。 */
function round24to12(v24: bigint): bigint {
  const sign = v24 < 0n ? -1n : 1n;
  const a = v24 < 0n ? -v24 : v24;
  return sign * halfUpDivPos(a, 10n ** 12n);
}

/**
 * ln(num/den)（num、den 均为正定点）：内部比值在 scale 24 上取回，平方根折半归约到
 * [1/√2, √2] 后按 ln(r) = 2·atanh((r−1)/(r+1)) 级数求值，结果单次舍入到 scale 12。
 */
export function decLnRatio(num: Dec, den: Dec, field = 'lnRatio'): Dec {
  if (num.scaled <= 0n || den.scaled <= 0n) {
    throw new RotationError(
      'ROTATION_LN_DOMAIN',
      `${field}: ln(${decToString(num)}/${decToString(den)})（对数定义域须为正定点）`,
    );
  }
  let r = halfUpDivPos(num.scaled * WORK_POW, den.scaled); // 比值 at scale 24
  let halvings = 0;
  while (r < LN_LOWER || r > LN_UPPER) {
    r = isqrtFloor(r * WORK_POW); // √r at scale 24（下取整，1e-24 级误差在结果精度下不可见）
    halvings += 1;
    if (halvings > 64) throw new RotationError('ROTATION_LN_RANGE', `${field}: 归约超界（防御性上界，不应到达）`);
  }
  if (r === WORK_POW) return DEC_ZERO; // 比值恰为 1
  const negative = r < WORK_POW;
  const zNum = (negative ? WORK_POW - r : r - WORK_POW) * WORK_POW;
  const z = halfUpDivPos(zNum, r + WORK_POW); // |z| = |r−1|/(r+1) ≤ 0.1716 at scale 24
  let sum = 0n; // atanh(z) = Σ z^(2k+1)/(2k+1)（z > 0 域单调收敛）
  let power = z; // 当前项的 z^(2k+1) at scale 24
  const z2 = halfUpDivPos(z * z, WORK_POW); // z² at scale 24（每步 ×z² 只取奇次幂）
  let divisor = 1n;
  for (;;) {
    if (power === 0n) break; // 项在 scale 24 上归零：截断误差 < 1e-24
    sum += halfUpDivPos(power, divisor);
    power = halfUpDivPos(power * z2, WORK_POW); // ×z² 每步至少缩至 0.03
    divisor += 2n;
    if (divisor > 401n) throw new RotationError('ROTATION_LN_RANGE', `${field}: 级数超界（防御性上界，不应到达）`);
  }
  const ln24 = 2n * sum * 2n ** BigInt(halvings); // ×2（atanh 倍率）×2^halvings（归约还原），均精确
  return { scaled: round24to12(negative ? -ln24 : ln24) };
}

/** √a（a ≥ 0）：整数牛顿开方后单次 half-up 舍入到 scale 12。 */
export function decSqrt(a: Dec, field = 'sqrt'): Dec {
  if (a.scaled < 0n) {
    throw new RotationError('ROTATION_SQRT_DOMAIN', `${field}: ${decToString(a)}（负数无实平方根）`);
  }
  const t = a.scaled * 10n ** 12n; // √(a·10^12) 的舍入即结果 at scale 12
  const s = isqrtFloor(t);
  return { scaled: t - s * s > s ? s + 1n : s }; // round-half-up(√t)：t − s² > s ⟺ √t > s + 0.5
}

// ===== 体系判定（W7 冻结边界，只读复用）=====

export type RotationSystem = '2014' | '2021';

/** as-of 当时的申万一级行业体系（分类生效边界 2021-07-30；早于 2014 体系具名拒绝）。 */
export function rotationSystemOf(asOf: string): RotationSystem {
  if (!DATE_RE.test(asOf)) {
    throw new RotationError('ROTATION_AS_OF_INVALID', `asOf: ${asOf}（须 YYYY-MM-DD）`);
  }
  if (asOf < SW_2014_EFFECTIVE) {
    throw new RotationError(
      'ROTATION_AS_OF_PRE_2014',
      `asOf ${asOf} 早于 2014 体系生效日 ${SW_2014_EFFECTIVE}：老申万 23 前缀体系无核验一级指数映射（sw-semantics-report），如实具名拒绝不猜`,
    );
  }
  return asOf >= SW_2021_CLASSIFY_EFFECTIVE ? '2021' : '2014';
}

/** 体系内申万一级行业指数代码全集（冻结前缀表的值域去重升序；2014=28 / 2021=31）。 */
export function rotationIndustryCodes(system: RotationSystem): string[] {
  const table = system === '2021' ? SW2021_PREFIX_L1 : SW2014_PREFIX_L1;
  return [...new Set(Object.values(table))].sort();
}

// ===== 行业轮动监测表 =====

/**
 * 行业指数行情行视图（结构相容即受：settlement/excess.ts 的 IndexBarView 经
 * toIndexBarView 规范化后直接可传；close 须为十进制定点字符串且为正）。
 */
export interface IndustryIndexBarView {
  /** 交易日（YYYY-MM-DD）。 */
  date: string;
  /** 收盘点位（十进制定点字符串；jsonb number 须经 decFrom/toIndexBarView 规范化）。 */
  close: string;
}

export interface IndustryMomentumRow {
  /** 综合排名 = 行序（规则写死：20 日收益降序 → 同值代码升序 → 不可得列末）。 */
  rank: number;
  /** 申万一级行业指数代码（裸 6 位，如 801080）。 */
  industryIndexCode: string;
  /** 行业名称（注入的标签表命中则给出，否则 null——名称标签非时点事实，不编造）。 */
  name: string | null;
  /** as-of 截止（date ≤ asOf）可用收盘行数（审计口径）。 */
  barsUsed: number;
  /** 最后一根 date ≤ asOf 的行情日；该行业在体系内但无行情时不出现本行（缺行如实）。 */
  lastBarDate: string;
  /** 近 20 收盘日收益 P_t/P_{t−20}−1（scale-12 定点字符串；不足 21 根为 null）。 */
  return20: string | null;
  /** 近 60 收盘日收益（不足 61 根为 null）。 */
  return60: string | null;
  /** 近 120 收盘日收益（不足 121 根为 null）。 */
  return120: string | null;
  /** 20 日波动：最近 20 个收盘对数收益的总体标准差（scale-12 定点字符串；不足 21 根 null）。 */
  volatility20: string | null;
}

export interface IndustryMomentumTable {
  /** 资料截点（YYYY-MM-DD；表内行业身份按该时点体系冻结）。 */
  asOf: string;
  /** 所用申万一级行业体系。 */
  system: RotationSystem;
  /** 体系内应有指数中 as-of 无任何行情的代码（升序；缺行如实，不以他体系指数顶替）。 */
  missingIndustries: string[];
  /** 排名序的行（rank = 行序 1..n）。 */
  rows: IndustryMomentumRow[];
  /** 体系与口径注记（材料嵌入用：as-of、体系、收益/波动/排名口径、缺行语义）。 */
  note: string;
}

export interface IndustryMomentumOptions {
  /**
   * 行业代码 → 名称标签（如取自 SW_INDEX_LIST 当前快照，行业代码 '801010.SI' 去后缀）。
   * 名称是便捷标签非时点事实；缺省时名称列一律 null。
   */
  names?: ReadonlyMap<string, string>;
}

/**
 * 行业轮动监测表（纯函数）：对每个体系内行业指数按 as-of 计算确定性动量特征并排名。
 * - 输入为体系内外任意代码到行情行视图的映射；只有 as-of 当时体系内的代码入表，
 *   体系外代码（如 2021 窗口的 801020、2014 窗口的 801950/960/970/980）静默不入表；
 * - 同日重复行情行具名拒绝（来源冲突不静默合并，DATA-SOURCES §6.5 同纪律）；
 * - 收益/波动均为 scale-12 定点字符串（decToString 去尾零）。
 */
export function industryMomentumTable(
  barsByIndustry: ReadonlyMap<string, readonly IndustryIndexBarView[]>,
  asOf: string,
  options?: IndustryMomentumOptions,
): IndustryMomentumTable {
  const system = rotationSystemOf(asOf);
  const ranked: { code: string; r20: Dec | null; row: IndustryMomentumRow }[] = [];
  const missing: string[] = [];

  for (const code of rotationIndustryCodes(system)) {
    const bars = barsByIndustry.get(code) ?? [];
    const seen = new Set<string>();
    const entries: { date: string; close: string }[] = [];
    for (const bar of bars) {
      if (!DATE_RE.test(bar.date)) {
        throw new RotationError('ROTATION_BAR_DATE_INVALID', `${code} 行情日 ${bar.date}（须 YYYY-MM-DD）`);
      }
      if (bar.date > asOf) continue; // as-of 过滤：只用 date ≤ asOf 的收盘
      if (seen.has(bar.date)) {
        throw new RotationError('ROTATION_BAR_DATE_CONFLICT', `${code} ${bar.date} 同日重复行情行：来源冲突不静默合并`);
      }
      seen.add(bar.date);
      entries.push({ date: bar.date, close: bar.close });
    }
    if (entries.length === 0) {
      missing.push(code); // 缺行如实：体系内应有而 as-of 无任何行情
      continue;
    }
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const closes = entries.map((e) => {
      const c = decFromString(e.close, `SW_INDEX_BAR ${code} ${e.date} 收盘`);
      if (c.scaled <= 0n) {
        throw new RotationError('ROTATION_CLOSE_INVALID', `${code} ${e.date} 收盘 ${e.close}（指数点位须为正定点）`);
      }
      return c;
    });
    const n = closes.length;
    const last = closes[n - 1] as Dec;
    const periodReturn = (w: number): Dec | null =>
      n >= w + 1 ? decSub(decDiv(last, closes[n - 1 - w] as Dec), DEC_ONE) : null;

    let vol: Dec | null = null;
    if (n >= VOLATILITY_WINDOW + 1) {
      const logReturns: Dec[] = [];
      for (let i = n - VOLATILITY_WINDOW; i <= n - 1; i += 1) {
        logReturns.push(decLnRatio(closes[i] as Dec, closes[i - 1] as Dec, `${code} ${(entries[i] as { date: string }).date} 对数收益`));
      }
      let sum = DEC_ZERO;
      for (const r of logReturns) sum = decAdd(sum, r);
      const mean = decDiv(sum, decFromInt(VOLATILITY_WINDOW));
      let acc = DEC_ZERO;
      for (const r of logReturns) {
        const d = decSub(r, mean);
        acc = decAdd(acc, decMul(d, d));
      }
      vol = decSqrt(decDiv(acc, decFromInt(VOLATILITY_WINDOW))); // 总体方差（÷N）开方
    }

    const r20 = periodReturn(20);
    const r60 = periodReturn(60);
    const r120 = periodReturn(120);
    ranked.push({
      code,
      r20,
      row: {
        rank: 0,
        industryIndexCode: code,
        name: options?.names?.get(code) ?? null,
        barsUsed: n,
        lastBarDate: (entries[n - 1] as { date: string }).date,
        return20: r20 === null ? null : decToString(r20),
        return60: r60 === null ? null : decToString(r60),
        return120: r120 === null ? null : decToString(r120),
        volatility20: vol === null ? null : decToString(vol),
      },
    });
  }

  ranked.sort((a, b) => {
    if (a.r20 === null && b.r20 === null) return a.code < b.code ? -1 : 1;
    if (a.r20 === null) return 1; // 20 日收益不可得者列末
    if (b.r20 === null) return -1;
    const c = decCmp(a.r20, b.r20);
    if (c !== 0) return c > 0 ? -1 : 1; // 20 日收益降序
    return a.code < b.code ? -1 : 1; // 同值按代码升序（排序稳定）
  });
  const rows = ranked.map((it, i) => ({ ...it.row, rank: i + 1 }));
  missing.sort();

  const note =
    `行业轮动监测表：as-of ${asOf}；申万一级行业体系 ${system}` +
    (system === '2021'
      ? '（2021-07-30 起现行 31 行业；801020 采掘已随 2021-12-13 指数切换退役，不在表内）'
      : '（2014-02-21~2021-07-29 旧体系 28 行业，含 801020 采掘；801950/801960/801970/801980 属 2021 体系，不在表内）') +
    '；收益=收盘原值比 P_t/P_{t−N}−1（N=20/60/120，行业指数无复权概念，t=as-of 前最后一根收盘）；' +
    '波动=最近 20 个收盘对数收益的总体标准差（scale-12 定点）；' +
    '排名=20 日收益降序（同值按代码升序；20 日收益不可得者列末且字段为 null）；' +
    '体系内 as-of 无行情的行业缺行如实（missingIndustries），不以他体系指数顶替；' +
    '分类生效 2021-07-30 与指数切换 2021-12-13 为两条官方时间线，其间新体系应有而尚无行情的行业按缺行呈现。';

  return { asOf, system, missingIndustries: missing, rows, note };
}
