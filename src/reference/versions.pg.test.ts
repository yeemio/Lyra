/** 仅显式提供隔离 PG 才执行；无默认业务库回退，不以内存替代 SQL。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { ArtifactStore } from '../artifacts/store.js';
import { insertFact, asOfFacts } from '../pintime/facts.js';
import { buildSeal, verifySeal } from '../pintime/seal.js';
import { applyReferenceMigration, saveGroupStats, loadReferenceVersion, referenceVersionPayload } from './library.js';
import { referenceFixture } from './versions-test-helper.js';

test('I-02/03 隔离 PG：源 DDL、追加/幂等、禁止改删清空、强制发布时间、旧截点和精确输入封存', {
  skip: process.env.LYRA_REPAIR_TEST_PG ? false : 'NOT_RUN: LYRA_REPAIR_TEST_PG 未提供隔离 PostgreSQL',
}, async (t) => {
  const connectionString = process.env.LYRA_REPAIR_TEST_PG!;
  const schema = `pr1_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const root = await mkdtemp(join(tmpdir(), 'lyra-pr1-pg-'));
  let pool: Pool | undefined;
  t.after(async () => { await pool?.end(); await dropSchema(admin, schema); await admin.end(); await rm(root, { recursive: true, force: true }); });
  await applySchema(admin, schema);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await applyReferenceMigration(pool); await applyReferenceMigration(pool);
  const f = referenceFixture();
  await saveGroupStats(pool, f.groups, f.facts);
  await saveGroupStats(pool, f.groups, f.facts);
  assert.equal((await pool.query('select count(*)::int as n from reference_library_versions')).rows[0].n, 1);
  assert.equal(await loadReferenceVersion(pool, '2026-03-01T01:00:00.000Z'), null, '刚发布的历史统计不能伪装三月已知');
  const cutoff = ((await pool.query("select clock_timestamp() + interval '2 milliseconds' as cutoff")).rows[0].cutoff as Date).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = await loadReferenceVersion(pool, cutoff); assert.ok(before);
  const later = referenceFixture('2026-03-02T00:00:00.000Z', 'new-event', '12');
  await saveGroupStats(pool, later.groups, later.facts);
  assert.deepEqual(await loadReferenceVersion(pool, cutoff), before);
  for (const sql of ["update reference_library_versions set payload='{}'::jsonb", 'delete from reference_library_versions', 'truncate reference_library_versions']) {
    await assert.rejects(() => pool!.query(sql), (e: unknown) => (e as { code?: string }).code === '55000');
  }
  const empty = referenceVersionPayload([], [], { ...f.identity, inputAvailableAtMax: null, materializedAt: '2026-03-03T00:00:00.000Z' });
  const hash = canonicalSha256(empty);
  const attempted = await pool.query(`insert into reference_library_versions
    (version_id,content_hash,payload,materialized_at,input_available_at_max,input_observed_at_max,maturity_at_max,published_at)
    values ($1,$2,$3::jsonb,$4,$4,$4,$4,'2026-03-03T00:00:01Z') returning published_at`,
    [`rl-${hash}`, hash, canonicalJsonString(empty), empty.materializedAt]);
  assert.ok((attempted.rows[0].published_at as Date).getTime() > Date.parse(cutoff), '显式伪造发布时间被 INSERT trigger 替换为 DB 实际时间');
  assert.deepEqual(await loadReferenceVersion(pool, cutoff), before);
  assert.equal((await pool.query('select count(*)::int as n from reference_library_versions')).rows[0].n, 3);

  // 新 seal 的精确子集必须满足实际源 SQL as-of 可见性；原件是真正临时 CAS。
  const store = new ArtifactStore(root);
  const selected = f.facts.filter((x) => x.factKind === 'ANNOUNCEMENT' || x.factKind === 'INDUSTRY_CLASS_VERSION');
  for (const fact of selected) {
    const ref = await store.put(new TextEncoder().encode(canonicalJsonString(fact.typedValue)), 'application/json', fact.firstObservedAt);
    fact.artifactSha256 = ref.sha256; await insertFact(pool, fact);
  }
  const key = { subjectKind: 'STOCK' as const, subject: '600101', researchKind: 'WEEKLY' as const, cutoff: '2026-01-05T09:00:00.000Z' };
  assert.equal((await asOfFacts(pool, { subjectType: 'STOCK', subjectId: key.subject, asOf: new Date(key.cutoff) })).length, 2);
  const input = { businessKey: key, cutoff: key.cutoff, factSelector: {}, gaps: [], methodVersion: 'synthetic@1',
    adapterVersion: 'synthetic@1', planAuthVersion: 'synthetic@1', selectedFactIds: [selected[0]!.factId] };
  const seal = await buildSeal(pool, store, input);
  assert.deepEqual(seal.factIds, input.selectedFactIds);
  assert.equal((await verifySeal(pool, store, seal.sealId)).factsChecked, 1);
  assert.equal((await buildSeal(pool, store, input)).manifestHash, seal.manifestHash);
  await assert.rejects(() => buildSeal(pool!, store, { ...input, cutoff: '2020-01-01T00:00:00.000Z' }),
    (e: unknown) => (e as { code?: string }).code === 'SEAL_INPUT_FACT_NOT_VISIBLE');
});
