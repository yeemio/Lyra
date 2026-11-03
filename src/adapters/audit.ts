/**
 * Lyra · 年报审计意见适配器（A 类 A5 / W32: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §2.1（PDF 原件经 CAS）、§6（适配器规则）、
 * docs/specs/POINT-IN-TIME.md §2/§3（五时间字段、availableAt）；
 * Gate-M 维度 7 风险项 coverage 实证缺口"审计意见未入库"（R11 后置项）。
 * adapterVersion：'audit@p1'（数据与适配器版本轴，独立版本号）。
 *
 * 分工（W32 冻结）：
 * - 桥 adapters/audit/bridge.py：PDF → 分页文本 → 审计节定位（锚点窗口），不回传全文本；
 * - 本文件：显式常量规则表判类 + 事实映射。规则表单一来源在 TS（可单测，合成文本注入）。
 *
 * 判类语义（派发冻结）：
 * - 五类：标准无保留意见 / 带强调事项段（或持续经营相关重大不确定性）的无保留意见 /
 *   保留意见 / 无法表示意见 / 否定意见；按优先级从强到弱匹配关键词序列，取窗口内首个命中；
 * - 多窗口命中冲突或零命中 → UNDETERMINED（如实入库不猜，带全部候选摘录）；
 * - 无任何审计节锚点窗口 → NO_AUDIT_SECTION（不产事实；季报/半年报跳过——只处理年报）。
 *
 * 实测依据（W32 探测 2026-10-25，600519 2018/2023 + 000657 2015，证据见桥文件头）：
 * - 新式年报（2019+）意见节窗口（"一、审计意见"后）不含"无保留意见"字样，判类关键词在
 *   重要提示句"……出具了标准无保留意见的审计报告"——桥的后向锚覆盖；
 * - 旧式年报（2015 探测样本）财务报告节有"审计意见类型 标准无保留审计意见"摘要行——
 *   关键词变体"无保留审计意见"（无"意见"二字相邻）入规则表；
 * - pypdf 抽取会在词内插空白（"无保留 意见审计报告"）——匹配一律在去空白文本上进行，
 *   摘录取自去空白文本（确定性，去除的仅为换行/空格伪影）；
 * - "持续经营"在标准意见报告的责任段/关键审计事项亦出现（探测 11 次/份），且责任段模板
 *   同时含"发表非无保留意见"（否定式）与"是否存在重大不确定性"（假设式）——派发复合词
 *   "持续经营"+"无保留"的精确化：要求"持续经营"与"重大不确定性"同句邻接（≤40 字符）且
 *   排除"是否"假设式与"非"否定式（lookbehind），与准则原文"与持续经营相关的重大不确定
 *   性"对齐，避免责任段假阳性（实证：600519 2018 责任段窗口曾致 R4 误命中）。
 *
 * 时点语义：
 * - AUDIT_OPINION 事实 = 从年报 PDF 原文确定性抽取的审计意见类型点事实；
 * - availableAt = 年报 ANNOUNCEMENT 事实的 availableAt 原样复用（派发冻结：年报披露日
 *   次日口径由 cninfo@p1 的 D+1 策略产出，此处不重复推导）；eventAt 同值；点事实
 *   validFrom/validTo 为 null；
 * - artifactSha256 = 年报 PDF 的 CAS 哈希（原件即证据）；announcementFactId 绑定进
 *   typedValue 作证据（派发要求）；
 * - UNDETERMINED 如实入库（typedValue.类型 = 'UNDETERMINED'，候选摘录随行）。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalSha256 } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import { AdapterError, TransientAdapterError } from './adapter-types.js';

const execFileAsync = promisify(execFile);

export const AUDIT_ADAPTER_VERSION = 'audit@p1';
/** factId 版本段：判类规则表或锚点合同变更 → 换版本号新 fact_id，旧事实保留（POINT-IN-TIME §4）。 */
const FACT_ID_VERSION_TAG = 'p1';

/** 容器内工程挂载根（桥路径前缀）。 */
const DOCKER_WORK = '/work';
/** 原件库相对工程根路径（CAS 分片规则：<dir>/<sha 前 2 位>/<sha256>）。 */
export const AUDIT_ARTIFACTS_REL = 'data/artifacts';

// ===== 审计意见五类（canonical 值；'UNDETERMINED' 为不确定占位，不作类型宣称）=====

export type AuditOpinionType =
  | '标准无保留意见'
  | '带强调事项段（或持续经营相关重大不确定性）的无保留意见'
  | '保留意见'
  | '无法表示意见'
  | '否定意见';

export const AUDIT_OPINION_TYPES: readonly AuditOpinionType[] = [
  '标准无保留意见',
  '带强调事项段（或持续经营相关重大不确定性）的无保留意见',
  '保留意见',
  '无法表示意见',
  '否定意见',
];

export const AUDIT_OPINION_UNDETERMINED = 'UNDETERMINED';

/** 摘录上限（派发冻结：原文摘录 200 字）。 */
export const AUDIT_EXCERPT_MAX = 200;
/** 摘录取证窗口：命中关键词前取字数（后取至 200 上限）。 */
const EXCERPT_BEFORE = 80;

// ===== 判类规则表（显式常量，派发冻结优先级从强到弱；匹配在去空白文本上）=====
//
// 每条规则：any = 任一模式命中即规则命中；all = 全部模式命中才规则命中（复合规则）。
// 防假命中 lookbehind（均来自标准审计报告责任段模板文本的实证，见文件头探测依据）：
// - (?<!非)无保留意见：责任段模板"如果披露不充分，我们应当发表非无保留意见"——
//   "非无保留意见"为修饰意见的否定式，非无保留意见本身；
// - (?<!无)保留意见 / (?<!无)保留审计意见："无保留意见"含"保留意见"子串；
// - 持续经营复合词 (?<!是否存在)重大不确定性：责任段模板"就……持续经营能力产生重大疑虑的
//   事项或情况是否存在重大不确定性得出结论"为假设式（带"是否"），真实强调事项段的
//   措辞为"……事项或情况存在重大不确定性"（直接断言，无"是否"）。
export interface AuditOpinionRule {
  readonly type: AuditOpinionType;
  readonly label: string; // 规则表显式名（日志/测试用）
  readonly any?: readonly string[];
  readonly all?: readonly string[];
}

/** 无保留意见关键词（排除否定式"非无保留意见"；含旧式"无保留审计意见"变体）。 */
const UNQUALIFIED_RE = '(?<!非)(?:无保留意见|无保留审计意见)';
/** 强调事项 / 持续经营重大不确定性关键词（排除假设式"是否存在重大不确定性"——
 *  lookbehind 须置"重大"前且取全否定短语"是否存在"，因否定词与"重大"间隔"存在"二字）。 */
const EOM_GOING_CONCERN_RE =
  '强调事项|持续经营[^。]{0,40}(?<!是否存在)重大不确定性|重大不确定性[^。]{0,40}持续经营';

export const AUDIT_OPINION_RULES: readonly AuditOpinionRule[] = [
  {
    type: '无法表示意见',
    label: 'R1 无法表示意见',
    any: ['无法表示意见'],
  },
  {
    type: '否定意见',
    label: 'R2 否定意见',
    any: ['否定意见'],
  },
  {
    type: '保留意见',
    label: 'R3 保留意见（不含无保留）',
    any: ['(?<!无)保留意见', '(?<!无)保留审计意见'],
  },
  {
    type: '带强调事项段（或持续经营相关重大不确定性）的无保留意见',
    label: 'R4 无保留+强调事项/持续经营重大不确定性',
    all: [UNQUALIFIED_RE, EOM_GOING_CONCERN_RE],
  },
  {
    type: '标准无保留意见',
    label: 'R5 标准无保留意见',
    any: [UNQUALIFIED_RE],
  },
];

/** 规则字符串 → RegExp（模块内单次编译；lookbehind 为 Node ≥8 / Python 3.7+ 同语义）。 */
const COMPILED_RULES: readonly {
  rule: AuditOpinionRule;
  any: readonly RegExp[];
  all: readonly RegExp[];
}[] = AUDIT_OPINION_RULES.map((rule) => ({
  rule,
  any: (rule.any ?? []).map((source) => new RegExp(source)),
  all: (rule.all ?? []).map((source) => new RegExp(source)),
}));

/** 去空白归一（pypdf 抽取的换行/空格伪影；中文财务文本词内空白无语义）。 */
export function normalizeAuditText(text: string): string {
  return text.replace(/\s+/g, '');
}

export interface AuditWindowHit {
  rule: string; // 命中规则 label
  type: AuditOpinionType;
  /** 命中关键词（归一文本中的原文片段）。 */
  matched: string;
  excerpt: string; // ≤200 字
  page: number; // PDF 页序（1 起）
}

/** 单窗口判类：规则表优先序内首个命中；零命中返回 null。 */
export function classifyAuditWindow(window: AuditWindow): AuditWindowHit | null {
  const norm = normalizeAuditText(window.text);
  for (const compiled of COMPILED_RULES) {
    const patterns = compiled.any !== undefined && compiled.any.length > 0 ? compiled.any : compiled.all;
    if (patterns === undefined) continue; // 不可达：规则构造保证 any/all 至少其一
    const matches = patterns
      .map((re) => re.exec(norm))
      .filter((m): m is RegExpExecArray => m !== null);
    if (compiled.any !== undefined && compiled.any.length > 0) {
      if (matches.length === 0) continue; // any：任一命中
    } else if (matches.length !== patterns.length) {
      continue; // all：全部命中
    }
    const first = matches[0]!;
    const start = Math.max(0, first.index - EXCERPT_BEFORE);
    return {
      rule: compiled.rule.label,
      type: compiled.rule.type,
      matched: first[0],
      excerpt: norm.slice(start, start + AUDIT_EXCERPT_MAX),
      page: window.page,
    };
  }
  return null;
}

// ===== 桥响应形态（adapters/audit/bridge.py stdout；只含定位窗口，不含全文本）=====

export interface AuditWindow {
  anchor: string; // 命中锚点原文（审计意见 / 意见的审计报告 / 意见审计报告）
  page: number; // PDF 页序（1 起）
  text: string; // 锚点窗口原文（前向 40+1000 字 / 后向 160+120 字，见桥常量）
}

export interface AuditBridgeFileResult {
  ok: boolean;
  path: string;
  sha256?: string | undefined;
  pages?: number | undefined;
  textLen?: number | undefined;
  windows?: AuditWindow[] | undefined;
  truncatedWindows?: boolean | undefined;
  error_code?: string | undefined;
  error?: string | undefined;
}

export interface AuditBridgePayload {
  ok: boolean;
  results?: AuditBridgeFileResult[] | undefined;
  error_code?: string | undefined;
  error?: string | undefined;
}

// ===== 判类聚合（多窗口）=====

export type AuditClassification =
  | {
      status: 'CLASSIFIED';
      type: AuditOpinionType;
      excerpt: string;
      candidates: { 类型: string; 摘录: string; 页码: number; 规则: string }[];
      判类说明: string;
    }
  | {
      status: 'UNDETERMINED';
      type: typeof AUDIT_OPINION_UNDETERMINED;
      excerpt: string;
      candidates: { 类型: string; 摘录: string; 页码: number; 规则: string }[];
      判类说明: string;
    };

/**
 * 多窗口聚合（派发冻结语义的实现解读）：
 * - 每窗口独立按规则表判类 → 命中集合；
 * - 命中类型唯一 → 该类型（首个命中窗口的摘录为判类依据）；
 * - 命中类型 >1 → UNDETERMINED（多命中冲突，带全部候选摘录，不猜）；
 * - 零命中 → UNDETERMINED（零命中，摘录取首个窗口，候选为空）。
 * 窗口为空数组（无审计节锚点）不属本函数职责，由适配器层判 NO_AUDIT_SECTION。
 */
export function classifyAuditWindows(windows: readonly AuditWindow[]): AuditClassification | null {
  if (windows.length === 0) return null;
  const hits: AuditWindowHit[] = [];
  for (const window of windows) {
    const hit = classifyAuditWindow(window);
    if (hit !== null) hits.push(hit);
  }
  if (hits.length === 0) {
    const norm = normalizeAuditText(windows[0]!.text);
    return {
      status: 'UNDETERMINED',
      type: AUDIT_OPINION_UNDETERMINED,
      excerpt: norm.slice(0, AUDIT_EXCERPT_MAX),
      candidates: [],
      判类说明: `零命中（${String(windows.length)} 个审计节窗口内无判类关键词）`,
    };
  }
  const byType = new Map<string, AuditWindowHit>();
  for (const hit of hits) {
    if (!byType.has(hit.type)) byType.set(hit.type, hit); // 每类型留首个命中
  }
  const candidates = [...byType.values()].map((hit) => ({
    类型: hit.type,
    摘录: hit.excerpt,
    页码: hit.page,
    规则: hit.rule,
  }));
  if (byType.size > 1) {
    return {
      status: 'UNDETERMINED',
      type: AUDIT_OPINION_UNDETERMINED,
      excerpt: hits[0]!.excerpt,
      candidates,
      判类说明: `多命中冲突（${[...byType.keys()].join(' / ')}），不猜`,
    };
  }
  const first = hits[0]!;
  return {
    status: 'CLASSIFIED',
    type: first.type,
    excerpt: first.excerpt,
    candidates,
    判类说明: `窗口一致（${String(hits.length)} 窗命中 ${first.rule}）`,
  };
}

// ===== 标题规则（runner 候选过滤单一来源；派发冻结）=====

/** 年报标题判定：含"年度报告"（"半年度报告"含其子串，按只处理年报排除）、排除摘要/英文/已取消。 */
export function isAnnualReportTitle(title: string): boolean {
  return /(?<!半)年度报告/.test(title) && !/摘要|英文|已取消/.test(title);
}

/** 报告年度从标题提取（首个 19xx/20xx 四位年；无则 null，不猜）。 */
export function extractReportYear(title: string): string | null {
  const match = /(?:19|20)\d{2}/.exec(title);
  return match === null ? null : match[0];
}

// ===== 事实映射 =====

/** 年报 ANNOUNCEMENT 证据绑定输入（runner 从库内带出，适配器不回查）。 */
export interface AuditSourceAnnouncement {
  factId: string;
  subjectId: string;
  title: string;
  /** 年报公告的 availableAt（ISO）——复用为本事实 availableAt（派发冻结）。 */
  availableAt: string;
  /** 年报公告的 sourcePublishedAt（ISO）；可能为 null（口径同 ANNOUNCEMENT 事实）。 */
  sourcePublishedAt: string | null;
  pdfSha256: string;
}

/**
 * AUDIT_OPINION 事实构造（确定性）：
 * - factId = 'audit-op-' + canonicalSha256({adapter, announcementFactId, pdfSha256})——
 *   同证据绑定 + 同适配器版本重放同 fact_id；判类规则变更走新版本号；
 * - typedValue：类型 / 摘录 / 报告年度 / pdfSha256 / announcementFactId（证据绑定，派发要求）/
 *   年报标题 / 候选 / 判类说明；
 * - 五时间字段：availableAt=eventAt=年报 ANNOUNCEMENT.availableAt；sourcePublishedAt 复用；
 *   validFrom/validTo=null（点事实）；firstObservedAt=本次抽取时刻。
 */
export function buildAuditOpinionFact(args: {
  announcement: AuditSourceAnnouncement;
  classification: AuditClassification;
  extractedAt: string;
}): TimePointFact {
  const { announcement, classification } = args;
  const factId = auditOpinionFactId(announcement.factId, announcement.pdfSha256);
  return {
    factId,
    subjectType: 'STOCK',
    subjectId: announcement.subjectId,
    factKind: 'AUDIT_OPINION',
    typedValue: {
      类型: classification.type,
      摘录: classification.excerpt,
      报告年度: extractReportYear(announcement.title),
      pdfSha256: announcement.pdfSha256,
      announcementFactId: announcement.factId,
      年报标题: announcement.title,
      候选: classification.candidates,
      判类说明: classification.判类说明,
    },
    validFrom: null,
    validTo: null,
    eventAt: announcement.availableAt,
    sourcePublishedAt: announcement.sourcePublishedAt,
    firstObservedAt: args.extractedAt,
    availableAt: announcement.availableAt,
    supersedesFactId: null,
    artifactSha256: announcement.pdfSha256,
    adapterVersion: AUDIT_ADAPTER_VERSION,
  };
}

/** factId：canonical 哈希形式（同 valuation 事实身份派生约定）。 */
export function auditOpinionFactId(announcementFactId: string, pdfSha256: string): string {
  return (
    'audit-op-' +
    canonicalSha256({
      adapter: AUDIT_ADAPTER_VERSION,
      kind: 'AUDIT_OPINION',
      announcementFactId,
      pdfSha256,
      version: FACT_ID_VERSION_TAG,
    })
  );
}

// ===== 桥执行器（docker run 容器化 python；本地计算，无网络无退避）=====

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface AuditBridgeExecutorOptions {
  dockerPath?: string | undefined;
  timeoutMs?: number | undefined;
  repoRootPath?: string | undefined;
}

export type AuditBridgeExecutor = (args: string[]) => Promise<AuditBridgePayload>;

/** 真实执行器：docker run --rm + akshare 卷（pypdf）+ 工程 mount，跑 adapters/audit/bridge.py。 */
export function makeAuditBridgeExecutor(opts: AuditBridgeExecutorOptions = {}): AuditBridgeExecutor {
  const dockerPath = opts.dockerPath ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const root = opts.repoRootPath ?? repoRoot;
  const fixedArgs = [
    'run', '--rm',
    '-v', 'lyra-akshare-py311:/usr/local/lib/python3.11/site-packages',
    '-v', `${root}:/work`,
    'python:3.11-slim',
    'python', '/work/adapters/audit/bridge.py',
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
      if (e.code === 'ENOENT') throw new AdapterError('AUDIT_DOCKER_MISSING', dockerPath);
      failed = true;
      killed = e.killed === true;
      if (typeof e.stdout === 'string') stdout = e.stdout;
    }
    let parsed: AuditBridgePayload | null = null;
    try {
      parsed = JSON.parse(stdout) as AuditBridgePayload;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed.ok !== 'boolean') {
      if (killed) throw new TransientAdapterError('AUDIT_BRIDGE_TIMEOUT', `超过 ${String(timeoutMs)}ms`);
      throw new TransientAdapterError(
        'AUDIT_BRIDGE_OUTPUT_INVALID',
        `stdout 不可解析（exit=${failed ? 'nonzero' : '0'}，前 120 字符：${stdout.slice(0, 120)}` +
          (stdout.length > 120 ? '…' : ')'),
      );
    }
    if (!parsed.ok) {
      // USAGE_ERROR = 永久（确定性参数错）；其余按瞬态（容器/解析环境问题）上报
      const code = parsed.error_code ?? 'AUDIT_BRIDGE_FAILED';
      if (code === 'USAGE_ERROR') throw new AdapterError(code, parsed.error ?? '');
      throw new TransientAdapterError(code, parsed.error ?? '');
    }
    return parsed;
  };
}

// ===== 适配器 =====

/** 桥侧容器内 PDF 路径（CAS 分片：<artifactsRel>/<sha 前 2 位>/<sha256>）。 */
export function dockerPdfPath(pdfSha256: string, artifactsRel: string = AUDIT_ARTIFACTS_REL): string {
  if (!/^[a-f0-9]{64}$/.test(pdfSha256)) {
    throw new AdapterError('AUDIT_PDF_SHA_INVALID', pdfSha256);
  }
  return `${DOCKER_WORK}/${artifactsRel}/${pdfSha256.slice(0, 2)}/${pdfSha256}`;
}

export interface AuditAdapterOptions {
  /** 注入桥执行器（单测 fixture 注入；缺省真实 docker）。 */
  execBridge?: AuditBridgeExecutor | undefined;
  dockerPath?: string | undefined;
  repoRootPath?: string | undefined;
  requestTimeoutMs?: number | undefined;
  /** 原件库相对工程根路径（默认 data/artifacts；须在工程内才能被容器挂载覆盖）。 */
  artifactsRel?: string | undefined;
  now?: (() => Date) | undefined;
}

/** 单份抽取产物（适配器只映射不落库；落库与状态由 runner 决定）。 */
export type AuditExtractResult =
  | {
      status: 'FACT'; // 五类或 UNDETERMINED → 事实已构造（含 NO_AUDIT_SECTION 之外的一切可判情形）
      fact: TimePointFact;
      classification: AuditClassification;
      pages: number;
      textLen: number;
      truncatedWindows: boolean;
    }
  | {
      status: 'NO_AUDIT_SECTION'; // 无任何审计节锚点窗口（季报/半年报/噪声公告）→ 不产事实
      pages: number;
      textLen: number;
      reason: string;
    }
  | {
      status: 'ERROR'; // 桥侧单份失败 / 哈希不符 → 不产事实
      code: string;
      error: string;
    };

export class AuditAdapter {
  readonly adapterVersion = AUDIT_ADAPTER_VERSION;
  private readonly execBridge: AuditBridgeExecutor;
  private readonly artifactsRel: string;
  private readonly now: () => Date;

  constructor(opts: AuditAdapterOptions = {}) {
    this.execBridge =
      opts.execBridge ??
      makeAuditBridgeExecutor({
        dockerPath: opts.dockerPath,
        timeoutMs: opts.requestTimeoutMs,
        repoRootPath: opts.repoRootPath,
      });
    this.artifactsRel = opts.artifactsRel ?? AUDIT_ARTIFACTS_REL;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * 批量抽取（一次桥调用摊薄容器启动；本地计算串行）。逐份：
   * 桥单份失败 / sha256 与 pdf_backfill_state 登记不符 → ERROR（不产事实）；
   * 无锚点窗口 → NO_AUDIT_SECTION；其余判类（五类 / UNDETERMINED）→ FACT。
   */
  async extractAnnualReportBatch(
    announcements: readonly AuditSourceAnnouncement[],
  ): Promise<AuditExtractResult[]> {
    if (announcements.length === 0) return [];
    const paths = announcements.map((a) => dockerPdfPath(a.pdfSha256, this.artifactsRel));
    const payload = await this.execBridge(['extract', ...paths]);
    const byPath = new Map<string, AuditBridgeFileResult>();
    for (const result of payload.results ?? []) byPath.set(result.path, result);
    const extractedAt = this.now().toISOString();
    return announcements.map((announcement, index) => {
      const result = byPath.get(paths[index]!);
      if (result === undefined) {
        return {
          status: 'ERROR',
          code: 'AUDIT_BRIDGE_RESULT_MISSING',
          error: `桥未返回该文件结果：${paths[index]!}`,
        } satisfies AuditExtractResult;
      }
      if (!result.ok) {
        return {
          status: 'ERROR',
          code: result.error_code ?? 'AUDIT_PDF_FAILED',
          error: result.error ?? '',
        } satisfies AuditExtractResult;
      }
      if (result.sha256 !== announcement.pdfSha256) {
        return {
          status: 'ERROR',
          code: 'AUDIT_PDF_HASH_MISMATCH',
          error: `桥算得 ${String(result.sha256)} ≠ 登记 ${announcement.pdfSha256}`,
        } satisfies AuditExtractResult;
      }
      const windows = result.windows ?? [];
      const pages = result.pages ?? 0;
      const textLen = result.textLen ?? 0;
      const classification = classifyAuditWindows(windows);
      if (classification === null) {
        const reason =
          textLen < 1000
            ? `无审计节且几乎无文本层（pages=${String(pages)}，textLen=${String(textLen)}，疑似扫描件）`
            : `无审计节锚点（pages=${String(pages)}，textLen=${String(textLen)}）`;
        return { status: 'NO_AUDIT_SECTION', pages, textLen, reason } satisfies AuditExtractResult;
      }
      return {
        status: 'FACT',
        fact: buildAuditOpinionFact({ announcement, classification, extractedAt }),
        classification,
        pages,
        textLen,
        truncatedWindows: result.truncatedWindows === true,
      } satisfies AuditExtractResult;
    });
  }

  /** 单份抽取（冒烟/调试；批量语义同 extractAnnualReportBatch）。 */
  async extractAnnualReport(announcement: AuditSourceAnnouncement): Promise<AuditExtractResult> {
    const results = await this.extractAnnualReportBatch([announcement]);
    const first = results[0];
    if (first === undefined) throw new AdapterError('AUDIT_BRIDGE_RESULT_MISSING', '单份调用无返回');
    return first;
  }
}
