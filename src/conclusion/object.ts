/**
 * Lyra · 研究结论对象（RESEARCH-METHOD §8）纯构造与字段间程序校验。W3: code-writer-pro。
 *
 * 字段间约束（程序校验，全部具名拒绝）：
 *   1. disposition 只从 jOutput.finalDisposition 取（API 无 disposition 入参——从 A 候选
 *      或先验抄录在类型层面即无路径），且必须属于该标的类别的合法选项空间
 *      （STOCK: OUTPERFORM/UNDERPERFORM/ABSTAIN；BROAD_ETF: UP/DOWN/ABSTAIN；跨类拒绝〔R18〕）；
 *   2. 四证据哈希齐备：aOutputHash / checklistHash / jOutputHash / manifestHash，其中
 *      checklistHash 必须可由 A 输出机械重导出（rederiveChecklistHash）；
 *      清单绑定 A 输出与封存 manifest（哈希两两相符）；J verdicts 恰好覆盖清单全部条目一次；
 *   3. 继承配对：有 inheritance 指针 → changeReason 必填（维持也写）；standalone →
 *      inheritance=null；事件完整重研写明降级原因，其余 standaloneNote='无基础结论可继承'；
 *      J 改判 A 候选按实际方向差异判定，J 自身及结论 changeReason 均必填；
 *   4. adoption 恒 false（类型层面字面量 false；落库断言由 db 层与读回保证）；
 *   5. settlement 初始 {state:'UNSETTLED'}；conclusionHash = canonicalSha256(除
 *      conclusionHash 外的研究字段)——settlement/createdAt 不属于研究字段，结算回填不改哈希。
 */
import { canonicalSha256 } from '../canonical.js';
import {
  validDispositions,
  type AOutput,
  type ConclusionObject,
  type JOutput,
  type ProgramChecklist,
  type ResearchBusinessKey,
  type SealManifest,
  type SettlementZone,
} from '../contracts.js';
import { rederiveChecklistHash, type DimensionCoveragePkg } from '../research/checklist.js';
import type { ResearchInputPackage } from '../research/inputs.js';
import { researchTraceOf, validateResearchJ } from '../research/validation.js';
import { assertVerifiedPrior, validatePostEventContext, type VerifiedPrior } from '../research/inheritance.js';

export type ConclusionErrorCode =
  | 'INVALID_BUSINESS_KEY'
  | 'MANIFEST_UNBOUND'
  | 'DISPOSITION_SPACE_INVALID'
  | 'CHECKLIST_UNBOUND'
  | 'CHECKLIST_HASH_MISMATCH'
  | 'J_VERDICTS_MISMATCH'
  | 'INHERITANCE_PAIRING_INVALID'
  | 'CHANGE_REASON_REQUIRED'
  | 'CONCLUSION_IMMUTABLE'
  | 'CONCLUSION_MISSING'
  | 'SETTLEMENT_INVALID'
  | 'RESEARCH_FIELDS_MUTATED';

export class ConclusionError extends Error {
  constructor(readonly code: ConclusionErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ConclusionError';
  }
}

export interface ConclusionInheritance {
  fromConclusionId: string;
  fromConclusionHash: string;
}

/** manifest 至少携带哈希；传完整 SealManifest 时额外校验与业务键的绑定。 */
export interface ConclusionManifestRef {
  manifestHash: string;
  businessKey?: ResearchBusinessKey;
}

export interface ConclusionInput {
  businessKey: ResearchBusinessKey;
  methodVersion: string;
  adapterVersion: string;
  planAuthVersion: string;
  aOutput: AOutput;
  checklist: ProgramChecklist;
  jOutput: JOutput;
  manifest: ConclusionManifestRef | SealManifest;
  /** 必填实际送达包；仅 manifest 哈希或全封存目录不能证明证据送达。 */
  researchInput: ResearchInputPackage;
  verifiedPrior?: VerifiedPrior;
  /** 继承指针；null = STANDALONE（standaloneNote 自动标注）。 */
  inheritance: ConclusionInheritance | null;
  /** 继承（维持也写）或 J 改判 A 候选时必填。 */
  changeReason: string | null;
  /** 清单维度覆盖参数（W25 接线）：派生清单用了第三参时必传，供机械重导出对称校验。 */
  checklistCoverage?: DimensionCoveragePkg;
}

/** 结算回填的 SETTLED 形态（SETTLEMENT-REVIEW 合同的占位区骨架；R26.2：directionHit 可为 null=ABSTAIN 的 N/A）。 */
export type SettledSettlement = SettlementZone & {
  state: 'SETTLED';
  directionHit: boolean | null;
  excessReturn: string; // 精确十进制定点（字符串）
};

/** 结算异常的落库形态（R26.2：具名登记，不进主统计、不冒充终态结算）。 */
export type AnomalySettlement = SettlementZone & {
  state: 'ANOMALY';
  anomalyCode: string;
  anomalyDetail?: string;
};

/** 结算回填的终态入参（SETTLED 或 ANOMALY；UNSETTLED 不可经回填写入）。 */
export type SettlementBackfill = SettledSettlement | AnomalySettlement;

/** 研究字段集（settlement/createdAt/conclusionId/conclusionHash 之外的全部字段）。 */
export type ConclusionResearchCore = Omit<ConclusionObject, 'conclusionId' | 'settlement' | 'createdAt' | 'conclusionHash'>;

export function researchCoreOf(c: ConclusionObject): ConclusionResearchCore {
  const { conclusionId: _id, settlement: _s, createdAt: _c, conclusionHash: _h, ...core } = c;
  return core;
}

/** conclusionHash 的独立重算口径（结算回填后的内建一致性断言用同一函数）。 */
export function conclusionHashOf(core: ConclusionResearchCore): string {
  return canonicalSha256(core);
}

function normalizeCutoff(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ConclusionError('INVALID_BUSINESS_KEY', `${field}: ${value}`);
  return d.toISOString();
}

function normalizedBusinessKey(bk: ResearchBusinessKey): ResearchBusinessKey {
  if (bk.subjectKind !== 'STOCK' && bk.subjectKind !== 'BROAD_ETF') {
    throw new ConclusionError('INVALID_BUSINESS_KEY', `subjectKind ${bk.subjectKind}`);
  }
  if (typeof bk.subject !== 'string' || bk.subject.length === 0) {
    throw new ConclusionError('INVALID_BUSINESS_KEY', 'subject 为空');
  }
  if (bk.researchKind !== 'WEEKLY' && bk.researchKind !== 'POST_EVENT' && bk.researchKind !== 'PRE_EVENT') {
    throw new ConclusionError('INVALID_BUSINESS_KEY', `researchKind ${bk.researchKind}`);
  }
  return { ...bk, cutoff: normalizeCutoff(bk.cutoff, 'businessKey.cutoff') };
}

/**
 * 构造结论对象（全部字段间校验在此完成；db 层只做落库与读回）。
 * 校验次序稳定：业务键 → manifest 绑定 → 选项空间 → 清单绑定 → 清单哈希重导出 →
 * J 覆盖 → 实际送达/承重/未知处置 → 继承原文核验与改判配对。
 */
export function buildConclusionObject(input: ConclusionInput): ConclusionObject {
  const businessKey = normalizedBusinessKey(input.businessKey);

  const manifest = input.manifest as ConclusionManifestRef;
  if (manifest.businessKey !== undefined) {
    const mbk = normalizedBusinessKey(manifest.businessKey);
    if (canonicalSha256(mbk) !== canonicalSha256(businessKey)) {
      throw new ConclusionError(
        'MANIFEST_UNBOUND',
        `manifest 与结论业务键不符（manifest.subject=${mbk.subject} / cutoff=${mbk.cutoff}）`,
      );
    }
  }

  // 1) disposition 空间：只从 J 取；跨类即拒绝（R18）
  const space = validDispositions(businessKey.subjectKind);
  const disposition = input.jOutput.finalDisposition;
  if (!space.includes(disposition)) {
    throw new ConclusionError(
      'DISPOSITION_SPACE_INVALID',
      `disposition ${disposition} 不在 ${businessKey.subjectKind} 选项空间 [${space.join(' / ')}]（R18 跨类拒绝）`,
    );
  }

  // 2) 清单绑定：aOutputHash 与 manifestHash 两两相符
  const aOutputHash = canonicalSha256(input.aOutput);
  if (input.checklist.aOutputHash !== aOutputHash) {
    throw new ConclusionError('CHECKLIST_UNBOUND', '清单 aOutputHash 与实际 A 输出哈希不符');
  }
  if (input.checklist.manifestHash !== manifest.manifestHash) {
    throw new ConclusionError('CHECKLIST_UNBOUND', '清单 manifestHash 与封存 manifest 哈希不符');
  }

  // 3) 清单哈希必须可由 A 输出机械重导出（RM §8）
  if (rederiveChecklistHash(input.aOutput, input.checklist.manifestHash, input.checklistCoverage) !== input.checklist.checklistHash) {
    throw new ConclusionError('CHECKLIST_HASH_MISMATCH', 'checklistHash 无法由 A 输出机械重导出');
  }

  // 4) J 裁决恰好覆盖清单全部条目一次（不得缺席/重复/越清单）
  const expectedIds = new Set(input.checklist.items.map((item) => item.checklistId));
  const gotIds = input.jOutput.verdicts.map((v) => v.checklistId);
  if (
    gotIds.length !== expectedIds.size ||
    new Set(gotIds).size !== gotIds.length ||
    gotIds.some((id) => !expectedIds.has(id))
  ) {
    throw new ConclusionError(
      'J_VERDICTS_MISMATCH',
      `J verdicts 必须恰好覆盖清单条目各一次（清单 ${expectedIds.size} 项，J 裁决 ${gotIds.length} 项）`,
    );
  }

  // 不信任通道或 J 自报：直接构造/合成路径也必须通过相同领域门。
  const pkg = input.researchInput;
  if (pkg === undefined || canonicalSha256(pkg.businessKey) !== canonicalSha256(businessKey) ||
      pkg.versions.methodVersion !== input.methodVersion || pkg.versions.adapterVersion !== input.adapterVersion ||
      pkg.versions.planAuthVersion !== input.planAuthVersion || pkg.seals[0]?.manifestHash !== manifest.manifestHash) {
    throw new ConclusionError('MANIFEST_UNBOUND', '结论须绑定同业务键、版本与封存的实际送达包');
  }
  validateResearchJ(input.jOutput, pkg, input.aOutput, input.checklist, input.aOutput.simulated, input.checklistCoverage);
  const eventContext = validatePostEventContext(pkg);
  if (eventContext?.basis === 'INHERITED') assertVerifiedPrior(eventContext, input.verifiedPrior);
  if (input.inheritance !== null && (eventContext?.basis !== 'INHERITED' ||
      eventContext.prior.conclusion.conclusionId !== input.inheritance.fromConclusionId ||
      eventContext.prior.conclusion.conclusionHash !== input.inheritance.fromConclusionHash)) {
    throw new ConclusionError('INHERITANCE_PAIRING_INVALID', '继承指针未绑定实际送达的先验原文');
  }
  if (input.inheritance === null && eventContext?.basis === 'INHERITED') {
    throw new ConclusionError('INHERITANCE_PAIRING_INVALID', '实际送达继承先验却丢失继承指针');
  }

  // 5) 继承配对与改判理由
  let standaloneNote: string | null;
  if (input.inheritance !== null) {
    if (typeof input.inheritance.fromConclusionId !== 'string' || input.inheritance.fromConclusionId.length === 0 ||
        typeof input.inheritance.fromConclusionHash !== 'string' || input.inheritance.fromConclusionHash.length === 0) {
      throw new ConclusionError('INHERITANCE_PAIRING_INVALID', '继承指针须同时含 fromConclusionId 与 fromConclusionHash');
    }
    if ((input.changeReason ?? '').trim().length === 0) {
      throw new ConclusionError('INHERITANCE_PAIRING_INVALID', '继承研究必须写改判理由（维持也写，RM §8）');
    }
    standaloneNote = null;
  } else {
    standaloneNote = eventContext?.basis === 'STANDALONE' ? `完整重研：${eventContext.reason}` : '无基础结论可继承';
  }
  if (input.jOutput.changedFromA === true && (input.changeReason ?? '').trim().length === 0) {
    throw new ConclusionError('CHANGE_REASON_REQUIRED', 'J 改判 A 候选必须写 changeReason（RM §2.3/§8）');
  }

  const core: ConclusionResearchCore = {
    businessKey,
    methodVersion: input.methodVersion,
    adapterVersion: input.adapterVersion,
    planAuthVersion: input.planAuthVersion,
    disposition,
    adoption: false, // 恒 false（类型层面字面量；此处构造唯一来源）
    evidence: {
      aOutputHash,
      checklistHash: input.checklist.checklistHash,
      jOutputHash: canonicalSha256(input.jOutput),
      manifestHash: manifest.manifestHash,
      researchTraceSha256: canonicalSha256(researchTraceOf({
        input: pkg, aOutput: input.aOutput, checklist: input.checklist, jOutput: input.jOutput,
        ...(input.checklistCoverage === undefined ? {} : { checklistCoverage: input.checklistCoverage }),
      })),
    },
    inheritance: input.inheritance,
    standaloneNote,
    changeReason: input.changeReason,
  };
  const conclusionHash = canonicalSha256(core);
  return {
    conclusionId: `cc-${conclusionHash.slice(0, 24)}`, // 内容身份：换任一研究字段即新结论身份
    ...core,
    settlement: { state: 'UNSETTLED' },
    createdAt: new Date().toISOString(),
    conclusionHash,
  };
}

/** 结算回填入参校验：接受 SETTLED（方向命中——ABSTAIN 时为 null；超额收益为十进制定点字符串）或 ANOMALY（具名，R26.2）。 */
export function validateSettlementResult(result: SettlementBackfill): void {
  if (result === null || typeof result !== 'object') {
    throw new ConclusionError('SETTLEMENT_INVALID', '结算回填入参非对象');
  }
  if (result.state === 'ANOMALY') {
    if (typeof result.anomalyCode !== 'string' || result.anomalyCode.length === 0) {
      throw new ConclusionError('SETTLEMENT_INVALID', 'ANOMALY 形态 anomalyCode 必填非空');
    }
    if (result.anomalyDetail !== undefined && typeof result.anomalyDetail !== 'string') {
      throw new ConclusionError('SETTLEMENT_INVALID', 'anomalyDetail 须为字符串');
    }
    return;
  }
  if (result.state !== 'SETTLED') {
    throw new ConclusionError('SETTLEMENT_INVALID', '结算回填只接受 SETTLED 或 ANOMALY 形态');
  }
  if (typeof result.directionHit !== 'boolean' && result.directionHit !== null) {
    throw new ConclusionError('SETTLEMENT_INVALID', 'directionHit 必填 boolean 或 null（ABSTAIN 的 N/A）');
  }
  if (typeof result.excessReturn !== 'string' || !/^-?\d+(\.\d+)?$/.test(result.excessReturn)) {
    throw new ConclusionError('SETTLEMENT_INVALID', `excessReturn 必须为十进制定点字符串: ${String(result.excessReturn)}`);
  }
  if (result.maxAdverse !== null && result.maxAdverse !== undefined &&
      (typeof result.maxAdverse !== 'string' || !/^-?\d+(\.\d+)?$/.test(result.maxAdverse))) {
    throw new ConclusionError('SETTLEMENT_INVALID', 'maxAdverse 必须为十进制定点字符串或 null');
  }
  if (result.invalidationTriggered !== undefined && typeof result.invalidationTriggered !== 'boolean') {
    throw new ConclusionError('SETTLEMENT_INVALID', 'invalidationTriggered 须为 boolean');
  }
  if (result.tradability !== null && result.tradability !== undefined && typeof result.tradability !== 'string') {
    throw new ConclusionError('SETTLEMENT_INVALID', 'tradability 须为字符串或 null');
  }
}
