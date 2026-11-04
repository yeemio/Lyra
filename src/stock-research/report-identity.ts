import { canonicalSha256 } from '../canonical.js';
import { KernelError } from '../contracts.js';
import type { ReportDocument } from './contracts.js';

/** 时间规范化在签名之前发生；不把 DB 默认时钟或额外查询字段带入正文。 */
export function reportBody(report: Omit<ReportDocument, 'contentHash'>): Omit<ReportDocument, 'contentHash'> {
  return {
    reportId: report.reportId, taskId: report.taskId, version: report.version,
    status: report.status, subject: report.subject, subjectName: report.subjectName,
    focus: report.focus, horizon: report.horizon, cutoff: new Date(report.cutoff).toISOString(),
    methodVersion: report.methodVersion, adapterVersion: report.adapterVersion,
    planAuthVersion: report.planAuthVersion, generatedBy: report.generatedBy,
    sections: report.sections, qaFindings: report.qaFindings,
    evidenceRefs: report.evidenceRefs ?? null, gate: report.gate ?? null,
    changeSummary: report.changeSummary ?? null,
    createdAt: new Date(report.createdAt).toISOString(),
    publishedAt: report.publishedAt === null ? null : new Date(report.publishedAt).toISOString(),
    ...(report.derivation ? { derivation: report.derivation } : {}),
  };
}

export function signReport(report: Omit<ReportDocument, 'contentHash'>): ReportDocument {
  const body = reportBody(report);
  return { ...body, contentHash: canonicalSha256(body) };
}

export function verifyReport(report: ReportDocument): ReportDocument {
  const normalized = signReport(report);
  if (normalized.contentHash !== report.contentHash) {
    throw new KernelError('SR_REPORT_HASH_MISMATCH', `${report.reportId}/v${report.version} 正文校验失败；旧记录不自动重签`);
  }
  return normalized;
}

/** 同一 ASSEMBLE 重入只容许相同正文；版本身份与首次持久化时间不重新生成。 */
export function assemblyBody(report: Omit<ReportDocument, 'contentHash'>): unknown {
  const { reportId: _id, version: _version, createdAt: _created, publishedAt: _published, ...body } = reportBody(report);
  return body;
}
