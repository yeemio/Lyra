import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { canonicalSha256 } from '../../canonical.js';
import type { FrozenJ, FrozenReviewArtifact } from './contracts.js';
import { assertData, factorAt, signalAt } from './data.js';
import { applyActions, executeAtOpen, openingContext } from './execution.js';
import { fixtureKnowledge } from './fixture-data.js';
import { fees, gross, slipped } from './money.js';
import { computeOfflineBundle, writeOfflineArtifacts } from './offline-demo.js';
import { assertPlan, assertRules, freezePlan, freezeRules, portfolioOf, sizeRisk } from './plan.js';
import { renderStrategy } from './render.js';
import { replayFrozenPlan, replayRules, validateHistory } from './replay.js';
import { reviewEvidence, reviewFrozenPlan } from './review.js';
import { setFutureOpen } from './scenarios.js';

let b: Awaited<ReturnType<typeof computeOfflineBundle>>;
let temp: string;
before(async () => { b = await computeOfflineBundle(); temp = await mkdtemp(join(tmpdir(), 'lyra-daily-r1-')); });
after(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });
const rehash = <T>(artifact: FrozenReviewArtifact<T>): FrozenReviewArtifact<T> => { const { artifactHash: _, ...core } = artifact; return { ...core, artifactHash: canonicalSha256(core) }; };

test('冻结规则/计划身份拒绝篡改、重叠窗；回放不改输入和参数', () => {
  const { data, rules } = b.inputs;
  const beforeHash = canonicalSha256({ data, rules, plan: b.plan });
  assert.equal(canonicalSha256(validateHistory(data, rules)), canonicalSha256(b.validation));
  assert.equal(canonicalSha256({ data, rules, plan: b.plan }), beforeHash);
  const { rulesHash: _, ...core } = rules;
  assert.throws(() => freezeRules({ ...core, outOfSample: { from: core.inSample.to, to: core.outOfSample.to } }), /IS_OOS_OVERLAP/);
  assert.throws(() => assertRules({ ...rules, fastSessions: rules.fastSessions + 1 }), /RULES_HASH_MISMATCH/);
  const p = structuredClone(b.plan); p.terms!.profitAboveFen++;
  assert.throws(() => assertPlan(p), /PLAN_HASH_MISMATCH/);
  assert.equal(Object.isFrozen(b.plan), true);
});

test('未来行情、修订、行业及反证不改变旧截点快照或计划；未来因子不倒灌', () => {
  const data = structuredClone(b.inputs.data), day = b.plan.signalDate, future = data.calendar.sessions[55]!;
  const old = data.bars.find((x) => x.subject === data.subject && x.date === day)!;
  data.bars.push({ ...old, ...fixtureKnowledge('late-revision', future.closeAt), supersedesFactId: old.factId, closeFen: old.closeFen + 1 });
  const f = data.factors.find((x) => x.subject === data.subject)!;
  data.factors.push({ ...f, ...fixtureKnowledge('future-factor-revision', future.closeAt), supersedesFactId: f.factId, numerator: 3 });
  data.industries.push({ ...fixtureKnowledge('future-membership', future.closeAt), subject: data.subject, industry: 'UNDELIVERED_FUTURE_INDUSTRY', validFrom: future.date, validTo: null });
  data.logic.push({ ...fixtureKnowledge('future-counterevidence', future.closeAt), subject: data.subject, effectiveOn: day, invalidates: true, reason: '未来才取得，不得提前见到' });
  assertData(data);
  assert.deepEqual(signalAt(data, b.inputs.rules, day), b.plan.snapshot);
  assert.equal(factorAt(data, data.subject, day, b.plan.cutoff).numerator, 1);
  assert.equal(freezePlan(data, b.inputs.rules, day, b.inputs.company).planHash, b.plan.planHash);
});

test('可得时间与取得时间独立；后取材料不得回填早可得，修订不能跨逻辑键', () => {
  const data = structuredClone(b.inputs.data);
  data.bars[0]!.firstObservedAt = data.calendar.sessions[20]!.closeAt;
  assert.throws(() => assertData(data), /AVAILABILITY_BEFORE_ACQUISITION/);
  const cross = structuredClone(b.inputs.data), old = cross.bars[0]!;
  cross.bars.push({ ...old, ...fixtureKnowledge('cross-date-revision', cross.calendar.sessions[50]!.closeAt), supersedesFactId: old.factId, date: cross.calendar.sessions[1]!.date });
  assert.throws(() => assertData(cross), /REVISION_CROSSES_LOGICAL_KEY/);
});

test('下一开盘成交不偷读当天收盘；即使稍后缺行情也保留已经发生的开盘事实', () => {
  const data = structuredClone(b.inputs.data), day = data.calendar.sessions[41]!.date;
  data.bars = data.bars.filter((x) => !(x.subject === data.subject && x.date === day));
  const replay = replayFrozenPlan(data, b.plan, b.review, b.forward.window);
  assert.equal(replay.status, 'DATA_INSUFFICIENT'); assert.equal(replay.metrics, null);
  const buy = replay.events.find((x) => x.kind === 'BUY'), originalBuy = b.forward.events.find((x) => x.kind === 'BUY');
  assert.deepEqual(buy, originalBuy);
  assert.equal(buy!.at, data.calendar.sessions[41]!.openAt);
  assert.ok(buy!.at > b.plan.cutoff);
});

test('开盘触板即保守不成交；晚一分钟取得的开盘不能倒填成交', () => {
  const d = b.inputs.data, day = d.calendar.sessions[41]!.date, ctx = openingContext(d, day);
  assert.ok(!('blocked' in ctx)); if ('blocked' in ctx) return;
  const p = { cashFen: 1_000_000, lots: [] };
  const limitCtx = structuredClone(ctx); limitCtx.state.upperLimitFen = ctx.quote.openFen;
  assert.equal(executeAtOpen(limitCtx, p, 'BUY', 100, b.inputs.rules).code, 'OPEN_AT_BUY_LIMIT');
  const late = structuredClone(ctx); late.quote.availableAt = `${day}T01:31:00.000Z`;
  assert.equal(executeAtOpen(late, p, 'BUY', 100, b.inputs.rules).code, 'OPEN_INPUT_NOT_AVAILABLE_OR_INCOMPATIBLE');
  const sellCtx = structuredClone(ctx); sellCtx.state.lowerLimitFen = ctx.quote.openFen;
  const held = { cashFen: 0, lots: [{ lotId: 'older', quantity: 100, costFen: 100_000, acquiredOn: d.calendar.sessions[30]!.date, unlocksOn: d.calendar.sessions[31]!.date, initiallySellable: 100, initialDate: day, dividendsFen: 0 }] };
  assert.equal(executeAtOpen(sellCtx, held, 'SELL', 100, b.inputs.rules).code, 'OPEN_AT_SELL_LIMIT');
});

test('T+1与显式可卖数量实际限制成交，未可卖部分保留', () => {
  assert.equal(b.cases.tPlusOne.sameDaySell.quantity, 0);
  assert.equal(b.cases.tPlusOne.sameDaySell.code, 'T_PLUS_ONE_OR_SELLABLE_LOCK');
  assert.equal(b.cases.tPlusOne.nextDaySell.quantity, 100);
  const d = b.inputs.data, ctx = openingContext(d, d.calendar.sessions[41]!.date);
  assert.ok(!('blocked' in ctx)); if ('blocked' in ctx) return;
  const held = { cashFen: 0, lots: [{ lotId: 'restricted', quantity: 100, costFen: 100_000, acquiredOn: d.calendar.sessions[30]!.date, unlocksOn: d.calendar.sessions[43]!.date, initiallySellable: 40, initialDate: ctx.quote.date, dividendsFen: 0 }] };
  const result = executeAtOpen(ctx, held, 'SELL', 100, b.inputs.rules);
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.quantity, 40); assert.equal(result.portfolio.lots[0]!.quantity, 60);
  assert.deepEqual(held.lots[0]!.quantity, 100);
});

test('数量满足资金、整手、费用和压力预算；缺用户账户时数量及情景金额为空', () => {
  const { data, rules } = b.inputs, risk = b.plan.indicativeRisk!;
  assert.equal(risk.status, 'SIZED'); assert.ok(risk.quantity! > 0); assert.equal(risk.quantity! % 100, 0);
  assert.ok(risk.buyGrossFen! + risk.buyFeesFen! <= data.account!.cashFen);
  assert.ok(risk.stressLossFen! <= data.account!.constraints.maxLossFen);
  const exitAmount = gross(risk.stressExitFen!, risk.quantity!);
  assert.equal(risk.stressLossFen, risk.buyGrossFen! + risk.buyFeesFen! - exitAmount + fees(exitAmount, 'SELL', rules.costs));
  assert.equal(b.plan.scenarios.find((s) => s.name === '跳空压力情景')!.netPnlFen, -risk.stressLossFen!);
  const missing = structuredClone(data); missing.account = null;
  const p = freezePlan(missing, rules, b.plan.signalDate, b.inputs.company);
  assert.equal(p.indicativeRisk!.status, 'MISSING_ACCOUNT'); assert.equal(p.indicativeRisk!.quantity, null);
  assert.ok(p.scenarios.every((s) => s.quantity === null && s.netPnlFen === null));
  const future = structuredClone(data.account!); future.availableAt = data.calendar.sessions[55]!.closeAt;
  assert.equal(sizeRisk(future, b.plan.cutoff, null, 1072, 1027, 100, rules, 1).quantity, null);
});

test('跳空按实际下一开盘及不利滑点记损益，超过压力预算也不美化成理想止损', () => {
  const r = b.cases.gapLossActualOpen, sell = r.events.find((e) => e.kind === 'SELL')!;
  assert.equal(sell.priceFen, slipped(980, 'SELL', b.inputs.rules.costs, 1));
  assert.notEqual(sell.priceFen, b.plan.terms!.priceInvalidBelowFen);
  assert.ok(-sell.netPnlFen! > b.inputs.data.account!.constraints.maxLossFen);
  assert.match(sell.reason, /REALIZED_LOSS_EXCEEDS_SCENARIO_BUDGET/);
});

test('公司行为显式调整股数/现金/条件，因子不足不能替代股数与现金条款', () => {
  const d = structuredClone(b.inputs.data), day = d.calendar.sessions[41]!, rules = b.inputs.rules;
  d.states.find((s) => s.date === day.date)!.actionIds = ['split'];
  d.factors.push({ ...fixtureKnowledge('split-factor', `${day.date}T01:00:00.000Z`), subject: d.subject, effectiveOn: day.date, numerator: 2, denominator: 1, actionId: 'split' });
  const p = { cashFen: 1000, lots: [{ lotId: 'old', quantity: 100, costFen: 100_000, acquiredOn: d.calendar.sessions[40]!.date, unlocksOn: day.date, initiallySellable: 0, initialDate: day.date, dividendsFen: 0 }] };
  assert.throws(() => applyActions(d, rules, day.date, day.openAt, p, b.plan.terms), /CORPORATE_ACTION_TERMS_NOT_AVAILABLE/);
  d.actions.push({ ...fixtureKnowledge('split-terms', `${day.date}T01:00:00.000Z`), actionId: 'split', subject: d.subject, effectiveOn: day.date, kind: 'SPLIT_OR_CASH', sharesNumerator: 2, sharesDenominator: 1, cashFenPerOldShare: 10 });
  const adjusted = applyActions(d, rules, day.date, day.openAt, p, b.plan.terms);
  assert.equal(adjusted.portfolio.lots[0]!.quantity, 200); assert.equal(adjusted.portfolio.lots[0]!.costFen, p.lots[0]!.costFen);
  assert.equal(adjusted.portfolio.cashFen, 1900); assert.equal(adjusted.costsFen, 100);
  assert.equal(adjusted.terms!.entryUpperFen, Math.floor((b.plan.terms!.entryUpperFen - 10 + 1) / 2));
  const late = structuredClone(d); late.actions[0]!.availableAt = day.closeAt;
  assert.throws(() => applyActions(late, rules, day.date, day.openAt, p, b.plan.terms), /CORPORATE_ACTION_TERMS_NOT_AVAILABLE/);
});

test('复权只用于特征；拆股后的实际成交仍用原始价，不发生虚假翻倍收益', () => {
  const d = structuredClone(b.inputs.data), first = d.calendar.sessions[41]!;
  for (let i = 41; i < d.calendar.sessions.length; i++) {
    const day = d.calendar.sessions[i]!.date;
    const q = d.openings.find((x) => x.subject === d.subject && x.date === day)!;
    q.openFen /= 2;
    const bar = d.bars.find((x) => x.subject === d.subject && x.date === day)!;
    for (const key of ['openFen', 'highFen', 'lowFen', 'closeFen'] as const) bar[key] /= 2;
    const state = d.states.find((x) => x.date === day)!;
    state.upperLimitFen = Math.round(state.upperLimitFen / 2); state.lowerLimitFen = Math.round(state.lowerLimitFen / 2);
  }
  d.states.find((s) => s.date === first.date)!.actionIds = ['split-2'];
  d.actions.push({ ...fixtureKnowledge('split-2-terms', `${first.date}T01:00:00.000Z`), actionId: 'split-2', subject: d.subject, effectiveOn: first.date, kind: 'SPLIT_OR_CASH', sharesNumerator: 2, sharesDenominator: 1, cashFenPerOldShare: 0 });
  d.factors.push({ ...fixtureKnowledge('split-2-factor', `${first.date}T01:00:00.000Z`), subject: d.subject, effectiveOn: first.date, numerator: 2, denominator: 1, actionId: 'split-2' });
  assertData(d);
  const r = replayFrozenPlan(d, b.plan, b.review, b.forward.window);
  assert.equal(r.status, 'COMPUTED_SYNTHETIC');
  assert.equal(r.events.find((e) => e.kind === 'BUY')!.priceFen, slipped(535, 'BUY', b.inputs.rules.costs, 1));
  assert.ok(Math.abs(r.metrics!.netReturnBps) < 1000);
});

test('全机会分母含等待/持仓/缺资料/技术失败；不足样本与无适配不互换', () => {
  for (const r of [b.validation.inSample, b.validation.outOfSample]) {
    const expected = b.inputs.data.calendar.sessions.filter((s) => s.date >= r.window.from && s.date <= r.window.to).length;
    assert.equal(r.opportunities.length, expected); assert.equal(new Set(r.opportunities.map((o) => o.opportunityId)).size, expected);
    assert.ok(r.opportunities.some((o) => o.decision === 'WAIT_NO_TRIGGER'));
    assert.ok(r.opportunities.some((o) => o.decision === 'ALREADY_POSITIONED'));
  }
  assert.equal(b.cases.missingData.opportunities.length, b.forward.opportunities.length); assert.equal(b.cases.missingData.metrics, null);
  assert.equal(b.cases.technicalFailure.status, 'TECHNICAL_FAILURE'); assert.ok(b.cases.technicalFailure.opportunities.every((o) => o.decision === 'TECHNICAL_FAILURE'));
  const { rulesHash: _, ...core } = b.inputs.rules;
  const insufficient = validateHistory(b.inputs.data, freezeRules({ ...core, minimumClosedTrades: 100 }));
  assert.equal(insufficient.status, 'INCOMPLETE'); assert.equal(insufficient.outOfSample.status, 'INSUFFICIENT_SAMPLE');
  const flat = structuredClone(b.inputs.data);
  for (const bar of flat.bars) if (bar.subject === flat.marketBenchmark) { bar.openFen = 5000; bar.closeFen = 5000; bar.highFen = 5004; bar.lowFen = 4996; }
  const noFit = replayRules(flat, b.inputs.rules, b.inputs.rules.inSample);
  assert.equal(noFit.status, 'INSUFFICIENT_SAMPLE'); assert.ok(noFit.opportunities.every((o) => o.decision === 'NO_FIT_ENVIRONMENT'));
});

test('缺日行情、缺基准、未来可得和最新修订口径均具名阻断，不伪装停牌', () => {
  assert.ok(b.cases.missingData.issues.some((i) => i.code === 'BAR_MISSING_OR_NOT_AVAILABLE'));
  const unaligned = structuredClone(b.inputs.data), day = b.inputs.rules.inSample.from;
  unaligned.bars = unaligned.bars.filter((x) => !(x.subject === unaligned.marketBenchmark && x.date === day));
  const gap = replayRules(unaligned, b.inputs.rules, b.inputs.rules.inSample);
  assert.equal(gap.status, 'DATA_INSUFFICIENT'); assert.equal(gap.metrics, null); assert.ok(gap.issues.some((i) => i.code === 'BENCHMARK_UNALIGNED_OR_NOT_AVAILABLE'));
  const revised = structuredClone(b.inputs.data); revised.revisionPolicy = 'LATEST_REVISED';
  assert.equal(replayRules(revised, b.inputs.rules, b.inputs.rules.inSample).status, 'DATA_INSUFFICIENT');
  const late = structuredClone(b.inputs.data), q = late.openings.find((x) => x.subject === late.subject && x.date === late.calendar.sessions[41]!.date)!;
  q.availableAt = `${q.date}T01:31:00.000Z`;
  const replay = replayFrozenPlan(late, b.plan, b.review, b.forward.window);
  assert.equal(replay.status, 'DATA_INSUFFICIENT'); assert.ok(replay.issues.some((i) => i.code === 'OPEN_MISSING_OR_NOT_AVAILABLE'));
});

test('未触发→到期、明确停牌顺延、限价不可成交、错过、失效各自保留', () => {
  assert.equal(b.waitPlan.snapshot.decision, 'WAIT_NO_TRIGGER');
  assert.equal(b.cases.notTriggeredAndExpired.condition, 'EXPIRED');
  assert.equal(b.cases.notTriggeredAndExpired.events.filter((e) => e.kind === 'BUY').length, 0);
  assert.ok(b.cases.notTriggeredAndExpired.events.some((e) => e.kind === 'PLAN_EXPIRED'));
  assert.equal(b.cases.explicitSuspension.status, 'COMPUTED_SYNTHETIC');
  assert.ok(b.cases.explicitSuspension.equity[0]!.staleMark);
  assert.equal(b.cases.explicitSuspension.events.find((e) => e.kind === 'BUY')!.date, b.inputs.data.calendar.sessions[42]!.date);
  assert.equal(b.cases.unfillableOpen.events.filter((e) => e.kind === 'BUY').length, 0);
  assert.equal(b.cases.unfillableOpen.events.filter((e) => e.reason === 'OPEN_AT_BUY_LIMIT').length, 3);
  assert.equal(b.cases.missedGap.condition, 'MISSED'); assert.equal(b.cases.priceInvalid.condition, 'INVALID');
});

test('程序清单机械重导出，J完整绑定计划、A、验证与证据；拒绝/未知/缺J均无成交', () => {
  assert.equal(b.review.gate.passed, true);
  assert.equal(b.review.checklist!.items.length, b.inputs.a.output.decisiveLinks.length + 1);
  assert.deepEqual(reviewFrozenPlan(b.plan, b.inputs.data, b.validation, b.inputs.a, b.inputs.j), b.review);
  for (const c of [b.cases.jRejected, b.cases.jUnresolved, b.cases.jAbsent]) {
    assert.equal(c.review.gate.passed, false); assert.equal(c.replay.status, 'REVIEW_BLOCKED'); assert.equal(c.replay.events.filter((e) => e.kind === 'BUY').length, 0);
  }
  const uncovered = structuredClone(b.inputs.j); uncovered.output.verdicts.pop();
  assert.equal(reviewFrozenPlan(b.plan, b.inputs.data, b.validation, b.inputs.a, rehash(uncovered)).gate.passed, false);
  const changed = structuredClone(b.inputs.j); changed.output.conclusionRuling.finalConclusion += '偷偷改写';
  assert.ok(reviewFrozenPlan(b.plan, b.inputs.data, b.validation, b.inputs.a, rehash(changed)).gate.blockers.some((x) => x.includes('REVIEW_CONTRACT_INVALID')));
  const retarget = structuredClone(b.inputs.j); retarget.output.verdicts[0]!.evidenceRef = 'risk-sizing';
  assert.ok(reviewFrozenPlan(b.plan, b.inputs.data, b.validation, b.inputs.a, rehash(retarget)).gate.blockers.some((x) => x.includes('J_EVIDENCE_RETARGETED')));
  const wrongPlan = structuredClone(b.inputs.j); wrongPlan.planHash = '0'.repeat(64);
  assert.ok(reviewFrozenPlan(b.plan, b.inputs.data, b.validation, b.inputs.a, rehash(wrongPlan)).gate.blockers.includes('J_ARTIFACT_BINDING_INVALID'));
});

test('冻结后全部事件共享同一planId/hash；逻辑反证与价格失效不混记', () => {
  assert.ok(b.forward.events.every((e) => e.planId === b.plan.planId && e.planHash === b.plan.planHash));
  const d = structuredClone(b.inputs.data), day = d.calendar.sessions[42]!;
  d.logic.push({ ...fixtureKnowledge('logic-failure', day.closeAt), subject: d.subject, effectiveOn: day.date, invalidates: true, reason: '冻结后的具名反证' });
  const r = replayFrozenPlan(d, b.plan, b.review, b.forward.window);
  assert.ok(r.events.some((e) => e.kind === 'EXIT_SCHEDULED' && e.reason === 'LOGIC_INVALID'));
  assert.equal(r.events.find((e) => e.kind === 'SELL')!.date, d.calendar.sessions[43]!.date);
  assert.ok(r.events.every((e) => e.planHash === b.plan.planHash));
});

test('DS-R1-01：等待入场的逻辑/收盘价格失效取消旧计划，固定计划不复活，新规则信号用新身份', (t) => {
  for (const reason of ['LOGIC_INVALID', 'PRICE_INVALID_CLOSE']) {
    const data = structuredClone(b.inputs.data), day = data.calendar.sessions[41]!, next = data.calendar.sessions[42]!;
    const q = data.openings.find((x) => x.subject === data.subject && x.date === day.date)!;
    data.states.find((x) => x.date === day.date)!.upperLimitFen = q.openFen;
    const bar = data.bars.find((x) => x.subject === data.subject && x.date === day.date)!;
    bar.highFen = q.openFen; bar.closeFen = reason === 'PRICE_INVALID_CLOSE' ? b.plan.terms!.priceInvalidBelowFen - 1 : q.openFen - 1; bar.lowFen = bar.closeFen - 1;
    if (reason === 'LOGIC_INVALID') {
      const invalid = { ...fixtureKnowledge('r2-pending-logic-invalid', day.closeAt), subject: data.subject, effectiveOn: day.date, invalidates: true, reason: '等待入场期间已可得的反证' };
      data.logic.push(invalid, { ...invalid, ...fixtureKnowledge('r2-new-logic-evidence', next.closeAt), supersedesFactId: invalid.factId, invalidates: false, reason: '之后新版本证据解除反证；不能使旧计划复活' });
    }
    assertData(data);
    const fixed = replayFrozenPlan(data, b.plan, b.review, b.forward.window);
    const cancellation = fixed.events.find((e) => e.kind === 'ENTRY_CANCELLED')!;
    assert.equal(cancellation.reason, reason); assert.equal(cancellation.at, `${day.date}T07:05:00.000Z`);
    assert.equal(cancellation.planId, b.plan.planId); assert.equal(fixed.condition, 'INVALID');
    assert.equal(fixed.events.filter((e) => e.kind === 'BUY').length, 0);
    assert.equal(fixed.events.filter((e) => e.kind === 'ENTRY_CANCELLED').length, 1);
    assert.ok(fixed.opportunities[0]!.reasonCodes.includes(reason)); assert.notEqual(fixed.opportunities[0]!.decision, 'PENDING_ENTRY');
    const rules = replayRules(data, b.inputs.rules, { from: b.plan.signalDate, to: b.forward.window.to });
    const cancelledRule = rules.events.find((e) => e.kind === 'ENTRY_CANCELLED')!;
    const laterBuys = rules.events.filter((e) => e.kind === 'BUY' && e.at > cancelledRule.at);
    assert.ok(laterBuys.length > 0); assert.ok(laterBuys.every((e) => e.planId !== cancelledRule.planId && e.planHash !== cancelledRule.planHash));
    t.diagnostic(JSON.stringify({ blocker: 'DS-R1-01', case: reason, condition: fixed.condition, cancellation, fixedBuysAfterInvalidation: 0, ruleCancelledPlan: cancelledRule.planId, ruleLaterBuyPlanIds: laterBuys.map((e) => e.planId) }));
  }
});

test('DS-R1-01：之后才可得的反证不能倒改此前开盘事实', (t) => {
  const data = structuredClone(b.inputs.data), first = data.calendar.sessions[41]!, later = data.calendar.sessions[42]!;
  const quote = data.openings.find((x) => x.subject === data.subject && x.date === first.date)!;
  data.states.find((x) => x.date === first.date)!.upperLimitFen = quote.openFen;
  const bar = data.bars.find((x) => x.subject === data.subject && x.date === first.date)!;
  bar.highFen = quote.openFen; bar.closeFen = quote.openFen - 1; bar.lowFen = quote.openFen - 4;
  data.logic.push({ ...fixtureKnowledge('r2-late-pending-logic', later.closeAt), subject: data.subject, effectiveOn: first.date, invalidates: true, reason: '下一日收盘才取得' });
  const r = replayFrozenPlan(data, b.plan, b.review, b.forward.window), buy = r.events.find((e) => e.kind === 'BUY')!;
  assert.equal(buy.at, later.openAt); assert.ok(buy.at < later.closeAt);
  assert.ok(!r.events.some((e) => e.kind === 'ENTRY_CANCELLED' && e.at < buy.at));
  assert.ok(r.events.some((e) => e.kind === 'EXIT_SCHEDULED' && e.reason === 'LOGIC_INVALID' && e.at > buy.at));
  t.diagnostic(JSON.stringify({ blocker: 'DS-R1-01', case: 'late-counterevidence', buyAt: buy.at, counterevidenceAvailableAt: later.closeAt, earlierOpenPreserved: true }));
});

test('DS-R1-02：缺失/迟到的基准首日开盘使验证不完整并阻断发布，不倒填且保留模拟事实', (t) => {
  for (const mode of ['missing', 'late']) {
    const data = structuredClone(b.inputs.data), start = data.calendar.sessions.find((s) => s.date === b.inputs.rules.inSample.from)!;
    const quote = data.openings.find((q) => q.subject === data.marketBenchmark && q.date === start.date)!;
    if (mode === 'missing') data.openings = data.openings.filter((q) => q.factId !== quote.factId);
    else quote.availableAt = new Date(Date.parse(start.openAt) + 60_000).toISOString();
    const validation = validateHistory(data, b.inputs.rules), window = validation.inSample;
    const expectedCode = mode === 'missing' ? 'BENCHMARK_OPEN_MISSING_AT_START' : 'BENCHMARK_OPEN_NOT_AVAILABLE_AT_START';
    assert.equal(window.status, 'DATA_INSUFFICIENT'); assert.equal(window.metrics, null); assert.equal(validation.status, 'INCOMPLETE');
    assert.ok(window.issues.some((i) => i.code === expectedCode && i.date === start.date));
    const trades = (r: typeof window) => r.events.filter((e) => e.kind === 'BUY' || e.kind === 'SELL').map((e) => ({ kind: e.kind, at: e.at, priceFen: e.priceFen, quantity: e.quantity, feesFen: e.feesFen, netPnlFen: e.netPnlFen }));
    assert.deepEqual(trades(window), trades(b.validation.inSample));
    assert.equal(window.opportunities.length, b.validation.inSample.opportunities.length);
    const plan = freezePlan(data, b.inputs.rules, b.plan.signalDate, b.inputs.company);
    const evidenceBundleHash = canonicalSha256(reviewEvidence(plan, data, validation));
    const a = rehash({ ...structuredClone(b.inputs.a), planHash: plan.planHash, validationHash: validation.validationHash, evidenceBundleHash });
    const j = rehash({ ...structuredClone(b.inputs.j), planHash: plan.planHash, validationHash: validation.validationHash, evidenceBundleHash, aHash: a.artifactHash });
    const review = reviewFrozenPlan(plan, data, validation, a, j);
    assert.equal(review.publication, 'VALIDATION_PENDING'); assert.equal(review.gate.passed, false);
    assert.deepEqual(review.gate.blockers, ['HISTORICAL_VALIDATION_INCOMPLETE']);
    const blocked = replayFrozenPlan(data, plan, review, b.forward.window);
    assert.equal(blocked.status, 'REVIEW_BLOCKED'); assert.equal(blocked.events.filter((e) => e.kind === 'BUY').length, 0);
    t.diagnostic(JSON.stringify({ blocker: 'DS-R1-02', case: mode, issue: window.issues.find((i) => i.code === expectedCode), windowStatus: window.status, validationStatus: validation.status, metrics: window.metrics, preservedTradeEvents: trades(window).length, publication: review.publication, gateBlockers: review.gate.blockers, gatedReplay: blocked.status }));
  }
});

test('实际封存材料保留250行与1215天缺段，拒绝给出虚假连续历史指标', () => {
  assert.equal(b.audit.stock.rows, 250); assert.equal(b.audit.stock.largestCalendarGap.calendarDays, 1215);
  assert.equal(b.audit.metrics, null); assert.equal(b.audit.status, 'REJECTED_FOR_CONTINUOUS_HISTORICAL_VALIDATION');
  assert.ok(b.audit.blockers.some((i) => i.code === 'TRADING_CALENDAR_NOT_DELIVERED'));
});

test('完整离线路径不访问数据库或网络、不运行模拟模型；消费已冻结文件原件', async () => {
  const query = Pool.prototype.query, fetch = globalThis.fetch;
  let queries = 0, network = 0;
  Pool.prototype.query = (() => { queries++; throw new Error('database forbidden in offline path'); }) as typeof query;
  globalThis.fetch = async () => { network++; throw new Error('network forbidden in offline path'); };
  try {
    const repeat = await computeOfflineBundle();
    assert.equal(repeat.plan.planHash, b.plan.planHash); assert.equal(queries, 0); assert.equal(network, 0);
    assert.deepEqual(repeat.review.modelExecution, { mode: 'FROZEN_FIXTURES_ONLY', newCalls: 0, newPermits: 0, realReviewDone: false });
  } finally { Pool.prototype.query = query; globalThis.fetch = fetch; }
});

test('离线HTML/JSON互链且转义动态值；原报告副本逐字节保留，重现不覆盖结果', async () => {
  const out = join(temp, 'artifacts'), first = await writeOfflineArtifacts(out), second = await writeOfflineArtifacts(out);
  assert.deepEqual(second, first);
  const files = new Set(await readdir(out));
  for (const name of ['index.html', 'validation.html', 'events.html', 'real-data-audit.html', 'company-report.html']) {
    const html = await readFile(join(out, name), 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(files.has(match[1]!), `${name} broken link ${match[1]}`);
    assert.match(html, /个人研究记录，非投资建议/);
    assert.ok(!html.includes('<script'));
  }
  assert.deepEqual(await readFile(join(out, 'original-report.html')), b.originalReport);
  const malicious = structuredClone(b.plan); malicious.subjectName = '<img src=x onerror=alert(1)>';
  assert.ok(!renderStrategy(malicious, b.review, b.validation, b.forward).includes('<img src=x'));
  assert.match(renderStrategy(malicious, b.review, b.validation, b.forward), /&lt;img/);
  assert.equal(first.artifacts.length, 19);
});
