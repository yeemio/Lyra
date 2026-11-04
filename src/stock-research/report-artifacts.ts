import { join } from 'node:path';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import type { DbClient } from '../db/exec.js';
import type { ComputeResult, EvidencePack, ReportDocument, SrArtifactRef, SrReportArtifacts, SrStep } from './contracts.js';
import type { AFinalOutput, AnalyzeOutput, JOutput, SrChecklist } from './transport.js';
import { verifyReport } from './report-identity.js';

type StepIdentity = Pick<SrStep, 'taskId' | 'stepId' | 'stepKind' | 'sectionKey' | 'sequence'>;
interface Envelope { format: 1; step: StepIdentity; value: unknown }
const identity = (step: StepIdentity): StepIdentity => ({ taskId: step.taskId, stepId: step.stepId, stepKind: step.stepKind, sectionKey: step.sectionKey, sequence: step.sequence });
const artifacts = (outputDir: string): ArtifactStore => new ArtifactStore(join(outputDir, 'artifacts'));

export async function putStepArtifact(outputDir: string, step: StepIdentity, value: unknown): Promise<SrArtifactRef> {
  const envelope: Envelope = { format: 1, step: identity(step), value };
  const ref = await artifacts(outputDir).put(Buffer.from(canonicalJsonString(envelope)), 'application/json', new Date().toISOString());
  return { sha256: ref.sha256, bytes: ref.bytes };
}

export async function readStepArtifact<T>(outputDir: string, step: StepIdentity, ref: SrArtifactRef | null | undefined): Promise<T> {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1) {
    throw new KernelError('SR_ARTIFACT_UNBOUND', `${step.stepId} 无可信产物引用`);
  }
  const bytes = await artifacts(outputDir).readBytes(ref.sha256);
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as Envelope;
  if (bytes.length !== ref.bytes || envelope.format !== 1 || canonicalSha256(envelope.step) !== canonicalSha256(identity(step))) {
    throw new KernelError('SR_ARTIFACT_BINDING_MISMATCH', `${step.stepId} 产物身份不符`);
  }
  return envelope.value as T;
}

/** 同一步骤第一次绑定后只能逐字重放；工作目录不是读取依据。 */
export async function saveStepArtifact(pool: DbClient, outputDir: string, step: StepIdentity, value: unknown): Promise<SrArtifactRef> {
  const ref = await putStepArtifact(outputDir, step, value);
  await pool.query(`update sr_step set output_artifact = $3::jsonb
    where task_id = $1::uuid and step_id = $2::uuid and output_artifact is null`,
  [step.taskId, step.stepId, JSON.stringify(ref)]);
  const result = await pool.query<{ output_artifact: SrArtifactRef }>(
    'select output_artifact from sr_step where task_id = $1::uuid and step_id = $2::uuid', [step.taskId, step.stepId]);
  if (canonicalSha256(result.rows[0]?.output_artifact ?? null) !== canonicalSha256(ref)) {
    throw new KernelError('SR_ARTIFACT_CONFLICT', `${step.stepId} 已绑定其他产物或步骤不存在`);
  }
  return ref;
}

export function reportArtifacts(steps: SrStep[], assemblyStepId: string): SrReportArtifacts {
  return {
    format: 1, assemblyStepId,
    steps: steps.filter((s) => s.stepKind !== 'ASSEMBLE' && s.stepKind !== 'CHAT_ANSWER').map((s) => {
      if (s.status !== 'SUCCEEDED' || !s.outputArtifact) throw new KernelError('SR_ARTIFACT_UNBOUND', s.stepId);
      return { stepId: s.stepId, stepKind: s.stepKind, sectionKey: s.sectionKey, sequence: s.sequence, artifact: s.outputArtifact };
    }),
  };
}

/** 报告版本签入的引用是唯一入口；核验所有 A/J/QA 原件，不从当前步骤行或工作文件补配。 */
export async function loadReportMaterials(outputDir: string, report: ReportDocument): Promise<{ pack: EvidencePack; computed: ComputeResult }> {
  verifyReport(report);
  const refs = report.evidenceRefs;
  const snapshot = refs?.artifacts;
  if (!snapshot || snapshot.format !== 1 || !snapshot.assemblyStepId || snapshot.steps.length !== 10) {
    throw new KernelError('SR_ARTIFACT_UNBOUND', `${report.reportId}/v${report.version} 缺少完整材料绑定`);
  }
  const values = new Map<string, unknown>();
  const ids = new Set<string>();
  for (const s of snapshot.steps) {
    const key = `${s.stepKind}:${s.sectionKey ?? ''}`;
    if (ids.has(s.stepId) || values.has(key)) throw new KernelError('SR_ARTIFACT_BINDING_MISMATCH', '重复步骤');
    ids.add(s.stepId);
    values.set(key, await readStepArtifact(outputDir, { ...s, taskId: report.taskId }, s.artifact));
  }
  const requireValue = <T>(key: string): T => {
    if (!values.has(key)) throw new KernelError('SR_ARTIFACT_UNBOUND', key);
    return values.get(key) as T;
  };
  requireValue('PLAN:');
  const pack = requireValue<{ pack: EvidencePack }>('EVIDENCE:').pack;
  const computed = requireValue<{ computed: ComputeResult }>('COMPUTE:').computed;
  const groups = ['a', 'b', 'c'].map((key) => requireValue<{ output: AnalyzeOutput }>(`ANALYZE:${key}`).output);
  const aFinal = requireValue<{ output: AFinalOutput }>(values.has('A_FINAL:') ? 'A_FINAL:' : 'SYNTHESIZE:').output;
  const checklist = requireValue<SrChecklist>('CHECKLIST:');
  const judge = requireValue<{ output: JOutput }>('JUDGE:').output;
  const qa = requireValue<{ findings: ReportDocument['qaFindings'] }>('QA_CHECK:').findings;
  const { packHash, ...packBody } = pack;
  if (pack.taskId !== report.taskId || computed.taskId !== report.taskId || pack.subject !== report.subject ||
      pack.cutoff !== report.cutoff || computed.cutoff !== report.cutoff ||
      packHash !== refs.packHash || canonicalSha256(packBody) !== packHash ||
      canonicalSha256({ sections: groups.flatMap((g) => g.sections), aFinal }) !== refs.aOutputHash ||
      checklist.checklistHash !== refs.checklistHash || canonicalSha256(checklist.items) !== refs.checklistHash ||
      canonicalSha256(judge) !== refs.jOutputHash || canonicalSha256(qa) !== canonicalSha256(report.qaFindings)) {
    throw new KernelError('SR_ARTIFACT_BINDING_MISMATCH', `${report.reportId}/v${report.version} 材料与报告不符`);
  }
  return { pack, computed };
}

export function materialTables(pack: EvidencePack, computed: ComputeResult) {
  return Object.fromEntries([...pack.tables, ...computed.tables].map((t) => [t.tableId, {
    title: t.title, columns: t.columns, rows: t.rows,
    note: 'formula' in t ? `${t.unitNote ?? ''}；公式：${t.formula}` : t.unitNote,
  }]));
}
