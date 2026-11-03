/**
 * Lyra · 程序清单（PROGRAM_CHECKLIST，无模型）。W3: code-writer-pro；W25: code-writer 追加式扩展。
 * 合同：docs/specs/RESEARCH-METHOD.md §2.2——由程序从实际 A 输出机械抽取，程序不表达
 * 任何独立意见（assessment 恒 NOT_ASSESSED）。
 *
 * 条目类别（P0 抽取范围）：
 *   - DECISIVE_LINK：每条决定性连接一条（aText 含证据原件哈希定位）；
 *   - STRONGEST_COUNTER：最强反证一条；
 *   - CANDIDATE：A 候选决策一条；
 *   - SELECTION_THRESHOLD：选择阈值一条（aText 取候选值——同一阈值供 J 复核）。
 *
 * W25 追加（REVISION-LOG：方法正文 v1 的 DIMENSION_COVERAGE，Gate-M 真实研究暴露缺口）：
 *   - 第三可选参 coverage（维度覆盖包）传入时，追加 DIMENSION_COVERAGE 条目
 *     （CHECKLIST_RULES_P2 规则 5）：个股八维/宽基七维逐维度一条，aText 取 A 实际论及
 *     （decisiveLinks/limitations 中含维度名的首个片段，截 160 字）或"该维度无 A 论述"；
 *   - deliveredCount=0 且 gap 非空的维度，程序单列缺口项："该维度无材料（缺口 N 条）"，
 *     sourceHash = canonicalSha256({dimension, gaps})；
 *   - 带 coverage 的派生整体为 p2 版本：条目 id 前缀 check:p2:、清单身份前缀 checklist:p2:；
 *     不传 coverage 保持 P0 行为逐字节不变（check:p0: / checklist:p0:）。
 *
 * checklistHash = canonicalSha256(除 checklistHash 外全部字段)，且必须可由 A 输出
 * 机械重导出（rederiveChecklistHash，RESEARCH-METHOD §8 字段间校验的断言基础）。
 */
import { canonicalSha256 } from '../canonical.js';
import type { AOutput, ChecklistItem, ProgramChecklist } from '../contracts.js';

/** aText 上限：≤160 字符的定位摘录，非全文（RM §2.2）。 */
export const A_TEXT_MAX = 160;

function clip(text: string): string {
  return text.length <= A_TEXT_MAX ? text : `${text.slice(0, A_TEXT_MAX - 1)}…`;
}

/** A 输出内容哈希（AOutput 无自哈希字段，整体 canonical 序列化）。 */
export function aOutputHashOf(aOutput: AOutput): string {
  return canonicalSha256(aOutput);
}

// ===== 维度覆盖包（W25：Gate-M 接线由总控后续完成，本模块只定义清单侧输入形态）=====

/** 单维度覆盖：dimension 为维度名（个股八维/宽基七维，见 src/research/inputs.ts DimensionRule）。 */
export interface DimensionCoverageEntry {
  dimension: string;
  deliveredCount: number;
  gap: string[];
}

export interface DimensionCoveragePkg {
  dimensions: DimensionCoverageEntry[];
}

const NO_A_TEXT = '该维度无 A 论述';

/** 无材料缺口项的固定 aText（程序单列，非 A 原文）。 */
export function dimensionGapText(gapCount: number): string {
  return `该维度无材料（缺口 ${gapCount} 条）`;
}

/**
 * DIMENSION_COVERAGE 条目（CHECKLIST_RULES_P2 规则 5）：每维度一条覆盖项；
 * deliveredCount=0 且 gap 非空的维度紧跟一条程序缺口项。id 序号在两类条目间连续递增。
 */
function dimensionItems(aOutput: AOutput, coverage: DimensionCoveragePkg, prefix: string): ChecklistItem[] {
  // 提及来源顺序：decisiveLinks 在前、limitations 在后，各自按数组序取首个含维度名的片段
  const fragments = [...aOutput.decisiveLinks.map((link) => link.text), ...aOutput.limitations];
  const items: ChecklistItem[] = [];
  let index = 0;
  for (const entry of coverage.dimensions) {
    const mentioned = fragments.find((fragment) => fragment.includes(entry.dimension));
    const aText = clip(mentioned ?? NO_A_TEXT);
    items.push({
      checklistId: `${prefix}:DIMENSION_COVERAGE:${index}`,
      category: 'DIMENSION_COVERAGE',
      assessment: 'NOT_ASSESSED',
      aText,
      sourceHash: canonicalSha256({ dimension: entry.dimension, aText }),
    });
    index += 1;
    if (entry.deliveredCount === 0 && entry.gap.length > 0) {
      items.push({
        checklistId: `${prefix}:DIMENSION_COVERAGE:${index}`,
        category: 'DIMENSION_COVERAGE',
        assessment: 'NOT_ASSESSED',
        aText: dimensionGapText(entry.gap.length),
        sourceHash: canonicalSha256({ dimension: entry.dimension, gaps: entry.gap }),
      });
      index += 1;
    }
  }
  return items;
}

/** 机械抽取：从 A 输出（与可选维度覆盖包）直接构造程序清单。同输入恒同输出（无任何模型或时钟参与）。 */
export function deriveChecklist(aOutput: AOutput, manifestHash: string, coverage?: DimensionCoveragePkg): ProgramChecklist {
  // p0 = 无覆盖包（P0 行为逐字节不变）；p2 = 带覆盖包（CHECKLIST_RULES_P2）
  const version = coverage === undefined ? 'p0' : 'p2';
  const aOutputHash = canonicalSha256(aOutput);
  const items: ChecklistItem[] = [];

  aOutput.decisiveLinks.forEach((link, index) => {
    items.push({
      checklistId: `check:${version}:DECISIVE_LINK:${index}`,
      category: 'DECISIVE_LINK',
      assessment: 'NOT_ASSESSED',
      aText: clip(`${link.text} [evidence ${link.evidenceArtifactSha256}]`),
      sourceHash: canonicalSha256(link),
    });
  });

  items.push({
    checklistId: `check:${version}:STRONGEST_COUNTER:0`,
    category: 'STRONGEST_COUNTER',
    assessment: 'NOT_ASSESSED',
    aText: clip(aOutput.strongestCounter),
    sourceHash: canonicalSha256(aOutput.strongestCounter),
  });

  items.push({
    checklistId: `check:${version}:CANDIDATE:0`,
    category: 'CANDIDATE',
    assessment: 'NOT_ASSESSED',
    aText: clip(aOutput.candidate),
    sourceHash: canonicalSha256(aOutput.candidate),
  });

  items.push({
    checklistId: `check:${version}:SELECTION_THRESHOLD:0`,
    category: 'SELECTION_THRESHOLD',
    assessment: 'NOT_ASSESSED',
    aText: clip(aOutput.candidate), // aText 取候选值：同一阈值供 J 应用于裁决后的剩余联合支持
    sourceHash: canonicalSha256(aOutput.candidate),
  });

  if (coverage !== undefined) {
    items.push(...dimensionItems(aOutput, coverage, `check:${version}`));
  }

  const core = {
    checklistId: `checklist:${version}:${aOutputHash.slice(0, 12)}:${manifestHash.slice(0, 8)}`,
    aOutputHash,
    manifestHash,
    items,
    mandatoryJ: true as const,
  };
  return { ...core, checklistHash: canonicalSha256(core) };
}

/**
 * 清单哈希机械重导出（RM §8 字段间校验）：仅凭 A 输出与 manifest 哈希（与派生时相同的
 * 可选维度覆盖包）即可重算，必须与已落库清单的 checklistHash 相等——证明清单无任何不可重放的内容。
 */
export function rederiveChecklistHash(aOutput: AOutput, manifestHash: string, coverage?: DimensionCoveragePkg): string {
  return deriveChecklist(aOutput, manifestHash, coverage).checklistHash;
}
