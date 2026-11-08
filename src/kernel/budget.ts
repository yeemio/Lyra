/** Atomic Shanghai-week reservations; sent attempts (including UNKNOWN) never release capacity. */
import type { Pool, PoolClient } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import { KernelError, type ModelCallContract, type PlanAuthBudget, type ResearchBusinessKey, type Stage } from '../contracts.js';
import { withTransaction } from '../db/exec.js';
import { assertLease, type ExecutionLease } from './lease.js';

export const BUDGET_GATE_KEY = 7041301;
export const researchExecutionKey = (key: ResearchBusinessKey): string => canonicalSha256({ ...key, cutoff: new Date(key.cutoff).toISOString() });
export function scopeLimit(budget: PlanAuthBudget, scope: 'WEEKLY' | 'POST_EVENT'): number {
  const n = scope === 'WEEKLY' ? (budget.scopeLimits?.weekly ?? 60) : (budget.scopeLimits?.postEvent ?? 10);
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(budget.maxModelCallsPerWeek) || budget.maxModelCallsPerWeek < 0) {
    throw new KernelError('EXECUTION_BUDGET_INVALID', 'Call limits must be nonnegative integers');
  }
  return n;
}

/** Must be in the SENT transaction, after the lease row is fenced. */
export async function reserveSend(tx: PoolClient, contract: ModelCallContract, budget: PlanAuthBudget, permitId: string): Promise<void> {
  if (contract.planAuthVersion !== budget.planAuthVersion) throw new KernelError('PLAN_AUTH_MISMATCH', 'Call and budget authorization differ');
  await bindBudget(tx, 'kernel', budget);
  const scope = contract.businessKey.researchKind === 'POST_EVENT' ? 'POST_EVENT' : 'WEEKLY';
  const limit = scopeLimit(budget, scope);
  const key = researchExecutionKey(contract.businessKey);
  await tx.query('select pg_advisory_xact_lock($1::bigint)', [BUDGET_GATE_KEY]);
  const time = await tx.query<{ week: string }>("select date_trunc('week',clock_timestamp() at time zone 'Asia/Shanghai')::date::text as week");
  const week = time.rows[0]!.week;
  await tx.query(`update execution_budget_reservation set state='RELEASED'
    where state='HELD' and (deadline<=clock_timestamp() or week_start<>$1::date)`, [week]);
  const sent = await tx.query<{ stage: Stage }>(`select stage from exec_permit where subject_kind=$1 and subject=$2 and research_kind=$3 and cutoff=$4::timestamptz and sent_at is not null`,
    [contract.businessKey.subjectKind, contract.businessKey.subject, contract.businessKey.researchKind, contract.businessKey.cutoff]);
  const sentStages = new Set(sent.rows.map((r) => r.stage));
  const stages: Stage[] = contract.stage === 'A' ? ['A','J'] : ['J'];
  const old = await tx.query<{ stage: Stage; state: string; plan_auth_version: string; scope_limit: number; plan_limit: number }>(
    'select stage,state,plan_auth_version,scope_limit,plan_limit from execution_budget_reservation where business_key=$1', [key]);
  if (old.rows.some((r) => r.state === 'HELD' && (r.plan_auth_version !== budget.planAuthVersion || r.scope_limit !== limit || r.plan_limit !== budget.maxModelCallsPerWeek))) {
    throw new KernelError('PLAN_AUTH_MISMATCH', 'Cannot change an active reservation authorization');
  }
  const held = new Set(old.rows.filter((r) => r.state === 'HELD').map((r) => r.stage));
  const needed = stages.filter((s) => !sentStages.has(s) && !held.has(s));
  const usage = await tx.query<{ scope_used: string; plan_used: string }>(`
    with sent as (select research_kind,plan_auth_version from exec_permit
      where sent_at >= ($1::date::timestamp at time zone 'Asia/Shanghai')
        and sent_at < (($1::date+7)::timestamp at time zone 'Asia/Shanghai')),
    held as (select scope,plan_auth_version from execution_budget_reservation where week_start=$1::date and state='HELD')
    select ((select count(*) from sent where case when research_kind='POST_EVENT' then 'POST_EVENT' else 'WEEKLY' end=$2)
      +(select count(*) from held where scope=$2))::text as scope_used,
      ((select count(*) from sent where plan_auth_version=$3)+(select count(*) from held where plan_auth_version=$3))::text as plan_used`,
    [week, scope, budget.planAuthVersion]);
  const u = usage.rows[0]!;
  if (Number(u.scope_used) + needed.length > limit || Number(u.plan_used) + needed.length > budget.maxModelCallsPerWeek) {
    throw new KernelError('MODEL_CALL_BUDGET_EXCEEDED', `${scope} budget cannot reserve ${needed.length} stages; sent and held slots are counted`);
  }
  for (const stage of needed) {
    await tx.query(`insert into execution_budget_reservation
      (week_start,scope,business_key,stage,state,plan_auth_version,scope_limit,plan_limit,deadline)
      values($1,$2,$3,$4,'HELD',$5,$6,$7,$8)
      on conflict(business_key,stage) do update set week_start=excluded.week_start,scope=excluded.scope,state='HELD',
      plan_auth_version=excluded.plan_auth_version,scope_limit=excluded.scope_limit,plan_limit=excluded.plan_limit,deadline=excluded.deadline,permit_id=null
      where execution_budget_reservation.state='RELEASED'`,
      [week, scope, key, stage, budget.planAuthVersion, limit, budget.maxModelCallsPerWeek, contract.deadline]);
  }
}

export async function consumeSendReservation(tx: PoolClient, contract: ModelCallContract, permitId: string): Promise<void> {
  const consumed = await tx.query(`update execution_budget_reservation set state='CONSUMED',permit_id=$3::uuid
    where business_key=$1 and stage=$2 and state='HELD' returning stage`, [researchExecutionKey(contract.businessKey), contract.stage, permitId]);
  if (consumed.rowCount !== 1) throw new KernelError('MODEL_CALL_BUDGET_EXCEEDED', 'No unused reservation for this send');
}

/** A stopped chain may release only its unsent reservations, never sent/UNKNOWN capacity. */
export async function releaseUnsentReservations(pool: Pool, key: ResearchBusinessKey, lease: ExecutionLease): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await assertLease(tx, lease, true);
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [BUDGET_GATE_KEY]);
    await tx.query("update execution_budget_reservation set state='RELEASED' where business_key=$1 and state='HELD'", [researchExecutionKey(key)]);
    await assertLease(tx, lease);
  });
}

/** An authorization version cannot acquire a larger ceiling on a later business key. */
export async function bindBudget(tx: PoolClient, space: 'kernel' | 'sr', budget: PlanAuthBudget): Promise<void> {
  const limits = { input: budget.maxInputBytes, inFlight: budget.maxInFlight, week: budget.maxModelCallsPerWeek,
    task: (budget as PlanAuthBudget & { maxModelCallsPerTask?: number }).maxModelCallsPerTask ?? null,
    weekly: space === 'kernel' ? scopeLimit(budget, 'WEEKLY') : null,
    postEvent: space === 'kernel' ? scopeLimit(budget, 'POST_EVENT') : null };
  if (Object.values(limits).some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0)) || limits.inFlight < 1) throw new KernelError('EXECUTION_BUDGET_INVALID');
  await tx.query(`insert into execution_budget_authorization(space,plan_auth_version,limits) values($1,$2,$3::jsonb)
    on conflict(space,plan_auth_version) do nothing`, [space, budget.planAuthVersion, JSON.stringify(limits)]);
  const old = (await tx.query<{ limits: typeof limits }>('select limits from execution_budget_authorization where space=$1 and plan_auth_version=$2', [space, budget.planAuthVersion])).rows[0]!.limits;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    if (limits[key] !== null && (old[key] === null || limits[key]! > old[key]!)) throw new KernelError('PLAN_AUTH_MISMATCH', 'Authorization ceiling cannot be increased under the same version');
  }
}
