/**
 * Lyra · 研究池行情面全量回填 runner（P1 W8: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 6（回填断点续跑、完成度可从 DB 读出）、
 * docs/REVISION-LOG.md R24（研究池 30 标的冻结；Owner 东财/新浪指令下 BaoStock 行情面
 * 降为双源之一——本 runner 即该面）、docs/specs/DATA-SOURCES.md §2.4/§6/§7
 * （原始价与因子分开存、适配器管线不绕过、节流 ≥1.5s 与退避暂停）。
 *
 * 范围（R24.1 冻结池 data/research-pool.json）：
 * - 26 股全历史日线 + 复权因子（默认 2015-01-01 起，--from 可调）；
 * - 4 宽基 ETF 全历史日线；4 跟踪指数（000016/000300/000905/000852）全历史日线
 *   （ETF/指数起点固定 1999-01-01：早于全部标的基准/上市日，BaoStock 按实际首日返回）。
 * - 指数行情先 1 次真实探测（sh.000300 小窗，段 kind=probe）：空 → IndexProbeEmptyError
 *   （退出码 3）按派发停下回报，不自行改道申万/东财；探测成功才继续其余段。
 *   探测空集不写断点（每次重跑重新探测，直至渠道可用或总控改道）。
 *
 * 断点续跑：<stateDir>/pool-market-progress.json（默认 <repo>/.backfill；段完成才提交，
 * tmp+rename 原子写）；重跑自动跳过已完成段；--to 变化产生新窗口段（重叠行 factId 去重
 * 为 identical，不产生新事实）。节流：相邻真实调用间隔 ≥ --throttle（默认 1600ms，
 * 下限 1500ms 冻结）。暂停（退避 3 次耗尽）：适配器抛 AdapterPauseError → 退出码 2；
 * 恢复 = 重跑同一命令。
 *
 * 全部调用经 BaoStockAdapter（响应原件入 data/artifacts，事实 insertFact public schema），
 * 绝不绕过适配器直写。空原件段（rowCount=0）如实入档并计入 emptyNonProbe 上报。
 * CLI：node --import tsx src/backfill/pool-market.ts
 *   [--pool <file>] [--from 2015-01-01] [--to YYYY-MM-DD] [--throttle 1600]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { BAOSTOCK_ADAPTER_VERSION, BaoStockAdapter } from '../adapters/baostock.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 具名错误 =====

/** 池回填具名错误（清单解析 / 代码转换 / 计划非法）。 */
export class PoolBackfillError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'PoolBackfillError';
  }
}

/** 指数行情探测空集：按派发停下回报（退出码 3），不改道、不落探测断点。 */
export class IndexProbeEmptyError extends Error {
  constructor(
    readonly bsCode: string,
    readonly start: string,
    readonly end: string,
  ) {
    super(`指数行情探测空集：fetchDailyBars(${bsCode}, ${start}, ${end}) 返回 0 行——BaoStock 该面无指数行情，按派发停下回报（改道申万/东财由总控裁定）`);
    this.name = 'IndexProbeEmptyError';
  }
}

// ===== 池清单解析（纯函数）=====

export interface PoolStock {
  code: string;
  name: string;
}

export interface PoolEtf {
  code: string;
  name: string;
  /** 原文如 "上证50(000016)"（R24.1 冻结文件字段）。 */
  tracks: string;
  /** 从 tracks 括号提取的 6 位跟踪指数代码。 */
  indexCode: string;
}

export interface ResearchPool {
  stocks: PoolStock[];
  etfs: PoolEtf[];
  /** 跟踪指数代码（按 etfs 出现序去重）。 */
  indexCodes: string[];
}

function requireStringArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PoolBackfillError('POOL_SHAPE_INVALID', `${field} 须为非空数组`);
  }
  return value;
}

/** research-pool.json 文本 → 结构化池（校验：6 位代码、主板 R17、ETF/指数格式、去重）。 */
export function parseResearchPool(text: string): ResearchPool {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new PoolBackfillError('POOL_JSON_INVALID', 'JSON 解析失败');
  }
  if (typeof root !== 'object' || root === null) {
    throw new PoolBackfillError('POOL_SHAPE_INVALID', '根不是对象');
  }
  const stocksRaw = requireStringArray((root as { stocks?: unknown }).stocks, 'stocks');
  const etfsRaw = requireStringArray((root as { etfs?: unknown }).etfs, 'etfs');

  const stocks: PoolStock[] = [];
  const seenStock = new Set<string>();
  stocksRaw.forEach((s, i) => {
    if (typeof s !== 'object' || s === null) {
      throw new PoolBackfillError('POOL_STOCK_INVALID', `stocks[${String(i)}] 不是对象`);
    }
    const code = (s as { code?: unknown }).code;
    const name = (s as { name?: unknown }).name;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new PoolBackfillError('POOL_CODE_INVALID', `stocks[${String(i)}].code=${String(code)}`);
    }
    toBsCode(code, 'stock'); // 主板校验（R17：60/00 开头），非主板具名拒绝
    if (seenStock.has(code)) {
      throw new PoolBackfillError('POOL_CODE_DUP', code);
    }
    seenStock.add(code);
    stocks.push({ code, name: typeof name === 'string' ? name : '' });
  });

  const etfs: PoolEtf[] = [];
  const indexCodes: string[] = [];
  const seenEtf = new Set<string>();
  etfsRaw.forEach((e, i) => {
    if (typeof e !== 'object' || e === null) {
      throw new PoolBackfillError('POOL_ETF_INVALID', `etfs[${String(i)}] 不是对象`);
    }
    const code = (e as { code?: unknown }).code;
    const name = (e as { name?: unknown }).name;
    const tracks = (e as { tracks?: unknown }).tracks;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new PoolBackfillError('POOL_CODE_INVALID', `etfs[${String(i)}].code=${String(code)}`);
    }
    toBsCode(code, 'etf'); // ETF 前缀校验与交易所归属
    if (typeof tracks !== 'string') {
      throw new PoolBackfillError('POOL_ETF_INVALID', `etfs[${String(i)}].tracks 非 string：${String(tracks)}`);
    }
    const m = /\((\d{6})\)/.exec(tracks);
    if (m === null) {
      throw new PoolBackfillError('POOL_TRACKS_INDEX_MISSING', `etfs[${String(i)}].tracks 缺 6 位指数代码括注：${tracks}`);
    }
    const indexCode = m[1]!;
    toBsCode(indexCode, 'index'); // 指数前缀校验（000xxx→sh / 399xxx→sz）
    if (seenEtf.has(code)) {
      throw new PoolBackfillError('POOL_CODE_DUP', code);
    }
    seenEtf.add(code);
    etfs.push({ code, name: typeof name === 'string' ? name : '', tracks, indexCode });
    if (!indexCodes.includes(indexCode)) indexCodes.push(indexCode);
  });
  return { stocks, etfs, indexCodes };
}

// ===== 代码格式转换（纯函数）=====

/**
 * 裸 6 位代码 → BaoStock 代码。kind 决定规则（不可混用——裸指数代码 000300 走 stock 规则
 * 会得到 sz.000300 并被归类为个股，这是本池的一个真实陷阱，故显式按 kind 分派）：
 * - stock：沪深主板（R17）60/00 开头 → sh./sz.；
 * - etf：51/56/58 → sh.，15/16/18 → sz.（R24 待确认指令含 159901，深市 ETF 格式一并支持）；
 * - index：000 → sh.，399 → sz.（跟踪指数须显式指数规则，见上）。
 */
export function toBsCode(code: string, kind: 'stock' | 'etf' | 'index'): string {
  if (!/^\d{6}$/.test(code)) {
    throw new PoolBackfillError('POOL_CODE_INVALID', `须 6 位数字：${code}`);
  }
  if (kind === 'index') {
    if (code.startsWith('000')) return `sh.${code}`;
    if (code.startsWith('399')) return `sz.${code}`;
    throw new PoolBackfillError('POOL_INDEX_CODE_INVALID', `指数代码须 000xxx/399xxx：${code}`);
  }
  if (kind === 'etf') {
    if (/^5[168]/.test(code)) return `sh.${code}`;
    if (/^1[568]/.test(code)) return `sz.${code}`;
    throw new PoolBackfillError('POOL_ETF_CODE_INVALID', `ETF 代码前缀不在支持集（sh 51/56/58，sz 15/16/18）：${code}`);
  }
  if (!/^(60|00)\d{4}$/.test(code)) {
    throw new PoolBackfillError('POOL_STOCK_NOT_MAINBOARD', `非沪深主板（R17 范围 60/00 开头）：${code}`);
  }
  return code.startsWith('6') ? `sh.${code}` : `sz.${code}`;
}

// ===== 段计划（纯函数）=====

export const STOCK_FROM_DEFAULT = '2015-01-01';
/** ETF/指数全历史起点：早于全部标的基准/上市日（510050 上市 2005-02-23、000852 基日 2004-12-31）。 */
export const FULL_HISTORY_FROM = '1999-01-01';
/** 指数探测窗（天）：覆盖 ≥1 个交易日即可，探测代码固定 sh.000300（派发指定）。 */
export const PROBE_WINDOW_DAYS = 20;
export const PROBE_INDEX = '000300';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date: string, field: string): void {
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new PoolBackfillError('DATE_INVALID', `${field}=${date}（须 YYYY-MM-DD）`);
  }
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type MarketSegKind = 'probe' | 'kline' | 'adjust' | 'etf-kline' | 'index-kline';

export interface MarketSegment {
  kind: MarketSegKind;
  /** 裸 6 位主体代码（stock/etf/index 同形）。 */
  code: string;
  /** BaoStock 代码（sh.600519 / sz.000938 / sh.510050 / sh.000300）。 */
  bsCode: string;
  start: string;
  end: string;
  /** 断点键：kind:code:start:end。 */
  segKey: string;
}

function seg(kind: MarketSegKind, code: string, start: string, end: string): MarketSegment {
  return { kind, code, bsCode: toBsCode(code, kind === 'kline' || kind === 'adjust' ? 'stock' : kind === 'etf-kline' ? 'etf' : 'index'), start, end, segKey: `${kind}:${code}:${start}:${end}` };
}

/**
 * 行情段计划：1 探测（sh.000300 小窗）+ 每股 [kline, adjust]（--from 起）+
 * 每 ETF kline + 每跟踪指数 kline（全历史 1999-01-01 起）。顺序确定（探测最前）。
 */
export function planMarketSegments(
  pool: ResearchPool,
  opts: { from: string; to: string; probeStart?: string },
): MarketSegment[] {
  assertDate(opts.from, 'from');
  assertDate(opts.to, 'to');
  if (opts.from > opts.to) {
    throw new PoolBackfillError('DATE_RANGE_INVALID', `from ${opts.from} > to ${opts.to}`);
  }
  const probeStart = opts.probeStart ?? shiftDays(opts.to, -PROBE_WINDOW_DAYS);
  assertDate(probeStart, 'probeStart');
  if (probeStart > opts.to) {
    throw new PoolBackfillError('DATE_RANGE_INVALID', `probeStart ${probeStart} > to ${opts.to}`);
  }
  const segments: MarketSegment[] = [
    seg('probe', PROBE_INDEX, probeStart, opts.to),
    ...pool.stocks.flatMap((s) => [seg('kline', s.code, opts.from, opts.to), seg('adjust', s.code, opts.from, opts.to)]),
    ...pool.etfs.map((e) => seg('etf-kline', e.code, FULL_HISTORY_FROM, opts.to)),
    ...pool.indexCodes.map((c) => seg('index-kline', c, FULL_HISTORY_FROM, opts.to)),
  ];
  return segments;
}

// ===== 断点进度 =====

export interface MarketSegStat {
  kind: MarketSegKind;
  code: string;
  bsCode: string;
  start: string;
  end: string;
  rowCount: number;
  inserted: number;
  identical: number;
  rejected: number;
  completedAt: string;
}

export interface MarketProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, MarketSegStat>;
}

export function emptyMarketProgress(): MarketProgress {
  return { version: 1, adapterVersion: BAOSTOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadMarketProgress(path: string): Promise<MarketProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<MarketProgress>;
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
    return emptyMarketProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveMarketProgress(path: string, progress: MarketProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

/** fetch 结果取适配器 FetchResult 的结构子集（注入兼容）。 */
export type MarketFetchResult = {
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: unknown[];
};
export type MarketFetchFn = (segment: MarketSegment) => Promise<MarketFetchResult>;

export interface MarketRunOptions {
  segments: MarketSegment[];
  progressPath: string;
  fetch: MarketFetchFn;
  /** 相邻真实调用最小间隔，默认 1600ms（≥ 派发冻结 1.5s）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface MarketRunResult {
  probe: 'PASS' | 'SKIPPED_DONE';
  /** 本次完成的非探测段数。 */
  completed: number;
  /** 断点已命中而跳过的非探测段数。 */
  skippedDone: number;
  /** 本次真实调用数（探测 + 非探测）。 */
  realCalls: number;
  /** 空返回的非探测段 segKey（原件空集如实入档，非失败）。 */
  emptyNonProbe: string[];
  rejectedRowsTotal: number;
}

export async function runMarketBackfill(opts: MarketRunOptions): Promise<MarketRunResult> {
  const throttleMs = opts.throttleMs ?? 1_600;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadMarketProgress(opts.progressPath);
  const probe = opts.segments.find((s) => s.kind === 'probe');
  if (probe === undefined) {
    throw new PoolBackfillError('MARKET_PROBE_MISSING', '段计划必须含探测段（planMarketSegments 保证）');
  }
  const rest = opts.segments.filter((s) => s.kind !== 'probe');
  const pending = rest.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = rest.length - pending.length;

  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  let realCalls = 0;
  let rejectedRowsTotal = 0;
  const doFetch = async (segment: MarketSegment): Promise<MarketFetchResult> => {
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) {
      await sleep(throttleMs - sinceLastCall);
    }
    const startedAt = Date.now();
    const r = await opts.fetch(segment);
    realCalls += 1;
    sinceLastCall = Date.now() - startedAt;
    return r;
  };

  // 探测：断点已过 → 跳过；空集 → 抛 IndexProbeEmptyError（不写断点，重跑重探）。
  let probeState: 'PASS' | 'SKIPPED_DONE';
  if (progress.completed[probe.segKey] !== undefined) {
    probeState = 'SKIPPED_DONE';
    log(`[pool-market] 探测已完成（断点跳过）：${probe.segKey}`);
  } else {
    const r = await doFetch(probe);
    if (r.rowCount === 0) throw new IndexProbeEmptyError(probe.bsCode, probe.start, probe.end);
    rejectedRowsTotal += r.rejectedRows.length;
    progress.completed[probe.segKey] = {
      kind: probe.kind, code: probe.code, bsCode: probe.bsCode, start: probe.start, end: probe.end,
      rowCount: r.rowCount, inserted: r.insertedFactIds.length, identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length, completedAt: new Date().toISOString(),
    };
    await saveMarketProgress(opts.progressPath, progress);
    probeState = 'PASS';
    log(`[pool-market] 探测通过：${probe.bsCode} ${probe.start}~${probe.end} rows=${String(r.rowCount)}`);
  }

  const emptyNonProbe: string[] = [];
  for (const segment of pending) {
    const r = await doFetch(segment);
    rejectedRowsTotal += r.rejectedRows.length;
    if (r.rowCount === 0) emptyNonProbe.push(segment.segKey);
    progress.completed[segment.segKey] = {
      kind: segment.kind, code: segment.code, bsCode: segment.bsCode, start: segment.start, end: segment.end,
      rowCount: r.rowCount, inserted: r.insertedFactIds.length, identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length, completedAt: new Date().toISOString(),
    };
    await saveMarketProgress(opts.progressPath, progress);
    log(`[pool-market] ${segment.segKey} rows=${String(r.rowCount)} new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}`);
  }
  return { probe: probeState, completed: pending.length, skippedDone, realCalls, emptyNonProbe, rejectedRowsTotal };
}

// ===== DB 计数（完成度可从 DB 读出）=====

/** 按 fact_kind:subject_type 计数（限定池主体与行情两 kind；增量 = after − before）。 */
export async function marketFactCounts(pool: Pool, subjectIds: string[]): Promise<Record<string, number>> {
  const res = await pool.query<{ fact_kind: string; subject_type: string; n: number }>(
    `select fact_kind, subject_type, count(*)::int as n from pintime_fact
     where adapter_version = $1 and fact_kind = any($2::text[]) and subject_id = any($3::text[])
     group by 1, 2 order by 1, 2`,
    [BAOSTOCK_ADAPTER_VERSION, ['DAILY_BAR', 'ADJUST_FACTOR'], subjectIds],
  );
  return Object.fromEntries(res.rows.map((r) => [`${r.fact_kind}:${r.subject_type}`, r.n]));
}

// ===== CLI =====

function parseArgs(argv: string[]): { pool: string; from: string; to: string; throttleMs: number } {
  let pool = join(repoRoot, 'data', 'research-pool.json');
  let from = STOCK_FROM_DEFAULT;
  let to = new Date().toISOString().slice(0, 10);
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
    else if (arg === '--from') from = valueOf(i + 1, '--from');
    else if (arg === '--to') to = valueOf(i + 1, '--to');
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
  }
  if (throttleMs < 1_500) {
    console.error(`--throttle 不得低于 1500ms（派发冻结 ≥1.5s）：${String(throttleMs)}`);
    process.exit(1);
  }
  return { pool, from, to, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.POOL_MARKET_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'pool-market-progress.json');
  await mkdir(stateDir, { recursive: true });

  const researchPool = parseResearchPool(await readFile(args.pool, 'utf8'));
  const subjectIds = [
    ...researchPool.stocks.map((s) => s.code),
    ...researchPool.etfs.map((e) => e.code),
    ...researchPool.indexCodes,
  ];
  const segments = planMarketSegments(researchPool, { from: args.from, to: args.to });

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

    const factsBefore = await marketFactCounts(pool, subjectIds);
    const artifactShas = new Set<string>();
    const fetch: MarketFetchFn = async (segment) => {
      const r = segment.kind === 'adjust'
        ? await adapter.fetchAdjustFactor(segment.bsCode, segment.start, segment.end)
        : await adapter.fetchDailyBars(segment.bsCode, segment.start, segment.end);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runMarketBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await marketFactCounts(pool, subjectIds);
      const progress = await loadMarketProgress(progressPath);
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(JSON.stringify({
        result: 'POOL MARKET BACKFILL OK',
        pool: args.pool,
        window: { stocks: `${args.from}~${args.to}`, etfIndex: `${FULL_HISTORY_FROM}~${args.to}` },
        segmentsTotal: segments.length,
        ...result,
        artifactsDistinct: artifactShas.size,
        factsBefore,
        factsAfter,
        factsDelta: delta,
        totalCompletedInFile: Object.keys(progress.completed).length,
        throttleMs: args.throttleMs,
        progressPath,
      }, null, 2));
    } catch (error) {
      if (error instanceof IndexProbeEmptyError) {
        // 按派发停下回报：不改道申万/东财（渠道裁定属总控），其余段未启动。
        console.error(`[pool-market] ${error.message}`);
        console.error('[pool-market] 已按派发停止：未执行任何非探测段；原件（空集）已如实入档。');
        process.exitCode = 3;
      } else if (error instanceof AdapterPauseError) {
        console.error(`[pool-market] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
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
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/pool-market.ts');

if (isMain) {
  await main();
}
