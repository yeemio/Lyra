/**
 * Lyra · 指数估值适配器（P2 W31: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §5/§6/§7（修订口径、适配器、限流退避）、
 * docs/specs/POINT-IN-TIME.md §2/§3.4（五时间字段、availableAt 近似声明）；
 * 桥 adapters/valuation/bridge.py（容器 python:3.11-slim + 命名卷 lyra-akshare-py311，
 * akshare 1.19.3）；退避/并发闸复用 ./backoff.ts（只读依赖）。
 *
 * 来源（W31 探测 2026-10-25，证据 var/w31-probe-result.json，8/8 调用成功）：
 * - csindex（中证指数公司官网 OSS autofile indicator/{code}indicator.xls）：官方日频
 *   市盈率1（总股本）/市盈率2（计算用股本）/股息率两种口径；实测近 20 个交易日滚动窗口
 *   （非全史）；000300/000016 探测通过（上交所指数亦由中证发布）。
 * - legulegu（经 AKShare）：stock_index_pe_lg / stock_index_pb_lg，覆盖 上证50/沪深300/
 *   中证500/中证1000 等 12 指数；**月末频率全史 + 最新一日**（上证50 2005-01 起 262 行，
 *   中证1000 2014-10 起 145 行）——非日频；PE 六口径 / PB 三口径。
 * - legulegu 全A：stock_a_ttm_lyr（全A PE TTM/LYR 中位/平均）、stock_a_all_pb（全A PB
 *   中位/等权），月末全史 2005-01 起。
 * - 申万一级行业指数 PE/PB：akshare 1.19.3 无可用外部来源（index_value_hist_funddb 不在
 *   本版本；legulegu index-basic API 仅 12 宽基；cninfo 行业市盈率为按日查询无 PB）——
 *   本适配器不覆盖，行业指数估值留待自算（B 类，依赖 W30 balance 净资产入库）。
 *
 * 时点语义（外部估值快照，R4 声明随行）：
 * - INDEX_VALUATION 事实 = 来源方按其口径计算的整指数估值快照；同日多来源事实并存
 *   （POINT-IN-TIME §4 分叉并存暴露，不自动合并），typedValue.来源 区分（csindex/legulegu）。
 * - availableAt = 数据日次日 00:00 Asia/Shanghai（派发冻结的保守口径；乐咕月末行的
 *   月末值在数据日次日零点即视为可得，属声明过的近似）；
 * - eventAt/validFrom = 数据日 15:00 Asia/Shanghai（收盘估值时点）；
 * - sourcePublishedAt = null（来源无逐行发布时刻；修订语义由 R4 声明覆盖）。
 * - typedValue 原样保留来源字段（csindex 原生中英混排表头、lg/all_a 原生列名），
 *   附派生元数据：来源 / 频率（日频|月末）/ 指数代码（csindex 原生 int 丢前导零，此处补 6 位）。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { insertFact, loadFact } from '../pintime/facts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import type { BridgeExecutor } from './baostock.js'; // 桥执行器类型（W4 冻结形态，只读引用）
import { ConcurrencyGate, resumePause, runWithBackoff, type BackoffSleeper } from './backoff.js';

const execFileAsync = promisify(execFile);

export const VALUATION_ADAPTER_VERSION = 'valuation@p1';

/** R4 估值快照口径声明（原文随行，与 BACKFILL_REVISION_NOTICE 并列）。 */
export const VALUATION_SNAPSHOT_NOTICE =
  '估值快照口径声明：本事实为来源方（中证指数公司官网 autofile / 乐咕乐股，经 AKShare）按其口径计算的整指数估值快照——' +
  '成分范围、股本口径（总股本/计算用股本/等权）、亏损股处理与再计算规则由来源方决定，非逐日官方发布原文；' +
  '乐咕序列为月末频率（含最新一日），中证官网 autofile 为近约 20 个交易日滚动窗口；' +
  '历史行值属抓取时点的最新修订口径，与当时实际可得值可能不同（来源自带分位列同此口径）。' +
  '消费方计算分位时须按来源与频率分别成列，不得混频。';

// ===== 目标指数清单（R17/R18：4 只宽基 ETF 跟踪指数；lgKey = 桥内中文 symbol 键）=====

export interface ValuationTarget {
  /** 6 位指数代码（subjectId）。 */
  code: string;
  name: string;
  lgKey: string;
}

export const VALUATION_TARGETS: readonly ValuationTarget[] = [
  { code: '000016', name: '上证50', lgKey: 'sz50' },
  { code: '000300', name: '沪深300', lgKey: 'hs300' },
  { code: '000905', name: '中证500', lgKey: 'zz500' },
  { code: '000852', name: '中证1000', lgKey: 'zz1000' },
];

/** 全A 虚拟指数主体（市场级背景口径，subjectType 仍为 INDEX）。 */
export const ALL_A_SUBJECT_ID = 'ALL-A';

// ===== Asia/Shanghai 时间（固定 +08；口径与 baostock.ts/sw.ts 一致，自持不跨文件依赖）=====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shanghaiClose(date: string): string {
  return new Date(`${date}T15:00:00+08:00`).toISOString();
}

/** 数据日次日 00:00 Asia/Shanghai（派发冻结的保守 availableAt）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（来源字段保留原生类型：数值为 number、日期/代码为 string 或 number）。 */
export type ValuationRow = Record<string, unknown>;

export interface ValuationMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface ValuationMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface ValuationRowMapping {
  facts: ValuationMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'valuation-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: 'INDEX_VALUATION',
    subject: `INDEX:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

/** 数值列读取：number 原样、null/缺省 → null（来源 NaN 已由桥转 null）。 */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function dateStr(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
}

function isNumOrNull(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
}

/** csindex indicator.xls 原生 10 列（W31 探测实测表头，原样键名）。 */
export const CSINDEX_COLS = [
  '日期Date', '指数代码Index Code', '指数中文全称Chinese Name(Full)', '指数中文简称Index Chinese Name',
  '指数英文全称English Name(Full)', '指数英文简称Index English Name',
  '市盈率1（总股本）P/E1', '市盈率2（计算用股本）P/E2',
  '股息率1（总股本）D/P1', '股息率2（计算用股本）D/P2',
] as const;

/**
 * csindex 日频行 → INDEX_VALUATION 事实。
 * typedValue = 原生 10 列（原样）+ 日期ISO + 指数代码（补前导零的 6 位）+ 来源/频率。
 */
export function mapCsindexDailyRowsToFacts(indexCode: string, rows: ValuationRow[], ctx: ValuationMapContext): ValuationRowMapping {
  if (!/^\d{6}$/.test(indexCode)) {
    return { facts: [], rejections: rows.map((_, rowIndex) => ({ rowIndex, code: 'VALUATION_CSINDEX_CODE_INVALID' })) };
  }
  const facts: ValuationMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const iso = dateStr(row['日期ISO']);
    const pe1 = num(row['市盈率1（总股本）P/E1']);
    const pe2 = num(row['市盈率2（计算用股本）P/E2']);
    const dp1 = num(row['股息率1（总股本）D/P1']);
    const dp2 = num(row['股息率2（计算用股本）D/P2']);
    if (iso === null) {
      rejections.push({ rowIndex, code: 'VALUATION_CSINDEX_DATE_INVALID' });
      return;
    }
    if (pe1 === null && pe2 === null && dp1 === null && dp2 === null) {
      rejections.push({ rowIndex, code: 'VALUATION_CSINDEX_ALL_METRICS_MISSING' });
      return;
    }
    // 原生 10 列键名原样保留（含空格/括号/斜杠，与 DATA-SOURCES §6.2 一致）
    const raw: ValuationRow = {};
    for (const k of CSINDEX_COLS) raw[k] = row[k];
    const typedValue = {
      ...raw,
      日期ISO: iso,
      指数代码: indexCode,
      来源: 'csindex',
      频率: '日频',
    };
    const t = shanghaiClose(iso);
    facts.push({
      fact: {
        factId: factIdOf({ adapterVersion: ctx.adapterVersion, subjectId: indexCode, objectKey: iso, raw }),
        subjectType: 'INDEX',
        subjectId: indexCode,
        factKind: 'INDEX_VALUATION',
        typedValue,
        validFrom: t,
        validTo: null,
        eventAt: t,
        sourcePublishedAt: null,
        firstObservedAt: ctx.fetchedAt,
        availableAt: shanghaiNextDayStart(iso),
        supersedesFactId: null,
        artifactSha256: ctx.artifactSha256,
        adapterVersion: ctx.adapterVersion,
      },
      objectKey: iso,
    });
  });
  return { facts, rejections };
}

const LG_PE_COLS = ['指数', '等权静态市盈率', '静态市盈率', '静态市盈率中位数', '等权滚动市盈率', '滚动市盈率', '滚动市盈率中位数'] as const;
const LG_PB_COLS = ['指数', '市净率', '等权市净率', '市净率中位数'] as const;

/**
 * legulegu 月末行（PE 或 PB）→ INDEX_VALUATION 事实。
 * typedValue = 原生列（原样）+ 指数代码 + 来源/频率。
 */
export function mapLgRowsToFacts(indexCode: string, metric: 'PE' | 'PB', rows: ValuationRow[], ctx: ValuationMapContext): ValuationRowMapping {
  if (!/^\d{6}$/.test(indexCode)) {
    return { facts: [], rejections: rows.map((_, rowIndex) => ({ rowIndex, code: 'VALUATION_LG_CODE_INVALID' })) };
  }
  const cols = metric === 'PE' ? LG_PE_COLS : LG_PB_COLS;
  const facts: ValuationMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const iso = dateStr(row['日期']);
    if (iso === null) {
      rejections.push({ rowIndex, code: 'VALUATION_LG_DATE_INVALID' });
      return;
    }
    const raw: ValuationRow = { 日期: row['日期'] };
    for (const c of cols) raw[c] = row[c];
    if (!cols.every((c) => isNumOrNull(raw[c]))) {
      rejections.push({ rowIndex, code: 'VALUATION_LG_METRIC_INVALID' });
      return;
    }
    const typedValue = {
      ...raw,
      指数代码: indexCode,
      来源: 'legulegu',
      频率: '月末',
      指标: metric,
    };
    const t = shanghaiClose(iso);
    facts.push({
      fact: {
        factId: factIdOf({ adapterVersion: ctx.adapterVersion, subjectId: indexCode, objectKey: iso, raw }),
        subjectType: 'INDEX',
        subjectId: indexCode,
        factKind: 'INDEX_VALUATION',
        typedValue,
        validFrom: t,
        validTo: null,
        eventAt: t,
        sourcePublishedAt: null,
        firstObservedAt: ctx.fetchedAt,
        availableAt: shanghaiNextDayStart(iso),
        supersedesFactId: null,
        artifactSha256: ctx.artifactSha256,
        adapterVersion: ctx.adapterVersion,
      },
      objectKey: iso,
    });
  });
  return { facts, rejections };
}

const ALL_A_PE_COLS = ['middlePETTM', 'averagePETTM', 'middlePELYR', 'averagePELYR', 'close'] as const;
const ALL_A_PB_COLS = ['middlePB', 'equalWeightAveragePB', 'close'] as const;

/** 全A 月末行 → INDEX_VALUATION 事实（subjectId=ALL-A；来源自带分位列原样保留，R4 声明覆盖其口径）。 */
export function mapAllARowsToFacts(metric: 'PE' | 'PB', rows: ValuationRow[], ctx: ValuationMapContext): ValuationRowMapping {
  const metricCols = metric === 'PE' ? ALL_A_PE_COLS : ALL_A_PB_COLS;
  const facts: ValuationMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const iso = dateStr(row['date']);
    if (iso === null) {
      rejections.push({ rowIndex, code: 'VALUATION_ALLA_DATE_INVALID' });
      return;
    }
    const raw: ValuationRow = { date: row['date'] };
    for (const c of metricCols) raw[c] = row[c];
    if (!metricCols.every((c) => isNumOrNull(raw[c]))) {
      rejections.push({ rowIndex, code: 'VALUATION_ALLA_METRIC_INVALID' });
      return;
    }
    // 来源自带分位列（quantileIn*）原样随行（抓取时点口径，R4 声明覆盖）
    for (const k of Object.keys(row)) {
      if (k.startsWith('quantileIn')) raw[k] = row[k];
    }
    const typedValue = {
      ...raw,
      指数代码: ALL_A_SUBJECT_ID,
      来源: 'legulegu-allA',
      频率: '月末',
      指标: metric,
    };
    const t = shanghaiClose(iso);
    facts.push({
      fact: {
        factId: factIdOf({ adapterVersion: ctx.adapterVersion, subjectId: ALL_A_SUBJECT_ID, objectKey: iso, raw }),
        subjectType: 'INDEX',
        subjectId: ALL_A_SUBJECT_ID,
        factKind: 'INDEX_VALUATION',
        typedValue,
        validFrom: t,
        validTo: null,
        eventAt: t,
        sourcePublishedAt: null,
        firstObservedAt: ctx.fetchedAt,
        availableAt: shanghaiNextDayStart(iso),
        supersedesFactId: null,
        artifactSha256: ctx.artifactSha256,
        adapterVersion: ctx.adapterVersion,
      },
      objectKey: iso,
    });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface ValuationBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/valuation/bridge.py。 */
export function makeValuationBridgeExecutor(opts: ValuationBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/valuation/bridge.py',
  ];
  return async (args: string[]) => {
    let stdout = '';
    let killed = false;
    let failed = false;
    try {
      const res = await execFileAsync(dockerPath, [...fixedArgs, ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      });
      stdout = res.stdout;
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
      if (e.code === 'ENOENT') throw new AdapterError('VALUATION_DOCKER_MISSING', dockerPath);
      failed = true;
      killed = e.killed === true;
      if (typeof e.stdout === 'string') stdout = e.stdout;
    }
    let parsed: BridgeResponse | null = null;
    try {
      parsed = JSON.parse(stdout) as BridgeResponse;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed.ok !== 'boolean') {
      if (killed) throw new TransientAdapterError('VALUATION_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'VALUATION_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'VALUATION_QUERY_FAILED';
      // USAGE_ERROR / XLS 表头·行形态异常 = 永久错误（确定性失败，重试无意义）；其余（网络等）瞬态退避。
      if (code === 'USAGE_ERROR' || code === 'VALUATION_XLS_FAILED') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface ValuationAdapterOptions {
  pool: Pool;
  store: ArtifactStore;
  /** 注入桥执行器（单测 fixture 注入；缺省真实 docker）。 */
  execBridge?: BridgeExecutor | undefined;
  now?: (() => Date) | undefined;
  gate?: ConcurrencyGate | undefined;
  backoffSleeper?: BackoffSleeper | undefined;
  backoffAttempts?: number | undefined;
  backoffBaseDelayMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  dockerPath?: string | undefined;
  repoRootPath?: string | undefined;
}

export interface ValuationFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：adapter:resource:对象标识。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（全部输出原样携带）。 */
  notices: string[];
}

export class ValuationAdapter {
  readonly adapterVersion = VALUATION_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: ValuationAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(1); // 单来源串行稳妥默认（DATA-SOURCES §7）
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.root = opts.repoRootPath ?? repoRoot;
    this.execBridge =
      opts.execBridge ??
      makeValuationBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /** csindex 官方日频（20 交易日窗）；桥把字节存 var/，本方法读该文件入原件库。 */
  async fetchCsindexDaily(indexCode: string, useCache = false): Promise<ValuationFetchResult> {
    if (!/^\d{6}$/.test(indexCode)) {
      throw new AdapterError('VALUATION_ARGS_INVALID', `indexCode=${indexCode}（须 6 位，如 000300）`);
    }
    return this.fetchWithBytes('csindex_daily', useCache ? [indexCode, '--use-cache'] : [indexCode], {
      resource: 'csindex_daily',
      objectKey: indexCode,
      mediaType: 'application/vnd.ms-excel',
      xlsVarName: `valuation-csindex-${indexCode}indicator.xls`,
      map: (rows, ctx) => mapCsindexDailyRowsToFacts(indexCode, rows, ctx),
    });
  }

  async fetchLgPe(indexCode: string, lgKey: string): Promise<ValuationFetchResult> {
    return this.fetchLg('lg_pe', 'PE', indexCode, lgKey);
  }

  async fetchLgPb(indexCode: string, lgKey: string): Promise<ValuationFetchResult> {
    return this.fetchLg('lg_pb', 'PB', indexCode, lgKey);
  }

  private async fetchLg(
    command: 'lg_pe' | 'lg_pb',
    metric: 'PE' | 'PB',
    indexCode: string,
    lgKey: string,
  ): Promise<ValuationFetchResult> {
    if (!/^\d{6}$/.test(indexCode)) {
      throw new AdapterError('VALUATION_ARGS_INVALID', `indexCode=${indexCode}（须 6 位）`);
    }
    if (!VALUATION_TARGETS.some((t) => t.lgKey === lgKey)) {
      throw new AdapterError('VALUATION_ARGS_INVALID', `lgKey=${lgKey}（须 sz50|hs300|zz500|zz1000）`);
    }
    return this.fetch(command, [lgKey], {
      resource: command,
      objectKey: indexCode,
      map: (rows, ctx) => mapLgRowsToFacts(indexCode, metric, rows, ctx),
    });
  }

  async fetchAllAPe(): Promise<ValuationFetchResult> {
    return this.fetch('all_a_pe', [], {
      resource: 'all_a_pe',
      objectKey: ALL_A_SUBJECT_ID,
      map: (rows, ctx) => mapAllARowsToFacts('PE', rows, ctx),
    });
  }

  async fetchAllAPb(): Promise<ValuationFetchResult> {
    return this.fetch('all_a_pb', [], {
      resource: 'all_a_pb',
      objectKey: ALL_A_SUBJECT_ID,
      map: (rows, ctx) => mapAllARowsToFacts('PB', rows, ctx),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: string;
      objectKey: string;
      map: (rows: ValuationRow[], ctx: ValuationMapContext) => ValuationRowMapping;
    },
  ): Promise<ValuationFetchResult> {
    return this.fetchWithBytes(command, params, {
      ...spec,
      mediaType: 'application/json',
      xlsVarName: null,
      map: spec.map,
    });
  }

  private async fetchWithBytes(
    command: string,
    params: string[],
    spec: {
      resource: string;
      objectKey: string;
      mediaType: string;
      xlsVarName: string | null;
      map: (rows: ValuationRow[], ctx: ValuationMapContext) => ValuationRowMapping;
    },
  ): Promise<ValuationFetchResult> {
    const scope = `valuation:${spec.resource}:${spec.objectKey}`;
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'valuation',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = (response.rows ?? []) as ValuationRow[];
    const fetchedAt = this.now().toISOString();
    const bytes =
      spec.xlsVarName !== null
        ? await readFile(join(this.root, 'var', spec.xlsVarName)) // XLS 字节即原件（桥已落盘）
        : new TextEncoder().encode(canonicalJsonString(rows));
    const artifact = await this.store.put(bytes, spec.mediaType, fetchedAt);
    const mapped = spec.map(rows, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      // 去重命中（DATA-SOURCES §6.5，与 baostock/emdc 同法）：factId 按原始行内容派生，
      // 同 factId 即同对象同值；跨次抓取 firstObservedAt 不同但身份同 → 计 identical 不再插入，
      // 首见事实与其原件引用（当时批次）保留（POINT-IN-TIME §2.1 只读，不改写）。
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'valuation', scope);
    return {
      adapterVersion: this.adapterVersion,
      command,
      params,
      scope,
      artifact,
      rowCount: rows.length,
      insertedFactIds,
      identicalFactIds,
      rejectedRows: mapped.rejections,
      notices: [BACKFILL_REVISION_NOTICE, VALUATION_SNAPSHOT_NOTICE],
    };
  }
}
