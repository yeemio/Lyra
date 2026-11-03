import { canonicalSha256 } from '../../canonical.js';
import type { AccountSnapshot, FrozenPlan, Portfolio, RiskSizing, StrategyData, StrategyRules } from './contracts.js';
import { assertData, known, signalAt } from './data.js';
import { fees, gross, integer, ratio, slipped, StrategyError } from './money.js';

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) immutable(v);
    Object.freeze(value);
  }
  return value;
}

export function freezeRules(input: Omit<StrategyRules, 'rulesHash'>): StrategyRules {
  if (input.schema !== 'lyra-daily-rules-v1' || input.family !== 'DAILY_TREND_WITH_WAIT' || input.metricContract !== 'CLOSE_EQUITY_V1'
    || !input.methodVersion || !input.dataContractVersion || !input.planAuthVersion || !input.selectionReason.trim()
    || !['DEMO_NOT_EFFICACY_VALIDATED', 'FROZEN_RESEARCH_HYPOTHESIS'].includes(input.parameterStatus)
    || !Number.isFinite(Date.parse(input.frozenAt))) throw new StrategyError('RULES_INVALID');
  for (const [key, n] of Object.entries({ fast: input.fastSessions, slow: input.slowSessions, hold: input.maxHoldingSessions, pending: input.pendingEntrySessions, lifetime: input.planLifetimeSessions, minimumSessions: input.minimumSessions, minimumClosedTrades: input.minimumClosedTrades })) integer(n, key, 1);
  integer(input.signalDelayMinutes, 'signalDelayMinutes');
  if (input.fastSessions >= input.slowSessions || input.pendingEntrySessions > input.planLifetimeSessions) throw new StrategyError('RULE_WINDOWS_INVALID');
  for (const [key, n] of Object.entries({ ...input.costs, entryGapBps: input.entryGapBps, stopBps: input.stopBps, profitBps: input.profitBps })) {
    integer(n, key);
    if (key !== 'minCommissionFen' && n >= 10_000) throw new StrategyError('BASIS_POINTS_INVALID', key);
  }
  if (input.stopBps === 0 || input.profitBps === 0) throw new StrategyError('EXIT_THRESHOLDS_INVALID');
  const windows = [input.inSample, input.outOfSample];
  if (windows.some((w) => !/^\d{4}-\d{2}-\d{2}$/.test(w.from) || !/^\d{4}-\d{2}-\d{2}$/.test(w.to) || w.from > w.to) || input.inSample.to >= input.outOfSample.from) throw new StrategyError('IS_OOS_OVERLAP_OR_INVALID');
  return immutable({ ...structuredClone(input), rulesHash: canonicalSha256(input) });
}

export function assertRules(rules: StrategyRules): void {
  const { rulesHash, ...core } = rules;
  if (freezeRules(core).rulesHash !== rulesHash) throw new StrategyError('RULES_HASH_MISMATCH');
}

export function portfolioOf(account: AccountSnapshot): Portfolio {
  return {
    cashFen: account.cashFen,
    lots: account.holdings.map((l) => ({ lotId: l.lotId, quantity: l.quantity, costFen: l.costFen, acquiredOn: l.acquiredOn, unlocksOn: l.unlocksOn, initiallySellable: l.sellableQuantity, initialDate: account.asOf.slice(0, 10), dividendsFen: 0 })),
  };
}

export function sizeRisk(account: AccountSnapshot | null, at: string, portfolio: Portfolio | null, buyPriceFen: number, stopFen: number, lotShares: number, rules: StrategyRules, tickFen: number): RiskSizing {
  integer(buyPriceFen, 'buyPriceFen', 1); integer(stopFen, 'stopFen', 1); integer(lotShares, 'lotShares', 1); integer(tickFen, 'tickFen', 1);
  const base: RiskSizing = { status: 'MISSING_ACCOUNT', quantity: null, buyPriceFen, stressExitFen: null, buyGrossFen: null, buyFeesFen: null, stressLossFen: null, accountHash: account ? canonicalSha256(account) : null,
    formula: 'max lot-multiple q satisfying buyGross+buyFees<=cash; (held+q)*buyPrice<=explicit value cap; buyGross+buyFees-(stressExit*q-sellFees)<=explicit loss budget; stressExit=adversely slipped/tick-rounded stop*(1-stressGapBps/10000)', issues: [] };
  if (!account) { base.issues.push('USER_CONFIRMED_ACCOUNT_AND_RISK_BUDGET_MISSING'); return base; }
  if (account.availableAt > at || account.asOf > at || account.confirmedAt > at) { base.status = 'ACCOUNT_NOT_AVAILABLE'; base.issues.push('ACCOUNT_FROM_FUTURE'); return base; }
  const p = portfolio ?? portfolioOf(account);
  const held = p.lots.reduce((n, l) => n + l.quantity, 0);
  const stressExit = slipped(ratio(stopFen, 10_000 - account.constraints.stressGapBps, 10_000), 'SELL', rules.costs, tickFen);
  base.stressExitFen = stressExit;
  if (stressExit <= 0 || stopFen >= buyPriceFen) { base.status = 'RISK_REJECTED'; base.quantity = 0; base.issues.push('INVALID_PRICE_RISK_RELATION'); return base; }
  const maxValue = Math.max(0, account.constraints.maxPositionValueFen - gross(buyPriceFen, held));
  let lo = 0, hi = Math.floor(Math.min(p.cashFen, maxValue) / buyPriceFen / lotShares);
  const acceptable = (lots: number): boolean => {
    const q = lots * lotShares, amount = gross(buyPriceFen, q);
    const buyFees = fees(amount, 'BUY', rules.costs), sale = gross(stressExit, q);
    const loss = amount + buyFees - sale + fees(sale, 'SELL', rules.costs);
    return amount + buyFees <= p.cashFen && loss <= account.constraints.maxLossFen && amount <= maxValue;
  };
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (acceptable(mid)) lo = mid; else hi = mid - 1; }
  const q = lo * lotShares, amount = gross(buyPriceFen, q), buyFees = fees(amount, 'BUY', rules.costs), sale = gross(stressExit, q);
  base.status = q > 0 ? 'SIZED' : 'RISK_REJECTED'; base.quantity = q; base.buyGrossFen = amount; base.buyFeesFen = buyFees; base.stressLossFen = amount + buyFees - sale + fees(sale, 'SELL', rules.costs);
  if (q === 0) base.issues.push('LOT_CASH_VALUE_OR_LOSS_BUDGET_BLOCKED');
  return base;
}

export function freezePlan(data: StrategyData, rules: StrategyRules, signalDate: string, companyReport: FrozenPlan['companyReport']): FrozenPlan {
  assertRules(rules);
  assertData(data);
  const snapshot = signalAt(data, rules, signalDate);
  const index = data.calendar.sessions.findIndex((s) => s.date === signalDate);
  const expiresOn = data.calendar.sessions[index + rules.planLifetimeSessions]?.date ?? null;
  const close = snapshot.signalCloseFen;
  const terms = close === null ? null : { entryLowerFen: ratio(close, 10_000 - rules.entryGapBps, 10_000), entryUpperFen: ratio(close, 10_000 + rules.entryGapBps, 10_000), priceInvalidBelowFen: ratio(close, 10_000 - rules.stopBps, 10_000), profitAboveFen: ratio(close, 10_000 + rules.profitBps, 10_000) };
  const dayRules = known(data.states.filter((s) => s.date === signalDate), snapshot.cutoff);
  const dayRule = dayRules.length === 1 ? dayRules[0] : null;
  const indicativeRisk = terms && close && dayRule ? sizeRisk(data.account, snapshot.cutoff, null, slipped(close, 'BUY', rules.costs, dayRule.tickFen), terms.priceInvalidBelowFen, dayRule.buyLotShares, rules, dayRule.tickFen) : null;
  const q = indicativeRisk?.quantity ?? null;
  const scenarios = terms && close && dayRule ? [
    { name: '参考价不变', rawExit: close, alreadySlipped: false, assumption: '假定后续某开盘等于信号收盘，仅用于成本敏感性' },
    { name: '止盈阈值情景', rawExit: terms.profitAboveFen, alreadySlipped: false, assumption: '假定后续开盘恰为止盈阈值；日内触价不保证此价格成交' },
    { name: '价格失效阈值情景', rawExit: terms.priceInvalidBelowFen, alreadySlipped: false, assumption: '假定后续开盘恰为失效阈值；不是亏损保证上限' },
    ...(indicativeRisk?.stressExitFen ? [{ name: '跳空压力情景', rawExit: indicativeRisk.stressExitFen, alreadySlipped: true, assumption: '假定失效阈值后再下跳显式stressGap；更大跳空仍可能发生' }] : []),
  ].map((x) => {
    const entryPriceFen = indicativeRisk?.buyPriceFen ?? slipped(close, 'BUY', rules.costs, dayRule.tickFen), exitPriceFen = x.alreadySlipped ? x.rawExit : slipped(x.rawExit, 'SELL', rules.costs, dayRule.tickFen);
    const totalFeesFen = q !== null && q > 0 ? fees(gross(entryPriceFen, q), 'BUY', rules.costs) + fees(gross(exitPriceFen, q), 'SELL', rules.costs) : null;
    return { name: x.name, assumption: x.assumption, entryPriceFen, exitPriceFen, quantity: q, totalFeesFen, netPnlFen: q !== null && q > 0 && totalFeesFen !== null ? gross(exitPriceFen - entryPriceFen, q) - totalFeesFen : null };
  }) : [];
  const trend = snapshot.decision === 'TREND_CANDIDATE';
  const core = {
    schema: 'lyra-daily-plan-v1' as const, rulesHash: rules.rulesHash, subject: data.subject, subjectName: data.subjectName, cutoff: snapshot.cutoff, signalDate, expiresOn,
    inputIdentity: data.identity, snapshot, rules, terms,
    indicativeRisk, scenarios,
    accountHash: data.account && data.account.availableAt <= snapshot.cutoff ? canonicalSha256(data.account) : null, companyReport,
    alternatives: [
      { family: 'DAILY_TREND' as const, selected: trend, reason: trend ? '冻结规则当前成立；仍需验证、必经J及下一开盘成交检查' : `${snapshot.decision}: ${snapshot.issues.map((i) => i.code).join(',')}` },
      { family: 'WAIT_CASH' as const, selected: !trend, reason: trend ? '保留全现金不交易对照；触发并不保证成交' : '暂不建立新模拟持仓；资料、机制与适配状态分别保留' },
    ],
    conditions: ['仅在收盘后截点判断，之后首个已覆盖的市场交易日开盘处理；停牌可在期限内顺延', '个股快均线>慢均线且收盘>快均线；市场及当时所属行业收盘各自>慢均线', '只用当时可得版本；缺日历、行情、规则、行业、因子或账户约束均阻断相应动作', '价格区间、风险与费用按下一开盘重新计算；涨停不买、跌停不卖，滑点不穿限价', '收盘价格失效/止盈、逻辑失效、持有期限退出分别记录；只安排下一开盘，不推断日线内先后'],
    limitations: ['参数是具名研究假设，未据结果优化；合成样本不构成策略有效性', '止损阈值不是保证成交价；开盘跳空、停牌和限价可使损失超过压力情景与预算', '账户缺失时数量为空；演示账户不是用户资金、持仓或真实操作', '离线模拟A/J原件只证明清单和发布门，真实模型调用与持久化未接入', ...(expiresOn === null ? ['CALENDAR_EXPIRY_NOT_COVERED'] : [])],
  };
  const planHash = canonicalSha256(core);
  return immutable({ ...core, planId: `daily:${data.subject}:${signalDate}:${planHash.slice(0, 16)}`, planHash });
}

export function assertPlan(plan: FrozenPlan): void {
  assertRules(plan.rules);
  const { planId, planHash, ...core } = plan;
  if (canonicalSha256(core) !== planHash || planId !== `daily:${plan.subject}:${plan.signalDate}:${planHash.slice(0, 16)}` || plan.rulesHash !== plan.rules.rulesHash) throw new StrategyError('PLAN_HASH_MISMATCH');
}
