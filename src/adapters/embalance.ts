/**
 * Lyra · 东财资产负债表适配器：个股商誉等资产负债表全历史（P1 W30: code-writer）。
 * 任务边界：A9 商誉占净资产比例（个股维度 7 风险项，RESEARCH-METHOD §4；Gate-M coverage
 * 实证缺口）；Owner 渠道指令：东财优先。桥 adapters/embalance/bridge.py（容器
 * python:3.11-slim + 命名卷 lyra-akshare-py311，与 W28/W29 并行各自建桥、文件不重叠）；
 * 退避/并发闸复用 ./backoff.ts；时点语义 docs/specs/POINT-IN-TIME.md §2/§3；
 * 适配器职责与去重 docs/specs/DATA-SOURCES.md §5/§6/§7；R4 修订口径声明随行。
 *
 * 来源与选型（2026-10-26 实测，探测证据 /tmp/lyra-w30/probe-balance.json、probe-bs.py 输出）：
 * - 派发预设 BaoStock query_balance_data **不含商誉**：venv baostock 0.9.40 实测仅 9 列偿债
 *   比率；穷举包源码无任何 goodwill 字段——"baostock balance 取商誉"前提不成立（原派发的
 *   baostock 追加式修改授权随之不执行，避免引入与任务目标无关的未用资源），按 Owner 渠道
 *   指令"东财优先"改走东财，总控回传中说明。
 * - BALANCE ← akshare.stock_balance_sheet_by_report_em（东财 F10 资产负债表按报告期，
 *   **每股一次调用拿全历史**；600519 实测 103 行，1998-12-31 → 2026-06-30，含一季报/中报/
 *   三季报/年报全部报告期）。列为东财原生字段名（数百列原样保留），事实构成字段：
 *   REPORT_DATE（报告期）、NOTICE_DATE（公告披露日，实测 103 行 0 空值）、GOODWILL（商誉，元）、
 *   TOTAL_PARENT_EQUITY（归母股东权益，元）、TOTAL_EQUITY（股东权益合计，元）、TOTAL_ASSETS（元）。
 * - 桥附确定性前缀转换字段 REPORT_DATE_ISO / NOTICE_DATE_ISO（YYYY-MM-DD，emrisk 桥同法）。
 *
 * 时点语义（本文件冻结口径；公告披露口径，与 BaoStock FINANCIAL pubDate 同法）：
 * - availableAt=NOTICE_DATE 次日 00:00 Asia/Shanghai（披露日精度 → 保守 D+1）；
 *   sourcePublishedAt=NOTICE_DATE 00:00+08；eventAt=validFrom=REPORT_DATE 00:00+08；
 * - 无 NOTICE_DATE 行具名拒绝（EMBALANCE_NOTICE_DATE_MISSING），不落库、不编造；
 *   REPORT_DATE 缺失/不可解析具名拒绝（EMBALANCE_REPORT_DATE_MISSING）。
 *
 * 业务语义边界（不越界）：源**无直接比率列**——"商誉占净资产比例"由消费侧计算；本适配器
 * 只原样入库构成字段（GOODWILL + 归母权益/权益合计两个分母候选并存），分母口径（归母 vs
 * 合计）属研究方法语义，不由适配器裁定（GOODWILL 为 null/空视为源无商誉，原样保留 null）。
 * - supersedes 接线（POINT-IN-TIME §4 修正不覆盖）：同 subject × 同报告期（REPORT_DATE_ISO）
 *   来源改值（更正报表）时新事实接 supersedes 链；同内容重放同 factId → IDENTICAL 去重（§6.5）。
 *
 * 范围：冻结池 26 只主板个股（R24.1）；symbol 前缀由主板规则派生（6→SH，0→SZ，R17）。
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

export const EMBALANCE_ADAPTER_VERSION = 'embalance@p1';

/** 6 位裸码（subjectId 形态）与东财 symbol 前缀派生（主板 R17：6→SH，0→SZ）。 */
const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 来源原生列名（实测 2026-10-26）与桥自加 ISO 前缀列名。 */
export const BAL_REPORT_DATE_ISO = 'REPORT_DATE_ISO';
export const BAL_NOTICE_DATE_ISO = 'NOTICE_DATE_ISO';

// ===== Asia/Shanghai 时间（固定 +08；口径与 emrisk.ts 自持同法，不跨文件依赖）=====

/** 日期 00:00 Asia/Shanghai。 */
export function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 日期次日 00:00 Asia/Shanghai（日精度来源的保守可得性，POINT-IN-TIME §3）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（东财字段原样保留：数值 number、日期字符串、NaN 已由桥转 null）。 */
export type EmbalanceRow = Record<string, unknown>;

export interface EmbalanceMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface EmbalanceMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmbalanceRowMapping {
  facts: EmbalanceMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'embalance-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `STOCK:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

export function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) {
    throw new AdapterError('EMBALANCE_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  }
  return code;
}

/** 裸码 → 东财 symbol（主板：6→SH，0→SZ；R17 范围外具名拒绝）。 */
export function toEmSymbol(code: string): string {
  requireBareCode(code);
  if (code.startsWith('6')) return `SH${code}`;
  if (code.startsWith('0')) return `SZ${code}`;
  throw new AdapterError('EMBALANCE_CODE_NOT_MAINBOARD', `${code}（非沪深主板，R17）`);
}

/** 资产负债表行：报告期与公告披露日为时点构成字段（桥已附 ISO 前缀列）。 */
function balanceFields(row: EmbalanceRow): { reportDate: string; noticeDate: string } | null {
  const report = row[BAL_REPORT_DATE_ISO];
  if (typeof report !== 'string' || !DATE_RE.test(report)) return null;
  const notice = row[BAL_NOTICE_DATE_ISO];
  if (typeof notice !== 'string' || !DATE_RE.test(notice)) return null;
  return { reportDate: report, noticeDate: notice };
}

/**
 * 资产负债表行 → BALANCE 事实。objectKey=报告期（业务对象=该股该期资产负债表）；
 * typedValue 原样保留东财全部字段 + code；availableAt=披露日次日 00:00+08（pubDate 同法）；
 * sourcePublishedAt=披露日 00:00+08；GOODWILL null（源无商誉）原样保留，不算拒绝。
 */
export function mapBalanceRowsToFacts(code: string, rows: EmbalanceRow[], ctx: EmbalanceMapContext): EmbalanceRowMapping {
  requireBareCode(code);
  const facts: EmbalanceMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = balanceFields(row);
    if (f === null) {
      const codeOut =
        typeof row[BAL_REPORT_DATE_ISO] !== 'string' || !DATE_RE.test(String(row[BAL_REPORT_DATE_ISO]))
          ? 'EMBALANCE_REPORT_DATE_MISSING'
          : 'EMBALANCE_NOTICE_DATE_MISSING';
      rejections.push({ rowIndex, code: codeOut });
      return;
    }
    const typedValue: EmbalanceRow = { ...row, code };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'BALANCE',
        subjectId: code,
        objectKey: f.reportDate,
        raw: row,
      }),
      subjectType: 'STOCK',
      subjectId: code,
      factKind: 'BALANCE',
      typedValue,
      validFrom: shanghaiDayStart(f.reportDate),
      validTo: null,
      eventAt: shanghaiDayStart(f.reportDate),
      sourcePublishedAt: shanghaiDayStart(f.noticeDate),
      firstObservedAt: ctx.fetchedAt,
      availableAt: shanghaiNextDayStart(f.noticeDate),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: f.reportDate });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python，与 emrisk 同法）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface EmbalanceBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/embalance/bridge.py。 */
export function makeEmbalanceBridgeExecutor(opts: EmbalanceBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/embalance/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMBALANCE_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMBALANCE_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMBALANCE_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMBALANCE_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmbalanceAdapterOptions {
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

export type EmbalanceResource = 'balance_sheet';

export interface EmbalanceFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：embalance:balance_sheet:<code>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class EmbalanceAdapter {
  readonly adapterVersion = EMBALANCE_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: EmbalanceAdapterOptions) {
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
      makeEmbalanceBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /** 个股全历史资产负债表（一次桥调用；rows 空集=来源无记录，如实空原件入档、计 0 事实）。 */
  async fetchBalanceSheet(code: string): Promise<EmbalanceFetchResult> {
    requireBareCode(code);
    const symbol = toEmSymbol(code);
    return this.fetch('balance', [symbol], {
      resource: 'balance_sheet',
      objectKey: code,
      map: (rows, ctx) => mapBalanceRowsToFacts(code, rows, ctx),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: EmbalanceResource;
      objectKey: string;
      map: (rows: EmbalanceRow[], ctx: EmbalanceMapContext) => EmbalanceRowMapping;
    },
  ): Promise<EmbalanceFetchResult> {
    const scope = `embalance:${spec.resource}:${spec.objectKey}`;
    // 抓取 + 桥合同校验都在退避内：瞬态坏响应按 §7 退避重试（30s/60s/120s）；
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff(() => this.execBridge([command, ...params]), {
        adapter: 'embalance',
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
    await resumePause(this.pool, 'embalance', scope);
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

  /** 接线 supersedes：查同对象键（报告期 REPORT_DATE_ISO）的当前链头（排除自身与仅被自身遮蔽）。 */
  private async wireSupersedes(fact: TimePointFact): Promise<TimePointFact> {
    const tv = fact.typedValue as EmbalanceRow;
    const reportDate = typeof tv[BAL_REPORT_DATE_ISO] === 'string' ? (tv[BAL_REPORT_DATE_ISO] as string) : '';
    const res = await this.pool.query<{ fact_id: string }>(
      `select f.fact_id from pintime_fact f
       where f.subject_type = $1 and f.subject_id = $2 and f.fact_kind = $3
         and f.typed_value->>'REPORT_DATE_ISO' = $4
         and f.fact_id <> $5
         and not exists (
           select 1 from pintime_fact s
           where s.supersedes_fact_id = f.fact_id and s.fact_id <> $5
         )
       order by f.available_at desc, f.fact_id desc limit 1`,
      [fact.subjectType, fact.subjectId, fact.factKind, reportDate, fact.factId],
    );
    const target = res.rows[0]?.fact_id;
    if (target === undefined || target === fact.factId) return fact;
    return { ...fact, supersedesFactId: target };
  }
}
