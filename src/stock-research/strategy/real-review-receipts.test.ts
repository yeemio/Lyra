/** SRR-R1-01: replay frozen receipts only; no transport dispatch or database connection. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { canonicalSha256 } from '../../canonical.js';
import { assertRealReviewResult, type RealReviewInput, type RealReviewResult } from './real-review.js';
import { fileStrategyStore, type RealClientManifest } from './real-store.js';
import { blockExternalEffects } from './review-isolated.js';

const ROOT = fileURLToPath(new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/continuation-20261031/', import.meta.url));
const invalid = 'STRATEGY_REVIEW_RECEIPT_OR_ARTIFACT_INVALID';
type Role = 'A' | 'J';
type Fixture = { input: RealReviewInput; result: RealReviewResult; manifestPath: string; manifestSha256: string };
type Proof = { name: string; expected: 'ACCEPT' | 'REJECT'; actual: 'ACCEPT' | 'REJECT'; code: string | null };
const fixtures = new Map<string, Fixture>(), proof: Proof[] = [];
let directory: string, guard: ReturnType<typeof blockExternalEffects>;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function rehash(result: RealReviewResult): RealReviewResult {
  const { resultHash: _, ...core } = result; return { ...core, resultHash: canonicalSha256(core) };
}
function check(name: string, fixture: Fixture, result: RealReviewResult, expected: 'ACCEPT' | 'REJECT', expectedCode = invalid): void {
  let actual: Proof['actual'] = 'ACCEPT', code: string | null = null;
  try { assertRealReviewResult(rehash(result), fixture.input); }
  catch (e) { actual = 'REJECT'; code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e); }
  proof.push({ name, expected, actual, code });
  assert.equal(actual, expected, name); if (expected === 'REJECT') assert.equal(code, expectedCode, name);
}
before(async () => {
  guard = blockExternalEffects(); directory = await mkdtemp(join(ROOT, 'r2/receipt-binding-'));
  const index = JSON.parse(await readFile(join(ROOT, 'isolated-reproduction-r1/reproduction.json'), 'utf8')) as { cases: { fault: string; resultPath: string; manifest: { manifestPath: string; manifestSha256: string } }[] };
  for (const entry of index.cases) {
    const input = JSON.parse(await readFile(join(dirname(entry.manifest.manifestPath), 'review-input.json'), 'utf8')) as RealReviewInput;
    fixtures.set(entry.fault, { input, result: JSON.parse(await readFile(entry.resultPath, 'utf8')) as RealReviewResult, ...entry.manifest });
  }
});
after(async () => {
  try {
    await writeFile(join(directory, 'proof.json'), JSON.stringify({ identity: 'FROZEN_RECEIPT_VALIDATOR_REPLAY', assignment: 'rework-strategy-review-source-r2-20261031', realModelCalls: 0, transportDispatches: 0, attempts: guard.attempts, cases: proof }, null, 2) + '\n', { flag: 'wx' });
    assert.deepEqual(guard.attempts, { database: 0, externalFetch: 0 });
  } finally { guard.restore(); }
});

test('SRR-R1-01：R1九种真实封存隔离回执仍可被正常文件消费者读取', async (t) => {
  for (const [name, fixture] of fixtures) {
    check(`original:${name}`, fixture, fixture.result, 'ACCEPT');
    const loaded = await fileStrategyStore(fixture.manifestPath, fixture.manifestSha256).load();
    assert.equal(loaded.researchReview?.resultHash, fixture.result.resultHash);
  }
  t.diagnostic(JSON.stringify({ replayedOriginalCases: fixtures.size, output: directory, transportDispatches: 0 }));
});

function receiptStates(role: Role): { name: string; fixture: Fixture; result: RealReviewResult }[] {
  const fixture = fixtures.get(role === 'A' ? 'A_UNKNOWN' : 'J_UNKNOWN')!;
  return ['UNKNOWN', 'SENT', 'PREPARED', 'FAILED_UNSENT', 'FAILED_SENT', 'SUCCEEDED_OUTPUT_MISSING'].map((name) => {
    // PREPARED/SENT and missing-output records are declared validation fixtures derived from the frozen receipt.
    const result = structuredClone(fixture.result), call = result.receipts[role]!;
    call.state = name === 'FAILED_UNSENT' || name === 'FAILED_SENT' ? 'FAILED' : name === 'SUCCEEDED_OUTPUT_MISSING' ? 'SUCCEEDED' : name as typeof call.state;
    call.failCode = ['SENT', 'PREPARED', 'SUCCEEDED_OUTPUT_MISSING'].includes(name) ? null : name === 'FAILED_UNSENT' ? 'DEADLINE_EXCEEDED' : name === 'FAILED_SENT' ? 'MODEL_OUTPUT_SCHEMA_INVALID' : call.failCode;
    if (name === 'PREPARED' || name === 'FAILED_UNSENT') { call.sentAt = null; call.provider = null; call.modelId = null; call.usage = null; }
    if (name === 'PREPARED' || name === 'SENT') call.settledAt = null;
    result.steps[role] = call.state;
    result.status = name === 'UNKNOWN' || name === 'SENT' ? 'UNKNOWN' : 'FAILED';
    result.error = { code: 'ISOLATED_RECEIPT_REPLAY_BLOCKED', message: 'Validation fixture only; no resampling or recovered output asserted' };
    result.modelCalls = [result.receipts.A, result.receipts.J].filter((r) => r?.sentAt).length;
    return { name, fixture, result: rehash(result) };
  });
}

test('SRR-R1-01：A/J全部状态均绑定任务、角色、版本、截止、call身份与精确prompt', (t) => {
  let mutations = 0;
  for (const role of ['A', 'J'] as const) for (const entry of receiptStates(role)) {
    check(`${role}:${entry.name}:valid`, entry.fixture, entry.result, 'ACCEPT');
    const changes: [string, (r: RealReviewResult) => void][] = [
      ['taskId', (r) => { r.receipts[role]!.taskId = '00000000-0000-5000-a000-000000000001'; }],
      ['stepId', (r) => { r.receipts[role]!.stepId = entry.fixture.input.stepIds[role === 'A' ? 'J' : 'A']; }],
      ['methodVersion', (r) => { r.receipts[role]!.methodVersion += ':other'; }],
      ['planAuthVersion', (r) => { r.receipts[role]!.planAuthVersion += ':other'; }],
      ['deadline', (r) => { r.receipts[role]!.deadline = '2099-01-01T00:00:00.000Z'; }],
      ['callId', (r) => { r.receipts[role]!.callId = '00000000-0000-4000-8000-000000000002'; }],
      ['permitId', (r) => { r.receipts[role]!.permitId = '00000000-0000-4000-8000-000000000002'; }],
      ['invalidCallId', (r) => { r.receipts[role]!.callId = r.receipts[role]!.permitId = 'unverifiable-call'; }],
      ['inputHash', (r) => { r.receipts[role]!.inputHash = '0'.repeat(64); }],
      ['inputBytes', (r) => { r.receipts[role]!.inputBytes += 1; }],
      ['simulated', (r) => { r.receipts[role]!.simulated = false; }],
      ['provider', (r) => { r.receipts[role]!.provider = 'unrelated-provider'; }],
      ['modelId', (r) => { r.receipts[role]!.modelId = 'unrelated-model'; }],
      ['effort', (r) => { r.receipts[role]!.usage = { reasoningEffort: 'unrelated-effort' }; }],
    ];
    for (const [name, mutate] of changes) { const result = structuredClone(entry.result); mutate(result); check(`${role}:${entry.name}:wrong-${name}`, entry.fixture, result, 'REJECT'); mutations++; }
    if (entry.result.receipts[role]!.sentAt === null) {
      for (const name of ['provider', 'modelId', 'usage'] as const) {
        const result = structuredClone(entry.result), call = result.receipts[role]!, desc = entry.fixture.input.execution.transports[role];
        if (name === 'provider') call.provider = desc.provider; else if (name === 'modelId') call.modelId = desc.modelId; else call.usage = { reasoningEffort: desc.effort! };
        check(`${role}:${entry.name}:fabricated-unsent-${name}`, entry.fixture, result, 'REJECT'); mutations++;
      }
    }
  }
  t.diagnostic(JSON.stringify({ roles: 2, statesPerRole: 6, bindingMutationsRejected: mutations, output: join(directory, 'proof.json') }));
});

test('SRR-R1-01：J回执缺A/清单依赖及A/J复用call身份必须显式拒绝', () => {
  const fixture = fixtures.get('J_UNKNOWN')!, missing = structuredClone(fixture.result);
  missing.a = null; missing.checklist = null; missing.steps.CHECKLIST = 'NOT_DERIVED_WITHOUT_A'; missing.promptBytes.J = null;
  check('J:missing-bound-A-and-checklist', fixture, missing, 'REJECT', 'STRATEGY_J_RECEIPT_DEPENDENCIES_MISSING');
  const repeated = structuredClone(fixture.result); repeated.receipts.J!.callId = repeated.receipts.J!.permitId = repeated.receipts.A!.callId;
  check('J:call-identity-reused-from-A', fixture, repeated, 'REJECT');
});

test('SRR-R1-01：四个主控反例重算result和manifest hash后仍被正常文件消费者拒绝', async (t) => {
  const fixture = fixtures.get('A_UNKNOWN')!, manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as RealClientManifest;
  const client = join(directory, 'repinned-client'); await mkdir(client);
  for (const source of manifest.sources) { const target = join(client, source.path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(dirname(fixture.manifestPath), source.path), target); }
  const mutations: [string, (r: RealReviewResult) => void][] = [
    ['wrong_task_id', (r) => { r.receipts.A!.taskId = '00000000-0000-5000-a000-000000000001'; }],
    ['wrong_step_id', (r) => { r.receipts.A!.stepId = fixture.input.stepIds.J; }],
    ['wrong_prompt_hash', (r) => { r.receipts.A!.inputHash = '0'.repeat(64); }],
    ['wrong_provider', (r) => { r.receipts.A!.provider = 'unrelated-provider'; }],
  ];
  for (const [name, mutate] of mutations) {
    const result = structuredClone(fixture.result); mutate(result); const bytes = Buffer.from(JSON.stringify(rehash(result)));
    await writeFile(join(client, `${name}-result.json`), bytes, { flag: 'wx' });
    const current = structuredClone(manifest), resultSource = current.sources.find((s) => s.id === current.review!.resultId)!; resultSource.path = `${name}-result.json`; resultSource.sha256 = sha(bytes);
    const pinned = Buffer.from(JSON.stringify(current)), path = join(client, `${name}-manifest.json`); await writeFile(path, pinned, { flag: 'wx' });
    let code: string | null = null;
    try { await fileStrategyStore(path, sha(pinned)).load(); } catch (e) { code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e); }
    proof.push({ name: `normal-file-consumer:${name}`, expected: 'REJECT', actual: code ? 'REJECT' : 'ACCEPT', code }); assert.equal(code, invalid, name);
  }
  t.diagnostic(JSON.stringify({ controllerCounterexamplesRejected: mutations.length, repinnedManifests: client, database: 0, transportDispatches: 0 }));
});
