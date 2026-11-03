/**
 * W1 单测 · 安装门留痕（EK-10.3）：recordInstall 拒非绿、CLI 只在全绿时落行。
 */
import { randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { KernelError, type InstallLogRecord } from '../contracts.js';
import { recordInstall } from './installlog.js';

const schema = `w1_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let pool: Pool;
let admin: Pool;

before(async () => {
  admin = createPool();
  await applySchema(admin, schema);
  pool = createPool({ schema });
});

after(async () => {
  await pool.end();
  await dropSchema(admin, schema);
  await admin.end();
});

function mkRec(o: Partial<InstallLogRecord> = {}): InstallLogRecord {
  return {
    versionId: 'v-p0-1',
    testRunId: `run-${randomUUID()}`,
    green: true,
    summary: 'pass=7 fail=0',
    recordedAt: new Date().toISOString(),
    ...o,
  };
}

describe('recordInstall（EK-10.3）', () => {
  it('全绿记录可写入并读回', async () => {
    const rec = mkRec();
    const entry = await recordInstall(pool, rec);
    assert.ok(entry.id);
    assert.equal(entry.versionId, rec.versionId);
    assert.equal(entry.green, true);
    const row = await pool.query(
      'select version_id, test_run_id, green, summary from install_log where id = $1',
      [entry.id],
    );
    assert.equal(row.rows[0].version_id, rec.versionId);
    assert.equal(row.rows[0].green, true);
  });

  it('green !== true → INSTALL_NOT_GREEN，不落行（运行时兜底）', async () => {
    const before = await pool.query('select count(*)::int as n from install_log');
    for (const bad of [false, undefined, null] as unknown[]) {
      await assertRejects(
        () => recordInstall(pool, mkRec({ green: bad as never })),
        'INSTALL_NOT_GREEN',
      );
    }
    const after = await pool.query('select count(*)::int as n from install_log');
    assert.equal(after.rows[0].n, before.rows[0].n, '非绿不产生安装');
  });

  it('缺字段（versionId/testRunId/summary）→ 拒绝', async () => {
    await assertRejects(() => recordInstall(pool, mkRec({ versionId: '' })), 'INSTALL_NOT_GREEN');
    await assertRejects(() => recordInstall(pool, mkRec({ testRunId: '  ' })), 'INSTALL_NOT_GREEN');
    await assertRejects(() => recordInstall(pool, mkRec({ summary: '' })), 'INSTALL_NOT_GREEN');
  });
});

describe('record-install.ts CLI（EK-10.3 安装门接线）', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const cliPath = fileURLToPath(new URL('./record-install.ts', import.meta.url));
  const tmpRunFile = path.join(tmpdir(), `lyra-last-journey-${randomUUID()}.json`);

  after(async () => {
    await rm(tmpRunFile, { force: true });
  });

  async function writeRun(obj: unknown): Promise<string> {
    await writeFile(tmpRunFile, JSON.stringify(obj), 'utf8');
    return tmpRunFile;
  }

  function runCli(file: string | undefined): SpawnSyncReturns<string> {
    const args = ['--import', 'tsx', cliPath];
    if (file !== undefined) args.push(file);
    return spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, LYRA_PG_SCHEMA: schema },
      encoding: 'utf8',
    });
  }

  it('全绿 → 退出码 0，install_log 落行', async () => {
    const before = await pool.query('select count(*)::int as n from install_log');
    const file = await writeRun({ versionId: 'v-p0-j', testRunId: 'run-j1', pass: 7, fail: 0, green: true });
    const r = runCli(file);
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout ?? '', /INSTALL_RECORDED/);
    const after = await pool.query('select count(*)::int as n from install_log');
    assert.equal(after.rows[0].n, before.rows[0].n + 1, '全绿才写安装日志行');
    const row = await pool.query(
      'select version_id, test_run_id, green from install_log order by id desc limit 1',
    );
    assert.equal(row.rows[0].version_id, 'v-p0-j');
    assert.equal(row.rows[0].green, true);
  });

  it('非绿（green:false / fail>0）→ 退出非零、不落行', async () => {
    const before = await pool.query('select count(*)::int as n from install_log');
    for (const obj of [
      { versionId: 'v2', testRunId: 'r2', pass: 6, fail: 1, green: false },
      { versionId: 'v3', testRunId: 'r3', pass: 6, fail: 1, green: true }, // fail>0 视为未全绿
    ]) {
      const file = await writeRun(obj);
      const r = runCli(file);
      assert.notEqual(r.status, 0, `应退出非零：${JSON.stringify(obj)}`);
      assert.match(r.stderr ?? '', /INSTALL_BLOCKED/);
    }
    const after = await pool.query('select count(*)::int as n from install_log');
    assert.equal(after.rows[0].n, before.rows[0].n, '非绿不产生安装');
  });

  it('记录文件缺失/非法 JSON → 退出非零', async () => {
    const r1 = runCli(path.join(tmpdir(), `no-such-${randomUUID()}.json`));
    assert.notEqual(r1.status, 0);
    assert.match(r1.stderr ?? '', /INSTALL_BLOCKED/);
    await writeFile(tmpRunFile, '{not json', 'utf8');
    const r2 = runCli(tmpRunFile);
    assert.notEqual(r2.status, 0);
  });
});

async function assertRejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof KernelError, `应为 KernelError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  throw new Error(`期望抛 KernelError(${code})，实际未抛`);
}
