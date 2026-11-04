import { researchJInputHash } from './validation.js';
import { researchMaterial } from './requests.js';
/**
 * Lyra · 事件后研究编排器单测（P3 W20: code-writer-pro）。DB 用例走 public 真实事实 +
 * 真实事件（public.events），执行与结论落隔离 schema；无网络。
 * 合同判定：SCHEDULING §3.2/3.3（截点=公告发布时刻、启动闸）、§7 SC-7.1（准入时继承声明）；
 * RESEARCH-METHOD §7/§8（INHERITED 先验是模型判断非事实、只重新评估新公告、维持也写桥接；
 * STANDALONE 标注原文；结算占位区初始 UNSETTLED）。
 * 重放口径申明：真实事件均为历史时刻，窗口截止早于真实时钟，内核发送前截止闸会按合同具名
 * 拒绝 DEADLINE_EXCEEDED；测试按 post-event.ts 的显式 deadline 重放口径传入近未来截止
 * （EK-6.1 禁止的是从模板隐式继承，显式给定并落 permit 可审计）。每次运行向 public.seal_manifest（W26 幂等后仅材料变化新增行）
 * 追加真实封存、向生产 CAS 写输入包原件（不可变数据，与 P2 旅程同一模式，如实申明）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { loadTradeCalendarTable } from '../adapters/calendar.js';
import type { AOutput, ConclusionObject, JOutput, PlanAuthBudget } from '../contracts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { readConclusion } from '../db/conclusion.js';
import { persistResearchConclusion } from './trace.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createPool } from '../db/pool.js';
import { runModelCall } from '../kernel/executor.js';
import { acquireExecutorLock, releaseExecutorLock } from '../kernel/lock.js';
import { findPermitByBusinessKey } from '../kernel/permit.js';
import { selectTransport } from '../kernel/transport.js';
import { deriveChecklist } from './checklist.js';
import { assembleResearchInput } from './inputs.js';
import { runPostEventResearch, type PostEventTriggerEvent } from './post-event.js';

const HOLDER = `w20-pe-${randomUUID()}`;
const schema = `w20_pe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let isolated: Pool;
const store = new ArtifactStore('data/artifacts');
const transport = selectTransport({ provider: 'simulated' });

const BUDGET: PlanAuthBudget = {
  planAuthVersion: 'pa-w20-post-event-test',
  maxModelCallsPerWeek: 20,
  maxInputBytes: 5_000_000,
  maxInFlight: 2,
};
const VERSIONS = { methodVersion: 'method@p2-v1', adapterVersion: 'data@p1' };
/** 重放截止：真实事件的窗口截止（历史时刻）早于真实时钟，显式传入近未来截止使全链可重放。 */
const REPLAY_DEADLINE_MS = 120_000;

before(async () => {
  await applySchema(admin, schema);
  isolated = createPool({ schema });
  await acquireExecutorLock(isolated, HOLDER);
});

after(async () => {
  try {
    await releaseExecutorLock(isolated, HOLDER);
  } catch {
    /* 已释放 */
  }
  await isolated.end().catch(() => {});
  await dropSchema(admin, schema);
  await admin.end();
});

interface EventRow {
  event_id: string;
  subject: string;
  type: string;
  subtype: string | null;
  event_time: Date;
  evidence_fact_id: string;
}

/** 从 public.events 取一例真实事件（重放确定性：按 subject+type+event_time 唯一命中）。 */
async function loadRealEvent(subject: string, type: string, eventTimeIso: string): Promise<PostEventTriggerEvent> {
  const r = await admin.query<EventRow>(
    `select event_id, subject, type, subtype, event_time, evidence_fact_id
     from events where subject = $1 and type = $2 and event_time = $3::timestamptz limit 1`,
    [subject, type, eventTimeIso],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error(`public.events 无该真实事件：${subject}/${type}@${eventTimeIso}`);
  return {
    eventId: row.event_id,
    subject: row.subject,
    type: row.type,
    subtype: row.subtype,
    eventTime: row.event_time.toISOString(),
    evidenceFactId: row.evidence_fact_id,
  };
}

/** 造一条真实链 STANDALONE 周度结论作先验（真实材料组装 + permit 全程 A/J + 落库）。 */
async function buildWeeklyPrior(cutoff: string): Promise<ConclusionObject> {
  const subject = '600519';
  const businessKey = {
    subjectKind: 'STOCK' as const,
    subject,
    researchKind: 'WEEKLY' as const,
    cutoff,
  };
  const assembled = await assembleResearchInput(admin, store, {
    subjectKind: 'STOCK',
    subject,
    cutoff,
    budget: { l0Bytes: 20_000, l1Bytes: 140_000, l2Bytes: 160_000, totalBytes: 300_000 },
    versions: { ...VERSIONS, planAuthVersion: BUDGET.planAuthVersion },
  });
  const deadline = new Date(Date.now() + REPLAY_DEADLINE_MS).toISOString();
  const material = researchMaterial(assembled.package);
  const a = await runModelCall<AOutput>(isolated, {
    contract: {
      businessKey,
      stage: 'A',
      inputHash: assembled.inputHash,
      inputBytes: assembled.inputBytes,
      methodVersion: VERSIONS.methodVersion,
      planAuthVersion: BUDGET.planAuthVersion,
      deadline,
    },
    budget: BUDGET,
    modelFn: async (ctx) =>
      (await transport.dispatch(ctx.contract, { inputHash: assembled.inputHash, subjectKind: 'STOCK', subject, material })) as AOutput,
    simulated: true,
    holderId: HOLDER,
  });
  const checklist = deriveChecklist(a.output, assembled.package.seals[0]!.manifestHash);
  const jInputHash = researchJInputHash(assembled.package, a.output, checklist);
  const j = await runModelCall<JOutput>(isolated, {
    contract: {
      businessKey,
      stage: 'J',
      inputHash: jInputHash,
      inputBytes: assembled.inputBytes,
      methodVersion: VERSIONS.methodVersion,
      planAuthVersion: BUDGET.planAuthVersion,
      deadline,
    },
    budget: BUDGET,
    modelFn: async (ctx) =>
      (await transport.dispatch(ctx.contract, { inputHash: jInputHash, subjectKind: 'STOCK', aOutput: a.output, checklist })) as JOutput,
    simulated: true,
    holderId: HOLDER,
  });
  const prior = await persistResearchConclusion(isolated, store, {
    businessKey,
    methodVersion: VERSIONS.methodVersion,
    adapterVersion: VERSIONS.adapterVersion,
    planAuthVersion: BUDGET.planAuthVersion,
    aOutput: a.output,
    checklist,
    jOutput: j.output,
    manifest: assembled.package.seals[0]!,
    researchInput: assembled.package,
    inheritance: null,
    changeReason: j.output.changedFromA ? j.output.changeReason : null,
  });
  // 隔离夹具的历史完成时钟，非业务结论回写；资格必须使用原行而非调用者自报时间。
  const completed = new Date(Date.parse(cutoff) + 60_000).toISOString();
  await isolated.query('update conclusion set created_at = $1 where conclusion_id = $2', [completed, prior.conclusionId]);
  return (await readConclusion(isolated, prior.conclusionId))!;
}

/** 第一条测试产出的真实周度先验（顺序测试共享，供资格破坏用例复用）。 */
let priorWeekly: ConclusionObject | null = null;

test('SC-7.1 + RM §7 INHERITED 全链：真实事件（600519 业绩预告 2018-02-01）继承本周周度结论', async () => {
  const calendar = await loadTradeCalendarTable(admin);
  const event = await loadRealEvent('600519', 'EARNINGS_FORECAST', '2018-02-01T00:00:00.000Z');
  // 先验：本周（2018-01-31 周三晚）完成的 STANDALONE 周度结论（真实材料全链）
  const prior = await buildWeeklyPrior('2018-01-31T10:00:00.000Z');
  priorWeekly = prior;
  assert.equal(prior.businessKey.researchKind, 'WEEKLY');
  assert.equal(prior.standaloneNote, '无基础结论可继承');

  const replayDeadline = new Date(Date.now() + REPLAY_DEADLINE_MS).toISOString();
  const outcome = await runPostEventResearch(
    { dataPool: admin, execPool: isolated, store, transport, calendar },
    {
      event,
      inheritance: { priorConclusion: prior },
      budget: BUDGET,
      holderId: HOLDER,
      versions: VERSIONS,
      now: new Date('2018-02-01T00:30:00.000Z'), // 检测命中后即时启动（SC-3.3）
      deadline: replayDeadline, // 历史事件重放截止（显式、落 permit 可审计）
    },
  );

  // 继承声明与资格（SC-7.1 判定时机=准入时刻；RM §7.1 资格全过）
  assert.deepEqual(outcome.eligibility, { eligible: true });
  assert.equal(outcome.declaration.basis, 'INHERITED');
  assert.equal(outcome.declaration.fromConclusionId, prior.conclusionId);
  assert.equal(outcome.declaration.fromConclusionHash, prior.conclusionHash);

  // 准入记录（SC-3.2：截点=公告发布时刻；触发引用=[eventId]）
  assert.equal(outcome.admission.queueClass, 'POST_EVENT');
  assert.equal(outcome.admission.cutoff, '2018-02-01T00:00:00.000Z');
  assert.deepEqual(outcome.admission.triggerEventIds, [event.eventId]);
  assert.equal(outcome.admission.researchKind, 'POST_EVENT');

  // 窗口（SC-3.3：次日=下一交易日 2018-02-02，09:15 截止 = 01:15Z）
  assert.equal(outcome.window.nextTradingDay, '2018-02-02');
  assert.equal(outcome.window.deadline, '2018-02-02T01:15:00.000Z');

  // 组装：POST_EVENT 业务键被 W11 组装器接受（无缺口）、截点=事件 availableAt
  assert.equal(outcome.package.businessKey.researchKind, 'POST_EVENT');
  assert.equal(outcome.package.businessKey.subject, '600519');
  assert.equal(outcome.package.businessKey.cutoff, '2018-02-01T00:00:00.000Z');

  // 结论对象：继承指针 + 改判理由（维持也写桥接；三要素）+ 占位区初始 UNSETTLED
  const c = outcome.conclusion;
  assert.equal(c.businessKey.researchKind, 'POST_EVENT');
  assert.equal(c.businessKey.cutoff, '2018-02-01T00:00:00.000Z');
  assert.deepEqual(c.inheritance, { fromConclusionId: prior.conclusionId, fromConclusionHash: prior.conclusionHash });
  assert.equal(c.standaloneNote, null);
  assert.ok((c.changeReason ?? '').includes('先验模型判断'), '桥接：先验是先验模型判断非当前事实');
  assert.ok((c.changeReason ?? '').includes('只重新评估新公告'), '桥接：只重新评估新公告');
  assert.ok((c.changeReason ?? '').includes(event.eventId), '桥接：触发事件引用');
  assert.ok(['RESEARCH_OUTPERFORM', 'RESEARCH_UNDERPERFORM', 'ABSTAIN'].includes(c.disposition));
  assert.equal(c.adoption, false);
  assert.deepEqual(c.settlement, { state: 'UNSETTLED' });
  for (const h of [c.evidence.aOutputHash, c.evidence.checklistHash, c.evidence.jOutputHash, c.evidence.manifestHash]) {
    assert.match(h, /^[a-f0-9]{64}$/);
  }
  // 落库读回（隔离 schema）全等
  const readBack = await readConclusion(isolated, c.conclusionId);
  assert.equal(readBack?.conclusionHash, c.conclusionHash);
  assert.deepEqual(readBack?.inheritance, c.inheritance);

  // permit：A/J 恰两次、全 SUCCEEDED、研究类型 POST_EVENT、截止=显式重放截止（可审计）
  const businessKey = { subjectKind: 'STOCK' as const, subject: '600519', researchKind: 'POST_EVENT' as const, cutoff: '2018-02-01T00:00:00.000Z' };
  const pa = await findPermitByBusinessKey(isolated, { businessKey, stage: 'A' });
  const pj = await findPermitByBusinessKey(isolated, { businessKey, stage: 'J' });
  assert.equal(pa?.state, 'SUCCEEDED');
  assert.equal(pj?.state, 'SUCCEEDED');
  assert.equal(pa?.simulated, true);
  assert.equal(pa?.contract.deadline, replayDeadline, 'permit 截止 = 显式重放截止（EK-6.1 显式给定，非模板继承）');
  assert.equal(pa?.contract.inputHash, outcome.inputHash);
});

test('SC-7.1 STANDALONE 全链：真实事件（600519 增速变化 2017-10-26）无先验 → 标注原文、继承指针 null', async () => {
  const calendar = await loadTradeCalendarTable(admin);
  const event = await loadRealEvent('600519', 'PERIOD_GROWTH_DELTA', '2017-10-26T16:00:00.000Z');
  const outcome = await runPostEventResearch(
    { dataPool: admin, execPool: isolated, store, transport, calendar },
    {
      event,
      inheritance: null,
      budget: BUDGET,
      holderId: HOLDER,
      versions: VERSIONS,
      now: new Date('2017-10-26T16:30:00.000Z'),
      deadline: new Date(Date.now() + REPLAY_DEADLINE_MS).toISOString(),
    },
  );
  assert.deepEqual(outcome.declaration, { basis: 'STANDALONE', standaloneNote: '无基础结论可继承' });
  assert.equal(outcome.conclusion.inheritance, null);
  assert.match(outcome.conclusion.standaloneNote ?? '', /^完整重研：/);
  // STANDALONE 非重试：changeReason 仅在 J 改判 A 候选时由 J 提供（RM §8 配对）
  if (outcome.conclusion.changeReason !== null) {
    assert.ok((outcome.conclusion.changeReason ?? '').length > 0);
  }
  assert.equal(outcome.conclusion.businessKey.cutoff, '2017-10-26T16:00:00.000Z'); // 截点=事件时点
  assert.equal(outcome.conclusion.businessKey.researchKind, 'POST_EVENT');
  // 周末锚点非交易日链路：事件上海日 2017-10-27（周五）→ 次日=下一交易日 2017-10-30（周一）
  assert.equal(outcome.window.nextTradingDay, '2017-10-30');
  assert.equal(outcome.window.deadline, '2017-10-30T01:15:00.000Z');
});

test('RM §7.1 继承资格不满足（方法版本不兼容）→ 不继承，落 STANDALONE（不猜）', async () => {
  const calendar = await loadTradeCalendarTable(admin);
  const event = await loadRealEvent('600519', 'HOLDER_TRADE', '2018-09-03T00:00:00.000Z');
  assert.ok(priorWeekly !== null, '前置：第一条测试的真实周度先验在库');
  const realPrior = priorWeekly;

  const outcome = await runPostEventResearch(
    { dataPool: admin, execPool: isolated, store, transport, calendar },
    {
      event,
      inheritance: { priorConclusion: realPrior },
      budget: BUDGET,
      holderId: HOLDER,
      versions: { methodVersion: 'method@p2-v2-20261103', adapterVersion: VERSIONS.adapterVersion }, // 资格破坏：方法版本不兼容
      now: new Date('2018-09-03T01:00:00.000Z'),
      deadline: new Date(Date.now() + REPLAY_DEADLINE_MS).toISOString(),
    },
  );
  assert.equal(outcome.eligibility.eligible, false);
  if (!outcome.eligibility.eligible) assert.match(outcome.eligibility.reason, /方法版本/);
  assert.equal(outcome.declaration.basis, 'STANDALONE'); // 不满足任一条即不继承（RM §7.1）
  assert.equal(outcome.conclusion.inheritance, null);
  assert.match(outcome.conclusion.standaloneNote ?? '', /^完整重研：/);
});

test('SC-3.3 启动闸：次日 08:00 后新启动具名拒绝 POST_EVENT_START_LATE（零 permit、零组装）', async () => {
  const calendar = await loadTradeCalendarTable(admin);
  const event = await loadRealEvent('600519', 'HOLDER_TRADE', '2018-09-28T00:00:00.000Z');
  await assert.rejects(
    () =>
      runPostEventResearch(
        { dataPool: admin, execPool: isolated, store, transport, calendar },
        {
          event,
          inheritance: null,
          budget: BUDGET,
          holderId: HOLDER,
          versions: VERSIONS,
          now: new Date('2018-10-08T01:00:00.000Z'), // 晚于 latestStart 2018-10-08T00:00Z（国庆顺延后的次日 08:00）
        },
      ),
    (e: unknown) => (e as { code?: string }).code === 'POST_EVENT_START_LATE',
  );
  const permits = await isolated.query<{ n: string }>(
    `select count(*)::text as n from exec_permit where research_kind = 'POST_EVENT' and cutoff = '2018-09-28T00:00:00.000Z'`,
  );
  assert.equal(permits.rows[0]?.n, '0', '被拒事件不产生任何 permit');
});
