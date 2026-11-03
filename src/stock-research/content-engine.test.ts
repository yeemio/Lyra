/** Full product path, simulated transport, write-isolated sr schema, public facts read-only. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, pgEnv } from '../db/pool.js';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createAccount } from './accounts.js';
import { createTask } from './store.js';
import { runSrTask } from './engine.js';
import { defaultSrPlanBudget, type SrModelStepKind, type SrModelTransport, type EvidencePack, type ComputeResult } from './contracts.js';
import { SimSrTransport, type PlanInput, type AnalyzeInput, type JInput, type AFinalInput } from './transport.js';
import { renderReportPage } from './render.js';

it('茅台问题链实际引擎输入与受限报告：离线模拟、不调用真实模型', async () => {
  const schema = `sr_content_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = createPool();
  const srPool = createPool({ schema });
  const dataPool = new Pool({ ...pgEnv(), options: '-c default_transaction_read_only=on' });
  const outputDir = resolve('delivery/CODEX-RESEARCH-CONTENT-20261028/offline-engine');
  let created = false;
  try {
    await applySchema(admin, schema, srMigrationSqlUrl); created = true;
    const readonly = await dataPool.query('show default_transaction_read_only');
    assert.equal(readonly.rows[0]!.default_transaction_read_only, 'on');
    const account = await createAccount(srPool, { username: 'offline_content', password: randomUUID(), role: 'USER' });
    const { task } = await createTask(srPool, { accountId: account.accountId, subject: '600519', subjectName: '贵州茅台', focus: 'BUSINESS', horizon: 'LONG_TERM', emphasis: '渠道/产品结构、销量与实现均价如何影响收入利润；现金流是否支持回款改善？', cutoff: '2026-10-28T06:40:00.000Z', idemKey: randomUUID(), methodVersion: 'sr-m1', adapterVersion: 'sr-content-offline-20261028', planAuthVersion: 'sr-auth-1' });
    const seen: { step: SrModelStepKind; payload: unknown }[] = [];
    const sim = new SimSrTransport();
    const transport: SrModelTransport = { describe: () => sim.describe(), async dispatch(step, ctx, payload) { seen.push({ step, payload }); return sim.dispatch(step, ctx, payload); } };
    const deps = { dataPool, srPool, transport, budget: defaultSrPlanBudget(), outputDir };
    const result = await runSrTask(deps, task.taskId);
    assert.ok(result.report, JSON.stringify(result.task.error));
    assert.equal(result.report.generatedBy, 'PRODUCT_SIMULATED');
    assert.equal(result.task.status, 'PARTIAL');
    assert.equal(result.report.status, 'PUBLISHED_RESTRICTED');
    const plan = seen.find((s) => s.step === 'PLAN')!.payload as PlanInput;
    assert.ok(Object.keys(plan.coverageSummary).length > 0);
    const analyses = seen.filter((s) => s.step === 'ANALYZE').map((s) => s.payload as AnalyzeInput);
    assert.equal(analyses.length, 3);
    for (const a of analyses) {
      assert.equal(a.researchContext!.horizon, 'LONG_TERM');
      assert.ok(a.tables.some((t) => t.tableId === 'report-excerpts' && t.rows.some((r) => String(r[1]).includes('成员单位存款'))));
      assert.ok(a.tables.some((t) => t.tableId === 'operating-scenarios' && t.rows.length === 3));
    }
    const final = seen.find((s) => s.step === 'A_FINAL')!.payload as AFinalInput;
    assert.ok(final.evidenceBundle!.some((t) => t.tableId === 'official-financials'));
    const judge = seen.find((s) => s.step === 'JUDGE')!.payload as JInput;
    for (const id of ['research-questions', 'operating-segments', 'report-excerpts', 'official-financials', 'operating-scenarios']) assert.ok(judge.evidenceBundle.some((t) => t.tableId === id), `J缺少${id}`);
    assert.ok(result.report.gate!.decisionBearingUnresolved.some((x) => x.includes('终端')));
    const dir = join(outputDir, 'tasks', task.taskId);
    const pack = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8')) as EvidencePack;
    const computed = JSON.parse(await readFile(join(dir, 'computed.json'), 'utf8')) as ComputeResult;
    const tablesById = Object.fromEntries([...pack.tables, ...computed.tables].map((t) => [t.tableId, { ...t, note: 'formula' in t ? `${t.unitNote}；${t.formula}` : t.unitNote }]));
    const html = renderReportPage({ report: result.report, tablesById, versions: [result.report], messages: [], csrf: 'offline-not-a-session' });
    assert.ok(html.includes('成员单位存款') && html.includes('82320067101.68'));
    assert.ok(html.includes('PRODUCT_SIMULATED') || html.includes('模拟'));
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'REPORT.html'), html);
    await writeFile(join(outputDir, 'report.json'), JSON.stringify(result.report, null, 2));
    await writeFile(join(outputDir, 'actual-model-inputs.json'), JSON.stringify(seen, null, 2));
    const calls = await srPool.query('select state, simulated, provider, model_id from sr_call');
    assert.equal(calls.rows.length, 6);
    assert.ok(calls.rows.every((c) => c.simulated && c.state === 'SUCCEEDED'));
    const again = await runSrTask(deps, task.taskId);
    assert.equal(seen.length, 6, '同任务重放零新增 dispatch');
    assert.equal(again.report!.contentHash, result.report.contentHash);
    await writeFile(join(outputDir, 'receipt.json'), JSON.stringify({ label: 'OFFLINE_SIMULATION_ONLY', taskId: task.taskId, temporarySrSchema: schema, dataPoolReadOnly: true, status: result.task.status, reportStatus: result.report.status, reportHash: result.report.contentHash, calls: calls.rows, replayNewDispatches: 0, publicBusinessWrites: 0, realModelCalls: 0 }, null, 2));
  } finally {
    await srPool.end(); await dataPool.end();
    if (created) await dropSchema(admin, schema);
    await admin.end();
  }
});
