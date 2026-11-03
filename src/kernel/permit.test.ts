/**
 * W1 单测 · permit 生命周期（EK-3/4/5/6）：预算阻断与修复重试、send-once 幂等、
 * 状态机非法迁移、markSent 截止、UNKNOWN 退役须 confirmedBy。隔离 schema 生命周期同 lock.test。
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { KernelError, type ModelCallContract, type ModelPermit, type PlanAuthBudget } from '../contracts.js';
import {
  countInFlight,
  failPreparedDeadline,
  findPermitByBusinessKey,
  getPermit,
  listUnclosedPermits,
  markSent,
  preparePermit,
  retireUnknown,
  settle,
  tryMarkSent,
} from './permit.js';

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

function mkContract(o: Partial<ModelCallContract> = {}, subject = '600519'): ModelCallContract {
  return {
    businessKey: {
      subjectKind: 'STOCK',
      subject,
      researchKind: 'WEEKLY',
      cutoff: '2026-10-24T15:00:00.000Z',
    },
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

describe('preparePermit：预算判定（EK-4.4/4.5）', () => {
  it('超预算 → 具名阻断 INPUT_OVER_BUDGET，落 FAILED 行、不进 SENT、不截断', async () => {
    const contract = mkContract({ inputBytes: 6000 }, '600100');
    await assertKernelError(() => preparePermit(pool, contract, budget), 'INPUT_OVER_BUDGET');
    const row = await findPermitByBusinessKey(pool, contract);
    assert.ok(row, '阻断行应落库');
    assert.equal(row.state, 'FAILED');
    assert.equal(row.failCode, 'INPUT_OVER_BUDGET');
    assert.equal(row.sentAt, null, '不进 SENT：发送从未发起');
    assert.equal(row.contract.inputBytes, 6000, '不截断：原样记录超预算字节数');
  });

  it('修复后同键重试：NOT_SENT 出口被替换，最终 SENT 计数为 1（EK-4.4）', async () => {
    const contract = mkContract({ inputBytes: 4500, inputHash: 'b'.repeat(64) }, '600101');
    const permit = await preparePermit(pool, contract, budget);
    assert.equal(permit.state, 'PREPARED');
    const sent = await markSent(pool, permit.permitId);
    assert.equal(sent.state, 'SENT');
    await settle(pool, permit.permitId, { result: 'SUCCEEDED' });
    const rows = await pool.query(
      `select count(*)::int as n from exec_permit where subject = '600101' and sent_at is not null`,
    );
    assert.equal(rows.rows[0].n, 1, '同键已发送计数为 1');
  });

  it('键上已有已发送链时，超预算提交不覆盖既有链（send-once 优先）', async () => {
    const key = '600102';
    const ok = await preparePermit(pool, mkContract({ inputBytes: 100 }, key), budget);
    await markSent(pool, ok.permitId);
    await settle(pool, ok.permitId, { result: 'SUCCEEDED' });
    await assertKernelError(
      () => preparePermit(pool, mkContract({ inputBytes: 9999 }, key), budget),
      'BUSINESS_KEY_ALREADY_SENT',
    );
    const after = await getPermit(pool, ok.permitId);
    assert.equal(after?.state, 'SUCCEEDED', '既有成功链未被阻断行覆盖');
  });
});

describe('send-once（EK-4.1/4.2）', () => {
  it('同键重复提交（SUCCEEDED/SENT/UNKNOWN 后）→ BUSINESS_KEY_ALREADY_SENT', async () => {
    // SUCCEEDED 后
    const k1 = mkContract({ inputBytes: 100 }, '600200');
    const p1 = await preparePermit(pool, k1, budget);
    await markSent(pool, p1.permitId);
    await settle(pool, p1.permitId, { result: 'SUCCEEDED' });
    await assertKernelError(() => preparePermit(pool, mkContract({}, '600200'), budget), 'BUSINESS_KEY_ALREADY_SENT');
    // SENT 中
    const k2 = mkContract({ inputBytes: 100 }, '600201');
    const p2 = await preparePermit(pool, k2, budget);
    await markSent(pool, p2.permitId);
    await assertKernelError(() => preparePermit(pool, mkContract({}, '600201'), budget), 'BUSINESS_KEY_ALREADY_SENT');
    await settle(pool, p2.permitId, { result: 'SUCCEEDED' }); // 清场：不向后继测试泄漏在途 SENT
    // UNKNOWN 后（EK-5.2：不自动重采样）
    const k3 = mkContract({ inputBytes: 100 }, '600202');
    const p3 = await preparePermit(pool, k3, budget);
    await markSent(pool, p3.permitId);
    await settle(pool, p3.permitId, { result: 'UNKNOWN', basis: 'TEST' });
    await assertKernelError(() => preparePermit(pool, mkContract({}, '600202'), budget), 'BUSINESS_KEY_ALREADY_SENT');
  });

  it('并发两次 prepare 同键：只留一行 PREPARED（不会双发）', async () => {
    const [a, b] = await Promise.all([
      preparePermit(pool, mkContract({ inputHash: 'c'.repeat(64) }, '600203'), budget),
      preparePermit(pool, mkContract({ inputHash: 'd'.repeat(64) }, '600203'), budget),
    ]);
    const rows = await pool.query(`select * from exec_permit where subject = '600203'`);
    assert.equal(rows.rows.length, 1, '每键至多一行（唯一约束 + 原子替换）');
    const survived = rows.rows[0];
    assert.equal(survived.state, 'PREPARED');
    assert.ok(
      survived.permit_id === a.permitId || survived.permit_id === b.permitId,
      '幸存行是两次提交之一',
    );
  });

  it('阶段（A/J）不同即不同业务键，互不阻塞', async () => {
    const aPermit = await preparePermit(pool, mkContract({ inputBytes: 100, stage: 'A' }, '600204'), budget);
    const jPermit = await preparePermit(pool, mkContract({ inputBytes: 100, stage: 'J' }, '600204'), budget);
    assert.notEqual(aPermit.permitId, jPermit.permitId);
    // 资料截点不同也是新键（新键重研的路径）
    const newCutoff = mkContract(
      { inputBytes: 100, businessKey: { subjectKind: 'STOCK', subject: '600204', researchKind: 'WEEKLY', cutoff: '2026-10-31T15:00:00.000Z' } },
      '600204',
    );
    const p = await preparePermit(pool, newCutoff, budget);
    assert.equal(p.state, 'PREPARED');
  });
});

describe('状态机（EK-3.3）', () => {
  it('PREPARED→SUCCEEDED / PREPARED→UNKNOWN 非法', async () => {
    const p = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600300'), budget);
    await assertKernelError(() => settle(pool, p.permitId, { result: 'SUCCEEDED' }), 'PERMIT_STATE_INVALID');
    await assertKernelError(() => settle(pool, p.permitId, { result: 'UNKNOWN', basis: 'X' }), 'PERMIT_STATE_INVALID');
    assert.equal((await getPermit(pool, p.permitId))?.state, 'PREPARED', '非法迁移不改状态');
  });

  it('PREPARED→FAILED 合法（发送前置失败出口）', async () => {
    const p = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600301'), budget);
    const after = await settle(pool, p.permitId, { result: 'FAILED', failCode: 'PRECHECK' });
    assert.equal(after.state, 'FAILED');
    assert.equal(after.failCode, 'PRECHECK');
    assert.equal(after.sentAt, null);
  });

  it('终态无出边：SUCCEEDED→FAILED、UNKNOWN→SUCCEEDED、二次 markSent 均非法', async () => {
    const p1 = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600302'), budget);
    await markSent(pool, p1.permitId);
    await settle(pool, p1.permitId, { result: 'SUCCEEDED' });
    await assertKernelError(() => settle(pool, p1.permitId, { result: 'FAILED', failCode: 'X' }), 'PERMIT_STATE_INVALID');
    await assertKernelError(() => settle(pool, p1.permitId, { result: 'UNKNOWN', basis: 'X' }), 'PERMIT_STATE_INVALID');
    await assertKernelError(() => markSent(pool, p1.permitId), 'PERMIT_STATE_INVALID');

    const p2 = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600303'), budget);
    await markSent(pool, p2.permitId);
    await settle(pool, p2.permitId, { result: 'UNKNOWN', basis: 'X' });
    await assertKernelError(() => settle(pool, p2.permitId, { result: 'SUCCEEDED' }), 'PERMIT_STATE_INVALID');
    // UNKNOWN 也不得被改写为 FAILED（EK-5.1：不改口）
    await assertKernelError(() => settle(pool, p2.permitId, { result: 'FAILED', failCode: 'X' }), 'PERMIT_STATE_INVALID');
  });

  it('SETTLE 不存在的 permit → PERMIT_STATE_INVALID', async () => {
    await assertKernelError(
      () => settle(pool, randomUUID(), { result: 'SUCCEEDED' }),
      'PERMIT_STATE_INVALID',
    );
  });

  it('SENT→{SUCCEEDED|FAILED|UNKNOWN} 全部合法且记录 fail_code/时刻', async () => {
    const cases: Array<{ subject: string; outcome: { result: 'SUCCEEDED' } | { result: 'FAILED'; failCode: string } | { result: 'UNKNOWN'; basis: string }; expectedFailCode: string | null }> = [
      { subject: '600310', outcome: { result: 'SUCCEEDED' }, expectedFailCode: null },
      { subject: '600311', outcome: { result: 'FAILED', failCode: 'EXPLICIT_FAIL' }, expectedFailCode: 'EXPLICIT_FAIL' },
      { subject: '600312', outcome: { result: 'UNKNOWN', basis: 'CONN_LOST' }, expectedFailCode: 'CONN_LOST' },
    ];
    for (const c of cases) {
      const p = await preparePermit(pool, mkContract({ inputBytes: 100 }, c.subject), budget);
      await markSent(pool, p.permitId);
      const after = await settle(pool, p.permitId, c.outcome);
      assert.equal(after.state, c.outcome.result);
      assert.ok(after.settledAt, '终态记录时刻');
      assert.equal(after.failCode, c.expectedFailCode);
    }
  });
});

describe('markSent 截止（EK-6）', () => {
  it('发送前截止已过 → DEADLINE_EXCEEDED，FAILED/DEADLINE_EXCEEDED 且未发送', async () => {
    const contract = mkContract(
      { inputBytes: 100, deadline: new Date(Date.now() - 1000).toISOString() },
      '600400',
    );
    const p = await preparePermit(pool, contract, budget);
    await assertKernelError(() => markSent(pool, p.permitId), 'DEADLINE_EXCEEDED');
    const after = await getPermit(pool, p.permitId);
    assert.equal(after?.state, 'FAILED');
    assert.equal(after?.failCode, 'DEADLINE_EXCEEDED');
    assert.equal(after?.sentAt, null, '未按窗完成 ≠ 已发送');
  });

  it('截止后重试同键（新截止）被允许：NEVER_SENT 行可替换，最终 SENT=1', async () => {
    const contract = mkContract(
      { inputBytes: 100, deadline: new Date(Date.now() + 60_000).toISOString() },
      '600401',
    );
    const p = await preparePermit(pool, contract, budget);
    assert.equal(p.state, 'PREPARED');
    const sent = await markSent(pool, p.permitId);
    assert.equal(sent.state, 'SENT');
    await settle(pool, p.permitId, { result: 'SUCCEEDED' });
    const rows = await pool.query(
      `select count(*)::int as n from exec_permit where subject = '600401' and sent_at is not null`,
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('failPreparedDeadline 只关已过截止的 PREPARED 行，幂等安全', async () => {
    // 未过截止：不动
    const fresh = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600402'), budget);
    assert.equal(await failPreparedDeadline(pool, fresh.permitId), null, '未过截止不得关闭');
    assert.equal((await getPermit(pool, fresh.permitId))?.state, 'PREPARED');
    // 已过截止：关闭为 FAILED/DEADLINE_EXCEEDED，且不重复关闭
    const stale = await preparePermit(
      pool,
      mkContract({ inputBytes: 100, deadline: new Date(Date.now() - 1000).toISOString() }, '600403'),
      budget,
    );
    const failed = await failPreparedDeadline(pool, stale.permitId);
    assert.equal(failed?.state, 'FAILED');
    assert.equal(failed?.failCode, 'DEADLINE_EXCEEDED');
    assert.equal(await failPreparedDeadline(pool, stale.permitId), null, '终态不再重复关闭');
  });
});

describe('tryMarkSent 并发闸（EK-2.3/7.1）', () => {
  it('在途满 → IN_FLIGHT_FULL；有空位 → SENT', async () => {
    const p0 = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600500'), budget);
    const p1 = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600501'), budget);
    const p2 = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600502'), budget);
    assert.equal((await tryMarkSent(pool, p0.permitId, 2)).kind, 'SENT');
    assert.equal((await tryMarkSent(pool, p1.permitId, 2)).kind, 'SENT');
    assert.equal(await countInFlight(pool), 2);
    const full = await tryMarkSent(pool, p2.permitId, 2);
    assert.equal(full.kind, 'IN_FLIGHT_FULL');
    assert.equal((await getPermit(pool, p2.permitId))?.state, 'PREPARED', '排队不报错、不降配额');
    await settle(pool, p0.permitId, { result: 'SUCCEEDED' });
    const now = await tryMarkSent(pool, p2.permitId, 2);
    assert.equal(now.kind, 'SENT');
  });
});

describe('UNKNOWN 本地退役（EK-5.3 + R21）', () => {
  async function mkUnknown(subject: string): Promise<string> {
    const p = await preparePermit(pool, mkContract({ inputBytes: 100 }, subject), budget);
    await markSent(pool, p.permitId);
    await settle(pool, p.permitId, { result: 'UNKNOWN', basis: 'TEST_SILENCE' });
    return p.permitId;
  }

  it('confirmedBy 为空 → UNKNOWN_NOT_RETIRED（无无确认退役路径）', async () => {
    const id = await mkUnknown('600600');
    await assertKernelError(() => retireUnknown(pool, id, ''), 'UNKNOWN_NOT_RETIRED');
    await assertKernelError(() => retireUnknown(pool, id, '   '), 'UNKNOWN_NOT_RETIRED');
    const receipts = await pool.query('select * from retirement_receipt');
    assert.equal(receipts.rows.length, 0, '空确认不落回执');
  });

  it('非 UNKNOWN 态 → PERMIT_STATE_INVALID', async () => {
    const p = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600601'), budget);
    await markSent(pool, p.permitId);
    await settle(pool, p.permitId, { result: 'SUCCEEDED' });
    await assertKernelError(() => retireUnknown(pool, p.permitId, 'owner'), 'PERMIT_STATE_INVALID');
  });

  it('合法退役：回执落库，remote_result/remote_cost 恒 UNKNOWN，幂等', async () => {
    const id = await mkUnknown('600602');
    const receipt = await retireUnknown(pool, id, 'owner-yeemio');
    assert.equal(receipt.permitId, id);
    assert.equal(receipt.confirmedBy, 'owner-yeemio');
    assert.equal(receipt.remoteResult, 'UNKNOWN');
    assert.equal(receipt.remoteCost, 'UNKNOWN');
    assert.ok(receipt.confirmedAt);
    const again = await retireUnknown(pool, id, 'owner-yeemio');
    assert.equal(again.receiptId, receipt.receiptId, '重复退役幂等返回既有回执');
    const rows = await pool.query('select count(*)::int as n from retirement_receipt');
    assert.equal(rows.rows[0].n, 1);
    assert.equal((await getPermit(pool, id))?.state, 'UNKNOWN', '退役不改写状态（终态无出边）');
    // 退役后同键仍不可重采样；新资料截点另立新键可研究（EK-5.6 步 5）
    await assertKernelError(() => preparePermit(pool, mkContract({}, '600602'), budget), 'BUSINESS_KEY_ALREADY_SENT');
  });
});

describe('listUnclosedPermits（EK-8.2 的 pending 语义）', () => {
  it('SENT 未终结与未退役 UNKNOWN 计入；退役后移出', async () => {
    const sent = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600700'), budget);
    await markSent(pool, sent.permitId);
    const unk = await preparePermit(pool, mkContract({ inputBytes: 100 }, '600701'), budget);
    await markSent(pool, unk.permitId);
    await settle(pool, unk.permitId, { result: 'UNKNOWN', basis: 'TEST' });
    let pending = await listUnclosedPermits(pool);
    assert.ok(pending.some((p) => p.permitId === sent.permitId));
    assert.ok(pending.some((p) => p.permitId === unk.permitId));
    await retireUnknown(pool, unk.permitId, 'owner');
    pending = await listUnclosedPermits(pool);
    assert.ok(!pending.some((p) => p.permitId === unk.permitId), '已退役 UNKNOWN 不再 pending');
  });
});
