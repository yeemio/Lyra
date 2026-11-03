import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalSha256 } from '../../canonical.js';
import { deriveSrChecklist } from '../engine.js';
import type { AFinalOutput, JOutput } from '../transport.js';
import type { FrozenA, FrozenJ, FrozenReviewArtifact, StrategyData } from './contracts.js';
import { executeAtOpen, openingContext, sellableShares } from './execution.js';
import { fixtureKnowledge, syntheticData, syntheticRules } from './fixture-data.js';
import { fees, gross } from './money.js';
import { freezePlan, freezeRules, portfolioOf, sizeRisk } from './plan.js';
import { renderStrategy } from './render.js';
import { replayFrozenPlan, replayRules, validateHistory } from './replay.js';
import { REQUIRED_STRATEGY_TABLES, reviewEvidence, reviewFrozenPlan } from './review.js';
import { setFutureOpen } from './scenarios.js';
import { strictWorkbenchResult, workbenchJson, workbenchSha256, type StrictWorkbenchRequest } from './workbench-runner.js';
import { renderWorkbenchContent } from './workbench-render.js';

// Fresh, explicitly synthetic review fixtures. No delivery files, model dispatch, network or database.
function fixture() {
  const data = syntheticData(), rules = syntheticRules(data);
  const company = { path: 'synthetic://review-repair/company', sha256: canonicalSha256('synthetic-company'), acceptedBoundary: 'new engineering fixture only' };
  const plan = freezePlan(data, rules, data.calendar.sessions[40]!.date, company);
  const validation = validateHistory(data, rules);
  const aOutput: AFinalOutput = { narrative: '新合成回归夹具，不是模型意见', conclusion: '仅验证工程行为', conclusionConditions: ['只用于隔离测试'],
    decisiveLinks: REQUIRED_STRATEGY_TABLES.map((tableId) => ({ tableId, text: `合成表 ${tableId}` })), strongestCounter: '未证明真实效果', catalysts: [], gaps: [] };
  const checklist = deriveSrChecklist([], aOutput);
  const artifact = <T>(role: 'A' | 'J', output: T, aHash: string | null, checklistHash: string | null): FrozenReviewArtifact<T> => {
    const core = { identity: 'STATIC_SIMULATED_FIXTURE' as const, role, fixtureId: `review-repair-${role}`, authoredBy: 'source-regression-test', planHash: plan.planHash,
      validationHash: validation.validationHash, evidenceBundleHash: canonicalSha256(reviewEvidence(plan, data, validation)), aHash, checklistHash, output };
    return { ...core, artifactHash: canonicalSha256(core) };
  };
  const a: FrozenA = artifact('A', aOutput, null, null);
  const j: FrozenJ = artifact<JOutput>('J', {
    verdicts: checklist.items.map((i) => ({ checklistId: i.checklistId, verdict: 'SUPPORTED', decisionBearing: true, bearingReason: '合成测试逐项绑定', remainingBasis: null, evidenceRef: i.tableId ?? 'counterevidence', correction: null })),
    conclusionRuling: { finalConclusion: aOutput.conclusion, changedFromA: false, changeReason: null, conditions: ['只用于隔离测试'] }, unresolvedDisposition: [], limitations: ['不是真实 A/J'],
  }, a.artifactHash, checklist.checklistHash);
  const review = reviewFrozenPlan(plan, data, validation, a, j);
  assert.equal(review.gate.passed, true, review.gate.blockers.join(';'));
  return { data, rules, company, plan, validation, a, j, review, window: { from: data.calendar.sessions[41]!.date, to: data.calendar.sessions[50]!.date } };
}
const context = (data: StrategyData, index: number) => {
  const ctx = openingContext(data, data.calendar.sessions[index]!.date);
  if ('blocked' in ctx) throw new Error(ctx.blocked);
  return ctx;
};

test('I-22: past unlock cannot override confirmed sellable shares, even on later replay days', () => {
  const data = syntheticData(), rules = syntheticRules(data), account = data.account!, day = data.calendar.sessions[41]!.date;
  account.asOf = `${day}T00:00:00.000Z`;
  account.holdings = [{ lotId: 'restricted', subject: data.subject, quantity: 1000, sellableQuantity: 200, costFen: 1_000_000, acquiredOn: data.calendar.sessions[30]!.date, unlocksOn: data.calendar.sessions[31]!.date }];
  const p = portfolioOf(account);
  assert.equal(sellableShares(p, day), 200);
  const first = executeAtOpen(context(data, 41), p, 'SELL', 1000, rules);
  assert.equal(first.status, 'PARTIAL'); assert.equal(first.quantity, 200);
  assert.equal(first.portfolio.lots[0]!.quantity, 800);
  assert.equal(executeAtOpen(context(data, 41), first.portfolio, 'SELL', 800, rules).quantity, 0);
  assert.equal(executeAtOpen(context(data, 42), first.portfolio, 'SELL', 800, rules).quantity, 0);
  assert.equal(p.lots[0]!.quantity, 1000);
});

test('I-22: explicit future unlock and simulated T+1 use the same lot rule', () => {
  const data = syntheticData(), rules = syntheticRules(data), today = context(data, 41);
  const p = { cashFen: 1_000_000, lots: [{ lotId: 'future-unlock', quantity: 1000, costFen: 1_000_000, acquiredOn: data.calendar.sessions[30]!.date, unlocksOn: data.calendar.sessions[43]!.date, initiallySellable: 200, initialDate: today.quote.date, dividendsFen: 0 }] };
  const partial = executeAtOpen(today, p, 'SELL', 1000, rules);
  assert.equal(partial.quantity, 200); assert.equal(sellableShares(partial.portfolio, data.calendar.sessions[42]!.date), 0);
  assert.equal(executeAtOpen(context(data, 43), partial.portfolio, 'SELL', 1000, rules).quantity, 800);
  const bought = executeAtOpen(today, { cashFen: 1_000_000, lots: [] }, 'BUY', 100, rules);
  assert.equal(bought.quantity, 100); assert.equal(executeAtOpen(today, bought.portfolio, 'SELL', 100, rules).quantity, 0);
  assert.equal(executeAtOpen(context(data, 42), bought.portfolio, 'SELL', 100, rules).quantity, 100);
  const mixed = { cashFen: 0, lots: [...p.lots, ...bought.portfolio.lots] };
  assert.equal(executeAtOpen(today, mixed, 'SELL', 1100, rules).quantity, 200);
});

test('I-24: 1900 shares already risk 1254 yuan, so a 600 yuan total budget cannot size an addition', () => {
  const data = syntheticData(), rules = syntheticRules(data), account = data.account!;
  account.holdings = [{ lotId: 'existing', subject: data.subject, quantity: 1900, sellableQuantity: 1900, costFen: 1, acquiredOn: '2026-05-01', unlocksOn: '2026-05-04' }];
  account.constraints = { maxPositionValueFen: 5_000_000, maxLossFen: 60_000, stressGapBps: 0 };
  const zeroFees = { ...rules, costs: { commissionBps: 0, minCommissionFen: 0, transferBps: 0, sellTaxBps: 0, slippageBps: 0, dividendTaxBps: 0 } };
  const risk = sizeRisk(account, data.calendar.sessions[40]!.closeAt, null, 1070, 1004, 100, zeroFees, 1);
  assert.equal(risk.status, 'RISK_REJECTED'); assert.equal(risk.quantity, 0);
  assert.equal(risk.existingStressLossFen, 125_400); assert.equal(risk.totalStressLossFen, 125_400);
  assert.equal(risk.incrementalStressLossFen, 0); assert.equal(risk.stressSellFeesFen, 0);
  assert.ok(risk.issues.includes('EXISTING_POSITION_EXCEEDS_TOTAL_LOSS_BUDGET'));
  account.holdings[0]!.costFen = 9_999_999;
  assert.equal(sizeRisk(account, data.calendar.sessions[40]!.closeAt, null, 1070, 1004, 100, zeroFees, 1).totalStressLossFen, risk.totalStressLossFen);
});

test('I-24: total stress includes one combined exit fee and preserves cash/value/lot constraints', () => {
  const data = syntheticData(), rules = syntheticRules(data), account = data.account!;
  account.holdings = [{ lotId: 'existing', subject: data.subject, quantity: 100, sellableQuantity: 100, costFen: 100_000, acquiredOn: '2026-05-01', unlocksOn: '2026-05-04' }];
  const risk = sizeRisk(account, data.calendar.sessions[40]!.closeAt, null, 1070, 1004, 100, rules, 1), q = risk.quantity!;
  assert.equal(risk.status, 'SIZED'); assert.ok(q > 0); assert.equal(q % 100, 0);
  const exit = risk.stressExitFen!, total = (100 + q) * (1070 - exit) + fees(q * 1070, 'BUY', rules.costs) + fees((100 + q) * exit, 'SELL', rules.costs);
  assert.equal(risk.totalStressLossFen, total);
  assert.equal(risk.existingStressLossFen! + risk.incrementalStressLossFen!, total);
  assert.equal(risk.stressSellFeesFen, fees((100 + q) * exit, 'SELL', rules.costs));
  assert.ok(total <= account.constraints.maxLossFen);
  assert.ok(risk.buyGrossFen! + risk.buyFeesFen! <= account.cashFen);
  assert.ok(gross(1070, 100 + q) <= account.constraints.maxPositionValueFen);
  assert.equal(sizeRisk(null, data.calendar.sessions[40]!.closeAt, null, 1070, 1004, 100, rules, 1).totalStressLossFen, null);
});

function assertContinuous(b: ReturnType<typeof fixture>, data: StrategyData, fromIndex: number) {
  const full = replayFrozenPlan(data, b.plan, b.review, b.window), from = data.calendar.sessions[fromIndex]!.date;
  const slice = replayFrozenPlan(data, b.plan, b.review, { ...b.window, from });
  assert.deepEqual(slice.events, full.events.filter((e) => e.date >= from));
  assert.deepEqual(slice.opportunities, full.opportunities.filter((o) => o.date >= from));
  assert.deepEqual(slice.equity, full.equity.filter((e) => e.date >= from));
  assert.deepEqual(slice.finalPortfolio, full.finalPortfolio); assert.equal(slice.condition, full.condition); assert.equal(slice.status, full.status);
  assert.deepEqual([...slice.continuity!.priorOpportunities, ...slice.opportunities], full.opportunities);
  assert.deepEqual([...slice.continuity!.priorEvents, ...slice.events], full.events);
  assert.equal(slice.metrics, null); assert.deepEqual(slice.continuity!.cumulativeMetrics, full.metrics);
  assert.equal(slice.efficacyAccepted, false);
  return { full, slice };
}

test('I-23: a missed first gap never revives when display starts a day later', () => {
  const b = fixture(), data = structuredClone(b.data);
  setFutureOpen(data, 41, b.plan.terms!.entryUpperFen + 10);
  const { full, slice } = assertContinuous(b, data, 42);
  assert.equal(full.condition, 'MISSED'); assert.equal(slice.events.filter((e) => e.kind === 'BUY').length, 0);
  assert.ok(slice.continuity!.priorEvents.some((e) => e.reason === 'MISSED_GAP_ABOVE_ENTRY_RANGE'));
});

test('I-23: price/logic invalidation and pending/plan expiry survive a later display window', () => {
  const b = fixture();
  const invalid = structuredClone(b.data); setFutureOpen(invalid, 41, b.plan.terms!.priceInvalidBelowFen - 1);
  assert.equal(assertContinuous(b, invalid, 42).slice.condition, 'INVALID');
  for (const mode of ['logic', 'pending-expiry'] as const) {
    const data = structuredClone(b.data);
    for (let i = 41; i <= 43; i++) { const day = data.calendar.sessions[i]!.date; data.states.find((s) => s.date === day)!.state = 'SUSPENDED'; data.bars = data.bars.filter((bar) => !(bar.subject === data.subject && bar.date === day)); }
    if (mode === 'logic') data.logic.push({ ...fixtureKnowledge('early-logic-invalidation', data.calendar.sessions[41]!.closeAt), subject: data.subject, effectiveOn: b.window.from, invalidates: true, reason: 'synthetic early invalidation' });
    const { slice } = assertContinuous(b, data, 45);
    assert.equal(slice.events.filter((e) => e.kind === 'BUY').length, 0);
    assert.ok(slice.continuity!.priorEvents.some((e) => mode === 'logic' ? e.kind === 'ENTRY_CANCELLED' : e.kind === 'ENTRY_EXPIRED'));
  }
  const { slice } = assertContinuous(b, b.data, 49);
  assert.equal(slice.events.some((e) => e.kind === 'BUY'), false);
});

test('I-23: prior fills/exit state, corporate actions and prior data failure remain effective', () => {
  const b = fixture();
  const normal = assertContinuous(b, b.data, 44);
  assert.ok(normal.slice.continuity!.priorEvents.some((e) => e.kind === 'BUY'));
  const data = structuredClone(b.data), actionDay = data.calendar.sessions[42]!;
  data.states.find((s) => s.date === actionDay.date)!.actionIds = ['cash'];
  data.actions.push({ ...fixtureKnowledge('cash-terms', `${actionDay.date}T01:00:00.000Z`), actionId: 'cash', subject: data.subject, effectiveOn: actionDay.date, kind: 'SPLIT_OR_CASH', sharesNumerator: 1, sharesDenominator: 1, cashFenPerOldShare: 10 });
  data.factors.push({ ...fixtureKnowledge('cash-factor', `${actionDay.date}T01:00:00.000Z`), subject: data.subject, effectiveOn: actionDay.date, numerator: 1, denominator: 1, actionId: 'cash' });
  const acted = assertContinuous(b, data, 44);
  assert.ok(acted.slice.continuity!.priorEvents.some((e) => e.kind === 'CORPORATE_ACTION_APPLIED'));
  const missing = structuredClone(b.data); missing.openings = missing.openings.filter((q) => !(q.subject === missing.subject && q.date === b.window.from));
  const blocked = assertContinuous(b, missing, 42);
  assert.equal(blocked.slice.status, 'DATA_INSUFFICIENT'); assert.equal(blocked.slice.continuity!.cumulativeMetrics, null);
  assert.equal(blocked.slice.events.some((e) => e.kind === 'BUY'), false);
});

test('fixed-plan continuity does not merge historical IS/OOS or bypass the J gate', () => {
  const b = fixture();
  assert.deepEqual(replayRules(b.data, b.rules, b.rules.outOfSample), b.validation.outOfSample);
  const blockedReview = reviewFrozenPlan(b.plan, b.data, b.validation, b.a, null);
  const blocked = replayFrozenPlan(b.data, b.plan, blockedReview, { ...b.window, from: b.data.calendar.sessions[44]!.date });
  assert.equal(blocked.status, 'REVIEW_BLOCKED'); assert.equal(blocked.finalPortfolio, null);
  assert.equal([...blocked.continuity!.priorEvents, ...blocked.events].some((e) => e.kind === 'BUY'), false);
  assert.equal(blockedReview.modelExecution.realReviewDone, false);
  const changedData = structuredClone(b.data); changedData.account!.constraints.maxLossFen++;
  const changedPlan = freezePlan(changedData, b.rules, b.plan.signalDate, b.company);
  assert.equal(reviewFrozenPlan(changedPlan, changedData, validateHistory(changedData, b.rules), b.a, b.j).gate.passed, false);
});

test('risk and continuity HTML exposes total-budget rejection and labels cumulative time scope', async () => {
  const b = fixture(), { slice } = assertContinuous(b, b.data, 44);
  const account = structuredClone(b.data.account!);
  account.holdings = [{ lotId: 'existing', subject: b.data.subject, quantity: 1900, sellableQuantity: 1900, costFen: 1, acquiredOn: '2026-05-01', unlocksOn: '2026-05-04' }];
  account.constraints = { maxPositionValueFen: 5_000_000, maxLossFen: 60_000, stressGapBps: 0 };
  const { rulesHash: _, ...core } = b.rules;
  const zero = freezeRules({ ...core, stopBps: 617, costs: { commissionBps: 0, minCommissionFen: 0, transferBps: 0, sellTaxBps: 0, slippageBps: 0, dividendTaxBps: 0 } });
  const data = { ...b.data, account }, view = freezePlan(data, zero, b.plan.signalDate, b.company);
  const validation = validateHistory(data, zero), review = reviewFrozenPlan(view, data, validation, null, null);
  const simulation = replayFrozenPlan(data, view, review, slice.window);
  const html = renderStrategy(view, review, validation, simulation);
  assert.match(html, /已有持仓压力损失/); assert.match(html, /合计标的压力损失/); assert.match(html, /1254.00 元/);
  assert.match(html, /EXISTING_POSITION_EXCEEDS_TOTAL_LOSS_BUDGET/); assert.match(html, /累计指标覆盖/);
  assert.match(html, /不据累计值声称展示窗口收益/);
  const companyBytes = Buffer.from('<p>Synthetic engineering fixture only</p>');
  const inputs = new Map([['data', workbenchJson(data)], ['rules', workbenchJson(zero)], ['company-report', companyBytes]]);
  const pin = (id: string) => ({ path: `${id}.json`, sha256: workbenchSha256(inputs.get(id)!) });
  const request: StrictWorkbenchRequest = { schema: 'lyra-l2-workbench-request-v1', mode: 'STRICT_REPLAY', createdAt: '2026-11-03T00:00:00.000Z',
    data: pin('data'), rules: pin('rules'), companyReport: { file: pin('company-report'), reference: { ...b.company, sha256: workbenchSha256(companyBytes) } }, signalDate: b.plan.signalDate, simulationWindow: slice.window, a: null, j: null };
  const result = strictWorkbenchResult(request, workbenchSha256(workbenchJson(request)), inputs);
  assert.equal(result.executionEligible, false); assert.equal(result.realReviewDone, false); assert.equal(result.efficacyAccepted, false);
  const workbenchHtml = renderWorkbenchContent({ status: 'LOADED', loaded: { result, manifestSha256: canonicalSha256('synthetic-manifest'), sources: [] } }, 'synthetic-csrf');
  assert.match(workbenchHtml, /已有仓位压力损失已超过该标的总预算/); assert.match(workbenchHtml, /1,254.00 元/);
  assert.match(workbenchHtml, /累计指标覆盖/); assert.match(workbenchHtml, /展示窗口机会/);
  if (process.env.LYRA_REVIEW_ARTIFACT_DIR) {
    await mkdir(process.env.LYRA_REVIEW_ARTIFACT_DIR, { recursive: true });
    await writeFile(join(process.env.LYRA_REVIEW_ARTIFACT_DIR, 'PR07-synthetic-render.html'), html);
    await writeFile(join(process.env.LYRA_REVIEW_ARTIFACT_DIR, 'PR07-workbench-render.html'), workbenchHtml);
  }
});
