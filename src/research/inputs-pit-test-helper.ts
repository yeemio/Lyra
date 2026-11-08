/** 仅合成行为测试的查询端口；不执行或宣称验证 PostgreSQL SQL。所有原件均为临时 CAS。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { RESEARCH_REPAIR_METHOD_VERSION } from './indicators.js';
import { etfMappingContent } from '../conclusion/benchmark.js';
import type { EtfMappingSnapshot } from '../conclusion/benchmark.js';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import type { FactRow, SealRow } from '../db/pintime.js';

export function factRow(f: TimePointFact): FactRow {
  const ts = (s: string | null): Date | null => s === null ? null : new Date(s);
  return { fact_id: f.factId, subject_type: f.subjectType, subject_id: f.subjectId, fact_kind: f.factKind,
    typed_value: f.typedValue, valid_from: ts(f.validFrom), valid_to: ts(f.validTo), event_at: ts(f.eventAt),
    source_published_at: ts(f.sourcePublishedAt), first_observed_at: new Date(f.firstObservedAt), available_at: new Date(f.availableAt),
    supersedes_fact_id: f.supersedesFactId, artifact_sha256: f.artifactSha256, adapter_version: f.adapterVersion };
}
export async function pitFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-pit-synthetic-'));
  const store = new ArtifactStore(join(dir, 'cas'));
  const facts: TimePointFact[] = [];
  const seals: SealRow[] = [];
  const queries: string[] = [];
  const pool = { async query(sql: string, values: unknown[] = []) {
    queries.push(sql);
    if (/select \* from pintime_fact where fact_id = \$1/.test(sql)) {
      return { rows: facts.filter((f) => f.factId === values[0]).map(factRow) };
    }
    if (sql.startsWith('select * from pintime_fact where available_at <= $1')) {
      const at = new Date(values[0] as string).getTime();
      const selected = facts.filter((f) => Date.parse(f.availableAt) <= at &&
        [['subject_type', f.subjectType], ['subject_id', f.subjectId], ['fact_kind', f.factKind]].every(([column, value]) => {
          const m = new RegExp(`${column} = \\$(\\d+)`).exec(sql);
          return m === null || values[Number(m[1]) - 1] === value;
        })).sort((a, b) => a.subjectType.localeCompare(b.subjectType) || a.subjectId.localeCompare(b.subjectId) ||
          a.factKind.localeCompare(b.factKind) || a.availableAt.localeCompare(b.availableAt) || a.factId.localeCompare(b.factId));
      return { rows: selected.map(factRow) };
    }
    if (sql.startsWith('select supersedes_fact_id from pintime_fact')) {
      return { rows: facts.filter((f) => Date.parse(f.availableAt) <= new Date(values[0] as string).getTime() &&
        (values[1] as string[]).includes(f.supersedesFactId ?? '')).map((f) => ({ supersedes_fact_id: f.supersedesFactId })) };
    }
    if (sql.startsWith('select * from seal_manifest')) {
      return { rows: seals.filter((s) => canonicalJsonString(s.business_key) === canonicalJsonString(JSON.parse(values[0] as string)) &&
        s.cutoff.getTime() === new Date(values[1] as string).getTime() && s.adapter_version === values[2]) };
    }
    if (sql.includes('insert into seal_manifest')) {
      seals.push({ seal_id: values[0] as string, business_key: JSON.parse(values[1] as string), cutoff: new Date(values[2] as string),
        artifact_refs: JSON.parse(values[3] as string), fact_ids: JSON.parse(values[4] as string), gaps: JSON.parse(values[5] as string),
        method_version: values[6] as string, adapter_version: values[7] as string, plan_auth_version: values[8] as string,
        created_at: new Date(values[9] as string), manifest_hash: values[10] as string });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('from reference_library_versions')) throw Object.assign(new Error('synthetic: no reference publications'), { code: '42P01' });
    if (sql.includes('from events')) return { rows: [] };
    if (sql.includes('select subject_id, typed_value from pintime_fact')) {
      return { rows: facts.filter((f) => f.factKind === 'SW_INDEX_BAR' && Date.parse(f.availableAt) <= Date.parse(String(values[0])))
        .map((f) => ({ subject_id: f.subjectId, typed_value: f.typedValue })) };
    }
    if (sql.includes("fact_kind = 'SW_INDEX_LIST'")) return { rows: [] };
    throw new Error(`Unsupported synthetic query (NOT SQL validation): ${sql}`);
  } } as unknown as Pool;
  const poolFile = join(dir, 'synthetic-pool.json');
  const poolData = { frozenAt: '2025-01-01', stocks: [
    { code: '600101', name: '合成公司一', swL1IndexCode: '801999', swL1Name: '当前池错误名称' },
    { code: '600102', name: '合成公司二', swL1IndexCode: '801999', swL1Name: '当前池错误名称' },
  ], etfs: [{ code: '510300', name: '合成宽基', tracks: '合成指数(000300)' }] };
  await writeFile(poolFile, JSON.stringify(poolData));
  let seq = 0;
  async function add(base: Pick<TimePointFact, 'subjectType' | 'subjectId' | 'factKind' | 'typedValue' | 'availableAt'> & Partial<TimePointFact>) {
    const factId = base.factId ?? `synthetic-pit-${++seq}`;
    const bytes = new TextEncoder().encode(canonicalJsonString({ factId, ...base }));
    const ref = await store.put(bytes, 'application/json', base.firstObservedAt ?? base.availableAt);
    const fact: TimePointFact = { validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: base.availableAt, supersedesFactId: null, adapterVersion: 'synthetic-pit@1', ...base,
      factId, artifactSha256: ref.sha256 };
    facts.push(fact);
    return fact;
  }
  return { dir, store, facts, seals, queries, pool, poolFile, poolData, add, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export const PIT_TEST_BUDGET = { l0Bytes: 1_000_000, l1Bytes: 1_000_000, l2Bytes: 1_000_000, totalBytes: 3_000_000 };
export const PIT_TEST_VERSIONS = { methodVersion: RESEARCH_REPAIR_METHOD_VERSION, adapterVersion: 'synthetic-pit@1', planAuthVersion: 'synthetic-only@1' };
export const barValue = (code: string, date: string, close = '10') => ({ code: `sh.${code}`, date,
  open: '10', high: close, low: '10', close, preclose: '10', volume: '1000', amount: '10000',
  adjustflag: '3', tradestatus: '1', isST: '0' });

/** 合成 ETF 观察回执；生产入口必须由 CAS 实际落位取得，不允许配置日期冒充。 */
export function testEtfMapping(subject: string, tracks: string, observedAt = '2023-01-01T00:00:00.000Z'): EtfMappingSnapshot {
  const config = { frozenAt: '2023-01-01', tracks };
  const bytes = Buffer.byteLength(canonicalJsonString(etfMappingContent(subject, config)));
  return { ...config, observation: { sha256: canonicalSha256(etfMappingContent(subject, config)), bytes,
    mediaType: 'application/json', firstObservedAt: observedAt } };
}
