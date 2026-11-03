/**
 * Lyra · 调度计划对象单测（P3 W17: code-writer-pro）。纯函数部分；持久化函数
 * （applyScheduleMigration 与 persist、load 系）需 DB，不在单测面（旅程测试与验收覆盖，登记于回传）。
 * 合同判定：SCHEDULING.md SC-2（窗口常量快照）、SC-6.1（容量常数随计划携带）、
 * SC-8.1（预算基线）、SC-8.2（授权与计划身份分离：版本轴独立、改授权不牵连窗口与容量）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdmissionRecord } from './queue.js';
import { admissionIdOf, admitPostEvent } from './queue.js';
import { buildSchedulePlan, materializeEveningQueue, verifySchedulePlan } from './plan.js';
import { shanghaiInstant } from './windows.js';

const STOCKS = ['603986', '002384', '600176', '600183', '000938', '603259', '601899', '600522', '002281', '000977',
  '600105', '000988', '600519', '000657', '002407', '002008', '601318', '603993', '600276', '600150',
  '002851', '603019', '600036', '600900', '603256', '600030'];
const ETFS = ['510050', '510300', '510500', '512100'];
const POOL = { frozenAt: '2026-10-25', stocks: STOCKS.map((code) => ({ code })), etfs: ETFS.map((code) => ({ code })) };

const CREATED = '2026-10-25T12:00:00.000Z';

test('计划对象携带冻结常量快照（SC-2/6.1/8.1/10.3）', () => {
  const plan = buildSchedulePlan({ planAuthVersion: 'auth-v1', poolInfo: POOL, createdAt: CREATED });
  assert.equal(plan.planKind, 'SCHEDULE_PLAN');
  assert.equal(plan.planId, 'plan:auth-v1:2026-10-25');
  assert.equal(plan.poolVersion, '2026-10-25'); // 轮转顺序表随池版本冻结
  assert.equal(plan.capacityMorningWindow, 4);
  assert.deepEqual(plan.windows, {
    postEventLatestStart: '08:00:00',
    postEventDeadline: '09:15:00',
    weeklyOpen: '18:00:00',
    weeklyLatestStart: '22:00:00',
    weeklyDeadline: '23:30:00',
    morningJudgeTime: '08:00:00',
  });
  assert.deepEqual(plan.budget, { weeklyBaselinePerWeek: 60, postEventBaselinePerWeek: 10, maxInFlight: 2 });
  assert.equal(plan.clockToleranceMs, 60_000);
  assert.equal(plan.rotation.order.length, 30);
});

test('planAuthVersion 缺失具名拒绝（SC-8.2 计划身份显式版本化）', () => {
  assert.throws(
    () => buildSchedulePlan({ planAuthVersion: '', poolInfo: POOL, createdAt: CREATED }),
    (e: unknown) => e instanceof Error && e.message.includes('PLAN_AUTH_VERSION_REQUIRED'),
  );
});

test('计划哈希：同一输入幂等（同哈希）；篡改任一字段即失配', () => {
  const a = buildSchedulePlan({ planAuthVersion: 'auth-v1', poolInfo: POOL, createdAt: CREATED });
  const b = buildSchedulePlan({ planAuthVersion: 'auth-v1', poolInfo: POOL, createdAt: CREATED });
  assert.equal(a.planHash, b.planHash);
  assert.equal(verifySchedulePlan(a), true);
  const tampered = { ...a, capacityMorningWindow: 5 as 4 };
  assert.equal(verifySchedulePlan(tampered), false);
  const tamperedWindow = { ...a, windows: { ...a.windows, postEventDeadline: '09:30:00' as typeof a.windows.postEventDeadline } };
  assert.equal(verifySchedulePlan(tamperedWindow), false);
});

test('SC-8.2 证伪：新授权版本产生新计划身份，容量常数与窗口读回不变（版本轴互不牵连）', () => {
  const v1 = buildSchedulePlan({ planAuthVersion: 'auth-v1', poolInfo: POOL, createdAt: CREATED });
  const v2 = buildSchedulePlan({ planAuthVersion: 'auth-v2-finalseason', poolInfo: POOL, createdAt: CREATED });
  assert.notEqual(v1.planId, v2.planId);
  assert.notEqual(v1.planHash, v2.planHash);
  assert.equal(v2.capacityMorningWindow, v1.capacityMorningWindow); // 容量常数 4 不变
  assert.deepEqual(v2.windows, v1.windows); // 窗口读回不变
  assert.deepEqual(v2.budget, v1.budget); // 基线不变（上限数值由授权文件冻结，不在计划快照里浮动）
});

test('materializeEveningQueue：计划 → 准入队列按 SC-5.1 固定序（执行由 kernel 消费）', () => {
  const cutoff = shanghaiInstant('2026-10-12', '18:30:00').toISOString();
  const post = admitPostEvent({ subject: '603986', subjectKind: 'STOCK', publishedAt: shanghaiInstant('2026-10-09', '20:00:00').toISOString(), detectedAt: shanghaiInstant('2026-10-09', '20:00:00').toISOString(), triggerEventIds: ['evt:1'] }, cutoff);
  const rotation: AdmissionRecord = {
    admissionId: admissionIdOf('WEEKLY_ROTATION', 'STOCK', '600183', cutoff),
    queueClass: 'WEEKLY_ROTATION', subjectKind: 'STOCK', subject: '600183', researchKind: 'WEEKLY',
    cutoff, firstQueuedAt: cutoff, detectedAt: null, triggerEventIds: [], annotation: null,
    source: 'WEEKLY_ROTATION', started: false, sent: false, notes: [],
  };
  const deferred: AdmissionRecord = { ...rotation, subject: '600176', admissionId: admissionIdOf('WEEKLY_DEFERRED', 'STOCK', '600176', cutoff), queueClass: 'WEEKLY_DEFERRED', source: 'WEEKLY_DEFERRED' };
  const queue = materializeEveningQueue([rotation, deferred, post]);
  assert.deepEqual(queue.map((e) => e.queueClass), ['POST_EVENT', 'WEEKLY_DEFERRED', 'WEEKLY_ROTATION']);
});
