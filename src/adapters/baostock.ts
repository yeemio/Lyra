/**
 * Lyra · BaoStock 适配器（P1 W4: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §2.2/§2.4/§2.5/§2.6/§6（适配器规则与去重）、§7（限流退避）；
 * 时点语义 docs/specs/POINT-IN-TIME.md §2/§3（availableAt 取法只按该合同落点，不重定义）；
 * 退避/并发闸/暂停上报在 ./backoff.ts；桥 adapters/baostock/bridge.py（venv .venv-p1）。
 *
 * 职责（DATA-SOURCES §6.2：取数 → 解析为带时间字段的事实 → 写原件库，不决定业务语义）：
 * - execFile 调 venv Python 跑 bridge（login→查询→logout 一次一调用）；
 * - 每次成功响应的原始 rows JSON（canonical 序列化）作为原件入 ArtifactStore
 *   （application/json，firstObservedAt=抓取时刻；同 bytes 幂等、保留首次观察时间）；
 * - rows 映射为 TimePointFact 批量 insertFact（复用 src/pintime/facts.ts，只读依赖）；
 *   同 rows 同适配器版本重放 → 同 factId → ALREADY_INSERTED_IDENTICAL（DATA-SOURCES §6.5 去重）。
 *
 * availableAt 规则（P1 冻结）：
 * - K线行/复权因子/成分归属/股票池快照/交易日历 = 该交易日 15:00 Asia/Shanghai（收盘事实）；
 * - 财务行 = pubDate 次日 00:00 Asia/Shanghai（pubDate 日精度 → 保守 D+1，POINT-IN-TIME §3.2；
 *   statDate 只进 validFrom，不定可得性）；无 pubDate 的行拒绝入库（具名错误，不落库）。
 *
 * supersedes 接线（POINT-IN-TIME §4 修正不覆盖）：
 * - FINANCIAL（可变窗口，DATA-SOURCES §6.5）与 ADJUST_FACTOR（P1-DATA Done-when 3 链例方向）
 *   按同对象键（财务 statDate+bsQuery；复权因子 dividOperateDate）接 supersedes 链；
 * - 其余种类（日线/成分/股票池/日历，已终局窗口）不接链：来源改值时并行并存，
 *   按来源冲突处置（DATA-SOURCES §6.5 / POINT-IN-TIME §4），不自动覆盖、不静默合并。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef } from '../contracts.js';
import type { TimePointFact, TimePointSubjectType } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { insertFact, loadFact, type InsertFactStatus } from '../pintime/facts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type AdapterResource,
  type BridgeResponse,
  type BridgeRow,
} from './adapter-types.js';
import {
  ConcurrencyGate,
  resumePause,
  runWithBackoff,
  type BackoffSleeper,
} from './backoff.js';

const execFileAsync = promisify(execFile);

export const BAOSTOCK_ADAPTER_VERSION = 'baostock@0.9.40-p1';

/**
 * 行业分类版本轴（W6 实测修正）：派发预设 query_stock_industry 返回申万 2021 分类，
 * 2026-10-25 真实探测（5560/5560 行）证明其实际返回**证监会行业分类**
 * （industryClassification='证监会行业分类'，industry 为 GB/T 门类+大类如 'C15酒、饮料和精制茶制造业'），
 * baostock 0.9.40 包内不存在任何申万接口。版本轴如实登记为 csrc@current
 * （来源未自述版本号与生效日，不得编造年份）；申万轴缺口登记见 src/adapters/swclass.ts。
 */
export const INDUSTRY_CLASS_VERSION_TAG = 'csrc@current';

export type BaostockCommand =
  | 'kline'
  | 'adjust_factor'
  | 'financial'
  | 'trade_dates'
  | 'stock_pool'
  | 'hs300'
  | 'zz500'
  | 'stock_basic'
  | 'sw_industry';

// 新增子命令的资源段超出 adapter-types.ts 的 AdapterResource 联合（该文件 W6 只读），
// 此处对内部映射表放宽值类型；既有命令的取值与语义不变。
const COMMAND_RESOURCE: Record<BaostockCommand, AdapterResource | 'stock_basic' | 'industry_class'> = {
  kline: 'daily_kline',
  adjust_factor: 'adjust_factor',
  financial: 'quarter_financial',
  trade_dates: 'trade_calendar',
  stock_pool: 'stock_pool',
  hs300: 'index_constituents',
  zz500: 'index_constituents',
  stock_basic: 'stock_basic',
  sw_industry: 'industry_class',
};

// ===== Asia/Shanghai 时间（固定 +08，无夏令时）=====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateArg(value: string, field: string): void {
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00+08:00`).getTime())) {
    throw new AdapterError('BAOSTOCK_DATE_INVALID', `${field}=${value}（须 YYYY-MM-DD）`);
  }
}

/** 该交易日 15:00 Asia/Shanghai（收盘事实）。 */
export function shanghaiClose(date: string): string {
  return new Date(`${date}T15:00:00+08:00`).toISOString();
}

function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** pubDate 次日 00:00 Asia/Shanghai（日精度保守 D+1，P1 冻结规则）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

// ===== 代码归一与主体归类 =====

/** 裸 6 位代码补交易所前缀（6/9/5→sh，其余含 399→sz）；指数代码请显式传 sh.000xxx/sz.399xxx。 */
export function normalizeCode(code: string): string {
  if (/^s[hz]\.\d{6}$/.test(code)) return code;
  if (/^\d{6}$/.test(code)) {
    const exchange = /^[013]/.test(code) ? 'sz' : 'sh';
    return `${exchange}.${code}`;
  }
  throw new AdapterError('BAOSTOCK_CODE_INVALID', code);
}

/** 按带前缀代码归类主体：sz.399xxx / sh.000xxx → INDEX；5 开头 → ETF；其余 → STOCK。 */
export function classifySubject(bsCode: string): { subjectType: TimePointSubjectType; subjectId: string } {
  const m = /^s([hz])\.(\d{6})$/.exec(bsCode);
  const num = m?.[2];
  if (num === undefined) throw new AdapterError('BAOSTOCK_CODE_INVALID', bsCode);
  if (num.startsWith('399')) return { subjectType: 'INDEX', subjectId: num };
  if (m?.[1] === 'h' && num.startsWith('000')) return { subjectType: 'INDEX', subjectId: num };
  if (num.startsWith('5')) return { subjectType: 'ETF', subjectId: num };
  return { subjectType: 'STOCK', subjectId: num };
}

// ===== 行映射（纯函数，单测用 fixture 字符串注入）=====

/** 映射产物：fact（supersedes 未接线，入库前接线）+ 对象键（DATA-SOURCES §6.5 对象标识素材）。 */
export interface MappedFact {
  fact: TimePointFact;
  objectKey: string;
  /** 是否参与 supersedes 接线（financial / adjust_factor）。 */
  supersedesWiring: boolean;
}

export interface RowMapping {
  facts: MappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

export interface MapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

type RowOutcome = { ok: true; mapped: MappedFact } | { ok: false; code: string };

function rowDate(row: BridgeRow, field: string): string | null {
  const v = row[field];
  return typeof v === 'string' && DATE_RE.test(v) ? v : null;
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  row: BridgeRow;
}): string {
  return 'bs-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    row: args.row,
  });
}

function mkMapped(args: {
  factKind: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  row: BridgeRow;
  availableAt: string;
  eventAt: string;
  validFrom: string | null;
  sourcePublishedAt: string | null;
  wiring: boolean;
  ctx: MapContext;
}): MappedFact {
  const fact: TimePointFact = {
    factId: factIdOf({
      adapterVersion: args.ctx.adapterVersion,
      factKind: args.factKind,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      objectKey: args.objectKey,
      row: args.row,
    }),
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    factKind: args.factKind,
    typedValue: args.row, // 原始字段原样（含桥自加的 bsQuery/bsIndex/bsDay 上下文字段）
    validFrom: args.validFrom,
    validTo: null,
    eventAt: args.eventAt,
    sourcePublishedAt: args.sourcePublishedAt,
    firstObservedAt: args.ctx.fetchedAt,
    availableAt: args.availableAt,
    supersedesFactId: null,
    artifactSha256: args.ctx.artifactSha256,
    adapterVersion: args.ctx.adapterVersion,
  };
  return { fact, objectKey: args.objectKey, supersedesWiring: args.wiring };
}

function mapRow(command: BaostockCommand, params: string[], row: BridgeRow, ctx: MapContext): RowOutcome {
  switch (command) {
    case 'kline': {
      const date = rowDate(row, 'date');
      if (date === null) return { ok: false, code: 'DAILY_BAR_DATE_MISSING' };
      try {
        const { subjectType, subjectId } = classifySubject(row.code ?? params[0] ?? '');
        const t = shanghaiClose(date);
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'DAILY_BAR', subjectType, subjectId, objectKey: date, row,
            availableAt: t, eventAt: t, validFrom: t, sourcePublishedAt: null, wiring: false, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'adjust_factor': {
      const opDate = rowDate(row, 'dividOperateDate') ?? rowDate(row, 'divideOperateDate');
      if (opDate === null) return { ok: false, code: 'ADJUST_FACTOR_DATE_MISSING' };
      try {
        const { subjectType, subjectId } = classifySubject(row.code ?? params[0] ?? '');
        const t = shanghaiClose(opDate);
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'ADJUST_FACTOR', subjectType, subjectId, objectKey: opDate, row,
            availableAt: t, eventAt: t, validFrom: t, sourcePublishedAt: null, wiring: true, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'financial': {
      const pubDate = rowDate(row, 'pubDate');
      const statDate = rowDate(row, 'statDate');
      if (pubDate === null) return { ok: false, code: 'FINANCIAL_PUBDATE_MISSING' }; // 冻结：具名拒绝
      if (statDate === null) return { ok: false, code: 'FINANCIAL_STATDATE_MISSING' };
      try {
        const { subjectType, subjectId } = classifySubject(row.code ?? params[0] ?? '');
        const bsQuery = row.bsQuery ?? 'unknown';
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'FINANCIAL', subjectType, subjectId, objectKey: `${statDate}:${bsQuery}`, row,
            // pubDate 日精度 → 次日 00:00 可得；statDate 只进 validFrom（POINT-IN-TIME §3.2）
            availableAt: shanghaiNextDayStart(pubDate),
            eventAt: shanghaiDayStart(statDate),
            validFrom: shanghaiDayStart(statDate),
            sourcePublishedAt: shanghaiDayStart(pubDate),
            wiring: true, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'trade_dates': {
      const date = rowDate(row, 'calendar_date');
      if (date === null) return { ok: false, code: 'TRADE_CALENDAR_DATE_MISSING' };
      const t = shanghaiClose(date);
      return {
        ok: true,
        mapped: mkMapped({
          factKind: 'TRADE_CALENDAR', subjectType: 'RULE', subjectId: 'ashare-calendar', objectKey: date, row,
          availableAt: t, eventAt: t, validFrom: t, sourcePublishedAt: null, wiring: false, ctx,
        }),
      };
    }
    case 'stock_pool': {
      const day = params[0] ?? '';
      if (!DATE_RE.test(day)) return { ok: false, code: 'STOCK_POOL_DAY_MISSING' };
      try {
        const { subjectType, subjectId } = classifySubject(row.code ?? '');
        if (subjectType !== 'STOCK') return { ok: false, code: 'STOCK_POOL_CODE_INVALID' };
        const t = shanghaiClose(day);
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'STOCK_POOL', subjectType, subjectId, objectKey: day, row,
            availableAt: t, eventAt: t, validFrom: t, sourcePublishedAt: null, wiring: false, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'hs300':
    case 'zz500': {
      const updateDate = rowDate(row, 'updateDate');
      if (updateDate === null) return { ok: false, code: 'INDEX_MEMBERSHIP_DATE_MISSING' };
      // 所属指数以命令为准（桥按命令在行内自加 bsIndex；此处不依赖行内容）
      const bsIndex = command;
      try {
        const { subjectType, subjectId } = classifySubject(row.code ?? '');
        if (subjectType !== 'STOCK') return { ok: false, code: 'INDEX_MEMBERSHIP_CODE_INVALID' };
        const t = shanghaiClose(updateDate);
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'INDEX_MEMBERSHIP', subjectType, subjectId, objectKey: `${bsIndex}:${updateDate}`, row,
            availableAt: t, eventAt: t, validFrom: t, sourcePublishedAt: null, wiring: false, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'stock_basic': {
      // query_stock_basic 字段（2026-10-25 实测）：code/code_name/ipoDate/outDate/type/status——
      // 无 isST。当前快照事实：availableAt=抓取时刻（我们此刻才知道该表，P1 冻结规则）；
      // 快照各字段（现名/状态的）官方生效日未知 → validFrom=null，不编造；ipoDate 原文保留在
      // typedValue。历史 ST 状态不得由任何当前快照回填——每股时点 isST 以 DAILY_BAR 行内
      // isST 字段（按交易日）为准，ST 时点表另立（ASHARE-RULES）。
      if (typeof row.code !== 'string' || row.code.length === 0) {
        return { ok: false, code: 'STOCK_BASIC_CODE_MISSING' };
      }
      try {
        const { subjectType, subjectId } = classifySubject(row.code);
        if (subjectType !== 'STOCK') return { ok: false, code: 'STOCK_BASIC_CODE_INVALID' };
        const t = ctx.fetchedAt;
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'STOCK_BASIC', subjectType, subjectId, objectKey: 'current', row,
            availableAt: t, eventAt: t, validFrom: null, sourcePublishedAt: null, wiring: false, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
    case 'sw_industry': {
      // query_stock_industry 当前快照（2026-10-25 实测返回证监会行业分类，见 INDUSTRY_CLASS_VERSION_TAG）。
      // availableAt=抓取时刻（当前快照表，P1 冻结规则：我们此刻才知道该表）；来源未自述生效日
      // → validFrom=null，不编造。行内 updateDate 原文保留（来源自述的数据时点）。
      // classVersion 为适配器自加上下文字段（不改写 BaoStock 字段，同桥 bsQuery/bsIndex 先例）。
      if (typeof row.code !== 'string' || row.code.length === 0) {
        return { ok: false, code: 'INDUSTRY_CLASS_CODE_MISSING' };
      }
      if (typeof row.industry !== 'string' || row.industry.length === 0) {
        return { ok: false, code: 'INDUSTRY_CLASS_VALUE_MISSING' };
      }
      try {
        const { subjectType, subjectId } = classifySubject(row.code);
        if (subjectType !== 'STOCK') return { ok: false, code: 'INDUSTRY_CLASS_CODE_INVALID' };
        const t = ctx.fetchedAt;
        const value: BridgeRow = { ...row, classVersion: INDUSTRY_CLASS_VERSION_TAG };
        return {
          ok: true,
          mapped: mkMapped({
            factKind: 'INDUSTRY_CLASS_VERSION', subjectType, subjectId,
            objectKey: INDUSTRY_CLASS_VERSION_TAG, row: value,
            availableAt: t, eventAt: t, validFrom: null, sourcePublishedAt: null, wiring: false, ctx,
          }),
        };
      } catch (error) {
        return { ok: false, code: error instanceof AdapterError ? error.code : 'BAOSTOCK_ROW_INVALID' };
      }
    }
  }
}

/**
 * 纯映射：桥 rows → 时点事实。拒绝的行不产生事实，以具名 code 上报（调用方如实透出）。
 */
export function mapRowsToFacts(
  command: BaostockCommand,
  params: string[],
  rows: BridgeRow[],
  ctx: MapContext,
): RowMapping {
  const facts: MappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const outcome = mapRow(command, params, row, ctx);
    if (outcome.ok) facts.push(outcome.mapped);
    else rejections.push({ rowIndex, code: outcome.code });
  });
  return { facts, rejections };
}

// ===== 真实桥执行器 =====

/** 桥执行器：给子命令参数，返回解析后的桥响应。单测注入 fixture，生产 execFile。 */
export type BridgeExecutor = (args: string[]) => Promise<BridgeResponse>;

const PERMANENT_BRIDGE_CODES = new Set(['USAGE_ERROR']);

export function makeRealBridgeExecutor(
  pythonPath: string,
  bridgePath: string,
  timeoutMs: number,
): BridgeExecutor {
  return async (args) => {
    let stdout = '';
    let killed = false;
    let failed = false;
    try {
      const res = await execFileAsync(pythonPath, [bridgePath, ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      });
      stdout = res.stdout;
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
      if (e.code === 'ENOENT') throw new AdapterError('BAOSTOCK_PYTHON_MISSING', pythonPath);
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
      if (killed) throw new TransientAdapterError('BAOSTOCK_BRIDGE_TIMEOUT', `超过 ${timeoutMs}ms`);
      throw new TransientAdapterError(
        'BAOSTOCK_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'BAOSTOCK_QUERY_FAILED';
      if (PERMANENT_BRIDGE_CODES.has(code)) throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface BaoStockAdapterOptions {
  pool: Pool;
  store: ArtifactStore;
  /** 注入桥执行器（单测 fixture 注入）；缺省真实 execFile venv python。 */
  execBridge?: BridgeExecutor | undefined;
  /** firstObservedAt 时钟（默认真实时间）。 */
  now?: (() => Date) | undefined;
  /** 并发闸（默认 new ConcurrencyGate(2)：在途 ≤2，DATA-SOURCES §7）。 */
  gate?: ConcurrencyGate | undefined;
  requestTimeoutMs?: number | undefined;
  pythonPath?: string | undefined;
  bridgePath?: string | undefined;
  /** 退避注入（单测秒级加速：立即放行的 sleeper + 缩短的 attempts/baseDelayMs）。 */
  backoffSleeper?: BackoffSleeper | undefined;
  backoffAttempts?: number | undefined;
  backoffBaseDelayMs?: number | undefined;
}

export interface FetchResult {
  adapterVersion: string;
  command: BaostockCommand;
  params: string[];
  /** 恢复位置（断点）：adapter:resource:对象标识。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（financial 输出原样携带）。 */
  notices: string[];
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export class BaoStockAdapter {
  readonly adapterVersion = BAOSTOCK_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;

  constructor(opts: BaoStockAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(2);
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.execBridge =
      opts.execBridge ??
      makeRealBridgeExecutor(
        opts.pythonPath ?? join(repoRoot, '.venv-p1/bin/python'),
        opts.bridgePath ?? join(repoRoot, 'adapters/baostock/bridge.py'),
        opts.requestTimeoutMs ?? 120_000,
      );
  }

  /** 日线（不复权原始价，adjustflag='3'；DATA-SOURCES §2.4 原始价与因子分开存）。 */
  async fetchDailyBars(code: string, startDate: string, endDate: string): Promise<FetchResult> {
    assertDateArg(startDate, 'startDate');
    assertDateArg(endDate, 'endDate');
    return this.fetch('kline', [normalizeCode(code), startDate, endDate]);
  }

  async fetchAdjustFactor(code: string, startDate: string, endDate: string): Promise<FetchResult> {
    assertDateArg(startDate, 'startDate');
    assertDateArg(endDate, 'endDate');
    return this.fetch('adjust_factor', [normalizeCode(code), startDate, endDate]);
  }

  /** 季频财务（query_profit_data + query_growth_data；修订口径声明随输出原样携带）。 */
  async fetchQuarterFinancials(code: string, year?: number, quarter?: number): Promise<FetchResult> {
    if ((year === undefined) !== (quarter === undefined)) {
      throw new AdapterError('BAOSTOCK_ARGS_INVALID', 'year/quarter 须同给或同缺');
    }
    const bsCode = normalizeCode(code);
    let params = [bsCode];
    if (year !== undefined && quarter !== undefined) {
      if (!Number.isInteger(year) || year < 1990 || year > 2100 || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        throw new AdapterError('BAOSTOCK_ARGS_INVALID', `year=${String(year)} quarter=${String(quarter)}`);
      }
      params = [bsCode, String(year), String(quarter)];
    }
    return this.fetch('financial', params);
  }

  async fetchTradeDates(startDate: string, endDate: string): Promise<FetchResult> {
    assertDateArg(startDate, 'startDate');
    assertDateArg(endDate, 'endDate');
    return this.fetch('trade_dates', [startDate, endDate]);
  }

  async fetchStockPool(day: string): Promise<FetchResult> {
    assertDateArg(day, 'day');
    return this.fetch('stock_pool', [day]);
  }

  /** 指数按日成分（hs300 / zz500；中证 800 = 两者并集，DATA-SOURCES §2.6）。 */
  async fetchIndexMembership(index: 'hs300' | 'zz500', date: string): Promise<FetchResult> {
    assertDateArg(date, 'date');
    return this.fetch(index, [date]);
  }

  /**
   * 单只股票基本资料当前快照（query_stock_basic：code/code_name/ipoDate/outDate/type/status）。
   * STOCK_BASIC 事实 availableAt=抓取时刻；不含 isST，历史 ST 不得由此回填（见 mapRow 注）。
   */
  async fetchStockBasic(code: string): Promise<FetchResult> {
    return this.fetch('stock_basic', [normalizeCode(code)]);
  }

  /**
   * 全量股票行业分类当前快照（query_stock_industry，桥子命令沿用派发命名 sw_industry）。
   * 2026-10-25 实测：返回**证监会行业分类**（非申万），版本轴见 INDUSTRY_CLASS_VERSION_TAG；
   * 申万轴缺口登记见 src/adapters/swclass.ts。
   */
  async fetchSwIndustry(): Promise<FetchResult> {
    return this.fetch('sw_industry', []);
  }

  private async fetch(command: BaostockCommand, params: string[]): Promise<FetchResult> {
    const scope = `baostock:${COMMAND_RESOURCE[command]}:${params.join(':')}`;
    // 并发闸（在途 ≤2）+ 退避（30s/60s/120s，3 次失败暂停上报落库）串在真实调用外层。
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'baostock',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = response.rows ?? [];
    const fetchedAt = this.now().toISOString();
    // 原始 rows JSON（canonical 序列化）作为原件：同 rows 同哈希，重放天然幂等。
    const artifact = await this.store.put(
      new TextEncoder().encode(canonicalJsonString(rows)),
      'application/json',
      fetchedAt,
    );
    const mapped = mapRowsToFacts(command, params, rows, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      // 去重命中（DATA-SOURCES §6.5）：factId 按行内容派生，同 factId 即同对象同值；
      // 首见事实与其原件引用（当时批次）保留，不因后续批次重delivery 改写（POINT-IN-TIME §2.1 只读）。
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      const fact = await this.wireSupersedes(m);
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status: InsertFactStatus = await insertFact(this.pool, fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(fact.factId);
    }
    // 恢复后从断点继续：同 scope 此前暂停过则标记 RESUMED（无既有行则无操作）。
    await resumePause(this.pool, 'baostock', scope);
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
      notices: command === 'financial' ? [BACKFILL_REVISION_NOTICE] : [],
    };
  }

  /** 接线 supersedes：查同对象键的当前链头（排除自身；排除仅被自身 supersede 的遮蔽）。 */
  private async wireSupersedes(m: MappedFact): Promise<TimePointFact> {
    if (!m.supersedesWiring) return m.fact;
    const target = await this.findSupersedesTarget(m.fact);
    if (target === null || target === m.fact.factId) return m.fact;
    return { ...m.fact, supersedesFactId: target };
  }

  private async findSupersedesTarget(fact: TimePointFact): Promise<string | null> {
    let conditions: Array<[string, string]>;
    const tv = fact.typedValue as BridgeRow;
    if (fact.factKind === 'FINANCIAL') {
      conditions = [
        ['typed_value->>\'statDate\'', tv.statDate ?? ''],
        ['typed_value->>\'bsQuery\'', tv.bsQuery ?? ''],
      ];
    } else if (fact.factKind === 'ADJUST_FACTOR') {
      conditions = [
        ['coalesce(typed_value->>\'dividOperateDate\', typed_value->>\'divideOperateDate\')', tv.dividOperateDate ?? tv.divideOperateDate ?? ''],
      ];
    } else {
      return null;
    }
    const where = conditions.map(([expr], i) => `${expr} = $${i + 4}`).join(' and ');
    const selfParam = conditions.length + 4;
    const res = await this.pool.query<{ fact_id: string }>(
      `select f.fact_id from pintime_fact f
       where f.subject_type = $1 and f.subject_id = $2 and f.fact_kind = $3
         and ${where}
         and f.fact_id <> $${selfParam}
         and not exists (
           select 1 from pintime_fact s
           where s.supersedes_fact_id = f.fact_id and s.fact_id <> $${selfParam}
         )
       order by f.available_at desc, f.fact_id desc limit 1`,
      [fact.subjectType, fact.subjectId, fact.factKind, ...conditions.map(([, v]) => v), fact.factId],
    );
    return res.rows[0]?.fact_id ?? null;
  }
}

/** 冒烟/测试辅助：本次运行的隔离 schema 名。 */
export function p1RunId(): string {
  return `p1_w4_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}
