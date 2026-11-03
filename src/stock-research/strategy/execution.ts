import type { FrozenPlan, OpeningQuote, Portfolio, StrategyData, StrategyRules, TradingState } from './contracts.js';
import { known, one } from './data.js';
import { fees, gross, integer, ratio, slipped, StrategyError } from './money.js';
import { sizeRisk } from './plan.js';

export interface OpeningContext { quote: OpeningQuote; state: TradingState; openAt: string; nextSession: string | null }
export interface FillResult {
  status: 'FILLED' | 'PARTIAL' | 'BLOCKED';
  code: string;
  portfolio: Portfolio;
  quantity: number;
  priceFen: number | null;
  feesFen: number;
  netPnlFen: number | null;
  evidenceIds: string[];
}

export function openingContext(data: StrategyData, date: string): OpeningContext | { blocked: string; evidenceIds: string[] } {
  const i = data.calendar.sessions.findIndex((s) => s.date === date);
  const session = data.calendar.sessions[i];
  if (!session || data.calendar.availableAt > session.openAt) return { blocked: 'CALENDAR_NOT_AVAILABLE', evidenceIds: [] };
  const states = known(data.states.filter((s) => s.date === date), session.openAt);
  if (states.length !== 1) return { blocked: 'STATE_MISSING_OR_NOT_AVAILABLE', evidenceIds: [] };
  const state = states[0]!;
  if (state.state === 'SUSPENDED') return { blocked: 'EXPLICIT_SUSPENSION', evidenceIds: [state.factId] };
  const quotes = known(data.openings.filter((q) => q.subject === data.subject && q.date === date), session.openAt);
  if (quotes.length !== 1) return { blocked: 'OPEN_MISSING_OR_NOT_AVAILABLE', evidenceIds: [state.factId] };
  return { quote: quotes[0]!, state, openAt: session.openAt, nextSession: data.calendar.sessions[i + 1]?.date ?? null };
}

function lotSellable(lot: Portfolio['lots'][number], date: string): number {
  if (date < lot.initialDate || date <= lot.acquiredOn) return 0;
  // A past unlock date is not evidence that the snapshot's restricted remainder can be sold.
  const subsequentlyUnlocked = lot.unlocksOn > lot.initialDate && date >= lot.unlocksOn;
  return subsequentlyUnlocked ? lot.quantity : Math.min(lot.quantity, lot.initiallySellable);
}

export function sellableShares(portfolio: Portfolio, date: string): number {
  return portfolio.lots.reduce((total, lot) => total + lotSellable(lot, date), 0);
}

/** 唯一确定性成交函数。它不是模型执行器，不调用模型，也不接收未来的日线字段。 */
export function executeAtOpen(ctx: OpeningContext, portfolio: Portfolio, side: 'BUY' | 'SELL', requestedQuantity: number, rules: StrategyRules): FillResult {
  integer(requestedQuantity, 'order quantity', 1);
  const { quote: q, state: s } = ctx;
  const out: FillResult = { status: 'BLOCKED', code: '', portfolio: structuredClone(portfolio), quantity: 0, priceFen: null, feesFen: 0, netPnlFen: null, evidenceIds: [q.factId, s.factId] };
  const block = (code: string): FillResult => ({ ...out, code });
  if (q.availableAt > ctx.openAt || s.availableAt > ctx.openAt || q.date !== s.date || q.subject !== s.subject || q.priceBasis !== 'RAW' || s.settlementDays !== 1) return block('OPEN_INPUT_NOT_AVAILABLE_OR_INCOMPATIBLE');
  if (s.state !== 'TRADING') return block('EXPLICIT_SUSPENSION');
  if (q.openFen < s.lowerLimitFen || q.openFen > s.upperLimitFen || q.openFen % s.tickFen !== 0) return block('RAW_OPEN_OR_LIMIT_INVALID');
  if (side === 'BUY' && q.openFen >= s.upperLimitFen) return block('OPEN_AT_BUY_LIMIT');
  if (side === 'SELL' && q.openFen <= s.lowerLimitFen) return block('OPEN_AT_SELL_LIMIT');
  const price = slipped(q.openFen, side, rules.costs, s.tickFen);
  if (price > s.upperLimitFen || price < s.lowerLimitFen) return block('SLIPPAGE_OUTSIDE_LIMIT');
  const qty = side === 'SELL' ? Math.min(requestedQuantity, sellableShares(portfolio, q.date)) : requestedQuantity;
  if (qty === 0) return block('T_PLUS_ONE_OR_SELLABLE_LOCK');
  if (side === 'BUY' && (qty % s.buyLotShares !== 0 || ctx.nextSession === null)) return block('BUY_LOT_OR_T1_CALENDAR_MISSING');
  const amount = gross(price, qty), charge = fees(amount, side, rules.costs);
  if (side === 'BUY') {
    if (amount + charge > portfolio.cashFen) return block('INSUFFICIENT_CASH');
    out.portfolio.cashFen -= amount + charge;
    out.portfolio.lots.push({ lotId: `sim:${q.factId}`, quantity: qty, costFen: amount + charge, acquiredOn: q.date, unlocksOn: ctx.nextSession!, initiallySellable: 0, initialDate: q.date, dividendsFen: 0 });
  } else {
    let remaining = qty, cost = 0, dividends = 0;
    for (const lot of out.portfolio.lots) {
      const available = lotSellable(lot, q.date);
      const take = Math.min(remaining, available);
      if (take === 0) continue;
      const partCost = ratio(lot.costFen, take, lot.quantity), partDividend = ratio(lot.dividendsFen, take, lot.quantity);
      lot.quantity -= take; lot.costFen -= partCost; lot.dividendsFen -= partDividend; lot.initiallySellable = Math.max(0, lot.initiallySellable - take);
      remaining -= take; cost += partCost; dividends += partDividend;
    }
    out.portfolio.lots = out.portfolio.lots.filter((l) => l.quantity > 0);
    out.portfolio.cashFen += amount - charge;
    out.netPnlFen = amount - charge - cost + dividends;
  }
  return { ...out, status: qty < requestedQuantity ? 'PARTIAL' : 'FILLED', code: qty < requestedQuantity ? 'SELLABLE_QUANTITY_PARTIAL' : 'NEXT_OPEN_FILL', quantity: qty, priceFen: price, feesFen: charge };
}

/** 公司行为条款是必要输入：仅有复权因子不能推导真实股数或现金。 */
export function applyActions(data: StrategyData, rules: StrategyRules, date: string, at: string, portfolio: Portfolio, terms: FrozenPlan['terms']): { portfolio: Portfolio; terms: FrozenPlan['terms']; evidenceIds: string[]; dividendFen: number; costsFen: number } {
  const actions = known(data.actions.filter((a) => a.subject === data.subject && a.effectiveOn === date), at);
  const state = one(known(data.states.filter((s) => s.date === date), at), 'STATE_MISSING_OR_NOT_AVAILABLE', date);
  for (const id of state.actionIds) if (!actions.some((a) => a.actionId === id)) throw new StrategyError('CORPORATE_ACTION_TERMS_NOT_AVAILABLE', id);
  if (actions.some((a) => !state.actionIds.includes(a.actionId))) throw new StrategyError('ACTION_NOT_BOUND_TO_TRADING_STATE', date);
  const prior = known(data.factors.filter((f) => f.subject === data.subject && f.effectiveOn < date), at).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)).at(-1);
  const today = known(data.factors.filter((f) => f.subject === data.subject && f.effectiveOn === date), at);
  for (const f of today) if (prior && BigInt(f.numerator) * BigInt(prior.denominator) !== BigInt(prior.numerator) * BigInt(f.denominator) && f.actionId === null) throw new StrategyError('FACTOR_CHANGE_WITHOUT_ACTION', f.factId);
  const allFactors = known(data.factors.filter((f) => f.subject === data.subject && f.effectiveOn === date && f.actionId !== null), at);
  for (const f of allFactors) if (!actions.some((a) => a.actionId === f.actionId)) throw new StrategyError('CORPORATE_ACTION_TERMS_MISSING', f.factId);
  const p = structuredClone(portfolio);
  let current = terms ? { ...terms } : null, dividendFen = 0, costsFen = 0;
  for (const a of actions) {
    if (a.kind !== 'SPLIT_OR_CASH') throw new StrategyError('CORPORATE_ACTION_UNSUPPORTED', a.actionId);
    one(known(data.factors.filter((f) => f.subject === data.subject && f.actionId === a.actionId), at), 'ACTION_FACTOR_MISSING_OR_CONFLICT', a.actionId);
    for (const lot of p.lots) {
      if (lot.acquiredOn >= date) continue;
      const numerator = BigInt(lot.quantity) * BigInt(a.sharesNumerator);
      if (numerator % BigInt(a.sharesDenominator) !== 0n) throw new StrategyError('FRACTIONAL_ACTION_UNSUPPORTED', a.actionId);
      const cash = gross(a.cashFenPerOldShare, lot.quantity);
      const tax = ratio(cash, rules.costs.dividendTaxBps, 10_000), net = cash - tax;
      costsFen += tax;
      dividendFen += net; p.cashFen += net; lot.dividendsFen += net;
      lot.quantity = Number(numerator / BigInt(a.sharesDenominator));
      lot.initiallySellable = ratio(lot.initiallySellable, a.sharesNumerator, a.sharesDenominator);
    }
    if (current) for (const key of Object.keys(current) as (keyof NonNullable<FrozenPlan['terms']>)[]) {
      current[key] = ratio(Math.max(1, current[key] - a.cashFenPerOldShare), a.sharesDenominator, a.sharesNumerator);
    }
  }
  return { portfolio: p, terms: current, evidenceIds: actions.map((a) => a.factId), dividendFen, costsFen };
}

export function entryAtOpen(data: StrategyData, rules: StrategyRules, plan: FrozenPlan, ctx: OpeningContext, p: Portfolio, terms: NonNullable<FrozenPlan['terms']>): { fill: FillResult | null; code: string; terminal: boolean } {
  const open = ctx.quote.openFen;
  if (open <= terms.priceInvalidBelowFen || open < terms.entryLowerFen) return { fill: null, code: 'PRICE_INVALID_AT_OPEN', terminal: true };
  if (open > terms.entryUpperFen) return { fill: null, code: 'MISSED_GAP_ABOVE_ENTRY_RANGE', terminal: true };
  if (plan.accountHash === null || !data.account || canonicalAccount(data.account) !== plan.accountHash) return { fill: null, code: 'FROZEN_ACCOUNT_MISSING_OR_CHANGED', terminal: false };
  const size = sizeRisk(data.account, ctx.openAt, p, slipped(open, 'BUY', rules.costs, ctx.state.tickFen), terms.priceInvalidBelowFen, ctx.state.buyLotShares, rules, ctx.state.tickFen);
  if (size.status !== 'SIZED' || !size.quantity) return { fill: null, code: size.status === 'RISK_REJECTED' ? 'RISK_BUDGET_REJECTED_AT_OPEN' : size.status, terminal: false };
  const fill = executeAtOpen(ctx, p, 'BUY', size.quantity, rules);
  return { fill, code: fill.code, terminal: false };
}

// 复用项目统一 canonical 哈希；独立命名只避免与价格操作混淆。
import { canonicalSha256 as canonicalAccount } from '../../canonical.js';
