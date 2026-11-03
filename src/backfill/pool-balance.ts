/**
 * Lyra · 研究池资产负债表（商誉面）全量回填 runner（P1 W30: code-writer）。
 * 合同：docs/specs/P1-DATA.md（回填断点续跑、完成度可从 DB 读出——pool-financials 先例）、
 * docs/REVISION-LOG.md R24.1（冻结池 26 股）、RESEARCH-METHOD §4 维度 7 风险项（商誉占净资产
 * 比例）、docs/specs/DATA-SOURCES.md §5/§6/§7（R4 修订口径声明随行、适配器管线、节流与退避
 * 暂停）。渠道（选型变更，总控回传说明）：派发预设 BaoStock query_balance_data 实测不含商誉
 * （0.9.40 仅 9 列偿债比率），按 Owner"东财优先"指令改走东财资产负债表——每股**一次调用**
 * 拿全历史报告期（26 次真实调用），节流沿用东财容器面先例 ≥2s。
 *
 * 段计划：26 股（池文件序），segKey=embalance:balance_sheet:<code>。源空集（来源无记录）如实
 * 入档为空原件、计 0 事实、段记 emptySource 完成——不重试、不造数。无 NOTICE_DATE 行由适配器
 * 具名拒绝（EMBALANCE_NOTICE_DATE_MISSING），计数如实上报，不视为段失败。
 *
 * 断点续跑：<stateDir>/pool-balance-progress.json（默认 <repo>/.backfill；env
 * POOL_BALANCE_STATE_DIR 可调；段完成才提交，tmp+rename 原子写）；重跑自动跳过已完成段。
 * 节流：相邻真实调用 ≥ --throttle（默认 2000ms，下限 2000ms）。暂停（退避 3 次耗尽）：
 * AdapterPauseError → 退出码 2；恢复 = 重跑同一命令。
 *
 * 全部调用经 EmbalanceAdapter（原件入 data/artifacts，事实 insertFact public schema；
 * factKind BALANCE，时点口径=公告披露日 D+1，与 FINANCIAL pubDate 同法，见
 * src/adapters/embalance.ts 文件头）。回填窗口：一次调用返回全历史（含 2015 前），研究窗
 * 2015..2026 子集单列上报；BUSINESS 语义（商誉占净资产比例、分母口径）由消费侧计算，本
 * runner 只入库构成字段。
 * CLI：node --import tsx src/backfill/pool-balance.ts [--pool <file>] [--throttle 2000]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMBALANCE_ADAPTER_VERSION, EmbalanceAdapter } from '../adapters/embalance.js';
import { PoolBackfillError, parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 段计划（纯函数）=====

/** 节流下限（东财容器面先例 ≥2s）。 */
export const BALANCE_THROTTLE_FLOOR_MS = 2_000;
export const BALANCE_THROTTLE_DEFAULT_MS = 2_000;

export interface BalanceSegment {
  code: string;
  /** 断点键：embalance:balance_sheet:<code>。 */
  segKey: string;
}

/** 资产负债表段计划：池个股（文件序），顺序确定。 */
export function planBalanceSegments(stocks: string[]): BalanceSegment[] {
  const seen = new Set<string>();
  for (const code of stocks) {
    if (!/^\d{6}$/.test(code)) throw new PoolBackfillError('BALANCE_CODE_INVALID', code);
    if (seen.has(code)) throw new PoolBackfillError('BALANCE_CODE_DUPLICATE', code);
    seen.add(code);
  }
  return stocks.map((code) => ({ code, segKey: `embalance:balance_sheet:${code}` }));
}

// ===== 断点进度 =====

export interface BalanceSegStat {
  code: string;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
}

export interface BalanceProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, BalanceSegStat>;
}

export function emptyBalanceProgress(): BalanceProgress {
  return {
    version: 1,
    adapterVersion: EMBALANCE_ADAPTER_VERSION,
    updatedAt: new Date().toISOString(),
    completed: {},
  };
}

export async function loadBalanceProgress(path: string): Promise<BalanceProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<BalanceProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMBALANCE_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyBalanceProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveBalanceProgress(path: string, progress: BalanceProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type BalanceFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type BalanceFetchFn = (segment: BalanceSegment) => Promise<BalanceFetchResult>;

export interface BalanceRunOptions {
  segments: BalanceSegment[];
  progressPath: string;
  fetch: BalanceFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（下限 2000ms）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface BalanceRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  emptySource: number;
  rejectedRowsTotal: number;
}

export async function runBalanceBackfill(opts: BalanceRunOptions): Promise<BalanceRunResult> {
  const throttleMs = opts.throttleMs ?? BALANCE_THROTTLE_DEFAULT_MS;
  if (!Number.isInteger(throttleMs) || throttleMs < BALANCE_THROTTLE_FLOOR_MS) {
    throw new PoolBackfillError('BALANCE_THROTTLE_INVALID', String(throttleMs));
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadBalanceProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;
  log(`[pool-bal] segments=${String(opts.segments.length)} done=${String(skippedDone)} pending=${String(pending.length)} throttle=${String(throttleMs)}ms`);

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let emptySource = 0;
  let rejectedRowsTotal = 0;
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
    if (empty) emptySource += 1;
    progress.completed[segment.segKey] = {
      code: segment.code,
      rowCount: r.rowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: empty,
      completedAt: new Date().toISOString(),
    };
    await saveBalanceProgress(opts.progressPath, progress);
    log(`[pool-bal] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}${empty ? ' (空原件入档)' : ''}`);
  }
  return { completed: pending.length, skippedDone, realCalls, emptySource, rejectedRowsTotal };
}

// ===== DB 计数（完成度可从 DB 读出；2015..2026 研究窗与商誉非空子集单列）=====

const WINDOW_FROM = '2015-01-01';
const WINDOW_TO = '2026-12-31';

export async function balanceFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [EMBALANCE_ADAPTER_VERSION, ['BALANCE'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
}

export async function balanceWindowCounts(
  pool: Pool,
  subjectIds: string[],
): Promise<{ window: number; windowWithGoodwill: number }> {
  const res = await pool.query<{ n: number; g: number }>(
    `select count(*)::int as n,
            count(*) filter (where typed_value->>'GOODWILL' is not null)::int as g
     from pintime_fact
     where adapter_version = $1 and fact_kind = 'BALANCE' and subject_id = any($2::text[])
       and typed_value->>'REPORT_DATE_ISO' >= $3 and typed_value->>'REPORT_DATE_ISO' <= $4`,
    [EMBALANCE_ADAPTER_VERSION, subjectIds, WINDOW_FROM, WINDOW_TO],
  );
  return { window: res.rows[0]?.n ?? 0, windowWithGoodwill: res.rows[0]?.g ?? 0 };
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let throttleMs = BALANCE_THROTTLE_DEFAULT_MS;
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
  }
  if (!Number.isInteger(throttleMs) || throttleMs < BALANCE_THROTTLE_FLOOR_MS) {
    console.error(`--throttle 不得低于 ${String(BALANCE_THROTTLE_FLOOR_MS)}ms：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.POOL_BALANCE_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'pool-balance-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const segments = planBalanceSegments(stockCodes);

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
    const adapter = new EmbalanceAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await balanceFactCounts(pool, stockCodes);
    const artifactShas = new Set<string>();
    const fetch: BalanceFetchFn = async (segment) => {
      const r = await adapter.fetchBalanceSheet(segment.code);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runBalanceBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await balanceFactCounts(pool, stockCodes);
      const progress = await loadBalanceProgress(progressPath);
      const rejectedByCode: Record<string, number> = {};
      for (const stat of Object.values(progress.completed)) {
        if (stat.rejected > 0) rejectedByCode[stat.code] = stat.rejected;
      }
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(JSON.stringify({
        result: 'POOL BALANCE BACKFILL OK',
        pool: args.pool,
        stocks: stockCodes.length,
        segmentsTotal: segments.length,
        ...result,
        artifactsDistinct: artifactShas.size,
        rejectedByCode,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        window2015_2026: await balanceWindowCounts(pool, stockCodes),
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[pool-bal] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/pool-balance.ts');

if (isMain) {
  await main();
}
