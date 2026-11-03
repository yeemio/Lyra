/** 固定反例，不选收益。变更仅在计划截点后，A/J仍消费同一组已冻结静态原件。 */
import type { FrozenA, FrozenJ, FrozenPlan, PlanReview, StrategyData, StrategyRules, ValidationReport } from './contracts.js';
import { executeAtOpen, openingContext } from './execution.js';
import { replayFrozenPlan, replayRules } from './replay.js';
import { reviewFrozenPlan } from './review.js';

export function setFutureOpen(data: StrategyData, index: number, value: number): void {
  const day = data.calendar.sessions[index]!.date;
  const q = data.openings.find((x) => x.subject === data.subject && x.date === day)!;
  const b = data.bars.find((x) => x.subject === data.subject && x.date === day)!;
  q.openFen = value; b.openFen = value; b.highFen = Math.max(b.closeFen, value) + 4; b.lowFen = Math.min(b.closeFen, value) - 4;
}

export function scenarioCases(data: StrategyData, rules: StrategyRules, plan: FrozenPlan, validation: ValidationReport, review: PlanReview,
  a: FrozenA, rejectedJ: FrozenJ, unresolvedJ: FrozenJ, waitPlan: FrozenPlan, waitReview: PlanReview) {
  const day = (i: number): string => data.calendar.sessions[i]!.date;
  const forward = { from: day(41), to: day(50) };
  const invalid = structuredClone(data); setFutureOpen(invalid, 41, plan.terms!.priceInvalidBelowFen - 10);
  const missed = structuredClone(data); setFutureOpen(missed, 41, plan.terms!.entryUpperFen + 10);
  const limits = structuredClone(data);
  for (const i of [41, 42, 43]) {
    const d = day(i), state = limits.states.find((s) => s.date === d)!, quote = limits.openings.find((q) => q.subject === data.subject && q.date === d)!;
    state.upperLimitFen = quote.openFen; state.ruleVersion = 'SYNTHETIC_OPEN_AT_LIMIT';
    const b = limits.bars.find((x) => x.subject === data.subject && x.date === d)!;
    b.highFen = quote.openFen; b.closeFen = quote.openFen - 1; b.lowFen = quote.openFen - 4;
  }
  const suspended = structuredClone(data);
  const sd = day(41); suspended.states.find((s) => s.date === sd)!.state = 'SUSPENDED';
  suspended.bars = suspended.bars.filter((b) => !(b.subject === data.subject && b.date === sd));
  suspended.openings = suspended.openings.filter((b) => !(b.subject === data.subject && b.date === sd));
  const missing = structuredClone(data); missing.bars = missing.bars.filter((b) => !(b.subject === data.subject && b.date === day(42)));
  const gapLoss = structuredClone(data); setFutureOpen(gapLoss, 44, 980);
  const wait = structuredClone(data), waitClose = waitPlan.snapshot.signalCloseFen!;
  const waitStart = data.calendar.sessions.findIndex((s) => s.date === waitPlan.signalDate) + 1;
  for (let i = waitStart; i < wait.calendar.sessions.length; i++) {
    const d = day(i), b = wait.bars.find((x) => x.subject === wait.subject && x.date === d)!;
    setFutureOpen(wait, i, waitClose); b.closeFen = waitClose; b.highFen = waitClose + 4; b.lowFen = waitClose - 4;
  }
  const rejected = reviewFrozenPlan(plan, data, validation, a, rejectedJ);
  const unresolved = reviewFrozenPlan(plan, data, validation, a, unresolvedJ);
  const absent = reviewFrozenPlan(plan, data, validation, a, null);
  const badRules = structuredClone(rules); badRules.rulesHash = '0'.repeat(64);
  const ctx = openingContext(data, day(41));
  if ('blocked' in ctx) throw new Error('synthetic opening fixture unavailable');
  const bought = executeAtOpen(ctx, { cashFen: 10_000_000, lots: [] }, 'BUY', 100, rules);
  const sameDaySell = executeAtOpen(ctx, bought.portfolio, 'SELL', 100, rules);
  const next = openingContext(data, day(42));
  if ('blocked' in next) throw new Error('synthetic next opening fixture unavailable');
  const nextDaySell = executeAtOpen(next, bought.portfolio, 'SELL', 100, rules);
  return {
    identity: 'SYNTHETIC_ADVERSARIAL_CASES', parametersOptimized: false, modelCalls: 0, actualOperations: [],
    notTriggeredAndExpired: replayFrozenPlan(wait, waitPlan, waitReview, { from: day(waitStart), to: day(57) }),
    priceInvalid: replayFrozenPlan(invalid, plan, review, forward),
    missedGap: replayFrozenPlan(missed, plan, review, forward),
    unfillableOpen: replayFrozenPlan(limits, plan, review, forward),
    explicitSuspension: replayFrozenPlan(suspended, plan, review, forward),
    missingData: replayFrozenPlan(missing, plan, review, forward),
    gapLossActualOpen: replayFrozenPlan(gapLoss, plan, review, forward),
    technicalFailure: replayRules(data, badRules, rules.outOfSample),
    jRejected: { review: rejected, replay: replayFrozenPlan(data, plan, rejected, forward) },
    jUnresolved: { review: unresolved, replay: replayFrozenPlan(data, plan, unresolved, forward) },
    jAbsent: { review: absent, replay: replayFrozenPlan(data, plan, absent, forward) },
    tPlusOne: { sameDaySell: { status: sameDaySell.status, code: sameDaySell.code, quantity: sameDaySell.quantity }, nextDaySell: { status: nextDaySell.status, code: nextDaySell.code, quantity: nextDaySell.quantity } },
  };
}
