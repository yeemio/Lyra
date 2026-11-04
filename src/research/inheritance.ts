/** 继承材料是可核查的旧模型判断；新公告必须作为本轮实际送达事实出现。 */
import { canonicalSha256 } from '../canonical.js';
import type { Pool } from 'pg';
import type { ArtifactStore } from '../artifacts/store.js';
import { readConclusion } from '../db/conclusion.js';
import { KernelError, type ConclusionObject, type TimePointFact } from '../contracts.js';
import { buildCoverageReceiptMaterial, materialBytes, type InputBudget, type RecordsMaterial, type ResearchInputPackage } from './inputs.js';
import { deliveredEvidence, validateResearchJ, type ResearchTrace } from './validation.js';

export interface PostEventTriggerEvent {
  eventId: string;
  subject: string;
  type: string;
  subtype: string | null;
  eventTime: string;
  evidenceFactId: string;
  attrs?: Record<string, unknown>;
}

export interface PriorResearch {
  conclusion: ConclusionObject;
  aOutput: ResearchTrace['aOutput'];
  checklist: ResearchTrace['checklist'];
  jOutput: ResearchTrace['jOutput'];
}
export type PostEventContext = {
  kind: 'POST_EVENT_CONTEXT_V2';
  event: PostEventTriggerEvent;
  eventFact: TimePointFact;
  admittedAt: string;
} & ({ basis: 'INHERITED'; prior: PriorResearch; reason: string } |
     { basis: 'STANDALONE'; prior: null; reason: string });

const CONTEXT_ID = 'mat:0:post-event-context';
function fail(detail: string): never { throw new KernelError('POST_EVENT_CONTEXT_INVALID', detail); }

/** 非可序列化核验收据；仅数据库+CAS 读回可以签发，调用者不能自报先验已验证。 */
export interface VerifiedPrior { readonly kind: 'VERIFIED_PRIOR' }
const verifiedPriors = new WeakMap<VerifiedPrior, string>();
function priorReceiptHash(prior: PriorResearch, event: PostEventTriggerEvent, admittedAt: string): string {
  return canonicalSha256({ prior, event: { ...event, eventTime: new Date(event.eventTime).toISOString() }, admittedAt: new Date(admittedAt).toISOString() });
}
export function assertVerifiedPrior(context: PostEventContext & { basis: 'INHERITED' }, receipt?: VerifiedPrior): void {
  if (receipt === undefined || verifiedPriors.get(receipt) !== priorReceiptHash(context.prior, context.event, context.admittedAt)) fail('继承缺少数据库/CAS 原文核验收据，或先验/事件/准入时点已被修改');
}

export function priorEligibilityReason(event: PostEventTriggerEvent, prior: ConclusionObject, methodVersion: string, admittedAt: string): string | null {
  if (prior.businessKey.subjectKind !== 'STOCK' || prior.businessKey.subject !== event.subject || prior.businessKey.researchKind !== 'WEEKLY') return '先验不是同股周度结论';
  if (prior.methodVersion !== methodVersion) return '先验方法版本不兼容';
  const eventAt = Date.parse(event.eventTime), priorAt = Date.parse(prior.businessKey.cutoff), completed = Date.parse(prior.createdAt), admitted = Date.parse(admittedAt);
  if (![eventAt, priorAt, completed, admitted].every(Number.isFinite) || priorAt >= eventAt || admitted < eventAt || completed > admitted) return '先验截点或完成时间不符合准入时点';
  // 上海自然周：周一 00:00 至准入时点。无日历/窗口口径变更。
  const wall = new Date(admitted + 8 * 3600_000);
  const weekStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - (wall.getUTCDay() + 6) % 7) - 8 * 3600_000;
  if (completed < weekStart) return '先验不是本周已完成结论';
  return null;
}

export function validatePriorResearch(prior: PriorResearch): void {
  const { conclusion: c } = prior;
  const t = prior;
  const { conclusionId: _id, conclusionHash, createdAt: _created, settlement: _settlement, ...core } = c;
  if (canonicalSha256(core) !== conclusionHash || c.conclusionId !== `cc-${conclusionHash.slice(0, 24)}`) fail('先验结论哈希不符');
  if (!c.evidence.researchTraceSha256 || canonicalSha256(t.aOutput) !== c.evidence.aOutputHash || canonicalSha256(t.jOutput) !== c.evidence.jOutputHash ||
      t.checklist.checklistHash !== c.evidence.checklistHash || t.checklist.manifestHash !== c.evidence.manifestHash ||
      t.jOutput.finalDisposition !== c.disposition || t.aOutput.subjectKind !== c.businessKey.subjectKind ||
      c.businessKey.researchKind !== 'WEEKLY' || c.inheritance !== null) fail('先验原 A/J 或身份未绑定');
  const { checklistHash, ...checklistCore } = t.checklist;
  if (canonicalSha256(checklistCore) !== checklistHash) fail('先验清单哈希不符');
}

/** 正常入口从结论行和哈希校验 CAS 读原文，不能由调用者自报“已落库”。 */
export async function loadPriorResearch(
  pool: Pool, store: ArtifactStore, supplied: ConclusionObject | null,
  event: PostEventTriggerEvent, methodVersion: string, admittedAt: string,
): Promise<{ prior: PriorResearch | null; reason: string; verification?: VerifiedPrior }> {
  if (supplied === null) return { prior: null, reason: '无基础结论可继承' };
  const stored = await readConclusion(pool, supplied.conclusionId);
  if (stored === null || stored.conclusionHash !== supplied.conclusionHash) fail('先验未落库或身份不符');
  const reason = priorEligibilityReason(event, stored, methodVersion, admittedAt);
  if (reason !== null) return { prior: null, reason };
  const hash = stored.evidence.researchTraceSha256;
  if (!hash) return { prior: null, reason: '旧结论缺可核验的原输入/A/J 原文；不能声明继承' };
  let raw: Uint8Array;
  try { raw = await store.readBytes(hash); }
  catch (error) {
    if ((error as { code?: string }).code === 'ARTIFACT_MISSING') return { prior: null, reason: '先验原文原件缺失；不能声明继承' };
    throw error;
  }
  let trace: ResearchTrace;
  try { trace = JSON.parse(new TextDecoder().decode(raw)) as ResearchTrace; }
  catch { fail('先验原文不是 JSON'); }
  if (!trace || !trace.input || !trace.aOutput || !trace.checklist || !trace.jOutput || trace.kind !== 'TRADITIONAL_RESEARCH_TRACE_V2' || canonicalSha256(trace) !== hash ||
      trace.input.versions.methodVersion !== stored.methodVersion || trace.input.versions.adapterVersion !== stored.adapterVersion ||
      trace.input.versions.planAuthVersion !== stored.planAuthVersion || canonicalSha256(trace.input.businessKey) !== canonicalSha256(stored.businessKey)) fail('先验原文与结论身份不符');
  validateResearchJ(trace.jOutput, trace.input, trace.aOutput, trace.checklist, trace.aOutput.simulated, trace.checklistCoverage);
  const prior = { conclusion: stored, aOutput: trace.aOutput, checklist: trace.checklist, jOutput: trace.jOutput };
  validatePriorResearch(prior);
  const verification: VerifiedPrior = Object.freeze({ kind: 'VERIFIED_PRIOR' });
  verifiedPriors.set(verification, priorReceiptHash(prior, event, admittedAt));
  return { prior, verification, reason: '已读回原结论、原 A/J 判断及条件；只重新评估新增事件，先验不是当前事实' };
}

export function validatePostEventContext(pkg: ResearchInputPackage): PostEventContext | null {
  const matches = pkg.materials.filter((m) => m.materialId === CONTEXT_ID);
  if (pkg.businessKey.researchKind !== 'POST_EVENT') {
    if (matches.length > 0) fail('非事件研究不得携带继承声明');
    return null;
  }
  const m = matches[0];
  if (matches.length !== 1 || m?.kind !== 'RECORDS' || m.records.length !== 1 || !pkg.layers.l0.blocks.some((b) => b.materialId === CONTEXT_ID)) fail('事件材料未实际送达 L0');
  const context = m.records[0] as unknown as PostEventContext;
  if (context?.kind !== 'POST_EVENT_CONTEXT_V2' || !context.event || !context.eventFact) fail('事件材料形状缺失');
  const { event, eventFact: fact } = context;
  if (event.subject !== pkg.businessKey.subject || pkg.businessKey.subjectKind !== 'STOCK' ||
      Date.parse(event.eventTime) !== Date.parse(pkg.cutoff) || pkg.cutoff !== pkg.businessKey.cutoff || event.evidenceFactId !== fact.factId ||
      fact.subjectId !== event.subject || fact.subjectType !== 'STOCK' || !m.factIds.includes(fact.factId) ||
      !Number.isFinite(Date.parse(fact.availableAt)) || Date.parse(fact.availableAt) > Date.parse(pkg.cutoff) ||
      (fact.sourcePublishedAt !== null && (!Number.isFinite(Date.parse(fact.sourcePublishedAt)) || Date.parse(fact.sourcePublishedAt) > Date.parse(pkg.cutoff))) ||
      !deliveredEvidence(pkg).has(fact.artifactSha256)) fail('新事件事实未绑定同股/截点/封存/实际送达');
  if (!context.reason?.trim() || !Number.isFinite(Date.parse(context.admittedAt)) || Date.parse(context.admittedAt) < Date.parse(event.eventTime)) fail('继承/完整重研的依据或准入时点无效');
  if (context.basis === 'INHERITED') {
    if (!context.prior) fail('继承缺少原结论与原 A/J 判断条件');
    validatePriorResearch(context.prior);
    const reason = priorEligibilityReason(event, context.prior.conclusion, pkg.versions.methodVersion, context.admittedAt);
    if (reason !== null) fail(reason);
  } else if (context.basis !== 'STANDALONE' || context.prior !== null) fail('完整重研不得伪装继承');
  return context;
}

/** 为不可裁剪 L0 加入事件/先验原文，重新计量 L0/L2 与整个包身份；超预算拒绝。 */
export function withPostEventContext(base: ResearchInputPackage, context: PostEventContext, budget: InputBudget): ResearchInputPackage {
  deliveredEvidence(base);
  const pkg = structuredClone(base);
  if (pkg.materials.some((m) => m.materialId === CONTEXT_ID)) fail('事件上下文不能二次覆盖');
  const fact = context.eventFact;
  if (!pkg.seals.some((s) => s.factIds.includes(fact.factId) && s.artifactRefs.some((a) => a.sha256 === fact.artifactSha256))) fail('事件锚定事实不在本轮封存');
  const material: RecordsMaterial = { materialId: CONTEXT_ID, dimension: 0,
    title: '事件研究：原判断与原条件（INHERITED，仅为旧模型判断）/新增事件事实；STANDALONE 为完整重研',
    kind: 'RECORDS', factIds: [fact.factId], records: [structuredClone(context) as unknown as Record<string, unknown>] };
  material.evidenceRefs = [{ factId: fact.factId, artifactSha256: fact.artifactSha256 }];
  pkg.materials.push(material);
  const bytes = materialBytes(material);
  pkg.layers.l0.blocks.push({ materialId: CONTEXT_ID, bytes });
  pkg.layers.l0.bytes += bytes;
  const index = pkg.materials.find((m) => m.kind === 'INDEX');
  if (index?.kind !== 'INDEX') fail('缺送达索引');
  index.content.deliveredFacts.push({ factId: fact.factId, artifactSha256: fact.artifactSha256, materialId: CONTEXT_ID, layer: 'L0' });
  const indexBlock = pkg.layers.l2.blocks.find((b) => b.materialId === index.materialId);
  if (!indexBlock) fail('索引未送达');
  pkg.layers.l2.bytes -= indexBlock.bytes;
  indexBlock.bytes = materialBytes(index);
  pkg.layers.l2.bytes += indexBlock.bytes;
  // 原组装器回执中的固定材料/L2 数字也要随追加更新，不能只改外层 layers。
  const receiptIndex = pkg.materials.findIndex((m) => m.materialId === 'mat:0:coverage-receipt');
  if (receiptIndex !== -1) {
    const block = pkg.layers.l0.blocks.find((b) => b.materialId === 'mat:0:coverage-receipt');
    if (!block) fail('coverage 回执未送达');
    const receipt = buildCoverageReceiptMaterial(pkg.dimensions, {
      l0FixedBytes: pkg.layers.l0.bytes - block.bytes, l0Budget: pkg.layers.l0.budget,
      l1Bytes: pkg.layers.l1.bytes, l1Budget: pkg.layers.l1.budget, l1Blocks: pkg.layers.l1.blocks.length,
      l2Bytes: pkg.layers.l2.bytes, l2Budget: pkg.layers.l2.budget,
    });
    pkg.materials[receiptIndex] = receipt;
    pkg.layers.l0.bytes -= block.bytes;
    block.bytes = materialBytes(receipt);
    pkg.layers.l0.bytes += block.bytes;
  }
  for (const [key, max] of [['l0', budget.l0Bytes], ['l1', budget.l1Bytes], ['l2', budget.l2Bytes]] as const) {
    if (pkg.layers[key].bytes > Math.min(max, pkg.layers[key].budget)) throw new KernelError('INPUT_OVER_BUDGET', `${key} 事件材料超预算`);
  }
  if (pkg.layers.l0.bytes + pkg.layers.l1.bytes + pkg.layers.l2.bytes > budget.totalBytes) throw new KernelError('INPUT_OVER_BUDGET', '事件材料总字节超预算');
  const { inputHash: _old, ...core } = pkg;
  pkg.inputHash = canonicalSha256(core);
  validatePostEventContext(pkg);
  return pkg;
}
