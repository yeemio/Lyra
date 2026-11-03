/**
 * Lyra · 两融明细（沪深交易所官方）+ 龙虎榜（东财）适配器（P2 W28: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §6（适配器规则：取数→解析→原件入库→事实映射）、
 * §7（限流退避，复用 ./backoff.ts 只读依赖）、§5（修订口径声明 R4 随行）；
 * 时点语义 docs/specs/POINT-IN-TIME.md §2/§3；Gate-M 维度5 缺口（融资余额变化未入库 /
 * 龙虎榜数据未入库）。Owner 渠道指令（东财/新浪优先）下的可用性裁选见 bridge.py 文件头。
 *
 * 来源（W28 探测实测 2026-10-25，容器 akshare 1.19.3，证据 var/w28-probe.py 输出）：
 * - margin_sse：ak.stock_margin_detail_sse(date)——上交所官方单日全市场明细
 *   （2026-10-21 实测 2,000 行 9 列；单请求 pageSize=5000 无分页截断）；
 * - margin_szse：ak.stock_margin_detail_szse(date)——深交所官方单日全市场明细
 *   （2026-10-21 实测 2,116 行 8 列；响应无日期列，桥以请求参数回填 信用交易日期）；
 * - lhb_detail：ak.stock_lhb_detail_em(start,end)——东财 datacenter（非 R24.4 断连的
 *   push2 报价系），区间一次调用全市场上榜行（5 日窗实测 327 行 21 列）。
 *
 * 事实种类（派发冻结）：
 * - MARGIN_BALANCE：一行 = 主体 × 信用交易日的两融明细。availableAt=eventAt=validFrom=
 *   交易日 15:00 Asia/Shanghai（派发冻结口径；交易所实际盘后公布，公布时刻未实测，
 *   notices 注记）。typedValue 原样保留来源字段（深市附请求参数回填的 信用交易日期）。
 * - DRAGON_TIGER：一行 = 股票 × 上榜日 × 上榜原因。availableAt=上榜日 15:00+08
 *   （派发裁定：龙虎榜收盘后公布，取上榜日收盘时点并在此注明——公布时刻未实测）。
 *   来源行含 上榜后1/2/5/10日 前视列：原样保留（原件忠实）+ typedValue.forwardLookingColumns
 *   显式标记 + notices 注记，as-of 研究读回不得使用这些列。
 *
 * 两 kind 均为已终局窗口：factId 不含观察时刻，同键同值重放 → 同 factId → IDENTICAL
 * （DATA-SOURCES §6.5 去重，同 DAILY_BAR_SINA 形态）；不接 supersedes 链。
 *
 * subjectId 裸码（R24 裁定）：subjectType/subjectId 复用 ./baostock.ts 的
 * normalizeCode/classifySubject（与 BaoStock/新浪同形，保证跨源联读主体键一致）。
 * 主体过滤：fetch* 可选 subjectFilter（裸码集合）——非池主体行不计入事实（原件仍全量入库，
 * 过滤只作用于事实面，行计入 filteredOut 计数，缺口显式不静默）。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact, TimePointSubjectType } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { insertFact, loadFact } from '../pintime/facts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import type { BridgeExecutor } from './baostock.js';
import { ConcurrencyGate, resumePause, runWithBackoff, type BackoffSleeper } from './backoff.js';
import { classifySubject, normalizeCode, shanghaiClose } from './baostock.js';

const execFileAsync = promisify(execFile);

export const EMDC_ADAPTER_VERSION = 'em@p1';

/** 龙虎榜来源行的前视列（东财当前口径；as-of 读回禁用，typedValue 显式标记）。 */
export const LHB_FORWARD_LOOKING_COLUMNS = ['上榜后1日', '上榜后2日', '上榜后5日', '上榜后10日'] as const;

/** 两融口径注记（DATA-SOURCES §5 形态；availableAt 近似声明过的）。 */
export const MARGIN_REVISION_NOTICE =
  '两融口径注记：交易所两融明细盘后公布（公布时刻未实测），availableAt 按派发冻结取交易日 15:00+08；' +
  '深市响应无日期列，行内 信用交易日期 由请求参数回填（非来源数据）；回填历史属当前最新修订口径。';

/** 龙虎榜口径注记（availableAt 近似 + 前视列声明）。 */
export const LHB_REVISION_NOTICE =
  '龙虎榜口径注记：数据为东财 datacenter 当前口径回填；availableAt=上榜日 15:00+08（收盘后公布，' +
  '公布时刻未实测）；来源行含 上榜后1/2/5/10日 前视列（typedValue.forwardLookingColumns 标记），' +
  'as-of 研究读回不得使用这些列。';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE_RE = /^\d{8}$/;

/** YYYY-MM-DD ↔ YYYYMMDD（桥参数用紧凑形态）。 */
export function toCompactDate(iso: string): string {
  if (!DATE_RE.test(iso)) throw new AdapterError('EMDC_DATE_INVALID', `须 YYYY-MM-DD：${iso}`);
  return iso.replaceAll('-', '');
}

export function compactToIso(compact: string): string | null {
  if (!COMPACT_DATE_RE.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return DATE_RE.test(iso) && !Number.isNaN(new Date(`${iso}T00:00:00+08:00`).getTime()) ? iso : null;
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（来源字段保留原生类型：数值 number、日期字符串）。 */
export type EmdcRow = Record<string, unknown>;

export interface EmdcMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface EmdcMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmdcRowMapping {
  facts: EmdcMappedFact[];
  rejections: { rowIndex: number; code: string }[];
  /** subjectFilter 提供时不在池内的行数（原件全量入库，事实面按池过滤，计数显式）。 */
  filteredOut: number;
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'em-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

/** 行级读取：SSE 取 标的证券代码/信用交易日期，SZSE 取 证券代码/桥回填 信用交易日期。 */
function marginRowFields(row: EmdcRow, exchange: 'sse' | 'szse'): { code: string; compactDate: string } | null {
  const code = exchange === 'sse' ? row['标的证券代码'] : row['证券代码'];
  const compactDate = row['信用交易日期'];
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  if (typeof compactDate !== 'string' || !COMPACT_DATE_RE.test(compactDate)) return null;
  return { code, compactDate };
}

/**
 * 两融明细行 → MARGIN_BALANCE 事实（一行 = 主体 × 交易日）。
 * availableAt=eventAt=validFrom=交易日 15:00+08；typedValue 原样保留来源字段，
 * 附 exchange/tradeDateISO 归一字段；factId 不含观察时刻（终局窗口去重）。
 */
export function mapMarginRowsToFacts(
  rows: EmdcRow[],
  exchange: 'sse' | 'szse',
  ctx: EmdcMapContext,
  subjectFilter?: ReadonlySet<string>,
): EmdcRowMapping {
  const facts: EmdcMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  let filteredOut = 0;
  rows.forEach((row, rowIndex) => {
    const f = marginRowFields(row, exchange);
    if (f === null) {
      rejections.push({ rowIndex, code: 'EMDC_MARGIN_ROW_INVALID' });
      return;
    }
    const iso = compactToIso(f.compactDate);
    if (iso === null) {
      rejections.push({ rowIndex, code: 'EMDC_MARGIN_DATE_INVALID' });
      return;
    }
    if (subjectFilter !== undefined && !subjectFilter.has(f.code)) {
      filteredOut += 1;
      return;
    }
    const bsCode = normalizeCode(f.code);
    const { subjectType, subjectId } = classifySubject(bsCode);
    const t = shanghaiClose(iso);
    const typedValue = { exchange, tradeDateISO: iso, code: bsCode, ...row };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'MARGIN_BALANCE',
        subjectType,
        subjectId,
        objectKey: iso,
        raw: row,
      }),
      subjectType,
      subjectId,
      factKind: 'MARGIN_BALANCE',
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
    facts.push({ fact, objectKey: iso });
  });
  return { facts, rejections, filteredOut };
}

/**
 * 龙虎榜行 → DRAGON_TIGER 事实（一行 = 股票 × 上榜日 × 上榜原因）。
 * availableAt=上榜日 15:00+08（派发裁定，收盘后公布、公布时刻未实测，notices 注记）；
 * typedValue 原样保留来源字段 + tradeDateISO/code 归一 + forwardLookingColumns 标记。
 */
export function mapLhbRowsToFacts(
  rows: EmdcRow[],
  ctx: EmdcMapContext,
  subjectFilter?: ReadonlySet<string>,
): EmdcRowMapping {
  const facts: EmdcMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  let filteredOut = 0;
  rows.forEach((row, rowIndex) => {
    const code = row['代码'];
    const date = row['上榜日'];
    const reason = row['上榜原因'];
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      rejections.push({ rowIndex, code: 'EMDC_LHB_CODE_INVALID' });
      return;
    }
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      rejections.push({ rowIndex, code: 'EMDC_LHB_DATE_INVALID' });
      return;
    }
    if (subjectFilter !== undefined && !subjectFilter.has(code)) {
      filteredOut += 1;
      return;
    }
    const reasonText = typeof reason === 'string' ? reason : '';
    const bsCode = normalizeCode(code);
    const { subjectType, subjectId } = classifySubject(bsCode);
    const t = shanghaiClose(date);
    const typedValue = {
      tradeDateISO: date,
      code: bsCode,
      forwardLookingColumns: LHB_FORWARD_LOOKING_COLUMNS,
      ...row,
    };
    const objectKey = `${date}:${reasonText}`;
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'DRAGON_TIGER',
        subjectType,
        subjectId,
        objectKey,
        raw: row,
      }),
      subjectType,
      subjectId,
      factKind: 'DRAGON_TIGER',
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
    facts.push({ fact, objectKey });
  });
  return { facts, rejections, filteredOut };
}

// ===== 桥执行器（docker run 容器化 python）=====

export interface EmdcBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emdc/bridge.py。 */
export function makeEmdcBridgeExecutor(opts: EmdcBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emdc/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMDC_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMDC_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMDC_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMDC_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmdcAdapterOptions {
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
  /** 工程根（缺省取本文件相对根；容器 -v mount 用）。 */
  repoRootPath?: string | undefined;
}

export type EmdcResource = 'margin_sse' | 'margin_szse' | 'lhb_detail';

export interface EmdcFetchResult {
  adapterVersion: string;
  resource: EmdcResource;
  params: string[];
  /** 恢复位置（断点）：emdc:<resource>:<对象标识>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** subjectFilter 提供时被过滤的非池行数（原件仍全量入库）。 */
  filteredOut: number;
  /** DATA-SOURCES §5 修订口径声明原文（R4 + 面内注记，原样携带）。 */
  notices: string[];
}

export class EmdcAdapter {
  readonly adapterVersion = EMDC_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;

  constructor(opts: EmdcAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(1); // 单来源串行稳妥默认（同 sw 先例）
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.execBridge =
      opts.execBridge ??
      makeEmdcBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: opts.repoRootPath,
      });
  }

  /** 交易所两融明细（单日单所一次调用全市场；subjectFilter 可选按裸码过滤事实面）。 */
  async fetchMarginDetail(
    exchange: 'sse' | 'szse',
    date: string,
    subjectFilter?: ReadonlySet<string>,
  ): Promise<EmdcFetchResult> {
    const compact = toCompactDate(date);
    return this.fetchBridge('margin_' + exchange, [compact], {
      resource: ('margin_' + exchange) as EmdcResource,
      objectKey: compact,
      map: (rows, ctx) => mapMarginRowsToFacts(rows, exchange, ctx, subjectFilter),
      notices: [BACKFILL_REVISION_NOTICE, MARGIN_REVISION_NOTICE],
    });
  }

  /** 东财龙虎榜（区间一次调用全市场；subjectFilter 可选按裸码过滤事实面）。 */
  async fetchLhbDetail(
    start: string,
    end: string,
    subjectFilter?: ReadonlySet<string>,
  ): Promise<EmdcFetchResult> {
    const startC = toCompactDate(start);
    const endC = toCompactDate(end);
    if (startC > endC) {
      throw new AdapterError('EMDC_DATE_RANGE_INVALID', `start ${start} > end ${end}`);
    }
    return this.fetchBridge('lhb_detail', [startC, endC], {
      resource: 'lhb_detail',
      objectKey: `${startC}-${endC}`,
      map: (rows, ctx) => mapLhbRowsToFacts(rows, ctx, subjectFilter),
      notices: [BACKFILL_REVISION_NOTICE, LHB_REVISION_NOTICE],
    });
  }

  private async fetchBridge(
    command: string,
    params: string[],
    spec: {
      resource: EmdcResource;
      objectKey: string;
      map: (rows: EmdcRow[], ctx: EmdcMapContext) => EmdcRowMapping;
      notices: string[];
    },
  ): Promise<EmdcFetchResult> {
    const scope = `emdc:${spec.resource}:${spec.objectKey}`;
    // 桥调用 + 输出可解析都在退避内：东财/交易所侧瞬态失败按 §7 退避（30s/60s/120s），
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'emdc',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = response.rows ?? [];
    const fetchedAt = this.now().toISOString();
    // 原件 = 桥 stdout 的 rows 规范化 JSON（全市场原样，不受 subjectFilter 影响）。
    const bytes = new TextEncoder().encode(canonicalJsonString(rows));
    const artifact = await this.store.put(bytes, 'application/json', fetchedAt);
    const mapped = spec.map(rows, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        // 终局窗口同 factId 先写为准（同 sina DAILY_BAR_SINA 先例）：factId 不含观察时刻，
        // 跨次抓取 firstObservedAt/artifact 不同但身份同 → 计 identical 不再插入（§6.5 去重）；
        // 源内同键改值不产生第二事实，修订值仍保留在新原件中可见。
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'emdc', scope);
    return {
      adapterVersion: this.adapterVersion,
      resource: spec.resource,
      params,
      scope,
      artifact,
      rowCount: rows.length,
      insertedFactIds,
      identicalFactIds,
      rejectedRows: mapped.rejections,
      filteredOut: mapped.filteredOut,
      notices: spec.notices,
    };
  }
}
