/** Actual PostgreSQL only: explicit loopback URL, random owned schemas, synthetic CAS, no external model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString } from '../canonical.js';
import { KernelError, type ModelCallContract, type PlanAuthBudget } from '../contracts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { acquireLease, assertLease, keepLeaseAlive, releaseLease, renewLease } from './lease.js';
import { preparePermit, getPermit, tryMarkSent, retireUnknown } from './permit.js';
import { runModelCall, runPermittedCall, AJ_PERMIT_SPACE } from './executor.js';
import { completeWithCheckpoint, responseCheckpoint } from './response.js';
import { confirmRecovery } from './recovery.js';
import { BUDGET_GATE_KEY, releaseUnsentReservations } from './budget.js';
import { SimulatedTransport } from './transport.js';
import { syntheticConclusionInput } from '../research/research-test-helper.js';
import { runGateM } from '../research/gate-m.js';
import { freezeResearchSnapshot, publishResearchCheckpoint, withResearchClaim } from '../research/gate-m-checkpoint.js';
import { collectProcessMetrics } from '../schedule/metrics.js';

const url = process.env.LYRA_REPAIR_TEST_PG;
const gate = { skip: url ? false : 'NOT_RUN: explicit isolated LYRA_REPAIR_TEST_PG is unavailable' };
const baseBudget: PlanAuthBudget = { planAuthVersion: 'pr4-synthetic', maxInputBytes: 1000000, maxInFlight: 2,
  maxModelCallsPerWeek: 100, scopeLimits: { weekly: 100, postEvent: 100 } };
const versions = { methodVersion: 'method@test-pr4', adapterVersion: 'data@test-pr4', planAuthVersion: baseBudget.planAuthVersion };
const c = (subject = '600101', stage: 'A' | 'J' = 'A'): ModelCallContract => ({ businessKey: {
  subjectKind: 'STOCK', subject, researchKind: 'WEEKLY', cutoff: '2026-11-01T00:00:00.000Z' },
  stage, inputHash: 'a'.repeat(64), inputBytes: 100, methodVersion: versions.methodVersion,
  planAuthVersion: versions.planAuthVersion, deadline: new Date(Date.now() + 60000).toISOString() });

async function fixture(t: TestContext) {
  assert.ok(url); assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
  const schema = `pr4_k_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, application_name: schema, max: 8 });
  const other = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const root = await mkdtemp(join(tmpdir(), 'pr4-pg-cas-')), store = new ArtifactStore(root);
  await applySchema(admin, schema); await applySchema(admin, schema);
  t.after(async () => { await pool.end(); await other.end(); await dropSchema(admin, schema); await admin.end(); await rm(root, { recursive: true, force: true }); });
  return { pool, other, schema, store, root };
}
async function count(pool: Pool, table: string, where = 'true') {
  return Number((await pool.query(`select count(*) as n from ${table} where ${where}`)).rows[0].n);
}
async function childLease(schema: string) {
  const code = `import {Pool} from 'pg'; import {acquireLease} from './src/kernel/lease.ts';
    const p=new Pool({connectionString:process.env.LYRA_REPAIR_TEST_PG,options:'-c search_path='+process.env.LYRA_TEST_SCHEMA});
    try { console.log(JSON.stringify(await acquireLease(p,'kernel','synthetic-second-process',10000))); }
    catch(e) { console.log(JSON.stringify({code:e.code})); } finally { await p.end(); }`;
  return new Promise<{ code?: string; space?: string; holderId?: string; generation?: string; ttlMs?: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',code], { env: { ...process.env, LYRA_TEST_SCHEMA: schema }, stdio: ['ignore','pipe','pipe'] });
    let out = '', err = ''; child.stdout.on('data', (b: Buffer) => { out += b; }); child.stderr.on('data', (b: Buffer) => { err += b; });
    child.on('error', reject); child.on('close', (status) => { if (status !== 0) reject(new Error(`synthetic child exited ${status}: ${err}`)); else resolve(JSON.parse(out.trim())); });
  });
}

test('PR4 PG: two processes, live heartbeat beyond TTL, takeover fences old send and old completion', gate, async (t) => {
  const { pool, other, schema } = await fixture(t);
  const lease = await acquireLease(pool, 'kernel', 'synthetic-first', 600), keeper = keepLeaseAlive(pool, lease);
  const contract = c();
  try {
    await new Promise((r) => setTimeout(r, 900)); await keeper.assert();
    assert.equal((await childLease(schema)).code, 'EXECUTION_LOCK_HELD');
    await assert.rejects(runModelCall(other, { contract, budget: baseBudget, holderId: lease.holderId,
      simulated: true, modelFn: async () => assert.fail('holder string is not authority') }), { code: 'EXECUTION_LOCK_HELD' });
    const p = await preparePermit(pool, contract, baseBudget);
    await keeper.stop(); await pool.query("update kernel_lock set lease_until=clock_timestamp()-interval '1 second' where id=1");
    const next = await childLease(schema); assert.ok(next.generation); assert.notEqual(next.generation, lease.generation);
    await assert.rejects(renewLease(pool, lease), { code: 'EXECUTION_LOCK_HELD' });
    await assert.rejects(tryMarkSent(pool, p.permitId, 2, lease, baseBudget), { code: 'EXECUTION_LOCK_HELD' });
    await assert.rejects(releaseLease(pool, lease), { code: 'EXECUTION_LOCK_HELD' });
    await assert.rejects(completeWithCheckpoint(pool, lease, responseCheckpoint({ permitId: p.permitId, contract, simulated: true,
      input: {}, transport: {}, output: {} }), false), { code: 'EXECUTION_LOCK_HELD' });
    assert.equal((await getPermit(pool, p.permitId))!.state, 'PREPARED');
    assert.equal((await pool.query('select generation::text from kernel_lock')).rows[0].generation, next.generation);
  } finally { await keeper.stop(); }
});

test('PR4 PG: expiry while waiting for budget lock cannot cross SENT; contract replacement cannot bind old payload', gate, async (t) => {
  const { pool, other, schema } = await fixture(t);
  const lease = await acquireLease(pool, 'kernel', 'synthetic-wait', 1500), contract = c();
  const p = await preparePermit(pool, contract, baseBudget);
  const blocker = await other.connect(); await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock($1::bigint)', [BUDGET_GATE_KEY]);
  const pending = assert.rejects(tryMarkSent(pool, p.permitId, 2, lease, baseBudget, contract), { code: 'EXECUTION_LOCK_HELD' });
  const start = Date.now();
  while (true) {
    const waiting = await other.query(`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where a.application_name=$1 and l.locktype='advisory' and not l.granted and l.objid=$2::oid`, [schema, BUDGET_GATE_KEY]);
    if (waiting.rowCount) break;
    if (Date.now()-start > 1000) { await blocker.query('rollback'); blocker.release(); assert.fail('Never observed the intended budget-lock wait'); }
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 1600)); await blocker.query('commit'); blocker.release(); await pending;
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 0); assert.equal(await count(pool, 'execution_budget_reservation'), 0);
  const next = await acquireLease(pool, 'kernel', 'synthetic-next');
  const replaced = await preparePermit(pool, { ...contract, inputHash: 'b'.repeat(64) }, baseBudget);
  assert.equal(replaced.permitId, p.permitId);
  await assert.rejects(tryMarkSent(pool, p.permitId, 2, next, baseBudget, contract), { code: 'PERMIT_CONTRACT_CONFLICT' });
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 0);
});

test('PR4 PG: pair reservations, concurrent keys, UNKNOWN counts, original authorization and cross-pool chain ownership', gate, async (t) => {
  const { pool, other } = await fixture(t), lease = await acquireLease(pool, 'kernel');
  const budget = { ...baseBudget, maxModelCallsPerWeek: 2, scopeLimits: { weekly: 2, postEvent: 2 } };
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => { release = r; }), sent = new Promise<void>((r) => { started = r; });
  const first = c();
  const a = runModelCall(pool, { contract: first, budget, lease, simulated: true, modelFn: async () => { started(); await waiting; throw new KernelError('TIMEOUT'); } });
  const rejected = assert.rejects(a, { code: 'TIMEOUT' }); await sent;
  await assert.rejects(runModelCall(other, { contract: c('600102'), budget, lease, simulated: true, modelFn: async () => assert.fail('budget') }), { code: 'MODEL_CALL_BUDGET_EXCEEDED' });
  assert.equal(await count(pool, 'execution_budget_reservation', "state='HELD'"), 1);
  release(); await rejected; await releaseUnsentReservations(pool, first.businessKey, lease);
  assert.equal(await count(pool, 'exec_permit', "state='UNKNOWN'"), 1);
  await assert.rejects(runModelCall(pool, { contract: c('600103'), budget, lease, simulated: true, modelFn: async () => assert.fail('one slot cannot start pair') }), { code: 'MODEL_CALL_BUDGET_EXCEEDED' });
  await assert.rejects(runModelCall(pool, { contract: c('600104'), budget: { ...budget, maxModelCallsPerWeek: 99 }, lease, simulated: true, modelFn: async () => assert.fail('authorization') }), { code: 'PLAN_AUTH_MISMATCH' });
  const unknown = (await pool.query("select permit_id from exec_permit where state='UNKNOWN'")).rows[0].permit_id;
  await retireUnknown(pool, unknown, 'synthetic-test-owner');
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 1, 'retirement does not erase charged attempts');
  let finish!: () => void; const hold = new Promise<void>((r) => { finish = r; });
  let entered!: () => void; const entry = new Promise<void>((r) => { entered = r; });
  const chain = withResearchClaim(pool, lease, c('600105').businessKey, async () => { entered(); await hold; }); await entry;
  await assert.rejects(withResearchClaim(other, lease, c('600105').businessKey, async () => assert.fail('duplicate')), { code: 'RESEARCH_ALREADY_RUNNING' });
  finish(); await chain;
});

test('PR4 PG: paused full-queue waiter cannot close the new generation SENT', gate, async (t) => {
  const { pool, other } = await fixture(t), old = await acquireLease(pool, 'kernel');
  const budget = baseBudget, contract = { ...c('600103'), deadline: new Date(Date.now()+3000).toISOString() };
  const blocker = await preparePermit(pool, c('600101'), budget);
  const secondBlocker = await preparePermit(pool, c('600102'), budget);
  await tryMarkSent(pool, blocker.permitId, 2, old, budget);
  await tryMarkSent(pool, secondBlocker.permitId, 2, old, budget);
  let resume!: () => void, paused!: () => void;
  const hold = new Promise<void>((r) => { resume = r; }), reached = new Promise<void>((r) => { paused = r; });
  const space = { ...AJ_PERMIT_SPACE, tryMarkSent: async (...args: Parameters<typeof tryMarkSent>) => {
    const result = await tryMarkSent(...args);
    assert.equal(result.kind, 'IN_FLIGHT_FULL'); paused(); await hold; return result;
  } };
  const rejected = assert.rejects(runPermittedCall(space, pool, { contract, budget, lease: old, simulated: true,
    modelFn: async () => assert.fail('Old waiter must never dispatch') }), { code: 'EXECUTION_LOCK_HELD' });
  await reached;
  await other.query("update kernel_lock set lease_until=clock_timestamp()-interval '1 second'");
  const next = await acquireLease(other, 'kernel'); await confirmRecovery(other, 'synthetic-takeover-owner');
  const waiting = (await pool.query("select permit_id from exec_permit where subject='600103'")).rows[0].permit_id;
  assert.equal((await tryMarkSent(other, waiting, 2, next, budget, contract)).kind, 'SENT');
  await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(contract.deadline)-Date.now()+30)));
  resume(); await rejected;
  const row = (await other.query('select state,execution_generation::text from exec_permit where permit_id=$1', [waiting])).rows[0];
  assert.equal(row.state, 'SENT'); assert.equal(row.execution_generation, next.generation);
});

test('PR4 PG: expired full waiter cannot close a replacement PREPARED in the same lease generation', gate, async (t) => {
  const { pool, other } = await fixture(t), lease = await acquireLease(pool, 'kernel');
  for (const subject of ['600101', '600102']) {
    const row = await preparePermit(pool, c(subject), baseBudget);
    await tryMarkSent(pool, row.permitId, 2, lease, baseBudget);
  }
  const contract = { ...c('600103'), deadline: new Date(Date.now()+1500).toISOString() };
  let paused!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { paused = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const space = { ...AJ_PERMIT_SPACE, tryMarkSent: async (...args: Parameters<typeof tryMarkSent>) => {
    const result = await tryMarkSent(...args); assert.equal(result.kind, 'IN_FLIGHT_FULL');
    paused(); await resume; return result;
  } };
  const rejected = assert.rejects(runPermittedCall(space, pool, { contract, budget: baseBudget, lease, simulated: true,
    modelFn: async () => assert.fail('Stale request must not dispatch') }), { code: 'PERMIT_CONTRACT_CONFLICT' });
  await reached;
  const replacement = { ...contract, inputHash: 'b'.repeat(64), deadline: new Date(Date.now()+60000).toISOString() };
  const row = await preparePermit(other, replacement, baseBudget);
  await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(contract.deadline)-Date.now()+30)));
  release(); await rejected;
  const kept = (await getPermit(other, row.permitId))!;
  assert.equal(kept.state, 'PREPARED'); assert.equal(kept.sentAt, null);
  assert.equal(kept.contract.inputHash, replacement.inputHash); assert.equal(kept.contract.deadline, replacement.deadline);
});

test('PR4 PG: partial A/J failure consumes both sends; retries and preflight refusals remain separate attempts in metrics', gate, async (t) => {
  const { pool } = await fixture(t), lease = await acquireLease(pool, 'kernel');
  await pool.query(await readFile(new URL('../db/events-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../db/schedule-migration.sql', import.meta.url), 'utf8'));
  const budget = { ...baseBudget, maxModelCallsPerWeek: 2, scopeLimits: { weekly: 2, postEvent: 0 } }, contract = c();
  const invoke = (call: ModelCallContract, b = budget) => runModelCall(pool, { contract: call, budget: b, lease, simulated: true,
    modelFn: async () => { if (call.stage === 'J') throw new KernelError('MODEL_OUTPUT_SCHEMA_INVALID'); return 'synthetic'; } });
  await assert.rejects(invoke(contract, { ...budget, maxInputBytes: 1 }), { code: 'INPUT_OVER_BUDGET' });
  await invoke(contract);
  await assert.rejects(invoke(contract), { code: 'BUSINESS_KEY_ALREADY_SENT' });
  await assert.rejects(invoke({ ...contract, stage: 'J' }), { code: 'MODEL_OUTPUT_SCHEMA_INVALID' });
  await releaseUnsentReservations(pool, contract.businessKey, lease);
  await assert.rejects(invoke(c('600102')), { code: 'MODEL_CALL_BUDGET_EXCEEDED' });
  await assert.rejects(runModelCall(pool, { contract: c('600103'), budget, lease, simulated: true,
    preflight: () => { throw new KernelError('MODEL_INPUT_UNBOUND'); }, modelFn: async () => assert.fail('preflight') }), { code: 'MODEL_INPUT_UNBOUND' });
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 2);
  assert.equal(await count(pool, 'execution_attempt'), 6);
  assert.equal(await count(pool, 'execution_attempt', "fail_code='INPUT_OVER_BUDGET'"), 1, 'Retry did not erase first refusal');
  const time = (await pool.query("select date_trunc('week',clock_timestamp() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' as start")).rows[0].start as Date;
  const metrics = await collectProcessMetrics(pool, { weekStart: time.toISOString(), weekEnd: new Date(time.getTime()+7*86400000).toISOString() });
  assert.equal(metrics.weeklyModelCalls, 2); assert.equal(metrics.postEventModelCalls, 0);
  assert.deepEqual(metrics.detail.attempts, { observed: 6, unfinished: 0, returned: 1, rejected: 5 });
  assert.equal(metrics.detail.permits.sendOnceRejections, 1);
  await assert.rejects(pool.query("update execution_attempt set fail_code='forged'"), /EXECUTION_ATTEMPT_IMMUTABLE/);
  // Both scope ceilings are independently enforced even when the plan limit is not exhausted.
  for (const scope of ['WEEKLY', 'POST_EVENT'] as const) {
    const scoped = { ...budget, maxModelCallsPerWeek: 100, planAuthVersion: `synthetic-scope-${scope}` };
    await assert.rejects(invoke({ ...c('600104'), planAuthVersion: scoped.planAuthVersion,
      businessKey: { ...c('600104').businessKey, researchKind: scope } }, scoped), { code: 'MODEL_CALL_BUDGET_EXCEEDED' });
  }
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 2);
});

test('PR4 PG: takeover of an unobserved SENT blocks new keys; resolver labels cannot invent success', gate, async (t) => {
  const { pool } = await fixture(t); const old = await acquireLease(pool, 'kernel');
  const p = await preparePermit(pool, c(), baseBudget); await tryMarkSent(pool, p.permitId, 2, old, baseBudget);
  await releaseLease(pool, old); const next = await acquireLease(pool, 'kernel');
  await assert.rejects(runModelCall(pool, { contract: c('600102'), budget: baseBudget, lease: next, simulated: true,
    modelFn: async () => assert.fail('must reconcile') }), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  await assert.rejects(confirmRecovery(pool, 'synthetic-owner', () => ({ outcome: 'SUCCEEDED' })), { code: 'RECOVERY_EVIDENCE_REQUIRED' });
  await confirmRecovery(pool, 'synthetic-owner'); assert.equal((await getPermit(pool, p.permitId))!.state, 'UNKNOWN');
  assert.equal(await count(pool, 'exec_permit', 'sent_at is not null'), 1);
});

test('PR4 PG: checkpoint write failure rolls back SUCCEEDED and cannot be retried as a new send', gate, async (t) => {
  const { pool } = await fixture(t), lease = await acquireLease(pool, 'kernel'), contract = c(); let calls = 0;
  await pool.query(`create function fail_cp() returns trigger language plpgsql as $$ begin
    if new.response_checkpoint is not null then raise exception 'SYNTHETIC_CHECKPOINT_IO'; end if; return new; end $$;
    create trigger fail_cp before update on exec_permit for each row execute function fail_cp()`);
  const invoke = () => runModelCall(pool, { contract, budget: baseBudget, lease, simulated: true,
    checkpoint: { input: { synthetic: true }, transport: { simulated: true } }, modelFn: async () => { calls++; return { value: 1 }; } });
  await assert.rejects(invoke(), { code: 'RESULT_PERSISTENCE_UNKNOWN' });
  const row = (await pool.query('select * from exec_permit')).rows[0]; assert.equal(row.state, 'UNKNOWN'); assert.equal(row.response_checkpoint, null);
  await assert.rejects(invoke(), { code: 'BUSINESS_KEY_ALREADY_SENT' }); assert.equal(calls, 1);
});

test('PR4 PG: A/J/before-publication crashes recover original inputs, receipts and result; no resend', gate, async (t) => {
  for (const fault of ['AFTER_A', 'AFTER_J', 'BEFORE_COMMIT'] as const) await t.test(fault, async (sub) => {
    const { pool, store } = await fixture(sub), contract = c();
    const input = syntheticConclusionInput(contract.businessKey, versions), pkg = input.researchInput;
    const ref = await store.put(Buffer.from(canonicalJsonString(pkg)), 'application/json', pkg.cutoff);
    let builds = 0, calls = 0, stop = true;
    const inner = new SimulatedTransport();
    const transport = { describe: () => ({ provider: 'synthetic-AJ', simulated: true, modelId: 'fixed', effort: 'fixed' }),
      preflight: (call: ModelCallContract, payload: unknown) => { inner.preflight(call, payload); if (fault === 'AFTER_A' && stop && call.stage === 'J') throw new KernelError('SYNTHETIC_STOP'); },
      dispatch: async (call: ModelCallContract, payload: unknown) => { calls++; return inner.dispatch(call, payload); } };
    if (fault === 'AFTER_J') {
      const put = store.put.bind(store);
      sub.mock.method(store, 'put', async (...args: Parameters<ArtifactStore['put']>) => {
        if (stop && new TextDecoder().decode(args[0]).includes('TRADITIONAL_RESEARCH_TRACE_V2')) throw new Error('SYNTHETIC_BEFORE_PUBLISH');
        return put(...args);
      });
    }
    if (fault === 'BEFORE_COMMIT') await pool.query(`create function fail_publish() returns trigger language plpgsql as $$ begin
      if new.conclusion_id is not null then raise exception 'SYNTHETIC_BEFORE_COMMIT'; end if; return new; end $$;
      create trigger fail_publish before update on research_execution for each row execute function fail_publish()`);
    const deps = { execPool: pool, dataPool: pool, store, transport, assembleInput: async () => { builds++; return { package: pkg, artifactRef: ref, inputHash: pkg.inputHash, inputBytes: ref.bytes }; } };
    const opts = { subject: pkg.businessKey.subject, cutoff: pkg.cutoff, execute: true, validatePackage: false, versions, budget: baseBudget,
      deadline: new Date(Date.now() + 60000).toISOString().replace('Z', '+00:00') };
    await assert.rejects(runGateM(deps, opts)); assert.equal(await count(pool, 'conclusion'), 0);
    assert.equal(await count(pool, 'exec_permit', "state='SUCCEEDED'"), fault === 'AFTER_A' ? 1 : 2);
    stop = false; if (fault === 'BEFORE_COMMIT') await pool.query('drop trigger fail_publish on research_execution');
    await assert.rejects(runGateM({ ...deps, transport: { ...transport, describe: () => ({ ...transport.describe(), modelId: 'different' }) } }, opts), { code: 'RESEARCH_CHECKPOINT_CONFLICT' });
    const result = await runGateM(deps, opts); assert.equal(result.mode, 'execute'); if (result.mode !== 'execute') assert.fail();
    assert.equal(calls, 2); assert.equal(builds, 1); assert.equal(await count(pool, 'conclusion'), 1);
    const again = await runGateM(deps, opts); assert.equal(again.mode, 'execute'); if (again.mode !== 'execute') assert.fail();
    assert.equal(again.conclusion.conclusionHash, result.conclusion.conclusionHash); assert.equal(calls, 2);
    await assert.rejects(pool.query("update research_execution set snapshot_hash='forged'"), /RESEARCH_CHECKPOINT_IMMUTABLE/);
    await assert.rejects(pool.query("update exec_permit set response_hash='forged' where stage='A'"), /EXECUTION_CHECKPOINT_IMMUTABLE/);
  });
});

test('PR4 PG: publication cannot bypass missing A/J receipts; budget refusal row remains never-sent', gate, async (t) => {
  const { pool, store } = await fixture(t), lease = await acquireLease(pool, 'kernel'), contract = c();
  const input = syntheticConclusionInput(contract.businessKey, versions), pkg = input.researchInput;
  const ref = await store.put(Buffer.from(canonicalJsonString(pkg)), 'application/json', pkg.cutoff);
  await freezeResearchSnapshot(pool, store, lease, contract.businessKey, {}, async () => ({ version: 1, deadline: contract.deadline,
    assembled: { package: pkg, artifactRef: ref, inputHash: pkg.inputHash, inputBytes: ref.bytes }, metadata: null }));
  await assert.rejects(publishResearchCheckpoint(pool, store, lease, input), { code: 'RESEARCH_CHECKPOINT_CONFLICT' });
  assert.equal(await count(pool, 'conclusion'), 0);
  await assert.rejects(runModelCall(pool, { contract, budget: { ...baseBudget, maxInputBytes: 1 }, lease, simulated: true,
    modelFn: async () => assert.fail('input rejected') }), { code: 'INPUT_OVER_BUDGET' });
  assert.equal(await count(pool, 'exec_permit', "state='FAILED' and sent_at is null and fail_code='INPUT_OVER_BUDGET'"), 1);
  await assertLease(pool, lease);
});
