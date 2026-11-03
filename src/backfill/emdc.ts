/**
 * Lyra · 研究池两融 + 龙虎榜有界回填 runner（P2 W28: code-writer-pro）。
 * 合同：Gate-M 维度5 缺口（融资余额变化未入库 / 龙虎榜数据未入库）；
 * docs/specs/DATA-SOURCES.md §6（全部调用经 EmdcAdapter，绝不绕过适配器直写）、
 * §7（节流 ≥2s 派发冻结、退避暂停）；R24（冻结池 data/research-pool.json，subjectId 裸码）。
 *
 * 范围（派发冻结）：冻结池 26 股 × 近 2 年（--from 默认 = --to − 2 年）。
 * - 两融：每交易日 2 次调用（margin_sse + margin_szse 单日全市场各一次；按池主体过滤事实面，
 *   原件全量入库）——接口形态为按日全市场（W28 探测），比逐股逐日少 26 倍调用；
 * - 龙虎榜：区间按 ~31 天分块调用（东财区间一次返回全市场，事实按池过滤）。
 * 段序：LHB 块（调用少覆盖大）在前，两融按交易日**降序**（近端研究价值优先——部分完成时
 * 覆盖最近窗口）。
 *
 * 断点续跑：<stateDir>/emdc-progress.json（默认 <repo>/.backfill；段完成才提交，tmp+rename
 * 原子写）；重跑自动跳过已完成段；同窗重放事实 factId 去重为 identical。节流：相邻真实调用
 * 间隔 ≥ --throttle（默认 2000ms，下限 2000ms 派发冻结）。预算：--budget-seconds 到点在段边界
 * 干净停止（退出码 0，partial=true；恢复 = 重跑同一命令）。暂停（退避 3 次耗尽）：退出码 2，
 * 恢复 = 重跑同一命令。
 *
 * 交易日底座：public schema 的 TRADE_CALENDAR 事实（P1 已回填 2015-01-05 起）；缺失或窗口
 * 界外 → 具名错误（不猜测）。ETF 两融行存在于同一响应原件中（510050 见探测），但事实面按
 * 派发冻结仅 26 股——ETF 接线属总控后续。
 *
 * CLI：node --import tsx src/backfill/emdc.ts
 *   [--pool <file>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--throttle 2000]
 *   [--budget-seconds N] [--lhb-chunk-days 31]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMDC_ADAPTER_VERSION, EmdcAdapter } from '../adapters/emdc.js';
import { calendarCoverage, loadTradeCalendarTable, tradingDaysBetween, type TradeCalendarTable } from '../adapters/calendar.js';
import { parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 具名错误 =====

export class EmdcBackfillError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'EmdcBackfillError';
  }
}

// ===== 段计划（纯函数，单测直接覆盖）=====

export type EmdcSegKind = 'lhb' | 'margin_sse' | 'margin_szse';

export interface EmdcSegment {
  kind: EmdcSegKind;
  /** LHB：块起/止；margin：交易日（start=end）。YYYY-MM-DD。 */
  start: string;
  end: string;
  /** 断点键：kind:start:end。 */
  segKey: string;
}

/** 交易日序列 → 两融段（每交易日 × 所需交易所；降序——近端优先）。 */
export function planMarginSegments(
  tradingDays: readonly string[],
  exchanges: readonly ('sse' | 'szse')[],
): EmdcSegment[] {
  const segments: EmdcSegment[] = [];
  for (let i = tradingDays.length - 1; i >= 0; i -= 1) {
    const day = tradingDays[i]!;
    for (const ex of exchanges) {
      segments.push({ kind: ('margin_' + ex) as EmdcSegKind, start: day, end: day, segKey: `margin_${ex}:${day}:${day}` });
    }
  }
  return segments;
}

/** 窗口 → ~chunkDays 日历日分块（LHB 区间调用；块间衔接无空洞无重叠）。 */
export function chunkWindow(from: string, to: string, chunkDays: number): { start: string; end: string }[] {
  const DAY_MS = 86_400_000;
  if (!(chunkDays >= 1)) throw new EmdcBackfillError('EMDC_CHUNK_INVALID', `chunkDays=${String(chunkDays)}`);
  const startMs = new Date(`${from}T00:00:00Z`).getTime();
  const endMs = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new EmdcBackfillError('EMDC_DATE_INVALID', `${from}~${to}`);
  }
  if (startMs > endMs) throw new EmdcBackfillError('EMDC_DATE_RANGE_INVALID', `${from} > ${to}`);
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

/** LHB 段（升序块）。 */
export function planLhbSegments(from: string, to: string, chunkDays: number): EmdcSegment[] {
  return chunkWindow(from, to, chunkDays).map((c) => ({
    kind: 'lhb' as const,
    start: c.start,
    end: c.end,
    segKey: `lhb:${c.start}:${c.end}`,
  }));
}

/** 池 → 所需交易所集合（sh 主板 6 开头 → sse；sz 主板 0 开头 → szse；R17 主板外不产生两融面）。 */
export function poolExchanges(stockCodes: readonly string[]): ('sse' | 'szse')[] {
  const ex = new Set<'sse' | 'szse'>();
  for (const code of stockCodes) {
    if (code.startsWith('6')) ex.add('sse');
    else if (code.startsWith('0')) ex.add('szse');
    else throw new EmdcBackfillError('EMDC_POOL_CODE_UNSUPPORTED', `两融面仅主板（R17）：${code}`);
  }
  return [...ex].sort();
}

/** 全段计划：LHB 块在前（调用少覆盖大），两融交易日降序在后。 */
export function planEmdcSegments(
  table: TradeCalendarTable,
  opts: { from: string; to: string; lhbChunkDays: number; exchanges: readonly ('sse' | 'szse')[] },
): EmdcSegment[] {
  const coverage = calendarCoverage(table);
  if (opts.from < coverage.first || opts.to > coverage.last) {
    throw new EmdcBackfillError(
      'EMDC_CALENDAR_WINDOW_OUT_OF_COVERAGE',
      `请求 ${opts.from}~${opts.to} 超出日历覆盖 ${coverage.first}~${coverage.last}（先补 TRADE_CALENDAR）`,
    );
  }
  return [...planLhbSegments(opts.from, opts.to, opts.lhbChunkDays), ...planMarginSegments(tradingDaysBetween(table, opts.from, opts.to), opts.exchanges)];
}

// ===== 断点进度 =====

export interface EmdcSegStat {
  kind: EmdcSegKind;
  start: string;
  end: string;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  filteredOut: number;
  completedAt: string;
}

export interface EmdcProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, EmdcSegStat>;
}

export function emptyEmdcProgress(): EmdcProgress {
  return { version: 1, adapterVersion: EMDC_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadEmdcProgress(path: string): Promise<EmdcProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<EmdcProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMDC_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyEmdcProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveEmdcProgress(path: string, progress: EmdcProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

/** fetch 结果取 EmdcFetchResult 的结构子集（注入兼容）。 */
export type EmdcFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
  filteredOut: number;
};
export type EmdcFetchFn = (segment: EmdcSegment) => Promise<EmdcFetchResult>;

export interface EmdcRunOptions {
  segments: EmdcSegment[];
  progressPath: string;
  fetch: EmdcFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（派发冻结 ≥2s）。 */
  throttleMs?: number;
  /** 墙钟预算（ms）；到点在段边界干净停止（partial，非失败）。 */
  budgetMs?: number | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface EmdcRunResult {
  /** 本次完成的段数。 */
  completed: number;
  /** 断点已命中而跳过的段数。 */
  skippedDone: number;
  /** 本次真实调用数。 */
  realCalls: number;
  /** 空返回段 segKey（原件空集如实入档，非失败——交易所历史边界/数据滞后的诚实呈现）。 */
  emptySegments: string[];
  rejectedRowsTotal: number;
  filteredOutTotal: number;
  /** 预算到点停止（true 时未完成段留待续跑）。 */
  budgetStopped: boolean;
}

export async function runEmdcBackfill(opts: EmdcRunOptions): Promise<EmdcRunResult> {
  const throttleMs = opts.throttleMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const progress = await loadEmdcProgress(opts.progressPath);
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
      log(`[emdc] 预算到点，段边界停止（断点文件累计 ${String(Object.keys(progress.completed).length)} 段）`);
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
    await saveEmdcProgress(opts.progressPath, progress);
    log(`[emdc] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)} filteredOut=${String(r.filteredOut)}`);
  }
  return { completed: completedCount, skippedDone, realCalls, emptySegments, rejectedRowsTotal, filteredOutTotal, budgetStopped };
}

// ===== DB 计数（完成度可从 DB 读出）=====

/** 按池主体计数 MARGIN_BALANCE / DRAGON_TIGER 事实（限定 em@p1）。 */
export async function emdcFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [EMDC_ADAPTER_VERSION, ['MARGIN_BALANCE', 'DRAGON_TIGER'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
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
  lhbChunkDays: number;
} {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let to = new Date().toISOString().slice(0, 10);
  let from: string | undefined;
  let throttleMs = 2_000;
  let budgetSeconds: number | undefined;
  let lhbChunkDays = 31;
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
    else if (arg === '--lhb-chunk-days') lhbChunkDays = Number(valueOf(i + 1, '--lhb-chunk-days'));
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
  if (!(lhbChunkDays >= 1)) {
    console.error(`--lhb-chunk-days 须 ≥1：${String(lhbChunkDays)}`);
    process.exit(1);
  }
  return { pool, from, to, throttleMs, budgetSeconds, lhbChunkDays };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMDC_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'emdc-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const subjectFilter = new Set(stockCodes);
  const exchanges = poolExchanges(stockCodes);

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const table = await loadTradeCalendarTable(pool);
    const coverage = calendarCoverage(table);
    const segments = planEmdcSegments(table, {
      from: args.from,
      to: args.to,
      lhbChunkDays: args.lhbChunkDays,
      exchanges,
    });
    console.log(
      `[emdc] 日历覆盖 ${coverage.first}~${coverage.last}；段计划 ${String(segments.length)}（LHB 块 ${String(segments.filter((s) => s.kind === 'lhb').length)} + 两融 ${String(segments.filter((s) => s.kind !== 'lhb').length)}；池 ${String(stockCodes.length)} 股 × ${exchanges.join('/')}`,
    );

    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new EmdcAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const fetch: EmdcFetchFn = async (segment) => {
      if (segment.kind === 'lhb') return await adapter.fetchLhbDetail(segment.start, segment.end, subjectFilter);
      const ex = segment.kind === 'margin_sse' ? 'sse' : 'szse';
      return await adapter.fetchMarginDetail(ex, segment.start, subjectFilter);
    };

    const factsBefore = await emdcFactCounts(pool, stockCodes);
    try {
      const result = await runEmdcBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        ...(args.budgetSeconds !== undefined ? { budgetMs: args.budgetSeconds * 1_000 } : {}),
        log: (m) => console.log(m),
      });
      const factsAfter = await emdcFactCounts(pool, stockCodes);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      const progress = await loadEmdcProgress(progressPath);
      console.log(JSON.stringify({
        result: 'EMDC BACKFILL OK',
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
        resumeCommand: `node --import tsx src/backfill/emdc.ts --from ${args.from} --to ${args.to}`,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[emdc] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/emdc.ts');

if (isMain) {
  await main();
}
