/**
 * W22 单测 · Gate-M 周度研究执行器（真实数据 + mock 通道）。
 * 零真实模型调用、零 spawn：真跑路径注入 FakeSolChannel（ModelTransport，describe
 * simulated:false；输出回抄 prompt 内嵌的 required_input_hash，顺带钉扎 prompt 绑定）。
 * 读走生产库 public（真实事实与封存追加，与 W11/旅程同模式），执行与结论落隔离 schema。
 * 覆盖：A/J prompt 内容（方法正文关键句、分层渲染、coverage、schema 说明、哈希回抄）；
 * 干跑零 permit/零模型调用；真跑全链（A→清单→J→结论→报告，inputBytes=prompt 真实字节）；
 * 预算闸（超限即 INPUT_OVER_BUDGET 且不调模型）；send-once 同键拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { ArtifactStore } from '../artifacts/store.js';
import { acquireExecutorLock, releaseExecutorLock } from '../kernel/lock.js';
import type { ModelTransport } from '../kernel/transport.js';
import type { SolDispatchPayload } from '../kernel/sol-transport.js';
import { DEFAULT_SOL_MODEL } from '../kernel/sol-transport.js';
import { readConclusion } from '../db/conclusion.js';
import { KernelError, type AOutput, type JOutput, type ModelCallContract } from '../contracts.js';
import { canonicalSha256 } from '../canonical.js';
import { runGateM, renderJPrompt, GATE_M_PLAN_BUDGET } from './gate-m.js';
import { deriveChecklist } from './checklist.js';
import { simulatedModelA } from './simulated.js';

const HOLDER = `gate-m-test-${randomUUID()}`;
const schema = `gate_m_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let isolated: Pool;
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

// ===== mock 通道：Sol 形态载荷（prompt + expectedChecklistIds），输出回抄 prompt 内嵌哈希 =====

class FakeSolChannel implements ModelTransport {
  readonly calls: { stage: 'A' | 'J'; prompt: string; inputBytes: number }[] = [];

  async dispatch(call: ModelCallContract, payload: unknown): Promise<unknown> {
    const p = payload as SolDispatchPayload;
    const requiredHash = /required_input_hash = "([0-9a-f]{64})"/.exec(p.prompt)?.[1];
    if (requiredHash === undefined) {
      throw new KernelError('MODEL_OUTPUT_SCHEMA_INVALID', 'fake：prompt 未内嵌 required_input_hash');
    }
    this.calls.push({ stage: call.stage, prompt: p.prompt, inputBytes: Buffer.byteLength(p.prompt, 'utf8') });
    if (call.stage === 'A') {
      const out: AOutput = {
        stage: 'A',
        inputHash: requiredHash,
        subjectKind: call.businessKey.subjectKind,
        candidate: 'RESEARCH_OUTPERFORM',
        decisiveLinks: [
          { text: '决定性连接一：近 8 季财务趋势（fake 通道）', evidenceArtifactSha256: '11'.repeat(32) },
          { text: '决定性连接二：行业基准相对表现（fake 通道）', evidenceArtifactSha256: '22'.repeat(32) },
        ],
        strongestCounter: '最强反证：近 20 日换手率抬升（fake 通道）',
        confidence: 'MEDIUM',
        limitations: ['fake 通道输出（测试）'],
        simulated: true,
      };
      return out;
    }
    const ids = p.expectedChecklistIds ?? [];
    const out: JOutput = {
      stage: 'J',
      inputHash: requiredHash,
      finalDisposition: 'ABSTAIN',
      verdicts: ids.map((id) => ({ checklistId: id, verdict: 'SUPPORTED' as const, decisionBearing: true, correction: null })),
      changedFromA: false,
      changeReason: null,
      strongestCaseDisposition: 'ACCEPTED',
      limitations: ['fake 通道输出（测试）'],
      simulated: true,
    };
    return out;
  }

  describe(): { provider: string; simulated: boolean } {
    return { provider: 'fake-sol-channel', simulated: false };
  }
}

test('Gate-M prompt：A prompt 含方法正文关键句、分层渲染、coverage 与 schema 说明（真实 600519 数据）', async () => {
  const outcome = await runGateM({ dataPool: admin, execPool: isolated, store, transport: new FakeSolChannel() }, {
    subject: '600519',
    cutoff: '2022-06-30T07:00:00.000Z',
    execute: false,
  });
  assert.equal(outcome.mode, 'dry-run');
  const a = outcome.prompts.aPrompt;
  // 方法正文全文进入 prompt（关键句抽检 + 版本行）
  assert.ok(a.includes('A（分析者）指令 · method@p2-v1'), 'A_INSTRUCTIONS 版本行');
  assert.ok(a.includes('你的输出单独永远不是最终结论'), '方法正文角色句');
  assert.ok(a.includes('缺以下任一项即结构无效'), '方法正文结构有效性句');
  // 分层渲染：L0 身份、L1 行情表、L2 索引目录
  assert.ok(a.includes('研究身份（L0，不可裁剪）'), 'L0 身份块');
  assert.ok(a.includes('资金与价格行为：DAILY_BAR 无损表格'), 'L1 行情表块');
  assert.ok(a.includes('deliveredFacts'), 'L2 索引目录渲染');
  // coverage 声明（缺口可见）
  assert.ok(a.includes('coverage 声明'), 'coverage 声明在场');
  assert.ok(a.includes('缺口'), 'coverage 缺口行在场');
  // 绑定与 schema 说明
  assert.ok(a.includes(`required_input_hash = "${outcome.assembled.inputHash}"`), 'inputHash 回抄绑定');
  assert.ok(a.includes('"decisiveLinks"'), 'A 输出 schema 说明在场');
  assert.ok(a.includes('RESEARCH_OUTPERFORM'), '选项空间说明在场');
  assert.ok(outcome.prompts.aPromptBytes > 10_000, '真实材料 prompt 量级');
});

test('Gate-M prompt：J prompt 含 J_DUTIES、A 输出全文、清单全文与绑定哈希', async () => {
  const outcome = await runGateM({ dataPool: admin, execPool: isolated, store, transport: new FakeSolChannel() }, {
    subject: '600519',
    cutoff: '2022-06-30T07:00:00.000Z',
    execute: false,
  });
  assert.equal(outcome.mode, 'dry-run');
  const pkg = outcome.assembled.package;
  const fakeA = simulatedModelA({
    inputHash: pkg.inputHash,
    subjectKind: pkg.businessKey.subjectKind,
    subject: pkg.businessKey.subject,
    material: {
      artifactSha256s: pkg.seals.flatMap((s) => s.artifactRefs.map((r) => r.sha256)).slice(0, 12),
      factCount: pkg.seals.reduce((n, s) => n + s.factIds.length, 0),
      gaps: pkg.dimensions.flatMap((c) => c.gap),
    },
  });
  const checklist = deriveChecklist(fakeA, pkg.seals[0]!.manifestHash);
  const jInputHash = canonicalSha256({ a: fakeA, checklist });
  const j = renderJPrompt('STOCK', fakeA, checklist, jInputHash);
  assert.ok(j.includes('J（裁决者）义务 · method@p2-v1'), 'J_DUTIES 版本行');
  assert.ok(j.includes('逐项裁决恰好一次'), 'J_DUTIES 逐项裁决句');
  assert.ok(j.includes('A 输出全文'), 'A 输出全文段');
  assert.ok(j.includes('程序清单全文'), '清单全文段');
  assert.ok(j.includes('check:p0:DECISIVE_LINK:0'), '清单 id 在场');
  assert.ok(j.includes(`required_input_hash = "${jInputHash}"`), 'J 绑定哈希');
  assert.ok(j.includes('"finalDisposition"'), 'J 输出 schema 说明在场');
});

test('Gate-M 干跑：零 permit、零模型调用、预算与 argv 预览齐全（不 spawn）', async () => {
  let dispatched = 0;
  const spyTransport: ModelTransport = {
    async dispatch() { dispatched += 1; throw new Error('干跑不得调用模型'); },
    describe() { return { provider: 'spy', simulated: false }; },
  };
  const outcome = await runGateM({ dataPool: admin, execPool: isolated, store, transport: spyTransport }, {
    subject: '600519',
    cutoff: '2022-06-30T07:00:00.000Z',
    execute: false,
  });
  assert.equal(outcome.mode, 'dry-run');
  assert.equal(dispatched, 0, '干跑零模型调用');
  const permits = await isolated.query<{ n: string }>(`select count(*)::text as n from exec_permit`);
  assert.equal(permits.rows[0]?.n, '0', '干跑零 permit');
  assert.equal(outcome.validation?.ok, true, '输入包程序校验通过');
  assert.equal(outcome.prompts.jPromptBasis, 'simulated-a-estimate', 'J 字节数为模拟 A 估算');
  assert.equal(outcome.budgetCheck.pass, true, '预算检查通过（真实字节数）');
  assert.ok(outcome.budgetCheck.a.bytes > 0 && outcome.budgetCheck.j.bytes > 0);
  // argv 预览（Sol/high、schema 约束、stdin '-'；占位路径标注）
  assert.equal(outcome.previews.a.pathPlaceholders, true);
  assert.equal(outcome.previews.a.argv[outcome.previews.a.argv.indexOf('-m') + 1], DEFAULT_SOL_MODEL);
  assert.ok(outcome.previews.a.argv.includes('model_reasoning_effort="high"'));
  assert.equal(outcome.previews.a.argv[outcome.previews.a.argv.length - 1], '-');
  assert.ok(outcome.previews.j.argv.includes('--output-schema'));
  assert.equal(outcome.previews.a.stage, 'A');
  assert.equal(outcome.previews.j.stage, 'J');
});

test('Gate-M 真跑（mock 通道）：A→清单→J→结论落库→报告，inputBytes=prompt 真实字节', async () => {
  const fake = new FakeSolChannel();
  const outcome = await runGateM({ dataPool: admin, execPool: isolated, store, transport: fake }, {
    subject: '600519',
    cutoff: '2022-06-30T07:00:00.000Z',
    execute: true,
    holderId: HOLDER,
  });
  assert.equal(outcome.mode, 'execute');
  assert.equal(outcome.prompts.jPromptBasis, 'real-a-output');
  assert.equal(fake.calls.length, 2, '恰两次模型调用（授权 2）');
  // permit：双双 SUCCEEDED、非模拟身份、input_bytes = prompt 真实字节数（预算闸口径）
  assert.ok(outcome.permits.a !== null, '常规路径 A permit 在');
  if (outcome.permits.a !== null) {
    assert.equal(outcome.permits.a.state, 'SUCCEEDED');
    assert.equal(outcome.permits.a.simulated, false);
  }
  assert.equal(outcome.permits.j.state, 'SUCCEEDED');
  const rows = await isolated.query<{ stage: string; state: string; input_bytes: number; simulated: boolean }>(
    `select stage, state, input_bytes::int as input_bytes, simulated from exec_permit where permit_id = any($1::uuid[])`,
    [[outcome.permits.a.permitId, outcome.permits.j.permitId]],
  );
  const aRow = rows.rows.find((r) => r.stage === 'A');
  const jRow = rows.rows.find((r) => r.stage === 'J');
  assert.equal(aRow?.state, 'SUCCEEDED');
  assert.equal(aRow?.input_bytes, outcome.prompts.aPromptBytes, 'A permit inputBytes = A prompt 真实字节');
  assert.equal(jRow?.input_bytes, outcome.prompts.jPromptBytes, 'J permit inputBytes = J prompt 真实字节');
  assert.equal(aRow?.simulated, false);
  // 结论：落库可读回、disposition 与 J 一致、adoption=false
  assert.equal(outcome.conclusion.disposition, 'ABSTAIN');
  assert.equal(outcome.conclusion.adoption, false);
  const readBack = await readConclusion(isolated, outcome.conclusion.conclusionId);
  assert.equal(readBack?.conclusionHash, outcome.conclusion.conclusionHash);
  // 报告：人审件含合规标注与标的
  assert.ok(outcome.reportText.includes('个人研究记录，非投资建议'), '末行合规标注');
  assert.ok(outcome.reportText.includes('600519'));
  assert.ok(outcome.reportText.includes('J 最终决定'));
});

test('Gate-M 预算闸：prompt 真实字节超授权上限 → INPUT_OVER_BUDGET 且不调模型', async () => {
  const fake = new FakeSolChannel();
  await assert.rejects(
    () => runGateM({ dataPool: admin, execPool: isolated, store, transport: fake }, {
      subject: '600519',
      cutoff: '2022-03-31T07:00:00.000Z',
      execute: true,
      holderId: HOLDER,
      budget: { ...GATE_M_PLAN_BUDGET, planAuthVersion: 'pa-gate-m-budget-test', maxInputBytes: 1_000 },
      versions: { methodVersion: 'method@p2-v1', adapterVersion: 'data@p1', planAuthVersion: 'pa-gate-m-budget-test' },
    }),
    (err: unknown) => (err as { code?: string }).code === 'INPUT_OVER_BUDGET',
    '超预算具名阻断',
  );
  assert.equal(fake.calls.length, 0, '预算闸在发送前拦截，模型零调用');
  const blocked = await isolated.query<{ state: string; fail_code: string }>(
    `select state, fail_code from exec_permit where plan_auth_version = 'pa-gate-m-budget-test'`,
  );
  assert.equal(blocked.rows[0]?.state, 'FAILED');
  assert.equal(blocked.rows[0]?.fail_code, 'INPUT_OVER_BUDGET');
});

test('Gate-M send-once：同业务键二次真跑 → BUSINESS_KEY_ALREADY_SENT', async () => {
  const fake = new FakeSolChannel();
  await assert.rejects(
    () => runGateM({ dataPool: admin, execPool: isolated, store, transport: fake }, {
      subject: '600519',
      cutoff: '2022-06-30T07:00:00.000Z',
      execute: true,
      holderId: HOLDER,
    }),
    (err: unknown) => (err as { code?: string }).code === 'BUSINESS_KEY_ALREADY_SENT',
    'send-once 拒绝（授权只有一轮）',
  );
  assert.equal(fake.calls.length, 0, '重发在 permit 层被拒，模型零调用');
});
