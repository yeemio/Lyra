import { researchJInputHash } from './validation.js';
import { researchMaterial } from './requests.js';
/**
 * P2 整合测试（总控整合波）：真实数据全链——
 * 组装器（真实封存材料）→ SimulatedTransport → A → 程序清单 → J → 结论对象落库 → 报告读回。
 * 全程公开 API（EK-10.4）；读走生产库 public（真实事实），执行与结论落隔离 schema。
 * 向 public.seal_manifest 追加真实封存（W26 幂等后：仅当材料真实变化才新增行，复用不新增）（不可变数据，与 W11 样本同一模式，如实申明）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../db/pool.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { ArtifactStore } from '../artifacts/store.js';
import { assembleResearchInput, validateResearchInputPackage } from './inputs.js';
import { deriveChecklist, rederiveChecklistHash } from './checklist.js';
import { SimulatedTransport, selectTransport } from '../kernel/transport.js';
import { runModelCall } from '../kernel/executor.js';
import { findPermitByBusinessKey } from '../kernel/permit.js';
import { acquireExecutorLock, releaseExecutorLock } from '../kernel/lock.js';
import { persistConclusion, readConclusion } from '../db/conclusion.js';
import { buildReportView, renderReportText } from './report.js';
import { canonicalSha256 } from '../canonical.js';
import type { ModelCallContract, PlanAuthBudget, ResearchBusinessKey, AOutput, JOutput } from '../contracts.js';

const HOLDER = `p2-int-${randomUUID()}`;
const schema = `p2_int_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let isolated: import('pg').Pool;
// 生产原件库：封存引用的事实原件都在 data/artifacts（R24 冻结根）；测试产生的包原件入生产 CAS（不可变，与 W11 样本同模式）。
const store = new ArtifactStore('data/artifacts');

test.before(async () => {
  await applySchema(admin, schema);
  isolated = createPool({ schema });
  await acquireExecutorLock(isolated, HOLDER);
});

test.after(async () => {
  try { await releaseExecutorLock(isolated, HOLDER); } catch { /* 已释放 */ }
  await isolated?.end().catch(() => {});
  await dropSchema(admin, schema);
  await admin.end();
});

const BUDGET: PlanAuthBudget = {
  planAuthVersion: 'pa-p2-int-1',
  maxModelCallsPerWeek: 10,
  maxInputBytes: 5_000_000,
  maxInFlight: 2,
};
const VERSIONS = { methodVersion: 'method@p2-v1', adapterVersion: 'data@p1', planAuthVersion: BUDGET.planAuthVersion };

test('P2 全链：真实材料组装 → 模拟 A/J → 清单 → 结论 → 报告（个股）', async () => {
  const subject = '600519';
  const cutoff = '2022-06-30T07:00:00.000Z';
  const businessKey: ResearchBusinessKey = { subjectKind: 'STOCK', subject, researchKind: 'WEEKLY', cutoff };

  // 1. 组装（真实库读取；封存追加 public，与 W11 样本同模式）
  const assembled = await assembleResearchInput(admin, store, {
    subjectKind: 'STOCK', subject, cutoff,
    budget: { l0Bytes: 20_000, l1Bytes: 140_000, l2Bytes: 160_000, totalBytes: 300_000 },
    versions: VERSIONS,
  });
  assert.ok(assembled.inputBytes > 0);
  const validation = await validateResearchInputPackage(admin, store, assembled.package);
  assert.equal(validation.ok, true, `样本包校验：${JSON.stringify(validation).slice(0, 300)}`);

  // 2. 模拟 A（经 transport，走 permit）
  const transport = selectTransport({ provider: 'simulated' });
  assert.ok(transport instanceof SimulatedTransport);
  assert.equal(transport.describe().simulated, true);
  const material = researchMaterial(assembled.package);
  const aInput = { inputHash: assembled.inputHash, subjectKind: 'STOCK' as const, subject, material };
  const contractA: ModelCallContract = {
    businessKey, stage: 'A',
    inputHash: assembled.inputHash, inputBytes: assembled.inputBytes,
    methodVersion: VERSIONS.methodVersion, planAuthVersion: VERSIONS.planAuthVersion,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  const a = await runModelCall<AOutput>(isolated, {
    contract: contractA, budget: BUDGET,
    modelFn: async (ctx) => (await transport.dispatch(ctx.contract, aInput)) as AOutput,
    simulated: true, holderId: HOLDER,
  });
  assert.equal(a.permit.state, 'SUCCEEDED');
  assert.equal(a.permit.simulated, true);
  assert.equal(a.output.stage, 'A');
  assert.ok(a.output.decisiveLinks.length >= 2);

  // 3. 程序清单（可机械重导出）
  const manifestHash = assembled.package.seals[0]!.manifestHash;
  const checklist = deriveChecklist(a.output, manifestHash);
  assert.equal(checklist.mandatoryJ, true);
  assert.equal(rederiveChecklistHash(a.output, manifestHash), checklist.checklistHash);

  // 4. 模拟 J
  const jInputHash = researchJInputHash(assembled.package, a.output, checklist);
  const contractJ: ModelCallContract = {
    businessKey, stage: 'J',
    inputHash: jInputHash, inputBytes: assembled.inputBytes,
    methodVersion: VERSIONS.methodVersion, planAuthVersion: VERSIONS.planAuthVersion,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  const j = await runModelCall<JOutput>(isolated, {
    contract: contractJ, budget: BUDGET,
    modelFn: async (ctx) => (await transport.dispatch(ctx.contract, { inputHash: jInputHash, subjectKind: 'STOCK' as const, aOutput: a.output, checklist })) as JOutput,
    simulated: true, holderId: HOLDER,
  });
  assert.equal(j.permit.state, 'SUCCEEDED');
  assert.equal(j.output.verdicts.length, checklist.items.length, 'J 恰好逐项裁决');

  // 5. 结论对象（隔离 schema 落库 + 读回）
  const conclusion = await persistConclusion(isolated, {
    businessKey,
    methodVersion: VERSIONS.methodVersion, adapterVersion: VERSIONS.adapterVersion, planAuthVersion: VERSIONS.planAuthVersion,
    aOutput: a.output, checklist, jOutput: j.output,
    manifest: assembled.package.seals[0]!,
    researchInput: assembled.package,
    inheritance: null, changeReason: j.output.changedFromA ? j.output.changeReason : null,
  });
  assert.equal(conclusion.disposition, j.output.finalDisposition);
  assert.equal(conclusion.adoption, false);
  const readBack = await readConclusion(isolated, conclusion.conclusionId);
  assert.equal(readBack?.conclusionHash, conclusion.conclusionHash);

  // 6. 报告读回（视图 + 渲染 + 合规行）
  const view = buildReportView(conclusion, assembled.package, a.output, checklist, j.output);
  const text = renderReportText(view);
  assert.ok(text.includes('个人研究记录，非投资建议'), '末行合规标注');
  assert.ok(text.includes(subject));
  assert.ok(assembled.package.dimensions.length > 0, 'coverage（dimensions）存在');

  // 7. send-once：同业务键重提交被拒（隔离 schema 的 permit 表；错误码在 code 字段）
  await assert.rejects(
    () => runModelCall<AOutput>(isolated, {
      contract: contractA, budget: BUDGET,
      modelFn: async (ctx) => (await transport.dispatch(ctx.contract, aInput)) as AOutput,
      simulated: true, holderId: HOLDER,
    }),
    (err: unknown) => (err as { code?: string }).code === 'BUSINESS_KEY_ALREADY_SENT',
    'send-once 拒绝',
  );
  const permits = await isolated.query(`select count(*)::int as n from exec_permit where sent_at is not null`);
  assert.equal(permits.rows[0]!.n, 2, '全链恰好两次模型发送（A+J）');
});

test('P2 全链：宽基标的（ETF 七维）', async () => {
  const subject = '510300';
  const cutoff = '2022-06-30T07:00:00.000Z';
  const businessKey: ResearchBusinessKey = { subjectKind: 'BROAD_ETF', subject, researchKind: 'WEEKLY', cutoff };
  const assembled = await assembleResearchInput(admin, store, {
    subjectKind: 'BROAD_ETF', subject, cutoff,
    budget: { l0Bytes: 20_000, l1Bytes: 140_000, l2Bytes: 160_000, totalBytes: 300_000 },
    versions: VERSIONS,
  });
  const v = await validateResearchInputPackage(admin, store, assembled.package);
  assert.equal(v.ok, true);
  const transport = selectTransport();
  const material = researchMaterial(assembled.package);
  const aInput = { inputHash: assembled.inputHash, subjectKind: 'BROAD_ETF' as const, subject, material };
  const contract: ModelCallContract = {
    businessKey, stage: 'A', inputHash: assembled.inputHash, inputBytes: assembled.inputBytes,
    methodVersion: VERSIONS.methodVersion, planAuthVersion: VERSIONS.planAuthVersion,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  const a = await runModelCall<AOutput>(isolated, {
    contract, budget: BUDGET, modelFn: async (ctx) => (await transport.dispatch(ctx.contract, aInput)) as AOutput,
    simulated: true, holderId: HOLDER,
  });
  const checklist = deriveChecklist(a.output, assembled.package.seals[0]!.manifestHash);
  const jInputHash = researchJInputHash(assembled.package, a.output, checklist);
  const j = await runModelCall<JOutput>(isolated, {
    contract: { ...contract, stage: 'J', inputHash: jInputHash }, budget: BUDGET,
    modelFn: async (ctx) => (await transport.dispatch(ctx.contract, { inputHash: jInputHash, subjectKind: 'BROAD_ETF' as const, aOutput: a.output, checklist })) as JOutput,
    simulated: true, holderId: HOLDER,
  });
  const conclusion = await persistConclusion(isolated, {
    businessKey,
    methodVersion: VERSIONS.methodVersion, adapterVersion: VERSIONS.adapterVersion, planAuthVersion: VERSIONS.planAuthVersion,
    aOutput: a.output, checklist, jOutput: j.output,
    manifest: assembled.package.seals[0]!,
    researchInput: assembled.package, inheritance: null,
    changeReason: j.output.changedFromA ? j.output.changeReason : null,
  });
  // 宽基选项空间：结论只允许 UP/DOWN/ABSTAIN
  assert.ok(['RESEARCH_UP', 'RESEARCH_DOWN', 'ABSTAIN'].includes(conclusion.disposition), `宽基 disposition 越界: ${conclusion.disposition}`);
  const jPermit = await findPermitByBusinessKey(isolated, { businessKey, stage: 'J' });
  assert.equal(jPermit?.state, 'SUCCEEDED');
});
