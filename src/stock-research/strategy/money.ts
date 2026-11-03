import type { StrategyRules } from './contracts.js';

export class StrategyError extends Error {
  constructor(readonly code: string, detail = '') { super(`${code}${detail ? `: ${detail}` : ''}`); this.name = 'StrategyError'; }
}

export function integer(n: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(n) || n < minimum) throw new StrategyError('INVALID_INTEGER', field);
  return n;
}

/** 金额/比率均用 BigInt 中间值，half-up；阈值比较不依赖浮点。 */
export function ratio(n: number | bigint, numerator: number | bigint, denominator: number | bigint): number {
  const d = BigInt(denominator);
  if (d <= 0n) throw new StrategyError('INVALID_DIVISOR');
  const value = BigInt(n) * BigInt(numerator);
  const sign = value < 0n ? -1n : 1n;
  const abs = value < 0n ? -value : value;
  const out = Number(sign * ((abs * 2n + d) / (d * 2n)));
  if (!Number.isSafeInteger(out)) throw new StrategyError('MONEY_OVERFLOW');
  return out;
}

export function gross(priceFen: number, quantity: number): number { return ratio(priceFen, quantity, 1); }
export function fees(amountFen: number, side: 'BUY' | 'SELL', costs: StrategyRules['costs']): number {
  if (amountFen === 0) return 0;
  return Math.max(costs.minCommissionFen, ratio(amountFen, costs.commissionBps, 10_000))
    + ratio(amountFen, costs.transferBps, 10_000)
    + (side === 'SELL' ? ratio(amountFen, costs.sellTaxBps, 10_000) : 0);
}

export function slipped(openFen: number, side: 'BUY' | 'SELL', costs: StrategyRules['costs'], tickFen: number): number {
  const value = BigInt(openFen) * BigInt(10_000 + (side === 'BUY' ? costs.slippageBps : -costs.slippageBps));
  const unit = BigInt(10_000 * tickFen);
  // 不利方向按 tick 舍入，禁止滑点后穿越当时限价。
  return Number((side === 'BUY' ? (value + unit - 1n) / unit : value / unit) * BigInt(tickFen));
}
