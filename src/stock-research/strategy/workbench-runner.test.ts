import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from '../../canonical.js';
import type { StrategyData } from './contracts.js';
import { fileWorkbenchStore } from './workbench-store.js';
import { workbenchJson, workbenchSha256, writeWorkbench, type StrictWorkbenchRequest, type WorkbenchManifest, type WorkbenchRequest } from './workbench-runner.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = join(root, 'delivery/CODEX-STRATEGY-CLIENT-20261029/workbench-20261031/history');
const frozen = join(root, 'delivery/CODEX-DAILY-STRATEGY-20261029/frozen');
const realManifest = join(root, 'delivery/CODEX-STRATEGY-CLIENT-20261029/data/client-manifest.json');
const actualManifestPin = 'c69a4b9ff82d8b36cf1fb140bcc578eca425d911267e04d4e930b7b55c304bc2';
const createdAt = '2026-10-31T00:00:00.000Z';
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(evidence, 'checks-'));
async function pin(path: string) { return { path, sha256: workbenchSha256(await readFile(path)) }; }
async function strictRequest(): Promise<StrictWorkbenchRequest> {
  const reference = JSON.parse(await readFile(join(frozen, 'company-report-ref.json'), 'utf8')) as StrictWorkbenchRequest['companyReport']['reference'];
  return { schema: 'lyra-l2-workbench-request-v1', mode: 'STRICT_REPLAY', createdAt,
    data: await pin(join(frozen, 'data.json')), rules: await pin(join(frozen, 'rules.json')),
    companyReport: { file: await pin(resolve(root, reference.path)), reference },
    signalDate: '2026-07-27', simulationWindow: { from: '2026-07-28', to: '2026-08-10' },
    a: await pin(join(frozen, 'a.json')), j: await pin(join(frozen, 'j.json')) };
}
async function run(name: string, request: WorkbenchRequest) {
  const directory = join(temporary, name);
  await mkdir(directory, { recursive: true });
  const requestPath = join(directory, 'input-request.json'), bytes = workbenchJson(request);
  await writeFile(requestPath, bytes, { flag: 'wx' });
  return writeWorkbench(requestPath, workbenchSha256(bytes), join(directory, 'output'));
}
async function rehash(output: string, changes: Record<string, (value: any) => void>) {
  const m = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as WorkbenchManifest;
  for (const [id, change] of Object.entries(changes)) {
    const s = m.sources.find((s) => s.id === id)!;
    const value = JSON.parse(await readFile(join(output, s.path), 'utf8'));
    change(value);
    const bytes = workbenchJson(value);
    await writeFile(join(output, s.path), bytes); s.sha256 = workbenchSha256(bytes);
  }
  const bytes = workbenchJson(m);
  await writeFile(join(output, 'manifest.json'), bytes);
  return workbenchSha256(bytes);
}

test('strict package keeps the accepted synthetic chain, source bytes and immutable output', async () => {
  const request = await strictRequest();
  const receipt = await run('synthetic', request), store = fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256);
  const loaded = await store.load(), r = loaded.result;
  assert.equal(r.inputIdentity, 'SYNTHETIC'); assert.equal(r.status, 'COMPUTED_OFFLINE');
  assert.equal(r.realReviewDone, false); assert.equal(r.executionEligible, false); assert.equal(r.efficacyAccepted, false);
  if (r.status !== 'COMPUTED_OFFLINE') throw new Error('strict result missing');
  assert.equal(r.validation.status, 'SYNTHETIC_BEHAVIOR_ONLY'); assert.equal(r.review.publication, 'OFFLINE_DEMO_REVIEWED');
  assert.equal(r.simulation.identity, 'OFFLINE_FROZEN_PLAN_SIMULATION'); assert.equal(r.simulation.status, 'COMPUTED_SYNTHETIC');
  assert.equal(r.simulation.metrics!.allOpportunities, r.simulation.opportunities.length);
  assert.ok(r.simulation.events.length > 0); assert.equal(r.review.modelExecution.newCalls, 0);
  assert.equal((await store.source('company-report')).sha256, request.companyReport.file.sha256);
  const second = await writeWorkbench(join(dirname(receipt.outputDirectory), 'input-request.json'), receipt.requestSha256, receipt.outputDirectory);
  assert.deepEqual(second, receipt);
  const originalManifest = await readFile(receipt.manifestPath);
  await writeFile(join(receipt.outputDirectory, 'result.json'), 'immutable sentinel');
  await assert.rejects(writeWorkbench(join(dirname(receipt.outputDirectory), 'input-request.json'), receipt.requestSha256, receipt.outputDirectory), /WORKBENCH_IMMUTABLE_CONFLICT/);
  assert.equal(await readFile(join(receipt.outputDirectory, 'result.json'), 'utf8'), 'immutable sentinel');
  assert.deepEqual(await readFile(receipt.manifestPath), originalManifest);
});

test('readiness loads only the pinned actual file store and preserves all missing inputs', async () => {
  const receipt = await run('readiness', { schema: 'lyra-l2-workbench-request-v1', mode: 'REAL_READINESS', createdAt, manifest: { path: realManifest, sha256: actualManifestPin } });
  const store = fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256), r = (await store.load()).result;
  assert.equal(r.status, 'INPUT_BLOCKED'); assert.equal(r.inputIdentity, 'REAL_PUBLIC_DATA');
  assert.equal(r.binding.baseManifestSha256, actualManifestPin);
  assert.equal(r.plan, null); assert.equal(r.validation, null); assert.equal(r.review, null); assert.equal(r.simulation, null); assert.equal(r.account, null);
  assert.equal(r.blockers.filter((i) => i.code === 'REAL_SERIES_DATE_MISSING').length, 8);
  for (const code of ['LATEST_REVISED_NOT_HISTORICAL_PIT', 'INDEPENDENT_OPEN_OBSERVATIONS_MISSING', 'DAILY_RULE_AND_ACTION_EXECUTION_INPUTS_UNVERIFIED', 'USER_ACCOUNT_AND_RISK_BUDGET_MISSING', 'REAL_A_AND_MANDATORY_J_NOT_RUN']) assert.ok(r.blockers.some((i) => i.code === code));
  assert.equal(receipt.modelCalls, 0); assert.equal(receipt.databaseReads, 0); assert.equal(receipt.databaseWrites, 0); assert.equal(receipt.collections, 0);
  const source = (await store.load()).sources.find((s) => s.id === 'real-dataset')!;
  const manifest = JSON.parse(await readFile(receipt.manifestPath, 'utf8')) as WorkbenchManifest;
  await writeFile(join(receipt.outputDirectory, manifest.sources.find((s) => s.id === source.id)!.path), '{}');
  await assert.rejects(store.load(), /WORKBENCH_SOURCE_HASH_MISMATCH/);
  await assert.rejects(store.source('result'), /WORKBENCH_SOURCE_HASH_MISMATCH/);
});

test('missing and drifting pins or files fail without a synthetic fallback', async () => {
  const request = await strictRequest();
  const directory = join(temporary, 'pins'); await mkdir(directory);
  const requestPath = join(directory, 'request.json'), bytes = workbenchJson(request); await writeFile(requestPath, bytes);
  await assert.rejects(writeWorkbench(requestPath, '', join(directory, 'missing-pin')), /WORKBENCH_PIN_REQUIRED/);
  await assert.rejects(writeWorkbench(requestPath, '0'.repeat(64), join(directory, 'wrong-pin')), /WORKBENCH_REQUEST_HASH_MISMATCH/);
  await assert.rejects(run('wrong-data-pin', { ...request, data: { ...request.data, sha256: '0'.repeat(64) } }), /WORKBENCH_INPUT_HASH_MISMATCH/);
  await assert.rejects(run('missing-file', { ...request, data: { ...request.data, path: join(directory, 'does-not-exist.json') } }), /ENOENT/);
  await assert.rejects(run('missing-real', { schema: 'lyra-l2-workbench-request-v1', mode: 'REAL_READINESS', createdAt, manifest: { path: join(directory, 'missing-real.json'), sha256: actualManifestPin } }), /ENOENT/);
});

test('LATEST_REVISED is refused by the strict input boundary', async () => {
  const request = await strictRequest(), data = JSON.parse(await readFile(request.data.path, 'utf8')) as StrategyData;
  data.revisionPolicy = 'LATEST_REVISED';
  const path = join(temporary, 'latest-revised.json'); await writeFile(path, workbenchJson(data));
  await assert.rejects(run('latest-revised', { ...request, data: await pin(path) }), /LATEST_REVISED_NOT_PIT/);
});

test('missing A or J and rejected static J remain blocked', async () => {
  const request = await strictRequest();
  const cases = [
    { name: 'a-missing', request: { ...request, a: null, j: null }, blocker: 'A_MISSING' },
    { name: 'j-missing', request: { ...request, j: null }, blocker: 'MANDATORY_J_MISSING' },
    { name: 'j-rejected', request: { ...request, j: await pin(join(frozen, 'j-rejected.json')) }, blocker: 'J_BEARING_REJECTED:' },
  ];
  for (const c of cases) {
    const receipt = await run(c.name, c.request), r = (await fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256).load()).result;
    assert.equal(r.status, 'COMPUTED_OFFLINE'); if (r.status !== 'COMPUTED_OFFLINE') throw new Error('strict result missing');
    assert.equal(r.review.gate.passed, false); assert.ok(r.review.gate.blockers.some((b) => b.startsWith(c.blocker)));
    assert.equal(r.simulation.status, 'REVIEW_BLOCKED'); assert.equal(r.simulation.metrics, null); assert.equal(r.simulation.finalPortfolio, null);
  }
});

test('incomplete validation keeps the original gate and does not invent metrics', async () => {
  const request = await strictRequest(), data = JSON.parse(await readFile(request.data.path, 'utf8')) as StrategyData;
  const rules = JSON.parse(await readFile(request.rules.path, 'utf8'));
  data.openings = data.openings.filter((q) => !(q.subject === data.marketBenchmark && q.date === rules.inSample.from));
  const path = join(temporary, 'incomplete-data.json'); await writeFile(path, workbenchJson(data));
  const receipt = await run('incomplete', { ...request, data: await pin(path) });
  const r = (await fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256).load()).result;
  if (r.status !== 'COMPUTED_OFFLINE') throw new Error('strict result missing');
  assert.equal(r.validation.status, 'INCOMPLETE'); assert.equal(r.validation.inSample.metrics, null);
  assert.ok(r.review.gate.blockers.includes('HISTORICAL_VALIDATION_INCOMPLETE')); assert.equal(r.review.publication, 'VALIDATION_PENDING');
  assert.equal(r.simulation.status, 'REVIEW_BLOCKED'); assert.equal(r.simulation.metrics, null);
});

test('rehashing outer artifacts does not permit cross-plan, rule or window substitution', async () => {
  for (const kind of ['plan', 'rules', 'window'] as const) {
    const receipt = await run(`cross-${kind}`, await strictRequest());
    const mutation = (r: any) => {
      if (kind === 'plan') r.plan.signalDate = '2026-07-28';
      if (kind === 'rules') r.validation.inSample.rulesHash = '1'.repeat(64);
      if (kind === 'window') r.simulation.window.from = '2026-07-29';
      const { resultHash: _hash, ...core } = r; r.resultHash = canonicalSha256(core);
    };
    const newPin = await rehash(receipt.outputDirectory, { result: mutation });
    const store = fileWorkbenchStore(receipt.manifestPath, newPin);
    await assert.rejects(store.load(), /WORKBENCH_RESULT_BINDING_INVALID/);
    await assert.rejects(store.source('result'), /WORKBENCH_RESULT_BINDING_INVALID/);
  }
  const receipt = await run('cross-component', await strictRequest());
  const newPin = await rehash(receipt.outputDirectory, { simulation: (r) => { r.window.from = '2026-07-29'; } });
  await assert.rejects(fileWorkbenchStore(receipt.manifestPath, newPin).load(), /WORKBENCH_OUTPUT_BINDING_INVALID/);
});

test('manifest and source pins are checked again on every read', async () => {
  const receipt = await run('manifest-drift', await strictRequest()), store = fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256);
  await store.load();
  await writeFile(receipt.manifestPath, `${await readFile(receipt.manifestPath, 'utf8')}\n`);
  await assert.rejects(store.load(), /WORKBENCH_MANIFEST_HASH_MISMATCH/);
  await assert.rejects(store.source('company-report'), /WORKBENCH_MANIFEST_HASH_MISMATCH/);
});

test('consumer rejects traversal and symbolic-link escape even when hashes match', async () => {
  const receipt = await run('link-escape', await strictRequest());
  const path = join(receipt.outputDirectory, 'inputs/data.json'); await unlink(path);
  await symlink(join(frozen, 'data.json'), path);
  const store = fileWorkbenchStore(receipt.manifestPath, receipt.manifestSha256);
  await assert.rejects(store.load(), /WORKBENCH_SOURCE_LINK_ESCAPE/);
  await assert.rejects(store.source('result'), /WORKBENCH_SOURCE_LINK_ESCAPE/);
  const other = await run('traversal', await strictRequest());
  const m = JSON.parse(await readFile(other.manifestPath, 'utf8')) as WorkbenchManifest;
  m.sources.find((s) => s.id === 'data')!.path = '../outside.json';
  const bytes = workbenchJson(m); await writeFile(other.manifestPath, bytes);
  await assert.rejects(fileWorkbenchStore(other.manifestPath, workbenchSha256(bytes)).load(), /WORKBENCH_SOURCE_PATH_INVALID/);
});

test('CLI requires an explicit request, request pin and output directory', async () => {
  const { runWorkbenchCli } = await import('./workbench-entry.js');
  await assert.rejects(runWorkbenchCli([]), /WORKBENCH_USAGE/);
});
