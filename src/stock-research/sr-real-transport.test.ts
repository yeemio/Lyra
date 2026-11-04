/**
 * sr 真实通道离线验证（R1）：授权守门、干跑计划、注入 runner 的完整 dispatch 执行体。
 * 全程不触网、不 spawn 真实进程——runner 为注入的假实现（模拟 codex CLI 行为）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { KernelError } from '../contracts.js';
import {
  RealSrTransport,
  realTransportConfigFromEnv,
  selectSrTransport,
  srOutputSchema,
  STEP_INSTRUCTIONS,
  type RealRunner,
} from './transport.js';

const OUT = mkdtempSync(join(tmpdir(), 'sr-real-'));

function cfg(over: Partial<ReturnType<typeof realTransportConfigFromEnv>> = {}) {
  const base = realTransportConfigFromEnv({
    LYRA_SR_REAL_CALLS: '1',
    LYRA_SR_REAL_MODEL: 'test-model-x',
    LYRA_SR_REAL_EFFORT: 'high',
    LYRA_SR_REAL_WINDOW_MS: '60000',
    LYRA_SR_INVOCATIONS_DIR: join(OUT, 'inv'),
  } as unknown as NodeJS.ProcessEnv);
  return { ...base, ...over };
}

/** 假 runner：按 schema 约定产出 final.txt（模拟 codex CLI 的 --output-last-message 行为）。 */
function fakeRunner(finalJson: unknown): RealRunner & { calls: { argv: string[]; stdin: string }[] } {
  const calls: { argv: string[]; stdin: string }[] = [];
  return {
    calls,
    async run(argv, opts) {
      calls.push({ argv, stdin: opts.stdin });
      const finalIdx = argv.indexOf('--output-last-message');
      const finalPath = finalIdx >= 0 ? argv[finalIdx + 1]! : '';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(finalPath, JSON.stringify(finalJson), 'utf8');
      return { code: 0, stdout: '{"type":"ok"}', stderr: '' };
    },
  };
}

describe('R1 真实通道：授权守门', () => {
  it('角色默认不会开启真实调用；分析与复核均在 runner 前被拒绝', async () => {
    const runner = fakeRunner({});
    const t = new RealSrTransport(realTransportConfigFromEnv({}), runner);
    for (const step of ['ANALYZE', 'JUDGE'] as const) {
      assert.equal(t.dryRun(step, { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}).authorized, false);
      await assert.rejects(() => t.dispatch(step, { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}), { code: 'MODEL_PROVIDER_UNAUTHORIZED' });
    }
    assert.equal(runner.calls.length, 0);
  });

  it('enabled=false → dispatch 具名拒绝，describe 如实声明未授权', async () => {
    const t = new RealSrTransport(cfg({ enabled: false }));
    assert.equal(t.describe().simulated, true, '未授权即模拟身份声明');
    await assert.rejects(
      () => t.dispatch('PLAN', { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}),
      (e: unknown) => e instanceof KernelError && e.code === 'MODEL_PROVIDER_UNAUTHORIZED',
    );
  });

  it('selectSrTransport 默认模拟；real 且授权齐备 → 真实通道', () => {
    const sim = selectSrTransport({}, true);
    assert.equal(sim.describe().provider, 'sr-sim');
    const real = selectSrTransport({ LYRA_SR_REAL_CALLS: '1', LYRA_SR_REAL_MODEL: 'm' }, false);
    assert.equal(real.describe().provider, 'codex-native-sr');
    assert.equal(real.describe().simulated, false);
    const dsh = selectSrTransport({ LYRA_SR_TRANSPORT: 'dsh' }, false);
    assert.equal(dsh.describe('JUDGE').provider, 'dsh-deepseek-native-sr');
    assert.equal(dsh.describe('JUDGE').modelId, 'deepseek-flash');
  });
});

describe('R1 真实通道：干跑与执行体', () => {
  it('默认角色实际传入 CLI：分析 Terra/max、复核 Sol/high，与逐步身份一致', async () => {
    const runner = fakeRunner({});
    const t = new RealSrTransport(realTransportConfigFromEnv({ LYRA_SR_REAL_CALLS: '1', LYRA_SR_INVOCATIONS_DIR: join(OUT, 'roles') }), runner);
    for (const step of ['PLAN', 'ANALYZE', 'A_FINAL', 'CHAT_ANSWER', 'JUDGE', 'QA_JUDGE'] as const) {
      await t.dispatch(step, { callId: randomUUID(), inputHash: '0'.repeat(64) }, {});
      const argv = runner.calls.at(-1)!.argv;
      const review = step === 'JUDGE' || step === 'QA_JUDGE';
      const expectedModel = review ? 'gpt-6.1-sol' : 'gpt-6.1-terra';
      const expectedEffort = review ? 'high' : 'max';
      assert.equal(argv[argv.indexOf('-m') + 1], expectedModel);
      assert.ok(argv.includes(`model_reasoning_effort="${expectedEffort}"`));
      assert.equal(t.describe(step).modelId, expectedModel);
      assert.equal(t.describe(step).effort, expectedEffort);
    }
    assert.equal(runner.calls.length, 6);
  });

  it('显式整轮模型覆盖仍有效；复核专用配置可独立覆盖', () => {
    const shared = { LYRA_SR_REAL_MODEL: 'explicit-model', LYRA_SR_REAL_EFFORT: 'medium' };
    const legacy = new RealSrTransport(realTransportConfigFromEnv(shared));
    assert.equal(legacy.describe('ANALYZE').modelId, 'explicit-model');
    assert.equal(legacy.describe('JUDGE').modelId, 'explicit-model');
    assert.equal(legacy.describe('JUDGE').effort, 'medium');
    const split = new RealSrTransport(realTransportConfigFromEnv({ ...shared, LYRA_SR_REAL_REVIEW_MODEL: 'review-model', LYRA_SR_REAL_REVIEW_EFFORT: 'high' }));
    assert.equal(split.describe('ANALYZE').modelId, 'explicit-model');
    assert.equal(split.describe('JUDGE').modelId, 'review-model');
    assert.equal(split.describe('JUDGE').effort, 'high');
  });

  it('dryRun 输出完整 argv/schema/授权状态，不 spawn', () => {
    const t = new RealSrTransport(cfg());
    const plan = t.dryRun('JUDGE', { callId: randomUUID(), inputHash: '0'.repeat(64) }, { x: 1 });
    assert.ok(plan.argv.includes('exec') && plan.argv.includes('--output-schema'));
    assert.ok(plan.argv.includes('-m') && plan.argv.includes('test-model-x'));
    assert.ok(JSON.stringify(plan.schema).includes('SUPPORTED'), 'JUDGE schema 含裁决枚举');
    assert.equal(plan.authorized, true);
    assert.equal(plan.note.includes('不 spawn'), true);
    assert.equal(existsSync(join(OUT, 'inv')), false, 'dryRun 不落盘调用目录');
  });

  it('注入 runner：dispatch 全链工作（prompt 落盘→runner→final.txt 解析→输出返回）', async () => {
    const finalJson = { questions: ['q1'], materialPriorities: ['fin-quarterly'], emphasisNotes: [] };
    const runner = fakeRunner(finalJson);
    const t = new RealSrTransport(cfg(), runner);
    const callId = randomUUID();
    const out = await t.dispatch('PLAN', { callId, inputHash: '0'.repeat(64) }, { subject: '002384' });
    assert.deepEqual(out, finalJson, 'final.txt JSON 原样返回（权威校验在引擎侧）');
    // 调用取证落盘
    assert.ok(existsSync(join(OUT, 'inv', callId, 'prompt.txt')), 'prompt 落盘');
    assert.ok(existsSync(join(OUT, 'inv', callId, 'schema.json')), 'schema 落盘');
    assert.ok(existsSync(join(OUT, 'inv', callId, 'final.txt')), 'final 落盘');
    const prompt = readFileSync(join(OUT, 'inv', callId, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes('规划分析者') && prompt.includes('002384'), '提示词含指令与输入');
    // argv 指向真实调用目录（非 dry 路径）
    const argv = runner.calls[0]!.argv;
    assert.ok(argv.some((a) => a.includes(callId)), 'argv 使用调用目录');
  });

  it('runner 非零退出 / final 缺失 / 非法 JSON → 具名错误', async () => {
    const badExit: RealRunner = { async run() { return { code: 3, stdout: '', stderr: 'boom' }; } };
    const t1 = new RealSrTransport(cfg(), badExit);
    await assert.rejects(() => t1.dispatch('PLAN', { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}),
      (e: unknown) => e instanceof KernelError && e.code === 'SR_REAL_EXIT_NONZERO');

    const noFinal: RealRunner = { async run() { return { code: 0, stdout: '', stderr: '' }; } };
    const t2 = new RealSrTransport(cfg(), noFinal);
    await assert.rejects(() => t2.dispatch('PLAN', { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}),
      (e: unknown) => e instanceof KernelError && e.code === 'SR_FINAL_MISSING');

    const badJson: RealRunner = {
      async run(argv) {
        const i = argv.indexOf('--output-last-message');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(argv[i + 1]!, '{not-json', 'utf8');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const t3 = new RealSrTransport(cfg(), badJson);
    await assert.rejects(() => t3.dispatch('PLAN', { callId: randomUUID(), inputHash: '0'.repeat(64) }, {}),
      (e: unknown) => e instanceof KernelError && e.code === 'SR_OUTPUT_INVALID_JSON');
  });
});


// ===== 〔C8/C7-01〕两层职责分离：服务协议形状 与 本地业务保证 分别验证 =====
// Codex C7 裁定：对外 schema 只用目标服务（codex exec --output-schema / Structured Outputs）
// 支持的子集——无组合/条件关键字、对象闭合、声明字段全 required、nullable 用 type 数组；
// 条件义务（承重依据、剩余依据、改判理由、证据命中）由本地 validateXxx 权威承担。
// 两层职责不同，不对任意输入完全同判。完整 JSON Schema 校验器（ajv Draft 2020-12）的
// 正反例与逐字段删除验证在交付探针 delivery/ZCODE-C8-FREEZE-20261027/（本文件不引外部依赖）。

const STEPS = ['PLAN', 'ANALYZE', 'A_FINAL', 'JUDGE', 'CHAT_ANSWER'] as const;
type Step = (typeof STEPS)[number];

/** 服务不支持/要求的组合与条件关键字（官方 Structured Outputs 规则，Codex C7 裁定引用）。 */
const UNSUPPORTED_KEYWORDS = [
  'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems',
  'dependencies', 'dependentRequired', 'dependentSchemas',
] as const;

interface ShapeFinding { path: string; rule: string; detail: string }

/** 确定性结构走查（与 Codex provider-schema-check 同规则）：违规逐路径报点，便于失败定位。 */
function serviceSubsetFindings(node: unknown, path = '$'): ShapeFinding[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  const sc = node as Record<string, unknown>;
  const out: ShapeFinding[] = [];
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in sc) out.push({ path, rule: 'unsupported_composition_keyword', detail: kw });
  }
  const type = sc.type;
  const types = Array.isArray(type) ? (type as unknown[]).map(String) : typeof type === 'string' ? [type] : [];
  if (Array.isArray(type) && !types.includes('null')) {
    out.push({ path, rule: 'type_array_only_for_nullable', detail: JSON.stringify(type) });
  }
  const props = sc.properties as Record<string, unknown> | undefined;
  const required = sc.required as string[] | undefined;
  if (types.includes('object')) {
    if (sc.additionalProperties !== false) {
      out.push({ path, rule: 'object_additionalProperties_must_be_false', detail: String(sc.additionalProperties) });
    }
    for (const key of Object.keys(props ?? {})) {
      if (!(required ?? []).includes(key)) out.push({ path, rule: 'all_declared_fields_required', detail: key });
    }
  }
  for (const [k, sub] of Object.entries(props ?? {})) out.push(...serviceSubsetFindings(sub, `${path}/properties/${k}`));
  if (sc.items !== undefined) out.push(...serviceSubsetFindings(sc.items, `${path}/items`));
  return out;
}

/** 各步骤"最小合法协议输出"——含全部声明键（nullable 字段以 null 表达，数组可空）。 */
function minimalProtocolOutputs(): Record<Step, () => unknown> {
  return {
    PLAN: () => ({ questions: ['Q1'], materialPriorities: ['fin-quarterly'], emphasisNotes: [] }),
    ANALYZE: () => ({ sections: [{ key: 'company', narrative: 'Analysis.', findings: [], tables: [], gaps: [], scenarios: null }], citations: [] }),
    A_FINAL: () => ({
      narrative: 'n', conclusion: 'c', conclusionConditions: ['cond'],
      decisiveLinks: [{ text: 'l', tableId: 'fin-quarterly' }],
      strongestCounter: 'counter', catalysts: [], gaps: [],
    }),
    JUDGE: () => ({
      verdicts: [{ checklistId: 'sr-fnd:company:1', verdict: 'SUPPORTED', decisionBearing: true,
        bearingReason: 'r', remainingBasis: null, evidenceRef: 'fin-quarterly', correction: null }],
      conclusionRuling: { finalConclusion: '同A结论', changedFromA: false, changeReason: null, conditions: ['c'] },
      unresolvedDisposition: [], limitations: [],
    }),
    CHAT_ANSWER: () => ({ reportIdentity: { reportId: 'fixture-report', version: 1, contentHash: '1'.repeat(64) }, answer: 'a', citations: [], missingData: [], suggestedAction: null }),
  };
}

describe('C8 服务协议形状：五类步骤 schema 均在目标服务支持子集内', () => {
  it('无组合/条件关键字；对象（含 nullable 分支）全闭合；声明字段全 required；type 数组仅用于 nullable', () => {
    for (const step of STEPS) {
      const findings = serviceSubsetFindings(srOutputSchema(step));
      assert.deepEqual(findings, [], `${step}: 服务子集违规 ${JSON.stringify(findings)}`);
    }
  });

  it('C7-01 裁定点名差异逐点回归（不再出现）', () => {
    const judge = srOutputSchema('JUDGE') as Record<string, any>;
    assert.equal('allOf' in judge, false, 'JUDGE 根层不得有 allOf');
    const verdictItem = judge.properties.verdicts.items;
    assert.equal('allOf' in verdictItem, false, 'verdicts 项不得有 allOf/if/then');
    assert.deepEqual(
      [...verdictItem.required].sort(),
      ['bearingReason', 'checklistId', 'correction', 'decisionBearing', 'evidenceRef', 'remainingBasis', 'verdict'],
      'verdicts 项七字段全 required',
    );
    const rb = verdictItem.properties.remainingBasis;
    assert.equal(rb.additionalProperties, false, 'remainingBasis 对象分支须闭合');
    assert.ok(Array.isArray(rb.type) && rb.type.includes('null'), 'remainingBasis 须为 nullable');
    const ruling = judge.properties.conclusionRuling;
    assert.ok(ruling.required.includes('changeReason'), 'conclusionRuling 须含 changeReason（nullable）');

    const analyze = srOutputSchema('ANALYZE') as Record<string, any>;
    assert.ok(analyze.properties.sections.items.required.includes('scenarios'), 'ANALYZE 章节项须含 scenarios（nullable）');

    const chat = srOutputSchema('CHAT_ANSWER') as Record<string, any>;
    assert.ok(chat.required.includes('suggestedAction'), 'CHAT_ANSWER 须含 suggestedAction（nullable）');
    assert.equal(chat.properties.suggestedAction.additionalProperties, false, 'suggestedAction 对象分支须闭合');
    assert.deepEqual(
      [...chat.properties.suggestedAction.required].sort(),
      ['cutoff', 'emphasis', 'type'],
      'suggestedAction 声明字段全 required',
    );
  });
});

describe('C8 本地业务保证：wire nullable 之外的权威校验（两层分离，不同判是设计而非缺口）', () => {
  it('最小合法协议输出（含 nullable 键）全部通过本地校验，且消费端可直接读取必需字段与数组', async () => {
    const v = await import('./transport.js');
    const validators: Record<Step, (o: unknown) => unknown> = {
      PLAN: (o) => v.validatePlanOutput(o),
      ANALYZE: (o) => v.validateAnalyzeOutput(o),
      A_FINAL: (o) => v.validateAFinalOutput(o),
      JUDGE: (o) => v.validateJOutput(o, ['sr-fnd:company:1'], { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }),
      CHAT_ANSWER: (o) => v.validateChatOutput(o),
    };
    for (const step of STEPS) {
      const out = minimalProtocolOutputs()[step]() as Record<string, unknown>;
      validators[step](out); // 本地校验通过（不抛）
      if (step === 'ANALYZE') {
        const sec = (out.sections as Array<{ gaps: unknown[]; findings: unknown[]; tables: unknown[]; scenarios: unknown }>)[0]!;
        assert.ok(Array.isArray(sec.gaps) && Array.isArray(sec.findings) && Array.isArray(sec.tables), 'ANALYZE 消费数组实际存在');
        assert.equal(sec.scenarios, null, 'scenarios nullable 分支在场');
      }
      if (step === 'A_FINAL') {
        const catalysts = out.catalysts as unknown[];
        const gapsList = out.gaps as unknown[];
        assert.ok(Array.isArray(catalysts) && Array.isArray(gapsList), 'A_FINAL 消费数组实际存在（catalysts.map / gaps）');
        void [...catalysts].map((x) => x).length; void gapsList.length;
      }
      if (step === 'CHAT_ANSWER') {
        assert.equal(out.suggestedAction, null, 'suggestedAction nullable 分支在场且本地放行');
      }
    }
  });

  it('wire 接受（nullable）而本地必拒：承重项 bearingReason/evidenceRef 为 null', async () => {
    const { validateJOutput } = await import('./transport.js');
    const mk = minimalProtocolOutputs().JUDGE; // verdicts[0] 为承重项
    const bearingNull = mk() as any;
    bearingNull.verdicts[0].bearingReason = null;
    assert.throws(() => validateJOutput(bearingNull, ['sr-fnd:company:1'], { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }), /bearingReason/);
    const refNull = mk() as any;
    refNull.verdicts[0].evidenceRef = null;
    assert.throws(() => validateJOutput(refNull, ['sr-fnd:company:1'], { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }), /evidenceRef/);
  });

  it('wire 接受（nullable）而本地必拒：非承重项 remainingBasis 为 null / 引用不合规', async () => {
    const { validateJOutput } = await import('./transport.js');
    // 非承重 SUPPORTED 项：remainingBasis 须为非空 {refs,note}（协议层只知 nullable，不知业务义务）
    const nonbearing = minimalProtocolOutputs().JUDGE() as any;
    nonbearing.verdicts[0].decisionBearing = false;
    nonbearing.verdicts[0].bearingReason = null;
    nonbearing.verdicts[0].evidenceRef = null;
    nonbearing.verdicts[0].remainingBasis = null;
    // 单项全非承重在本地另拒——补一个承重项使合同成立，再验 remainingBasis 义务本身
    nonbearing.verdicts.push({ checklistId: 'sr-fnd:company:2', verdict: 'SUPPORTED', decisionBearing: true,
      bearingReason: '承重依据', remainingBasis: null, evidenceRef: 'fin-quarterly', correction: null });
    assert.throws(() => validateJOutput(nonbearing, ['sr-fnd:company:1', 'sr-fnd:company:2'],
      { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }), /remainingBasis/);
  });

  it('wire 接受（nullable）而本地必拒：改判缺 changeReason；未改判而自报改判亦拒（改判绑定）', async () => {
    const { validateJOutput } = await import('./transport.js');
    const changedNoReason = minimalProtocolOutputs().JUDGE() as any;
    changedNoReason.conclusionRuling.changedFromA = true;
    changedNoReason.conclusionRuling.finalConclusion = '不同结论';
    changedNoReason.conclusionRuling.changeReason = null;
    assert.throws(() => validateJOutput(changedNoReason, ['sr-fnd:company:1'],
      { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }), /changeReason/);
    const falseChange = minimalProtocolOutputs().JUDGE() as any;
    falseChange.conclusionRuling.changedFromA = true; // 结论未变却自报改判
    falseChange.conclusionRuling.changeReason = '理由';
    assert.throws(() => validateJOutput(falseChange, ['sr-fnd:company:1'],
      { deliveredTableIds: ['fin-quarterly'], aConclusion: '同A结论' }), /改判绑定/);
  });

  it('本地校验拒绝 C6 已关闭具名反例（保持既有保证）', async () => {
    const { validatePlanOutput, validateAnalyzeOutput, validateAFinalOutput, validateChatOutput } = await import('./transport.js');
    // ANALYZE 缺 findings / tables / gaps
    for (const field of ['findings', 'tables', 'gaps'] as const) {
      const sec: Record<string, unknown> = { key: 'company', narrative: 'n', findings: [], tables: [], gaps: [], scenarios: null };
      delete sec[field];
      assert.throws(() => validateAnalyzeOutput({ sections: [sec], citations: [] }), new RegExp(field), `ANALYZE 缺 ${field} 应拒`);
    }
    // A_FINAL 缺 catalysts / gaps
    for (const field of ['catalysts', 'gaps'] as const) {
      const base: Record<string, unknown> = {
        narrative: 'n', conclusion: 'c', conclusionConditions: ['x'],
        decisiveLinks: [{ text: 'l', tableId: 't' }], strongestCounter: 's', catalysts: [], gaps: [],
      };
      delete base[field];
      assert.throws(() => validateAFinalOutput(base), new RegExp(field), `A_FINAL 缺 ${field} 应拒`);
    }
    // PLAN 缺 materialPriorities/emphasisNotes（协议层 required 同拒——服务形状与本地一致的非条件面）
    assert.throws(() => validatePlanOutput({ questions: ['q'] }), /materialPriorities/);
    // 基线合法性（防过度收紧）
    validateChatOutput({ reportIdentity: { reportId: 'fixture-report', version: 1, contentHash: '1'.repeat(64) }, answer: 'a', citations: [], missingData: [], suggestedAction: null });
    validateChatOutput({ reportIdentity: { reportId: 'fixture-report', version: 1, contentHash: '1'.repeat(64) }, answer: 'a', citations: [], missingData: [], suggestedAction: { type: 'NEW_TASK', cutoff: '2026-10-27', emphasis: null } });
  });
});

// ===== 〔C6/C5-03〕最小合法协议响应通过本地校验；缺真正必填在协议层即被 required 拒 =====
describe('C5-03 协议必填一致性（最小响应双向验证）', () => {
  it('PLAN 最小协议响应 {questions, materialPriorities, emphasisNotes} 通过 validatePlanOutput；仅 questions 在协议层即缺必填', async () => {
    const { validatePlanOutput, srOutputSchema } = await import('./transport.js');
    const minimal = { questions: ['Q1'], materialPriorities: ['fin-quarterly'], emphasisNotes: [] };
    validatePlanOutput(minimal); // 通过
    const schema = srOutputSchema('PLAN') as { required?: string[] };
    for (const f of ['questions', 'materialPriorities', 'emphasisNotes']) {
      assert.ok(schema.required?.includes(f), `PLAN required 缺 ${f}（Codex 反例：仅 questions 曾被协议放行而本地拒绝）`);
    }
  });

  it('CHAT_ANSWER 最小响应 {answer, citations, missingData, suggestedAction} 通过校验；缺数组/动议在协议层即被拒', async () => {
    const { validateChatOutput, srOutputSchema } = await import('./transport.js');
    validateChatOutput({ reportIdentity: { reportId: 'fixture-report', version: 1, contentHash: '1'.repeat(64) }, answer: 'a', citations: [], missingData: [], suggestedAction: null });
    const schema = srOutputSchema('CHAT_ANSWER') as { required?: string[] };
    for (const f of ['answer', 'citations', 'missingData', 'suggestedAction']) assert.ok(schema.required?.includes(f), `CHAT required 缺 ${f}`);
  });

  it('JUDGE 根层 limitations 列为必填（本地校验强制 Array）', async () => {
    const { srOutputSchema } = await import('./transport.js');
    const schema = srOutputSchema('JUDGE') as { required?: string[] };
    assert.ok(schema.required?.includes('limitations'), 'JUDGE required 缺 limitations');
  });

  it('ANALYZE 最小响应（单章+空 findings/citations）通过 validateAnalyzeOutput', async () => {
    const { validateAnalyzeOutput, srOutputSchema } = await import('./transport.js');
    validateAnalyzeOutput({ sections: [{ key: 'company', narrative: 'n', findings: [], tables: [], gaps: [] }], citations: [] });
    const schema = srOutputSchema('ANALYZE') as { required?: string[] };
    for (const f of ['sections', 'citations']) assert.ok(schema.required?.includes(f), `ANALYZE required 缺 ${f}`);
  });
});
