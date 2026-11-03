/**
 * W1 单测 · 启动诊断与恢复（EK-8）：RECONCILING 进入/零模型调用/RECOVERY_CONFIRM_REQUIRED/
 * 显式确认回 RUNNING/UNKNOWN 保持待退役、diagnose 三问。
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { KernelError, type ModelCallContract, type PlanAuthBudget } from '../contracts.js';
import { markSent, preparePermit, retireUnknown, settle } from './permit.js';
import { runModelCall, type ModelFn } from './executor.js';
import { assertRunning, bootRecovery, confirmRecovery, diagnose, getRecoveryState } from './recovery.js';

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
  maxModelCallsPerWeek: 40,
  maxInputBytes: 5000,
  maxInFlight: 2,
};

function mkContract(subject: string, o: Partial<ModelCallContract> = {}): ModelCallContract {
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

const noopModel: ModelFn = async () => ({ v: 1 });

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

/** 直接造一个 SENT 未终结的 permit（模拟进程死亡现场，绕过 executor 走内表）。 */
async function seedSentPermit(subject: string): Promise<string> {
  const p = await preparePermit(pool, mkContract(subject), budget);
  await markSent(pool, p.permitId);
  return p.permitId;
}

describe('bootRecovery（EK-8.2）', () => {
  it('干净启动保持 RUNNING', async () => {
    const s = await bootRecovery(pool);
    assert.equal(s.lifecycle, 'RUNNING');
    assert.deepEqual(s.pendingPermitIds, []);
  });

  it('存在 SENT 未终结 → RECONCILING 并登记 pending；重复 boot 不自动退出', async () => {
    const id = await seedSentPermit('602500');
    const s = await bootRecovery(pool);
    assert.equal(s.lifecycle, 'RECONCILING');
    assert.ok(s.pendingPermitIds.includes(id));
    const again = await bootRecovery(pool);
    assert.equal(again.lifecycle, 'RECONCILING', '恢复确认是唯一出口，重启不自动续跑');
  });

  it('未退役 UNKNOWN 也计入 pending；退役后不再计入', async () => {
    const id = await seedSentPermit('602501');
    await settle(pool, id, { result: 'UNKNOWN', basis: 'TEST_CRASH' });
    let s = await bootRecovery(pool);
    assert.ok(s.pendingPermitIds.includes(id));
    await retireUnknown(pool, id, 'owner');
    s = await bootRecovery(pool);
    // 已退役 UNKNOWN 不再 pending；但 lifecycle 仍 RECONCILING（需显式确认才能回 RUNNING）
    assert.equal(s.lifecycle, 'RECONCILING');
    assert.ok(!s.pendingPermitIds.includes(id));
    await confirmRecovery(pool, 'owner');
  });
});

describe('RECONCILING 下的执行守卫（EK-8.2/8.3）', () => {
  it('assertRunning 抛 RECOVERY_CONFIRM_REQUIRED；runModelCall 零模型调用、零 permit 落位', async () => {
    const id = await seedSentPermit('602510');
    await bootRecovery(pool);
    const err = await assertKernelError(() => assertRunning(pool), 'RECOVERY_CONFIRM_REQUIRED');
    assert.match(err.message, new RegExp(id.slice(0, 8)), '错误信息含 pending permit 标识');

    let calls = 0;
    const modelFn: ModelFn = async () => { calls++; return {}; };
    const before = await pool.query(`select count(*)::int as n from exec_permit`);
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract('602511'), budget, modelFn, simulated: true }),
      'RECOVERY_CONFIRM_REQUIRED',
    );
    assert.equal(calls, 0, 'RECONCILING 下零模型调用');
    const after = await pool.query(`select count(*)::int as n from exec_permit`);
    assert.equal(after.rows[0].n, before.rows[0].n, '守卫先于 permit 落位');
  });
});

describe('confirmRecovery（EK-8.3）', () => {
  it('无确认人 → RECOVERY_CONFIRM_REQUIRED；RUNNING 下调用为幂等 no-op', async () => {
    await seedSentPermit('602520');
    await bootRecovery(pool);
    await assertKernelError(() => confirmRecovery(pool, ''), 'RECOVERY_CONFIRM_REQUIRED');
    await assertKernelError(() => confirmRecovery(pool, '  '), 'RECOVERY_CONFIRM_REQUIRED');
    await confirmRecovery(pool, 'owner-yeemio'); // 先确认一次清场
    const again = await confirmRecovery(pool, 'owner-yeemio');
    assert.equal(again.state.lifecycle, 'RUNNING');
    assert.deepEqual(again.resolved, []);
  });

  it('默认：SENT 无证据 → UNKNOWN（不改口）；确认后 RUNNING、可执行新键', async () => {
    const id = await seedSentPermit('602521');
    await bootRecovery(pool);
    const { state, resolved } = await confirmRecovery(pool, 'owner-yeemio');
    assert.equal(state.lifecycle, 'RUNNING');
    assert.deepEqual(state.pendingPermitIds, []);
    // 子集断言：前序测试可能遗留本键之外的 pending（UNKNOWN 待退役等），只断言本 permit 的裁决
    assert.deepEqual(
      resolved.filter((r) => r.permitId === id),
      [{ permitId: id, from: 'SENT', to: 'UNKNOWN' }],
    );
    const p = await pool.query(`select state, fail_code from exec_permit where permit_id=$1`, [id]);
    assert.equal(p.rows[0].state, 'UNKNOWN');
    assert.equal(p.rows[0].fail_code, 'RECOVERY_UNCONFIRMED');
    // 新键（新截点）可正常执行；同键仍被 send-once 拦住
    const ok = await runModelCall(pool, {
      contract: mkContract('602522', { businessKey: { subjectKind: 'STOCK', subject: '602522', researchKind: 'WEEKLY', cutoff: '2026-10-31T15:00:00.000Z' } }),
      budget, modelFn: noopModel, simulated: true,
    });
    assert.equal(ok.permit.state, 'SUCCEEDED');
    await assertKernelError(
      () => runModelCall(pool, { contract: mkContract('602521'), budget, modelFn: noopModel, simulated: true }),
      'BUSINESS_KEY_ALREADY_SENT',
    );
  });

  it('resolver 判"结果可知"则按确认终态关闭；UNKNOWN pending 保持 UNKNOWN 待退役', async () => {
    const sentId = await seedSentPermit('602523');
    const unkContract = mkContract('602524');
    const unkPermit = await preparePermit(pool, unkContract, budget);
    await markSent(pool, unkPermit.permitId);
    await settle(pool, unkPermit.permitId, { result: 'UNKNOWN', basis: 'CRASH' });
    await bootRecovery(pool);
    const { resolved } = await confirmRecovery(pool, 'owner-yeemio', () => ({ outcome: 'SUCCEEDED' }));
    const relevant = resolved.filter((r) => r.permitId === sentId || r.permitId === unkPermit.permitId);
    assert.deepEqual(
      relevant.sort((a, b) => a.permitId.localeCompare(b.permitId)),
      [
        { permitId: unkPermit.permitId, from: 'UNKNOWN', to: 'UNKNOWN' },
        { permitId: sentId, from: 'SENT', to: 'SUCCEEDED' },
      ].sort((a, b) => a.permitId.localeCompare(b.permitId)),
    );
    assert.equal((await getRecoveryState(pool)).lifecycle, 'RUNNING');
    // UNKNOWN 待退役：Owner 显式确认后关闭
    const receipt = await retireUnknown(pool, unkPermit.permitId, 'owner-yeemio');
    assert.equal(receipt.remoteResult, 'UNKNOWN');
  });
});

describe('diagnose（EK-8.1 三问：缺什么/什么状态/下一步）', () => {
  it('就绪：ok=true、lifecycle=RUNNING、hint 可读', async () => {
    const r = await diagnose(pool);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.lifecycle, 'RUNNING');
    assert.match(r.hint, /RUNNING/);
  });

  it('RECONCILING：pending 入报告、hint 指向 confirmRecovery', async () => {
    const id = await seedSentPermit('602530');
    await bootRecovery(pool);
    const r = await diagnose(pool);
    assert.equal(r.lifecycle, 'RECONCILING');
    assert.ok(r.pendingPermits.includes(id), '本测试种下的 permit 入 pending 报告');
    assert.match(r.hint, /confirmRecovery/);
    await confirmRecovery(pool, 'owner');
  });

  it('表缺失：missing 具名 TABLE_MISSING:*，hint 给出处置', async () => {
    const emptySchema = `w1_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`create schema "${emptySchema}"`);
    const emptyPool = createPool({ schema: emptySchema });
    try {
      const r = await diagnose(emptyPool);
      assert.equal(r.ok, false);
      assert.ok(r.missing.includes('TABLE_MISSING:exec_permit'), `missing=${r.missing.join(',')}`);
      assert.match(r.hint, /schema\.sql/);
    } finally {
      await emptyPool.end();
      await admin.query(`drop schema "${emptySchema}" cascade`);
    }
  });

  it('PG 不可达：missing 具名 PG_CONNECT:*', async () => {
    const prev = { host: process.env.LYRA_PG_HOST, port: process.env.LYRA_PG_PORT };
    process.env.LYRA_PG_HOST = '127.0.0.1';
    process.env.LYRA_PG_PORT = '1'; // 无人监听，连接拒绝
    const badPool = createPool();
    try {
      const r = await diagnose(badPool);
      assert.equal(r.ok, false);
      assert.equal(r.missing[0]?.startsWith('PG_CONNECT:'), true, `missing=${r.missing.join(',')}`);
      assert.match(r.hint, /PostgreSQL/);
    } finally {
      if (prev.host === undefined) delete process.env.LYRA_PG_HOST; else process.env.LYRA_PG_HOST = prev.host;
      if (prev.port === undefined) delete process.env.LYRA_PG_PORT; else process.env.LYRA_PG_PORT = prev.port;
      await badPool.end().catch(() => {});
    }
  });
});
