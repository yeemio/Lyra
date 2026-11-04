/** RRE-R1-01: no real models or database; fixed grant coverage and unchanged send deadlines. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { canonicalSha256 } from '../../canonical.js';
import { KernelError } from '../../contracts.js';
import { defaultSrPlanBudget } from '../contracts.js';
import { RealSrTransport, realTransportConfigFromEnv, type RealRunner, type AFinalOutput, type JInput, type JOutput } from '../transport.js';
import { assertRealReviewResult, executePreparedStrategyReview, prepareRealStrategyReview, type ReviewOwnerGrant } from './real-review.js';
import { blockExternalEffects, originalStrategyStore, IsolatedSrPool } from './review-isolated.js';

const BASE = fileURLToPath(new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/parallel-20261031/', import.meta.url));
let out: string, guard: ReturnType<typeof blockExternalEffects>, store: Awaited<ReturnType<typeof originalStrategyStore>>, frozenA: AFinalOutput, serial = 0;
const proof: unknown[] = [];
before(async () => {
  guard = blockExternalEffects(); out = await mkdtemp(join(BASE, 'review/r2/grant-window-')); store = await originalStrategyStore();
  frozenA = JSON.parse(await readFile(join(BASE, 'review/verification-i7RRwR/TEST_ONLY/case-3/80be08c5-fc74-52f2-acc7-8e5f7e4faa4b/a.json'), 'utf8')).output;
});
after(async () => { try { assert.deepEqual(guard.attempts, { database: 0, externalFetch: 0 }); await writeFile(join(out, 'proof.json'), JSON.stringify({ identity: 'TEST_ONLY_GRANT_WINDOW_VERIFICATION', realModelCalls: 0, attempts: guard.attempts, cases: proof }, null, 2) + '\n', { flag: 'wx' }); } finally { guard.restore(); } });

async function fixture(order: 'NORMAL' | 'A_LATER' = 'NORMAL', fault: 'NONE' | 'UNKNOWN' | 'FAILED' = 'NONE') {
  const outputDir = join(out, 'TEST_ONLY', `case-${++serial}`), pool = new IsolatedSrPool();
  const calls: { role: string; at: string }[] = [];
  const config = { ...realTransportConfigFromEnv({ LYRA_SR_REAL_BINARY: '/FORBIDDEN_REAL_PROCESS' }), invocationsDir: join(outputDir, 'invocations') };
  const runner: RealRunner = { async run(argv, opts) {
    const marker = '# 输入（JSON）\n', payload = JSON.parse(opts.stdin.slice(opts.stdin.lastIndexOf(marker) + marker.length));
    const role = 'checklist' in payload ? 'J' : 'A'; calls.push({ role, at: new Date().toISOString() });
    if (role === 'A' && fault === 'UNKNOWN') throw new KernelError('SILENCE_AFTER_SEND', 'TEST_ONLY original UNKNOWN retained');
    let output: unknown = role === 'A' ? frozenA : null;
    if (role === 'A' && fault === 'FAILED') output = { invalid: 'TEST_ONLY schema failure' };
    if (role === 'J') {
      const input = payload as JInput;
      output = { verdicts: input.checklist.items.map((item) => ({ checklistId: item.checklistId, verdict: 'SUPPORTED', decisionBearing: true, bearingReason: 'TEST_ONLY grant-window fixture', remainingBasis: null, evidenceRef: item.tableId ?? 'gaps-and-lineage', correction: null })), conclusionRuling: { finalConclusion: input.aFinal.conclusion, changedFromA: false, changeReason: null, conditions: input.aFinal.conclusionConditions }, unresolvedDisposition: [], limitations: ['TEST_ONLY; no actual model'] } satisfies JOutput;
    }
    writeFileSync(argv[argv.indexOf('--output-last-message') + 1]!, JSON.stringify(output));
    return { code: 0, stdout: 'TEST_ONLY', stderr: '' };
  } };
  const now = Date.now(), deadlines = { A: new Date(now + (order === 'A_LATER' ? 120_000 : 60_000)).toISOString(), J: new Date(now + (order === 'A_LATER' ? 60_000 : 120_000)).toISOString() };
  const prepared = await prepareRealStrategyReview({ sourceStore: store, transport: new RealSrTransport(config, runner), request: { accountId: '00000000-0000-4000-8000-000000000001', authorizationRef: 'TEST_ONLY_RRE_R1_01', authorizationMode: 'TEST_ONLY_REAL_RUNNER', budget: { ...defaultSrPlanBudget(), planAuthVersion: 'TEST_ONLY_grant_window_r2' }, deadlines }, outputDir, preparedAt: new Date(now - 1000).toISOString() });
  const grantFor = (validUntil: string): ReviewOwnerGrant => {
    const core = { schema: 'lyra-strategy-real-review-authorization-v1' as const, kind: 'TEST_ONLY_AUTHORIZATION' as const, approvalRef: 'TEST_ONLY_NOT_OWNER_PERMISSION', approvedAt: new Date().toISOString(), validUntil, proposalHash: prepared.proposal.proposalHash, inputHash: prepared.input.inputHash, accountId: prepared.input.execution.accountId!, maxNewModelCalls: 2 as const, businessWrites: prepared.proposal.businessWrites };
    return { ...core, grantHash: canonicalSha256(core) };
  };
  let transportFactories = 0, storeFactories = 0;
  const args = { sourceStore: store, ...prepared, expectedProposalHash: prepared.proposal.proposalHash, realCallsEnabled: true, permitStoreOrigin: 'TEST_ONLY_SQL_DOUBLE' as const,
    createTransport: () => { transportFactories++; return new RealSrTransport({ ...config, enabled: true }, runner); }, openPermitStore: async () => { storeFactories++; return { srPool: pool.asPool(), holderId: pool.holderId, lease: pool.lease }; } };
  return { ...prepared, args, grantFor, pool, calls, counts: () => ({ transportFactories, storeFactories }) };
}

test('RRE-R1-01：仍有效但不足覆盖A/J的grant在入口拒绝，主控反例零发送', async (t) => {
  for (const scenario of ['CONTROLLER_SHORT_GRANT', 'A_ONLY', 'J_ONLY_WITH_LATER_A', 'ONE_MS_SHORT'] as const) {
    const f = await fixture(scenario === 'J_ONLY_WITH_LATER_A' ? 'A_LATER' : 'NORMAL');
    const maximum = [f.input.execution.deadlines.A, f.input.execution.deadlines.J].sort().at(-1)!;
    const validUntil = scenario === 'CONTROLLER_SHORT_GRANT' ? new Date(Date.now() + 3000).toISOString() : scenario === 'A_ONLY' ? f.input.execution.deadlines.A : scenario === 'J_ONLY_WITH_LATER_A' ? f.input.execution.deadlines.J : new Date(Date.parse(maximum) - 1).toISOString();
    const grant = f.grantFor(validUntil), original = canonicalSha256({ input: f.input, proposal: f.proposal, grant });
    assert.ok(Date.now() < Date.parse(grant.validUntil));
    await assert.rejects(executePreparedStrategyReview({ ...f.args, grant }), { code: 'STRATEGY_OWNER_AUTHORIZATION_WINDOW_TOO_SHORT' });
    assert.deepEqual(f.counts(), { transportFactories: 0, storeFactories: 0 }); assert.equal(f.calls.length, 0); assert.equal(f.pool.snapshot().calls.length, 0);
    assert.equal(canonicalSha256({ input: f.input, proposal: f.proposal, grant }), original);
    const directory = join(dirname(f.proposal.outputDir), scenario); await mkdir(directory, { recursive: true });
    for (const [name, value] of [['input', f.input], ['proposal', f.proposal], ['grant', grant]] as const) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    proof.push({ scenario, validUntil, deadlines: f.input.execution.deadlines, error: 'STRATEGY_OWNER_AUTHORIZATION_WINDOW_TOO_SHORT', ...f.counts(), runnerCalls: 0, permits: 0, inputsUnchanged: true, jDispatchedAfterGrantExpiry: false });
  }
  t.diagnostic(JSON.stringify({ rejectedWhileStillValid: 4, output: out, runnerCalls: 0, realModelCalls: 0 }));
});
test('RRE-R1-01：grant恰好覆盖最晚截止或更长均可用，原deadline和成功恢复不变', async () => {
  for (const extraMs of [0, 1]) {
    const f = await fixture(), maximum = [f.input.execution.deadlines.A, f.input.execution.deadlines.J].sort().at(-1)!;
    const grant = f.grantFor(new Date(Date.parse(maximum) + extraMs).toISOString()), originalGrant = canonicalSha256(grant);
    const first = await executePreparedStrategyReview({ ...f.args, grant }); assert.equal(f.calls.length, 2); assert.equal(first.result.status, 'REVIEW_COMPLETE_RESTRICTED'); assertRealReviewResult(first.result, f.input);
    assert.equal(first.result.receipts.A!.deadline, f.input.execution.deadlines.A); assert.equal(first.result.receipts.J!.deadline, f.input.execution.deadlines.J);
    assert.ok(f.calls.every((c) => c.at <= grant.validUntil && c.at <= f.input.execution.deadlines[c.role as 'A' | 'J']));
    const callsBefore = canonicalSha256(f.pool.snapshot().calls), second = await executePreparedStrategyReview({ ...f.args, grant });
    assert.equal(f.calls.length, 2); assert.equal(second.result.resultHash, first.result.resultHash); assert.equal(canonicalSha256(f.pool.snapshot().calls), callsBefore); assert.equal(canonicalSha256(grant), originalGrant);
    proof.push({ scenario: `COVERS_MAX_PLUS_${extraMs}_MS`, grantValidUntil: grant.validUntil, deadlines: f.input.execution.deadlines, calls: f.calls, resultHash: first.result.resultHash, unchangedGrant: true, unchangedPermitDeadlines: true, recoveryNewCalls: 0 });
  }
});

test('RRE-R1-01：已发FAILED和UNKNOWN原件保留，不延长grant或更换身份重发', async () => {
  for (const fault of ['UNKNOWN', 'FAILED'] as const) {
    const f = await fixture('NORMAL', fault), grant = f.grantFor(f.input.execution.deadlines.J), originalGrant = canonicalSha256(grant);
    const first = await executePreparedStrategyReview({ ...f.args, grant }); assert.equal(first.result.status, fault); assert.equal(first.result.steps.J, 'NOT_RUN'); assert.equal(f.calls.length, 1); assertRealReviewResult(first.result, f.input);
    const originalCalls = canonicalSha256(f.pool.snapshot().calls), originalResult = await readFile(first.resultPath, 'utf8'), before = f.counts();
    await assert.rejects(executePreparedStrategyReview({ ...f.args, grant }), { code: 'STRATEGY_LOCAL_CALL_NOT_RECOVERABLE' });
    assert.deepEqual(f.counts(), before); assert.equal(f.calls.length, 1); assert.equal(canonicalSha256(f.pool.snapshot().calls), originalCalls); assert.equal(await readFile(first.resultPath, 'utf8'), originalResult); assert.equal(canonicalSha256(grant), originalGrant);
    proof.push({ scenario: fault, calls: f.calls, resultPath: first.resultPath, resultHash: first.result.resultHash, preservedCalls: true, preservedResult: true, preservedGrant: true, retryRunnerCalls: 0 });
  }
});
