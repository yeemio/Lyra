/**
 * Lyra · 研究池大宗交易有界回填 runner（P2 W37: code-writer，B1）。
 * 合同：docs/specs/DATA-SOURCES.md §6（全部调用经 EmblockAdapter，绝不绕过适配器直写）、
 * §7（节流 ≥2s 派发冻结、退避暂停）；R24（冻结池 data/research-pool.json，subjectId 裸码）。
 *
 * 范围（派发冻结）：冻结池 26 股 × 近 2 年（--from 默认 = --to − 2 年）。
 * 大宗交易 mrmx：区间按 ~31 天历日分块调用（东财 datacenter 一次调用返回全市场区间明细，
 * 事实按池过滤、原件全量入库）——接口形态按区间全市场（W37 探测：31 天窗实测 1,720 行
 * << 单页 5,000 上限），2 年 ≈ 24 次调用，比逐股逐日少两个数量级。块序：**降序**
 * （近端研究价值优先——部分完成时覆盖最近窗口）。
 *
 * 断点续跑：<stateDir>/emblock-progress.json（默认 <repo>/.backfill；env EMBLOCK_STATE_DIR
 * 可覆盖）；段完成才提交，tmp+rename 原子写；重跑自动跳过已完成段；同窗重放事实 factId
 * 去重为 identical。节流：相邻真实调用间隔 ≥ --throttle（默认 2000ms，下限 2000ms 派发
 * 冻结）。预算：--budget-seconds 到点在段边界干净停止（退出码 0，partial=true；恢复 =
 * 重跑同一命令）。暂停（退避 3 次耗尽）：退出码 2，恢复 = 重跑同一命令。
 * 截断守卫：rows≥5000 具名永久错误直接失败（非暂停）——缩小 --chunk-days 重排。
 *
 * 无交易日历依赖：mrmx 分块为纯历日数学（窗口内非交易日源端无行，空窗如实登记）；
 * 源端历史覆盖：2024-09 已实测有数（W37 探测）。
 *
 * CLI：node --import tsx src/backfill/emblock.ts
 *   [--pool <file>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--throttle 2000]
 *   [--budget-seconds N] [--chunk-days 31]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMBLOCK_ADAPTER_VERSION, EmblockAdapter } from '../adapters/emblock.js';
import { parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 具名错误 =====

export class EmblockBackfillError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'EmblockBackfillError';
  }
}

// ===== 段计划（纯函数，单测直接覆盖）=====

export type EmblockSegKind = 'mrmx';

export interface EmblockSegment {
  kind: EmblockSegKind;
  /** 块起/止（YYYY-MM-DD，历日含端点）。 */
  start: string;
  end: string;
  /** 断点键：kind:start:end。 */
  segKey: string;
}

/** 窗口 → ~chunkDays 历日分块（升序）。块间衔接无空洞无重叠。 */
export function chunkWindowAsc(from: string, to: string, chunkDays: number): { start: string; end: string }[] {
  const DAY_MS = 86_400_000;
  if (!(chunkDays >= 1)) throw new EmblockBackfillError('EMBLOCK_CHUNK_INVALID', `chunkDays=${String(chunkDays)}`);
  const startMs = new Date(`${from}T00:00:00Z`).getTime();
  const endMs = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new EmblockBackfillError('EMBLOCK_DATE_INVALID', `${from}~${to}`);
  }
  if (startMs > endMs) throw new EmblockBackfillError('EMBLOCK_DATE_RANGE_INVALID', `${from} > ${to}`);
  const chunks: { start: string; end: string }[] = [];
  let cur = startMs;
  while (cur <= endMs) {
    const next = Math.min(cur + (chunkDays - 1) * DAY_MS, endMs);
    chunks.push({
      start: new Date(cur).toISOString().slice(0, 10),
      end: new Date(next).toISOString().slice(0, 10),
    });
    cur = next + DAY_MS;
  }
  return chunks;
}

/** 全段计划：mrmx 块降序（近端优先——部分完成时覆盖最近窗口）。 */
export function planEmblockSegments(from: string, to: string, chunkDays: number): EmblockSegment[] {
  return chunkWindowAsc(from, to, chunkDays)
    .map((c) => ({ kind: 'mrmx' as const, start: c.start, end: c.end, segKey: `mrmx:${c.start}:${c.end}` }))
    .reverse();
}

// ===== 断点进度 =====

export interface EmblockSegStat {
  kind: EmblockSegKind;
  start: string;
  end: string;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  filteredOut: number;
  completedAt: string;
}

export interface EmblockProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, EmblockSegStat>;
}

export function emptyEmblockProgress(): EmblockProgress {
  return { version: 1, adapterVersion: EMBLOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadEmblockProgress(path: string): Promise<EmblockProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<EmblockProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMBLOCK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyEmblockProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveEmblockProgress(path: string, progress: EmblockProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

/** fetch 结果取 EmblockFetchResult 的结构子集（注入兼容）。 */
export type EmblockFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
  filteredOut: number;
};
export type EmblockFetchFn = (segment: EmblockSegment) => Promise<EmblockFetchResult>;

export interface EmblockRunOptions {
  segments: EmblockSegment[];
  progressPath: string;
  fetch: EmblockFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（派发冻结 ≥2s）。 */
  throttleMs?: number;
  /** 墙钟预算（ms）；到点在段边界干净停止（partial，非失败）。 */
  budgetMs?: number | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface EmblockRunResult {
  /** 本次完成的段数。 */
  completed: number;
  /** 断点已命中而跳过的段数。 */
  skippedDone: number;
  /** 本次真实调用数。 */
  realCalls: number;
  /** 空返回段 segKey（原件空集如实入档，非失败——窗口内无大宗成交日的诚实呈现）。 */
  emptySegments: string[];
  rejectedRowsTotal: number;
  filteredOutTotal: number;
  /** 预算到点停止（true 时未完成段留待续跑）。 */
  budgetStopped: boolean;
}

export async function runEmblockBackfill(opts: EmblockRunOptions): Promise<EmblockRunResult> {
  const throttleMs = opts.throttleMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const progress = await loadEmblockProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let rejectedRowsTotal = 0;
  let filteredOutTotal = 0;
  let completedCount = 0;
  const emptySegments: string[] = [];
  let budgetStopped = false;

  for (const segment of pending) {
    // 预算判定含下一跳节流等待：剩余墙钟不足以再发一次调用就在段边界停（不半途打断在途调用）。
    if (opts.budgetMs !== undefined && now() - startedAt + throttleMs > opts.budgetMs) {
      budgetStopped = true;
      log(`[emblock] 预算到点，段边界停止（断点文件累计 ${String(Object.keys(progress.completed).length)} 段）`);
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
    filteredOutTotal += r.filteredOut;
    if (r.rowCount === 0) emptySegments.push(segment.segKey);
    progress.completed[segment.segKey] = {
      kind: segment.kind,
      start: segment.start,
      end: segment.end,
      rowCount: r.rowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      filteredOut: r.filteredOut,
      completedAt: new Date().toISOString(),
    };
    completedCount += 1;
    await saveEmblockProgress(opts.progressPath, progress);
    log(`[emblock] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)} filteredOut=${String(r.filteredOut)}`);
  }
  return { completed: completedCount, skippedDone, realCalls, emptySegments, rejectedRowsTotal, filteredOutTotal, budgetStopped };
}

// ===== DB 计数（完成度可从 DB 读出）=====

/** 按池主体计数 BLOCK_TRADE 事实（限定 emblock@p1）。 */
export async function emblockFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ subject_type: string; n: number }>(
    `select subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = 'BLOCK_TRADE' and subject_id = any($2::text[])
     group by 1 order by 1`,
    [EMBLOCK_ADAPTER_VERSION, subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [r.subject_type, r.n]));
}

// ===== CLI =====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateArg(date: string, flag: string): void {
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    console.error(`${flag} 须 YYYY-MM-DD：${date}`);
    process.exit(1);
  }
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): {
  pool: string;
  from: string;
  to: string;
  throttleMs: number;
  budgetSeconds: number | undefined;
  chunkDays: number;
} {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let to = new Date().toISOString().slice(0, 10);
  let from: string | undefined;
  let throttleMs = 2_000;
  let budgetSeconds: number | undefined;
  let chunkDays = 31;
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
    else if (arg === '--from') from = valueOf(i + 1, '--from');
    else if (arg === '--to') to = valueOf(i + 1, '--to');
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
    else if (arg === '--budget-seconds') budgetSeconds = Number(valueOf(i + 1, '--budget-seconds'));
    else if (arg === '--chunk-days') chunkDays = Number(valueOf(i + 1, '--chunk-days'));
  }
  assertDateArg(to, '--to');
  if (from === undefined) from = shiftYears(to, 2); // 派发默认：近 2 年
  assertDateArg(from, '--from');
  if (from > to) {
    console.error(`--from > --to：${from} > ${to}`);
    process.exit(1);
  }
  if (throttleMs < 2_000) {
    console.error(`--throttle 不得低于 2000ms（派发冻结 ≥2s）：${String(throttleMs)}`);
    process.exit(1);
  }
  if (budgetSeconds !== undefined && !(budgetSeconds > 0)) {
    console.error(`--budget-seconds 须为正数：${String(budgetSeconds)}`);
    process.exit(1);
  }
  if (!(chunkDays >= 1)) {
    console.error(`--chunk-days 须 ≥1：${String(chunkDays)}`);
    process.exit(1);
  }
  return { pool, from, to, throttleMs, budgetSeconds, chunkDays };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMBLOCK_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'emblock-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const subjectFilter = new Set(stockCodes);

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const segments = planEmblockSegments(args.from, args.to, args.chunkDays);
    console.log(
      `[emblock] 段计划 ${String(segments.length)}（--chunk-days ${String(args.chunkDays)}，降序近端优先）；池 ${String(stockCodes.length)} 股（事实面过滤，原件全市场）`,
    );

    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new EmblockAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await emblockFactCounts(pool, stockCodes);
    try {
      const result = await runEmblockBackfill({
        segments,
        progressPath,
        fetch: (segment) => adapter.fetchBlockTradeDetail(segment.start, segment.end, subjectFilter),
        throttleMs: args.throttleMs,
        ...(args.budgetSeconds !== undefined ? { budgetMs: args.budgetSeconds * 1_000 } : {}),
        log: (m) => console.log(m),
      });
      const factsAfter = await emblockFactCounts(pool, stockCodes);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      const progress = await loadEmblockProgress(progressPath);
      console.log(JSON.stringify({
        result: 'EMBLOCK BACKFILL OK',
        pool: args.pool,
        window: `${args.from}~${args.to}`,
        segmentsTotal: segments.length,
        ...result,
        partial: result.budgetStopped,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
        resumeCommand: `node --import tsx src/backfill/emblock.ts --from ${args.from} --to ${args.to}`,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[emblock] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/emblock.ts');

if (isMain) {
  await main();
}
