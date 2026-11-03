/**
 * Lyra · 研究报告视图与纯文本渲染（P2 W11: code-writer-pro）。
 * 合同：docs/specs/P2-RESEARCH.md Done-when 4——结论对象扩展研究报告视图
 * （A 摘要、清单逐项+裁决、J 最终决定与改判理由、证据引用下钻到原件哈希、输入包 coverage），
 * CLI 可读回渲染；界面展示须标注"个人研究记录，非投资建议"（PLAN §9 / RM §8）。
 *
 * 证据引用下钻口径：factId → artifact sha256 → 字节区间。P2 事实不记录其在原件内的偏移
 * （CAS 原件为适配器批量载荷），故区间给全区间 [0, bytes) 并如实标注；后续适配器记录
 * 偏移后本结构无需变更即可承载窄区间。
 */
import type {
  AOutput,
  ArtifactRef,
  ChecklistItem,
  ConclusionObject,
  JOutput,
  ProgramChecklist,
} from '../contracts.js';
import type { DimensionCoverage, LayerReceipt, ResearchInputPackage } from './inputs.js';

export const REPORT_DISCLAIMER = '个人研究记录，非投资建议';

/** 证据引用下钻条目（factId → 原件哈希 → 字节区间）。 */
export interface EvidenceDrillDownEntry {
  factId: string;
  artifactSha256: string;
  artifactBytes: number;
  /** 字节区间 [start, end)：P2 为全区间（事实未记录原件内偏移，如实标注）。 */
  byteRange: { start: number; end: number };
  deliveredIn: { materialId: string; layer: 'L0' | 'L1' } | null;
}

export interface EvidenceDrillDown {
  /** 送达材料的 factId → 下钻条目（来自输入包 L2 索引与封存 artifactRefs）。 */
  byFactId: Record<string, EvidenceDrillDownEntry>;
  /** 封存原件目录：sha256 → { bytes, mediaType }。 */
  artifacts: Record<string, { bytes: number; mediaType: string }>;
  /** A 输出证据引用是否全部可解析（指向送达材料引用目录或封存原件）。 */
  aEvidenceResolvable: boolean[] | null;
}

export interface ChecklistViewItem {
  checklistId: string;
  category: ChecklistItem['category'];
  aText: string;
  /** J 裁决（null = J 缺席/未裁决该条——视图如实呈现，不代填）。 */
  verdict: JOutput['verdicts'][number]['verdict'] | null;
  decisionBearing: boolean | null;
  correction: string | null;
}

export interface ReportView {
  conclusion: {
    conclusionId: string;
    businessKey: ConclusionObject['businessKey'];
    disposition: ConclusionObject['disposition'];
    adoption: false;
    inheritance: ConclusionObject['inheritance'];
    standaloneNote: ConclusionObject['standaloneNote'];
    changeReason: string | null;
    settlement: ConclusionObject['settlement'];
    evidence: ConclusionObject['evidence'];
    createdAt: string;
  };
  /** A 摘要（无 A 输出时为 null——视图如实呈现，不代填）。 */
  aSummary: {
    candidate: AOutput['candidate'];
    confidence: AOutput['confidence'];
    decisiveLinks: AOutput['decisiveLinks'];
    strongestCounter: string;
    limitations: string[];
    simulated: boolean;
  } | null;
  /** 清单逐项 + J 裁决。 */
  checklist: { checklistId: string; items: ChecklistViewItem[]; mandatoryJ: boolean } | null;
  /** J 最终决定与改判理由。 */
  j: {
    finalDisposition: JOutput['finalDisposition'];
    changedFromA: boolean;
    changeReason: string | null;
    strongestCaseDisposition: JOutput['strongestCaseDisposition'];
    limitations: string[];
    simulated: boolean;
  } | null;
  evidenceDrillDown: EvidenceDrillDown | null;
  inputCoverage: {
    inputHash: string | null;
    artifactRef: ArtifactRef | null;
    dimensions: DimensionCoverage[];
    layers: { l0: LayerReceipt; l1: LayerReceipt; l2: LayerReceipt } | null;
  } | null;
  disclaimer: typeof REPORT_DISCLAIMER;
}

/** 从输入包抽证据下钻目录（送达引用目录 + 封存原件目录）。 */
function drillDownOf(pkg: ResearchInputPackage): EvidenceDrillDown {
  const indexMaterial = pkg.materials.find((m) => m.kind === 'INDEX');
  const artifacts: EvidenceDrillDown['artifacts'] = {};
  for (const seal of pkg.seals) {
    for (const ref of seal.artifactRefs) {
      artifacts[ref.sha256] = { bytes: ref.bytes, mediaType: ref.mediaType };
    }
  }
  const byFactId: Record<string, EvidenceDrillDownEntry> = {};
  if (indexMaterial !== undefined && indexMaterial.kind === 'INDEX') {
    for (const entry of indexMaterial.content.deliveredFacts) {
      const artifact = artifacts[entry.artifactSha256];
      const total = artifact?.bytes ?? 0;
      byFactId[entry.factId] = {
        factId: entry.factId,
        artifactSha256: entry.artifactSha256,
        artifactBytes: total,
        byteRange: { start: 0, end: total },
        deliveredIn: { materialId: entry.materialId, layer: entry.layer },
      };
    }
  }
  return { byFactId, artifacts, aEvidenceResolvable: null };
}

/**
 * 构造研究报告视图。aOutput/checklist/jOutput/package 可为 null（如仅从库读回结论时）——
 * 视图如实呈现"缺"，不代填任何叙事。J 裁决按 checklistId 与清单条目对齐；
 * 清单条目无对应裁决 → verdict=null（可见的缺席，不由视图补写）。
 */
export function buildReportView(
  conclusion: ConclusionObject,
  researchInputPackage: ResearchInputPackage | null,
  aOutput: AOutput | null,
  checklist: ProgramChecklist | null,
  jOutput: JOutput | null,
): ReportView {
  const view: ReportView = {
    conclusion: {
      conclusionId: conclusion.conclusionId,
      businessKey: conclusion.businessKey,
      disposition: conclusion.disposition,
      adoption: false,
      inheritance: conclusion.inheritance,
      standaloneNote: conclusion.standaloneNote,
      changeReason: conclusion.changeReason,
      settlement: conclusion.settlement,
      evidence: conclusion.evidence,
      createdAt: conclusion.createdAt,
    },
    aSummary:
      aOutput === null
        ? null
        : {
            candidate: aOutput.candidate,
            confidence: aOutput.confidence,
            decisiveLinks: aOutput.decisiveLinks,
            strongestCounter: aOutput.strongestCounter,
            limitations: aOutput.limitations,
            simulated: aOutput.simulated,
          },
    checklist: null,
    j:
      jOutput === null
        ? null
        : {
            finalDisposition: jOutput.finalDisposition,
            changedFromA: jOutput.changedFromA,
            changeReason: jOutput.changeReason,
            strongestCaseDisposition: jOutput.strongestCaseDisposition,
            limitations: jOutput.limitations,
            simulated: jOutput.simulated,
          },
    evidenceDrillDown: researchInputPackage === null ? null : drillDownOf(researchInputPackage),
    // 包 artifactRef 不在包自身之内（组装器返回值携带）；此处只呈现包内可得信息。
    inputCoverage:
      researchInputPackage === null
        ? null
        : {
            inputHash: researchInputPackage.inputHash,
            artifactRef: null,
            dimensions: researchInputPackage.dimensions,
            layers: researchInputPackage.layers,
          },
    disclaimer: REPORT_DISCLAIMER,
  };
  if (checklist !== null) {
    const verdictBy = new Map((jOutput?.verdicts ?? []).map((v) => [v.checklistId, v]));
    view.checklist = {
      checklistId: checklist.checklistId,
      mandatoryJ: checklist.mandatoryJ,
      items: checklist.items.map((item) => {
        const verdict = verdictBy.get(item.checklistId);
        return {
          checklistId: item.checklistId,
          category: item.category,
          aText: item.aText,
          verdict: verdict?.verdict ?? null,
          decisionBearing: verdict?.decisionBearing ?? null,
          correction: verdict?.correction ?? null,
        };
      }),
    };
  }
  if (aOutput !== null && view.evidenceDrillDown !== null) {
    // A 证据引用可解析性：引用的原件哈希须命中封存原件目录（送达明细另见 byFactId）。
    const sealed = new Set(Object.keys(view.evidenceDrillDown.artifacts));
    view.evidenceDrillDown.aEvidenceResolvable = aOutput.decisiveLinks.map((link) =>
      sealed.has(link.evidenceArtifactSha256),
    );
  }
  return view;
}

// ===== 纯文本渲染（CLI 用；人可读）=====

const line = (char = '-', n = 72): string => char.repeat(n);

function wrap(text: string, width = 100): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** 渲染纯文本研究报告（末行恒为合规标注）。 */
export function renderReportText(view: ReportView): string {
  const out: string[] = [];
  const c = view.conclusion;
  out.push(line('='));
  out.push(`Lyra 研究报告 · ${c.conclusionId}`);
  out.push(line('='));
  out.push(
    `标的：${c.businessKey.subjectKind} ${c.businessKey.subject} · 研究类型 ${c.businessKey.researchKind} · 资料截点 ${c.businessKey.cutoff}`,
  );
  out.push(`最终决定（J 裁决后）：${c.disposition} · adoption=${String(c.adoption)}（恒 false）`);
  if (c.inheritance !== null) {
    out.push(`继承来源：${c.inheritance.fromConclusionId}（hash ${c.inheritance.fromConclusionHash.slice(0, 16)}…）`);
  } else if (c.standaloneNote !== null) {
    out.push(`继承：${c.standaloneNote}`);
  }
  if (c.changeReason !== null) out.push(`改判理由：${c.changeReason}`);
  out.push(
    `证据哈希：A=${c.evidence.aOutputHash.slice(0, 16)}… 清单=${c.evidence.checklistHash.slice(0, 16)}… ` +
      `J=${c.evidence.jOutputHash.slice(0, 16)}… manifest=${c.evidence.manifestHash.slice(0, 16)}…`,
  );
  out.push(`结算占位区：${JSON.stringify(c.settlement)}`);
  out.push(`结论落库时间：${c.createdAt}`);

  out.push('');
  out.push(line());
  out.push('A 摘要（分析者）');
  out.push(line());
  if (view.aSummary === null) {
    out.push('（本轮无 A 输出可读回——视图不代填）');
  } else {
    const a = view.aSummary;
    out.push(`候选决策：${a.candidate} · 信心：${a.confidence}${a.simulated ? '（模拟输出）' : ''}`);
    a.decisiveLinks.forEach((link, i) => {
      out.push(`  决定性连接 ${i + 1}：${wrap(link.text)}`);
      out.push(`    证据原件：${link.evidenceArtifactSha256}`);
    });
    out.push(`最强反证：${wrap(a.strongestCounter)}`);
    if (a.limitations.length > 0) out.push(`限制：${a.limitations.map((x) => wrap(x, 60)).join(' / ')}`);
  }

  out.push('');
  out.push(line());
  out.push('程序清单逐项与 J 裁决');
  out.push(line());
  if (view.checklist === null) {
    out.push('（本轮无清单可读回——视图不代填）');
  } else {
    out.push(`清单身份：${view.checklist.checklistId}（必经 J：${String(view.checklist.mandatoryJ)}）`);
    for (const item of view.checklist.items) {
      out.push(
        `- [${item.checklistId}] ${item.category} · 裁决 ${item.verdict ?? '（未裁决）'} · ` +
          `承重 ${item.decisionBearing === null ? '（未裁决）' : String(item.decisionBearing)}`,
      );
      out.push(`  A 原文：${wrap(item.aText)}`);
      if (item.correction !== null) out.push(`  J 修正：${wrap(item.correction)}`);
    }
  }

  out.push('');
  out.push(line());
  out.push('J 最终决定（裁决者）');
  out.push(line());
  if (view.j === null) {
    out.push('（本轮无 J 输出可读回——视图不代填）');
  } else {
    const j = view.j;
    out.push(`最终决定：${j.finalDisposition}${j.simulated ? '（模拟输出）' : ''}`);
    out.push(`与 A 候选关系：${j.changedFromA ? `改判（${String(j.changeReason ?? '改判理由缺失')}）` : '维持 A 候选'}`);
    out.push(`最强待回应论证处置：${j.strongestCaseDisposition}`);
    if (j.limitations.length > 0) out.push(`限制：${j.limitations.map((x) => wrap(x, 60)).join(' / ')}`);
  }

  out.push('');
  out.push(line());
  out.push('证据引用下钻（factId → 原件 sha256 → 字节区间）');
  out.push(line());
  if (view.evidenceDrillDown === null) {
    out.push('（无输入包可读回——视图不代填）');
  } else {
    const facts = Object.values(view.evidenceDrillDown.byFactId);
    out.push(`送达引用目录 ${String(facts.length)} 条；封存原件 ${String(Object.keys(view.evidenceDrillDown.artifacts).length)} 个。`);
    for (const entry of facts.slice(0, 200)) {
      out.push(
        `- ${entry.factId} → ${entry.artifactSha256.slice(0, 16)}… [${String(entry.byteRange.start)}, ${String(entry.byteRange.end)})` +
          `（${String(entry.artifactBytes)} 字节全区间，P2 事实未记录原件内偏移） @${entry.deliveredIn === null ? '?' : entry.deliveredIn.materialId}/${entry.deliveredIn === null ? '?' : entry.deliveredIn.layer}`,
      );
    }
    if (facts.length > 200) out.push(`  …（其余 ${String(facts.length - 200)} 条见输入包 L2 索引）`);
    if (view.evidenceDrillDown.aEvidenceResolvable !== null) {
      out.push(`A 证据引用可解析性：${view.evidenceDrillDown.aEvidenceResolvable.map((x) => (x ? '可解析' : '未命中')).join('，')}`);
    }
  }

  out.push('');
  out.push(line());
  out.push('输入包 coverage');
  out.push(line());
  if (view.inputCoverage === null) {
    out.push('（无输入包可读回——视图不代填）');
  } else {
    out.push(`inputHash：${view.inputCoverage.inputHash ?? '（缺）'}`);
    if (view.inputCoverage.layers !== null) {
      for (const layer of [view.inputCoverage.layers.l0, view.inputCoverage.layers.l1, view.inputCoverage.layers.l2]) {
        out.push(`- ${layer.name}：${String(layer.bytes)} / ${String(layer.budget)} 字节，${String(layer.blocks.length)} 块`);
      }
    }
    for (const d of view.inputCoverage.dimensions) {
      out.push(
        `- 维度${d.dimension} ${d.code}（${d.name}）：送达 ${String(d.delivered.length)} / 降级 ${String(d.demoted.length)} / 缺口 ${String(d.gap.length)}`,
      );
      for (const gap of d.gap) out.push(`    缺口：${gap}`);
    }
  }

  out.push('');
  out.push(line('='));
  out.push(REPORT_DISCLAIMER);
  return out.join('\n');
}
