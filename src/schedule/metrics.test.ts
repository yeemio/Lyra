/**
 * Lyra · 周末工程指标真实采集单测（P5 准备 W27: code-writer-pro）。
 * 隔离 schema + 临时原件目录：exec_permit / seal_manifest / events / schedule_admission
 * 合成行驱动全部口径断言（按窗完成、各态计数、缺口前后差、封存新增、准入面、完整性抽查）。
 * 公共库只读（不触 public），全部写入落隔离 schema 与临时目录。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import {
  checkArtifactIntegrity,
  collectProcessMetrics,
  refreshGapList,
  weekWindowOfSaturday,
  type IntegritySealSample,
} from './metrics.js';

const schema = `w27_m_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let pool: Pool;
let store: ArtifactStore;
let artifactDir: string;

// 周窗口：2026-10-19（周一）00:00+08 → 2026-10-26（周一）00:00+08（半开区间）
const WEEK_START = '2026-10-18T16:00:00.000Z';
const WEEK_END = '2026-10-25T16:00:00.000Z';
const GAP_A = 'GAP_A：既有具名缺口（本周前已登记）';
const GAP_B = 'GAP_B：本周新登记具名缺口';

// 原件：art1/art2 正常入库；MISSING_HASH 不入库；CORRUPT_HASH 手工放一份内容不符的文件
const ART1 = createHash('sha256').update('metrics-artifact-1').digest('hex');
const ART2 = createHash('sha256').update('metrics-artifact-2').digest('hex');
const ART3 = createHash('sha256').update('metrics-artifact-3').digest('hex');
const MISSING_HASH = createHash('sha256').update('metrics-artifact-missing').digest('hex');
const CORRUPT_HASH = createHash('sha256').update('metrics-artifact-corrupt-expected').digest('hex');

async function insertPermit(row: {
  subject: string;
  researchKind: 'WEEKLY' | 'POST_EVENT';
  stage: 'A' | 'J';
  state: 'PREPARED' | 'SENT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  failCode: string | null;
  settledAt: Date | null;
  deadline: Date;
  cutoff: Date;
  simulated?: boolean;
  createdAt?: Date;
}): Promise<void> {
  await pool.query(
    `insert into exec_permit (permit_id, stage, subject_kind, subject, research_kind, cutoff, input_hash,
       input_bytes, method_version, plan_auth_version, deadline, state, sent_at, settled_at, fail_code, simulated, created_at)
     values ($1, $2, 'STOCK', $3, $4, $5, $6, 1000, 'method@p2-v1', 'pa-test', $7, $8, $9, $10, $11, $12, $13)`,
    [
      randomUUID(), row.stage, row.subject, row.researchKind, row.cutoff,
      createHash('sha256').update(`${row.subject}:${row.researchKind}:${row.stage}`).digest('hex'),
      row.deadline, row.state,
      row.state === 'PREPARED' ? null : new Date('2026-10-20T10:00:00Z'),
      row.settledAt, row.failCode, row.simulated ?? true,
      row.createdAt ?? new Date('2026-10-20T09:00:00Z'),
    ],
  );
}

async function insertSeal(sealId: string, createdAt: Date, gaps: string[], refs: string[]): Promise<void> {
  await pool.query(
    `insert into seal_manifest (seal_id, business_key, cutoff, artifact_refs, fact_ids, gaps,
       method_version, adapter_version, plan_auth_version, created_at, manifest_hash)
     values ($1, $2::jsonb, $3, $4::jsonb, '[]'::jsonb, $5::jsonb, 'm', 'a', 'pa-test', $6, $7)`,
    [
      sealId,
      JSON.stringify({ subjectKind: 'STOCK', subject: '600001', researchKind: 'WEEKLY', cutoff: '2026-10-18T00:00:00Z' }),
      new Date('2026-10-18T00:00:00Z'),
      JSON.stringify(refs.map((sha256) => ({ sha256, bytes: 10, mediaType: 'application/json', firstObservedAt: '2026-10-18T00:00:00Z' }))),
      JSON.stringify(gaps),
      createdAt,
      createHash('sha256').update(sealId).digest('hex'),
    ],
  );
}

before(async () => {
  await applySchema(admin, schema);
  pool = createPool({ schema });
  // events / schedule 迁移（隔离 schema 内）
  const eventsSql = await readFile(fileURLToPath(new URL('../db/events-migration.sql', import.meta.url)), 'utf8');
  const scheduleSql = await readFile(fileURLToPath(new URL('../db/schedule-migration.sql', import.meta.url)), 'utf8');
  await pool.query(eventsSql);
  await pool.query(scheduleSql);

  artifactDir = await mkdtemp(join(tmpdir(), 'lyra-w27-metrics-'));
  store = new ArtifactStore(artifactDir);
  await store.put(new TextEncoder().encode('metrics-artifact-1'), 'application/json', '2026-10-01T00:00:00Z');
  await store.put(new TextEncoder().encode('metrics-artifact-2'), 'application/json', '2026-10-01T00:00:00Z');
  await store.put(new TextEncoder().encode('metrics-artifact-3'), 'application/json', '2026-10-01T00:00:00Z');
  // CORRUPT_HASH：内容不符的手工文件（readBytes 哈希比对失败 → HASH_MISMATCH）
  await mkdir(join(artifactDir, CORRUPT_HASH.slice(0, 2)), { recursive: true });
  await writeFile(join(artifactDir, CORRUPT_HASH.slice(0, 2), CORRUPT_HASH), 'corrupted-content', { mode: 0o600 });

  // ---- exec_permit：4 个业务键 ----
  const cutoff = new Date('2026-10-20T10:00:00Z');
  const deadline = new Date('2026-10-20T12:00:00Z');
  // key1（600001 WEEKLY）：A/J 均 SUCCEEDED 窗内 → 完成
  await insertPermit({ subject: '600001', researchKind: 'WEEKLY', stage: 'A', state: 'SUCCEEDED', failCode: null, settledAt: new Date('2026-10-20T11:00:00Z'), deadline, cutoff });
  await insertPermit({ subject: '600001', researchKind: 'WEEKLY', stage: 'J', state: 'SUCCEEDED', failCode: null, settledAt: new Date('2026-10-20T11:30:00Z'), deadline, cutoff });
  // key2（600002 WEEKLY）：J FAILED/DEADLINE_EXCEEDED → 未按窗
  await insertPermit({ subject: '600002', researchKind: 'WEEKLY', stage: 'A', state: 'SUCCEEDED', failCode: null, settledAt: new Date('2026-10-20T11:00:00Z'), deadline, cutoff });
  await insertPermit({ subject: '600002', researchKind: 'WEEKLY', stage: 'J', state: 'FAILED', failCode: 'DEADLINE_EXCEEDED', settledAt: new Date('2026-10-20T12:01:00Z'), deadline, cutoff });
  // key3（600003 POST_EVENT）：A SUCCEEDED 但迟到（LATE_COMPLETED），J 窗内 → 完成但计 1 次未按窗
  await insertPermit({ subject: '600003', researchKind: 'POST_EVENT', stage: 'A', state: 'SUCCEEDED', failCode: 'LATE_COMPLETED', settledAt: new Date('2026-10-20T12:30:00Z'), deadline, cutoff });
  await insertPermit({ subject: '600003', researchKind: 'POST_EVENT', stage: 'J', state: 'SUCCEEDED', failCode: null, settledAt: new Date('2026-10-20T11:30:00Z'), deadline, cutoff });
  // key4（600004 WEEKLY）：A UNKNOWN → unknown=1
  await insertPermit({ subject: '600004', researchKind: 'WEEKLY', stage: 'A', state: 'UNKNOWN', failCode: 'SILENCE_AFTER_SEND', settledAt: new Date('2026-10-20T11:00:00Z'), deadline, cutoff, simulated: false });
  // 窗外行（不计入）：上周创建
  await insertPermit({ subject: '600009', researchKind: 'WEEKLY', stage: 'A', state: 'SUCCEEDED', failCode: null, settledAt: new Date('2026-10-10T11:00:00Z'), deadline: new Date('2026-10-10T12:00:00Z'), cutoff: new Date('2026-10-10T10:00:00Z'), createdAt: new Date('2026-10-10T09:00:00Z') });

  // ---- seal_manifest：2 行本周前（GAP_A），3 行本周（GAP_A / GAP_A+GAP_B / GAP_B）----
  await insertSeal('seal-before-1', new Date('2026-10-12T00:00:00Z'), [GAP_A], [ART1, ART2]);
  await insertSeal('seal-before-2', new Date('2026-10-13T00:00:00Z'), [GAP_A], [ART1]);
  await insertSeal('seal-week-1', new Date('2026-10-20T00:00:00Z'), [GAP_A], [ART2, MISSING_HASH]);
  await insertSeal('seal-week-2', new Date('2026-10-21T00:00:00Z'), [GAP_A, GAP_B], [ART3]);
  await insertSeal('seal-week-3', new Date('2026-10-22T00:00:00Z'), [GAP_B], [CORRUPT_HASH]);

  // ---- events：本周 2 行，上周 1 行 ----
  for (const [id, created] of [
    ['evt-1', '2026-10-20T00:00:00Z'],
    ['evt-2', '2026-10-21T00:00:00Z'],
    ['evt-old', '2026-10-10T00:00:00Z'],
  ] as const) {
    await pool.query(
      `insert into events (event_id, subject, type, subtype, event_time, evidence_fact_id, created_at)
       values ($1, '600001', 'BUYBACK', null, $2, 'f-x', $3)`,
      [id, created, created],
    );
  }

  // ---- schedule_admission ----
  await pool.query(
    `insert into schedule_admission (admission_id, plan_id, queue_class, priority, subject_kind, subject, research_kind,
       cutoff, source, detected_at, trigger_event_ids, annotation, first_queued_at, started, sent, notes)
     values ('adm-1', 'plan-1', 'POST_EVENT_DEGRADED', 2, 'STOCK', '600001', 'POST_EVENT',
       $1, 'POST_EVENT_DEGRADED', null, '[]'::jsonb, null, $1, false, false, '[]'::jsonb)`,
    [new Date('2026-10-20T00:00:00Z')],
  );
  await pool.query(
    `insert into schedule_admission (admission_id, plan_id, queue_class, priority, subject_kind, subject, research_kind,
       cutoff, source, detected_at, trigger_event_ids, annotation, first_queued_at, started, sent, notes)
     values ('adm-2', 'plan-1', 'POST_EVENT', 0, 'STOCK', '600002', 'POST_EVENT',
       $1, 'DETECTION', $1, '[]'::jsonb, 'BLOCKED:MODEL_PROVIDER_UNAUTHORIZED', $1, false, false, '[]'::jsonb)`,
    [new Date('2026-10-21T00:00:00Z')],
  );
  await pool.query(
    `insert into schedule_admission (admission_id, plan_id, queue_class, priority, subject_kind, subject, research_kind,
       cutoff, source, detected_at, trigger_event_ids, annotation, first_queued_at, started, sent, notes)
     values ('adm-3', 'plan-1', 'WEEKLY_DEFERRED', 1, 'STOCK', '600003', 'WEEKLY',
       $1, 'WEEKLY_DEFERRED', null, '[]'::jsonb, null, $1, false, false, '[]'::jsonb),
       ('adm-4', 'plan-1', 'WEEKLY_DEFERRED', 1, 'STOCK', '600004', 'WEEKLY',
       $1, 'WEEKLY_DEFERRED', null, '[]'::jsonb, null, $1, false, false, '[]'::jsonb)`,
    [new Date('2026-10-22T00:00:00Z')],
  );
});

after(async () => {
  await pool.end().catch(() => {});
  await dropSchema(admin, schema);
  await admin.end();
  await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
});

test('SC-11.4 真实采集：permit 各态 / 按窗完成 / 缺口差 / 封存新增 / 准入面 / 抽查', async () => {
  const report = await collectProcessMetrics(pool, { weekStart: WEEK_START, weekEnd: WEEK_END, store });
  const { detail } = report;

  // permit 面（窗外行不计）
  assert.equal(detail.permits.total, 7);
  assert.equal(detail.permits.byState.SUCCEEDED, 5);
  assert.equal(detail.permits.byState.FAILED, 1);
  assert.equal(detail.permits.byState.UNKNOWN, 1);
  assert.equal(detail.permits.simulatedTrue, 6);
  assert.equal(detail.permits.simulatedFalse, 1);
  assert.equal(detail.permits.weeklyCalls, 5);
  assert.equal(detail.permits.postEventCalls, 2);
  assert.equal(detail.permits.researchKeys, 4);
  assert.equal(detail.permits.researchKeysOnWindowCompleted, 2);
  assert.equal(detail.permits.notOnWindow, 2);
  assert.equal(detail.permits.sendOnceRejections, null, 'send-once 拒绝库面不可观测 → null（不猜零）');

  // 周报端口字段映射
  assert.deepEqual(report.windowCompletion, { onWindowCompleted: 2, total: 4 });
  assert.equal(report.notOnWindow, 2);
  assert.equal(report.unknown, 1);
  assert.equal(report.paused, 0);
  assert.equal(report.blocked, 1);
  assert.equal(report.overflowDegraded, 1);
  assert.equal(report.weeklyModelCalls, 5);
  assert.equal(report.postEventModelCalls, 2);
  assert.equal(report.deferredBacklog, 2);
  assert.deepEqual(report.gapListPrevious, [GAP_A]);

  // 事件 / 封存 / 缺口
  assert.equal(detail.eventsDetected, 2);
  assert.equal(detail.sealsAdded, 3);
  assert.deepEqual(detail.gaps.addedThisWeek, [GAP_B]);

  // 完整性抽查：5 封存全抽 → 5 原件校验通过 + 1 缺失 + 1 损坏
  assert.ok(detail.integrity !== null);
  assert.equal(detail.integrity.checked, 5, `checked=${String(detail.integrity.checked)}`);
  assert.equal(detail.integrity.missing.length, 1);
  assert.equal(detail.integrity.missing[0]?.sha256, MISSING_HASH);
  assert.equal(detail.integrity.missing[0]?.label, 'seal-week-1');
  assert.equal(detail.integrity.corrupted.length, 1);
  assert.equal(detail.integrity.corrupted[0]?.sha256, CORRUPT_HASH);
  assert.equal(detail.integrity.corrupted[0]?.label, 'seal-week-3');

  // 诚实边界声明在场
  assert.ok(detail.honestyNotes.some((n) => n.includes('sendOnceRejections')));
});

test('refreshGapList：全部封存具名缺口去重并集（排序稳定）', async () => {
  const gaps = await refreshGapList(pool);
  assert.deepEqual(gaps, [GAP_A, GAP_B]);
});

test('checkArtifactIntegrity：抽样数生效、种子复现', async () => {
  const seals: IntegritySealSample[] = [
    { sealId: 's1', artifactSha256s: [ART1] },
    { sealId: 's2', artifactSha256s: [ART2] },
    { sealId: 's3', artifactSha256s: [MISSING_HASH] },
    { sealId: 's4', artifactSha256s: [ART1, ART2] },
    { sealId: 's5', artifactSha256s: [] },
    { sealId: 's6', artifactSha256s: [ART1] },
  ];
  const a = await checkArtifactIntegrity(store, seals, { sampleSize: 2, seed: 'seed-x' });
  const b = await checkArtifactIntegrity(store, seals, { sampleSize: 2, seed: 'seed-x' });
  assert.equal(a.checked, b.checked, '同种子同样本（复现）');
  assert.ok(a.checked <= 4);
  const full = await checkArtifactIntegrity(store, seals, { sampleSize: 6, seed: 's' });
  assert.equal(full.checked, 5); // ART1×2 + ART2×2 + MISSING 失败
  assert.equal(full.missing.length, 1);
  // 缺失样本种子（seed-y 抽到 s5 空封存）也可能 checked 更少——只断言不抛、形态合法
  const c = await checkArtifactIntegrity(store, seals, { sampleSize: 1, seed: 'seed-y' });
  assert.ok(c.checked <= 2);
});

test('weekWindowOfSaturday：周一 00:00+08 → 下周一 00:00+08；非周六具名拒绝', () => {
  assert.deepEqual(weekWindowOfSaturday('2026-10-24'), { weekStart: WEEK_START, weekEnd: WEEK_END });
  assert.throws(() => weekWindowOfSaturday('2026-10-23'), (e: unknown) => (e as { code?: string }).code === 'WEEKEND_NOT_SATURDAY');
});

test('窗口校验：倒置窗口具名拒绝', async () => {
  await assert.rejects(
    () => collectProcessMetrics(pool, { weekStart: WEEK_END, weekEnd: WEEK_START }),
    (e: unknown) => (e as { code?: string }).code === 'METRICS_WINDOW_INVALID',
  );
});
