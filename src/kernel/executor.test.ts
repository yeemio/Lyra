/**
 * W1 单测 · 执行编排器：成功路径、预算/send-once/恢复/执行权四道闸、并发上限 2、
 * 截止三分支（R22：timer 胜出→UNKNOWN；迟到成功→LATE_COMPLETED；发送前过期→FAILED）、
 * SILENCE_AFTER_SEND→UNKNOWN 不自动重采样。
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import {
  KernelError,
  type ModelCallContract,
  type ModelPermit,
  type PlanAuthBudget,
} from '../contracts.js';
import { countInFlight, getPermit } from './permit.js';
import { runModelCall, type ModelFn } from './executor.js';
import { acquireExecutorLock, releaseExecutorLock } from './lock.js';
import { getRecoveryState } from './recovery.js';

const schema = `w1_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let pool: Pool;
let admin: Pool;

before(async () => {
  admin = createPool();
  await applySchema(admin, schema);
  pool = createPool({ schema });
});

after(async () => {
  await pool.end();
  await dropSchema(admin, schema);
  await admin.end();
});

const budget: PlanAuthBudget = {
  planAuthVersion: 'pa-0.1',
  maxModelCallsPerWeek: 500,
  scopeLimits: { weekly: 500, postEvent: 500 }, // Explicit synthetic test authorization; separate budget gate tests use small caps.
  maxInputBytes: 5000,
  maxInFlight: 2,
};

function mkContract(o: Partial<ModelCallContract> = {}, subject = '601519'): ModelCallContract {
  return {
    businessKey: { subjectKind: 'STOCK', subject, researchKind: 'WEEKLY', cutoff: '2026-10-24T15:00:00.000Z' },
    stage: 'A',
    inputHash: 'a'.repeat(64),
    inputBytes: 1000,
    methodVersion: 'm-0.1',
    planAuthVersion: 'pa-0.1',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    ...o,
  };
}

async function assertKernelError(fn: () => Promise<unknown>, code: string): Promise<KernelError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof KernelError, `应为 KernelError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  throw new Error(`期望抛 KernelError(${code})，实际未抛`);
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('runModelCall 成功路径', () => {
  it('permit PREPARED→SENT→SUCCEEDED，modelFn 收到 SENT permit 与合同', async () => {
    let seen: ModelPermit | undefined;
    const modelFn: ModelFn<{ answer: number }> = async (ctx) => {
      seen = ctx.permit;
      return { answer: 42 };
    };
    const r = await runModelCall(pool, { contract: mkContract({}, '601500'), budget, modelFn, simulated: true });
    assert.deepEqual(r.output, { answer: 42 });
    assert.equal(r.permit.state, 'SUCCEEDED');
    assert.ok(r.permit.sentAt, '记录发起时刻');
    assert.ok(r.permit.settledAt);
    assert.equal(seen?.state, 'SENT', 'modelFn 只在 SENT 后被调用（发送实际载体）');
    assert.equal(seen?.simulated, true, '模拟身份自我声明落 permit');
  });
});

describe('四道闸（零释放次序）', () => {
  it('预算超限 → INPUT_OVER_BUDGET，modelFn 零调用', async () => {
    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return {}; };
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract({ inputBytes: 9999 }, '601510'), budget, modelFn, simulated: true }),
      'INPUT_OVER_BUDGET',
    );
    assert.equal(calls, 0);
    const permit = await getPermit(
      pool,
      (await pool.query<{ permit_id: string }>(`select permit_id from exec_permit where subject='601510'`)).rows[0]!.permit_id,
    );
    assert.equal(permit?.state, 'FAILED');
    assert.equal(permit?.failCode, 'INPUT_OVER_BUDGET');
    assert.equal(permit?.sentAt, null);
  });

  it('send-once：同键第二次提交 → BUSINESS_KEY_ALREADY_SENT，modelFn 仅 1 次', async () => {
    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return { v: 1 }; };
    const first = await runModelCall(pool, { contract: mkContract({}, '601511'), budget, modelFn, simulated: true });
    assert.equal(first.permit.state, 'SUCCEEDED');
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract({}, '601511'), budget, modelFn, simulated: true }),
      'BUSINESS_KEY_ALREADY_SENT',
    );
    assert.equal(calls, 1, '重复提交零新增发送');
    const sent = await pool.query(
      `select count(*)::int as n from exec_permit where subject='601511' and sent_at is not null`,
    );
    assert.equal(sent.rows[0].n, 1);
  });

  it('预算阻断修复后重试同键：最终发送次数为 1（Done-when 1）', async () => {
    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return { v: 2 }; };
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract({ inputBytes: 8888 }, '601512'), budget, modelFn, simulated: true }),
      'INPUT_OVER_BUDGET',
    );
    const ok = await runModelCall(
      pool,
      { contract: mkContract({ inputBytes: 800, inputHash: 'f'.repeat(64) }, '601512'), budget, modelFn, simulated: true },
    );
    assert.equal(ok.permit.state, 'SUCCEEDED');
    assert.equal(calls, 1, '修复后重试最终发送次数为 1');
    const rows = await pool.query(
      `select count(*)::int as n from exec_permit where subject='601512' and sent_at is not null`,
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('执行权（可选 holderId）：非持有者 → EXECUTION_LOCK_HELD，零 permit 落位', async () => {
    const { lease } = await acquireExecutorLock(pool, 'exec-a');
    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return {}; };
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({}, '601513'), budget, modelFn, simulated: true, holderId: 'exec-b',
      }),
      'EXECUTION_LOCK_HELD',
    );
    assert.equal(calls, 0);
    const rows = await pool.query(`select count(*)::int as n from exec_permit where subject='601513'`);
    assert.equal(rows.rows[0].n, 0, '执行权拒绝先于 permit 落位');
    const ok = await runModelCall(pool, {
      contract: mkContract({}, '601513'), budget, modelFn, simulated: true, lease,
    });
    assert.equal(ok.permit.state, 'SUCCEEDED');
    await releaseExecutorLock(pool, lease);
  });
});

describe('并发闸：在途 ≤ maxInFlight=2（EK-2.3/7.1）', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('三路并发：仅 2 路进 SENT，第三路排队等待', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    const mk = (i: number): ModelFn => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await (gates[i] ?? assert.fail('gate 缺失')).promise;
      active--;
      return { i };
    };
    const calls = [0, 1, 2].map((i) =>
      runModelCall(pool, {
        contract: mkContract({}, `60152${i}`), budget, modelFn: mk(i), simulated: true,
      }),
    );
    try {
      await waitUntil(async () => (await countInFlight(pool)) === 2);
      const states = await pool.query<{ state: string }>(
        `select state from exec_permit where subject like '60152_'`,
      );
      const byState = states.rows.map((r) => r.state).sort();
      // 串行化只保证"至多 2 在途"，不保证进入次序：恰好 2 个 SENT + 1 个 PREPARED（排队）
      assert.deepEqual(byState, ['PREPARED', 'SENT', 'SENT'], '超额者排队不报错、不降配额');
    } finally {
      for (const g of gates) g.resolve();
    }
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r.permit.state === 'SUCCEEDED').length, 3);
    assert.equal(maxActive, 2, 'modelFn 并发峰值恰为 2');
    assert.equal(await countInFlight(pool), 0);
  });

  it('等待并发位期间窗口关闭 → DEADLINE_EXCEEDED 未按窗完成', async () => {
    const hold = [deferred(), deferred()];
    const holders = [0, 1].map((i) =>
      runModelCall(pool, {
        contract: mkContract({}, `60153${i}`), budget,
        modelFn: async () => { await (hold[i] ?? assert.fail('gate 缺失')).promise; return {}; },
        simulated: true,
      }),
    );
    await waitUntil(async () => (await countInFlight(pool)) === 2);
    const third = runModelCall(pool, {
      contract: mkContract({ deadline: new Date(Date.now() + 200).toISOString() }, '601532'),
      budget,
      modelFn: async () => { throw new Error('不应被调用'); },
      simulated: true,
    });
    try {
      await assertKernelError(() => third, 'DEADLINE_EXCEEDED');
      const row = await pool.query<{ state: string; fail_code: string | null }>(
        `select state, fail_code from exec_permit where subject = '601532'`,
      );
      assert.equal(row.rows[0]?.state, 'FAILED');
      assert.equal(row.rows[0]?.fail_code, 'DEADLINE_EXCEEDED');
    } finally {
      for (const h of hold) h.resolve();
    }
    await Promise.all(holders);
  });
});

describe('截止三分支（EK-6.2 + R22）', () => {
  it('发送前截止已过 → DEADLINE_EXCEEDED，modelFn 零调用', async () => {
    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return {}; };
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({ deadline: new Date(Date.now() - 1000).toISOString() }, '601540'),
        budget, modelFn, simulated: true,
      }),
      'DEADLINE_EXCEEDED',
    );
    assert.equal(calls, 0);
    const row = await pool.query(`select state, fail_code, sent_at from exec_permit where subject='601540'`);
    assert.equal(row.rows[0].state, 'FAILED');
    assert.equal(row.rows[0].fail_code, 'DEADLINE_EXCEEDED');
    assert.equal(row.rows[0].sent_at, null);
  });

  it('截止先到且 modelFn 仍挂起 → UNKNOWN/DEADLINE_EXCEEDED，不自动重采样（R22 分支 1）', async () => {
    let calls = 0;
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({ deadline: new Date(Date.now() + 120).toISOString() }, '601541'),
        budget,
        modelFn: async () => { calls++; await new Promise((r) => setTimeout(r, 500)); return {}; },
        simulated: true,
      }),
      'DEADLINE_EXCEEDED',
    );
    const row = await pool.query(`select state, fail_code, sent_at from exec_permit where subject='601541'`);
    assert.equal(row.rows[0].state, 'UNKNOWN', '远端结局不明 → UNKNOWN，不宣称 FAILED（R22）');
    assert.equal(row.rows[0].fail_code, 'DEADLINE_EXCEEDED', '未按窗完成的窗口分类由 fail_code 承载');
    assert.ok(row.rows[0].sent_at, '发送确实发起过');
    assert.equal((await getRecoveryState(pool)).lifecycle, 'RUNNING', 'UNKNOWN 是终态，不自动触发恢复');
    // 处置走 EK-5：不自动重采样——同键新尝试被 send-once 拦下，modelFn 零新增调用
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({}, '601541'), budget,
        modelFn: async () => { calls++; return {}; },
        simulated: true,
      }),
      'BUSINESS_KEY_ALREADY_SENT',
    );
    assert.equal(calls, 1);
  });

  it('modelFn 迟到成功（结果已知但晚于截止）→ SUCCEEDED + LATE_COMPLETED（R22 分支 2）', async () => {
    // 用阻塞块把 wall clock 推过 deadline，再让 modelFn 的到期回调先于内核计时器回调
    // 执行（libuv 计时器按到期时间排序：阻塞块 100ms 处忙等至 800ms → modelFn 200ms 处
    // → 内核计时器 350ms 处），从而命中"竞速由 modelFn 胜出、但此刻已过截止"的迟到分支。
    const blockUntil = Date.now() + 800;
    const blocker = setTimeout(() => { while (Date.now() < blockUntil) { /* 忙等 */ } }, 100);
    try {
      const r = await runModelCall(pool, {
        contract: mkContract({ deadline: new Date(Date.now() + 350).toISOString() }, '601543'),
        budget,
        modelFn: async () => { await new Promise((res) => setTimeout(res, 200)); return { late: true }; },
        simulated: true,
      });
      assert.deepEqual(r.output, { late: true });
      assert.equal(r.permit.state, 'SUCCEEDED', '结果已知且成功，照实 SUCCEEDED');
      assert.equal(r.permit.failCode, 'LATE_COMPLETED', '迟到成功诚实记时，不冒充按窗完成（R22）');
    } finally {
      clearTimeout(blocker);
    }
    const row = await pool.query(`select state, fail_code from exec_permit where subject='601543'`);
    assert.equal(row.rows[0].state, 'SUCCEEDED');
    assert.equal(row.rows[0].fail_code, 'LATE_COMPLETED');
  });

  it('显式错误晚到 → FAILED + 原错误码（R22 分支 2 错误侧）', async () => {
    const blockUntil = Date.now() + 800;
    const blocker = setTimeout(() => { while (Date.now() < blockUntil) { /* 忙等 */ } }, 100);
    try {
      await assertKernelError(
        () => runModelCall(pool, {
          contract: mkContract({ deadline: new Date(Date.now() + 350).toISOString() }, '601544'),
          budget,
          modelFn: async () => {
            await new Promise((res) => setTimeout(res, 200));
            throw new KernelError('EXPLICIT_FAIL', '迟到的远端显式失败');
          },
          simulated: true,
        }),
        'EXPLICIT_FAIL',
      );
    } finally {
      clearTimeout(blocker);
    }
    const row = await pool.query(`select state, fail_code from exec_permit where subject='601544'`);
    assert.equal(row.rows[0].state, 'FAILED');
    assert.equal(row.rows[0].fail_code, 'EXPLICIT_FAIL', '晚到的显式错误按原错误码落库，不冒充 DEADLINE_EXCEEDED');
  });

  it('modelFn 窗内注入 TIMEOUT 故障 → UNKNOWN/TIMEOUT', async () => {
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({}, '601542'), budget,
        modelFn: async () => { throw new KernelError('TIMEOUT', '模拟超时'); },
        simulated: true,
      }),
      'TIMEOUT',
    );
    const row = await pool.query(`select state, fail_code from exec_permit where subject='601542'`);
    assert.equal(row.rows[0].state, 'UNKNOWN');
    assert.equal(row.rows[0].fail_code, 'TIMEOUT');
  });
});

describe('发送后故障（EK-5）', () => {
  it('SILENCE_AFTER_SEND → UNKNOWN：不自动重采样、同键新 permit 被拒', async () => {
    let calls = 0;
    const modelFn: ModelFn = async () => {
      calls++;
      throw new KernelError('SILENCE_AFTER_SEND', '模拟发送后失联');
    };
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract({}, '601550'), budget, modelFn, simulated: true }),
      'SILENCE_AFTER_SEND',
    );
    const row = await pool.query(`select state, fail_code, sent_at from exec_permit where subject='601550'`);
    assert.equal(row.rows[0].state, 'UNKNOWN');
    assert.equal(row.rows[0].fail_code, 'SILENCE_AFTER_SEND');
    assert.ok(row.rows[0].sent_at, '发送确实发起过');
    // 不自动重采样（EK-5.2）：同键提交被拒，modelFn 仍只调用过 1 次
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract({}, '601550'), budget, modelFn, simulated: true }),
      'BUSINESS_KEY_ALREADY_SENT',
    );
    assert.equal(calls, 1);
  });

  it('EXPLICIT_FAIL → FAILED 具名；非 KernelError → UNKNOWN/MODEL_FN_ERROR 且重抛', async () => {
    await assertKernelError(
      () => runModelCall(pool, {
        contract: mkContract({}, '601551'), budget,
        modelFn: async () => { throw new KernelError('EXPLICIT_FAIL', '远端显式失败'); },
        simulated: true,
      }),
      'EXPLICIT_FAIL',
    );
    let row = await pool.query(`select state, fail_code from exec_permit where subject='601551'`);
    assert.equal(row.rows[0].state, 'FAILED');
    assert.equal(row.rows[0].fail_code, 'EXPLICIT_FAIL');
    await assertThrowsAsync(
      () => runModelCall(pool, {
        contract: mkContract({}, '601552'), budget,
        modelFn: async () => { throw new Error('boom'); },
        simulated: true,
      }),
      /boom/,
    );
    row = await pool.query(`select state, fail_code from exec_permit where subject='601552'`);
    assert.equal(row.rows[0].state, 'UNKNOWN');
    assert.equal(row.rows[0].fail_code, 'MODEL_FN_ERROR');
  });
});

async function assertThrowsAsync(fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), re);
    return;
  }
  throw new Error(`期望抛出匹配 ${re} 的错误，实际未抛`);
}
