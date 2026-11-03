import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact } from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { canonicalSha256 } from '../canonical.js';
import { insertFactRow, PintimeError, rowToFact, type FactRow } from '../db/pintime.js';

const ready = new WeakMap<Pool, Promise<void>>();

/** 同源相同原件的首次 CAS 元数据落盘也串行；数据库行锁不能保护此前的文件写入。 */
export async function putSwArtifact(pool: Pool, store: ArtifactStore, bytes: Uint8Array,
  mediaType: string, fetchedAt: string): Promise<ArtifactRef> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtextextended(current_schema() || ':sw-artifact:' || $1, 0))", [hash]);
    const artifact = await store.put(bytes, mediaType, fetchedAt);
    await client.query('commit');
    return artifact;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** SW 专用追加收据；不改变其他来源 insertFact 的严格不可变比较。 */
async function ensureSchema(pool: Pool): Promise<void> {
  let promise = ready.get(pool);
  if (promise === undefined) {
    promise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended(current_schema() || ':sw-observation-schema', 0))");
        await client.query(`create table if not exists sw_fact_observation (
          observation_id text primary key,
          capture_id text not null,
          scope text not null,
          logical_key text not null,
          fact_id text not null references pintime_fact(fact_id),
          semantic_hash text not null,
          observed_at timestamptz not null,
          artifact_sha256 text not null
        );
        create index if not exists sw_fact_observation_fact_idx on sw_fact_observation(fact_id, observed_at)`);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally { client.release(); }
    })();
    ready.set(pool, promise);
  }
  try { await promise; } catch (error) { ready.delete(pool); throw error; }
}

const iso = (value: string | null): string | null => value === null ? null : new Date(value).toISOString();

export function swLogicalKey(fact: TimePointFact): string {
  return canonicalSha256({ adapterVersion: fact.adapterVersion, subjectType: fact.subjectType,
    subjectId: fact.subjectId, factKind: fact.factKind, validFrom: iso(fact.validFrom) });
}

/** 保留源行语义的独立指纹。修订的 availableAt 会推进，但源语义指纹不随抓取时钟改变。 */
export function swSemanticHash(fact: TimePointFact): string {
  const snapshot = fact.factKind === 'SW_INDEX_LIST';
  return canonicalSha256({ key: swLogicalKey(fact), typedValue: fact.typedValue,
    validTo: iso(fact.validTo), eventAt: snapshot ? null : iso(fact.eventAt),
    sourcePublishedAt: iso(fact.sourcePublishedAt), availableAt: snapshot ? null : iso(fact.availableAt) });
}

export interface SwCurrentFact {
  fact: TimePointFact;
  semanticHash: string;
  lastObservedAt: string;
}

export function resolveSwObservation(incoming: TimePointFact, current: SwCurrentFact | null): {
  fact: TimePointFact; identical: boolean; semanticHash: string;
} {
  const semanticHash = swSemanticHash(incoming);
  if (current === null) return { fact: incoming, identical: false, semanticHash };
  if (swLogicalKey(incoming) !== swLogicalKey(current.fact)) throw new PintimeError('SW_LINEAGE_KEY_MISMATCH');
  if (semanticHash === current.semanticHash) return { fact: current.fact, identical: true, semanticHash };
  if (new Date(incoming.firstObservedAt).getTime() <= new Date(current.lastObservedAt).getTime()) {
    throw new PintimeError('SW_OBSERVATION_ORDER_CONFLICT', 'different content at an older or equal observation time');
  }
  const fact: TimePointFact = { ...incoming,
    factId: 'sw-revision-' + canonicalSha256({ key: swLogicalKey(incoming), semanticHash, supersedes: current.fact.factId }),
    supersedesFactId: current.fact.factId,
    availableAt: new Date(Math.max(new Date(incoming.availableAt).getTime(),
      new Date(incoming.firstObservedAt).getTime(), new Date(current.fact.availableAt).getTime())).toISOString(),
  };
  return { fact, identical: false, semanticHash };
}

/** 每业务行单独事务/数据库锁：跨进程重叠批次也串行判定，不跨行持锁而产生锁序死锁。 */
export async function observeSwFact(pool: Pool, incoming: TimePointFact, scope: string, captureId: string): Promise<{
  factId: string; observationId: string; identical: boolean;
}> {
  await ensureSchema(pool);
  const key = swLogicalKey(incoming);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtextextended(current_schema() || ':sw:' || $1, 0))", [key]);
    const rows = await client.query<FactRow & { semantic_hash: string | null; last_observed_at: Date | null }>(
      `select f.*,
         (select o.semantic_hash from sw_fact_observation o where o.fact_id=f.fact_id order by o.observed_at limit 1) as semantic_hash,
         (select max(o.observed_at) from sw_fact_observation o where o.fact_id=f.fact_id) as last_observed_at
       from pintime_fact f
       where f.adapter_version=$1 and f.subject_type=$2 and f.subject_id=$3 and f.fact_kind=$4
         and f.valid_from is not distinct from $5::timestamptz
         and not exists (select 1 from pintime_fact child where child.supersedes_fact_id=f.fact_id)`,
      [incoming.adapterVersion, incoming.subjectType, incoming.subjectId, incoming.factKind, incoming.validFrom]);
    if (rows.rows.length > 1) throw new PintimeError('SW_LINEAGE_AMBIGUOUS', key);
    const row = rows.rows[0];
    const previous = row === undefined ? null : rowToFact(row);
    const resolved = resolveSwObservation(incoming, previous === null || row === undefined ? null : {
      fact: previous, semanticHash: row.semantic_hash ?? swSemanticHash(previous),
      lastObservedAt: new Date(Math.max(row.first_observed_at.getTime(), row.last_observed_at?.getTime() ?? 0)).toISOString(),
    });
    if (!resolved.identical) await insertFactRow(client, resolved.fact);
    const observationId = canonicalSha256({ captureId, factId: resolved.fact.factId });
    await client.query(`insert into sw_fact_observation
      (observation_id, capture_id, scope, logical_key, fact_id, semantic_hash, observed_at, artifact_sha256)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (observation_id) do nothing`,
    [observationId, captureId, scope, key, resolved.fact.factId, resolved.semanticHash, incoming.firstObservedAt, incoming.artifactSha256]);
    await client.query('commit');
    return { factId: resolved.fact.factId, observationId, identical: resolved.identical };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}
