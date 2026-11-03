import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { Pool } from 'pg';
import { KernelError } from '../contracts.js';
import { createPool, pgEnv } from '../db/pool.js';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createAccount } from './accounts.js';
import { createTask } from './store.js';
import { runSrTask, askReportQuestion } from './engine.js';
import { defaultSrPlanBudget, type SrModelStepKind } from './contracts.js';
import { selectSrTransport, SimSrTransport, STEP_INSTRUCTIONS } from './transport.js';
import { DshSrTransport, dshConfigFromEnv } from './dsh.js';
import { ReadOnlyDshCredentials, openReadOnlyDshAccount } from './dsh-native-account.js';

const evidenceDir = resolve('delivery/CODEX-DSH-CHANNEL-20261028/r2');
const token = 'lyra_test_synthetic_not_a_real_credential';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v, null, 1)).digest('hex');
const context = (v: unknown) => ({ callId: randomUUID(), inputHash: hash(v) });

function sse(res: ServerResponse, text: string, stopReason = 'end_turn') {
  const frames = [
    { type: 'message_start', message: { id: 'local-synthetic', model: 'deepseek-flash', usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frames.map(v => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`).join(''));
}

async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, any>) => Promise<void> | void) {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-dsh-'));
  const errors: unknown[] = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      requests++;
      assert.equal(req.url, '/anthropic/v1/messages');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-dsh-auth-token'], token);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'deepseek-flash');
      await handler(req, res, body);
    } catch (error) { errors.push(error); res.writeHead(500); res.end('local fixture failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const credentialsPath = join(dir, 'synthetic.yaml');
  await writeFile(credentialsPath, JSON.stringify({ version: 1, records: { 'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token, issuer: origin } } } }), { mode: 0o600 });
  const before = await readFile(credentialsPath);
  const env = { LYRA_SR_TRANSPORT: 'dsh', LYRA_SR_REAL_CALLS: '1', LYRA_SR_DSH_MODEL: 'deepseek-flash', LYRA_SR_DSH_ENDPOINT: `${origin}/anthropic`, LYRA_SR_DSH_PLATFORM_ORIGIN: origin, LYRA_SR_DSH_CREDENTIALS_PATH: credentialsPath, LYRA_SR_DSH_LOCAL_VALIDATION: '1' };
  return { env, credentialsPath, requests: () => requests, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); assert.deepEqual(errors, []); assert.ok(before.equals(await readFile(credentialsPath)), 'synthetic credentials unchanged'); } };
}

it('selection/default/authorization/binding/config fail closed before credential or network access', async () => {
  assert.ok(selectSrTransport({}, true) instanceof SimSrTransport);
  assert.equal(selectSrTransport({}, false).describe().provider, 'codex-native-sr');
  assert.ok(selectSrTransport({ LYRA_SR_TRANSPORT: 'dsh' }, false) instanceof DshSrTransport);
  const disabled = selectSrTransport({ LYRA_SR_TRANSPORT: 'dsh', LYRA_SR_DSH_CREDENTIALS_PATH: '/missing' }, false);
  await assert.rejects(disabled.dispatch('PLAN', context({}), {}), { code: 'MODEL_PROVIDER_UNAUTHORIZED' });
  const enabled = dshConfigFromEnv({ LYRA_SR_REAL_CALLS: '1' });
  await assert.rejects(new DshSrTransport(enabled).dispatch('PLAN', { callId: 'x', inputHash: 'wrong' }, {}), { code: 'DSH_INPUT_BINDING_INVALID' });
  await assert.rejects(new DshSrTransport({ ...enabled, endpoint: 'https://example.com/anthropic' }).dispatch('PLAN', context({}), {}), { code: 'DSH_CONFIG_INVALID' });
});

it('native credential provider denies every mutation; missing/malformed/issuer mismatch stays local and redacted', async () => {
  const f = await fixture((_req, res) => sse(res, '{}'));
  try {
    const ctx = new Context();
    await ctx.plugin(ReadOnlyDshCredentials, f.credentialsPath);
    try {
      const key = credentialKey('deepseek-account-platform', 'default');
      assert.equal((await ctx.credentials.describeRecord(key)).writable, false);
      for (const operation of [() => ctx.credentials.set(credentialRef('SYNTHETIC'), token), () => ctx.credentials.unset(credentialRef('SYNTHETIC')), () => ctx.credentials.modifyRecord(key, async v => v), () => ctx.credentials.deleteRecord(key)]) await assert.rejects(operation(), /DSH_CREDENTIAL_MUTATION_DENIED/);
    } finally { await ctx.fiber.dispose(); }
    for (const path of ['/missing/lyra-dsh.yaml', f.credentialsPath]) {
      const cfg = dshConfigFromEnv({ ...f.env, LYRA_SR_DSH_CREDENTIALS_PATH: path, LYRA_SR_DSH_PLATFORM_ORIGIN: 'http://127.0.0.1:1' });
      await assert.rejects(new DshSrTransport(cfg).dispatch('PLAN', context({}), {}), { code: 'DSH_PREPARATION_FAILED' });
    }
    const malformed = join(await mkdtemp(join(tmpdir(), 'dsh-malformed-')), 'credential.yaml');
    await writeFile(malformed, 'version: 9\nsecret: synthetic-parse-marker');
    await assert.rejects(new DshSrTransport(dshConfigFromEnv({ ...f.env, LYRA_SR_DSH_CREDENTIALS_PATH: malformed })).dispatch('PLAN', context({}), {}), error => error instanceof KernelError && error.code === 'DSH_PREPARATION_FAILED' && !error.message.includes('synthetic-parse-marker'));
    const nonTestGrant = join(await mkdtemp(join(tmpdir(), 'dsh-nontest-shape-')), 'credential.yaml');
    await writeFile(nonTestGrant, JSON.stringify({ version: 1, records: { 'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token: 'synthetic-non-test-shaped-grant', issuer: f.env.LYRA_SR_DSH_PLATFORM_ORIGIN } } } }));
    await assert.rejects(new DshSrTransport(dshConfigFromEnv({ ...f.env, LYRA_SR_DSH_CREDENTIALS_PATH: nonTestGrant })).dispatch('PLAN', context({}), {}), { code: 'DSH_PREPARATION_FAILED' });
    assert.equal(f.requests(), 0);
  } finally { await f.close(); }
});

it('official SDK performs one Messages request; rejects HTTP/invalid JSON, contains redirects/truncation/timeout and redacts errors', async () => {
  const cases = [
    { name: 'valid', handle: (_req: IncomingMessage, res: ServerResponse) => sse(res, '{"questions":["q"],"materialPriorities":[],"emphasisNotes":[]}'), code: null },
    { name: '429', handle: (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(429); res.end(`error ${token}`); }, code: 'DSH_HTTP_REJECTED' },
    { name: 'invalid-json', handle: (_req: IncomingMessage, res: ServerResponse) => sse(res, `invalid ${token}`), code: 'SR_OUTPUT_INVALID_JSON' },
    { name: 'max-tokens-terminal', handle: (_req: IncomingMessage, res: ServerResponse) => sse(res, '{"questions":["q"],"materialPriorities":[],"emphasisNotes":[]}', 'max_tokens'), code: 'DSH_OUTPUT_INCOMPLETE' },
    { name: 'redirect', handle: (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(307, { location: '/forbidden-redirect' }); res.end(); }, code: 'SILENCE_AFTER_SEND' },
    { name: 'truncated', handle: (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {}\n\n'); }, code: 'SILENCE_AFTER_SEND' },
    { name: 'response-limit', handle: (_req: IncomingMessage, res: ServerResponse) => sse(res, 'x'.repeat(1024)), code: 'SILENCE_AFTER_SEND' },
    { name: 'timeout', handle: (_req: IncomingMessage, _res: ServerResponse) => {}, code: 'SILENCE_AFTER_SEND' },
  ];
  const results = [];
  for (const c of cases) {
    const f = await fixture(c.handle);
    try {
      const transport = new DshSrTransport({ ...dshConfigFromEnv(f.env), callWindowMs: c.name === 'timeout' ? 1200 : 10000, maxResponseBytes: c.name === 'response-limit' ? 64 : 4 * 1024 * 1024 });
      if (c.code) await assert.rejects(transport.dispatch('PLAN', context({}), {}), error => error instanceof KernelError && error.code === c.code && !error.message.includes(token));
      else assert.deepEqual(await transport.dispatch('PLAN', context({}), {}), { questions: ['q'], materialPriorities: [], emphasisNotes: [] });
      assert.equal(f.requests(), 1, `${c.name}: no retries/redirect/refresh`);
      results.push({ case: c.name, requests: f.requests(), result: c.code ?? 'PARSED', secretInError: false });
    } finally { await f.close(); }
  }
  await writeFile(join(evidenceDir, 'native-sdk-cases.json'), JSON.stringify({ label: 'LOCAL_SYNTHETIC_SDK_ONLY', results }, null, 2));
});

it('selector → unique executor/permit → official SDK → business validation/persistence/J/chat; replay and UNKNOWN block resends', async () => {
  const seen: SrModelStepKind[] = [];
  const sim = new SimSrTransport();
  let mode: 'valid' | 'invalid-schema' | 'unknown' | 'max-tokens' = 'valid';
  const responseDelayMs = 80;
  const f = await fixture(async (_req, res, body) => {
    const prompt = body.messages[0].content[0].text as string;
    const step = (Object.keys(STEP_INSTRUCTIONS) as SrModelStepKind[]).find(key => prompt.startsWith(STEP_INSTRUCTIONS[key]));
    assert.ok(step);
    seen.push(step);
    const input = JSON.parse(prompt.split('# 输入（JSON）\n')[1]!);
    await new Promise(resolve => setTimeout(resolve, responseDelayMs));
    if (mode === 'unknown') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
    if (mode === 'max-tokens') { sse(res, JSON.stringify(await sim.dispatch(step, context(input), input)), 'max_tokens'); return; }
    if (mode === 'invalid-schema') { sse(res, '{}'); return; }
    sse(res, JSON.stringify(await sim.dispatch(step, context(input), input)));
  });
  const schema = `sr_dsh_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = createPool(), srPool = createPool({ schema });
  const dataPool = new Pool({ ...pgEnv(), options: '-c default_transaction_read_only=on' });
  const outputDir = await mkdtemp(join(tmpdir(), 'lyra-dsh-engine-'));
  let created = false;
  try {
    await applySchema(admin, schema, srMigrationSqlUrl); created = true;
    assert.equal((await dataPool.query('show default_transaction_read_only')).rows[0]!.default_transaction_read_only, 'on');
    const account = await createAccount(srPool, { username: 'dsh_offline', password: randomUUID(), role: 'USER' });
    const newTask = async () => (await createTask(srPool, { accountId: account.accountId, subject: '600519', subjectName: 'fixture', focus: 'BUSINESS', horizon: 'LONG_TERM', emphasis: null, cutoff: '2026-10-28T06:40:00.000Z', idemKey: randomUUID(), methodVersion: 'sr-m1', adapterVersion: 'dsh-offline-r1', planAuthVersion: 'sr-auth-1' })).task;
    const deps = { srPool, dataPool, outputDir, transport: selectSrTransport(f.env, false), budget: defaultSrPlanBudget() };
    const task = await newTask();
    const result = await runSrTask(deps, task.taskId);
    assert.ok(result.report, JSON.stringify(result.task.error));
    assert.deepEqual(seen, ['PLAN', 'ANALYZE', 'ANALYZE', 'ANALYZE', 'A_FINAL', 'JUDGE']);
    assert.equal(result.report.generatedBy, 'PRODUCT_SIMULATED', 'local SDK fixture never becomes real-model evidence');
    assert.equal(result.report.status, 'PUBLISHED_RESTRICTED', 'original J publication gate retained');
    const replay = await runSrTask(deps, task.taskId);
    assert.equal(f.requests(), 6); assert.equal(replay.report!.contentHash, result.report.contentHash);
    const dir = join(outputDir, 'tasks', task.taskId);
    const pack = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
    const computed = JSON.parse(await readFile(join(dir, 'computed.json'), 'utf8'));
    const message = await askReportQuestion(deps, account.accountId, { taskId: task.taskId, reportVersion: 1, question: 'What evidence is missing?', questionKind: 'MISSING_DATA', pack, computed });
    assert.equal(message.role, 'ASSISTANT'); assert.equal(seen.at(-1), 'CHAT_ANSWER');
    const calls = (await srPool.query('select state, simulated, provider, model_id, input_hash, usage from sr_call where task_id=$1', [task.taskId])).rows;
    assert.equal(calls.length, 7); assert.ok(calls.every(c => c.state === 'SUCCEEDED' && c.simulated && c.provider === 'dsh-deepseek-native-sr' && c.model_id === 'deepseek-flash' && c.input_hash));
    assert.ok(calls.every(c => c.usage.durationMs >= responseDelayMs), 'successful duration includes actual model wait');
    mode = 'invalid-schema';
    const invalid = await newTask(), invalidResult = await runSrTask(deps, invalid.taskId);
    assert.equal(invalidResult.task.status, 'FAILED'); assert.equal(invalidResult.task.error!.code, 'MODEL_OUTPUT_SCHEMA_INVALID'); assert.equal(invalidResult.report, null);
    const invalidCall = (await srPool.query('select state,provider,model_id,usage from sr_call where task_id=$1', [invalid.taskId])).rows[0]!;
    assert.equal(invalidCall.state, 'FAILED'); assert.ok(invalidCall.usage.durationMs >= responseDelayMs, 'known failure duration includes wait and validation');
    mode = 'max-tokens';
    const incomplete = await newTask();
    const beforeIncomplete = f.requests();
    const incompleteResult = await runSrTask(deps, incomplete.taskId);
    assert.equal(incompleteResult.task.error!.code, 'DSH_OUTPUT_INCOMPLETE'); assert.equal(incompleteResult.report, null);
    const incompleteCall = (await srPool.query('select state,fail_code,provider,model_id,usage from sr_call where task_id=$1', [incomplete.taskId])).rows[0]!;
    assert.equal(incompleteCall.state, 'FAILED'); assert.equal(incompleteCall.fail_code, 'DSH_OUTPUT_INCOMPLETE');
    assert.ok(incompleteCall.usage.durationMs >= responseDelayMs);
    assert.equal(f.requests() - beforeIncomplete, 1, 'provider-confirmed terminal makes one physical request');
    await runSrTask(deps, incomplete.taskId); assert.equal(f.requests() - beforeIncomplete, 1, 'known terminal does not trigger automatic retry');
    mode = 'unknown';
    const unknown = await newTask(), unknownResult = await runSrTask(deps, unknown.taskId);
    assert.equal(unknownResult.task.status, 'FAILED');
    const unknownCall = (await srPool.query('select state,fail_code,provider,model_id,usage from sr_call where task_id=$1', [unknown.taskId])).rows[0]!;
    assert.equal(unknownCall.state, 'UNKNOWN'); assert.equal(unknownCall.fail_code, 'SILENCE_AFTER_SEND');
    assert.ok(unknownCall.usage.durationMs >= responseDelayMs, 'UNKNOWN duration includes actual wait');
    const beforeReplay = f.requests();
    await runSrTask(deps, unknown.taskId); assert.equal(f.requests(), beforeReplay);
    const unauthorized = await newTask();
    const blocked = await runSrTask({ ...deps, transport: selectSrTransport({ ...f.env, LYRA_SR_REAL_CALLS: '0' }, false) }, unauthorized.taskId);
    assert.equal(blocked.task.error!.code, 'MODEL_PROVIDER_UNAUTHORIZED'); assert.equal(f.requests(), beforeReplay);
    // Force only the supplementary usage update to fail: identity remains, original error wins.
    const failingMetaPool = new Proxy(srPool, { get(target, key) {
      if (key === 'query') return (sql: string, values?: unknown[]) => {
        if (sql.includes('update sr_call set provider') && values?.[3]) return Promise.reject(new Error('SYNTHETIC_USAGE_WRITE_FAILED'));
        return target.query(sql, values);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const telemetryFailure = await newTask();
    const originalFailure = await runSrTask({ ...deps, srPool: failingMetaPool, transport: { describe: () => ({ provider: 'synthetic-error', modelId: 'synthetic', simulated: true }), async dispatch() { await new Promise(resolve => setTimeout(resolve, responseDelayMs)); throw new KernelError('SYNTHETIC_ORIGINAL_FAILURE', 'Controlled original error'); } } }, telemetryFailure.taskId);
    assert.equal(originalFailure.task.error!.code, 'SYNTHETIC_ORIGINAL_FAILURE');
    const telemetryFailureCall = (await srPool.query('select state,fail_code,provider,model_id from sr_call where task_id=$1', [telemetryFailure.taskId])).rows[0]!;
    assert.equal(telemetryFailureCall.state, 'FAILED'); assert.equal(telemetryFailureCall.fail_code, 'SYNTHETIC_ORIGINAL_FAILURE'); assert.equal(telemetryFailureCall.provider, 'synthetic-error');
    await writeFile(join(evidenceDir, 'engine-receipt.json'), JSON.stringify({ label: 'LOCAL_SYNTHETIC_SDK_ONLY', schema, outputDir, dataPoolReadOnly: true, publicWrites: 0, externalRequests: 0, localRequests: f.requests(), steps: seen, reportStatus: result.report.status, generatedBy: result.report.generatedBy, replayNewDispatches: 0, calls, responseDelayMs, invalidSchema: invalidResult.task.error, invalidCall, incompleteCall, maxTokensPhysicalRequests: 1, maxTokensReplayRequests: 0, unknownCall, unknownReplayRequests: 0, unauthorizedRequests: 0, telemetryFailureCall }, null, 2));
  } finally {
    await srPool.end(); await dataPool.end(); if (created) await dropSchema(admin, schema); await admin.end(); await f.close();
  }
});

it('existing native grant: metadata-only parse with zero fetch and byte-for-byte unchanged file', async () => {
  const cfg = dshConfigFromEnv({});
  const before = await readFile(cfg.credentialsPath);
  const nativeFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const account = await openReadOnlyDshAccount(cfg);
    await account.close();
    const unchanged = before.equals(await readFile(cfg.credentialsPath));
    assert.ok(unchanged); assert.equal(fetches, 0);
    await writeFile(join(evidenceDir, 'credential-readback.json'), JSON.stringify({ nativeParser: '0.2.1-rc.1', configuredGrant: true, metadataOnly: true, unchanged, networkRequests: fetches, credentialWrites: 0, resolvedRealToken: false }, null, 2));
  } finally { globalThis.fetch = nativeFetch; }
});
