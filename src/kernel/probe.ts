/**
 * Lyra · 执行器锁探测 CLI（EK-2.1 旅程断言用）。W1: code-writer-pro。
 *
 * 用法：node --import tsx src/kernel/probe.ts
 * 环境：LYRA_PG_* 连接（默认 127.0.0.1:5433/lyra）；LYRA_PG_SCHEMA 指向目标隔离
 * schema（旅程测试 spawn 本文件模拟第二执行器时须设置，与运行中套件同 schema）。
 *
 * 行为：以 probe-<pid>-<uuid> 尝试抢锁；抢到即释放（探测不长期占用，TTL 内他人
 * 可立即取锁）。退出码：抢到=0；EXECUTION_LOCK_HELD=3；其他故障=1。
 */
import { randomUUID } from 'node:crypto';
import { KernelError } from '../contracts.js';
import { createPool } from '../db/pool.js';
import { acquireExecutorLock, releaseExecutorLock } from './lock.js';

async function main(): Promise<number> {
  const holder = `probe-${process.pid}-${randomUUID()}`;
  const schema = process.env.LYRA_PG_SCHEMA;
  const pool = createPool(schema ? { schema } : undefined);
  try {
    const lock = await acquireExecutorLock(pool, holder);
    console.log(`EXECUTOR_LOCK_ACQUIRED holder=${lock.holder} acquiredAt=${lock.acquiredAt}`);
    await releaseExecutorLock(pool, holder);
    return 0;
  } catch (err) {
    if (err instanceof KernelError && err.code === 'EXECUTION_LOCK_HELD') {
      console.error(`EXECUTION_LOCK_HELD probe=${holder}: ${err.message}`);
      return 3;
    }
    console.error(`PROBE_FAILED probe=${holder}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`PROBE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
