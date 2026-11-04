import type { FrozenBenchmark } from '../conclusion/benchmark.js';
/**
 * Lyra · 单股研究报告产品（sr 空间）共享契约。R31，2026-10-26。
 * 依据：TASK-PACKAGE §4/§5、docs/REQUIREMENTS.md v3.0 §2–§7。
 *
 * 空间边界：本模块与 src/db/sr-migration.sql 定义的 sr_* 表位于数据库 schema `sr`
 * （本任务新建命名空间），与 A/J 空间（public.exec_permit 等）互不占用。模型调用
 * 经 src/kernel/executor.ts 的 runPermittedCall（同一执行器编排）接入，permit 语义
 * （状态机/send-once/并发闸/截止/UNKNOWN）与 A/J 一致。
 *
 * 版本轴沿用三条独立轴（contracts.ts）：方法版本（研究链结构与章节合同）、
 * 数据与适配器版本、执行计划与授权版本。
 */

import type { PlanAuthBudget } from '../contracts.js';

// ===== 版本与常量 =====

export const SR_METHOD_VERSION = 'sr-m1'; // 报告链方法版本（步骤结构 + 章节合同）
export const SR_DB_NAMESPACE = 'sr'; // 数据库 schema 名（新建命名空间）
export const SR_OUTPUT_DIR = 'var/single-stock-report'; // 运行输出根（任务包/证据/提示词）

// ===== 任务 =====

export type SrFocus = 'FULL' | 'BUSINESS' | 'FINANCIAL_QUALITY' | 'VALUATION' | 'EVENTS';
export type SrHorizon = 'MID_TERM' | 'LONG_TERM' | 'NEAR_TERM';

export type SrTaskStatus =
  | 'QUEUED' // 已受理，等待执行器
  | 'RUNNING' // 执行中（看步骤明细）
  | 'PARTIAL' // 有产出但有具名缺口/质检不通过项（诚实保留成果）
  | 'COMPLETED' // 全步骤完成且质检通过
  | 'FAILED' // 未产出报告的失败（具名 error）
  | 'CANCELLED'; // 用户显式取消（首版仅管理员操作）

export interface SrTaskError {
  code: string; // 如 STEP_FAILED / QUOTA_EXHAUSTED / MODEL_PROVIDER_UNAUTHORIZED
  message: string;
  stepId?: string;
}

export interface SrTask {
  taskId: string; // uuid
  accountId: string;
  subject: string; // 6 位股票代码
  subjectName: string; // 展示名（来自研究池）
  focus: SrFocus;
  emphasis: string | null; // 用户自由文本关注点
  horizon: SrHorizon;
  cutoff: string; // 资料截点 ISO-8601（任务建立时定，不变）
  status: SrTaskStatus;
  idemKey: string; // 幂等键：account+subject+focus+horizon+cutoff+emphasis 摘要
  revisedFromTaskId: string | null; // 显式修订/更新截点产生的新任务关联
  methodVersion: string;
  adapterVersion: string;
  planAuthVersion: string;
  error: SrTaskError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ===== 步骤 =====

export type SrStepKind =
  | 'PLAN' // 研究问题与资料计划（模型调用）
  | 'EVIDENCE' // 证据包组装（确定性，无模型）
  | 'COMPUTE' // 财务/行情/估值计算（确定性，无模型）
  | 'ANALYZE' // A 分节分析（模型调用，sectionKey 区分组）
  | 'A_FINAL' // A 终稿：核心判断+决定性连接+最强反证（模型调用；对应 Metis A 角色）
  | 'CHECKLIST' // 程序清单：从 A 全部产物机械抽取（确定性，无模型；对应 Metis 程序清单）
  | 'JUDGE' // 必经 J 裁决：逐清单项裁决+承重未知项处置+终局结论（模型调用）
  | 'QA_CHECK' // 质量检查（确定性）
  | 'ASSEMBLE' // 发布门+报告组装与版本落位（确定性，无模型）
  | 'CHAT_ANSWER' // 追问回答（模型调用，sectionKey=messageId）
  // 兼容：C2 链的 SYNTHESIZE 语义并入 A_FINAL；旧行保留可读
  | 'SYNTHESIZE';

export type SrStepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'; // 因前置缺口明确跳过（记录原因）

export interface SrStep {
  stepId: string; // uuid；逻辑步骤身份（重试不换 ID；改输入 = 新步骤）
  taskId: string;
  stepKind: SrStepKind;
  sectionKey: string | null; // ANALYZE 的章节键 / CHAT_ANSWER 的 messageId
  sequence: number;
  status: SrStepStatus;
  note: string | null; // SKIPPED 原因 / 摘要
  startedAt: string | null;
  finishedAt: string | null;
}

// ===== 调用（sr 空间 permit）=====

export interface SrCallContract {
  taskId: string;
  stepId: string;
  inputHash: string;
  inputBytes: number;
  methodVersion: string;
  planAuthVersion: string;
  deadline: string; // 本执行自身持有（不继承模板）
}

export interface SrCall {
  callId: string; // uuid（permitId）
  taskId: string;
  stepId: string;
  inputHash: string;
  inputBytes: number;
  methodVersion: string;
  planAuthVersion: string;
  deadline: string;
  state: 'PREPARED' | 'SENT' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED'; // 与 A/J 同一状态机
  sentAt: string | null;
  settledAt: string | null;
  failCode: string | null;
  simulated: boolean;
  provider: string | null; // 实际通道 describe()（sim-xxx / codex-native 等）
  modelId: string | null;
  usage: SrCallUsage | null;
  createdAt: string;
}

export interface SrCallUsage {
  reasoningEffort?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  costNote?: string; // 费用可得性说明（无法计量时如实写）
}

// sr 空间预算（EK-4 语义；maxInFlight 固定 2 与内核一致）
export interface SrPlanBudget extends PlanAuthBudget {
  planAuthVersion: string;
  maxModelCallsPerTask: number; // 单任务模型调用硬上限
  maxModelCallsPerWeek: number;
  maxInputBytes: number; // 单调用输入预算
  maxInFlight: 2;
}

export function defaultSrPlanBudget(): SrPlanBudget {
  return {
    planAuthVersion: 'sr-auth-1',
    maxModelCallsPerTask: 8,
    maxModelCallsPerWeek: 40,
    maxInputBytes: 900_000,
    maxInFlight: 2,
  };
}

// ===== 证据包 =====

export type EvidenceLocator =
  | { kind: 'FACT'; factId: string; factKind: string; subjectId: string; availableAt: string }
  | { kind: 'FILE'; path: string; note: string } // 包内或仓库内的相对原件路径（仅作定位，不直接作为 Web 路由）
  | { kind: 'COMPUTED'; tableId: string };

export interface EvidenceTable {
  tableId: string; // 如 fin-quarterly、bars-daily、valuation-inputs
  title: string;
  columns: string[];
  rows: (string | number | null)[][]; // 无损文本表格（沿用 tables.ts 纪律：不丢精度）
  unitNote: string | null;
  locators: EvidenceLocator[]; // 行级来源（与行对齐或整体来源说明）
  cutoff: string;
}

export interface EvidencePack {
  benchmark?: FrozenBenchmark;
  comparisonBenchmark?: { kind: 'INDUSTRY' | 'MARKET_PROXY' | 'MISSING'; indexCode: string | null;
    industryBindingHash: string; note: string; factIds: string[]; artifactHashes: string[] };
  taskId: string;
  subject: string;
  cutoff: string;
  builtAt: string;
  tables: EvidenceTable[];
  /** 覆盖说明：每类事实的条数、期间与缺口（如实登记，不假装连续）。 */
  coverage: SrCoverage;
  packHash: string; // canonicalSha256(除 packHash 外)
}

export interface SrCoverage {
  financials: { periods: number; latestPeriod: string | null; note: string | null };
  bars: { count: number; firstDate: string | null; lastDate: string | null; note: string | null };
  announcements: { count: number; latestTitleAt: string | null; note: string | null };
  margin: { count: number; latestDate: string | null; note: string | null };
  holderCount: { count: number; latestDate: string | null; note: string | null };
  pledge: { count: number; latestDate: string | null; note: string | null };
  industry: { swL1: string | null; note: string | null };
  valuationInputs: { closePriceDate: string | null; sharesSource: string | null; epsTtmSource: string | null; note: string | null };
  gaps: string[]; // 具名缺口（如"无一致预期数据""无内含价值披露"）
}

// ===== 计算层 =====

export interface ComputedTable extends EvidenceTable {
  formula: string; // 可读公式说明（输入→结果）
  inputs: string[]; // 依赖的 tableId
}

export interface ComputeResult {
  taskId: string;
  cutoff: string;
  tables: ComputedTable[]; // 增长率/利润率/ROE/相对表现/PE-PB 敏感性等
  checks: { name: string; ok: boolean; detail: string }[]; // 计算自检（单位/期间对齐）
}

// ===== 报告对象 =====

export const REPORT_SECTIONS = [
  'summary', // 首页与研究摘要
  'company', // 公司与业务
  'industry', // 行业与竞争
  'drivers', // 核心驱动
  'financials', // 财务质量
  'outlook', // 前景与情景
  'valuation', // 估值与预期
  'market', // 价格与市场表现
  'risk', // 风险与最终判断
  'sources', // 来源与研究边界
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number];

export const SECTION_TITLES: Record<ReportSectionKey, string> = {
  summary: '首页与研究摘要',
  company: '公司与业务',
  industry: '行业与竞争',
  drivers: '核心驱动',
  financials: '财务质量',
  outlook: '前景与情景',
  valuation: '估值与预期',
  market: '价格与市场表现',
  risk: '风险与最终判断',
  sources: '来源与研究边界',
};

export type ClaimStatus = 'FACT' | 'INFERENCE' | 'HYPOTHESIS' | 'REJECTED'; // 已证事实/推断/待验证/J 驳回（裁决后状态）

export interface Finding {
  text: string;
  status: ClaimStatus;
  citations: string[]; // 引用标记 n（对应 section.citations 下标+1，或跨章 sources）
}

export interface Citation {
  label: string; // 展示：如「财务指标 2026Q2」
  locator: EvidenceLocator | { kind: 'SECTION'; sectionKey: string };
  quote?: string; // 截断引用
}

export interface ScenarioRow {
  name: string; // 基准/改善/恶化
  condition: string; // 可观察触发条件
  implication: string; // 对价值/结论的含义
}

export interface ReportSection {
  key: ReportSectionKey;
  title: string;
  narrative: string; // markdown 正文（模型输出，渲染时全量转义+受控标记渲染）
  findings: Finding[];
  tables: string[]; // 引用的 tableId（渲染时从证据包/计算表取）
  citations: Citation[];
  gaps: string[];
  scenarios?: ScenarioRow[]; // outlook 章专用
}

export interface ReportQaFinding {
  code: string; // 如 CITATION_UNRESOLVED / NUMBER_UNPROVENANCED / CUTOFF_LEAK / COUNTERCASE_MISSING
  severity: 'BLOCKING' | 'ADVISORY';
  sectionKey: ReportSectionKey | null;
  detail: string;
}

/** Metis 继承的证据绑定：报告绑定 A 输出/程序清单/J 裁决/证据包四哈希（可整链回读核验）。 */
export interface ReportEvidenceRefs {
  packHash: string; // 证据包（manifest 语义）
  aOutputHash: string; // A 全部产物（分段+终稿）canonical 哈希
  checklistHash: string; // 程序清单哈希
  jOutputHash: string; // J 裁决输出哈希
}

/**
 * 发布门（Metis 发布门继承，适配报告形态）：
 * - mandatoryJDone：J 必经且完成，未完成不得发布；
 * - decisionBearingUnresolved：J 裁决后仍承重的未解项（必须非空处置——逐项具名展示，不静默发布为"完整"）；
 * - passed=false 时报告可落库但状态为 RESTRICTED（发布受限），任务 PARTIAL。
 */
export interface ReportPublishGate {
  mandatoryJDone: boolean;
  decisionBearingUnresolved: string[]; // 具名（清单项 id + 事项）
  passed: boolean;
  reason: string;
}

export interface ReportDocument {
  reportId: string; // 稳定身份（同任务修订共享，跨任务新研究则新 ID）
  taskId: string;
  version: number; // 不可变发布版本（1 起）
  subject: string;
  subjectName: string;
  focus: SrFocus;
  horizon: SrHorizon;
  cutoff: string;
  methodVersion: string;
  adapterVersion: string;
  planAuthVersion: string;
  generatedBy: 'PRODUCT_SIMULATED' | 'PRODUCT_REAL' | 'EXECUTOR_COLLAB' | 'OFFLINE_DERIVED'; // 生成身份，不得混用
  sections: ReportSection[];
  qaFindings: ReportQaFinding[];
  evidenceRefs: ReportEvidenceRefs | null; // 〔C3〕证据绑定四哈希
  gate: ReportPublishGate | null; // 〔C3〕发布门结果
  status: 'DRAFT' | 'PUBLISHED' | 'PUBLISHED_RESTRICTED' | 'SUPERSEDED' // PUBLISHED_RESTRICTED=门未过
  changeSummary: string | null; // 修订版的变化摘要
  createdAt: string;
  publishedAt: string | null;
  derivation?: { sourceReportPath: string; sourceReportSha256: string; mappingPath: string; mappingSha256: string; note: string };
  contentHash: string; // canonicalSha256(除 contentHash 外)
}

// ===== 对话 =====

export type ChatQuestionKind =
  | 'EXPLAIN' // 解释
  | 'CHALLENGE' // 质疑/反驳
  | 'ADJUST_ASSUMPTION' // 假设调整
  | 'MISSING_DATA' // 资料不足
  | 'NEW_CUTOFF' // 更新截点
  | 'OTHER';

export interface ChatMessage {
  messageId: string;
  threadId: string;
  role: 'USER' | 'ASSISTANT';
  kind: ChatQuestionKind; // 助手侧为回答对应的问题分类
  content: string;
  citations: Citation[];
  callId: string | null; // 模型回答绑定调用（无调用为 null）
  suggestedAction: { type: 'NEW_TASK'; cutoff: string; emphasis: string | null } | null; // NEW_CUTOFF 引导
  createdAt: string;
}

export interface ChatThread {
  threadId: string;
  reportId: string;
  accountId: string;
  createdAt: string;
}

// ===== 账户与会话（S4）=====

export type SrRole = 'ADMIN' | 'USER';

export interface SrAccount {
  accountId: string;
  username: string;
  displayName: string;
  role: SrRole;
  quota: SrAccountQuota;
  createdAt: string;
  disabledAt: string | null;
}

export interface SrAccountQuota {
  monthlyReportTasks: number; // 自然月任务数上限（0 = 仅管理员设置）
  monthlyModelCalls: number;
  maxConcurrentTasks: number;
  note?: string; // 套餐说明（试用/正式）
}

export function defaultTrialQuota(): SrAccountQuota {
  return { monthlyReportTasks: 5, monthlyModelCalls: 60, maxConcurrentTasks: 1, note: '试用' };
}

export interface SrSession {
  sessionId: string;
  accountId: string;
  csrfToken: string; // 会话绑定 CSRF 令牌（表单回传校验）
  createdAt: string;
  expiresAt: string;
}

// ===== 传输层（模型通道）=====

export type SrModelStepKind = 'PLAN' | 'ANALYZE' | 'A_FINAL' | 'CHECKLIST' | 'JUDGE' | 'SYNTHESIZE' | 'QA_JUDGE' | 'CHAT_ANSWER';

export interface SrTransportDescribe {
  provider: string;
  simulated: boolean;
  modelId: string | null;
  effort?: string;
}

export interface SrModelTransport {
  describe(step?: SrModelStepKind): SrTransportDescribe;
  dispatch(step: SrModelStepKind, ctx: { callId: string; inputHash: string; deadline?: string }, payload: unknown): Promise<unknown>;
}

// ===== 引擎依赖注入（测试可替换）=====

export interface SrEngineDeps {
  dataPool: import('pg').Pool; // 只读事实面（public）
  srPool: import('pg').Pool; // sr 命名空间
  transport: SrModelTransport;
  budget: SrPlanBudget;
  outputDir: string; // 默认 SR_OUTPUT_DIR
  now?: () => Date;
}
