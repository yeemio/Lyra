/**
 * Lyra · Gate-M 周度研究执行器（真实模型门，W22: code-writer-pro）。
 * 依据：R27（A=Sol/high、J=Sol/high、复用 codex 通道、2 次调用上限、失败即停不重采样）、
 * docs/specs/P2-RESEARCH.md Done-when 5、delivery/GATE-M-APPLICATION.md。
 *
 * 两模式：
 *   - 干跑（execute:false，CLI 缺省）：组装真实输入包 → 渲染 A prompt（方法正文 +
 *     分层渲染 + coverage 声明 + 输出 schema 说明）→ J prompt 用确定性模拟 A 输出
 *     估算字节数（明确标注 simulated-a-estimate，非模型调用、不落库）→ SolTransport
 *     argv/prompt 预览（不 spawn）→ 预算检查（真实字节数 vs 授权上限）。零 permit、
 *     零模型调用、零 spawn。
 *   - 真跑（execute:true，CLI 须 --execute 显式）：assembleResearchInput →
 *     runModelCall(A) → 解析 → deriveChecklist → runModelCall(J) → 解析 →
 *     persistConclusion → buildReportView/renderReportText。模型调用恰 2 次（授权额度），
 *     全部经 kernel（permit/send-once/截止纪律自动生效）；任一环失败即停，无重试。
 *
 * 预算闸（EK-4.4）：contract.inputBytes 用 prompt 真实 UTF-8 字节数（不是包字节数）——
 * 真实模型的输入就是 prompt 本身；preparePermit 据此做超预算阻断。
 */
import type { Pool } from 'pg';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import {
  KernelError,
  validDispositions,
  type AOutput,
  type ConclusionObject,
  type JOutput,
  type ModelPermit,
  type PlanAuthBudget,
  type ProgramChecklist,
  type SubjectKind,
} from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { runModelCall } from '../kernel/executor.js';
import type { ModelTransport } from '../kernel/transport.js';
import {
  SolTransport,
  aOutputWireSchema,
  jOutputWireSchema,
  type SolInvocationPlan,
  type SolTransportConfig,
} from '../kernel/sol-transport.js';
import { A_INSTRUCTIONS, J_DUTIES, METHOD_P2_VERSION } from '../method/text.js';
import { persistConclusion } from '../db/conclusion.js';
import {
  assembleResearchInput,
  renderInputLayers,
  validateResearchInputPackage,
  type AssembledResearchInput,
  type AssembleVersions,
  type InputBudget,
  type LayerBlockView,
  type PackageValidationSummary,
  type ResearchInputPackage,
} from './inputs.js';
import { deriveChecklist, type DimensionCoveragePkg } from './checklist.js';
import { simulatedModelA } from './simulated.js';
import { buildReportView, renderReportText, type ReportView } from './report.js';

// ===== Gate-M 冻结缺省（R27 / GATE-M-APPLICATION）=====

/** 授权输入上限：≤1.2MB/次（十进制口径 1,200,000 字节，两种 MB 读法下都满足）。 */
export const GATE_M_MAX_INPUT_BYTES = 1_200_000;
/** 授权调用数：共 2 次（A+J、1 只标的），不设追加。 */
export const GATE_M_MAX_MODEL_CALLS = 2;
/** 每次调用执行窗 60 分钟（EK-6.1：显式计算，不从模板继承）。 */
export const GATE_M_CALL_WINDOW_MS = 60 * 60 * 1000;

/** Gate-M 计划授权预算（type 约束 maxInFlight 字面 2；A/J 顺序执行，实际并发 1）。 */
export const GATE_M_PLAN_BUDGET: PlanAuthBudget = {
  planAuthVersion: 'pa-gate-m-1',
  maxModelCallsPerWeek: GATE_M_MAX_MODEL_CALLS,
  maxInputBytes: GATE_M_MAX_INPUT_BYTES,
  maxInFlight: 2,
};

/** Gate-M 版本轴（方法 = 冻结正文；数据 = P1 面；授权 = Gate-M 单）。 */
export const GATE_M_VERSIONS: AssembleVersions = {
  methodVersion: METHOD_P2_VERSION,
  adapterVersion: 'data@p1',
  planAuthVersion: GATE_M_PLAN_BUDGET.planAuthVersion,
};

/** 输入分层预算（L1/L2 在授权 1.2MB 内取宽裕值，实际用量以干跑回执为准）。 */
export const GATE_M_INPUT_BUDGET: InputBudget = {
  l0Bytes: 20_000,
  l1Bytes: 400_000,
  l2Bytes: 500_000,
  totalBytes: 900_000,
};

export interface GateMDeps {
  /** 材料读取与封存写入库（生产 public：事实 + seal_manifest）。 */
  dataPool: Pool;
  /** 执行内核与结论落库库（exec_permit + conclusion；真跑写入，干跑只读不用）。 */
  execPool: Pool;
  store: ArtifactStore;
  /** 真跑的模型通道（SolTransport；干跑不触碰）。 */
  transport: ModelTransport;
}

export interface GateMOptions {
  subject: string;
  /** 缺省 STOCK；宽基须显式 BROAD_ETF。 */
  subjectKind?: SubjectKind;
  /** 资料截点（ISO；CLI 缺省 = 最近收盘日 15:00+08）。 */
  cutoff: string;
  /** 缺省 false（干跑）；真跑必须显式 true。 */
  execute?: boolean;
  budget?: PlanAuthBudget;
  versions?: AssembleVersions;
  inputBudget?: InputBudget;
  /** 执行权持有者（EK-2.1 可选防御层；真跑建议传）。 */
  holderId?: string;
  /** 执行截止（EK-6.1：显式给定优先；缺省 = 每次调用发起时刻 + 60 分钟）。 */
  deadline?: string;
  /** 干跑是否跑样本包程序校验（缺省 true，只读）。 */
  validatePackage?: boolean;
  /** argv/prompt 预览用的 Sol 配置（预览实例恒 dryRun，绝不 spawn）。 */
  solTransportConfig?: Partial<SolTransportConfig>;
  poolInfoFile?: string;
  /** 打捞路径（R28 缺陷处置）：复用一次已发生的真实 A 调用产物（final.txt 路径）。校验 inputHash 绑定后跳过 A 的 permit 调用，仅执行 J——A 的历史 FAILED permit 保留不改，输出作为与输入绑定的真实模型产物使用。 */
  aFrom?: string;
}

export interface GateMPrompts {
  aPrompt: string;
  aPromptBytes: number;
  jPrompt: string;
  jPromptBytes: number;
  /** real-a-output = 真跑（J prompt 绑定实际 A 输出）；simulated-a-estimate = 干跑估算。 */
  jPromptBasis: 'real-a-output' | 'simulated-a-estimate';
}

export interface GateMBudgetCheck {
  maxInputBytes: number;
  a: { bytes: number; pass: boolean };
  j: { bytes: number; pass: boolean; basis: GateMPrompts['jPromptBasis'] };
  pass: boolean;
}

export type GateMOutcome =
  | {
      mode: 'dry-run';
      assembled: AssembledResearchInput;
      validation: PackageValidationSummary | null;
      prompts: GateMPrompts;
      previews: { a: SolInvocationPlan; j: SolInvocationPlan };
      budgetCheck: GateMBudgetCheck;
    }
  | {
      mode: 'execute';
      assembled: AssembledResearchInput;
      validation: PackageValidationSummary | null;
      prompts: GateMPrompts;
      permits: { a: ModelPermit | null; aSalvagedFrom?: string; j: ModelPermit };
      conclusion: ConclusionObject;
      reportView: ReportView;
      reportText: string;
    };

// ===== prompt 渲染 =====

const SECTION = '='.repeat(72);

function renderBlock(layer: 'L0' | 'L1' | 'L2', block: LayerBlockView): string {
  return `### [${layer}] ${block.materialId} · ${block.title}（${String(block.bytes)} 字节）\n${canonicalJsonString(block.payload)}`;
}

function renderCoverage(pkg: ResearchInputPackage): string {
  const lines = [
    'coverage 声明（RM §5：送达/降级/缺口三态。被降级材料只作为限制进入 limitations，不得假装读过；缺口不得当作无风险）',
  ];
  for (const d of pkg.dimensions) {
    const demoted = d.demoted.length > 0 ? ` [${d.demoted.join(', ')}]` : '';
    const gaps = d.gap.length > 0 ? `：${d.gap.join('；')}` : '';
    lines.push(
      `- 维度${d.dimension} ${d.code}（${d.name}）：送达 ${d.delivered.length} 件 [${d.delivered.join(', ')}]；降级 ${d.demoted.length} 件${demoted}；缺口 ${d.gap.length} 条${gaps}`,
    );
  }
  const { l0, l1, l2 } = pkg.layers;
  lines.push(
    `分层字节（canonical JSON UTF-8 真实字节）：L0 ${l0.bytes}/${l0.budget} · L1 ${l1.bytes}/${l1.budget} · L2 ${l2.bytes}/${l2.budget}`,
  );
  return lines.join('\n');
}

/** A prompt：方法正文 A_INSTRUCTIONS 全文 + 分层渲染（L0+L1 文本 + L2 目录）+ coverage + 输出 schema 说明。 */
export function renderAPrompt(pkg: ResearchInputPackage): string {
  const view = renderInputLayers(pkg);
  const space = validDispositions(pkg.businessKey.subjectKind);
  return [
    A_INSTRUCTIONS,
    SECTION,
    '研究输入（本轮封存、按分层实际送达；证据引用只能指向 L2 索引目录中出现的事实与原件）',
    '',
    '—— L0（背景，不可裁剪）——',
    ...view.l0.map((b) => renderBlock('L0', b)),
    '',
    '—— L1（会改变判断的证据）——',
    ...view.l1.map((b) => renderBlock('L1', b)),
    '',
    '—— L2（索引目录）——',
    ...view.l2.map((b) => renderBlock('L2', b)),
    '',
    SECTION,
    renderCoverage(pkg),
    SECTION,
    [
      '输出要求（结构有效性由程序校验，缺任一项即结构无效，本轮无有效 A）',
      '- 只输出一个 JSON 对象：无 markdown 代码围栏、无前后解释文字；',
      `- 绑定字段：inputHash 必须原样回抄本值 required_input_hash = "${pkg.inputHash}"；`,
      `- candidate 只能取自本标的（${pkg.businessKey.subjectKind}）选项空间：${space.join(' / ')}（跨类无效，R18）；`,
      '- decisiveLinks 至少 2 条；每条 evidenceArtifactSha256 必须是本轮 L2 索引 deliveredFacts[].artifactSha256 或封存 seals[].artifactRefs[].sha256 中实际出现的 64 位十六进制原件哈希；',
      '- simulated 是通道自声明字段（R28）：本调用为真实模型通道，输出 false；',
      '- 完整形状（JSON Schema，逐字段约束，字段集封闭不得增删）：',
      JSON.stringify(aOutputWireSchema(pkg.businessKey.subjectKind), null, 1),
    ].join('\n'),
  ].join('\n');
}

/** J prompt：J_DUTIES 全文 + A 输出全文 + 清单全文 + 输入绑定 + 输出 schema 说明。 */
export function renderJPrompt(
  subjectKind: SubjectKind,
  aOutput: AOutput,
  checklist: ProgramChecklist,
  jInputHash: string,
): string {
  const space = validDispositions(subjectKind);
  return [
    J_DUTIES,
    SECTION,
    'A 输出全文（本轮分析者输出；程序已按其机械抽取下列清单）',
    canonicalJsonString(aOutput),
    SECTION,
    '程序清单全文（程序机械抽取，程序无独立意见；你必须逐项裁决恰好一次）',
    canonicalJsonString(checklist),
    SECTION,
    [
      '输入绑定与输出要求（结构有效性由程序校验）',
      `- required_input_hash = "${jInputHash}"；输出 inputHash 字段必须原样回抄该值，不回抄或回抄不一致即输出无效；`,
      '- 只输出一个 JSON 对象：无 markdown 代码围栏、无前后解释文字；',
      `- verdicts 必须恰好覆盖清单全部 checklistId 各一次（清单共 ${checklist.items.length} 项：${checklist.items.map((i) => i.checklistId).join(', ')}），不得跳项、合并或重复；`,
      `- finalDisposition 只能取自本标的（${subjectKind}）选项空间：${space.join(' / ')}（跨类无效，R18）；`,
      '- changedFromA 为 true 时 changeReason 必填非空；',
      '- simulated 是通道自声明字段（R28）：本调用为真实模型通道，输出 false；',
      '- 完整形状（JSON Schema，逐字段约束，字段集封闭不得增删）：',
      JSON.stringify(jOutputWireSchema(subjectKind), null, 1),
    ].join('\n'),
  ].join('\n');
}

// ===== prompt 组装（干跑与真跑共用）=====

export interface GateMPromptBundle {
  assembled: AssembledResearchInput;
  aPrompt: string;
  aPromptBytes: number;
}

/** 组装真实输入包 + 渲染 A prompt（组装器/校验器复用，W11 既有公开 API）。 */
export async function buildGateMPrompts(
  deps: Pick<GateMDeps, 'dataPool' | 'store'>,
  opts: GateMOptions,
): Promise<GateMPromptBundle> {
  const subjectKind: SubjectKind = opts.subjectKind ?? 'STOCK';
  const assembled = await assembleResearchInput(deps.dataPool, deps.store, {
    subjectKind,
    subject: opts.subject,
    cutoff: opts.cutoff,
    budget: opts.inputBudget ?? GATE_M_INPUT_BUDGET,
    versions: opts.versions ?? GATE_M_VERSIONS,
    ...(opts.poolInfoFile === undefined ? {} : { poolInfoFile: opts.poolInfoFile }),
  });
  const aPrompt = renderAPrompt(assembled.package);
  return { assembled, aPrompt, aPromptBytes: Buffer.byteLength(aPrompt, 'utf8') };
}

/** 干跑的 J prompt 估算：确定性模拟 A（同 inputHash 同输出）→ 机械清单 → J 渲染。
 * 仅供字节数/argv 预览，不落库、不 dispatch、不产生 permit——非模型调用。 */
function estimateJPrompt(
  pkg: ResearchInputPackage,
): { jPrompt: string; jPromptBytes: number; jInputHash: string; checklist: ProgramChecklist } {
  const material = {
    artifactSha256s: pkg.seals.flatMap((s) => s.artifactRefs.map((r) => r.sha256)).slice(0, 12),
    factCount: pkg.seals.reduce((n, s) => n + s.factIds.length, 0),
    gaps: pkg.dimensions.flatMap((c) => c.gap),
  };
  const simulatedA = simulatedModelA({
    inputHash: pkg.inputHash,
    subjectKind: pkg.businessKey.subjectKind,
    subject: pkg.businessKey.subject,
    material,
  });
  const checklist = deriveChecklist(simulatedA, pkg.seals[0]?.manifestHash ?? '00'.repeat(32));
  const jInputHash = canonicalSha256({ a: simulatedA, checklist });
  const jPrompt = renderJPrompt(pkg.businessKey.subjectKind, simulatedA, checklist, jInputHash);
  return { jPrompt, jPromptBytes: Buffer.byteLength(jPrompt, 'utf8'), jInputHash, checklist };
}

function budgetCheckOf(prompts: GateMPrompts, maxInputBytes: number): GateMBudgetCheck {
  const a = { bytes: prompts.aPromptBytes, pass: prompts.aPromptBytes <= maxInputBytes };
  const j = { bytes: prompts.jPromptBytes, pass: prompts.jPromptBytes <= maxInputBytes, basis: prompts.jPromptBasis };
  return { maxInputBytes, a, j, pass: a.pass && j.pass };
}

// ===== 执行器 =====

/**
 * Gate-M 主入口。execute:false → 干跑（零 permit/零模型/零 spawn）；
 * execute:true → 真跑：恰 A+J 两次 runModelCall（额度 2），失败即停不重采样，
 * 结论落库并渲染报告。任何一步具名抛错（KernelError/组装器错误原样上抛）。
 */

/** 包维度覆盖 → 清单维度覆盖参数（W25 接线：维度名用中文名以匹配 A 论述提及）。 */
function coveragePkgOf(pkg: ResearchInputPackage): DimensionCoveragePkg {
  return { dimensions: pkg.dimensions.map((d) => ({ dimension: d.name, deliveredCount: d.delivered.length, gap: d.gap })) };
}

export async function runGateM(deps: GateMDeps, opts: GateMOptions): Promise<GateMOutcome> {
  const subjectKind: SubjectKind = opts.subjectKind ?? 'STOCK';
  const budget = opts.budget ?? GATE_M_PLAN_BUDGET;
  const versions = opts.versions ?? GATE_M_VERSIONS;

  // 1) 组装 + A prompt（真实数据；组装器自带分层预算闸与 coverage）。
  const bundle = await buildGateMPrompts(deps, { ...opts, subjectKind });
  const { assembled, aPrompt, aPromptBytes } = bundle;
  const pkg = assembled.package;
  const businessKey = pkg.businessKey; // 组装器规范化后的业务键（send-once 键）

  // 2) 样本包程序校验（缺省开；只读，花授权前先证完整性）。
  const validation = opts.validatePackage === false
    ? null
    : await validateResearchInputPackage(deps.dataPool, deps.store, pkg);

  const deadlineOf = (): string =>
    opts.deadline ?? new Date(Date.now() + GATE_M_CALL_WINDOW_MS).toISOString();

  if (opts.execute !== true) {
    // ---- 干跑：J 估算 + argv 预览 + 预算检查；零 permit、零模型、零 spawn ----
    const jEstimate = estimateJPrompt(pkg);
    const prompts: GateMPrompts = {
      aPrompt,
      aPromptBytes,
      jPrompt: jEstimate.jPrompt,
      jPromptBytes: jEstimate.jPromptBytes,
      jPromptBasis: 'simulated-a-estimate',
    };
    const previewTransport = new SolTransport({ ...opts.solTransportConfig, dryRun: true });
    const previews = {
      a: await previewTransport.preview(
        { businessKey, stage: 'A', inputHash: assembled.inputHash, inputBytes: aPromptBytes, methodVersion: versions.methodVersion, planAuthVersion: budget.planAuthVersion, deadline: deadlineOf() },
        { inputHash: assembled.inputHash, subjectKind, prompt: aPrompt },
      ),
      j: await previewTransport.preview(
        { businessKey, stage: 'J', inputHash: jEstimate.jInputHash, inputBytes: jEstimate.jPromptBytes, methodVersion: versions.methodVersion, planAuthVersion: budget.planAuthVersion, deadline: deadlineOf() },
        { inputHash: jEstimate.jInputHash, subjectKind, prompt: jEstimate.jPrompt, expectedChecklistIds: jEstimate.checklist.items.map((i) => i.checklistId) },
      ),
    };
    return {
      mode: 'dry-run',
      assembled,
      validation,
      prompts,
      previews,
      budgetCheck: budgetCheckOf(prompts, budget.maxInputBytes),
    };
  }

  // ---- 真跑：恰两次模型调用（授权 2；任一环失败即停，无重试）----
  if (opts.aFrom !== undefined) {
    // 打捞（R28 缺陷处置）：复用已发生的真实 A 产物；inputHash 强绑定；不再产生 A permit。
    const { readFile } = await import('node:fs/promises');
    const salvaged = JSON.parse(await readFile(opts.aFrom, 'utf8')) as AOutput;
    if (salvaged.stage !== 'A' || salvaged.subjectKind !== subjectKind) throw new KernelError('SALVAGE_A_UNBOUND', '打捞 A 的 stage/subjectKind 不符');
    // 材料绑定证明（v2，强于 prompt 比对）：从 seal_manifest 取回 A 产物当时的原始封存（不可变行），
    // 校验打捞 A 的全部证据哈希 ⊆ 原始封存原件集；结论绑定原始 manifest；当前组装仅作报告展示。
    const stamp = opts.aFrom.match(/sol-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (stamp === null) throw new KernelError('SALVAGE_A_UNBOUND', 'aFrom 路径无法解析 invocation 时间戳');
    const invAt = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`;
    const sealRows = await deps.dataPool.query(
      `select seal_id, business_key, cutoff, artifact_refs, fact_ids, gaps, method_version, adapter_version, plan_auth_version, created_at, manifest_hash
         from seal_manifest
        where business_key->>'subject' = $1 and business_key->>'researchKind' = 'WEEKLY' and business_key->>'subjectKind' = $2
          and cutoff = $3 and created_at <= $4::timestamptz
        order by created_at asc limit 2`,
      [businessKey.subject, subjectKind, businessKey.cutoff, invAt],
    );
    if (sealRows.rows.length < 1) throw new KernelError('SALVAGE_A_UNBOUND', '未找到 A 产物当时的原始封存');
    type SealRow = { seal_id: string; business_key: unknown; cutoff: Date; artifact_refs: unknown; fact_ids: unknown; gaps: unknown; method_version: string; adapter_version: string; plan_auth_version: string; created_at: Date; manifest_hash: string };
    const toManifest = (r: SealRow) => ({
      sealId: r.seal_id, businessKey: JSON.parse(JSON.stringify(r.business_key)), cutoff: new Date(r.cutoff).toISOString(),
      artifactRefs: JSON.parse(JSON.stringify(r.artifact_refs)), factIds: JSON.parse(JSON.stringify(r.fact_ids)),
      gaps: JSON.parse(JSON.stringify(r.gaps)), methodVersion: r.method_version, adapterVersion: r.adapter_version,
      planAuthVersion: r.plan_auth_version, createdAt: new Date(r.created_at).toISOString(), manifestHash: r.manifest_hash,
    });
    const originalSeals = sealRows.rows.map((r) => toManifest(r as SealRow));
    const originalManifest = originalSeals[0]!;
    const originalArtifactSet = new Set(originalSeals.flatMap((seal) => seal.artifactRefs.map((r: { sha256: string }) => r.sha256)));
    const unboundEvidence = salvaged.decisiveLinks.map((l) => l.evidenceArtifactSha256).filter((h) => !originalArtifactSet.has(h));
    if (unboundEvidence.length > 0) throw new KernelError('SALVAGE_A_UNBOUND', `打捞 A 存在原始封存之外证据：${unboundEvidence.join(',').slice(0, 120)}`);
    if (!validDispositions(subjectKind).includes(salvaged.candidate)) throw new KernelError('SALVAGE_A_UNBOUND', `打捞 A 候选越界：${salvaged.candidate}`);
    if (!Array.isArray(salvaged.decisiveLinks) || salvaged.decisiveLinks.length < 2) throw new KernelError('SALVAGE_A_UNBOUND', '打捞 A 决定性连接不足 2 条');
    const manifest0 = originalManifest;
    const checklist0 = deriveChecklist(salvaged, manifest0.manifestHash, coveragePkgOf(pkg));
    const jInputHash0 = canonicalSha256({ a: salvaged, checklist: checklist0 });
    const jPrompt0 = renderJPrompt(subjectKind, salvaged, checklist0, jInputHash0);
    const j0 = await runModelCall<JOutput>(deps.execPool, {
      contract: { businessKey, stage: 'J', inputHash: jInputHash0, inputBytes: Buffer.byteLength(jPrompt0, 'utf8'), methodVersion: versions.methodVersion, planAuthVersion: budget.planAuthVersion, deadline: deadlineOf() },
      budget,
      modelFn: async (ctx) => (await deps.transport.dispatch(ctx.contract, { inputHash: jInputHash0, subjectKind, prompt: jPrompt0, expectedChecklistIds: checklist0.items.map((i) => i.checklistId) })) as JOutput,
      simulated: deps.transport.describe().simulated,
      ...(opts.holderId === undefined ? {} : { holderId: opts.holderId }),
    });
    const conclusion0 = await persistConclusion(deps.execPool, {
      businessKey,
      methodVersion: versions.methodVersion, adapterVersion: versions.adapterVersion, planAuthVersion: budget.planAuthVersion,
      aOutput: salvaged, checklist: checklist0, jOutput: j0.output, manifest: manifest0,
      checklistCoverage: coveragePkgOf(pkg),
      inheritance: null, changeReason: j0.output.changedFromA ? j0.output.changeReason : null,
    });
    const reportView0 = buildReportView(conclusion0, pkg, salvaged, checklist0, j0.output);
    return { mode: 'execute', assembled, validation, prompts: { aPrompt, aPromptBytes, jPrompt: jPrompt0, jPromptBytes: Buffer.byteLength(jPrompt0, 'utf8'), jPromptBasis: 'real-a-output' }, permits: { a: null, aSalvagedFrom: opts.aFrom, j: j0.permit }, conclusion: conclusion0, reportView: reportView0, reportText: renderReportText(reportView0) };
  }
  // A：contract.inputBytes = prompt 真实字节数（预算闸 EK-4.4 用真实口径）。
  const a = await runModelCall<AOutput>(deps.execPool, {
    contract: {
      businessKey,
      stage: 'A',
      inputHash: assembled.inputHash,
      inputBytes: aPromptBytes,
      methodVersion: versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline: deadlineOf(),
    },
    budget,
    modelFn: async (ctx) =>
      (await deps.transport.dispatch(ctx.contract, { inputHash: assembled.inputHash, subjectKind, prompt: aPrompt })) as AOutput,
    simulated: deps.transport.describe().simulated,
    ...(opts.holderId === undefined ? {} : { holderId: opts.holderId }),
  });

  // 程序清单（无模型机械抽取；绑定真实封存 manifest）。
  const manifest = pkg.seals[0];
  if (manifest === undefined) throw new KernelError('SEAL_MISSING', '输入包无封存 manifest');
  const checklist = deriveChecklist(a.output, manifest.manifestHash, coveragePkgOf(pkg));
  const jInputHash = canonicalSha256({ a: a.output, checklist });

  // J：prompt = J_DUTIES + A 输出全文 + 清单全文 + 绑定与 schema 说明。
  const jPrompt = renderJPrompt(subjectKind, a.output, checklist, jInputHash);
  const jPromptBytes = Buffer.byteLength(jPrompt, 'utf8');
  const j = await runModelCall<JOutput>(deps.execPool, {
    contract: {
      businessKey,
      stage: 'J',
      inputHash: jInputHash,
      inputBytes: jPromptBytes,
      methodVersion: versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline: deadlineOf(),
    },
    budget,
    modelFn: async (ctx) =>
      (await deps.transport.dispatch(ctx.contract, {
        inputHash: jInputHash,
        subjectKind,
        prompt: jPrompt,
        expectedChecklistIds: checklist.items.map((i) => i.checklistId),
      })) as JOutput,
    simulated: deps.transport.describe().simulated,
    ...(opts.holderId === undefined ? {} : { holderId: opts.holderId }),
  });

  // 结论落库（STANDALONE 周度；J 改判 A 候选时 changeReason 必填由构造器校验）。
  const conclusion = await persistConclusion(deps.execPool, {
    businessKey,
    methodVersion: versions.methodVersion,
    adapterVersion: versions.adapterVersion,
    planAuthVersion: budget.planAuthVersion,
    aOutput: a.output,
    checklist,
    jOutput: j.output,
    manifest,
    checklistCoverage: coveragePkgOf(pkg),
    inheritance: null,
    changeReason: j.output.changedFromA ? j.output.changeReason : null,
  });
  const reportView = buildReportView(conclusion, pkg, a.output, checklist, j.output);

  return {
    mode: 'execute',
    assembled,
    validation,
    prompts: { aPrompt, aPromptBytes, jPrompt, jPromptBytes, jPromptBasis: 'real-a-output' },
    permits: { a: a.permit, j: j.permit },
    conclusion,
    reportView,
    reportText: renderReportText(reportView),
  };
}

// ===== CLI =====
//
// 用法：
//   node --import tsx src/research/gate-m.ts --subject 600519 [--cutoff <iso>] [--kind STOCK|BROAD_ETF]
//        [--execute] [--holder <id>] [--schema <execSchema>] [--out <dir>] [--binary <codex 路径>]
//
// 缺省干跑：组装真实输入包（会向 public.seal_manifest 追加真实封存与包原件，不可变数据，
// 与 W11 样本同模式）→ 打印 prompt 字节数（A/J）、argv 预览、输入包校验、预算检查。
// --execute 显式真跑（2 次授权模型调用）→ 打印报告全文（人工审阅件）。
// 退出码：0 成功；1 用法错误；2 执行/校验失败。

async function latestClosedCutoff(pool: Pool, subject: string): Promise<string> {
  const res = await pool.query<{ d: string | null }>(
    `select max((typed_value->>'date')::text) as d from pintime_fact
     where subject_id = $1 and fact_kind = 'DAILY_BAR'`,
    [subject],
  );
  const d = res.rows[0]?.d;
  if (d === null || d === undefined) {
    throw new Error(`库内无 ${subject} 的 DAILY_BAR 事实，无法推定最近收盘截点；请 --cutoff 显式给定`);
  }
  return new Date(`${d}T15:00:00+08:00`).toISOString();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const subject = flag('--subject');
  if (subject === undefined) {
    console.error('用法：node --import tsx src/research/gate-m.ts --subject <code> [--cutoff <iso>] [--kind STOCK|BROAD_ETF] [--execute] [--holder <id>] [--schema <s>] [--out <dir>] [--binary <path>]');
    process.exit(1);
  }
  const kindArg = flag('--kind');
  if (kindArg !== undefined && kindArg !== 'STOCK' && kindArg !== 'BROAD_ETF') {
    console.error(`--kind 须为 STOCK 或 BROAD_ETF：${kindArg}`);
    process.exit(1);
  }
  const execute = argv.includes('--execute');
  const aFrom = flag('--a-from');
  const outDir = flag('--out');
  const binaryArg = flag('--binary');
  const schemaArg = flag('--schema');
  const holderArg = flag('--holder');
  const dataPool = (await import('../db/pool.js')).createPool();
  const execPool = (await import('../db/pool.js')).createPool(schemaArg === undefined ? undefined : { schema: schemaArg });
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const store = new ArtifactStore(process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts'));
  const cutoffArg = flag('--cutoff');
  try {
    const cutoff = cutoffArg ?? (await latestClosedCutoff(dataPool, subject));
    console.log(`[gate-m] 模式 ${execute ? 'EXECUTE（真跑，2 次授权调用）' : 'DRY-RUN（零模型调用、零 spawn）'} · 标的 ${kindArg ?? 'STOCK'} ${subject} · 截点 ${cutoff}`);
    const outcome = await runGateM(
      {
        dataPool,
        execPool,
        store,
        transport: new SolTransport(binaryArg === undefined ? {} : { binary: binaryArg }),
      },
      {
        subject,
        ...(kindArg === undefined ? {} : { subjectKind: kindArg }),
        cutoff,
        execute,
        ...(aFrom === undefined ? {} : { aFrom }),
        ...(holderArg === undefined ? {} : { holderId: holderArg }),
      },
    );
    const { assembled, validation, prompts } = outcome;
    console.log(
      `[gate-m] 输入包 inputHash=${assembled.inputHash.slice(0, 16)}… 包原件=${assembled.artifactRef.sha256.slice(0, 16)}…（${String(assembled.artifactRef.bytes)} 字节）`,
    );
    if (validation !== null) {
      console.log(
        `[gate-m] 包校验 ok：facts=${String(validation.factsChecked)} barRows=${String(validation.barRowsChecked)} artifacts=${String(validation.artifactsChecked)} dimensions=${String(validation.dimensions)}`,
      );
    } else {
      console.log('[gate-m] 包校验：跳过（validatePackage=false）');
    }
    console.log(
      `[gate-m] prompt 字节：A=${String(prompts.aPromptBytes)} · J=${String(prompts.jPromptBytes)}（${prompts.jPromptBasis}）`,
    );
    if (outcome.mode === 'dry-run') {
      const { previews, budgetCheck } = outcome;
      console.log(`[gate-m] 预算检查（上限 ${String(budgetCheck.maxInputBytes)} 字节）：A ${budgetCheck.a.pass ? 'PASS' : 'FAIL'} · J ${budgetCheck.j.pass ? 'PASS' : 'FAIL'}（${budgetCheck.j.basis}）→ ${budgetCheck.pass ? 'PASS' : 'FAIL'}`);
      console.log(`[gate-m] A argv 预览：${previews.a.binary} ${previews.a.argv.join(' ')}`);
      console.log(`[gate-m] J argv 预览：${previews.j.binary} ${previews.j.argv.join(' ')}`);
      console.log(
        `[gate-m] 层字节：L0=${String(assembled.package.layers.l0.bytes)}/${String(assembled.package.layers.l0.budget)} L1=${String(assembled.package.layers.l1.bytes)}/${String(assembled.package.layers.l1.budget)} L2=${String(assembled.package.layers.l2.bytes)}/${String(assembled.package.layers.l2.budget)}`,
      );
      if (outDir !== undefined) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'a-prompt.txt'), prompts.aPrompt, 'utf8');
        await writeFile(join(outDir, 'j-prompt-estimate.txt'), prompts.jPrompt, 'utf8');
        await writeFile(
          join(outDir, 'dry-run-summary.json'),
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            subject,
            subjectKind: kindArg ?? 'STOCK',
            cutoff,
            inputHash: assembled.inputHash,
            inputArtifact: assembled.artifactRef,
            layers: assembled.package.layers,
            dimensions: assembled.package.dimensions,
            validation,
            prompts: { aBytes: prompts.aPromptBytes, jBytes: prompts.jPromptBytes, jBasis: prompts.jPromptBasis },
            budgetCheck,
            previews: {
              a: { argv: previews.a.argv, promptSha256: previews.a.promptSha256, schema: previews.a.schema },
              j: { argv: previews.j.argv, promptSha256: previews.j.promptSha256, schema: previews.j.schema },
            },
          }, null, 2),
          'utf8',
        );
        console.log(`[gate-m] 干跑产物已写入 ${outDir}（a-prompt.txt / j-prompt-estimate.txt / dry-run-summary.json）`);
      }
    } else {
      const { permits, conclusion } = outcome;
      console.log(
        `[gate-m] permit：A=${permits.a === null ? `（打捞自 ${permits.aSalvagedFrom ?? '?'},无新 permit）` : `${permits.a.permitId}（${permits.a.state}${permits.a.failCode === null ? '' : '/' + permits.a.failCode}）`} J=${permits.j.permitId}（${permits.j.state}${permits.j.failCode === null ? '' : '/' + permits.j.failCode}）`,
      );
      console.log(`[gate-m] 结论 ${conclusion.conclusionId} · disposition=${conclusion.disposition}`);
      if (outDir !== undefined) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, `report-${conclusion.conclusionId}.txt`), outcome.reportText, 'utf8');
      }
      console.log(outcome.reportText);
    }
  } catch (error) {
    console.error(`[gate-m] 失败：${String(error).slice(0, 600)}`);
    process.exitCode = 2;
  } finally {
    await dataPool.end().catch(() => {});
    await execPool.end().catch(() => {});
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('research/gate-m.ts');
if (isMain) {
  await main();
}
