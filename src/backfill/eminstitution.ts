/**
 * Lyra · 基金重仓近 2 年回填 runner（P1 W39: code-writer，B2/D5-D7）。
 * 合同：docs/specs/P1-DATA.md（回填断点续跑、完成度可从 DB 读出——pool-financials 先例）、
 * docs/REVISION-LOG.md（B2 实施登记）、docs/specs/DATA-SOURCES.md §5/§6/§7（R4 修订口径声明
 * 随行、节流与退避暂停）。派发冻结：26 池股近 2 年；接口按报告期一次调用（桥内分页拉全市场
 * 快照并按池码过滤，meta.fullRows 申报过滤前行数）；节流沿用东财容器面先例 ≥2s。
 *
 * 段计划：近 2 年 = 最近 8 个报告期季度末（anchor=运行当日，严格 ≤ anchor；2026-10-25 运行
 * 即 2024-12-31..2026-09-30），segKey=eminstitution:fund_hold:<date>。源空集（该报告期池内
 * 无基金持仓记录）如实入档为空原件、计 0 事实、段记 emptySource 完成——不重试、不造数。
 *
 * 断点续跑：<stateDir>/eminstitution-progress.json（默认 <repo>/.backfill；env
 * EMINSTITUTION_STATE_DIR 可调；段完成才提交，tmp+rename 原子写）；重跑自动跳过已完成段。
 * 节流：相邻真实调用 ≥ --throttle（默认 2000ms，下限 2000ms）。暂停（退避 3 次耗尽）：
 * AdapterPauseError → 退出码 2；恢复 = 重跑同一命令。
 *
 * 北向个股面声明（探测实证）：东财个股级北向持股序列止于 2024-08-16（披露机制调整停发），
 * 近 2 年窗口该面不可得——本 runner 只覆盖基金重仓面，见 src/adapters/eminstitution.ts 文件头。
 *
 * 全部调用经 InstitutionAdapter（原件入 data/artifacts，事实 insertFact public schema；
 * factKind FUND_HOLD、subjectType STOCK、subjectId 裸码；时点口径见 src/adapters/eminstitution.ts）。
 * CLI：node --import tsx src/backfill/eminstitution.ts [--pool <file>] [--throttle 2000]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMINSTITUTION_ADAPTER_VERSION, InstitutionAdapter } from '../adapters/eminstitution.js';
import { PoolBackfillError, parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 段计划（纯函数）=====

/** 节流下限（东财容器面先例 ≥2s）。 */
export const EMINSTITUTION_THROTTLE_FLOOR_MS = 2_000;
export const EMINSTITUTION_THROTTLE_DEFAULT_MS = 2_000;

/** 近 2 年 = 最近 8 个报告期（季频）。 */
export const EMINSTITUTION_QUARTERS = 8;

/** 季末（月, 日），新→旧序。 */
const QUARTER_ENDS_DESC: [number, number][] = [[12, 31], [9, 30], [6, 30], [3, 31]];

/**
 * anchor 之前（严格 ≤ anchor，Asia/Shanghai 口径）的最近 count 个报告期季度末，旧→新序。
 * anchor=2026-10-25、count=8 → ['2024-12-31'..'2026-09-30']。
 */
export function fundHoldQuarterEnds(anchor: Date, count: number): string[] {
  const out: string[] = []; // 新→旧
  let year = anchor.getUTCFullYear();
  const floorYear = anchor.getUTCFullYear() - 10;
  while (out.length < count && year >= floorYear) {
    for (const [month, day] of QUARTER_ENDS_DESC) {
      const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (new Date(`${iso}T00:00:00+08:00`).getTime() <= anchor.getTime()) {
        out.push(iso);
        if (out.length === count) break;
      }
    }
    year -= 1;
  }
  return out.reverse();
}

export interface InstitutionSegment {
  /** 报告期季度末（YYYY-MM-DD）。 */
  date: string;
  /** 断点键：eminstitution:fund_hold:<date>。 */
  segKey: string;
}

/** 基金重仓段计划：近 2 年季度末（旧→新），顺序确定；池码只进桥参数不进段键（段=日期）。 */
export function planInstitutionSegments(anchor: Date, quarters: number = EMINSTITUTION_QUARTERS): InstitutionSegment[] {
  if (!Number.isInteger(quarters) || quarters <= 0) {
    throw new PoolBackfillError('EMINSTITUTION_QUARTERS_INVALID', String(quarters));
  }
  return fundHoldQuarterEnds(anchor, quarters).map((date) => ({ date, segKey: `eminstitution:fund_hold:${date}` }));
}

// ===== 断点进度 =====

export interface InstitutionSegStat {
  date: string;
  /** 池命中行数（桥过滤后）。 */
  rowCount: number;
  /** 桥过滤前来源全市场行数（如实申报）。 */
  fullRowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
}

export interface InstitutionProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, InstitutionSegStat>;
}

export function emptyInstitutionProgress(): InstitutionProgress {
  return {
    version: 1,
    adapterVersion: EMINSTITUTION_ADAPTER_VERSION,
    updatedAt: new Date().toISOString(),
    completed: {},
  };
}

export async function loadInstitutionProgress(path: string): Promise<InstitutionProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<InstitutionProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMINSTITUTION_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyInstitutionProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveInstitutionProgress(path: string, progress: InstitutionProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type InstitutionFetchResult = {
  rowCount: number;
  fullRowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type InstitutionFetchFn = (segment: InstitutionSegment) => Promise<InstitutionFetchResult>;

export interface InstitutionRunOptions {
  segments: InstitutionSegment[];
  progressPath: string;
  fetch: InstitutionFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（下限 2000ms）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface InstitutionRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  emptySource: number;
  rejectedRowsTotal: number;
  poolHitsTotal: number;
}

export async function runInstitutionBackfill(opts: InstitutionRunOptions): Promise<InstitutionRunResult> {
  const throttleMs = opts.throttleMs ?? EMINSTITUTION_THROTTLE_DEFAULT_MS;
  if (!Number.isInteger(throttleMs) || throttleMs < EMINSTITUTION_THROTTLE_FLOOR_MS) {
    throw new PoolBackfillError('EMINSTITUTION_THROTTLE_INVALID', String(throttleMs));
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadInstitutionProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;
  log(`[eminstitution] segments=${String(opts.segments.length)} done=${String(skippedDone)} pending=${String(pending.length)} throttle=${String(throttleMs)}ms`);

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let emptySource = 0;
  let rejectedRowsTotal = 0;
  let poolHitsTotal = 0;
  for (const segment of pending) {
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) {
      await sleep(throttleMs - sinceLastCall);
    }
    const startedAt = Date.now();
    const r = await opts.fetch(segment);
    realCalls += 1;
    sinceLastCall = Date.now() - startedAt;
    rejectedRowsTotal += r.rejectedRows.length;
    poolHitsTotal += r.rowCount;
    const empty = r.rowCount === 0;
    if (empty) emptySource += 1;
    progress.completed[segment.segKey] = {
      date: segment.date,
      rowCount: r.rowCount,
      fullRowCount: r.fullRowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: empty,
      completedAt: new Date().toISOString(),
    };
    await saveInstitutionProgress(opts.progressPath, progress);
    log(`[eminstitution] ${segment.segKey} rows=${String(r.rowCount)}/full=${String(r.fullRowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}${empty ? ' (空原件入档)' : ''}`);
  }
  return { completed: pending.length, skippedDone, realCalls, emptySource, rejectedRowsTotal, poolHitsTotal };
}

// ===== DB 计数（完成度可从 DB 读出）=====

export async function institutionFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [EMINSTITUTION_ADAPTER_VERSION, ['FUND_HOLD'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
}

export async function institutionWindowCount(pool: Pool, subjectIds: string[]): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `select count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = 'FUND_HOLD' and subject_id = any($2::text[])
       and left(typed_value->>'REPORT_DATE', 10) >= $3 and left(typed_value->>'REPORT_DATE', 10) <= $4`,
    [EMINSTITUTION_ADAPTER_VERSION, subjectIds, fundHoldQuarterEnds(new Date(), EMINSTITUTION_QUARTERS)[0], fundHoldQuarterEnds(new Date(), EMINSTITUTION_QUARTERS).at(-1)],
  );
  return res.rows[0]?.n ?? 0;
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let throttleMs = EMINSTITUTION_THROTTLE_DEFAULT_MS;
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
  if (!Number.isInteger(throttleMs) || throttleMs < EMINSTITUTION_THROTTLE_FLOOR_MS) {
    console.error(`--throttle 不得低于 ${String(EMINSTITUTION_THROTTLE_FLOOR_MS)}ms：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMINSTITUTION_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'eminstitution-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const segments = planInstitutionSegments(new Date());

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
    const adapter = new InstitutionAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await institutionFactCounts(pool, stockCodes);
    const artifactShas = new Set<string>();
    const fetch: InstitutionFetchFn = async (segment) => {
      const r = await adapter.fetchFundHold(segment.date.replaceAll('-', ''), stockCodes);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runInstitutionBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await institutionFactCounts(pool, stockCodes);
      const progress = await loadInstitutionProgress(progressPath);
      const window = fundHoldQuarterEnds(new Date(), EMINSTITUTION_QUARTERS);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(JSON.stringify({
        result: 'EMINSTITUTION BACKFILL OK',
        pool: args.pool,
        stocks: stockCodes.length,
        quarters: window,
        segmentsTotal: segments.length,
        ...result,
        artifactsDistinct: artifactShas.size,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        factsInWindow: await institutionWindowCount(pool, stockCodes),
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
        northboundNote: '北向个股面不可得（披露机制调整，序列止于 2024-08-16；近 2 年窗口无数据）——探测实证，见 src/adapters/eminstitution.ts 文件头',
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[eminstitution] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/eminstitution.ts');

if (isMain) {
  await main();
}
