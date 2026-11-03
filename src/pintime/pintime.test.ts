import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import { createPool } from '../db/pool.js';
import { PintimeError } from '../db/pintime.js';
import { ArtifactError, ArtifactStore } from '../artifacts/store.js';
import { asOfFacts, insertFact, loadFact, type FactSelector } from './facts.js';
import { buildSeal, readSeal, verifySeal } from './seal.js';
import { assertNoLeakage } from './leakage.js';

// ===== 隔离运行环境：独立 schema + 临时原件目录 =====

const SCHEMA = `w2_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;
let artifactDir: string;
let store: ArtifactStore;
let DEFAULT_ARTIFACT = 'ab'.repeat(32); // before() 中替换为真实原件哈希

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
  artifactDir = await mkdtemp(join(tmpdir(), 'lyra-w2-artifacts-'));
  store = new ArtifactStore(artifactDir);
  DEFAULT_ARTIFACT = (
    await store.put(new TextEncoder().encode('default-test-artifact'), 'text/plain', '2026-01-01T00:00:00Z')
  ).sha256;
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
  await rm(artifactDir, { recursive: true, force: true });
});

// ===== 夹具 =====

const D0 = new Date('2026-03-10T00:00:00Z'); // 断言截点（任选历史日期）
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number): string => new Date(D0.getTime() + offsetDays * DAY).toISOString();

let seq = 0;
function makeFact(overrides: Partial<TimePointFact>): TimePointFact {
  seq += 1;
  return {
    factId: `w2-fact-${SCHEMA}-${seq}`,
    subjectType: 'STOCK',
    subjectId: '600000',
    factKind: 'FINANCIAL',
    typedValue: { seq },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: iso(-30),
    availableAt: iso(-1),
    supersedesFactId: null,
    artifactSha256: DEFAULT_ARTIFACT,
    adapterVersion: 'av-w2-test',
    ...overrides,
  };
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof PintimeError || error instanceof ArtifactError,
      `expected named error, got ${String(error)}`,
    );
    assert.equal((error as { code: string }).code, code);
    return;
  }
  assert.fail(`expected error ${code}, but call succeeded`);
}

function sealInput(selector: FactSelector, cutoff: string, gaps: string[] = []) {
  return {
    businessKey: { subjectKind: 'STOCK' as const, subject: selector.subjectId ?? '600000', researchKind: 'WEEKLY' as const, cutoff },
    cutoff,
    factSelector: selector,
    gaps,
    methodVersion: 'mv-w2-test',
    adapterVersion: 'av-w2-test',
    planAuthVersion: 'pv-w2-test',
  };
}

// ===== insertFact：幂等与冲突 =====

test('insertFact: INSERTED, ALREADY_INSERTED_IDENTICAL, FACT_CONFLICT', async () => {
  const fact = makeFact({
    subjectId: '600099', // 独立 subject，避免与 as-of 过滤用例互相污染
    factId: 'idem-1',
    typedValue: { period: '2025Q3', revenue: '123.45' },
    availableAt: iso(-1),
  });
  assert.equal(await insertFact(pool, fact), 'INSERTED');
  assert.equal(await insertFact(pool, fact), 'ALREADY_INSERTED_IDENTICAL'); // 同内容幂等
  const kept = await loadFact(pool, 'idem-1');
  assert.deepEqual(kept?.typedValue, { period: '2025Q3', revenue: '123.45' });

  await expectCode(
    () => insertFact(pool, { ...fact, typedValue: { period: '2025Q3', revenue: '999.99' } }),
    'FACT_CONFLICT', // 同 factId 异内容：修正必须走 supersedes 新增，不覆盖
  );
  await expectCode(() => insertFact(pool, { ...fact, availableAt: iso(0) }), 'FACT_CONFLICT');
  await expectCode(
    () => insertFact(pool, { ...fact, factId: 'sup-self', supersedesFactId: 'sup-self' }),
    'INVALID_FACT',
  );
  await expectCode(
    () => insertFact(pool, { ...fact, factId: 'sup-dangling', supersedesFactId: 'no-such-fact' }),
    'FACT_SUPERSEDES_MISSING',
  );
});

// ===== as-of 过滤：availableAt 之后的事实被挡 =====

test('asOfFacts excludes facts available after cutoff', async () => {
  const past = makeFact({ subjectId: '600001', factId: 'asof-past', availableAt: iso(-1) });
  const future = makeFact({ subjectId: '600001', factId: 'asof-future', availableAt: iso(1) }); // 故意埋入的未来事实
  await insertFact(pool, past);
  await insertFact(pool, future);

  const atD0 = await asOfFacts(pool, { subjectId: '600001', asOf: D0 });
  assert.deepEqual(
    atD0.map((fact) => fact.factId),
    ['asof-past'], // 未来事实被 as-of 过滤挡住（POINT-IN-TIME §8）
  );
  const after = await asOfFacts(pool, { subjectId: '600001', asOf: new Date(D0.getTime() + 2 * DAY) });
  assert.deepEqual(
    after.map((fact) => fact.factId).sort(),
    ['asof-future', 'asof-past'],
  );
});

test('asOfFacts boundary: availableAt == cutoff is readable, not a violation', async () => {
  const edge = makeFact({ subjectId: '600005', factId: 'edge-exact', factKind: 'DISCLOSURE_SCHEDULE', availableAt: D0.toISOString() });
  await insertFact(pool, edge);
  const read = await asOfFacts(pool, { subjectId: '600005', asOf: D0 });
  assert.deepEqual(
    read.map((fact) => fact.factId),
    ['edge-exact'],
  );
  assert.equal(new Date(read[0]?.availableAt ?? '').getTime(), D0.getTime());
  const violations = await assertNoLeakage(pool, { factSelector: { subjectId: '600005' }, asOf: D0 });
  assert.equal(violations.length, 0);
});

// ===== supersedes 链时点解析：D 前旧版有效、D 后新版生效 =====

test('supersedes chain resolves to latest version valid at asOf', async () => {
  const a = makeFact({ subjectId: '000002', factKind: 'ANNOUNCEMENT', factId: 'sup-a', typedValue: { v: 1 }, availableAt: iso(-2) });
  const b = makeFact({ subjectId: '000002', factKind: 'ANNOUNCEMENT', factId: 'sup-b', typedValue: { v: 2 }, availableAt: iso(1), supersedesFactId: 'sup-a' });
  const c = makeFact({ subjectId: '000002', factKind: 'ANNOUNCEMENT', factId: 'sup-c', typedValue: { v: 3 }, availableAt: iso(5), supersedesFactId: 'sup-b' });
  await insertFact(pool, a);
  await insertFact(pool, b);
  await insertFact(pool, c);

  const before = await asOfFacts(pool, { subjectId: '000002', asOf: new Date(D0.getTime() - DAY) });
  assert.deepEqual(before.map((fact) => fact.factId), ['sup-a']); // D 前旧版有效
  const mid = await asOfFacts(pool, { subjectId: '000002', asOf: new Date(D0.getTime() + 2 * DAY) });
  assert.deepEqual(mid.map((fact) => fact.factId), ['sup-b']); // 新版生效，被 supersede 的旧版不再返回
  const late = await asOfFacts(pool, { subjectId: '000002', asOf: new Date(D0.getTime() + 6 * DAY) });
  assert.deepEqual(late.map((fact) => fact.factId), ['sup-c']);
  const first = mid[0];
  assert.deepEqual(first?.typedValue, { v: 2 });
});

test('asOfFacts optional filters select by subjectId / factKind / subjectType', async () => {
  await insertFact(pool, makeFact({ subjectId: '600006', factKind: 'INDUSTRY_CLASS_VERSION', factId: 'flt-1' }));
  await insertFact(pool, makeFact({ subjectId: '600006', factKind: 'ADJUST_FACTOR', factId: 'flt-2' }));
  await insertFact(pool, makeFact({ subjectId: '600007', factKind: 'INDUSTRY_CLASS_VERSION', factId: 'flt-3' }));

  const bySubject = await asOfFacts(pool, { subjectId: '600006', asOf: D0 });
  assert.deepEqual(bySubject.map((fact) => fact.factId).sort(), ['flt-1', 'flt-2']);
  const byKind = await asOfFacts(pool, { factKind: 'INDUSTRY_CLASS_VERSION', asOf: D0 });
  assert.deepEqual(byKind.map((fact) => fact.factId).sort(), ['flt-1', 'flt-3']);
  const byType = await asOfFacts(pool, { subjectType: 'ETF', asOf: D0 });
  assert.equal(byType.length, 0); // 夹具全部为 STOCK
});

// ===== buildSeal / readSeal / verifySeal =====

test('buildSeal collects as-of facts and artifact refs; manifestHash recomputes; verifySeal green', async () => {
  const a1 = await store.put(new TextEncoder().encode('artifact-one-bytes'), 'application/pdf', iso(-3));
  const a2 = await store.put(new TextEncoder().encode('artifact-two-bytes'), 'text/html', iso(-3));
  await insertFact(pool, makeFact({ subjectId: '600003', factId: 'seal-f1', artifactSha256: a1.sha256, availableAt: iso(-1) }));
  await insertFact(pool, makeFact({ subjectId: '600003', factId: 'seal-f2', artifactSha256: a1.sha256, availableAt: iso(-2) }));
  await insertFact(pool, makeFact({ subjectId: '600003', factId: 'seal-f3', artifactSha256: a2.sha256, availableAt: iso(-1) }));
  await insertFact(pool, makeFact({ subjectId: '600003', factId: 'seal-future', artifactSha256: a2.sha256, availableAt: iso(1) })); // 截点后不可见

  const seal = await buildSeal(pool, store, sealInput({ subjectId: '600003' }, D0.toISOString(), ['行业分类表 2026Q1 版本未取得']));
  assert.deepEqual([...seal.factIds].sort(), ['seal-f1', 'seal-f2', 'seal-f3']); // 未来事实不进封存（不得原地 sort：数组顺序已进哈希）
  assert.equal(seal.artifactRefs.length, 2); // 同哈希去重
  assert.deepEqual(seal.gaps, ['行业分类表 2026Q1 版本未取得']);
  assert.deepEqual(seal.businessKey, {
    subjectKind: 'STOCK',
    subject: '600003',
    researchKind: 'WEEKLY',
    cutoff: D0.toISOString(),
  });
  const { manifestHash, ...core } = seal;
  assert.equal(canonicalSha256(core), manifestHash); // 哈希身份可独立重算

  const read = await readSeal(pool, seal.sealId);
  assert.deepEqual(read, seal);

  const verify = await verifySeal(pool, store, seal.sealId);
  assert.equal(verify.ok, true);
  assert.equal(verify.factsChecked, 3);
  assert.equal(verify.artifactsChecked, 2);
});

test('verifySeal detects DB row tampering -> SEAL_HASH_MISMATCH', async () => {
  const art = await store.put(new TextEncoder().encode('tamper-db-artifact'), 'text/plain', iso(-3));
  await insertFact(pool, makeFact({ subjectId: '600010', factId: 'tamper-db-f1', artifactSha256: art.sha256, availableAt: iso(-1) }));
  const seal = await buildSeal(pool, store, sealInput({ subjectId: '600010' }, iso(-1)));
  await verifySeal(pool, store, seal.sealId); // 先确认绿
  await pool.query('update seal_manifest set gaps = $2::jsonb where seal_id = $1', [seal.sealId, JSON.stringify(['篡改'])]);
  await expectCode(() => verifySeal(pool, store, seal.sealId), 'SEAL_HASH_MISMATCH');
});

test('verifySeal detects store tampering -> HASH_MISMATCH from store', async () => {
  const art = await store.put(new TextEncoder().encode('tamper-store-artifact'), 'text/plain', iso(-3));
  await insertFact(pool, makeFact({ subjectId: '600011', factId: 'tamper-store-f1', artifactSha256: art.sha256, availableAt: iso(-1) }));
  const seal = await buildSeal(pool, store, sealInput({ subjectId: '600011' }, iso(-1)));
  const copyDir = await mkdtemp(join(tmpdir(), 'lyra-w2-tampered-'));
  try {
    await cp(artifactDir, copyDir, { recursive: true });
    const hash = seal.artifactRefs[0]?.sha256 as string;
    const target = join(copyDir, hash.slice(0, 2), hash);
    await writeFile(target, Buffer.concat([await readFile(target), Buffer.from('X')])); // 白盒篡改副本
    const tamperedStore = new ArtifactStore(copyDir);
    await expectCode(() => verifySeal(pool, tamperedStore, seal.sealId), 'HASH_MISMATCH');
  } finally {
    await rm(copyDir, { recursive: true, force: true });
  }
});

test('verifySeal missing seal -> SEAL_MISSING; buildSeal with absent artifact -> ARTIFACT_MISSING', async () => {
  await expectCode(() => verifySeal(pool, store, 'no-such-seal'), 'SEAL_MISSING');
  await insertFact(pool, makeFact({ subjectId: '600008', factId: 'ghost-artifact', artifactSha256: 'cd'.repeat(32) }));
  await expectCode(() => buildSeal(pool, store, sealInput({ subjectId: '600008' }, iso(-1))), 'ARTIFACT_MISSING');
  await expectCode(() => buildSeal(pool, store, sealInput({ subjectId: '600008' }, 'not-a-date')), 'INVALID_SEAL_INPUT');
});

// ===== buildSeal 幂等复用（W26：同材料同键不追加重复行）=====

test('buildSeal idempotent reuse: same materials -> same sealId one row; new fact -> new seal; new cutoff -> new row', async () => {
  const art = (await store.put(new TextEncoder().encode('idem-seal-artifact'), 'text/plain', iso(-5))).sha256;
  const subject = '600020';
  await insertFact(pool, makeFact({ subjectId: subject, factId: 'idem-seal-f1', artifactSha256: art, availableAt: iso(-1) }));
  const countSealRows = async (): Promise<number> =>
    Number(
      (await pool.query<{ n: string }>('select count(*)::text as n from seal_manifest where business_key->>\'subject\' = $1', [subject]))
        .rows[0]?.n,
    );

  // 同材料两次 build → 同 sealId、库内一行；第二次带 reused 标记
  const first = await buildSeal(pool, store, sealInput({ subjectId: subject }, iso(2)));
  assert.equal(first.reused, undefined, '首次封存非复用');
  const second = await buildSeal(pool, store, sealInput({ subjectId: subject }, iso(2)));
  assert.equal(second.sealId, first.sealId, '同材料幂等复用同 sealId');
  assert.equal(second.reused, true);
  assert.equal(await countSealRows(), 1, '库内一行（不追加同键重复）');
  // 复用返回的仍是完整 manifest：与库内行全等（除调用期标记），manifestHash 可独立重算
  const row = await readSeal(pool, first.sealId);
  const { reused, ...content } = second;
  assert.deepEqual(row, content);
  const { manifestHash, reused: _reused, ...core } = second;
  assert.equal(canonicalSha256(core), manifestHash, 'reused 不进 manifestHash');

  // 材料变化（多一个截点前可见事实）→ 新 seal、两行
  await insertFact(pool, makeFact({ subjectId: subject, factId: 'idem-seal-f2', artifactSha256: art, availableAt: iso(0) }));
  const third = await buildSeal(pool, store, sealInput({ subjectId: subject }, iso(2)));
  assert.notEqual(third.sealId, first.sealId, '材料真实变化 → 新封存');
  assert.equal(third.reused, undefined);
  assert.equal(await countSealRows(), 2);

  // 不同 cutoff → 新行（业务键不同，即使事实集相同）
  const fourth = await buildSeal(pool, store, sealInput({ subjectId: subject }, iso(3)));
  assert.notEqual(fourth.sealId, third.sealId);
  assert.equal(await countSealRows(), 3);

  // 复用不改写历史：最早封存仍可校验
  const verify = await verifySeal(pool, store, first.sealId);
  assert.equal(verify.ok, true);
  assert.equal(verify.factsChecked, 1);
});

// ===== assertNoLeakage =====

test('leakage: planted future fact is blocked; read-back at D passes with zero violations', async () => {
  await insertFact(pool, makeFact({ subjectId: '600004', factId: 'leak-past', availableAt: iso(-1) }));
  await insertFact(pool, makeFact({ subjectId: '600004', factId: 'leak-future', availableAt: iso(1) })); // 故意埋入

  const selector = { subjectId: '600004' };
  const readBack = await asOfFacts(pool, { ...selector, asOf: D0 });
  assert.deepEqual(readBack.map((fact) => fact.factId), ['leak-past']); // 未来事实被挡

  const violations = await assertNoLeakage(pool, { factSelector: selector, asOf: D0 });
  assert.deepEqual(violations, []); // 空 = 通过：读回内容无 availableAt > D 的信息
});

test('leakage: violation fires when a sealed set contains post-cutoff facts', async () => {
  // 封存时点晚于断言截点：seal（cutoff=D+5）包含“相对 D 的未来事实”，按 D 校验必须报 violation。
  const seal = await buildSeal(pool, store, sealInput({ subjectId: '600004' }, iso(5)));
  const violations = await assertNoLeakage(pool, { sealId: seal.sealId, asOf: D0 });
  assert.ok(violations.length >= 1);
  const leaked = violations.find((violation) => violation.factId === 'leak-future');
  assert.ok(leaked !== undefined, 'planted future fact must be reported');
  assert.equal(leaked.reason, 'FACT_AFTER_CUTOFF');
  assert.equal(leaked.target, 'SEAL');

  const clean = await assertNoLeakage(pool, { sealId: seal.sealId, asOf: new Date(D0.getTime() + 5 * DAY) });
  assert.deepEqual(clean, []); // 按其自身截点校验：通过
});

test('leakage: argument validation and missing seal are named errors', async () => {
  await expectCode(
    () => assertNoLeakage(pool, { factSelector: { subjectId: '600004' }, sealId: 'also-given', asOf: D0 }),
    'INVALID_LEAKAGE_TARGET',
  );
  await expectCode(() => assertNoLeakage(pool, { asOf: D0 }), 'INVALID_LEAKAGE_TARGET');
  await expectCode(() => assertNoLeakage(pool, { sealId: 'no-such-seal', asOf: D0 }), 'SEAL_MISSING');
});
