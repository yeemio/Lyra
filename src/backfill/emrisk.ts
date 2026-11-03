/**
 * Lyra · 东财风险面全量回填 runner：股权质押比例 + 股东户数（P1 W29: code-writer）。
 * 合同：docs/specs/P1-DATA.md（回填断点续跑、完成度可从 DB 读出——同 pool-financials 先例）、
 * docs/REVISION-LOG.md R24.1（冻结池 26 股）、docs/specs/DATA-SOURCES.md §5/§6/§7
 * （R4 修订口径声明随行、适配器管线、节流与退避暂停）。派发冻结：节流 ≥2s；26 股全历史
 * （两类指标为个股层面，4 只宽基 ETF 不适用、不在段内；接口每股一次调用拿全历史，量小）。
 *
 * 段计划：26 股 × 2 资源（pledge_ratio / holder_count）= 52 段，确定性顺序（池文件序，
 * 每股先质押后户数）。源空集（来源无记录）如实入档为空原件、计 0 事实、段记 emptySource
 * 完成——不重试、不造数（pool-financials 冻结口径先例）。
 *
 * 断点续跑：<stateDir>/emrisk-progress.json（默认 <repo>/.backfill；env EMRISK_STATE_DIR 可调；
 * 段完成才提交，tmp+rename 原子写）；重跑自动跳过已完成段。节流：相邻真实调用 ≥ --throttle
 * （默认 2000ms，下限 2000ms 派发冻结）。暂停（退避 3 次耗尽）：AdapterPauseError → 退出码 2；
 * 恢复 = 重跑同一命令。
 *
 * 全部调用经 EmriskAdapter（原件入 data/artifacts，事实 insertFact public schema；
 * factKind PLEDGE_RATIO / HOLDER_COUNT，时点口径见 src/adapters/emrisk.ts 文件头）。
 * CLI：node --import tsx src/backfill/emrisk.ts [--pool <file>] [--throttle 2000]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMRISK_ADAPTER_VERSION, EmriskAdapter, isEmriskCompletion, type EmriskCompletion } from '../adapters/emrisk.js';
import { PoolBackfillError, parseResearchPool } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 段计划（纯函数）=====

/** 节流下限（派发冻结 ≥2s）。 */
export const EMRISK_THROTTLE_FLOOR_MS = 2_000;
export const EMRISK_THROTTLE_DEFAULT_MS = 2_000;

export type EmriskSegmentResource = 'pledge_ratio' | 'holder_count';

export interface EmriskSegment {
  code: string;
  resource: EmriskSegmentResource;
  /** 断点键：emrisk:pledge_ratio:<code> / emrisk:holder_count:<code>。 */
  segKey: string;
}

/** 风险面段计划：每股（池文件序）× [质押比例, 股东户数]，顺序确定。 */
export function planEmriskSegments(stocks: string[]): EmriskSegment[] {
  const seen = new Set<string>();
  for (const code of stocks) {
    if (!/^\d{6}$/.test(code)) throw new PoolBackfillError('EMRISK_CODE_INVALID', code);
    if (seen.has(code)) throw new PoolBackfillError('EMRISK_CODE_DUPLICATE', code);
    seen.add(code);
  }
  const segments: EmriskSegment[] = [];
  for (const code of stocks) {
    segments.push({ code, resource: 'pledge_ratio', segKey: `emrisk:pledge_ratio:${code}` });
    segments.push({ code, resource: 'holder_count', segKey: `emrisk:holder_count:${code}` });
  }
  return segments;
}

// ===== 断点进度 =====

export interface EmriskSegStat {
  code: string;
  resource: EmriskSegmentResource;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  /** 源空集（空原件如实入档，正常完成态）。 */
  emptySource: boolean;
  completedAt: string;
  /** 历史账本可无此字段；没有协议完成证明的段不得跳过。 */
  completion?: EmriskCompletion;
}

export interface EmriskProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, EmriskSegStat>;
  failures?: Record<string, { at: string; error: string }>;
}

export function emptyEmriskProgress(): EmriskProgress {
  return {
    version: 1,
    adapterVersion: EMRISK_ADAPTER_VERSION,
    updatedAt: new Date().toISOString(),
    completed: {},
  };
}

export async function loadEmriskProgress(path: string): Promise<EmriskProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<EmriskProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : EMRISK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
      failures: parsed.failures ?? {},
    };
  } catch {
    return emptyEmriskProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveEmriskProgress(path: string, progress: EmriskProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type EmriskFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
  completion: EmriskCompletion;
};
export type EmriskFetchFn = (segment: EmriskSegment) => Promise<EmriskFetchResult>;

export interface EmriskRunOptions {
  segments: EmriskSegment[];
  progressPath: string;
  fetch: EmriskFetchFn;
  /** 相邻真实调用最小间隔，默认 2000ms（派发冻结 ≥2s）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface EmriskRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  emptySource: number;
  rejectedRowsTotal: number;
  /** 空集段键样本（全量入断点文件，此处只带回证据链样本）。 */
  emptySample: string[];
}

export async function runEmriskBackfill(opts: EmriskRunOptions): Promise<EmriskRunResult> {
  const throttleMs = opts.throttleMs ?? EMRISK_THROTTLE_DEFAULT_MS;
  if (!Number.isInteger(throttleMs) || throttleMs < EMRISK_THROTTLE_FLOOR_MS) {
    throw new PoolBackfillError('EMRISK_THROTTLE_INVALID', String(throttleMs));
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadEmriskProgress(opts.progressPath);
  const pending = opts.segments.filter((s) => {
    const stat = progress.completed[s.segKey];
    return stat === undefined || !isEmriskCompletion(stat.completion, s.resource, s.code, stat.rowCount);
  });
  const skippedDone = opts.segments.length - pending.length;
  log(`[emrisk] segments=${String(opts.segments.length)} done=${String(skippedDone)} pending=${String(pending.length)} throttle=${String(throttleMs)}ms`);

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
    realCalls += 1;
    let r: EmriskFetchResult;
    try {
      r = await opts.fetch(segment);
      if (!isEmriskCompletion(r.completion, segment.resource, segment.code, r.rowCount)) {
        throw new PoolBackfillError('EMRISK_COMPLETION_UNVERIFIED', segment.segKey);
      }
    } catch (error) {
      progress.failures ??= {};
      progress.failures[segment.segKey] = { at: new Date().toISOString(), error: String(error) };
      await saveEmriskProgress(opts.progressPath, progress);
      throw error;
    }
    sinceLastCall = Date.now() - startedAt;
    rejectedRowsTotal += r.rejectedRows.length;
    const empty = r.rowCount === 0;
    if (empty) {
      emptySource += 1;
      if (emptySample.length < 50) emptySample.push(segment.segKey);
    }
    progress.completed[segment.segKey] = {
      code: segment.code,
      resource: segment.resource,
      rowCount: r.rowCount,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      emptySource: empty,
      completedAt: new Date().toISOString(),
      completion: r.completion,
    };
    delete progress.failures?.[segment.segKey];
    await saveEmriskProgress(opts.progressPath, progress);
    log(`[emrisk] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}${empty ? ' (空原件入档)' : ''}`);
  }
  return { completed: pending.length, skippedDone, realCalls, emptySource, rejectedRowsTotal, emptySample };
}

// ===== DB 计数（完成度可从 DB 读出）=====

export async function emriskFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; n: number }>(
    `select fact_kind, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1 order by 1`,
    [EMRISK_ADAPTER_VERSION, ['PLEDGE_RATIO', 'HOLDER_COUNT'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [r.fact_kind, r.n]));
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let throttleMs = EMRISK_THROTTLE_DEFAULT_MS;
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
  if (!Number.isInteger(throttleMs) || throttleMs < EMRISK_THROTTLE_FLOOR_MS) {
    console.error(`--throttle 不得低于 ${String(EMRISK_THROTTLE_FLOOR_MS)}ms（派发冻结 ≥2s）：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.EMRISK_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'emrisk-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const stockCodes = researchPool.stocks.map((s) => s.code);
  const segments = planEmriskSegments(stockCodes);

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
    const adapter = new EmriskAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await emriskFactCounts(pool, stockCodes);
    const artifactShas = new Set<string>();
    const fetch: EmriskFetchFn = async (segment) => {
      const r =
        segment.resource === 'pledge_ratio'
          ? await adapter.fetchPledgeRatio(segment.code)
          : await adapter.fetchHolderCount(segment.code);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runEmriskBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await emriskFactCounts(pool, stockCodes);
      const progress = await loadEmriskProgress(progressPath);
      const rejectedByCode: Record<string, number> = {};
      for (const stat of Object.values(progress.completed)) {
        if (stat.rejected > 0) rejectedByCode[`${stat.code}:${stat.resource}`] = stat.rejected;
      }
      const covered = { pledge: 0, holder: 0 };
      for (const stat of Object.values(progress.completed)) {
        if (stat.resource === 'pledge_ratio' && !stat.emptySource) covered.pledge += 1;
        if (stat.resource === 'holder_count' && !stat.emptySource) covered.holder += 1;
      }
      console.log(JSON.stringify({
        result: 'EMRISK BACKFILL OK',
        pool: args.pool,
        stocks: stockCodes.length,
        segmentsTotal: segments.length,
        ...result,
        coveredStocks: covered,
        artifactsDistinct: artifactShas.size,
        rejectedByCode,
        factsBefore,
        factsAfter,
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[emrisk] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/emrisk.ts');

if (isMain) {
  await main();
}
