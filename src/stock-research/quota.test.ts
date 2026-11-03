/**
 * sr 配额单测 · code-writer-pro。隔离 schema + 真实 PG（127.0.0.1:5433）。
 * 覆盖：并发预约抗超额（20 路限 5 恰好 5 成）、退款正确且绝不退成负数、
 * 跨月 period 隔离（含上海时区月边界）、getQuotaUsage 按月汇总、
 * recordUsageEvent 落账。合成月份避开真实当月，用例彼此独立。
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { createAccount } from './accounts.js';
import { getQuotaUsage, recordUsageEvent, refundQuota, reserveQuota } from './quota.js';

const schema = `srquota_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let pool: Pool;
let admin: Pool;

before(async () => {
  admin = createPool();
  await applySchema(admin, schema, srMigrationSqlUrl);
  pool = createPool({ schema });
});

after(async () => {
  await pool.end();
  await dropSchema(admin, schema);
  await admin.end();
});

describe('reserveQuota 并发抗超额', () => {
  it('20 路并发（Promise.all）限额 5 → 恰好 5 路 ok、used 封顶 5、15 路被拒', async () => {
    const acc = await createAccount(pool, { username: 'burst_user', password: 'pw-12345678' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveQuota(pool, acc.accountId, 'REPORT_TASK', 5)),
    );
    assert.equal(results.filter((r) => r.ok).length, 5, '恰好 5 路预约成功');
    assert.equal(results.filter((r) => !r.ok).length, 15, '其余 15 路被拒');
    const [first] = results;
    assert.ok(first);
    for (const r of results) {
      assert.equal(r.limit, 5);
      assert.equal(r.period, first.period, '同一时刻同月');
    }
    const oks = results.filter((r) => r.ok).map((r) => r.used).sort((a, b) => a - b);
    assert.deepEqual(oks, [1, 2, 3, 4, 5], '成功者拿到的 used 恰为 1..5 各一次');
    for (const r of results.filter((x) => !x.ok)) {
      assert.equal(r.used, 5, '拒绝时读回的当前用量已封顶');
    }
    const usage = await getQuotaUsage(pool, acc.accountId);
    assert.deepEqual(usage.rows, [{ kind: 'REPORT_TASK', used: 5 }]);
  });
});

describe('refundQuota', () => {
  it('退款正确且绝不退成负数；退款释放的额度可再预约', async () => {
    const acc = await createAccount(pool, { username: 'refund_user', password: 'pw-12345678' });
    const r = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 10);
    assert.ok(r.ok && r.used === 1);
    await refundQuota(pool, acc.accountId, 'MODEL_CALL', r.period);
    assert.equal(
      (await getQuotaUsage(pool, acc.accountId)).rows.find((x) => x.kind === 'MODEL_CALL')?.used,
      0,
      '退一还一',
    );
    for (let i = 0; i < 5; i += 1) {
      await refundQuota(pool, acc.accountId, 'MODEL_CALL', r.period); // 连续多退
    }
    assert.equal(
      (await getQuotaUsage(pool, acc.accountId)).rows.find((x) => x.kind === 'MODEL_CALL')?.used,
      0,
      'greatest 兜底，不为负',
    );
    const again = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 10);
    assert.ok(again.ok && again.used === 1, '退款释放的额度可再约');
  });

  it('不存在的计数行退款 → 无操作不抛错', async () => {
    const acc = await createAccount(pool, { username: 'refund_gap', password: 'pw-12345678' });
    await refundQuota(pool, acc.accountId, 'REPORT_TASK', '2026-01');
    assert.deepEqual((await getQuotaUsage(pool, acc.accountId)).rows, []);
  });
});

describe('跨月 period 隔离（Asia/Shanghai）', () => {
  it('UTC 月末 17:30 归入上海次月；各月额度独立、getQuotaUsage 按月汇总', async () => {
    const acc = await createAccount(pool, { username: 'period_user', password: 'pw-12345678' });
    const aug = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-08-15T04:00:00Z'));
    assert.equal(aug.period, '2026-08');
    assert.ok(aug.ok);

    // 2026-08-31T17:30Z = 上海 2026-09-01T01:30 → 归入九月
    const sep = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-08-31T17:30:00Z'));
    assert.equal(sep.period, '2026-09');
    assert.ok(sep.ok);

    // 九月独立额度：补约到满 5，第 6 次被拒
    for (let i = 0; i < 3; i += 1) {
      const r = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-09-10T00:00:00Z'));
      assert.ok(r.ok);
    }
    const last = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-09-10T00:00:00Z'));
    assert.ok(last.ok && last.used === 5, '九月用满 5');
    assert.equal(
      (await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-09-10T00:00:00Z'))).ok,
      false,
      '九月超额拒绝',
    );

    // 八月不受九月用满影响（仍是 1，可继续约成 2）
    const augAgain = await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 5, new Date('2026-08-20T00:00:00Z'));
    assert.ok(augAgain.ok && augAgain.used === 2);

    const sepUsage = await getQuotaUsage(pool, acc.accountId, new Date('2026-09-15T00:00:00Z'));
    assert.equal(sepUsage.period, '2026-09');
    assert.equal(sepUsage.rows.find((x) => x.kind === 'MODEL_CALL')?.used, 5);
    const augUsage = await getQuotaUsage(pool, acc.accountId, new Date('2026-08-20T00:00:00Z'));
    assert.equal(augUsage.period, '2026-08');
    assert.equal(augUsage.rows.find((x) => x.kind === 'MODEL_CALL')?.used, 2);
  });
});

describe('getQuotaUsage 汇总', () => {
  it('同月两类 kind 汇总正确（自包含账户）', async () => {
    const acc = await createAccount(pool, { username: 'summary_user', password: 'pw-12345678' });
    await reserveQuota(pool, acc.accountId, 'REPORT_TASK', 5);
    await reserveQuota(pool, acc.accountId, 'REPORT_TASK', 5);
    await reserveQuota(pool, acc.accountId, 'MODEL_CALL', 60);
    const usage = await getQuotaUsage(pool, acc.accountId);
    assert.ok(/^\d{4}-\d{2}$/.test(usage.period));
    assert.equal(usage.rows.find((x) => x.kind === 'REPORT_TASK')?.used, 2);
    assert.equal(usage.rows.find((x) => x.kind === 'MODEL_CALL')?.used, 1);
    assert.equal(usage.rows.length, 2);
  });
});

describe('recordUsageEvent', () => {
  it('落账含可选 taskId 与 detail；缺省 detail 为空对象', async () => {
    const acc = await createAccount(pool, { username: 'event_user', password: 'pw-12345678' });
    const taskId = randomUUID();
    await recordUsageEvent(pool, acc.accountId, 'TASK_CREATED', { subject: '600941' }, taskId);
    await recordUsageEvent(pool, acc.accountId, 'QUOTA_REFUND', { kind: 'REPORT_TASK' });
    await recordUsageEvent(pool, acc.accountId, 'TASK_COMPLETED'); // 缺省 detail
    const rows = await pool.query<{ kind: string; task_id: string | null; detail: { subject?: string } }>(
      'select kind, task_id, detail from sr_usage_event where account_id = $1::uuid',
      [acc.accountId],
    );
    assert.equal(rows.rows.length, 3);
    const created = rows.rows.find((r) => r.kind === 'TASK_CREATED');
    assert.equal(created?.task_id, taskId);
    assert.equal(created?.detail.subject, '600941');
    const refund = rows.rows.find((r) => r.kind === 'QUOTA_REFUND');
    assert.equal(refund?.task_id, null);
    assert.deepEqual(refund?.detail, { kind: 'REPORT_TASK' });
    const done = rows.rows.find((r) => r.kind === 'TASK_COMPLETED');
    assert.deepEqual(done?.detail, {}, '缺省 detail 落空对象');
  });
});
