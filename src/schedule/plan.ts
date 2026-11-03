/**
 * Lyra · 调度计划对象与持久化（P3 W17: code-writer-pro）。
 * 合同：docs/specs/SCHEDULING.md（SC-2 窗口常量、SC-6.1 容量常数、SC-8.1 预算基线、
 * SC-8.2 授权与计划身份分离——执行计划与授权版本轴独立版本化）；表结构
 * src/db/schedule-migration.sql（幂等，应用到 public）。
 *
 * 链路：计划（本模块）→ 准入队列（queue.ts）→ 执行由 kernel 层消费；调度不直接调模型、
 * 不调组装器。计划对象携带冻结常量快照（容量 4、窗口边界、预算基线、时钟容忍），
 * planHash = canonicalSha256(除 planHash 外全部字段)；同一 planAuthVersion 重复构建幂等。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import type { PlanAuthVersionId } from '../contracts.js';
import type { AdmissionRecord, QueueClass } from './queue.js';
import { POST_EVENT_BASELINE_PER_WEEK, QUEUE_PRIORITY, sortAdmissionQueue, WEEKLY_BASELINE_PER_WEEK } from './queue.js';
import { MORNING_JUDGE_TIME, MORNING_WINDOW_CAPACITY } from './overflow.js';
import type { PoolOrderSource, RotationTable } from './weekly.js';
import { rotationTableFromPool } from './weekly.js';
import {
  CLOCK_TOLERANCE_MS,
  POST_EVENT_DEADLINE,
  POST_EVENT_LATEST_START,
  WEEKLY_DEADLINE,
  WEEKLY_LATEST_START,
  WEEKLY_OPEN,
} from './windows.js';

export const SCHEDULER_VERSION = 'schedule@p3-w17-v1';

/** 计划对象具名错误。 */
export class SchedulePlanError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'SchedulePlanError';
  }
}

/** 计划携带的冻结常量快照（读回与合同文本一致性可断言，SC-8.2 证伪）。 */
export interface SchedulePlanWindows {
  postEventLatestStart: typeof POST_EVENT_LATEST_START;
  postEventDeadline: typeof POST_EVENT_DEADLINE;
  weeklyOpen: typeof WEEKLY_OPEN;
  weeklyLatestStart: typeof WEEKLY_LATEST_START;
  weeklyDeadline: typeof WEEKLY_DEADLINE;
  morningJudgeTime: typeof MORNING_JUDGE_TIME;
}

export interface SchedulePlan {
  planKind: 'SCHEDULE_PLAN';
  schedulerVersion: string;
  /** 执行计划与授权版本轴（独立版本化；新授权上限 → 新版本 → 新计划行，SC-8.2）。 */
  planAuthVersion: PlanAuthVersionId;
  poolVersion: string;
  capacityMorningWindow: typeof MORNING_WINDOW_CAPACITY;
  windows: SchedulePlanWindows;
  budget: {
    weeklyBaselinePerWeek: typeof WEEKLY_BASELINE_PER_WEEK;
    postEventBaselinePerWeek: typeof POST_EVENT_BASELINE_PER_WEEK;
    maxInFlight: 2;
  };
  clockToleranceMs: typeof CLOCK_TOLERANCE_MS;
  rotation: RotationTable;
  createdAt: string;
  planId: string;
  planHash: string;
}

/** 构建调度计划：轮转顺序表随池版本冻结（顺序 = data/research-pool.json 文件顺序）。 */
export function buildSchedulePlan(input: {
  planAuthVersion: PlanAuthVersionId;
  poolInfo: PoolOrderSource;
  createdAt?: string;
}): SchedulePlan {
  if (typeof input.planAuthVersion !== 'string' || input.planAuthVersion.length === 0) {
    throw new SchedulePlanError('PLAN_AUTH_VERSION_REQUIRED', 'planAuthVersion 为空（SC-8.2：计划身份显式版本化）');
  }
  const rotation = rotationTableFromPool(input.poolInfo);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const core: Omit<SchedulePlan, 'planHash'> = {
    planKind: 'SCHEDULE_PLAN' as const,
    schedulerVersion: SCHEDULER_VERSION,
    planAuthVersion: input.planAuthVersion,
    poolVersion: rotation.poolVersion,
    capacityMorningWindow: MORNING_WINDOW_CAPACITY,
    windows: {
      postEventLatestStart: POST_EVENT_LATEST_START,
      postEventDeadline: POST_EVENT_DEADLINE,
      weeklyOpen: WEEKLY_OPEN,
      weeklyLatestStart: WEEKLY_LATEST_START,
      weeklyDeadline: WEEKLY_DEADLINE,
      morningJudgeTime: MORNING_JUDGE_TIME,
    },
    budget: {
      weeklyBaselinePerWeek: WEEKLY_BASELINE_PER_WEEK,
      postEventBaselinePerWeek: POST_EVENT_BASELINE_PER_WEEK,
      maxInFlight: 2 as const,
    },
    clockToleranceMs: CLOCK_TOLERANCE_MS,
    rotation,
    createdAt,
    planId: `plan:${input.planAuthVersion}:${rotation.poolVersion}`,
  };
  return { ...core, planHash: canonicalSha256(core) };
}

/** 计划哈希复核（读回一致性）。 */
export function verifySchedulePlan(plan: SchedulePlan): boolean {
  const { planHash, ...core } = plan;
  return canonicalSha256(core) === planHash;
}

// ===== 持久化 =====

const MIGRATION_URL = new URL('../db/schedule-migration.sql', import.meta.url);

/** 应用调度表迁移（幂等；调用方决定 schema——派发要求 public，即默认 search_path）。 */
export async function applyScheduleMigration(pool: Pool): Promise<void> {
  const sql = await readFile(fileURLToPath(MIGRATION_URL), 'utf8');
  await pool.query(sql);
}

interface PlanRow {
  plan_id: string;
  plan_auth_version: string;
  pool_version: string;
  capacity_morning: number;
  plan_hash: string;
  body: SchedulePlan;
  created_at: Date;
}

/** 落计划（只追加：同 plan_id 幂等跳过，不更新——版本轴纪律）。 */
export async function persistSchedulePlan(pool: Pool, plan: SchedulePlan): Promise<{ inserted: boolean }> {
  const r = await pool.query(
    `insert into schedule_plan (plan_id, plan_auth_version, pool_version, capacity_morning, plan_hash, body)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (plan_id) do nothing`,
    [plan.planId, plan.planAuthVersion, plan.poolVersion, plan.capacityMorningWindow, plan.planHash, JSON.stringify(plan)],
  );
  return { inserted: (r.rowCount ?? 0) > 0 };
}

/** 读回最新计划（created_at 最大者）；无计划返回 null。 */
export async function loadLatestSchedulePlan(pool: Pool): Promise<SchedulePlan | null> {
  const res = await pool.query<PlanRow>(
    `select * from schedule_plan order by created_at desc, plan_id desc limit 1`,
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  const plan = row.body;
  if (!verifySchedulePlan(plan)) {
    throw new SchedulePlanError('PLAN_HASH_MISMATCH', `plan_id=${row.plan_id} 读回哈希不一致`);
  }
  return plan;
}

export interface AdmissionRow {
  admissionId: string;
  planId: string;
  queueClass: QueueClass;
  priority: number;
  subjectKind: string;
  subject: string;
  researchKind: string;
  cutoff: string;
  source: string;
  detectedAt: string | null;
  triggerEventIds: string[];
  annotation: string | null;
  firstQueuedAt: string;
  started: boolean;
  sent: boolean;
  notes: string[];
}

/** 批量落准入记录（同 (plan_id, admission_id) 幂等跳过）。 */
export async function persistAdmissions(
  pool: Pool,
  planId: string,
  records: readonly AdmissionRecord[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const r of records) {
    const res = await pool.query(
      `insert into schedule_admission (admission_id, plan_id, queue_class, priority, subject_kind, subject,
         research_kind, cutoff, source, detected_at, trigger_event_ids, annotation, first_queued_at, started, sent, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb)
       on conflict (plan_id, admission_id) do nothing`,
      [
        r.admissionId, planId, r.queueClass, QUEUE_PRIORITY[r.queueClass], r.subjectKind, r.subject,
        r.researchKind, r.cutoff, r.source, r.detectedAt, JSON.stringify(r.triggerEventIds), r.annotation,
        r.firstQueuedAt, r.started, r.sent, JSON.stringify(r.notes),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return { inserted };
}

interface AdmissionDbRow {
  admission_id: string;
  plan_id: string;
  queue_class: QueueClass;
  priority: number;
  subject_kind: string;
  subject: string;
  research_kind: string;
  cutoff: Date;
  source: string;
  detected_at: Date | null;
  trigger_event_ids: string[];
  annotation: string | null;
  first_queued_at: Date;
  started: boolean;
  sent: boolean;
  notes: string[];
}

/** 读回准入记录（可按计划过滤；时间统一 ISO 读回）。 */
export async function loadAdmissions(pool: Pool, filter?: { planId?: string }): Promise<AdmissionRow[]> {
  const res = filter?.planId === undefined
    ? await pool.query<AdmissionDbRow>(`select * from schedule_admission order by plan_id, priority, first_queued_at, admission_id`)
    : await pool.query<AdmissionDbRow>(
        `select * from schedule_admission where plan_id = $1 order by priority, first_queued_at, admission_id`,
        [filter.planId],
      );
  return res.rows.map((r) => ({
    admissionId: r.admission_id,
    planId: r.plan_id,
    queueClass: r.queue_class,
    priority: r.priority,
    subjectKind: r.subject_kind,
    subject: r.subject,
    researchKind: r.research_kind,
    cutoff: r.cutoff.toISOString(),
    source: r.source,
    detectedAt: r.detected_at === null ? null : r.detected_at.toISOString(),
    triggerEventIds: r.trigger_event_ids,
    annotation: r.annotation,
    firstQueuedAt: r.first_queued_at.toISOString(),
    started: r.started,
    sent: r.sent,
    notes: r.notes,
  }));
}

/** 计划 → 准入队列物化（SC-5.1 固定序；执行由 kernel 层消费）。 */
export function materializeEveningQueue(records: readonly AdmissionRecord[]): AdmissionRecord[] {
  return sortAdmissionQueue(records);
}
