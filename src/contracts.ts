import type { FrozenBenchmark } from './conclusion/benchmark.js';
/**
 * Lyra · 共享契约（P0，总控冻结 2026-10-25）。
 * 唯一共享类型源；实现模块只 import、不重复定义。字段出处：
 * 研究身份/disposition/adoption/证据哈希/继承 —— docs/specs/RESEARCH-METHOD.md §3/§8（含 R18 两类标的）；
 * 五时间字段/as-of/supersedes —— docs/specs/POINT-IN-TIME.md §2/§4；
 * permit/send-once/UNKNOWN/截止/预算 —— docs/specs/EXECUTION-KERNEL.md §3–§6；
 * 三条版本轴 —— docs/PLAN.md §10。
 */

// ===== 三条独立的版本轴（互相不推导）=====
export type MethodVersionId = string; // 方法版本轴（方法文本与裁决结构）
export type AdapterVersionId = string; // 数据与适配器版本轴（按来源各自版本号）
export type PlanAuthVersionId = string; // 执行计划与授权版本轴（计划身份 + 调用上限/并发/预算）

// ===== 研究身份与业务键 =====
export type SubjectKind = 'STOCK' | 'BROAD_ETF';
export type ResearchKind = 'WEEKLY' | 'POST_EVENT' | 'PRE_EVENT';

export interface ResearchBusinessKey {
  subjectKind: SubjectKind;
  subject: string; // 股票代码（如 600519）或 ETF 代码
  researchKind: ResearchKind;
  cutoff: string; // 资料截点，ISO-8601
}

// ===== 决策选项空间（R18：两类标的分别校验，跨类即拒绝）=====
export const STOCK_DISPOSITIONS = ['RESEARCH_OUTPERFORM', 'RESEARCH_UNDERPERFORM', 'ABSTAIN'] as const;
export const BROAD_DISPOSITIONS = ['RESEARCH_UP', 'RESEARCH_DOWN', 'ABSTAIN'] as const;
export type StockDisposition = (typeof STOCK_DISPOSITIONS)[number];
export type BroadDisposition = (typeof BROAD_DISPOSITIONS)[number];
export type Disposition = StockDisposition | BroadDisposition;

export function validDispositions(kind: SubjectKind): readonly string[] {
  return kind === 'STOCK' ? STOCK_DISPOSITIONS : BROAD_DISPOSITIONS;
}

// ===== 原件（POINT-IN-TIME §9 CAS）=====
export interface ArtifactRef {
  sha256: string;
  bytes: number;
  mediaType: string;
  firstObservedAt: string; // 抓取时间；入库必带
}

// ===== 时点事实（五时间字段，POINT-IN-TIME §2）=====
export type TimePointSubjectType = 'STOCK' | 'ETF' | 'INDUSTRY' | 'INDEX' | 'RULE';
/** 四类时点对象（R14）对应的 factKind 至少含以下；允许扩展 */
export type TimePointFactKind =
  | 'ANNOUNCEMENT' // 公告/财务发布时间
  | 'FINANCIAL' // 财务指标（pubDate 口径）
  | 'INDUSTRY_CLASS_VERSION' // 行业分类版本
  | 'INDEX_MEMBERSHIP' // 指数成分归属
  | 'ADJUST_FACTOR' // 复权因子
  | 'DISCLOSURE_SCHEDULE' // 预约披露表（版本化）
  | (string & {});

export interface TimePointFact {
  factId: string;
  subjectType: TimePointSubjectType;
  subjectId: string;
  factKind: TimePointFactKind;
  typedValue: unknown; // JSON；结构按 factKind 由适配器定义
  validFrom: string | null;
  validTo: string | null;
  eventAt: string | null;
  sourcePublishedAt: string | null;
  firstObservedAt: string;
  availableAt: string; // as-of 判定唯一依据；≠发布时间≠事务时间
  supersedesFactId: string | null; // 修正不覆盖原件
  artifactSha256: string;
  adapterVersion: AdapterVersionId;
}

// ===== 封存 manifest（POINT-IN-TIME §7）=====
export interface SealManifest {
  sealId: string;
  businessKey: ResearchBusinessKey;
  cutoff: string;
  artifactRefs: ArtifactRef[];
  factIds: string[];
  gaps: string[]; // 显式缺口列表（可空数组，不可缺省）
  methodVersion: MethodVersionId;
  adapterVersion: AdapterVersionId;
  planAuthVersion: PlanAuthVersionId;
  createdAt: string;
  manifestHash: string; // canonicalSha256(除 manifestHash 外的全部字段)
  /**
   * 调用期标记（W26 幂等复用）：buildSeal 命中同材料既有封存而复用时为 true。
   * 不落库、不进 manifestHash、不进研究包内容（嵌入前经 sealManifestContent 剥离）。
   */
  reused?: true;
}

// ===== 执行内核 =====
export type PermitState = 'PREPARED' | 'SENT' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
export type Stage = 'A' | 'J';

export interface ModelCallContract {
  businessKey: ResearchBusinessKey;
  stage: Stage;
  inputHash: string; // 输入内容哈希
  inputBytes: number; // 输入字节数（预算判定）
  methodVersion: MethodVersionId;
  planAuthVersion: PlanAuthVersionId;
  deadline: string; // 本次执行自身持有，不从计划模板继承（EK-6.1）
}

export interface ModelPermit {
  permitId: string;
  contract: ModelCallContract;
  state: PermitState;
  sentAt: string | null;
  settledAt: string | null;
  failCode: string | null; // FAILED/未按窗完成的具名原因，如 DEADLINE_EXCEEDED
  simulated: boolean; // 模拟模型身份自我声明（EK-10.1）
}

export interface PlanAuthBudget {
  planAuthVersion: PlanAuthVersionId;
  maxModelCallsPerWeek: number;
  maxInputBytes: number; // 输入预算；超预算 INPUT_OVER_BUDGET 阻断（EK-4.4/4.5）
  maxInFlight: 2; // 并发上限（EK-2.3）
  scopeLimits?: { weekly: number; postEvent: number }; // 显式授权；缺省冻结常态 60/10，不自动扩容
}

export type KernelErrorCode =
  | 'EXECUTION_LOCK_HELD' // 第二执行器（EK-2.1）
  | 'PERMIT_REQUIRED' // 无 permit 调用（EK-3.2）
  | 'INPUT_OVER_BUDGET' // 超预算阻断，不截断（EK-4.4）
  | 'BUSINESS_KEY_ALREADY_SENT' // send-once：同业务键已发送（EK-4.1）
  | 'DEADLINE_EXCEEDED' // 截止到期，按未按窗完成分类（EK-6.2）
  | 'UNKNOWN_NOT_RETIRED' // UNKNOWN 未退役前禁止重采样（EK-5.2）
  | 'RECOVERY_CONFIRM_REQUIRED' // RECONCILING 下未确认恢复即执行（EK-8）
  | 'PERMIT_STATE_INVALID';

export class KernelError extends Error {
  constructor(readonly code: KernelErrorCode | string, message?: string) {
    super(message ?? code);
    this.name = 'KernelError';
  }
}

// ===== 模拟模型（EK-10.1）=====
export type SimFault = 'TIMEOUT' | 'SILENCE_AFTER_SEND' | 'EXPLICIT_FAIL' | 'INPUT_OVER_BUDGET';

export interface AOutput {
  stage: 'A';
  inputHash: string;
  subjectKind: SubjectKind;
  candidate: Disposition; // A 候选；单独永远不是最终结论
  decisiveLinks: { text: string; evidenceArtifactSha256: string }[];
  strongestCounter: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  limitations: string[];
  simulated: boolean; // R28：通道自声明——模拟通道 true、真实通道 false（原冻结字面 true 放宽）
}

export type ChecklistVerdict = 'SUPPORTED' | 'NARROWED' | 'REJECTED' | 'UNRESOLVED';

export interface JOutput {
  stage: 'J';
  inputHash: string;
  finalDisposition: Disposition; // disposition 必须等于此值（字段间校验）
  verdicts: {
    checklistId: string;
    verdict: ChecklistVerdict;
    decisionBearing: boolean;
    correction: string | null;
    /** 新输出必填；旧存档形状由读取层保留，不可据此重新生成有效结论。 */
    reason: string;
    evidenceArtifactSha256s: string[];
    remainingBasisChecklistIds: string[];
  }[];
  changedFromA: boolean;
  changeReason: string | null; // 改判必填（含继承改判）
  strongestCaseDisposition: 'ACCEPTED' | 'NARROWED' | 'REFUTED' | 'UNRESOLVED';
  limitations: string[];
  simulated: boolean; // R28：通道自声明——模拟通道 true、真实通道 false（原冻结字面 true 放宽）
}

// ===== 程序清单（无模型，机械抽取）=====
export interface ChecklistItem {
  checklistId: string; // check:p0|p2:<category>:<index>（p2 = 带维度覆盖包派生，REVISION-LOG W25）
  category:
    | 'DECISIVE_LINK'
    | 'STRONGEST_COUNTER'
    | 'CANDIDATE'
    | 'SELECTION_THRESHOLD'
    | 'DIMENSION_COVERAGE'; // P2 追加：个股八维/宽基七维逐维度覆盖项（CHECKLIST_RULES_P2 规则 5）
  assessment: 'NOT_ASSESSED'; // 程序无独立意见
  aText: string; // A 原文定位（截断引用，非全文）
  sourceHash: string; // 来源对象哈希（A 输出或原件）
}

export interface ProgramChecklist {
  checklistId: string; // 清单身份
  aOutputHash: string;
  manifestHash: string;
  items: ChecklistItem[];
  mandatoryJ: true;
  checklistHash: string; // canonicalSha256(除 checklistHash 外)；必须可由 A 输出机械重导出
}

// ===== 研究结论对象（RESEARCH-METHOD §8）=====
export interface ConclusionEvidence {
  aOutputHash: string;
  checklistHash: string;
  jOutputHash: string;
  manifestHash: string;
  /** 新结论绑定实际输入及 A/清单/J 原文 CAS；旧结论缺失时不得声明已送达继承。 */
  researchTraceSha256?: string;
  /** 新研究实际使用的基准快照；旧对象缺失时不可按当前库补写。 */
  benchmark?: FrozenBenchmark;
}

export interface SettlementZone {
  /** 占位区；回填只写本区，不改研究字段。ANOMALY=结算异常具名登记（R26.2：不进主统计、不冒充终态结算）。 */
  state: 'UNSETTLED' | 'SETTLED' | 'ANOMALY';
  directionHit?: boolean | null; // null = ABSTAIN 的 N/A（SR-2.2，R26.2）
  excessReturn?: string | null; // 精确十进制定点（字符串）
  maxAdverse?: string | null;
  invalidationTriggered?: boolean;
  tradability?: string | null; // ASHARE-RULES §5 分类
  anomalyCode?: string; // state='ANOMALY' 时必填（如 INDEX_BAR_MISSING）
  anomalyDetail?: string;
}

export interface ConclusionObject {
  conclusionId: string;
  businessKey: ResearchBusinessKey;
  methodVersion: MethodVersionId;
  adapterVersion: AdapterVersionId;
  planAuthVersion: PlanAuthVersionId;
  disposition: Disposition;
  adoption: false; // 恒 false（首版无正式采用）
  evidence: ConclusionEvidence;
  inheritance: { fromConclusionId: string; fromConclusionHash: string } | null; // STANDALONE 时为 null
  standaloneNote: string | null; // STANDALONE 时为 "无基础结论可继承"
  changeReason: string | null; // 继承改判或 J 改判 A 候选时必填
  settlement: SettlementZone;
  createdAt: string;
  conclusionHash: string; // canonicalSha256(除 conclusionHash 外的研究字段)
}

// ===== 恢复状态（EK-8）=====
export type Lifecycle = 'RUNNING' | 'RECONCILING';
export interface RecoveryState {
  lifecycle: Lifecycle;
  pendingPermitIds: string[]; // RECONCILING 时待处置的 permit
  updatedAt: string;
}

// ===== 安装日志（EK-10.3）=====
export interface InstallLogRecord {
  versionId: string;
  testRunId: string;
  green: true; // 只允许写全绿记录；非绿不产生安装
  summary: string; // 输出摘要（通过/失败计数）
  recordedAt: string;
}
