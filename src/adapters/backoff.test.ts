/**
 * Lyra · 退避器/并发闸/暂停上报 单测（P1 W4）。不碰外网；DB 用隔离 schema（本地 lyra-pg）。
 * 合同判定：DATA-SOURCES §7（30s/60s/120s、第 4 次不再发起、暂停上报四要素落库）、EK-7.2/EK-7.3。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { AdapterError, TransientAdapterError } from './adapter-types.js';
import {
  AdapterPauseError,
  BACKOFF_BASE_DELAY_MS,
  ConcurrencyGate,
  applyP1Migration,
  loadPauseReports,
  resumePause,
  runWithBackoff,
  type BackoffSleeper,
} from './backoff.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';

/** 注入睡眠：记录等待序列并立即放行（秒级加速退避）。 */
function recordingSleeper(): { sleeper: BackoffSleeper; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleeper: { sleep: async (ms) => { waits.push(ms); } } };
}

test('退避序列 30s/60s/120s，3 次尝试后暂停，第 4 次不再发起（DATA-SOURCES §7 判定）', async () => {
  const { waits, sleeper } = recordingSleeper();
  let calls = 0;
  await assert.rejects(
    runWithBackoff(
      async () => {
        calls += 1;
        throw new TransientAdapterError('BS_RATE_LIMITED', '网络接口错误');
      },
      { adapter: 'baostock', scope: 'baostock:daily_kline:sh.600519:2026-10-20:2026-10-22', sleeper },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AdapterPauseError, `应抛 AdapterPauseError，得到 ${String(error)}`);
      const four = error.fourElements();
      assert.equal(four.retries, 3);
      assert.ok(four.lastError.includes('BS_RATE_LIMITED'), '最后错误含具名错误码');
      assert.equal(four.scope, 'baostock:daily_kline:sh.600519:2026-10-20:2026-10-22');
      assert.ok(four.nextAction.length > 0, '唯一下一步动作非空（EK-7.3 四要素齐）');
      return true;
    },
  );
  assert.equal(calls, 3, '同一调用至多 3 次尝试，第 4 次不再发起');
  assert.deepEqual(waits, [BACKOFF_BASE_DELAY_MS, 60_000, 120_000], '等待序列约 30s/60s/120s');
});

test('attempts 可注入收窄（=2 → 等待 30s/60s、2 次尝试后暂停）', async () => {
  const { waits, sleeper } = recordingSleeper();
  let calls = 0;
  await assert.rejects(
    runWithBackoff(
      async () => {
        calls += 1;
        throw new TransientAdapterError('TIMEOUT', '超时');
      },
      { adapter: 'x', scope: 'x:r:o', attempts: 2, sleeper },
    ),
    (error: unknown) => error instanceof AdapterPauseError,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [BACKOFF_BASE_DELAY_MS, 60_000]);
});

test('第 2 次尝试成功：不暂停，瞬态不升级为失败', async () => {
  const { waits, sleeper } = recordingSleeper();
  let calls = 0;
  const out = await runWithBackoff(
    async () => {
      calls += 1;
      if (calls === 1) throw new TransientAdapterError('BS_RATE_LIMITED', '限流');
      return 'recovered';
    },
    { adapter: 'x', scope: 'x:r:o', sleeper },
  );
  assert.equal(out, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [BACKOFF_BASE_DELAY_MS]);
});

test('永久错误不重试、不暂停，立即抛出', async () => {
  const { waits, sleeper } = recordingSleeper();
  let calls = 0;
  await assert.rejects(
    runWithBackoff(
      async () => {
        calls += 1;
        throw new AdapterError('USAGE_ERROR', '参数错');
      },
      { adapter: 'x', scope: 'x:r:o', sleeper },
    ),
    (error: unknown) => error instanceof AdapterError && !(error instanceof AdapterPauseError) && error.code === 'USAGE_ERROR',
  );
  assert.equal(calls, 1, '永久错误只调用一次');
  assert.deepEqual(waits, [], '无退避等待');
});

// ===== 落库面（本地 lyra-pg，隔离 schema）=====

let admin: Pool;
let schema: string;
let pool: Pool;

before(async () => {
  admin = createPool();
  schema = `p1_w4_backoff_${Date.now().toString(36)}`;
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
});

test('暂停上报落库：四要素行 + 同 scope 幂等覆盖 + 恢复标记 RESUMED', async () => {
  const { sleeper } = recordingSleeper();
  const scope = 'baostock:quarter_financial:sh.600519:2026:3';
  await assert.rejects(
    runWithBackoff(
      async () => {
        throw new TransientAdapterError('BAOSTOCK_QUERY_FAILED', '查询失败');
      },
      { adapter: 'baostock', scope, pool, sleeper },
    ),
    (error: unknown) => error instanceof AdapterPauseError,
  );
  let rows = await loadPauseReports(pool, 'baostock');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row, '有暂停行');
  assert.equal(row.scope, scope);
  assert.equal(row.retries, 3, '已重试次数');
  assert.ok(row.last_error.includes('BAOSTOCK_QUERY_FAILED'), '最后错误含具名码');
  assert.equal(row.status, 'PAUSED', '暂停而非 FAILED');

  // 再次暂停同 scope：幂等覆盖，不产生第二行
  await assert.rejects(
    runWithBackoff(
      async () => {
        throw new TransientAdapterError('BAOSTOCK_LOGIN_FAILED', '登录失败');
      },
      { adapter: 'baostock', scope, pool, sleeper },
    ),
    () => true,
  );
  rows = await loadPauseReports(pool, 'baostock');
  assert.equal(rows.length, 1, '同 (adapter, scope) 幂等覆盖');
  assert.ok(rows[0]?.last_error.includes('BAOSTOCK_LOGIN_FAILED'), '覆盖为最新错误');

  // 恢复：从断点续跑成功后置 RESUMED；无既有行则无操作
  assert.equal(await resumePause(pool, 'baostock', scope), true);
  assert.equal(await resumePause(pool, 'baostock', 'baostock:daily_kline:none'), false, '不虚构暂停历史');
  rows = await loadPauseReports(pool);
  assert.equal(rows[0]?.status, 'RESUMED');
});

test('并发闸：在途 ≤ limit，超额 FIFO 排队，全部完成', async () => {
  const gate = new ConcurrencyGate(2);
  let inFlight = 0;
  let peak = 0;
  const task = async (id: number): Promise<number> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return id * 10;
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => gate.run(() => task(i))));
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2, `在途峰值 ${peak} 应 ≤2（DATA-SOURCES §7 主动并发限流）`);
  assert.ok(peak === 2, `应真实到达并发上限（峰值 ${peak}）`);
  assert.throws(() => new ConcurrencyGate(0), (error: unknown) => error instanceof AdapterError && error.code === 'GATE_LIMIT_INVALID');
});
