/**
 * Lyra · 周末复盘真实接线单测（P3 W20: code-writer-pro）。
 * 模式申明：个股可结算结论与宽基结论的结算读 **public 真实事实**（factPool=admin：
 * 600519 全史行情 + 申万 2021 归属 801120 + 801120 全史指数行情 + 510050/000016 全史），
 * 结论对象落隔离 schema（不触 public.conclusion）；ANOMALY 用例按 W13 settle.test.ts
 * 既有模式在隔离 schema 合成最小事实（构造指数缺日——public 事实不可变，不可删日）。
 * 夹具结论不产生任何模型调用（直接构造 simulated A/J 输出——与本模块"零模型调用"
 * 断言一致，隔离 schema exec_permit 恒 0 行）。
 * 合同判定：SCHEDULING §3.4/§11（SC-11.1 零调用、SC-11.2 结算、SC-11.4 周报白名单）；
 * SR-2.4（未到期不提前结算）；RM §8（回填只写占位区，研究字段不可变）。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { loadTradeCalendarTable, type TradeCalendarTable } from '../adapters/calendar.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { researchCoreOf } from '../conclusion/object.js';
import type { ConclusionObject, Disposition, SubjectKind } from '../contracts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { persistConclusion, readConclusion } from '../db/conclusion.js';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import { deriveChecklist } from '../research/checklist.js';
import { simulatedModelA, simulatedModelJ } from '../research/simulated.js';
import { runWeekend, type DueConclusionView } from './weekend-runner.js';
import type { WeekendProcessMetrics } from './weekend.js';

const schema = `w20_wk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let isolated: Pool;
let calendar: TradeCalendarTable;

const SATURDAY = '2026-10-24'; // 真实周六（2026-10-25 为周日）
const ART = 'ab'.repeat(32);

const METRICS: WeekendProcessMetrics = {
  windowCompletion: { onWindowCompleted: 27, total: 30 },
  overflowDegraded: 2,
  notOnWindow: 1,
  unknown: 0,
  paused: 0,
  blocked: 1,
  weeklyModelCalls: 60,
  postEventModelCalls: 9,
  deferredBacklog: 3,
  gapListPrevious: ['gap:sw2014'],
};

// ===== 夹具：隔离 schema 结论（不产生 permit——与 SC-11.1 零调用一致）=====

interface FixtureInput {
  subjectKind: SubjectKind;
  subject: string;
  cutoff: string;
  seed: string;
}

/** 直接构造 simulated A/J（夹具构造路径，不经 runModelCall、零 permit）→ persistConclusion。 */
async function fixtureConclusion(input: FixtureInput): Promise<ConclusionObject> {
  const inputHash = createHash('sha256').update(`${input.seed}:a`).digest('hex');
  const a = simulatedModelA({
    inputHash,
    subjectKind: input.subjectKind,
    subject: input.subject,
    material: { artifactSha256s: [ART], factCount: 1 },
  });
  const manifestHash = createHash('sha256').update(`${input.seed}:manifest`).digest('hex');
  const checklist = deriveChecklist(a, manifestHash);
  const j = simulatedModelJ({ inputHash: canonicalSha256({ a, checklist }), subjectKind: input.subjectKind, aOutput: a, checklist });
  return persistConclusion(isolated, {
    businessKey: { subjectKind: input.subjectKind, subject: input.subject, researchKind: 'WEEKLY', cutoff: input.cutoff },
    methodVersion: 'method@p2-v1',
    adapterVersion: 'data@p1',
    planAuthVersion: 'pa-w20-weekend-test',
    aOutput: a,
    checklist,
    jOutput: j,
    manifest: { manifestHash },
    inheritance: null,
    changeReason: j.changedFromA ? j.changeReason : null,
  });
}

function dueView(c: ConclusionObject, conclusionTime: string): DueConclusionView {
  return {
    conclusionId: c.conclusionId,
    subjectKind: c.businessKey.subjectKind,
    subject: c.businessKey.subject,
    disposition: c.disposition as Disposition,
    conclusionTime,
    cutoff: c.businessKey.cutoff,
  };
}

// ===== 隔离 schema 合成事实（ANOMALY 用例；沿用 W13 settle.test.ts 模式）=====

function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  let day = start;
  while (out.length < n) {
    const dow = new Date(`${day}T00:00:00.00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day);
    day = nextDay(day);
  }
  return out;
}

const CAL = weekdays('2024-01-02', 30);

function shClose(day: string): string {
  return new Date(`${day}T15:00:00+08:00`).toISOString();
}

async function insertSyntheticFacts(): Promise<void> {
  for (const d of CAL) {
    await insertFact(isolated, {
      factId: `w20cal-${d}`,
      subjectType: 'RULE',
      subjectId: 'ashare-calendar',
      factKind: 'TRADE_CALENDAR',
      typedValue: { calendar_date: d, is_trading_day: '1' },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'test@w20',
    });
  }
  // 801999：缺 CAL[10] 一日的行业基准（构造 INDEX_BAR_MISSING，R26.3）
  for (const d of CAL.filter((x) => x !== CAL[10])) {
    await insertFact(isolated, {
      factId: `w20ix-${d}`,
      subjectType: 'INDEX',
      subjectId: '801999',
      factKind: 'SW_INDEX_BAR',
      typedValue: { 日期: d, 开盘: '1000', 收盘: '1000', swIndexCode: '801999' },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'sw@p1',
    });
  }
  // 600201：20 个有成交交易日（第 20 日 +20%）；第 10 日行业基准缺行情 → ANOMALY
  for (const [i, d] of CAL.slice(0, 20).entries()) {
    const close = i === 19 ? '120.00' : '100.00';
    await insertFact(isolated, {
      factId: `w20sb-${d}`,
      subjectType: 'STOCK',
      subjectId: '600201',
      factKind: 'DAILY_BAR',
      typedValue: {
        code: 'sh.600201', date: d,
        open: '100.00', high: close, low: '100.00', close, preclose: '100.00',
        volume: '1000', amount: '10000.0000', adjustflag: '3', tradestatus: '1', isST: '0',
      },
      validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
      firstObservedAt: '2023-12-31T00:00:00.000Z', availableAt: shClose(d),
      supersedesFactId: null, artifactSha256: ART, adapterVersion: 'baostock@0.9.40-p1',
    });
  }
  await insertFact(isolated, {
    factId: 'w20sw-600201-2021',
    subjectType: 'STOCK',
    subjectId: '600201',
    factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: {
      股票代码: '600201', 计入日期: 0, 行业代码: '340501', 更新日期: 0,
      计入日期ISO: '2021-07-30', 更新日期ISO: '2021-07-30 00:00:00', 体系: '2021', l1IndexCode: '801999',
    },
    validFrom: '2021-07-29T16:00:00.000Z', validTo: null,
    eventAt: '2021-07-29T16:00:00.000Z', sourcePublishedAt: '2021-07-29T16:00:00.000Z',
    firstObservedAt: '2026-10-25T00:00:00.000Z', availableAt: '2021-07-30T16:00:00.000Z',
    supersedesFactId: null, artifactSha256: ART, adapterVersion: 'sw@p1',
  });
}

before(async () => {
  await applySchema(admin, schema);
  isolated = createPool({ schema });
  calendar = await loadTradeCalendarTable(admin); // 真实交易日历（public，2015-01-05 → 2026-10-23）
  await insertSyntheticFacts();
});

after(async () => {
  await isolated.end().catch(() => {});
  await dropSchema(admin, schema);
  await admin.end();
});

test('SC-11.1/11.2/11.4 真实接线：已到期个股 + 宽基结论真实结算回填，研究字段不变，零模型调用', async () => {
  // 参考价锚点：窗口须在真实数据（尾=2026-10-23）内走完且避开真实数据缺口——
  // public 801120（申万食品饮料）缺 2026-10-15 一日行情（实测探明），窗口须结束于该日之前，
  // 否则个股结算按 R26.3 具名 INDEX_BAR_MISSING（ANOMALY 用例已由合成面覆盖）。
  const tds = calendar.tradingDays;
  const refIdx = tds.length - 32;
  const refDay = tds[refIdx] as string;
  const prevDay = tds[refIdx - 1] as string;
  const conclusionTime = new Date(`${prevDay}T20:00:00+08:00`).toISOString(); // 前一交易日收盘后完成
  const cutoff = new Date(`${prevDay}T18:00:00+08:00`).toISOString(); // 周度截点口径（18:00+08）

  const c1 = await fixtureConclusion({ subjectKind: 'STOCK', subject: '600519', cutoff, seed: 'w20-c1-600519' });
  const c2 = await fixtureConclusion({ subjectKind: 'BROAD_ETF', subject: '510050', cutoff, seed: 'w20-c2-510050' });
  const core1Before = canonicalJsonString(researchCoreOf(c1));
  const core2Before = canonicalJsonString(researchCoreOf(c2));
  assert.ok(new Date(conclusionTime).getTime() < new Date(`${refDay}T09:30:00+08:00`).getTime()); // 锚点自检：参考价日 = refDay

  const out = await runWeekend(
    {
      pool: isolated,
      factPool: admin, // 结算读 public 真实事实
      calendar,
      collectProcessMetrics: async () => METRICS,
    },
    { saturday: SATURDAY, conclusions: [dueView(c1, conclusionTime), dueView(c2, conclusionTime)] },
  );

  // §3.4 计划：周六触发、周五（2026-10-23）收盘截点
  assert.equal(out.plan.saturday, SATURDAY);
  assert.equal(out.plan.cutoffDay, '2026-10-23');
  assert.deepEqual(out.plan.steps, ['SETTLEMENT', 'ARTIFACT_INTEGRITY', 'GAP_LIST_REFRESH', 'WEEKLY_REPORT']);

  // 结算回填：个股 + 宽基均 SETTLED、占位区回填形态合规、研究字段不变
  assert.deepEqual(
    out.settlement.tally,
    { attempted: 2, settled: 2, anomaly: 0, unsettled: 0, skipped: 0 },
    `真实结算 tally：${JSON.stringify(out.settlement.tally)}`,
  );
  const [e1, e2] = out.settlement.entries;
  assert.equal(e1?.outcome, 'SETTLED');
  assert.equal(e1?.backfilled, 'SETTLED');
  assert.equal(e1?.settlement?.state, 'SETTLED');
  assert.match(e1?.settlement?.excessReturn ?? '', /^-?\d+(\.\d+)?$/, '超额收益为十进制定点字符串');
  assert.ok(
    e1?.settlement?.directionHit === null || typeof e1?.settlement?.directionHit === 'boolean',
    'directionHit 为 boolean 或 null（ABSTAIN 的 N/A）',
  );
  assert.equal(e1?.researchFieldsUnchanged, true);
  assert.equal(e2?.outcome, 'SETTLED');
  assert.equal(e2?.backfilled, 'SETTLED');
  assert.match(e2?.settlement?.excessReturn ?? '', /^-?\d+(\.\d+)?$/);
  assert.equal(e2?.researchFieldsUnchanged, true);

  // 读回复核（RM §8：回填只写占位区；研究字段与哈希不变）
  const r1 = await readConclusion(isolated, c1.conclusionId);
  const r2 = await readConclusion(isolated, c2.conclusionId);
  assert.ok(r1 && r2);
  assert.equal(r1.settlement.state, 'SETTLED');
  assert.equal(r2.settlement.state, 'SETTLED');
  assert.equal(canonicalJsonString(researchCoreOf(r1)), core1Before);
  assert.equal(canonicalJsonString(researchCoreOf(r2)), core2Before);
  assert.equal(r1.conclusionHash, c1.conclusionHash);
  assert.equal(r2.conclusionHash, c2.conclusionHash);
  assert.equal(r1.adoption, false);

  // SC-11.4 周报：白名单校验通过（runner 已内建校验），零效果评价字段
  assert.equal(out.report.reportKind, 'WEEKLY_PROCESS_REPORT');
  assert.equal(out.report.effectEvaluationFields, 'NONE');
  assert.equal(out.report.zeroModelCalls, true);
  // 缺口清单语义：未接 refreshGapList 端口 → 当前清单为空；delta = 前后差集（W17 口径）
  assert.deepEqual(out.report.gapListDelta, { added: [], resolved: ['gap:sw2014'] });
  for (const forbidden of ['hitRate', 'return', 'directionHit', 'excessReturn']) {
    assert.equal(forbidden in (out.report as unknown as Record<string, unknown>), false, `周报不得含效果类字段 ${forbidden}`);
  }

  // SC-11.1 零模型调用：permit 新增 0（隔离 schema exec_permit 全程 0 行）
  assert.equal(out.permitsCreatedDuringReview, 0);
  assert.equal(out.zeroModelCallsVerified, true);
  const permits = await isolated.query<{ n: string }>('select count(*)::text as n from exec_permit');
  assert.equal(permits.rows[0]?.n, '0');
});

test('SR-10.4/R26.3 ANOMALY 接线：指数窗口缺日 → 具名 INDEX_BAR_MISSING 回填，不冒充终态结算', async () => {
  const c3 = await fixtureConclusion({ subjectKind: 'STOCK', subject: '600201', cutoff: '2024-01-01T10:00:00.000Z', seed: 'w20-c3-600201' });
  const core3Before = canonicalJsonString(researchCoreOf(c3));
  const out = await runWeekend(
    {
      pool: isolated,
      factPool: isolated, // 合成事实（隔离 schema）：public 不可变，无法构造缺日
      calendar,
      collectProcessMetrics: async () => METRICS,
    },
    { saturday: SATURDAY, conclusions: [dueView(c3, '2024-01-01T20:00:00+08:00')] },
  );
  const e3 = out.settlement.entries[0];
  assert.equal(e3?.outcome, 'ANOMALY');
  assert.equal(e3?.code, 'INDEX_BAR_MISSING');
  assert.equal(e3?.backfilled, 'ANOMALY');
  assert.equal(out.settlement.tally.anomaly, 1);
  const r3 = await readConclusion(isolated, c3.conclusionId);
  assert.equal(r3?.settlement.state, 'ANOMALY');
  assert.equal(r3?.settlement.anomalyCode, 'INDEX_BAR_MISSING');
  assert.equal(canonicalJsonString(researchCoreOf(r3 as ConclusionObject)), core3Before, 'ANOMALY 回填同样不触碰研究字段');
});

test('SR-2.4 接线：结论太新（参考价日未到）→ UNSETTLED 不回填、占位区原样', async () => {
  // 结论完成于数据尾（2026-10-23）之后 → 无参考价日可用（真实事实尾=2026-10-23）
  const c4 = await fixtureConclusion({ subjectKind: 'STOCK', subject: '600519', cutoff: '2026-10-24T10:00:00.000Z', seed: 'w20-c4-notdue' });
  const out = await runWeekend(
    { pool: isolated, factPool: admin, calendar, collectProcessMetrics: async () => METRICS },
    { saturday: SATURDAY, conclusions: [dueView(c4, '2026-10-24T20:00:00+08:00')] },
  );
  const e4 = out.settlement.entries[0];
  assert.equal(e4?.outcome, 'UNSETTLED');
  assert.equal(e4?.code, 'REFERENCE_NOT_DUE');
  assert.equal(e4?.backfilled, null, '未到期不预测性回填（SR-2.4）');
  const r4 = await readConclusion(isolated, c4.conclusionId);
  assert.deepEqual(r4?.settlement, { state: 'UNSETTLED' });
});

test('防御接线：跨类 disposition / 结论缺失 → 具名跳过不猜；非周六具名拒绝', async () => {
  const cStock = await fixtureConclusion({ subjectKind: 'STOCK', subject: '600519', cutoff: '2026-09-30T10:00:00.000Z', seed: 'w20-c5-skip' });
  const crossClass: DueConclusionView = { ...dueView(cStock, '2026-09-29T20:00:00+08:00'), disposition: 'RESEARCH_UP' };
  const missing: DueConclusionView = {
    conclusionId: 'cc-nonexistent', subjectKind: 'STOCK', subject: '600519',
    disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2026-09-29T20:00:00+08:00', cutoff: '2026-09-30T10:00:00.000Z',
  };
  const out = await runWeekend(
    { pool: isolated, factPool: admin, calendar, collectProcessMetrics: async () => METRICS },
    { saturday: SATURDAY, conclusions: [crossClass, missing] },
  );
  assert.deepEqual(out.settlement.tally, { attempted: 0, settled: 0, anomaly: 0, unsettled: 0, skipped: 2 });
  assert.equal(out.settlement.entries[0]?.code, 'DISPOSITION_SPACE_INVALID');
  assert.equal(out.settlement.entries[1]?.code, 'CONCLUSION_MISSING');

  await assert.rejects(
    () => runWeekend(
      { pool: isolated, factPool: admin, calendar, collectProcessMetrics: async () => METRICS },
      { saturday: '2026-10-23', conclusions: [] }, // 周五非周六
    ),
    (e: unknown) => (e as { code?: string }).code === 'WEEKEND_NOT_SATURDAY',
  );
});

test('二次回填防御：已回填结论再入队列 → 具名跳过（占位区只回填一次语义可见）', async () => {
  const c6 = await fixtureConclusion({ subjectKind: 'STOCK', subject: '600519', cutoff: '2026-08-31T10:00:00.000Z', seed: 'w20-c6-twice' });
  const conclusionTime = '2026-08-31T20:00:00+08:00';
  await runWeekend(
    { pool: isolated, factPool: admin, calendar, collectProcessMetrics: async () => METRICS },
    { saturday: SATURDAY, conclusions: [dueView(c6, conclusionTime)] },
  );
  const after1 = await readConclusion(isolated, c6.conclusionId);
  assert.equal(after1?.settlement.state, 'SETTLED');
  const out2 = await runWeekend(
    { pool: isolated, factPool: admin, calendar, collectProcessMetrics: async () => METRICS },
    { saturday: SATURDAY, conclusions: [dueView(c6, conclusionTime)] }, // 同一结论再入队列
  );
  assert.equal(out2.settlement.entries[0]?.code, 'ALREADY_BACKFILLED');
  assert.equal(out2.settlement.entries[0]?.settlement?.state, 'SETTLED');
});
