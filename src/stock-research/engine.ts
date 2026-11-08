/**
 * Lyra · sr 研究引擎（R31）：任务 → 步骤 → 调用 → 报告。
 *
 * 研究链（最小足够，TASK-PACKAGE §5.2）：
 *   PLAN（模型）→ EVIDENCE（确定性）→ COMPUTE（确定性）→ ANALYZE×3 组（模型）
 *   → SYNTHESIZE（模型）→ QA_CHECK（确定性）→ ASSEMBLE（确定性）
 *
 * 纪律：
 * - 任务身份与调用身份分开：调用绑定 (taskId, stepId, inputHash)；重试原身份，
 *   改输入=新步骤。全部模型调用经 runPermittedCall + SR_PERMIT_SPACE（唯一执行器）。
 * - 恢复：步骤产物持久化；重入任务从第一个未完成步骤续跑，已完成模型步骤复用
 *   落盘输出，零重复发送（send-once 双保险）。
 * - 诚实状态：QA 有 BLOCKING 发现 → 任务 PARTIAL（报告保留并展示质检结果）；
 *   步骤硬失败 → FAILED（具名），未产出报告时退还任务配额。
 * - 生成身份：报告 generatedBy 由通道 describe().simulated 决定，不得手工改写。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../contracts.js';
import { runPermittedCall, type PermittedCallSuccess } from '../kernel/executor.js';
import { canonicalSha256 } from '../canonical.js';
import { withExecutionLease, type ExecutionLease } from '../kernel/lease.js';
import { fencedSrWrite, freezeSrInput, restoreSrResponse, srCheckpointInput, assertSrModelArtifact, initialEvidence, type SrInputCheckpoint } from './engine-checkpoint.js';
import {
  REPORT_SECTIONS,
  type SrCallContract,
  SECTION_TITLES,
  SR_METHOD_VERSION,
  type ChatMessage,
  type EvidencePack,
  type ComputeResult,
  type ReportDocument,
  type ReportQaFinding,
  type ReportSection,
  type SrEngineDeps,
  type SrStep,
  type SrTask,
  type SrTransportDescribe,
} from './contracts.js';
import {
  SR_PERMIT_SPACE,
  srCallHasReceipt,
  srFindCallByStep,
  addChatMessage,
  createChatThread,
  findThreadForReport,
  getReportByTaskAndVersion,
  getTask,
  insertAssembledReport,
  insertStep,
  getLatestReportForTask,
  listSteps,
  srRecordCallMeta,
  updateStep,
  updateTask,
  ensureSrSteps,
  claimSrTask,
} from './store.js';
import type { SrCallPermit } from './store.js';
import {
  validateAFinalOutput,
  validateAnalyzeOutput,
  validateChatOutput,
  validateJOutput,
  validatePlanOutput,
  validateSynthOutput,
  type AFinalInput,
  type AFinalOutput,
  type AnalyzeInput,
  type AnalyzeOutput,
  type ChatInput,
  type ChatOutput,
  type JInput,
  type JOutput,
  type PlanInput,
  type PlanOutput,
  type SrChecklist,
  type SrChecklistItem,
  type SynthInput,
  type SynthOutput,
} from './transport.js';
import { selectAnalysisTables } from './materials.js';
import { beginChatRequest, completeChatRequest, recordRequestFailure } from './store-requests.js';
import { buildEvidencePack, applyPlanToEvidence } from './evidence.js';
import { computeMetrics } from './compute.js';
import { signReport } from './report-identity.js';
import { chatCitations, verifiedChatMessages } from './chat-evidence.js';
import { loadReportMaterials, readStepArtifact, reportArtifacts, saveStepArtifact } from './report-artifacts.js';

/** ANALYZE 分组：三组覆盖十章中的九章（summary 由 SYNTHESIZE 生成、sources 由组装生成）。 */
const ANALYZE_GROUPS: { key: string; sections: string[] }[] = [
  { key: 'a', sections: ['company', 'industry', 'drivers'] },
  { key: 'b', sections: ['financials', 'outlook'] },
  { key: 'c', sections: ['valuation', 'market', 'risk'] },
];

export const SR_CALL_WINDOW_MS = 60 * 60 * 1000; // 单调用执行窗（与 DECISIONS §2 申请及 RealTransport 缺省一致）

function sha256Text(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface StepPlanRow {
  kind: SrStep['stepKind'];
  sectionKey: string | null;
}

function plannedSteps(): StepPlanRow[] {
  // 〔C3/R0〕Metis 继承链：A（分段+终稿）→ 程序清单（机械）→ 必经 J → 发布门组装。
  // 模型调用：PLAN + ANALYZE×3 + A_FINAL + JUDGE = 6 次（≤ 任务上限 8）。
  return [
    { kind: 'PLAN', sectionKey: null },
    { kind: 'EVIDENCE', sectionKey: null },
    { kind: 'COMPUTE', sectionKey: null },
    ...ANALYZE_GROUPS.map((g) => ({ kind: 'ANALYZE' as const, sectionKey: g.key })),
    { kind: 'A_FINAL', sectionKey: null },
    { kind: 'CHECKLIST', sectionKey: null },
    { kind: 'JUDGE', sectionKey: null },
    { kind: 'QA_CHECK', sectionKey: null },
    { kind: 'ASSEMBLE', sectionKey: null },
  ];
}

/** 程序清单：从 A 全部产物机械抽取（无模型，可由 A 输出重导出复算）。 */
export function deriveSrChecklist(
  groups: AnalyzeOutput[],
  aFinal: AFinalOutput,
): SrChecklist {
  const items: SrChecklistItem[] = [];
  for (const g of groups) {
    for (const sec of g.sections) {
      sec.findings.forEach((f) => {
        const tableId = g.citations[f.citations[0] ?? -1]?.tableId ?? sec.tables[0] ?? null;
        items.push({
          checklistId: `sr-fnd:${sec.key}:${items.filter((x) => x.sectionKey === sec.key).length + 1}`,
          category: 'FINDING',
          sectionKey: sec.key,
          text: f.text,
          status: f.status,
          tableId: tableId ?? null,
        });
      });
    }
  }
  aFinal.decisiveLinks.forEach((l, i) => {
    items.push({
      checklistId: `sr-dl:${i + 1}`,
      category: 'DECISIVE_LINK',
      sectionKey: null,
      text: l.text,
      status: 'INFERENCE',
      tableId: l.tableId,
    });
  });
  items.push({
    checklistId: 'sr-counter:1',
    category: 'COUNTER',
    sectionKey: 'risk',
    text: aFinal.strongestCounter,
    status: 'COUNTER',
    tableId: null,
  });
  return {
    items,
    checklistHash: canonicalSha256(items),
    derivedFrom: {
      aSectionsHash: canonicalSha256(groups),
      aFinalHash: canonicalSha256(aFinal),
    },
  };
}

// ===== 步骤产物落盘/读回 =====

async function taskDir(deps: SrEngineDeps, taskId: string): Promise<string> {
  const dir = join(deps.outputDir, 'tasks', taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeStepOutput(deps: SrEngineDeps, step: SrStep, value: unknown): Promise<string> {
  await fencedSrWrite(deps.srPool, deps.lease, (tx) => saveStepArtifact(tx, deps.outputDir, step, value));
  const dir = await taskDir(deps, step.taskId);
  const rel = join('steps', `${String(step.sequence).padStart(2, '0')}-${step.stepKind}${step.sectionKey ? '-' + step.sectionKey : ''}.json`);
  await mkdir(join(dir, 'steps'), { recursive: true });
  await writeFile(join(dir, rel), JSON.stringify(value, null, 1), 'utf8');
  return rel;
}

async function readStepOutput<T>(deps: SrEngineDeps, step: SrStep): Promise<T> {
  return readStepArtifact<T>(deps.outputDir, step, step.outputArtifact);
}

// ===== 模型调用（唯一发送路径）=====

export type SrModelStep = 'PLAN' | 'ANALYZE' | 'A_FINAL' | 'JUDGE' | 'SYNTHESIZE' | 'CHAT_ANSWER';

/** Shared sr entry; callers own the frozen contract and output persistence, never a second permit space. */
export async function callSrModel<T>(
  deps: Pick<SrEngineDeps, 'srPool' | 'transport' | 'budget'> & Pick<SrEngineDeps, 'lease'>,
  args: {
    contract: Omit<SrCallContract, 'inputHash' | 'inputBytes'>;
    modelStep: SrModelStep;
    input: unknown;
    validate: (v: unknown) => T;
    holderId?: string;
    lease?: ExecutionLease;
    fixedDeadline?: boolean;
    expectedTransport?: SrTransportDescribe;
    afterValidated?: (output: T, permit: SrCallPermit, transport: SrTransportDescribe) => Promise<void>;
  },
): Promise<PermittedCallSuccess<SrCallPermit, T>> {
  return withExecutionLease(deps.srPool, 'sr', async (guard) => {
    const { modelStep, input, validate } = args;
    const prompt = JSON.stringify(input, null, 1);
    const inputHash = sha256Text(prompt);
    const desc = deps.transport.describe(modelStep);
    if (args.expectedTransport && canonicalSha256(desc) !== canonicalSha256(args.expectedTransport)) throw new KernelError('MODEL_PROVIDER_UNAUTHORIZED', 'Frozen transport identity changed');
    if (!desc.simulated && !deps.transport.preflight) throw new KernelError('MODEL_PREFLIGHT_REQUIRED', 'Real SR transport requires a non-sending preflight');
    const wire = await deps.transport.preflight?.(modelStep, inputHash, input) ?? { inputHash, inputBytes: Buffer.byteLength(prompt, 'utf8') };
    if (!Number.isSafeInteger(wire.inputBytes) || wire.inputBytes < 1 || !/^[a-f0-9]{64}$/.test(wire.inputHash)) throw new KernelError('MODEL_INPUT_UNBOUND', 'Transport preflight has no valid wire identity');
    if (wire.inputBytes > deps.budget.maxInputBytes) throw new KernelError('INPUT_OVER_BUDGET', 'Full wire prompt exceeds the authorized input budget');
    const frozen = await freezeSrInput(deps.srPool, guard.lease, { version: 1,
      contract: { ...args.contract, deadline: new Date(args.contract.deadline).toISOString(), inputHash, inputBytes: Buffer.byteLength(prompt, 'utf8') },
      modelStep, input, wire, transport: desc, budget: deps.budget }, args.fixedDeadline);
    let result = await restoreSrResponse(deps.srPool, frozen);
    let startedAt: number | undefined;
    let callId: string | undefined;
    try {
      if (!result) result = await runPermittedCall<SrCallPermit, SrCallContract, T>(SR_PERMIT_SPACE, deps.srPool, {
        contract: frozen.contract, budget: deps.budget, simulated: desc.simulated, lease: guard.lease,
        checkpoint: { input: srCheckpointInput(frozen), transport: desc },
        modelFn: async (ctx) => {
          await guard.assert();
          if (canonicalSha256(deps.transport.describe(modelStep)) !== canonicalSha256(desc)) throw new KernelError('MODEL_PROVIDER_UNAUTHORIZED', 'Transport identity changed before dispatch');
          callId = ctx.permit.callId; startedAt = performance.now();
          await fencedSrWrite(deps.srPool, guard.lease, (tx) => srRecordCallMeta(tx as unknown as SrEngineDeps['srPool'], callId!, { provider: desc.provider, modelId: desc.modelId,
            usage: { ...(desc.effort ? { reasoningEffort: desc.effort } : {}), wireInputBytes: wire.inputBytes } }));
          ctx.signal?.throwIfAborted();
          await guard.assert();
          ctx.signal?.throwIfAborted();
          return validate(await deps.transport.dispatch(modelStep, { callId, inputHash, deadline: frozen.contract.deadline, signal: ctx.signal }, frozen.input));
        }, pollMs: 25,
      });
      const output = validate(result.output);
      // Publication is after the atomic SUCCEEDED/checkpoint, outside the model/deadline race.
      // If publication fails, retry reads this original result, without dispatching again.
      await guard.assert();
      await args.afterValidated?.(output, result.permit, desc);
      return { permit: result.permit, output };
    } catch (err) {
      if (err instanceof KernelError) throw new KernelError(err.code, `[${modelStep}] ${err.message}`);
      throw err;
    } finally {
      if (callId && startedAt !== undefined) await fencedSrWrite(deps.srPool, guard.lease, (tx) => srRecordCallMeta(tx as unknown as SrEngineDeps['srPool'], callId!, {
        provider: desc.provider, modelId: desc.modelId, usage: {
          ...(desc.effort ? { reasoningEffort: desc.effort } : {}), durationMs: Math.round(performance.now() - startedAt!),
          wireInputBytes: wire.inputBytes, costNote: desc.simulated ? '模拟通道：无费用' : '费用未知，待实际回执；UNKNOWN 不记零费用',
        },
      })).catch(() => undefined);
    }
  }, { lease: args.lease ?? deps.lease, holderId: args.holderId });
}

async function callModel(
  deps: SrEngineDeps, task: SrTask, step: SrStep, modelStep: SrModelStep,
  input: unknown, validate: (v: unknown) => unknown,
): Promise<unknown> {
  const now = deps.now?.() ?? new Date();
  const result = await callSrModel(deps, {
    contract: { taskId: task.taskId, stepId: step.stepId, methodVersion: SR_METHOD_VERSION,
      planAuthVersion: deps.budget.planAuthVersion, deadline: new Date(now.getTime() + SR_CALL_WINDOW_MS).toISOString() },
    modelStep, input, validate,
  });
  return result.output;
}

async function updateOwnedStep(deps: SrEngineDeps, stepId: string, patch: Parameters<typeof updateStep>[2]): Promise<void> {
  await fencedSrWrite(deps.srPool, deps.lease, (tx) => updateStep(tx, stepId, patch));
}
async function updateOwnedTask(deps: SrEngineDeps, taskId: string, patch: Parameters<typeof updateTask>[2]): Promise<SrTask> {
  return fencedSrWrite(deps.srPool, deps.lease, (tx) => updateTask(tx as unknown as SrEngineDeps['srPool'], taskId, patch));
}

// ===== 步骤执行 =====

interface RunContext {
  deps: SrEngineDeps;
  task: SrTask;
  plan?: PlanOutput;
  pack?: EvidencePack;
  computed?: ComputeResult;
  analyze: Map<string, AnalyzeOutput>;
  synth?: SynthOutput;
  aFinal?: AFinalOutput;
  checklist?: SrChecklist;
  judge?: JOutput;
  qa?: ReportQaFinding[];
}

async function runOneStep(ctx: RunContext, step: SrStep): Promise<void> {
  const { deps, task } = ctx;
  await updateOwnedStep(deps, step.stepId, { status: 'RUNNING', started: true });
  try {
    switch (step.stepKind) {
      case 'PLAN': {
        const preflight = { pack: await initialEvidence(deps, task.taskId, async () =>
          (await buildEvidencePack(deps.dataPool, { taskId: task.taskId, subject: task.subject, cutoff: task.cutoff, focus: task.focus, outputDir: deps.outputDir })).pack) };
        ctx.pack = preflight.pack;
        const input: PlanInput = {
          subject: task.subject,
          subjectName: task.subjectName,
          swL1: preflight.pack.coverage.industry.swL1 ?? '历史归属/名称缺失',
          focus: task.focus,
          horizon: task.horizon,
          emphasis: task.emphasis,
          cutoff: task.cutoff,
          coverageSummary: { coverage: preflight.pack.coverage, materials: preflight.pack.tables.map((t) => ({ tableId: t.tableId, title: t.title, rows: t.rows.length, unitNote: t.unitNote })) },
          sectionsContract: [...REPORT_SECTIONS],
        };
        const out = validatePlanOutput(await callModel(deps, task, step, 'PLAN', input, validatePlanOutput));
        ctx.plan = out;
        await writeStepOutput(deps, step, { inputJson: JSON.stringify(input, null, 1), input, output: out });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${out.questions.length} 个研究问题`, finished: true });
        return;
      }
      case 'EVIDENCE': {
        if (!ctx.plan) throw new KernelError('STEP_PRECONDITION', 'EVIDENCE 需要 PLAN');
        const built = { pack: ctx.pack ?? await initialEvidence(deps, task.taskId) };
        built.pack = applyPlanToEvidence(built.pack, ctx.plan, task.horizon);
        ctx.pack = built.pack;
        await writeFile(join(await taskDir(deps, task.taskId), 'evidence.json'), JSON.stringify(built.pack, null, 1), 'utf8');
        await writeStepOutput(deps, step, { pack: built.pack });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${built.pack.tables.length} 张证据表，缺口 ${built.pack.coverage.gaps.length} 项`, finished: true });
        return;
      }
      case 'COMPUTE': {
        if (!ctx.pack) throw new KernelError('STEP_PRECONDITION', 'COMPUTE 需要 EVIDENCE 产物');
        const result = computeMetrics(ctx.pack);
        ctx.computed = result;
        const dir = await taskDir(deps, task.taskId);
        await writeFile(join(dir, 'computed.json'), JSON.stringify(result, null, 1), 'utf8');
        await writeStepOutput(deps, step, { computed: result });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${result.tables.length} 张计算表`, finished: true });
        return;
      }
      case 'ANALYZE': {
        if (!ctx.pack || !ctx.computed || !ctx.plan) throw new KernelError('STEP_PRECONDITION', 'ANALYZE 需要前置产物');
        const group = ANALYZE_GROUPS.find((g) => g.key === step.sectionKey);
        if (!group) throw new KernelError('STEP_PRECONDITION', `未知分析组 ${step.sectionKey}`);
        if (!step.sectionKey) throw new KernelError('STEP_PRECONDITION', 'ANALYZE 缺少分组键');
        const input: AnalyzeInput = {
          subject: task.subject,
          subjectName: task.subjectName,
          cutoff: task.cutoff,
          sectionKeys: group.sections,
          tables: [
            ...selectAnalysisTables(ctx.pack.tables, ctx.plan, step.sectionKey).map((t) => ({ tableId: t.tableId, title: t.title, columns: t.columns, rows: t.rows, unitNote: t.unitNote })),
            ...ctx.computed.tables.map((t) => ({ tableId: t.tableId, title: t.title, columns: t.columns, rows: t.rows, unitNote: `${t.unitNote ?? ""}；公式：${t.formula}` })),
          ],
          coverageGaps: ctx.pack.coverage.gaps,
          planQuestions: ctx.plan.questions,
          researchContext: { focus: task.focus, horizon: task.horizon, emphasis: task.emphasis, materialPriorities: ctx.plan.materialPriorities, emphasisNotes: ctx.plan.emphasisNotes },
        };
        const out = validateAnalyzeOutput(await callModel(deps, task, step, 'ANALYZE', input, (v) => validateAnalyzeOutput(v, input)), input);
        ctx.analyze.set(step.sectionKey ?? '', out);
        await writeStepOutput(deps, step, { inputJson: JSON.stringify(input, null, 1), input, output: out });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${out.sections.length} 章`, finished: true });
        return;
      }
      case 'SYNTHESIZE':
      case 'A_FINAL': {
        // 〔C3〕A 终稿：核心判断 + 决定性连接（绑证据表）+ 最强反证。旧链 SYNTHESIZE 行按同义处理。
        if (!ctx.analyze.size || !ctx.computed) throw new KernelError('STEP_PRECONDITION', 'A_FINAL 需要分析产物');
        const valTable = ctx.computed.tables.find((t) => t.tableId.includes('valuation'));
        const input: AFinalInput = {
          subject: task.subject,
          subjectName: task.subjectName,
          cutoff: task.cutoff,
          sections: ANALYZE_GROUPS.flatMap((g) => ctx.analyze.get(g.key)?.sections ?? []),
          valuationNote: valTable ? `${valTable.title}：${valTable.formula}` : '估值计算表缺失（按缺口处理）',
          decisiveLinkContract: '每条决定性连接必须绑定一个证据/计算表 tableId，否则不得作为承重判断；回答研究问题，区分事实、假设与竞争解释，缺材料限制因果判断',
          researchContext: { focus: task.focus, horizon: task.horizon, emphasis: task.emphasis, plan: ctx.plan },
          // 保留当前封存包的全部表与行，避免成稿丢失分章已见的原表、历史比较与计算依据。
          evidenceBundle: [...(ctx.pack?.tables ?? []), ...ctx.computed.tables],
        };
        const out = validateAFinalOutput(await callModel(deps, task, step, 'A_FINAL', input, (v) => validateAFinalOutput(v)));
        ctx.aFinal = out;
        await writeStepOutput(deps, step, { inputJson: JSON.stringify(input, null, 1), input, output: out });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `结论+${out.decisiveLinks.length} 条决定性连接+反证`, finished: true });
        return;
      }
      case 'CHECKLIST': {
        // 程序清单：无模型，机械抽取；哈希可由 A 产物重导出复算（QA 校验）。
        if (!ctx.aFinal) throw new KernelError('STEP_PRECONDITION', 'CHECKLIST 需要 A 终稿');
        const groups = ANALYZE_GROUPS.map((g) => ctx.analyze.get(g.key)).filter((x): x is AnalyzeOutput => Boolean(x));
        const cl = deriveSrChecklist(groups, ctx.aFinal);
        ctx.checklist = cl;
        await writeStepOutput(deps, step, cl);
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${cl.items.length} 项（哈希 ${cl.checklistHash.slice(0, 8)}）`, finished: true });
        return;
      }
      case 'JUDGE': {
        // 必经 J：逐清单项裁决（全覆盖），承重未知项处置，终局结论；改判必须给理由。
        // J 独立复核整个封存包；不能由 A 是否引用某张表决定 J 能否看见反证。
        if (!ctx.checklist || !ctx.aFinal) throw new KernelError('STEP_PRECONDITION', 'JUDGE 需要清单与 A 终稿');
        const evidenceBundle = [...(ctx.pack?.tables ?? []), ...(ctx.computed?.tables ?? [])]
          .map((t) => ({ ...t, note: 'formula' in t ? `${t.unitNote ?? ''}；公式：${t.formula}` : t.unitNote ?? null }));
        const input: JInput = {
          subject: task.subject,
          subjectName: task.subjectName,
          cutoff: task.cutoff,
          checklist: ctx.checklist,
          aFinal: ctx.aFinal,
          sectionSummaries: ANALYZE_GROUPS.flatMap((g) => ctx.analyze.get(g.key)?.sections ?? []).map((x) => ({ key: x.key, narrativeExcerpt: x.narrative.slice(0, 300) })),
          evidenceBundle,
          researchContext: { focus: task.focus, horizon: task.horizon, emphasis: task.emphasis, plan: ctx.plan },
        };
        const ids = ctx.checklist.items.map((i) => i.checklistId);
        const deliveredIds = evidenceBundle.map((t) => t.tableId);
        const out = validateJOutput(
          await callModel(deps, task, step, 'JUDGE', input, (v) => validateJOutput(v, ids, { deliveredTableIds: deliveredIds, aConclusion: ctx.aFinal!.conclusion })),
          ids,
          { deliveredTableIds: deliveredIds, aConclusion: ctx.aFinal.conclusion },
        );
        ctx.judge = out;
        await writeStepOutput(deps, step, { inputJson: JSON.stringify(input, null, 1), input, output: out });
        const unresolved = out.verdicts.filter((v) => v.verdict === 'UNRESOLVED').length;
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `${out.verdicts.length} 项裁决，${unresolved} 项未解，证据 ${evidenceBundle.length} 表`, finished: true });
        return;
      }
      case 'QA_CHECK': {
        const findings = runQaChecks(ctx);
        ctx.qa = findings;
        await writeStepOutput(deps, step, { findings });
        const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: blocking ? `${blocking} 项 BLOCKING` : '通过', finished: true });
        return;
      }
      case 'ASSEMBLE': {
        const report = await assembleReport(ctx, step);
        const dir = await taskDir(deps, task.taskId);
        await writeFile(join(dir, 'report.md'), renderReportMarkdown(report, await loadReportMaterials(deps.outputDir, report)), 'utf8');
        await writeStepOutput(deps, step, { reportId: report.reportId, version: report.version, contentHash: report.contentHash });
        await updateOwnedStep(deps, step.stepId, { status: 'SUCCEEDED', note: `v${report.version}`, finished: true });
        return;
      }
      default:
        throw new KernelError('STEP_PRECONDITION', `引擎不执行步骤类型 ${step.stepKind}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateOwnedStep(deps, step.stepId, { status: 'FAILED', note: message.slice(0, 500), finished: true });
    throw err;
  }
}

// ===== 质量检查（确定性；独立于文风）=====

export function runQaChecks(ctx: RunContext): ReportQaFinding[] {
  const findings: ReportQaFinding[] = [];
  const pack = ctx.pack;
  const computed = ctx.computed;
  const knownTables = new Set([
    ...(pack?.tables.map((t) => t.tableId) ?? []),
    ...(computed?.tables.map((t) => t.tableId) ?? []),
  ]);
  // 1. 截点纪律：证据表内定位不得晚于截点
  if (pack) {
    for (const t of pack.tables) {
      for (const loc of t.locators) {
        if (loc.kind === 'FACT' && loc.availableAt > pack.cutoff) {
          findings.push({ code: 'CUTOFF_LEAK', severity: 'BLOCKING', sectionKey: null, detail: `表 ${t.tableId} 定位晚于截点：${loc.availableAt}` });
        }
      }
    }
  } else {
    findings.push({ code: 'EVIDENCE_MISSING', severity: 'BLOCKING', sectionKey: null, detail: '证据包缺失' });
  }
  // 2. 引用可解析：findings 引用的引用号与 tableId 必须存在
  for (const [gkey, out] of ctx.analyze) {
    for (const s of out.sections) {
      for (const t of s.tables) {
        if (!knownTables.has(t)) {
          findings.push({ code: 'CITATION_UNRESOLVED', severity: 'BLOCKING', sectionKey: s.key as ReportSection['key'], detail: `组 ${gkey} 章节 ${s.key} 引用未知表 ${t}` });
        }
      }
      for (const c of out.citations) {
        if (!knownTables.has(c.tableId)) {
          findings.push({ code: 'CITATION_UNRESOLVED', severity: 'BLOCKING', sectionKey: s.key as ReportSection['key'], detail: `组 ${gkey} 引用未知表 ${c.tableId}` });
        }
      }
    }
  }
  // 3. 章节完整：十个章节键齐全且 narrative 非空
  const produced = new Map(ANALYZE_GROUPS.flatMap((g) => ctx.analyze.get(g.key)?.sections ?? []).map((s) => [s.key, s]));
  for (const key of REPORT_SECTIONS) {
    if (key === 'summary' || key === 'sources') continue;
    const s = produced.get(key);
    if (!s || !s.narrative.trim()) {
      findings.push({ code: 'SECTION_MISSING', severity: 'BLOCKING', sectionKey: key, detail: `章节 ${key} 缺失或为空` });
    }
  }
  // 4. 反证必答与结论条件（C3：以 A 终稿 + J 裁决为准）
  if (!ctx.aFinal || !ctx.aFinal.strongestCounter.trim()) {
    findings.push({ code: 'COUNTERCASE_MISSING', severity: 'BLOCKING', sectionKey: 'risk', detail: 'A 终稿最强反证缺失' });
  }
  if (ctx.aFinal && ctx.aFinal.conclusionConditions.length === 0) {
    findings.push({ code: 'CONCLUSION_UNCONDITIONAL', severity: 'BLOCKING', sectionKey: 'risk', detail: 'A 终稿结论未带条件' });
  }
  if (ctx.judge && ctx.judge.conclusionRuling.conditions.length === 0) {
    findings.push({ code: 'CONCLUSION_UNCONDITIONAL', severity: 'BLOCKING', sectionKey: 'risk', detail: 'J 终局未带条件' });
  }
  // 5. 情景完整（outlook）
  const outlook = produced.get('outlook');
  if (!outlook?.scenarios || outlook.scenarios.length < 3) {
    findings.push({ code: 'SCENARIO_MISSING', severity: 'BLOCKING', sectionKey: 'outlook', detail: '基准/改善/恶化三情景不完整' });
  }
  // 6. 计算自检失败项 → ADVISORY
  for (const c of computed?.checks ?? []) {
    if (!c.ok) findings.push({ code: 'COMPUTE_CHECK_FAILED', severity: 'ADVISORY', sectionKey: 'financials', detail: `${c.name}: ${c.detail}` });
  }
  // 7. 缺口披露：coverage.gaps 必须进 sources 章（组装保证）；此处仅记数
  const gaps = pack?.coverage.gaps ?? [];
  if (gaps.length === 0) findings.push({ code: 'GAPS_EMPTY', severity: 'ADVISORY', sectionKey: 'sources', detail: '缺口清单为空：请确认数据面确实无缺口（通常应至少有一致预期缺失）' });
  // 8. 〔C3/R0〕程序清单可重导出复算（机械抽取哈希必须与 A 产物重导出一致）
  if (ctx.aFinal && ctx.checklist) {
    const groups = ANALYZE_GROUPS.map((g) => ctx.analyze.get(g.key)).filter((x): x is AnalyzeOutput => Boolean(x));
    const rederived = deriveSrChecklist(groups, ctx.aFinal);
    if (rederived.checklistHash !== ctx.checklist.checklistHash) {
      findings.push({ code: 'CHECKLIST_NOT_REDERIVABLE', severity: 'BLOCKING', sectionKey: null, detail: `程序清单哈希不可由 A 产物重导出复算（存 ${ctx.checklist.checklistHash.slice(0, 8)} vs 复算 ${rederived.checklistHash.slice(0, 8)}）` });
    }
  } else if (!ctx.aFinal || !ctx.checklist) {
    findings.push({ code: 'CHAIN_STRUCTURE_MISSING', severity: 'BLOCKING', sectionKey: null, detail: 'A 终稿或程序清单缺失（Metis 继承链不完整）' });
  }
  // 9a. 〔C4 对抗收口〕A 终稿决定性连接必须绑定真实存在的证据/计算表（编造 tableId 不允许静默进入裁决链）
  if (ctx.aFinal) {
    const known = new Set([
      ...(pack?.tables.map((t) => t.tableId) ?? []),
      ...(computed?.tables.map((t) => t.tableId) ?? []),
    ]);
    for (const l of ctx.aFinal.decisiveLinks) {
      if (!known.has(l.tableId)) {
        findings.push({ code: 'DECISIVE_LINK_TABLE_UNKNOWN', severity: 'BLOCKING', sectionKey: null, detail: `A 决定性连接绑定未知表 ${l.tableId}（证据缺失——按阻断处理，不得发布完整报告）` });
      }
    }
  }
  // 9. J 全覆盖（validator 已强制；此处复核计数）与承重未知项处置非空
  if (ctx.checklist && ctx.judge) {
    const ids = new Set(ctx.checklist.items.map((i) => i.checklistId));
    const judged = new Set(ctx.judge.verdicts.map((v) => v.checklistId));
    if (ids.size !== judged.size || [...ids].some((i) => !judged.has(i))) {
      findings.push({ code: 'JUDGE_NOT_EXHAUSTIVE', severity: 'BLOCKING', sectionKey: null, detail: 'J 裁决未全覆盖程序清单' });
    }
    const unresolvedIds = ctx.judge.verdicts.filter((v) => v.verdict === 'UNRESOLVED').map((v) => v.checklistId);
    const handled = new Set(ctx.judge.unresolvedDisposition.map((u) => u.checklistId));
    const unhandled = unresolvedIds.filter((i) => !handled.has(i));
    if (unhandled.length > 0) {
      findings.push({ code: 'UNRESOLVED_UNHANDLED', severity: 'BLOCKING', sectionKey: null, detail: `承重未解项未具名处置：${unhandled.join('、')}` });
    }
  } else if (!ctx.judge) {
    findings.push({ code: 'JUDGE_MISSING', severity: 'BLOCKING', sectionKey: null, detail: '必经 J 裁决缺失（报告不得发布）' });
  }
  return findings;
}

/** 〔C4/R0d〕裁决落实到正文：J 驳回/收窄/未解逐项写回章节 findings——驳回内容降为已否定审计记录，不再以"已证事实"呈现。 */
export function applyVerdictsToSections(
  sections: ReportSection[],
  checklist: SrChecklist | undefined,
  judge: JOutput | undefined,
): ReportSection[] {
  if (!checklist || !judge) return sections;
  const verdictById = new Map(judge.verdicts.map((v) => [v.checklistId, v]));
  const dispById = new Map(judge.unresolvedDisposition.map((u) => [u.checklistId, u.handling]));
  return sections.map((sec) => {
    if (sec.key === 'sources') return sec;
    const findings = sec.findings.map((f, idx) => {
      const id = `sr-fnd:${sec.key}:${idx + 1}`;
      const v = verdictById.get(id);
      if (!v) return f;
      if (v.verdict === 'REJECTED') {
        return { ...f, status: 'REJECTED' as const, text: `${f.text}〔J 驳回：${v.correction ?? '与送达证据不符'}——原文仅作已否定审计记录保留〕` };
      }
      if (v.verdict === 'NARROWED') {
        return { ...f, text: `${f.text}〔J 收窄：${v.correction ?? '适用范围受限'}〕` };
      }
      if (v.verdict === 'UNRESOLVED') {
        return { ...f, status: 'HYPOTHESIS' as const, text: `${f.text}〔J 未解：${dispById.get(id) ?? '保留为承重未知项'}〕` };
      }
      return f;
    });
    // 〔C5/C4-02〕驳回纠正 + 〔C7/C6-02〕收窄范围均写入本章 narrative 头部：
    // A 原文保留但过宽/被否的表述先被声明约束——用户先读到的就是裁决后有效范围。
    let narrative = sec.narrative;
    const pairs = findings
      .map((f, idx) => ({ f, v: verdictById.get(`sr-fnd:${sec.key}:${idx + 1}`) }))
      .filter((x) => x.v?.verdict === 'REJECTED' || x.v?.verdict === 'NARROWED');
    const rejectedHere = pairs.filter((x) => x.v?.verdict === 'REJECTED');
    const narrowedHere = pairs.filter((x) => x.v?.verdict === 'NARROWED');
    const head: string[] = [];
    if (rejectedHere.length > 0) {
      head.push(`以下 A 原文判断已被 J 驳回，当前有效判断以本声明与各条目标注为准：\n${rejectedHere
        .map((x) => `- 「${x.f.text.slice(0, 60)}${x.f.text.length > 60 ? '…' : ''}」已驳回——J 纠正：${x.v!.correction ?? '与送达证据不符'}；下文 A 原文中的相应表述仅作已否定历史记录保留，不构成当前判断`)
        .join('\n')}`);
    }
    if (narrowedHere.length > 0) {
      head.push(`以下判断的适用范围已被 J 收窄，收窄后的有效范围以此处为准；下文 A 原文中更宽的表述仅作改判前历史记录保留：\n${narrowedHere
        .map((x) => `- 「${x.f.text.slice(0, 60)}${x.f.text.length > 60 ? '…' : ''}」收窄为——${x.v!.correction ?? '适用范围受限（见条目标注）'}`)
        .join('\n')}`);
    }
    if (head.length > 0) {
      narrative = `**〔J 裁决修正——本章先行声明〕**\n${head.join('\n\n')}\n\n---\n${sec.narrative}`;
    }
    return { ...sec, findings, narrative };
  });
}

/** 〔C6/C5-02〕摘要头部声明：驳回（已否定内容）或改判（旧结论=历史）任一存在即触发——
 * 两者都使 A 摘要原文不再是"当前结论"，必须先行标注，不允许无标记旧结论与 J 终局并陈。 */
export function summaryCorrectionHeader(judge: JOutput | undefined, checklist: SrChecklist | undefined): string {
  if (!judge || !checklist) return '';
  const rejected = judge.verdicts.filter((v) => v.verdict === 'REJECTED');
  const changed = judge.conclusionRuling.changedFromA;
  if (rejected.length === 0 && !changed) return '';
  const parts: string[] = [];
  if (rejected.length > 0) {
    const items = rejected.map((v) => {
      const it = checklist.items.find((i) => i.checklistId === v.checklistId);
      return `- ${v.checklistId}（${it?.text.slice(0, 50) ?? ''}${(it?.text.length ?? 0) > 50 ? '…' : ''}）：${v.correction ?? '与送达证据不符'}`;
    }).join('\n');
    parts.push(`已被 J 驳回的判断（原文仅作已否定历史记录保留）：\n${items}`);
  }
  if (changed) {
    parts.push(`**J 已改判**——以下 A 摘要原文为改判前判断，仅作历史记录保留；当前有效结论以文末"J 终局结论"为准（改判理由：${judge.conclusionRuling.changeReason ?? '见风险章'}）`);
  }
  return `**〔J 裁决修正声明〕** ${parts.join('\n\n')}\n\n---\n`;
}

// ===== 发布门（Metis 发布门继承；assemble 与任务终态共用） =====

export function evaluatePublishGate(ctx: RunContext): { gate: import('./contracts.js').ReportPublishGate; gatePassed: boolean } {
  // 〔C6/C5-01〕承重与否只信 J 的声明——该声明已经过 validateJOutput 的完整校验
  //（承重必带理由+证据命中；非承重必带结构化剩余依据且引用有效）。不再用 A 原分类
  // 覆盖合法的非承重裁决（合法非承重未解项与有效结论并存，保留为 limitation）。
  const judge = ctx.judge;
  const decisionBearingUnresolved = judge
    ? judge.verdicts.filter((v) => v.verdict === 'UNRESOLVED' && v.decisionBearing).map((v) => {
        const item = ctx.checklist?.items.find((i) => i.checklistId === v.checklistId);
        return `${v.checklistId}：${item?.text.slice(0, 60) ?? ''}`;
      })
    : [];
  // 〔C4/R0c〕同一份有效裁定：QA BLOCKING 检查同样阻断完整发布（受限产物保留并展示原因）
  const qaBlocking = (ctx.qa ?? []).filter((f) => f.severity === 'BLOCKING');
  const gatePassed = Boolean(judge) && decisionBearingUnresolved.length === 0 && qaBlocking.length === 0;
  const gate = {
    mandatoryJDone: Boolean(judge),
    decisionBearingUnresolved,
    passed: gatePassed,
    reason: !judge
      ? '必经 J 裁决未完成：报告不得按完整形态发布'
      : decisionBearingUnresolved.length > 0
        ? `发布门未过：${decisionBearingUnresolved.length} 项承重未解项（程序承重下限+模型声明合并判定；具名展示，结论按受限形态发布）`
        : qaBlocking.length > 0
          ? `发布门未过：${qaBlocking.length} 项 BLOCKING 质检错误（${qaBlocking.map((f) => f.code).join('、')}）；报告按受限形态发布`
          : 'J 裁决完成、无承重未解项且质检无阻断：允许发布',
  };
  return { gate, gatePassed };
}

// ===== 报告组装 =====

function generatedBy(ctx: RunContext): ReportDocument['generatedBy'] {
  return ctx.deps.transport.describe().simulated ? 'PRODUCT_SIMULATED' : 'PRODUCT_REAL';
}

async function assembleReport(ctx: RunContext, step: SrStep): Promise<ReportDocument> {
  const { deps, task } = ctx;
  const version = 1; // 实际版本在持有任务行锁的 insertAssembledReport 中确定
  const reportId = randomUUID();
  const sections: ReportSection[] = [];

  // 〔C3〕发布门评估（共用函数）
  const judge = ctx.judge;
  const aFinal = ctx.aFinal!;
  const { gate, gatePassed } = evaluatePublishGate(ctx);
  // 〔C3〕证据绑定四哈希（对齐 Metis ConclusionEvidence；QA/QA 区展示可核验）
  const aSections = ANALYZE_GROUPS.flatMap((g) => ctx.analyze.get(g.key)?.sections ?? []);
  const evidenceRefs = {
    packHash: ctx.pack?.packHash ?? '(缺失)',
    aOutputHash: canonicalSha256({ sections: aSections, aFinal }),
    checklistHash: ctx.checklist?.checklistHash ?? '(缺失)',
    jOutputHash: judge ? canonicalSha256(judge) : '(J 未完成)',
    artifacts: reportArtifacts(await listSteps(deps.srPool, task.taskId), step.stepId),
  };

  // summary（A 摘要 + J 终局对齐——〔C4/R0d〕摘要不得先于裁决呈现旧结论）
  const synth = ctx.synth;
  const finalConclusion = judge ? judge.conclusionRuling.finalConclusion : aFinal.conclusion;
  const jr = judge?.conclusionRuling;
  sections.push({
    key: 'summary',
    title: SECTION_TITLES.summary,
    narrative:
      `${summaryCorrectionHeader(judge, ctx.checklist)}${synth ? synth.narrative : aFinal.narrative}\n\n**J 终局结论**：${finalConclusion}` +
      `${jr?.changedFromA ? `（已改判，理由：${jr.changeReason}）` : ''}\n\n条件：${(jr?.conditions ?? aFinal.conclusionConditions).join('；')}`,
    findings: (synth ? synth.findings : aFinal.conclusionConditions.map((c) => ({ text: c, status: 'HYPOTHESIS' as const }))).map((f) => ({ text: f.text, status: f.status, citations: [] as string[] })),
    tables: [],
    citations: [],
    gaps: aFinal.gaps,
  });
  // 分析章节（保序输出）
  for (const g of ANALYZE_GROUPS) {
    const out = ctx.analyze.get(g.key);
    if (!out) continue;
    for (const s of out.sections) {
      if (!REPORT_SECTIONS.includes(s.key as (typeof REPORT_SECTIONS)[number])) continue;
      sections.push({
        key: s.key as ReportSection['key'],
        title: SECTION_TITLES[s.key as ReportSection['key']] ?? s.key,
        narrative: s.narrative,
        findings: s.findings.map((f) => ({ text: f.text, status: f.status, citations: f.citations.map((i) => `C${i + 1}`) })),
        tables: s.tables,
        citations: out.citations.map((c) => ({ label: c.label, locator: { kind: 'COMPUTED' as const, tableId: c.tableId } })),
        gaps: s.gaps,
        ...(s.scenarios ? { scenarios: s.scenarios } : {}),
      });
    }
  }
  // 〔C4/R0d〕裁决写回正文（驳回/收窄/未解标注），再进入风险章融合
  const applied = applyVerdictsToSections(sections, ctx.checklist, judge);
  sections.length = 0;
  sections.push(...applied);

  // risk 章融合综合结论（反证必答）
  const riskIdx = sections.findIndex((s) => s.key === 'risk');
  const risk = sections[riskIdx];
  if (riskIdx >= 0 && risk) {
    const jr = judge?.conclusionRuling;
    sections[riskIdx] = {
      ...risk,
      narrative:
        `${risk.narrative}\n\n**A 候选结论**：${aFinal.conclusion}\n\n` +
        `**J 终局判断（有条件、有期限${jr?.changedFromA ? '；已改判，理由见下' : ''}）**：${finalConclusion}\n\n` +
        `条件与期限：\n${(jr?.conditions ?? aFinal.conclusionConditions).map((c) => `- ${c}`).join('\n')}\n\n` +
        (jr?.changedFromA ? `**改判理由**：${jr.changeReason}\n\n` : '') +
        `**最强反方解释（J 已正面裁决）**：${aFinal.strongestCounter}\n\n` +
        (judge && judge.verdicts.some((v) => v.verdict === 'REJECTED')
          ? `**被 J 驳回的判断**（正文对应条目已降为已否定记录）：${judge.verdicts.filter((v) => v.verdict === 'REJECTED').map((v) => `${v.checklistId}（${v.correction ?? ''}）`).join('；')}\n\n`
          : '') +
        (judge && judge.verdicts.some((v) => v.verdict === 'NARROWED')
          ? `**被 J 收窄的判断**：${judge.verdicts.filter((v) => v.verdict === 'NARROWED').map((v) => `${v.checklistId}（${v.correction ?? '适用范围受限'}）`).join('；')}\n\n`
          : '') +
        (judge && judge.verdicts.some((v) => v.verdict === 'UNRESOLVED' && !v.decisionBearing)
          ? `**非承重未解项（J 依据校验通过，保留为 limitation，不阻断结论）**：${judge.verdicts.filter((v) => v.verdict === 'UNRESOLVED' && !v.decisionBearing).map((v) => `${v.checklistId}（依据：${((v.remainingBasis as { refs: string[] } | null)?.refs ?? []).join('、')}）`).join('；')}\n\n`
          : '') +
        `**改变结论的新证据（催化）**：\n${aFinal.catalysts.map((c) => `- ${c}`).join('\n')}`,
    };
  }
  // sources（确定性生成）
  const cov = ctx.pack?.coverage;
  const genNote =
    generatedBy(ctx) === 'PRODUCT_SIMULATED'
      ? '本报告由模拟研究通道在真实证据数据上生成，用于工程链与产品流程验证，不构成研究结论。'
      : '本报告由产品研究链生成（个人研究记录，非投资建议）。';
  const verdictSummary = judge
    ? `J 裁决：共 ${judge.verdicts.length} 项——SUPPORTED ${judge.verdicts.filter((v) => v.verdict === 'SUPPORTED').length}、` +
      `NARROWED ${judge.verdicts.filter((v) => v.verdict === 'NARROWED').length}、` +
      `REJECTED ${judge.verdicts.filter((v) => v.verdict === 'REJECTED').length}、` +
      `UNRESOLVED ${judge.verdicts.filter((v) => v.verdict === 'UNRESOLVED').length}。`
    : '';
  sections.push({
    key: 'sources',
    title: SECTION_TITLES.sources,
    narrative:
      `${genNote}\n\n资料截点：${task.cutoff}；方法版本 ${task.methodVersion}。\n\n` +
      `研究链：A 分节分析 + A 终稿 → 程序清单（${ctx.checklist?.items.length ?? 0} 项，机械抽取）→ 必经 J 裁决 → 发布门${gate.passed ? '（通过）' : '（未过——受限发布）'}。\n\n` +
      `${verdictSummary}\n\n` +
      `证据绑定（可整链核验）：证据包 ${evidenceRefs.packHash.slice(0, 16)}… / A 输出 ${evidenceRefs.aOutputHash.slice(0, 16)}… / 清单 ${evidenceRefs.checklistHash.slice(0, 16)}… / J 输出 ${evidenceRefs.jOutputHash.slice(0, 16)}…。\n\n` +
      `数据面：财务 ${cov?.financials.periods ?? 0} 期（最新 ${cov?.financials.latestPeriod ?? '无'}）、` +
      `日线 ${cov?.bars.count ?? 0} 根（至 ${cov?.bars.lastDate ?? '无'}）、公告 ${cov?.announcements.count ?? 0} 条、` +
      `两融 ${cov?.margin.count ?? 0} 条。\n\n研究边界：公开资料研究；财务口径以 BaoStock 季频（累计口径，单季为程序拆分）为准；` +
      `行业归属按申万分类时点版本。一致预期数据不可得，全文无冒称。`,
    findings: [],
    tables: (ctx.pack?.tables ?? []).map((t) => t.tableId).concat((ctx.computed?.tables ?? []).map((t) => t.tableId)),
    citations: [],
    gaps: cov?.gaps ?? [],
  });

  const base = {
    reportId,
    taskId: task.taskId,
    version,
    status: (gate.passed ? 'PUBLISHED' : 'PUBLISHED_RESTRICTED') as ReportDocument['status'],
    subject: task.subject,
    subjectName: task.subjectName,
    focus: task.focus,
    horizon: task.horizon,
    cutoff: task.cutoff,
    methodVersion: task.methodVersion,
    adapterVersion: task.adapterVersion,
    planAuthVersion: task.planAuthVersion,
    generatedBy: generatedBy(ctx),
    sections,
    qaFindings: ctx.qa ?? [],
    evidenceRefs,
    gate,
    changeSummary: task.revisedFromTaskId ? '修订版（关联原任务）' : null,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    publishedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await loadReportMaterials(deps.outputDir, signReport(base));
  return insertAssembledReport(deps.srPool, base, deps.lease);
}

/** 报告的 markdown 归档形态（与网页/PDF 同源）。 */
export function renderReportMarkdown(report: ReportDocument, ctx: { pack?: EvidencePack; computed?: ComputeResult }): string {
  const lines: string[] = [];
  lines.push(`# ${report.subjectName}（${report.subject}）单股研究报告 v${report.version}`);
  lines.push('');
  lines.push(`> 资料截点 ${report.cutoff} · 研究重点 ${report.focus} · 生成身份 ${report.generatedBy}`);
  lines.push('');
  for (const s of report.sections) {
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.narrative);
    if (s.findings.length) {
      lines.push('');
      for (const f of s.findings) {
        const tag = f.status === 'FACT' ? '已证事实' : f.status === 'INFERENCE' ? '推断' : f.status === 'REJECTED' ? 'J 驳回（已否定记录）' : '待验证';
        lines.push(`- 【${tag}】${f.text}`);
      }
    }
    if (s.scenarios?.length) {
      lines.push('');
      lines.push('| 情景 | 触发条件 | 含义 |');
      lines.push('|---|---|---|');
      for (const sc of s.scenarios) lines.push(`| ${sc.name} | ${sc.condition} | ${sc.implication} |`);
    }
    if (s.gaps.length) {
      lines.push('');
      lines.push(`缺口：${s.gaps.join('；')}`);
    }
    lines.push('');
  }
  const tablesById = new Map([
    ...(ctx.pack?.tables ?? []).map((t) => [t.tableId, t] as const),
    ...(ctx.computed?.tables ?? []).map((t) => [t.tableId, t] as const),
  ]);
  lines.push('## 附：计算与证据表');
  for (const t of tablesById.values()) {
    lines.push('');
    lines.push(`### ${t.title}（${t.tableId}）`);
    lines.push(`公式/口径：${'formula' in t ? t.formula : (t.unitNote ?? '证据表')}`);
    lines.push(`| ${t.columns.join(' | ')} |`);
    lines.push(`| ${t.columns.map(() => '---').join(' | ')} |`);
    for (const r of t.rows) lines.push(`| ${r.map((c) => (c === null ? '—' : String(c))).join(' | ')} |`);
  }
  if (report.qaFindings.length) {
    lines.push('');
    lines.push('## 质量检查结果');
    for (const f of report.qaFindings) lines.push(`- [${f.severity}] ${f.code}: ${f.detail}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('个人研究记录，非投资建议。');
  return lines.join('\n');
}

// ===== 主入口：执行/续跑一个任务 =====

export interface SrTaskRunResult {
  task: SrTask;
  report: ReportDocument | null;
}

const runningTasks = new WeakMap<SrEngineDeps['srPool'], Map<string, Promise<SrTaskRunResult>>>();
export async function runSrTask(deps: SrEngineDeps, taskId: string): Promise<SrTaskRunResult> {
  let tasks = runningTasks.get(deps.srPool);
  if (!tasks) { tasks = new Map(); runningTasks.set(deps.srPool, tasks); }
  const old = tasks.get(taskId);
  if (old) return old;
  const promise = withExecutionLease(deps.srPool, 'sr', ({ lease }) => runSrTaskOwned({ ...deps, lease }, taskId), { lease: deps.lease });
  tasks.set(taskId, promise);
  try { return await promise; } finally { tasks.delete(taskId); }
}

async function runSrTaskOwned(deps: SrEngineDeps, taskId: string): Promise<SrTaskRunResult> {
  const task = await getTask(deps.srPool, taskId);
  if (!task) throw new KernelError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
  // FAILED 可续跑（中断恢复只续未完成步骤；已完成模型步骤复用落盘输出，零重发）。
  if (['COMPLETED', 'PARTIAL', 'CANCELLED'].includes(task.status)) {
    const report = await getLatestReportForTask(deps.srPool, taskId);
    if (report) await loadReportMaterials(deps.outputDir, report);
    return { task, report: report ?? null };
  }
  let claimed = false;
  try {
    await claimSrTask(deps.srPool, deps.lease!, taskId);
    claimed = true;
    const steps = await ensureSrSteps(deps.srPool, deps.lease!, taskId, plannedSteps());
    const ctx: RunContext = { deps, task, analyze: new Map() };
    for (const step of steps) {
      if (step.status === 'SUCCEEDED') {
        if (['PLAN','ANALYZE','A_FINAL','SYNTHESIZE','JUDGE'].includes(step.stepKind)) await verifyCompletedModel(deps, step);
        // 只读首次绑定的 CAS 产物；工作目录缺失/覆盖不改变恢复材料。
        if (step.stepKind === 'EVIDENCE') ctx.pack = (await readStepOutput<{ pack: EvidencePack }>(deps, step)).pack;
        if (step.stepKind === 'COMPUTE') ctx.computed = (await readStepOutput<{ computed: ComputeResult }>(deps, step)).computed;
        if (step.stepKind === 'PLAN') { ctx.plan = await reloadPlan(deps, taskId, step); ctx.pack = await initialEvidence(deps, taskId); }
        if (step.stepKind === 'ANALYZE' && step.sectionKey) ctx.analyze.set(step.sectionKey, await reloadAnalyze(deps, taskId, step));
        if (step.stepKind === 'SYNTHESIZE' || step.stepKind === 'A_FINAL') ctx.aFinal = await reloadAFinal(deps, taskId, step);
        if (step.stepKind === 'CHECKLIST') ctx.checklist = await readStepOutput<SrChecklist>(deps, step);
        if (step.stepKind === 'JUDGE') ctx.judge = await reloadJudge(deps, taskId, step);
        if (step.stepKind === 'QA_CHECK') {
          ctx.qa = (await readStepOutput<{ findings: ReportQaFinding[] }>(deps, step)).findings;
        }
        continue;
      }
      if (step.status === 'SKIPPED') continue;
      try {
        await runOneStep(ctx, step);
      } catch (err) {
        // 〔C3/R2〕同输入不得以新 stepId 自动重发：send-once 拒绝即如实失败。
        // 恢复路径只有两类——(a) 从未发送（sent_at null）的调用原位替换（permit 语义自带）；
        // (b) 显式新研究/修订任务（新任务身份 + 新授权记录）。不存在引擎内自动重采样。
        if (err instanceof KernelError && err.code === 'BUSINESS_KEY_ALREADY_SENT') {
          const call = await srFindCallByStep(deps.srPool, taskId, step.stepId);
          const stateNote = call ? call.state : '未知';
          const sentNote = call?.sentAt ? '已发送' : '未发送';
          throw new KernelError(
            'SENT_CHAIN_BLOCKED',
            `步骤 ${step.stepKind} 的既有调用处于已发送链（state=${stateNote}，${sentNote}）：` +
            `一次发送语义禁止同输入换 ID 重发（R2）。恢复选项：读回/打捞原尝试产物；或由用户显式发起修订（新任务新授权）。`,
          );
        }
        throw err;
      }
      ctx.task = await getTask(deps.srPool, taskId) ?? ctx.task;
    }
    const blocking = (ctx.qa ?? []).filter((f) => f.severity === 'BLOCKING').length;
    const gateEval = evaluatePublishGate(ctx);
    const gateBlocked = !gateEval.gatePassed; // 〔C4/R0c〕单一有效裁定：QA 阻断已并入发布门
    const finalTask = await updateOwnedTask(deps, taskId, {
      status: blocking > 0 || gateBlocked ? 'PARTIAL' : 'COMPLETED',
      error: gateBlocked
        ? { code: 'PUBLISH_GATE_BLOCKED', message: gateEval.gate.reason }
        : blocking > 0
          ? { code: 'QA_BLOCKING_FINDINGS', message: `${blocking} 项 BLOCKING 质检发现（报告保留，见质检区）` }
          : null,
      completed: true,
    });
    const report = await getLatestReportForTask(deps.srPool, taskId);
    return { task: finalTask, report: report ?? null };
  } catch (err) {
    if (!claimed || (err instanceof KernelError && ['EXECUTION_LOCK_HELD','EXECUTION_LEASE_REQUIRED','RECOVERY_CONFIRM_REQUIRED'].includes(err.code))) throw err;
    const code = err instanceof KernelError ? err.code : 'STEP_FAILED';
    const message = err instanceof Error ? err.message : String(err);
    const failedTask = await updateOwnedTask(deps, taskId, {
      status: 'FAILED',
      error: { code, message: message.slice(0, 1000) },
      completed: true,
    });
    return { task: failedTask, report: null };
  }
}

async function verifyCompletedModel(deps: SrEngineDeps, step: SrStep): Promise<void> {
  const row = (await deps.srPool.query<{ input_checkpoint: SrInputCheckpoint | null; input_checkpoint_hash: string | null }>(
    'select input_checkpoint,input_checkpoint_hash from sr_step where step_id=$1::uuid', [step.stepId])).rows[0];
  const frozen = row?.input_checkpoint;
  if (!frozen || row!.input_checkpoint_hash !== canonicalSha256(frozen) || frozen.contract.taskId !== step.taskId ||
      frozen.contract.stepId !== step.stepId || canonicalSha256(frozen.transport) !== canonicalSha256(deps.transport.describe(frozen.modelStep))) {
    throw new KernelError('SR_CHECKPOINT_MISSING', 'Completed model step lacks a matching original request');
  }
  const result = await restoreSrResponse(deps.srPool, frozen);
  const value = await readStepOutput<{ inputJson: string; input: unknown; output: unknown }>(deps, step);
  if (!result) throw new KernelError('SR_CHECKPOINT_CONFLICT', 'Completed model step has no original successful call');
  assertSrModelArtifact(frozen, value, result.output);
  switch (frozen.modelStep) {
    case 'PLAN': validatePlanOutput(result.output); break;
    case 'ANALYZE': validateAnalyzeOutput(result.output, frozen.input as AnalyzeInput); break;
    case 'A_FINAL': validateAFinalOutput(result.output); break;
    case 'SYNTHESIZE': validateSynthOutput(result.output); break;
    case 'JUDGE': {
      const input = frozen.input as JInput;
      validateJOutput(result.output, input.checklist.items.map((x) => x.checklistId),
        { deliveredTableIds: input.evidenceBundle.map((x) => x.tableId), aConclusion: input.aFinal.conclusion }); break;
    }
  }
}

async function reloadPlan(deps: SrEngineDeps, taskId: string, step: SrStep): Promise<PlanOutput> {
  const v = await readStepOutput<{ output: PlanOutput }>(deps, step);
  return v.output;
}
async function reloadAnalyze(deps: SrEngineDeps, taskId: string, step: SrStep): Promise<AnalyzeOutput> {
  const v = await readStepOutput<{ output: AnalyzeOutput }>(deps, step);
  return v.output;
}
async function reloadSynth(deps: SrEngineDeps, taskId: string, step: SrStep): Promise<SynthOutput> {
  const v = await readStepOutput<{ output: SynthOutput }>(deps, step);
  return v.output;
}
async function reloadAFinal(deps: SrEngineDeps, taskId: string, step: SrStep): Promise<AFinalOutput> {
  const v = await readStepOutput<{ output: AFinalOutput }>(deps, step);
  return v.output;
}
async function reloadJudge(deps: SrEngineDeps, taskId: string, step: SrStep): Promise<JOutput> {
  const v = await readStepOutput<{ output: JOutput }>(deps, step);
  return v.output;
}
// ===== 追问（CHAT_ANSWER 步骤 + 调用）=====

export interface AskOptions {
  requestKey?: string;
  quotaLimit?: number;
  taskId: string;
  reportVersion: number;
  question: string;
  questionKind: ChatMessage['kind'];
  pack?: EvidencePack; // 兼容调用者：如提供，必须与绑定原件逐字相符
  computed?: ComputeResult;
}

export async function askReportQuestion(
  deps: SrEngineDeps,
  accountId: string,
  opts: AskOptions,
): Promise<ChatMessage> {
  const task = await getTask(deps.srPool, opts.taskId, accountId);
  if (!task) throw new KernelError('TASK_NOT_FOUND', `任务不存在或无权访问：${opts.taskId}`);
  const report = await getReportByTaskAndVersion(deps.srPool, opts.taskId, opts.reportVersion);
  if (!report) throw new KernelError('REPORT_NOT_FOUND', `报告不存在：${opts.taskId}/v${opts.reportVersion}`);

  const { pack, computed } = await loadReportMaterials(deps.outputDir, report);
  if ((opts.pack && canonicalSha256(opts.pack) !== canonicalSha256(pack)) ||
      (opts.computed && canonicalSha256(opts.computed) !== canonicalSha256(computed))) {
    throw new KernelError('SR_ARTIFACT_BINDING_MISMATCH', '追问材料不属于所选报告版本');
  }
  const kind = opts.questionKind !== 'OTHER' ? opts.questionKind : classifyQuestion(opts.question);
  const tablesForQuestion = selectTablesForQuestion(pack, computed, opts.question, kind);
  const input: ChatInput = {
    question: opts.question,
    questionKind: kind,
    subject: task.subject,
    cutoff: report.cutoff,
    reportIdentity: { reportId: report.reportId, version: report.version, contentHash: report.contentHash },
    reportExcerpt: report.sections.slice(0, 4).map((s) => ({ sectionKey: s.key, narrative: s.narrative.slice(0, 400), tables: s.tables })),
    tables: tablesForQuestion.map((t) => {
      const body = { tableId: t.tableId, title: t.title, columns: t.columns, rows: t.rows.slice(-30),
        kind: ('formula' in t ? 'COMPUTED' : 'EVIDENCE') as 'COMPUTED' | 'EVIDENCE',
        locators: t.locators.length === t.rows.length ? t.locators.slice(-30) : t.locators };
      return { ...body, tableHash: canonicalSha256(body) };
    }),
  };
  const inputJson = JSON.stringify(input, null, 1);
  const { request, step } = await beginChatRequest(deps.srPool, { accountId, report, question: opts.question, kind, input,
    ...(opts.requestKey === undefined ? {} : { key: opts.requestKey }), ...(opts.quotaLimit === undefined ? {} : { quotaLimit: opts.quotaLimit }) });
  let active = questionRuns.get(deps.srPool);
  if (!active) { active = new Map(); questionRuns.set(deps.srPool, active); }
  const runKey = `${accountId}:${request.request_key}`;
  const running = active.get(runKey);
  if (running) return running;
  const work = (async () => {
  const originalCall = await srFindCallByStep(deps.srPool, task.taskId, step.stepId);
  if (originalCall?.state === 'SENT' || originalCall?.state === 'UNKNOWN') throw new KernelError(
    originalCall.state === 'SENT' ? 'REQUEST_PENDING' : 'REQUEST_UNKNOWN', `Original request ${request.request_key}: ${originalCall.state}; no resend`);
  let saved: { permit: SrCallPermit; output: unknown } | null = null;
  if (originalCall?.state === 'SUCCEEDED') {
    const row = (await deps.srPool.query<{ input_checkpoint: SrInputCheckpoint; input_checkpoint_hash: string }>(
      'select input_checkpoint,input_checkpoint_hash from sr_step where step_id=$1::uuid', [step.stepId])).rows[0];
    if (!row?.input_checkpoint || row.input_checkpoint_hash !== canonicalSha256(row.input_checkpoint) ||
        canonicalSha256(row.input_checkpoint.input) !== canonicalSha256(input) || row.input_checkpoint.modelStep !== 'CHAT_ANSWER') throw new KernelError('SR_CHECKPOINT_CONFLICT');
    saved = await restoreSrResponse(deps.srPool, row.input_checkpoint);
    if (request.state === 'SUCCEEDED') {
      const verified = await verifiedChatMessages(deps.srPool, deps.outputDir, report, request.thread_id!);
      const message = verified.messages.find((m) => m.messageId === request.response_message_id);
      if (!saved || !message || message.callId !== saved.permit.callId) throw new KernelError('SR_CHAT_UNBOUND');
      return message;
    }
  }
  return withExecutionLease(deps.srPool, 'sr', async ({ lease }) => {
    const owned = { ...deps, lease };
    try {
      if (step.status !== 'SUCCEEDED') await updateOwnedStep(owned, step.stepId, { status: 'RUNNING', started: true });
      const archive = async (output: ReturnType<typeof validateChatOutput>, permit: SrCallPermit) => {
        await fencedSrWrite(deps.srPool, lease, (tx) => saveStepArtifact(tx, deps.outputDir, step, { inputJson, input, output, callId: permit.callId }));
      };
      const result = saved ? { permit: saved.permit, output: validateChatOutput(saved.output, input) } : await callSrModel(owned, {
        contract: { taskId: task.taskId, stepId: step.stepId, methodVersion: task.methodVersion,
          planAuthVersion: deps.budget.planAuthVersion,
          deadline: new Date((deps.now?.() ?? new Date()).getTime() + SR_CALL_WINDOW_MS).toISOString() },
        modelStep: 'CHAT_ANSWER', input, validate: (v) => validateChatOutput(v, input),
        afterValidated: archive,
      });
      const out = result.output;
      if (saved) await archive(out, result.permit);
      return await completeChatRequest(deps.srPool, lease, request, {
        threadId: request.thread_id!, role: 'ASSISTANT', kind, content: out.answer,
        citations: chatCitations(input, out), callId: result.permit.callId, suggestedAction: out.suggestedAction ?? null,
      });
    } catch (err) {
      await recordRequestFailure(deps.srPool, lease, request, err);
      const call = await srFindCallByStep(deps.srPool, task.taskId, step.stepId);
      if (call?.state !== 'SENT' && call?.state !== 'SUCCEEDED') {
        await updateOwnedStep(owned, step.stepId, { status: 'FAILED', note: (err instanceof Error ? err.message : String(err)).slice(0, 500), finished: true });
      }
      throw err;
    }
  }, { lease: deps.lease });
  })();
  active.set(runKey, work);
  try { return await work; } finally { active.delete(runKey); }
}

const questionRuns = new WeakMap<SrEngineDeps['srPool'], Map<string, Promise<ChatMessage>>>();

export function classifyQuestion(q: string): ChatMessage['kind'] {
  const s = q.toLowerCase();
  if (/更新|最新|截点|新数据|财报后/.test(s)) return 'NEW_CUTOFF';
  if (/为什么质疑|不对|反驳|错了|反例/.test(s)) return 'CHALLENGE';
  if (/假设|如果|换成|调整/.test(s)) return 'ADJUST_ASSUMPTION';
  if (/缺|没有数据|哪里找|看不到/.test(s)) return 'MISSING_DATA';
  if (/什么意思|解释|怎么理解|是什么/.test(s)) return 'EXPLAIN';
  return 'OTHER';
}

function selectTablesForQuestion(pack: EvidencePack, computed: ComputeResult, q: string, kind: ChatMessage['kind']): (EvidencePack['tables'][number] | ComputeResult['tables'][number])[] {
  const all = [...pack.tables, ...computed.tables] as (EvidencePack['tables'][number] | ComputeResult['tables'][number])[];
  if (kind === 'NEW_CUTOFF') return [];
  const hits = all.filter((t) => q.includes(t.tableId.split('-')[0] ?? '') || t.title.split('').some((ch) => q.includes(ch) && ch !== ' '));
  if (hits.length > 0) return hits.slice(0, 3);
  return [...computed.tables.slice(0, 2), ...pack.tables.filter((t) => t.tableId.includes('fin')).slice(0, 1)];
}

// 供 server 使用的 sha 暴露（报告内容指纹在 store.insertReport 内计算）
export { canonicalSha256 };
