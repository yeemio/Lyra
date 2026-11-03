/**
 * Lyra · 东财机构持仓面适配器：基金重仓按报告期（P1 W39: code-writer，B2/D5-D7）。
 * 任务边界：需求池 B2「机构持仓（基金重仓/北向持股）」（REQUIREMENTS-BACKLOG B 类，
 * 实施登记见回传/REVISION-LOG）；桥 adapters/eminstitution/bridge.py（容器 python:3.11-slim +
 * 命名卷 lyra-akshare-py311，与 emfund/emrisk 同模式）；退避/并发闸复用 ./backoff.ts
 * （只 import 不复刻）；时点语义 docs/specs/POINT-IN-TIME.md §2/§3；适配器职责与去重
 * docs/specs/DATA-SOURCES.md §5/§6/§7；R4 修订口径声明随行。
 *
 * 来源与选型（2026-10-25 容器内实测，探测证据 /tmp/w39-probe-call.txt、/tmp/w39-north-diag.txt）：
 * - FUND_HOLD ← 东财数据中心主力数据接口 data.eastmoney.com/dataapi/zlsj/list
 *   （date=<报告期>、type=1=基金持仓；akshare.stock_report_fund_hold 同端点）。桥按报告期
 *   一次调用（内部逐页 pageSize=500），行保留原始 JSON 字段名与原生值类型（不经 pandas，
 *   规避 W37 登记的 pandas jsonable 整型转字符串缺陷类）；桥内按池码过滤，meta.fullRows
 *   如实申报过滤前行数（2024-12-31 实测 5,225 行、2026-09-30 实测 1,556 行）。池适用性：
 *   2026-09-30 601318/000938 实测命中，2024-12-31 全市场行含池股。
 * - 北向个股面（B2 另一半）：东财 RPT_MUTUAL_HOLDSTOCKNDATE_STA（akshare
 *   stock_hsgt_individual_em 同端点）实测存活但**序列止于 2024-08-16**（2024-08 披露机制
 *   调整后个股级停发；601318 count=1698 全部 ≤2024-08-16，降序首行=2024-08-16）——
 *   近 2 年窗口完全落在停发之后，该信息面按派发如实声明不可得（市场级资金流非个股持仓，
 *   不属 B2 个股信息面）。此声明即探测结论，不造数、不以历史段顶替近 2 年窗口。
 *
 * 时点语义（本文件冻结口径；季报口径）：
 * - 事件=报告期季度末（持仓状态成立时点）→ eventAt=validFrom=季度末 00:00 Asia/Shanghai；
 * - 来源快照**无逐行披露日**（REPORT_DATE 为报告期非披露日；zlsj 为东财当前聚合视图，随
 *   基金陆续披露而增行改值）→ 不编造披露日：availableAt=季度末+92 天 00:00+08（法定披露
 *   期限统一保守上界：基金年报 3 个月、半年报 2 个月、季报 15 个工作日全部期限 ≤ 季末+92 天，
 *   与 emfund ETF_SHARE 先例同常量）；sourcePublishedAt=null。
 *   （派发假设的"披露日次日"以探测实证修正：来源无逐行披露日字段，按 POINT-IN-TIME §3
 *   保守可得上界口径执行——不编造。）
 * - 回填拿到的是来源当前聚合视图（可整期重刷），R4 声明随行；季度披露在途（如最新报告期）
 *   时重跑可产生同对象改值事实 → supersedes 链（POINT-IN-TIME §4 修正不覆盖）。
 * - supersedes 接线：同 subject × 同报告期来源改值（更正/追加披露聚合值变化）时新事实接
 *   supersedes 链，as-of 读回链头胜出；同内容重放同 factId → IDENTICAL 去重（DATA-SOURCES §6.5）。
 *
 * 范围：冻结池 26 只沪深主板个股（R17/R18；data/research-pool.json），subjectType='STOCK'、
 * subjectId=裸码；池过滤在桥内完成（桥 meta.fullRows 申报全市场行数）。
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

export const EMINSTITUTION_ADAPTER_VERSION = 'eminstitution@p1';

/** 季度末 → 可得性的统一保守上界（天）：季度末+92 天 ≥ 基金全部定期报告法定披露期限（见文件头时点语义）。 */
export const FUND_HOLD_AVAILABILITY_LAG_DAYS = 92;

/** 6 位裸码（subjectId 形态；池 26 股沪深主板，R17/R18）。 */
const CODE_RE = /^\d{6}$/;
/** 报告期季度末（YYYY-MM-DD；基金定期报告仅四类季末）。 */
const QUARTER_END_RE = /^\d{4}-(03-31|06-30|09-30|12-31)$/;
/** 桥参数日期形态（YYYYMMDD）。 */
const BRIDGE_DATE_RE = /^\d{8}$/;

/** 来源原生字段名（zlsj/list 原始 JSON 键，实测 2026-10-25）。 */
export const FUND_HOLD_CODE_FIELD = 'SECURITY_CODE';
export const FUND_HOLD_REPORT_DATE_FIELD = 'REPORT_DATE';

// ===== Asia/Shanghai 时间（固定 +08；口径与 emfund.ts 自持同法，不跨文件依赖）=====

/** 日期 00:00 Asia/Shanghai。 */
export function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 季度末+92 天 00:00 Asia/Shanghai（法定披露上界口径，POINT-IN-TIME §3 保守可得）。 */
export function fundHoldAvailableAt(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + FUND_HOLD_AVAILABILITY_LAG_DAYS * 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（zlsj/list 原始 JSON 行，键为来源原生字段名，值原生类型：数值/字符串/null）。 */
export type InstitutionRow = Record<string, unknown>;

export interface InstitutionMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface InstitutionMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface InstitutionRowMapping {
  facts: InstitutionMappedFact[];
  rejections: { rowIndex: number; code: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'eminstitution-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `STOCK:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) {
    throw new AdapterError('EMINSTITUTION_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  }
  return code;
}

/**
 * zlsj 行：SECURITY_CODE（6 位裸码）与 REPORT_DATE（YYYY-MM-DD 季末前缀，行值形态
 * "YYYY-MM-DD 00:00:00"）为事实构成字段。
 */
function fundHoldFields(row: InstitutionRow, expectedDate: string): { code: string; reportDate: string } | null {
  const rawCode = row[FUND_HOLD_CODE_FIELD];
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().padStart(6, '0');
  if (!CODE_RE.test(code)) return null;
  const rawDate = row[FUND_HOLD_REPORT_DATE_FIELD];
  if (typeof rawDate !== 'string') return null;
  const reportDate = rawDate.slice(0, 10);
  if (!QUARTER_END_RE.test(reportDate)) return null;
  // 行内报告期必须与请求报告期一致（zlsj 按日期过滤返回；不一致视为异常行，具名拒绝）
  if (reportDate !== expectedDate) return null;
  return { code, reportDate };
}

/**
 * zlsj 行 → FUND_HOLD 事实。objectKey=报告期季度末（业务对象=该股该期基金重仓聚合状态）；
 * typedValue 原样保留来源原始字段 + code；availableAt=季度末+92 天 00:00+08（法定披露上界，
 * 不编造披露日）；sourcePublishedAt=null。
 */
export function mapFundHoldRowsToFacts(expectedDate: string, rows: InstitutionRow[], ctx: InstitutionMapContext): InstitutionRowMapping {
  if (!QUARTER_END_RE.test(expectedDate)) {
    throw new AdapterError('EMINSTITUTION_DATE_INVALID', `expectedDate=${expectedDate}（须 YYYY-MM-DD 季末）`);
  }
  const facts: InstitutionMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = fundHoldFields(row, expectedDate);
    if (f === null) {
      // 缺代码/报告期形态异常/与请求期不一致 统一具名拒绝（availableAt 不编造）。
      rejections.push({ rowIndex, code: 'EMINSTITUTION_ROW_FIELDS_INVALID' });
      return;
    }
    const typedValue: InstitutionRow = { ...row, code: f.code };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'FUND_HOLD',
        subjectId: f.code,
        objectKey: f.reportDate,
        raw: row,
      }),
      subjectType: 'STOCK',
      subjectId: f.code,
      factKind: 'FUND_HOLD',
      typedValue,
      validFrom: shanghaiDayStart(f.reportDate),
      validTo: null,
      eventAt: shanghaiDayStart(f.reportDate),
      sourcePublishedAt: null,
      firstObservedAt: ctx.fetchedAt,
      availableAt: fundHoldAvailableAt(f.reportDate),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey: f.reportDate });
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python，与 emfund 同法）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface InstitutionBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/eminstitution/bridge.py。 */
export function makeInstitutionBridgeExecutor(opts: InstitutionBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/eminstitution/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMINSTITUTION_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMINSTITUTION_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMINSTITUTION_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMINSTITUTION_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface InstitutionAdapterOptions {
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

export type InstitutionResource = 'fund_hold';

export interface InstitutionFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：eminstitution:fund_hold:<date>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  /** 桥池过滤前的来源全市场行数（meta.fullRows，如实申报）。 */
  fullRowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class InstitutionAdapter {
  readonly adapterVersion = EMINSTITUTION_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: InstitutionAdapterOptions) {
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
      makeInstitutionBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /**
   * 按报告期的基金重仓全市场快照（桥内按池码过滤）。rows 空集=该报告期池内无基金持仓记录，
   * 如实空原件入档、计 0 事实（不报错、不造数；pool-financials 冻结口径先例）。
   */
  async fetchFundHold(date: string, codes: string[]): Promise<InstitutionFetchResult> {
    if (!BRIDGE_DATE_RE.test(date) || !QUARTER_END_RE.test(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`)) {
      throw new AdapterError('EMINSTITUTION_DATE_INVALID', `date=${date}（须 YYYYMMDD 季末）`);
    }
    const seen = new Set<string>();
    for (const code of codes) {
      requireBareCode(code);
      if (seen.has(code)) throw new AdapterError('EMINSTITUTION_CODE_DUPLICATE', code);
      seen.add(code);
    }
    if (codes.length === 0) throw new AdapterError('EMINSTITUTION_CODES_EMPTY', '池码表不得为空');
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    return this.fetch('fund_hold', [date, codes.join(',')], {
      resource: 'fund_hold',
      objectKey: iso,
      map: (rows, ctx) => mapFundHoldRowsToFacts(iso, rows, ctx),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: InstitutionResource;
      objectKey: string;
      map: (rows: InstitutionRow[], ctx: InstitutionMapContext) => InstitutionRowMapping;
    },
  ): Promise<InstitutionFetchResult> {
    const scope = `eminstitution:${spec.resource}:${spec.objectKey}`;
    // 抓取 + 桥合同校验都在退避内：瞬态坏响应按 §7 退避重试（30s/60s/120s）；
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff(() => this.execBridge([command, ...params]), {
        adapter: 'eminstitution',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = (response.rows ?? []) as unknown as InstitutionRow[];
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
    await resumePause(this.pool, 'eminstitution', scope);
    const meta = (response as { meta?: Record<string, unknown> }).meta;
    const fullRowCount = typeof meta?.fullRows === 'number' ? meta.fullRows : rows.length;
    return {
      adapterVersion: this.adapterVersion,
      command,
      params,
      scope,
      artifact,
      rowCount: rows.length,
      fullRowCount,
      insertedFactIds,
      identicalFactIds,
      rejectedRows: mapped.rejections,
      notices: [BACKFILL_REVISION_NOTICE],
    };
  }

  /** 接线 supersedes：查同对象键（报告期）的当前链头（排除自身；排除仅被自身 supersede 的遮蔽）。 */
  private async wireSupersedes(fact: TimePointFact): Promise<TimePointFact> {
    const tv = fact.typedValue as InstitutionRow;
    const reportDate = typeof tv[FUND_HOLD_REPORT_DATE_FIELD] === 'string'
      ? (tv[FUND_HOLD_REPORT_DATE_FIELD] as string).slice(0, 10)
      : '';
    const res = await this.pool.query<{ fact_id: string }>(
      `select f.fact_id from pintime_fact f
       where f.subject_type = $1 and f.subject_id = $2 and f.fact_kind = $3
         and left(f.typed_value->>'REPORT_DATE', 10) = $4
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
