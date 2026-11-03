import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { loadSealRow } from '../db/pintime.js';
import { asOfFacts, insertFact, loadFact } from '../pintime/facts.js';
import { buildSeal, verifySeal } from '../pintime/seal.js';
import { applyP1Migration } from './backoff.js';
import { mapClassifyRowsToFacts, mapDailyRowsToFacts, mapL1ListRowToFacts, SwAdapter, type SwMapContext } from './sw.js';
import { observeSwFact, resolveSwObservation, swLogicalKey, swSemanticHash, type SwCurrentFact } from './sw-observations.js';
import type { TimePointFact } from '../contracts.js';
import type { BridgeResponse } from './adapter-types.js';

const T0 = '2026-11-03T00:00:00.000Z';
const T1 = '2026-11-03T00:00:01.000Z';
const T2 = '2026-11-03T00:00:02.000Z';
const ctx = (fetchedAt = T0, artifactSha256 = 'a'.repeat(64)): SwMapContext => ({ adapterVersion: 'sw@p1', fetchedAt, artifactSha256 });
const bar = { 日期: '2026-10-30', 收盘: 10 };
const classification = { 股票代码: '000001', 计入日期: 41691, 计入日期ISO: '2014-02-21', 行业代码: '480101', 更新日期: 42304, 更新日期ISO: '2015-10-27 15:00:00' };
const current = (fact: TimePointFact): SwCurrentFact => ({ fact, semanticHash: swSemanticHash(fact), lastObservedAt: fact.firstObservedAt });

test('I-06：日线、分类、列表晚一秒/不同原件观察保留首次事实全部身份', () => {
  const builders = [
    (c: SwMapContext) => mapDailyRowsToFacts('801780', [bar], c),
    (c: SwMapContext) => mapClassifyRowsToFacts([classification], c),
    (c: SwMapContext) => mapL1ListRowToFacts([{ 行业代码: '801780.SI' }], c),
  ];
  for (const build of builders) {
    const first = build(ctx()).facts[0]!.fact;
    const next = build(ctx(T1, 'b'.repeat(64))).facts[0]!.fact;
    const resolved = resolveSwObservation(next, current(first));
    assert.equal(resolved.identical, true);
    assert.deepEqual(resolved.fact, first);
  }
});

test('I-06：批次增量不改旧行；真修订推进可得时点、带supersedes，重复修订不再增版', () => {
  const first = mapDailyRowsToFacts('801780', [bar], ctx()).facts[0]!.fact;
  const expanded = mapDailyRowsToFacts('801780', [bar, { 日期: '2026-11-02', 收盘: 12 }], ctx(T1, 'b'.repeat(64)));
  assert.equal(resolveSwObservation(expanded.facts[0]!.fact, current(first)).identical, true);
  const changed = mapDailyRowsToFacts('801780', [{ ...bar, 收盘: 11 }], ctx(T1)).facts[0]!.fact;
  const revised = resolveSwObservation(changed, current(first));
  assert.notEqual(revised.fact.factId, first.factId);
  assert.equal(revised.fact.supersedesFactId, first.factId);
  assert.equal(revised.fact.availableAt, T1);
  const repeated = resolveSwObservation({ ...changed, firstObservedAt: T2 }, {
    fact: revised.fact, semanticHash: revised.semanticHash, lastObservedAt: T1,
  });
  assert.equal(repeated.identical, true);
  assert.deepEqual(repeated.fact, revised.fact);
  assert.throws(() => resolveSwObservation({ ...changed, firstObservedAt: T0 }, current(first)), /SW_OBSERVATION_ORDER_CONFLICT/);
});

test('I-06：仅validTo改变与行业代码改值都属于同一业务键的新修订', () => {
  const first = mapClassifyRowsToFacts([classification], ctx()).facts[0]!.fact;
  const second = { ...classification, 计入日期: 44407, 计入日期ISO: '2021-07-30', 行业代码: '480301' };
  const clipped = mapClassifyRowsToFacts([classification, second], ctx(T1)).facts[0]!.fact;
  assert.equal(clipped.factId, first.factId, '旧映射 ID 相同，不允许据 ID 跳过有效期差异');
  const revised = resolveSwObservation(clipped, current(first));
  assert.equal(revised.identical, false);
  assert.equal(revised.fact.supersedesFactId, first.factId);
  assert.equal(revised.fact.validTo, '2021-07-29T16:00:00.000Z');
  const recoded = mapClassifyRowsToFacts([{ ...classification, 行业代码: '490101' }], ctx(T1)).facts[0]!.fact;
  assert.equal(swLogicalKey(recoded), swLogicalKey(first));
  assert.equal(resolveSwObservation(recoded, current(first)).fact.supersedesFactId, first.factId);
});

test('I-06：同日重复分类去重；同日多值具名拒绝，不制造零长度有效期', () => {
  const identical = mapClassifyRowsToFacts([classification, { ...classification }], ctx());
  assert.equal(identical.facts.length, 1);
  assert.equal(identical.facts[0]!.fact.validTo, null);
  const conflict = mapClassifyRowsToFacts([classification, { ...classification, 行业代码: '490101' }], ctx());
  assert.equal(conflict.facts.length, 0);
  assert.equal(conflict.rejections.length, 2);
  assert.equal(conflict.rejections[0]?.code, 'SW_CLASSIFY_DATE_CONFLICT');
});

test('I-06：分类链存在坏行时整股拒绝，不把过滤结果当作有效期延长', () => {
  const second = { ...classification, 计入日期ISO: '2021-07-30', 行业代码: '480301' };
  assert.ok(mapClassifyRowsToFacts([classification, second], ctx()).facts[0]!.fact.validTo);
  const broken = mapClassifyRowsToFacts([classification, { ...second, 行业代码: 'invalid' }], ctx(T1));
  assert.deepEqual(broken.facts, []);
  assert.deepEqual(broken.rejections.map((r) => r.code).sort(), ['SW_CLASSIFY_HISTORY_INCOMPLETE', 'SW_CLASSIFY_ROW_INVALID']);
});

test('I-06：并发覆盖共享XLS缓存时，行/字节身份不匹配在任何数据库访问前失败', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-sw-xls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'var'));
  await writeFile(join(dir, 'var/sw-StockClassifyUse_stock.xls'), 'later-capture');
  let queries = 0;
  const forbidden = async () => { queries++; throw new Error('unexpected DB access'); };
  const pool = { query: forbidden, connect: forbidden } as unknown as Pool;
  const adapter = new SwAdapter({ pool, store: new ArtifactStore(join(dir, 'artifacts')), repoRootPath: dir,
    execBridge: async () => ({ ok: true, rows: [classification], meta: {
      sha256: createHash('sha256').update('first-capture').digest('hex'), bytes: Buffer.byteLength('first-capture'), dataRows: 1,
    } }) as unknown as BridgeResponse });
  await assert.rejects(adapter.fetchClassifyXls(), /SW_XLS_ARTIFACT_MISMATCH/);
  assert.equal(queries, 0);
});

// 必须显式提供隔离测试 PG；绝不回退到应用默认业务数据库。
test('I-06 PostgreSQL：双池并发、修订、收据事务、旧封存不变', {
  skip: process.env.LYRA_REPAIR_TEST_PG ? false : 'NOT_RUN: LYRA_REPAIR_TEST_PG 未提供隔离 PostgreSQL',
}, async (t) => {
  const connectionString = process.env.LYRA_REPAIR_TEST_PG!;
  const schema = 'lyra_review_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString });
  const a = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const b = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const dir = await mkdtemp(join(tmpdir(), 'lyra-sw-integrity-'));
  t.after(async () => { await Promise.all([a.end(), b.end()]); await dropSchema(admin, schema); await admin.end(); await rm(dir, { recursive: true, force: true }); });
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  const store = new ArtifactStore(dir);
  let responseRows = [bar];
  const adapter = (pool: Pool, at: string) => new SwAdapter({ pool, store, now: () => new Date(at),
    execBridge: async () => ({ ok: true, rows: responseRows }) as unknown as BridgeResponse });
  const concurrent = await Promise.all([adapter(a, T0).fetchL1Daily('801780'), adapter(b, T1).fetchL1Daily('801780')]);
  assert.equal(concurrent.reduce((n, r) => n + r.insertedFactIds.length, 0), 1);
  assert.equal(concurrent.reduce((n, r) => n + r.identicalFactIds.length, 0), 1);
  assert.equal((await a.query('select count(*)::int as n from sw_fact_observation')).rows[0].n, 2);
  const originalId = concurrent.flatMap((r) => r.insertedFactIds)[0]!;
  const original = await loadFact(a, originalId);
  const seal = await buildSeal(a, store, { businessKey: { subjectKind: 'BROAD_ETF', subject: '510300', researchKind: 'WEEKLY', cutoff: T1 },
    cutoff: T1, factSelector: { subjectId: '801780', factKind: 'SW_INDEX_BAR' }, gaps: [], methodVersion: 'test', adapterVersion: 'sw@p1', planAuthVersion: 'test' });
  const sealed = await loadSealRow(a, seal.sealId);
  responseRows = [{ ...bar, 收盘: 11 }];
  const changed = await adapter(a, T2).fetchL1Daily('801780');
  assert.equal(changed.insertedFactIds.length, 1);
  assert.equal((await adapter(b, '2026-11-03T00:00:03Z').fetchL1Daily('801780')).identicalFactIds[0], changed.insertedFactIds[0]);
  assert.deepEqual(await loadFact(a, originalId), original);
  assert.deepEqual(await loadSealRow(a, seal.sealId), sealed);
  assert.equal((await verifySeal(a, store, seal.sealId)).ok, true);
  assert.equal((await asOfFacts(a, { subjectId: '801780', asOf: new Date(T1) }))[0]?.factId, originalId);
  assert.equal((await asOfFacts(a, { subjectId: '801780', asOf: new Date(T2) }))[0]?.factId, changed.insertedFactIds[0]);
  await assert.rejects(insertFact(a, { ...original!, firstObservedAt: T2 }), /FACT_CONFLICT/);
  await a.query(`create function reject_sw_receipt() returns trigger language plpgsql as $$
    begin if new.scope='synthetic-failure' then raise exception 'synthetic receipt failure'; end if; return new; end $$;
    create trigger reject_sw_receipt before insert on sw_fact_observation for each row execute function reject_sw_receipt()`);
  const before = (await a.query('select count(*)::int as n from pintime_fact')).rows[0].n;
  const failed = mapDailyRowsToFacts('801780', [{ ...bar, 收盘: 999 }], ctx('2026-11-03T00:00:04Z')).facts[0]!.fact;
  await assert.rejects(observeSwFact(b, failed, 'synthetic-failure', randomUUID()), /synthetic receipt failure/);
  assert.equal((await a.query('select count(*)::int as n from pintime_fact')).rows[0].n, before);
});
