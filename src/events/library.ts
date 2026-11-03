/**
 * Lyra · 事件实例对象与持久化（W14: code-writer）。
 * 合同：docs/specs/P3-EVENTS-REVIEW.md Done-when 2；表结构 src/db/events-migration.sql（幂等，应用到 public）。
 * 事件实例 = 股票 × 事件类型 × 触发公告（HISTORICAL-REFERENCE §3 通用规则 2）；event_id 确定性 → 重放幂等，
 * 重复运行不产生重复实例（ON CONFLICT DO NOTHING），原件永不覆盖（不 update）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { DetectedEvent } from './detect.js';
import { eventIdOf } from './detect.js';
import type { EventType } from './rules.js';

/** 事件实例对象（派发冻结列 + attrs）。 */
export interface EventInstance {
  eventId: string;
  subject: string;
  type: EventType;
  subtype: string | null;
  eventTime: string; // ISO；= availableAt 基准
  evidenceFactId: string;
  attrs: Record<string, unknown>;
}

/** DetectedEvent → EventInstance（补确定性 event_id）。 */
export function toInstance(event: DetectedEvent): EventInstance {
  return {
    eventId: eventIdOf(event.subject, event.eventType, event.evidenceFactId),
    subject: event.subject,
    type: event.eventType,
    subtype: event.subtype,
    eventTime: event.eventTime,
    evidenceFactId: event.evidenceFactId,
    attrs: event.attrs,
  };
}

const MIGRATION_URL = new URL('../db/events-migration.sql', import.meta.url);

/** 应用 events 表迁移（幂等；调用方决定 schema——派发要求 public，即默认 search_path）。 */
export async function applyEventsMigration(pool: Pool): Promise<void> {
  const sql = await readFile(fileURLToPath(MIGRATION_URL), 'utf8');
  await pool.query(sql);
}

export interface InsertEventsResult {
  inserted: number;
  duplicateSkipped: number;
}

/** 批量落库：同 event_id 幂等跳过；不 update、不 delete（原件永不覆盖）。 */
export async function insertEvents(pool: Pool, events: readonly EventInstance[]): Promise<InsertEventsResult> {
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
