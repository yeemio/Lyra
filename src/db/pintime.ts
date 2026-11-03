import type { Pool } from 'pg';
import { canonicalJsonString } from '../canonical.js';
import type { ArtifactRef, ResearchBusinessKey, SealManifest, TimePointFact } from '../contracts.js';

/** 时点层/原件库 DB 访问层具名错误。code 为稳定错误名。 */
export class PintimeError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'PintimeError';
  }
}

// ===== pintime_fact 行映射 =====

export interface FactRow {
  fact_id: string;
  subject_type: string;
  subject_id: string;
  fact_kind: string;
  typed_value: unknown; // pg 对 jsonb 返回已解析的 JS 值
  valid_from: Date | null;
  valid_to: Date | null;
  event_at: Date | null;
  source_published_at: Date | null;
  first_observed_at: Date;
  available_at: Date;
  supersedes_fact_id: string | null;
  artifact_sha256: string;
  adapter_version: string;
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toTs(value: string | null, field: string): Date | null {
  if (value === null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new PintimeError('INVALID_FACT_TIME', field);
  return d;
}

export function rowToFact(row: FactRow): TimePointFact {
  return {
    factId: row.fact_id,
    subjectType: row.subject_type as TimePointFact['subjectType'],
    subjectId: row.subject_id,
    factKind: row.fact_kind,
    typedValue: row.typed_value,
    validFrom: isoOrNull(row.valid_from),
    validTo: isoOrNull(row.valid_to),
    eventAt: isoOrNull(row.event_at),
    sourcePublishedAt: isoOrNull(row.source_published_at),
    firstObservedAt: row.first_observed_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    supersedesFactId: row.supersedes_fact_id,
    artifactSha256: row.artifact_sha256,
    adapterVersion: row.adapter_version,
  };
}

function factEqual(a: TimePointFact, b: TimePointFact): boolean {
  const epoch = (value: string | null): number | null =>
    value === null ? null : new Date(value).getTime();
  return (
    a.factId === b.factId &&
    a.subjectType === b.subjectType &&
    a.subjectId === b.subjectId &&
    a.factKind === b.factKind &&
    canonicalJsonString(a.typedValue) === canonicalJsonString(b.typedValue) &&
    epoch(a.validFrom) === epoch(b.validFrom) &&
    epoch(a.validTo) === epoch(b.validTo) &&
    epoch(a.eventAt) === epoch(b.eventAt) &&
    epoch(a.sourcePublishedAt) === epoch(b.sourcePublishedAt) &&
    epoch(a.firstObservedAt) === epoch(b.firstObservedAt) &&
    epoch(a.availableAt) === epoch(b.availableAt) &&
    a.supersedesFactId === b.supersedesFactId &&
    a.artifactSha256 === b.artifactSha256 &&
    a.adapterVersion === b.adapterVersion
  );
}

/**
 * 幂等插入：同 factId 同内容 → IDENTICAL（调用方映射为 ALREADY_INSERTED_IDENTICAL）；
 * 同 factId 异内容 → 抛 FACT_CONFLICT（修正只新增 + supersedes，不覆盖，POINT-IN-TIME §4）；
 * supersedes_fact_id 悬空引用 → FACT_SUPERSEDES_MISSING。
 */
export async function insertFactRow(pool: Pick<Pool, 'query'>, fact: TimePointFact): Promise<'INSERTED' | 'IDENTICAL'> {
  const params = [
    fact.factId,
    fact.subjectType,
    fact.subjectId,
    fact.factKind,
    JSON.stringify(fact.typedValue),
    toTs(fact.validFrom, 'validFrom'),
    toTs(fact.validTo, 'validTo'),
    toTs(fact.eventAt, 'eventAt'),
    toTs(fact.sourcePublishedAt, 'sourcePublishedAt'),
    toTs(fact.firstObservedAt, 'firstObservedAt'),
    toTs(fact.availableAt, 'availableAt'),
    fact.supersedesFactId,
    fact.artifactSha256,
    fact.adapterVersion,
  ];
  try {
    const res = await pool.query(
      `insert into pintime_fact
        (fact_id, subject_type, subject_id, fact_kind, typed_value,
         valid_from, valid_to, event_at, source_published_at,
         first_observed_at, available_at, supersedes_fact_id, artifact_sha256, adapter_version)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (fact_id) do nothing`,
      params,
    );
    if (res.rowCount === 1) return 'INSERTED';
  } catch (error) {
    if ((error as { code?: string }).code === '23503') {
      throw new PintimeError('FACT_SUPERSEDES_MISSING', `supersedesFactId ${String(fact.supersedesFactId)} not found`);
    }
    throw error;
  }
  const existing = await loadFactRow(pool, fact.factId);
  if (existing === null) throw new PintimeError('FACT_ROW_VANISHED', fact.factId);
  if (!factEqual(rowToFact(existing), fact)) {
    throw new PintimeError('FACT_CONFLICT', `factId ${fact.factId} exists with different content`);
  }
  return 'IDENTICAL';
}

export async function loadFactRow(pool: Pick<Pool, 'query'>, factId: string): Promise<FactRow | null> {
  const res = await pool.query('select * from pintime_fact where fact_id = $1', [factId]);
  const row = res.rows[0] as FactRow | undefined;
  return row ?? null;
}

export interface FactFilter {
  subjectType?: string;
  subjectId?: string;
  factKind?: string;
}

/** as-of 基础查询：只取 available_at <= asOf 的候选（supersedes 链解析在 facts.ts 完成）。 */
export async function queryFactRows(pool: Pool, filter: FactFilter, asOf: Date): Promise<FactRow[]> {
  const clauses = ['available_at <= $1'];
  const params: unknown[] = [asOf];
  if (filter.subjectType !== undefined) {
    params.push(filter.subjectType);
    clauses.push(`subject_type = $${params.length}`);
  }
  if (filter.subjectId !== undefined) {
    params.push(filter.subjectId);
    clauses.push(`subject_id = $${params.length}`);
  }
  if (filter.factKind !== undefined) {
    params.push(filter.factKind);
    clauses.push(`fact_kind = $${params.length}`);
  }
  const sql =
    `select * from pintime_fact where ${clauses.join(' and ')} ` +
    'order by subject_type asc, subject_id asc, fact_kind asc, available_at asc, fact_id asc';
  const res = await pool.query(sql, params);
  return res.rows as FactRow[];
}

/**
 * 查询在 asOf 时点已被任何 as-of 有效事实直接 supersede 的 factId 集合。
 * 不按 selector 过滤：supersede 关系成立与否与读取过滤条件无关。
 */
export async function findShadowedFactIds(pool: Pool, factIds: string[], asOf: Date): Promise<Set<string>> {
  if (factIds.length === 0) return new Set();
  const res = await pool.query(
    'select supersedes_fact_id from pintime_fact where available_at <= $1 and supersedes_fact_id = any($2::text[])',
    [asOf, factIds],
  );
  return new Set(res.rows.map((r) => r.supersedes_fact_id as string));
}

// ===== seal_manifest 行映射 =====

export interface SealRow {
  seal_id: string;
  business_key: unknown;
  cutoff: Date;
  artifact_refs: unknown;
  fact_ids: unknown;
  gaps: unknown;
  method_version: string;
  adapter_version: string;
  plan_auth_version: string;
  created_at: Date;
  manifest_hash: string;
}

function jsonArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new PintimeError('SEAL_ROW_CORRUPT', field);
  return value;
}

export function rowToSeal(row: SealRow): SealManifest {
  return {
    sealId: row.seal_id,
    businessKey: row.business_key as ResearchBusinessKey,
    cutoff: row.cutoff.toISOString(),
    artifactRefs: jsonArray(row.artifact_refs, 'artifact_refs') as ArtifactRef[],
    factIds: jsonArray(row.fact_ids, 'fact_ids') as string[],
    gaps: jsonArray(row.gaps, 'gaps') as string[],
    methodVersion: row.method_version,
    adapterVersion: row.adapter_version,
    planAuthVersion: row.plan_auth_version,
    createdAt: row.created_at.toISOString(),
    manifestHash: row.manifest_hash,
  };
}

/** 封存写入（一次插入，无更新路径；manifest_hash unique 由 DB 兜底内容身份）。 */
export async function insertSealRow(pool: Pool, seal: SealManifest): Promise<void> {
  await pool.query(
    `insert into seal_manifest
      (seal_id, business_key, cutoff, artifact_refs, fact_ids, gaps,
       method_version, adapter_version, plan_auth_version, created_at, manifest_hash)
     values ($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`,
    [
      seal.sealId,
      JSON.stringify(seal.businessKey),
      new Date(seal.cutoff),
      JSON.stringify(seal.artifactRefs),
      JSON.stringify(seal.factIds),
      JSON.stringify(seal.gaps),
      seal.methodVersion,
      seal.adapterVersion,
      seal.planAuthVersion,
      new Date(seal.createdAt),
      seal.manifestHash,
    ],
  );
}

export async function loadSealRow(pool: Pool, sealId: string): Promise<SealRow | null> {
  const res = await pool.query('select * from seal_manifest where seal_id = $1', [sealId]);
  const row = res.rows[0] as SealRow | undefined;
  return row ?? null;
}

/**
 * 按 (business_key, cutoff, adapter_version) 查既有封存候选行（W26 幂等复用前置查询）。
 * business_key 传归一化对象（cutoff 为 UTC ISO，与落库口径一致）；jsonb 等值比较与键序无关。
 * 结果按 created_at/seal_id 稳定排序；是否复用由调用方按内容指纹逐条判定。
 */
export async function findSealRowsByKey(
  pool: Pool,
  businessKey: ResearchBusinessKey,
  cutoff: Date,
  adapterVersion: string,
): Promise<SealRow[]> {
  const res = await pool.query(
    `select * from seal_manifest
     where business_key = $1::jsonb and cutoff = $2 and adapter_version = $3
     order by created_at asc, seal_id asc`,
    [JSON.stringify(businessKey), cutoff, adapterVersion],
  );
  return res.rows as SealRow[];
}
