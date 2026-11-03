/**
 * Lyra · 安装门留痕（EK-10.3）。W1: code-writer-pro。
 * 只允许写全绿记录：green !== true 一律拒绝（INSTALL_NOT_GREEN），无全绿记录的
 * 安装视为未完成。记录含版本标识、测试运行标识、输出摘要与时间。
 */
import type { Pool } from 'pg';
import { KernelError, type InstallLogRecord } from '../contracts.js';

export interface InstallLogEntry {
  id: string;
  versionId: string;
  testRunId: string;
  green: true;
  summary: string;
  recordedAt: string;
}

interface InstallRow {
  id: string;
  version_id: string;
  test_run_id: string;
  green: boolean;
  summary: string;
  recorded_at: Date;
}

/**
 * 写一条安装日志。green !== true → KernelError('INSTALL_NOT_GREEN')，不落行。
 * （InstallLogRecord.green 的字面量类型 true 已在编译期拦住多数误用；此处为运行时
 * 兜底——JSON/动态来源不经过类型系统。）
 */
export async function recordInstall(pool: Pool, rec: InstallLogRecord): Promise<InstallLogEntry> {
  if (rec.green !== true) {
    throw new KernelError(
      'INSTALL_NOT_GREEN',
      `仅全绿旅程可安装（EK-10.3）：green=${String(rec.green)}，拒写安装日志`,
    );
  }
  const bad: string[] = [];
  if (!rec.versionId?.trim()) bad.push('versionId');
  if (!rec.testRunId?.trim()) bad.push('testRunId');
  if (!rec.summary?.trim()) bad.push('summary');
  if (bad.length > 0) {
    throw new KernelError('INSTALL_NOT_GREEN', `安装记录缺字段：${bad.join('、')}（EK-10.3 全绿记录需完整可溯）`);
  }
  const res = await pool.query<InstallRow>(
    `insert into install_log (version_id, test_run_id, green, summary, recorded_at)
     values ($1, $2, true, $3, $4)
     returning id, version_id, test_run_id, green, summary, recorded_at`,
    [rec.versionId.trim(), rec.testRunId.trim(), rec.summary, rec.recordedAt],
  );
  const row = res.rows[0];
  if (!row) throw new Error('recordInstall: 写入失败');
  return {
    id: String(row.id),
    versionId: row.version_id,
    testRunId: row.test_run_id,
    green: true,
    summary: row.summary,
    recordedAt: row.recorded_at.toISOString(),
  };
}
