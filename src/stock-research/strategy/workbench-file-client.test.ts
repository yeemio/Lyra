import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { startRealFileClient } from './client-preview.js';
import type { L2WorkbenchStore } from './workbench-contracts.js';

const out = 'delivery/CODEX-STRATEGY-CLIENT-20261029/workbench-20261031/client/file-readback';
const packages = 'delivery/CODEX-STRATEGY-CLIENT-20261029/workbench-20261031/history/packages';
const strategyManifest = `${packages}/real-readiness/inputs/real/client-manifest.json`;
const strategyPin = 'c69a4b9ff82d8b36cf1fb140bcc578eca425d911267e04d4e930b7b55c304bc2';
const cases = [
  { name: 'real-readiness', pin: '23549e2c8ca93453bffc8f2a825e0119430126d6920bcb9cccd2ddab627b965c', identity: 'REAL_PUBLIC_DATA', status: 'INPUT_BLOCKED' },
  { name: 'synthetic', pin: '63830155d5679f8ffecbc0c88d1fe797d9d6311e316d0479dca185a278a9df19', identity: 'SYNTHETIC', status: 'COMPUTED_OFFLINE' },
] as const;
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
after(() => { /* Each test closes its exact port=0 server in finally. */ });

test('pinned real INPUT_BLOCKED and separate synthetic packages read back through preview/API/HTML/original routes without external effects', async () => {
  await mkdir(out, { recursive: true });
  let databaseAttempts = 0, modelAttempts = 0, externalAttempts = 0;
  const query = Pool.prototype.query, connect = Pool.prototype.connect, originalFetch = globalThis.fetch;
  Pool.prototype.query = (() => { databaseAttempts++; throw new Error('FILE_CLIENT_REAL_DATABASE_FORBIDDEN'); }) as typeof query;
  Pool.prototype.connect = (() => { databaseAttempts++; throw new Error('FILE_CLIENT_REAL_DATABASE_FORBIDDEN'); }) as typeof connect;
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (u.hostname !== '127.0.0.1') { externalAttempts++; throw new Error('FILE_CLIENT_EXTERNAL_FORBIDDEN'); }
    return originalFetch(input, init);
  };
  const receipts: unknown[] = [];
  try {
    assert.equal(hash(await readFile(strategyManifest)), strategyPin);
    for (const c of cases) {
      const manifestPath = `${packages}/${c.name}/manifest.json`;
      assert.equal(hash(await readFile(manifestPath)), c.pin);
      const { server, baseUrl, deps } = await startRealFileClient(strategyManifest, strategyPin, 0, { manifestPath, manifestSha256: c.pin });
      const startedAt = new Date().toISOString();
      deps.transport.dispatch = async () => { modelAttempts++; throw new Error('FILE_CLIENT_MODEL_FORBIDDEN'); };
      const deniedDatabase = { query: async () => { databaseAttempts++; throw new Error('FILE_CLIENT_DATABASE_FORBIDDEN'); }, connect: async () => { databaseAttempts++; throw new Error('FILE_CLIENT_DATABASE_FORBIDDEN'); } } as unknown as Pool;
      deps.srPool = deniedDatabase; deps.dataPool = deniedDatabase;
      let receipt: Record<string, unknown> = {};
      try {
        const apiResponse = await fetch(baseUrl+'/api/strategies/601919/workbench'); assert.equal(apiResponse.status, 200);
        const apiBytes = Buffer.from(await apiResponse.arrayBuffer()), loaded = JSON.parse(apiBytes.toString()) as Awaited<ReturnType<L2WorkbenchStore['load']>>;
        assert.equal(loaded.manifestSha256, c.pin); assert.equal(loaded.result.status, c.status); assert.equal(loaded.result.inputIdentity, c.identity);
        assert.equal(loaded.result.realReviewDone, false); assert.equal(loaded.result.executionEligible, false); assert.equal(loaded.result.efficacyAccepted, false);
        const page = await fetch(baseUrl+'/strategies/601919/workbench'), html = await page.text(); assert.equal(page.status, 200);
        assert.equal(page.headers.get('x-lyra-workbench-result-hash'), loaded.result.resultHash); assert.equal(page.headers.get('x-lyra-workbench-manifest-sha256'), c.pin);
        assert.ok(html.includes('个人研究记录，非投资建议')); assert.ok(html.includes('逐批填写该标的持仓')); assert.ok(!html.includes('name="holdings"'));
        if (loaded.result.status === 'INPUT_BLOCKED') {
          for (const key of ['plan', 'validation', 'review', 'simulation', 'account'] as const) assert.equal(loaded.result[key], null);
          assert.equal(loaded.result.blockers.filter((b) => b.code === 'REAL_SERIES_DATE_MISSING').length, 8);
          for (const code of ['LATEST_REVISED_NOT_HISTORICAL_PIT', 'INDEPENDENT_OPEN_OBSERVATIONS_MISSING', 'DAILY_RULE_AND_ACTION_EXECUTION_INPUTS_UNVERIFIED', 'USER_ACCOUNT_AND_RISK_BUDGET_MISSING']) assert.ok(loaded.result.blockers.some((b) => b.code === code));
          assert.ok(!html.includes('初始组合净值')); assert.ok(!html.includes('进入价格下界')); assert.ok(html.includes('数量和收益均未计算'));
        } else {
          assert.equal(loaded.result.inputIdentity, 'SYNTHETIC'); assert.equal(loaded.result.validation.status, 'SYNTHETIC_BEHAVIOR_ONLY');
          assert.ok(html.includes('合成离线演示')); assert.ok(html.includes('样本内 IS')); assert.ok(html.includes('样本外 OOS')); assert.ok(html.includes('进入价格下界')); assert.ok(html.includes('10.38 元')); assert.ok(html.includes('净收益率'));
          const main = html.slice(0, html.indexOf('<section class="sr-section" id="workbench-originals">'));
          for (const hidden of ['netReturnBps', loaded.result.resultHash, '工作区完整 JSON', 'sr_account']) assert.ok(!main.includes(hidden));
          assert.equal(loaded.result.simulation.opportunities.length, 10); assert.equal(loaded.result.simulation.events.length, 3);
        }
        const resultSource = await fetch(baseUrl+'/api/strategies/601919/workbench/sources/result'); assert.equal(resultSource.status, 200);
        const resultBytes = Buffer.from(await resultSource.arrayBuffer()); assert.equal(hash(resultBytes), resultSource.headers.get('x-lyra-source-sha256')); assert.deepEqual(JSON.parse(resultBytes.toString()), loaded.result);
        assert.equal(resultSource.headers.get('content-disposition'), 'attachment');
        const htmlSource = loaded.sources.find((s) => s.mediaType === 'text/html');
        if (htmlSource) {
          const original = await fetch(baseUrl+`/api/strategies/601919/workbench/sources/${htmlSource.id}`); assert.equal(original.status, 200);
          const bytes = Buffer.from(await original.arrayBuffer()); assert.equal(hash(bytes), original.headers.get('x-lyra-source-sha256')); assert.equal(original.headers.get('x-content-type-options'), 'nosniff'); assert.equal(original.headers.get('content-disposition'), 'attachment');
          await writeFile(`${out}/${c.name}-original.html`, bytes);
        }
        const realPage = await fetch(baseUrl+'/strategies/601919'); assert.equal(realPage.status, 200); assert.ok((await realPage.text()).includes('/strategies/601919/workbench'));
        assert.equal((await fetch(baseUrl+'/api/strategies/601919/workbench/sources/unknown')).status, 404);
        await writeFile(`${out}/${c.name}-api.json`, apiBytes); await writeFile(`${out}/${c.name}.html`, html); await writeFile(`${out}/${c.name}-result-original.json`, resultBytes);
        receipt = { name: c.name, manifestPath, manifestSha256: c.pin, startedAt, baseUrl, resultHash: loaded.result.resultHash, identity: loaded.result.inputIdentity, status: loaded.result.status, readbackApi: '/api/strategies/601919/workbench', readbackHtml: '/strategies/601919/workbench', htmlSha256: hash(html), apiSha256: hash(apiBytes), originalResultSha256: hash(resultBytes), installed: false };
      } finally {
        await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
        assert.equal(server.listening, false); receipts.push({ ...receipt, closedAt: new Date().toISOString(), listeningAfterClose: server.listening });
      }
    }
  } finally {
    Pool.prototype.query = query; Pool.prototype.connect = connect; globalThis.fetch = originalFetch;
    await writeFile(`${out}/receipt.json`, JSON.stringify({ identity: 'ACTUAL_PINNED_FILE_STORE_CLIENT_READBACK', databaseAttempts, modelAttempts, externalAttempts, sourceNetworkMonitor: false, ownInstances: receipts, workerStarted: false, schemaApplied: false, installed: false }, null, 2)+'\n');
  }
  assert.equal(databaseAttempts, 0); assert.equal(modelAttempts, 0); assert.equal(externalAttempts, 0); assert.equal(receipts.length, 2);
});
