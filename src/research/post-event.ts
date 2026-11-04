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
 *      （同股 / 本周已完成周度结论 / 先验截点严格早于本次截点 / 方法版本兼容），
 *      从数据库及 CAS 读回原输入/A/清单/J；缺原文或资格不符 → STANDALONE 完整重研；
 *   3) 组装输入（assembleResearchInput，POST_EVENT 业务键、截点=事件时点——W11 组装器
 *      researchKind 参数原生接受 POST_EVENT，无缺口）；
 *   4) A（经 transport.dispatch）→ deriveChecklist（无模型机械抽取）→ J →
 *      persistResearchConclusion（先保存原文 CAS；INHERITED 必须有 J 自身比较理由，程序附加桥接，
 *      含"先验是先验模型判断非当前事实 / 本轮只重新评估新公告 / 触发事件引用"三要素）。
 *
 * 执行截止（EK-6.1）：缺省 = 事件窗口截止（postEventWindowOf 显式计算，SC-3.3 次日 09:15，
 * 绝不从计划模板继承）。历史事件重放（窗口截止早于真实时钟）须显式传入 deadline——
 * 内核发送前截止闸会对过期窗口具名拒绝 DEADLINE_EXCEEDED（合同行为，不绕过）；显式传入的
 * deadline 原样写入 permit 落库可审计。
 */
import type { Pool } from 'pg';
import { canonicalJsonString } from '../canonical.js';
import type {
  ArtifactRef,
  AOutput,
  ConclusionObject,
  JOutput,
  PlanAuthBudget,
} from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { withExecutionLease, type ExecutionLease } from '../kernel/lease.js';
import { releaseUnsentReservations } from '../kernel/budget.js';
import { coalesceResearchRun, withResearchClaim, freezeResearchSnapshot, runResearchStage, publishResearchCheckpoint } from './gate-m-checkpoint.js';
import type { ModelTransport } from '../kernel/transport.js';
import { loadFact } from '../pintime/facts.js';
import { buildARequest, buildJRequest, assertAssembledIdentity } from './requests.js';
import { validateResearchA, validateResearchJ } from './validation.js';
import { loadPriorResearch, immutablePrior, withPostEventContext, validatePostEventContext, type PostEventTriggerEvent, type PostEventContext } from './inheritance.js';
export type { PostEventTriggerEvent } from './inheritance.js';
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
  assembleInput?: typeof assembleResearchInput;
}

export interface PostEventResearchOptions {
  event: PostEventTriggerEvent;
  inheritance: PostEventInheritanceInput;
  budget: PlanAuthBudget;
  holderId?: string;
  lease?: ExecutionLease;
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
    : `；J 维持 A 候选；J 对先验和新增事件的比较：${jOutput.changeReason}`;
  return (
    `事件后研究继承桥接（RM §7.1）：先验 ${prior.conclusionId} 是先验模型判断，不是当前事实，不构成自动选择；` +
    `本轮只重新评估新公告（触发事件 ${event.eventId} ${event.type}${event.subtype === null ? '' : `/${event.subtype}`}，证据事实 ${event.evidenceFactId}）；` +
    `${relation}${vsA}`
  );
}

// ===== 编排主函数 =====

/**
 * 执行一次事件后研究（准入 → 继承原文核验 → 组装 → A → 清单 → J → 原文/结论落库）。
 * 模型调用恰两次（A/J），全部经 kernel.runModelCall（permit 纪律 EK-3.2；模拟器同样不得 bypass）。
 */
export async function runPostEventResearch(
  deps: PostEventResearchDeps,
  opts: PostEventResearchOptions,
): Promise<PostEventResearchOutcome> {
  return coalesceResearchRun(deps.execPool, { subjectKind: 'STOCK', subject: opts.event.subject, cutoff: opts.event.eventTime, researchKind: 'POST_EVENT' },
    { event: opts.event, budget: opts.budget, versions: opts.versions, inputBudget: opts.inputBudget ?? DEFAULT_POST_EVENT_INPUT_BUDGET, deadline: opts.deadline ?? null, transport: deps.transport.describe() },
    () => withExecutionLease(deps.execPool, 'kernel', ({ lease }) =>
      withResearchClaim(deps.execPool, lease, { subjectKind: 'STOCK', subject: opts.event.subject,
        cutoff: opts.event.eventTime, researchKind: 'POST_EVENT' }, () => runPostEventInner(deps, { ...opts, lease })), opts));
}

async function runPostEventInner(deps: PostEventResearchDeps, opts: PostEventResearchOptions): Promise<PostEventResearchOutcome> {
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
  const snapshot = await freezeResearchSnapshot(deps.execPool, deps.store, opts.lease!,
    { subjectKind: 'STOCK', subject: event.subject, cutoff: event.eventTime, researchKind: 'POST_EVENT' },
    { event, versions: opts.versions, budget, inputBudget: opts.inputBudget ?? DEFAULT_POST_EVENT_INPUT_BUDGET,
      transport: deps.transport.describe(), requestedDeadline: opts.deadline ?? null }, async () => {
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
  const resolved = await loadPriorResearch(deps.execPool, deps.store, opts.inheritance?.priorConclusion ?? null, event, opts.versions.methodVersion, now.toISOString());
  const prior = resolved.prior?.conclusion ?? null;
  const eligibility: InheritanceEligibility = prior === null ? { eligible: false, reason: resolved.reason } : { eligible: true };
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
  const base = await (deps.assembleInput ?? assembleResearchInput)(deps.dataPool, deps.store, {
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
  assertAssembledIdentity(base, { subjectKind: 'STOCK', subject: event.subject, cutoff: event.eventTime, researchKind: 'POST_EVENT' },
    { ...opts.versions, planAuthVersion: budget.planAuthVersion });
  const eventFact = await loadFact(deps.dataPool, event.evidenceFactId);
  if (eventFact === null) throw new PostEventError('EVENT_FACT_MISSING', event.evidenceFactId);
  const context: PostEventContext = resolved.prior === null
    ? { kind: 'POST_EVENT_CONTEXT_V2', basis: 'STANDALONE', prior: null, event, eventFact, admittedAt: now.toISOString(), reason: resolved.reason }
    : { kind: 'POST_EVENT_CONTEXT_V2', basis: 'INHERITED', prior: resolved.prior, event, eventFact, admittedAt: now.toISOString(), reason: resolved.reason };
  const pkg = withPostEventContext(base.package, context, opts.inputBudget ?? DEFAULT_POST_EVENT_INPUT_BUDGET);
  const artifactRef = await deps.store.put(new TextEncoder().encode(canonicalJsonString(pkg)), 'application/json', new Date().toISOString());
  const assembled = { package: pkg, artifactRef, inputHash: pkg.inputHash, inputBytes: artifactRef.bytes };

  // 执行截止（EK-6.1）：显式给定优先；缺省 = 窗口截止（显式计算，不从模板继承）。
  const window = postEventWindowOf(deps.calendar, event.eventTime);
  const deadline = opts.deadline ?? window.deadline;
  parseInstant(deadline, 'deadline');

    return { version: 1, assembled, deadline, metadata: { admission, window, declaration, eligibility } };
  });
  const { assembled, deadline } = snapshot;
  const { admission, window, declaration, eligibility } = snapshot.metadata;
  const pkg = assembled.package;
  const businessKey = pkg.businessKey;
  assertAssembledIdentity(assembled, { subjectKind: 'STOCK', subject: event.subject, cutoff: event.eventTime, researchKind: 'POST_EVENT' },
    { ...opts.versions, planAuthVersion: budget.planAuthVersion });
  const original = validatePostEventContext(pkg);
  if (!original) throw new PostEventError('RESEARCH_CHECKPOINT_INVALID', 'Missing original event admission');
  // Reissue the nonserializable verification receipt from original DB/CAS evidence and original admission time.
  const resolved = await loadPriorResearch(deps.execPool, deps.store, original.prior?.conclusion ?? null,
    original.event, opts.versions.methodVersion, original.admittedAt);
  if (original.basis === 'INHERITED' && (!resolved.prior || canonicalJsonString(immutablePrior(resolved.prior)) !== canonicalJsonString(immutablePrior(original.prior!)))) {
    throw new PostEventError('RESEARCH_CHECKPOINT_INVALID', 'Original inherited evidence no longer verifies');
  }
  const prior = resolved.prior?.conclusion ?? null;

  // 4a) A（经 transport，permit 已 SENT 才发送——EK-3.2/EK-11.2）。
  const simulated = deps.transport.describe().simulated;
  const aRequest = buildARequest(pkg, simulated);
  const a = await runResearchStage<AOutput>({
    pool: deps.execPool, lease: opts.lease!, transport: deps.transport, snapshot, request: aRequest,
    contract: {
      businessKey,
      stage: 'A',
      inputHash: assembled.inputHash,
      inputBytes: aRequest.inputBytes,
      methodVersion: opts.versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline,
    },
    budget,
    validate: (value) => validateResearchA(value, pkg, simulated),
  });

  // 4b) 程序清单（无模型机械抽取；绑定真实封存 manifest）。
  const manifest = assembled.package.seals[0];
  if (manifest === undefined) throw new PostEventError('SEAL_MISSING', '输入包无封存 manifest');
  const checklist = deriveChecklist(a.output, manifest.manifestHash);

  // 4c) J（inputHash 绑定实际材料包 + A + 清单，RM §2.3 输入哈希回抄）。
  const jRequest = buildJRequest(pkg, a.output, checklist, simulated);
  const jInputHash = jRequest.inputHash;
  const j = await runResearchStage<JOutput>({
    pool: deps.execPool, lease: opts.lease!, transport: deps.transport, snapshot, request: jRequest,
    contract: {
      businessKey,
      stage: 'J',
      inputHash: jInputHash,
      inputBytes: jRequest.inputBytes,
      methodVersion: opts.versions.methodVersion,
      planAuthVersion: budget.planAuthVersion,
      deadline,
    },
    budget,
    validate: (value) => validateResearchJ(value, pkg, a.output, checklist, simulated),
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
  const conclusion = await publishResearchCheckpoint(deps.execPool, deps.store, opts.lease!, {
    businessKey,
    methodVersion: opts.versions.methodVersion,
    adapterVersion: opts.versions.adapterVersion,
    planAuthVersion: budget.planAuthVersion,
    aOutput: a.output,
    researchInput: pkg,
    ...(resolved.verification === undefined ? {} : { verifiedPrior: resolved.verification }),
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
