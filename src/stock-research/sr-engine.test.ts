/**
 * sr 引擎集成测试（R31）。覆盖 TASK-PACKAGE §8.2 决策改变型矩阵的引擎侧：
 * - 模拟链全流程 → 报告十章 + 生成身份 + 调用账（5 次模型调用，全部 simulated）
 * - 重放零新发（send-once）；中断恢复只续未完成步骤
 * - 已发送后失败 → 有记录的新步骤重试（不悄悄换 ID）
 * - UNKNOWN 不自动重发；退役 + 恢复确认后才可新步骤重试
 * - 报告版本不可变；同标的新任务是独立报告（旧报告不被改写）
 * - 证据截点纪律（定位不晚于截点）
 *
 * 运行前提：真实 pg（127.0.0.1:5433，public 只读事实面）+ 隔离 sr schema。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { KernelError } from '../contracts.js';
import { createAccount } from './accounts.js';
import { SR_OUTPUT_DIR, defaultSrPlanBudget, type SrModelTransport } from './contracts.js';
import { SimSrTransport, RealSrTransport, realTransportConfigFromEnv } from './transport.js';
import { askReportQuestion, runSrTask } from './engine.js';
import {
  createTask,
  getReportByTaskAndVersion,
  listReportVersions,
  srBootRecovery,
  srConfirmRecovery,
  srFindCallByStep,
  srListUnclosedCalls,
  srRetireUnknown,
} from './store.js';

const schema = `sr_t_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
let admin: Pool;
let srPool: Pool;
let dataPool: Pool;
let outDir: string;
let accountId: string;

before(async () => {
  admin = createPool();
  await applySchema(admin, schema, srMigrationSqlUrl);
  srPool = createPool({ schema });
  dataPool = createPool(); // public 只读
  outDir = await mkdtemp(join(tmpdir(), 'sr-engine-'));
  const acc = await createAccount(srPool, {
    username: `tester_${Date.now().toString(36)}`,
    password: 'test-password-8',
    role: 'USER',
  });
  accountId = acc.accountId;
});

after(async () => {
  await srPool.end().catch(() => undefined);
  await dataPool.end().catch(() => undefined);
  await dropSchema(admin, schema);
  await admin.end().catch(() => undefined);
});

interface Deps {
  srPool: Pool;
  dataPool: Pool;
  transport: SrModelTransport;
  budget: ReturnType<typeof defaultSrPlanBudget>;
  outputDir: string;
}

function depsWith(transport: SrModelTransport): Deps {
  return { srPool, dataPool, transport, budget: defaultSrPlanBudget(), outputDir: outDir };
}

async function newTask(subject: string, cutoff: string, emphasis: string | null = null) {
  const r = await createTask(srPool, {
    accountId,
    subject,
    subjectName: subject,
    focus: 'FULL',
    emphasis,
    horizon: 'MID_TERM',
    cutoff,
    idemKey: randomUUID(),
    methodVersion: 'sr-m1',
    adapterVersion: 'pool-frozen-1',
    planAuthVersion: 'sr-auth-1',
  });
  return r.task;
}

async function callRows(): Promise<{ state: string; step_id: string; simulated: boolean; sent_at: Date | null }[]> {
  const res = await srPool.query(
    'select state, step_id, simulated, sent_at from sr_call',
  );
  return res.rows;
}

/** 故障注入通道：第 n 次 dispatch（1 起）抛注入错误，其余透传内层。 */
class FaultTransport {
  private n = 0;
  constructor(private inner: SrModelTransport, private faultAt: number, private err: KernelError) {}
  describe() {
    return this.inner.describe();
  }
  async dispatch(step: Parameters<SrModelTransport['dispatch']>[0], ctx: Parameters<SrModelTransport['dispatch']>[1], payload: unknown) {
    this.n += 1;
    if (this.n === this.faultAt) throw this.err;
    return this.inner.dispatch(step, ctx, payload);
  }
}

describe('sr 引擎：模拟链全流程', () => {
  it('002384 → Metis 继承链（A→清单→J→发布门）十章报告、6 次模拟调用、证据绑定四哈希', async () => {
    const task = await newTask('002384', '2026-10-23T16:00:00.000Z');
    const { task: done, report } = await runSrTask(depsWith(new SimSrTransport()), task.taskId);
    assert.ok(report, '应产出报告');
    assert.equal(done.status, 'COMPLETED', `状态应为 COMPLETED（实际 ${done.status}，error=${JSON.stringify(done.error)}）`);
    assert.equal(report.sections.length, 10, '十章齐全');
    assert.equal(report.generatedBy, 'PRODUCT_SIMULATED', '生成身份=模拟');
    assert.ok(report.gate && report.gate.passed, `发布门应通过（实际 ${JSON.stringify(report.gate)}）`);
    assert.equal(report.status, 'PUBLISHED', '门过 → 正常发布');
    assert.ok(report.evidenceRefs, '证据绑定四哈希存在');
    assert.ok((report.evidenceRefs!.packHash ?? '').length >= 16 && report.evidenceRefs!.checklistHash !== '(缺失)', '绑定哈希非占位');
    assert.ok(report.sections.some((x) => x.key === 'sources' && x.narrative.includes('必经 J 裁决')), '来源章声明研究链');
    assert.ok(report.sections.some((x) => x.key === 'risk' && x.narrative.includes('J 终局判断')), '风险章含 J 终局');
    assert.ok(report.sections.some((s) => s.key === 'risk' && s.narrative.includes('最强反方解释')), '风险章含反证');
    const calls = await callRows();
    assert.equal(calls.length, 6, '模型调用 6 次（PLAN+3×ANALYZE+A_FINAL+JUDGE）');
    assert.ok(calls.every((c) => c.simulated), '全部 simulated=true');
    const kinds = await srPool.query("select s.step_kind from sr_call c join sr_step s on s.step_id=c.step_id order by c.created_at");
    assert.ok(kinds.rows.some((r: { step_kind: string }) => r.step_kind === 'CHECKLIST' === false), '清单无调用（确定性步骤）');
    assert.ok(kinds.rows.filter((r: { step_kind: string }) => r.step_kind === 'JUDGE').length === 1, '必经 J 恰一次');
    // 证据截点纪律
    const pack = JSON.parse(await readFile(join(outDir, 'tasks', task.taskId, 'evidence.json'), 'utf8'));
    for (const t of pack.tables) {
      for (const loc of t.locators) {
        if (loc.kind === 'FACT') assert.ok(loc.availableAt <= '2026-10-23T16:00:00.000Z', `截点泄漏：${t.tableId} ${loc.availableAt}`);
      }
    }
  });

  it('重放同任务零新增发送，报告指纹不变', async () => {
    const before = (await callRows()).length;
    const tasks = await srPool.query<{ task_id: string }>(
      `select task_id from sr_task where subject = '002384' order by created_at limit 1`,
    );
    const taskId = tasks.rows[0]!.task_id;
    const r1 = await getReportByTaskAndVersion(srPool, taskId, 1);
    await runSrTask(depsWith(new SimSrTransport()), taskId);
    const after = (await callRows()).length;
    assert.equal(after, before, '重放不得新增调用');
    const r2 = await getReportByTaskAndVersion(srPool, taskId, 1);
    assert.equal(r1!.contentHash, r2!.contentHash, '报告不可变');
  });
});

describe('sr 引擎：发布门（Metis 继承）', () => {
  it('J 裁决存在承重未解项 → PUBLISHED_RESTRICTED + 任务 PARTIAL + 具名处置', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const gateBlocking: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const jIn = payload as import('./transport.js').JInput;
          // 注入：第一条清单判为承重 UNRESOLVED，给全字段（新合同：承重理由+证据引用命中送达表+具名处置）
          if (j.verdicts[0]) {
            j.verdicts[0] = {
              ...j.verdicts[0],
              verdict: 'UNRESOLVED',
              decisionBearing: true,
              bearingReason: '测试注入：该判断影响结论成立性',
              evidenceRef: jIn.evidenceBundle[0]?.tableId ?? null,
            };
            j.unresolvedDisposition.push({ checklistId: j.verdicts[0].checklistId, handling: '测试注入：保留为承重未知' });
          }
        }
        return out;
      },
    };
    const { task: done, report } = await runSrTask(depsWith(gateBlocking), task.taskId);
    assert.equal(done.status, 'PARTIAL', '门未过 → PARTIAL');
    assert.ok(done.error && done.error.code === 'PUBLISH_GATE_BLOCKED', `错误码 PUBLISH_GATE_BLOCKED（实际 ${JSON.stringify(done.error)}）`);
    assert.equal(report!.status, 'PUBLISHED_RESTRICTED', '受限发布形态');
    assert.ok(report!.gate && !report!.gate.passed && report!.gate.decisionBearingUnresolved.length === 1, '承重未解项具名展示');
    assert.ok(report!.sections.some((x) => x.key === 'sources' && x.narrative.includes('受限发布')), '来源章如实声明');
  });
});

describe('sr 引擎：中断恢复与调用身份', () => {
  it('〔R2〕已发送后失败 → 重跑被已发送链阻断：零新调用、无新步骤', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const fault = new FaultTransport(new SimSrTransport(), 3, new KernelError('MODEL_OUTPUT_SCHEMA_INVALID', '注入：窗内显式失败'));
    const first = await runSrTask(depsWith(fault), task.taskId);
    assert.equal(first.task.status, 'FAILED', '故障任务诚实失败');
    const failedCall = await srFindCallByStep(srPool, task.taskId, (await srPool.query<{ step_id: string }>(
      `select s.step_id from sr_step s join sr_call c on c.step_id = s.step_id
       where s.task_id = $1::uuid and c.state = 'FAILED' limit 1`, [task.taskId],
    )).rows[0]!.step_id);
    assert.ok(failedCall?.sentAt, '失败发生在发送后（sent_at 非空）');

    const stepsBefore = (await srPool.query(`select count(*)::int n from sr_step where task_id=$1`, [task.taskId])).rows[0].n;
    const callsBefore = (await callRows()).length;
    const second = await runSrTask(depsWith(new SimSrTransport()), task.taskId);
    assert.equal(second.task.status, 'FAILED', '同输入重跑必须失败（不得换 ID 重发）');
    assert.ok(JSON.stringify(second.task.error).includes('SENT_CHAIN_BLOCKED') || JSON.stringify(second.task.error).includes('一次发送'),
      `错误应说明发送链阻断：${JSON.stringify(second.task.error)}`);
    assert.equal((await callRows()).length, callsBefore, '零新增调用');
    const stepsAfter = (await srPool.query(`select count(*)::int n from sr_step where task_id=$1`, [task.taskId])).rows[0].n;
    assert.equal(stepsAfter, stepsBefore, '无自动新步骤');
  });

  it('UNKNOWN 不自动重发：恢复守卫拦截 → 退役+确认后新步骤重试', async () => {
    const task = await newTask('600519', '2026-10-24T16:00:00.000Z');
    const fault = new FaultTransport(new SimSrTransport(), 1, new KernelError('SILENCE_AFTER_SEND', '注入：发送后静默'));
    const first = await runSrTask(depsWith(fault), task.taskId);
    assert.equal(first.task.status, 'FAILED', 'UNKNOWN 任务失败');
    const unclosed = await srListUnclosedCalls(srPool);
    const target = unclosed.find((c) => c.taskId === task.taskId);
    assert.ok(target, '存在未闭合 UNKNOWN 调用');
    const callsBefore = (await callRows()).length;

    // 引擎恢复扫描 → RECONCILING；此时重跑被恢复守卫拦截（零调用）
    await srBootRecovery(srPool);
    const blocked = await runSrTask(depsWith(new SimSrTransport()), task.taskId);
    assert.equal(blocked.task.status, 'FAILED');
    assert.equal((await callRows()).length, callsBefore, 'RECONCILING 下零新调用');
    assert.ok(JSON.stringify(blocked.task.error).includes('RECOVERY'), `错误应含恢复提示：${JSON.stringify(blocked.task.error)}`);

    // 〔R2〕Owner 退役 + 恢复确认后：同输入仍不得自动重发（退役不是重采样许可）；
    // 重新生成的正道 = 显式新任务（修订），新任务身份 + 新授权记录。
    await srRetireUnknown(srPool, target.callId, 'owner-test');
    await srConfirmRecovery(srPool, 'owner-test');
    const third = await runSrTask(depsWith(new SimSrTransport()), task.taskId);
    assert.equal(third.task.status, 'FAILED', '退役后同输入仍不自动重发');
    assert.equal((await callRows()).length, callsBefore, '退役前后零新增调用');
    // 正道：显式新任务可完整重做（新身份、新调用）
    const redo = await newTask('600519', '2026-10-24T16:00:00.000Z');
    const redoRes = await runSrTask(depsWith(new SimSrTransport()), redo.taskId);
    assert.ok(['COMPLETED', 'PARTIAL'].includes(redoRes.task.status), `显式新任务完成（实际 ${redoRes.task.status}）`);
  });
});

describe('sr 引擎：C4 差集验收点', () => {
  it('〔R0a〕A 误读数值 → J 输入送达真实原值与定位（可核对）', async () => {
    const task = await newTask('002384', '2026-10-23T16:00:00.000Z');
    const inner = new SimSrTransport();
    let analyzeCalls = 0;
    const liar: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'ANALYZE') {
          analyzeCalls += 1;
          if (analyzeCalls === 2) {
            // b 组（financials/outlook）：注入 A 误读——把财务章叙事改成错误数值
            const o = out as import('./transport.js').AnalyzeOutput;
            const fin = o.sections.find((x) => x.key === 'financials');
            if (fin) fin.narrative = '2026H1 营业收入 999.99 亿元（误读注入）';
          }
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(liar), task.taskId);
    assert.ok(res.report, '链应完成');
    // JUDGE 输入读回：evidenceBundle 必须含 fin-quarterly 的真实原值（27797683972.88）与定位
    const jStep = await readFile(join(outDir, 'tasks', task.taskId, 'steps', '09-JUDGE.json'), 'utf8');
    const jInput = JSON.parse(jStep) as { input: import('./transport.js').JInput };
    const aInput = JSON.parse(await readFile(join(outDir, 'tasks', task.taskId, 'steps', '07-A_FINAL.json'), 'utf8')) as { input: import('./transport.js').AFinalInput };
    const pack = JSON.parse(await readFile(join(outDir, 'tasks', task.taskId, 'evidence.json'), 'utf8')) as import('./contracts.js').EvidencePack;
    const computed = JSON.parse(await readFile(join(outDir, 'tasks', task.taskId, 'computed.json'), 'utf8')) as import('./contracts.js').ComputeResult;
    const expected = [...pack.tables, ...computed.tables];
    assert.ok(expected.some((t) => t.rows.length > 40), '覆盖原先末尾40行截断的回归场景');
    assert.deepEqual(aInput.input.evidenceBundle, expected, 'A 收到封存包全部表、行、定位与计算依赖');
    assert.deepEqual(jInput.input.evidenceBundle, expected.map((t) => ({
      ...t, note: 'formula' in t ? `${t.unitNote ?? ''}；公式：${t.formula}` : t.unitNote ?? null,
    })), 'J 收到同一完整封存包，不由 A 的引用筛掉反证，计算口径保留');
    const finTable = jInput.input.evidenceBundle.find((t) => t.tableId === 'fin-quarterly');
    assert.ok(finTable, 'fin-quarterly 实际内容已送达 J');
    const flat = JSON.stringify(finTable.rows);
    assert.ok(flat.includes('27797683972'), `J 可核对 A 误读的真实原值（27797683972.88）: ${flat.slice(0, 80)}`);
    assert.ok(Array.isArray(finTable.columns) && finTable.columns.length > 0, '送达列名');
  });

  it('〔R0b〕裁决合同收紧：缺 decisionBearing / 全非承重 / UNRESOLVED 无处置 / 改判绑定不符 全部拒绝', async () => {
    const { validateJOutput } = await import('./transport.js');
    const ids = ['a', 'b'];
    const base = (over: Record<string, unknown>) => ({
      verdicts: [
        { checklistId: 'a', verdict: 'NARROWED', decisionBearing: true, bearingReason: 'r', evidenceRef: 'fin-quarterly', remainingBasis: null, correction: null },
        { checklistId: 'b', verdict: 'SUPPORTED', decisionBearing: false, bearingReason: null, remainingBasis: { refs: ['a'], note: '表值直接核对，锚定承重项 a' }, evidenceRef: null, correction: null },
      ],
      conclusionRuling: { finalConclusion: '同A结论', changedFromA: false, changeReason: null, conditions: ['c1'] },
      unresolvedDisposition: [],
      limitations: [],
      ...over,
    });
    const opts = { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' };
    // 合法基线通过
    validateJOutput(base({}), ids, opts);
    // ① decisionBearing 缺失（字段删除）→ 拒
    assert.throws(() => validateJOutput(base({ verdicts: [ { checklistId: 'a', verdict: 'SUPPORTED', remainingBasis: { refs: [], note: 'x' }, evidenceRef: null, bearingReason: null, correction: null }, base({}).verdicts[1] ] }), ids, opts), /decisionBearing/);
    // ② 全非承重 → 拒
    assert.throws(() => validateJOutput(base({ verdicts: [
      { checklistId: 'a', verdict: 'SUPPORTED', decisionBearing: false, bearingReason: null, remainingBasis: { refs: [], note: 'x' }, evidenceRef: null, correction: null },
      { checklistId: 'b', verdict: 'SUPPORTED', decisionBearing: false, bearingReason: null, remainingBasis: { refs: [], note: 'y' }, evidenceRef: null, correction: null },
    ] }), ids, opts), /全.*非承重|非承重/);
    // ③ UNRESOLVED 无处置 → 拒
    assert.throws(() => validateJOutput(base({ verdicts: [
      { checklistId: 'a', verdict: 'UNRESOLVED', decisionBearing: true, bearingReason: 'r', evidenceRef: 'fin-quarterly', remainingBasis: null, correction: null },
      base({}).verdicts[1],
    ] }), ids, opts), /处置|引用未解/);  // 引用未解项先于处置校验触发——同为合同收紧
    // ④ 改判绑定：结论不同却自报未改判 → 拒
    assert.throws(() => validateJOutput(base({ conclusionRuling: { finalConclusion: '完全不同的终局结论文本', changedFromA: false, changeReason: null, conditions: ['c1'] } }), ids, opts), /改判/);
    // ⑤ 承重项 evidenceRef 未命中送达表 → 拒
    assert.throws(() => validateJOutput(base({ verdicts: [
      { checklistId: 'a', verdict: 'NARROWED', decisionBearing: true, bearingReason: 'r', evidenceRef: 'not-delivered', remainingBasis: null, correction: null },
      base({}).verdicts[1],
    ] }), ids, opts), /evidenceRef|送达/);
  });

  it('〔C5-01/R0c〕合法非承重未解项不拦门（保留为 limitation）+ BLOCKING 质检阻断完整发布', async () => {
    const task = await newTask('002384', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const legit: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const bearing = j.verdicts.filter((v) => v.decisionBearing && v.verdict === 'NARROWED');
          const alt = bearing[1] ?? bearing[0];
          // 合法非承重化：一条承重 NARROWED 改判 UNRESOLVED + 非承重 + 结构化剩余依据
          //（引用另一条承重已核查项——过全部校验；C5-01 验收：此类裁决不得被类别规则推翻）
          if (alt) {
            const ref = bearing.find((x) => x.checklistId !== alt.checklistId) ?? bearing[0];
            j.verdicts = j.verdicts.map((v) => v.checklistId === alt.checklistId
              ? { ...v, verdict: 'UNRESOLVED' as const, decisionBearing: false, bearingReason: null,
                  remainingBasis: { refs: ref ? [ref.checklistId] : [], note: '依据校验合法：结论不依赖此项' }, evidenceRef: null }
              : v);
          }
          j.unresolvedDisposition = [
            ...j.unresolvedDisposition,
            { checklistId: alt?.checklistId ?? 'x', handling: '非承重未解：保留为 limitation' },
          ];
        }
        if (step === 'ANALYZE') {
          // 表引用仍合法；只保留两个完整情景，通过 ANALYZE 合同后由 QA 拒绝三情景不完整。
          const o = out as import('./transport.js').AnalyzeOutput;
          const outlook = o.sections.find((s) => s.key === 'outlook');
          if (outlook) {
            assert.ok(outlook.scenarios && outlook.scenarios.length === 3, '合成通道先提供完整三情景');
            outlook.scenarios = outlook.scenarios.slice(0, 2);
          }
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(legit), task.taskId);
    // 门因 BLOCKING 质检未过（单一裁定），但不是因为合法非承重未解项
    assert.equal(res.task.status, 'PARTIAL');
    assert.equal(res.report!.status, 'PUBLISHED_RESTRICTED');
    assert.deepEqual(res.report!.qaFindings.filter((f) => f.severity === 'BLOCKING').map((f) => f.code), ['SCENARIO_MISSING'], '仅三情景完整性触发 QA 阻断');
    assert.ok(!res.report!.gate!.passed);
    assert.ok(res.report!.gate!.reason.includes('BLOCKING') || res.report!.gate!.reason.includes('质检'),
      `阻断原因应为质检而非承重未解（${res.report!.gate!.reason}）`);
    assert.ok(res.report!.gate!.decisionBearingUnresolved.length === 0, '合法非承重未解不计入承重未解');
    // limitation 保留：风险章呈现非承重未解项及其依据引用
    const risk = res.report!.sections.find((x) => x.key === 'risk')!;
    assert.ok(risk.narrative.includes('非承重未解项') && risk.narrative.includes('limitation'), '保留为 limitation 呈现');
  });

  it('〔C5-01 正路径〕合法非承重未解（无质检问题）→ 门过 COMPLETED，limitation 仍在', async () => {
    const task = await newTask('002384', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const legit: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const bearing = j.verdicts.filter((v) => v.decisionBearing && v.verdict === 'NARROWED');
          // 降级末条承重项（避开其他非承重项共同引用的锚=bearing[0]），引用锚本身
          const alt = bearing[bearing.length - 1];
          const ref = bearing[0] ?? bearing.find((x) => x.checklistId !== alt?.checklistId);
          if (alt && ref) {
            j.verdicts = j.verdicts.map((v) => v.checklistId === alt.checklistId
              ? { ...v, verdict: 'UNRESOLVED' as const, decisionBearing: false, bearingReason: null,
                  remainingBasis: { refs: [ref.checklistId], note: '依据合法' }, evidenceRef: null }
              : v);
            j.unresolvedDisposition.push({ checklistId: alt.checklistId, handling: '非承重未解：保留为 limitation' });
          }
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(legit), task.taskId);
    assert.equal(res.task.status, 'COMPLETED', `合法非承重未解不应拦门（实际 ${res.task.status}，${JSON.stringify(res.task.error)}）`);
    assert.equal(res.report!.status, 'PUBLISHED');
    assert.ok(res.report!.gate!.passed, '门过');
    const risk = res.report!.sections.find((x) => x.key === 'risk')!;
    assert.ok(risk.narrative.includes('非承重未解项'), 'limitation 仍如实呈现');
  });

  it('〔C5-02〕仅 NARROWED + 改判：摘要头部有改判声明（旧结论标为历史）', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    let flip = false;
    const changer: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'JUDGE' && !flip) {
          flip = true;
          const j = out as import('./transport.js').JOutput;
          // 全部 NARROWED（无 REJECTED），终局改判为相反结论（改判绑定：结论不同→changedFromA=true+理由）
          j.conclusionRuling = {
            finalConclusion: '与 A 完全相反的 J 终局判断：估值张力不可支持正面结论',
            changedFromA: true,
            changeReason: 'A 低估了融资余额收缩的持续性，证据不支持其乐观表述',
            conditions: j.conclusionRuling.conditions,
          };
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(changer), task.taskId);
    assert.ok(res.report, '链应完成');
    const summary = res.report!.sections.find((x) => x.key === 'summary')!;
    const head = summary.narrative.slice(0, 800);
    assert.ok(head.includes('J 已改判') && head.includes('改判前判断') && head.includes('历史记录'),
      `摘要头部应有改判声明（前 800 字：${head.slice(0, 120)}…）`);
    const jIdx = summary.narrative.indexOf('J 终局结论');
    const changedIdx = summary.narrative.indexOf('J 已改判');
    assert.ok(changedIdx >= 0 && changedIdx < jIdx, '改判声明在 J 终局之前（先标注旧结论身份）');
    const risk = res.report!.sections.find((x) => x.key === 'risk')!;
    assert.ok(risk.narrative.includes('已改判，理由见下') || risk.narrative.includes('改判理由'), '风险章含改判理由');
  });

  it('〔R0d〕裁决写回正文：REJECTED 降为已否定记录、NARROWED 带 correction、可定位', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    let mark = 0;
    const ruler: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'ANALYZE' && mark === 0) {
          mark = 1;
          // 组 a（company/industry/drivers）：记录第一条 finding 的清单 id 供裁决注入
          const o = out as import('./transport.js').AnalyzeOutput;
          const sec = o.sections.find((x) => x.key === 'company');
          if (sec && sec.findings[0]) void sec;
        }
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const jIn = payload as import('./transport.js').JInput;
          const items = jIn.checklist.items.filter((i) => i.category === 'FINDING' && i.sectionKey);
          const first = items.find((i) => i.sectionKey === 'company');
          const second = items.find((i) => i.sectionKey !== 'company');
          const ref = jIn.evidenceBundle[0]?.tableId ?? null;
          j.verdicts = j.verdicts.map((v) => {
            if (first && v.checklistId === first.checklistId) {
              return { ...v, verdict: 'REJECTED' as const, correction: 'A 将合并口径误作归母——与送达表不符' };
            }
            if (second && v.checklistId === second.checklistId) {
              return { ...v, verdict: 'NARROWED' as const, correction: '仅适用于截点内已披露期间' };
            }
            return v;
          });
          void ref;
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(ruler), task.taskId);
    assert.ok(res.report, '链应完成');
    const company = res.report!.sections.find((x) => x.key === 'company');
    const rejected = company?.findings.find((f) => f.status === 'REJECTED');
    assert.ok(rejected, 'company 章存在被驳回条目（状态 REJECTED）');
    assert.ok(rejected!.text.includes('J 驳回'), '驳回条目带 J 标注');
    assert.ok(rejected!.text.includes('与送达表不符') || rejected!.text.includes('归母'), '驳回 correction 可定位');
    const narrowedSec = res.report!.sections.find((x) => x.findings.some((f) => f.text.includes('J 收窄') && f.text.includes('截点内已披露期间')));
    assert.ok(narrowedSec, 'NARROWED correction 写回对应章节');
    const risk = res.report!.sections.find((x) => x.key === 'risk');
    assert.ok(risk!.narrative.includes('被 J 驳回的判断'), '风险章列驳回清单');
    assert.ok(risk!.narrative.includes('被 J 收窄的判断'), '风险章列收窄清单');
    const summary = res.report!.sections.find((x) => x.key === 'summary');
    assert.ok(summary!.narrative.includes('J 终局结论'), '摘要含 J 终局');
  });
});

describe('sr 引擎：C4 差集验收点', () => {
  it('〔C4-01〕remainingBasis 伪造被拒：不存在引用/未解引用/非承重链式引用/自引用；合法结构化引用通过', async () => {
    const { validateJOutput } = await import('./transport.js');
    const ids = ['a', 'b', 'c'];
    const mk = (verdicts: unknown[], finalConclusion = '同A结论') => ({
      verdicts,
      conclusionRuling: { finalConclusion, changedFromA: false, changeReason: null, conditions: ['c1'] },
      unresolvedDisposition: [],
      limitations: [],
    });
    const bearing = (id: string, verdict: 'SUPPORTED' | 'NARROWED' = 'SUPPORTED') => ({
      checklistId: id, verdict, decisionBearing: true,
      bearingReason: 'r', remainingBasis: null, evidenceRef: 'fin-quarterly', correction: null,
    });
    const nonBearing = (id: string, refs: string[]) => ({
      checklistId: id, verdict: 'SUPPORTED' as const, decisionBearing: false,
      bearingReason: null, remainingBasis: { refs, note: '依据' }, evidenceRef: null, correction: null,
    });
    const opts = { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' };
    // 合法：非承重 a 依据承重已核查项 b
    validateJOutput(mk([nonBearing('a', ['b']), bearing('b'), bearing('c')]), ids, opts);
    // ① 引用不存在的清单项 → 拒（Codex 已证反例：nonexistent-checklist-item）
    assert.throws(() => validateJOutput(mk([nonBearing('a', ['nonexistent-checklist-item']), bearing('b'), bearing('c')]), ids, opts), /不存在/);
    // ② 引用未解项 → 拒
    assert.throws(() => validateJOutput(mk([
      nonBearing('a', ['b']),
      { checklistId: 'b', verdict: 'UNRESOLVED', decisionBearing: true, bearingReason: 'r', remainingBasis: null, evidenceRef: 'fin-quarterly', correction: null },
      bearing('c'),
    ]), ids, opts), /未解/);
    // ③ 引用非承重项（链式依赖无根） → 拒
    assert.throws(() => validateJOutput(mk([nonBearing('a', ['b']), nonBearing('b', ['c']), bearing('c')]), ids, opts), /非承重/);
    // ④ 自引用 → 拒
    assert.throws(() => validateJOutput(mk([nonBearing('a', ['a']), bearing('b'), bearing('c')]), ids, opts), /自引用/);
    // ⑤ 引用已驳回项 → 拒
    assert.throws(() => validateJOutput(mk([
      nonBearing('a', ['b']),
      { checklistId: 'b', verdict: 'REJECTED', decisionBearing: true, bearingReason: 'r', remainingBasis: null, evidenceRef: 'fin-quarterly', correction: 'x' },
      bearing('c'),
    ]), ids, opts), /已驳回/);
    // ⑥ 字符串型 remainingBasis（旧形态） → 拒（必须结构化）
    assert.throws(() => validateJOutput(mk([
      { checklistId: 'a', verdict: 'SUPPORTED', decisionBearing: false, bearingReason: null, remainingBasis: '任意非空文字', evidenceRef: null, correction: null },
      bearing('b'), bearing('c'),
    ]), ids, opts), /remainingBasis/);
  });

  it('〔C4-02〕驳回纠正写入 narrative/摘要头部：原文保留但标为已否定，当前结论以 J 为准', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const ruler: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'ANALYZE' && (payload as { sectionKeys?: string[] }).sectionKeys?.includes('company')) {
          // A 叙事断言 "value is 100"（将被 J 驳回并纠正为 200——Codex 已证反例形态）
          const o = out as import('./transport.js').AnalyzeOutput;
          const sec = o.sections.find((x) => x.key === 'company');
          if (sec) sec.narrative = '本章 A 断言：value is 100。';
        }
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const jIn = payload as import('./transport.js').JInput;
          const first = jIn.checklist.items.find((i) => i.sectionKey === 'company' && i.category === 'FINDING');
          const anchorBearing = j.verdicts.find((v) => v.decisionBearing && v.verdict === 'NARROWED');
          if (first) {
            j.verdicts = j.verdicts.map((v) => v.checklistId === first.checklistId
              ? { ...v, verdict: 'REJECTED' as const, correction: '正确值为 200——A 误读送达表' }
              : v);
            void anchorBearing;
          }
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(ruler), task.taskId);
    assert.ok(res.report, '链应完成');
    const company = res.report!.sections.find((x) => x.key === 'company')!;
    // narrative 头部即裁决声明（不是只靠后部清单）——A 原文仍在但已标为已否定记录
    const headIdx = company.narrative.indexOf('J 裁决修正');
    const rawIdx = company.narrative.indexOf('value is 100');
    assert.ok(headIdx >= 0 && headIdx < rawIdx, '纠正声明位于 A 原文之前（先读到裁决后状态）');
    assert.ok(company.narrative.includes('已驳回') && company.narrative.includes('200'), '驳回与纠正值写入');
    assert.ok(company.narrative.includes('已否定历史记录'), 'A 原文明确标为已否定记录');
    const summary = res.report!.sections.find((x) => x.key === 'summary')!;
    assert.ok(summary.narrative.trimStart().startsWith('**〔J 裁决修正声明〕**') || summary.narrative.includes('J 裁决修正声明'), '摘要头部有驳回声明');
    assert.ok(summary.narrative.includes('J 终局结论'), '摘要含 J 终局');
    // 归档 md 同源（网页/PDF 共用 narrative）
    const { renderReportMarkdown } = await import('./engine.js');
    const md = renderReportMarkdown(res.report!, {});
    assert.ok(md.includes('J 裁决修正') && md.includes('value is 100'), '归档/PDF 同源呈现（声明+原文标注）');
  });

  it('〔C4-03〕QA 阻断在 ASSEMBLE 失败恢复后保持：质检结论不丢、零模型重发', async () => {
    // 场景：两个合法情景通过响应合同，QA 以 SCENARIO_MISSING 阻断 → PARTIAL/受限。
    // ASSEMBLE 置 FAILED 并保留报告行，重入恢复必须仍 PARTIAL/受限、原版本且模型调用零新增。
    const task = await newTask('002384', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const blocker: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'ANALYZE') {
          const o = out as import('./transport.js').AnalyzeOutput;
          const outlook = o.sections.find((s) => s.key === 'outlook');
          if (outlook) {
            assert.ok(outlook.scenarios && outlook.scenarios.length === 3, '合成通道先提供完整三情景');
            outlook.scenarios = outlook.scenarios.slice(0, 2);
          }
        }
        return out;
      },
    };
    const first = await runSrTask(depsWith(blocker), task.taskId);
    assert.equal(first.task.status, 'PARTIAL', '首轮：门未过（BLOCKING）');
    assert.equal(first.report!.status, 'PUBLISHED_RESTRICTED');
    assert.deepEqual(first.report!.qaFindings.filter((f) => f.severity === 'BLOCKING').map((f) => f.code), ['SCENARIO_MISSING'], '首轮确实到达 QA 三情景完整性检查');
    const callsAfterFirst = (await callRows()).length;

    // 模拟组装后工作文件写失败：保留已经插入的报告，重入同一步骤不增版。
    await srPool.query(`update sr_step set status='FAILED', finished_at=null where task_id=$1::uuid and step_kind='ASSEMBLE'`, [task.taskId]);
    await srPool.query(`update sr_task set status='FAILED', error=null, completed_at=null where task_id=$1::uuid`, [task.taskId]);

    // 恢复：QA 结论从绑定的 CAS 原件重载，阻断必须保持，模型调用零新增。
    const second = await runSrTask(depsWith(inner), task.taskId);
    assert.equal(second.task.status, 'PARTIAL', `恢复后仍 PARTIAL（实际 ${second.task.status}，error=${JSON.stringify(second.task.error)}）`);
    assert.ok(second.task.error && second.task.error.code === 'PUBLISH_GATE_BLOCKED', '恢复后仍是发布门阻断');
    assert.equal(second.report!.status, 'PUBLISHED_RESTRICTED', '恢复后仍受限发布');
    assert.deepEqual(second.report!.qaFindings, first.report!.qaFindings, '恢复保留完整 QA 发现');
    assert.ok(!second.report!.gate!.passed, '门未过');
    assert.ok(second.report!.gate!.reason.includes('BLOCKING') || second.report!.gate!.reason.includes('质检'), `门原因含质检阻断（${second.report!.gate!.reason}）`);
    assert.equal((await callRows()).length, callsAfterFirst, '恢复零模型重发');
    assert.equal(second.report!.contentHash, first.report!.contentHash, '重入保留首次报告正文与版本');
    assert.equal((await listReportVersions(srPool, task.taskId)).length, 1, '不凭空增版');
  });
});

describe('sr 引擎：C6 差集验收点', () => {
  it('〔C6-02〕收窄作用于章节主叙述：过宽表述被先行范围声明约束（Codex 探针复现）', async () => {
    const task = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const inner = new SimSrTransport();
    const narrower: SrModelTransport = {
      describe: () => inner.describe(),
      dispatch: async (step, ctx2, payload) => {
        const out = await inner.dispatch(step, ctx2, payload);
        if (step === 'ANALYZE' && (payload as { sectionKeys?: string[] }).sectionKeys?.includes('company')) {
          // A 叙事与 finding 都是过宽表述 "All divisions grew by 20%."（Codex 探针形态）
          const o = out as import('./transport.js').AnalyzeOutput;
          const sec = o.sections.find((x) => x.key === 'company');
          if (sec) {
            sec.narrative = 'All divisions grew by 20%.';
            sec.findings = [{ text: 'All divisions grew by 20%.', status: 'FACT', citations: [0] }];
          }
        }
        if (step === 'JUDGE') {
          const j = out as import('./transport.js').JOutput;
          const jIn = payload as import('./transport.js').JInput;
          const target = jIn.checklist.items.find((i) => i.sectionKey === 'company' && i.category === 'FINDING');
          if (target) {
            j.verdicts = j.verdicts.map((v) => v.checklistId === target.checklistId
              ? { ...v, verdict: 'NARROWED' as const, correction: 'Only division A grew by 20%; this is not established for other divisions.' }
              : v);
          }
        }
        return out;
      },
    };
    const res = await runSrTask(depsWith(narrower), task.taskId);
    assert.ok(res.report, '链应完成');
    const company = res.report!.sections.find((x) => x.key === 'company')!;
    const headIdx = company.narrative.indexOf('J 裁决修正');
    const rawIdx = company.narrative.indexOf('All divisions grew by 20%');
    assert.ok(headIdx >= 0 && headIdx < rawIdx, '范围声明位于过宽原文之前（先读到有效范围）');
    assert.ok(company.narrative.includes('适用范围已被 J 收窄'), '收窄声明措辞');
    assert.ok(company.narrative.includes('Only division A grew by 20%'), '收窄后的有效范围文本在主叙述');
    assert.ok(company.narrative.includes('改判前历史记录'), '过宽表述标为历史记录');
    // 共享报告对象（网页/PDF/归档同源）
    const { renderReportMarkdown } = await import('./engine.js');
    const md = renderReportMarkdown(res.report!, {});
    assert.ok(md.includes('适用范围已被 J 收窄') && md.includes('Only division A grew by 20%'), '归档/PDF 同源');
    // 风险章收窄清单仍在
    const risk = res.report!.sections.find((x) => x.key === 'risk')!;
    assert.ok(risk.narrative.includes('被 J 收窄的判断'), '风险章清单保留');
  });
});

describe('sr 引擎：版本与同标的新研究', () => {
  it('同标的新任务是独立报告，旧报告不被改写', async () => {
    const t1 = await newTask('002384', '2026-10-23T16:00:00.000Z');
    const r1 = await runSrTask(depsWith(new SimSrTransport()), t1.taskId);
    const hash1 = r1.report!.contentHash;
    const t2 = await newTask('002384', '2026-10-24T16:00:00.000Z');
    const r2 = await runSrTask(depsWith(new SimSrTransport()), t2.taskId);
    assert.notEqual(r1.report!.reportId, r2.report!.reportId, '新任务=新报告身份');
    assert.equal((await listReportVersions(srPool, t1.taskId)).length, 1, '旧任务版本不变');
    const again = await getReportByTaskAndVersion(srPool, t1.taskId, 1);
    assert.equal(again!.contentHash, hash1, '旧报告内容指纹不变（无前视改写）');
  });
});

describe('sr 追问（CHAT_ANSWER）', () => {
  it('五类问题中的 NEW_CUTOFF 给出建议动作且不改报告；同文本逐字重发幂等', async () => {
    // 自建任务（不依赖其他测试的执行顺序/数据）
    const own = await newTask('601318', '2026-10-24T16:00:00.000Z');
    const ownRes = await runSrTask(depsWith(new SimSrTransport()), own.taskId);
    assert.ok(ownRes.report, '前置：自建任务产出报告');
    const taskId = own.taskId;
    const report = await getReportByTaskAndVersion(srPool, taskId, 1);
    const pack = JSON.parse(await readFile(join(outDir, 'tasks', taskId, 'evidence.json'), 'utf8'));
    const computed = JSON.parse(await readFile(join(outDir, 'tasks', taskId, 'computed.json'), 'utf8'));
    const msg = await askReportQuestion(depsWith(new SimSrTransport()), accountId, {
      taskId,
      reportVersion: 1,
      question: '财报出了，能按最新数据更新结论吗？',
      questionKind: 'NEW_CUTOFF',
      pack,
      computed,
    });
    assert.equal(msg.role, 'ASSISTANT');
    assert.ok(msg.suggestedAction?.type === 'NEW_TASK', 'NEW_CUTOFF → 建议新任务');
    const after = await getReportByTaskAndVersion(srPool, taskId, 1);
    assert.equal(after!.contentHash, report!.contentHash, '提问不得改已发布报告');

    // 〔C3 补〕同文本逐字重发 → 幂等返回既有回答，零新调用
    const callsBeforeChat = (await callRows()).length;
    const again = await askReportQuestion(depsWith(new SimSrTransport()), accountId, {
      taskId,
      reportVersion: 1,
      question: '财报出了，能按最新数据更新结论吗？',
      questionKind: 'NEW_CUTOFF',
      pack,
      computed,
    });
    assert.equal(again.messageId, msg.messageId, '逐字重发返回既有回答');
    assert.equal((await callRows()).length, callsBeforeChat, '零新增调用');
  });
});

describe('sr 引擎：角色模型身份', () => {
  it('离线 runner 的六步路由与持久调用账逐项一致，重放不新增发送', async () => {
    const task = await newTask('002384', '2026-10-23T16:00:00.000Z');
    const sim = new SimSrTransport();
    let nextOutput: unknown;
    const invocations: string[][] = [];
    const real = new RealSrTransport(realTransportConfigFromEnv({ LYRA_SR_REAL_CALLS: '1', LYRA_SR_INVOCATIONS_DIR: join(outDir, 'role-invocations') }), {
      async run(argv) {
        invocations.push(argv);
        await writeFile(argv[argv.indexOf('--output-last-message') + 1]!, JSON.stringify(nextOutput));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const transport: SrModelTransport = {
      describe: (step) => ({ ...real.describe(step), simulated: true }),
      async dispatch(step, ctx, payload) {
        nextOutput = await sim.dispatch(step, ctx, payload);
        return real.dispatch(step, ctx, payload);
      },
    };
    const deps = depsWith(transport);
    const result = await runSrTask(deps, task.taskId);
    assert.ok(result.report, JSON.stringify(result.task.error));
    assert.equal(result.report.generatedBy, 'PRODUCT_SIMULATED');
    const calls = (await srPool.query(`select s.step_kind, c.model_id, c.usage, c.state, c.simulated
      from sr_call c join sr_step s on s.step_id=c.step_id where c.task_id=$1`, [task.taskId])).rows;
    assert.equal(calls.length, 6);
    for (const call of calls) {
      const review = call.step_kind === 'JUDGE';
      assert.equal(call.model_id, review ? 'gpt-6.1-sol' : 'gpt-6.1-terra');
      assert.equal(call.usage.reasoningEffort, review ? 'high' : 'max');
      assert.equal(call.state, 'SUCCEEDED');
      assert.equal(call.simulated, true);
    }
    assert.equal(invocations.filter(argv => argv.includes('gpt-6.1-sol')).length, 1);
    assert.equal(invocations.filter(argv => argv.includes('gpt-6.1-terra')).length, 5);
    await runSrTask(deps, task.taskId);
    assert.equal(invocations.length, 6);
  });
});

