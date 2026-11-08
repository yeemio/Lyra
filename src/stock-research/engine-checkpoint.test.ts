/** Pure request/CAS checks only; JSON key reordering here is not a PostgreSQL run. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { defaultSrPlanBudget } from './contracts.js';
import { assertSrModelArtifact, type SrInputCheckpoint } from './engine-checkpoint.js';
import { putStepArtifact, readStepArtifact } from './report-artifacts.js';

function fixture() {
  const input = { subjectName: '公开合成公司', subject: '600101', coverage: { rows: 1, gaps: [] } };
  const inputJson = JSON.stringify(input, null, 1);
  const inputHash = createHash('sha256').update(inputJson, 'utf8').digest('hex');
  const inputBytes = Buffer.byteLength(inputJson, 'utf8');
  const step = { taskId: randomUUID(), stepId: randomUUID(), stepKind: 'PLAN' as const, sectionKey: null, sequence: 1 };
  const output = { questions: [{ text: '合成问题', priority: 1 }] };
  const frozen: SrInputCheckpoint = { version: 1,
    contract: { taskId: step.taskId, stepId: step.stepId, inputHash, inputBytes, methodVersion: 'sr-m1',
      planAuthVersion: 'sr-auth-1', deadline: '2026-12-01T00:00:00.000Z' },
    modelStep: 'PLAN', input: JSON.parse(canonicalJsonString(input)),
    transport: { provider: 'synthetic-only', simulated: true, modelId: 'no-dispatch' },
    wire: { inputHash, inputBytes }, budget: defaultSrPlanBudget() };
  return { step, frozen, value: { inputJson, input, output } };
}

test('I11: original CAS bytes survive object-key reordering in the structured checkpoint', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pr4-r2-cas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { step, frozen, value } = fixture();
  const ref = await putStepArtifact(dir, step, value);
  const saved = await readStepArtifact<typeof value>(dir, step, ref);
  assert.notEqual(saved.inputJson, JSON.stringify(frozen.input, null, 1), 'old textual comparison would reject');
  assert.deepEqual(JSON.parse(saved.inputJson), frozen.input);
  assert.equal(canonicalSha256(saved.input), canonicalSha256(frozen.input));
  assert.ok(frozen.contract.inputBytes > saved.inputJson.length, 'contract counts UTF-8 bytes');
  assert.doesNotThrow(() => assertSrModelArtifact(frozen, saved, value.output));
});

test('I11: changed raw text, byte count, structured input and output remain conflicts', () => {
  const { frozen, value } = fixture();
  const cases: { label: string; checkpoint?: SrInputCheckpoint; artifact?: typeof value }[] = [
    { label: 'same structure with different whitespace', artifact: { ...value, inputJson: value.inputJson + '\n' } },
    { label: 'same structure with reordered raw text', artifact: { ...value, inputJson: JSON.stringify(frozen.input, null, 1) } },
    { label: 'wrong contract hash', checkpoint: { ...frozen, contract: { ...frozen.contract, inputHash: '0'.repeat(64) } } },
    { label: 'wrong contract byte count', checkpoint: { ...frozen, contract: { ...frozen.contract, inputBytes: frozen.contract.inputBytes + 1 } } },
    { label: 'changed checkpoint input', checkpoint: { ...frozen, input: { ...value.input, subject: '600102' } } },
    { label: 'changed CAS structured input', artifact: { ...value, input: { ...value.input, subject: '600102' } } },
    { label: 'changed CAS output', artifact: { ...value, output: { questions: [] } } },
    { label: 'invalid JSON text', artifact: { ...value, inputJson: '{' } },
  ];
  for (const c of cases) assert.throws(() => assertSrModelArtifact(c.checkpoint ?? frozen, c.artifact ?? value, value.output),
    { code: 'SR_CHECKPOINT_CONFLICT' }, c.label);
  const changedRaw = JSON.stringify({ ...value.input, subject: '600102' }, null, 1);
  // Matching raw hash/bytes alone cannot replace the original structured request.
  const rebound = { ...frozen, contract: { ...frozen.contract,
    inputHash: createHash('sha256').update(changedRaw).digest('hex'), inputBytes: Buffer.byteLength(changedRaw) } };
  assert.throws(() => assertSrModelArtifact(rebound, { ...value, inputJson: changedRaw }, value.output), { code: 'SR_CHECKPOINT_CONFLICT' });
});

test('I11: CAS step identity and missing-original rejection remain mandatory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pr4-r2-cas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { step, value } = fixture();
  const ref = await putStepArtifact(dir, step, value);
  for (const changed of [{ ...step, taskId: randomUUID() }, { ...step, stepId: randomUUID() },
    { ...step, stepKind: 'ANALYZE' as const }, { ...step, sectionKey: 'a' }, { ...step, sequence: 2 }]) {
    await assert.rejects(readStepArtifact(dir, changed, ref), { code: 'SR_ARTIFACT_BINDING_MISMATCH' });
  }
  await assert.rejects(readStepArtifact(dir, step, null), { code: 'SR_ARTIFACT_UNBOUND' });
  await rm(join(dir, 'artifacts', ref.sha256.slice(0, 2), ref.sha256));
  await assert.rejects(readStepArtifact(dir, step, ref), { code: 'ARTIFACT_MISSING' });
});
