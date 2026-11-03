/**
 * Lyra · 数据源层退避器、并发闸与暂停上报（P1 W4: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §7、docs/specs/EXECUTION-KERNEL.md EK-7.2/EK-7.3（数据源层）；
 * 表 adapter_pause_report（src/db/p1-migration.sql，本文件 applyP1Migration 应用）。
 *
 * 退避行为（按 §7 判定条款实现；睡眠可注入，单测秒级加速）：
 * - 同一调用遭遇瞬态错误（限流/超时/临时不可用，TransientAdapterError）时最多发起 3 次：
 *   每次失败后等待 30s/60s/120s（首次 30 秒、逐次加倍），第 3 次失败后的等待结束即
 *   停止重试、按暂停上报（第 4 次不再发起）——与 §7 判定"等待序列约 30s/60s/120s
 *   且第 4 次不再发起"逐字对齐；EK-7.2 的"至少重试 3 次"据此落为同一调用至多 3 次尝试。
 * - 永久错误（非 TransientAdapterError）不重试、不暂停，立即抛出。
 * - 暂停上报四要素（EK-7.3）：retries（已重试次数）、lastError（具名错误码与原文摘要）、
 *   scope（恢复位置/断点）、nextAction（唯一下一步动作）；并落库 adapter_pause_report
 *   （同 scope 幂等覆盖）。瞬态问题不升级为任务失败：抛出 AdapterPauseError 供上层
 *   标记暂停续跑，不是 FAILED。
 * - 恢复：同 scope 后续成功调用由适配器调 resumePause 置 RESUMED（恢复后从断点继续）。
 *
 * 并发闸：单适配器在途请求 ≤ limit（默认 2，DATA-SOURCES §7 主动并发限流；超出排队，
 * 不报错、不降配额——与 EK-7.1 同型）。
 */
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { AdapterError, TransientAdapterError } from './adapter-types.js';

export const BACKOFF_BASE_DELAY_MS = 30_000; // 首次等待约 30 秒
export const BACKOFF_MAX_ATTEMPTS = 3; // 同一调用至多 3 次尝试（§7 判定：第 4 次不再发起）

/** 可注入睡眠：单测记录等待序列并立即放行，实现秒级加速。 */
export interface BackoffSleeper {
  sleep(ms: number): Promise<void>;
}

export const realSleeper: BackoffSleeper = {
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ===== 暂停上报（EK-7.3 四要素 + 落库）=====

/** 暂停上报错误：瞬态问题的停止信号，不是任务 FAILED。 */
export class AdapterPauseError extends AdapterError {
  constructor(
    readonly adapter: string,
    readonly scope: string,
    readonly retries: number,
    readonly lastError: string,
    readonly nextAction: string,
  ) {
    super('ADAPTER_PAUSED', `${adapter} ${scope} 重试 ${retries} 次仍失败：${lastError}`);
    this.name = 'AdapterPauseError';
  }

  /** EK-7.3 四要素（缺任一项即违约）。 */
  fourElements(): { retries: number; lastError: string; scope: string; nextAction: string } {
    return { retries: this.retries, lastError: this.lastError, scope: this.scope, nextAction: this.nextAction };
  }
}

export interface AdapterPauseRow {
  adapter: string;
  scope: string;
  retries: number;
  last_error: string;
  status: string;
  updated_at: Date;
}

/** 暂停上报落库：同 (adapter, scope) 幂等覆盖（p1-migration.sql 主键 + upsert）。 */
export async function recordPause(
  pool: Pool,
  pause: { adapter: string; scope: string; retries: number; lastError: string },
): Promise<void> {
  await pool.query(
    `insert into adapter_pause_report (adapter, scope, retries, last_error, status, updated_at)
     values ($1, $2, $3, $4, 'PAUSED', now())
     on conflict (adapter, scope) do update
       set retries = excluded.retries, last_error = excluded.last_error,
           status = 'PAUSED', updated_at = now()`,
    [pause.adapter, pause.scope, pause.retries, pause.lastError],
  );
}

/** 恢复标记：同 scope 后续成功后置 RESUMED；无既有行则无操作（不虚构暂停历史）。 */
export async function resumePause(pool: Pool, adapter: string, scope: string): Promise<boolean> {
  const res = await pool.query(
    `update adapter_pause_report set status = 'RESUMED', updated_at = now()
     where adapter = $1 and scope = $2`,
    [adapter, scope],
  );
  return res.rowCount === 1;
}

export async function loadPauseReports(pool: Pool, adapter?: string): Promise<AdapterPauseRow[]> {
  const res = await pool.query(
    'select * from adapter_pause_report' + (adapter === undefined ? '' : ' where adapter = $1') + ' order by updated_at desc',
    adapter === undefined ? [] : [adapter],
  );
  return res.rows as AdapterPauseRow[];
}

// ===== 退避执行器 =====

export interface BackoffOptions {
  adapter: string;
  /** 恢复位置（断点）：adapter:resource:对象标识。 */
  scope: string;
  /** 唯一下一步动作（EK-7.3 第 4 要素），默认从断点重试该采集单元。 */
  nextAction?: string | undefined;
  attempts?: number | undefined;
  baseDelayMs?: number | undefined;
  sleeper?: BackoffSleeper | undefined;
  /** 提供时暂停上报落库；缺省不落库（纯函数式用法）。 */
  pool?: Pool | undefined;
}

/**
 * 带退避执行一次调用。fn 抛 TransientAdapterError → 等待（30s/60s/120s 逐次加倍）后重试，
 * 至多 attempts（默认 3）次尝试；耗尽后抛 AdapterPauseError（先落库暂停上报）。
 * fn 抛其他错误 → 立即原样抛出（永久错误不重试、不暂停）。
 */
export async function runWithBackoff<T>(fn: (attempt: number) => Promise<T>, opts: BackoffOptions): Promise<T> {
  const attempts = opts.attempts ?? BACKOFF_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? BACKOFF_BASE_DELAY_MS;
  const sleeper = opts.sleeper ?? realSleeper;
  let attempt = 0;
  let lastError = 'unknown';
  // eslint-disable-next-line no-constant-condition -- 循环出口为 return / throw
  while (true) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof TransientAdapterError)) throw error;
      lastError = `${error.code}: ${error.message}`;
      // 每次失败后都等待（含最后一次：判定条款要求观察到 30s/60s/120s 完整序列），再判停。
      await sleeper.sleep(baseDelayMs * 2 ** (attempt - 1));
      if (attempt >= attempts) break;
    }
  }
  const pause = new AdapterPauseError(
    opts.adapter,
    opts.scope,
    attempt,
    lastError,
    opts.nextAction ?? `从断点重试该采集单元（scope=${opts.scope}）`,
  );
  if (opts.pool !== undefined) {
    try {
      await recordPause(opts.pool, pause);
    } catch (recordError) {
      // 暂停信号优先；落库失败如实附加，不吞暂停也不冒充已落库。
      pause.message += `（暂停记录落库失败：${String(recordError)}）`;
    }
  }
  throw pause;
}

// ===== 并发闸（主动并发限流：单适配器在途 ≤ limit，默认 2）=====

export class ConcurrencyGate {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AdapterError('GATE_LIMIT_INVALID', `limit=${limit}`);
    }
  }

  get current(): number {
    return this.inFlight;
  }

  /** 排队执行：在途已满则 FIFO 等待；任务结束（含抛错）释放一个名额。 */
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      this.waiters.shift()?.();
    }
  }
}

// ===== P1 增量 schema 应用（与 db/exec.ts applySchema 同语义，但不改该冻结文件）=====

const SCHEMA_NAME_RE = /^[a-z0-9_]{1,63}$/;
const p1MigrationUrl = new URL('../db/p1-migration.sql', import.meta.url);

/** 建隔离 schema（可选）并按 search_path 应用 p1-migration.sql（幂等）。 */
export async function applyP1Migration(pool: Pool, schema?: string): Promise<void> {
  const ddl = await readFile(p1MigrationUrl, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (schema !== undefined) {
      if (!SCHEMA_NAME_RE.test(schema)) {
        throw new AdapterError('SCHEMA_NAME_INVALID', schema);
      }
      await client.query(`create schema if not exists "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
    }
    await client.query(ddl);
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时回滚失败可忽略。
    }
    throw error;
  } finally {
    client.release();
  }
}
