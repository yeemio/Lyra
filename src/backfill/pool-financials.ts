/**
 * Lyra · 研究池财务面全量回填 runner（P1 W8: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 6（回填断点续跑、完成度可从 DB 读出）、
 * docs/REVISION-LOG.md R24.1（冻结池 26 股）、docs/specs/DATA-SOURCES.md §2.5/§5/§6/§7
 * （季频财务 pubDate 时点、修订口径声明、适配器管线、节流 ≥1.5s 与退避暂停）。
 *
 * 范围：26 股 × 2015..2026 各季（Q1–Q4）季频财务（profit+growth，经
 * BaoStockAdapter.fetchQuarterFinancials(code, year, quarter)；默认年度区间按当前年收尾，
 * --from-year/--to-year 可调）。源空集（如 2026Q4 未披露）如实入档为空原件、计 0 事实、
 * 段记 emptySource 完成——不重试、不造数（派发冻结口径）。无 pubDate 行由适配器具名拒绝
 * （FINANCIAL_PUBDATE_MISSING），计数如实上报，不视为段失败。
 *
 * 断点续跑：<stateDir>/pool-fin-progress.json（默认 <repo>/.backfill；段完成才提交，
 * tmp+rename 原子写）；重跑自动跳过已完成段。节流：相邻真实调用 ≥ --throttle（默认
 * 1600ms，下限 1500ms 冻结）。暂停（退避 3 次耗尽）：AdapterPauseError → 退出码 2；
 * 恢复 = 重跑同一命令。
 *
 * 全部调用经 BaoStockAdapter（原件入 data/artifacts，事实 insertFact public schema，
 * FINANCIAL 按 statDate+bsQuery 接 supersedes 链——适配器 W4 冻结行为，本 runner 不改）。
 * CLI：node --import tsx src/backfill/pool-financials.ts
 *   [--pool <file>] [--from-year 2015] [--to-year 2026] [--throttle 1600]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { BAOSTOCK_ADAPTER_VERSION, BaoStockAdapter } from '../adapters/baostock.js';
import { PoolBackfillError, parseResearchPool, toBsCode } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 段计划（纯函数）=====

export const FIN_FROM_YEAR_DEFAULT = 2015;

export interface FinSegment {
  code: string;
  bsCode: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** 断点键：fin:code:year:Qn。 */
  segKey: string;
}

/** 财务段计划：每股（池文件序）× fromYear..toYear × Q1..Q4，顺序确定。 */
export function planFinancialSegments(stocks: string[], fromYear: number, toYear: number): FinSegment[] {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 1990 || toYear > 2100 || fromYear > toYear) {
    throw new PoolBackfillError('FIN_YEAR_RANGE_INVALID', `${String(fromYear)}..${String(toYear)}`);
  }
  const segments: FinSegment[] = [];
  for (const code of stocks) {
    for (let year = fromYear; year <= toYear; year++) {
      for (let quarter = 1 as const; quarter <= 4; quarter++) {
        segments.push({
          code,
          bsCode: toBsCode(code, 'stock'),
          year,
          quarter: quarter as 1 | 2 | 3 | 4,
          segKey: `fin:${code}:${String(year)}:Q${String(quarter)}`,
        });
      }
    }
  }
  return segments;
}

// ===== 断点进度 =====

export interface FinSegStat {
  code: string;
  year: number;
  quarter: number;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
}

export interface FinProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, FinSegStat>;
}

export function emptyFinProgress(): FinProgress {
  return { version: 1, adapterVersion: BAOSTOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadFinProgress(path: string): Promise<FinProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<FinProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : BAOSTOCK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyFinProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveFinProgress(path: string, progress: FinProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type FinFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type FinFetchFn = (segment: FinSegment) => Promise<FinFetchResult>;

export interface FinRunOptions {
  segments: FinSegment[];
  progressPath: string;
  fetch: FinFetchFn;
  /** 相邻真实调用最小间隔，默认 1600ms（≥ 派发冻结 1.5s）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface FinRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  emptySource: number;
  rejectedRowsTotal: number;
  /** 空集段键样本（全量入断点文件，此处只带回证据链样本）。 */
  emptySample: string[];
}

export async function runFinancialBackfill(opts: FinRunOptions): Promise<FinRunResult> {
  const throttleMs = opts.throttleMs ?? 1_600;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadFinProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;
  log(`[pool-fin] segments=${String(opts.segments.length)} done=${String(skippedDone)} pending=${String(pending.length)} throttle=${String(throttleMs)}ms`);

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let emptySource = 0;
  let rejectedRowsTotal = 0;
  const emptySample: string[] = [];
  for (const segment of pending) {
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) {
      await sleep(throttleMs - sinceLastCall);
    }
    const startedAt = Date.now();
    const r = await opts.fetch(segment);
    realCalls += 1;
    sinceLastCall = Date.now() - startedAt;
    rejectedRowsTotal += r.rejectedRows.length;
    const empty = r.rowCount === 0;
    if (empty) {
      emptySource += 1;
      if (emptySample.length < 50) emptySample.push(segment.segKey);
    }
    progress.completed[segment.segKey] = {
      code: segment.code,
      year: segment.year,
      quarter: segment.quarter,
      rowCount: r.rowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: empty,
      completedAt: new Date().toISOString(),
    };
    await saveFinProgress(opts.progressPath, progress);
    log(`[pool-fin] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}${empty ? ' (空原件入档)' : ''}`);
  }
  return { completed: pending.length, skippedDone, realCalls, emptySource, rejectedRowsTotal, emptySample };
}

// ===== DB 计数（完成度可从 DB 读出）=====

export async function financialFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [BAOSTOCK_ADAPTER_VERSION, ['FINANCIAL'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; fromYear: number; toYear: number; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let fromYear = FIN_FROM_YEAR_DEFAULT;
  let toYear = new Date().getUTCFullYear();
  let throttleMs = 1_600;
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
    else if (arg === '--from-year') fromYear = Number(valueOf(i + 1, '--from-year'));
    else if (arg === '--to-year') toYear = Number(valueOf(i + 1, '--to-year'));
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
  }
  if (throttleMs < 1_500) {
    console.error(`--throttle 不得低于 1500ms（派发冻结 ≥1.5s）：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, fromYear, toYear, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.POOL_FIN_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'pool-fin-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const subjectIds = researchPool.stocks.map((s) => s.code);
  const segments = planFinancialSegments(subjectIds, args.fromYear, args.toYear);

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new BaoStockAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await financialFactCounts(pool, subjectIds);
    const artifactShas = new Set<string>();
    const fetch: FinFetchFn = async (segment) => {
      const r = await adapter.fetchQuarterFinancials(segment.bsCode, segment.year, segment.quarter);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runFinancialBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await financialFactCounts(pool, subjectIds);
      const progress = await loadFinProgress(progressPath);
      // 空集/具名拒绝按年度汇总（如实上报，区分"源无披露"与"行被拒绝"）
      const emptyByYear: Record<string, number> = {};
      const rejectedByCode: Record<string, number> = {};
      for (const stat of Object.values(progress.completed)) {
        if (stat.emptySource) emptyByYear[String(stat.year)] = (emptyByYear[String(stat.year)] ?? 0) + 1;
        if (stat.rejected > 0) rejectedByCode[stat.code] = (rejectedByCode[stat.code] ?? 0) + stat.rejected;
      }
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(JSON.stringify({
        result: 'POOL FINANCIALS BACKFILL OK',
        pool: args.pool,
        years: `${String(args.fromYear)}..${String(args.toYear)}`,
        segmentsTotal: segments.length,
        ...result,
        artifactsDistinct: artifactShas.size,
        emptyByYear,
        rejectedByCode,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[pool-fin] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/pool-financials.ts');

if (isMain) {
  await main();
}
