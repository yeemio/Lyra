/** Execution ownership is a database lease plus an acquisition generation, never a holder name alone. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { KernelError } from '../contracts.js';
import { withTransaction, type DbClient } from '../db/exec.js';

export type LeaseSpace = 'kernel' | 'sr';
export interface ExecutionLease {
  space: LeaseSpace;
  holderId: string;
  generation: string;
  ttlMs: number;
}
export interface LeaseGuard {
  lease: ExecutionLease;
  signal: AbortSignal;
  assert(): Promise<void>;
}
const table = (space: LeaseSpace): string => space === 'kernel' ? 'kernel_lock' : 'sr_engine_lock';
const validTtl = (ms: number): number => {
  if (!Number.isSafeInteger(ms) || ms < 10) throw new KernelError('EXECUTION_LEASE_INVALID', 'Lease TTL must be an integer of at least 10ms');
  return ms;
};
const lost = (): KernelError => new KernelError('EXECUTION_LOCK_HELD', 'Execution lease missing, expired or superseded; the original acquisition token is required');

export async function acquireLease(pool: Pool, space: LeaseSpace, holderId: string = randomUUID(), ttlMs = 60_000): Promise<ExecutionLease> {
  validTtl(ttlMs);
  if (!holderId.trim()) throw lost();
  return withTransaction(pool, async (tx) => {
    const r = await tx.query<{ generation: string }>(
      `update ${table(space)} set holder=$1, generation=generation+1, acquired_at=clock_timestamp(),
         heartbeat_at=clock_timestamp(), lease_until=clock_timestamp()+($2::double precision*interval '1 millisecond'), lease_ttl_ms=$2
       where id=1 and (holder='' or lease_until<=clock_timestamp()) returning generation::text`, [holderId, ttlMs]);
    if (!r.rows[0]) throw lost();
    // A new acquisition must reconcile sends left by an earlier generation before any new send.
    // Already acknowledged UNKNOWN rows are not silently re-opened on every idle worker iteration.
    const permits = space === 'kernel' ? 'exec_permit' : 'sr_call';
    const id = space === 'kernel' ? 'permit_id' : 'call_id';
    const recovery = space === 'kernel' ? 'recovery_state' : 'sr_recovery_state';
    const pending = space === 'kernel' ? 'pending_permit_ids' : 'pending_call_ids';
    await tx.query(`update ${recovery} set lifecycle='RECONCILING',
      ${pending}=(select jsonb_agg(distinct value) from jsonb_array_elements(
        ${pending} || (select jsonb_agg(${id}::text) from ${permits} where state='SENT'))),updated_at=clock_timestamp()
      where id=1 and exists(select 1 from ${permits} where state='SENT')`);
    return { space, holderId, generation: r.rows[0].generation, ttlMs };
  });
}

/** FOR UPDATE is used in the same transaction as SENT or a successful checkpoint. */
export async function assertLease(pool: DbClient, lease: ExecutionLease, lockRow = false): Promise<void> {
  if (!lease || !lease.holderId || !/^\d+$/.test(lease.generation)) throw lost();
  const r = await pool.query<{ holder: string; generation: string; lease_until: Date }>(
    `select holder,generation::text,lease_until from ${table(lease.space)} where id=1${lockRow ? ' for update' : ''}`);
  // Fetch the database clock after any row-lock wait. A transaction-start now() can be stale.
  const n = await pool.query<{ current_time: Date }>('select clock_timestamp() as current_time');
  const row = r.rows[0];
  if (!row || row.holder !== lease.holderId || row.generation !== lease.generation ||
      row.lease_until.getTime() <= n.rows[0]!.current_time.getTime()) throw lost();
}

export async function renewLease(pool: Pool, lease: ExecutionLease): Promise<void> {
  const r = await pool.query(
    `update ${table(lease.space)} set heartbeat_at=clock_timestamp(),
       lease_until=clock_timestamp()+(lease_ttl_ms::double precision*interval '1 millisecond')
     where id=1 and holder=$1 and generation=$2::bigint and lease_until>clock_timestamp()`,
    [lease.holderId, lease.generation]);
  if (r.rowCount !== 1) throw lost();
}

export async function releaseLease(pool: Pool, lease: ExecutionLease): Promise<void> {
  const r = await pool.query(`update ${table(lease.space)} set holder='',lease_until=clock_timestamp(),heartbeat_at=clock_timestamp()
    where id=1 and holder=$1 and generation=$2::bigint`, [lease.holderId, lease.generation]);
  if (r.rowCount !== 1) throw lost();
}

export function keepLeaseAlive(pool: Pool, lease: ExecutionLease): LeaseGuard & { stop(): Promise<void> } {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = renewLease(pool, lease).catch((err: unknown) => { controller.abort(err); }).finally(() => { pending = undefined; });
  }, Math.max(2, Math.floor(lease.ttlMs / 3)));
  timer.unref();
  return {
    lease, signal: controller.signal,
    assert: async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      await assertLease(pool, lease);
    },
    stop: async () => { clearInterval(timer); await pending; },
  };
}

// Concurrent calls in one executor/pool share an acquisition. Other processes/pools must acquire
// their own lease and are rejected while this one is live. No database lookup upgrades an old token.
const active = new WeakMap<Pool, Map<LeaseSpace, { users: number; ready: Promise<LeaseGuard & { stop(): Promise<void> }>; closing?: Promise<void> }>>();
export async function withExecutionLease<T>(
  pool: Pool, space: LeaseSpace, fn: (guard: LeaseGuard) => Promise<T>,
  opts: { lease?: ExecutionLease | undefined; holderId?: string | undefined; ttlMs?: number | undefined } = {},
): Promise<T> {
  if (opts.lease) {
    if (opts.lease.space !== space || (opts.holderId && opts.holderId !== opts.lease.holderId)) throw lost();
    await assertLease(pool, opts.lease);
    const guard = keepLeaseAlive(pool, opts.lease);
    try { return await fn(guard); } finally { await guard.stop(); }
  }
  if (opts.holderId) throw lost(); // Holder-only callers cannot borrow the latest generation.
  let bySpace = active.get(pool);
  if (!bySpace) { bySpace = new Map(); active.set(pool, bySpace); }
  let entry = bySpace.get(space);
  if (entry?.closing) { await entry.closing; return withExecutionLease(pool, space, fn, opts); }
  if (!entry) {
    entry = { users: 0, ready: acquireLease(pool, space, randomUUID(), opts.ttlMs).then((lease) => keepLeaseAlive(pool, lease)) };
    bySpace.set(space, entry);
  }
  entry.users++;
  try {
    const guard = await entry.ready;
    await guard.assert();
    return await fn(guard);
  } finally {
    entry.users--;
    if (!entry.users) {
      const closingEntry = entry;
      entry.closing = (async () => {
        try {
          const guard = await closingEntry.ready.catch(() => undefined);
          if (guard) { await guard.stop(); await releaseLease(pool, guard.lease); }
        } finally { if (bySpace!.get(space) === closingEntry) bySpace!.delete(space); }
      })();
      await entry.closing;
    }
  }
}
