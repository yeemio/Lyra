/** A/J 共用送达构造器：完整 prompt、结构化材料、输入身份与真实 UTF-8 字节数。 */
import { canonicalJsonString } from '../canonical.js';
import { KernelError, validDispositions, type AOutput, type ProgramChecklist, type ResearchBusinessKey } from '../contracts.js';
import { aOutputWireSchema, jOutputWireSchema, type SolDispatchPayload } from '../kernel/sol-transport.js';
import { A_INSTRUCTIONS, J_DUTIES } from '../method/text.js';
import { renderInputLayers, type AssembledResearchInput, type AssembleVersions, type LayerBlockView, type LayeredInputView, type ResearchInputPackage } from './inputs.js';
import { deliveredEvidence, researchJInputHash } from './validation.js';
import type { SimulatedMaterialSummary } from './simulated.js';
import { validatePostEventContext } from './inheritance.js';
import { RESEARCH_REPAIR_METHOD_VERSION } from './indicators.js';

const SECTION = '='.repeat(72);

function renderBlock(layer: 'L0' | 'L1' | 'L2', block: LayerBlockView): string {
  return `### [${layer}] ${block.materialId} · ${block.title}（${String(block.bytes)} 字节）\n${canonicalJsonString(block.payload)}`;
}

function renderCoverage(pkg: ResearchInputPackage): string {
  const lines = [
    'coverage 声明（RM §5：送达/降级/缺口三态。被降级材料只作为限制进入 limitations，不得假装读过；缺口不得当作无风险）',
  ];
  for (const d of pkg.dimensions) {
    const demoted = d.demoted.length > 0 ? ` [${d.demoted.join(', ')}]` : '';
    const gaps = d.gap.length > 0 ? `：${d.gap.join('；')}` : '';
    lines.push(
      `- 维度${d.dimension} ${d.code}（${d.name}）：送达 ${d.delivered.length} 件 [${d.delivered.join(', ')}]；降级 ${d.demoted.length} 件${demoted}；缺口 ${d.gap.length} 条${gaps}`,
    );
  }
  const { l0, l1, l2 } = pkg.layers;
  lines.push(
    `分层字节（canonical JSON UTF-8 真实字节）：L0 ${l0.bytes}/${l0.budget} · L1 ${l1.bytes}/${l1.budget} · L2 ${l2.bytes}/${l2.budget}`,
  );
  return lines.join('\n');
}

/** A prompt：方法正文 A_INSTRUCTIONS 全文 + 分层渲染（L0+L1 文本 + L2 目录）+ coverage + 输出 schema 说明。 */
export function renderAPrompt(pkg: ResearchInputPackage, simulated = false): string {
  const view = renderInputLayers(pkg);
  const space = validDispositions(pkg.businessKey.subjectKind);
  return [
    `本轮方法身份：${pkg.versions.methodVersion}；传统研究送达/复核约束 traditional-research@2`,
    A_INSTRUCTIONS,
    SECTION,
    '研究输入（本轮封存、按分层实际送达；证据引用只限实际送达的 L0/L1 材料（L2 封存目录不代表送达））',
    '',
    '—— L0（背景，不可裁剪）——',
    ...view.l0.map((b) => renderBlock('L0', b)),
    '',
    '—— L1（会改变判断的证据）——',
    ...view.l1.map((b) => renderBlock('L1', b)),
    '',
    '—— L2（索引目录）——',
    ...view.l2.map((b) => renderBlock('L2', b)),
    '',
    SECTION,
    renderCoverage(pkg),
    SECTION,
    [
      '输出要求（结构有效性由程序校验，缺任一项即结构无效，本轮无有效 A）',
      '- 只输出一个 JSON 对象：无 markdown 代码围栏、无前后解释文字；',
      `- 绑定字段：inputHash 必须原样回抄本值 required_input_hash = "${pkg.inputHash}"；`,
      `- candidate 只能取自本标的（${pkg.businessKey.subjectKind}）选项空间：${space.join(' / ')}（跨类无效，R18）；`,
      '- decisiveLinks 至少 2 条；每条 evidenceArtifactSha256 必须是本轮 L2 索引 deliveredFacts[].artifactSha256 中实际出现的 64 位十六进制原件哈希；',
      `- simulated 必须与本次通道身份一致：${String(simulated)}；`,
      '- 完整形状（JSON Schema，逐字段约束，字段集封闭不得增删）：',
      JSON.stringify(aOutputWireSchema(pkg.businessKey.subjectKind), null, 1),
    ].join('\n'),
  ].join('\n');
}

/** J prompt：J_DUTIES 全文 + A 输出全文 + 清单全文 + 输入绑定 + 输出 schema 说明。 */
export function renderJPrompt(
  pkg: ResearchInputPackage,
  aOutput: AOutput,
  checklist: ProgramChecklist,
  jInputHash: string,
  simulated = false,
): string {
  if (jInputHash !== researchJInputHash(pkg, aOutput, checklist)) throw new KernelError('MODEL_INPUT_UNBOUND', 'J 输入哈希未包含材料包');
  const subjectKind = pkg.businessKey.subjectKind;
  const view = renderInputLayers(pkg);
  const space = validDispositions(subjectKind);
  return [
    `本轮方法身份：${pkg.versions.methodVersion}；传统研究送达/复核约束 traditional-research@2`,
    J_DUTIES,
    SECTION,
    '供独立核查的本轮实际送达材料（与 A 同包；先验若存在仅为模型判断，非当前事实）',
    ...view.l0.map((b) => renderBlock('L0', b)),
    ...view.l1.map((b) => renderBlock('L1', b)),
    ...view.l2.map((b) => renderBlock('L2', b)),
    renderCoverage(pkg),
    SECTION,
    'A 输出全文（本轮分析者输出；程序已按其机械抽取下列清单）',
    canonicalJsonString(aOutput),
    SECTION,
    '程序清单全文（程序机械抽取，程序无独立意见；你必须逐项裁决恰好一次）',
    canonicalJsonString(checklist),
    SECTION,
    [
      '输入绑定与输出要求（结构有效性由程序校验）',
      `- required_input_hash = "${jInputHash}"；输出 inputHash 字段必须原样回抄该值，不回抄或回抄不一致即输出无效；`,
      '- 只输出一个 JSON 对象：无 markdown 代码围栏、无前后解释文字；',
      `- verdicts 必须恰好覆盖清单全部 checklistId 各一次（清单共 ${checklist.items.length} 项：${checklist.items.map((i) => i.checklistId).join(', ')}），不得跳项、合并或重复；`,
      `- finalDisposition 只能取自本标的（${subjectKind}）选项空间：${space.join(' / ')}（跨类无效，R18）；`,
      '- changedFromA 必须等于 finalDisposition 与 A.candidate 的实际差异；改判须有 J 自身非空 changeReason；',
      '- 若送达了 INHERITED 先验，changeReason 必须比较其原判断/条件与本次新增事件，维持也写；STANDALONE 是完整重研，不得冒称继承；',
      '- 每项写 reason 和 evidenceArtifactSha256s；已解决项须有实际送达引用；NARROWED/REJECTED 须写 correction；',
      '- 非承重项 remainingBasisChecklistIds 必须指向仍承重且 SUPPORTED/NARROWED 的项；承重项该数组为空。不得全非承重；',
      '- 承重 UNRESOLVED 或最强论证 UNRESOLVED 时须 ABSTAIN；每个 UNRESOLVED 的 checklistId 必须列在 limitations 中；',
      `- simulated 必须与本次通道身份一致：${String(simulated)}；`,
      '- 完整形状（JSON Schema，逐字段约束，字段集封闭不得增删）：',
      JSON.stringify(jOutputWireSchema(subjectKind), null, 1),
    ].join('\n'),
  ].join('\n');
}

export interface ResearchDispatchPayload extends SolDispatchPayload {
  subject: string;
  researchInput: LayeredInputView;
  material: SimulatedMaterialSummary;
  aOutput?: AOutput;
  checklist?: ProgramChecklist;
}

export interface ResearchRequest {
  inputHash: string;
  inputBytes: number;
  payload: ResearchDispatchPayload;
}

/** 在消费 permit 前核对组装结果与本轮请求，不能等结论落库才发现版本或业务键错绑。 */
export function assertAssembledIdentity(assembled: AssembledResearchInput, businessKey: ResearchBusinessKey, versions: AssembleVersions): void {
  const normalized = { ...businessKey, cutoff: new Date(businessKey.cutoff).toISOString() };
  const pkg = assembled.package;
  if (assembled.inputHash !== pkg.inputHash || pkg.cutoff !== normalized.cutoff ||
      canonicalJsonString(pkg.businessKey) !== canonicalJsonString(normalized) ||
      canonicalJsonString(pkg.versions) !== canonicalJsonString(versions)) {
    throw new KernelError('RESEARCH_INPUT_UNBOUND', '组装包与本轮业务键/方法/数据/授权身份不符');
  }
}

export function researchMaterial(pkg: ResearchInputPackage): SimulatedMaterialSummary {
  return { artifactSha256s: [...deliveredEvidence(pkg)],
    factCount: pkg.seals.reduce((n, s) => n + s.factIds.length, 0),
    gaps: pkg.dimensions.flatMap((d) => d.gap) };
}

export function buildARequest(pkg: ResearchInputPackage, simulated: boolean): ResearchRequest {
  if (!simulated && pkg.versions.methodVersion !== RESEARCH_REPAIR_METHOD_VERSION) {
    throw new KernelError('RESEARCH_METHOD_PROTOCOL_MISMATCH', '真实调用须显式使用修复后方法身份，旧冻结方法不能产生新协议样本');
  }
  validatePostEventContext(pkg);
  const material = researchMaterial(pkg);
  const prompt = renderAPrompt(pkg, simulated);
  return { inputHash: pkg.inputHash, inputBytes: Buffer.byteLength(prompt, 'utf8'),
    payload: { inputHash: pkg.inputHash, subjectKind: pkg.businessKey.subjectKind,
      subject: pkg.businessKey.subject, prompt, researchInput: renderInputLayers(pkg), material } };
}

export function buildJRequest(pkg: ResearchInputPackage, a: AOutput, checklist: ProgramChecklist, simulated: boolean): ResearchRequest {
  const inputHash = researchJInputHash(pkg, a, checklist);
  const prompt = renderJPrompt(pkg, a, checklist, inputHash, simulated);
  return { inputHash, inputBytes: Buffer.byteLength(prompt, 'utf8'),
    payload: { inputHash, subjectKind: pkg.businessKey.subjectKind, subject: pkg.businessKey.subject,
      prompt, researchInput: renderInputLayers(pkg), material: researchMaterial(pkg), aOutput: a, checklist,
      expectedChecklistIds: checklist.items.map((item) => item.checklistId) } };
}
