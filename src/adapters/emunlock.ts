/**
 * Lyra · 限售解禁批次明细（东财 datacenter）适配器（P2 W42: code-writer，C4）。
 * 合同：docs/specs/DATA-SOURCES.md §6（适配器规则：取数→解析→原件入库→事实映射）、
 * §7（限流退避，复用 ./backoff.ts 只读依赖）、§5（修订口径声明 R4 随行）；
 * 时点语义 docs/specs/POINT-IN-TIME.md §2/§3。C4 派发：事件库 SHARE_UNLOCK 已标题级
 * （178 例），本面补明细股数/金额充实参照库样本；接线预留（research inputs 侧后续接入，
 * 本任务不改 inputs.ts）。
 *
 * 来源（W42 探测实测 2026-10-25，容器 akshare 1.19.3，证据 var/w42-probe{,2,3}.py）：
 * - queue：ak.stock_restricted_release_queue_em(symbol=<6 位码>)——东财 datacenter-web
 *   RPT_LIFT_STAGE 个股限售解禁批次，单 HTTP 请求 pageSize=500 pageNumber=1、无分页循环
 *   → **按个股全历史形态**（C4 派发选型，选型依据见 adapters/emunlock/bridge.py 文件头：
 *   summary_em 市场级汇总无个股明细、detail_em 全市场按日分页不占优、stockholder_em 调用
 *   量超边界）。列（剔除 akshare 重排序号 后 12）：解禁时间/解禁股东数/解禁数量/
 *   实际解禁数量/未解禁数量/实际解禁数量市值/占总市值比例/占流通市值比例/解禁前一交易日
 *   收盘价/限售股类型/解禁前20日涨跌幅/解禁后20日涨跌幅。
 * - 单位（akshare 换算后原样保留）：股数列 = 股（来源原始万股 ×10000）、市值列 = 元
 *   （来源原始万元 ×10000）。
 * - 来源行无股票代码列（akshare 重命名时丢弃 SECURITY_CODE）→ 代码 = 调用参数绑定
 *   （subjectFilter 不适用：每调用单股绑定），map context 注入 typedValue.code，raw 不掺
 *   合成列。来源行无公告日列（实测 announce_like_cols=[]）→ availableAt 保守口径（下）。
 * - 实测样本：603986 全历史 23 行（2017-08-18~2025-12-22）；002384 7 行（2010-07-09~
 *   2028-06-28）；600176 5 行（2014-08-04~2030-07-01）；600036 0 行（东财该报告无此股
 *   记录——空结果如实入档非失败）。含**未来未到期批次**（如 2030-07-01，其解禁前/后
 *   20 日涨跌幅实测为空、收盘价为预置暂态值）。
 *
 * 事实种类（派发冻结）：
 * - UNLOCK_DETAIL：一行 = 一个解禁批次（股票 × 解禁日 × 股数 × 限售股类型）。
 *   解禁为**预先公告**的日程事件，但来源无公告日列 → 派发冻结规则 availableAt =
 *   min(公告日, 解禁日)+1 在无公告日时塌缩为 **解禁日次日 00:00+08**（保守：不在解禁日
 *   前宣称可得，as-of 解禁日前不可见）；eventAt=解禁日 15:00+08（解禁生效日时点标记）。
 *   typedValue 仅保留事件白名单（解禁数量/实际解禁数量/未解禁数量/实际解禁数量市值/
 *   占总市值比例/占流通市值比例/限售股类型等——C4 核心的股数/金额字段）+
 *   unlockDateISO/code 归一。未来批次的市场衍生字段为抓取时点快照，到期后来源刷新、
 *   事件白名单变化 → 新事实快照（同业务键不同值并存），不接 supersedes 链（同 emblock 先例，
 *   修正不覆盖原件见 POINT-IN-TIME §6）；akshare 生成的 序号 列为调用内 reset_index
 *   重排序号（随批次漂移），桥侧剔除——同业务键重放 raw 稳定 → 同 factId → IDENTICAL
 *   （DATA-SOURCES §6.5 去重）。
 *
 * subjectId 裸码（R24 裁定）：subjectType/subjectId 复用 ./baostock.ts 的
 * normalizeCode/classifySubject。范围 = 冻结池 26 股（C4 派发冻结；ETF 无解禁面，
 * 不在本适配器范围）。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { ArtifactRef, TimePointFact, TimePointSubjectType } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { asOfFacts, insertFact, loadFact } from '../pintime/facts.js';
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

export const EMUNLOCK_ADAPTER_VERSION = 'emunlock@p2-pit';

/** 来源整行含事后收益；历史事件材料只允许下列字段（旧事实读取同样应用）。 */
export const UNLOCK_EVENT_FIELDS = [
  '解禁时间', '解禁股东数', '解禁数量', '实际解禁数量', '未解禁数量',
  '实际解禁数量市值', '占总市值比例', '占流通市值比例',
  '解禁前一交易日收盘价', '限售股类型', '解禁前20日涨跌幅',
] as const;

export function unlockEventFields(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(UNLOCK_EVENT_FIELDS.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]));
}

/**
 * 东财 datacenter 单页行数上限（akshare queue_em 无分页循环，pageSize=500 pageNumber=1）。
 * 桥返回行数达到该值即疑似静默截断 → 具名错误（非瞬态：不重试；实测池内单股最多 23 行，
 * 远低于上限）。
 */
export const EMUNLOCK_SINGLE_PAGE_CEILING = 500;

/** 限售解禁口径注记（DATA-SOURCES §5 形态；availableAt 近似声明过的）。 */
export const EMUNLOCK_REVISION_NOTICE =
  '限售解禁口径注记：数据为东财 datacenter 当前口径回填；availableAt=validFrom=解禁日次日 ' +
  '00:00+08（解禁为预先公告的日程事件，来源无公告日列——2026-10-25 实测——派发冻结规则 ' +
  'min(公告日,解禁日)+1 塌缩为解禁日+1，保守不在解禁日前宣称可得）；eventAt=解禁日 15:00+08；' +
  '股数列单位=股、市值列单位=元（akshare 由来源原始万股/万元 ×10000 换算）；akshare 生成的 ' +
  '序号 列为调用内重排序号（非来源数据），桥侧剔除；来源行无股票代码列，代码为调用参数绑定' +
  '（typedValue.code 注入，raw 不掺合成列）；未来未到期批次的市场衍生字段（收盘价/解禁前' +
  '20日涨跌幅）按事件白名单保留；解禁后20日涨跌幅仅在逐日交易日历完整且20交易日窗口成熟后，' +
  '写独立 UNLOCK_OUTCOME，availableAt=max(成熟收盘时刻,取得时刻)，不进入事件材料。缺日历则只留原件，' +
  '不猜成熟时间。当前修订回填不等于严格历史PIT；东财无记录的股票空结果如实入档，不造数。';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^\d{6}$/;

/** 裸码校验（调用参数绑定用）。 */
export function requireBareCode(code: string): string {
  if (!CODE_RE.test(code)) throw new AdapterError('EMUNLOCK_CODE_INVALID', `code=${code}（须 6 位裸码）`);
  return code;
}

// ===== 行映射（纯函数，单测 fixture 注入）=====

/** 桥响应行（来源字段保留原生类型：数值 number、日期字符串）。 */
export type EmUnlockRow = Record<string, unknown>;

export interface EmUnlockMapContext {
  adapterVersion: string;
  fetchedAt: string;
  artifactSha256: string;
  /** 成熟窗口证明：包含非交易日的逐日日历；缺失时不发布事后收益事实。 */
  calendarFacts?: readonly TimePointFact[];
}

function unlockMaturity(date: string, ctx: EmUnlockMapContext): { at: string; factIds: string[] } | null {
  const days = new Map<string, { trading: boolean; id: string }>();
  const conflicts = new Set<string>();
  for (const f of ctx.calendarFacts ?? []) {
    if (f.factKind !== 'TRADE_CALENDAR' || f.subjectType !== 'RULE' || f.subjectId !== 'ashare-calendar' ||
        Date.parse(f.availableAt) > Date.parse(ctx.fetchedAt) || Date.parse(f.firstObservedAt) > Date.parse(ctx.fetchedAt)) continue;
    const v = f.typedValue as Record<string, unknown>;
    if (typeof v.calendar_date !== 'string' || !DATE_RE.test(v.calendar_date) || !['0', '1'].includes(String(v.is_trading_day))) continue;
    const trading = String(v.is_trading_day) === '1';
    if (days.has(v.calendar_date) && days.get(v.calendar_date)!.trading !== trading) conflicts.add(v.calendar_date);
    days.set(v.calendar_date, { trading, id: f.factId });
  }
  const factIds: string[] = [];
  let tradingDays = 0;
  // 完整逐日日历证明；不以工作日或20个自然日冒充20个交易日。
  for (let ms = Date.parse(`${date}T00:00:00Z`) + 86_400_000; ms <= Date.parse(ctx.fetchedAt); ms += 86_400_000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const row = days.get(day);
    if (row === undefined || conflicts.has(day)) return null;
    factIds.push(row.id);
    if (row.trading && ++tradingDays === 20) {
      const at = shanghaiClose(day);
      return Date.parse(at) <= Date.parse(ctx.fetchedAt) ? { at, factIds } : null;
    }
  }
  return null;
}

export interface EmUnlockMappedFact {
  fact: TimePointFact;
  objectKey: string;
}

export interface EmUnlockRowMapping {
  facts: EmUnlockMappedFact[];
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
  return 'emu-' + canonicalSha256({
    adapter: args.adapterVersion,
    kind: args.factKind,
    subject: `${args.subjectType}:${args.subjectId}`,
    key: args.objectKey,
    raw: args.raw,
  });
}

/**
 * 业务键素材（对象标识）：解禁日 × 解禁数量 × 实际解禁数量 × 限售股类型 × 解禁股东数 ×
 * 未解禁数量。同日多批次（不同限售股类型/股数）靠组合区分；完全重复业务键行合并为一条
 * 事实（notices 注记）。
 */
function objectKeyOf(iso: string, row: EmUnlockRow): string {
  const keyParts = [
    row['解禁数量'],
    row['实际解禁数量'],
    row['限售股类型'],
    row['解禁股东数'],
    row['未解禁数量'],
  ];
  return `${iso}:${JSON.stringify(keyParts)}`;
}

/**
 * 限售解禁批次行 → UNLOCK_DETAIL 事实（一行 = 一个批次；code 为调用参数绑定）。
 * availableAt=validFrom=解禁日次日 00:00+08（派发冻结保守口径：来源无公告日列）；
 * eventAt=解禁日 15:00+08（解禁生效日时点标记）；typedValue 只保留事件白名单
 * （股数/金额/比例/限售股类型等）+ unlockDateISO/code 归一；factId 不含观察时刻
 * （终局窗口去重）。
 */
export function mapUnlockRowsToFacts(
  rows: EmUnlockRow[],
  boundCode: string,
  ctx: EmUnlockMapContext,
): EmUnlockRowMapping {
  const bsCode = normalizeCode(boundCode);
  const { subjectType, subjectId } = classifySubject(bsCode);
  const facts: EmUnlockMappedFact[] = [];
  const rejections: { rowIndex: number; code: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const date = row['解禁时间'];
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      rejections.push({ rowIndex, code: 'EMUNLOCK_ROW_DATE_INVALID' });
      return;
    }
    const eventT = shanghaiClose(date); // 解禁日 15:00+08（生效日时点标记）
    const availT = shanghaiNextDayStart(date); // 解禁日次日 00:00+08（派发冻结保守可得）
    const objectKey = objectKeyOf(date, row);
    const typedValue = { ...unlockEventFields(row), unlockDateISO: date, code: bsCode };
    const fact: TimePointFact = {
      factId: factIdOf({
        adapterVersion: ctx.adapterVersion,
        factKind: 'UNLOCK_DETAIL',
        subjectType,
        subjectId,
        objectKey,
        raw: typedValue,
      }),
      subjectType,
      subjectId,
      factKind: 'UNLOCK_DETAIL',
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
    const outcome = row['解禁后20日涨跌幅'];
    const present = outcome !== null && outcome !== undefined && outcome !== '';
    const numeric = (typeof outcome === 'number' && Number.isFinite(outcome)) ||
      (typeof outcome === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(outcome) && Number.isFinite(Number(outcome)));
    if (present && !numeric) rejections.push({ rowIndex, code: 'EMUNLOCK_OUTCOME_INVALID' });
    const maturity = numeric ? unlockMaturity(date, ctx) : null;
    if (maturity !== null) {
      const value = {
        code: bsCode, unlockDateISO: date, eventFactId: fact.factId,
        horizonTradingDays: 20, maturedAt: maturity.at,
        calendarFactIds: maturity.factIds, '解禁后20日涨跌幅': outcome,
      };
      facts.push({
        objectKey: `${objectKey}:outcome20`,
        fact: {
          ...fact,
          factId: factIdOf({ adapterVersion: ctx.adapterVersion, factKind: 'UNLOCK_OUTCOME', subjectType, subjectId, objectKey, raw: value }),
          factKind: 'UNLOCK_OUTCOME', typedValue: value,
          validFrom: maturity.at, eventAt: maturity.at,
          availableAt: new Date(Math.max(Date.parse(maturity.at), Date.parse(ctx.fetchedAt))).toISOString(),
        },
      });
    }
  });
  return { facts, rejections };
}

// ===== 桥执行器（docker run 容器化 python）=====

export interface EmUnlockBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

/** 真实执行器：docker run --rm + akshare 卷 + 工程 mount，跑 adapters/emunlock/bridge.py。 */
export function makeEmUnlockBridgeExecutor(opts: EmUnlockBridgeExecutorOptions = {}): BridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/emunlock/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('EMUNLOCK_DOCKER_MISSING', dockerPath);
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
      if (killed) throw new TransientAdapterError('EMUNLOCK_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'EMUNLOCK_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      const code = parsed.error_code ?? 'EMUNLOCK_QUERY_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

export interface EmUnlockAdapterOptions {
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

export type EmUnlockResource = 'queue';

export interface EmUnlockFetchResult {
  adapterVersion: string;
  resource: EmUnlockResource;
  params: string[];
  /** 恢复位置（断点）：emunlock:<resource>:<code>。 */
  scope: string;
  artifact: ArtifactRef;
  rowCount: number;
  insertedFactIds: string[];
  identicalFactIds: string[];
  rejectedRows: { rowIndex: number; code: string }[];
  /** DATA-SOURCES §5 修订口径声明原文（R4 + 面内注记，原样携带）。 */
  notices: string[];
}

export class EmUnlockAdapter {
  readonly adapterVersion = EMUNLOCK_ADAPTER_VERSION;
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly gate: ConcurrencyGate;
  private readonly execBridge: BridgeExecutor;
  private readonly now: () => Date;
  private readonly backoffSleeper: BackoffSleeper | undefined;
  private readonly backoffAttempts: number | undefined;
  private readonly backoffBaseDelayMs: number | undefined;

  constructor(opts: EmUnlockAdapterOptions) {
    this.pool = opts.pool;
    this.store = opts.store;
    this.gate = opts.gate ?? new ConcurrencyGate(1); // 单来源串行稳妥默认（同 emdc/emblock 先例）
    this.now = opts.now ?? (() => new Date());
    this.backoffSleeper = opts.backoffSleeper;
    this.backoffAttempts = opts.backoffAttempts;
    this.backoffBaseDelayMs = opts.backoffBaseDelayMs;
    this.execBridge =
      opts.execBridge ??
      makeEmUnlockBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: opts.repoRootPath,
      });
  }

  /**
   * 东财个股限售解禁批次全历史（单股单调用；code 为 6 位裸码调用参数绑定）。
   * rows 达单页上限即疑似静默截断 → 具名永久错误（不重试）。空结果（来源无记录）
   * 如实返回 rowCount=0 + 空原件（非失败）。
   */
  async fetchUnlockQueue(code: string): Promise<EmUnlockFetchResult> {
    const bare = requireBareCode(code);
    return this.fetchBridge('queue', [bare], {
      resource: 'queue',
      objectKey: bare,
      boundCode: bare,
    });
  }

  private async fetchBridge(
    command: string,
    params: string[],
    spec: {
      resource: EmUnlockResource;
      objectKey: string;
      boundCode: string;
    },
  ): Promise<EmUnlockFetchResult> {
    const scope = `emunlock:${spec.resource}:${spec.objectKey}`;
    // 桥调用 + 输出可解析都在退避内：东财侧瞬态失败按 §7 退避（30s/60s/120s），
    // 3 次仍失败 → 暂停上报落库（EK-7.3 四要素，同 scope 幂等覆盖）。
    const response = await this.gate.run(() =>
      runWithBackoff((attempt) => this.execBridge([command, ...params]), {
        adapter: 'emunlock',
        scope,
        pool: this.pool,
        sleeper: this.backoffSleeper,
        attempts: this.backoffAttempts,
        baseDelayMs: this.backoffBaseDelayMs,
      }),
    );
    const rows = response.rows ?? [];
    // 单页上限守卫：akshare queue_em 无分页循环，行数达上限即疑似静默截断——
    // 具名永久错误（不写原件不入事实，不重试）。
    if (rows.length >= EMUNLOCK_SINGLE_PAGE_CEILING) {
      throw new AdapterError(
        'EMUNLOCK_SUSPECTED_TRUNCATION',
        `rows=${String(rows.length)} ≥ 单页上限 ${String(EMUNLOCK_SINGLE_PAGE_CEILING)}（queue_em 无分页循环）`,
      );
    }
    const fetchedAt = this.now().toISOString();
    // 原件 = 桥 stdout 的 rows 规范化 JSON（单股原样；序号 已在桥侧剔除——随批次漂移的
    // akshare 产物，非来源数据）。
    const bytes = new TextEncoder().encode(canonicalJsonString(rows));
    const artifact = await this.store.put(bytes, 'application/json', fetchedAt);
    const mapped = mapUnlockRowsToFacts(rows, spec.boundCode, {
      adapterVersion: this.adapterVersion,
      fetchedAt,
      artifactSha256: artifact.sha256,
      calendarFacts: await asOfFacts(this.pool, { subjectType: 'RULE', subjectId: 'ashare-calendar', factKind: 'TRADE_CALENDAR', asOf: new Date(fetchedAt) }),
    });
    const insertedFactIds: string[] = [];
    const identicalFactIds: string[] = [];
    for (const m of mapped.facts) {
      const existing = await loadFact(this.pool, m.fact.factId);
      if (existing !== null) {
        // 终局窗口同 factId 先写为准（emdc/emblock 先例）：factId 不含观察时刻，跨次抓取
        // firstObservedAt/artifact 不同但身份同 → 计 identical 不再插入（§6.5 去重）。
        identicalFactIds.push(m.fact.factId);
        continue;
      }
      // 并发竞态兜底：另一在途请求先插同 factId 时，insertFact 原子返回 IDENTICAL。
      const status = await insertFact(this.pool, m.fact);
      (status === 'INSERTED' ? insertedFactIds : identicalFactIds).push(m.fact.factId);
    }
    await resumePause(this.pool, 'emunlock', scope);
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
      notices: [BACKFILL_REVISION_NOTICE, EMUNLOCK_REVISION_NOTICE],
    };
  }
}
