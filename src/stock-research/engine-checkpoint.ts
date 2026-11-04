import type { Pool, PoolClient } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import { withTransaction } from '../db/exec.js';
import { assertLease, type ExecutionLease } from '../kernel/lease.js';
import { contractHash, loadCallCheckpoint } from '../kernel/response.js';
import type { EvidencePack, SrCallContract, SrEngineDeps, SrModelStepKind, SrPlanBudget, SrTransportDescribe } from './contracts.js';
import { srFindCallByStep, type SrCallPermit } from './store.js';

export function fencedSrWrite<T>(pool: Pool, lease: ExecutionLease | undefined, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  if (!lease || lease.space !== 'sr') throw new KernelError('EXECUTION_LEASE_REQUIRED', 'SR writes require the original acquisition token');
  return withTransaction(pool, async (tx) => { await assertLease(tx, lease, true); const value = await fn(tx); await assertLease(tx, lease); return value; });
}

export interface SrInputCheckpoint {
  version: 1;
  contract: SrCallContract;
  modelStep: SrModelStepKind;
  input: unknown;
  transport: SrTransportDescribe;
  wire: { inputHash: string; inputBytes: number };
  budget: SrPlanBudget;
}
const withoutDeadline = ({ deadline: _deadline, ...rest }: SrCallContract) => rest;

export async function freezeSrInput(pool: Pool, lease: ExecutionLease, candidate: SrInputCheckpoint, fixedDeadline = false): Promise<SrInputCheckpoint> {
  return fencedSrWrite(pool, lease, async (tx) => {
    const rows = await tx.query<{ input_checkpoint: SrInputCheckpoint | null; input_checkpoint_hash: string | null }>(
      'select input_checkpoint,input_checkpoint_hash from sr_step where task_id=$1::uuid and step_id=$2::uuid for update',
      [candidate.contract.taskId, candidate.contract.stepId]);
    const row = rows.rows[0];
    if (!row) throw new KernelError('SR_CHECKPOINT_MISSING', 'Original task/step is missing');
    if (row.input_checkpoint) {
      const old = row.input_checkpoint;
      if (old.version !== 1 || canonicalSha256(old) !== row.input_checkpoint_hash ||
          canonicalSha256({ ...old, contract: withoutDeadline(old.contract) }) !== canonicalSha256({ ...candidate, contract: withoutDeadline(candidate.contract) }) ||
          (fixedDeadline && Date.parse(old.contract.deadline) !== Date.parse(candidate.contract.deadline))) {
        throw new KernelError('SR_CHECKPOINT_CONFLICT', 'Task/step/input/budget/transport cannot change on retry');
      }
      return old;
    }
    const call = await srFindCallByStep(tx, candidate.contract.taskId, candidate.contract.stepId);
    if (call?.sentAt) throw new KernelError('SR_CHECKPOINT_MISSING', 'Legacy sent calls cannot acquire a guessed input checkpoint');
    await tx.query('update sr_step set input_checkpoint=$3::jsonb,input_checkpoint_hash=$4 where task_id=$1::uuid and step_id=$2::uuid',
      [candidate.contract.taskId, candidate.contract.stepId, JSON.stringify(candidate), canonicalSha256(candidate)]);
    return candidate;
  });
}

export function srCheckpointInput(frozen: SrInputCheckpoint) {
  return { modelStep: frozen.modelStep, input: frozen.input, wire: frozen.wire };
}

export async function restoreSrResponse(pool: Pool, frozen: SrInputCheckpoint): Promise<{ permit: SrCallPermit; output: unknown } | null> {
  const c = frozen.contract;
  const permit = await srFindCallByStep(pool, c.taskId, c.stepId);
  if (!permit?.sentAt) return null;
  const cp = await loadCallCheckpoint(pool, 'sr', permit.callId);
  if (!cp) throw new KernelError(permit.state === 'SENT' ? 'REQUEST_PENDING' : permit.state === 'UNKNOWN' ? 'REQUEST_UNKNOWN' : 'SR_CHECKPOINT_MISSING',
    `Original call ${permit.callId} is ${permit.state}; no automatic resend or guessed success`);
  const actual = { taskId: permit.taskId, stepId: permit.stepId, methodVersion: permit.methodVersion,
    planAuthVersion: permit.planAuthVersion, inputHash: permit.inputHash, inputBytes: permit.inputBytes, deadline: permit.deadline };
  if (contractHash(actual) !== contractHash(c) || contractHash(cp.contract) !== contractHash(c) ||
      canonicalSha256(cp.input) !== canonicalSha256(srCheckpointInput(frozen)) ||
      canonicalSha256(cp.transport) !== canonicalSha256(frozen.transport) || cp.simulated !== frozen.transport.simulated) {
    throw new KernelError('SR_CHECKPOINT_CONFLICT', 'Successful response does not bind to the original sent request');
  }
  return { permit, output: cp.output };
}

/** Freeze the full pre-PLAN evidence; EVIDENCE after restart must not rebuild it from newer data. */
export async function initialEvidence(deps: SrEngineDeps, taskId: string, build?: () => Promise<EvidencePack>): Promise<EvidencePack> {
  const read = async () => (await deps.srPool.query<{ initial_evidence: EvidencePack | null; initial_evidence_hash: string | null }>(
    'select initial_evidence,initial_evidence_hash from sr_task where task_id=$1::uuid', [taskId])).rows[0];
  let row = await read();
  if (!row?.initial_evidence) {
    if (!build) throw new KernelError('SR_CHECKPOINT_MISSING', 'Original pre-PLAN evidence is unavailable');
    const sent = await deps.srPool.query('select 1 from sr_call where task_id=$1::uuid and sent_at is not null limit 1', [taskId]);
    if (sent.rowCount) throw new KernelError('SR_CHECKPOINT_MISSING', 'Cannot rebuild evidence after an unbound legacy send');
    const pack = await build();
    await fencedSrWrite(deps.srPool, deps.lease, async (tx) => {
      await tx.query('update sr_task set initial_evidence=$2::jsonb,initial_evidence_hash=$3 where task_id=$1::uuid and initial_evidence is null',
        [taskId, JSON.stringify(pack), canonicalSha256(pack)]);
    });
    row = await read();
  }
  const pack = row?.initial_evidence;
  if (!pack || canonicalSha256(pack) !== row!.initial_evidence_hash || pack.taskId !== taskId) throw new KernelError('SR_CHECKPOINT_INVALID', 'Initial evidence hash/identity differs');
  const { packHash, ...core } = pack;
  if (packHash !== canonicalSha256(core)) throw new KernelError('SR_CHECKPOINT_INVALID', 'Initial evidence content hash differs');
  return pack;
}
