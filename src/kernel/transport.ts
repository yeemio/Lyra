/**
 * Lyra · 模型路由接口（P2，W12: code-writer-pro）。合同：docs/specs/P2-RESEARCH.md
 * Done-when 3——ModelTransport 抽象（调用合同 → 输出）；SimulatedTransport 包装现有
 * 确定性模拟模型；真实端点为具名未授权占位。
 *
 * permit 纪律不变（EK-3.2）：transport 不持有、不创建、不校验 permit——模型调用唯一
 * 公开入口仍是 kernel/executor.runModelCall。整合层以
 * `(ctx) => transport.dispatch(ctx.contract, payload)` 作为 modelFn 注入，发送动作只
 * 发生在 permit 进入 SENT 之后；transport 在此之上补一层"输入 ↔ 调用合同"绑定校验
 * （payload.inputHash / subjectKind 必须与 call 一致，不符即 MODEL_INPUT_UNBOUND）。
 *
 * 真实通道（Gate-M）：本文件刻意不含任何端点 URL、凭据读取或供应商 SDK——授权走
 * Owner 有界授权，授权后另立合同实现；此前一律 UnauthorizedTransport。
 */
import { KernelError, type ModelCallContract } from '../contracts.js';
import {
  simulatedModelA,
  simulatedModelJ,
  type SimulatedAInput,
  type SimulatedJInput,
} from '../research/simulated.js';

/** 模型路由抽象：一次模型调用的传输载体（A/J 输出统一以 unknown 返回，由调用侧定型）。 */
export interface ModelTransport {
  dispatch(call: ModelCallContract, payload: unknown): Promise<unknown>;
  /** 身份自我声明（EK-10.1）：provider 名与是否模拟。 */
  describe(): { provider: string; simulated: boolean };
}

const HASH_RE = /^[a-f0-9]{64}$/;

/** 输入 ↔ 调用合同绑定守卫：payload 必须是携带与 call 一致的 inputHash/subjectKind 的对象。 */
function assertPayloadBound(call: ModelCallContract, payload: unknown): SimulatedAInput | SimulatedJInput {
  if (payload === null || typeof payload !== 'object') {
    throw new KernelError('MODEL_INPUT_UNBOUND', `stage ${call.stage} 的 payload 必须是对象，实为 ${typeof payload}`);
  }
  const p = payload as Partial<SimulatedAInput & SimulatedJInput>;
  if (typeof p.inputHash !== 'string' || !HASH_RE.test(p.inputHash) || p.inputHash !== call.inputHash) {
    throw new KernelError(
      'MODEL_INPUT_UNBOUND',
      `模型输入与调用合同不符：payload.inputHash 必须等于 contract.inputHash（stage=${call.stage}, subject=${call.businessKey.subject}）`,
    );
  }
  if (p.subjectKind !== call.businessKey.subjectKind) {
    throw new KernelError(
      'MODEL_INPUT_UNBOUND',
      `模型输入与调用合同不符：payload.subjectKind=${String(p.subjectKind)} ≠ contract.subjectKind=${call.businessKey.subjectKind}`,
    );
  }
  return p as SimulatedAInput | SimulatedJInput;
}

/** 确定性模拟传输：A/J 由 call.stage 分派到 src/research/simulated.ts 的模型函数。 */
export class SimulatedTransport implements ModelTransport {
  async dispatch(call: ModelCallContract, payload: unknown): Promise<unknown> {
    const input = assertPayloadBound(call, payload);
    if (call.stage === 'A') return simulatedModelA(input as SimulatedAInput);
    return simulatedModelJ(input as SimulatedJInput);
  }

  describe(): { provider: string; simulated: boolean } {
    return { provider: 'lyra-simulated', simulated: true };
  }
}

/** 真实端点未授权的具名占位说明（无凭据、无猜测 URL；授权走 Owner 有界授权）。 */
export const DEFAULT_UNAUTHORIZED_REASON =
  '真实模型通道未授权（Gate-M 待 Owner 有界授权）：当前无授权配置、无凭据、无猜测端点；' +
  '经 Owner 有界授权后另立合同实现，本占位不补充任何端点或凭据';

/** 真实端点占位：任何 dispatch 一律具名拒绝；不触碰网络。 */
export class UnauthorizedTransport implements ModelTransport {
  constructor(readonly reason: string = DEFAULT_UNAUTHORIZED_REASON) {}

  async dispatch(_call: ModelCallContract, _payload: unknown): Promise<never> {
    throw new KernelError('MODEL_PROVIDER_UNAUTHORIZED', this.reason);
  }

  describe(): { provider: string; simulated: boolean } {
    return { provider: 'real-endpoint-unauthorized', simulated: false };
  }
}

/** 传输选择配置：缺省 simulated；'real' 在无授权配置时得到未授权占位。 */
export interface TransportSelection {
  provider?: 'simulated' | 'real';
}

export function selectTransport(config?: TransportSelection): ModelTransport {
  if (config?.provider === 'real') return new UnauthorizedTransport();
  return new SimulatedTransport();
}
