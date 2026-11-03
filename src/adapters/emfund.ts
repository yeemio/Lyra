/**
 * Lyra · 东财基金面适配器：ETF 季度份额序列（P1 W30: code-writer）。
 * 任务边界：A7 宽基七维-资金维度"ETF 份额变化"（FREEZE §四；DATA-SOURCES §2.10 候选
 * AKShare/交易所公告的东财落点）；Owner 渠道指令：东财优先。桥 adapters/emfund/bridge.py
 * （容器 python:3.11-slim + 命名卷 lyra-akshare-py311，与 W28/W29 并行各自建桥、文件不重叠）；
 * 退避/并发闸复用 ./backoff.ts（只 import 不复刻）；时点语义 docs/specs/POINT-IN-TIME.md §2/§3；
 * 适配器职责与去重 docs/specs/DATA-SOURCES.md §5/§6/§7；R4 修订口径声明随行。
 *
 * 来源与选型（2026-10-26 容器内实测，探测证据 /tmp/lyra-w30/probe-etf.json）：
 * - ETF_SHARE ← 东财天天基金 F10 规模变动接口（FundArchivesDatas.aspx?type=gmbd，**按基金
 *   一次调用拿全历史季频序列**；510050 实测自 2005-02 成立起 ~85 个季度行、512100 自上市季度起）。
 *   列为来源原生中文字段名：日期 / 期间申购（亿份）/ 期间赎回（亿份）/ 期末总份额（亿份）/
 *   期末净资产（亿元）/ 净资产变动率，值原样保留（亿份两位小数为来源公布精度）。
 * - 派发候选 akshare.fund_etf_fund_info_em 实测为历史净值表（包源码核对：列＝净值日期/单位净值/
 *   累计净值/日增长率/申购状态/赎回状态），无份额列，排除；
 * - akshare.fund_etf_scale_sse（上交所按日期全市场快照）实测可用但按日期一次调用，全历史
 *   ≈2,800 次调用不可行——保留为交叉校验参照（2025-09-30 510050 基金份额 57,723,966,800 份，
 *   见 emfund.smoke.ts 跨源校验）。
 *
 * 时点语义（本文件冻结口径；季报口径）：
 * - 事件=季度末日（期末份额状态成立时点）→ eventAt=validFrom=季度末 00:00 Asia/Shanghai；
 * - F10 序列**无逐行披露日**（不编造）→ availableAt=季度末+92 天 00:00+08（法定披露期限统一
 *   保守上界：年报 3 个月、半年报 2 个月、季报 15 个工作日的全部法定期限 ≤ 季度末+92 天）；
 *   sourcePublishedAt=null（快照/汇总表无逐行发布时刻，不编造）。
 * - 回填一次性拿到的是来源当前视图（F10 可整表重刷），R4 声明随行。
 * - supersedes 接线（POINT-IN-TIME §4 修正不覆盖）：同 subject × 同季度（'日期'）来源改值
 *   （更正/重述）时新事实接 supersedes 链，as-of 读回链头胜出；同内容重放同 factId →
 *   IDENTICAL 去重（DATA-SOURCES §6.5）。
 *
 * 范围：冻结池 4 只宽基 ETF（510050/510300/510500/512100，R24.1），subjectType='ETF'、
 * subjectId=裸码。
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

export const EMFUND_ADAPTER_VERSION = 'emfund@p1';

/** 季度末 → 可得性的统一保守上界（天）：季度末+92 天 ≥ 全部法定披露期限（见文件头时点语义）。 */
export const SHARE_AVAILABILITY_LAG_DAYS = 92;

/** 6 位裸码（subjectId 形态；池 4 ETF 均沪市 51/56 前缀，R24.1）。 */
const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 来源原生列名（gmbd 表头，实测 2026-10-26）。 */
export const SHARE_DATE_FIELD = '日期';
export const SHARE_TOTAL_FIELD = '期末总份额（亿份）';

// ===== Asia/Shanghai 时间（固定 +08；口径与 emrisk.ts 自持同法，不跨文件依赖）=====

/** 日期 00:00 Asia/Shanghai。 */
export function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 季度末+92 天 00:00 Asia/Shanghai（法定披露上界口径，POINT-IN-TIME §3 保守可得）。 */
export function shareAvailableAt(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + SHARE_AVAILABILITY_LAG_DAYS * 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（gmbd 表单元格原样字符串）。 */
export type EmfundRow = Record<string, unknown>;

export interface EmfundMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface EmfundMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmfundRowMapping {
  facts: EmfundMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'emfund-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `ETF:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) {
    throw new AdapterError('EMFUND_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  }
  return code;
}

/** gmbd 季度行：季度末日与期末总份额（亿份）为事实构成字段。 */
function shareFields(row: EmfundRow): { quarterEnd: string } | null {
  const date = row[SHARE_DATE_FIELD];
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  const total = row[SHARE_TOTAL_FIELD];
  if (typeof total !== 'string' || total.length === 0) return null;
  return { quarterEnd: date };
}

/**
 * gmbd 季度行 → ETF_SHARE 事实。objectKey=季度末日（业务对象=该 ETF 该季期末份额）；
 * typedValue 原样保留来源中文字段 + code；availableAt=季度末+92 天 00:00+08（法定披露上界，
 * 不编造披露日）；sourcePublishedAt=null。
 */
export function mapShareRowsToFacts(code: string, rows: EmfundRow[], ctx: EmfundMapContext): EmfundRowMapping {
  requireBareCode(code);
  const facts: EmfundMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = shareFields(row);
    if (f === null) {
      // 缺季度日期 / 缺期末总份额 统一具名拒绝（availableAt 不编造）。
      const codeOut = typeof row[SHARE_DATE_FIELD] !== 'string' || !DATE_RE.test(String(row[SHARE_DATE_FIELD]))
        ? 'EMFUND_SHARE_DATE_MISSING'
        : 'EMFUND_SHARE_VALUE_MISSING';
      rejections.push({ rowIndex, code: codeOut });
      return;
    }
    const typedValue: EmfundRow = { ...row, code };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'ETF_SHARE',
        subjectId: code,
        objectKey: f.quarterEnd,
        raw: row,
      }),
      subjectType: 'ETF',
      subjectId: code,
      factKind: 'ETF_SHARE',
      typedValue,
      validFrom: shanghaiDayStart(f.quarterEnd),
      validTo: null,
      eventAt: shanghaiDayStart(f.quarterEnd),
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: shareAvailableAt(f.quarterEnd),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: f.quarterEnd });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python，与 emrisk 同法）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface EmfundBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emfund/bridge.py。 */
export function makeEmfundBridgeExecutor(opts: EmfundBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emfund/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMFUND_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMFUND_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMFUND_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMFUND_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmfundAdapterOptions {
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

export type EmfundResource = 'etf_share';

export interface EmfundFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：emfund:etf_share:<code>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class EmfundAdapter {
  readonly adapterVersion = EMFUND_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: EmfundAdapterOptions) {
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
      makeEmfundBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /** ETF 全历史季度份额序列（一次桥调用；rows 空集=来源无记录，如实空原件入档、计 0 事实）。 */
  async fetchEtfShare(code: string): Promise<EmfundFetchResult> {
    requireBareCode(code);
    return this.fetch('fund_share', [code], {
      resource: 'etf_share',
      objectKey: code,
      map: (rows, ctx) => mapShareRowsToFacts(code, rows, ctx),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: EmfundResource;
      objectKey: string;
      map: (rows: EmfundRow[], ctx: EmfundMapContext) => EmfundRowMapping;
    },
  ): Promise<EmfundFetchResult> {
    const scope = `emfund:${spec.resource}:${spec.objectKey}`;
    // 抓取 + 桥合同校验都在退避内：瞬态坏响应按 §7 退避重试（30s/60s/120s）；
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff(() => this.execBridge([command, ...params]), {
        adapter: 'emfund',
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
      // 去重命中（DATA-SOURCES §6.5，W4 冻结语义）：factId 按行内容派生，同 factId 即
      // 同对象同值；首见事实与其原件引用（当时批次）保留，不因重放批次改写（POINT-IN-TIME §2.1 只读）。
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      const fact = await this.wireSupersedes(m.fact);
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status: InsertFactStatus = await insertFact(this.pool, fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(fact.factId);
    }
    await resumePause(this.pool, 'emfund', scope);
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

  /** 接线 supersedes：查同对象键（季度末日）的当前链头（排除自身；排除仅被自身 supersede 的遮蔽）。 */
  private async wireSupersedes(fact: TimePointFact): Promise<TimePointFact> {
    const tv = fact.typedValue as EmfundRow;
    const quarterEnd = typeof tv[SHARE_DATE_FIELD] === 'string' ? (tv[SHARE_DATE_FIELD] as string) : '';
    const res = await this.pool.query<{ fact_id: string }>(
      `select f.fact_id from pintime_fact f
       where f.subject_type = $1 and f.subject_id = $2 and f.fact_kind = $3
         and f.typed_value->>'日期' = $4
         and f.fact_id <> $5
         and not exists (
           select 1 from pintime_fact s
           where s.supersedes_fact_id = f.fact_id and s.fact_id <> $5
         )
       order by f.available_at desc, f.fact_id desc limit 1`,
      [fact.subjectType, fact.subjectId, fact.factKind, quarterEnd, fact.factId],
    );
    const target = res.rows[0]?.fact_id;
    if (target === undefined || target === fact.factId) return fact;
    return { ...fact, supersedesFactId: target };
  }
}
