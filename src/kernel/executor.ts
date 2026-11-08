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
 *   0) 当前执行租约与代际校验——EXECUTION_LOCK_HELD（EK-2.1）；
 *   1) 恢复守卫——RECONCILING 下零模型调用（EK-8.2/8.3）；
 *   2) preparePermit——预算判定（INPUT_OVER_BUDGET）+ send-once（BUSINESS_KEY_ALREADY_SENT）；
 *   3) 并发闸——在途 SENT < budget.maxInFlight 才原子 PREPARED→SENT，否则轮询等待，
 *      等待中窗口关闭按 DEADLINE_EXCEEDED 未按窗完成落库（EK-2.3/7.1、EK-6.2）；
 *   4) 发送已发起（此后不得声称"确定未发送"）：与截止竞速，终态按先到的信号分类
 *      （R22 三分支）——a) 截止先到且 modelFn 仍挂起（timer 竞速胜出，远端结局不明）
 *      → UNKNOWN + fail_code=DEADLINE_EXCEEDED（处置走 EK-5：不自动重采样、不自动退役）；
 *      b) modelFn 先解决但迟到（结果已知）：成功 → SUCCEEDED + fail_code=LATE_COMPLETED
 *      （诚实记时，Metis late_completed 先例）；显式错误晚到 → FAILED + 原错误码；
 *      c) 本地 TIMEOUT/DEADLINE_EXCEEDED → UNKNOWN，不能从杀进程推断远端失败；
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
import { assertLease, withExecutionLease, type ExecutionLease, type LeaseSpace, type LeaseGuard } from './lease.js';
import { completeWithCheckpoint, contractHash, responseCheckpoint } from './response.js';
import { getPermit } from './permit.js';
import { withTransaction } from '../db/exec.js';
import { recordAttempt } from './attempt.js';

/** modelFn 收到的调用上下文：permit 已处于 SENT（发送动作的实际载体）。 */
export interface ModelCallContext {
  permit: ModelPermit;
  contract: ModelCallContract;
  signal?: AbortSignal;
}

/** 模型调用函数（P0 由调用方注入模拟模型；真实端点 P2 起按有界授权引入）。 */
export type ModelFn<A = unknown> = (ctx: ModelCallContext) => Promise<A>;

export interface RunModelCallOptions<A = unknown> {
  contract: ModelCallContract;
  budget: PlanAuthBudget;
  modelFn: ModelFn<A>;
  /** 模拟身份自我声明（EK-10.1）：P0 恒 true，落 permit.simulated。 */
  simulated: boolean;
  /** 兼容旧 API 的标识；不能单凭 holderId 借用租约，须同时传入原 acquisition token。 */
  holderId?: string;
  lease?: ExecutionLease;
  preflight?: () => Promise<void> | void;
  checkpoint?: { input: unknown; transport: unknown };
  /** 并发闸轮询间隔（默认 25ms；测试可调）。 */
  pollMs?: number;
}

export interface ModelCallSuccess<A = unknown> {
  permit: ModelPermit;
  output: A;
}

// ===== 〔R31〕泛型 permit 空间：同一执行器编排，可插的落位实现 =====

/** 编排器对 permit 的最小要求（状态机值域与 A/J 一致，见 contracts.ts PermitState）。 */
export type ExecutorPermitLike = PermitLike & { sentAt?: string | null };

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
  leaseSpace?: LeaseSpace;
  /** 可选：执行权校验（A/J 为 kernel_lock 防御层，EK-2.1）。 */
  assertLock?(pool: Pool, lease: ExecutionLease): Promise<void>;
  /** 恢复守卫：该空间 RECONCILING 下任何执行操作 → RECOVERY_CONFIRM_REQUIRED（EK-8）。 */
  assertRunning(pool: Pool): Promise<unknown>;
  /** 预算判定（INPUT_OVER_BUDGET）+ send-once + PREPARED 落位（EK-4）。 */
  preparePermit(pool: Pool, contract: C, budget: PlanAuthBudget, opts?: { simulated?: boolean }): Promise<P>;
  /** 原子并发闸 PREPARED→SENT（EK-2.3/7.1）。 */
  tryMarkSent(pool: Pool, permitId: string, maxInFlight: number, lease?: ExecutionLease, budget?: PlanAuthBudget, expectedContract?: C): Promise<TryMarkSentOutcome<P>>;
  getPermit?(pool: Pool, permitId: string): Promise<P | null>;
  contractOf?(permit: P): C;
  /** 终态记录（EK-3.3 记录义务）。 */
  settle(pool: Pool, permitId: string, outcome: PermitOutcome): Promise<P>;
}

/** 泛型 modelFn 上下文（permit 与合同的具体类型由空间决定）。 */
export interface PermittedCallContext<P extends ExecutorPermitLike, C extends ExecutorContractLike> {
  permit: P;
  contract: C;
  signal?: AbortSignal;
}

export interface RunPermittedCallOptions<P extends ExecutorPermitLike, C extends ExecutorContractLike, A = unknown> {
  contract: C;
  budget: PlanAuthBudget;
  modelFn: (ctx: PermittedCallContext<P, C>) => Promise<A>;
  simulated: boolean;
  holderId?: string | undefined;
  lease?: ExecutionLease | undefined;
  preflight?: (() => Promise<void> | void) | undefined;
  checkpoint?: { input: unknown; transport: unknown } | undefined;
  pollMs?: number | undefined;
}

export interface PermittedCallSuccess<P extends ExecutorPermitLike, A = unknown> {
  permit: P;
  output: A;
}

/** A/J 空间：既有 exec_permit 行为的 PermitSpace 装配（行为与 R31 前完全一致）。 */
export const AJ_PERMIT_SPACE: PermitSpace<ModelPermit, ModelCallContract> = {
  leaseSpace: 'kernel',
  getPermit,
  contractOf: (p) => p.contract,
  assertLock: (pool, lease) => assertLockHeld(pool, lease),
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
  if (space.leaseSpace) {
    const leaseSpace = space.leaseSpace;
    return recordAttempt(pool, leaseSpace, opts.contract, async () => {
      // Refusal remains visible but never consumes the send-once marker.
      await opts.preflight?.();
      return withExecutionLease(pool, leaseSpace, (guard) => executePermittedCall(space, pool, opts, guard), opts);
    });
  }
  // Explicit injected permit spaces are used by pure contract tests; production spaces always have a leaseSpace.
  await opts.preflight?.();
  return executePermittedCall(space, pool, opts);
}

async function executePermittedCall<P extends ExecutorPermitLike, C extends ExecutorContractLike, A>(
  space: PermitSpace<P, C>, pool: Pool, opts: RunPermittedCallOptions<P, C, A>, guard?: LeaseGuard,
): Promise<PermittedCallSuccess<P, A>> {
  const { contract, budget, modelFn } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const settleOwned = (id: string, outcome: PermitOutcome, preparedOnly = false): Promise<P> => guard ? withTransaction(pool, async (tx) => {
    await assertLease(tx, guard.lease, true);
    if (preparedOnly) {
      await tx.query(guard.lease.space === 'kernel'
        ? 'select permit_id from exec_permit where permit_id=$1::uuid for update'
        : 'select call_id from sr_call where call_id=$1::uuid for update', [id]);
      const current = await space.getPermit?.(tx as unknown as Pool, id);
      if (current?.state !== 'PREPARED' || current.sentAt !== null) throw new KernelError('PERMIT_STATE_INVALID', 'Expired queue waiter cannot close a sent call');
      if (!space.contractOf || contractHash(space.contractOf(current)) !== contractHash(contract)) throw new KernelError('PERMIT_CONTRACT_CONFLICT', 'Expired queue waiter cannot close a replacement contract');
    }
    const result = await space.settle(tx as unknown as Pool, id, outcome);
    await assertLease(tx, guard.lease);
    return result;
  }) : space.settle(pool, id, outcome);
  const deadlineMs = Date.parse(contract.deadline);
  if (Number.isNaN(deadlineMs)) {
    throw new KernelError('PERMIT_STATE_INVALID', `contract.deadline 非法 ISO 时间: ${contract.deadline}`);
  }

  // 0) 生产空间强制执行租约；第二执行器在门入口被命名拒绝。
  await guard?.assert();

  // 1) 恢复守卫（EK-8.2/8.3）：RECONCILING 下任何执行操作 → RECOVERY_CONFIRM_REQUIRED，
  //    零模型调用、零 permit 落位。
  await space.assertRunning(pool);

  // 2) permit：预算判定 + send-once（EK-4.1/4.4/4.5）。
  const prepared = guard ? await withTransaction(pool, async (tx) => {
    await assertLease(tx, guard.lease, true);
    try { return await space.preparePermit(tx as unknown as Pool, contract, budget, { simulated: opts.simulated }); }
    catch (error) {
      // Budget refusal is an auditable never-sent attempt; commit its FAILED row before rethrowing.
      if (error instanceof KernelError && error.code === 'INPUT_OVER_BUDGET') return error;
      throw error;
    }
  }) : await space.preparePermit(pool, contract, budget, { simulated: opts.simulated });
  if (prepared instanceof KernelError) throw prepared;
  let permit = prepared;

  // 3) 并发闸（EK-2.3/7.1）：超出排队不报错；窗口内等不到则未按窗完成。
  for (;;) {
    await guard?.assert();
    const r = await space.tryMarkSent(pool, permit.permitId, budget.maxInFlight, guard?.lease, budget, contract);
    if (r.kind === 'SENT') {
      // 竞态修复（2026-10-26）：tryMarkSent 返回 SENT 的瞬间 deadline 可能恰好已过
      // （DB 时钟 vs 本地时钟的毫秒级边界）——复查并按未按窗完成落库
      if (Date.now() >= deadlineMs) {
        await settleOwned(permit.permitId, { result: 'UNKNOWN', basis: 'DEADLINE_EXCEEDED' });
        throw new KernelError('DEADLINE_EXCEEDED',
          `并发位获取后瞬间窗口关闭（deadline=${contract.deadline}）：按未按窗完成落库（竞态修复 2026-10-26）`);
      }
      permit = r.permit;
      break;
    }
    if (r.kind === 'IN_FLIGHT_FULL') {
      if (Date.now() >= deadlineMs) {
        // The fenced lease lock serializes sends; a stale waiter may close only its never-sent PREPARED row.
        await settleOwned(permit.permitId, { result: 'FAILED', failCode: 'DEADLINE_EXCEEDED' }, true);
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
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timerError: KernelError | undefined;
  const timerPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timerError = new KernelError('DEADLINE_EXCEEDED',
        `截止已到 modelFn 仍挂起（deadline=${contract.deadline}）：远端结局不明（EK-3.3/5，R22）`);
      controller.abort(timerError);
      reject(timerError);
    }, Math.max(0, deadlineMs - Date.now()));
  });
  const leaseLost = () => controller.abort(guard?.signal.reason);
  guard?.signal.addEventListener('abort', leaseLost, { once: true });
  const callPromise = Promise.resolve().then(async () => {
    await guard?.assert();
    if (controller.signal.aborted) throw controller.signal.reason;
    return modelFn({ permit, contract, signal: controller.signal });
  });
  callPromise.catch(() => {}); // 败者分支已被本函数处理，避免竞速后未处理拒绝
  try {
    const ownershipPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    const output = await Promise.race([callPromise, timerPromise, ownershipPromise]);
    await guard?.assert();
    // 竞速由 modelFn 胜出。wall clock 已过 deadline：结果已知但迟到（R22 分支 2）——
    // 成功照实 SUCCEEDED，fail_code=LATE_COMPLETED 诚实记时，不冒充按窗完成（EK-6.2）。
    let done: P;
    if (opts.checkpoint && guard) {
      try {
        await completeWithCheckpoint(pool, guard.lease, responseCheckpoint({ permitId: permit.permitId,
          contract, simulated: opts.simulated, ...opts.checkpoint, output }), Date.now() > deadlineMs);
      } catch (err) {
        throw new KernelError('RESULT_PERSISTENCE_UNKNOWN', `Response could not be committed with its checkpoint: ${err instanceof Error ? err.message : String(err)}`);
      }
      const saved = await space.getPermit?.(pool, permit.permitId);
      if (!saved) throw new KernelError('RESULT_PERSISTENCE_UNKNOWN', 'Committed result could not be read back');
      done = saved;
    } else {
      const outcome = Date.now() > deadlineMs ? { result: 'SUCCEEDED' as const, failCode: 'LATE_COMPLETED' } : { result: 'SUCCEEDED' as const };
      done = guard ? await withTransaction(pool, async (tx) => {
        await assertLease(tx, guard.lease, true);
        const result = await space.settle(tx as unknown as Pool, permit.permitId, outcome);
        await assertLease(tx, guard.lease);
        return result;
      }) : await settleOwned(permit.permitId, outcome);
    }
    return { permit: done, output };
  } catch (err) {
    controller.abort(err);
    if (err === timerError) {
      // R22 分支 1：截止先到且 modelFn 仍挂起——远端可能已产生结果与费用，标 FAILED
      // 宣称了未掌握的知识；判 UNKNOWN，"未按窗完成"的窗口分类由 fail_code 承载，
      // 不与 permit 态混同。处置走 EK-5：不自动重采样（同键新 permit 被 send-once 拦住）、
      // 不自动退役（只经 Owner 显式确认 retireUnknown，R21）。
      await settleOwned(permit.permitId, { result: 'UNKNOWN', basis: 'DEADLINE_EXCEEDED' }).catch(() => undefined);
      throw err;
    }
    if (err instanceof KernelError) {
      if (['SILENCE_AFTER_SEND', 'DSH_WORKER_FAILED', 'TIMEOUT', 'DEADLINE_EXCEEDED', 'EXECUTION_LOCK_HELD', 'RESULT_PERSISTENCE_UNKNOWN', 'MODEL_PROVIDER_EXIT_NONZERO', 'SR_REAL_EXIT_NONZERO', 'MODEL_FINAL_MISSING', 'SR_FINAL_MISSING', 'MODEL_OUTPUT_LIMIT_EXCEEDED', 'SR_OUTPUT_LIMIT_EXCEEDED'].includes(err.code)) {
        // EK-5.1/5.2：远端可能已成功、可能已计费，本地无证据不改口；迟到不改变"结局不明"。
        await settleOwned(permit.permitId, { result: 'UNKNOWN', basis: err.code }).catch(() => undefined);
        throw err;
      }
      if (Date.now() > deadlineMs) {
        // R22 分支 2（错误侧）：显式错误晚到——结局已知，按原错误码具名落 FAILED。
        await settleOwned(permit.permitId, { result: 'FAILED', failCode: err.code });
        throw err;
      }
      {
          // 远端显式失败或本地验证拒绝：具名记录（EK-3.3 FAILED 记录义务）。
          await settleOwned(permit.permitId, { result: 'FAILED', failCode: err.code });
          throw err;
      }
    }
    // 非 KernelError：本地异常，具名 MODEL_FN_ERROR，如实重抛原始错误。
    await settleOwned(permit.permitId, { result: 'UNKNOWN', basis: 'MODEL_FN_ERROR' });
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    guard?.signal.removeEventListener('abort', leaseLost);
    controller.abort(new KernelError('CALL_CLOSED', 'Call executor has closed; late work cannot publish'));
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
    lease: opts.lease,
    preflight: opts.preflight,
    checkpoint: opts.checkpoint,
    pollMs: opts.pollMs,
  });
  return r;
}

// failPreparedDeadline 仍由 permit.ts 导出（A/J 空间内部与恢复流程使用）；
// 此处 re-export 保持既有 import 路径兼容。
export { failPreparedDeadline };
