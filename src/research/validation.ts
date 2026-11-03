/** 传统研究的共同领域门：真实/合成 transport 与结论构造均须经过。 */
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { KernelError, type AOutput, type JOutput, type ModelCallContract, type ProgramChecklist } from '../contracts.js';
import { validateAOutputShape, validateJOutputShape } from '../kernel/sol-transport.js';
import { deriveChecklist, type DimensionCoveragePkg } from './checklist.js';
import { renderInputLayers, type ResearchInputPackage } from './inputs.js';

function reject(code: string, detail: string): never { throw new KernelError(code, detail); }

/** 只接受 L0/L1 实际送达、且能回到本轮封存的引用；L2 的封存目录不授予引用资格。 */
export function deliveredEvidence(pkg: ResearchInputPackage): Set<string> {
  if (pkg === undefined || pkg === null) reject('RESEARCH_INPUT_REQUIRED', '结论须绑定实际送达包');
  const { inputHash, ...core } = pkg;
  if (canonicalSha256(core) !== inputHash) reject('RESEARCH_INPUT_HASH_MISMATCH', '送达包内容与哈希不符');
  const materialIds = pkg.materials.map((m) => m.materialId);
  const deliveredIds = [pkg.layers.l0, pkg.layers.l1, pkg.layers.l2].flatMap((l) => l.blocks.map((b) => b.materialId));
  if (new Set(materialIds).size !== materialIds.length || new Set(deliveredIds).size !== deliveredIds.length) {
    reject('RESEARCH_INPUT_UNBOUND', '材料或送达块身份重复，不能确定实际载荷');
  }
  renderInputLayers(pkg); // 材料存在与逐块字节复核
  for (const layer of [pkg.layers.l0, pkg.layers.l1, pkg.layers.l2]) {
    if (layer.blocks.reduce((n, b) => n + b.bytes, 0) !== layer.bytes || layer.bytes > layer.budget) {
      reject('RESEARCH_INPUT_UNBOUND', `${layer.name} 字节回执或预算不符`);
    }
  }
  if (pkg.seals.length === 0) reject('SEAL_MISSING', '送达包无封存');
  for (const seal of pkg.seals) {
    const { manifestHash, reused: _reused, ...sealed } = seal;
    if (canonicalSha256(sealed) !== manifestHash) reject('MANIFEST_HASH_MISMATCH', seal.sealId);
    if (canonicalJsonString(seal.businessKey) !== canonicalJsonString(pkg.businessKey) ||
        seal.cutoff !== pkg.cutoff || seal.methodVersion !== pkg.versions.methodVersion ||
        seal.adapterVersion !== pkg.versions.adapterVersion || seal.planAuthVersion !== pkg.versions.planAuthVersion) {
      reject('RESEARCH_INPUT_UNBOUND', '封存与送达包身份不符');
    }
  }
  const indexes = pkg.materials.filter((m) => m.kind === 'INDEX');
  const index = indexes[0];
  if (indexes.length !== 1 || index?.kind !== 'INDEX' || !pkg.layers.l2.blocks.some((b) => b.materialId === index.materialId)) {
    reject('RESEARCH_INPUT_UNBOUND', '送达索引缺失');
  }
  const hashes = new Set<string>();
  for (const ref of index.content.deliveredFacts) {
    const layer = ref.layer === 'L0' ? pkg.layers.l0 : ref.layer === 'L1' ? pkg.layers.l1 : null;
    const material = pkg.materials.find((m) => m.materialId === ref.materialId);
    if (layer === null || !layer.blocks.some((b) => b.materialId === ref.materialId) ||
        !material?.factIds.includes(ref.factId) ||
        !material.evidenceRefs?.some((r) => r.factId === ref.factId && r.artifactSha256 === ref.artifactSha256) ||
        !pkg.seals.some((s) => s.factIds.includes(ref.factId) && s.artifactRefs.some((a) => a.sha256 === ref.artifactSha256))) {
      reject('RESEARCH_EVIDENCE_UNBOUND', `${ref.factId} 未同时命中实际送达材料与封存`);
    }
    hashes.add(ref.artifactSha256);
  }
  return hashes;
}

export function researchJInputHash(pkg: ResearchInputPackage, a: AOutput, checklist: ProgramChecklist): string {
  return canonicalSha256({ protocol: 'traditional-j@2', researchInputHash: pkg.inputHash, a, checklist });
}

function callOf(pkg: ResearchInputPackage, stage: 'A' | 'J', inputHash: string): ModelCallContract {
  return { businessKey: pkg.businessKey, stage, inputHash, inputBytes: 0,
    methodVersion: pkg.versions.methodVersion, planAuthVersion: pkg.versions.planAuthVersion, deadline: pkg.cutoff };
}

export function validateResearchA(value: unknown, pkg: ResearchInputPackage, simulated: boolean): AOutput {
  const delivered = deliveredEvidence(pkg);
  const a = validateAOutputShape(value, callOf(pkg, 'A', pkg.inputHash), simulated);
  for (const link of a.decisiveLinks) {
    if (!delivered.has(link.evidenceArtifactSha256)) reject('A_EVIDENCE_NOT_DELIVERED', link.evidenceArtifactSha256);
  }
  return a;
}

export function validateResearchJ(
  value: unknown, pkg: ResearchInputPackage, a: AOutput, checklist: ProgramChecklist,
  simulated: boolean, coverage?: DimensionCoveragePkg,
): JOutput {
  validateResearchA(a, pkg, simulated);
  const expected = deriveChecklist(a, pkg.seals[0]!.manifestHash, coverage);
  if (canonicalJsonString(checklist) !== canonicalJsonString(expected)) reject('CHECKLIST_UNBOUND', '清单内容无法由 A 与封存重导出');
  const j = validateJOutputShape(value, callOf(pkg, 'J', researchJInputHash(pkg, a, checklist)), checklist.items.map((x) => x.checklistId), simulated);
  const changed = j.finalDisposition !== a.candidate;
  if (j.changedFromA !== changed) reject('J_CHANGE_FLAG_MISMATCH', 'changedFromA 与实际 A/J 方向差异不符');
  if (changed && !j.changeReason?.trim()) reject('J_CHANGE_REASON_REQUIRED', '实际改判须有 J 自身理由');
  const eventMaterial = pkg.materials.find((m) => m.materialId === 'mat:0:post-event-context');
  if (eventMaterial?.kind === 'RECORDS' && eventMaterial.records[0]?.basis === 'INHERITED' && !j.changeReason?.trim()) {
    reject('J_INHERITANCE_REASON_REQUIRED', '继承研究须由 J 写出原判断与新增事件的比较，维持也写');
  }
  const bearing = j.verdicts.filter((v) => v.decisionBearing);
  if (bearing.length === 0) reject('J_NO_DECISION_BASIS', '不能把全部条目标为非承重');
  const delivered = deliveredEvidence(pkg);
  const byId = new Map(j.verdicts.map((v) => [v.checklistId, v]));
  for (const v of j.verdicts) {
    if (!v.reason.trim()) reject('J_REASON_REQUIRED', v.checklistId);
    for (const hash of v.evidenceArtifactSha256s) {
      if (!delivered.has(hash)) reject('J_EVIDENCE_NOT_DELIVERED', `${v.checklistId}: ${hash}`);
    }
    if (v.verdict !== 'UNRESOLVED' && v.evidenceArtifactSha256s.length === 0) {
      reject('J_EVIDENCE_REQUIRED', v.checklistId);
    }
    if ((v.verdict === 'NARROWED' || v.verdict === 'REJECTED') && !v.correction?.trim()) {
      reject('J_CORRECTION_REQUIRED', v.checklistId);
    }
    const remaining = v.remainingBasisChecklistIds;
    if (new Set(remaining).size !== remaining.length || (v.decisionBearing && remaining.length !== 0) ||
        (!v.decisionBearing && remaining.length === 0)) reject('J_REMAINING_BASIS_INVALID', v.checklistId);
    for (const id of remaining) {
      const basis = byId.get(id);
      if (id === v.checklistId || !basis?.decisionBearing || (basis.verdict !== 'SUPPORTED' && basis.verdict !== 'NARROWED')) {
        reject('J_REMAINING_BASIS_INVALID', `${v.checklistId} → ${id}`);
      }
    }
    if (v.verdict === 'UNRESOLVED' && !j.limitations.some((s) => s.includes(v.checklistId))) {
      reject('J_UNRESOLVED_LIMITATION_REQUIRED', v.checklistId);
    }
  }
  if (j.finalDisposition !== 'ABSTAIN') {
    if (bearing.some((v) => v.verdict === 'UNRESOLVED') || j.strongestCaseDisposition === 'UNRESOLVED') {
      reject('J_UNRESOLVED_DIRECTION', '承重未知或最强论证未解时须 ABSTAIN');
    }
    const supportedLink = checklist.items.some((item) => item.category === 'DECISIVE_LINK' &&
      bearing.some((v) => v.checklistId === item.checklistId && (v.verdict === 'SUPPORTED' || v.verdict === 'NARROWED')));
    if (!supportedLink) reject('J_NO_DECISION_BASIS', '方向结论至少需要一条经支持或收窄的承重决定性连接');
  }
  return j;
}

/** 新结论的可核查材料；哈希是 canonical JSON 字节的 CAS 身份。 */
export interface ResearchTrace {
  kind: 'TRADITIONAL_RESEARCH_TRACE_V2';
  input: ResearchInputPackage;
  aOutput: AOutput;
  checklist: ProgramChecklist;
  jOutput: JOutput;
  checklistCoverage?: DimensionCoveragePkg;
}

export function researchTraceOf(input: Omit<ResearchTrace, 'kind'>): ResearchTrace {
  return { kind: 'TRADITIONAL_RESEARCH_TRACE_V2', ...input };
}
