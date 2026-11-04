/** Pure execution/transport contracts. In-memory ports here are explicitly NOT PostgreSQL evidence. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { KernelError, type ModelCallContract, type ModelPermit, type PlanAuthBudget } from '../contracts.js';
import { runPermittedCall, type PermitSpace } from './executor.js';
import { contractHash } from './response.js';
import { keepLeaseAlive } from './lease.js';
import { tryMarkSent } from './permit.js';
import { srTryMarkSent } from '../stock-research/store.js';
import { preflightTransport, SimulatedTransport, UnauthorizedTransport } from './transport.js';
import { runNightlyCli } from '../schedule/nightly.js';
import { SolTransport } from './sol-transport.js';
import { budgetGuard } from '../schedule/queue.js';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { syntheticConclusionInput } from '../research/research-test-helper.js';
import { buildARequest } from '../research/requests.js';
import { coalesceResearchRun, verifyResearchSnapshot } from '../research/gate-m-checkpoint.js';
import { immutablePrior } from '../research/inheritance.js';
import { requestKey } from '../stock-research/store-requests.js';
import { RealSrTransport, realTransportConfigFromEnv } from '../stock-research/transport.js';

const budget: PlanAuthBudget = { planAuthVersion: 'test-only', maxModelCallsPerWeek: 4, maxInputBytes: 100000, maxInFlight: 2 };
const makeContract = (ms = 1000): ModelCallContract => ({ businessKey: { subjectKind: 'STOCK', subject: '600101', researchKind: 'WEEKLY', cutoff: '2026-11-01T00:00:00.000Z' },
  stage: 'A', inputHash: 'a'.repeat(64), inputBytes: 100, methodVersion: 'test-only', planAuthVersion: budget.planAuthVersion, deadline: new Date(Date.now() + ms).toISOString() });
function memoryPort() {
  let row: ModelPermit | null = null, prepared = 0, sends = 0;
  const outcomes: unknown[] = [];
  const space: PermitSpace<ModelPermit, ModelCallContract> = {
    assertRunning: async () => {},
    preparePermit: async (_pool, contract) => {
      prepared++; if (row?.sentAt) throw new KernelError('BUSINESS_KEY_ALREADY_SENT');
      return row = { permitId: 'pure-port', contract, state: 'PREPARED', sentAt: null, settledAt: null, failCode: null, simulated: true };
    },
    tryMarkSent: async () => { sends++; row!.state = 'SENT'; row!.sentAt = new Date().toISOString(); return { kind: 'SENT', permit: row! }; },
    settle: async (_pool, _id, outcome) => { outcomes.push(outcome); row!.state = outcome.result; return row!; },
  };
  return { space, outcomes, read: () => ({ row, prepared, sends }) };
}
const noDb = {} as Pool;

test('I10/I13: both public send gates reject an independent concurrency argument above the authorized limit before SQL', async () => {
  for (const max of [0, 3, 2.5, Number.NaN]) {
    await assert.rejects(tryMarkSent(noDb, 'not-accessed', max, { space: 'kernel', holderId: 'pure', generation: '1', ttlMs: 1000 }, budget), { code: 'EXECUTION_BUDGET_INVALID' });
    await assert.rejects(srTryMarkSent(noDb, 'not-accessed', max, { space: 'sr', holderId: 'pure', generation: '1', ttlMs: 1000 }, budget), { code: 'EXECUTION_BUDGET_INVALID' });
  }
});

test('I09 pure port: local observation failures are UNKNOWN; known output rejection stays FAILED', async (t) => {
  for (const code of ['TIMEOUT', 'SILENCE_AFTER_SEND', 'DSH_WORKER_FAILED', 'MODEL_PROVIDER_EXIT_NONZERO', 'MODEL_FINAL_MISSING', 'MODEL_OUTPUT_LIMIT_EXCEEDED',
    'SR_REAL_EXIT_NONZERO', 'SR_FINAL_MISSING', 'EXECUTION_LOCK_HELD', 'RESULT_PERSISTENCE_UNKNOWN', 'MODEL_OUTPUT_SCHEMA_INVALID', 'SOL_SPAWN_FAILED']) {
    await t.test(code, async () => {
      const p = memoryPort(), contract = makeContract();
      const invoke = () => runPermittedCall(p.space, noDb, { contract, budget, simulated: true, modelFn: async () => { throw new KernelError(code); } });
      await assert.rejects(invoke, { code });
      assert.equal(p.read().row!.state, ['MODEL_OUTPUT_SCHEMA_INVALID', 'SOL_SPAWN_FAILED'].includes(code) ? 'FAILED' : 'UNKNOWN');
      await assert.rejects(invoke, { code: 'BUSINESS_KEY_ALREADY_SENT' });
      assert.equal(p.read().sends, 1);
    });
  }
});

test('I09 pure port: deadline abort is synchronous before a deliberately delayed UNKNOWN write; late output cannot win', async () => {
  const p = memoryPort(), original = p.space.settle;
  let release!: () => void, signal: AbortSignal | undefined, observed = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  p.space.settle = async (...args) => { observed = true; assert.equal(signal!.aborted, true); await blocked; return original(...args); };
  const run = runPermittedCall(p.space, noDb, { contract: makeContract(150), budget, simulated: true,
    modelFn: async (ctx) => { signal = ctx.signal; await new Promise((r) => setTimeout(r, 200)); return 'too late'; } });
  const rejected = assert.rejects(run, { code: 'DEADLINE_EXCEEDED' });
  await new Promise((r) => setTimeout(r, 180)); assert.equal(observed, true); release(); await rejected;
  await new Promise((r) => setTimeout(r, 40)); assert.equal(p.read().row!.state, 'UNKNOWN'); assert.equal(p.outcomes.length, 1);
});

test('I12 pure port: preflight rejection creates zero permits/sends', async () => {
  const p = memoryPort();
  await assert.rejects(runPermittedCall(p.space, noDb, { contract: makeContract(), budget, simulated: false,
    preflight: () => { throw new KernelError('MODEL_INPUT_UNBOUND'); }, modelFn: async () => assert.fail('no dispatch') }), { code: 'MODEL_INPUT_UNBOUND' });
  assert.deepEqual(p.read(), { row: null, prepared: 0, sends: 0 });
});

test('I12 CLI selects the supplied real factory while frozen P5 rejects before any database access', async () => {
  let selected = 0, queries = 0;
  const pool = { query: async () => { queries++; assert.fail('P5 refusal precedes database access'); } } as unknown as Pool;
  await assert.rejects(runNightlyCli(['--date', '2026-11-09', '--commit', '--transport', 'real'], {
    dataPool: pool, execPool: pool, calendar: { tradingDays: ['2026-11-09'] }, store: {} as ArtifactStore,
  }, () => { selected++; return new UnauthorizedTransport(); }), { code: 'P5_PROTOCOL_FROZEN' });
  assert.equal(selected, 1); assert.equal(queries, 0);
});

test('I10 pure heartbeat port: renew runs independently during slow work and loss aborts the guard', async () => {
  let renewals = 0, valid = true;
  const pool = { query: async () => { renewals++; return { rows: [], rowCount: valid ? 1 : 0 }; } } as unknown as Pool;
  const guard = keepLeaseAlive(pool, { space: 'kernel', holderId: 'pure', generation: '1', ttlMs: 30 });
  try {
    await new Promise((r) => setTimeout(r, 100)); assert.ok(renewals >= 3); assert.equal(guard.signal.aborted, false);
    valid = false; await new Promise((r) => setTimeout(r, 40)); assert.equal(guard.signal.aborted, true);
    await assert.rejects(guard.assert(), { code: 'EXECUTION_LOCK_HELD' });
  } finally { await guard.stop(); }
});

test('I11: equivalent time representations bind one contract; model/effort identities remain distinct', () => {
  const c = makeContract();
  c.deadline = '2026-11-05T22:00:00+08:00';
  assert.equal(contractHash(c), contractHash({ ...c, deadline: '2026-11-05T14:00:00.000Z' }));
  assert.equal(contractHash(c), contractHash({ ...c, deadline: '2026-11-05T14:00:00Z' }));
  assert.notEqual(canonicalSha256(new SolTransport().describe()), canonicalSha256(new SolTransport({ reasoningEffort: 'max' }).describe()));
});

test('I13: both scope ceilings and one remaining slot reject a new A/J pair independently', () => {
  for (const scope of ['WEEKLY', 'POST_EVENT'] as const) assert.equal(budgetGuard({ postEventAuthCap: 10, weeklyUsed: 60, postEventUsed: 10, scope, requiredCalls: 2 }).ok, false);
  assert.equal(budgetGuard({ postEventAuthCap: 10, weeklyUsed: 59, postEventUsed: 0, scope: 'WEEKLY', requiredCalls: 2 }).ok, false);
  assert.equal(budgetGuard({ postEventAuthCap: 10, weeklyUsed: 60, postEventUsed: 8, scope: 'POST_EVENT', requiredCalls: 2 }).ok, true);
});

test('I11: duplicate same-pool chain joins; a changed concurrent intent cannot enter cleanup', async () => {
  const c = makeContract(), pool = {} as Pool; let calls = 0, release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const run = () => { calls++; return blocked.then(() => 7); };
  const a = coalesceResearchRun(pool, c.businessKey, { input: 1 }, run);
  const b = coalesceResearchRun(pool, c.businessKey, { input: 1 }, run);
  await assert.rejects(coalesceResearchRun(pool, c.businessKey, { input: 2 }, run), { code: 'RESEARCH_CHECKPOINT_CONFLICT' });
  release(); assert.deepEqual(await Promise.all([a, b]), [7, 7]); assert.equal(calls, 1);
});

test('I11: original CAS package required; tampered hash, bytes and body cannot be trusted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr4-pure-cas-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root), c = makeContract();
  const input = syntheticConclusionInput(c.businessKey, { methodVersion: c.methodVersion, adapterVersion: 'synthetic', planAuthVersion: c.planAuthVersion });
  const pkg = input.researchInput, ref = await store.put(Buffer.from(canonicalJsonString(pkg)), 'application/json', c.businessKey.cutoff);
  const snap = { version: 1 as const, assembled: { package: pkg, artifactRef: ref, inputHash: pkg.inputHash, inputBytes: ref.bytes }, deadline: c.deadline, metadata: null };
  await verifyResearchSnapshot(store, snap);
  for (const mutate of [(s: typeof snap) => { s.assembled.inputBytes++; }, (s: typeof snap) => { s.assembled.package.pool.file = 'forged'; },
    (s: typeof snap) => { s.assembled.inputHash = 'f'.repeat(64); }]) {
    const bad = structuredClone(snap); mutate(bad); await assert.rejects(verifyResearchSnapshot(store, bad), { code: 'RESEARCH_CHECKPOINT_INVALID' });
  }
  const request = buildARequest(pkg, true);
  await preflightTransport(new SimulatedTransport(), { ...c, inputHash: request.inputHash, inputBytes: request.inputBytes }, request.payload);
  await assert.rejects(preflightTransport(new SimulatedTransport(), { ...c, inputHash: request.inputHash, inputBytes: 1 }, request.payload), { code: 'MODEL_INPUT_UNBOUND' });
});

test('I11: mutable settlement is outside prior receipt identity; research and admission identity remain bound', () => {
  const c = makeContract(), input = syntheticConclusionInput(c.businessKey, { methodVersion: 'test', adapterVersion: 'test', planAuthVersion: 'test' });
  const a = { conclusion: { settlement: { state: 'UNSETTLED' }, conclusionHash: 'immutable' }, aOutput: input.aOutput, checklist: input.checklist, jOutput: input.jOutput };
  const b = { ...a, conclusion: { ...a.conclusion, settlement: { state: 'ANOMALY' } } };
  assert.equal(canonicalSha256(immutablePrior(a as never)), canonicalSha256(immutablePrior(b as never)));
  assert.notEqual(canonicalSha256(immutablePrior(a as never)), canonicalSha256(immutablePrior({ ...b, jOutput: { ...b.jOutput, changeReason: 'forged' } } as never)));
});

test('I16: deterministic user intent key, explicit new key and malformed keys have separate semantics', () => {
  const intent = { report: 'v1', question: 'why' };
  assert.equal(requestKey(undefined, intent), requestKey(undefined, structuredClone(intent)));
  assert.notEqual(requestKey(undefined, intent), requestKey('new-intent-key', intent));
  assert.throws(() => requestKey('../bad', intent), { code: 'REQUEST_KEY_INVALID' });
});

test('I12: real-shaped SR preflight includes full prompt bytes, but never invokes its runner', () => {
  let runs = 0;
  const transport = new RealSrTransport({ ...realTransportConfigFromEnv({}), enabled: true }, { run: async () => { runs++; assert.fail('preflight cannot spawn'); } });
  const input = { question: 'TEST_ONLY' }, json = JSON.stringify(input, null, 1);
  const payloadHash = createHash('sha256').update(json).digest('hex');
  const wire = transport.preflight('CHAT_ANSWER', payloadHash, input);
  assert.ok(wire.inputBytes > Buffer.byteLength(json)); assert.equal(runs, 0);
  assert.throws(() => transport.preflight('CHAT_ANSWER', 'f'.repeat(64), input), { code: 'MODEL_INPUT_UNBOUND' });
});
