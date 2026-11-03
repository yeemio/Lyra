/**
 * Lyra · 涨跌幅规则表（ASHARE-RULES §2.1〔R19〕）。W3: code-writer-pro。
 *
 * 系数是交易所规则版本的函数，不是固定常数：每行带生效区间 [from, to)（日精度），
 * 按判定日 D 取命中行；命中零行或多行一律具名错误，不回退默认值（不得猜）。
 * 表新增行（交易所再次调整）走修订程序，旧行只封闭 to、不改写。
 * 切换日依据：沪深交易所 2026-04-24 修订后交易规则，主板风险警示股票涨跌幅
 * 自 2026-07-06 起由 5% 调整为 10%（docs/FREEZE-P0-20261025.md R19）。
 *
 * 价格口径（ASHARE-RULES §2.2/§2.3）：涨停/跌停价 = 前收盘 × (1 ± c)，四舍五入到分
 * （round-half-up，禁用银行家舍入）；一切比较先转"分"的整数。本模块全部用
 * 整数分运算（前收盘转分后与整数百分比做整数乘除），无浮点直接相等比较。
 */
export type LimitBoard = 'MAINBOARD';
export type StStatus = 'NORMAL' | 'ST' | '*ST';

export type LimitRuleErrorCode =
  | 'RULE_DATE_INVALID' // 判定日非法
  | 'RULE_NO_MATCH' // 查表命中零行（不得回退默认值）
  | 'RULE_AMBIGUOUS' // 查表命中多行（规则表自身缺陷，必须暴露）
  | 'RULE_COEFFICIENT_INVALID'
  | 'RULE_PRICE_INVALID';

export class LimitRuleError extends Error {
  constructor(readonly code: LimitRuleErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'LimitRuleError';
  }
}

export interface LimitRuleRow {
  board: LimitBoard;
  stStatus: StStatus;
  /** 生效区间 [from, to)，null 表示开区间端；日精度 YYYY-MM-DD。 */
  from: string | null;
  to: string | null;
  coefficient: number; // 0.05 / 0.10
  ruleVersionId: string;
}

/** P0 冻结规则表（ASHARE-RULES §2.1；R19 切换日 2026-07-06）。 */
export const LIMIT_RULE_TABLE: readonly LimitRuleRow[] = [
  { board: 'MAINBOARD', stStatus: 'NORMAL', from: null, to: null, coefficient: 0.1, ruleVersionId: 'ASHARE-LIMIT-2026A-MAINBOARD-NORMAL-10' },
  // 主板 ST/*ST：[—, 2026-07-06) 5%
  { board: 'MAINBOARD', stStatus: 'ST', from: null, to: '2026-07-06', coefficient: 0.05, ruleVersionId: 'ASHARE-LIMIT-2026A-MAINBOARD-ST-5' },
  { board: 'MAINBOARD', stStatus: '*ST', from: null, to: '2026-07-06', coefficient: 0.05, ruleVersionId: 'ASHARE-LIMIT-2026A-MAINBOARD-ST-5' },
  // 主板 ST/*ST：[2026-07-06, —) 10%（R19 切换）
  { board: 'MAINBOARD', stStatus: 'ST', from: '2026-07-06', to: null, coefficient: 0.1, ruleVersionId: 'ASHARE-LIMIT-2026B-MAINBOARD-ST-10' },
  { board: 'MAINBOARD', stStatus: '*ST', from: '2026-07-06', to: null, coefficient: 0.1, ruleVersionId: 'ASHARE-LIMIT-2026B-MAINBOARD-ST-10' },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 判定日归一为日精度 YYYY-MM-DD：接受 'YYYY-MM-DD' / ISO 时间串 / Date（取 UTC 日）。 */
export function normalizeRuleDate(date: string | Date): string {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new LimitRuleError('RULE_DATE_INVALID', String(date));
    return date.toISOString().slice(0, 10);
  }
  if (typeof date === 'string' && DAY_RE.test(date)) {
    const d = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      throw new LimitRuleError('RULE_DATE_INVALID', date);
    }
    return date;
  }
  if (typeof date === 'string') {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  throw new LimitRuleError('RULE_DATE_INVALID', String(date));
}

export interface LimitRuleKey {
  board: string;
  stStatus: string;
  date: string | Date;
}

/**
 * 通用查表（公开以便对"零行/多行"路径做证伪测试）：按（板块、状态、判定日）命中
 * 恰好一行；零行 → RULE_NO_MATCH，多行 → RULE_AMBIGUOUS（规则表缺陷必须暴露）。
 */
export function resolveLimitRule(rows: readonly LimitRuleRow[], key: LimitRuleKey): LimitRuleRow {
  const day = normalizeRuleDate(key.date);
  const matched = rows.filter(
    (r) =>
      r.board === key.board &&
      r.stStatus === key.stStatus &&
      (r.from === null || day >= r.from) &&
      (r.to === null || day < r.to),
  );
  if (matched.length === 0) {
    throw new LimitRuleError(
      'RULE_NO_MATCH',
      `规则表命中零行（board=${key.board}, stStatus=${key.stStatus}, date=${day}）：不得回退默认值，先修订规则表（ASHARE-RULES §2.1）`,
    );
  }
  if (matched.length > 1) {
    throw new LimitRuleError(
      'RULE_AMBIGUOUS',
      `规则表命中 ${matched.length} 行（board=${key.board}, stStatus=${key.stStatus}, date=${day}）：${matched.map((r) => r.ruleVersionId).join('、')}`,
    );
  }
  return matched[0] as LimitRuleRow;
}

/** 取涨跌幅系数：唯一命中行返回 {coefficient, ruleVersionId}；否则具名错误。 */
export function limitCoefficient(query: {
  board: LimitBoard;
  stStatus: StStatus;
  date: string | Date;
}): { coefficient: number; ruleVersionId: string } {
  const row = resolveLimitRule(LIMIT_RULE_TABLE, query);
  return { coefficient: row.coefficient, ruleVersionId: row.ruleVersionId };
}

export type LimitSide = 'UP' | 'DOWN';

/** 非负整数除法四舍五入（round-half-up；禁用银行家舍入）。 */
function divHalfUp(numerator: number, denominator: number): number {
  const q = Math.floor(numerator / denominator);
  const rem = numerator - q * denominator;
  return rem * 2 >= denominator ? q + 1 : q;
}

/** 元 → 整数分（×100 后 half-up 取整；价格一律以分为整数比较）。 */
export function fenOf(yuan: number): number {
  if (!Number.isFinite(yuan) || yuan <= 0) {
    throw new LimitRuleError('RULE_PRICE_INVALID', `前收盘价必须为正数: ${String(yuan)}`);
  }
  return Math.floor(yuan * 100 + 0.5);
}

function coefficientToPercent(coefficient: number): number {
  if (!Number.isFinite(coefficient) || coefficient <= 0 || coefficient >= 1) {
    throw new LimitRuleError('RULE_COEFFICIENT_INVALID', `系数超出 (0,1): ${String(coefficient)}`);
  }
  const pct = Math.round(coefficient * 100);
  if (Math.abs(coefficient * 100 - pct) > 1e-9 || pct < 1 || pct > 99) {
    throw new LimitRuleError('RULE_COEFFICIENT_INVALID', `系数不是整百分比: ${String(coefficient)}`);
  }
  return pct;
}

/**
 * 涨跌停价（ASHARE-RULES §2.2）：前收盘 × (1 ± c) 四舍五入到分，返回两位小数字符串。
 * 全程整数分运算：prevFen × (100 ± pct) 后对 100 做 half-up，无浮点相等比较。
 */
export function limitPrice(prevClose: number, side: LimitSide, coefficient: number): string {
  const prevFen = fenOf(prevClose);
  const pct = coefficientToPercent(coefficient);
  const scale = side === 'UP' ? 100 + pct : 100 - pct;
  const fen = divHalfUp(prevFen * scale, 100);
  const yuan = Math.floor(fen / 100);
  const cents = fen % 100;
  return `${yuan}.${String(cents).padStart(2, '0')}`;
}
