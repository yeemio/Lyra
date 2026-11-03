/**
 * Lyra · 大宗交易明细（东财 datacenter）适配器（P2 W37: code-writer，B1）。
 * 合同：docs/specs/DATA-SOURCES.md §6（适配器规则：取数→解析→原件入库→事实映射）、
 * §7（限流退避，复用 ./backoff.ts 只读依赖）、§5（修订口径声明 R4 随行）；
 * 时点语义 docs/specs/POINT-IN-TIME.md §2/§3。Owner 渠道指令（东财优先）下的可用性
 * 裁选见 adapters/emblock/bridge.py 文件头。
 *
 * 来源（W37 探测实测 2026-10-25，容器 akshare 1.19.3，证据 var/w37-probe.py 输出）：
 * - mrmx：ak.stock_dzjy_mrmx(symbol="A股", start_date, end_date)——东财 datacenter-web
 *   大宗交易每日明细（近 5 日窗实测 446 行 13 列；31 天历史窗实测 1,720 行 16 个交易日，
 *   单 HTTP 请求 pageSize=5000 无分页循环——TS 侧 rows>=5000 具名错误防静默截断）。
 *   列：交易日期/证券代码/证券简称/涨跌幅/收盘价/成交价/折溢率/成交量/成交额/
 *   成交额/流通市值/买方营业部/卖方营业部（无成交时刻列，实测）。
 *
 * 形态选型（B1 派发要求注明理由）：按区间全市场明细 + 事实面按池过滤（同 W28 龙虎榜）。
 * dzjy 族其余接口均为聚合统计面（sctj/hygtj 固定区间段个股聚合、mrtj 市场级每日汇总），
 * 非个股级明细且区间不可自选；mrmx 是唯一逐笔明细接口且支持任意区间——比逐股逐日
 * 少两个数量级调用（31 天窗 1 次调用覆盖全市场）。
 *
 * 事实种类（派发冻结）：
 * - BLOCK_TRADE：一行 = 一笔大宗成交（股票 × 交易日 × 成交价 × 买卖双方营业部）。
 *   availableAt=validFrom=交易日次日 00:00+08（B1 派发冻结保守口径：大宗盘后披露、
 *   来源无成交时刻列、公布时刻未实测）；eventAt=交易日 15:00+08（成交发生时点标记）。
 *   typedValue 原样保留来源字段（含 折溢率——B1 核心字段）+ tradeDateISO/code 归一。
 *   akshare 生成的 序号 列为调用内 reset_index 重排序号（随窗口选择漂移），桥侧剔除——
 *   同业务键重放 raw 稳定 → 同 factId → IDENTICAL（DATA-SOURCES §6.5 去重，同 emdc
 *   终局窗口形态）；不接 supersedes 链。同日完全重复业务键行（价/量/额/双方营业部全同）
 *   去重为一条事实，原件保留全量行（notices 注记）。
 *
 * subjectId 裸码（R24 裁定）：subjectType/subjectId 复用 ./baostock.ts 的
 * normalizeCode/classifySubject（与 BaoStock/新浪/emdc 同形，跨源联读主体键一致）。
 * 主体过滤：可选 subjectFilter（裸码集合）——非池主体行不计入事实（原件仍全量入库，
 * 过滤只作用于事实面，行计入 filteredOut 计数，缺口显式不静默）。范围 = 冻结池 26 股
 * （B1 派发冻结；ETF 大宗不在本面）。
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
import { classifySubject, normalizeCode, shanghaiClose, shanghaiNextDayStart } from './baostock.js';

const execFileAsync = promisify(execFile);

export const EMBLOCK_ADAPTER_VERSION = 'emblock@p1';

/**
 * 东财 datacenter 单页行数上限（akshare mrmx 无分页循环，pageSize=5000 pageNumber=1）。
 * 桥返回行数达到该值即疑似静默截断 → 具名错误（非瞬态：须缩小窗口重排，不重试）。
 */
export const EMBLOCK_SINGLE_PAGE_CEILING = 5000;

/** 大宗交易口径注记（DATA-SOURCES §5 形态；availableAt 近似声明过的）。 */
export const EMBLOCK_REVISION_NOTICE =
  '大宗交易口径注记：数据为东财 datacenter 当前口径回填；availableAt=交易日次日 00:00+08' +
  '（大宗盘后披露，来源无成交时刻列，公布时刻未实测，派发冻结保守口径）；akshare 生成的 序号 ' +
  '列为调用内重排序号（随窗口漂移，非来源数据），桥侧剔除；同日完全重复业务键行' +
  '（价/量/额/买卖营业部全同）去重为一条事实，原件保留全量行。';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE_RE = /^\d{8}$/;

/** YYYY-MM-DD ↔ YYYYMMDD（桥参数用紧凑形态）。 */
export function toCompactDate(iso: string): string {
  if (!DATE_RE.test(iso)) throw new AdapterError('EMBLOCK_DATE_INVALID', `须 YYYY-MM-DD：${iso}`);
  return iso.replaceAll('-', '');
}

export function compactToIso(compact: string): string | null {
  if (!COMPACT_DATE_RE.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return DATE_RE.test(iso) && !Number.isNaN(new Date(`${iso}T00:00:00+08:00`).getTime()) ? iso : null;
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（来源字段保留原生类型：数值 number、日期字符串）。 */
export type EmblockRow = Record<string, unknown>;

export interface EmblockMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface EmblockMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmblockRowMapping {
  facts: EmblockMappedFact[];
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
  return 'emb-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

/**
 * 业务键素材（对象标识）：交易日 × 价 × 量 × 额 × 买卖营业部。
 * 同日多笔成交靠营业部组合与价/量区分；完全重复业务键行合并为一条事实（notices 注记）。
 */
function objectKeyOf(iso: string, row: EmblockRow): string {
  const keyParts = [row['成交价'], row['成交量'], row['成交额'], row['买方营业部'], row['卖方营业部']];
  return `${iso}:${JSON.stringify(keyParts)}`;
}

/**
 * 大宗交易明细行 → BLOCK_TRADE 事实（一行 = 一笔成交）。
 * availableAt=validFrom=交易日次日 00:00+08（派发冻结保守）；eventAt=交易日 15:00+08；
 * typedValue 原样保留来源字段（折溢率等）+ tradeDateISO/code 归一；
 * factId 不含观察时刻（终局窗口去重）。
 */
export function mapBlockTradeRowsToFacts(
  rows: EmblockRow[],
  ctx: EmblockMapContext,
  subjectFilter?: ReadonlySet<string>,
): EmblockRowMapping {
  const facts: EmblockMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  let filteredOut = 0;
  rows.forEach((row, rowIndex) => {
    const code = row['证券代码'];
    const date = row['交易日期'];
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      rejections.push({ rowIndex, code: 'EMBLOCK_ROW_CODE_INVALID' });
      return;
    }
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      rejections.push({ rowIndex, code: 'EMBLOCK_ROW_DATE_INVALID' });
      return;
    }
    if (subjectFilter !== undefined && !subjectFilter.has(code)) {
      filteredOut += 1;
      return;
    }
    const bsCode = normalizeCode(code);
    const { subjectType, subjectId } = classifySubject(bsCode);
    const eventT = shanghaiClose(date); // 交易日 15:00+08（成交发生时点标记）
    const availT = shanghaiNextDayStart(date); // 交易日次日 00:00+08（派发冻结保守可得）
    const objectKey = objectKeyOf(date, row);
    const typedValue = { tradeDateISO: date, code: bsCode, ...row };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'BLOCK_TRADE',
        subjectType,
        subjectId,
        objectKey,
        raw: row,
      }),
      subjectType,
      subjectId,
      factKind: 'BLOCK_TRADE',
      typedValue,
      validFrom: availT,
      validTo: null,
      eventAt: eventT,
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: availT,
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey });
  });
  return { facts, rejections, filteredOut };
}

// ===== 桥执行器（docker run 容器化 python）=====

export interface EmblockBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emblock/bridge.py。 */
export function makeEmblockBridgeExecutor(opts: EmblockBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emblock/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMBLOCK_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMBLOCK_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMBLOCK_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMBLOCK_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmblockAdapterOptions {
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

export type EmblockResource = 'mrmx';

export interface EmblockFetchResult {
  adapterVersion: string;
  resource: EmblockResource;
  params: string[];
  /** 恢复位置（断点）：emblock:<resource>:<对象标识>。 */
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

export class EmblockAdapter {
  readonly adapterVersion = EMBLOCK_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;

  constructor(opts: EmblockAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(1); // 单来源串行稳妥默认（同 emdc 先例）
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.execBridge =
      opts.execBridge ??
      makeEmblockBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: opts.repoRootPath,
      });
  }

  /**
   * 东财大宗交易每日明细（区间一次调用全市场；subjectFilter 可选按裸码过滤事实面）。
   * rows 达单页上限即疑似静默截断 → 具名永久错误（缩小窗口重排，不重试）。
   */
  async fetchBlockTradeDetail(
    start: string,
    end: string,
    subjectFilter?: ReadonlySet<string>,
  ): Promise<EmblockFetchResult> {
    const startC = toCompactDate(start);
    const endC = toCompactDate(end);
    if (startC > endC) {
      throw new AdapterError('EMBLOCK_DATE_RANGE_INVALID', `start ${start} > end ${end}`);
    }
    return this.fetchBridge('mrmx', [startC, endC], {
      resource: 'mrmx',
      objectKey: `${startC}-${endC}`,
      map: (rows, ctx) => mapBlockTradeRowsToFacts(rows, ctx, subjectFilter),
      notices: [BACKFILL_REVISION_NOTICE, EMBLOCK_REVISION_NOTICE],
    });
  }

  private async fetchBridge(
    command: string,
    params: string[],
    spec: {
      resource: EmblockResource;
      objectKey: string;
      map: (rows: EmblockRow[], ctx: EmblockMapContext) => EmblockRowMapping;
      notices: string[];
    },
  ): Promise<EmblockFetchResult> {
    const scope = `emblock:${spec.resource}:${spec.objectKey}`;
    // 桥调用 + 输出可解析都在退避内：东财侧瞬态失败按 §7 退避（30s/60s/120s），
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'emblock',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = response.rows ?? [];
    // 单页上限守卫：akshare mrmx 无分页循环，行数达上限即疑似静默截断——
    // 具名永久错误（不写原件不入事实），回填侧须缩小窗口重排（31 天窗远低于上限）。
    if (rows.length >= EMBLOCK_SINGLE_PAGE_CEILING) {
      throw new AdapterError(
        'EMBLOCK_SUSPECTED_TRUNCATION',
        `rows=${String(rows.length)} ≥ 单页上限 ${String(EMBLOCK_SINGLE_PAGE_CEILING)}（mrmx 无分页循环）——缩小窗口重排`,
      );
    }
    const fetchedAt = this.now().toISOString();
    // 原件 = 桥 stdout 的 rows 规范化 JSON（全市场原样，不受 subjectFilter 影响；
    // 序号 已在桥侧剔除——随窗口漂移的 akshare 产物，非来源数据）。
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
        // 终局窗口同 factId 先写为准（emdc 先例）：factId 不含观察时刻，跨次抓取
        // firstObservedAt/artifact 不同但身份同 → 计 identical 不再插入（§6.5 去重）。
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'emblock', scope);
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
