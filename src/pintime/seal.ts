import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import type {
  AdapterVersionId,
  ArtifactRef,
  MethodVersionId,
  PlanAuthVersionId,
  ResearchBusinessKey,
  SealManifest,
} from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { insertSealRow, findSealRowsByKey, loadSealRow, PintimeError, rowToSeal } from '../db/pintime.js';
import { asOfFacts, loadFact, type FactSelector } from './facts.js';

export interface SealInput {
  businessKey: ResearchBusinessKey;
  cutoff: string; // 资料截点 knowledge_cutoff_at，ISO-8601
  factSelector: FactSelector;
  /** 派生材料的精确输入子集；每项仍须通过 selector 与 as-of 可见性验证。 */
  selectedFactIds?: readonly string[];
  gaps: string[]; // 显式缺口列表：可空数组，不可缺省（POINT-IN-TIME §7）
  methodVersion: MethodVersionId;
  adapterVersion: AdapterVersionId;
  planAuthVersion: PlanAuthVersionId;
}

export interface SealVerifyResult {
  ok: true;
  sealId: string;
  manifestHash: string;
  factsChecked: number;
  artifactsChecked: number;
}

const SUBJECT_KINDS = ['STOCK', 'BROAD_ETF'] as const;
const RESEARCH_KINDS = ['WEEKLY', 'POST_EVENT', 'PRE_EVENT'] as const;

function parseIsoSeal(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new PintimeError('INVALID_SEAL_INPUT', field);
  return d;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new PintimeError('INVALID_SEAL_INPUT', field);
}

// ===== 内容指纹（W26 幂等复用）=====

/** 内容指纹输入面：材料内容，不含身份字段（sealId/createdAt 不参与幂等判定）。 */
interface SealContentParts {
  factIds: string[];
  artifactSha256s: string[];
  gaps: string[];
  methodVersion: string;
  planAuthVersion: string;
}

/**
 * 内容指纹 = canonicalSha256(材料内容)。factIds / 原件哈希集排序去重（顺序与重复不构成
 * 材料差异）；gaps 保序（与 manifestHash 同口径：缺口清单顺序是内容的一部分）。
 * 幂等复用据此判定；manifestHash 定义不变（仍含 sealId/createdAt，历史哈希不可改）。
 */
function sealContentFingerprint(parts: SealContentParts): string {
  return canonicalSha256({
    factIds: [...new Set(parts.factIds)].sort(),
    artifactSha256s: [...new Set(parts.artifactSha256s)].sort(),
    gaps: parts.gaps,
    methodVersion: parts.methodVersion,
    planAuthVersion: parts.planAuthVersion,
  });
}

/** 剥离调用期标记 reused（非 manifest 内容）：嵌入研究包 / 参与 inputHash 前统一调用。 */
export function sealManifestContent(seal: SealManifest): SealManifest {
  const { reused, ...content } = seal;
  return content;
}

/**
 * 封存（POINT-IN-TIME §7）：按 selector 做 as-of 取事实（cutoff 为可见世界上限），
 * 收集对应 ArtifactRef（原件缺失即失败——manifest 内所有引用必须可解析），
 * manifestHash = canonicalSha256(除 manifestHash 外全部字段)，落库后不可变（无更新 API）。
 *
 * 幂等复用（W26）：落库前按 (business_key, cutoff, adapter_version) 查既有封存，
 * 内容指纹一致（事实集/原件哈希集/缺口/方法与授权版本相同）→ 复用既有 seal 返回
 * （带 reused: true 调用期标记），不追加新行；材料真实变化 → 照旧新建。
 * 封存不可变 → 幂等只能复用，不能改写；并发同键双封允许双行，下次先匹配者复用。
 */
export async function buildSeal(pool: Pool, store: ArtifactStore, input: SealInput): Promise<SealManifest> {
  const cutoffDate = parseIsoSeal(input.cutoff, 'cutoff');
  if (!SUBJECT_KINDS.includes(input.businessKey.subjectKind)) {
    throw new PintimeError('INVALID_SEAL_INPUT', 'businessKey.subjectKind');
  }
  if (!RESEARCH_KINDS.includes(input.businessKey.researchKind)) {
    throw new PintimeError('INVALID_SEAL_INPUT', 'businessKey.researchKind');
  }
  requireNonEmpty(input.businessKey.subject, 'businessKey.subject');
  parseIsoSeal(input.businessKey.cutoff, 'businessKey.cutoff');
  if (!Array.isArray(input.gaps)) throw new PintimeError('INVALID_SEAL_INPUT', 'gaps must be an array');
  requireNonEmpty(input.methodVersion, 'methodVersion');
  requireNonEmpty(input.adapterVersion, 'adapterVersion');
  requireNonEmpty(input.planAuthVersion, 'planAuthVersion');

  const visible = await asOfFacts(pool, { ...input.factSelector, asOf: cutoffDate });
  const selected = input.selectedFactIds === undefined ? null : new Set(input.selectedFactIds);
  const facts = selected === null ? visible : visible.filter((f) => selected.has(f.factId));
  if (selected !== null && facts.length !== selected.size) {
    throw new PintimeError('SEAL_INPUT_FACT_NOT_VISIBLE', '派生输入须全部命中 selector 与精确 cutoff');
  }

  const hashes = [...new Set(facts.map((fact) => fact.artifactSha256))].sort();
  const artifactRefs: ArtifactRef[] = [];
  for (const hash of hashes) {
    artifactRefs.push(await store.refOf(hash)); // 原件缺失 → ARTIFACT_MISSING（引用必须可解析）
  }

  // 进哈希的字符串先归一为 UTC ISO，保证封存 → DB 往返后可重算一致（verifySeal）。
  const businessKey = { ...input.businessKey, cutoff: new Date(input.businessKey.cutoff).toISOString() };

  // 幂等复用前置查询：同键候选逐条重建内容指纹，与本次输入一致 → 返回既有 seal（不改写）。
  const fingerprint = sealContentFingerprint({
    factIds: facts.map((fact) => fact.factId),
    artifactSha256s: hashes,
    gaps: [...input.gaps],
    methodVersion: input.methodVersion,
    planAuthVersion: input.planAuthVersion,
  });
  const candidates = await findSealRowsByKey(pool, businessKey, cutoffDate, input.adapterVersion);
  for (const row of candidates) {
    const existing = rowToSeal(row);
    if (
      sealContentFingerprint({
        factIds: existing.factIds,
        artifactSha256s: existing.artifactRefs.map((ref) => ref.sha256),
        gaps: existing.gaps,
        methodVersion: existing.methodVersion,
        planAuthVersion: existing.planAuthVersion,
      }) === fingerprint
    ) {
      return { ...existing, reused: true };
    }
  }

  const core = {
    sealId: randomUUID(),
    businessKey,
    cutoff: cutoffDate.toISOString(),
    artifactRefs,
    factIds: facts.map((fact) => fact.factId),
    gaps: [...input.gaps],
    methodVersion: input.methodVersion,
    adapterVersion: input.adapterVersion,
    planAuthVersion: input.planAuthVersion,
    createdAt: new Date().toISOString(),
  };
  const manifestHash = canonicalSha256(core);
  const seal: SealManifest = { ...core, manifestHash };
  await insertSealRow(pool, seal);
  return seal;
}

export async function readSeal(pool: Pool, sealId: string): Promise<SealManifest | null> {
  const row = await loadSealRow(pool, sealId);
  return row === null ? null : rowToSeal(row);
}

/**
 * 校验封存（POINT-IN-TIME §7 判定）：重算 manifestHash 一致；
 * 每个 factId 可解析；每个 artifact 哈希在原件库按校验读回一致。
 * 任一不满足抛具名错误（SEAL_MISSING / SEAL_HASH_MISMATCH / SEALED_FACT_MISSING，或原件库 ARTIFACT_MISSING / HASH_MISMATCH）。
 */
export async function verifySeal(pool: Pool, store: ArtifactStore, sealId: string): Promise<SealVerifyResult> {
  const seal = await readSeal(pool, sealId);
  if (seal === null) throw new PintimeError('SEAL_MISSING', sealId);
  const { manifestHash, ...core } = seal;
  if (canonicalSha256(core) !== manifestHash) throw new PintimeError('SEAL_HASH_MISMATCH', sealId);
  for (const factId of seal.factIds) {
    const fact = await loadFact(pool, factId);
    if (fact === null) throw new PintimeError('SEALED_FACT_MISSING', `${sealId} fact ${factId}`);
  }
  for (const ref of seal.artifactRefs) {
    await store.readBytes(ref.sha256); // ARTIFACT_MISSING / HASH_MISMATCH 原样传播
  }
  return {
    ok: true,
    sealId: seal.sealId,
    manifestHash,
    factsChecked: seal.factIds.length,
    artifactsChecked: seal.artifactRefs.length,
  };
}
