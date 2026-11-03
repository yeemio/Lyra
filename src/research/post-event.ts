/**
 * Lyra · 事件后研究编排器（P3 W20: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md §3.1–3.3（SC-3.2 截点=公告发布时刻、SC-3.3 启动闸）、
 * §7（SC-7.1 准入时继承声明）；docs/specs/RESEARCH-METHOD.md §7（继承语义：INHERITED 是
 * 先验模型判断非当前事实、只重新评估新公告、维持与改判都写桥接）、§8（继承指针 + 改判理由
 * 必填——J 维持也写）、§2（A → 程序清单 → 必经 J）；docs/specs/P3-EVENTS-REVIEW.md
 * Done-when 4（事件后研究流程：继承消费）。
 *
 * 编排链（一次事件后研究 = 恰好 A+J 两次模型调用，全部经 kernel.runModelCall，EK-3.2）：
 *   0) 事件形状校验 + SC-3.3 启动闸（canStartPostEvent，时钟注入；08:00 后新启动具名拒绝）；
 *   1) 事件准入记录（复用 W17 admitPostEvent 形态：截点=事件 availableAt 基准，触发引用=[eventId]）；
 *   2) 继承声明（复用 W17 declarePostEventInheritance）：先验经 RM §7.1 资格校验
 *      （同股 / 周度结论 / 先验截点严格早于本次截点 / 方法版本兼容 / 已落库即 A/J 完整有效），
 *      不满足任一条 → 不继承，落 STANDALONE（"无基础结论可继承"）；
 *   3) 组装输入（assembleResearchInput，POST_EVENT 业务键、截点=事件时点——W11 组装器
 *      researchKind 参数原生接受 POST_EVENT，无缺口）；
 *   4) 模拟 A（经 transport.dispatch）→ deriveChecklist（无模型机械抽取）→ 模拟 J →
 *      persistConclusion（继承指针 + changeReason：INHERITED 恒必填，桥接文本程序拼装，
 *      含"先验是先验模型判断非当前事实 / 本轮只重新评估新公告 / 触发事件引用"三要素）。
 *
 * 执行截止（EK-6.1）：缺省 = 事件窗口截止（postEventWindowOf 显式计算，SC-3.3 次日 09:15，
 * 绝不从计划模板继承）。历史事件重放（窗口截止早于真实时钟）须显式传入 deadline——
 * 内核发送前截止闸会对过期窗口具名拒绝 DEADLINE_EXCEEDED（合同行为，不绕过）；显式传入的
 * deadline 原样写入 permit 落库可审计。
 */
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import type {
  ArtifactRef,
  AOutput,
  ConclusionObject,
  JOutput,
  PlanAuthBudget,
} from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { runModelCall } from '../kernel/executor.js';
import type { ModelTransport } from '../kernel/transport.js';
import { persistConclusion } from '../db/conclusion.js';
import type { TradeCalendarTable } from '../adapters/calendar.js';
import {
  canStartPostEvent,
  postEventWindowOf,
  ScheduleError,
  type PostEventWindow,
} from '../schedule/windows.js';
import {
  admitPostEvent,
  declarePostEventInheritance,
  type AdmissionRecord,
  type CompletedWeeklyRef,
  type InheritanceDeclaration,
} from '../schedule/queue.js';
import { assembleResearchInput, type InputBudget, type ResearchInputPackage } from './inputs.js';
import { deriveChecklist } from './checklist.js';

/** 事件后研究编排具名错误（code 为稳定错误名）。 */
export class PostEventError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'PostEventError';
  }
}

/** 触发事件引用（public.events 行形态，W14 EventInstance 兼容；只消费不重定义判定）。 */
export interface PostEventTriggerEvent {
  eventId: string;
  /** 个股代码（裸 6 位；宽基不进事件后研究，SC-4.1）。 */
  subject: string;
  type: string;
  subtype: string | null;
  /** ISO；= availableAt 基准（W14 口径）= 本次研究资料截点（SC-3.2）。 */
  eventTime: string;
  evidenceFactId: string;
  attrs?: Record<string, unknown>;
}

/** 继承入参：null = STANDALONE；先验为已落库结论对象（id/hash 与资格字段取自其身）。 */
export type PostEventInheritanceInput = { priorConclusion: ConclusionObject } | null;

/** RM §7.1 继承资格判定结果（不满足任一条即不继承，落 STANDALONE，不猜）。 */
export type InheritanceEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

export interface PostEventResearchDeps {
  /** 材料读取与封存写入库（生产 public：事实 + seal_manifest）。 */
  dataPool: Pool;
  /** 执行内核与结论落库库（exec_permit + conclusion；测试用隔离 schema）。 */
  execPool: Pool;
  store: ArtifactStore;
  transport: ModelTransport;
  calendar: TradeCalendarTable;
}

export interface PostEventResearchOptions {
  event: PostEventTriggerEvent;
  inheritance: PostEventInheritanceInput;
  budget: PlanAuthBudget;
  holderId?: string;
  /** 研究身份版本轴（方法 / 数据与适配器；执行计划与授权版本取 budget.planAuthVersion）。 */
  versions: { methodVersion: string; adapterVersion: string };
  /** 输入分层预算（RM §5）；缺省取 P2 旅程对 600519 真实数据验证过的量级。 */
  inputBudget?: InputBudget;
  /** SC-3.1 检测命中时刻（准入记录义务）；缺省取事件时点。 */
  detectedAt?: string;
  /** 启动闸判定时钟（SC-3.3）；缺省当前时刻。 */
  now?: Date;
  /**
   * 执行截止（EK-6.1：显式给定、不从模板继承）。缺省 = 事件窗口截止（SC-3.3 次日 09:15）。
   * 历史事件重放须显式传入（窗口截止早于真实时钟时，内核具名拒绝 DEADLINE_EXCEEDED——
   * 该拒绝是合同行为；传入的 deadline 原样落 permit 可审计）。
   */
  deadline?: string;
  poolInfoFile?: string;
}

/** 缺省输入分层预算（真实 600519 数据上 P2 旅程验证过的量级；L0/L2 不可裁剪）。 */
export const DEFAULT_POST_EVENT_INPUT_BUDGET: InputBudget = {
  l0Bytes: 20_000,
  l1Bytes: 140_000,
  l2Bytes: 160_000,
  totalBytes: 300_000,
};

export interface PostEventResearchOutcome {
  admission: AdmissionRecord;
  window: PostEventWindow;
  declaration: InheritanceDeclaration;
  eligibility: InheritanceEligibility;
  inputHash: string;
  inputBytes: number;
  inputArtifactRef: ArtifactRef;
  package: ResearchInputPackage;
  permits: { aPermitId: string; jPermitId: string };
  conclusion: ConclusionObject;
}

// ===== 内部工具 =====

function parseInstant(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new PostEventError('EVENT_SHAPE_INVALID', `${field}: ${value}`);
  return d;
}

/** RM §7.1 继承资格：同股 / STOCK / 周度结论 / 先验截点严格早于本次截点 / 方法版本兼容；
 * "先验 A/J 完整有效"由先验是已落库结论对象（buildConclusionObject 全字段校验 + 不可变落库）承载。 */
function checkInheritanceEligibility(
  event: PostEventTriggerEvent,
  prior: ConclusionObject,
  methodVersion: string,
): InheritanceEligibility {
  if (prior.businessKey.subject !== event.subject) {
    return { eligible: false, reason: `先验标的 ${prior.businessKey.subject} ≠ 事件标的 ${event.subject}` };
  }
  if (prior.businessKey.subjectKind !== 'STOCK') {
    return { eligible: false, reason: `先验标的类别 ${prior.businessKey.subjectKind} 非 STOCK` };
  }
  if (prior.businessKey.researchKind !== 'WEEKLY') {
    return { eligible: false, reason: `先验研究类型 ${prior.businessKey.researchKind} 非本周周度结论（SC-7.1）` };
  }
  if (new Date(prior.businessKey.cutoff).getTime() >= new Date(event.eventTime).getTime()) {
    return { eligible: false, reason: `先验资料截点 ${prior.businessKey.cutoff} 不早于本次截点 ${event.eventTime}` };
  }
  if (prior.methodVersion !== methodVersion) {
    return { eligible: false, reason: `先验方法版本 ${prior.methodVersion} 与本轮 ${methodVersion} 不兼容` };
  }
  return { eligible: true };
}

/** INHERITED 的 changeReason 桥接文本（RM §7.1 维持与改判都写；三要素：先验是模型判断 / 只重新评估新公告 / 触发引用）。 */
function inheritanceChangeReason(
  event: PostEventTriggerEvent,
  prior: ConclusionObject,
  jOutput: JOutput,
): string {
  const relation =
    jOutput.finalDisposition === prior.disposition
      ? `维持先验结论方向（先验 ${prior.disposition}）`
      : `改判先验结论方向（先验 ${prior.disposition} → 本轮 J 终判 ${jOutput.finalDisposition}）`;
  const vsA = jOutput.changedFromA
    ? `；J 相对 A 候选改判：${jOutput.changeReason ?? '(A/J 改判理由缺失)'}`
    : '；J 维持 A 候选';
  return (
    `事件后研究继承桥接（RM §7.1）：先验 ${prior.conclusionId} 是先验模型判断，不是当前事实，不构成自动选择；` +
    `本轮只重新评估新公告（触发事件 ${event.eventId} ${event.type}${event.subtype === null ? '' : `/${event.subtype}`}，证据事实 ${event.evidenceFactId}）；` +
    `${relation}${vsA}`
  );
}

// ===== 编排主函数 =====

/**
 * 执行一次事件后研究（准入 → 继承声明 → 组装 → 模拟 A → 清单 → 模拟 J → 结论落库）。
 * 模型调用恰两次（A/J），全部经 kernel.runModelCall（permit 纪律 EK-3.2；模拟器同样不得 bypass）。
 */
export async function runPostEventResearch(
  deps: PostEventResearchDeps,
  opts: PostEventResearchOptions,
): Promise<PostEventResearchOutcome> {
  const { event, budget } = opts;
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new PostEventError('EVENT_SHAPE_INVALID', 'eventId 为空');
  }
  if (typeof event.subject !== 'string' || !/^\d{6}$/.test(event.subject)) {
    throw new PostEventError('EVENT_SHAPE_INVALID', `subject: ${event.subject}（须裸 6 位个股代码）`);
  }
  if (typeof event.evidenceFactId !== 'string' || event.evidenceFactId.length === 0) {
    throw new PostEventError('EVENT_SHAPE_INVALID', 'evidenceFactId 为空');
  }
  parseInstant(event.eventTime, 'event.eventTime');
  const now = opts.now ?? new Date();

  // 0) SC-3.3 启动闸：检测命中后即可启动；次日 08:00 后新启动具名拒绝（不猜）。
  const gate = canStartPostEvent(deps.calendar, event.eventTime, now);
  if (!gate.allowed) {
    throw new ScheduleError(gate.code, `事件 ${event.eventId}（${event.eventTime}）启动被拒：latestStart=${gate.latestStart}`);
  }

  // 1) 事件准入记录（W17 admitPostEvent 形态；截点=事件 availableAt 基准，SC-3.2）。
  const admission = admitPostEvent(
    {
      subject: event.subject,
      subjectKind: 'STOCK',
      publishedAt: event.eventTime,
      detectedAt: opts.detectedAt ?? event.eventTime,
      triggerEventIds: [event.eventId],
    },
    now.toISOString(),
  );

  // 2) 继承声明（判定时机=准入时刻，SC-7.1；资格不满足即 STANDALONE，RM §7.1）。
  const prior = opts.inheritance === null ? null : opts.inheritance.priorConclusion;
  const eligibility =
    prior === null
      ? ({ eligible: false, reason: '无基础结论可继承（未注入先验）' } as InheritanceEligibility)
      : checkInheritanceEligibility(event, prior, opts.versions.methodVersion);
  const weeklyRefs: CompletedWeeklyRef[] =
    prior !== null && eligibility.eligible
      ? [{
          subject: prior.businessKey.subject,
          conclusionId: prior.conclusionId,
          conclusionHash: prior.conclusionHash,
          completedAt: prior.createdAt,
        }]
      : [];
  const declaration = declarePostEventInheritance(event.subject, weeklyRefs);

  // 3) 组装输入（POST_EVENT 业务键、截点=事件时点；W11 组装器原生支持，无缺口）。
  const assembled = await assembleResearchInput(deps.dataPool, deps.store, {
    subjectKind: 'STOCK',
    subject: event.subject,
    cutoff: event.eventTime,
    budget: opts.inputBudget ?? DEFAULT_POST_EVENT_INPUT_BUDGET,
    versions: {
      methodVersion: opts.versions.methodVersion,
      adapterVersion: opts.versions.adapterVersion,
      planAuthVersion: budget.planAuthVersion,
    },
    researchKind: 'POST_EVENT',
    ...(opts.poolInfoFile === undefined ? {} : { poolInfoFile: opts.poolInfoFile }),
  });
  const businessKey = assembled.package.businessKey; // 组装器规范化后的业务键（cutoff ISO 化）

  // 执行截止（EK-6.1）：显式给定优先；缺省 = 窗口截止（显式计算，不从模板继承）。
  const window = postEventWindowOf(deps.calendar, event.eventTime);
  const deadline = opts.deadline ?? window.deadline;
  parseInstant(deadline, 'deadline');

  // 4a) 模拟 A（经 transport，permit 已 SENT 才发送——EK-3.2/EK-11.2）。
  const material = {
    artifactSha256s: assembled.package.seals.flatMap((s) => s.artifactRefs.map((r) => r.sha256)).slice(0, 12),
    factCount: assembled.package.seals.reduce((n, s) => n + s.factIds.length, 0),
    gaps: assembled.package.dimensions.flatMap((c) => c.gap),
  };
  const a = await runModelCall<AOutput>(deps.execPool, {
    contract: {
      businessKey,
      stage: 'A',
      inputHash: assembled.inputHash,
      inputBytes: assembled.inputBytes,
      methodVersion: opts.versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline,
    },
    budget,
    modelFn: async (ctx) =>
      (await deps.transport.dispatch(ctx.contract, {
        inputHash: assembled.inputHash,
        subjectKind: 'STOCK',
        subject: event.subject,
        material,
      })) as AOutput,
    simulated: deps.transport.describe().simulated,
    ...(opts.holderId === undefined ? {} : { holderId: opts.holderId }),
  });

  // 4b) 程序清单（无模型机械抽取；绑定真实封存 manifest）。
  const manifest = assembled.package.seals[0];
  if (manifest === undefined) throw new PostEventError('SEAL_MISSING', '输入包无封存 manifest');
  const checklist = deriveChecklist(a.output, manifest.manifestHash);

  // 4c) 模拟 J（inputHash = 程序对 J 输入整体的哈希，RM §2.3 输入哈希回抄）。
  const jInputHash = canonicalSha256({ a: a.output, checklist });
  const j = await runModelCall<JOutput>(deps.execPool, {
    contract: {
      businessKey,
      stage: 'J',
      inputHash: jInputHash,
      inputBytes: assembled.inputBytes,
      methodVersion: opts.versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline,
    },
    budget,
    modelFn: async (ctx) =>
      (await deps.transport.dispatch(ctx.contract, {
        inputHash: jInputHash,
        subjectKind: 'STOCK',
        aOutput: a.output,
        checklist,
      })) as JOutput,
    simulated: deps.transport.describe().simulated,
    ...(opts.holderId === undefined ? {} : { holderId: opts.holderId }),
  });

  // 4d) 结论对象（继承指针 + 改判理由；INHERITED 恒写桥接——维持也写，RM §7.1/§8）。
  const inheritedFrom = declaration.basis === 'INHERITED' && prior !== null ? prior : null;
  const inheritance =
    inheritedFrom === null
      ? null
      : { fromConclusionId: inheritedFrom.conclusionId, fromConclusionHash: inheritedFrom.conclusionHash };
  const changeReason =
    inheritedFrom !== null
      ? inheritanceChangeReason(event, inheritedFrom, j.output)
      : j.output.changedFromA
        ? j.output.changeReason
        : null;
  const conclusion = await persistConclusion(deps.execPool, {
    businessKey,
    methodVersion: opts.versions.methodVersion,
    adapterVersion: opts.versions.adapterVersion,
    planAuthVersion: budget.planAuthVersion,
    aOutput: a.output,
    checklist,
    jOutput: j.output,
    manifest,
    inheritance,
    changeReason,
  });

  return {
    admission: { ...admission, started: true, sent: true, notes: [...admission.notes] },
    window,
    declaration,
    eligibility,
    inputHash: assembled.inputHash,
    inputBytes: assembled.inputBytes,
    inputArtifactRef: assembled.artifactRef,
    package: assembled.package,
    permits: { aPermitId: a.permit.permitId, jPermitId: j.permit.permitId },
    conclusion,
  };
}
