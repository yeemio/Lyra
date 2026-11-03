/**
 * Lyra · 年报审计意见回填 runner（A 类 A5 / W32: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §2.1/§4（L2 原件已入 CAS）/§6（适配器规则）；
 * 适配器 src/adapters/audit.ts（audit@p1，判类规则表单一来源）；桥 adapters/audit/bridge.py。
 *
 * 候选（派发冻结）：tier2 定期报告 PDF 中标题含"年度报告"（"半年度报告"含其子串，
 * 按只处理年报排除；排除 摘要/英文/已取消）的已完成（pdf_backfill_state DONE）行。
 * 标题过滤单一来源 = isAnnualReportTitle（TS 侧，与单测一致）。
 * audit@p2 候选过滤收紧（W43；REVISION-LOG 迭代循环 19 登记待办）：监管回函噪声标题
 * （问询函/关注函/监管工作函及其回复）不再入候选——isAuditNoiseTitle 保守组合规则；
 * 只影响未来候选，既有事实与 audit_opinion_state 现状行不动（audit@p1 产出如实保留）。
 *
 * 行为：
 * - 逐份抽取（批量桥调用摊薄容器启动，默认 20 份/批，本地计算无网络无节流）：
 *   FACT（五类/UNDETERMINED）→ insertFact 落 AUDIT_OPINION（幂等：同 factId 同内容
 *   ALREADY_INSERTED_IDENTICAL）；NO_AUDIT_SECTION → 不产事实（季报/半年报/噪声公告跳过，
 *   状态 SKIPPED 可见）；桥单份失败/哈希不符/落库冲突 → FAILED 继续；
 * - 断点续跑：audit_opinion_state 按 fact_id 幂等——DONE/SKIPPED 行重跑跳过，FAILED 重跑重试；
 * - 桥级失败（docker 缺失/超时/输出不可解析）：当前批登记 FAILED 后中止本次运行
 *   （环境性失败继续跑只会批量 FAILED，恢复 = 重跑同一命令）；本地计算无网络，
 *   不适用 DATA-SOURCES §7 网络退避。
 *
 * 状态表 audit_opinion_state（本文件内联 DDL，形状照 pdf_backfill_state；幂等应用）：
 *   fact_id（= 年报 ANNOUNCEMENT fact_id，PK）/ pdf_sha256 / status（DONE|SKIPPED|FAILED）/
 *   opinion（五类或 UNDETERMINED，DONE 行必填）/ error / extracted_at。
 *
 * CLI：
 *   node --import tsx src/backfill/audit.ts [--limit N] [--subject 600519] [--batch N]
 *   node --import tsx src/backfill/audit.ts --stats   （只读：完成度与五类分布）
 * 环境：LYRA_ARTIFACTS_DIR（缺省 <repo>/data/artifacts，须在工程内）、LYRA_PG_*。
 * 单测（src/backfill/audit.test.ts）经注入桥/适配器与隔离 schema，不碰 docker 不碰网络。
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { insertFact } from '../pintime/facts.js';
import type { InsertFactStatus } from '../pintime/facts.js';
import { createPool } from '../db/pool.js';
import { AdapterError } from '../adapters/adapter-types.js';
import {
  AUDIT_ARTIFACTS_REL,
  AUDIT_ADAPTER_VERSION,
  AuditAdapter,
  isAnnualReportTitle,
  type AuditSourceAnnouncement,
} from '../adapters/audit.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_BATCH_SIZE = 20;
const ERROR_TEXT_MAX = 300;

// ===== 状态表（内联 DDL；幂等；不带 schema 限定按 search_path 落位）=====

const AUDIT_MIGRATION_SQL = `
-- Lyra 年报审计意见回填状态表（A5/W32: code-writer-pro）。
-- 幂等键 fact_id = 年报 ANNOUNCEMENT 事实 id（断点续跑：重跑跳过 DONE/SKIPPED，FAILED 重试）。
create table if not exists audit_opinion_state (
  fact_id text primary key,
  pdf_sha256 text not null,
  status text not null check (status in ('DONE', 'FAILED', 'SKIPPED')),
  opinion text,
  error text,
  extracted_at timestamptz not null default now()
);
create index if not exists audit_opinion_state_status_idx on audit_opinion_state (status);
`;

const SCHEMA_NAME_RE = /^[a-z0-9_]{1,63}$/;

/** 建隔离 schema（可选）并应用内联 DDL（事务内，幂等）。 */
export async function applyAuditMigration(pool: Pool, schema?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (schema !== undefined) {
      if (!SCHEMA_NAME_RE.test(schema)) {
        throw new AdapterError('SCHEMA_NAME_INVALID', schema);
      }
      await client.query(`create schema if not exists "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
    }
    await client.query(AUDIT_MIGRATION_SQL);
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时回滚失败可忽略。
    }
    throw error;
  } finally {
    client.release();
  }
}

// ===== 状态读写 =====

export type AuditBackfillStatus = 'DONE' | 'SKIPPED' | 'FAILED';

export interface AuditStateRow {
  factId: string;
  pdfSha256: string;
  status: AuditBackfillStatus;
  opinion: string | null;
  error: string | null;
  extractedAt: string; // ISO
}

export async function upsertAuditState(pool: Pool, row: Omit<AuditStateRow, 'extractedAt'> & { extractedAt?: string }): Promise<void> {
  await pool.query(
    `insert into audit_opinion_state (fact_id, pdf_sha256, status, opinion, error, extracted_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (fact_id) do update
       set pdf_sha256 = excluded.pdf_sha256, status = excluded.status,
           opinion = excluded.opinion, error = excluded.error,
           extracted_at = excluded.extracted_at`,
    [row.factId, row.pdfSha256, row.status, row.opinion, row.error, row.extractedAt ?? new Date().toISOString()],
  );
}

export async function loadAuditState(pool: Pool, factId: string): Promise<AuditStateRow | null> {
  const res = await pool.query(
    'select fact_id, pdf_sha256, status, opinion, error, extracted_at from audit_opinion_state where fact_id = $1',
    [factId],
  );
  const row = res.rows[0] as
    | { fact_id: string; pdf_sha256: string; status: AuditBackfillStatus; opinion: string | null; error: string | null; extracted_at: Date }
    | undefined;
  if (row === undefined) return null;
  return {
    factId: row.fact_id,
    pdfSha256: row.pdf_sha256,
    status: row.status,
    opinion: row.opinion,
    error: row.error,
    extractedAt: row.extracted_at.toISOString(),
  };
}

// ===== 候选（年报 ANNOUNCEMENT × 已完成 PDF × 审计回填状态）=====

export interface AuditCandidateRow extends AuditSourceAnnouncement {
  /** audit_opinion_state 现状（null = 未处理；FAILED 重跑重试）。 */
  auditStatus: AuditBackfillStatus | null;
}

/**
 * 监管回函噪声标题排除（audit@p2 收紧；保守规则）：
 * 仅排除标题含（"回复"或"函"）且含（"问询"或"监管"或"关注"）的组合——精确命中
 * W32 实测噪声形态（问询函/关注函/监管工作函及其回复公告、专项说明），不过度排除：
 * 含"回复"或"函"但无问询/监管/关注限定词的标题保留；年报本体标题不含该组合，天然保留。
 * 保守优先：宁可漏排不误排（真实年报标题不会命中此组合）。
 */
export function isAuditNoiseTitle(title: string): boolean {
  return /回复|函/.test(title) && /问询|监管|关注/.test(title);
}

/** 库内年报候选全集（标题过滤：isAnnualReportTitle + audit@p2 噪声排除 isAuditNoiseTitle；不含状态过滤）。 */
export async function loadAnnualReportCandidates(pool: Pool): Promise<AuditCandidateRow[]> {
  const res = await pool.query(
    `select f.fact_id, f.subject_id,
            coalesce(f.typed_value->>'title', '') as title,
            s.pdf_sha256, f.available_at, f.source_published_at,
            a.status as audit_status
     from pintime_fact f
     join pdf_backfill_state s on s.fact_id = f.fact_id and s.status = 'DONE'
     left join audit_opinion_state a on a.fact_id = f.fact_id
     where f.fact_kind = 'ANNOUNCEMENT'
     order by f.subject_id, f.available_at`,
  );
  const rows: AuditCandidateRow[] = [];
  for (const raw of res.rows as {
    fact_id: string;
    subject_id: string;
    title: string;
    pdf_sha256: string | null;
    available_at: Date;
    source_published_at: Date | null;
    audit_status: AuditBackfillStatus | null;
  }[]) {
    if (!isAnnualReportTitle(raw.title)) continue; // 只处理年报（季报/半年报/摘要/英文/已取消跳过）
    if (isAuditNoiseTitle(raw.title)) continue; // audit@p2：监管回函噪声标题不入候选（既有状态行不动，仅影响未来候选）
    if (raw.pdf_sha256 === null || raw.pdf_sha256.length === 0) continue; // 无哈希无从读 CAS
    rows.push({
      factId: raw.fact_id,
      subjectId: raw.subject_id,
      title: raw.title,
      availableAt: raw.available_at.toISOString(),
      sourcePublishedAt: raw.source_published_at === null ? null : raw.source_published_at.toISOString(),
      pdfSha256: raw.pdf_sha256,
      auditStatus: raw.audit_status,
    });
  }
  return rows;
}

/** 待处理候选：未处理或 FAILED（断点续跑：DONE/SKIPPED 跳过）；subject/limit 可选收窄。 */
export function selectPendingCandidates(
  rows: readonly AuditCandidateRow[],
  opts: { subject?: string | undefined; limit?: number | undefined } = {},
): AuditCandidateRow[] {
  const out: AuditCandidateRow[] = [];
  for (const row of rows) {
    if (row.auditStatus === 'DONE' || row.auditStatus === 'SKIPPED') continue;
    if (opts.subject !== undefined && row.subjectId !== opts.subject) continue;
    if (opts.limit !== undefined && out.length >= opts.limit) break;
    out.push(row);
  }
  return out;
}

// ===== 回填执行 =====

export interface AuditRunRecord {
  factId: string;
  subjectId: string;
  title: string;
  status: AuditBackfillStatus;
  opinion?: string | undefined;
  error?: string | undefined;
}

export interface AuditRunSummary {
  adapterVersion: string;
  considered: number;
  factsInserted: number;
  factsIdentical: number;
  classified: number; // 五类命中（status FACT 且非 UNDETERMINED）
  undetermined: number; // UNDETERMINED 如实入库
  skippedNoAudit: number;
  failed: number;
  /** 桥级失败（环境性）：当前批已登记 FAILED，本次运行中止；恢复 = 重跑同一命令。 */
  aborted: string | null;
  records: AuditRunRecord[];
}

export interface AuditBackfillOptions {
  pool: Pool;
  adapter: AuditAdapter;
  batchSize?: number | undefined;
  subject?: string | undefined;
  limit?: number | undefined;
  nowImpl?: (() => Date) | undefined;
  onRecord?: ((record: AuditRunRecord, index: number, total: number) => void) | undefined;
}

function truncateError(text: string): string {
  return text.length <= ERROR_TEXT_MAX ? text : `${text.slice(0, ERROR_TEXT_MAX)}…`;
}

/** 跑全部待回填年报候选（断点续跑）。 */
export async function runAuditBackfill(options: AuditBackfillOptions): Promise<AuditRunSummary> {
  const { pool, adapter } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.nowImpl ?? (() => new Date());
  const all = await loadAnnualReportCandidates(pool);
  const candidates = selectPendingCandidates(all, { subject: options.subject, limit: options.limit });
  const summary: AuditRunSummary = {
    adapterVersion: AUDIT_ADAPTER_VERSION,
    considered: 0,
    factsInserted: 0,
    factsIdentical: 0,
    classified: 0,
    undetermined: 0,
    skippedNoAudit: 0,
    failed: 0,
    aborted: null,
    records: [],
  };
  for (let start = 0; start < candidates.length; start += batchSize) {
    const chunk = candidates.slice(start, start + batchSize);
    let results;
    try {
      results = await adapter.extractAnnualReportBatch(chunk);
    } catch (error) {
      // 桥级失败（docker 缺失/超时/输出不可解析）：当前批登记 FAILED 后中止
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const observedIso = now().toISOString();
      for (const candidate of chunk) {
        await upsertAuditState(pool, {
          factId: candidate.factId,
          pdfSha256: candidate.pdfSha256,
          status: 'FAILED',
          opinion: null,
          error: truncateError(`桥级失败：${message}`),
          extractedAt: observedIso,
        });
        summary.failed += 1;
        const record: AuditRunRecord = {
          factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
          status: 'FAILED', error: truncateError(message),
        };
        summary.records.push(record);
        options.onRecord?.(record, summary.considered + 1, candidates.length);
        summary.considered += 1;
      }
      summary.aborted = truncateError(message);
      break;
    }
    for (let i = 0; i < chunk.length; i++) {
      const candidate = chunk[i]!;
      const result = results[i];
      summary.considered += 1;
      const index = summary.considered;
      if (result === undefined) {
        await upsertAuditState(pool, {
          factId: candidate.factId, pdfSha256: candidate.pdfSha256, status: 'FAILED',
          opinion: null, error: '结果数与批量不一致',
        });
        summary.failed += 1;
        const record: AuditRunRecord = {
          factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
          status: 'FAILED', error: '结果数与批量不一致',
        };
        summary.records.push(record);
        options.onRecord?.(record, index, candidates.length);
        continue;
      }
      if (result.status === 'NO_AUDIT_SECTION') {
        await upsertAuditState(pool, {
          factId: candidate.factId, pdfSha256: candidate.pdfSha256, status: 'SKIPPED',
          opinion: null, error: truncateError(result.reason),
        });
        summary.skippedNoAudit += 1;
        const record: AuditRunRecord = {
          factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
          status: 'SKIPPED', error: result.reason,
        };
        summary.records.push(record);
        options.onRecord?.(record, index, candidates.length);
        continue;
      }
      if (result.status === 'ERROR') {
        await upsertAuditState(pool, {
          factId: candidate.factId, pdfSha256: candidate.pdfSha256, status: 'FAILED',
          opinion: null, error: truncateError(`${result.code}: ${result.error}`),
        });
        summary.failed += 1;
        const record: AuditRunRecord = {
          factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
          status: 'FAILED', error: `${result.code}: ${result.error}`,
        };
        summary.records.push(record);
        options.onRecord?.(record, index, candidates.length);
        continue;
      }
      // FACT（五类或 UNDETERMINED）→ 落库；落库冲突（同 factId 异内容）按 FAILED 登记
      let insertStatus: InsertFactStatus;
      try {
        insertStatus = await insertFact(pool, result.fact);
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        await upsertAuditState(pool, {
          factId: candidate.factId, pdfSha256: candidate.pdfSha256, status: 'FAILED',
          opinion: null, error: truncateError(`落库失败：${message}`),
        });
        summary.failed += 1;
        const record: AuditRunRecord = {
          factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
          status: 'FAILED', error: truncateError(`落库失败：${message}`),
        };
        summary.records.push(record);
        options.onRecord?.(record, index, candidates.length);
        continue;
      }
      if (insertStatus === 'INSERTED') summary.factsInserted += 1;
      else summary.factsIdentical += 1;
      const opinion = result.classification.type;
      if (result.classification.status === 'UNDETERMINED') summary.undetermined += 1;
      else summary.classified += 1;
      await upsertAuditState(pool, {
        factId: candidate.factId, pdfSha256: candidate.pdfSha256, status: 'DONE',
        opinion, error: null,
      });
      const record: AuditRunRecord = {
        factId: candidate.factId, subjectId: candidate.subjectId, title: candidate.title,
        status: 'DONE', opinion,
      };
      summary.records.push(record);
      options.onRecord?.(record, index, candidates.length);
    }
  }
  return summary;
}

// ===== 完成度与分布统计（--stats；只读）=====

export interface AuditCoverageStats {
  candidatesTotal: number; // 年报候选全集（标题过滤后）
  processedDone: number;
  processedSkipped: number;
  processedFailed: number;
  pending: number; // 未处理 + FAILED（重跑会重试）
  stateOpinionCounts: Record<string, number>; // audit_opinion_state DONE 行按 opinion
  factCounts: Record<string, number>; // pintime_fact AUDIT_OPINION 按 typedValue.类型
}

export async function computeAuditCoverageStats(pool: Pool): Promise<AuditCoverageStats> {
  const all = await loadAnnualReportCandidates(pool);
  let processedDone = 0;
  let processedSkipped = 0;
  let processedFailed = 0;
  for (const row of all) {
    if (row.auditStatus === 'DONE') processedDone += 1;
    else if (row.auditStatus === 'SKIPPED') processedSkipped += 1;
    else if (row.auditStatus === 'FAILED') processedFailed += 1;
  }
  const stateRes = await pool.query<{ opinion: string | null; count: string }>(
    "select opinion, count(*) as count from audit_opinion_state where status = 'DONE' group by opinion order by count desc",
  );
  const stateOpinionCounts: Record<string, number> = {};
  for (const row of stateRes.rows) {
    stateOpinionCounts[row.opinion ?? '(null)'] = Number(row.count);
  }
  const factRes = await pool.query<{ t: string | null; count: string }>(
    "select typed_value->>'类型' as t, count(*) as count from pintime_fact where fact_kind = 'AUDIT_OPINION' group by 1 order by count desc",
  );
  const factCounts: Record<string, number> = {};
  for (const row of factRes.rows) {
    factCounts[row.t ?? '(null)'] = Number(row.count);
  }
  return {
    candidatesTotal: all.length,
    processedDone,
    processedSkipped,
    processedFailed,
    pending: all.length - processedDone - processedSkipped,
    stateOpinionCounts,
    factCounts,
  };
}

// ===== CLI =====

interface CliArgs {
  limit: number | undefined;
  subject: string | undefined;
  batch: number;
  stats: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let limit: number | undefined;
  let subject: string | undefined;
  let batch = DEFAULT_BATCH_SIZE;
  let stats = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        console.error('--limit 须为正整数');
        process.exit(1);
      }
      limit = value;
      i += 1;
    } else if (arg === '--subject') {
      const value = argv[i + 1];
      if (value === undefined || !/^\d{6}$/.test(value)) {
        console.error('--subject 须为 6 位代码');
        process.exit(1);
      }
      subject = value;
      i += 1;
    } else if (arg === '--batch') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        console.error('--batch 须为 1–200');
        process.exit(1);
      }
      batch = value;
      i += 1;
    } else if (arg === '--stats') {
      stats = true;
    }
  }
  return { limit, subject, batch, stats };
}

/** 原件库相对工程根路径（容器挂载仅覆盖工程内；LYRA_ARTIFACTS_DIR 在工程外即拒绝）。 */
function resolveArtifactsRel(envDir: string | undefined): string {
  const abs = envDir !== undefined && isAbsolute(envDir) ? envDir : `${repoRoot}${envDir ?? AUDIT_ARTIFACTS_REL}`;
  const rel = relative(repoRoot, abs);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new AdapterError('AUDIT_ARTIFACTS_DIR_OUTSIDE_REPO', abs);
  }
  return rel;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactsRel = resolveArtifactsRel(process.env.LYRA_ARTIFACTS_DIR);
  await mkdir(`${repoRoot}${artifactsRel}`, { recursive: true });
  const pool = createPool();
  try {
    await applyAuditMigration(pool);
    if (args.stats) {
      const stats = await computeAuditCoverageStats(pool);
      console.log(`[audit] 年报候选全集=${String(stats.candidatesTotal)}（标题含年度报告，排除 半年度/摘要/英文/已取消 及监管回函噪声）`);
      console.log(
        `[audit] 完成 done=${String(stats.processedDone)} skipped(无审计节)=${String(stats.processedSkipped)} ` +
          `failed=${String(stats.processedFailed)} pending=${String(stats.pending)}`,
      );
      const pct = stats.candidatesTotal === 0 ? 'n/a' : `${Math.round(((stats.processedDone + stats.processedSkipped) / stats.candidatesTotal) * 100)}%`;
      console.log(`[audit] 完成度（done+skipped）/候选全集 = ${pct}`);
      console.log(`[audit] 状态表 DONE 行 opinion 分布：${JSON.stringify(stats.stateOpinionCounts)}`);
      console.log(`[audit] AUDIT_OPINION 事实分布（五类 + UNDETERMINED）：${JSON.stringify(stats.factCounts)}`);
      return;
    }
    const adapter = new AuditAdapter({ artifactsRel });
    const summary = await runAuditBackfill({
      pool,
      adapter,
      batchSize: args.batch,
      subject: args.subject,
      limit: args.limit,
      onRecord: (record, index, total) => {
        if (record.status === 'DONE') {
          console.log(
            `[audit] ${String(index)}/${String(total)} fact=${record.factId} ${record.subjectId} ` +
              `${record.title.slice(0, 24)} DONE ${record.opinion ?? ''}`,
          );
        } else {
          console.log(
            `[audit] ${String(index)}/${String(total)} fact=${record.factId} ${record.subjectId} ` +
              `${record.title.slice(0, 24)} ${record.status} ${record.error ?? ''}`,
          );
        }
      },
    });
    console.log(
      `[audit] 运行结束：considered=${String(summary.considered)} inserted=${String(summary.factsInserted)} ` +
        `identical=${String(summary.factsIdentical)} classified=${String(summary.classified)} ` +
        `undetermined=${String(summary.undetermined)} skippedNoAudit=${String(summary.skippedNoAudit)} ` +
        `failed=${String(summary.failed)} aborted=${summary.aborted !== null}`,
    );
    if (summary.aborted !== null) {
      console.error(`[audit] 桥级失败中止：${summary.aborted}；恢复 = 重跑同一命令（断点续跑）`);
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) await main();
