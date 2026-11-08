import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import { withTransaction, rowToPermit, type DbClient, type ExecPermitRow } from '../db/exec.js';
import { assertLease, type ExecutionLease, type LeaseSpace } from './lease.js';

export interface CallCheckpoint {
  version: 1;
  permitId: string;
  contract: unknown;
  simulated: boolean;
  input: unknown;
  transport: unknown;
  output: unknown;
  outputHash: string;
}
export function responseCheckpoint(args: Omit<CallCheckpoint, 'version' | 'outputHash'>): CallCheckpoint {
  return { version: 1, ...args, outputHash: canonicalSha256(args.output) };
}
/** PostgreSQL timestamp normalization is not a different request identity. */
export function contractHash(value: unknown): string {
  const c = value as { deadline: string; businessKey?: { cutoff: string } };
  return canonicalSha256({ ...c, deadline: new Date(c.deadline).toISOString(),
    ...(c.businessKey ? { businessKey: { ...c.businessKey, cutoff: new Date(c.businessKey.cutoff).toISOString() } } : {}) });
}

const columns = (space: LeaseSpace) => space === 'kernel' ? { table: 'exec_permit', id: 'permit_id' } : { table: 'sr_call', id: 'call_id' };

/** A recoverable result and SUCCEEDED are one transaction. A local persistence failure is not remote failure. */
export async function completeWithCheckpoint(pool: Pool, lease: ExecutionLease, checkpoint: CallCheckpoint, late: boolean): Promise<void> {
  const c = columns(lease.space);
  await withTransaction(pool, async (tx) => {
    await assertLease(tx, lease, true);
    const found = await tx.query(`select * from ${c.table} where ${c.id}=$1::uuid for update`, [checkpoint.permitId]);
    const row = found.rows[0];
    if (!row) throw new KernelError('CHECKPOINT_COMMIT_REJECTED', 'Call row missing');
    const actual = lease.space === 'kernel' ? rowToPermit(row as ExecPermitRow).contract : {
      taskId: row.task_id, stepId: row.step_id, inputHash: row.input_hash, inputBytes: Number(row.input_bytes),
      methodVersion: row.method_version, planAuthVersion: row.plan_auth_version, deadline: row.deadline.toISOString(),
    };
    if (contractHash(actual) !== contractHash(checkpoint.contract) || row.simulated !== checkpoint.simulated) {
      throw new KernelError('CHECKPOINT_COMMIT_REJECTED', 'Database call contract differs from the validated response');
    }
    await assertLease(tx, lease);
    const r = await tx.query(`update ${c.table} set state='SUCCEEDED',settled_at=clock_timestamp(),fail_code=$4,
      response_checkpoint=$2::jsonb,response_hash=$3
      where ${c.id}=$1::uuid and state='SENT' and execution_generation=$5::bigint and response_checkpoint is null
      and exists(select 1 from ${lease.space === 'kernel' ? 'kernel_lock' : 'sr_engine_lock'} where id=1 and lease_until>clock_timestamp())`,
      [checkpoint.permitId, JSON.stringify(checkpoint), canonicalSha256(checkpoint), late ? 'LATE_COMPLETED' : null, lease.generation]);
    if (r.rowCount !== 1) throw new KernelError('CHECKPOINT_COMMIT_REJECTED', 'Call no longer belongs to this execution generation or has already settled');
  });
}

export async function loadCallCheckpoint(pool: DbClient, space: LeaseSpace, permitId: string): Promise<CallCheckpoint | null> {
  const c = columns(space);
  const r = await pool.query<{ state: string; simulated: boolean; response_checkpoint: CallCheckpoint | null; response_hash: string | null }>(
    `select state,simulated,response_checkpoint,response_hash from ${c.table} where ${c.id}=$1::uuid`, [permitId]);
  const row = r.rows[0];
  if (!row?.response_checkpoint) return null;
  const cp = row.response_checkpoint;
  if (row.state !== 'SUCCEEDED' || cp.version !== 1 || cp.permitId !== permitId || cp.simulated !== row.simulated ||
      cp.outputHash !== canonicalSha256(cp.output) || row.response_hash !== canonicalSha256(cp)) {
    throw new KernelError('CALL_CHECKPOINT_INVALID', 'Checkpoint is not a bound successful result');
  }
  return cp;
}
