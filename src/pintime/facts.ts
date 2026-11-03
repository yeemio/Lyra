import type { Pool } from 'pg';
import type { TimePointFact, TimePointSubjectType } from '../contracts.js';
import {
  PintimeError,
  findShadowedFactIds,
  insertFactRow,
  loadFactRow,
  queryFactRows,
  rowToFact,
  type FactFilter,
} from '../db/pintime.js';

const SUBJECT_TYPES: readonly TimePointSubjectType[] = ['STOCK', 'ETF', 'INDUSTRY', 'INDEX', 'RULE'];
const HASH_RE = /^[a-f0-9]{64}$/;

/** 事实选择器：与 asOf 组成一次 as-of 读取（POINT-IN-TIME §2.3）。 */
export interface FactSelector {
  subjectType?: TimePointSubjectType;
  subjectId?: string;
  factKind?: string;
}

export type InsertFactStatus = 'INSERTED' | 'ALREADY_INSERTED_IDENTICAL';

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new PintimeError('INVALID_FACT', field);
}

function validateFact(fact: TimePointFact): void {
  requireNonEmpty(fact.factId, 'factId');
  if (!SUBJECT_TYPES.includes(fact.subjectType)) {
    throw new PintimeError('INVALID_FACT', `subjectType ${String(fact.subjectType)}`);
  }
  requireNonEmpty(fact.subjectId, 'subjectId');
  requireNonEmpty(fact.factKind, 'factKind');
  requireNonEmpty(fact.adapterVersion, 'adapterVersion');
  if (!HASH_RE.test(fact.artifactSha256)) throw new PintimeError('INVALID_FACT', 'artifactSha256');
  if (fact.typedValue === undefined) throw new PintimeError('INVALID_FACT', 'typedValue undefined');
  if (fact.supersedesFactId === fact.factId) throw new PintimeError('INVALID_FACT', 'supersedes self');
}

/**
 * 插入时点事实。同 factId 同内容幂等（ALREADY_INSERTED_IDENTICAL）；
 * 同 factId 异内容抛 FACT_CONFLICT——修正只新增事实并带 supersedes_fact_id，不覆盖（POINT-IN-TIME §4）。
 */
export async function insertFact(pool: Pool, fact: TimePointFact): Promise<InsertFactStatus> {
  validateFact(fact);
  const result = await insertFactRow(pool, fact);
  return result === 'INSERTED' ? 'INSERTED' : 'ALREADY_INSERTED_IDENTICAL';
}

export async function loadFact(pool: Pool, factId: string): Promise<TimePointFact | null> {
  const row = await loadFactRow(pool, factId);
  return row === null ? null : rowToFact(row);
}

/**
 * as-of 读取（POINT-IN-TIME §2.3）：只返回 available_at <= asOf 的候选，
 * 并沿 supersedes 链解析到该时点有效的最新版本——被某个 available_at <= asOf 的新事实
 * 直接 supersede 的旧事实不返回（链头胜出；分叉并存暴露，不自动合并，§4 来源冲突）。
 */
export async function asOfFacts(pool: Pool, query: FactSelector & { asOf: Date }): Promise<TimePointFact[]> {
  if (!(query.asOf instanceof Date) || Number.isNaN(query.asOf.getTime())) {
    throw new PintimeError('INVALID_ASOF', 'asOf must be a valid Date');
  }
  const filter: FactFilter = {};
  if (query.subjectType !== undefined) filter.subjectType = query.subjectType;
  if (query.subjectId !== undefined) filter.subjectId = query.subjectId;
  if (query.factKind !== undefined) filter.factKind = query.factKind;
  const rows = await queryFactRows(pool, filter, query.asOf);
  const shadowed = await findShadowedFactIds(
    pool,
    rows.map((row) => row.fact_id),
    query.asOf,
  );
  return rows.filter((row) => !shadowed.has(row.fact_id)).map(rowToFact);
}
