/** Real isolated PostgreSQL gates, with public synthetic reports and transports only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { KernelError } from '../contracts.js';
import { canonicalSha256 } from '../canonical.js';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { acquireLease, releaseLease } from '../kernel/lease.js';
import { createAccount } from './accounts.js';
import { defaultSrPlanBudget } from './contracts.js';
import { askReportQuestion, runSrTask } from './engine.js';
import { createTask, getTask, insertReport, listSteps, listReportVersions, resumeSrTask, srGetCall } from './store.js';
import { beginChatRequest, createRevisionRequest } from './store-requests.js';
import { reportFixture } from './report-identity-test-helper.js';
import { SyntheticRecoveryTransport, syntheticInitialEvidence } from './engine-recovery-test-helper.js';
import { createSrServer, startSrWorker } from './server.js';

const url = process.env.LYRA_REPAIR_TEST_PG;
const gate = { skip: url ? false : 'NOT_RUN: explicit isolated LYRA_REPAIR_TEST_PG is unavailable' };
async function fixture(t: TestContext) {
  assert.ok(url); assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
  const schema = `pr4_sr_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const other = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const outputDir = await mkdtemp(join(tmpdir(), 'pr4-sr-pg-'));
  await applySchema(admin, schema, srMigrationSqlUrl); await applySchema(admin, schema, srMigrationSqlUrl);
  t.after(async () => { await pool.end(); await other.end(); await dropSchema(admin, schema); await admin.end(); await rm(outputDir, { recursive: true, force: true }); });
  const account = await createAccount(pool, { username: 'public_synthetic', password: 'synthetic-test-only', role: 'ADMIN' });
  const transport = new SyntheticRecoveryTransport();
  const deps = { srPool: pool, dataPool: pool, transport, budget: { ...defaultSrPlanBudget(), maxModelCallsPerWeek: 100 }, outputDir };
  const newTask = async () => (await createTask(pool, { accountId: account.accountId, subject: '600101', subjectName: '公开合成',
    focus: 'FULL', emphasis: null, horizon: 'MID_TERM', cutoff: '2026-11-01T00:00:00.000Z', idemKey: randomUUID(),
    methodVersion: 'sr-m1', adapterVersion: 'synthetic', planAuthVersion: deps.budget.planAuthVersion })).task;
  const newReport = async () => {
    const task = await newTask(), f = await reportFixture(outputDir, { taskId: task.taskId });
    await insertReport(pool, f.report); await pool.query("update sr_task set status='PARTIAL' where task_id=$1", [task.taskId]); return f.report;
  };
  const serverDeps = { ...deps, poolCache: { stocks: [], etfs: [] }, localAccountId: account.accountId, localCsrf: 'public-synthetic-csrf',
    config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 60000, mode: 'local' as const } };
  return { pool, other, outputDir, accountId: account.accountId, transport, deps, newTask, newReport, serverDeps };
}
async function count(pool: Pool, table: string, where = 'true') { return Number((await pool.query(`select count(*) as n from ${table} where ${where}`)).rows[0].n); }
async function http(t: TestContext, deps: Parameters<typeof createSrServer>[0]) {
  const server = createSrServer(deps); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('PR4 PG: pending two-pool duplicate, stable quota/user message, completed offline readback and explicit new intent', gate, async (t) => {
  const f = await fixture(t), report = await f.newReport();
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((r) => { release = r; }), sent = new Promise<void>((r) => { started = r; });
  f.transport.before = async () => { started(); await hold; };
  const opts = { taskId: report.taskId, reportVersion: 1, question: 'fin 合成依据', questionKind: 'EXPLAIN' as const, requestKey: 'stable-request-1', quotaLimit: 20 };
  const a = askReportQuestion(f.deps, f.accountId, opts); await sent;
  await assert.rejects(askReportQuestion({ ...f.deps, srPool: f.other }, f.accountId, opts), { code: 'REQUEST_PENDING' });
  assert.equal(await count(f.pool, 'sr_request'), 1); assert.equal(await count(f.pool, 'sr_chat_message', "role='USER'"), 1);
  assert.equal((await f.pool.query("select used from sr_quota_usage where kind='MODEL_CALL'")).rows[0].used, 1);
  release(); const answer = await a;
  const offline = { describe: () => { throw new Error('Current transport must not be consulted for saved answer'); }, dispatch: async () => assert.fail('no resend') };
  const lease = await acquireLease(f.other, 'sr', 'another-live-worker');
  const repeated = await askReportQuestion({ ...f.deps, srPool: f.other, transport: offline }, f.accountId, opts);
  assert.equal(repeated.messageId, answer.messageId); assert.equal(f.transport.calls.length, 1); await releaseLease(f.other, lease);
  await assert.rejects(askReportQuestion(f.deps, f.accountId, { ...opts, question: 'changed intent' }), { code: 'REQUEST_INTENT_CONFLICT' });
  delete f.transport.before;
  const explicit = await askReportQuestion(f.deps, f.accountId, { ...opts, requestKey: 'stable-request-2' });
  assert.notEqual(explicit.messageId, answer.messageId); assert.equal(f.transport.calls.length, 2);
  const { requestKey: _key, ...sameUserIntent } = opts;
  assert.equal((await askReportQuestion(f.deps, f.accountId, sameUserIntent)).messageId, explicit.messageId);
  assert.equal(f.transport.calls.length, 2);
});

test('PR4 PG HTTP: UNKNOWN survives full page refresh; default same intent cannot acquire a new key or send', gate, async (t) => {
  const f = await fixture(t), report = await f.newReport(), base = await http(t, f.serverDeps);
  f.transport.before = () => { throw new KernelError('TIMEOUT'); };
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await (await fetch(`${base}/reports/${report.reportId}?v=1`)).text();
    assert.ok(page.includes('继续同内容原请求')); assert.ok(page.includes('明确发起新请求'));
    const key = /name="request_key" value="([^"]+)"/.exec(page)![1]!;
    const response = await fetch(`${base}/reports/${report.reportId}/chat`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: 'public-synthetic-csrf',
        report_version: '1', question: 'fin 解释', request_key: key, intent_mode: 'REUSE' }).toString() });
    assert.equal(response.status, attempt === 0 ? 500 : 409);
  }
  assert.equal(f.transport.calls.length, 1); assert.equal(await count(f.pool, 'sr_request'), 1);
  assert.equal(await count(f.pool, 'sr_call', "state='UNKNOWN'"), 1); assert.equal(await count(f.pool, 'sr_chat_message', "role='ASSISTANT'"), 0);
  await assert.rejects(resumeSrTask(f.pool, f.accountId, report.taskId), { code: 'TASK_RECOVERY_UNBOUND' });
});

test('PR4 PG: answer write failure restores original validated checkpoint without current transport/preflight or a second quota', gate, async (t) => {
  const f = await fixture(t), report = await f.newReport();
  await f.pool.query(`create function fail_answer() returns trigger language plpgsql as $$ begin
    if new.role='ASSISTANT' then raise exception 'SYNTHETIC_ANSWER_WRITE'; end if; return new; end $$;
    create trigger fail_answer before insert on sr_chat_message for each row execute function fail_answer()`);
  const opts = { taskId: report.taskId, reportVersion: 1, question: 'fin 合成', questionKind: 'EXPLAIN' as const, requestKey: 'saved-answer-key', quotaLimit: 10 };
  await assert.rejects(askReportQuestion(f.deps, f.accountId, opts), /SYNTHETIC_ANSWER_WRITE/);
  assert.equal((await f.pool.query('select state from sr_request')).rows[0].state, 'RESULT_READY');
  assert.equal(await count(f.pool, 'sr_call', "state='SUCCEEDED' and response_checkpoint is not null"), 1);
  await f.pool.query('drop trigger fail_answer on sr_chat_message');
  const answer = await askReportQuestion({ ...f.deps, transport: { describe: () => { throw new Error('offline'); }, dispatch: async () => assert.fail('offline') } }, f.accountId, opts);
  assert.ok(answer.callId); assert.equal((await srGetCall(f.pool, answer.callId!))!.state, 'SUCCEEDED');
  assert.equal(f.transport.calls.length, 1); assert.equal(await count(f.pool, 'sr_chat_message', "role='ASSISTANT'"), 1);
  assert.equal((await f.pool.query("select used from sr_quota_usage where kind='MODEL_CALL'")).rows[0].used, 1);
});

test('PR4 PG: intent binds derived input without deriving a new user key; revision concurrency freezes one cutoff/task/quota', gate, async (t) => {
  const f = await fixture(t), report = await f.newReport();
  const chat = { accountId: f.accountId, report, question: 'same text', kind: 'EXPLAIN' as const, input: { material: 1 }, quotaLimit: 10 };
  await beginChatRequest(f.pool, chat);
  await assert.rejects(beginChatRequest(f.other, { ...chat, input: { material: 2 } }), { code: 'REQUEST_INTENT_CONFLICT' });
  assert.equal(await count(f.pool, 'sr_request'), 1);
  const args = { accountId: f.accountId, report, key: 'revision-stable-1', emphasis: 'synthetic', newCutoff: true, quotaLimit: 10,
    methodVersion: 'sr-m1', adapterVersion: 'synthetic', planAuthVersion: f.deps.budget.planAuthVersion };
  const [a, b] = await Promise.all([createRevisionRequest(f.pool, args), createRevisionRequest(f.other, args)]);
  assert.equal(a.task.taskId, b.task.taskId); assert.equal(a.task.cutoff, b.task.cutoff); assert.equal(Number(a.created) + Number(b.created), 1);
  const again = await createRevisionRequest(f.pool, args); assert.equal(again.task.cutoff, a.task.cutoff);
  await assert.rejects(createRevisionRequest(f.pool, { ...args, emphasis: 'changed' }), { code: 'REQUEST_INTENT_CONFLICT' });
  const next = await createRevisionRequest(f.pool, { ...args, key: 'revision-stable-2' }); assert.notEqual(next.task.taskId, a.task.taskId);
  assert.equal((await f.pool.query("select used from sr_quota_usage where kind='REPORT_TASK'")).rows[0].used, 2);
});

test('PR4 PG: per-task cap counts main/CHAT and UNKNOWN sends; a ninth call cannot enter SENT', gate, async (t) => {
  const f = await fixture(t), report = await f.newReport();
  for (let i = 0; i < 8; i++) await askReportQuestion(f.deps, f.accountId, {
    taskId: report.taskId, reportVersion: 1, question: `fin synthetic ${i}`, questionKind: 'EXPLAIN', requestKey: `budget-chat-${i}` });
  await assert.rejects(askReportQuestion(f.deps, f.accountId, { taskId: report.taskId, reportVersion: 1, question: 'fin ninth', questionKind: 'EXPLAIN', requestKey: 'budget-chat-9' }), { code: 'MODEL_CALL_BUDGET_EXCEEDED' });
  assert.equal(f.transport.calls.length, 8); assert.equal(await count(f.pool, 'sr_call', 'sent_at is not null'), 8);
  assert.equal(await count(f.pool, 'sr_call', "state='PREPARED' and sent_at is null"), 1);
});

test('PR4 PG: partial skeleton, pre-PLAN evidence freeze, original-task HTTP resume and worker recovery without repeated PLAN', gate, async (t) => {
  const f = await fixture(t), task = await f.newTask(), initial = syntheticInitialEvidence(task.taskId);
  await f.pool.query('update sr_task set initial_evidence=$2::jsonb,initial_evidence_hash=$3 where task_id=$1', [task.taskId, JSON.stringify(initial), canonicalSha256(initial)]);
  const existingStep = randomUUID();
  await f.pool.query("insert into sr_step(step_id,task_id,step_kind,sequence,status) values($1,$2,'PLAN',1,'PENDING')", [existingStep, task.taskId]);
  const work = join(f.outputDir, 'tasks', task.taskId); await mkdir(work, { recursive: true }); await writeFile(join(work, 'steps'), 'SYNTHETIC_EISDIR');
  const failed = await runSrTask(f.deps, task.taskId); assert.equal(failed.task.status, 'FAILED'); assert.match(failed.task.error!.message, /EEXIST|ENOTDIR/);
  assert.equal(f.transport.calls.length, 1); assert.equal((await listSteps(f.pool, task.taskId)).length, 11);
  assert.equal((await listSteps(f.pool, task.taskId))[0]!.stepId, existingStep);
  await assert.rejects(f.pool.query('update sr_task set cutoff=clock_timestamp() where task_id=$1', [task.taskId]), /SR_TASK_INPUT_IMMUTABLE/);
  await rm(join(work, 'steps')); await mkdir(join(work, 'steps'));
  const base = await http(t, f.serverDeps);
  const page = await (await fetch(`${base}/tasks/${task.taskId}`)).text(); assert.ok(page.includes('核验原检查点并继续此任务'));
  const response = await fetch(`${base}/tasks/${task.taskId}/resume`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=public-synthetic-csrf' });
  assert.equal(response.status, 302);
  const worker = await startSrWorker(f.serverDeps);
  try {
    const until = Date.now() + 10000;
    while (Date.now() < until && ['QUEUED','RUNNING'].includes((await getTask(f.pool, task.taskId))!.status)) await new Promise((r) => setTimeout(r, 50));
    const done = (await getTask(f.pool, task.taskId))!;
    assert.ok(['COMPLETED','PARTIAL'].includes(done.status), JSON.stringify(done.error));
    assert.equal(f.transport.calls.filter((x) => x.kind === 'PLAN').length, 1); assert.equal(f.transport.calls.length, 6);
    const planInput = f.transport.calls[0]!.input as { coverageSummary: unknown };
    assert.ok(JSON.stringify(planInput.coverageSummary).includes('TEST_ONLY'));
    assert.equal((await listReportVersions(f.pool, task.taskId)).length, 1);
  } finally { await worker.stop(); }
});

test('PR4 PG: unclaimed legacy/frozen task and RECONCILING are never rewritten FAILED by claim errors', gate, async (t) => {
  const f = await fixture(t);
  for (const frozen of [false, true]) {
    const task = await f.newTask();
    await f.pool.query("update sr_task set status='RUNNING',emphasis=$2 where task_id=$1", [task.taskId, frozen ? 'FROZEN_STRATEGY_REVIEW:synthetic' : null]);
    await assert.rejects(runSrTask(f.deps, task.taskId), { code: 'TASK_RECOVERY_UNBOUND' });
    assert.equal((await getTask(f.pool, task.taskId))!.status, 'RUNNING');
  }
  const task = await f.newTask(); await f.pool.query("update sr_recovery_state set lifecycle='RECONCILING'");
  await assert.rejects(runSrTask(f.deps, task.taskId), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  assert.equal((await getTask(f.pool, task.taskId))!.status, 'QUEUED'); assert.equal(f.transport.calls.length, 0);
});
