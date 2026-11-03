/**
 * Lyra · 唯一执行器锁（EK-2.1–EK-2.3）。W1: code-writer-pro。
 * 载体：kernel_lock 单行表（schema 冻结）。holder 为空或心跳超过 TTL 视为可夺取；
 * 被他人持有且未过期 → EXECUTION_LOCK_HELD（命名拒绝，绝不静默排队成第二条执行链）。
 */
import type { Pool } from 'pg';
import { KernelError } from '../contracts.js';
import { dbNow, type DbClient } from '../db/exec.js';

/** 心跳 TTL：超过即视为持有者死亡，可夺取（默认 60s）。 */
export const LOCK_TTL_MS = 60_000;

export interface ExecutorLockInfo {
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
}

interface LockRow {
  holder: string;
  acquired_at: Date;
  heartbeat_at: Date;
}

function toInfo(row: LockRow): ExecutorLockInfo {
  return {
    holder: row.holder,
    acquiredAt: row.acquired_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
  };
}

function nonEmpty(holderId: string, who: string): string {
  const h = holderId.trim();
  if (!h) throw new Error(`${who}: holderId 不能为空`);
  return h;
}

/** 抢占执行权：holder 为空 / 本人 / 心跳过期可取得；他人持有且未过期 → EXECUTION_LOCK_HELD。 */
export async function acquireExecutorLock(
  pool: Pool,
  holderId: string,
  opts?: { ttlMs?: number },
): Promise<ExecutorLockInfo> {
  const holder = nonEmpty(holderId, 'acquireExecutorLock');
  const ttlMs = opts?.ttlMs ?? LOCK_TTL_MS;
  // 单条原子 UPDATE：并发抢占在行锁上串行化，后到者重估条件后看到新心跳。
  const res = await pool.query<LockRow>(
    `update kernel_lock set
       holder = $1,
       acquired_at = case when kernel_lock.holder = $1 then kernel_lock.acquired_at else now() end,
       heartbeat_at = now()
     where id = 1
       and (kernel_lock.holder = '' or kernel_lock.holder = $1
            or kernel_lock.heartbeat_at < now() - ($2::double precision * interval '1 millisecond'))
     returning holder, acquired_at, heartbeat_at`,
    [holder, ttlMs],
  );
  const row = res.rows[0];
  if (row) return toInfo(row);
  const cur = await readExecutorLock(pool);
  const ageMs = (await dbNow(pool)).getTime() - Date.parse(cur.heartbeatAt);
  throw new KernelError(
    'EXECUTION_LOCK_HELD',
    `执行权由 ${cur.holder || '(空)'} 持有（心跳 ${ageMs}ms 前，TTL ${ttlMs}ms），${holder} 被拒绝（EK-2.1）`,
  );
}

/** 续租。锁已易主（TTL 内被夺走后本人心跳失效）→ EXECUTION_LOCK_HELD。 */
export async function heartbeatExecutorLock(
  pool: Pool,
  holderId: string,
): Promise<ExecutorLockInfo> {
  const holder = nonEmpty(holderId, 'heartbeatExecutorLock');
  const res = await pool.query<LockRow>(
    `update kernel_lock set heartbeat_at = now()
     where id = 1 and holder = $1
     returning holder, acquired_at, heartbeat_at`,
    [holder],
  );
  const row = res.rows[0];
  if (row) return toInfo(row);
  const cur = await readExecutorLock(pool);
  throw new KernelError(
    'EXECUTION_LOCK_HELD',
    `执行权已不在 ${holder} 手中（当前 ${cur.holder || '(空)'}），心跳被拒（EK-2.1）`,
  );
}

/** 释放执行权（仅本人可释放；释放后行回到空闲态）。 */
export async function releaseExecutorLock(pool: Pool, holderId: string): Promise<void> {
  const holder = nonEmpty(holderId, 'releaseExecutorLock');
  const res = await pool.query(
    `update kernel_lock set holder = '', acquired_at = now() - interval '1 day', heartbeat_at = now() - interval '1 day'
     where id = 1 and holder = $1`,
    [holder],
  );
  if ((res.rowCount ?? 0) === 0) {
    const cur = await readExecutorLock(pool);
    if (cur.holder === holder || cur.holder === '') return; // 已释放（幂等）
    throw new KernelError(
      'EXECUTION_LOCK_HELD',
      `执行权由 ${cur.holder} 持有，${holder} 无法释放（EK-2.1）`,
    );
  }
}

/** 读当前锁状态（不判 TTL；诊断用）。 */
export async function readExecutorLock(pool: DbClient): Promise<ExecutorLockInfo> {
  const res = await pool.query<LockRow>(
    'select holder, acquired_at, heartbeat_at from kernel_lock where id = 1',
  );
  const row = res.rows[0];
  if (!row) throw new Error('kernel_lock 单行缺失：schema 未应用或被破坏');
  return toInfo(row);
}

/**
 * 执行操作前的执行权校验（EK-2.2 防御层）：holder 不符或心跳过期 → EXECUTION_LOCK_HELD。
 * runModelCall 在提供 holderId 时调用；探测脚本/旅程测试用它验证第二执行器被拒。
 */
export async function assertLockHeld(
  pool: Pool,
  holderId: string,
  opts?: { ttlMs?: number },
): Promise<void> {
  const holder = nonEmpty(holderId, 'assertLockHeld');
  const ttlMs = opts?.ttlMs ?? LOCK_TTL_MS;
  const cur = await readExecutorLock(pool);
  const ageMs = (await dbNow(pool)).getTime() - Date.parse(cur.heartbeatAt);
  if (cur.holder !== holder || ageMs >= ttlMs) {
    throw new KernelError(
      'EXECUTION_LOCK_HELD',
      `执行权由 ${cur.holder || '(空)'} 持有（心跳 ${ageMs}ms 前，TTL ${ttlMs}ms），${holder} 的执行操作被拒绝（EK-2.1）`,
    );
  }
}
