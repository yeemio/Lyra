/**
 * Lyra · 研究池限售解禁全历史回填 runner（P2 W42: code-writer，C4）。
 * 合同：docs/specs/DATA-SOURCES.md §6（全部调用经 EmUnlockAdapter，绝不绕过适配器直写）、
 * §7（节流 ≥2s 东财容器面先例、退避暂停）；R24（冻结池 data/research-pool.json，
 * subjectId 裸码）。
 *
 * 范围（派发冻结）：冻结池 **26 股全历史**（ETF 无解禁面，不在范围）。接口形态按个股
 * 全历史（W42 探测实测：queue_em 单请求返回单股全部解禁批次含未来未到期批次；选型依据
 * 见 adapters/emunlock/bridge.py 文件头）——段 = 单股，26 段 = 26 次调用。块序：池内
 * rank 升序（冻结池排序即研究优先序）。
 *
 * 断点续跑：<stateDir>/emunlock-progress.json（默认 <repo>/.backfill；env EMUNLOCK_STATE_DIR
 * 可覆盖）；段完成才提交，tmp+rename 原子写；重跑自动跳过已完成段；同股重放事实 factId
 * 去重为 identical。节流：相邻真实调用间隔 ≥ --throttle（默认 2000ms，下限 2000ms 派发
 * 冻结）。预算：--budget-seconds 到点在段边界干净停止（退出码 0，partial=true；恢复 =
 * 重跑同一命令）。暂停（退避 3 次耗尽）：退出码 2，恢复 = 重跑同一命令。
 * 截断守卫：rows≥500 具名永久错误直接失败（非暂停）。
 *
 * 空源段（东财该报告无此股记录，如 600036 实测 0 行）如实登记 emptySource 完成——
 * 空原件入档、计 0 事实、不重试、不造数（诚实边界）。
 *
 * 接线预留：UNLOCK_DETAIL 事实落 public.pintime_fact（R24 裸码键），research inputs 侧
 * 接线后续任务接入，本 runner 不改 inputs.ts（C4 派发冻结）。
 *
 * CLI：node --import tsx src/backfill/emunlock.ts [--pool <file>] [--throttle 2000]
 *   [--budget-seconds N]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMUNLOCK_ADAPTER_VERSION, EmUnlockAdapter } from '../adapters/emunlock.js';
import { PoolBackfillError, parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 具名错误 =====

export class EmUnlockBackfillError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'EmUnlockBackfillError';
  }
}

// ===== 段计划（纯函数，单测直接覆盖）=====

/** 节流下限（东财容器面先例 ≥2s）。 */
export const EMUNLOCK_THROTTLE_FLOOR_MS = 2_000;
export const EMUNLOCK_THROTTLE_DEFAULT_MS = 2_000;

export type EmUnlockSegKind = 'queue';

export interface EmUnlockSegment {
  kind: EmUnlockSegKind;
  /** 股票 6 位裸码（池 rank 升序）。 */
  code: string;
  /** 断点键：queue:<code>。 */
  segKey: string;
}

/**
 * 池股段计划：rank 升序（冻结池排序即研究优先序），段 = 单股全历史（接口形态决定无日期
 * 分块）。code 形态由 parseResearchPool 已校验（6 位裸码）；此处再守一道。
 */
export function planEmUnlockSegments(codes: readonly string[]): EmUnlockSegment[] {
  if (codes.length === 0) throw new EmUnlockBackfillError('EMUNLOCK_POOL_EMPTY', '池股为空');
  return codes.map((code) => {
    if (!/^\d{6}$/.test(code)) throw new EmUnlockBackfillError('EMUNLOCK_CODE_INVALID', code);
    return { kind: 'queue' as const, code, segKey: `queue:${code}` };
  });
}

// ===== 断点进度 =====

export interface EmUnlockSegStat {
  kind: EmUnlockSegKind;
  code: string;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
}

export interface EmUnlockProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, EmUnlockSegStat>;
}

export function emptyEmUnlockProgress(): EmUnlockProgress {
  return { version: 1, adapterVersion: EMUNLOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadEmUnlockProgress(path: string): Promise<EmUnlockProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<EmUnlockProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMUNLOCK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyEmUnlockProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveEmUnlockProgress(path: string, progress: EmUnlockProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

/** fetch 结果取 EmUnlockFetchResult 的结构子集（注入兼容）。 */
export type EmUnlockFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type EmUnlockFetchFn = (segment: EmUnlockSegment) => Promise<EmUnlockFetchResult>;

export interface EmUnlockRunOptions {
  segments: EmUnlockSegment[];
  progressPath: string;
  fetch: EmUnlockFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（派发冻结 ≥2s）。 */
  throttleMs?: number;
  /** 墙钟预算（ms）；到点在段边界干净停止（partial，非失败）。 */
  budgetMs?: number | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface EmUnlockRunResult {
  /** 本次完成的段数。 */
  completed: number;
  /** 断点已命中而跳过的段数。 */
  skippedDone: number;
  /** 本次真实调用数。 */
  realCalls: number;
  /** 空返回段 segKey（空原件如实入档，非失败——东财无该股解禁记录的诚实呈现）。 */
  emptySegments: string[];
  rejectedRowsTotal: number;
  /** 预算到点停止（true 时未完成段留待续跑）。 */
  budgetStopped: boolean;
}

export async function runEmUnlockBackfill(opts: EmUnlockRunOptions): Promise<EmUnlockRunResult> {
  const throttleMs = opts.throttleMs ?? EMUNLOCK_THROTTLE_DEFAULT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const progress = await loadEmUnlockProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let rejectedRowsTotal = 0;
  let completedCount = 0;
  const emptySegments: string[] = [];
  let budgetStopped = false;

  for (const segment of pending) {
    // 预算判定含下一跳节流等待：剩余墙钟不足以再发一次调用就在段边界停（不半途打断在途调用）。
    if (opts.budgetMs !== undefined && now() - startedAt + throttleMs > opts.budgetMs) {
      budgetStopped = true;
      log(`[emunlock] 预算到点，段边界停止（断点文件累计 ${String(Object.keys(progress.completed).length)} 段）`);
      break;
    }
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) {
      await sleep(throttleMs - sinceLastCall);
    }
    const startedCall = now();
    const r = await opts.fetch(segment);
    realCalls += 1;
    sinceLastCall = now() - startedCall;
    rejectedRowsTotal += r.rejectedRows.length;
    if (r.rowCount === 0) emptySegments.push(segment.segKey);
    progress.completed[segment.segKey] = {
      kind: segment.kind,
      code: segment.code,
      rowCount: r.rowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: r.rowCount === 0,
      completedAt: new Date().toISOString(),
    };
    completedCount += 1;
    await saveEmUnlockProgress(opts.progressPath, progress);
    log(`[emunlock] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}`);
  }
  return { completed: completedCount, skippedDone, realCalls, emptySegments, rejectedRowsTotal, budgetStopped };
}

// ===== DB 计数（完成度可从 DB 读出）=====

/** 按池主体计数 UNLOCK_DETAIL 事实（限定 emunlock@p1）。 */
export async function emUnlockFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ subject_type: string; n: number }>(
    `select subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = 'UNLOCK_DETAIL' and subject_id = any($2::text[])
     group by 1 order by 1`,
    [EMUNLOCK_ADAPTER_VERSION, subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [r.subject_type, r.n]));
}

// ===== CLI =====

function parseArgs(argv: string[]): {
  pool: string;
  throttleMs: number;
  budgetSeconds: number | undefined;
} {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let throttleMs = EMUNLOCK_THROTTLE_DEFAULT_MS;
  let budgetSeconds: number | undefined;
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`缺少 ${flag} 的值`);
      process.exit(1);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pool') pool = valueOf(i + 1, '--pool');
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
    else if (arg === '--budget-seconds') budgetSeconds = Number(valueOf(i + 1, '--budget-seconds'));
  }
  if (throttleMs < EMUNLOCK_THROTTLE_FLOOR_MS) {
    console.error(`--throttle 不得低于 ${String(EMUNLOCK_THROTTLE_FLOOR_MS)}ms（派发冻结 ≥2s）：${String(throttleMs)}`);
    process.exit(1);
  }
  if (budgetSeconds !== undefined && !(budgetSeconds > 0)) {
    console.error(`--budget-seconds 须为正数：${String(budgetSeconds)}`);
    process.exit(1);
  }
  return { pool, throttleMs, budgetSeconds };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMUNLOCK_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'emunlock-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  if (stockCodes.length === 0) {
    throw new PoolBackfillError('POOL_STOCKS_EMPTY', '冻结池无股票（解禁面仅个股）');
  }

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const segments = planEmUnlockSegments(stockCodes);
    console.log(
      `[emunlock] 段计划 ${String(segments.length)} 股（单股全历史，rank 升序）；ETF 无解禁面不在范围`,
    );

    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new EmUnlockAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await emUnlockFactCounts(pool, stockCodes);
    try {
      const result = await runEmUnlockBackfill({
        segments,
        progressPath,
        fetch: (segment) => adapter.fetchUnlockQueue(segment.code),
        throttleMs: args.throttleMs,
        ...(args.budgetSeconds !== undefined ? { budgetMs: args.budgetSeconds * 1_000 } : {}),
        log: (m) => console.log(m),
      });
      const factsAfter = await emUnlockFactCounts(pool, stockCodes);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      const progress = await loadEmUnlockProgress(progressPath);
      console.log(JSON.stringify({
        result: 'EMUNLOCK BACKFILL OK',
        pool: args.pool,
        scope: '26 股全历史（含未来未到期批次）',
        segmentsTotal: segments.length,
        ...result,
        partial: result.budgetStopped,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
        resumeCommand: 'node --import tsx src/backfill/emunlock.ts',
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[emunlock] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
        process.exitCode = 2;
      } else {
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不执行——单测导入纯函数）
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/emunlock.ts');

if (isMain) {
  await main();
}
