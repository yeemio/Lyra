import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { EmriskAdapter, makeEmriskBridgeExecutor, validateEmriskResponse } from './emrisk.js';
import { emriskResponse } from './emrisk-test-helper.js';
import { AdapterPauseError } from './backoff.js';
import { emptyEmriskProgress, loadEmriskProgress, planEmriskSegments, runEmriskBackfill, saveEmriskProgress } from '../backfill/emrisk.js';
import type { BridgeResponse } from './adapter-types.js';

test('I-07：错误、旧版无证明空集与损坏分页收据均不通过适配器门', () => {
  for (const response of [{ ok: false, rows: [] }, { ok: true, rows: [] }, { ok: true },
    { ...emriskResponse('pledge_ratio', '600519', []), rows: [{}] }]) {
    assert.throws(() => validateEmriskResponse(response, 'pledge_ratio', '600519'));
  }
  assert.deepEqual(validateEmriskResponse(emriskResponse('pledge_ratio', '600519', []), 'pledge_ratio', '600519'), []);
  assert.throws(() => validateEmriskResponse(emriskResponse('holder_count', '600519', []), 'pledge_ratio', '600519'));
});

for (const failedPage of [1, 2]) {
  test(`I-07：第 ${failedPage} 页错误原件/退避/账本/恢复走正常适配器与runner`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lyra-emrisk-integrity-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const progressPath = join(dir, 'progress.json');
    let calls = 0;
    let failure = true;
    const dbQueries: string[] = [];
    // 只替代暂停状态表；任何事实访问都使测试失败，不伪装为数据库集成证明。
    const pool = { query: async (sql: string) => {
      assert.ok(/adapter_pause_report/.test(sql)); dbQueries.push(sql); return { rows: [], rowCount: 0 };
    } } as unknown as Pool;
    const adapter = new EmriskAdapter({ pool, store, backoffAttempts: 2, backoffSleeper: { sleep: async () => {} },
      execBridge: async () => {
        calls++;
        return failure ? { ok: false, error_code: 'EMRISK_SOURCE_ERROR', error: 'synthetic page failure',
          meta: { complete: false, failedPage, receivedRows: failedPage === 1 ? 0 : 500,
            rawPages: [{ page: failedPage, status: 200, body: '{"success":false,"result":null}' }] } } as BridgeResponse
          : emriskResponse('pledge_ratio', '600519', []);
      },
    });
    const opts = { segments: planEmriskSegments(['600519']).slice(0, 1), progressPath,
      fetch: async () => adapter.fetchPledgeRatio('600519'), sleep: async () => {} };
    await assert.rejects(runEmriskBackfill(opts), AdapterPauseError);
    const failed = await loadEmriskProgress(progressPath);
    assert.deepEqual(failed.completed, {});
    const error = failed.failures?.['emrisk:pledge_ratio:600519']?.error ?? '';
    const sha = /artifact=([a-f0-9]{64})/.exec(error)?.[1];
    assert.ok(sha);
    const receipt = JSON.parse(new TextDecoder().decode(await store.readBytes(sha)));
    assert.equal(receipt.response.meta.failedPage, failedPage);
    assert.equal(receipt.response.meta.receivedRows, failedPage === 1 ? 0 : 500);
    assert.ok(receipt.priorAttemptArtifactSha256);
    await store.readBytes(receipt.priorAttemptArtifactSha256);
    assert.equal(calls, 2);
    failure = false;
    const recovered = await runEmriskBackfill(opts);
    assert.equal(recovered.completed, 1);
    assert.equal(recovered.emptySource, 1);
    assert.equal((await runEmriskBackfill(opts)).skippedDone, 1);
    assert.equal(calls, 3);
    assert.ok(dbQueries.length >= 2);
    assert.ok((await readFile(progressPath, 'utf8')).includes('emrisk-pages-v1'));
  });
}

test('I-07：旧账本无证明的空集必须重新验证，失败不升级为可信完成', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-emrisk-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'progress.json');
  const progress = emptyEmriskProgress();
  const segment = planEmriskSegments(['600519'])[0]!;
  progress.completed[segment.segKey] = { code: segment.code, resource: segment.resource, rowCount: 0,
    inserted: 0, identical: 0, rejected: 0, emptySource: true, completedAt: '2026-10-25T00:00:00Z' };
  await saveEmriskProgress(path, progress);
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runEmriskBackfill({ segments: [segment], progressPath: path,
      fetch: async () => { calls++; throw new Error('still unverified'); } }), /still unverified/);
  }
  assert.equal(calls, 2);
  assert.equal((await loadEmriskProgress(path)).completed[segment.segKey]?.completion, undefined);
});

test('I-07：不可解析的桥输出保留完整原文，不只保存120字符前缀', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-emrisk-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic-bridge');
  const original = 'invalid-source-output:'.repeat(30);
  await writeFile(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(original)}); process.exit(1);\n`, { mode: 0o755 });
  const response = await makeEmriskBridgeExecutor({ dockerPath: path })(['pledge', '600519']);
  assert.equal(response.ok, false);
  assert.equal(response.error_code, 'EMRISK_BRIDGE_OUTPUT_INVALID');
  assert.equal((response as unknown as { meta: { rawStdout: string } }).meta.rawStdout, original);
});
