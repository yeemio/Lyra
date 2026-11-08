/** Compatibility names for the kernel execution lease; sending requires the returned generation. */
import type { Pool } from 'pg';
import { KernelError } from '../contracts.js';
import type { DbClient } from '../db/exec.js';
import { acquireLease, assertLease, renewLease, releaseLease, type ExecutionLease } from './lease.js';
export const LOCK_TTL_MS = 60_000;
export interface ExecutorLockInfo {
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
  lease?: ExecutionLease;
}
export async function acquireExecutorLock(pool: Pool, holderId: string, opts?: { ttlMs?: number }): Promise<ExecutorLockInfo & { lease: ExecutionLease }> {
  const lease = await acquireLease(pool, 'kernel', holderId, opts?.ttlMs ?? LOCK_TTL_MS);
  return { ...await readExecutorLock(pool), lease };
}
export async function heartbeatExecutorLock(pool: Pool, lease: ExecutionLease): Promise<ExecutorLockInfo> {
  await renewLease(pool, lease);
  return { ...await readExecutorLock(pool), lease };
}
export async function releaseExecutorLock(pool: Pool, lease: ExecutionLease): Promise<void> {
  await releaseLease(pool, lease);
}
export async function readExecutorLock(pool: DbClient): Promise<ExecutorLockInfo> {
  const r = await pool.query<{ holder: string; acquired_at: Date; heartbeat_at: Date }>('select holder,acquired_at,heartbeat_at from kernel_lock where id=1');
  const row = r.rows[0];
  if (!row) throw new KernelError('EXECUTION_LOCK_MISSING', 'kernel_lock is missing');
  return { holder: row.holder, acquiredAt: row.acquired_at.toISOString(), heartbeatAt: row.heartbeat_at.toISOString() };
}
export async function assertLockHeld(pool: DbClient, lease: ExecutionLease): Promise<void> {
  await assertLease(pool, lease);
}
