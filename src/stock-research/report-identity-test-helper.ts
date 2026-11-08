/** 公开合成材料；只用于报告身份/隔离 PG 回归，不是历史资料或业务接受证据。 */
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../canonical.js';
import type { ComputeResult, EvidencePack, ReportDocument, ReportSection, SrStep } from './contracts.js';
import type { AFinalOutput, AnalyzeOutput, JOutput } from './transport.js';
import { deriveSrChecklist } from './engine.js';
import { putStepArtifact, reportArtifacts } from './report-artifacts.js';
import { signReport } from './report-identity.js';

export async function reportFixture(outputDir: string, opts: { taskId?: string; reportId?: string; version?: number; subject?: string; cutoff?: string; label?: string } = {}) {
  const taskId = opts.taskId ?? randomUUID();
  const subject = opts.subject ?? '600101';
  const cutoff = opts.cutoff ?? '2026-11-01T00:00:00.000Z';
  const label = opts.label ?? 'SYNTHETIC-V1';
  const packBase: Omit<EvidencePack, 'packHash'> = {
    taskId, subject, cutoff, builtAt: cutoff,
    tables: [{ tableId: 'fin-quarterly', title: label, columns: ['statDate', 'MBRevenue'], rows: [['2026-09-30', 123]],
      unitNote: '公开合成来源字段', cutoff,
      locators: [{ kind: 'FACT', factId: `synthetic-${label}`, factKind: 'FINANCIAL', subjectId: subject, availableAt: cutoff }] },
    { tableId: 'official-financials', title: '公开合成原件', columns: ['reportPeriod', 'metric', 'value', 'sourceSubject'],
      rows: [['2026-09-30', 'operatingRevenue', 123, subject]], unitNote: '测试原件定位，非真实财报', cutoff,
      locators: [{ kind: 'FILE', path: 'synthetic/report.txt', note: '公开合成测试原件' }] }],
    coverage: {
      financials: { periods: 1, latestPeriod: '2026-09-30', note: 'synthetic' },
      bars: { count: 0, firstDate: null, lastDate: null, note: null },
      announcements: { count: 0, latestTitleAt: null, note: null }, margin: { count: 0, latestDate: null, note: null },
      holderCount: { count: 0, latestDate: null, note: null }, pledge: { count: 0, latestDate: null, note: null },
      industry: { swL1: null, note: null }, valuationInputs: { closePriceDate: null, sharesSource: null, epsTtmSource: null, note: null },
      gaps: ['公开合成输入，无真实业务接受'],
    },
  };
  const pack: EvidencePack = { ...packBase, packHash: canonicalSha256(packBase) };
  const computed: ComputeResult = { taskId, cutoff, checks: [], tables: [{
    tableId: 'fixture-computed', title: `计算 ${label}`, columns: ['value'], rows: [[42]], unitNote: '公开合成计算',
    locators: pack.tables[0]!.locators, cutoff, formula: '42', inputs: ['fin-quarterly'],
  }] };
  const section = (key: ReportSection['key']): ReportSection => ({ key, title: key, narrative: label,
    findings: [], tables: ['fin-quarterly', 'fixture-computed'], citations: [], gaps: [] });
  const groups: AnalyzeOutput[] = ['company', 'financials', 'valuation'].map((key) => ({ sections: [{ key, narrative: label, findings: [], tables: ['fin-quarterly', 'fixture-computed'], gaps: [] }], citations: [] }));
  const aFinal: AFinalOutput = { narrative: label, conclusion: `条件判断 ${label}`, conclusionConditions: ['仅供合成验证'],
    decisiveLinks: [{ text: '合成连接', tableId: 'fin-quarterly' }], strongestCounter: '缺真实材料', catalysts: [], gaps: [] };
  const checklist = deriveSrChecklist(groups, aFinal);
  const judge: JOutput = { verdicts: checklist.items.map((i) => ({ checklistId: i.checklistId, verdict: 'SUPPORTED',
    decisionBearing: true, bearingReason: '合成依据', evidenceRef: 'fin-quarterly', remainingBasis: null, correction: null })),
    conclusionRuling: { finalConclusion: aFinal.conclusion, changedFromA: false, changeReason: null, conditions: aFinal.conclusionConditions },
    unresolvedDisposition: [], limitations: ['模拟材料不构成真实研究'] };
  const values: { kind: SrStep['stepKind']; key?: string; value: unknown }[] = [
    { kind: 'PLAN', value: { input: {}, output: { questions: ['合成问题'], materialPriorities: ['fin-quarterly'], emphasisNotes: [] } } },
    { kind: 'EVIDENCE', value: { pack } }, { kind: 'COMPUTE', value: { computed } },
    ...groups.map((g, i) => ({ kind: 'ANALYZE' as const, key: ['a', 'b', 'c'][i]!, value: { input: {}, output: g } })),
    { kind: 'A_FINAL', value: { input: {}, output: aFinal } }, { kind: 'CHECKLIST', value: checklist },
    { kind: 'JUDGE', value: { input: {}, output: judge } }, { kind: 'QA_CHECK', value: { findings: [] } },
  ];
  const steps: SrStep[] = [];
  for (const [i, value] of values.entries()) {
    const step: SrStep = { taskId, stepId: randomUUID(), stepKind: value.kind, sectionKey: value.key ?? null,
      sequence: i + 1, status: 'SUCCEEDED', note: null, startedAt: cutoff, finishedAt: cutoff };
    step.outputArtifact = await putStepArtifact(outputDir, step, value.value);
    steps.push(step);
  }
  const assembly: SrStep = { taskId, stepId: randomUUID(), stepKind: 'ASSEMBLE', sectionKey: null, sequence: 11,
    status: 'PENDING', note: null, startedAt: null, finishedAt: null };
  const report = signReport({ reportId: opts.reportId ?? randomUUID(), taskId, version: opts.version ?? 1,
    subject, subjectName: `合成公司 ${label}`, focus: 'FULL', horizon: 'MID_TERM', cutoff,
    methodVersion: 'sr-m1', adapterVersion: 'synthetic', planAuthVersion: 'sr-auth-1', generatedBy: 'PRODUCT_SIMULATED',
    sections: [section('summary'), section('company'), section('financials'), section('valuation'), { ...section('sources'), gaps: pack.coverage.gaps }],
    qaFindings: [], gate: { mandatoryJDone: true, decisionBearingUnresolved: [], passed: true, reason: '合成门' },
    evidenceRefs: { packHash: pack.packHash, aOutputHash: canonicalSha256({ sections: groups.flatMap((g) => g.sections), aFinal }),
      checklistHash: checklist.checklistHash, jOutputHash: canonicalSha256(judge), artifacts: reportArtifacts(steps, assembly.stepId) },
    status: 'PUBLISHED', changeSummary: null, createdAt: cutoff, publishedAt: cutoff,
  });
  return { report, pack, computed, steps, assembly, values };
}
