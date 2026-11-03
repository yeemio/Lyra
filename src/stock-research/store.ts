/**
 * Lyra · sr 空间持久层与 permit 空间（R31，2026-10-26）。
 *
 * 职责：
 * - sr_call 的 permit 状态机（与 A/J exec_permit 同一语义：PREPARED/SENT/UNKNOWN/
 *   SUCCEEDED/FAILED、send-once=unique(task_id, step_id)、并发闸 advisory lock、
 *   截止、UNKNOWN 只经显式退役）。经 PermitSpace 接入 kernel/executor.ts 的
 *   runPermittedCall——同一执行器编排，不复制第二套执行器。
 * - 任务/步骤/报告/对话的对象存取（全部参数化 SQL）。
 * - sr 空间的恢复状态与引擎锁（对应 kernel/recovery.ts、kernel/lock.ts 的同构实现）。
 *
 * 表结构：src/db/sr-migration.sql（schema `sr`，新建命名空间，不触碰 public）。
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { KernelError, type PlanAuthBudget } from '../contracts.js';
import { canonicalSha256 } from '../canonical.js';
import { dbNow, withTransaction, type DbClient } from '../db/exec.js';
import type { PermitSpace } from '../kernel/executor.js';
import type { PermitOutcome, TryMarkSentOutcome } from '../kernel/permit.js';
import type {
  ChatMessage,
  ChatThread,
  ReportDocument,
  SrCall,
  SrCallContract,
  SrStep,
  SrTask,
} from './contracts.js';

// ===== 行映射 =====

interface TaskRow {
  task_id: string;
  account_id: string;
  subject: string;
  subject_name: string;
  focus: string;
  emphasis: string | null;
  horizon: string;
  cutoff: Date;
  status: string;
  idem_key: string;
  revised_from_task_id: string | null;
  method_version: string;
  adapter_version: string;
  plan_auth_version: string;
  error: unknown;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function rowToTask(row: TaskRow): SrTask {
  return {
    taskId: row.task_id,
    accountId: row.account_id,
    subject: row.subject,
    subjectName: row.subject_name,
    focus: row.focus as SrTask['focus'],
    emphasis: row.emphasis,
    horizon: row.horizon as SrTask['horizon'],
    cutoff: row.cutoff.toISOString(),
    status: row.status as SrTask['status'],
    idemKey: row.idem_key,
    revisedFromTaskId: row.revised_from_task_id,
    methodVersion: row.method_version,
    adapterVersion: row.adapter_version,
    planAuthVersion: row.plan_auth_version,
    error: (row.error as SrTask['error']) ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

interface StepRow {
  step_id: string;
  task_id: string;
  step_kind: string;
  section_key: string | null;
  sequence: number;
  status: string;
  note: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

function rowToStep(row: StepRow): SrStep {
  return {
    stepId: row.step_id,
    taskId: row.task_id,
    stepKind: row.step_kind as SrStep['stepKind'],
    sectionKey: row.section_key,
    sequence: row.sequence,
    status: row.status as SrStep['status'],
    note: row.note,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

interface CallRow {
  call_id: string;
  task_id: string;
  step_id: string;
  input_hash: string;
  input_bytes: string | number;
  method_version: string;
  plan_auth_version: string;
  deadline: Date;
  state: string;
  sent_at: Date | null;
  settled_at: Date | null;
  fail_code: string | null;
  simulated: boolean;
  provider: string | null;
  model_id: string | null;
  usage: unknown;
  created_at: Date;
}

export function rowToCall(row: CallRow): SrCallPermit {
  return {
    permitId: row.call_id, // permit 空间协议名 = callId（同一对象两种称呼）
    callId: row.call_id,
    taskId: row.task_id,
    stepId: row.step_id,
    inputHash: row.input_hash,
    inputBytes: Number(row.input_bytes),
    methodVersion: row.method_version,
    planAuthVersion: row.plan_auth_version,
    deadline: row.deadline.toISOString(),
    state: row.state as SrCall['state'],
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    failCode: row.fail_code,
    simulated: row.simulated,
    provider: row.provider,
    modelId: row.model_id,
    usage: (row.usage as SrCall['usage']) ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/** 执行器协议视图：permitId = callId。 */
export type SrCallPermit = SrCall & { permitId: string };

// ===== 任务 =====

export interface NewTaskInput {
  accountId: string;
  subject: string;
  subjectName: string;
  focus: SrTask['focus'];
  emphasis: string | null;
  horizon: SrTask['horizon'];
  cutoff: string;
  idemKey: string;
  revisedFromTaskId?: string | null;
  methodVersion: string;
  adapterVersion: string;
  planAuthVersion: string;
}

/**
 * 幂等建任务：同 (account_id, idem_key) 已存在 → 返回既有任务（created=false）。
 * 双击/网络重传不会产生第二个任务或第二次配额预约。
 */
export async function createTask(
  srPool: Pool,
  input: NewTaskInput,
): Promise<{ task: SrTask; created: boolean }> {
  const taskId = randomUUID();
  const res = await srPool.query<TaskRow>(
    `insert into sr_task (task_id, account_id, subject, subject_name, focus, emphasis, horizon,
       cutoff, status, idem_key, revised_from_task_id, method_version, adapter_version, plan_auth_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$10,$11,$12,$13)
     on conflict (account_id, idem_key) do nothing
     returning *`,
    [taskId, input.accountId, input.subject, input.subjectName, input.focus, input.emphasis,
      input.horizon, input.cutoff, input.idemKey, input.revisedFromTaskId ?? null,
      input.methodVersion, input.adapterVersion, input.planAuthVersion],
  );
  const row = res.rows[0];
  if (row) return { task: rowToTask(row), created: true };
  const existing = await srPool.query<TaskRow>(
    `select * from sr_task where account_id = $1 and idem_key = $2`,
    [input.accountId, input.idemKey],
  );
  const old = existing.rows[0];
  if (!old) throw new Error('createTask: 幂等冲突后未找到既有任务（不可达）');
  return { task: rowToTask(old), created: false };
}

export async function getTask(srPool: DbClient, taskId: string, accountId?: string): Promise<SrTask | null> {
  const res = await srPool.query<TaskRow>(
    `select * from sr_task where task_id = $1::uuid${accountId ? ' and account_id = $2::uuid' : ''}`,
    accountId ? [taskId, accountId] : [taskId],
  );
  const row = res.rows[0];
  return row ? rowToTask(row) : null;
}

export async function listTasks(srPool: Pool, accountId: string, limit = 50): Promise<SrTask[]> {
  const res = await srPool.query<TaskRow>(
    `select * from sr_task where account_id = $1::uuid order by created_at desc limit $2`,
    [accountId, limit],
  );
  return res.rows.map(rowToTask);
}

export async function updateTask(
  srPool: Pool,
  taskId: string,
  patch: { status?: SrTask['status']; error?: SrTask['error'] | null; completed?: boolean },
): Promise<SrTask> {
  const res = await srPool.query<TaskRow>(
    `update sr_task set
       status = coalesce($2, status),
       error = coalesce($3::jsonb, error),
       completed_at = case when $4 then now() else completed_at end,
       updated_at = now()
     where task_id = $1::uuid returning *`,
    [taskId, patch.status ?? null, patch.error === undefined ? null : JSON.stringify(patch.error), patch.completed ?? false],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`updateTask: 任务不存在 ${taskId}`);
  return rowToTask(row);
}

/** 取一个排队任务执行（FOR UPDATE SKIP LOCKED：多 worker 安全；配额并发由 quota 层管）。 */
export async function claimQueuedTask(srPool: Pool, workerId: string): Promise<SrTask | null> {
  return withTransaction(srPool, async (tx) => {
    const res = await tx.query<TaskRow>(
      `update sr_task as t set status = 'RUNNING', updated_at = now()
       where t.task_id = (
         select task_id from sr_task where status = 'QUEUED'
         order by created_at limit 1 for update skip locked
       ) returning *`,
    );
    void workerId;
    const row = res.rows[0];
    return row ? rowToTask(row) : null;
  });
}

// ===== 步骤 =====

export interface NewStepInput {
  taskId: string;
  stepKind: SrStep['stepKind'];
  sectionKey?: string | null;
  sequence: number;
}

export async function insertStep(srPool: DbClient, input: NewStepInput): Promise<SrStep> {
  const res = await srPool.query<StepRow>(
    `insert into sr_step (step_id, task_id, step_kind, section_key, sequence, status)
     values ($1,$2,$3,$4,$5,'PENDING') returning *`,
    [randomUUID(), input.taskId, input.stepKind, input.sectionKey ?? null, input.sequence],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insertStep: 写入失败');
  return rowToStep(row);
}

export async function updateStep(
  srPool: DbClient,
  stepId: string,
  patch: { status?: SrStep['status']; note?: string | null; started?: boolean; finished?: boolean },
): Promise<void> {
  await srPool.query(
    `update sr_step set
       status = coalesce($2, status),
       note = coalesce($3, note),
       started_at = case when $4 then now() else started_at end,
       finished_at = case when $5 then now() else finished_at end
     where step_id = $1::uuid`,
    [stepId, patch.status ?? null, patch.note ?? null, patch.started ?? false, patch.finished ?? false],
  );
}

export async function listSteps(srPool: DbClient, taskId: string): Promise<SrStep[]> {
  const res = await srPool.query<StepRow>(
    `select * from sr_step where task_id = $1::uuid order by sequence`,
    [taskId],
  );
  return res.rows.map(rowToStep);
}

/** Register a non-queued, fixed-identity review in the existing sr task/step space. */
export async function registerSrFrozenReview(
  srPool: Pool,
  input: NewTaskInput & { taskId: string; steps: { stepId: string; stepKind: SrStep['stepKind']; sequence: number }[] },
): Promise<void> {
  await srPool.query(
    `insert into sr_task (task_id, account_id, subject, subject_name, focus, emphasis, horizon,
       cutoff, status, idem_key, revised_from_task_id, method_version, adapter_version, plan_auth_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING',$9,null,$10,$11,$12)
     on conflict do nothing`,
    [input.taskId, input.accountId, input.subject, input.subjectName, input.focus, input.emphasis,
      input.horizon, input.cutoff, input.idemKey, input.methodVersion, input.adapterVersion, input.planAuthVersion],
  );
  const task = await getTask(srPool, input.taskId);
  if (!task || (['accountId', 'subject', 'subjectName', 'focus', 'emphasis', 'horizon', 'cutoff', 'idemKey', 'methodVersion', 'adapterVersion', 'planAuthVersion'] as const).some((k) => task[k] !== input[k])) {
    throw new KernelError('BUSINESS_KEY_ALREADY_SENT', 'Frozen strategy task binding differs; changing identity cannot authorize a resend');
  }
  for (const step of input.steps) {
    await srPool.query(
      `insert into sr_step (step_id, task_id, step_kind, section_key, sequence, status)
       values ($1,$2,$3,null,$4,'PENDING') on conflict do nothing`,
      [step.stepId, input.taskId, step.stepKind, step.sequence],
    );
  }
  const steps = await listSteps(srPool, input.taskId);
  if (steps.length !== input.steps.length || input.steps.some((s) => !steps.some((x) => x.stepId === s.stepId && x.stepKind === s.stepKind && x.sequence === s.sequence && x.sectionKey === null))) {
    throw new KernelError('PERMIT_STATE_INVALID', 'Frozen strategy step binding differs');
  }
}

// ===== sr permit 状态机（PermitSpace 实现）=====

/**
 * send-once 载体：unique(task_id, step_id)。冲突替换只允许"从未发送"的行
 * （sent_at is null 且 PREPARED/FAILED）——与 A/J CONFLICT_WHERE 同义。
 */
const SR_CONFLICT_WHERE = `where sr_call.sent_at is null and sr_call.state in ('PREPARED', 'FAILED')`;
const SR_CONFLICT_SET = [
  'call_id = excluded.call_id',
  'input_hash = excluded.input_hash',
  'input_bytes = excluded.input_bytes',
  'method_version = excluded.method_version',
  'plan_auth_version = excluded.plan_auth_version',
  'deadline = excluded.deadline',
  'simulated = excluded.simulated',
  'created_at = now()',
].join(', ');

async function srUpsertCall(
  srPool: Pool,
  contract: SrCallContract,
  simulated: boolean,
  variant: { state: 'PREPARED' } | { state: 'FAILED'; failCode: string },
): Promise<SrCallPermit | null> {
  const callId = randomUUID();
  const base: unknown[] = [callId, contract.taskId, contract.stepId, contract.inputHash,
    contract.inputBytes, contract.methodVersion, contract.planAuthVersion, contract.deadline, simulated];
  let sql: string;
  let params: unknown[];
  if (variant.state === 'PREPARED') {
    sql = `insert into sr_call (call_id, task_id, step_id, input_hash, input_bytes,
        method_version, plan_auth_version, deadline, state, simulated)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED',$9)
      on conflict (task_id, step_id) do update set ${SR_CONFLICT_SET},
        state = 'PREPARED', sent_at = null, settled_at = null, fail_code = null
      ${SR_CONFLICT_WHERE}
      returning *`;
    params = base;
  } else {
    params = [...base, variant.failCode];
    sql = `insert into sr_call (call_id, task_id, step_id, input_hash, input_bytes,
        method_version, plan_auth_version, deadline, state, settled_at, fail_code, simulated)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'FAILED', now(), $10, $9)
      on conflict (task_id, step_id) do update set ${SR_CONFLICT_SET},
        state = 'FAILED', sent_at = null, settled_at = now(), fail_code = excluded.fail_code
      ${SR_CONFLICT_WHERE}
      returning *`;
  }
  const res = await srPool.query<CallRow>(sql, params);
  return res.rows[0] ? rowToCall(res.rows[0]) : null;
}

async function srGetCall(srPool: DbClient, callId: string): Promise<SrCallPermit | null> {
  const res = await srPool.query<CallRow>(`select * from sr_call where call_id = $1::uuid`, [callId]);
  return res.rows[0] ? rowToCall(res.rows[0]) : null;
}

export async function srFindCallByStep(srPool: DbClient, taskId: string, stepId: string): Promise<SrCallPermit | null> {
  const res = await srPool.query<CallRow>(
    `select * from sr_call where task_id = $1::uuid and step_id = $2::uuid`, [taskId, stepId],
  );
  return res.rows[0] ? rowToCall(res.rows[0]) : null;
}

export async function srPreparePermit(
  srPool: Pool,
  contract: SrCallContract,
  budget: PlanAuthBudget,
  opts?: { simulated?: boolean },
): Promise<SrCallPermit> {
  const simulated = opts?.simulated ?? true;
  if (contract.inputBytes > budget.maxInputBytes) {
    const blocked = await srUpsertCall(srPool, contract, simulated, { state: 'FAILED', failCode: 'INPUT_OVER_BUDGET' });
    throw new KernelError(
      'INPUT_OVER_BUDGET',
      `sr 调用输入 ${contract.inputBytes} 字节超过预算 ${budget.maxInputBytes}` +
        `（planAuth ${budget.planAuthVersion}）：具名阻断、不截断、不发送${blocked ? `；call=${blocked.callId}` : ''}`,
    );
  }
  const call = await srUpsertCall(srPool, contract, simulated, { state: 'PREPARED' });
  if (call) return call;
  const existing = await srFindCallByStep(srPool, contract.taskId, contract.stepId);
  if (existing && (existing.sentAt !== null || existing.state === 'SENT' || existing.state === 'SUCCEEDED' || existing.state === 'UNKNOWN')) {
    throw new KernelError(
      'BUSINESS_KEY_ALREADY_SENT',
      `sr 调用键 task=${contract.taskId}/step=${contract.stepId} 已存在已发送链` +
        `（state=${existing.state}, call=${existing.callId}），send-once 拒绝`,
    );
  }
  throw new KernelError(
    'PERMIT_STATE_INVALID',
    '同键 sr_call 并发落位冲突（既有行从未发送）；重试即可，不会产生第二次发送',
  );
}

/** 并发闸串行化键（与 A/J 的 7021001 区分，sr 专属）。 */
const SR_GATE_ADVISORY_KEY = 7311002;

export async function srTryMarkSent(
  srPool: Pool,
  callId: string,
  maxInFlight: number,
): Promise<TryMarkSentOutcome<SrCallPermit>> {
  return withTransaction(srPool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [SR_GATE_ADVISORY_KEY]);
    const res = await tx.query<CallRow>(
      `update sr_call as c set state = 'SENT', sent_at = now()
       where c.call_id = $1::uuid and c.state = 'PREPARED' and now() <= c.deadline
         and (select count(*) from sr_call x where x.state = 'SENT') < $2::int
       returning c.*`,
      [callId, maxInFlight],
    );
    if (res.rows[0]) return { kind: 'SENT', permit: rowToCall(res.rows[0]) };
    const cur = await tx.query<CallRow & { deadline_exceeded: boolean }>(
      `select *, now() > deadline as deadline_exceeded from sr_call where call_id = $1::uuid`,
      [callId],
    );
    const curRow = cur.rows[0];
    if (!curRow) return { kind: 'INVALID_STATE', permit: null };
    if (curRow.state !== 'PREPARED') return { kind: 'INVALID_STATE', permit: rowToCall(curRow) };
    if (curRow.deadline_exceeded) {
      await tx.query(
        `update sr_call set state = 'FAILED', settled_at = now(), fail_code = 'DEADLINE_EXCEEDED'
         where call_id = $1::uuid and state = 'PREPARED'`,
        [callId],
      );
      return { kind: 'DEADLINE_EXCEEDED', permit: rowToCall(curRow) };
    }
    return { kind: 'IN_FLIGHT_FULL' };
  });
}

export async function srSettle(srPool: DbClient, callId: string, outcome: PermitOutcome): Promise<SrCallPermit> {
  const failCode =
    outcome.result === 'FAILED' ? outcome.failCode
    : outcome.result === 'UNKNOWN' ? (outcome.basis ?? 'OUTCOME_UNCONFIRMED')
    : (outcome.failCode ?? null);
  const allowedFrom: string[] = outcome.result === 'FAILED' ? ['SENT', 'PREPARED'] : ['SENT'];
  const res = await srPool.query<CallRow>(
    `update sr_call set state = $2, settled_at = now(), fail_code = $3
     where call_id = $1::uuid and state = any($4::text[]) returning *`,
    [callId, outcome.result, failCode, allowedFrom],
  );
  const row = res.rows[0];
  if (row) return rowToCall(row);
  const cur = await srGetCall(srPool, callId);
  throw new KernelError(
    'PERMIT_STATE_INVALID',
    `sr_call 状态迁移非法：${cur ? cur.state : '不存在'} → ${outcome.result}（call=${callId}）`,
  );
}

/** 调用结算后补记通道身份与用量（不改状态机）。 */
export async function srRecordCallMeta(
  srPool: Pool,
  callId: string,
  meta: { provider: string; modelId: string | null; usage?: SrCall['usage'] },
): Promise<void> {
  await srPool.query(
    `update sr_call set provider = $2, model_id = $3, usage = coalesce($4::jsonb, usage)
     where call_id = $1::uuid`,
    [callId, meta.provider, meta.modelId, meta.usage ? JSON.stringify(meta.usage) : null],
  );
}

/** sr 空间的 UNKNOWN 退役（对应 retireUnknown：只经 Owner 显式确认）。 */
export async function srRetireUnknown(srPool: Pool, callId: string, confirmedBy: string): Promise<void> {
  const by = confirmedBy.trim();
  if (!by) throw new KernelError('UNKNOWN_NOT_RETIRED', 'sr UNKNOWN 退役必须登记确认人（confirmedBy 非空）');
  await withTransaction(srPool, async (tx) => {
    const existing = await tx.query(`select 1 from sr_call_receipt where call_id = $1::uuid`, [callId]);
    if (existing.rows[0]) return; // 幂等
    const cur = await tx.query<CallRow>(`select * from sr_call where call_id = $1::uuid for update`, [callId]);
    const row = cur.rows[0];
    if (!row) throw new KernelError('UNKNOWN_NOT_RETIRED', `sr_call 不存在，无法退役: ${callId}`);
    if (row.state !== 'UNKNOWN') {
      throw new KernelError('PERMIT_STATE_INVALID', `仅 UNKNOWN 可退役（当前 ${row.state}，call=${callId}）`);
    }
    await tx.query(
      `insert into sr_call_receipt (receipt_id, call_id, confirmed_by) values ($1,$2,$3)`,
      [randomUUID(), callId, by],
    );
  });
}

// ===== sr 恢复状态与引擎锁 =====

interface SrRecoveryRow {
  lifecycle: string;
  pending_call_ids: string[] | null;
  updated_at: Date;
}

export interface SrRecoveryState {
  lifecycle: 'RUNNING' | 'RECONCILING';
  pendingCallIds: string[];
  updatedAt: string;
}

export async function getSrRecoveryState(srPool: Pool): Promise<SrRecoveryState> {
  const res = await srPool.query<SrRecoveryRow>(
    'select lifecycle, pending_call_ids, updated_at from sr_recovery_state where id = 1',
  );
  const row = res.rows[0];
  if (!row) throw new Error('sr_recovery_state 单行缺失：sr-migration.sql 未应用');
  return {
    lifecycle: row.lifecycle === 'RECONCILING' ? 'RECONCILING' : 'RUNNING',
    pendingCallIds: Array.isArray(row.pending_call_ids) ? row.pending_call_ids : [],
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 非闭合 sr 调用（SENT 未终结 / UNKNOWN 未退役）。 */
export async function srListUnclosedCalls(srPool: Pool): Promise<SrCall[]> {
  const res = await srPool.query<CallRow>(
    `select * from sr_call c
     where c.state = 'SENT'
        or (c.state = 'UNKNOWN'
            and not exists (select 1 from sr_call_receipt r where r.call_id = c.call_id))
     order by c.created_at, c.call_id`,
  );
  return res.rows.map(rowToCall);
}

export async function srBootRecovery(srPool: Pool): Promise<SrRecoveryState> {
  const pending = await srListUnclosedCalls(srPool);
  const current = await getSrRecoveryState(srPool);
  if (pending.length > 0 || current.lifecycle === 'RECONCILING') {
    await srPool.query(
      `update sr_recovery_state set lifecycle = 'RECONCILING', pending_call_ids = $1::jsonb, updated_at = now()
       where id = 1`,
      [JSON.stringify(pending.map((c) => c.callId))],
    );
    return getSrRecoveryState(srPool);
  }
  return current;
}

export async function srAssertRunning(srPool: Pool): Promise<void> {
  const s = await getSrRecoveryState(srPool);
  if (s.lifecycle === 'RECONCILING') {
    throw new KernelError(
      'RECOVERY_CONFIRM_REQUIRED',
      `sr 空间生命周期 RECONCILING：待处置调用 ${s.pendingCallIds.length} 个。零模型调用；经 srConfirmRecovery 确认后恢复`,
    );
  }
}

/** RECONCILING 唯一出口：无法配对确认终态的 SENT 默认转 UNKNOWN；owner 必填。 */
export async function srConfirmRecovery(
  srPool: Pool,
  owner: string,
  resolve?: (call: SrCall) => { outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; failCode?: string },
): Promise<SrRecoveryState> {
  const who = owner.trim();
  if (!who) throw new KernelError('RECOVERY_CONFIRM_REQUIRED', 'sr 恢复确认必须登记确认人');
  return withTransaction(srPool, async (tx) => {
    const cur = await tx.query<SrRecoveryRow>(
      'select * from sr_recovery_state where id = 1 for update',
    );
    const row = cur.rows[0];
    if (!row) throw new Error('sr_recovery_state 单行缺失');
    if (row.lifecycle !== 'RECONCILING') return getSrRecoveryState(tx as unknown as Pool);
    const ids = Array.isArray(row.pending_call_ids) ? row.pending_call_ids : [];
    for (const callId of ids) {
      const c = await tx.query<CallRow>(`select * from sr_call where call_id = $1::uuid`, [callId]);
      const call = c.rows[0];
      if (!call) continue;
      if (call.state === 'SENT') {
        const decision = resolve?.(rowToCall(call)) ?? { outcome: 'UNKNOWN' as const };
        const outcome: PermitOutcome = decision.outcome === 'SUCCEEDED'
          ? { result: 'SUCCEEDED' }
          : decision.outcome === 'FAILED'
            ? { result: 'FAILED', failCode: decision.failCode ?? 'RECOVERY_CONFIRMED_FAIL' }
            : { result: 'UNKNOWN', basis: 'RECOVERY_UNCONFIRMED' };
        await srSettle(tx, callId, outcome);
      }
      // UNKNOWN 保持待退役；其余状态跳过。
    }
    const updated = await tx.query<SrRecoveryRow>(
      `update sr_recovery_state set lifecycle = 'RUNNING', pending_call_ids = '[]'::jsonb, updated_at = now()
       where id = 1 returning lifecycle, pending_call_ids, updated_at`,
    );
    const after = updated.rows[0];
    if (!after) throw new Error('srConfirmRecovery: 状态更新失败');
    return {
      lifecycle: after.lifecycle === 'RECONCILING' ? 'RECONCILING' : 'RUNNING',
      pendingCallIds: [],
      updatedAt: after.updated_at.toISOString(),
    };
  });
}

// ===== sr 引擎锁（单行表，语义同 kernel_lock）=====

export const SR_LOCK_TTL_MS = 60_000;

export async function acquireSrEngineLock(srPool: Pool, holderId: string, opts?: { ttlMs?: number }): Promise<void> {
  const ttlMs = opts?.ttlMs ?? SR_LOCK_TTL_MS;
  const res = await srPool.query(
    `update sr_engine_lock set
       holder = $1,
       acquired_at = case when sr_engine_lock.holder = $1 then sr_engine_lock.acquired_at else now() end,
       heartbeat_at = now()
     where id = 1
       and (sr_engine_lock.holder = '' or sr_engine_lock.holder = $1
            or sr_engine_lock.heartbeat_at < now() - ($2::double precision * interval '1 millisecond'))`,
    [holderId, ttlMs],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new KernelError('EXECUTION_LOCK_HELD', `sr 引擎锁被他人持有，${holderId} 被拒绝`);
  }
}

export async function heartbeatSrEngineLock(srPool: Pool, holderId: string): Promise<void> {
  const res = await srPool.query(
    `update sr_engine_lock set heartbeat_at = now() where id = 1 and holder = $1`,
    [holderId],
  );
  if ((res.rowCount ?? 0) === 0) throw new KernelError('EXECUTION_LOCK_HELD', 'sr 引擎锁已易主，心跳被拒');
}

export async function releaseSrEngineLock(srPool: Pool, holderId: string): Promise<void> {
  await srPool.query(
    `update sr_engine_lock set holder = '', acquired_at = now() - interval '1 day',
       heartbeat_at = now() - interval '1 day' where id = 1 and holder = $1`,
    [holderId],
  );
}

export async function assertSrLockHeld(srPool: Pool, holderId: string, opts?: { ttlMs?: number }): Promise<void> {
  const ttlMs = opts?.ttlMs ?? SR_LOCK_TTL_MS;
  const res = await srPool.query<{ holder: string; heartbeat_at: Date }>(
    'select holder, heartbeat_at from sr_engine_lock where id = 1',
  );
  const row = res.rows[0];
  if (!row) throw new Error('sr_engine_lock 单行缺失');
  const ageMs = (await dbNow(srPool)).getTime() - row.heartbeat_at.getTime();
  if (row.holder !== holderId || ageMs >= ttlMs) {
    throw new KernelError('EXECUTION_LOCK_HELD', `sr 引擎执行权校验失败（holder=${row.holder || '(空)'}）`);
  }
}

/** UNKNOWN 调用是否已有退役回执（重试新步骤的前置判定）。 */
export async function srCallHasReceipt(srPool: DbClient, callId: string): Promise<boolean> {
  const res = await srPool.query(`select 1 from sr_call_receipt where call_id = $1::uuid`, [callId]);
  return (res.rowCount ?? 0) > 0;
}

// ===== sr permit space 装配（接入 runPermittedCall）=====

export const SR_PERMIT_SPACE: PermitSpace<SrCallPermit, SrCallContract> = {
  assertLock: (pool, holderId) => assertSrLockHeld(pool, holderId),
  assertRunning: srAssertRunning,
  preparePermit: srPreparePermit,
  tryMarkSent: srTryMarkSent,
  settle: srSettle,
};

// ===== 报告 =====

export async function insertReport(srPool: Pool, report: Omit<ReportDocument, 'contentHash'>): Promise<ReportDocument> {
  const full: ReportDocument = { ...report, contentHash: canonicalSha256({ ...report }) };
  const res = await srPool.query(
    `insert into sr_report (report_id, task_id, version, status, subject, subject_name, focus, horizon,
       cutoff, method_version, adapter_version, plan_auth_version, generated_by, content, qa_findings,
       change_summary, content_hash, published_at, report_gate, evidence_refs)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,
       case when $4 like 'PUBLISHED%' then now() else null end, $18::jsonb, $19::jsonb)`,
    [full.reportId, full.taskId, full.version, full.status, full.subject, full.subjectName,
      full.focus, full.horizon, full.cutoff, full.methodVersion, full.adapterVersion,
      full.planAuthVersion, full.generatedBy, JSON.stringify(full.sections),
      JSON.stringify(full.qaFindings), full.changeSummary, full.contentHash,
      full.gate ? JSON.stringify(full.gate) : null,
      full.evidenceRefs ? JSON.stringify(full.evidenceRefs) : null],
  );
  if ((res.rowCount ?? 0) === 0) throw new Error('insertReport: 写入失败');
  return full;
}

export async function getReportByTaskAndVersion(
  srPool: DbClient,
  taskId: string,
  version: number,
): Promise<ReportDocument | null> {
  const res = await srPool.query<ReportRow>(
    `select r.*, a.account_id from sr_report r join sr_task a on a.task_id = r.task_id
     where r.task_id = $1::uuid and r.version = $2`,
    [taskId, version],
  );
  return res.rows[0] ? rowToReport(res.rows[0]) : null;
}

interface ReportRow {
  report_id: string;
  task_id: string;
  version: number;
  status: string;
  subject: string;
  subject_name: string;
  focus: string;
  horizon: string;
  cutoff: Date;
  method_version: string;
  adapter_version: string;
  plan_auth_version: string;
  generated_by: string;
  content: unknown;
  qa_findings: unknown;
  change_summary: string | null;
  content_hash: string;
  created_at: Date;
  published_at: Date | null;
  report_gate: unknown;
  evidence_refs: unknown;
  account_id?: string;
}

function rowToReport(row: ReportRow): ReportDocument {
  return {
    reportId: row.report_id,
    taskId: row.task_id,
    version: row.version,
    status: row.status as ReportDocument['status'],
    subject: row.subject,
    subjectName: row.subject_name,
    focus: row.focus as ReportDocument['focus'],
    horizon: row.horizon as ReportDocument['horizon'],
    cutoff: row.cutoff.toISOString(),
    methodVersion: row.method_version,
    adapterVersion: row.adapter_version,
    planAuthVersion: row.plan_auth_version,
    generatedBy: row.generated_by as ReportDocument['generatedBy'],
    sections: row.content as ReportDocument['sections'],
    qaFindings: row.qa_findings as ReportDocument['qaFindings'],
    changeSummary: row.change_summary,
    gate: (row.report_gate as ReportDocument['gate']) ?? null,
    evidenceRefs: (row.evidence_refs as ReportDocument['evidenceRefs']) ?? null,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    contentHash: row.content_hash,
  };
}

export interface ReportWithOwner extends ReportDocument {
  accountId: string;
}

/** 按报告身份读取（带归属；accountId 不匹配返回 null——服务端访问控制的取数基础）。 */
export async function getReportById(srPool: DbClient, reportId: string, accountId?: string): Promise<ReportWithOwner | null> {
  const res = await srPool.query<ReportRow>(
    `select r.*, a.account_id from sr_report r join sr_task a on a.task_id = r.task_id
     where r.report_id = $1::uuid${accountId ? ' and a.account_id = $2::uuid' : ''}`,
    accountId ? [reportId, accountId] : [reportId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const acc = row.account_id;
  return acc ? { ...rowToReport(row), accountId: acc } : null;
}

export async function listReportVersions(srPool: DbClient, taskId: string): Promise<ReportDocument[]> {
  const res = await srPool.query<ReportRow>(
    `select r.*, a.account_id from sr_report r join sr_task a on a.task_id = r.task_id
     where r.task_id = $1::uuid order by r.version desc`, [taskId],
  );
  return res.rows.map(rowToReport);
}

/** 旧版本 SUPERSEDED 化 + 新版本发布（一个事务；不可变发布版本语义）。 */
export async function publishNewVersion(
  srPool: Pool,
  report: Omit<ReportDocument, 'contentHash'>,
): Promise<ReportDocument> {
  return withTransaction(srPool, async (tx) => {
    await tx.query(
      `update sr_report set status = 'SUPERSEDED' where report_id = $1::uuid and version < $2`,
      [report.reportId, report.version],
    );
    return insertReport(tx as unknown as Pool, { ...report, status: 'PUBLISHED' });
  });
}

// ===== 对话 =====

export async function createChatThread(srPool: Pool, reportId: string, accountId: string): Promise<ChatThread> {
  const threadId = randomUUID();
  await srPool.query(
    `insert into sr_chat_thread (thread_id, report_id, account_id) values ($1,$2,$3)`,
    [threadId, reportId, accountId],
  );
  return { threadId, reportId, accountId, createdAt: new Date().toISOString() };
}

export async function getChatThread(srPool: DbClient, threadId: string, accountId?: string): Promise<ChatThread | null> {
  const res = await srPool.query(
    `select t.*, r.task_id as task_ref from sr_chat_thread t
     join sr_report r on r.report_id = t.report_id
     join sr_task k on k.task_id = r.task_id
     where t.thread_id = $1::uuid${accountId ? ' and k.account_id = $2::uuid' : ''}`,
    accountId ? [threadId, accountId] : [threadId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { threadId: row.thread_id, reportId: row.report_id, accountId: row.account_id, createdAt: row.created_at.toISOString() };
}

export async function findThreadForReport(srPool: DbClient, reportId: string, accountId: string): Promise<ChatThread | null> {
  const res = await srPool.query(
    `select t.* from sr_chat_thread t
     join sr_task k on k.task_id = (select task_id from sr_report where report_id = $1::uuid)
     where t.report_id = $1::uuid and k.account_id = $2::uuid limit 1`,
    [reportId, accountId],
  );
  const row = res.rows[0];
  return row ? { threadId: row.thread_id, reportId: row.report_id, accountId, createdAt: row.created_at.toISOString() } : null;
}

export async function addChatMessage(srPool: DbClient, msg: Omit<ChatMessage, 'messageId' | 'createdAt'>): Promise<ChatMessage> {
  const messageId = randomUUID();
  await srPool.query(
    `insert into sr_chat_message (message_id, thread_id, role, kind, content, citations, call_id, suggested_action)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
    [messageId, msg.threadId, msg.role, msg.kind, msg.content,
      JSON.stringify(msg.citations ?? []), msg.callId ?? null,
      msg.suggestedAction ? JSON.stringify(msg.suggestedAction) : null],
  );
  return { ...msg, messageId, createdAt: new Date().toISOString() };
}

export async function listChatMessages(srPool: DbClient, threadId: string): Promise<ChatMessage[]> {
  const res = await srPool.query(
    `select * from sr_chat_message where thread_id = $1::uuid order by created_at, case when role = 'USER' then 0 else 1 end, message_id`,
    [threadId],
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    messageId: String(r.message_id),
    threadId: String(r.thread_id),
    role: r.role as 'USER' | 'ASSISTANT',
    kind: r.kind as ChatMessage['kind'],
    content: String(r.content),
    citations: (r.citations as ChatMessage['citations']) ?? [],
    callId: r.call_id ? String(r.call_id) : null,
    suggestedAction: (r.suggested_action as ChatMessage['suggestedAction']) ?? null,
    createdAt: r.created_at instanceof Date ? (r.created_at as Date).toISOString() : String(r.created_at),
  }));
}
