/** PR4: public synthetic credentials and loopback only; no native grant or real model. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelError } from '../contracts.js';
import { DshSrTransport, dshConfigFromEnv } from './dsh.js';

const payload = { label: 'PUBLIC_SYNTHETIC_ABORT_FIXTURE' };
const inputHash = createHash('sha256').update(JSON.stringify(payload, null, 1)).digest('hex');

it('DSH preflight binds full prompt and effort before credential access; pre-aborted dispatch is local', async () => {
  const config = dshConfigFromEnv({ LYRA_SR_REAL_CALLS: '1', LYRA_SR_DSH_CREDENTIALS_PATH: '/nonexistent/pr4-no-native-grant' });
  const transport = new DshSrTransport(config);
  const wire = transport.preflight('PLAN', inputHash, payload);
  assert.ok(wire.inputBytes > Buffer.byteLength(JSON.stringify(payload, null, 1)));
  assert.notEqual(wire.inputHash, inputHash);
  assert.notDeepEqual(transport.describe(), new DshSrTransport({ ...config, effort: 'low' }).describe());
  assert.throws(() => transport.preflight('PLAN', 'wrong', payload), { code: 'DSH_INPUT_BINDING_INVALID' });
  const controller = new AbortController();
  const reason = new KernelError('EXECUTION_LOCK_HELD', 'synthetic revoked lease');
  controller.abort(reason);
  await assert.rejects(transport.dispatch('PLAN', { callId: randomUUID(), inputHash, signal: controller.signal }, payload), error => error === reason);
});

it('DSH abort after one loopback send terminates worker/socket; result remains UNKNOWN and credentials unchanged', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-pr4-dsh-abort-'));
  const token = 'lyra_test_synthetic_abort_not_a_credential';
  let received!: () => void, receiveFailed!: (error: unknown) => void, closed!: () => void;
  const receivedPromise = new Promise<void>((resolve, reject) => { received = resolve; receiveFailed = reject; });
  const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
  let requests = 0;
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.once('close', closed);
    try {
      requests++;
      assert.equal(req.url, '/anthropic/v1/messages');
      assert.equal(req.headers['x-dsh-auth-token'], token);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: { text: string }[] }[] };
      assert.ok(body.messages[0]!.content[0]!.text.includes('PUBLIC_SYNTHETIC_ABORT_FIXTURE'));
      received(); // Remote result intentionally withheld; abort cannot prove remote failure.
    } catch (error) { errors.push(error); receiveFailed(error); res.end(); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const credentialsPath = join(dir, 'synthetic.json');
  await writeFile(credentialsPath, JSON.stringify({ version: 1, records: { 'deepseek-account-platform/default': {
    kind: 'grant', payload: { version: 1, token, issuer: origin },
  } } }), { mode: 0o600 });
  const before = await readFile(credentialsPath);
  const transport = new DshSrTransport({ ...dshConfigFromEnv({}), enabled: true, validation: true, endpoint: `${origin}/anthropic`, platformOrigin: origin,
    credentialsPath, callWindowMs: 10000 });
  const controller = new AbortController();
  const call = transport.dispatch('PLAN', { callId: randomUUID(), inputHash, signal: controller.signal }, payload);
  const rejection = assert.rejects(call, { code: 'SILENCE_AFTER_SEND' });
  await receivedPromise;
  controller.abort(new KernelError('EXECUTION_LOCK_HELD', 'synthetic lease loss'));
  await rejection;
  await closedPromise;
  assert.equal(requests, 1, 'no retry or redirect after cancellation');
  assert.deepEqual(errors, []);
  assert.deepEqual(await readFile(credentialsPath), before);
});
