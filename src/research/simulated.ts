/**
 * Lyra · 确定性模拟模型（EK-10.1 / EK-11.2）。W3: code-writer-pro。
 *
 * - 同 inputHash 同输出：一切"随机"选择都由 inputHash 的 SHA-256 派生，无时钟、无状态。
 * - A 输出（P0 简化 schema）：候选决策（取自该标的合法选项空间）、决定性连接
 *   （≥2 条，证据引用只指向实际送达材料的原件哈希）、最强反证、信心、限制；
 *   J 输出：逐项 verdict + decisionBearing、finalDisposition、changedFromA/changeReason、
 *   strongestCaseDisposition；两者都回抄 inputHash 并自我声明 simulated:true。
 * - 模拟器不得 bypass permit（EK-3.2/EK-11.2）：模型函数入口守卫——无 permit /
 *   permit 非 SENT → 具名拒绝；阶段或输入哈希与 permit 合同不符 → 具名拒绝。
 * - 故障注入（withFault）：TIMEOUT 返回晚于 deadline；SILENCE_AFTER_SEND 抛内核可识别
 *   的静默故障（runModelCall 判 permit=UNKNOWN）；EXPLICIT_FAIL 显式失败；
 *   INPUT_OVER_BUDGET 由 executor 预算闸在 preparePermit 前置拦截（模型侧若被调用
 *   即闸失效的可观察信号，具名抛出，绝不静默继续）。
 */
import { createHash } from 'node:crypto';
import { canonicalSha256 } from '../canonical.js';
import {
  KernelError,
  validDispositions,
  type AOutput,
  type Disposition,
  type JOutput,
  type PlanAuthBudget,
  type ProgramChecklist,
  type SimFault,
  type SubjectKind,
} from '../contracts.js';
import type { ModelCallContext, ModelFn } from '../kernel/executor.js';
import type { LayeredInputView } from './inputs.js';

export class SimulatedModelError extends Error {
  constructor(readonly code: 'SIMULATED_INPUT_INVALID' | 'CHECKLIST_UNBOUND', detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'SimulatedModelError';
  }
}

const HASH_RE = /^[a-f0-9]{64}$/;

function pick(seed: string, modulo: number): number {
  return createHash('sha256').update(seed, 'utf8').digest().readUInt32BE(0) % modulo;
}

function tag(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== permit 守卫（EK-3.2 结构性强制：模拟器同样不得 bypass permit）=====

/**
 * 模型函数入口守卫：permit 缺失 → PERMIT_REQUIRED；permit 非 SENT →
 * PERMIT_STATE_INVALID（发送尚未发起，模型不得运行）；合同阶段/输入哈希与本次
 * 模型输入不符 → MODEL_INPUT_UNBOUND（模型输出必须绑定本轮 permit）。
 */
export function assertModelCallContext(
  ctx: Partial<ModelCallContext> | null | undefined,
  stage: 'A' | 'J',
  inputHash: string,
): void {
  if (!ctx || !ctx.permit) {
    throw new KernelError('PERMIT_REQUIRED', `模型调用必须携带 permit（EK-3.2）：stage=${stage} 的模拟模型拒绝无 permit 直调`);
  }
  if (ctx.permit.state !== 'SENT') {
    throw new KernelError('PERMIT_STATE_INVALID', `permit 状态 ${ctx.permit.state} 非 SENT：发送尚未实际发起，模型不得运行（EK-3.2）`);
  }
  if (ctx.permit.contract.stage !== stage || ctx.permit.contract.inputHash !== inputHash) {
    throw new KernelError(
      'MODEL_INPUT_UNBOUND',
      `模型输入与 permit 合同不符（contract.stage=${ctx.permit.contract.stage}, contract.inputHash 绑定失败）`,
    );
  }
}

// ===== A（分析者）=====

export interface SimulatedMaterialSummary {
  /** 封存实际送达的原件哈希（证据引用只指向这里，RM §2.1 禁池外引用）。 */
  artifactSha256s: string[];
  factCount: number;
  gaps?: string[];
}

export interface SimulatedAInput {
  inputHash: string;
  subjectKind: SubjectKind;
  subject: string;
  material: SimulatedMaterialSummary;
}

const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const;

/** 确定性模拟 A：同 inputHash 同输出；候选取自该标的合法选项空间（R18）。 */
export function simulatedModelA(input: SimulatedAInput): AOutput {
  if (!HASH_RE.test(input.inputHash)) {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', `inputHash 非 64 位十六进制: ${input.inputHash}`);
  }
  if (input.material.artifactSha256s.length === 0) {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', '材料摘要必须含至少一个原件哈希（证据引用需可指向）');
  }
  for (const sha of input.material.artifactSha256s) {
    if (!HASH_RE.test(sha)) throw new SimulatedModelError('SIMULATED_INPUT_INVALID', `非法原件哈希: ${sha}`);
  }
  const space = validDispositions(input.subjectKind);
  if (space.length === 0) throw new SimulatedModelError('SIMULATED_INPUT_INVALID', `标的类别无选项空间: ${input.subjectKind}`);

  const h1 = pick(`${input.inputHash}:a`, 1_000_000);
  const candidate = space[h1 % space.length] as Disposition;
  const linkCount = 2 + pick(`${input.inputHash}:links`, 2); // 2 或 3 条，恒 ≥2
  const artifacts = input.material.artifactSha256s;
  const decisiveLinks = Array.from({ length: linkCount }, (_, i) => ({
    text: `合成决定性连接${i + 1}：支撑候选 ${candidate} 的前提 ${tag(`${input.inputHash}:link:${i}`)}`,
    evidenceArtifactSha256: artifacts[(h1 + i) % artifacts.length] as string,
  }));
  const limitations = [
    '模拟模型输出（EK-10.1），非真实判断',
    `材料事实数 ${input.material.factCount}`,
    ...(input.material.gaps ?? []).map((g) => `资料缺口：${g}`),
  ];
  return {
    stage: 'A',
    inputHash: input.inputHash,
    subjectKind: input.subjectKind,
    candidate,
    decisiveLinks,
    strongestCounter: `最强反证：与候选 ${candidate} 反方向的合成证据 ${tag(`${input.inputHash}:counter`)}`,
    confidence: CONFIDENCE[pick(`${input.inputHash}:conf`, CONFIDENCE.length)] as AOutput['confidence'],
    limitations,
    simulated: true,
  };
}

// ===== J（裁决者）=====

export interface SimulatedJInput {
  /** 程序对本轮 J 输入整体计算的哈希（RM §2.3 输入哈希回抄）。 */
  inputHash: string;
  subjectKind: SubjectKind;
  aOutput: AOutput;
  checklist: ProgramChecklist;
  researchInput?: LayeredInputView;
}

const VERDICTS = ['SUPPORTED', 'NARROWED', 'REJECTED', 'UNRESOLVED'] as const;
const CASE_DISPOSITIONS = ['ACCEPTED', 'NARROWED', 'REFUTED', 'UNRESOLVED'] as const;

/**
 * 确定性模拟 J：逐项裁决清单恰好一次；至少一项承重（首项恒承重）；承重 UNRESOLVED
 * → finalDisposition=ABSTAIN（RM §2.3 程序校验的模拟侧遵守）；改判必写 changeReason；
 * inputHash 原样回抄。
 */
export function simulatedModelJ(input: SimulatedJInput): JOutput {
  if (!HASH_RE.test(input.inputHash)) {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', `inputHash 非 64 位十六进制: ${input.inputHash}`);
  }
  if (input.aOutput.simulated !== true || input.aOutput.stage !== 'A') {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', 'J 只裁决模拟 A 输出');
  }
  if (input.checklist.items.length === 0) {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', '清单为空：无项可裁决');
  }
  if (canonicalSha256(input.aOutput) !== input.checklist.aOutputHash) {
    throw new SimulatedModelError('CHECKLIST_UNBOUND', '清单未绑定本次 A 输出（aOutputHash 不符）：J 不得裁决他轮清单');
  }
  const verdicts: JOutput['verdicts'] = input.checklist.items.map((item, index) => {
    const verdict = VERDICTS[pick(`${input.inputHash}:v:${item.checklistId}`, VERDICTS.length)] as JOutput['verdicts'][number]['verdict'];
    return {
      checklistId: item.checklistId,
      verdict,
      decisionBearing: index === 0 ? true : pick(`${input.inputHash}:b:${item.checklistId}`, 3) !== 0,
      correction: verdict === 'REJECTED' || verdict === 'NARROWED' ? `J 复核修正条目 ${item.checklistId}（模拟）` : null,
      reason: `模拟逐项复核 ${item.checklistId}，非真实判断`,
      evidenceArtifactSha256s: [...new Set(input.aOutput.decisiveLinks.map((l) => l.evidenceArtifactSha256))],
      remainingBasisChecklistIds: [],
    };
  });
  const bases = verdicts.filter((v) => v.decisionBearing && (v.verdict === 'SUPPORTED' || v.verdict === 'NARROWED'));
  for (const v of verdicts) {
    if (bases.length === 0) v.decisionBearing = true;
    else if (!v.decisionBearing) v.remainingBasisChecklistIds = bases.map((b) => b.checklistId);
  }
  const bearingUnresolved = verdicts.some((v) => v.decisionBearing && v.verdict === 'UNRESOLVED');
  const strongestCaseDisposition = CASE_DISPOSITIONS[pick(`${input.inputHash}:case`, CASE_DISPOSITIONS.length)] as JOutput['strongestCaseDisposition'];
  const hasBasis = input.checklist.items.some((i) => i.category === 'DECISIVE_LINK' && bases.some((v) => v.checklistId === i.checklistId));

  const space = validDispositions(input.subjectKind);
  const candIdx = space.indexOf(input.aOutput.candidate);
  if (candIdx < 0) {
    throw new SimulatedModelError('SIMULATED_INPUT_INVALID', `A 候选 ${input.aOutput.candidate} 不在 ${input.subjectKind} 选项空间`);
  }
  let finalDisposition: Disposition;
  let changedFromA: boolean;
  if (bearingUnresolved || strongestCaseDisposition === 'UNRESOLVED' || !hasBasis) {
    finalDisposition = 'ABSTAIN';
    changedFromA = finalDisposition !== input.aOutput.candidate;
  } else {
    changedFromA = pick(`${input.inputHash}:flip`, 2) === 1;
    finalDisposition = changedFromA
      ? (space[(candIdx + 1 + pick(`${input.inputHash}:flip2`, 2)) % space.length] as Disposition)
      : input.aOutput.candidate;
    changedFromA = finalDisposition !== input.aOutput.candidate;
  }
  return {
    stage: 'J',
    inputHash: input.inputHash,
    finalDisposition,
    verdicts,
    changedFromA,
    changeReason: changedFromA
      ? bearingUnresolved
        ? '承重项 UNRESOLVED，按裁决规则 ABSTAIN（模拟）'
        : 'J 复核后改判 A 候选（模拟理由）'
      : input.researchInput?.l0.some((b) => b.materialId === 'mat:0:post-event-context')
        ? '模拟比较已送达的原判断/条件和新增事件后维持 A（非真实判断）' : null,
    strongestCaseDisposition,
    limitations: ['模拟模型 J 裁决（EK-10.1），非真实判断', ...verdicts.filter((v) => v.verdict === 'UNRESOLVED').map((v) => `${v.checklistId}：模拟未解项`) ],
    simulated: true,
  };
}

// ===== ModelFn 包装（经 runModelCall 注入，入口守卫 permit）=====

export function simulatedModelAFn(input: SimulatedAInput): ModelFn<AOutput> {
  return async (ctx) => {
    assertModelCallContext(ctx, 'A', input.inputHash);
    return simulatedModelA(input);
  };
}

export function simulatedModelJFn(input: SimulatedJInput): ModelFn<JOutput> {
  return async (ctx) => {
    assertModelCallContext(ctx, 'J', input.inputHash);
    return simulatedModelJ(input);
  };
}

// ===== 故障注入（EK-10.1 场景注入）=====

/** TIMEOUT 故障的过冲量：晚于 deadline 返回（毫秒）。 */
export const FAULT_OVERSHOOT_MS = 150;

/**
 * 故障注入包装器：
 * - TIMEOUT：睡到 deadline 之后再返回——与截止竞速中必输，executor 判 FAILED/DEADLINE_EXCEEDED；
 * - SILENCE_AFTER_SEND：发送后失联——executor 判 permit=UNKNOWN（不自动重采样/退役）；
 * - EXPLICIT_FAIL：远端显式失败——FAILED 具名；
 * - INPUT_OVER_BUDGET：本故障的正确拦截点是 executor 预算闸（preparePermit，EK-4.4/4.5），
 *   调用方须同时把 contract.inputBytes 声明为超预算（oversizedInputBytes）；
 *   模型侧被调用即说明闸失效，具名抛出作为可观察信号。
 */
export function withFault<A>(fn: ModelFn<A>, fault?: SimFault): ModelFn<A> {
  if (fault === undefined) return fn;
  switch (fault) {
    case 'TIMEOUT':
      return async (ctx) => {
        const deadlineMs = Date.parse(ctx.contract.deadline);
        const remain = Number.isNaN(deadlineMs) ? 0 : Math.max(0, deadlineMs - Date.now());
        await sleep(remain + FAULT_OVERSHOOT_MS); // 返回晚于 deadline
        return fn(ctx);
      };
    case 'SILENCE_AFTER_SEND':
      return async () => {
        throw new KernelError('SILENCE_AFTER_SEND', '模拟发送后失联（EK-5.1）：远端结局不可知，本地无证据不改口');
      };
    case 'EXPLICIT_FAIL':
      return async () => {
        throw new KernelError('EXPLICIT_FAIL', '模拟远端显式失败');
      };
    case 'INPUT_OVER_BUDGET':
      return async () => {
        throw new KernelError('INPUT_OVER_BUDGET', '模型侧被调用：预算闸未在 preparePermit 前置拦截（故障注入的可观察信号）');
      };
  }
}

/** 慢模型（并发闸断言用）：延迟 ms 后正常返回。 */
export function withDelay<A>(fn: ModelFn<A>, ms: number): ModelFn<A> {
  return async (ctx) => {
    await sleep(ms);
    return fn(ctx);
  };
}

/** INPUT_OVER_BUDGET 故障的输入声明：超预算 1 字节（具名阻断、不截断）。 */
export function oversizedInputBytes(budget: PlanAuthBudget): number {
  return budget.maxInputBytes + 1;
}
