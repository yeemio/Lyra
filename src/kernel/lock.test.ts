/**
 * W1 单测 · 唯一执行器锁（EK-2.1）：进程内第二 holder、心跳、TTL 夺取、释放、
 * probe CLI 第二执行器进程（退出码 0/3）。隔离 schema：w1_<runid>，结束 drop。
 */
import { randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { KernelError } from '../contracts.js';
import {
  acquireExecutorLock,
  assertLockHeld,
  heartbeatExecutorLock,
  readExecutorLock,
  releaseExecutorLock,
} from './lock.js';

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

async function assertKernelError(fn: () => Promise<unknown>, code: string): Promise<KernelError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof KernelError, `应为 KernelError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  throw new Error(`期望抛 KernelError(${code})，实际未抛`);
}

describe('acquireExecutorLock（EK-2.1）', () => {
  it('空闲可取得，holder/时间落位', async () => {
    const lock = await acquireExecutorLock(pool, 'exec-a');
    assert.equal(lock.holder, 'exec-a');
    const cur = await readExecutorLock(pool);
    assert.equal(cur.holder, 'exec-a');
    await releaseExecutorLock(pool, 'exec-a');
  });

  it('进程内第二 holder 被 EXECUTION_LOCK_HELD 命名拒绝', async () => {
    await acquireExecutorLock(pool, 'exec-a');
    const err = await assertKernelError(() => acquireExecutorLock(pool, 'exec-b'), 'EXECUTION_LOCK_HELD');
    assert.match(err.message, /exec-a/);
    const cur = await readExecutorLock(pool);
    assert.equal(cur.holder, 'exec-a'); // 未被静默改写
    await releaseExecutorLock(pool, 'exec-a');
  });

  it('同 holder 重复 acquire 为续租（acquiredAt 不变）', async () => {
    const first = await acquireExecutorLock(pool, 'exec-a');
    const again = await acquireExecutorLock(pool, 'exec-a');
    assert.equal(again.holder, 'exec-a');
    assert.equal(again.acquiredAt, first.acquiredAt);
    await releaseExecutorLock(pool, 'exec-a');
  });

  it('心跳过期（TTL）后可被夺取；心跳续租可保锁', async () => {
    await acquireExecutorLock(pool, 'exec-a');
    // 人为将心跳拨回 TTL 之前（模拟持有者死亡）
    await pool.query(`update kernel_lock set heartbeat_at = now() - interval '120 seconds' where id = 1`);
    const stolen = await acquireExecutorLock(pool, 'exec-b');
    assert.equal(stolen.holder, 'exec-b');
    await heartbeatExecutorLock(pool, 'exec-b'); // 续租
    await assertKernelError(() => acquireExecutorLock(pool, 'exec-c'), 'EXECUTION_LOCK_HELD');
    await releaseExecutorLock(pool, 'exec-b');
  });

  it('非持有者心跳/释放/执行校验均被拒', async () => {
    await acquireExecutorLock(pool, 'exec-a');
    await assertKernelError(() => heartbeatExecutorLock(pool, 'exec-b'), 'EXECUTION_LOCK_HELD');
    await assertKernelError(() => releaseExecutorLock(pool, 'exec-b'), 'EXECUTION_LOCK_HELD');
    await assertKernelError(() => assertLockHeld(pool, 'exec-b'), 'EXECUTION_LOCK_HELD');
    await assertLockHeld(pool, 'exec-a'); // 持有者通过
    await releaseExecutorLock(pool, 'exec-a');
  });
});

describe('probe.ts 第二执行器进程（EK-2.1 旅程形态）', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const probePath = fileURLToPath(new URL('./probe.ts', import.meta.url));

  function runProbe(): SpawnSyncReturns<string> {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', probePath],
      { cwd: repoRoot, env: { ...process.env, LYRA_PG_SCHEMA: schema }, encoding: 'utf8' },
    );
  }

  it('锁被持有时退出码 3（EXECUTION_LOCK_HELD）', async () => {
    await acquireExecutorLock(pool, 'exec-a');
    const r = runProbe();
    assert.equal(r.status, 3, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr ?? '', /EXECUTION_LOCK_HELD/);
    assert.equal((await readExecutorLock(pool)).holder, 'exec-a'); // 探测不改写锁
    await releaseExecutorLock(pool, 'exec-a');
  });

  it('锁空闲时退出码 0，且探测后立即释放', async () => {
    const r = runProbe();
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout ?? '', /EXECUTOR_LOCK_ACQUIRED/);
    // probe 已释放：下一个 holder 无需等 TTL 即可取得
    const lock = await acquireExecutorLock(pool, 'exec-a');
    assert.equal(lock.holder, 'exec-a');
    await releaseExecutorLock(pool, 'exec-a');
  });
});
