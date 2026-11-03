/** New real-entry preparation and TEST_ONLY runner verification; never a real model result. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { canonicalSha256 } from '../../canonical.js';
import { KernelError } from '../../contracts.js';
import { defaultSrPlanBudget } from '../contracts.js';
import { RealSrTransport, realTransportConfigFromEnv, type RealRunner } from '../transport.js';
import type { AFinalOutput, JInput, JOutput } from '../transport.js';
import { createSrServer } from '../server.js';
import { realFileClientDeps } from './client-preview.js';
import { fileStrategyStore } from './real-store.js';
import { reviewEntry, executeReviewBundle } from './real-review-entry.js';
import { assertRealReviewResult, executePreparedStrategyReview, prepareRealStrategyReview, REAL_REVIEW_TABLES, runRealStrategyReview, type RealReviewInput, type RealReviewResult, type ReviewOwnerGrant } from './real-review.js';
import { blockExternalEffects, IsolatedSrPool, originalStrategyStore, writeReviewClientManifest, type IsolatedSrSnapshot } from './review-isolated.js';

const DELIVERY = fileURLToPath(new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/parallel-20261031/review/', import.meta.url));
const OLD = fileURLToPath(new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/continuation-20261031/', import.meta.url));
const ACCOUNT = '00000000-0000-4000-8000-000000000001'; // TEST_ONLY account; never a proposed actual account.
let directory: string, guard: ReturnType<typeof blockExternalEffects>, sourceStore: Awaited<ReturnType<typeof originalStrategyStore>>, serial = 0;
const evidence: unknown[] = [];
before(async () => { guard = blockExternalEffects(); directory = await mkdtemp(join(DELIVERY, 'verification-')); sourceStore = await originalStrategyStore(); });
after(async () => { try { assert.deepEqual(guard.attempts, { database: 0, externalFetch: 0 }); await writeFile(join(directory, 'TEST_ONLY-verification.json'), JSON.stringify({ identity: 'TEST_ONLY_ENTRY_VERIFICATION', realModelCalls: 0, attempts: guard.attempts, cases: evidence }, null, 2) + '\n', { flag: 'wx' }); } finally { guard.restore(); } });
function request(testOnly: boolean) { return { accountId: ACCOUNT, authorizationRef: 'TEST_ONLY:strategy-real-review-ready-20261031', authorizationMode: testOnly ? 'TEST_ONLY_REAL_RUNNER' as const : 'OWNER_BOUND_REAL' as const, budget: { ...defaultSrPlanBudget(), planAuthVersion: 'strategy-real-review-ready-test-v1' }, deadlines: { A: new Date(Date.now() + 120_000).toISOString(), J: new Date(Date.now() + 180_000).toISOString() } }; }
function grantFor(prepared: Awaited<ReturnType<typeof prepareRealStrategyReview>>, testOnly: boolean): ReviewOwnerGrant {
  const core = { schema: 'lyra-strategy-real-review-authorization-v1' as const, kind: testOnly ? 'TEST_ONLY_AUTHORIZATION' as const : 'OWNER_AUTHORIZATION' as const, approvalRef: 'TEST_ONLY_GATE_FIXTURE_NOT_OWNER_PERMISSION', approvedAt: new Date().toISOString(), validUntil: prepared.input.execution.deadlines.J, proposalHash: prepared.proposal.proposalHash, inputHash: prepared.input.inputHash, accountId: ACCOUNT, maxNewModelCalls: 2 as const, businessWrites: prepared.proposal.businessWrites };
  return { ...core, grantHash: canonicalSha256(core) };
}
async function ownerPlan() {
  const outputDir = join(directory, `never-executed-owner-target-${++serial}`), config = { ...realTransportConfigFromEnv({ LYRA_SR_REAL_BINARY: '/FORBIDDEN_REAL_PROCESS_IN_TEST' }), invocationsDir: join(outputDir, 'invocations') };
  const prepared = await prepareRealStrategyReview({ sourceStore, transport: new RealSrTransport(config), request: request(false), outputDir, preparedAt: new Date(Date.now() - 1000).toISOString() });
  return { ...prepared, config, grant: grantFor(prepared, false) };
}
async function injectedPlan(fault: 'NONE' | 'A_UNKNOWN' | 'J_NARROWED' = 'NONE') {
  const pool = new IsolatedSrPool(), outputDir = join(directory, 'TEST_ONLY', `case-${++serial}`);
  const config = { ...realTransportConfigFromEnv({ LYRA_SR_REAL_BINARY: '/FORBIDDEN_REAL_PROCESS_IN_TEST' }), invocationsDir: join(outputDir, 'invocations') };
  const calls: { argv: string[]; windowMs: number; role: string }[] = [];
  const runner: RealRunner = { async run(argv, opts) {
    const final = argv[argv.indexOf('--output-last-message') + 1]!, callId = basename(dirname(final)); assert.equal(pool.sent(callId), true);
    const marker = '# 输入（JSON）\n', payload = JSON.parse(opts.stdin.slice(opts.stdin.lastIndexOf(marker) + marker.length));
    const isJ = 'checklist' in payload; calls.push({ argv, windowMs: opts.windowMs, role: isJ ? 'J' : 'A' });
    if (!isJ && fault === 'A_UNKNOWN') throw new KernelError('SILENCE_AFTER_SEND', 'TEST_ONLY injected runner unknown');
    let out: AFinalOutput | JOutput;
    if (!isJ) out = { narrative: 'TEST_ONLY injected A; no model was run.', conclusion: 'Keep the frozen draft restricted with all missing evidence.', conclusionConditions: ['Current conditional draft only; no execution or historical efficacy'], decisiveLinks: REAL_REVIEW_TABLES.map((tableId) => ({ tableId, text: `Preserve the complete ${tableId} dependency and gaps` })), strongestCounter: 'Missing industry, historical and account inputs prevent execution.', catalysts: [], gaps: ['TEST_ONLY injected output'] };
    else {
      const input = payload as JInput;
      out = { verdicts: input.checklist.items.map((item) => ({ checklistId: item.checklistId, verdict: 'SUPPORTED', decisionBearing: true, bearingReason: 'TEST_ONLY dependency verification', remainingBasis: null, evidenceRef: item.tableId ?? 'gaps-and-lineage', correction: null })), conclusionRuling: { finalConclusion: input.aFinal.conclusion, changedFromA: false, changeReason: null, conditions: input.aFinal.conclusionConditions }, unresolvedDisposition: [], limitations: ['TEST_ONLY injected runner; not actual research'] };
      if (fault === 'J_NARROWED') { out.verdicts[0]!.verdict = 'NARROWED'; out.verdicts[0]!.correction = 'A new frozen version is required'; }
    }
    writeFileSync(final, JSON.stringify(out)); return { code: 0, stdout: 'TEST_ONLY', stderr: '' };
  } };
  const prepared = await prepareRealStrategyReview({ sourceStore, transport: new RealSrTransport(config, runner), request: request(true), outputDir, preparedAt: new Date(Date.now() - 1000).toISOString() });
  const grant = grantFor(prepared, true);
  let transportFactories = 0, storeFactories = 0;
  const args = { sourceStore, ...prepared, expectedProposalHash: prepared.proposal.proposalHash, grant, realCallsEnabled: true, permitStoreOrigin: 'TEST_ONLY_SQL_DOUBLE' as const,
    createTransport: () => { transportFactories++; return new RealSrTransport({ ...config, enabled: true }, runner); },
    openPermitStore: async () => { storeFactories++; return { srPool: pool.asPool(), holderId: pool.holderId }; } };
  return { ...prepared, grant, args, pool, runner, calls, counts: () => ({ transportFactories, storeFactories }) };
}

test('默认入口只准备：不造账户、不读凭据，J hash/bytes待真实A后确定，原阻断保留', async (t) => {
  let forbiddenReads = 0;
  const env = new Proxy({ LYRA_SR_REAL_BINARY: '/FORBIDDEN_REAL_PROCESS_IN_TEST', LYRA_SR_REAL_CALLS: '1' } as NodeJS.ProcessEnv, { get(target, key) { if (/TOKEN|PASSWORD|SECRET|CREDENTIAL/.test(String(key))) { forbiddenReads++; throw new Error('CREDENTIAL_READ_FORBIDDEN'); } return target[String(key)]; } });
  const out = join(directory, 'default-preparation');
  const result = await reviewEntry(['--out', out, '--deadline-a', '2026-11-02T04:00:00.000Z', '--deadline-j', '2026-11-02T05:00:00.000Z', '--plan-auth-version', 'strategy-real-review-ready-20261031-v1'], env) as { status: string; accountId: unknown; modelCalls: number; registeredTasks: number; createdPermits: number; jInput: { payloadHash: unknown; payloadBytes: unknown }; blockers: { code: string }[] };
  assert.equal(result.status, 'NOT_RUN'); assert.equal(result.accountId, null); assert.equal(result.modelCalls, 0); assert.equal(result.registeredTasks, 0); assert.equal(result.createdPermits, 0); assert.equal(result.jInput.payloadHash, null); assert.equal(result.jInput.payloadBytes, null); assert.equal(forbiddenReads, 0);
  for (const code of ['NEW_OWNER_AUTHORIZATION_REQUIRED', 'ACTUAL_SR_ACCOUNT_ID_REQUIRED', 'REAL_CONTINUOUS_COVERAGE_INCOMPLETE', 'LATEST_REVISED_NOT_HISTORICAL_PIT']) assert.ok(result.blockers.some((b) => b.code === code));
  await assert.rejects(executeReviewBundle({ bundle: out, expectedProposalHash: '', env: { LYRA_SR_REAL_CALLS: '1' } }), { code: 'STRATEGY_NEW_OWNER_AUTHORIZATION_REQUIRED' });
  evidence.push({ name: 'default-zero-send-preparation', result, forbiddenCredentialReads: forbiddenReads }); t.diagnostic(JSON.stringify({ output: out, actualModelCalls: 0, databaseAttempts: 0 }));
});

test('缺新授权、方案pin漂移、过期、输入漂移在创建真实transport/数据库之前拒绝', async () => {
  const p = await ownerPlan(); let transports = 0, stores = 0;
  const args = { sourceStore, input: p.input, proposal: p.proposal, expectedProposalHash: p.proposal.proposalHash, grant: p.grant, realCallsEnabled: true, permitStoreOrigin: 'BUSINESS_SR_DATABASE' as const,
    createTransport: () => { transports++; return new RealSrTransport({ ...p.config, enabled: true }); }, openPermitStore: async () => { stores++; throw new Error('DATABASE_FACTORY_MUST_NOT_OPEN'); } };
  const { grant: _, ...missing } = args;
  await assert.rejects(executePreparedStrategyReview(missing), { code: 'STRATEGY_NEW_OWNER_AUTHORIZATION_REQUIRED' });
  await assert.rejects(executePreparedStrategyReview({ ...args, expectedProposalHash: '0'.repeat(64) }), { code: 'STRATEGY_REVIEW_PROPOSAL_PIN_INVALID' });
  await assert.rejects(executePreparedStrategyReview({ ...args, realCallsEnabled: false }), { code: 'STRATEGY_EXPLICIT_REAL_SWITCH_REQUIRED' });
  await assert.rejects(executePreparedStrategyReview({ ...args, now: new Date('2099-01-01T00:00:00.000Z') }), { code: 'STRATEGY_REVIEW_AUTHORIZATION_OR_DEADLINE_EXPIRED' });
  const loaded = await sourceStore.load(), changed = structuredClone(loaded); changed.data.dataHash = '0'.repeat(64);
  await assert.rejects(executePreparedStrategyReview({ ...args, sourceStore: { ...sourceStore, load: async () => changed } }), { code: 'STRATEGY_REVIEW_INPUT_BINDING_INVALID' });
  assert.equal(transports, 0); assert.equal(stores, 0); evidence.push({ name: 'pre-factory-refusals', transportFactories: transports, databaseFactories: stores });
});

test('角色错绑、注入runner冒充真实及SQL替身迁入真实模式均在数据库打开前拒绝', async () => {
  const p = await ownerPlan(); let stores = 0;
  const runner: RealRunner = { async run() { throw new Error('NO_RUNNER_MAY_RUN'); } };
  const args = { sourceStore, input: p.input, proposal: p.proposal, expectedProposalHash: p.proposal.proposalHash, grant: p.grant, realCallsEnabled: true, permitStoreOrigin: 'BUSINESS_SR_DATABASE' as const, createTransport: () => new RealSrTransport({ ...p.config, enabled: true, reviewModelId: 'wrong-role' }), openPermitStore: async () => { stores++; throw new Error('NO_DATABASE'); } };
  await assert.rejects(executePreparedStrategyReview(args), { code: 'STRATEGY_EXECUTION_TRANSPORT_CHANGED' });
  await assert.rejects(executePreparedStrategyReview({ ...args, createTransport: () => new RealSrTransport({ ...p.config, enabled: true }, runner) }), { code: 'STRATEGY_EXECUTION_TRANSPORT_CHANGED' });
  await assert.rejects(executePreparedStrategyReview({ ...args, permitStoreOrigin: 'TEST_ONLY_SQL_DOUBLE' }), { code: 'STRATEGY_PERMIT_STORE_ORIGIN_INVALID' });
  assert.equal(stores, 0); evidence.push({ name: 'role-and-origin-refusals', databaseFactories: stores });
});

test('TEST_ONLY真实通道runner准确argv、显式截止与最多A/J两次；成功恢复零重发', async (t) => {
  const s = await injectedPlan(), first = await executePreparedStrategyReview(s.args);
  assert.equal(first.result.identity, 'TEST_ONLY_RESEARCH_REVIEW'); assert.equal(first.result.realReviewDone, false); assert.equal(first.result.reviewCompleted, true); assert.equal(first.result.executionEligible, false); assert.equal(s.calls.length, 2);
  assert.equal(first.result.receipts.A?.simulated, false); assert.equal(first.result.receipts.J?.simulated, false); assertRealReviewResult(first.result, s.input);
  for (const call of s.calls) { const model = call.role === 'A' ? 'gpt-6.1-terra' : 'gpt-6.1-sol', effort = call.role === 'A' ? 'max' : 'high'; assert.equal(call.argv[call.argv.indexOf('-m') + 1], model); assert.ok(call.argv.includes(`model_reasoning_effort="${effort}"`)); assert.ok(call.argv.includes('web_search="disabled"')); assert.ok(call.windowMs <= 180_000); assert.ok(call.argv[call.argv.indexOf('--output-last-message') + 1]!.includes('/TEST_ONLY/')); }
  const callsBefore = canonicalSha256(s.pool.snapshot().calls), recovered = await executePreparedStrategyReview(s.args);
  assert.equal(s.calls.length, 2); assert.equal(recovered.result.resultHash, first.result.resultHash); assert.equal(canonicalSha256(s.pool.snapshot().calls), callsBefore);
  evidence.push({ name: 'TEST_ONLY-success-and-recovery', inputHash: s.input.inputHash, proposalHash: s.proposal.proposalHash, resultHash: first.result.resultHash, runnerCalls: s.calls, actualModelCalls: 0, repeatedRunnerCalls: 0, resultPath: first.resultPath }); t.diagnostic(JSON.stringify({ resultPath: first.resultPath, identity: first.result.identity, realReviewDone: false, actualModelCalls: 0 }));
});

test('TEST_ONLY首个UNKNOWN即停；已知不可恢复状态在transport/库工厂之前零副作用拒绝', async () => {
  const s = await injectedPlan('A_UNKNOWN'), first = await executePreparedStrategyReview(s.args);
  assert.equal(first.result.status, 'UNKNOWN'); assert.equal(s.calls.length, 1); assert.equal(first.result.steps.J, 'NOT_RUN'); assertRealReviewResult(first.result, s.input);
  const before = s.counts(); await assert.rejects(executePreparedStrategyReview(s.args), { code: 'STRATEGY_LOCAL_CALL_NOT_RECOVERABLE' }); assert.deepEqual(s.counts(), before); assert.equal(s.calls.length, 1);
  evidence.push({ name: 'TEST_ONLY-UNKNOWN-stop', resultHash: first.result.resultHash, runnerCalls: 1, repeatedFactories: 0, actualModelCalls: 0 });
});

test('完成复核与结论获支持分开；正常只读API/页面明确TEST_ONLY，旧模拟原件仍可读', async (t) => {
  const s = await injectedPlan('J_NARROWED'), delivered = await executePreparedStrategyReview(s.args);
  assert.equal(delivered.result.reviewCompleted, true); assert.equal(delivered.result.reviewGatePassed, false); assert.equal(delivered.result.status, 'BLOCKED'); assert.equal(delivered.result.realReviewDone, false);
  const client = await writeReviewClientManifest(join(directory, 'TEST_ONLY', `client-${++serial}`), delivered.inputPath, delivered.resultPath), deps = realFileClientDeps(client.manifestPath, client.manifestSha256), server = createSrServer(deps);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { const response = await fetch(base + '/api/strategies/601919'), body = await response.json() as { researchReview: RealReviewResult; draft: { quantity: null }; validation: { metrics: null } }; assert.equal(response.status, 200); assert.equal(body.researchReview.identity, 'TEST_ONLY_RESEARCH_REVIEW'); assert.equal(body.researchReview.realReviewDone, false); assert.equal(body.draft.quantity, null); assert.equal(body.validation.metrics, null); const page = await fetch(base + '/strategies/601919'); assert.match(await page.text(), /TEST_ONLY/); assert.equal((await fetch(base + '/api/strategies/601919', { method: 'POST' })).status, 404); await writeFile(join(dirname(client.manifestPath), 'api-readback.json'), JSON.stringify(body, null, 2) + '\n'); } finally { await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); }
  const index = JSON.parse(await readFile(join(OLD, 'isolated-reproduction-r1/reproduction.json'), 'utf8'));
  for (const entry of index.cases) { const loaded = await fileStrategyStore(entry.manifest.manifestPath, entry.manifest.manifestSha256).load(); assert.equal(loaded.researchReview?.resultHash, entry.resultHash); }
  const r2 = JSON.parse(await readFile(join(OLD, 'r2/evidence.json'), 'utf8')) as { receiptProof: string };
  const badDirectory = join(dirname(r2.receiptProof), 'repinned-client');
  for (const name of ['wrong_task_id', 'wrong_step_id', 'wrong_prompt_hash', 'wrong_provider']) {
    const path = join(badDirectory, `${name}-manifest.json`), bytes = await readFile(path);
    await assert.rejects(fileStrategyStore(path, createHash('sha256').update(bytes).digest('hex')).load(), { code: 'STRATEGY_REVIEW_RECEIPT_OR_ARTIFACT_INVALID' });
  }
  evidence.push({ name: 'TEST_ONLY-client-and-legacy-consumer', manifest: client, legacyCases: index.cases.length, actualModelCalls: 0 }); t.diagnostic(JSON.stringify({ client, legacyCases: index.cases.length, actualModelCalls: 0 }));
});

test('旧模拟成功与UNKNOWN恢复沿原身份零发送，原R1/R2证据不改写', async () => {
  const index = JSON.parse(await readFile(join(OLD, 'isolated-reproduction-r1/reproduction.json'), 'utf8'));
  for (const entry of index.cases.filter((x: { fault: string }) => ['NONE', 'A_UNKNOWN'].includes(x.fault))) {
    const original = dirname(entry.resultPath), input = JSON.parse(await readFile(join(original, 'input.json'), 'utf8')) as RealReviewInput;
    const pool = new IsolatedSrPool(JSON.parse(await readFile(join(original, 'isolated-sr-snapshot.json'), 'utf8')) as IsolatedSrSnapshot), outputDir = join(directory, 'TEST_ONLY', `legacy-${entry.fault}`), target = join(outputDir, input.taskId);
    await mkdir(target, { recursive: true }); for (const name of ['input.json', 'a.json', 'checklist.json', 'j.json']) { try { await copyFile(join(original, name), join(target, name)); } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; } }
    let dispatches = 0; const result = await runRealStrategyReview({ sourceStore, input, expectedInputHash: input.inputHash, srPool: pool.asPool(), transport: { describe: (step) => input.execution.transports[step === 'JUDGE' ? 'J' : 'A'], dispatch: async () => { dispatches++; throw new Error('LEGACY_RESEND_FORBIDDEN'); } }, budget: input.execution.budget, outputDir, holderId: pool.holderId });
    assert.equal(result.result.resultHash, entry.resultHash); assert.equal(dispatches, 0); evidence.push({ name: `legacy-recovery:${entry.fault}`, resultHash: result.result.resultHash, dispatches });
  }
});
