/**
 * Lyra · 东财机构调研记录适配器：个股调研明细近窗（P2 W41b: code-writer，C2/D5-D7）。
 * 任务边界：需求池 C2「调研记录」（REVISION-LOG 迭代循环 18 C 轮补充，入池队首——月频机构
 * 关注度信号，D5/D7 机构关注度）；桥 adapters/emsurvey/bridge.py（容器 python:3.11-slim +
 * 命名卷 lyra-akshare-py311，与 emfund/eminstitution/embalance 同模式）；退避/并发闸复用
 * ./backoff.ts（只 import 不复刻）；时点语义 docs/specs/POINT-IN-TIME.md §2/§3；适配器职责
 * 与去重 docs/specs/DATA-SOURCES.md §5/§6/§7；R4 修订口径声明随行。
 *
 * 来源与选型（2026-10-26 容器内实测十轮鉴别 + 真实冒烟/回填实证，证据 /tmp/w41b/probe1..10-out.txt）：
 * - akshare 1.19.3 调研一族仅两函数：stock_jgdy_detail_em（RPT_ORG_SURVEY 逐条调研明细）
 *   与 stock_jgdy_tj_em（RPT_ORG_SURVEYNEW 按股统计聚合）。派发两形态裁选：近 2 年按日
 *   全市场明细实测 total=632,672 行（12,654 页）调用过重 → 选**按个股过滤形态**。
 * - 最终形态（probe9/probe10 在超重数据集上实证）：RPT_ORG_SURVEY + columns=ALL +
 *   sortColumns=NOTICE_DATE + filter (SECURITY_CODE)(IS_SOURCE="1")(RECEIVE_START_DATE>
 *   '<窗界前一日>') 三 term 组合可用（603986 近 2 年实测 664 行、002384 实测 115 行）。
 *   诊断弯路如实记录：①自定义 headers（Chrome UA+Referer）与急促连发触发 9701
 *   '服务器繁忙'（探测五连 0 数据）——默认 UA 裸请求（akshare 同款、无 ut、页间 sleep 1s）
 *   是硬前提；②601318/600519 两冒烟样本近 2 年为**合法空集**（601318 全历史止于
 *   2023-10-27，600519 全程无记录），早期"过滤项组合必 9201"误判由此造成、probe9 证伪；
 *   ③code-only 过滤对超重数据集（603986 全历史 6,049+ 行）9701（后端查询过载），
 *   IS_SOURCE="1" 收窄即解——同时与映射层时点口径自洽（只收有披露来源的记录行）。
 * - 反爬纪律：桥保持默认 UA、无 ut、页间 sleep(1s)；9701 归瞬态由 TS 退避（DATA-SOURCES
 *   §7）；9201 在该过滤组合下为近窗空集语义（首页 9201 如实空原件，不造数）。
 * - 行=一次调研活动 × 一家接待机构（columns=ALL 含 ORG_NAME/ORG_CODE/ORG_TYPE/
 *   ORG_TYPE_CODE/IS_QFII/NUMBERNEW/CONTENT 等完整明细字段，比 akshare 11 列清单更全——
 *   D5/D7 关注度的机构构成可用）；NOTICE_DATE=纪要披露日；RECEIVE_START_DATE=接待日；
 *   桥附 RECEIVE_START_DATE_ISO / NOTICE_DATE_ISO 前缀列；近窗窗界纪律在桥过滤之上
 *   由映射层二次执行（纵深防御，窗外行具名计数）。
 * - 前视防泄漏：akshare 原版 quoteColumns 拉的 CLOSE_PRICE/CHANGE_RATE 是**抓取时点当前
 *   行情**（不是披露时点行情），随行入库会把今天价格塞进历史事实——桥不请求该参数且
 *   防御性剔除两键；typedValue 原样保留其余来源字段（DATA-SOURCES §6.2）。
 *
 * 时点语义（本文件冻结口径；披露口径，embalance 逐行 NOTICE_DATE 先例同法）：
 * - 事件=调研活动发生时点 → eventAt=validFrom=RECEIVE_START_DATE 00:00 Asia/Shanghai；
 * - availableAt=NOTICE_DATE（纪要披露日）次日 00:00+08（披露日精度 → 保守 D+1）；
 *   sourcePublishedAt=NOTICE_DATE 00:00+08（来源原生逐行披露日，非编造）；
 * - 无 RECEIVE_START_DATE 行具名拒绝（EMSURVEY_RECEIVE_DATE_MISSING）；无 NOTICE_DATE 行
 *   具名拒绝（EMSURVEY_NOTICE_DATE_MISSING）——不落库、不编造（POINT-IN-TIME §3）。
 *
 * 业务语义边界（不越界）：行内 RECEIVE_OBJECT 为单机构名——"机构关注度"的计数/去重
 * （按调研日×机构）与 D5/D7 信号构造属研究方法语义，由消费侧计算；本适配器只原样入库
 * 登记记录。SURVEY_RECORD 为登记记录事实（同 emdc LHB 先例）：factId 含原始行内容，
 * 不接 supersedes 链——源侧更正/补录以追加记录形态如实入库；同内容重放同 factId →
 * IDENTICAL 去重（DATA-SOURCES §6.5）。
 *
 * 范围：冻结池 26 只沪深主板个股（R17/R18/R24；data/research-pool.json），subjectType='STOCK'、
 * subjectId=裸码；近 2 年窗界（event=调研日口径）由回填层冻结派发，桥只收窗界参数。
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

export const EMSURVEY_ADAPTER_VERSION = 'emsurvey@p1';

/** 6 位裸码（subjectId 形态；池 26 股沪深主板，R17/R18）。 */
const CODE_RE = /^\d{6}$/;
/** ISO 日期（YYYY-MM-DD；桥附 *_ISO 前缀列形态与窗界参数形态）。 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 来源原生字段名与桥自加 ISO 前缀列名（实测/社区抓包形态 2026-10-26）。 */
export const SURVEY_RECEIVE_START_ISO = 'RECEIVE_START_DATE_ISO';
export const SURVEY_NOTICE_ISO = 'NOTICE_DATE_ISO';
export const SURVEY_NUMBERNEW_FIELD = 'NUMBERNEW';
/** 接待机构数量（活动聚合值——D5/D7 关注度直接构件；字段名以冒烟/回填原件为准声明）。 */
export const SURVEY_ORG_NUM_FIELD = 'RECEIVE_ORG_NUM';

// ===== Asia/Shanghai 时间（固定 +08；口径与 eminstitution.ts 自持同法，不跨文件依赖）=====

/** 日期 00:00 Asia/Shanghai。 */
export function shanghaiDayStart(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** 日期次日 00:00 Asia/Shanghai（日精度来源的保守可得性，POINT-IN-TIME §3）。 */
export function shanghaiNextDayStart(date: string): string {
  return new Date(new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（11 列原始 JSON + 桥附 *_ISO 前缀列；数值原生类型、文本 null 原样）。 */
export type SurveyRow = Record<string, unknown>;

export interface SurveyMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
}

export interface SurveyMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface SurveyRowMapping {
  facts: SurveyMappedFact[];
  rejections: { rowIndex: number; code: string }[];
  /** 派发窗界外行（原件保留、不入事实；派发冻结近 2 年纪律由映射层执行）。 */
  outOfWindow: { rowIndex: number; receiveIso: string }[];
}

function factIdOf(args: {
  adapterVersion: string;
  factKind: string;
  subjectId: string;
  objectKey: string;
  raw: unknown;
}): string {
  return 'emsurvey-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `STOCK:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) {
    throw new AdapterError('EMSURVEY_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  }
  return code;
}

/**
 * 调研明细行构成字段：SECURITY_CODE（6 位裸码，须与请求代码一致——桥按个股过滤返回，
 * 不一致视为异常行具名拒绝）、RECEIVE_START_DATE_ISO（接待日）、NOTICE_DATE_ISO（披露日）。
 */
function surveyFields(row: SurveyRow, expectedCode: string): { receiveIso: string; noticeIso: string } | null {
  const rawCode = row['SECURITY_CODE'];
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().padStart(6, '0');
  if (code !== expectedCode) return null;
  const receiveIso = row[SURVEY_RECEIVE_START_ISO];
  if (typeof receiveIso !== 'string' || !ISO_DATE_RE.test(receiveIso)) return null;
  const noticeIso = row[SURVEY_NOTICE_ISO];
  if (typeof noticeIso !== 'string' || !ISO_DATE_RE.test(noticeIso)) return null;
  return { receiveIso, noticeIso };
}

/**
 * SURVEY 明细行 → SURVEY_RECORD 事实。objectKey=接待日|公告日|NUMBERNEW（登记记录的
 * 自然键；同键不同内容行不同 factId 并存、不接 supersedes——见文件头语义边界）；
 * availableAt=披露日次日 00:00+08；sourcePublishedAt=披露日 00:00+08；
 * eventAt=validFrom=接待日 00:00+08。防泄漏断言：行情快照列不得入事实（桥已剔除）。
 * 窗界纪律（纵深防御）：桥已按 sinceExclusive=窗界前一日过滤；映射层对窗界外行仍具名
 * 计数入 outOfWindow 桶（原件保留、不入事实）——桥过滤失效时不放过任何窗外事实。
 */
export function mapSurveyRowsToFacts(
  code: string,
  rows: SurveyRow[],
  ctx: SurveyMapContext,
  window?: { windowFromIso: string },
): SurveyRowMapping {
  requireBareCode(code);
  const facts: SurveyMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  const outOfWindow: { rowIndex: number; receiveIso: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const f = surveyFields(row, code);
    if (f === null) {
      // 缺代码/代码不一致/缺接待日/缺披露日 统一具名拒绝（availableAt 不编造）。
      rejections.push({ rowIndex, code: 'EMSURVEY_ROW_FIELDS_INVALID' });
      return;
    }
    if (window !== undefined && f.receiveIso < window.windowFromIso) {
      // 派发窗界外（近 2 年纪律在映射层执行）：原件保留、不入事实。
      outOfWindow.push({ rowIndex, receiveIso: f.receiveIso });
      return;
    }
    if ('CLOSE_PRICE' in row || 'CHANGE_RATE' in row) {
      // 前视泄漏防线：行情快照列属抓取时点当前行情，绝不入事实（桥应已剔除，双保险）。
      rejections.push({ rowIndex, code: 'EMSURVEY_ROW_QUOTE_COLUMN_LEAK' });
      return;
    }
    const typedValue: SurveyRow = { ...row, code };
    const numbernew = row[SURVEY_NUMBERNEW_FIELD];
    const numbernewKey = numbernew === null || numbernew === undefined ? '' : String(numbernew);
    const objectKey = `${f.receiveIso}|${f.noticeIso}|${numbernewKey}`;
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'SURVEY_RECORD',
        subjectId: code,
        objectKey,
        raw: row,
      }),
      subjectType: 'STOCK',
      subjectId: code,
      factKind: 'SURVEY_RECORD',
      typedValue,
      validFrom: shanghaiDayStart(f.receiveIso),
      validTo: null,
      eventAt: shanghaiDayStart(f.receiveIso),
      sourcePublishedAt: shanghaiDayStart(f.noticeIso),
      firstObservedAt: ctx.fetchedAt,
      availableAt: shanghaiNextDayStart(f.noticeIso),
      supersedesFactId: null,
      artifactSha256: ctx.artifactSha256,
      adapterVersion: ctx.adapterVersion,
    };
    facts.push({ fact, objectKey });
  });
  return { facts, rejections, outOfWindow };
}

// ===== 桥执行器（docker run 容器化 python，与 eminstitution 同法）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface SurveyBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emsurvey/bridge.py。 */
export function makeSurveyBridgeExecutor(opts: SurveyBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emsurvey/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMSURVEY_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMSURVEY_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMSURVEY_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMSURVEY_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface SurveyAdapterOptions {
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

export type SurveyResource = 'survey';

export interface SurveyFetchResult {
  adapterVersion: string;
  command: string;
  params: string[];
  /** 恢复位置（断点）：emsurvey:survey:<code>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  /** 桥月度块自校验后仍缺失的行数（来源分页漂移残余；0=窗口内零缺失，如实申报）。 */
  gapRows: number;
  /** 派发窗界（近 2 年）外行数（原件保留、不入事实）。 */
  windowExcludedRows: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4，原样携带）。 */
  notices: string[];
}

export class SurveyAdapter {
  readonly adapterVersion = EMSURVEY_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;
  private readonly root: string;

  constructor(opts: SurveyAdapterOptions) {
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
      makeSurveyBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: this.root,
      });
  }

  /**
   * 个股调研明细近窗（窗界=windowFromIso，事件=接待日 ≥ 窗界入事实；桥以 sinceExclusive=
   * 窗界前一日严格大于过滤，映射层窗界二次执行为纵深防御——窗外行具名计数）。rows 空集=
   * 近窗无调研记录，如实空原件入档、计 0 事实（不报错、不造数；pool-financials 冻结口径先例）。
   */
  async fetchSurvey(code: string, windowFromIso: string): Promise<SurveyFetchResult> {
    requireBareCode(code);
    // 日历真实日期校验（形态 + 往返一致；'2024-13-40' 等伪日期具名拒绝，不发桥调用）。
    const asUtc = new Date(`${windowFromIso}T00:00:00Z`);
    const validIso = ISO_DATE_RE.test(windowFromIso) && !Number.isNaN(asUtc.getTime())
      && asUtc.toISOString().slice(0, 10) === windowFromIso;
    if (!validIso) {
      throw new AdapterError('EMSURVEY_SINCE_INVALID', `windowFromIso=${windowFromIso}（须 YYYY-MM-DD 真实日历日期）`);
    }
    const sinceExclusive = new Date(asUtc.getTime() - 86_400_000).toISOString().slice(0, 10);
    const sinceCompact = sinceExclusive.replaceAll('-', '');
    return this.fetch('survey', [code, sinceCompact], {
      resource: 'survey',
      objectKey: code,
      map: (rows, ctx) => mapSurveyRowsToFacts(code, rows, ctx, { windowFromIso }),
    });
  }

  private async fetch(
    command: string,
    params: string[],
    spec: {
      resource: SurveyResource;
      objectKey: string;
      map: (rows: SurveyRow[], ctx: SurveyMapContext) => SurveyRowMapping;
    },
  ): Promise<SurveyFetchResult> {
    const scope = `emsurvey:${spec.resource}:${spec.objectKey}`;
    // 抓取 + 桥合同校验都在退避内：瞬态坏响应（含来源 9701 繁忙）按 §7 退避重试
    // （30s/60s/120s）；3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff(() => this.execBridge([command, ...params]), {
        adapter: 'emsurvey',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = (response.rows ?? []) as unknown as SurveyRow[];
    const meta = (response as { meta?: Record<string, unknown> }).meta;
    const gapRows = typeof meta?.gapTotal === 'number' ? meta.gapTotal : 0;
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
      // 登记记录事实不接 supersedes（LHB 先例，文件头语义边界）；并发竞态兜底：
      // 另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status: InsertFactStatus = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'emsurvey', scope);
    return {
      adapterVersion: this.adapterVersion,
      command,
      params,
      scope,
      artifact,
      rowCount: rows.length,
      gapRows,
      windowExcludedRows: mapped.outOfWindow.length,
      insertedFactIds,
      identicalFactIds,
      rejectedRows: mapped.rejections,
      notices: [BACKFILL_REVISION_NOTICE],
    };
  }
}
