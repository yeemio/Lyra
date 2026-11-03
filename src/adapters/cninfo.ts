/**
 * Lyra · 巨潮资讯网公告元数据适配器（P1 W5: code-writer）。
 * 合同：docs/specs/DATA-SOURCES.md §2.1/§6/§7、docs/specs/POINT-IN-TIME.md §2/§3、docs/specs/P1-DATA.md Done-when 1/6。
 * adapterVersion：'cninfo@p1'（数据与适配器版本轴，独立版本号）。
 *
 * 有界探测登记（2026-10-25，共 3 次真实请求）：
 * - orgId：POST /new/information/topSearch/query（keyWord=代码）→ JSON 数组行
 *   {code, pinyin, sjstsBond, category, type, delisted, orgId, zwjc}；600519 → gssh0600519。
 * - 公告查询：POST /new/hisAnnouncement/query（form-urlencoded），column=sse|szse、plate=sh|sz、
 *   stock=<code>,<orgId>、seDate=YYYY-MM-DD~YYYY-MM-DD、pageSize≤30、pageNum 翻页。
 *   响应顶层键（实测）：classifiedAnnouncements, totalSecurities, totalAnnouncement,
 *   totalRecordNum, announcements, categoryList, hasMore, totalpages。
 * - announcements[] 元素键（实测清单，见 CnInfoAnnouncementMeta 注释）。
 * - adjunctUrl 为相对路径（finalpage/YYYY-MM-DD/<id>.PDF），PDF 前缀 http://static.cninfo.com.cn/。
 * - announcementTime 为毫秒时间戳（CST 语义）。精度混合：多数为 00:00:00 CST（日精度元数据），
 *   少数带盘中时刻（实测 17:05:47 / 18:38:10 CST）→ availableAt 按两类分别处理：
 *   有时刻按时刻（POINT-IN-TIME §3.1）；日精度保守按 D+1 开盘前——默认策略跳周末取次一
 *   周一至周五的 08:00 CST（与 P0 旅程夹具 D+1 00:00 UTC 同口径）。A 股法定节假日不在默认
 *   策略内（登记为已知近似，见 defaultDayPrecisionAvailableAt）；精确交易日历策略可经
 *   dayPrecisionPolicy 注入（W6 calendar 落地后由 runner 接线）。
 *
 * 退避：可恢复错误等待 30s/60s/120s 重试至少 3 次（DATA-SOURCES §7 / EK-7，与共享退避器
 * src/adapters/backoff.ts 的 runWithBackoff 同语义），仍失败则暂停上报（四要素：已重试次数、
 * 最后错误、恢复位置、唯一下一步动作）。暂停载体（R21 落库裁定；REVISION-LOG"P1 集成裁定"
 * 第 2 条集成债 2026-10-25 回工统一）：注入 pool 时经共享 recordPause 落 adapter_pause_report
 * （adapter='cninfo@p1'，scope=恢复位置断点）；缺省不落库仅 console.error（向后兼容）。
 * 原 l1-pause.json 文件载体已移除。测试经 sleepImpl/fetchImpl 注入，不碰网络。
 */
import type { ArtifactRef, TimePointFact } from '../contracts.js';
import { ArtifactStore } from '../artifacts/store.js';
import type { Pool } from 'pg';
import { recordPause } from './backoff.js';

export const CNINFO_ADAPTER_VERSION = 'cninfo@p1';
/** factId 版本段：适配器合同变更 → 新 fact_id（POINT-IN-TIME §4），旧事实保留。 */
const FACT_ID_VERSION_TAG = CNINFO_ADAPTER_VERSION.split('@')[1] ?? CNINFO_ADAPTER_VERSION;

const QUERY_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
const TOP_SEARCH_URL = 'http://www.cninfo.com.cn/new/information/topSearch/query';
const PDF_BASE_URL = 'http://static.cninfo.com.cn/';

const REQUEST_TIMEOUT_MS = 30_000;
/** DATA-SOURCES §7：约 30s 起步逐次加倍，至少重试 3 次；仍失败暂停上报。 */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
const CST_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** CST 零点 = UTC 前一日 16:00（毫秒对 86400000 取模的余数）。 */
const CST_MIDNIGHT_REMAINDER_MS = 16 * 3_600_000;

/** 巨潮适配器具名错误。retryable=true 表示按 DATA-SOURCES §7 退避重试。 */
export class CninfoError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
    readonly retryable = false,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'CninfoError';
  }
}

/** 暂停上报（DATA-SOURCES §7 四要素）。达重试上限后抛出；采集任务状态为暂停而非 FAILED。 */
export class CnInfoPauseError extends Error {
  constructor(
    readonly report: {
      retried: number;
      lastError: string;
      resumePoint: unknown;
      nextAction: string;
    },
  ) {
    super(
      `CNINFO_PAUSED retried=${report.retried} lastError=${report.lastError} ` +
        `resumePoint=${JSON.stringify(report.resumePoint)} nextAction=${report.nextAction}`,
    );
    this.name = 'CnInfoPauseError';
  }
}

/** postWithRetry 的恢复位置（断点）形状；同时是 adapter_pause_report scope 的取值来源。 */
export type CnInfoResumePoint =
  | { step: 'topSearch'; code: string }
  | { step: 'hisAnnouncement'; code: string; seDate: string; pageNum: number };

/**
 * 暂停上报 scope（adapter_pause_report.scope：恢复位置断点，adapter:resource:对象标识语义）。
 * runner（src/backfill/l1.ts）段成功后用同一函数构造 scope 调 resumePause 置 RESUMED，
 * 保证两侧 scope 字符串单一来源、不会漂移。
 */
export function cninfoPauseScope(resumePoint: CnInfoResumePoint): string {
  if (resumePoint.step === 'topSearch') return `cninfo:topSearch:${resumePoint.code}`;
  return `cninfo:hisAnnouncement:${resumePoint.code}:${resumePoint.seDate}:${resumePoint.pageNum}`;
}

// ===== 来源响应形态（探测登记，字段原样保留，不做业务改写）=====

/** announcements[] 元素实测键：id, secCode, secName, orgId, announcementId, announcementTitle,
 *  announcementTime, adjunctUrl, adjunctSize, adjunctType, storageTime, columnId, pageColumn,
 *  announcementType, associateAnnouncement, important, batchNum, announcementContent, orgName,
 *  tileSecName, shortTitle, announcementTypeName, secNameList（未知字段忽略，已知字段不重命名）。 */
export interface CnInfoAnnouncementMeta {
  announcementId?: string | number | undefined;
  announcementTitle?: string | null;
  announcementTime?: number | string | null;
  adjunctUrl?: string | null;
  adjunctSize?: number | string | null;
  announcementType?: string | null;
  secCode?: string | null;
  secName?: string | null;
  orgId?: string | null;
  [key: string]: unknown;
}

export interface CnInfoPageRaw {
  announcements?: CnInfoAnnouncementMeta[] | null;
  hasMore?: boolean | null;
  totalAnnouncement?: number | null;
  totalRecordNum?: number | null;
  totalpages?: number | null;
  [key: string]: unknown;
}

export interface AnnouncementPage {
  raw: CnInfoPageRaw;
  announcements: CnInfoAnnouncementMeta[];
  /** 本页原始 JSON bytes 的原件引用（first_observed_at 为实际抓取时刻）。 */
  artifact: ArtifactRef;
  /** 本页映射出的时点事实（TIMEPOINT 契约见 POINT-IN-TIME §2）。 */
  facts: TimePointFact[];
}

// ===== 代码分类（R17：仅沪深主板；创业板/科创板/北交所/ETF 拒绝）=====

export interface CnInfoCodeClass {
  column: 'sse' | 'szse';
  plate: 'sh' | 'sz';
  subjectType: 'STOCK';
}

/** 沪主板 600/601/603/605、深主板 000/001/003；其余（30x 创业板、68x 科创板、51x/15x ETF 等）返回 null。 */
export function classifyCninfoCode(code: string): CnInfoCodeClass | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (/^(600|601|603|605)\d{3}$/.test(code)) return { column: 'sse', plate: 'sh', subjectType: 'STOCK' };
  if (/^(000|001|002|003)\d{3}$/.test(code)) return { column: 'szse', plate: 'sz', subjectType: 'STOCK' }; // 002 原中小板，2021 并入深主板（R17）
  return null;
}

/** PDF 原文地址（L2 用；L1 只存元数据，不抓 PDF 本体——DATA-SOURCES §4 三层分层）。 */
export function pdfUrlOf(adjunctUrl: string): string {
  return PDF_BASE_URL + adjunctUrl.replace(/^\//, '');
}

// ===== 时间映射（POINT-IN-TIME §3.1）=====

/** 判定 announcementTime 是否为 CST 零点（日精度元数据）。 */
export function isDayPrecisionCst(ms: number): boolean {
  return ((ms % DAY_MS) + DAY_MS) % DAY_MS === CST_MIDNIGHT_REMAINDER_MS;
}

/**
 * 日精度公告的保守 available_at（默认策略）：公告日 D 的次一周一至周五 08:00 CST。
 * 已知近似（如实登记）：A 股法定节假日未处理——D+1 落在节假日时默认策略早于真实
 * "次一交易日开盘前"。精确策略经 dayPrecisionPolicy 注入（W6 交易日历）后替换，
 * 替换属适配器新版本语义，历史事实不重写。
 */
export function defaultDayPrecisionAvailableAt(publishedMs: number): string {
  const nextDayCstMidnight = publishedMs + DAY_MS;
  // 用 D+1 的 CST 日历日判星期：加偏移后 UTC 分量即 CST 分量
  const dow = new Date(nextDayCstMidnight + CST_OFFSET_MS).getUTCDay();
  const shift = dow === 6 ? 2 : dow === 0 ? 1 : 0; // 周六 +2、周日 +1 → 次周一
  const availableMs = nextDayCstMidnight + shift * DAY_MS + CST_OFFSET_MS; // 08:00 CST = 00:00 UTC
  return new Date(availableMs).toISOString();
}

export interface AnnouncementTiming {
  precision: 'TIMED' | 'DAY';
  /** source_published_at：来源标注的 announcementTime 原样转 ISO（三类时间字段不互覆写）。 */
  publishedIso: string;
  /** available_at：有时刻按时刻；日精度按保守 D+1 开盘前（默认策略或注入策略）。 */
  availableIso: string;
}

export function announcementTiming(ms: number, dayPrecisionPolicy?: (publishedMs: number) => string): AnnouncementTiming {
  const publishedIso = new Date(ms).toISOString();
  if (!isDayPrecisionCst(ms)) {
    return { precision: 'TIMED', publishedIso, availableIso: publishedIso };
  }
  const availableIso = dayPrecisionPolicy !== undefined ? dayPrecisionPolicy(ms) : defaultDayPrecisionAvailableAt(ms);
  const available = new Date(availableIso);
  if (Number.isNaN(available.getTime())) throw new CninfoError('INVALID_AVAILABILITY_POLICY', availableIso);
  // 判定条款（POINT-IN-TIME §3.1）：日精度公告的 available_at 不得早于 D+1 开盘前——
  // 这里保守下界取 D+1 00:00 CST；策略输出早于该下界即拒绝。
  const floorMs = ms + DAY_MS;
  if (available.getTime() < floorMs) {
    throw new CninfoError('INVALID_AVAILABILITY_POLICY', `availableAt ${availableIso} earlier than D+1 floor`);
  }
  return { precision: 'DAY', publishedIso, availableIso: available.toISOString() };
}

// ===== 事实映射 =====

/**
 * 单条公告 → TimePointFact。
 * - factId 确定性：cninfo:ann:<announcementId>@<版本段>——同原件 + 同适配器版本重放同
 *   fact_id（POINT-IN-TIME §4）；适配器合同变更（新版本段）自然得到新 fact_id。
 * - typedValue：来源原生字段原样保存（DATA-SOURCES §6.2），含 title/adjunctUrl/
 *   announcementTime 原始值（派发要求）+ announcementId/secCode/secName/announcementType/adjunctSize。
 * - available_at = 事件时点（派发冻结）；source_published_at 独立保存来源标注时刻；
 *   first_observed_at 为实际抓取时刻。valid_from/valid_to 为 null（点事实）。
 */
export function mapAnnouncementToFact(
  announcement: CnInfoAnnouncementMeta,
  pageArtifactSha256: string,
  firstObservedAt: string,
  dayPrecisionPolicy?: (publishedMs: number) => string,
): TimePointFact {
  const rawTime = announcement.announcementTime;
  const ms = typeof rawTime === 'string' ? Number(rawTime) : rawTime;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new CninfoError('INVALID_ANNOUNCEMENT_TIME', String(rawTime));
  }
  const announcementId = announcement.announcementId === undefined || announcement.announcementId === null
    ? undefined
    : String(announcement.announcementId);
  if (announcementId === undefined || announcementId.length === 0) {
    throw new CninfoError('INVALID_ANNOUNCEMENT_ID', String(announcement.announcementId));
  }
  const subjectId = announcement.secCode ?? '';
  // 主板收窄一致性守卫（R17）：来源 secCode 越出沪深主板即拒绝，不映射
  if (classifyCninfoCode(subjectId) === null) {
    throw new CninfoError('INVALID_ANNOUNCEMENT_SUBJECT', subjectId);
  }
  const timing = announcementTiming(ms, dayPrecisionPolicy);
  return {
    factId: `cninfo:ann:${announcementId}@${FACT_ID_VERSION_TAG}`,
    subjectType: 'STOCK',
    subjectId,
    factKind: 'ANNOUNCEMENT',
    typedValue: {
      title: announcement.announcementTitle ?? '',
      adjunctUrl: announcement.adjunctUrl ?? '',
      announcementTime: ms, // 原始值（毫秒时间戳）
      announcementId,
      secCode: subjectId,
      secName: announcement.secName ?? '',
      announcementType: announcement.announcementType ?? '',
      adjunctSize: announcement.adjunctSize ?? null,
    },
    validFrom: null,
    validTo: null,
    eventAt: timing.availableIso,
    sourcePublishedAt: timing.publishedIso,
    firstObservedAt,
    availableAt: timing.availableIso,
    supersedesFactId: null,
    artifactSha256: pageArtifactSha256,
    adapterVersion: CNINFO_ADAPTER_VERSION,
  };
}

// ===== 适配器 =====

export interface CnInfoAdapterOptions {
  /** 原件库（只读依赖复用 src/artifacts/store.ts）。 */
  store: ArtifactStore;
  /** 注入点：默认全局 fetch（单测注入 fixture 响应体，不碰网络）。 */
  fetchImpl?: typeof fetch;
  /** 注入点：默认真实 sleep（单测注入即时 resolve 并记录时延）。 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 请求间最小间隔（主动节流，DATA-SOURCES §7 并发收敛为串行）。默认 2000ms。 */
  throttleMs?: number;
  /** 已废弃（R21 落库统一，2026-10-25 回工）：暂停上报不再写文件；字段仅为既有调用方
   *  （src/adapters/cninfo.smoke.ts，不在本回工可改范围）类型兼容保留，构造时忽略。 */
  pauseStatePath?: string;
  /** 注入点：提供时暂停上报经共享 recordPause 落 adapter_pause_report（R21）；
   *  缺省仅 console.error 不落库（向后兼容，纯函数式用法）。 */
  pool?: Pool;
  /** 日精度 available_at 策略注入（默认 defaultDayPrecisionAvailableAt）。 */
  dayPrecisionPolicy?: (publishedMs: number) => string;
  /** 注入点：默认 Date.now（单测固定 firstObservedAt）。 */
  nowImpl?: () => number;
}

export interface AnnouncementQuery {
  code: string;
  /** YYYY-MM-DD（含端点）。 */
  from: string;
  /** YYYY-MM-DD（含端点）。 */
  to: string;
  pageSize?: number;
  /** 最多拉取页数（ runaway 保护）。默认 400。 */
  maxPages?: number;
}

interface PostResult {
  status: number;
  text: string;
}

const DEFAULT_THROTTLE_MS = 2_000;
const DEFAULT_MAX_PAGES = 400;
const MAX_PAGE_SIZE = 30;

export class CnInfoAdapter {
  readonly adapterVersion = CNINFO_ADAPTER_VERSION;
  private readonly store: ArtifactStore;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throttleMs: number;
  private readonly pool: Pool | undefined;
  private readonly dayPrecisionPolicy: ((publishedMs: number) => string) | undefined;
  private readonly now: () => number;
  private readonly orgIdCache = new Map<string, string>();
  private lastRequestAt = 0;

  constructor(options: CnInfoAdapterOptions) {
    this.store = options.store;
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.pool = options.pool;
    this.dayPrecisionPolicy = options.dayPrecisionPolicy;
    this.now = options.nowImpl ?? Date.now;
  }

  /** 断点续跑用：注入上次运行解析好的 orgId，避免重跑重复 topSearch。 */
  seedOrgId(code: string, orgId: string): void {
    this.orgIdCache.set(code, orgId);
  }

  peekOrgId(code: string): string | undefined {
    return this.orgIdCache.get(code);
  }

  private async throttle(): Promise<void> {
    const gap = this.now() - this.lastRequestAt;
    const wait = this.throttleMs - gap;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      // 个人研究用途的低频访问；UA 如实标识为脚本访问
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'http://www.cninfo.com.cn',
      Referer: 'http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure_list/search',
    };
  }

  /**
   * 单一调用 + DATA-SOURCES §7 退避：可恢复错误（网络异常/超时/429/5xx/200 非约定 JSON）
   * 等待 30s/60s/120s 重试至少 3 次；仍失败 → 暂停上报（console.error；注入 pool 时经共享
   * recordPause 落 adapter_pause_report，R21）并抛 CnInfoPauseError。
   * 不可恢复错误（4xx 等）原样抛 CninfoError，不重试、不暂停。
   */
  private async postWithRetry(url: string, params: Record<string, string>, resumePoint: CnInfoResumePoint): Promise<PostResult> {
    let lastError: string = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay === undefined) break; // 不可达：循环边界已保证
        await this.sleep(delay);
      }
      try {
        await this.throttle();
        const response = await this.doFetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: new URLSearchParams(params).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = `HTTP ${response.status}`;
          continue; // 可恢复：退避重试
        }
        if (response.status !== 200) {
          throw new CninfoError('SOURCE_HTTP', `HTTP ${response.status} from ${url}`); // 不可恢复
        }
        const text = await response.text();
        try {
          JSON.parse(text);
        } catch {
          lastError = 'HTTP 200 with non-JSON body';
          continue; // 疑似反爬拦截页：可恢复
        }
        return { status: response.status, text };
      } catch (error) {
        if (error instanceof CninfoError && !error.retryable) throw error;
        lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }
    const report = {
      retried: RETRY_DELAYS_MS.length,
      lastError,
      resumePoint,
      nextAction: '重跑同一 CLI（断点续跑跳过已完成段），从该 段×页 重试；恢复后先读回最后一步实际结果再续跑',
    };
    console.error(`[cninfo@p1] 暂停上报（DATA-SOURCES §7 四要素）：${JSON.stringify(report)}`);
    if (this.pool !== undefined) {
      try {
        await recordPause(this.pool, {
          adapter: CNINFO_ADAPTER_VERSION,
          scope: cninfoPauseScope(resumePoint),
          retries: report.retried,
          lastError: report.lastError,
        });
      } catch (recordError) {
        // 暂停信号优先：落库失败如实登记，不吞暂停也不冒充已落库（与 backoff.ts 同语义）。
        console.error(`[cninfo@p1] 暂停记录落库失败：${String(recordError)}`);
      }
    }
    throw new CnInfoPauseError(report);
  }

  /** orgId 解析（topSearch，进程内缓存；断点经 seedOrgId 注入复用）。 */
  async resolveOrgId(code: string): Promise<string> {
    const cached = this.orgIdCache.get(code);
    if (cached !== undefined) return cached;
    const result = await this.postWithRetry(
      TOP_SEARCH_URL,
      { keyWord: code, maxNum: '10' },
      { step: 'topSearch', code },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text) as unknown;
    } catch {
      throw new CninfoError('SOURCE_NONCONFORMING', `topSearch non-JSON for ${code}`);
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)
        ? ((parsed as { data: unknown[] }).data as unknown[])
        : [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as { code?: unknown; orgId?: unknown };
      if (record.code === code && typeof record.orgId === 'string' && record.orgId.length > 0) {
        this.orgIdCache.set(code, record.orgId);
        return record.orgId;
      }
    }
    throw new CninfoError('ORGID_NOT_FOUND', `topSearch returned no orgId for ${code}`);
  }

  /** 拉取一页公告元数据：响应体原件入库（first_observed_at = 抓取时刻）并映射事实。 */
  async fetchPage(query: {
    code: string;
    orgId: string;
    from: string;
    to: string;
    pageNum: number;
    pageSize?: number;
  }): Promise<AnnouncementPage> {
    const klass = classifyCninfoCode(query.code);
    if (klass === null) throw new CninfoError('CODE_OUT_OF_SCOPE', query.code);
    const pageSize = Math.min(query.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const result = await this.postWithRetry(
      QUERY_URL,
      {
        pageNum: String(query.pageNum),
        pageSize: String(pageSize),
        column: klass.column,
        tabName: 'fulltext',
        plate: klass.plate,
        stock: `${query.code},${query.orgId}`,
        searchkey: '',
        secid: '',
        category: '',
        trade: '',
        seDate: `${query.from}~${query.to}`,
        sortName: '',
        sortOrder: '',
        isHLtitle: 'true',
      },
      { step: 'hisAnnouncement', code: query.code, seDate: `${query.from}~${query.to}`, pageNum: query.pageNum },
    );
    const raw = JSON.parse(result.text) as CnInfoPageRaw;
    const announcements = Array.isArray(raw.announcements) ? raw.announcements : [];
    const observedIso = new Date(this.now()).toISOString();
    const artifact = await this.store.put(
      new TextEncoder().encode(result.text),
      'application/json',
      observedIso,
    );
    const facts: TimePointFact[] = [];
    for (const announcement of announcements) {
      facts.push(mapAnnouncementToFact(announcement, artifact.sha256, observedIso, this.dayPrecisionPolicy));
    }
    return { raw, announcements, artifact, facts };
  }

  /**
   * 段查询（股票 × 日期区间）：逐页拉取直到最后一页（不满足满页或 hasMore=false）或
   * maxPages 上限。页间经 throttle 串行节流（DATA-SOURCES §7：单来源串行）。
   */
  async fetchAnnouncements(query: AnnouncementQuery): Promise<AnnouncementPage[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
      throw new CninfoError('INVALID_DATE_RANGE', `${query.from}~${query.to}`);
    }
    if (query.from > query.to) throw new CninfoError('INVALID_DATE_RANGE', `${query.from} > ${query.to}`);
    const klass = classifyCninfoCode(query.code);
    if (klass === null) throw new CninfoError('CODE_OUT_OF_SCOPE', query.code);
    const orgId = await this.resolveOrgId(query.code);
    const pageSize = Math.min(query.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
    const pages: AnnouncementPage[] = [];
    let pageNum = 1;
    for (;;) {
      const page = await this.fetchPage({ code: query.code, orgId, from: query.from, to: query.to, pageNum, pageSize });
      pages.push(page);
      const more =
        page.announcements.length >= pageSize && page.raw.hasMore !== false && pageNum < maxPages;
      if (!more) break;
      pageNum += 1;
    }
    return pages;
  }
}
