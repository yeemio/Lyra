import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createSrServer, srServerConfigFromEnv, type SrFullDeps } from './server.js';
import { assertLocalBind } from './server-origin.js';

describe('I-21: local HTTP boundary before owner identity (no database/model calls)', () => {
  let server: ReturnType<typeof createSrServer>;
  let port = 0;
  let ownerReads = 0;
  const csrf = 'synthetic-local-csrf';
  const forbidden = (): never => { throw new Error('TEST_FORBIDS_DATABASE_OR_MODEL'); };
  const deps = {
    config: srServerConfigFromEnv({ LYRA_SR_PORT: '0' }),
    srPool: { query: forbidden }, dataPool: { query: forbidden },
    poolCache: { stocks: [], etfs: [] },
    get localAccountId() { ownerReads++; return 'synthetic-owner'; },
    localCsrf: csrf, transport: { dispatch: forbidden }, budget: {},
  } as unknown as SrFullDeps;
  before(async () => {
    server = createSrServer(deps);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  function send(host: string, method = 'GET', headers: Record<string, string> = {}, token: string | null = csrf, connection = { host: '127.0.0.1', port }): Promise<{ status: number; body: string }> {
    const body = method === 'POST' ? new URLSearchParams({ action: 'add-lot', lotCount: '1', ...(token === null ? {} : { _csrf: token }) }).toString() : '';
    return new Promise((resolve, reject) => {
      const req = request({ ...connection, method,
        path: `/strategies/601919/workbench${method === 'POST' ? '/risk-export' : ''}`,
        headers: { host, ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (s: string) => { text += s; });
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  it('rejects hostile/ambiguous authorities before exposing owner or CSRF', async () => {
    for (const host of [`untrusted.example:${port}`, `localhost.evil:${port}`, `127.1:${port}`, `2130706433:${port}`, `localhost.:${port}`, 'localhost', `localhost:${port + 1}`]) {
      ownerReads = 0;
      const r = await send(host, 'GET', { origin: 'http://untrusted.example', 'x-forwarded-host': `localhost:${port}` });
      assert.equal(r.status, 403, host); assert.match(r.body, /LOCAL_HOST_REJECTED/);
      assert.equal(ownerReads, 0); assert.ok(!r.body.includes(csrf));
    }
  });
  it('accepts all three loopback authorities and same-origin writes', async () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      const host = `${hostname}:${port}`;
      const page = await send(host);
      assert.equal(page.status, 503); // Workbench deliberately not configured; honest UI still includes the input form.
      assert.ok(page.body.includes(csrf));
      const write = await send(host, 'POST', { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
      assert.equal(write.status, 200); assert.match(write.body, /第 2 批持仓/);
    }
  });
  it('rejects foreign/null/other-port origins and cross-site metadata before identity', async () => {
    const host = `localhost:${port}`;
    for (const origin of ['null', 'http://untrusted.example', `http://localhost:${port + 1}`, `http://127.0.0.1:${port}`]) {
      ownerReads = 0;
      const r = await send(host, 'POST', { origin });
      assert.equal(r.status, 403); assert.match(r.body, /LOCAL_ORIGIN_REJECTED/); assert.equal(ownerReads, 0);
    }
    for (const site of ['cross-site', 'same-site', 'none']) {
      ownerReads = 0;
      const r = await send(host, 'POST', { origin: `http://${host}`, 'sec-fetch-site': site });
      assert.equal(r.status, 403); assert.match(r.body, /LOCAL_FETCH_SITE_REJECTED/); assert.equal(ownerReads, 0);
    }
  });
  it('retains CSRF for browser and header-less local clients', async () => {
    const host = `127.0.0.1:${port}`;
    assert.equal((await send(host, 'POST', {}, null)).status, 403);
    assert.equal((await send(host, 'POST', { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, 'wrong')).status, 403);
    assert.equal((await send(host, 'POST')).status, 200);
  });
  it('serves an actual IPv6 loopback listener', async () => {
    const ipv6 = createSrServer({ ...deps, config: srServerConfigFromEnv({ LYRA_SR_BIND: '::1', LYRA_SR_PORT: '0' }) });
    await new Promise<void>((resolve, reject) => { ipv6.once('error', reject); ipv6.listen(0, '::1', resolve); });
    try {
      const connection = { host: '::1', port: (ipv6.address() as AddressInfo).port };
      const host = `[::1]:${connection.port}`;
      assert.equal((await send(host, 'GET', {}, csrf, connection)).status, 503);
      assert.equal((await send(host, 'POST', { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, csrf, connection)).status, 200);
    } finally {
      ipv6.closeAllConnections();
      await new Promise<void>((resolve, reject) => ipv6.close((err) => err ? reject(err) : resolve()));
    }
  });
  it('requires explicit opt-in for non-loopback local listening', () => {
    for (const bind of ['0.0.0.0', '::', '192.0.2.1']) {
      assert.throws(() => createSrServer({ ...deps, config: srServerConfigFromEnv({ LYRA_SR_BIND: bind }) }), /EXPLICIT_OPT_IN/);
      assert.doesNotThrow(() => assertLocalBind(srServerConfigFromEnv({ LYRA_SR_BIND: bind, LYRA_SR_ALLOW_NON_LOOPBACK_BIND: '1' })));
    }
    for (const bind of ['localhost', '127.0.0.1', '::1']) assert.doesNotThrow(() => assertLocalBind({ mode: 'local', bind }));
    assert.doesNotThrow(() => assertLocalBind({ mode: 'saas', bind: '0.0.0.0' }));
  });
});
