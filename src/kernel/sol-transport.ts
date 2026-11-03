/**
 * Lyra · Sol 真实通道传输（Gate-M，W22: code-writer-pro）。R27 / GATE-M-APPLICATION：
 * A=Sol/high、J=Sol/high，复用 Metis 的 codex-native 调用机制（只读镜像其最小集），
 * 凭据零接触——本模块不读取、不打印、不复制 ~/.codex 任何内容；子进程继承本进程
 * 环境（默认 CODEX_HOME 生效于 codex CLI 自身），Lyra 仓库不落任何凭据。
 *
 * 镜像范围（Metis packages/transports/src/codex/native.ts，只读参照）：
 *   - argv 构造（buildCodexArgv）：exec --ephemeral --ignore-rules --ignore-user-config
 *     --sandbox read-only --skip-git-repo-check -c model_reasoning_effort="…"
 *     -c web_search="disabled" -c project_doc_max_bytes=0 -m <model> --json --color never
 *     --output-schema <schema.json> --output-last-message <final.txt> '-'（prompt 走 stdin）；
 *   - schema 约束输出：--output-schema 传 JSON Schema 文件（本地另有逐字段形状校验，
 *     二者同构；本地校验是权威——远端约束只是尽力）；
 *   - 超时与终止语义：超时 → 对进程组（detached）SIGTERM → 宽限后 SIGKILL → 兜底收束；
 *     输出字节上限超限同样终止。终局判定 = 退出码 + final.txt 内容（Metis 的
 *     turn 级事件流 / journal / invocation 目录 fence / 二进制哈希钉扎 / permit 回调
 *     不镜像——Lyra 的 permit 纪律在 kernel 层已有，本 transport 只抛错）。
 *
 * 错误纪律（transport 只抛具名 KernelError，FAILED/UNKNOWN 的 permit 终态由
 * kernel/executor.runModelCall 处置；输出校验失败即 FAILED，无任何自动重试）：
 *   MODEL_INPUT_UNBOUND（payload 与调用合同不符）/ SOL_PROMPT_LIMIT_EXCEEDED /
 *   SOL_SPAWN_FAILED / TIMEOUT（transport 自身超窗终止）/ MODEL_OUTPUT_LIMIT_EXCEEDED /
 *   MODEL_PROVIDER_EXIT_NONZERO / MODEL_FINAL_MISSING / MODEL_OUTPUT_INVALID_JSON /
 *   MODEL_OUTPUT_SCHEMA_INVALID。
 *
 * dryRun：构造完整 argv/prompt/schema 预览（路径占位），不 spawn、不写盘——
 * Gate-M 干跑与单测用；config.dryRun=true 时 dispatch 一律只返回预览（防误发真实调用）。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  KernelError,
  validDispositions,
  type AOutput,
  type JOutput,
  type ModelCallContract,
  type SubjectKind,
} from '../contracts.js';
import type { ModelTransport } from './transport.js';

// ===== 冻结缺省（R27：Sol/high；GATE-M-APPLICATION：每次 60 分钟）=====

/** 本机 Codex CLI 二进制（总控亲证路径；可注入覆盖）。 */
export const DEFAULT_CODEX_BINARY = '/Users/yeemio/.nvm/versions/node/v24.18.0/bin/codex';
/** R27 冻结模型：A 与 J 同为 Sol。 */
export const DEFAULT_SOL_MODEL = 'gpt-6.1-sol';
export const DEFAULT_SOL_REASONING_EFFORT = 'high';
/** 每次调用执行窗 60 分钟（GATE-M-APPLICATION）。 */
export const DEFAULT_SOL_TIMEOUT_MS = 60 * 60 * 1000;
/** 通道级 prompt 上限（Metis CODEX_NATIVE_MAX_PROMPT_CHARACTERS 同值）。 */
export const SOL_PROMPT_MAX_CHARACTERS = 1_048_576;
/** 输出字节上限（stdout+stderr 合计；Metis maxOutputBytes 同值缺省）。 */
export const DEFAULT_SOL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** 终止宽限：SIGTERM 后等待毫秒数再 SIGKILL（Metis killGraceMs 同语义）。 */
export const DEFAULT_SOL_KILL_GRACE_MS = 500;
/** 调用证据目录根（argv 里 schema/final/stdout/stderr/prompt 落此，供审计；不删除）。 */
export const DEFAULT_SOL_WORK_DIR_ROOT = 'var/sol-invocations';

const HASH_RE = /^[a-f0-9]{64}$/;

/** Sol 通道 dispatch 载荷：prompt 由调用侧（gate-m）构造——prompt 构造单一来源在研究层。 */
export interface SolDispatchPayload {
  /** 必须等于 contract.inputHash（输入 ↔ 调用合同绑定守卫）。 */
  inputHash: string;
  /** 必须等于 contract.businessKey.subjectKind。 */
  subjectKind: string;
  /** 完整模型 prompt（方法正文 + 渲染输入 + schema 说明）。 */
  prompt: string;
  /** stage=J 时可选：清单 checklistId 全集——输出 verdicts 必须恰好逐项覆盖各一次。 */
  expectedChecklistIds?: string[];
}

export interface SolTransportConfig {
  binary: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs: number;
  /** 调用证据目录根（相对路径相对进程 cwd）。 */
  workDirRoot: string;
  /** true：dispatch 一律只返回预览，绝不 spawn（防误发）。 */
  dryRun: boolean;
  /** spawn 注入点（单测 mock 用；缺省 node:child_process.spawn）。 */
  spawnFn: SpawnFn;
}

/** 真实 spawn 需满足的最小子进程面（node:child_process.spawn 的结构子集）。 */
export interface ChildLike {
  pid: number | null;
  stdin: { end(data?: string): void; on(event: 'error', listener: () => void): void; destroy(): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void; destroy(): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void; destroy(): void };
  once(event: 'error', listener: () => void): void;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  unref(): void;
}

export type SpawnFn = (
  binary: string,
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildLike;

/** 预览/干跑产物：argv + prompt + schema 的完整静态视图（不含任何 fs 副作用）。 */
export interface SolInvocationPlan {
  binary: string;
  argv: string[];
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  stage: 'A' | 'J';
  prompt: string;
  promptBytes: number;
  promptSha256: string;
  /** 本地权威校验所用的 JSON Schema（与 --output-schema 落盘内容同构）。 */
  schema: Record<string, unknown>;
  /** 路径占位说明（真实 dispatch 用一次性调用目录）。 */
  pathPlaceholders: boolean;
}

// ===== argv 构造（Metis buildCodexArgv 语义镜像，去掉 serviceTier/controlledEndpoint）=====

export function buildSolArgv(input: {
  model: string;
  reasoningEffort: string;
  schemaPath: string;
  finalPath: string;
}): string[] {
  const args = [
    'exec', '--ephemeral', '--ignore-rules', '--ignore-user-config',
    '--sandbox', 'read-only', '--skip-git-repo-check',
    '-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    '-c', `web_search=${JSON.stringify('disabled')}`,
    '-c', 'project_doc_max_bytes=0',
    '-m', input.model,
    '--json', '--color', 'never',
    '--output-schema', input.schemaPath,
    '--output-last-message', input.finalPath,
    '-',
  ];
  return args;
}

// ===== 输出 JSON Schema（wire 约束 + 本地权威校验共用形状描述）=====

const hex64 = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;

export function aOutputWireSchema(subjectKind: SubjectKind): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: [
      'stage', 'inputHash', 'subjectKind', 'candidate', 'decisiveLinks',
      'strongestCounter', 'confidence', 'limitations', 'simulated',
    ],
    properties: {
      stage: { type: 'string', enum: ['A'] },
      inputHash: hex64,
      subjectKind: { type: 'string', enum: [subjectKind] },
      candidate: { type: 'string', enum: [...validDispositions(subjectKind)] },
      decisiveLinks: {
        type: 'array', minItems: 2,
        items: {
          type: 'object', additionalProperties: false,
          required: ['text', 'evidenceArtifactSha256'],
          properties: { text: { type: 'string' }, evidenceArtifactSha256: hex64 },
        },
      },
      strongestCounter: { type: 'string' },
      confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
      limitations: { type: 'array', items: { type: 'string' } },
      simulated: { type: 'boolean' }, // R28：真实通道输出 false
    },
  };
}

export function jOutputWireSchema(subjectKind: SubjectKind): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: [
      'stage', 'inputHash', 'finalDisposition', 'verdicts', 'changedFromA',
      'changeReason', 'strongestCaseDisposition', 'limitations', 'simulated',
    ],
    properties: {
      stage: { type: 'string', enum: ['J'] },
      inputHash: hex64,
      finalDisposition: { type: 'string', enum: [...validDispositions(subjectKind)] },
      verdicts: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false,
          required: ['checklistId', 'verdict', 'decisionBearing', 'correction'],
          properties: {
            checklistId: { type: 'string' },
            verdict: { type: 'string', enum: ['SUPPORTED', 'NARROWED', 'REJECTED', 'UNRESOLVED'] },
            decisionBearing: { type: 'boolean' },
            correction: { type: ['string', 'null'] },
          },
        },
      },
      changedFromA: { type: 'boolean' },
      changeReason: { type: ['string', 'null'] },
      strongestCaseDisposition: { type: 'string', enum: ['ACCEPTED', 'NARROWED', 'REFUTED', 'UNRESOLVED'] },
      limitations: { type: 'array', items: { type: 'string' } },
      simulated: { type: 'boolean' }, // R28：真实通道输出 false
    },
  };
}

// ===== 本地权威校验（最小 validator；形状与 contracts AOutput/JOutput 一致）=====

const A_KEYS = ['stage', 'inputHash', 'subjectKind', 'candidate', 'decisiveLinks', 'strongestCounter', 'confidence', 'limitations', 'simulated'] as const;
const J_KEYS = ['stage', 'inputHash', 'finalDisposition', 'verdicts', 'changedFromA', 'changeReason', 'strongestCaseDisposition', 'limitations', 'simulated'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(detail: string): KernelError {
  return new KernelError('MODEL_OUTPUT_SCHEMA_INVALID', detail);
}

function assertExactKeys(obj: Record<string, unknown>, keys: readonly string[], stage: string): void {
  const got = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (got.length !== expected.length || got.some((k, i) => k !== expected[i])) {
    throw shapeError(`${stage} 输出字段集不符：期望 [${expected.join(',')}] 实得 [${got.join(',')}]`);
  }
}

/**
 * A 输出形状校验（本地权威）。绑定：inputHash 必须原样回抄 contract.inputHash、
 * subjectKind 必须等于合同标的类别、candidate 必须在该类别选项空间（R18 跨类拒绝）。
 * 注：simulated 字段是通道自声明（R28）——本真实通道断言 false；permit.simulated（false）与 describe() 同向印证。
 */
export function validateAOutputShape(value: unknown, call: ModelCallContract): AOutput {
  if (!isPlainObject(value)) throw shapeError(`A 输出须为 JSON 对象，实为 ${typeof value}`);
  assertExactKeys(value, A_KEYS, 'A');
  if (value.stage !== 'A') throw shapeError(`stage 须为 'A'，实为 ${String(value.stage)}`);
  if (value.inputHash !== call.inputHash || typeof value.inputHash !== 'string') {
    throw shapeError(`inputHash 必须原样回抄调用合同输入哈希（期望 ${call.inputHash.slice(0, 16)}…，实得 ${String(value.inputHash).slice(0, 16)}…）`);
  }
  if (value.subjectKind !== call.businessKey.subjectKind) {
    throw shapeError(`subjectKind 须为 ${call.businessKey.subjectKind}，实为 ${String(value.subjectKind)}`);
  }
  const space = validDispositions(call.businessKey.subjectKind);
  if (typeof value.candidate !== 'string' || !space.includes(value.candidate)) {
    throw shapeError(`candidate ${String(value.candidate)} 不在 ${call.businessKey.subjectKind} 选项空间 [${space.join('/')}]（R18 跨类拒绝）`);
  }
  if (!Array.isArray(value.decisiveLinks) || value.decisiveLinks.length < 2) {
    throw shapeError(`decisiveLinks 须为 ≥2 条数组，实得 ${Array.isArray(value.decisiveLinks) ? String(value.decisiveLinks.length) : '非数组'}`);
  }
  const links = value.decisiveLinks.map((link, i) => {
    if (!isPlainObject(link) || Object.keys(link).length !== 2 || typeof link.text !== 'string' || link.text.length === 0) {
      throw shapeError(`decisiveLinks[${i}] 须为 {text:string, evidenceArtifactSha256:64hex}`);
    }
    if (typeof link.evidenceArtifactSha256 !== 'string' || !HASH_RE.test(link.evidenceArtifactSha256)) {
      throw shapeError(`decisiveLinks[${i}].evidenceArtifactSha256 须为 64 位十六进制原件哈希，实得 ${String(link.evidenceArtifactSha256).slice(0, 24)}…`);
    }
    return { text: link.text, evidenceArtifactSha256: link.evidenceArtifactSha256 };
  });
  if (typeof value.strongestCounter !== 'string' || value.strongestCounter.length === 0) {
    throw shapeError('strongestCounter 须为非空字符串');
  }
  if (value.confidence !== 'HIGH' && value.confidence !== 'MEDIUM' && value.confidence !== 'LOW') {
    throw shapeError(`confidence 须为 HIGH/MEDIUM/LOW，实为 ${String(value.confidence)}`);
  }
  if (!Array.isArray(value.limitations) || value.limitations.some((x) => typeof x !== 'string')) {
    throw shapeError('limitations 须为字符串数组');
  }
  if (value.simulated !== false) {
    throw shapeError(`R28：真实通道输出 simulated 须为 false，实为 ${String(value.simulated)}`);
  }
  return {
    stage: 'A',
    inputHash: value.inputHash,
    subjectKind: call.businessKey.subjectKind,
    candidate: value.candidate as AOutput['candidate'],
    decisiveLinks: links,
    strongestCounter: value.strongestCounter,
    confidence: value.confidence,
    limitations: value.limitations as string[],
    simulated: false,
  };
}

/**
 * J 输出形状校验（本地权威）。绑定同 A；expectedChecklistIds 给定时 verdicts 必须
 * 恰好逐项覆盖各一次（把"输出 ↔ 输入清单"绑定前移到 dispatch 内，避免两发授权
 * 花完才在结论构造处发现覆盖不符——该约束与 buildConclusionObject 的
 * J_VERDICTS_MISMATCH 同构，此处只是更早失败，不放松后者）。
 */
export function validateJOutputShape(
  value: unknown,
  call: ModelCallContract,
  expectedChecklistIds?: readonly string[],
): JOutput {
  if (!isPlainObject(value)) throw shapeError(`J 输出须为 JSON 对象，实为 ${typeof value}`);
  assertExactKeys(value, J_KEYS, 'J');
  if (value.stage !== 'J') throw shapeError(`stage 须为 'J'，实为 ${String(value.stage)}`);
  if (value.inputHash !== call.inputHash || typeof value.inputHash !== 'string') {
    throw shapeError(`inputHash 必须原样回抄调用合同输入哈希（期望 ${call.inputHash.slice(0, 16)}…，实得 ${String(value.inputHash).slice(0, 16)}…）`);
  }
  const space = validDispositions(call.businessKey.subjectKind);
  if (typeof value.finalDisposition !== 'string' || !space.includes(value.finalDisposition)) {
    throw shapeError(`finalDisposition ${String(value.finalDisposition)} 不在 ${call.businessKey.subjectKind} 选项空间 [${space.join('/')}]`);
  }
  if (!Array.isArray(value.verdicts) || value.verdicts.length === 0) {
    throw shapeError('verdicts 须为非空数组');
  }
  const verdicts = value.verdicts.map((v, i): JOutput['verdicts'][number] => {
    if (!isPlainObject(v) || Object.keys(v).length !== 4) {
      throw shapeError(`verdicts[${i}] 须为 {checklistId, verdict, decisionBearing, correction}`);
    }
    if (typeof v.checklistId !== 'string' || v.checklistId.length === 0) throw shapeError(`verdicts[${i}].checklistId 须为非空字符串`);
    if (v.verdict !== 'SUPPORTED' && v.verdict !== 'NARROWED' && v.verdict !== 'REJECTED' && v.verdict !== 'UNRESOLVED') {
      throw shapeError(`verdicts[${i}].verdict ${String(v.verdict)} 不在 SUPPORTED/NARROWED/REJECTED/UNRESOLVED`);
    }
    if (typeof v.decisionBearing !== 'boolean') throw shapeError(`verdicts[${i}].decisionBearing 须为 boolean`);
    if (v.correction !== null && typeof v.correction !== 'string') throw shapeError(`verdicts[${i}].correction 须为 string|null`);
    return { checklistId: v.checklistId, verdict: v.verdict, decisionBearing: v.decisionBearing, correction: v.correction };
  });
  if (expectedChecklistIds !== undefined) {
    const expected = [...expectedChecklistIds].sort();
    const got = verdicts.map((v) => v.checklistId).sort();
    if (expected.length !== got.length || got.some((id, i) => id !== expected[i])) {
      throw shapeError(
        `verdicts 必须恰好覆盖清单条目各一次：清单 [${expected.join(',')}] vs 输出 [${got.join(',')}]`,
      );
    }
  }
  if (typeof value.changedFromA !== 'boolean') throw shapeError('changedFromA 须为 boolean');
  if (value.changeReason !== null && typeof value.changeReason !== 'string') throw shapeError('changeReason 须为 string|null');
  if (
    value.strongestCaseDisposition !== 'ACCEPTED' && value.strongestCaseDisposition !== 'NARROWED' &&
    value.strongestCaseDisposition !== 'REFUTED' && value.strongestCaseDisposition !== 'UNRESOLVED'
  ) {
    throw shapeError(`strongestCaseDisposition ${String(value.strongestCaseDisposition)} 不在 ACCEPTED/NARROWED/REFUTED/UNRESOLVED`);
  }
  if (!Array.isArray(value.limitations) || value.limitations.some((x) => typeof x !== 'string')) {
    throw shapeError('limitations 须为字符串数组');
  }
  if (value.simulated !== false) {
    throw shapeError(`R28：真实通道输出 simulated 须为 false，实为 ${String(value.simulated)}`);
  }
  return {
    stage: 'J',
    inputHash: value.inputHash,
    finalDisposition: value.finalDisposition as JOutput['finalDisposition'],
    verdicts,
    changedFromA: value.changedFromA,
    changeReason: value.changeReason,
    strongestCaseDisposition: value.strongestCaseDisposition,
    limitations: value.limitations as string[],
    simulated: false,
  };
}

// ===== 输入 ↔ 调用合同绑定守卫（与 SimulatedTransport 同款纪律）=====

function assertPayloadBound(call: ModelCallContract, payload: unknown): SolDispatchPayload {
  if (!isPlainObject(payload)) {
    throw new KernelError('MODEL_INPUT_UNBOUND', `stage ${call.stage} 的 payload 必须是对象，实为 ${typeof payload}`);
  }
  if (typeof payload.inputHash !== 'string' || payload.inputHash !== call.inputHash) {
    throw new KernelError(
      'MODEL_INPUT_UNBOUND',
      `模型输入与调用合同不符：payload.inputHash 必须等于 contract.inputHash（stage=${call.stage}, subject=${call.businessKey.subject}）`,
    );
  }
  if (payload.subjectKind !== call.businessKey.subjectKind) {
    throw new KernelError(
      'MODEL_INPUT_UNBOUND',
      `模型输入与调用合同不符：payload.subjectKind=${String(payload.subjectKind)} ≠ contract.subjectKind=${call.businessKey.subjectKind}`,
    );
  }
  if (typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
    throw new KernelError('MODEL_INPUT_UNBOUND', `stage ${call.stage} 的 payload.prompt 必须为非空字符串（prompt 构造单一来源在研究层 gate-m）`);
  }
  if (call.stage !== 'A' && call.stage !== 'J') {
    throw new KernelError('MODEL_INPUT_UNBOUND', `未知 stage: ${String(call.stage)}`);
  }
  return payload as unknown as SolDispatchPayload;
}

// ===== SolTransport =====

export class SolTransport implements ModelTransport {
  readonly config: SolTransportConfig;

  constructor(config?: Partial<SolTransportConfig>) {
    this.config = {
      binary: DEFAULT_CODEX_BINARY,
      model: DEFAULT_SOL_MODEL,
      reasoningEffort: DEFAULT_SOL_REASONING_EFFORT,
      timeoutMs: DEFAULT_SOL_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_SOL_MAX_OUTPUT_BYTES,
      killGraceMs: DEFAULT_SOL_KILL_GRACE_MS,
      workDirRoot: DEFAULT_SOL_WORK_DIR_ROOT,
      dryRun: false,
      spawnFn: spawn as unknown as SpawnFn,
      ...config,
    };
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new KernelError('SOL_CONFIG_INVALID', `timeoutMs 须为正数: ${String(this.config.timeoutMs)}`);
    }
    if (this.config.binary.length === 0 || this.config.model.length === 0 || this.config.reasoningEffort.length === 0) {
      throw new KernelError('SOL_CONFIG_INVALID', 'binary/model/reasoningEffort 不得为空');
    }
  }

  describe(): { provider: string; simulated: boolean } {
    return { provider: 'codex-native', simulated: false };
  }

  /** 静态构造调用计划（无 fs、无 spawn）：预览与 dispatch 共用。paths 为占位时标注。 */
  buildPlan(call: ModelCallContract, payload: SolDispatchPayload, paths?: { schemaPath: string; finalPath: string }): SolInvocationPlan {
    const subjectKind = call.businessKey.subjectKind;
    const schema = call.stage === 'A' ? aOutputWireSchema(subjectKind) : jOutputWireSchema(subjectKind);
    const schemaPath = paths?.schemaPath ?? '<sol-invocation-dir>/schema.json';
    const finalPath = paths?.finalPath ?? '<sol-invocation-dir>/final.txt';
    const argv = buildSolArgv({
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      schemaPath,
      finalPath,
    });
    return {
      binary: this.config.binary,
      argv,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      timeoutMs: this.config.timeoutMs,
      stage: call.stage,
      prompt: payload.prompt,
      promptBytes: Buffer.byteLength(payload.prompt, 'utf8'),
      promptSha256: createHash('sha256').update(payload.prompt, 'utf8').digest('hex'),
      schema,
      pathPlaceholders: paths === undefined,
    };
  }

  /** 干跑预览：绑定守卫 + 完整 argv/prompt/schema 视图；不 spawn、不写盘。 */
  async preview(call: ModelCallContract, payload: unknown): Promise<SolInvocationPlan> {
    const bound = assertPayloadBound(call, payload);
    this.assertPromptLimit(bound.prompt);
    return this.buildPlan(call, bound);
  }

  /**
   * 一次真实模型调用：构造调用目录（schema/prompt 落盘，证据保留）→ spawn codex
   * （argv 镜像 Metis；prompt 走 stdin）→ 等待退出（与超时/输出上限竞速，超限终止
   * 进程组）→ 读 final.txt → JSON 解析 → 本地权威形状校验 → 返回定型输出。
   * 任何失败只抛具名 KernelError；无重试、无凭据接触。
   */
  async dispatch(call: ModelCallContract, payload: unknown): Promise<unknown> {
    const bound = assertPayloadBound(call, payload);
    this.assertPromptLimit(bound.prompt);
    if (this.config.dryRun) return this.buildPlan(call, bound); // 干跑守卫：绝不 spawn

    const invocationId = `sol-${new Date().toISOString().replaceAll(/[:.]/g, '')}-${call.stage.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    const dir = resolve(join(this.config.workDirRoot, invocationId)); // 绝对路径：codex 沙箱内相对路径不可读（真实失败教训 2026-10-25）
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const schemaPath = join(dir, 'schema.json');
    const finalPath = join(dir, 'final.txt');
    const stdoutPath = join(dir, 'stdout.jsonl');
    const stderrPath = join(dir, 'stderr.txt');
    const promptPath = join(dir, 'prompt.txt');
    const plan = this.buildPlan(call, bound, { schemaPath, finalPath });
    writeFileSync(schemaPath, JSON.stringify(plan.schema, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(promptPath, bound.prompt, { mode: 0o600 });

    const { exitCode, exitSignal, stderrTail } = await this.runProcess(plan, bound.prompt, {
      cwd: dir,
      stdoutPath,
      stderrPath,
    });

    if (exitCode !== 0) {
      throw new KernelError(
        'MODEL_PROVIDER_EXIT_NONZERO',
        `codex 退出码 ${String(exitCode)}${exitSignal === null ? '' : `（信号 ${exitSignal}）`}：显式失败，不重试。stderr 尾部：${stderrTail}`,
      );
    }

    let rawText: string;
    try {
      rawText = readFileSync(finalPath, 'utf8').trim();
    } catch {
      throw new KernelError('MODEL_FINAL_MISSING', `退出码 0 但 final.txt 缺失（${finalPath}）：远端终局消息未产出`);
    }
    if (rawText.length === 0) {
      throw new KernelError('MODEL_FINAL_MISSING', `final.txt 为空（${finalPath}）：远端终局消息未产出`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new KernelError(
        'MODEL_OUTPUT_INVALID_JSON',
        `final.txt 不是合法 JSON：${String(error).slice(0, 200)}；头部：${rawText.slice(0, 120)}`,
      );
    }
    return call.stage === 'A'
      ? validateAOutputShape(parsed, call)
      : validateJOutputShape(parsed, call, bound.expectedChecklistIds);
  }

  private assertPromptLimit(prompt: string): void {
    if (prompt.length > SOL_PROMPT_MAX_CHARACTERS) {
      throw new KernelError(
        'SOL_PROMPT_LIMIT_EXCEEDED',
        `prompt ${String(prompt.length)} 字符超通道上限 ${String(SOL_PROMPT_MAX_CHARACTERS)}（Metis 同值）：拒绝发送，不截断`,
      );
    }
  }

  /** 进程竞速核心：退出 vs 超时（SIGTERM→SIGKILL 进程组）vs 输出上限。 */
  private runProcess(
    plan: SolInvocationPlan,
    prompt: string,
    io: { cwd: string; stdoutPath: string; stderrPath: string },
  ): Promise<{ exitCode: number | null; exitSignal: string | null; stderrTail: string }> {
    const { spawnFn, timeoutMs, killGraceMs, maxOutputBytes } = this.config;
    return new Promise((resolve, reject) => {
      let stderrBuf = '';
      let outputBytes = 0;
      let stdoutTotal = '';
      let settled = false;
      let pendingTerminate: KernelError | null = null; // 我方主动终止：close 不再解读为远端退出码
      let killTimer: NodeJS.Timeout | undefined;
      let killSettleTimer: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;

      const child = spawnFn(plan.binary, plan.argv, {
        cwd: io.cwd,
        env: process.env, // 凭据零接触：整环境原样继承（默认 CODEX_HOME 由 codex 自身解析），不增删不打印
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const cleanup = (): void => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        clearTimeout(killSettleTimer);
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try { writeFileSync(io.stdoutPath, stdoutTotal, { mode: 0o600 }); } catch { /* 证据写失败不改判结局 */ }
        try { writeFileSync(io.stderrPath, stderrBuf, { mode: 0o600 }); } catch { /* 同上 */ }
        fn();
      };
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined || child.pid === null) return;
        try {
          process.kill(-child.pid, signal); // detached：负 pid = 进程组（Metis 同语义）
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const terminate = (error: KernelError): void => {
        if (settled || pendingTerminate !== null) return;
        pendingTerminate = error;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => {
          killGroup('SIGKILL');
          // SIGKILL 后再等一拍宽限即单边收束（不等 close——子进程树可能已不可靠）。
          killSettleTimer = setTimeout(() => finish(() => reject(error)), killGraceMs);
        }, killGraceMs);
      };

      child.once('error', () => {
        finish(() => reject(new KernelError('SOL_SPAWN_FAILED', `spawn ${plan.binary} 失败（ENOENT/EACCES 等）`)));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        stdoutTotal += chunk.toString('utf8');
        if (outputBytes > maxOutputBytes) {
          terminate(new KernelError(
            'MODEL_OUTPUT_LIMIT_EXCEEDED',
            `子进程输出 ${String(outputBytes)} 字节超上限 ${String(maxOutputBytes)}：终止进程组，不重试`,
          ));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192); // 只留尾部作错误上下文
        if (outputBytes > maxOutputBytes) {
          terminate(new KernelError(
            'MODEL_OUTPUT_LIMIT_EXCEEDED',
            `子进程输出 ${String(outputBytes)} 字节超上限 ${String(maxOutputBytes)}：终止进程组，不重试`,
          ));
        }
      });
      child.stdin.on('error', () => {
        terminate(new KernelError('SOL_SPAWN_FAILED', 'prompt stdin 写入失败'));
      });
      child.once('close', (code, signal) => {
        // 我方主动终止（超时/输出超限）的 close 属于既定失败路径，不解读为远端退出码。
        if (pendingTerminate !== null) finish(() => reject(pendingTerminate));
        else finish(() => resolve({ exitCode: code, exitSignal: signal, stderrTail: stderrBuf.slice(-400) }));
      });
      deadline = setTimeout(() => {
        terminate(new KernelError(
          'TIMEOUT',
          `codex 调用超时（${String(timeoutMs)}ms，stage=${plan.stage}）：SIGTERM→SIGKILL 终止进程组；终态分类由 runModelCall 处置`,
        ));
      }, timeoutMs);
      child.stdin.end(prompt); // '-'：prompt 自 stdin 送入（Metis 同语义）
    });
  }
}
