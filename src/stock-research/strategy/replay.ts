import { canonicalSha256 } from '../../canonical.js';
import type { FrozenPlan, Issue, Opportunity, PlanReview, Portfolio, ReplayResult, StrategyData, StrategyEvent, StrategyRules, ValidationReport } from './contracts.js';
import { assertData, closeCutoff, issueOf, known, one, signalAt, snapshotInput } from './data.js';
import { applyActions, entryAtOpen, executeAtOpen, openingContext } from './execution.js';
import { gross, ratio, StrategyError } from './money.js';
import { assertPlan, assertRules, freezePlan, portfolioOf } from './plan.js';
import { offlineReviewIsBound } from './review.js';

const HISTORICAL_REPORT = { path: '(rule-validation-only)', sha256: canonicalSha256('not-a-company-report'), acceptedBoundary: '确定性规则验证，不是经A/J发布的用户计划' };

function empty(data: StrategyData, rules: StrategyRules, window: ReplayResult['window'], plan: FrozenPlan | null): ReplayResult {
  return { schema: 'lyra-daily-replay-v1', identity: plan ? 'OFFLINE_FROZEN_PLAN_SIMULATION' : 'HISTORICAL_RULE_REPLAY', rulesHash: rules.rulesHash,
    dataHash: canonicalSha256(data), planHash: plan?.planHash ?? null, window, status: 'DATA_INSUFFICIENT', issues: [], opportunities: [], events: [], equity: [], metrics: null, finalPortfolio: null, condition: 'UNTRIGGERED', efficacyAccepted: false };
}

/** 历史验证只执行冻结规则的确定性程序，不调用模拟/真实模型，不宣称完成用户计划J。 */
export function replayRules(data: StrategyData, rules: StrategyRules, window: ReplayResult['window']): ReplayResult {
  return replay(data, rules, window, null, null);
}

export function replayFrozenPlan(data: StrategyData, plan: FrozenPlan, review: PlanReview, window: ReplayResult['window']): ReplayResult {
  return replay(data, plan.rules, window, plan, review);
}

function replay(data: StrategyData, rules: StrategyRules, window: ReplayResult['window'], fixed: FrozenPlan | null, review: PlanReview | null): ReplayResult {
  const result = empty(data, rules, window, fixed);
  const sessions = data.calendar?.sessions?.filter((s) => s.date >= window.from && s.date <= window.to) ?? [];
  const append = (plan: FrozenPlan | null, date: string, at: string, kind: string, reason: string, attribution: StrategyEvent['attribution'], extra: Partial<Pick<StrategyEvent, 'quantity' | 'priceFen' | 'feesFen' | 'netPnlFen' | 'evidenceIds'>> = {}): void => {
    const core = { planId: plan?.planId ?? `rules:${rules.rulesHash}`, planHash: plan?.planHash ?? rules.rulesHash, date, at, kind, reason, attribution, quantity: null, priceFen: null, feesFen: null, netPnlFen: null, evidenceIds: [], ...extra };
    result.events.push({ ...core, eventId: canonicalSha256({ ...core, sequence: result.events.length }) });
  };
  try {
    assertRules(rules); assertData(data); if (fixed) assertPlan(fixed);
    if (!sessions.length || data.calendar.completeFrom > window.from || data.calendar.completeTo < window.to || window.from > window.to) throw new StrategyError('WINDOW_OUTSIDE_CALENDAR');
    if (fixed && (fixed.subject !== data.subject || window.from <= fixed.signalDate || fixed.expiresOn === null || canonicalSha256(snapshotInput(data, fixed.cutoff)) !== fixed.snapshot.inputHash)) throw new StrategyError('FROZEN_PLAN_INPUT_OR_WINDOW_INVALID');
    if (fixed && (!review || !offlineReviewIsBound(fixed, review))) {
      result.status = 'REVIEW_BLOCKED'; result.issues.push({ code: 'MANDATORY_J_GATE_BLOCKED', date: null, detail: review?.gate.blockers.join(';') ?? 'J missing' });
      append(fixed, sessions[0]!.date, sessions[0]!.openAt, 'REVIEW_BLOCKED', '没有绑定当前冻结计划的有效离线A→清单→J，不模拟成交', 'RESEARCH');
      result.opportunities = sessions.map((s) => ({ opportunityId: `${data.subject}:DAILY_TREND:${s.date}`, date: s.date, cutoff: closeCutoff(s, rules), decision: 'DATA_PENDING', reasonCodes: ['MANDATORY_J_GATE_BLOCKED'], planId: fixed.planId }));
      return result;
    }
    const account = data.account;
    if (!account || account.availableAt > sessions[0]!.openAt) {
      result.issues.push({ code: !account ? 'ACCOUNT_AND_RISK_BUDGET_MISSING' : 'ACCOUNT_NOT_AVAILABLE_AT_WINDOW_START', date: sessions[0]!.date, detail: '具体数量与组合收益未计算；没有假设用户空仓或默认资金' });
      result.opportunities = sessions.map((s) => { const signal = signalAt(data, rules, s.date); return { opportunityId: `${data.subject}:DAILY_TREND:${s.date}`, date: s.date, cutoff: signal.cutoff, decision: signal.decision, reasonCodes: [...signal.issues.map((i) => i.code), 'ACCOUNT_AND_RISK_BUDGET_MISSING'], planId: fixed?.planId ?? null }; });
      for (const s of sessions) append(fixed, s.date, s.openAt, 'QUANTITY_UNAVAILABLE', 'ACCOUNT_AND_RISK_BUDGET_MISSING', 'RISK');
      return result;
    }
    let portfolio = portfolioOf(account), active: FrozenPlan | null = fixed;
    let terms = fixed?.terms ? { ...fixed.terms } : null;
    let pending: { plan: FrozenPlan; since: number } | null = fixed?.snapshot.decision === 'TREND_CANDIDATE' ? { plan: fixed, since: 0 } : null;
    let pendingExit: string | null = null, heldSince = portfolio.lots.length ? -1 : null, terminal = false, dataBlocked = false;
    const priorMarks = known(data.bars.filter((b) => b.subject === data.subject && b.date < sessions[0]!.date), sessions[0]!.openAt).sort((a, b) => a.date.localeCompare(b.date));
    let initialEquity: number | null = null, lastMark: number | null = priorMarks.at(-1)?.closeFen ?? null, turnover = 0, totalFees = 0, fills = 0, closedTrades = 0, unfilled = 0;
    let firstBenchmark: number | null = null, lastBenchmark: number | null = null;
    const totalQty = (): number => portfolio.lots.reduce((n, l) => n + l.quantity, 0);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!, cutoff = closeCutoff(s, rules);
      const ctx = openingContext(data, s.date);
      if ('blocked' in ctx && ctx.blocked !== 'EXPLICIT_SUSPENSION') {
        dataBlocked = true; result.issues.push({ code: ctx.blocked, date: s.date, detail: '开盘时不可得；不使用该日收盘事实倒推开盘' });
      }
      if (!('blocked' in ctx) || ctx.blocked === 'EXPLICIT_SUSPENSION') {
        const applied = applyActions(data, rules, s.date, s.openAt, portfolio, terms);
        portfolio = applied.portfolio; terms = applied.terms;
        for (const a of known(data.actions.filter((a) => a.subject === data.subject && a.effectiveOn === s.date), s.openAt)) if (lastMark !== null) lastMark = ratio(Math.max(1, lastMark - a.cashFenPerOldShare), a.sharesDenominator, a.sharesNumerator);
        totalFees += applied.costsFen;
        if (applied.evidenceIds.length) append(active, s.date, s.openAt, 'CORPORATE_ACTION_APPLIED', '股数、现金与派生价格条件按已知公司行为调整，原计划不改写', 'RULE', { evidenceIds: applied.evidenceIds, feesFen: applied.costsFen });
      }
      if (i === 0) {
        if (!('blocked' in ctx)) lastMark = ctx.quote.openFen;
        if (lastMark !== null) initialEquity = portfolio.cashFen + gross(lastMark, totalQty());
        else if (totalQty() === 0) initialEquity = portfolio.cashFen;
      }
      const expired = fixed && fixed.expiresOn !== null && s.date > fixed.expiresOn;
      if (expired && !terminal && totalQty() === 0) { terminal = true; pending = null; result.condition = 'EXPIRED'; append(fixed, s.date, s.openAt, 'PLAN_EXPIRED', '冻结计划到期，后续触发不得补入', 'TIMING'); }
      if (pendingExit && totalQty() > 0) {
        if ('blocked' in ctx) { unfilled++; append(active, s.date, s.openAt, 'EXIT_UNFILLED', `${pendingExit}:${ctx.blocked}`, 'EXECUTION', { evidenceIds: ctx.evidenceIds }); }
        else {
          const fill = executeAtOpen(ctx, portfolio, 'SELL', totalQty(), rules);
          append(active, s.date, s.openAt, fill.status === 'BLOCKED' ? 'EXIT_UNFILLED' : 'SELL', `${pendingExit}:${fill.code}${fill.netPnlFen !== null && -fill.netPnlFen > account.constraints.maxLossFen ? ':REALIZED_LOSS_EXCEEDS_SCENARIO_BUDGET' : ''}`, 'EXECUTION', { quantity: fill.quantity, priceFen: fill.priceFen, feesFen: fill.feesFen, netPnlFen: fill.netPnlFen, evidenceIds: fill.evidenceIds });
          if (fill.status === 'BLOCKED') unfilled++;
          else { portfolio = fill.portfolio; fills++; totalFees += fill.feesFen; turnover += gross(fill.priceFen!, fill.quantity); if (totalQty() === 0) { closedTrades++; pendingExit = null; heldSince = null; if (fixed) terminal = true; } }
        }
      } else if (pending && totalQty() === 0 && !terminal) {
        if (i - pending.since >= rules.pendingEntrySessions) { append(pending.plan, s.date, s.openAt, 'ENTRY_EXPIRED', '入场等待窗口已耗尽；不追溯成交', 'TIMING'); pending = null; result.condition = 'EXPIRED'; if (fixed) terminal = true; }
        else if (dataBlocked) { append(pending.plan, s.date, s.openAt, 'ENTRY_BLOCKED_DATA', '当前回放已有未解释资料缺口', 'DATA'); }
        else if ('blocked' in ctx) { unfilled++; append(pending.plan, s.date, s.openAt, 'ENTRY_UNFILLED', ctx.blocked, 'EXECUTION', { evidenceIds: ctx.evidenceIds }); }
        else if (terms) {
          const entry = entryAtOpen(data, rules, pending.plan, ctx, portfolio, terms);
          if (entry.fill && entry.fill.status !== 'BLOCKED') {
            const fill = entry.fill; portfolio = fill.portfolio; heldSince = i; fills++; totalFees += fill.feesFen; turnover += gross(fill.priceFen!, fill.quantity);
            append(pending.plan, s.date, s.openAt, 'BUY', fill.code, 'EXECUTION', { quantity: fill.quantity, priceFen: fill.priceFen, feesFen: fill.feesFen, evidenceIds: fill.evidenceIds });
            active = pending.plan; pending = null; result.condition = 'TRIGGERED';
          } else {
            unfilled++; append(pending.plan, s.date, s.openAt, entry.terminal ? 'ENTRY_TERMINATED' : 'ENTRY_UNFILLED', entry.code, entry.code.includes('RISK') || entry.code.includes('ACCOUNT') ? 'RISK' : 'EXECUTION', { evidenceIds: [ctx.quote.factId, ctx.state.factId] });
            if (entry.terminal) { result.condition = entry.code.startsWith('MISSED') ? 'MISSED' : 'INVALID'; pending = null; if (fixed) terminal = true; }
          }
        }
      }
      // 收盘判断在全部开盘处理之后。该日稍后材料缺失也不能反向取消已发生的开盘成交。
      const signal = signalAt(data, rules, s.date);
      const opportunity: Opportunity = { opportunityId: `${data.subject}:DAILY_TREND:${s.date}`, date: s.date, cutoff, decision: signal.decision, reasonCodes: signal.issues.map((x) => x.code), planId: active?.planId ?? null };
      result.opportunities.push(opportunity);
      if (signal.decision === 'DATA_PENDING' || signal.decision === 'TECHNICAL_FAILURE') {
        dataBlocked = true; result.issues.push(...signal.issues);
        append(active, s.date, cutoff, 'DATA_OR_COMPUTE_BLOCKED', signal.issues.map((x) => x.code).join(';'), signal.decision === 'TECHNICAL_FAILURE' ? 'RULE' : 'DATA');
      }
      const raw = known(data.bars.filter((b) => b.subject === data.subject && b.date === s.date), cutoff);
      const state = known(data.states.filter((x) => x.date === s.date), cutoff);
      let stale = false;
      if (raw.length === 1) lastMark = raw[0]!.closeFen;
      else if (state.length === 1 && state[0]!.state === 'SUSPENDED' && lastMark !== null) stale = true;
      else { dataBlocked = true; result.issues.push({ code: 'CLOSE_VALUATION_MISSING', date: s.date, detail: '无法确定组合净值，最终收益不展示' }); }
      if (lastMark !== null && initialEquity !== null) result.equity.push({ date: s.date, equityFen: portfolio.cashFen + gross(lastMark, totalQty()), investedFen: gross(lastMark, totalQty()), staleMark: stale });
      const bm = known(data.bars.filter((b) => b.subject === data.marketBenchmark && b.date === s.date), cutoff);
      const bmOpen = known(data.openings.filter((q) => q.subject === data.marketBenchmark && q.date === s.date), s.openAt);
      if (i === 0) {
        if (bmOpen.length === 1) firstBenchmark = bmOpen[0]!.openFen;
        else {
          const delivered = data.openings.filter((q) => q.subject === data.marketBenchmark && q.date === s.date);
          const code = bmOpen.length > 1 ? 'BENCHMARK_OPEN_CONFLICT_AT_START' : delivered.length === 0 ? 'BENCHMARK_OPEN_MISSING_AT_START' : 'BENCHMARK_OPEN_NOT_AVAILABLE_AT_START';
          result.issues.push({ code, date: s.date, detail: `${data.marketBenchmark}; requiredAt=${s.openAt}; 不用后续收盘或其他日期倒填起点` });
        }
      }
      if (bm.length === 1) lastBenchmark = bm[0]!.closeFen;
      else { dataBlocked = true; result.issues.push({ code: 'BENCHMARK_UNALIGNED_OR_NOT_AVAILABLE', date: s.date, detail: data.marketBenchmark }); }
      if (totalQty() > 0) {
        if (signal.decision !== 'DATA_PENDING' && signal.decision !== 'TECHNICAL_FAILURE') opportunity.decision = 'ALREADY_POSITIONED';
        if (terms && raw.length === 1 && raw[0]!.closeFen <= terms.priceInvalidBelowFen) pendingExit ??= 'PRICE_INVALID_CLOSE';
        else if (signal.decision === 'LOGIC_INVALID') pendingExit ??= 'LOGIC_INVALID';
        else if (terms && raw.length === 1 && raw[0]!.closeFen >= terms.profitAboveFen) pendingExit ??= 'PROFIT_EXIT_CLOSE';
        else if (heldSince !== null && i - heldSince + 1 >= rules.maxHoldingSessions) pendingExit ??= 'HOLDING_TIME_EXIT';
        else if (fixed?.expiresOn && s.date >= fixed.expiresOn) pendingExit ??= 'PLAN_TIME_EXPIRED';
        if (pendingExit) { result.condition = pendingExit === 'PRICE_INVALID_CLOSE' || pendingExit === 'LOGIC_INVALID' ? 'INVALID' : result.condition; append(active, s.date, cutoff, 'EXIT_SCHEDULED', pendingExit, pendingExit === 'LOGIC_INVALID' ? 'RESEARCH' : 'RULE', { evidenceIds: signal.evidenceIds }); }
      } else if (pending && ((terms && raw.length === 1 && raw[0]!.closeFen <= terms.priceInvalidBelowFen)
        || known(data.logic.filter((l) => l.subject === data.subject && l.effectiveOn <= s.date), cutoff).some((l) => l.invalidates))) {
        const reason = terms && raw.length === 1 && raw[0]!.closeFen <= terms.priceInvalidBelowFen ? 'PRICE_INVALID_CLOSE' : 'LOGIC_INVALID';
        const logicIds = known(data.logic.filter((l) => l.subject === data.subject && l.effectiveOn <= s.date), cutoff).filter((l) => l.invalidates).map((l) => l.factId);
        append(pending.plan, s.date, cutoff, 'ENTRY_CANCELLED', reason, reason === 'LOGIC_INVALID' ? 'RESEARCH' : 'RULE', { evidenceIds: [...new Set([...signal.evidenceIds, ...raw.map((r) => r.factId), ...logicIds])].sort() });
        opportunity.reasonCodes.push(reason);
        result.condition = 'INVALID'; pending = null;
        if (fixed) terminal = true;
      } else if (!terminal && !dataBlocked && !pending) {
        if (signal.decision === 'LOGIC_INVALID') { result.condition = 'INVALID'; if (fixed) terminal = true; append(active, s.date, cutoff, 'LOGIC_INVALID', '当时可得反证使逻辑失效', 'RESEARCH', { evidenceIds: signal.evidenceIds }); }
        else if (signal.decision === 'TREND_CANDIDATE') {
          active = fixed ?? freezePlan(data, rules, s.date, HISTORICAL_REPORT); terms = active.terms ? { ...active.terms } : null;
          pending = { plan: active, since: i + 1 }; opportunity.planId = active.planId;
          append(active, s.date, cutoff, 'ENTRY_SIGNAL', '收盘规则触发，只安排之后开盘', 'TIMING', { evidenceIds: signal.evidenceIds });
        } else append(active, s.date, cutoff, 'WAIT', signal.issues.map((x) => x.code).join(';') || signal.decision, 'RESEARCH', { evidenceIds: signal.evidenceIds });
      } else if (pending) opportunity.decision = 'PENDING_ENTRY';
    }
    result.finalPortfolio = portfolio;
    if (!dataBlocked && firstBenchmark !== null && initialEquity !== null && initialEquity > 0 && result.equity.length === sessions.length) {
      let peak = initialEquity, maximumDrawdownBps = 0, exposures = 0;
      for (const p of result.equity) { peak = Math.max(peak, p.equityFen); maximumDrawdownBps = Math.max(maximumDrawdownBps, ratio(peak - p.equityFen, 10_000, peak)); exposures += p.equityFen > 0 ? ratio(p.investedFen, 10_000, p.equityFen) : 0; }
      const finalEquity = result.equity.at(-1)!.equityFen;
      result.metrics = { initialEquityFen: initialEquity, finalEquityFen: finalEquity, netPnlFen: finalEquity - initialEquity, netReturnBps: ratio(finalEquity - initialEquity, 10_000, initialEquity), maximumDrawdownBps,
        meanExposureBps: ratio(exposures, 1, sessions.length), turnoverBps: ratio(turnover, 10_000, initialEquity), feesFen: totalFees, closedTrades, fills, unfilledAttempts: unfilled, valuedSessions: result.equity.length, allOpportunities: result.opportunities.length,
        benchmarkReturnBps: firstBenchmark !== null && lastBenchmark !== null ? ratio(lastBenchmark - firstBenchmark, 10_000, firstBenchmark) : null, waitCashReturnBps: 0 };
      result.status = !fixed && (sessions.length < rules.minimumSessions || closedTrades < rules.minimumClosedTrades) ? 'INSUFFICIENT_SAMPLE' : data.identity === 'SYNTHETIC' ? 'COMPUTED_SYNTHETIC' : 'COMPUTED_HISTORICAL';
      if (result.status === 'INSUFFICIENT_SAMPLE') result.issues.push({ code: 'MINIMUM_SAMPLE_NOT_MET', date: null, detail: `sessions=${sessions.length}/${rules.minimumSessions};closedTrades=${closedTrades}/${rules.minimumClosedTrades}` });
    } else result.status = 'DATA_INSUFFICIENT';
    if (dataBlocked) result.condition = 'FAILED';
    if (pendingExit) result.issues.push({ code: 'EXIT_PENDING_AT_WINDOW_END', date: sessions.at(-1)!.date, detail: pendingExit });
    if (totalQty() > 0) result.issues.push({ code: 'OPEN_POSITION_MARKED_NOT_LIQUIDATED', date: sessions.at(-1)!.date, detail: '以末日有据收盘估值，未伪造成交；潜在退出费用未扣' });
    if (pending) result.issues.push({ code: 'ENTRY_PENDING_AT_WINDOW_END', date: sessions.at(-1)!.date, detail: '未产生假想成交' });
    return result;
  } catch (e) {
    const issue = issueOf(e); result.issues.push(issue); result.status = e instanceof StrategyError && /MISSING|AVAILABLE|PIT|CALENDAR|COVERAGE/.test(e.code) ? 'DATA_INSUFFICIENT' : 'TECHNICAL_FAILURE'; result.metrics = null; result.condition = 'FAILED';
    const done = new Set(result.opportunities.map((o) => o.date));
    for (const s of sessions) if (!done.has(s.date)) result.opportunities.push({ opportunityId: `${data.subject}:DAILY_TREND:${s.date}`, date: s.date, cutoff: closeCutoff(s, rules), decision: 'TECHNICAL_FAILURE', reasonCodes: [issue.code], planId: fixed?.planId ?? null });
    append(fixed, sessions[0]?.date ?? window.from, sessions[0]?.openAt ?? `${window.from}T00:00:00.000Z`, 'REPLAY_FAILED', issue.code, 'DATA');
    return result;
  }
}

export function validateHistory(data: StrategyData, rules: StrategyRules): ValidationReport {
  assertRules(rules);
  const inSample = replayRules(data, rules, rules.inSample), outOfSample = replayRules(data, rules, rules.outOfSample);
  const computed = (r: ReplayResult): boolean => r.status === 'COMPUTED_SYNTHETIC' || r.status === 'COMPUTED_HISTORICAL';
  const core = { schema: 'lyra-daily-validation-v1' as const, rulesHash: rules.rulesHash, dataHash: canonicalSha256(data), selection: 'RULES_FROZEN_BEFORE_REPLAY_NO_TUNING' as const, inSample, outOfSample,
    status: computed(inSample) && computed(outOfSample) ? data.identity === 'SYNTHETIC' ? 'SYNTHETIC_BEHAVIOR_ONLY' as const : 'HISTORICAL_COMPUTED_NOT_ACCEPTED' as const : 'INCOMPLETE' as const, efficacyAccepted: false as const,
    denominatorDefinitions: {
      opportunities: '窗口内每个市场交易日×此标的×冻结策略族；含等待、拒绝、缺资料、失败与持仓占用，每日恰一条；非交易日不计',
      fills: '实际确定性模拟的买卖成交事件数；部分成交计一事件；不是信号数',
      unfilledAttempts: '实际尝试后被停牌/限价/可卖/风险等阻断的开盘事件数；可多于机会数，不作胜率分母',
      closedTrades: '完整平掉一段非重叠模拟持仓的次数；窗口末持仓只估值，不假装已平',
      netReturn: '(末日收盘组合净值-窗口初始开盘组合净值)/窗口初始净值；实际成交已扣费用/不利滑点；未平仓潜在退出费用未扣',
      maximumDrawdown: '含初始净值在内的逐市场交易日收盘净值峰谷；非盘中回撤，停牌估值注明沿用最后有效价',
      exposure: '所有可估值市场交易日的(持仓市值/当日净值)算术均值；资料缺口时总体指标为空',
      turnover: '买卖实际成交总额之和/窗口初始净值（双边）；不使用年化',
      benchmark: '同窗市场基准首日已知原始开盘至末日收盘价格回报；不计基准交易费、不冒称可交易或含息总回报',
      waitCash: '显式全现金、零收益不交易反事实；不假定用户现有持仓消失',
      sampleSplit: '样本内、样本外独立起始账户与持仓，不跨窗带仓；慢均线预热只消费当时已知的此前资料；未调参、未年化、未估概率',
    } };
  return { ...core, validationHash: canonicalSha256(core) };
}
