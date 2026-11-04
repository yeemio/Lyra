import { randomUUID } from 'node:crypto';
/** Trusted replay uses the original package and successful permit, never a filename or a fresh as-of query. */
import type { Pool } from 'pg';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { KernelError, type ModelCallContract, type PlanAuthBudget, type ResearchBusinessKey } from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { withTransaction } from '../db/exec.js';
import { readConclusion } from '../db/conclusion.js';
import { buildConclusionObject, researchCoreOf, conclusionHashOf, type ConclusionInput } from '../conclusion/object.js';
import { assertLease, type ExecutionLease } from '../kernel/lease.js';
import { researchExecutionKey, releaseUnsentReservations } from '../kernel/budget.js';
import { findPermitByBusinessKey } from '../kernel/permit.js';
import { contractHash, loadCallCheckpoint } from '../kernel/response.js';
import { runModelCall, type ModelCallSuccess } from '../kernel/executor.js';
import { preflightTransport, type ModelTransport } from '../kernel/transport.js';
import type { AssembledResearchInput } from './inputs.js';
import { buildARequest, buildJRequest, type ResearchRequest } from './requests.js';
import { persistResearchConclusion } from './trace.js';

export interface ResearchSnapshot<M = unknown> {
  version: 1;
  assembled: AssembledResearchInput;
  deadline: string;
  metadata: M;
}

export async function verifyResearchSnapshot(store: ArtifactStore, snapshot: ResearchSnapshot): Promise<void> {
  const a = snapshot.assembled;
  const { inputHash, ...core } = a.package;
  const bytes = await store.readBytes(a.artifactRef.sha256);
  if (snapshot.version !== 1 || !Number.isFinite(Date.parse(snapshot.deadline)) ||
      inputHash !== canonicalSha256(core) || a.inputHash !== inputHash ||
      a.artifactRef.bytes !== bytes.byteLength || a.inputBytes !== bytes.byteLength ||
      new TextDecoder().decode(bytes) !== canonicalJsonString(a.package)) {
    throw new KernelError('RESEARCH_CHECKPOINT_INVALID', 'Original package, CAS bytes or input identity differ');
  }
}

export async function freezeResearchSnapshot<M>(
  pool: Pool, store: ArtifactStore, lease: ExecutionLease, key: ResearchBusinessKey, intent: unknown,
  build: () => Promise<ResearchSnapshot<M>>,
): Promise<ResearchSnapshot<M>> {
  const executionKey = researchExecutionKey(key);
  const requestHash = canonicalSha256(intent);
  const read = async () => (await pool.query<{ request_hash: string; snapshot_hash: string; snapshot: ResearchSnapshot<M> }>(
    'select request_hash,snapshot_hash,snapshot from research_execution where execution_key=$1', [executionKey])).rows[0];
  let row = await read();
  if (!row) {
    const candidate = await build();
    await verifyResearchSnapshot(store, candidate);
    await withTransaction(pool, async (tx) => {
      await assertLease(tx, lease, true);
      await assertResearchRunning(tx as unknown as Pool);
      await tx.query(`insert into research_execution(execution_key,business_key,request_hash,snapshot,snapshot_hash)
        values($1,$2::jsonb,$3,$4::jsonb,$5) on conflict(execution_key) do nothing`,
      [executionKey, JSON.stringify(key), requestHash, JSON.stringify(candidate), canonicalSha256(candidate)]);
      await assertLease(tx, lease);
    });
    row = await read();
  }
  if (!row || row.request_hash !== requestHash || row.snapshot_hash !== canonicalSha256(row.snapshot)) {
    throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Business key is already bound to another execution intent or damaged snapshot');
  }
  await verifyResearchSnapshot(store, row.snapshot);
  return row.snapshot;
}

/** A completed call may replay only if every request/transport binding and its validated output still agree. */
export async function runResearchStage<A>(args: {
  pool: Pool; lease: ExecutionLease; transport: ModelTransport; contract: ModelCallContract;
  budget: PlanAuthBudget; reuseDeadline?: boolean; snapshot: ResearchSnapshot; request: ResearchRequest; validate: (value: unknown) => A;
}): Promise<ModelCallSuccess<A>> {
  const { pool, lease, transport, request } = args;
  const old = await findPermitByBusinessKey(pool, args.contract);
  const contract = args.reuseDeadline && old ? { ...args.contract, deadline: old.contract.deadline } : args.contract;
  const identity = transport.describe();
  const checkpointInput = { packageSha256: args.snapshot.assembled.artifactRef.sha256, payload: request.payload };
  if (old?.sentAt) {
    const cp = await loadCallCheckpoint(pool, 'kernel', old.permitId);
    if (!cp) throw new KernelError(old.state === 'UNKNOWN' || old.state === 'SENT' ? 'RECOVERY_CONFIRM_REQUIRED' : 'RECOVERY_CHECKPOINT_MISSING',
      `Original ${contract.stage} permit ${old.permitId} is ${old.state}; no trusted result may be guessed or resent`);
    if (contractHash(old.contract) !== contractHash(contract) || contractHash(cp.contract) !== contractHash(contract) ||
        canonicalSha256(cp.input) !== canonicalSha256(checkpointInput) || canonicalSha256(cp.transport) !== canonicalSha256(identity) ||
        cp.simulated !== identity.simulated) throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Permit/input/transport identity changed on replay');
    return { permit: old, output: args.validate(cp.output) };
  }
  return runModelCall(pool, { contract, budget: args.budget, lease, simulated: identity.simulated,
    preflight: () => preflightTransport(transport, contract, request.payload),
    checkpoint: { input: checkpointInput, transport: identity },
    modelFn: async (ctx) => args.validate(await transport.dispatch(contract, request.payload, ctx.signal)) });
}

/** Publication can retry after a crash; the immutable conclusion is verified and read, never rewritten. */
export async function publishResearchCheckpoint(pool: Pool, store: ArtifactStore, lease: ExecutionLease, input: ConclusionInput) {
  const expected = buildConclusionObject(input);
  return withTransaction(pool, async (tx) => {
    await assertLease(tx, lease, true);
    await assertResearchRunning(tx as unknown as Pool);
    const key = researchExecutionKey(input.businessKey);
    const row = (await tx.query<{ conclusion_id: string | null; conclusion_hash: string | null; snapshot: ResearchSnapshot; snapshot_hash: string }>(
      'select conclusion_id,conclusion_hash,snapshot,snapshot_hash from research_execution where execution_key=$1 for update', [key])).rows[0];
    if (!row) throw new KernelError('RESEARCH_CHECKPOINT_MISSING', 'Publication requires the original execution snapshot');
    if (row.conclusion_id && (row.conclusion_id !== expected.conclusionId || row.conclusion_hash !== expected.conclusionHash)) {
      throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Publication differs from the original conclusion');
    }
    const db = tx as unknown as Pool;
    if (row.snapshot_hash !== canonicalSha256(row.snapshot) || canonicalSha256(row.snapshot.assembled.package) !== canonicalSha256(input.researchInput)) {
      throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Publication does not use the original frozen package');
    }
    await verifyResearchSnapshot(store, row.snapshot);
    const requests = [buildARequest(input.researchInput, input.aOutput.simulated), buildJRequest(input.researchInput, input.aOutput, input.checklist, input.aOutput.simulated)];
    let transportHash: string | undefined;
    for (const [index, stage] of (['A','J'] as const).entries()) {
      const permit = await findPermitByBusinessKey(db, { businessKey: input.businessKey, stage });
      const cp = permit ? await loadCallCheckpoint(db, 'kernel', permit.permitId) : null;
      const request = requests[index]!;
      const output = stage === 'A' ? input.aOutput : input.jOutput;
      if (!permit || !cp || contractHash(cp.contract) !== contractHash(permit.contract) ||
          permit.contract.inputHash !== request.inputHash || permit.contract.inputBytes !== request.inputBytes ||
          permit.contract.methodVersion !== input.methodVersion || permit.contract.planAuthVersion !== input.planAuthVersion ||
          cp.simulated !== input.aOutput.simulated || canonicalSha256(cp.output) !== canonicalSha256(output) ||
          canonicalSha256(cp.input) !== canonicalSha256({ packageSha256: row.snapshot.assembled.artifactRef.sha256, payload: request.payload })) {
        throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Publication requires both original successful A/J permits and their validated responses');
      }
      const hash = canonicalSha256(cp.transport);
      if (transportHash !== undefined && hash !== transportHash) throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'A/J transport identities differ');
      transportHash = hash;
    }
    const existing = await readConclusion(db, expected.conclusionId);
    if (existing && (existing.conclusionHash !== expected.conclusionHash || conclusionHashOf(researchCoreOf(existing)) !== expected.conclusionHash)) throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Existing conclusion hash differs');
    const conclusion = existing ?? await persistResearchConclusion(db, store, input);
    await tx.query('update research_execution set conclusion_id=$2,conclusion_hash=$3 where execution_key=$1',
      [key, conclusion.conclusionId, conclusion.conclusionHash]);
    await assertLease(tx, lease);
    return conclusion;
  });
}

// Same-process duplicate entry points share one chain; a rejected duplicate cannot release its J reservation.
const chains = new WeakMap<Pool, Map<string, { intent: string; result: Promise<unknown> }>>();
export async function coalesceResearchRun<T>(pool: Pool, key: ResearchBusinessKey, intent: unknown, run: () => Promise<T>): Promise<T> {
  let map = chains.get(pool);
  if (!map) { map = new Map(); chains.set(pool, map); }
  const id = researchExecutionKey(key), hash = canonicalSha256(intent);
  const old = map.get(id);
  if (old) {
    if (old.intent !== hash) throw new KernelError('RESEARCH_CHECKPOINT_CONFLICT', 'Concurrent business key has another intent');
    return old.result as Promise<T>;
  }
  const result = Promise.resolve().then(run);
  map.set(id, { intent: hash, result });
  try { return await result; } finally { map.delete(id); }
}

async function assertResearchRunning(pool: Pool): Promise<void> {
  const row = (await pool.query('select lifecycle from recovery_state where id=1 for share')).rows[0];
  if (row?.lifecycle !== 'RUNNING') throw new KernelError('RECOVERY_CONFIRM_REQUIRED');
}

/** A database claim protects one chain even when two Pool objects share a valid lease. */
export async function withResearchClaim<T>(pool: Pool, lease: ExecutionLease, key: ResearchBusinessKey, run: () => Promise<T>): Promise<T> {
  const id = researchExecutionKey(key), owner = randomUUID();
  await withTransaction(pool, async (tx) => {
    await assertLease(tx, lease, true);
    await assertResearchRunning(tx as unknown as Pool);
    const claimed = await tx.query(`insert into research_execution_claim(execution_key,owner,generation) values($1,$2,$3::bigint)
      on conflict(execution_key) do update set owner=excluded.owner,generation=excluded.generation
      where research_execution_claim.generation<excluded.generation returning owner`, [id, owner, lease.generation]);
    if (claimed.rowCount !== 1) throw new KernelError('RESEARCH_ALREADY_RUNNING', 'Original business chain is active; duplicate cannot release its reservations');
    await assertLease(tx, lease);
  });
  try { return await run(); } finally {
    await releaseUnsentReservations(pool, key, lease).catch(() => undefined);
    await withTransaction(pool, async (tx) => {
      await assertLease(tx, lease, true);
      await tx.query('delete from research_execution_claim where execution_key=$1 and owner=$2::uuid', [id, owner]);
      await assertLease(tx, lease);
    }).catch(() => undefined);
  }
}
