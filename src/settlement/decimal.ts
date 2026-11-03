/**
 * Lyra · 结算域精确十进制定点（P3 W13: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md SR-2.2 数值纪律（方向命中与失效触发的比较一律
 * 精确十进制定点，禁止浮点直接相等与阈值比较；移植 Metis ExactDecimal 思想）；
 * 精度常量 = SETTLEMENT-REVIEW 未决 3（scale 与展示精度，P3 实施合同冻结）——本模块
 * 冻结 scale = 12（P3-EVENTS-REVIEW 派发：BigInt scale-12）。
 *
 * 表示：Dec = { scaled: bigint }，真实值 = scaled / 10^12。全 BigInt 运算，无浮点。
 * 舍入：乘除在 scale 12 上按"绝对值 half-up（half 远离零）"舍入，与 ASHARE-RULES §2.2
 * 四舍五入到分的方向约定一致；加减法精确（scale 内无舍入）。
 * 展示：decToString 去尾零（'0'、'-0.5'、'0.012345678901'），与 conclusion/object.ts
 * validateSettlementResult 的 /^-?\d+(\.\d+)?$/ 兼容。
 *
 * 输入来源纪律：字符串价格（DAILY_BAR 原始字段）直接解析；jsonb number（SW_INDEX_BAR
 * 指数点位，pg 解析为 float64）经 decFromJsonNumber 用 String(n) 的最短往返表示取回——
 * 指数点位 ≤ 7 位有效数字时该表示与原十进制完全一致；指数形式（1e+21 等）一律具名拒绝。
 *
 * 本文件同时承载结算域共享具名错误 SettlementError：置于依赖链底座（本模块无域内依赖）
 * 以避免 reference/excess/tradability/settle 之间的循环导入；错误本体与十进制无关。
 */
export const DECIMAL_SCALE = 12; // SETTLEMENT-REVIEW 未决 3 冻结值（P3/W13 落地）
const SCALE_POW = 10n ** BigInt(DECIMAL_SCALE);

/** 结算域具名错误（SR-10.4 结算异常具名登记的错误载体；code 为稳定错误名）。 */
export class SettlementError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'SettlementError';
  }
}

export interface Dec {
  /** 真实值 = scaled / 10^DECIMAL_SCALE；构造一律经本模块函数，不直接手写。 */
  readonly scaled: bigint;
}

export const DEC_ZERO: Dec = { scaled: 0n };
export const DEC_ONE: Dec = { scaled: SCALE_POW };

export type DecimalInput = string | number;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function assertDecimalString(value: string, field: string): void {
  if (!DECIMAL_RE.test(value)) {
    throw new SettlementError('DECIMAL_INVALID', `${field}: "${value}"（须为纯十进制定点，无指数/空串/正负号外字符）`);
  }
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > DECIMAL_SCALE) {
    throw new SettlementError('DECIMAL_SCALE_EXCEEDED', `${field}: "${value}" 小数位 ${String(fraction.length)} > scale ${String(DECIMAL_SCALE)}`);
  }
}

function fromValidated(value: string): Dec {
  const negative = value.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(DECIMAL_SCALE, '0'));
  return { scaled: negative ? -scaled : scaled };
}

/** 十进制定点字符串 → Dec（严格格式；拒绝指数、空串、超过 scale 的小数位）。 */
export function decFromString(value: string, field = 'decimal'): Dec {
  assertDecimalString(value, field);
  return fromValidated(value);
}

/** jsonb number（float64）→ Dec：取 String(n) 最短往返表示后按字符串解析；拒绝非有限与指数形式。 */
export function decFromJsonNumber(value: number, field = 'jsonNumber'): Dec {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettlementError('DECIMAL_INVALID', `${field}: ${String(value)}（非有限数）`);
  }
  return decFromString(String(value), field);
}

/** 任意来源（字符串价格 / jsonb 指数点位）→ Dec。 */
export function decFrom(value: DecimalInput, field = 'decimal'): Dec {
  return typeof value === 'number' ? decFromJsonNumber(value, field) : decFromString(value, field);
}

/** 整数 → Dec。 */
export function decFromInt(value: number | bigint): Dec {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new SettlementError('DECIMAL_INVALID', `decFromInt: ${String(value)} 非安全整数`);
  }
  return { scaled: BigInt(value) * SCALE_POW };
}

/** 非负整数对正数 half-up（half 远离零；负数先取绝对值再还原符号）。 */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new SettlementError('DECIMAL_DIV_ZERO', '除数为零');
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d); // 正数域上 floor = half-up
  return sign * q;
}

/** Dec → 字符串（去尾零；零恒为 '0'，不产生 '-0'）。 */
export function decToString(a: Dec): string {
  const negative = a.scaled < 0n;
  const abs = negative ? -a.scaled : a.scaled;
  const intPart = abs / SCALE_POW;
  const frac = (abs % SCALE_POW).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  const body = frac.length === 0 ? intPart.toString() : `${intPart.toString()}.${frac}`;
  return negative && abs !== 0n ? `-${body}` : body;
}

export function decAdd(a: Dec, b: Dec): Dec {
  return { scaled: a.scaled + b.scaled };
}

export function decSub(a: Dec, b: Dec): Dec {
  return { scaled: a.scaled - b.scaled };
}

export function decNeg(a: Dec): Dec {
  return { scaled: -a.scaled };
}

export function decAbs(a: Dec): Dec {
  return { scaled: a.scaled < 0n ? -a.scaled : a.scaled };
}

/** 乘法：a×b 在 scale 12 上 half-up 舍入（误差 ≤ 5e-13 相对量级/次）。 */
export function decMul(a: Dec, b: Dec): Dec {
  return { scaled: divRoundHalfUp(a.scaled * b.scaled, SCALE_POW) };
}

/** 除法：a/b 在 scale 12 上 half-up 舍入。 */
export function decDiv(a: Dec, b: Dec): Dec {
  if (b.scaled === 0n) {
    throw new SettlementError('DECIMAL_DIV_ZERO', `decDiv: ${decToString(a)} / 0`);
  }
  return { scaled: divRoundHalfUp(a.scaled * SCALE_POW, b.scaled) };
}

/** 精确比较：-1 / 0 / 1（方向命中与失效触发的唯一比较路径，无任何浮点）。 */
export function decCmp(a: Dec, b: Dec): -1 | 0 | 1 {
  if (a.scaled < b.scaled) return -1;
  if (a.scaled > b.scaled) return 1;
  return 0;
}

export function decIsZero(a: Dec): boolean {
  return a.scaled === 0n;
}

export function decMin(a: Dec, b: Dec): Dec {
  return a.scaled <= b.scaled ? a : b;
}

export function decMax(a: Dec, b: Dec): Dec {
  return a.scaled >= b.scaled ? a : b;
}
