import { canonicalSha256 } from '../../canonical.js';
import { deriveSrChecklist } from '../engine.js';
import { validateAFinalOutput, validateJOutput, type JEvidenceBundleTable } from '../transport.js';
import type { FrozenA, FrozenJ, FrozenPlan, FrozenReviewArtifact, PlanReview, StrategyData, ValidationReport } from './contracts.js';
import { snapshotInput } from './data.js';
import { assertPlan, immutable } from './plan.js';

export const REQUIRED_STRATEGY_TABLES = ['strategy-rules', 'signal-snapshot', 'plan-terms', 'risk-sizing', 'historical-validation', 'counterevidence'] as const;

/** J 收到完整冻结对象及原始时点输入；表哈希绑定，而非只递送 A 选中的摘要。 */
export function reviewEvidence(plan: FrozenPlan, data: StrategyData, validation: ValidationReport): JEvidenceBundleTable[] {
  const table = (tableId: string, title: string, value: unknown): JEvidenceBundleTable => ({ tableId, title, columns: ['contentHash', 'frozenContentJson'], rows: [[canonicalSha256(value), JSON.stringify(value)]], note: '完整对象，未按A引用删项；金额为分，时间为UTC，合成与实际身份保留' });
  return [
    table('strategy-rules', '冻结规则、成本与样本窗', plan.rules),
    table('signal-snapshot', '截点内原始输入与派生特征', { raw: snapshotInput(data, plan.cutoff), snapshot: plan.snapshot }),
    table('plan-terms', '冻结条件、价格、失效、期限与等待对照', plan),
    table('risk-sizing', '显式账户与风险预算及数量计算', { account: data.account && data.account.availableAt <= plan.cutoff ? data.account : null, sizing: plan.indicativeRisk }),
    table('historical-validation', '完整样本内/外机会、事件与计算', validation),
    table('counterevidence', '反证、缺口与适用边界', { issues: plan.snapshot.issues, limitations: plan.limitations, validationStatus: validation.status, efficacyAccepted: false }),
  ];
}

function artifactValid<T>(artifact: FrozenReviewArtifact<T>, role: 'A' | 'J', plan: FrozenPlan, validation: ValidationReport, evidenceHash: string): boolean {
  const { artifactHash, ...core } = artifact;
  return artifact.identity === 'STATIC_SIMULATED_FIXTURE' && artifact.role === role && Boolean(artifact.fixtureId && artifact.authoredBy)
    && artifact.planHash === plan.planHash && artifact.validationHash === validation.validationHash && artifact.evidenceBundleHash === evidenceHash && canonicalSha256(core) === artifactHash;
}

export function reviewFrozenPlan(plan: FrozenPlan, data: StrategyData, validation: ValidationReport, a: FrozenA | null, j: FrozenJ | null): PlanReview {
  assertPlan(plan);
  const evidenceBundle = reviewEvidence(plan, data, validation), evidenceBundleHash = canonicalSha256(evidenceBundle);
  const blockers: string[] = [];
  const { validationHash, ...validationCore } = validation;
  if (canonicalSha256(validationCore) !== validationHash || validation.rulesHash !== plan.rulesHash || validation.inSample.rulesHash !== plan.rulesHash || validation.outOfSample.rulesHash !== plan.rulesHash) blockers.push('VALIDATION_IDENTITY_MISMATCH');
  if (canonicalSha256(snapshotInput(data, plan.cutoff)) !== plan.snapshot.inputHash) blockers.push('PLAN_INPUT_CHANGED');
  if (plan.snapshot.decision === 'DATA_PENDING' || plan.snapshot.decision === 'TECHNICAL_FAILURE' || plan.terms === null || plan.expiresOn === null) blockers.push('PLAN_DATA_INCOMPLETE');
  if (validation.status === 'INCOMPLETE') blockers.push('HISTORICAL_VALIDATION_INCOMPLETE');
  if (plan.rules.outOfSample.to >= plan.signalDate) blockers.push('VALIDATION_NOT_BEFORE_PLAN');
  let checklist: PlanReview['checklist'] = null, judge: PlanReview['judge'] = null, aOutput: PlanReview['a'] = null;
  if (a === null) blockers.push('A_MISSING');
  else if (!artifactValid(a, 'A', plan, validation, evidenceBundleHash) || a.aHash !== null || a.checklistHash !== null) blockers.push('A_ARTIFACT_BINDING_INVALID');
  else {
    try {
      aOutput = validateAFinalOutput(a.output);
      if (REQUIRED_STRATEGY_TABLES.some((id) => !aOutput!.decisiveLinks.some((l) => l.tableId === id)) || aOutput.decisiveLinks.some((l) => !evidenceBundle.some((t) => t.tableId === l.tableId))) blockers.push('A_STRATEGY_BEARING_COVERAGE_INCOMPLETE');
      checklist = deriveSrChecklist([], aOutput);
      if (j === null) blockers.push('MANDATORY_J_MISSING');
      else if (!artifactValid(j, 'J', plan, validation, evidenceBundleHash) || j.aHash !== a.artifactHash || j.checklistHash !== checklist.checklistHash) blockers.push('J_ARTIFACT_BINDING_INVALID');
      else {
        judge = validateJOutput(j.output, checklist.items.map((i) => i.checklistId), { deliveredTableIds: evidenceBundle.map((t) => t.tableId), aConclusion: aOutput.conclusion });
        for (const v of judge.verdicts) {
          const item = checklist.items.find((i) => i.checklistId === v.checklistId)!;
          if (v.decisionBearing && item.tableId !== null && v.evidenceRef !== item.tableId) blockers.push(`J_EVIDENCE_RETARGETED:${v.checklistId}`);
          if ((v.verdict === 'REJECTED' || v.verdict === 'NARROWED') && !v.correction?.trim()) blockers.push(`J_CORRECTION_MISSING:${v.checklistId}`);
          if (v.decisionBearing && (v.verdict === 'REJECTED' || v.verdict === 'UNRESOLVED')) blockers.push(`J_BEARING_${v.verdict}:${v.checklistId}`);
          if (v.decisionBearing && v.verdict === 'NARROWED') blockers.push(`REVISED_PLAN_REQUIRED:${v.checklistId}`);
        }
        if (judge.conclusionRuling.changedFromA) blockers.push('J_CHANGED_CONCLUSION_REQUIRES_NEW_PLAN');
      }
    } catch (e) { blockers.push(`REVIEW_CONTRACT_INVALID:${e instanceof Error ? e.message : String(e)}`); }
  }
  const publication: PlanReview['publication'] = blockers.includes('PLAN_DATA_INCOMPLETE') ? 'DATA_PENDING'
    : blockers.includes('HISTORICAL_VALIDATION_INCOMPLETE') ? 'VALIDATION_PENDING'
      : blockers.length === 0 ? 'OFFLINE_DEMO_REVIEWED' : a === null || j === null ? 'DRAFT' : 'J_BLOCKED';
  const core = { planHash: plan.planHash, validationHash, aHash: a?.artifactHash ?? null, jHash: j?.artifactHash ?? null,
    evidenceBundle, evidenceBundleHash, checklist, a: aOutput, judge, gate: { passed: blockers.length === 0, blockers }, publication,
    effectiveConclusion: judge?.conclusionRuling.finalConclusion ?? null,
    modelExecution: { mode: 'FROZEN_FIXTURES_ONLY' as const, newCalls: 0 as const, newPermits: 0 as const, realReviewDone: false as const } };
  return immutable({ ...core, reviewHash: canonicalSha256(core) });
}

export function offlineReviewIsBound(plan: FrozenPlan, review: PlanReview): boolean {
  try {
    const { reviewHash, ...core } = review;
    if (canonicalSha256(core) !== reviewHash || review.planHash !== plan.planHash || !review.gate.passed || review.gate.blockers.length > 0 || review.publication !== 'OFFLINE_DEMO_REVIEWED'
      || !review.a || !review.judge || !review.checklist || !review.aHash || !review.jHash || review.modelExecution.mode !== 'FROZEN_FIXTURES_ONLY'
      || review.modelExecution.newCalls !== 0 || review.modelExecution.newPermits !== 0 || review.modelExecution.realReviewDone !== false) return false;
    const cl = deriveSrChecklist([], validateAFinalOutput(review.a));
    if (canonicalSha256(cl) !== canonicalSha256(review.checklist) || canonicalSha256(review.evidenceBundle) !== review.evidenceBundleHash) return false;
    const j = validateJOutput(review.judge, cl.items.map((i) => i.checklistId), { deliveredTableIds: review.evidenceBundle.map((t) => t.tableId), aConclusion: review.a.conclusion });
    return !j.conclusionRuling.changedFromA && j.verdicts.every((v) => !v.decisionBearing || v.verdict === 'SUPPORTED');
  } catch { return false; }
}
