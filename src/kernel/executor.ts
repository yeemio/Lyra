/**
 * Lyra · 执行编排器（W1: code-writer-pro）。合同：docs/specs/EXECUTION-KERNEL.md
 * §3–§7（EK-3.2、EK-4、EK-5.1/5.2、EK-6、EK-7.1）。
 *
 * runModelCall 是模型调用的唯一公开入口：modelFn 只在此处、且只在 permit 进入
 * SENT 之后被调用——内核不存在无 permit 的模型调用路径（EK-3.2 结构性强制；
 * 模拟器同样不得 bypass permit，EK-11.2）。
 *
 * 〔R31〕编排体泛化为 runPermittedCall<P, C>：permit 落位/迁移由 PermitSpace 注入，
 * 编排逻辑（恢复守卫、并发闸轮询、截止竞速三分支、终态分类）单份共享。A/J 路径
 * 经 AJ_PERMIT_SPACE 保持既有行为与签名不变；报告产品链（src/stock-research/）
 * 以同一编排器接入自己的 permit 表空间——仍是一个发送入口与一个执行器。
 *
 * 编排顺序（每步具名可测）：
 *   0) （可选 holderId 时）执行权校验——EXECUTION_LOCK_HELD（EK-2.1）；
 *   1) 恢复守卫——RECONCILING 下零模型调用（EK-8.2/8.3）；
 *   2) preparePermit——预算判定（INPUT_OVER_BUDGET）+ send-once（BUSINESS_KEY_ALREADY_SENT）；
 *   3) 并发闸——在途 SENT < budget.maxInFlight 才原子 PREPARED→SENT，否则轮询等待，
 *      等待中窗口关闭按 DEADLINE_EXCEEDED 未按窗完成落库（EK-2.3/7.1、EK-6.2）；
 *   4) 发送已发起（此后不得声称"确定未发送"）：与截止竞速，终态按先到的信号分类
 *      （R22 三分支）——a) 截止先到且 modelFn 仍挂起（timer 竞速胜出，远端结局不明）
 *      → UNKNOWN + fail_code=DEADLINE_EXCEEDED（处置走 EK-5：不自动重采样、不自动退役）；
 *      b) modelFn 先解决但迟到（结果已知）：成功 → SUCCEEDED + fail_code=LATE_COMPLETED
 *      （诚实记时，Metis late_completed 先例）；显式错误晚到 → FAILED + 原错误码；
 *      c) 窗内 modelFn 显式 TIMEOUT/DEADLINE_EXCEEDED → FAILED/DEADLINE_EXCEEDED（EK-6.2）；
 *      SILENCE_AFTER_SEND → UNKNOWN（不自动重采样、不自动退役）；发送前过期 →
 *      FAILED/DEADLINE_EXCEEDED（从未发送，结局已知）。modelFn 的注入故障编码沿用
 *      SimFault（contracts.ts）。
 */
import type { Pool } from 'pg';
import {
  KernelError,
  type ModelCallContract,
  type ModelPermit,
  type PlanAuthBudget,
} from '../contracts.js';
import { assertLockHeld } from './lock.js';
import {
  failPreparedDeadline,
  preparePermit,
  settle,
  tryMarkSent,
  type PermitLike,
  type PermitOutcome,
  type TryMarkSentOutcome,
} from './permit.js';
import { assertRunning } from './recovery.js';

/** modelFn 收到的调用上下文：permit 已处于 SENT（发送动作的实际载体）。 */
export interface ModelCallContext {
  permit: ModelPermit;
  contract: ModelCallContract;
}

/** 模型调用函数（P0 由调用方注入模拟模型；真实端点 P2 起按有界授权引入）。 */
export type ModelFn<A = unknown> = (ctx: ModelCallContext) => Promise<A>;

export interface RunModelCallOptions<A = unknown> {
  contract: ModelCallContract;
  budget: PlanAuthBudget;
  modelFn: ModelFn<A>;
  /** 模拟身份自我声明（EK-10.1）：P0 恒 true，落 permit.simulated。 */
  simulated: boolean;
  /** 可选：执行权持有者标识。提供时先校验 kernel_lock 归属（EK-2.1 防御层）。 */
  holderId?: string;
  /** 并发闸轮询间隔（默认 25ms；测试可调）。 */
  pollMs?: number;
}

export interface ModelCallSuccess<A = unknown> {
  permit: ModelPermit;
  output: A;
}

// ===== 〔R31〕泛型 permit 空间：同一执行器编排，可插的落位实现 =====

/** 编排器对 permit 的最小要求（状态机值域与 A/J 一致，见 contracts.ts PermitState）。 */
export type ExecutorPermitLike = PermitLike;

/** 编排器对调用合同的最小要求：本执行自身持有的截止（EK-6.1）。 */
export interface ExecutorContractLike {
  deadline: string;
}

/**
 * permit 空间：一个自洽的 permit 表空间（A/J 的 exec_permit，或报告链的 sr_call_permit）。
 * 实现必须保持与 EK 合同一致的状态机、send-once、并发闸与预算语义——编排器不重复
 * 校验这些不变量，复用方即共享同一执行纪律。
 */
export interface PermitSpace<P extends ExecutorPermitLike, C extends ExecutorContractLike> {
  /** 可选：执行权校验（A/J 为 kernel_lock 防御层，EK-2.1）。 */
  assertLock?(pool: Pool, holderId: string): Promise<void>;
  /** 恢复守卫：该空间 RECONCILING 下任何执行操作 → RECOVERY_CONFIRM_REQUIRED（EK-8）。 */
  assertRunning(pool: Pool): Promise<unknown>;
  /** 预算判定（INPUT_OVER_BUDGET）+ send-once + PREPARED 落位（EK-4）。 */
  preparePermit(pool: Pool, contract: C, budget: PlanAuthBudget, opts?: { simulated?: boolean }): Promise<P>;
  /** 原子并发闸 PREPARED→SENT（EK-2.3/7.1）。 */
  tryMarkSent(pool: Pool, permitId: string, maxInFlight: number): Promise<TryMarkSentOutcome<P>>;
  /** 终态记录（EK-3.3 记录义务）。 */
  settle(pool: Pool, permitId: string, outcome: PermitOutcome): Promise<P>;
}

/** 泛型 modelFn 上下文（permit 与合同的具体类型由空间决定）。 */
export interface PermittedCallContext<P extends ExecutorPermitLike, C extends ExecutorContractLike> {
  permit: P;
  contract: C;
}

export interface RunPermittedCallOptions<P extends ExecutorPermitLike, C extends ExecutorContractLike, A = unknown> {
  contract: C;
  budget: PlanAuthBudget;
  modelFn: (ctx: PermittedCallContext<P, C>) => Promise<A>;
  simulated: boolean;
  holderId?: string | undefined;
  pollMs?: number | undefined;
}

export interface PermittedCallSuccess<P extends ExecutorPermitLike, A = unknown> {
  permit: P;
  output: A;
}

/** A/J 空间：既有 exec_permit 行为的 PermitSpace 装配（行为与 R31 前完全一致）。 */
export const AJ_PERMIT_SPACE: PermitSpace<ModelPermit, ModelCallContract> = {
  assertLock: (pool, holderId) => assertLockHeld(pool, holderId),
  assertRunning,
  preparePermit,
  tryMarkSent,
  settle,
};

const DEFAULT_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次模型调用的完整编排（泛型版，R31）。失败具名抛 KernelError；成功返回 SUCCEEDED
 * 的 permit 与输出。UNKNOWN 不在此函数内关闭——退役只经 Owner 显式确认
 * （retireUnknown，R21；各空间实现各自的退役路径，语义一致）。
 */
export async function runPermittedCall<
  P extends ExecutorPermitLike,
  C extends ExecutorContractLike,
  A = unknown,
>(
  space: PermitSpace<P, C>,
  pool: Pool,
  opts: RunPermittedCallOptions<P, C, A>,
): Promise<PermittedCallSuccess<P, A>> {
  const { contract, budget, modelFn } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadlineMs = Date.parse(contract.deadline);
  if (Number.isNaN(deadlineMs)) {
    throw new KernelError('PERMIT_STATE_INVALID', `contract.deadline 非法 ISO 时间: ${contract.deadline}`);
  }

  // 0) 执行权（可选防御层，EK-2.1）：第二执行器在门入口被命名拒绝。
  if (opts.holderId !== undefined && space.assertLock) await space.assertLock(pool, opts.holderId);

  // 1) 恢复守卫（EK-8.2/8.3）：RECONCILING 下任何执行操作 → RECOVERY_CONFIRM_REQUIRED，
  //    零模型调用、零 permit 落位。
  await space.assertRunning(pool);

  // 2) permit：预算判定 + send-once（EK-4.1/4.4/4.5）。
  let permit = await space.preparePermit(pool, contract, budget, { simulated: opts.simulated });

  // 3) 并发闸（EK-2.3/7.1）：超出排队不报错；窗口内等不到则未按窗完成。
  for (;;) {
    const r = await space.tryMarkSent(pool, permit.permitId, budget.maxInFlight);
    if (r.kind === 'SENT') {
      // 竞态修复（2026-10-26）：tryMarkSent 返回 SENT 的瞬间 deadline 可能恰好已过
      // （DB 时钟 vs 本地时钟的毫秒级边界）——复查并按未按窗完成落库
      if (Date.now() >= deadlineMs) {
        await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: 'DEADLINE_EXCEEDED' });
        throw new KernelError('DEADLINE_EXCEEDED',
          `并发位获取后瞬间窗口关闭（deadline=${contract.deadline}）：按未按窗完成落库（竞态修复 2026-10-26）`);
      }
      permit = r.permit;
      break;
    }
    if (r.kind === 'IN_FLIGHT_FULL') {
      if (Date.now() >= deadlineMs) {
        // 竞态根因修复（2026-10-26）：failPreparedDeadline 有 DB 时钟 `now() > deadline` 守卫，
        // 本地时钟已过而 DB 时钟未过的毫秒边界会静默返回 null（PREPARED 残留）——
        // 调用方已决定窗口关闭，直接 settle FAILED（settle 的状态机守卫足够）
        await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: 'DEADLINE_EXCEEDED' });
        throw new KernelError(
          'DEADLINE_EXCEEDED',
          `并发等待期间执行窗口关闭（deadline=${contract.deadline}）：按未按窗完成落库，不冒称完成（EK-6.2/7.1）`,
        );
      }
      await sleep(pollMs);
      continue;
    }
    if (r.kind === 'DEADLINE_EXCEEDED') {
      throw new KernelError(
        'DEADLINE_EXCEEDED',
        `发送前截止已过（deadline=${contract.deadline}）：未按窗完成（EK-6.2），permit=${r.permit.permitId}`,
      );
    }
    throw new KernelError(
      'PERMIT_STATE_INVALID',
      `permit 无法进入 SENT（当前 ${r.permit ? r.permit.state : '不存在'}，permit=${permit.permitId}）`,
    );
  }

  // 4) 发送已发起（SENT）：与截止竞速；先到的信号决定终态分类（R22 三分支）。
  // timerError 以引用同一性作为竞速胜负的精确判据——modelFn 自身也可能抛
  // DEADLINE_EXCEEDED 具名错误，不得与"计时器胜出（modelFn 仍挂起）"混同。
  let timer: NodeJS.Timeout | undefined;
  let timerError: KernelError | undefined;
  const timerPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timerError = new KernelError('DEADLINE_EXCEEDED',
        `截止已到 modelFn 仍挂起（deadline=${contract.deadline}）：远端结局不明（EK-3.3/5，R22）`);
      reject(timerError);
    }, Math.max(0, deadlineMs - Date.now()));
  });
  const callPromise = Promise.resolve().then(() => modelFn({ permit, contract }));
  callPromise.catch(() => {}); // 败者分支已被本函数处理，避免竞速后未处理拒绝
  try {
    const output = await Promise.race([callPromise, timerPromise]);
    // 竞速由 modelFn 胜出。wall clock 已过 deadline：结果已知但迟到（R22 分支 2）——
    // 成功照实 SUCCEEDED，fail_code=LATE_COMPLETED 诚实记时，不冒充按窗完成（EK-6.2）。
    const done = await space.settle(
      pool,
      permit.permitId,
      Date.now() > deadlineMs
        ? { result: 'SUCCEEDED', failCode: 'LATE_COMPLETED' }
        : { result: 'SUCCEEDED' },
    );
    return { permit: done, output };
  } catch (err) {
    if (err === timerError) {
      // R22 分支 1：截止先到且 modelFn 仍挂起——远端可能已产生结果与费用，标 FAILED
      // 宣称了未掌握的知识；判 UNKNOWN，"未按窗完成"的窗口分类由 fail_code 承载，
      // 不与 permit 态混同。处置走 EK-5：不自动重采样（同键新 permit 被 send-once 拦住）、
      // 不自动退役（只经 Owner 显式确认 retireUnknown，R21）。
      await space.settle(pool, permit.permitId, { result: 'UNKNOWN', basis: 'DEADLINE_EXCEEDED' });
      throw err;
    }
    if (err instanceof KernelError) {
      if (err.code === 'SILENCE_AFTER_SEND') {
        // EK-5.1/5.2：远端可能已成功、可能已计费，本地无证据不改口；迟到不改变"结局不明"。
        await space.settle(pool, permit.permitId, { result: 'UNKNOWN', basis: 'SILENCE_AFTER_SEND' });
        throw err;
      }
      if (Date.now() > deadlineMs) {
        // R22 分支 2（错误侧）：显式错误晚到——结局已知，按原错误码具名落 FAILED。
        await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: err.code });
        throw err;
      }
      switch (err.code) {
        case 'TIMEOUT':
        case 'DEADLINE_EXCEEDED': {
          // 窗内 modelFn 自身报超时/截止：按未按窗完成落库（EK-6.2，语义不变）。
          await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: 'DEADLINE_EXCEEDED' });
          throw new KernelError(
            'DEADLINE_EXCEEDED',
            `modelFn 超时/晚于截止（${err.code}: ${err.message}）：未按窗完成（EK-6.2）`,
          );
        }
        default: {
          // 远端显式失败或本地验证拒绝：具名记录（EK-3.3 FAILED 记录义务）。
          await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: err.code });
          throw err;
        }
      }
    }
    // 非 KernelError：本地异常，具名 MODEL_FN_ERROR，如实重抛原始错误。
    await space.settle(pool, permit.permitId, { result: 'FAILED', failCode: 'MODEL_FN_ERROR' });
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A/J 空间的模型调用入口（P0 起的既有公开入口，签名与行为不变）。
 * 报告产品链不得经由本函数复用 A/J 枚举——新链路使用 runPermittedCall +
 * 自己的空间实现（R31，TASK-PACKAGE §5.2.1）。
 */
export async function runModelCall<A = unknown>(
  pool: Pool,
  opts: RunModelCallOptions<A>,
): Promise<ModelCallSuccess<A>> {
  const r = await runPermittedCall<ModelPermit, ModelCallContract, A>(AJ_PERMIT_SPACE, pool, {
    contract: opts.contract,
    budget: opts.budget,
    modelFn: opts.modelFn,
    simulated: opts.simulated,
    holderId: opts.holderId,
    pollMs: opts.pollMs,
  });
  return r;
}

// failPreparedDeadline 仍由 permit.ts 导出（A/J 空间内部与恢复流程使用）；
// 此处 re-export 保持既有 import 路径兼容。
export { failPreparedDeadline };
