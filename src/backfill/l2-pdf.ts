/**
 * Lyra · L2 研究池公告 PDF 回填 runner（P1 后置面 W21: code-writer）。
 * 合同：docs/specs/DATA-SOURCES.md §2.1（PDF 原件入 CAS）、§4 L2（研究池全量 PDF 分层回填，
 * 不做一次性全量）、§7（串行节流 ≥2s + 退避 30s/60s/120s 暂停上报）；派发列冻结见
 * src/db/l2-migration.sql（pdf_backfill_state，幂等键 fact_id）。
 *
 * 优先级分层（派发冻结，classifyTier）：
 * - tier 1：预告/快报/更正类（标题含 业绩预告|业绩快报|修正|更正）；
 * - tier 2：定期报告（标题含 年度报告|季度报告|半年度报告|年报|一季报|三季报，排除"摘要"）；
 * - tier 3：其余（含被"摘要"排除的定期报告摘要），同层内一律按公告时间倒序。
 *
 * 行为：
 * - 下载：adjunctUrl 经 cninfo pdfUrlOf 构造静态域 URL → PDF 字节经 ArtifactStore.put 入
 *   CAS 原件库（mediaType application/pdf，写入即校验），落 pdf_backfill_state（sha256/bytes）；
 *   非 PDF 内容（HTTP 200 但无 %PDF- 头）按永久错误登记 FAILED，不重试。
 * - 断点续跑：按 fact_id 幂等——DONE 行在候选查询中即被排除（重跑跳过已下载）；
 *   FAILED 行重跑会重试；SKIPPED 行（adjunctUrl 为空）重跑时重登记（幂等同值）。
 * - 节流/退避：请求间隔默认 2000ms（L2_THROTTLE_MS 覆盖），单来源串行；瞬态错误
 *   （网络/超时/429/5xx）经共享 runWithBackoff 重试 3 次（30s/60s/120s），耗尽即暂停上报
 *   （adapter_pause_report 落库 + 退出码 2），本次运行停止，恢复 = 重跑同一命令。
 * - 永久错误（HTTP 4xx、非 PDF 内容）：登记 FAILED 后继续下一份，不暂停。
 *
 * CLI：node --import tsx src/backfill/l2-pdf.ts --tier 1|2|3 [--limit N]
 *      node --import tsx src/backfill/l2-pdf.ts --tier-stats（只读分层统计与全量预计）
 * 环境：LYRA_ARTIFACTS_DIR（缺省 <cwd>/data/artifacts）、L2_THROTTLE_MS（缺省 2000）、LYRA_PG_*。
 * 单测（src/backfill/l2-pdf.test.ts）经 fetchImpl/sleepImpl 注入，不碰网络。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { CNINFO_ADAPTER_VERSION, pdfUrlOf } from '../adapters/cninfo.js';
import { AdapterError, TransientAdapterError } from '../adapters/adapter-types.js';
import {
  AdapterPauseError,
  realSleeper,
  resumePause,
  runWithBackoff,
  type BackoffSleeper,
} from '../adapters/backoff.js';
import { createPool } from '../db/pool.js';

const PDF_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_THROTTLE_MS = 2_000; // DATA-SOURCES §7：单来源串行节流 ≥2s/请求
const ERROR_TEXT_MAX = 500;

// ===== 优先级分层（派发冻结的关键词，勿改；变更属合同事件）=====

export type PdfTier = 1 | 2 | 3;

const TIER1_TITLE_RE = /业绩预告|业绩快报|修正|更正/;
const TIER2_TITLE_RE = /年度报告|季度报告|半年度报告|年报|一季报|三季报/;
const TIER2_EXCLUDE_RE = /摘要/;

/** 标题 → 优先级层：1 预告/快报/更正 → 2 定期报告（非摘要）→ 3 其余。 */
export function classifyTier(title: string): PdfTier {
  if (TIER1_TITLE_RE.test(title)) return 1;
  if (TIER2_TITLE_RE.test(title) && !TIER2_EXCLUDE_RE.test(title)) return 2;
  return 3;
}

/** PDF 内容判定：HTTP 200 但前 1024 字节无 %PDF- 头视为非 PDF（疑似拦截页），拒绝入库。 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');
}

/** 暂停上报 scope（adapter_pause_report.scope）：cninfo:announcement_pdf:<factId>。 */
export function l2PauseScope(factId: string): string {
  return `cninfo:announcement_pdf:${factId}`;
}

function truncateError(text: string): string {
  return text.length <= ERROR_TEXT_MAX ? text : `${text.slice(0, ERROR_TEXT_MAX)}…`;
}

// ===== 迁移（l2-migration.sql：pdf_backfill_state；与 applyP1Migration 同语义）=====

const SCHEMA_NAME_RE = /^[a-z0-9_]{1,63}$/;
const l2MigrationUrl = new URL('../db/l2-migration.sql', import.meta.url);

/** 建隔离 schema（可选）并按 search_path 应用 l2-migration.sql（幂等）。 */
export async function applyL2Migration(pool: Pool, schema?: string): Promise<void> {
  const ddl = await readFile(l2MigrationUrl, 'utf8');
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
    await client.query(ddl);
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

// ===== 回填状态（pdf_backfill_state）=====

export type PdfBackfillStatus = 'DONE' | 'FAILED' | 'SKIPPED';

export interface PdfBackfillStateRow {
  factId: string;
  pdfSha256: string | null;
  bytes: number | null;
  status: PdfBackfillStatus;
  error: string | null;
  downloadedAt: string; // ISO
}

export async function loadPdfState(pool: Pool, factId: string): Promise<PdfBackfillStateRow | null> {
  const res = await pool.query(
    'select fact_id, pdf_sha256, bytes, status, error, downloaded_at from pdf_backfill_state where fact_id = $1',
    [factId],
  );
  const row = res.rows[0] as
    | {
        fact_id: string;
        pdf_sha256: string | null;
        bytes: string | number | null;
        status: PdfBackfillStatus;
        error: string | null;
        downloaded_at: Date;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    factId: row.fact_id,
    pdfSha256: row.pdf_sha256,
    bytes: row.bytes === null ? null : Number(row.bytes),
    status: row.status,
    error: row.error,
    downloadedAt: row.downloaded_at.toISOString(),
  };
}

/** 同 fact_id 幂等覆盖：FAILED/SKIPPED 重跑被新结果覆写，DONE 不重写（候选查询已排除）。 */
export async function upsertPdfState(pool: Pool, row: PdfBackfillStateRow): Promise<void> {
  await pool.query(
    `insert into pdf_backfill_state (fact_id, pdf_sha256, bytes, status, error, downloaded_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (fact_id) do update
       set pdf_sha256 = excluded.pdf_sha256, bytes = excluded.bytes,
           status = excluded.status, error = excluded.error,
           downloaded_at = excluded.downloaded_at`,
    [row.factId, row.pdfSha256, row.bytes, row.status, row.error, row.downloadedAt],
  );
}

// ===== 候选选择（分类在 TS 单一来源；排序按公告时间倒序）=====

/** 库内公告索引行（loadAnnouncementIndex 输出，已按公告时间倒序）。 */
export interface AnnouncementIndexRow {
  factId: string;
  subjectId: string;
  title: string;
  adjunctUrl: string;
  announcementTime: number;
  done: boolean; // pdf_backfill_state 中已有 DONE 行
}

export interface L2Candidate {
  factId: string;
  subjectId: string;
  title: string;
  adjunctUrl: string;
  announcementTime: number;
}

/**
 * 库内 ANNOUNCEMENT 事实索引（含已完成标记），公告时间倒序。
 * 分类（classifyTier）在 TS 侧做，保证分层关键词单一来源、与单测一致。
 */
export async function loadAnnouncementIndex(pool: Pool): Promise<AnnouncementIndexRow[]> {
  const res = await pool.query(
    `select f.fact_id, f.subject_id,
            coalesce(f.typed_value->>'title', '') as title,
            coalesce(f.typed_value->>'adjunctUrl', '') as adjunct_url,
            coalesce((f.typed_value->>'announcementTime')::bigint, 0) as announcement_time,
            coalesce(s.status = 'DONE', false) as done
     from pintime_fact f
     left join pdf_backfill_state s on s.fact_id = f.fact_id
     where f.fact_kind = 'ANNOUNCEMENT'
     order by (f.typed_value->>'announcementTime')::bigint desc`,
  );
  const rows: AnnouncementIndexRow[] = [];
  for (const raw of res.rows as {
    fact_id: string;
    subject_id: string;
    title: string;
    adjunct_url: string;
    announcement_time: string | number;
    done: boolean;
  }[]) {
    rows.push({
      factId: raw.fact_id,
      subjectId: raw.subject_id,
      title: raw.title,
      adjunctUrl: raw.adjunct_url,
      announcementTime: Number(raw.announcement_time),
      done: raw.done === true,
    });
  }
  return rows;
}

/** 候选选择：跳过 DONE（断点续跑），按 classifyTier 过滤，公告时间倒序，limit 截断。 */
export function selectTierCandidates(
  rows: readonly AnnouncementIndexRow[],
  tier: PdfTier,
  limit?: number,
): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const row of rows) {
    if (row.done) continue;
    if (classifyTier(row.title) !== tier) continue;
    out.push({
      factId: row.factId,
      subjectId: row.subjectId,
      title: row.title,
      adjunctUrl: row.adjunctUrl,
      announcementTime: row.announcementTime,
    });
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}

export interface TierStats {
  tier: PdfTier;
  total: number;
  done: number;
  pending: number;
}

/** 分层统计（--tier-stats 与收口报告用）：库内全部 ANNOUNCEMENT 事实按 classifyTier 归层。 */
export function computeTierStats(rows: readonly AnnouncementIndexRow[]): TierStats[] {
  const stats: Record<PdfTier, TierStats> = {
    1: { tier: 1, total: 0, done: 0, pending: 0 },
    2: { tier: 2, total: 0, done: 0, pending: 0 },
    3: { tier: 3, total: 0, done: 0, pending: 0 },
  };
  for (const row of rows) {
    const entry = stats[classifyTier(row.title)];
    if (entry === undefined) continue; // 不可达：classifyTier 只返回 1|2|3
    entry.total += 1;
    if (row.done) entry.done += 1;
    else entry.pending += 1;
  }
  return [stats[1], stats[2], stats[3]];
}

// ===== 下载执行 =====

export interface L2DownloadRecord {
  factId: string;
  status: PdfBackfillStatus;
  sha256?: string | undefined;
  bytes?: number | undefined;
  error?: string | undefined;
}

export interface L2PauseReport {
  retries: number;
  lastError: string;
  scope: string;
  nextAction: string;
}

export interface L2RunSummary {
  tier: PdfTier;
  /** 本次实际处理的候选数（受 limit 约束；DONE 行在候选查询已排除，不计入）。 */
  considered: number;
  downloaded: number;
  bytesTotal: number;
  skippedEmptyUrl: number;
  failedPermanent: number;
  pause: L2PauseReport | null; // 非空 = 暂停上报，本次运行已中止（退出码 2）
  records: L2DownloadRecord[];
}

export interface L2PdfBackfillOptions {
  pool: Pool;
  store: ArtifactStore;
  /** 注入点：默认全局 fetch（单测注入 fixture 响应，不碰网络）。 */
  fetchImpl?: typeof fetch | undefined;
  /** 注入点：默认真实 sleep；同时用于节流与退避（单测即时放行并记录时延）。 */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  /** 请求间最小间隔（DATA-SOURCES §7）。默认 2000ms。 */
  throttleMs?: number | undefined;
  /** 注入点：默认 Date.now。 */
  nowImpl?: (() => number) | undefined;
  /** 每份处理完成回调（CLI 流式进度；单测省略）。 */
  onRecord?: ((record: L2DownloadRecord, index: number, total: number) => void) | undefined;
}

export class L2PdfBackfill {
  private readonly pool: Pool;
  private readonly store: ArtifactStore;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffSleeper: BackoffSleeper;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly onRecord: ((record: L2DownloadRecord, index: number, total: number) => void) | undefined;
  private lastRequestAt = 0;

  constructor(options: L2PdfBackfillOptions) {
    this.pool = options.pool;
    this.store = options.store;
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.backoffSleeper = options.sleepImpl !== undefined ? { sleep: options.sleepImpl } : realSleeper;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.now = options.nowImpl ?? Date.now;
    this.onRecord = options.onRecord;
  }

  private async throttle(): Promise<void> {
    const gap = this.now() - this.lastRequestAt;
    const wait = this.throttleMs - gap;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /**
   * 单份 PDF 获取：HTTP 200 且含 %PDF- 头才返回字节。
   * 瞬态（网络/超时/429/5xx）抛 TransientAdapterError（退避重试）；永久（4xx/非 PDF）抛 AdapterError。
   */
  private async fetchPdf(url: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.doFetch(url, { signal: AbortSignal.timeout(PDF_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new TransientAdapterError('SOURCE_NETWORK', error instanceof Error ? error.message : String(error));
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientAdapterError('SOURCE_RATE_LIMITED', `HTTP ${response.status} from ${url}`);
    }
    if (response.status !== 200) {
      throw new AdapterError('SOURCE_HTTP', `HTTP ${response.status} from ${url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdfBytes(bytes)) throw new AdapterError('NOT_PDF', `non-PDF payload from ${url}`);
    return bytes;
  }

  private async emit(record: L2DownloadRecord, index: number, total: number): Promise<void> {
    if (this.onRecord !== undefined) this.onRecord(record, index, total);
  }

  /**
   * 跑一个优先级层的待回填候选（断点续跑：DONE 已排除）。暂停上报即中止本次运行
   * （后续候选不动，重跑同一命令恢复）；永久错误登记 FAILED 后继续。
   */
  async run(tier: PdfTier, limit?: number): Promise<L2RunSummary> {
    const rows = await loadAnnouncementIndex(this.pool);
    const candidates = selectTierCandidates(rows, tier, limit);
    const summary: L2RunSummary = {
      tier,
      considered: 0,
      downloaded: 0,
      bytesTotal: 0,
      skippedEmptyUrl: 0,
      failedPermanent: 0,
      pause: null,
      records: [],
    };
    for (const candidate of candidates) {
      const index = summary.considered + 1;
      summary.considered = index;
      // adjunctUrl 为空的行：跳过下载但登记 SKIPPED（缺口可见，不静默）
      if (candidate.adjunctUrl.length === 0) {
        const row: PdfBackfillStateRow = {
          factId: candidate.factId,
          pdfSha256: null,
          bytes: null,
          status: 'SKIPPED',
          error: 'EMPTY_ADJUNCT_URL',
          downloadedAt: new Date(this.now()).toISOString(),
        };
        await upsertPdfState(this.pool, row);
        summary.skippedEmptyUrl += 1;
        const record: L2DownloadRecord = { factId: candidate.factId, status: 'SKIPPED', error: row.error ?? undefined };
        summary.records.push(record);
        await this.emit(record, index, candidates.length);
        continue;
      }
      const url = pdfUrlOf(candidate.adjunctUrl);
      try {
        const bytes = await runWithBackoff(
          async () => {
            await this.throttle();
            return this.fetchPdf(url);
          },
          {
            adapter: CNINFO_ADAPTER_VERSION,
            scope: l2PauseScope(candidate.factId),
            sleeper: this.backoffSleeper,
            pool: this.pool,
            nextAction: `重跑同一 CLI（--tier ${tier}），断点续跑跳过已完成 PDF，从该 fact 重试`,
          },
        );
        const observedIso = new Date(this.now()).toISOString();
        const ref = await this.store.put(bytes, 'application/pdf', observedIso);
        await upsertPdfState(this.pool, {
          factId: candidate.factId,
          pdfSha256: ref.sha256,
          bytes: ref.bytes,
          status: 'DONE',
          error: null,
          downloadedAt: observedIso,
        });
        summary.downloaded += 1;
        summary.bytesTotal += ref.bytes;
        // 恢复登记：该 fact 曾暂停上报的，成功后置 RESUMED（无暂停行为无害 no-op）
        await resumePause(this.pool, CNINFO_ADAPTER_VERSION, l2PauseScope(candidate.factId));
        const record: L2DownloadRecord = {
          factId: candidate.factId,
          status: 'DONE',
          sha256: ref.sha256,
          bytes: ref.bytes,
        };
        summary.records.push(record);
        await this.emit(record, index, candidates.length);
      } catch (error) {
        const observedIso = new Date(this.now()).toISOString();
        if (error instanceof AdapterPauseError) {
          // 退避耗尽（DATA-SOURCES §7）：登记 FAILED + 暂停上报已由 runWithBackoff 落库；
          // 本次运行停止，断点已落库，恢复 = 重跑同一命令。
          const four = error.fourElements();
          await upsertPdfState(this.pool, {
            factId: candidate.factId,
            pdfSha256: null,
            bytes: null,
            status: 'FAILED',
            error: truncateError(`${four.lastError}（重试 ${four.retries} 次后暂停上报）`),
            downloadedAt: observedIso,
          });
          summary.pause = four;
          const record: L2DownloadRecord = {
            factId: candidate.factId,
            status: 'FAILED',
            error: truncateError(four.lastError),
          };
          summary.records.push(record);
          await this.emit(record, index, candidates.length);
          break;
        }
        // 永久错误（4xx / 非 PDF / 原件库错误）：登记 FAILED，继续下一份
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        await upsertPdfState(this.pool, {
          factId: candidate.factId,
          pdfSha256: null,
          bytes: null,
          status: 'FAILED',
          error: truncateError(message),
          downloadedAt: observedIso,
        });
        summary.failedPermanent += 1;
        const record: L2DownloadRecord = { factId: candidate.factId, status: 'FAILED', error: truncateError(message) };
        summary.records.push(record);
        await this.emit(record, index, candidates.length);
      }
    }
    return summary;
  }
}

// ===== CLI =====

interface CliArgs {
  tier: PdfTier | undefined;
  limit: number | undefined;
  stats: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let tier: PdfTier | undefined;
  let limit: number | undefined;
  let stats = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tier') {
      const value = argv[i + 1];
      if (value !== '1' && value !== '2' && value !== '3') {
        console.error('--tier 须为 1|2|3');
        process.exit(1);
      }
      tier = Number(value) as PdfTier;
      i += 1;
    } else if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        console.error('--limit 须为正整数');
        process.exit(1);
      }
      limit = value;
      i += 1;
    } else if (arg === '--tier-stats') {
      stats = true;
    }
  }
  if (!stats && tier === undefined) {
    console.error('用法：node --import tsx src/backfill/l2-pdf.ts --tier 1|2|3 [--limit N]');
    console.error('      node --import tsx src/backfill/l2-pdf.ts --tier-stats');
    process.exit(1);
  }
  return { tier, limit, stats };
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(0)} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const throttleMs = Number(process.env.L2_THROTTLE_MS ?? DEFAULT_THROTTLE_MS);
  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(process.cwd(), 'data', 'artifacts');
  const pool = createPool();
  try {
    await applyL2Migration(pool); // 幂等：表不存在即建
    if (args.stats) {
      const rows = await loadAnnouncementIndex(pool);
      const subjects = new Set(rows.map((row) => row.subjectId));
      const stats = computeTierStats(rows);
      const pendingTotal = stats.reduce((sum, entry) => sum + entry.pending, 0);
      const doneTotal = stats.reduce((sum, entry) => sum + entry.done, 0);
      const labels: Record<PdfTier, string> = { 1: '预告/快报/更正', 2: '定期报告(非摘要)', 3: '其余' };
      for (const entry of stats) {
        console.log(
          `[l2] tier${entry.tier} ${labels[entry.tier]}: total=${entry.total} done=${entry.done} pending=${entry.pending}`,
        );
      }
      console.log(
        `[l2] 合计 done=${doneTotal} pending=${pendingTotal} subjects=${subjects.size} throttle=${throttleMs}ms`,
      );
      const throttleSeconds = (pendingTotal * throttleMs) / 1000;
      const realisticSeconds = (pendingTotal * (throttleMs + 3_000)) / 1000; // 经验：每份下载约 1–5s，取 ~3s
      console.log(
        `[l2] 全量预计（pending=${pendingTotal}）：节流下限 ${formatDuration(throttleSeconds)}；` +
          `按每份约 4s（节流+下载）约 ${formatDuration(realisticSeconds)}`,
      );
      return;
    }
    const tier = args.tier;
    if (tier === undefined) return; // 不可达：parseArgs 已校验
    const backfill = new L2PdfBackfill({
      pool,
      store: new ArtifactStore(artifactsDir),
      throttleMs,
      onRecord: (record, index, total) => {
        if (record.status === 'DONE') {
          console.log(
            `[l2] ${index}/${total} fact=${record.factId} DONE sha256=${(record.sha256 ?? '').slice(0, 12)} bytes=${record.bytes ?? 0}`,
          );
        } else {
          console.log(`[l2] ${index}/${total} fact=${record.factId} ${record.status} error=${record.error ?? ''}`);
        }
      },
    });
    const summary = await backfill.run(tier, args.limit);
    console.log(
      `[l2] tier${summary.tier} 运行结束：considered=${summary.considered} downloaded=${summary.downloaded} ` +
        `bytes=${summary.bytesTotal} skipEmpty=${summary.skippedEmptyUrl} failedPermanent=${summary.failedPermanent} ` +
        `paused=${summary.pause !== null}`,
    );
    if (summary.pause !== null) {
      // 暂停上报四要素已由 runWithBackoff 落库 adapter_pause_report；此处置退出码，状态行已打印。
      console.error(
        `[l2] 暂停（重试上限）：${JSON.stringify(summary.pause)}；恢复 = 重跑同一命令（断点续跑跳过已完成）`,
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) await main();
