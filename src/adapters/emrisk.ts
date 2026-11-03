/**
 * Lyra · 东财风险面适配器：股权质押比例 + 股东户数（P1 W29: code-writer）。
 * 任务边界：R11 首版后置项 + Gate-M coverage 实证缺口（"股权质押比例未入库"，维度 7 风险项）；
 * Owner 渠道指令：东财优先。桥 adapters/emrisk/bridge.py（容器 python:3.11-slim + 命名卷
 * lyra-akshare-py311，akshare 1.19.3，与 W28 并行各自建桥、文件不重叠）；
 * 退避/并发闸复用 ./backoff.ts（只 import 不复刻）；时点语义 docs/specs/POINT-IN-TIME.md §2/§3；
 * 适配器职责与去重 docs/specs/DATA-SOURCES.md §5/§6/§7；R4 修订口径声明随行。
 *
 * 来源与选型（2026-10-25 容器内实测，探测输出 /tmp/lyra-w29/probe*.json）：
 * - PLEDGE_RATIO ← 东财数据中心报告 RPT_CSDC_LIST（上市公司质押比例，周度快照，同
 *   akshare.stock_gpzy_pledge_ratio_em 底层来源），按个股 SECURITY_CODE 过滤直连分页取数
 *   （bridge pledge 子命令）。选型理由：派发候选 akshare.stock_gpzy_pledge_ratio_em 是
 *   "按周快照日"全市场接口（每日期一次调用返回全市场 2294+ 行、内部 5 页 HTTP），26 股全历史
 *   周度（2014 起 ≈600 周）按日调用法调用量（≈3000 HTTP）与原件库规模均不可行；同源同报告
 *   换 SECURITY_CODE 过滤即一次调用拿该股全历史周度快照（600519 实测 608 行，2014-03-07 起），
 *   符合派发"每股一次调用拿全历史、量小"预期。列为东财原生字段名（SECURITY_CODE/TRADE_DATE/
 *   PLEDGE_RATIO/PLEDGE_DEAL_NUM/PLEDGE_MARKET_CAP/REPURCHASE_BALANCE/…），桥附确定性转换
 *   字段 TRADE_DATE_ISO（YYYY-MM-DD）。
 * - HOLDER_COUNT ← akshare.stock_zh_a_gdhs_detail_em（派发候选族实测通过；东财数据中心
 *   RPT_HOLDERNUM_DET 按个股过滤，一次调用全历史；600519 实测 63 行，2013-03-22 → 2026-06-30）。
 *   列为 akshare 原样中文字段名，含统计截止日与公告披露日两个时点字段；
 *   该包装对空结果集崩溃（TypeError NoneType），桥捕获该形态按空集如实返回。
 *
 * 时点语义（本文件冻结口径；快照与披露两类口径并存）：
 * - PLEDGE_RATIO：周度/不定期快照口径——快照日=TRADE_DATE（该周快照以该交易日为时点）；
 *   availableAt=快照日次日 00:00 Asia/Shanghai（保守，快照数据到库时点无逐行发布时刻自述）；
 *   eventAt=validFrom=快照日 00:00+08（指标在该时点成立）；sourcePublishedAt=null（快照表无
 *   逐行发布时间，不编造）。回填一次性拿到的是当前最新修订值（快照表可整表重刷），R4 声明随行。
 * - HOLDER_COUNT：公告披露口径——事件=股东户数统计截止日（户数状态成立时点）、披露=股东户数
 *   公告日期（东财公告披露口径）；availableAt=披露日次日 00:00+08（披露日精度 → 保守 D+1，
 *   与 BaoStock FINANCIAL pubDate 同法）；sourcePublishedAt=披露日 00:00+08；
 *   eventAt=validFrom=截止日 00:00+08。
 * - 两 kind 均 supersedesFactId=null：来源改值时新旧并存、按来源冲突处置（POINT-IN-TIME §4）；
 *   factId 由原始行内容派生（不含抓取时刻）→ 同内容重放同 factId → IDENTICAL 去重（§6.5）。
 *
 * 范围：冻结池 26 只主板个股（质押比例与股东户数为个股层面指标，4 只宽基 ETF 不适用、不在段内）。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { insertFact, loadFact, type InsertFactStatus } from '../pintime/facts.js';
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

export const EMRISK_ADAPTER_VERSION = 'emrisk@p1';

/** 6 位裸码（subjectId 形态；池 26 股均为沪/深主板 60/00 开头，R17）。 */
const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ===== Asia/Shanghai 时间（固定 +08；口径与 sw.ts 自持同法，不跨文件依赖）=====

/** 日期 00:00 Asia/Shanghai。 */
export function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 日期次日 00:00 Asia/Shanghai（日精度来源的保守可得性，POINT-IN-TIME §3）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（东财/akshare 字段原样保留：数值 number、日期字符串）。 */
export type EmriskRow = Record<string, unknown>;

export interface EmriskMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface EmriskMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmriskRowMapping {
  facts: EmriskMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'emrisk-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `STOCK:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) {
    throw new AdapterError('EMRISK_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  }
  return code;
}

/** 周度快照行：快照日（TRADE_DATE_ISO）与质押比例（PLEDGE_RATIO）为事实构成字段。 */
function pledgeFields(row: EmriskRow): { iso: string } | null {
  const iso = row['TRADE_DATE_ISO'];
  if (typeof iso !== 'string' || !DATE_RE.test(iso)) return null;
  const ratio = row['PLEDGE_RATIO'];
  if (ratio === null || ratio === undefined || ratio === '') return null;
  return { iso };
}

/**
 * 质押周度快照行 → PLEDGE_RATIO 事实。objectKey=快照日（业务对象=该股该周快照）；
 * typedValue 原样保留东财字段 + code；availableAt=快照日+1 00:00+08（快照口径，保守）。
 */
export function mapPledgeRowsToFacts(code: string, rows: EmriskRow[], ctx: EmriskMapContext): EmriskRowMapping {
  requireBareCode(code);
  const facts: EmriskMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = pledgeFields(row);
    if (f === null) {
      rejections.push({ rowIndex, code: 'EMRISK_PLEDGE_TRADE_DATE_MISSING' });
      return;
    }
    const typedValue: EmriskRow = { ...row, code };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'PLEDGE_RATIO',
        subjectId: code,
        objectKey: f.iso,
        raw: row,
      }),
      subjectType: 'STOCK',
      subjectId: code,
      factKind: 'PLEDGE_RATIO',
      typedValue,
      validFrom: shanghaiDayStart(f.iso),
      validTo: null,
      eventAt: shanghaiDayStart(f.iso),
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: shanghaiNextDayStart(f.iso),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: f.iso });
  });
  return { facts, rejections };
}

/** 股东户数行：统计截止日、公告披露日、本次户数三个时点/构成字段。 */
function gdhsFields(row: EmriskRow): { endDate: string; noticeDate: string } | null {
  const endDate = row['股东户数统计截止日'];
  if (typeof endDate !== 'string' || !DATE_RE.test(endDate)) return null;
  const noticeDate = row['股东户数公告日期'];
  if (typeof noticeDate !== 'string' || !DATE_RE.test(noticeDate)) return null;
  const num = row['股东户数-本次'];
  if (num === null || num === undefined || num === '') return null;
  return { endDate, noticeDate };
}

/**
 * 股东户数行 → HOLDER_COUNT 事实。objectKey=统计截止日（业务对象=该股该期户数）；
 * availableAt=公告披露日+1 00:00+08（公告披露口径，日精度保守 D+1）；sourcePublishedAt=披露日
 * 00:00+08。同截止日多行（来源更正）时新旧按 raw 内容各自成事实并存（冲突处置 §4）。
 */
export function mapHolderRowsToFacts(code: string, rows: EmriskRow[], ctx: EmriskMapContext): EmriskRowMapping {
  requireBareCode(code);
  const facts: EmriskMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = gdhsFields(row);
    if (f === null) {
      // 缺截止日 / 缺公告披露日 / 缺本次户数 统一具名拒绝（availableAt 不编造）。
      const codeOut =
        (typeof row['股东户数统计截止日'] !== 'string' ? 'EMRISK_GDHS_END_DATE_MISSING'
          : typeof row['股东户数公告日期'] !== 'string' ? 'EMRISK_GDHS_NOTICE_DATE_MISSING'
            : 'EMRISK_GDHS_NUM_MISSING');
      rejections.push({ rowIndex, code: codeOut });
      return;
    }
    const typedValue: EmriskRow = { ...row, code };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'HOLDER_COUNT',
        subjectId: code,
        objectKey: f.endDate,
        raw: row,
      }),
      subjectType: 'STOCK',
      subjectId: code,
      factKind: 'HOLDER_COUNT',
      typedValue,
      validFrom: shanghaiDayStart(f.endDate),
      validTo: null,
      eventAt: shanghaiDayStart(f.endDate),
      sourcePublishedAt: shanghaiDayStart(f.noticeDate),
      firstObservedAt: ctx.fetchedAt,
      availableAt: shanghaiNextDayStart(f.noticeDate),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: f.endDate });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python，与 sw 同法）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface EmriskBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emrisk/bridge.py。 */
export function makeEmriskBridgeExecutor(opts: EmriskBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emrisk/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMRISK_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMRISK_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMRISK_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMRISK_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmriskAdapterOptions {
  pool: Pool;
  store: ArtifactStore;
  /** 注入桥执行器（单测 fixture 注入；缺省真实 docker）。 */
  execBridge?: BridgeExecutor | undefined;
  now?: (() => Date) | undefined;
  /** 并发闸（默认 1——东财单来源串行稳妥默认，DATA-SOURCES §7）。 */
  gate?: ConcurrencyGate | undefined;
  backoffSleeper?: BackoffSleeper | undefined;
  backoffAttempts?: number | undefined;
  backoffBaseDelayMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  dockerPath?: string | undefined;
  /** 工程根（缺省取本文件相对根；容器 -v mount 用）。 */
  repoRootPath?: string | undefined;
}

export type EmriskResource = 'pledge_ratio' | 'holder_count';

export interface EmriskFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：emrisk:<resource>:<code>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class EmriskAdapter {
  readonly adapterVersion = EMRISK_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: EmriskAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(1);
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.root = opts.repoRootPath ?? repoRoot;
    this.execBridge =
      opts.execBridge ??
      makeEmriskBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /** 质押比例全历史周度快照（一次桥调用；rows 空集=来源无记录，如实空原件入档、计 0 事实）。 */
  async fetchPledgeRatio(code: string): Promise<EmriskFetchResult> {
    requireBareCode(code);
    return this.fetch('pledge', [code], {
      resource: 'pledge_ratio',
      objectKey: code,
      map: (rows, ctx) => mapPledgeRowsToFacts(code, rows, ctx),
    });
  }

  /** 股东户数全历史（一次桥调用；公告披露口径；空集同上）。 */
  async fetchHolderCount(code: string): Promise<EmriskFetchResult> {
    requireBareCode(code);
    return this.fetch('gdhs', [code], {
      resource: 'holder_count',
      objectKey: code,
      map: (rows, ctx) => mapHolderRowsToFacts(code, rows, ctx),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: EmriskResource;
      objectKey: string;
      map: (rows: EmriskRow[], ctx: EmriskMapContext) => EmriskRowMapping;
    },
  ): Promise<EmriskFetchResult> {
    const scope = `emrisk:${spec.resource}:${spec.objectKey}`;
    // 抓取（含桥内分页）+ 桥合同校验都在退避内：瞬态坏响应按 §7 退避重试（30s/60s/120s）；
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff(() => this.execBridge([command, ...params]), {
        adapter: 'emrisk',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = response.rows ?? [];
    const fetchedAt = this.now().toISOString();
    const artifact = await this.store.put(
      new TextEncoder().encode(canonicalJsonString(rows)),
      'application/json',
      fetchedAt,
    );
    const mapped = spec.map(rows, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      // 去重命中（DATA-SOURCES §6.5，W4 baostock 冻结语义）：factId 按行内容派生，同 factId 即
      // 同对象同值；首见事实与其原件引用（当时批次）保留，不因重放批次（不同 firstObservedAt /
      // 重抓原件）改写（POINT-IN-TIME §2.1 只读）——故重放幂等不依赖批次元数据相等。
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status: InsertFactStatus = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'emrisk', scope);
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
