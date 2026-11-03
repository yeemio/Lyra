/**
 * Lyra · 新浪行情适配器（P1 W9: code-writer）。
 * 合同：docs/specs/DATA-SOURCES.md §2.4（行情双源互证）、§6（适配器规则与去重）、§7（限流退避）、
 * §5（修订口径声明）；Owner 数据源指令（docs/REVISION-LOG.md "Owner 数据源指令" + R24 第 4 条）：
 * 新浪为行情第二源，直连端点、不经 akshare（其 fund_etf_hist_sina 已坏）；东财记为后续第三渠道。
 * 时点语义 docs/specs/POINT-IN-TIME.md §2/§3；退避/并发闸/暂停上报复用 ./backoff.ts（只 import 不复刻）。
 *
 * 端点（总控 2026-10-25 直测；本文件解析器字段位同日真实探测核对）：
 * - 批量报价 GET https://hq.sinajs.cn/list=sh513330,sz159901,...
 *   须带 Referer: https://finance.sina.com.cn；响应 GBK 编码；
 *   行格式 var hq_str_<symbol>="f0,f1,...,f33";（股票/ETF/跨境 ETF 布局一致，34 位），
 *   实测字段位：0 名称,1 开,2 昨收,3 现价,4 高,5 低,6 买一价,7 卖一价,8 成交量(股),
 *   9 成交额(元),10–29 五档量价,30 日期,31 时间,32–33 附加段。typedValue 另存 rawFields 全位原样。
 * - 日 K GET https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20data=/CN_MarketDataService.getKLineData
 *   ?symbol=sh513330&scale=240&ma=no&datalen=N（同带 Referer；N≤2000）；
 *   响应为前置注释行 + JSONP 包裹 var data=([{day,open,high,low,close,volume},...])；
 *   **无成交额列**——日 K 成交额为新浪侧缺口（crossCheckBars 对 amount 跳过并计数），
 *   当日成交额可从报价端点当日快照（字段 9）取。
 *
 * 职责（DATA-SOURCES §6.2：取数 → 解析为带时间字段的事实 → 写原件库，不决定业务语义）：
 * - 每次成功响应的原始字节（GBK 原样，不改码不重排）作为原件入 ArtifactStore
 *   （application/javascript; charset=gbk，firstObservedAt=抓取时刻；同 bytes 幂等）；
 * - 行映射为 TimePointFact 批量 insertFact（复用 src/pintime/facts.ts）；事实种类：
 *   报价 → SINA_QUOTE（快照类：availableAt=抓取时刻；factId 含观察时刻，同内容再抓=新观察事实，
 *   不与旧观察冲突）；日 K → DAILY_BAR_SINA（availableAt=eventAt=validFrom=该交易日 15:00
 *   Asia/Shanghai；factId 不含观察时刻，已终局窗口同键重放 → 同 factId → IDENTICAL，§6.5 去重）。
 *   两种 factKind 均不接 supersedes 链（来源改值时并行并存，按来源冲突处置，POINT-IN-TIME §4）。
 * - subjectId 归一化与 BaoStock 同形：复用 ./baostock.ts 的 normalizeCode/classifySubject
 *   （subjectId=裸 6 位如 513330，subjectType=ETF/STOCK；归一化代码 sh.513330 进 typedValue.code），
 *   保证互证与跨源联读时主体键一致。
 * - R4 修订口径声明随输出原样携带（notices）。
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ArtifactRef, TimePointFact, TimePointSubjectType } from '../contracts.js';
import { canonicalSha256 } from '../canonical.js';
import { insertFact, loadFact, type InsertFactStatus } from '../pintime/facts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
} from './adapter-types.js';
import {
  ConcurrencyGate,
  resumePause,
  runWithBackoff,
  type BackoffSleeper,
} from './backoff.js';
import { classifySubject, normalizeCode, shanghaiClose } from './baostock.js';

export const SINA_ADAPTER_VERSION = 'sina@p1';

export const SINA_QUOTE_REFERER = 'https://finance.sina.com.cn';
export const SINA_QUOTE_URL_BASE = 'https://hq.sinajs.cn/list=';
export const SINA_KLINE_URL =
  'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20data=/CN_MarketDataService.getKLineData';

/** 报价一次批量上限（URL 长度边界校验；真实批量 4 样本远低于此）。 */
export const SINA_QUOTE_BATCH_LIMIT = 50;
/** 日 K datalen 边界（来源侧约 2000 上限，实测口径）。 */
export const SINA_KLINE_DATALEN_MAX = 2000;
export const SINA_KLINE_SCALE = '240';

const gbkDecoder = new TextDecoder('gbk');

// ===== 代码归一（与 BaoStock 同形）=====

/** 任意形态（513330 / sh.513330 / sh513330）→ BaoStock 归一代码 sh.513330。 */
export function toNormalizedCode(code: string): string {
  const bare = /^s?h?z?(\d{6})$/.exec(code);
  if (bare !== null) return normalizeCode(bare[1] as string);
  return normalizeCode(code);
}

/** BaoStock 归一代码 sh.513330 → 新浪 symbol sh513330。 */
export function toSinaSymbol(bsCode: string): string {
  return bsCode.replace('.', '');
}

/** 主体归类（与 BaoStock 同形：subjectId=裸 6 位，subjectType=ETF/STOCK/INDEX）。 */
export function classifySubjectLikeBaoStock(bsCode: string): {
  subjectType: TimePointSubjectType;
  subjectId: string;
} {
  return classifySubject(bsCode);
}

// ===== 真实抓取器（单测注入 fixture；生产 fetch + Referer）=====

export type SinaFetcher = (url: string) => Promise<Uint8Array>;

export function makeRealSinaFetcher(timeoutMs = 30_000): SinaFetcher {
  return async (url) => {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Referer: SINA_QUOTE_REFERER,
          'User-Agent': 'Mozilla/5.0 (Lyra personal research; single-user low-rate)',
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TransientAdapterError('SINA_TIMEOUT', `超过 ${timeoutMs}ms`);
      }
      throw new TransientAdapterError('SINA_NETWORK_ERROR', String(error));
    }
    if (!res.ok) {
      throw new TransientAdapterError('SINA_HTTP_STATUS', `HTTP ${String(res.status)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}

// ===== 解析（纯函数，单测 fixture 字节注入；GBK 原字节照存原件库后此处才解码）=====

export interface SinaQuoteLine {
  symbol: string;
  fields: string[];
}

/**
 * 解析批量报价响应（GBK 字节）：抽出全部 var hq_str_<symbol>="..." 行。
 * 空串行（无效/未知代码的来源应答）保留为空 fields，由映射层按行具名拒绝。
 */
export function parseQuoteResponse(bytes: Uint8Array): SinaQuoteLine[] {
  const text = gbkDecoder.decode(bytes);
  const lines: SinaQuoteLine[] = [];
  for (const m of text.matchAll(/var hq_str_([a-z]{2}\d{6})="([^"]*)"/g)) {
    lines.push({ symbol: m[1] as string, fields: (m[2] as string).split(',') });
  }
  if (lines.length === 0) {
    throw new TransientAdapterError(
      'SINA_RESPONSE_UNPARSEABLE',
      `报价响应无可解析行（前 120 字符：${text.slice(0, 120)}）`,
    );
  }
  return lines;
}

/** 实测字段位（2026-10-25 四样本探测：股票/ETF/跨境 ETF 布局一致，≥32 位）。 */
export interface SinaQuoteFields {
  name: string;
  open: string;
  preclose: string;
  current: string;
  high: string;
  low: string;
  bid1: string;
  ask1: string;
  volume: string;
  amount: string;
  date: string;
  time: string;
}

/** 位字段 → 具名字段（0–31 实测位；fields 不足 32 视为不可解析行，返回 null）。 */
export function quoteFieldsToNamed(fields: string[]): SinaQuoteFields | null {
  if (fields.length < 32) return null;
  return {
    name: fields[0] ?? '',
    open: fields[1] ?? '',
    preclose: fields[2] ?? '',
    current: fields[3] ?? '',
    high: fields[4] ?? '',
    low: fields[5] ?? '',
    bid1: fields[6] ?? '',
    ask1: fields[7] ?? '',
    volume: fields[8] ?? '',
    amount: fields[9] ?? '',
    date: fields[30] ?? '',
    time: fields[31] ?? '',
  };
}

export interface SinaKlineRow {
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** 剥 JSONP 壳：锚定 var data=（前置可有注释行），取其后首个 ( 到末个 ) 之间 JSON。 */
export function parseKlineResponse(bytes: Uint8Array): SinaKlineRow[] {
  const text = gbkDecoder.decode(bytes);
  const anchor = text.indexOf('var data=');
  const start = anchor === -1 ? -1 : text.indexOf('(', anchor);
  const end = text.lastIndexOf(')');
  if (anchor === -1 || start === -1 || end === -1 || end <= start) {
    throw new TransientAdapterError(
      'SINA_RESPONSE_UNPARSEABLE',
      `K线响应无 JSONP 包裹（前 120 字符：${text.slice(0, 120)}）`,
    );
  }
  const json = text.slice(start + 1, end);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TransientAdapterError(
      'SINA_RESPONSE_UNPARSEABLE',
      `JSONP 内体不可解析（前 120 字符：${json.slice(0, 120)}）`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TransientAdapterError('SINA_RESPONSE_UNPARSEABLE', 'JSONP 内体非数组');
  }
  return parsed as SinaKlineRow[];
}

/** K 线行 day 字段提取交易日（YYYY-MM-DD；实测 scale=240 的 day 为纯日期，仍按前 10 位防御）。 */
export function klineDayToTradeDate(day: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(day);
  return m?.[1] ?? null;
}

// ===== 事实映射（纯函数）=====

export interface SinaMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface SinaMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

function subjectOf(bsCode: string): { subjectType: TimePointSubjectType; subjectId: string } {
  return classifySubject(bsCode);
}

/** 报价 factId：含观察时刻（快照类语义——同内容再抓是新观察，availableAt 不同即不同事实）。 */
function quoteFactId(args: {
  adapterVersion: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  row: unknown;
  observedAt: string;
}): string {
  return 'sina-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: 'SINA_QUOTE',
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    row: args.row,
    observedAt: args.observedAt,
  });
}

/** 日 K factId：不含观察时刻（已终局窗口——同键同值重放 → 同 factId → 去重，DATA-SOURCES §6.5）。 */
function barFactId(args: {
  adapterVersion: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  row: unknown;
}): string {
  return 'sina-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: 'DAILY_BAR_SINA',
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    row: args.row,
  });
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

export interface QuoteMapping {
  facts: SinaMappedFact[];
  rejections: { symbol: string; code: string }[];
}

/**
 * 报价行 → SINA_QUOTE 事实。快照类：availableAt=firstObservedAt=抓取时刻；
 * eventAt=来源自述报价时刻（date+time，Asia/Shanghai）不可解析时为 null（不编造）；
 * validFrom/sourcePublishedAt=null（快照无声明效力窗/发布时间，同 BaoStock STOCK_BASIC 先例）。
 */
export function mapQuoteLinesToFacts(
  lines: SinaQuoteLine[],
  bsCodes: Map<string, string>,
  ctx: SinaMapContext,
): QuoteMapping {
  const facts: SinaMappedFact[] = [];
  const rejections: { symbol: string; code: string }[] = [];
  for (const line of lines) {
    if (line.fields.length === 1 && (line.fields[0] ?? '') === '') {
      rejections.push({ symbol: line.symbol, code: 'SINA_QUOTE_EMPTY' });
      continue;
    }
    const named = quoteFieldsToNamed(line.fields);
    if (named === null) {
      rejections.push({ symbol: line.symbol, code: 'SINA_QUOTE_FIELDS_TOO_FEW' });
      continue;
    }
    const bsCode = bsCodes.get(line.symbol);
    if (bsCode === undefined) {
      rejections.push({ symbol: line.symbol, code: 'SINA_QUOTE_SYMBOL_UNREQUESTED' });
      continue;
    }
    const { subjectType, subjectId } = subjectOf(bsCode);
    const eventAt =
      DATETIME_RE.test(named.date) && TIME_RE.test(named.time)
        ? new Date(`${named.date}T${named.time}+08:00`).toISOString()
        : null;
    const objectKey = eventAt !== null ? `${named.date} ${named.time}` : ctx.fetchedAt;
    const typedValue = {
      code: bsCode,
      sinaSymbol: line.symbol,
      ...named,
      rawFields: line.fields,
    };
    const fact: TimePointFact = {
      factId: quoteFactId({
        adapterVersion: ctx.adapterVersion,
        subjectType,
        subjectId,
        objectKey,
        row: typedValue,
        observedAt: ctx.fetchedAt,
      }),
      subjectType,
      subjectId,
      factKind: 'SINA_QUOTE',
      typedValue,
      validFrom: null,
      validTo: null,
      eventAt,
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: ctx.fetchedAt,
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey });
  }
  return { facts, rejections };
}

export interface KlineMapping {
  facts: SinaMappedFact[];
  rejections: { day: string; code: string }[];
}

/** 日 K 行 → DAILY_BAR_SINA 事实：availableAt=eventAt=validFrom=交易日 15:00 Asia/Shanghai。 */
export function mapKlineRowsToFacts(
  rows: SinaKlineRow[],
  bsCode: string,
  ctx: SinaMapContext,
): KlineMapping {
  const { subjectType, subjectId } = subjectOf(bsCode);
  const facts: SinaMappedFact[] = [];
  const rejections: { day: string; code: string }[] = [];
  for (const row of rows) {
    const date = klineDayToTradeDate(row.day ?? '');
    if (date === null) {
      rejections.push({ day: String(row.day ?? ''), code: 'DAILY_BAR_SINA_DATE_MISSING' });
      continue;
    }
    const t = shanghaiClose(date);
    const typedValue = {
      code: bsCode,
      sinaSymbol: toSinaSymbol(bsCode),
      scale: SINA_KLINE_SCALE,
      day: row.day,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };
    const fact: TimePointFact = {
      factId: barFactId({
        adapterVersion: ctx.adapterVersion,
        subjectType,
        subjectId,
        objectKey: date,
        row: typedValue,
      }),
      subjectType,
      subjectId,
      factKind: 'DAILY_BAR_SINA',
      typedValue,
      validFrom: t,
      validTo: null,
      eventAt: t,
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: t,
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: date });
  }
  return { facts, rejections };
}

// ===== 与 BaoStock DAILY_BAR 互证（纯函数；输出差异报告，不抛错）=====

export interface CrossCheckOptions {
  /** 价格（开高低收）相对容差，|a-b|/max(|a|,|b|)；默认 1e-6（两源原始价等值口径）。 */
  priceRelTolerance?: number | undefined;
  /** 成交量相对容差；默认 1e-6（实测两源同为股数、等值）。 */
  volumeRelTolerance?: number | undefined;
  /** 量纲比 bs = sina × ratio；默认 1（2026-10-25 实测同为股）。 */
  volumeUnitRatio?: number | undefined;
}

export interface BarDiffEntry {
  date: string;
  field: 'open' | 'high' | 'low' | 'close' | 'volume';
  bsValue: string;
  sinaValue: string;
  relDiff: number;
}

export interface CrossCheckReport {
  bsFactCount: number;
  sinaFactCount: number;
  comparedDates: string[];
  matchedDates: string[];
  missingInSina: string[];
  missingInBs: string[];
  /** 新浪日 K 无额字段而被跳过 amount 比对的交集日期数。 */
  amountSkippedDates: number;
  diffs: BarDiffEntry[];
  /** diffs 与双向缺失均为空。 */
  consistent: boolean;
}

interface BarView {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount?: string | undefined;
}

function relDiff(a: number, b: number): number {
  const den = Math.max(Math.abs(a), Math.abs(b));
  if (den === 0) return 0;
  return Math.abs(a - b) / den;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractBsBar(fact: TimePointFact): { date: string; bar: BarView } | null {
  const tv = fact.typedValue as Record<string, unknown>;
  const date = tv.date;
  if (typeof date !== 'string' || !DATETIME_RE.test(date)) return null;
  return {
    date,
    bar: {
      open: String(tv.open ?? ''),
      high: String(tv.high ?? ''),
      low: String(tv.low ?? ''),
      close: String(tv.close ?? ''),
      volume: String(tv.volume ?? ''),
      amount: typeof tv.amount === 'string' ? tv.amount : undefined,
    },
  };
}

function extractSinaBar(fact: TimePointFact): { date: string; bar: BarView } | null {
  const tv = fact.typedValue as Record<string, unknown>;
  const date = klineDayToTradeDate(String(tv.day ?? ''));
  if (date === null) return null;
  return {
    date,
    bar: {
      open: String(tv.open ?? ''),
      high: String(tv.high ?? ''),
      low: String(tv.low ?? ''),
      close: String(tv.close ?? ''),
      volume: String(tv.volume ?? ''),
    },
  };
}

function extractBars(facts: TimePointFact[], side: 'bs' | 'sina'): Map<string, BarView> {
  const out = new Map<string, BarView>();
  for (const fact of facts) {
    const view = side === 'bs' ? extractBsBar(fact) : extractSinaBar(fact);
    if (view !== null) out.set(view.date, view.bar);
  }
  return out;
}

/**
 * OHLCV 逐日容差比对（按 date 联接）。新浪日 K 无成交额列 → amount 字段跳过并计数（缺口显式，
 * 不按零比对、不静默）；差异进报告不抛错（调用方据 consistent 决定 go/no-go，适配器不裁定）。
 */
export function crossCheckBars(
  bsFacts: TimePointFact[],
  sinaFacts: TimePointFact[],
  opts: CrossCheckOptions = {},
): CrossCheckReport {
  const priceTol = opts.priceRelTolerance ?? 1e-6;
  const volTol = opts.volumeRelTolerance ?? 1e-6;
  const unitRatio = opts.volumeUnitRatio ?? 1;
  const bs = extractBars(bsFacts, 'bs');
  const sina = extractBars(sinaFacts, 'sina');

  const allDates = [...new Set([...bs.keys(), ...sina.keys()])].sort();
  const diffs: BarDiffEntry[] = [];
  const matchedDates: string[] = [];
  const missingInSina: string[] = [];
  const missingInBs: string[] = [];
  let amountSkippedDates = 0;

  const check = (date: string, field: 'open' | 'high' | 'low' | 'close', tol: number): void => {
    const b = bs.get(date) as BarView;
    const s = sina.get(date) as BarView;
    const bn = num(b[field]);
    const sn = num(s[field]);
    if (bn === null || sn === null) {
      diffs.push({
        date, field, bsValue: b[field] ?? '', sinaValue: s[field] ?? '', relDiff: Number.NaN,
      });
      return;
    }
    const d = relDiff(bn, sn);
    if (d > tol) {
      diffs.push({ date, field, bsValue: b[field] ?? '', sinaValue: s[field] ?? '', relDiff: d });
    }
  };

  for (const date of allDates) {
    const b = bs.get(date);
    const s = sina.get(date);
    if (b === undefined) {
      missingInBs.push(date);
      continue;
    }
    if (s === undefined) {
      missingInSina.push(date);
      continue;
    }
    check(date, 'open', priceTol);
    check(date, 'high', priceTol);
    check(date, 'low', priceTol);
    check(date, 'close', priceTol);
    const bv = num(b.volume);
    const sv = num(s.volume);
    if (bv === null || sv === null) {
      diffs.push({
        date, field: 'volume', bsValue: b.volume, sinaValue: s.volume, relDiff: Number.NaN,
      });
    } else {
      const d = relDiff(bv, sv * unitRatio);
      if (d > volTol) {
        diffs.push({ date, field: 'volume', bsValue: b.volume, sinaValue: s.volume, relDiff: d });
      }
    }
    // 成交额：新浪日 K 结构性无额字段 → 全部交集日期跳过该字段比对并计数（缺口显式声明）。
    amountSkippedDates += 1;
    matchedDates.push(date);
  }

  return {
    bsFactCount: bsFacts.length,
    sinaFactCount: sinaFacts.length,
    comparedDates: allDates,
    matchedDates,
    missingInSina,
    missingInBs,
    amountSkippedDates,
    diffs,
    consistent: diffs.length === 0 && missingInSina.length === 0 && missingInBs.length === 0,
  };
}

// ===== 适配器 =====

export interface SinaAdapterOptions {
  pool: Pool;
  store: ArtifactStore;
  /** 注入抓取器（单测 fixture 字节注入）；缺省真实 fetch（带 Referer）。 */
  fetcher?: SinaFetcher | undefined;
  /** firstObservedAt 时钟（默认真实时间）。 */
  now?: (() => Date) | undefined;
  /** 并发闸（默认 new ConcurrencyGate(2)，DATA-SOURCES §7）。 */
  gate?: ConcurrencyGate | undefined;
  requestTimeoutMs?: number | undefined;
  /** 退避注入（单测秒级加速）。 */
  backoffSleeper?: BackoffSleeper | undefined;
  backoffAttempts?: number | undefined;
  backoffBaseDelayMs?: number | undefined;
}

export type SinaResource = 'quote' | 'daily_kline';

export interface SinaFetchResult {
  adapterVersion: string;
  source: 'sina';
  resource: SinaResource;
  params: string[];
  /** 恢复位置（断点）：sina:<resource>:<对象标识>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { symbol?: string | undefined; day?: string | undefined; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class SinaAdapter {
  readonly adapterVersion = SINA_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly fetcher: SinaFetcher;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;

  constructor(opts: SinaAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(2);
    this.fetcher = opts.fetcher ?? makeRealSinaFetcher(opts.requestTimeoutMs);
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
  }

  /**
   * 批量报价（一次请求）：codes 接受 513330 / sh.513330 / sh513330 任意形态，内部归一；
   * 原始 GBK 响应字节照存原件库；逐行映射 SINA_QUOTE 事实（无效行具名拒绝，不抛错）。
   */
  async fetchQuote(codes: string[]): Promise<SinaFetchResult> {
    if (codes.length === 0) throw new AdapterError('SINA_CODES_EMPTY', 'codes 为空');
    if (codes.length > SINA_QUOTE_BATCH_LIMIT) {
      throw new AdapterError('SINA_QUOTE_BATCH_TOO_LARGE', `codes=${String(codes.length)}`);
    }
    const bsCodes = codes.map(toNormalizedCode);
    const symbols = bsCodes.map(toSinaSymbol);
    // 同 symbol 归一重复：按 symbol 去重后单请求；symbol→归一代码映射供映射层回联。
    const symbolToBs = new Map<string, string>();
    symbols.forEach((sym, i) => symbolToBs.set(sym, bsCodes[i] as string));
    const scope = `sina:quote:${symbols.join(',')}`;
    // 抓取 + 结构校验都在退避内：反爬页/截断体等瞬态坏响应按 §7 退避重试（30s/60s/120s）；
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const bytes = await this.gate.run(() =>
      runWithBackoff(async () => {
        const raw = await this.fetcher(quoteUrl(symbols));
        parseQuoteResponse(raw);
        return raw;
      }, {
        adapter: 'sina',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const fetchedAt = this.now().toISOString();
    const artifact = await this.store.put(bytes, 'application/javascript; charset=gbk', fetchedAt);
    const lines = parseQuoteResponse(bytes);
    const mapped = mapQuoteLinesToFacts(lines, symbolToBs, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status: InsertFactStatus = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'sina', scope);
    return {
      adapterVersion: this.adapterVersion,
      source: 'sina',
      resource: 'quote',
      params: symbols,
      scope,
      artifact,
      rowCount: lines.length,
      insertedFactIds,
      identicalFactIds,
      rejectedRows: mapped.rejections,
      notices: [BACKFILL_REVISION_NOTICE],
    };
  }

  /**
   * 日 K（一次请求，datalen 根回看根数，≤2000）：原始 JSONP 字节照存原件库；
   * 逐行映射 DAILY_BAR_SINA 事实（availableAt=交易日 15:00+08）；无成交额列（缺口随 typedValue 呈现）。
   */
  async fetchDailyBars(code: string, datalen = 250): Promise<SinaFetchResult> {
    const bsCode = toNormalizedCode(code);
    if (!Number.isInteger(datalen) || datalen < 1 || datalen > SINA_KLINE_DATALEN_MAX) {
      throw new AdapterError('SINA_DATALEN_INVALID', `datalen=${String(datalen)}`);
    }
    const symbol = toSinaSymbol(bsCode);
    const scope = `sina:daily_kline:${bsCode}:${String(datalen)}`;
    // 抓取 + 结构校验都在退避内（同报价：坏响应瞬态重试）。
    const bytes = await this.gate.run(() =>
      runWithBackoff(async () => {
        const raw = await this.fetcher(klineUrl(symbol, datalen));
        parseKlineResponse(raw);
        return raw;
      }, {
        adapter: 'sina',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const fetchedAt = this.now().toISOString();
    const artifact = await this.store.put(bytes, 'application/javascript; charset=gbk', fetchedAt);
    const rows = parseKlineResponse(bytes);
    const mapped = mapKlineRowsToFacts(rows, bsCode, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      const status: InsertFactStatus = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'sina', scope);
    return {
      adapterVersion: this.adapterVersion,
      source: 'sina',
      resource: 'daily_kline',
      params: [symbol, String(datalen)],
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

function quoteUrl(symbols: string[]): string {
  return SINA_QUOTE_URL_BASE + symbols.join(',');
}

function klineUrl(symbol: string, datalen: number): string {
  return (
    `${SINA_KLINE_URL}?symbol=${symbol}&scale=${SINA_KLINE_SCALE}&ma=no&datalen=${String(datalen)}`
  );
}

/** 冒烟/测试辅助：本次运行的隔离 schema 名。 */
export function p1RunId(): string {
  return `p1_w9_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}
