import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { KernelError, type ModelCallContract } from '../contracts.js';
import type { LeaseSpace } from './lease.js';

/** Retries never replace the earlier attempt. A crash leaves an explicit unfinished record. */
export async function recordAttempt<T extends { permit: { permitId: string } }>(
  pool: Pool, space: LeaseSpace, contract: unknown, work: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  await pool.query('insert into execution_attempt(attempt_id,space,contract) values($1,$2,$3::jsonb)', [id, space, JSON.stringify(contract)]);
  let result: T | undefined, error: unknown, failed = false;
  try { result = await work(); }
  catch (e) { failed = true; error = e; }
  let permitId = result?.permit.permitId ?? null;
  if (permitId === null) {
    // A refusal can refer to a prior send; it is an attempt, never another billable call.
    const c = contract as ModelCallContract & { taskId: string; stepId: string };
    const row = space === 'kernel'
      ? await pool.query<{ permit_id: string }>(`select permit_id from exec_permit where stage=$1 and subject_kind=$2 and subject=$3
          and research_kind=$4 and cutoff=$5::timestamptz and input_hash=$6`,
        [c.stage, c.businessKey.subjectKind, c.businessKey.subject, c.businessKey.researchKind, c.businessKey.cutoff, c.inputHash])
      : await pool.query<{ permit_id: string }>('select call_id as permit_id from sr_call where task_id=$1::uuid and step_id=$2::uuid and input_hash=$3', [c.taskId, c.stepId, c.inputHash]);
    permitId = row.rows[0]?.permit_id ?? null;
  }
  await pool.query(`update execution_attempt set finished_at=clock_timestamp(),outcome=$2,fail_code=$3,permit_id=$4::uuid
    where attempt_id=$1::uuid and finished_at is null`, [id, failed ? 'REJECTED' : 'RETURNED',
    failed ? (error instanceof KernelError ? error.code : 'LOCAL_ERROR') : null, permitId]);
  if (failed) throw error;
  return result!;
}
