/**
 * Lyra · 申万行业轴适配器（P1 W7: code-writer-pro）。
 * 合同：docs/REVISION-LOG.md R23（来源落实）、docs/specs/DATA-SOURCES.md §2.7/§6/§7、
 * docs/specs/POINT-IN-TIME.md §2/§3.4/§5.2；桥 adapters/sw/bridge.py（容器 python:3.11-slim +
 * 命名卷 lyra-akshare-py311，akshare 1.19.3）；退避/并发闸复用 ./backoff.ts（只读依赖）。
 *
 * 来源（R23 实测，2026-10-25）：
 * - 分类变更史 XLS：swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls
 *   （12,929 数据行：股票代码/计入日期/行业代码/更新日期；含退市股；逐股多行构成变更史）；
 * - 申万一级列表：akshare.sw_index_first_info（legulegu，31 行，指数代码 801xxx.SI + 名称 + 成份数）；
 * - 一级指数日线：akshare.index_hist_sw（swsresearch API，1999-12-30 起全历史）；
 * - 一级当前成分：akshare.index_component_sw（含计入日期，语义核验用，不产事实）。
 *
 * 行级语义（W7 核验结论，证据 data/sw-semantics-report.json）：
 * - 体系三段：pre2014（老申万，23 前缀）/ 2014（2014-02-21 生效，28 前缀）/ 2021（2021-07-30
 *   分类发布生效，31 前缀）；行只在代码变更时产生——跨体系未变更的代码行被携带沿用（如 000002
 *   万科A 仅一行 1991-01-29 430101，三体系沿用），因此"日期 D 的分类"= 计入 ≤ D 的最新行，
 *   行的前缀在读取窗口所属体系下解释。
 * - 2021 指数切换日 2021-12-13（成分接口计入日期 & 801020 退役于 2021-12-10）与分类发布日
 *   2021-07-30 是两条不同官方时间线，互不覆盖。
 * - 前缀（行业代码前 2 位）→ 申万一级指数代码：2021 体系 31/31（8 指数成分锚点 100% 一致 +
 *   在市成份数双射 + 证监会大类主类一致）；2014 体系 28/28（具名锚点股 + 前缀转移矩阵 +
 *   指数日线历史覆盖含 801020 采掘退役边界）。pre2014 行不带 l1IndexCode（老体系指数代码未核验）。
 *
 * availableAt 规则（POINT-IN-TIME §3.4 / R23.3，声明过的近似，R4 修订口径声明随行）：
 * - INDUSTRY_CLASS_VERSION = 计入日期+1 日 00:00 Asia/Shanghai（保守）；
 * - SW_INDEX_LIST = 抓取时刻（当前快照）；
 * - SW_INDEX_BAR = 交易日 15:00 Asia/Shanghai（收盘事实）。
 * 该表是官方今日发布的回溯史（属最新修订口径），typedValue 原样保留来源字段。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact, TimePointSubjectType } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { insertFact } from '../pintime/facts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import type { BridgeExecutor } from './baostock.js'; // 桥执行器类型（W4 冻结形态，只读引用）
import { ConcurrencyGate, resumePause, runWithBackoff, type BackoffSleeper } from './backoff.js';
import { SW_CLASS_SOURCE_GAP_ID, SW2014_GAP_ID } from './swclass.js';

const execFileAsync = promisify(execFile);

export const SW_ADAPTER_VERSION = 'sw@p1';

/** XLS 桥内缓存路径（容器内 /work/var ↔ 工程根 var）。 */
export const SW_XLS_VAR_PATH = 'var/sw-StockClassifyUse_stock.xls';

// ===== 体系边界（R23/W7 实测核验；证据见 data/sw-semantics-report.json）=====

/** 2014 版分类生效日（XLS 2014-02-21 簇 1,124 行：代码变更股换行，其余携带）。 */
export const SW_2014_EFFECTIVE = '2014-02-21';
/** 2021 版分类发布/生效日（XLS 2021-07-30 簇 3,069 行；序列值 44407）。 */
export const SW_2021_CLASSIFY_EFFECTIVE = '2021-07-30';
/** 2021 版指数切换日（成分接口计入日期众数；801020 指数最后交易日 2021-12-10）。 */
export const SW_2021_INDEX_SWITCH = '2021-12-13';

export type SwSystem = 'pre2014' | '2014' | '2021';

/** 行业代码铸造体系：按计入日期判定（pre2014 = 老申万 23 前缀体系，公开锚点定性）。 */
export function swSystemOf(inDateISO: string): SwSystem {
  if (inDateISO >= SW_2021_CLASSIFY_EFFECTIVE) return '2021';
  if (inDateISO >= SW_2014_EFFECTIVE) return '2014';
  return 'pre2014';
}

// ===== 前缀 → 申万一级指数代码（核验冻结；证据 data/sw-semantics-report.json）=====

/** 2021 体系：31/31。8 个指数成分锚点（801010/801030/801080/801760/801780/801880/801950/801970，
 * 1,637 只成分股 100% 一致）+ 在市成份数双射（26/31 精确、其余 ±1–2）+ 证监会大类主类一致。 */
export const SW2021_PREFIX_L1: Readonly<Record<string, string>> = {
  '11': '801010', '22': '801030', '23': '801040', '24': '801050', '27': '801080',
  '28': '801880', '33': '801110', '34': '801120', '35': '801130', '36': '801140',
  '37': '801150', '41': '801160', '42': '801170', '43': '801180', '45': '801200',
  '46': '801210', '48': '801780', '49': '801790', '51': '801230', '61': '801710',
  '62': '801720', '63': '801730', '64': '801890', '65': '801740', '71': '801750',
  '72': '801760', '73': '801770', '74': '801950', '75': '801960', '76': '801970',
  '77': '801980',
};

/** 2014 体系：28/28（2014 窗口有效前缀全集）。具名锚点股（神华/万华/宝钢/紫金/京东方/比亚迪/
 * 格力/茅台/伊利/雅戈尔/太阳纸业/恒瑞/长江电力/上港/万科/居然之家/锦江/招行/中信证券/中国宝安/
 * 海螺/中国建筑/特变电工/三一/中航沈飞/用友/中南传媒/中兴）+ 2014→2021 前缀转移矩阵 +
 * 指数日线历史覆盖（801020 采掘 1999-12-30~2021-12-10 退役边界）。 */
export const SW2014_PREFIX_L1: Readonly<Record<string, string>> = {
  '11': '801010', '21': '801020', '22': '801030', '23': '801040', '24': '801050',
  '27': '801080', '28': '801880', '33': '801110', '34': '801120', '35': '801130',
  '36': '801140', '37': '801150', '41': '801160', '42': '801170', '43': '801180',
  '45': '801200', '46': '801210', '48': '801780', '49': '801790', '51': '801230',
  '61': '801710', '62': '801720', '63': '801730', '64': '801890', '65': '801740',
  '71': '801750', '72': '801760', '73': '801770',
};

/** 行的 l1IndexCode：按铸造体系取映射；无核验映射（pre2014 / 未知前缀）返回 null——不得猜。
 * 消费方按读取窗口体系解释前缀时用 SW2014_PREFIX_L1 / SW2021_PREFIX_L1 自行判定。 */
export function swL1IndexCodeFor(industryCode: string, inDateISO: string): string | null {
  const prefix = industryCode.slice(0, 2);
  const system = swSystemOf(inDateISO);
  const table = system === '2021' ? SW2021_PREFIX_L1 : system === '2014' ? SW2014_PREFIX_L1 : null;
  return table === null ? null : table[prefix] ?? null;
}

// ===== 缺口文本（W6 登记的缺口按 R23.6 收口；既有封存保留其历史缺口记录，不可改写）=====

/** SW_CLASS_SOURCE_GAP 关闭文本（语义核验通过：来源落实 + 双版本映射完整）。 */
export const SW_CLASS_SOURCE_GAP_CLOSED =
  `${SW_CLASS_SOURCE_GAP_ID}：关闭（2026-10-25，R23 裁定 / W7 落实）。申万行业轴来源已落实：` +
  `分类变更史 XLS（swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls，12,929 数据行，` +
  `逐股多行、含退市股、新旧三套编码体系混杂——pre2014/2014/2021 三段，行按代码变更产生、跨体系携带）` +
  `经 sw@p1 适配器入库为 INDUSTRY_CLASS_VERSION（availableAt=计入日期+1 日 00:00 保守口径，` +
  `R4 修订口径声明随行：官方今日发布的回溯史属最新修订口径）；31 个一级行业列表与指数日线全历史入库` +
  `（SW_INDEX_LIST / SW_INDEX_BAR，经 AKShare）。前缀→一级指数代码映射 2021 体系 31/31、` +
  `2014 体系 28/28 经成分锚点 + 成份数双射 + 具名股锚点 + 指数历史覆盖核验，` +
  `证据 data/sw-semantics-report.json。证监会分类（csrc@current）降为辅助事实保留。`;

/** SW2014_GAP 关闭文本（2014 版历史时点表由官方回溯 XLS 行段构成并三重核验）。 */
export const SW2014_GAP_CLOSED =
  `${SW2014_GAP_ID}：关闭（2026-10-25，W7 落实）。申万 2014 版（2014-02-21 生效，2021-07-30 止）的` +
  `历史时点表由官方回溯 XLS 对应行段构成：2014 窗口内每股取计入 ≤ D 的最新行（含跨体系携带行，` +
  `如 000002 万科A 唯一行 1991-01-29 430101 在 2014 窗口仍为现行分类）；28 个一级行业前缀经` +
  `具名锚点股 + 2014→2021 前缀转移矩阵（拆分结构：21 采掘→74 煤炭/75 石油石化，41 公用事业→41+76 环保，` +
  `51 综合消解、44 金融→48 银行/49 非银，25 建筑建材→61/62，31 交运设备→28/65，47 信息服务→71/72/73）+` +
  `指数日线历史覆盖（801020 采掘 1999-12-30~2021-12-10 退役边界，与 2021-12-13 指数切换日互证）三重核验，` +
  `映射完整（SW2014_PREFIX_L1）；证据 data/sw-semantics-report.json。pre2014（老申万 23 前缀）行` +
  `照常入库但不带 l1IndexCode（老体系指数代码未核验，2015 前研究窗口外，读回时按缺口可见）。`;

// ===== Asia/Shanghai 时间（固定 +08；口径与 baostock.ts 一致，此处自持不跨文件依赖）=====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function dayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 计入日期+1 日 00:00 Asia/Shanghai（分类行保守 D+1，POINT-IN-TIME §3.4 + R23.3）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

/** 交易日 15:00 Asia/Shanghai（指数日线收盘事实）。 */
export function shanghaiClose(date: string): string {
  return new Date(`${date}T15:00:00+08:00`).toISOString();
}

function shanghaiInstant(dateTime: string): string {
  return new Date(`${dateTime.replaceAll(' ', 'T')}+08:00`).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（sw 来源字段保留原生类型：数值为 number、日期为字符串）。 */
export type SwRow = Record<string, unknown>;

export interface SwMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface SwMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface SwRowMapping {
  facts: SwMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'sw-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

/** 桥原始行（股票代码/计入日期/行业代码/更新日期 + ISO 转换字段）的形状校验与读取。 */
function classifyFields(row: SwRow): { code: string; inISO: string; ind: string; updISO: string } | null {
  const code = row['股票代码'];
  const inISO = row['计入日期ISO'];
  const ind = row['行业代码'];
  const updISO = row['更新日期ISO'];
  if (typeof code !== 'string' || code.length === 0) return null;
  if (typeof inISO !== 'string' || !DATE_RE.test(inISO)) return null;
  if (typeof ind !== 'string' || !/^\d{6}$/.test(ind)) return null;
  if (typeof updISO !== 'string' || !(DATETIME_RE.test(updISO) || DATE_RE.test(updISO))) return null;
  return { code, inISO, ind, updISO };
}

/**
 * 分类变更史行 → INDUSTRY_CLASS_VERSION 事实（每股按计入日期升序链接 validFrom/validTo）。
 * typedValue 原样保留来源字段（含序列值），附体系判定与 l1IndexCode（映射可得时）；
 * availableAt=计入+1 日 00:00+08；sourcePublishedAt=更新日期（来源标注的行更新时刻）。
 */
export function mapClassifyRowsToFacts(rows: SwRow[], ctx: SwMapContext): SwRowMapping {
  const facts: SwMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  const parsed: { rowIndex: number; f: ReturnType<typeof classifyFields> }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = classifyFields(row);
    if (f === null) rejections.push({ rowIndex, code: 'SW_CLASSIFY_ROW_INVALID' });
    else parsed.push({ rowIndex, f });
  });
  type Entry = { rowIndex: number; code: string; inISO: string; ind: string; updISO: string; row: SwRow };
  const entries: Entry[] = [];
  for (const p of parsed) {
    if (p.f !== null) entries.push({ rowIndex: p.rowIndex, ...p.f, row: rows[p.rowIndex]! });
  }
  const byStock = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byStock.get(e.code) ?? [];
    list.push(e);
    byStock.set(e.code, list);
  }
  for (const [code, list] of byStock) {
    list.sort((a, b) => (a.inISO < b.inISO ? -1 : a.inISO > b.inISO ? 1 : a.ind.localeCompare(b.ind)));
    for (let i = 0; i < list.length; i += 1) {
      const cur = list[i]!;
      const next = list[i + 1];
      const raw = {
        股票代码: cur.row['股票代码'],
        计入日期: cur.row['计入日期'],
        行业代码: cur.row['行业代码'],
        更新日期: cur.row['更新日期'],
      };
      const typedValue = {
        ...raw,
        计入日期ISO: cur.inISO,
        更新日期ISO: cur.updISO,
        体系: swSystemOf(cur.inISO),
        l1IndexCode: swL1IndexCodeFor(cur.ind, cur.inISO),
      };
      const fact: TimePointFact = {
        factId: factIdOf({
          adapterVersion: ctx.adapterVersion,
          factKind: 'INDUSTRY_CLASS_VERSION',
          subjectType: 'STOCK',
          subjectId: code,
          objectKey: `${cur.inISO}:${cur.ind}`,
          raw,
        }),
        subjectType: 'STOCK',
        subjectId: code,
        factKind: 'INDUSTRY_CLASS_VERSION',
        typedValue,
        validFrom: dayStart(cur.inISO),
        validTo: next === undefined ? null : dayStart(next.inISO),
        eventAt: dayStart(cur.inISO),
        sourcePublishedAt: shanghaiInstant(cur.updISO),
        firstObservedAt: ctx.fetchedAt,
        availableAt: shanghaiNextDayStart(cur.inISO),
        supersedesFactId: null,
        artifactSha256: ctx.artifactSha256,
        adapterVersion: ctx.adapterVersion,
      };
      facts.push({ fact, objectKey: `${cur.inISO}:${cur.ind}` });
    }
  }
  return { facts, rejections };
}

/** 31 个一级行业列表 → 单条 SW_INDEX_LIST 当前快照事实（availableAt=抓取时刻；validFrom=null 不编造）。 */
export function mapL1ListRowToFacts(rows: SwRow[], ctx: SwMapContext): SwRowMapping {
  if (rows.length === 0) return { facts: [], rejections: [{ rowIndex: 0, code: 'SW_L1_LIST_EMPTY' }] };
  const fact: TimePointFact = {
    factId: factIdOf({
      adapterVersion: ctx.adapterVersion,
      factKind: 'SW_INDEX_LIST',
      subjectType: 'INDEX',
      subjectId: 'SW-L1-LIST',
      objectKey: 'current',
      raw: rows,
    }),
    subjectType: 'INDEX',
    subjectId: 'SW-L1-LIST',
    factKind: 'SW_INDEX_LIST',
    typedValue: { rows },
    validFrom: null,
    validTo: null,
    eventAt: ctx.fetchedAt,
    sourcePublishedAt: null,
    firstObservedAt: ctx.fetchedAt,
    availableAt: ctx.fetchedAt,
    supersedesFactId: null,
    artifactSha256: ctx.artifactSha256,
    adapterVersion: ctx.adapterVersion,
  };
  return { facts: [{ fact, objectKey: 'current' }], rejections: [] };
}

/** 指数日线行 → SW_INDEX_BAR 事实（availableAt=交易日 15:00+08；typedValue 保留 akshare 原始字段）。 */
export function mapDailyRowsToFacts(indexCode: string, rows: SwRow[], ctx: SwMapContext): SwRowMapping {
  if (!/^\d{6}$/.test(indexCode)) {
    return { facts: [], rejections: rows.map((_, rowIndex) => ({ rowIndex, code: 'SW_BAR_INDEX_INVALID' })) };
  }
  const facts: SwMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const date = row['日期'];
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      rejections.push({ rowIndex, code: 'SW_BAR_DATE_MISSING' });
      return;
    }
    const value: SwRow = { ...row, swIndexCode: indexCode };
    const t = shanghaiClose(date);
    facts.push({
      fact: {
        factId: factIdOf({
          adapterVersion: ctx.adapterVersion,
          factKind: 'SW_INDEX_BAR',
          subjectType: 'INDEX',
          subjectId: indexCode,
          objectKey: date,
          raw: row,
        }),
        subjectType: 'INDEX',
        subjectId: indexCode,
        factKind: 'SW_INDEX_BAR',
        typedValue: value,
        validFrom: t,
        validTo: null,
        eventAt: t,
        sourcePublishedAt: null,
        firstObservedAt: ctx.fetchedAt,
        availableAt: t,
        supersedesFactId: null,
        artifactSha256: ctx.artifactSha256,
        adapterVersion: ctx.adapterVersion,
      },
      objectKey: date,
    });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface SwBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/sw/bridge.py。 */
export function makeSwBridgeExecutor(opts: SwBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/sw/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('SW_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('SW_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'SW_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'SW_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface SwAdapterOptions {
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
  /** 工程根（缺省取本文件相对根；容器 -v mount 与 XLS 路径用）。 */
  repoRootPath?: string | undefined;
}

export interface SwFetchResult {
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

export class SwAdapter {
  readonly adapterVersion = SW_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: SwAdapterOptions) {
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
      makeSwBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /** 分类变更史 XLS（真实下载；桥把字节存 var/sw-StockClassifyUse_stock.xls，本方法读该文件入原件库）。 */
  async fetchClassifyXls(useCache = false): Promise<SwFetchResult> {
    return this.fetchWithBytes('classify_xls', useCache ? ['--use-cache'] : [], {
      resource: 'sw_classification',
      objectKey: 'StockClassifyUse_stock.xls',
      mediaType: 'application/vnd.ms-excel',
      rowsKey: (r) => r.rows ?? [],
      map: (rows, ctx) => mapClassifyRowsToFacts(rows, ctx),
    });
  }

  async fetchL1List(): Promise<SwFetchResult> {
    return this.fetch('l1_list', [], { resource: 'sw_l1_list', objectKey: 'current', map: mapL1ListRowToFacts });
  }

  async fetchL1Daily(indexCode: string): Promise<SwFetchResult> {
    if (!/^\d{6}$/.test(indexCode)) {
      throw new AdapterError('SW_ARGS_INVALID', `indexCode=${indexCode}（须 6 位，如 801010）`);
    }
    return this.fetch('l1_daily', [indexCode], {
      resource: 'sw_l1_daily',
      objectKey: indexCode,
      map: (rows, ctx) => mapDailyRowsToFacts(indexCode, rows, ctx),
    });
  }

  /** 当前成分（语义核验用；响应入原件库，不产生事实——事实面按派发冻结为三 kind）。 */
  async fetchL1Component(indexCode: string): Promise<SwFetchResult> {
    if (!/^\d{6}$/.test(indexCode)) {
      throw new AdapterError('SW_ARGS_INVALID', `indexCode=${indexCode}（须 6 位，如 801010）`);
    }
    return this.fetch('l1_component', [indexCode], {
      resource: 'sw_l1_component',
      objectKey: indexCode,
      map: () => ({ facts: [], rejections: [] }),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: string;
      objectKey: string;
      map: (rows: SwRow[], ctx: SwMapContext) => SwRowMapping;
      mediaType?: string;
    },
  ): Promise<SwFetchResult> {
    return this.fetchWithBytes(command, params, {
      ...spec,
      mediaType: spec.mediaType ?? 'application/json',
      rowsKey: (r) => r.rows ?? [],
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
      rowsKey: (response: BridgeResponse) => SwRow[];
      map: (rows: SwRow[], ctx: SwMapContext) => SwRowMapping;
    },
  ): Promise<SwFetchResult> {
    const scope = `sw:${spec.resource}:${spec.objectKey}`;
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'sw',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = spec.rowsKey(response);
    const fetchedAt = this.now().toISOString();
    const bytes =
      command === 'classify_xls'
        ? await readFile(join(this.root, SW_XLS_VAR_PATH)) // XLS 字节即原件（桥已落盘）
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
      // insertFact 同 factId 同内容幂等（IDENTICAL）；事实身份由原始行内容派生（DATA-SOURCES §6.5）。
      const status = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'sw', scope);
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
      notices: [BACKFILL_REVISION_NOTICE],
    };
  }
}
