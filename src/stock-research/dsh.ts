import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KernelError } from '../contracts.js';
import type { SrModelStepKind, SrModelTransport } from './contracts.js';
import { STEP_INSTRUCTIONS, srOutputSchema } from './transport.js';

export interface DshConfig {
  enabled: boolean;
  modelId: string;
  effort: 'off' | 'low' | 'high' | 'max';
  endpoint: string;
  platformOrigin: string;
  credentialsPath: string;
  callWindowMs: number;
  maxResponseBytes: number;
  maxTokens: number;
  validation: boolean;
}

export function dshConfigFromEnv(env: NodeJS.ProcessEnv): DshConfig {
  return {
    enabled: env.LYRA_SR_REAL_CALLS === '1',
    modelId: env.LYRA_SR_DSH_MODEL ?? 'deepseek-flash',
    effort: (env.LYRA_SR_DSH_EFFORT ?? 'high') as DshConfig['effort'],
    endpoint: env.LYRA_SR_DSH_ENDPOINT ?? 'https://api.deepseek.com/anthropic',
    platformOrigin: env.LYRA_SR_DSH_PLATFORM_ORIGIN ?? 'https://platform.deepseek.com',
    credentialsPath: env.LYRA_SR_DSH_CREDENTIALS_PATH ?? join(homedir(), '.dsh', '.credentials.yaml'),
    callWindowMs: Number(env.LYRA_SR_REAL_WINDOW_MS ?? 60 * 60 * 1000),
    maxResponseBytes: 4 * 1024 * 1024,
    maxTokens: 16384,
    validation: env.LYRA_SR_DSH_LOCAL_VALIDATION === '1',
  };
}

export interface DshWorkerRequest { config: DshConfig; callId: string; inputHash: string; step: SrModelStepKind; prompt: string; }
export type DshWorkerReply = { type: 'sent' } | { type: 'result'; output: unknown } | { type: 'failure'; code: string };

function assertConfig(c: DshConfig) {
  try {
    const endpoint = new URL(c.endpoint), platform = new URL(c.platformOrigin);
    const loopback = (u: URL) => u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || platform.username || platform.password || platform.pathname !== '/' || platform.search || platform.hash) throw new Error();
    if (c.validation ? !(loopback(endpoint) && loopback(platform)) : !(endpoint.origin === 'https://api.deepseek.com' && ['/anthropic', '/anthropic/'].includes(endpoint.pathname) && platform.origin === 'https://platform.deepseek.com')) throw new Error();
    if (!['off', 'low', 'high', 'max'].includes(c.effort) || !c.modelId || !c.credentialsPath || ![c.callWindowMs, c.maxResponseBytes, c.maxTokens].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error();
  } catch { throw new KernelError('DSH_CONFIG_INVALID', 'DSH 配置不兼容；真实端点仅允许官方 Messages API，本地验证仅允许合成凭据。'); }
}

/** Official pinned DSH Messages SDK, through the existing sr executor; no alternate executor/retry. */
export class DshSrTransport implements SrModelTransport {
  readonly config: Readonly<DshConfig>;
  constructor(config: DshConfig) { this.config = Object.freeze({ ...config }); }
  describe() { return { provider: 'dsh-deepseek-native-sr', modelId: this.config.modelId || null, simulated: this.config.validation }; }
  async dispatch(step: SrModelStepKind, ctx: { callId: string; inputHash: string; deadline?: string }, payload: unknown): Promise<unknown> {
    if (!this.config.enabled) throw new KernelError('MODEL_PROVIDER_UNAUTHORIZED', 'DSH 真实通道需要 Owner 授权（LYRA_SR_REAL_CALLS=1）；配置凭据不构成授权。');
    assertConfig(this.config);
    if (!['PLAN', 'ANALYZE', 'A_FINAL', 'JUDGE', 'CHAT_ANSWER'].includes(step)) throw new KernelError('DSH_STEP_UNSUPPORTED', 'DSH 不接收确定性或未启用的模型步骤。');
    const input = JSON.stringify(payload, null, 1);
    if (!ctx.callId || createHash('sha256').update(input).digest('hex') !== ctx.inputHash) throw new KernelError('DSH_INPUT_BINDING_INVALID', 'DSH 输入与许可合同不匹配。');
    const windowMs = Math.min(this.config.callWindowMs, ctx.deadline === undefined ? Infinity : Date.parse(ctx.deadline) - Date.now());
    if (!(windowMs > 0)) throw new KernelError('DEADLINE_EXCEEDED', 'DSH 发送前许可窗口已关闭。');
    const request: DshWorkerRequest = { config: { ...this.config, callWindowMs: windowMs }, callId: ctx.callId, inputHash: ctx.inputHash, step,
      prompt: `${STEP_INSTRUCTIONS[step]}\n\n# 输出 schema（本地业务校验仍为权威）\n${JSON.stringify(srOutputSchema(step))}\n\n# 输入（JSON）\n${input}\n` };
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './dsh-worker.ts' : './dsh-worker.js', import.meta.url), { workerData: request, env: {}, execArgv: [] });
    let sent = false;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const uncertain = () => new KernelError(sent ? 'SILENCE_AFTER_SEND' : 'DSH_WORKER_FAILED', sent ? 'DSH 已释放一次请求，远端结局不明；不得自动重发。' : 'DSH 本地准备失败（错误详情已脱敏）。');
        const timer = setTimeout(() => reject(uncertain()), windowMs);
        const fail = (error: KernelError) => { clearTimeout(timer); reject(error); };
        worker.on('message', (reply: DshWorkerReply) => {
          if (reply.type === 'sent') { sent = true; return; }
          clearTimeout(timer);
          if (reply.type === 'result') resolve(reply.output);
          else fail(new KernelError(reply.code, `DSH 请求未完成：${reply.code}（详情已脱敏，无自动重试）。`));
        });
        worker.once('error', () => fail(uncertain()));
        worker.once('exit', () => fail(uncertain()));
      });
    } finally { await worker.terminate(); }
  }
}
