/** 公开合成夹具，绝非业务资料或历史接受证据。仅测试使用。 */
import { freezeBenchmark, type FrozenBenchmark } from '../conclusion/benchmark.js';
import { canonicalSha256 } from '../canonical.js';
import type { ResearchBusinessKey, SealManifest } from '../contracts.js';
import type { ConclusionInput } from '../conclusion/object.js';
import { materialBytes, type AssembleVersions, type IndexMaterial, type Material, type ResearchInputPackage } from './inputs.js';
import { deriveChecklist } from './checklist.js';
import { simulatedModelA, simulatedModelJ } from './simulated.js';
import { researchMaterial } from './requests.js';
import { researchJInputHash } from './validation.js';

export function inputFromTestSeal(seal: SealManifest, benchmark: FrozenBenchmark = freezeBenchmark({ ...seal.businessKey, facts: [] })): ResearchInputPackage {
  const records = seal.factIds.map((factId, i) => ({ factId,
    artifactSha256: seal.artifactRefs[i % seal.artifactRefs.length]!.sha256,
    fixture: 'TEST_ONLY synthetic delivered content', value: String(i + 1) }));
  const material: Material = { materialId: 'test:records', kind: 'RECORDS', dimension: 1,
    title: 'TEST_ONLY 合成材料', factIds: [...seal.factIds], records,
    evidenceRefs: records.map(({ factId, artifactSha256 }) => ({ factId, artifactSha256 })) };
  const index: IndexMaterial = { materialId: 'test:index', kind: 'INDEX', dimension: 0,
    title: 'TEST_ONLY 引用目录', factIds: [], content: { deliveredFacts: records.map((r) => ({ factId: r.factId,
      artifactSha256: r.artifactSha256, materialId: material.materialId, layer: 'L1' })),
      demotedMaterials: [], seals: [], note: 'TEST_ONLY' } };
  const binding: Material = { materialId: 'mat:0:frozen-benchmark', kind: 'RECORDS', dimension: 0,
    title: 'TEST_ONLY 冻结基准', factIds: benchmark.attributionFact === null ? [] : [benchmark.attributionFact.factId],
    evidenceRefs: benchmark.attributionFact === null ? [] : [{ factId: benchmark.attributionFact.factId, artifactSha256: benchmark.attributionFact.artifactSha256 }],
    records: [benchmark as unknown as Record<string, unknown>] };
  const core = { benchmark, packageKind: 'RESEARCH_INPUT' as const, packageVersion: 2, assemblerRulesVersion: 'synthetic@test',
    businessKey: seal.businessKey, cutoff: seal.cutoff,
    pool: { file: 'TEST_ONLY', frozenAt: seal.cutoff, subject: { code: seal.businessKey.subject, name: '合成标的', kind: seal.businessKey.subjectKind } },
    versions: { methodVersion: seal.methodVersion, adapterVersion: seal.adapterVersion, planAuthVersion: seal.planAuthVersion },
    seals: [seal], materials: [material, binding, index], dimensions: [], rules: [],
    layers: { l0: { name: 'L0' as const, budget: 1_000_000, bytes: materialBytes(binding), blocks: [{ materialId: binding.materialId, bytes: materialBytes(binding) }] },
      l1: { name: 'L1' as const, budget: 1_000_000, bytes: materialBytes(material), blocks: [{ materialId: material.materialId, bytes: materialBytes(material) }] },
      l2: { name: 'L2' as const, budget: 1_000_000, bytes: materialBytes(index), blocks: [{ materialId: index.materialId, bytes: materialBytes(index) }] } } };
  return { ...core, inputHash: canonicalSha256(core) } as ResearchInputPackage;
}

export function syntheticConclusionInput(businessKey: ResearchBusinessKey, versions: AssembleVersions, benchmark: FrozenBenchmark = freezeBenchmark({ ...businessKey, facts: [] })): ConclusionInput {
  const source = benchmark?.attributionFact;
  const core = { sealId: 'test:seal', businessKey, cutoff: businessKey.cutoff,
    artifactRefs: [{ sha256: source?.artifactSha256 ?? canonicalSha256('TEST_ONLY source'), bytes: 0, mediaType: 'application/json', firstObservedAt: businessKey.cutoff }],
    factIds: source == null ? ['test:f1', 'test:f2'] : [source.factId], gaps: [], ...versions, createdAt: businessKey.cutoff };
  const seal = { ...core, manifestHash: canonicalSha256(core) };
  const pkg = inputFromTestSeal(seal, benchmark);
  const a = simulatedModelA({ inputHash: pkg.inputHash, subjectKind: businessKey.subjectKind,
    subject: businessKey.subject, material: researchMaterial(pkg) });
  const checklist = deriveChecklist(a, seal.manifestHash);
  const j = simulatedModelJ({ inputHash: researchJInputHash(pkg, a, checklist), subjectKind: businessKey.subjectKind, aOutput: a, checklist });
  return { businessKey, ...versions, researchInput: pkg, manifest: seal,
    aOutput: a, checklist, jOutput: j, inheritance: null, changeReason: j.changeReason };
}
