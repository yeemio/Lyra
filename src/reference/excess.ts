/**
 * Lyra · 历史参照库 · 事件窗口收益（P3 随轮提前 / W15: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §4（衡量口径）逐条款：
 * - 起算价 = 事件时点之后下一交易日开盘价（`ASHARE-RULES.md` §4 reference_open 同构规则，
 *   事件时点即合同的事件时点 = 触发公告 availableAt 基准；停牌顺延 §6）；
 * - 窗口 h ∈ {1, 5, 20}，参考价日 = 窗口第 1 个有成交交易日，终点 = 第 h 个该股有成交
 *   交易日收盘（停牌暂停计时，`ASHARE-RULES.md` §6）；
 * - 超额 = 个股收益 − 申万一级行业指数收益（指数取事件时点当时版本，由调用方按
 *   groups.ts 的 as-of 行业归属给出 industryL1AsOf，本模块不重判版本）；
 * - 后复权 = 原始价 × 累计复权因子链（`ASHARE-RULES.md` §7：原始价与因子分开读回，
 *   窗口跨除权日必须后复权；不直接采信数据源复权价列）；
 * - 价格失效触发：20 日窗口逐日累计超额序列，不利两侧分列（跑赢侧 ≤ −12% /
 *   跑输侧 ≥ +12%，R29.3 终裁冻结；该库历史统计已按 10% 落库保留为审计面，不重算）。
 *
 * 口径互指（派发冻结）：本模块与 `docs/specs/SETTLEMENT-REVIEW.md` SR-3（SR-3.1 参考价、
 * SR-3.3 窗口计时、SR-3.4 逐日累计超额序列、SR-2.2 失效触发定点比较）同口径，但**不 import
 * 其未完成实现**（src/settlement 属 W13）；两处算式在 P3 验收时由总控对齐。定点运算纪律同
 * SR-2.2：触发判定一律精确十进制定点，禁止浮点阈值比较。
 *
 * 单测（excess.test.ts）不碰网络不碰 DB：合成事实注入。
 */
import type { TimePointFact } from '../contracts.js';

// ===== 精确十进制定点（SR-2.2 数值纪律的最小实现；不 import W13 模块）=====

/** 定点数：value = int / 10^scale。int 为 BigInt，scale ≥ 0。 */
export interface Fixed {
  int: bigint;
  scale: number;
}

const FIXED_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/** 字符串/数值 → 定点；空串、NaN、非数字形返回 null（调用方按 DATA_GAP 处置，不推算）。 */
export function parseFixed(value: string | number | null | undefined): Fixed | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'number' ? Number.isFinite(value) ? String(value) : '' : value.trim();
  const m = FIXED_RE.exec(s);
  if (m === null) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2]!;
  const frac = m[3] ?? '';
  return { int: sign * BigInt(intPart + frac), scale: frac.length };
}

function align(a: Fixed, b: Fixed): { ai: bigint; bi: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    ai: a.int * 10n ** BigInt(scale - a.scale),
    bi: b.int * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export function fAdd(a: Fixed, b: Fixed): Fixed {
  const { ai, bi, scale } = align(a, b);
  return { int: ai + bi, scale };
}

export function fSub(a: Fixed, b: Fixed): Fixed {
  const { ai, bi, scale } = align(a, b);
  return { int: ai - bi, scale };
}

export function fMul(a: Fixed, b: Fixed): Fixed {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

/** 定点除法 a/b，目标精度 scale（默认 10；向零截断，比较阈值 0.1 下安全）。 */
export function fDiv(a: Fixed, b: Fixed, scale = 10): Fixed | null {
  if (b.int === 0n) return null;
  const shift = scale + b.scale - a.scale;
  const numerator = shift >= 0 ? a.int * 10n ** BigInt(shift) : a.int / 10n ** BigInt(-shift);
  return { int: numerator / b.int, scale };
}

export function fCmp(a: Fixed, b: Fixed): number {
  const { ai, bi } = align(a, b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** 定点数 → 规范字符串（去尾零；'0'；负号保留）。 */
export function fixedToString(f: Fixed): string {
  const neg = f.int < 0n;
  const digits = (neg ? -f.int : f.int).toString().padStart(f.scale + 1, '0');
  const intPart = f.scale === 0 ? digits : digits.slice(0, digits.length - f.scale);
  const frac = f.scale === 0 ? '' : digits.slice(digits.length - f.scale).replace(/0+$/, '');
  const body = frac.length === 0 ? intPart : `${intPart}.${frac}`;
  return neg && f.int !== 0n ? `-${body}` : body;
}

/** 失效阈值：R29.3 终裁冻结 12%（原预留 10%；已落库历史统计按 10% 保留为审计面，不重算）。 */
export const INVALIDATION_THRESHOLD_PCT = '12';
export const INVALIDATION_THRESHOLD = parseFixed('0.12')!;

const ONE: Fixed = { int: 1n, scale: 0 };
const ZERO: Fixed = { int: 0n, scale: 0 };

// ===== 事实行输入形态（typedValue 字段子集；DAILY_BAR/ADJUST_FACTOR 为字符串、SW_INDEX_BAR 为数值，兼容两者）=====

export interface DailyBarInput {
  /** YYYY-MM-DD。 */
  date: string;
  open: string | number;
  close: string | number;
  volume: string | number;
  /** BaoStock tradestatus：'1' 交易 / '0' 停牌；缺省视为交易（以 volume 判定兜底）。 */
  tradestatus?: string | number | null;
  /** 当日成交额（元）——窗口收益不使用；groups.ts 市值档代理基准用。 */
  amount?: string | number | null;
}

export interface AdjustFactorInput {
  /** 除权日（dividOperateDate / divideOperateDate）。 */
  operateDate: string;
  backAdjustFactor: string | number;
}

export interface IndexBarInput {
  date: string;
  open: string | number;
  close: string | number;
}

export function dailyBarsFromFacts(facts: TimePointFact[]): DailyBarInput[] {
  return facts.map((f) => {
    const tv = f.typedValue as Record<string, unknown>;
    return {
      date: String(tv['date'] ?? ''),
      open: tv['open'] as string | number,
      close: tv['close'] as string | number,
      volume: tv['volume'] as string | number,
      tradestatus: (tv['tradestatus'] ?? null) as string | number | null,
      amount: (tv['amount'] ?? null) as string | number | null,
    };
  }).filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date));
}

export function adjustFactorsFromFacts(facts: TimePointFact[]): AdjustFactorInput[] {
  return facts.map((f) => {
    const tv = f.typedValue as Record<string, unknown>;
    return {
      operateDate: String(tv['dividOperateDate'] ?? tv['divideOperateDate'] ?? ''),
      backAdjustFactor: tv['backAdjustFactor'] as string | number,
    };
  }).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.operateDate));
}

export function swIndexBarsFromFacts(facts: TimePointFact[]): IndexBarInput[] {
  return facts.map((f) => {
    const tv = f.typedValue as Record<string, unknown>;
    return {
      date: String(tv['日期'] ?? ''),
      open: tv['开盘'] as string | number,
      close: tv['收盘'] as string | number,
    };
  }).filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date));
}

// ===== 时间工具（Asia/Shanghai 固定 +08）=====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 时刻的上海日期（YYYY-MM-DD）；非法返回 null。 */
export function shanghaiDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 该交易日开盘时刻（09:15 集合竞价起点之前无开盘价可指；取 09:30 连续竞价开盘）毫秒。 */
function openInstantMs(date: string): number {
  return new Date(`${date}T09:30:00+08:00`).getTime();
}

/** 该交易日收盘事实可得时刻（15:00 +08）毫秒。 */
function closeAvailableMs(date: string): number {
  return new Date(`${date}T15:00:00+08:00`).getTime();
}

// ===== 事件窗口收益 =====

export type WindowStatus = 'OK' | 'WINDOW_INCOMPLETE' | 'NO_REFERENCE' | 'INDEX_GAP';

export interface WindowOutcome {
  h: 1 | 5 | 20;
  status: WindowStatus;
  /** 窗口第 h 个有成交交易日（status OK 时必填）。 */
  endDate: string | null;
  /** 绝对收益（后复权，定点字符串）。 */
  absReturn: string | null;
  /** 相对当时申万 L1 指数超额（定点字符串）。 */
  excessReturn: string | null;
}

export interface InvalidationOutcome {
  /** 冻结阈值（百分数值字符串）；R29.3 终裁 12%（原预留 10%）。 */
  thresholdPct: '12';
  reserved: true;
  /** 跑赢侧不利：累计超额 ≤ −12%（null = 序列不可得，非"未触发"）。 */
  downTriggered: boolean | null;
  /** 跑输侧不利：累计超额 ≥ +12%。 */
  upTriggered: boolean | null;
  firstDownDate: string | null;
  firstUpDate: string | null;
}

export interface EventWindowReturns {
  subject: string;
  eventTime: string;
  /** 事件时点当时申万 L1 指数码（调用方 as-of 判定）；null = 行业不可得（INDEX_GAP）。 */
  industryL1AsOf: string | null;
  /** 起算日（事件时点之后首个有成交交易日）。 */
  referenceDate: string | null;
  referenceOpenRaw: string | null;
  /** 起算日后复权开盘（原始 × 因子链）。 */
  referenceAdjustedOpen: string | null;
  windows: WindowOutcome[];
  /** 逐日累计超额序列（SR-3.4 同构；e_d 定点字符串；只含有成交且指数可得日；前 20 个）。 */
  cumulativeExcess: { date: string; e: string }[];
  invalidation: InvalidationOutcome;
  /** 样本级具名缺口（不含窗口未走完——那不是缺口，是 WINDOW_INCOMPLETE）。 */
  dataGaps: string[];
}

export interface EventWindowInput {
  subject: string;
  /** 事件时点（ISO；= 触发公告 availableAt 基准）。 */
  eventTime: string;
  industryL1AsOf: string | null;
  bars: DailyBarInput[];
  factors: AdjustFactorInput[];
  /** industryL1AsOf 对应指数日线（SW_INDEX_BAR）；industryL1AsOf 为 null 时可为空。 */
  indexBars: IndexBarInput[];
}

function hasVolume(bar: DailyBarInput): boolean {
  return String(bar.tradestatus ?? '1') !== '0' && Number(bar.volume) > 0;
}

/** 因子链取值：日期 d 的累计后复权因子 = 除权日 ≤ d 的最新行 backAdjustFactor；无行 = 1（上市初无除权）。 */
function factorAt(factorsSorted: AdjustFactorInput[], date: string): Fixed | null {
  let v: Fixed | null = null;
  for (const f of factorsSorted) {
    if (f.operateDate <= date) v = parseFixed(f.backAdjustFactor) ?? v;
    else break;
  }
  return v; // null = 无 ≤ d 的行 → 调用方以 1 为基并按截断缺口判定
}

/**
 * 事件窗口收益（HISTORICAL-REFERENCE §4 逐条款；SR-3 同构口径）。
 * 纯函数：输入合成事实数组即可单测，不碰网络不碰 DB。
 */
export function eventWindowReturns(input: EventWindowInput): EventWindowReturns {
  const eventMs = new Date(input.eventTime).getTime();
  const dataGaps: string[] = [];
  const windows: WindowOutcome[] = [];
  let cumulativeExcess: { date: string; e: string }[] = [];
  const invalidation: InvalidationOutcome = {
    thresholdPct: INVALIDATION_THRESHOLD_PCT,
    reserved: true,
    downTriggered: null,
    upTriggered: null,
    firstDownDate: null,
    firstUpDate: null,
  };
  const base: EventWindowReturns = {
    subject: input.subject,
    eventTime: input.eventTime,
    industryL1AsOf: input.industryL1AsOf,
    referenceDate: null,
    referenceOpenRaw: null,
    referenceAdjustedOpen: null,
    windows,
    cumulativeExcess,
    invalidation,
    dataGaps,
  };

  if (Number.isNaN(eventMs)) {
    dataGaps.push('EVENT_TIME_INVALID');
    for (const h of [1, 5, 20] as const) windows.push({ h, status: 'NO_REFERENCE', endDate: null, absReturn: null, excessReturn: null });
    return base;
  }

  const traded = input.bars
    .filter((b) => DATE_RE.test(b.date) && hasVolume(b))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const factorsSorted = input.factors
    .filter((f) => DATE_RE.test(f.operateDate))
    .sort((a, b) => (a.operateDate < b.operateDate ? -1 : a.operateDate > b.operateDate ? 1 : 0));

  // 起算日：第一个 open_instant > 事件时点的有成交交易日（ASHARE-RULES §4 + §6 停牌顺延）。
  const refIdx = traded.findIndex((b) => openInstantMs(b.date) > eventMs);
  if (refIdx === -1) {
    dataGaps.push('NO_TRADING_DAY_AFTER_EVENT');
    for (const h of [1, 5, 20] as const) windows.push({ h, status: 'NO_REFERENCE', endDate: null, absReturn: null, excessReturn: null });
    return base;
  }
  const ref = traded[refIdx]!;
  const refOpen = parseFixed(ref.open);
  const refFactor = factorAt(factorsSorted, ref.date);
  if (refOpen === null) {
    dataGaps.push(`DAILY_BAR_OPEN_INVALID:${ref.date}`);
    for (const h of [1, 5, 20] as const) windows.push({ h, status: 'NO_REFERENCE', endDate: null, absReturn: null, excessReturn: null });
    return base;
  }
  // 因子基准：起算日前库内无因子行时以 1 为基（BaoStock 因子从上市首除权 1.0 累计且全史在库；
  // 仅当窗口内跨除权且基准段被截断时登记 ADJUST_FACTOR_BASE_TRUNCATED）。
  const refFactorValue = refFactor ?? { int: 1n, scale: 0 };
  const refAdjOpen = fMul(refOpen, refFactorValue);
  base.referenceDate = ref.date;
  base.referenceOpenRaw = fixedToString(refOpen);
  base.referenceAdjustedOpen = fixedToString(refAdjOpen);

  // 行业指数（当时版本，调用方判定）：起算日开盘为参考点位（与个股参考价同时点）。
  const indexSorted = input.indexBars
    .filter((b) => DATE_RE.test(b.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const indexByDate = new Map(indexSorted.map((b) => [b.date, b]));
  const indexRef = input.industryL1AsOf === null ? null : indexByDate.get(ref.date) ?? null;
  const indexRefOpen = indexRef === null ? null : parseFixed(indexRef.open);
  const indexUsable = input.industryL1AsOf !== null && indexRef !== null && indexRefOpen !== null;
  if (input.industryL1AsOf === null) {
    dataGaps.push('INDUSTRY_L1_UNAVAILABLE_AT_EVENT');
  } else if (!indexUsable) {
    dataGaps.push(`SW_INDEX_BAR_MISSING:${input.industryL1AsOf}:${ref.date}`);
  }

  // 窗口第 k 个有成交交易日（k = 1..20，含起算日为第 1 日，SR-3.3）。
  const windowBars = traded.slice(refIdx, refIdx + 20);
  let excessSeqComplete = indexUsable;

  // 逐日累计超额（SR-3.4）：e_d = (P_d_close/P_ref − 1) − (I_d_close/I_ref − 1)。
  cumulativeExcess = [];
  for (const bar of windowBars) {
    const close = parseFixed(bar.close);
    const closeFactor = factorAt(factorsSorted, bar.date);
    if (close === null) {
      excessSeqComplete = false;
      dataGaps.push(`DAILY_BAR_CLOSE_INVALID:${bar.date}`);
      continue;
    }
    const adjClose = fMul(close, closeFactor ?? { int: 1n, scale: 0 });
    const stockRet = fSub(fDiv(adjClose, refAdjOpen) ?? ZERO, ONE);
    if (!indexUsable) continue; // 指数不可得：绝对收益照算，超额与序列缺
    const idxBar = indexByDate.get(bar.date);
    const idxClose = idxBar === undefined ? null : parseFixed(idxBar.close);
    if (idxClose === null) {
      excessSeqComplete = false;
      dataGaps.push(`SW_INDEX_BAR_MISSING:${input.industryL1AsOf}:${bar.date}`);
      continue;
    }
    const idxRet = fSub(fDiv(idxClose, indexRefOpen!) ?? ZERO, ONE);
    const e = fSub(stockRet, idxRet);
    cumulativeExcess.push({ date: bar.date, e: fixedToString(e) });
    if (invalidation.downTriggered !== true && fCmp(e, fSub(ZERO, INVALIDATION_THRESHOLD)) <= 0) {
      invalidation.downTriggered = true;
      invalidation.firstDownDate = bar.date;
    }
    if (invalidation.upTriggered !== true && fCmp(e, INVALIDATION_THRESHOLD) >= 0) {
      invalidation.upTriggered = true;
      invalidation.firstUpDate = bar.date;
    }
  }
  base.cumulativeExcess = cumulativeExcess;
  if (indexUsable && !excessSeqComplete) {
    // 序列中断（指数/收盘缺行）：已触发部分仍是事实，但"20 日窗口内是否触发"不可完整回答，
    // 两侧判定整体置 null（缺口已具名登记）；窗口未走完（无缺行）时前缀判定保持有效
    // （HISTORICAL-REFERENCE §7 第 1 条：只给已完成前缀）。
    invalidation.downTriggered = null;
    invalidation.upTriggered = null;
    invalidation.firstDownDate = null;
    invalidation.firstUpDate = null;
  } else if (indexUsable) {
    // 序列完整（或完整前缀）而未触发：两侧判定为 false——null 只留给"不可判定"。
    invalidation.downTriggered ??= false;
    invalidation.upTriggered ??= false;
  }

  // 因子基准截断缺口：窗口内存在除权日 > 起算日，且起算日前库内无因子行（基准段以 1 代入）。
  const hasFactorBeforeRef = refFactor !== null;
  const exDivInWindow = factorsSorted.some((f) => f.operateDate > ref.date && f.operateDate <= (windowBars[windowBars.length - 1]?.date ?? ''));
  if (exDivInWindow && !hasFactorBeforeRef) {
    dataGaps.push('ADJUST_FACTOR_BASE_TRUNCATED');
  }

  for (const h of [1, 5, 20] as const) {
    const bar = windowBars[h - 1];
    if (bar === undefined) {
      windows.push({ h, status: 'WINDOW_INCOMPLETE', endDate: windowBars[windowBars.length - 1]?.date ?? null, absReturn: null, excessReturn: null });
      continue;
    }
    const close = parseFixed(bar.close);
    if (close === null) {
      windows.push({ h, status: 'WINDOW_INCOMPLETE', endDate: bar.date, absReturn: null, excessReturn: null });
      continue;
    }
    const adjClose = fMul(close, factorAt(factorsSorted, bar.date) ?? { int: 1n, scale: 0 });
    const absReturn = fSub(fDiv(adjClose, refAdjOpen) ?? ZERO, ONE);
    let excess: string | null = null;
    let status: WindowStatus = 'OK';
    if (!indexUsable) {
      status = 'INDEX_GAP';
    } else {
      const idxBar = indexByDate.get(bar.date);
      const idxClose = idxBar === undefined ? null : parseFixed(idxBar.close);
      if (idxClose === null) {
        status = 'INDEX_GAP';
      } else {
        const idxRet = fSub(fDiv(idxClose, indexRefOpen!) ?? ZERO, ONE);
        excess = fixedToString(fSub(absReturn, idxRet));
      }
    }
    windows.push({ h, status, endDate: bar.date, absReturn: fixedToString(absReturn), excessReturn: excess });
  }

  return base;
}
