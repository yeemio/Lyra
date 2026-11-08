/** Stable user intents: reservation, request, task/step and USER message are created atomically. */
import type { Pool, PoolClient } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import { withTransaction } from '../db/exec.js';
import type { ExecutionLease } from '../kernel/lease.js';
import type { ChatMessage, ReportDocument, SrStep, SrTask } from './contracts.js';
import { fencedSrWrite } from './engine-checkpoint.js';
import { addChatMessage, createChatThread, createTask, getReportById, getTask, insertStep, listChatMessages, listSteps, srFindCallByStep, updateStep } from './store.js';
import { recordUsageEvent, reserveQuota } from './quota.js';

export interface SrRequest {
  account_id: string; request_key: string; kind: 'CHAT' | 'REVISE'; intent_hash: string; intent: unknown;
  task_id: string; report_id: string; report_version: number; report_hash: string;
  thread_id: string | null; step_id: string | null; result_task_id: string | null;
  response_message_id: string | null; state: string; error: unknown;
}
export function requestKey(key: string | undefined, intent: unknown): string {
  const value = key ?? `legacy-${canonicalSha256(intent)}`;
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new KernelError('REQUEST_KEY_INVALID', 'Request identity must be 8–128 ASCII letters, digits, colon, underscore or hyphen');
  return value;
}
async function existingRequest(tx: PoolClient, accountId: string, key: string, intent: unknown): Promise<SrRequest | null> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`sr-request:${accountId}:${key}`]);
  const row = (await tx.query<SrRequest>('select * from sr_request where account_id=$1::uuid and request_key=$2 for update', [accountId, key])).rows[0];
  if (row && row.intent_hash !== canonicalSha256(intent)) throw new KernelError('REQUEST_INTENT_CONFLICT', 'This request identity is already bound to another question, version or revision');
  return row ?? null;
}
async function verifyOwner(tx: PoolClient, accountId: string, report: ReportDocument): Promise<void> {
  const stored = await getReportById(tx, report.reportId, accountId, report.version);
  if (!stored || stored.contentHash !== report.contentHash) throw new KernelError('REQUEST_REPORT_UNBOUND', 'Request report version/owner does not match');
}
async function reserve(tx: PoolClient, accountId: string, kind: 'MODEL_CALL' | 'REPORT_TASK', limit?: number) {
  if (limit === undefined) return null; // local single-user caller has no account quota; execution budget still applies.
  const receipt = await reserveQuota(tx as unknown as Pool, accountId, kind, limit);
  if (!receipt.ok) throw new KernelError('ACCOUNT_QUOTA_EXCEEDED', `${kind}: ${receipt.used}/${receipt.limit}`);
  return { kind, ...receipt };
}

export async function beginChatRequest(pool: Pool, args: {
  accountId: string; report: ReportDocument; key?: string; question: string; kind: ChatMessage['kind']; input: unknown; quotaLimit?: number;
}): Promise<{ request: SrRequest; step: SrStep }> {
  const { report, accountId } = args;
  const userKey = requestKey(undefined, { kind: 'CHAT', reportId: report.reportId, reportVersion: report.version, reportHash: report.contentHash, question: args.question });
  const intent = { userKey, kind: 'CHAT', taskId: report.taskId, reportId: report.reportId, reportVersion: report.version,
    reportHash: report.contentHash, question: args.question, questionKind: args.kind, inputHash: canonicalSha256(args.input) };
  return withTransaction(pool, async (tx) => {
    await verifyOwner(tx, accountId, report);
    const key = await resolvedRequestKey(tx, accountId, args.key, userKey);
    let request = await existingRequest(tx, accountId, key, intent);
    if (!request) {
      const quota = await reserve(tx, accountId, 'MODEL_CALL', args.quotaLimit);
      const thread = await createChatThread(tx as unknown as Pool, report.reportId, accountId, report.version);
      await tx.query('select task_id from sr_task where task_id=$1::uuid for update', [report.taskId]);
      const seq = await tx.query<{ seq: number }>('select greatest(coalesce(max(sequence),899),899)+1 as seq from sr_step where task_id=$1::uuid', [report.taskId]);
      const step = await insertStep(tx, { taskId: report.taskId, stepKind: 'CHAT_ANSWER', sequence: seq.rows[0]!.seq });
      await addChatMessage(tx, { threadId: thread.threadId, role: 'USER', kind: args.kind, content: args.question,
        citations: [], callId: null, suggestedAction: null }, key);
      request = (await tx.query<SrRequest>(`insert into sr_request(account_id,request_key,kind,intent_hash,intent,task_id,
        report_id,report_version,report_hash,thread_id,step_id,quota_reservation)
        values($1,$2,'CHAT',$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb) returning *`,
      [accountId, key, canonicalSha256(intent), JSON.stringify(intent), report.taskId, report.reportId, report.version,
        report.contentHash, thread.threadId, step.stepId, JSON.stringify(quota)])).rows[0]!;
    }
    const step = (await listSteps(tx, report.taskId)).find((s) => s.stepId === request!.step_id);
    if (!step || step.stepKind !== 'CHAT_ANSWER' || !request.thread_id) throw new KernelError('REQUEST_CHECKPOINT_MISSING', 'Original request step/thread missing');
    return { request, step };
  });
}

export async function completeChatRequest(pool: Pool, lease: ExecutionLease, request: SrRequest, message: Omit<ChatMessage, 'messageId' | 'createdAt'>): Promise<ChatMessage> {
  return fencedSrWrite(pool, lease, async (tx) => {
    const row = (await tx.query<SrRequest>('select * from sr_request where account_id=$1::uuid and request_key=$2 for update',
      [request.account_id, request.request_key])).rows[0];
    if (!row || row.step_id !== request.step_id || row.thread_id !== message.threadId) throw new KernelError('REQUEST_CHECKPOINT_MISSING');
    const call = await srFindCallByStep(tx, request.task_id, request.step_id!);
    if (!call || call.callId !== message.callId || call.state !== 'SUCCEEDED') throw new KernelError('REQUEST_CHECKPOINT_INVALID', 'Answer requires the original successful call');
    const saved = await addChatMessage(tx, message, request.request_key);
    await updateStep(tx, request.step_id!, { status: 'SUCCEEDED', finished: true });
    await tx.query(`update sr_request set state='SUCCEEDED',error=null,response_message_id=$3,updated_at=clock_timestamp()
      where account_id=$1::uuid and request_key=$2`, [request.account_id, request.request_key, saved.messageId]);
    return saved;
  });
}

export async function recordRequestFailure(pool: Pool, lease: ExecutionLease, request: SrRequest, error: unknown): Promise<void> {
  await fencedSrWrite(pool, lease, async (tx) => {
    const call = request.step_id ? await srFindCallByStep(tx, request.task_id, request.step_id) : null;
    const state = call?.state === 'UNKNOWN' ? 'UNKNOWN' : call?.state === 'SENT' ? 'PENDING' : call?.state === 'SUCCEEDED' ? 'RESULT_READY' : 'FAILED';
    await tx.query(`update sr_request set state=$3,error=$4::jsonb,updated_at=clock_timestamp()
      where account_id=$1::uuid and request_key=$2 and state<>'SUCCEEDED'`, [request.account_id, request.request_key, state,
      JSON.stringify({ code: error instanceof KernelError ? error.code : 'REQUEST_FAILED', message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })]);
  });
}

export async function createRevisionRequest(pool: Pool, args: {
  accountId: string; report: ReportDocument; key?: string; emphasis: string | null; newCutoff: boolean; quotaLimit?: number;
  methodVersion: string; adapterVersion: string; planAuthVersion: string;
}): Promise<{ task: SrTask; created: boolean }> {
  const { report, accountId } = args;
  const userKey = requestKey(undefined, { kind: 'REVISE', reportId: report.reportId, reportVersion: report.version, reportHash: report.contentHash, emphasis: args.emphasis, newCutoff: args.newCutoff });
  const intent = { userKey, kind: 'REVISE', reportId: report.reportId, reportVersion: report.version, reportHash: report.contentHash,
    emphasis: args.emphasis, newCutoff: args.newCutoff, methodVersion: args.methodVersion,
    adapterVersion: args.adapterVersion, planAuthVersion: args.planAuthVersion };
  return withTransaction(pool, async (tx) => {
    await verifyOwner(tx, accountId, report);
    const key = await resolvedRequestKey(tx, accountId, args.key, userKey);
    const old = await existingRequest(tx, accountId, key, intent);
    if (old) {
      const task = old.result_task_id ? await getTask(tx, old.result_task_id, accountId) : null;
      if (!task) throw new KernelError('REQUEST_CHECKPOINT_MISSING', 'Original revision task is missing');
      return { task, created: false };
    }
    const quota = await reserve(tx, accountId, 'REPORT_TASK', args.quotaLimit);
    const time = await tx.query<{ t: Date }>('select clock_timestamp() as t');
    const cutoff = args.newCutoff ? time.rows[0]!.t.toISOString() : report.cutoff;
    const { task } = await createTask(tx as unknown as Pool, { accountId, subject: report.subject, subjectName: report.subjectName,
      focus: report.focus, emphasis: args.emphasis, horizon: report.horizon, cutoff,
      idemKey: `revision:${key}`, revisedFromTaskId: report.taskId, methodVersion: args.methodVersion,
      adapterVersion: args.adapterVersion, planAuthVersion: args.planAuthVersion });
    await tx.query(`insert into sr_request(account_id,request_key,kind,intent_hash,intent,task_id,report_id,report_version,
      report_hash,result_task_id,state,quota_reservation) values($1,$2,'REVISE',$3,$4::jsonb,$5,$6,$7,$8,$9,'SUCCEEDED',$10::jsonb)`,
    [accountId, key, canonicalSha256(intent), JSON.stringify(intent), report.taskId, report.reportId, report.version,
      report.contentHash, task.taskId, JSON.stringify(quota)]);
    await recordUsageEvent(tx as unknown as Pool, accountId, 'TASK_REVISED', { taskId: task.taskId, from: report.taskId, requestKey: key }, task.taskId);
    return { task, created: true };
  });
}

async function resolvedRequestKey(tx: PoolClient, accountId: string, explicit: string | undefined, userKey: string): Promise<string> {
  if (explicit !== undefined) return requestKey(explicit, null);
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`sr-intent:${accountId}:${userKey}`]);
  const row = (await tx.query<{ request_key: string }>(`select request_key from sr_request where account_id=$1::uuid
    and intent->>'userKey'=$2 order by created_at desc,request_key limit 1`, [accountId, userKey])).rows[0];
  return row?.request_key ?? userKey;
}
