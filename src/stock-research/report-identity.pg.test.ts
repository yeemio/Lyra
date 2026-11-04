/** 实际 PostgreSQL 门。仅显式 LYRA_REPAIR_TEST_PG + 随机隔离 schema；无业务库回退。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createAccount } from './accounts.js';
import { defaultSrPlanBudget, type SrModelTransport } from './contracts.js';
import { askReportQuestion, runSrTask } from './engine.js';
import { reportFixture } from './report-identity-test-helper.js';
import { syntheticInitialEvidence, SyntheticRecoveryTransport } from './engine-recovery-test-helper.js';
import { canonicalSha256 } from '../canonical.js';
import { createSrServer } from './server.js';
import { createTask, getReportById, getReportByTaskAndVersion, insertAssembledReport, insertReport, listReportVersions, listSteps, publishNewVersion } from './store.js';
import type { ChatInput } from './transport.js';

const url = process.env.LYRA_REPAIR_TEST_PG;
test('PR5 actual isolated PG: identity, versions, immutable recovery and delivered chat', { skip: !url }, async (t) => {
  const target = new URL(url!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), '仅显式隔离本机测试 PostgreSQL');
  const schema = `repair_pr5_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  const other = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  const outputDir = await mkdtemp(join(tmpdir(), 'pr5-pg-'));
  const delivered: ChatInput[] = [];
  let corrupt: 'tableId' | 'tableHash' | 'version' | 'contentHash' | null = null;
  const transport: SrModelTransport = {
    describe: () => ({ provider: 'synthetic-pr5', simulated: true, modelId: 'no-external-call' }),
    dispatch: async (kind, _ctx, payload) => {
      assert.equal(kind, 'CHAT_ANSWER', '本门禁止其他模型路径');
      const input = payload as ChatInput; delivered.push(input);
      return { answer: `合成回答 v${input.reportIdentity.version}`, reportIdentity: { ...input.reportIdentity,
        ...(corrupt === 'version' ? { version: input.reportIdentity.version + 1 } : {}),
        ...(corrupt === 'contentHash' ? { contentHash: '0'.repeat(64) } : {}) },
        citations: input.tables.map((table) => ({ label: table.title, tableId: corrupt === 'tableId' ? 'NOT_DELIVERED' : table.tableId,
          tableHash: corrupt === 'tableHash' ? '0'.repeat(64) : table.tableHash })),
        missingData: [], suggestedAction: null };
    },
  };
  let created = false;
  const deps = { srPool: pool, dataPool: pool, transport, outputDir, budget: { ...defaultSrPlanBudget(), maxModelCallsPerTask: 30 } };
  try {
    await applySchema(admin, schema, srMigrationSqlUrl); created = true;
    await applySchema(admin, schema, srMigrationSqlUrl);
    const account = await createAccount(pool, { username: 'synthetic_pr5', password: 'synthetic-password-only', role: 'ADMIN' });
    const newTask = async () => (await createTask(pool, {
      accountId: account.accountId, subject: '600101', subjectName: '公开合成公司', focus: 'FULL', emphasis: null, horizon: 'MID_TERM',
      cutoff: '2026-11-01T00:00:00.000Z', idemKey: randomUUID(), methodVersion: 'sr-m1', adapterVersion: 'synthetic', planAuthVersion: 'sr-auth-1',
    })).task;
    const task = await newTask();
    const first = await reportFixture(outputDir, { taskId: task.taskId, label: 'FIRST-VERSION' });
    const second = await reportFixture(outputDir, { taskId: task.taskId, reportId: first.report.reportId, version: 2, label: 'SECOND-VERSION' });
    await t.test('DB 往返正文 hash 与时间一致；新版不修改旧版；改单字段拒绝', async () => {
      await insertReport(pool, first.report);
      await publishNewVersion(pool, second.report);
      assert.deepEqual(await getReportByTaskAndVersion(pool, task.taskId, 1), first.report);
      assert.equal((await getReportById(pool, first.report.reportId, account.accountId))!.version, 2);
      assert.equal((await getReportById(pool, first.report.reportId, account.accountId, 1))!.contentHash, first.report.contentHash);
      assert.equal(await getReportById(pool, first.report.reportId, account.accountId, 99), null);
      await pool.query('update sr_report set subject_name = $3 where task_id = $1 and version = $2', [task.taskId, 1, '被改字段']);
      await assert.rejects(getReportByTaskAndVersion(pool, task.taskId, 1), { code: 'SR_REPORT_HASH_MISMATCH' });
      await pool.query('update sr_report set subject_name = $3 where task_id = $1 and version = $2', [task.taskId, 1, first.report.subjectName]);
      assert.equal((await getReportByTaskAndVersion(pool, task.taskId, 1))!.contentHash, first.report.contentHash);
    });
    await t.test('两池并发组装一个版本；同一步骤不同正文拒绝且不新增行', async () => {
      const separate = await newTask();
      const f = await reportFixture(outputDir, { taskId: separate.taskId });
      await pool.query("insert into sr_step(step_id,task_id,step_kind,sequence,status) values($1,$2,'ASSEMBLE',11,'PENDING')", [f.assembly.stepId, f.report.taskId]);
      const results = await Promise.all([insertAssembledReport(pool, f.report), insertAssembledReport(other, { ...f.report, reportId: randomUUID(), createdAt: new Date().toISOString() })]);
      assert.equal(results[0]!.contentHash, results[1]!.contentHash);
      assert.equal((await listReportVersions(pool, separate.taskId)).length, 1);
      await assert.rejects(insertAssembledReport(pool, { ...f.report, sections: [] }), { code: 'SR_REPORT_CONFLICT' });
      assert.equal((await listReportVersions(pool, separate.taskId)).length, 1);
    });
    await t.test('插入报告后写工作文件失败：原 ASSEMBLE 重入不增版；覆盖 A/J/QA 副本不改恢复', async () => {
      const recoveryTask = await newTask();
      const pack = syntheticInitialEvidence(recoveryTask.taskId, recoveryTask.subject, recoveryTask.cutoff);
      await pool.query('update sr_task set initial_evidence=$2::jsonb,initial_evidence_hash=$3 where task_id=$1',
        [recoveryTask.taskId, JSON.stringify(pack), canonicalSha256(pack)]);
      const recoveryTransport = new SyntheticRecoveryTransport(), recoveryDeps = { ...deps, transport: recoveryTransport };
      const work = join(outputDir, 'tasks', recoveryTask.taskId);
      await mkdir(join(work, 'report.md'), { recursive: true }); // 实际文件系统 EISDIR，发生在 DB insert 之后
      const failed = await runSrTask(recoveryDeps, recoveryTask.taskId);
      assert.equal(failed.task.status, 'FAILED');
      assert.match(failed.task.error!.message, /EISDIR/);
      const saved = (await listReportVersions(pool, recoveryTask.taskId))[0]!;
      assert.ok(saved);
      assert.equal(recoveryTransport.calls.length, 6, '原步骤通过正常发送与检查点入口');
      const savedSteps = await listSteps(pool, recoveryTask.taskId);
      await rm(join(work, 'report.md'), { recursive: true });
      await mkdir(join(work, 'steps'), { recursive: true });
      for (const step of savedSteps) await writeFile(join(work, 'steps', `${String(step.sequence).padStart(2, '0')}-${step.stepKind}${step.sectionKey ? '-' + step.sectionKey : ''}.json`), '{"forged":true}');
      await writeFile(join(work, 'evidence.json'), '{"forged":true}');
      const restored = await runSrTask(recoveryDeps, recoveryTask.taskId);
      assert.ok(['COMPLETED', 'PARTIAL'].includes(restored.task.status), JSON.stringify(restored.task.error));
      assert.equal(restored.report!.contentHash, saved.contentHash);
      assert.equal((await listReportVersions(pool, recoveryTask.taskId)).length, 1);
      assert.equal(Number((await pool.query('select count(*) from sr_call where task_id=$1', [recoveryTask.taskId])).rows[0].count), 6, '原六次调用未新增');
      assert.equal(recoveryTransport.calls.length, 6, '恢复零模型重发');
      await assert.rejects(pool.query('update sr_step set output_artifact=$2::jsonb where step_id=$1', [savedSteps[0]!.stepId, JSON.stringify({ sha256: '0'.repeat(64), bytes: 1 })]), /SR_ARTIFACT_IMMUTABLE/);
      const hash = savedSteps.find((s) => s.stepKind === 'JUDGE')!.outputArtifact!.sha256;
      await rm(join(outputDir, 'artifacts', hash.slice(0, 2), hash));
      await assert.rejects(runSrTask(recoveryDeps, recoveryTask.taskId), { code: 'ARTIFACT_MISSING' });
    });
    await t.test('HTTP HTML/PDF/追问携带所选版本；错误版本不回退；线程不因多版本标量查询失败', async () => {
      const server = createSrServer({ ...deps, poolCache: { stocks: [], etfs: [] }, localAccountId: account.accountId, localCsrf: 'synthetic-csrf',
        config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 60_000, mode: 'local' } });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const work = join(outputDir, 'tasks', task.taskId);
        await mkdir(work, { recursive: true }); await writeFile(join(work, 'evidence.json'), JSON.stringify(second.pack));
        for (const [version, label, wrong] of [[1, 'FIRST-VERSION', 'SECOND-VERSION'], [2, 'SECOND-VERSION', 'FIRST-VERSION']] as const) {
          const htmlResponse = await fetch(`${base}/reports/${first.report.reportId}?v=${version}`);
          assert.equal(htmlResponse.status, 200);
          const html = await htmlResponse.text();
          assert.ok(html.includes(label) && !html.includes(wrong));
          assert.ok(html.includes(`name="report_version" value="${version}"`));
          const pdfResponse = await fetch(`${base}/reports/${first.report.reportId}/pdf?v=${version}`);
          assert.equal(pdfResponse.status, 200);
          const pdf = Buffer.from(await pdfResponse.arrayBuffer());
          const text = execFileSync('pdftotext', ['-', '-'], { input: pdf, encoding: 'utf8' });
          assert.ok(text.includes(label) && !text.includes(wrong));
          const result = await fetch(`${base}/reports/${first.report.reportId}/chat`, { method: 'POST', redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ _csrf: 'synthetic-csrf', report_version: String(version), question: 'fin official fixture 依据' }).toString() });
          assert.equal(result.status, 302);
          assert.equal(delivered.at(-1)!.reportIdentity.version, version);
        }
        assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=99`)).status, 404);
        assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=bad`)).status, 400);
        for (const version of ['', '2147483648']) {
          assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=${version}`)).status, 400);
          assert.equal((await fetch(`${base}/reports/${first.report.reportId}/pdf?v=${version}`)).status, 400);
        }
        const latest = await (await fetch(`${base}/reports/${first.report.reportId}`)).text();
        assert.ok(latest.includes('SECOND-VERSION'));
        const old = await (await fetch(`${base}/reports/${first.report.reportId}?v=1`)).text();
        assert.ok(old.includes('合成回答 v1') && !old.includes('合成回答 v2'));
        await pool.query('update sr_report set subject_name=$2 where task_id=$1 and version=1', [task.taskId, '旧版本损坏']);
        assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=1`)).status, 500);
        assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=2`)).status, 200);
        assert.equal((await fetch(`${base}/reports/${first.report.reportId}/pdf?v=2`)).status, 200);
        const taskPage = await fetch(`${base}/tasks/${task.taskId}`);
        assert.equal(taskPage.status, 200); assert.ok((await taskPage.text()).includes('材料不可验证'));
        const next = await reportFixture(outputDir, { taskId: task.taskId, reportId: first.report.reportId, version: 3, label: 'THIRD-VERSION' });
        await pool.query("insert into sr_step(step_id,task_id,step_kind,sequence,status) values($1,$2,'ASSEMBLE',11,'PENDING')", [next.assembly.stepId, task.taskId]);
        assert.equal((await insertAssembledReport(pool, next.report)).version, 3, '旧坏版本不阻断独立新组装');
        await pool.query('update sr_report set subject_name=$2 where task_id=$1 and version=1', [task.taskId, first.report.subjectName]);
        const savedMessage = (await pool.query(`select m.* from sr_chat_message m join sr_chat_thread t on t.thread_id=m.thread_id
          where t.report_id=$1 and t.report_version=1 and m.role='ASSISTANT'`, [first.report.reportId])).rows[0];
        const sentBefore = Number((await pool.query('select count(*) from sr_call')).rows[0].count);
        for (const field of ['content', 'citations', 'call_id'] as const) {
          const value = field === 'content' ? '被覆盖回答' : field === 'citations' ? JSON.stringify([{ label: 'NOT_DELIVERED', locator: { kind: 'COMPUTED', tableId: 'NOT_DELIVERED' } }]) : null;
          await pool.query(`update sr_chat_message set ${field}=$2${field === 'citations' ? '::jsonb' : ''} where message_id=$1`, [savedMessage.message_id, value]);
          assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=1`)).status, 500);
          assert.equal((await fetch(`${base}/reports/${first.report.reportId}?v=2`)).status, 200);
          await assert.rejects(askReportQuestion(deps, account.accountId, { taskId: task.taskId, reportVersion: 1, question: 'fin official fixture 依据', questionKind: 'EXPLAIN' }));
          await pool.query(`update sr_chat_message set ${field}=$2${field === 'citations' ? '::jsonb' : ''} where message_id=$1`, [savedMessage.message_id, field === 'citations' ? JSON.stringify(savedMessage[field]) : savedMessage[field]]);
        }
        assert.equal(Number((await pool.query('select count(*) from sr_call')).rows[0].count), sentBefore, '损坏读回零新发送');
      } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    });
    await t.test('追问真实定位类型与成功调用收据绑定；未送达引用拒绝且不落助手答案', async () => {
      const messages = (await pool.query(`select m.*, c.state, c.task_id from sr_chat_message m join sr_call c on c.call_id=m.call_id where m.role='ASSISTANT'`)).rows;
      assert.equal(messages.length, 2);
      for (const message of messages) {
        assert.equal(message.state, 'SUCCEEDED'); assert.equal(message.task_id, task.taskId);
        assert.deepEqual(new Set(message.citations.map((c: { locator: { kind: string } }) => c.locator.kind)), new Set(['FACT', 'FILE', 'COMPUTED']));
        assert.ok(message.citations.every((c: { delivery: { contentHash: string } }) => [first.report.contentHash, second.report.contentHash].includes(c.delivery.contentHash)));
      }
      for (const [mode, reason] of [['tableId', /未送达表/], ['tableHash', /表哈希不符/], ['version', /错误报告版本/], ['contentHash', /错误报告版本/]] as const) {
        corrupt = mode;
        await assert.rejects(askReportQuestion(deps, account.accountId, { taskId: task.taskId, reportVersion: 1, question: `fin official fixture 错引 ${mode}`, questionKind: 'EXPLAIN' }), reason);
        assert.equal(Number((await pool.query("select count(*) from sr_chat_message where role='ASSISTANT'")).rows[0].count), 2);
      }
    });
  } finally {
    await pool.end(); await other.end();
    if (created) await dropSchema(admin, schema);
    await admin.end(); await rm(outputDir, { recursive: true, force: true });
  }
});
