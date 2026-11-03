/**
 * Lyra · 机构调研记录近 2 年回填 runner（P2 W41b: code-writer，C2/D5-D7）。
 * 合同：docs/specs/DATA-SOURCES.md（回填断点续跑、完成度可从 DB 读出——pool-financials 先例）、
 * R4 修订口径声明随行（BACKFILL_REVISION_NOTICE 经适配器 notices 原样携带）、节流与退避暂停。
 * 派发冻结：26 池股近 2 年；接口按个股过滤形态（每股一次桥调用，内部逐页 pageSize=50，
 * code-only 全历史拉取 + 近 2 年窗界在映射层执行——七轮鉴别实证：该来源 SECURITY_CODE 与
 * 日期过滤项组合必 9201，见 src/adapters/emsurvey.ts 文件头）；节流沿用东财容器面先例 ≥2s。
 *
 * 段计划：段=个股（segKey=emsurvey:survey:<code>，26 段）；近 2 年窗=anchor−2 年（日历口径，
 * Shanghai；事件=接待日 ≥ 窗界入事实，窗外行具名计数、原件全量如实入档）。
 * 源空集（该股无调研记录）如实入档为空原件、计 0 事实、段记 emptySource 完成——
 * 不重试、不造数。
 *
 * 断点续跑：<stateDir>/emsurvey-progress.json（默认 <repo>/.backfill；env EMSURVEY_STATE_DIR
 * 可调；段完成才提交，tmp+rename 原子写）；重跑自动跳过已完成段。节流：相邻真实调用
 * ≥ --throttle（默认 2000ms，下限 2000ms）。暂停（退避 3 次耗尽）：AdapterPauseError →
 * 退出码 2；恢复 = 重跑同一命令（已完成段跳过，从断点续跑）。
 *
 * 全部调用经 SurveyAdapter（原件入 data/artifacts，事实 insertFact public schema；
 * factKind SURVEY_RECORD、subjectType STOCK、subjectId 裸码；时点口径见 src/adapters/emsurvey.ts：
 * availableAt=披露日次日 00:00+08、sourcePublishedAt=披露日 00:00+08、eventAt=接待日 00:00+08）。
 * CLI：node --import tsx src/backfill/emsurvey.ts [--pool <file>] [--throttle 2000]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMSURVEY_ADAPTER_VERSION, SurveyAdapter } from '../adapters/emsurvey.js';
import { PoolBackfillError, parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 段计划（纯函数）=====

/** 节流下限（东财容器面先例 ≥2s）。 */
export const EMSURVEY_THROTTLE_FLOOR_MS = 2_000;
export const EMSURVEY_THROTTLE_DEFAULT_MS = 2_000;

/** 近 2 年 = 日历减 2 年（event=调研日口径）。 */
export const EMSURVEY_WINDOW_YEARS = 2;

/**
 * anchor（Asia/Shanghai 日历口径）前推 years 年的窗界 ISO（YYYY-MM-DD；2 月 29 界回退 2 月 28）。
 * anchor=2026-10-26 → 窗界 2024-10-26。
 */
export function surveyWindowFromIso(anchor: Date, years: number = EMSURVEY_WINDOW_YEARS): string {
  if (!Number.isInteger(years) || years <= 0) {
    throw new PoolBackfillError('EMSURVEY_WINDOW_YEARS_INVALID', String(years));
  }
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  const target = new Date(Date.UTC(y - years, m, 1));
  const lastDay = new Date(Date.UTC(y - years, m + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export interface SurveySegment {
  /** 裸码。 */
  code: string;
  /** 窗界（近 2 年，YYYY-MM-DD；事件=接待日 ≥ 窗界入事实；窗外行映射层具名计数）。 */
  fromIso: string;
  /** 断点键：emsurvey:survey:<code>。 */
  segKey: string;
}

/** 调研记录段计划：池内每股一段，顺序=池文件顺序（确定）；窗界对全部段一致。 */
export function planSurveySegments(codes: string[], anchor: Date, years: number = EMSURVEY_WINDOW_YEARS): SurveySegment[] {
  if (codes.length === 0) throw new PoolBackfillError('EMSURVEY_CODES_EMPTY', '池码表不得为空');
  if (new Set(codes).size !== codes.length) throw new PoolBackfillError('EMSURVEY_CODES_DUPLICATE', codes.join(','));
  const fromIso = surveyWindowFromIso(anchor, years);
  return codes.map((code) => ({ code, fromIso, segKey: `emsurvey:survey:${code}` }));
}

// ===== 断点进度 =====

export interface SurveySegStat {
  code: string;
  /** 桥返回行数（该股近窗调研明细行）。 */
  rowCount: number;
  /** 桥月度块自校验残余缺口行数（如实申报）。 */
  gapRows: number;
  /** 派发窗界（近 2 年）外行数（原件保留、不入事实）。 */
  windowExcluded: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
}

export interface SurveyProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, SurveySegStat>;
}

export function emptySurveyProgress(): SurveyProgress {
  return {
    version: 1,
    adapterVersion: EMSURVEY_ADAPTER_VERSION,
    updatedAt: new Date().toISOString(),
    completed: {},
  };
}

export async function loadSurveyProgress(path: string): Promise<SurveyProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SurveyProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMSURVEY_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptySurveyProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveSurveyProgress(path: string, progress: SurveyProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type SurveyFetchResult = {
  rowCount: number;
  gapRows: number;
  windowExcludedRows: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type SurveyFetchFn = (segment: SurveySegment) => Promise<SurveyFetchResult>;

export interface SurveyRunOptions {
  segments: SurveySegment[];
  progressPath: string;
  fetch: SurveyFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（下限 2000ms）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface SurveyRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  emptySource: number;
  rejectedRowsTotal: number;
  gapRowsTotal: number;
  windowExcludedTotal: number;
  rowTotal: number;
}

export async function runSurveyBackfill(opts: SurveyRunOptions): Promise<SurveyRunResult> {
  const throttleMs = opts.throttleMs ?? EMSURVEY_THROTTLE_DEFAULT_MS;
  if (!Number.isInteger(throttleMs) || throttleMs < EMSURVEY_THROTTLE_FLOOR_MS) {
    throw new PoolBackfillError('EMSURVEY_THROTTLE_INVALID', String(throttleMs));
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadSurveyProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;
  log(`[emsurvey] segments=${String(opts.segments.length)} done=${String(skippedDone)} pending=${String(pending.length)} throttle=${String(throttleMs)}ms`);

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let emptySource = 0;
  let rejectedRowsTotal = 0;
  let gapRowsTotal = 0;
  let windowExcludedTotal = 0;
  let rowTotal = 0;
  for (const segment of pending) {
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) {
      await sleep(throttleMs - sinceLastCall);
    }
    const startedAt = Date.now();
    const r = await opts.fetch(segment);
    realCalls += 1;
    sinceLastCall = Date.now() - startedAt;
    rejectedRowsTotal += r.rejectedRows.length;
    gapRowsTotal += r.gapRows;
    windowExcludedTotal += r.windowExcludedRows;
    rowTotal += r.rowCount;
    const empty = r.rowCount === 0;
    if (empty) emptySource += 1;
    progress.completed[segment.segKey] = {
      code: segment.code,
      rowCount: r.rowCount,
      gapRows: r.gapRows,
      windowExcluded: r.windowExcludedRows,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: empty,
      completedAt: new Date().toISOString(),
    };
    await saveSurveyProgress(opts.progressPath, progress);
    log(`[emsurvey] ${segment.segKey} rows=${String(r.rowCount)} inWindow=${String(r.rowCount - r.windowExcludedRows)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}${empty ? ' (空原件入档)' : ''}`);
  }
  return { completed: pending.length, skippedDone, realCalls, emptySource, rejectedRowsTotal, gapRowsTotal, windowExcludedTotal, rowTotal };
}

// ===== DB 计数（完成度可从 DB 读出）=====

export async function surveyFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [EMSURVEY_ADAPTER_VERSION, ['SURVEY_RECORD'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
}

export async function surveyWindowCount(pool: Pool, subjectIds: string[], fromIso: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `select count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = 'SURVEY_RECORD' and subject_id = any($2::text[])
       and typed_value->>'RECEIVE_START_DATE_ISO' >= $3`,
    [EMSURVEY_ADAPTER_VERSION, subjectIds, fromIso],
  );
  return res.rows[0]?.n ?? 0;
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let throttleMs = EMSURVEY_THROTTLE_DEFAULT_MS;
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
  if (!Number.isInteger(throttleMs) || throttleMs < EMSURVEY_THROTTLE_FLOOR_MS) {
    console.error(`--throttle 不得低于 ${String(EMSURVEY_THROTTLE_FLOOR_MS)}ms：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMSURVEY_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'emsurvey-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const anchor = new Date();
  const segments = planSurveySegments(stockCodes, anchor);
  const fromIso = segments[0]!.fromIso;

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
    const adapter = new SurveyAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await surveyFactCounts(pool, stockCodes);
    const artifactShas = new Set<string>();
    const fetch: SurveyFetchFn = async (segment) => {
      const r = await adapter.fetchSurvey(segment.code, segment.fromIso);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runSurveyBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await surveyFactCounts(pool, stockCodes);
      const progress = await loadSurveyProgress(progressPath);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(JSON.stringify({
        result: 'EMSURVEY BACKFILL OK',
        pool: args.pool,
        stocks: stockCodes.length,
        window: { fromIso, years: EMSURVEY_WINDOW_YEARS, eventBasis: 'RECEIVE_START_DATE（接待日）' },
        segmentsTotal: segments.length,
        ...result,
        artifactsDistinct: artifactShas.size,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        factsInWindow: await surveyWindowCount(pool, stockCodes, fromIso),
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
        formNote: 'code-only 全历史拉取 + 映射层近 2 年窗过滤（来源过滤项组合限制，七轮鉴别实证见 src/adapters/emsurvey.ts 文件头）',
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[emsurvey] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/emsurvey.ts');

if (isMain) {
  await main();
}
