/**
 * Lyra · 监管问询事件检测 CLI（W33: code-writer，A6）。跑冻结池 26 股 2015 至今的问询族公告，
 * 识别 REGULATORY_INQUIRY 事件并落 events 表（type 为无约束 text，W33 派发确认）。
 * 数据源：P1 冻结的 L1 巨潮 ANNOUNCEMENT 元数据（零新数据源，W33 探测实证 22/26 股 258 条覆盖）。
 *
 * 用法：node --import tsx src/events/inquiry.cli.ts
 * 幂等：event_id 确定性 + ON CONFLICT DO NOTHING，重复运行不重复落库；不 update、不 delete。
 * 组合层交叉核对：对每个候选标题同跑 W14 classifyTitle，登记双命中冲突数（裁定：问询类胜，
 * 真实语料预期 0）；W14 六类事件本身已由 detect.cli.ts 落库，本 CLI 只写 REGULATORY_INQUIRY。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { classifyTitle } from './detect.js';
import {
  detectInquiry,
  inquiryEventIdOf,
  toInquiryInstance,
  type InquiryEventInstance,
  type InquiryLetterKind,
  type InquiryIssuer,
  type InquirySubtype,
} from './inquiry.js';
import { applyEventsMigration } from './library.js';
import type { AnnouncementInput } from './detect.js';

const RANGE_START = '2015-01-01';
const SUMMARY_PATH = new URL('../../var/w33-inquiry-summary.json', import.meta.url);

interface PoolFile {
  stocks: { code: string; name: string }[];
}

function tally<K extends string>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function insertInquiryEvents(pool: Pool, events: readonly InquiryEventInstance[]): Promise<{ inserted: number; duplicateSkipped: number }> {
  let inserted = 0;
  for (const e of events) {
    const r = await pool.query(
      `insert into events (event_id, subject, type, subtype, event_time, evidence_fact_id, attrs)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (event_id) do nothing`,
      [e.eventId, e.subject, e.type, e.subtype, e.eventTime, e.evidenceFactId, JSON.stringify(e.attrs)],
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted, duplicateSkipped: events.length - inserted };
}

async function main(): Promise<void> {
  const poolFile = JSON.parse(readFileSync(new URL('../../data/research-pool.json', import.meta.url), 'utf8')) as PoolFile;
  const codes = poolFile.stocks.map((s) => s.code);
  if (codes.length !== 26) throw new Error(`POOL_SIZE_MISMATCH: ${codes.length}`);

  const pool = createPool();
  try {
    await applyEventsMigration(pool);

    const annRows = await pool.query<{ fact_id: string; subject_id: string; available_at: Date; title: string }>(
      `select fact_id, subject_id, available_at, typed_value->>'title' as title
       from pintime_fact
       where fact_kind = 'ANNOUNCEMENT' and subject_id = any($1) and available_at >= $2
       order by available_at, typed_value->>'announcementTime', fact_id`,
      [codes, RANGE_START],
    );

    const events: InquiryEventInstance[] = [];
    const subtypeCounts = new Map<InquirySubtype, number>();
    const letterKindCounts = new Map<InquiryLetterKind, number>();
    const issuerCounts = new Map<InquiryIssuer, number>();
    const excludedCounts = new Map<string, number>();
    const perStock = new Map<string, number>();
    let noKeyword = 0;
    let subtypeUndetermined = 0;
    let sixTypeArbitrationConflicts = 0;
    const conflictTitles: string[] = [];
    const sampleQuota: Record<InquirySubtype, number> = { RECEIVED: 5, REPLY: 5, UNDETERMINED: 10 };
    const perSubtypeTaken = new Map<InquirySubtype, number>();
    const sample: InquiryEventInstance[] = [];

    for (const row of annRows.rows) {
      const input: AnnouncementInput = {
        factId: row.fact_id,
        subjectId: row.subject_id,
        title: row.title ?? '',
        availableAt: row.available_at.toISOString(),
      };
      const outcome = detectInquiry(input);
      if (outcome.kind === 'NONE') {
        noKeyword += 1;
        continue;
      }
      if (outcome.kind === 'COMPANION_EXCLUDED') {
        tally(excludedCounts as Map<string, number>, outcome.excludedBy);
        continue;
      }
      const inst = toInquiryInstance(outcome.event);
      events.push(inst);
      tally(subtypeCounts, inst.subtype);
      tally(letterKindCounts, (inst.attrs.letterKind as InquiryLetterKind));
      tally(issuerCounts, (inst.attrs.issuer as InquiryIssuer));
      tally(perStock, inst.subject);
      if (inst.subtype === 'UNDETERMINED') subtypeUndetermined += 1;

      // 与 W14 六类的双命中登记（裁定：问询类胜；真实语料预期 0 冲突）
      const six = classifyTitle(input.title);
      if (six.primary !== null) {
        sixTypeArbitrationConflicts += 1;
        conflictTitles.push(input.title);
      }

      const taken = perSubtypeTaken.get(inst.subtype) ?? 0;
      const quota = sampleQuota[inst.subtype];
      if (taken < quota) {
        perSubtypeTaken.set(inst.subtype, taken + 1);
        sample.push(inst);
      }
    }

    const db = await insertInquiryEvents(pool, events);

    const summary = {
      rangeStart: RANGE_START,
      stocks: codes.length,
      stocksWithEvents: perStock.size,
      stocksZeroEvents: codes.filter((c) => !perStock.has(c)),
      announcementsScanned: annRows.rows.length,
      eventsDetected: events.length,
      db,
      countsBySubtype: Object.fromEntries(subtypeCounts),
      countsByLetterKind: Object.fromEntries(letterKindCounts),
      countsByIssuer: Object.fromEntries(issuerCounts),
      excludedBy: Object.fromEntries(excludedCounts),
      excludedTotal: [...excludedCounts.values()].reduce((a, b) => a + b, 0),
      noInquiryKeywordTitles: noKeyword,
      subtypeUndetermined: subtypeUndetermined,
      sixTypeArbitrationConflicts,
      conflictTitles,
      idScheme: 'evt:sha256(subject|REGULATORY_INQUIRY|evidenceFactId)',
      idSelfCheck: (() => {
        const probe = events[0];
        return probe === undefined ? null : probe.eventId === inquiryEventIdOf(probe.subject, probe.evidenceFactId);
      })(),
    };
    console.log('=== INQUIRY EVENTS SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));

    console.log('=== MANUAL REVIEW SAMPLE (10: 5 RECEIVED + 5 REPLY) ===');
    for (const e of sample) {
      const title = typeof e.attrs.title === 'string' ? e.attrs.title : '(no title)';
      console.log(
        [e.subject, e.subtype, String(e.attrs.letterKind), String(e.attrs.issuer), e.eventTime, title].join(' | '),
      );
    }

    writeFileSync(SUMMARY_PATH, JSON.stringify({ summary, sample }, null, 2), 'utf8');
    console.log(`summary written: var/w33-inquiry-summary.json`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('INQUIRY_CLI_FAILED:', err);
  process.exit(1);
});
