/**
 * Lyra · 不重叠样本与分母视图（P3 W13: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md SR-4（全机会分母：分母单位=研究准入 attempt，
 * 终态互斥六类；MISSED 两子类；可成交性视图；三条禁令；主统计分母交集；快照计数项）/
 * SR-5.1（不重叠：同股上一结论 20 日周期结束前产生的新结论不进汇总，判定基准=同股
 * 时间上最近的前一个结论对象（无论其本身是否被排除、是否可成交），新结论参考价日 ≤
 * 前一结论窗口结束日即排除）/ SR-5.2（排除不豁免：被排除结论照常结算与展示，只是不进
 * 汇总）。执行侧分类消费：docs/specs/EXECUTION-KERNEL.md EK-6.2（MISSED_WINDOW）、
 * EK-9.2（事件后溢出降级标注）；docs/specs/SCHEDULING.md SC-6.2（降级并入次日周度）、
 * SC-5.3（从未发送者顺延）。
 *
 * 全部纯函数（无 DB）：不重叠判定与终态分类的输入由调用方从结论对象/执行记录组装，
 * 样本身份可程序判定、可审计重放（SR-5.1）。
 */

// ===== 不重叠样本（SR-5.1）=====

/** 结论的窗口身份素材（reference.ts/excess.ts 产物；审计重放用）。 */
export interface ConclusionWindowInfo {
  conclusionId: string;
  /** 股票代码（同股判定键）。 */
  subject: string;
  /** 结论完成时刻（ISO；锚定"最近前一个结论"的排序键）。 */
  conclusionTime: string;
  /** 参考价日（YYYY-MM-DD）。 */
  referenceDay: string;
  /** 窗口结束日（第 20 个有成交交易日，YYYY-MM-DD）。 */
  windowEndDay: string;
  /** 本结论是否已被不重叠规则排除（锚定判定含被排除者，SR-5.1）。 */
  overlapExcluded: boolean;
}

/**
 * 锚定同股最近前一个结论（SR-5.1）：subject 相同、完成时刻早于新结论的结论中取最近一个
 * （含被排除者——排除不改变锚定基准）；无前一个结论返回 null。
 */
export function overlappingAnchor(
  subject: string,
  conclusionTime: string,
  priorConclusions: readonly ConclusionWindowInfo[],
): ConclusionWindowInfo | null {
  let anchor: ConclusionWindowInfo | null = null;
  for (const c of priorConclusions) {
    if (c.subject !== subject) continue;
    if (c.conclusionTime >= conclusionTime) continue;
    if (anchor === null || c.conclusionTime > anchor.conclusionTime) anchor = c;
  }
  return anchor;
}

/** SR-5.1 排除判定：新结论参考价日 ≤ 前一结论窗口结束日 → 排除（无锚定不排除）。 */
export function overlapExcluded(newReferenceDay: string, anchor: ConclusionWindowInfo | null): boolean {
  return anchor !== null && newReferenceDay <= anchor.windowEndDay;
}

/** 组合一步：锚定 + 排除判定。 */
export function overlapJudgement(
  subject: string,
  conclusionTime: string,
  newReferenceDay: string,
  priorConclusions: readonly ConclusionWindowInfo[],
): { anchor: ConclusionWindowInfo | null; excluded: boolean } {
  const anchor = overlappingAnchor(subject, conclusionTime, priorConclusions);
  return { anchor, excluded: overlapExcluded(newReferenceDay, anchor) };
}

// ===== 终态互斥分类（SR-4.1/4.2）=====

export type DenominatorTerminal = 'SELECTED' | 'ABSTAIN' | 'TECH_FAILURE' | 'MISSED' | 'UNKNOWN' | 'PENDING';
export type MissedSubclass = 'MISSED_OVERFLOW' | 'MISSED_WINDOW';

/** 执行侧结果（EK 分类的消费面）。 */
export type AttemptExecution =
  | { kind: 'SUCCEEDED' } // 执行成功（正常完成路径）
  | { kind: 'TECH_FAILURE'; code: string } // 执行或结构校验失败（A 未过结构校验、执行异常落库）
  | { kind: 'UNKNOWN' } // 远端结果未知（不重发、不自动重采样）
  | { kind: 'MISSED_WINDOW' } // 已启动而完成截止到期未完成（EK-6.2）
  | { kind: 'MISSED_OVERFLOW'; completed: boolean } // 事件后溢出降级（SC-6.2/EK-9.2）：completed=降级后次日按周度窗完成
  | { kind: 'QUEUED_DEFERRED' }; // 从未发送、仍在队列顺延（SC-5.3）

export interface DenominatorAttempt {
  attemptId: string;
  /** 结论对象（产生结论时；disposition 只需方向性判定）。 */
  conclusion: { disposition: string } | null;
  execution: AttemptExecution;
}

export interface DenominatorClassification {
  terminal: DenominatorTerminal;
  /** terminal=MISSED 时必填子类。 */
  missedSubclass: MissedSubclass | null;
  /** 并存标注：溢出降级后完成者（terminal=SELECTED/ABSTAIN 且曾降级，SR-4.2 独立计数）。 */
  missedOverflowTag: boolean;
}

const DIRECTIONAL_DISPOSITIONS = new Set([
  'RESEARCH_OUTPERFORM',
  'RESEARCH_UNDERPERFORM',
  'RESEARCH_UP',
  'RESEARCH_DOWN',
]);

/** 分母域具名错误。 */
export class DenominatorError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'DenominatorError';
  }
}

/**
 * 六终态互斥分类（SR-4.1/4.2）。结构性矛盾输入（成功却无结论、失败却有结论等）具名拒绝
 * ——互斥性由分类器保证，不静默猜测（SR-4.4 三条禁令的前置）。
 */
export function classifyDenominator(attempt: DenominatorAttempt): DenominatorClassification {
  const { conclusion, execution } = attempt;
  const hasConclusion = conclusion !== null;
  const completedOverflow = execution.kind === 'MISSED_OVERFLOW' && execution.completed;
  if (hasConclusion && execution.kind !== 'SUCCEEDED' && !completedOverflow) {
    throw new DenominatorError(
      'DENOMINATOR_INPUT_CONFLICT',
      `${attempt.attemptId}: 产生结论（${conclusion?.disposition ?? '?'}）与执行结果 ${execution.kind} 矛盾（结论只能来自成功或降级后完成的执行）`,
    );
  }
  if (!hasConclusion && execution.kind === 'SUCCEEDED') {
    throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${attempt.attemptId}: 执行成功但无结论对象`);
  }
  if (!hasConclusion && completedOverflow) {
    throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${attempt.attemptId}: 降级后完成（completed=true）但无结论对象`);
  }
  if (hasConclusion) {
    const disposition = (conclusion as { disposition: string }).disposition;
    if (disposition === 'ABSTAIN') {
      return { terminal: 'ABSTAIN', missedSubclass: null, missedOverflowTag: completedOverflow };
    }
    if (!DIRECTIONAL_DISPOSITIONS.has(disposition)) {
      throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${attempt.attemptId}: 未知 disposition ${disposition}`);
    }
    return { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: completedOverflow };
  }
  switch (execution.kind) {
    case 'TECH_FAILURE':
      return { terminal: 'TECH_FAILURE', missedSubclass: null, missedOverflowTag: false }; // ①技术失败不冒充放弃
    case 'UNKNOWN':
      return { terminal: 'UNKNOWN', missedSubclass: null, missedOverflowTag: false }; // ②UNKNOWN 不回写失败，单列"未知（非 0）"
    case 'MISSED_WINDOW':
      return { terminal: 'MISSED', missedSubclass: 'MISSED_WINDOW', missedOverflowTag: false };
    case 'MISSED_OVERFLOW': // 降级后仍未按周度窗完成 → 终态 MISSED（子类溢出降级）
      return { terminal: 'MISSED', missedSubclass: 'MISSED_OVERFLOW', missedOverflowTag: false };
    case 'QUEUED_DEFERRED':
      return { terminal: 'PENDING', missedSubclass: null, missedOverflowTag: false }; // ③PENDING 不冒充终态
    case 'SUCCEEDED':
      throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${attempt.attemptId}: unreachable（成功无结论已在上方拒绝）`);
  }
}

// ===== 分母视图（SR-4.3/4.5/4.7）=====

/** 分母视图样本（attempt + 结算侧视图字段的组合；全部由调用方从真实状态组装）。 */
export interface DenominatorSample {
  attemptId: string;
  subjectKind: 'STOCK' | 'BROAD_ETF';
  classification: DenominatorClassification;
  /** SELECTED 上的可成交性（ASHARE-RULES §5/§6 分类；非 SELECTED 为 null）。 */
  tradability: string | null;
  /** SR-5.1 overlap_excluded。 */
  overlapExcluded: boolean;
  /** 窗口是否已走完并已结算（未到期=未结算）。 */
  settled: boolean;
}

export interface DenominatorView {
  /** 快照内全部准入 attempt 数（分母的"全机会"基数）。 */
  totalAdmissions: number;
  selected: number;
  abstain: number;
  techFailure: number;
  missed: number;
  unknown: number;
  pending: number;
  /** MISSED 子类（terminal=MISSED 者的子类计数）。 */
  missedOverflow: number;
  missedWindow: number;
  /** 溢出降级"并存标注"计数（降级后完成者：terminal=SELECTED/ABSTAIN 且 tag，SR-4.2）。 */
  missedOverflowCompletedTag: number;
  /** SELECTED 上的可成交性视图（SR-4.3）。 */
  fillable: number;
  unfillableLimitUp: number;
  unfillableLimitDown: number;
  unfillableSuspended: number;
  suspendedOver20d: number;
  /** 不重叠排除计数（overlap_excluded=true 的选择样本，SR-4.7）。 */
  overlapExcludedCount: number;
  /** 未到期计数（窗口未走完、尚未结算的结论，SR-2.4/4.7）。 */
  notDue: number;
  /** 主统计分母（SR-4.5 交集 ∩ 个股 SR-8A.5）计数与成员清单。 */
  mainDenominator: { count: number; attemptIds: string[] };
}

/**
 * 分母视图（SR-4.7 全部计数项，全部独立计数、口径固定）。内建互斥断言：六终态计数之和
 * = 样本总数（SR-4.1 证伪——重叠或遗漏即违约，不静默吞）。
 */
export function buildDenominatorView(samples: readonly DenominatorSample[]): DenominatorView {
  const view: DenominatorView = {
    totalAdmissions: samples.length,
    selected: 0,
    abstain: 0,
    techFailure: 0,
    missed: 0,
    unknown: 0,
    pending: 0,
    missedOverflow: 0,
    missedWindow: 0,
    missedOverflowCompletedTag: 0,
    fillable: 0,
    unfillableLimitUp: 0,
    unfillableLimitDown: 0,
    unfillableSuspended: 0,
    suspendedOver20d: 0,
    overlapExcludedCount: 0,
    notDue: 0,
    mainDenominator: { count: 0, attemptIds: [] },
  };
  for (const s of samples) {
    const c = s.classification;
    switch (c.terminal) {
      case 'SELECTED':
        view.selected += 1;
        break;
      case 'ABSTAIN':
        view.abstain += 1;
        break;
      case 'TECH_FAILURE':
        view.techFailure += 1;
        break;
      case 'MISSED':
        view.missed += 1;
        if (c.missedSubclass === 'MISSED_OVERFLOW') view.missedOverflow += 1;
        else if (c.missedSubclass === 'MISSED_WINDOW') view.missedWindow += 1;
        else throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${s.attemptId}: MISSED 无子类`);
        break;
      case 'UNKNOWN':
        view.unknown += 1;
        break;
      case 'PENDING':
        view.pending += 1;
        break;
    }
    if (c.missedOverflowTag) view.missedOverflowCompletedTag += 1;
    if (c.terminal === 'SELECTED') {
      // 可成交性视图（SR-4.3；N_A 不可能出现在 SELECTED 上，出现即输入矛盾）
      switch (s.tradability) {
        case 'FILLABLE':
          view.fillable += 1;
          break;
        case 'UNFILLABLE_LIMIT_UP':
          view.unfillableLimitUp += 1;
          break;
        case 'UNFILLABLE_LIMIT_DOWN':
          view.unfillableLimitDown += 1;
          break;
        case 'UNFILLABLE_SUSPENDED':
          view.unfillableSuspended += 1;
          break;
        case 'SUSPENDED_OVER_20D':
          view.suspendedOver20d += 1;
          break;
        default:
          throw new DenominatorError('DENOMINATOR_INPUT_CONFLICT', `${s.attemptId}: SELECTED 样本 tradability=${String(s.tradability)}`);
      }
      if (s.overlapExcluded) view.overlapExcludedCount += 1;
      if (!s.settled) view.notDue += 1;
      // 主统计分母（SR-4.5：SELECTED ∩ FILLABLE ∩ 不重叠 ∩ 已到期；SR-8A.5：只含个股）
      if (s.tradability === 'FILLABLE' && !s.overlapExcluded && s.settled && s.subjectKind === 'STOCK') {
        view.mainDenominator.attemptIds.push(s.attemptId);
      }
    }
  }
  view.mainDenominator.count = view.mainDenominator.attemptIds.length;
  const terminalSum = view.selected + view.abstain + view.techFailure + view.missed + view.unknown + view.pending;
  if (terminalSum !== samples.length) {
    throw new DenominatorError(
      'DENOMINATOR_MUTUAL_EXCLUSIVITY_BROKEN',
      `六终态计数之和 ${String(terminalSum)} ≠ 样本总数 ${String(samples.length)}（SR-4.1 证伪命中）`,
    );
  }
  return view;
}
