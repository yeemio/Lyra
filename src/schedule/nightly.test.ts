import { syntheticConclusionInput } from '../research/research-test-helper.js';
/**
 * Lyra · 晚间研究循环骨架单测（P5 准备 W27: code-writer-pro）。
 * 隔离 schema + 临时原件目录 + 合成池（26+4 满轮转）+ 合成日历（未来交易日，commit 可在窗）。
 * 公共库只读：一切写入（事实 / 封存 / permit / 结论 / 调度表 / 事件）落隔离 schema。
 * 覆盖：轮转取 6 只 + 事件合并（SC-3.2）+ 池外跳过；dry 零 permit 零结论；
 * commit 落库且 pa-p5-skeleton 身份可查；transport=real 在任何计划/permit 前具名拒绝；
 * 非交易日 / commit 截止已过具名拒绝；settle-due 到期回填。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import type { TradeCalendarTable } from '../adapters/calendar.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { persistConclusion, readConclusion } from '../db/conclusion.js';
import { readExecutorLock } from '../kernel/lock.js';
import { insertFact } from '../pintime/facts.js';
import { validatePostEventContext } from '../research/inheritance.js';
import type { ResearchTrace } from '../research/validation.js';
import { runNightly, SKELETON_PLAN_AUTH_VERSION, type NightlyEntryResult } from './nightly.js';

const schema = `w27_n_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = createPool();
let pool: Pool;
let store: ArtifactStore;
let artifactDir: string;
let poolInfoFile: string;
let calendar: TradeCalendarTable;

// 合成日历只含工作日；全部日期相对本次运行选定的未来周一。
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (d <= end) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  return out;
}

function nextMonday(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
  return day.toISOString().slice(0, 10);
}

// opts.now 只影响排程；内核/PG 仍用真实时钟，因此每次选严格未来的周一。
const DATE = nextMonday(new Date()); // nth=1 → 轮转桶 1 = 600101..600106
function fixtureDay(offset: number): string {
  return new Date(Date.parse(`${DATE}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}
const NOW_EVENING = new Date(`${DATE}T13:00:00Z`); // 21:00+08（事件后、23:30 截止前）
const CUTOFF_EVENING = `${DATE}T10:00:00.000Z`; // 18:00+08 排程时刻（确定性截点）
const EVENT_CUTOFF = `${DATE}T12:30:00.000Z`;
const eventFactIds = new Map<string, string>();

function shanghaiClose(day: string): string {
  return new Date(`${day}T15:00:00+08:00`).toISOString();
}

let factSeq = 0;
async function addFact(base: {
  subjectType: 'STOCK' | 'ETF' | 'INDEX' | 'RULE';
  subjectId: string;
  factKind: string;
  typedValue: Record<string, unknown>;
  availableAt: string;
  validFrom?: string | null;
  eventAt?: string;
  sourcePublishedAt?: string;
}): Promise<string> {
  factSeq += 1;
  const factId = `w27n-${String(factSeq)}`;
  const ref = await store.put(new TextEncoder().encode(JSON.stringify({ factId, ...base })), 'application/json', base.availableAt);
  await insertFact(pool, {
    factId,
    subjectType: base.subjectType,
    subjectId: base.subjectId,
    factKind: base.factKind,
    typedValue: base.typedValue,
    validFrom: base.validFrom ?? null,
    validTo: null,
    eventAt: base.eventAt ?? null,
    sourcePublishedAt: base.sourcePublishedAt ?? null,
    firstObservedAt: base.availableAt,
    availableAt: base.availableAt,
    supersedesFactId: null,
    artifactSha256: ref.sha256,
    adapterVersion: 'test@w27',
  });
  return factId;
}

const bar = (code: string, date: string, close = '100.00'): Record<string, unknown> => ({
  code, date, open: close, high: close, low: close, close, preclose: close,
  volume: '1000', amount: '10000.0000', adjustflag: '3', tradestatus: '1', isST: '0',
});

async function countOf(table: string, where = ''): Promise<number> {
  const r = await pool.query<{ n: string }>(`select count(*)::text as n from ${table} ${where}`);
  return Number(r.rows[0]?.n ?? 0);
}

before(async () => {
  await applySchema(admin, schema);
  pool = createPool({ schema });
  const eventsSql = await readFile(fileURLToPath(new URL('../db/events-migration.sql', import.meta.url)), 'utf8');
  const scheduleSql = await readFile(fileURLToPath(new URL('../db/schedule-migration.sql', import.meta.url)), 'utf8');
  await pool.query(eventsSql);
  await pool.query(scheduleSql);

  artifactDir = await mkdtemp(join(tmpdir(), 'lyra-w27-nightly-'));
  store = new ArtifactStore(artifactDir);
  calendar = { tradingDays: weekdays(fixtureDay(-28), fixtureDay(39)) };

  // 合成池：26 个股 + 4 宽基（满轮转 5×6；代码 600101..600126 裸 6 位）
  const stocks = Array.from({ length: 26 }, (_, i) => ({
    rank: i + 1,
    code: `600${String(101 + i)}`,
    name: `合成股${String(i + 1)}`,
    swL1IndexCode: '801999',
    swL1Name: '合成行业',
  }));
  const etfs = [
    { code: '510050', name: '上证50ETF', tracks: '上证50(000016)' },
    { code: '510300', name: '沪深300ETF', tracks: '沪深300(000300)' },
    { code: '510500', name: '中证500ETF', tracks: '中证500(000905)' },
    { code: '512100', name: '中证1000ETF', tracks: '中证1000(000852)' },
  ];
  poolInfoFile = join(artifactDir, 'research-pool.json');
  await writeFile(poolInfoFile, JSON.stringify({ frozenAt: fixtureDay(-1), stocks, etfs }), 'utf8');

  // 结算引擎自事实库读交易日历（RULE/ashare-calendar）：合成工作日全部登记（availableAt 提前可见）
  for (const d of calendar.tradingDays) {
    await addFact({
      subjectType: 'RULE', subjectId: 'ashare-calendar', factKind: 'TRADE_CALENDAR',
      typedValue: { calendar_date: d, is_trading_day: '1' }, availableAt: `${fixtureDay(-35)}T00:00:00Z`,
    });
  }
  // 桶 1 个股：各 1 根可见日 K（模拟 A 的证据引用面 ≥1 原件）；600101 用结算全史替代（避免同日双 K → BAR_DATE_CONFLICT）
  for (let i = 1; i < 6; i += 1) {
    const code = `600${String(101 + i)}`;
    await addFact({ subjectType: 'STOCK', subjectId: code, factKind: 'DAILY_BAR', typedValue: bar(`sh.${code}`, DATE), availableAt: shanghaiClose(DATE) });
  }
  // 600101 结算夹具全史：四周前周二至本周五，保持原有交易日/结算窗口间隔。
  const settleDays = weekdays(fixtureDay(-27), fixtureDay(4));
  for (const d of settleDays) {
    await addFact({ subjectType: 'STOCK', subjectId: '600101', factKind: 'DAILY_BAR', typedValue: bar('sh.600101', d), availableAt: shanghaiClose(d) });
    await addFact({ subjectType: 'INDEX', subjectId: '801999', factKind: 'SW_INDEX_BAR', typedValue: { 日期: d, 开盘: '1000', 收盘: '1000', swIndexCode: '801999' }, availableAt: shanghaiClose(d) });
  }
  await addFact({
    subjectType: 'STOCK', subjectId: '600101', factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: { 股票代码: '600101', 计入日期: 0, 行业代码: '340501', 更新日期: 0, 计入日期ISO: fixtureDay(-37), 更新日期ISO: `${fixtureDay(-37)} 00:00:00`, 体系: '2021', l1IndexCode: '801999' },
    availableAt: `${fixtureDay(-36)}T00:00:00Z`, validFrom: `${fixtureDay(-37)}T00:00:00+08:00`,
  });

  // 当日事件：600102 两份（SC-3.2 合并 → 截点取最晚 20:30+08）+ 池外 601111 一份
  for (const [id, subject, at] of [
    ['evt-a', '600102', `${DATE}T12:00:00Z`],
    ['evt-b', '600102', EVENT_CUTOFF],
    ['evt-c', '601111', `${DATE}T12:10:00Z`],
  ] as const) {
    const factId = await addFact({
      subjectType: 'STOCK', subjectId: subject, factKind: 'ANNOUNCEMENT',
      typedValue: { title: `合成回购公告 ${id}`, announcementTime: Date.parse(at), announcementType: 'BUYBACK' },
      eventAt: at, sourcePublishedAt: at, availableAt: at,
    });
    eventFactIds.set(id, factId);
    await pool.query(
      `insert into events (event_id, subject, type, subtype, event_time, evidence_fact_id, created_at)
       values ($1, $2, 'BUYBACK', null, $3, $4, $3)`,
      [id, subject, at, factId],
    );
  }
});

after(async () => {
  await pool.end().catch(() => {});
  await dropSchema(admin, schema);
  await admin.end();
  await rm(artifactDir, { recursive: true, force: true }).catch(() => {});
});

function deps() {
  return { dataPool: pool, execPool: pool, store, calendar };
}

const entriesOf = (out: { entries: NightlyEntryResult[] }, status: string): NightlyEntryResult[] =>
  out.entries.filter((e) => e.status === status);

test('dry：轮转 6 只 + 事件合并（截点取最晚）+ 池外跳过；零 permit 零结论零调度写入', async () => {
  const out = await runNightly(deps(), { date: DATE, mode: 'dry', now: NOW_EVENING, poolInfoFile });

  assert.equal(out.nth, 1);
  assert.deepEqual(
    out.rotation.map((s) => s.subject),
    ['600101', '600102', '600103', '600104', '600105', '600106'],
  );
  // 事件合并：600102 两份 → 1 条（cutoff = 最晚 12:30Z）；601111 池外
  assert.equal(out.postEventMerged.length, 2);
  const merged102 = out.postEventMerged.find((m) => m.subject === '600102');
  assert.ok(merged102);
  assert.equal(merged102.cutoff, EVENT_CUTOFF, 'SC-3.2 截点取最晚');
  assert.deepEqual(merged102.triggerEventIds, ['evt-a', 'evt-b']);

  // 条目：1 SKIPPED（池外）+ 7 DRY（1 事件后 + 6 轮转）
  assert.deepEqual(out.tally, { DRY: 7, PASS: 0, FAILED: 0, BLOCKED: 0, SKIPPED: 1 });
  const skipped = entriesOf(out, 'SKIPPED');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.code, 'SUBJECT_NOT_IN_POOL');
  assert.equal(skipped[0]?.subject, '601111');
  for (const e of entriesOf(out, 'DRY')) {
    assert.ok(e.inputBytes !== null && e.inputBytes > 0, `${e.subject} dry 到 prompt 面字节数`);
    assert.match(e.inputHash ?? '', /^[a-f0-9]{64}$/);
  }
  // 事件后 dry 条目带启动闸与继承预览
  const pe = entriesOf(out, 'DRY').find((e) => e.researchKind === 'POST_EVENT');
  assert.ok(pe && pe.detail && pe.detail.includes('启动闸=ALLOWED') && pe.detail.includes('继承=STANDALONE'), pe?.detail ?? '');

  // 零落库（permit / 结论 / 调度表）；重复 dry 仍零
  await runNightly(deps(), { date: DATE, mode: 'dry', now: NOW_EVENING, poolInfoFile });
  assert.equal(await countOf('exec_permit'), 0);
  assert.equal(await countOf('conclusion'), 0);
  assert.equal(await countOf('schedule_plan'), 0);
  assert.equal(await countOf('schedule_admission'), 0);
});

test('commit（simulated）：7 研究全 PASS，permit/结论落库且 pa-p5-skeleton 身份可查，锁释放', async () => {
  const out = await runNightly(deps(), { date: DATE, mode: 'commit', now: NOW_EVENING, poolInfoFile });
  assert.deepEqual(out.tally, { DRY: 0, PASS: 7, FAILED: 0, BLOCKED: 0, SKIPPED: 1 });
  assert.equal(out.permitsCreated, 14);
  assert.equal(out.conclusionsCreated, 7);

  // permit 面：14 行全部 skeleton + simulated
  const permits = await pool.query<{ plan_auth_version: string; simulated: boolean; state: string }>(
    'select plan_auth_version, simulated, state from exec_permit',
  );
  assert.equal(permits.rows.length, 14);
  for (const p of permits.rows) {
    assert.equal(p.plan_auth_version, SKELETON_PLAN_AUTH_VERSION);
    assert.equal(p.simulated, true);
    assert.equal(p.state, 'SUCCEEDED');
  }

  // 结论面：7 行全部 skeleton；POST_EVENT 结论业务键 = 合并截点
  const conclusions = await pool.query<{ conclusion_id: string; plan_auth_version: string; bk: { researchKind: string; cutoff: string; subject: string } }>(
    'select conclusion_id, plan_auth_version, business_key as bk from conclusion',
  );
  assert.equal(conclusions.rows.length, 7);
  for (const c of conclusions.rows) {
    assert.equal(c.plan_auth_version, SKELETON_PLAN_AUTH_VERSION, '演练身份可查');
  }
  const pe = conclusions.rows.find((c) => c.bk.researchKind === 'POST_EVENT');
  assert.ok(pe);
  assert.equal(pe.bk.subject, '600102');
  assert.equal(pe.bk.cutoff, EVENT_CUTOFF);
  // 从正常入口落下的 CAS 输入读回，确认事件事实确实封存且送达 L0/L1。
  const eventConclusion = await readConclusion(pool, pe.conclusion_id);
  assert.ok(eventConclusion?.evidence.researchTraceSha256);
  const trace = JSON.parse(new TextDecoder().decode(await store.readBytes(eventConclusion.evidence.researchTraceSha256))) as ResearchTrace;
  const context = validatePostEventContext(trace.input);
  assert.ok(context);
  assert.equal(context.event.eventId, 'evt-b');
  assert.equal(context.event.evidenceFactId, eventFactIds.get('evt-b'));
  const delivered = new Set([...trace.input.layers.l0.blocks, ...trace.input.layers.l1.blocks].map((b) => b.materialId));
  for (const id of ['evt-a', 'evt-b']) {
    const factId = eventFactIds.get(id)!;
    assert.ok(trace.input.seals.some((seal) => seal.factIds.includes(factId)));
    const ref = trace.input.materials.filter((m) => delivered.has(m.materialId))
      .flatMap((m) => m.evidenceRefs ?? []).find((r) => r.factId === factId);
    assert.ok(ref, `${id} 公告必须实际送达`);
    const original = JSON.parse(new TextDecoder().decode(await store.readBytes(ref.artifactSha256)));
    assert.equal(original.factId, factId);
    assert.equal(original.subjectId, '600102');
    assert.equal(original.typedValue.title, `合成回购公告 ${id}`);
    assert.ok(Date.parse(original.availableAt) <= Date.parse(EVENT_CUTOFF));
  }
  const weekly = conclusions.rows.find((c) => c.bk.researchKind === 'WEEKLY' && c.bk.subject === '600101');
  assert.ok(weekly);
  assert.equal(weekly.bk.cutoff, CUTOFF_EVENING, '周度截点 = 18:00+08 确定性排程时刻');

  // 调度落档：计划 1 行（skeleton 版本轴）+ 准入 7 行（skipped 池外不入档）
  assert.equal(await countOf('schedule_plan'), 1);
  assert.equal(await countOf('schedule_admission'), 7);

  // 执行锁已释放（EK-2.1 holder 纪律）
  const lock = await readExecutorLock(pool);
  assert.equal(lock.holder, '');
});

test('commit（transport=real）：P5_PROTOCOL_FROZEN，在计划/准入/permit 前拒绝', async () => {
  const beforePermits = await countOf('exec_permit');
  const beforeConclusions = await countOf('conclusion');
  const beforePlans = await countOf('schedule_plan');
  const beforeAdmissions = await countOf('schedule_admission');
  await assert.rejects(() => runNightly(deps(), {
    date: fixtureDay(7), mode: 'commit', now: new Date(`${fixtureDay(7)}T13:00:00Z`), poolInfoFile,
    transportProvider: 'real',
  }), (error: unknown) => (error as { code?: string }).code === 'P5_PROTOCOL_FROZEN');
  assert.equal(await countOf('exec_permit'), beforePermits, 'blocked 不入 permit 表');
  assert.equal(await countOf('conclusion'), beforeConclusions);
  assert.equal(await countOf('schedule_plan'), beforePlans);
  assert.equal(await countOf('schedule_admission'), beforeAdmissions);
});

test('settle-due：到期结论结算回填（SETTLED），新结论未到期不预测性回填', async () => {
  // 600101 老结论：四周前周一 12:00+08 完成，次日参考价，20 个交易日窗口到本周一走完。
  const fixture = await persistConclusion(pool, syntheticConclusionInput(
    { subjectKind: 'STOCK', subject: '600101', researchKind: 'WEEKLY', cutoff: `${fixtureDay(-28)}T02:00:00.000Z` },
    { methodVersion: 'method@p2-v1', adapterVersion: 'data@p1', planAuthVersion: 'pa-w27-settle-test' }));
  await pool.query('update conclusion set created_at = $1 where conclusion_id = $2', [`${fixtureDay(-28)}T04:00:00Z`, fixture.conclusionId]);

  const out = await runNightly(deps(), {
    date: fixtureDay(7), mode: 'dry', now: new Date(`${fixtureDay(7)}T13:00:00Z`), poolInfoFile,
    settleDue: true, settleAsOf: new Date(`${fixtureDay(8)}T00:00:00Z`),
  });
  assert.ok(out.settleDue !== null);
  assert.equal(out.settleDue.settled, 1, `仅夹具到期：${JSON.stringify(out.settleDue.entries.map((e) => [e.conclusionId, e.outcome, e.code]))}`);
  // 600102..600106（含 600102 的 POST_EVENT）无申万归属事实 → 具名 ANOMALY 不冒充结算（SR-10.4）
  assert.equal(out.settleDue.anomaly, 6);
  assert.ok(out.settleDue.entries.filter((e) => e.outcome === 'ANOMALY').every((e) => e.code === 'INDUSTRY_BENCHMARK_MISSING'));
  // 600101 本周 skeleton 结论：参考价后窗口未走完 → 不提前结算（SR-2.4）
  assert.equal(out.settleDue.unsettled, 1);
  const readBack = await readConclusion(pool, fixture.conclusionId);
  assert.equal(readBack?.settlement.state, 'SETTLED');
  assert.match(readBack?.settlement.excessReturn ?? '', /^-?\d+(\.\d+)?$/);
  assert.ok(out.settleDue.entries.some((e) => e.outcome === 'UNSETTLED' && e.code === 'WINDOW_INCOMPLETE'));
});

test('防御：非交易日具名拒绝；commit 截止已过具名拒绝', async () => {
  await assert.rejects(
    () => runNightly(deps(), { date: fixtureDay(-1), mode: 'dry', now: NOW_EVENING, poolInfoFile }),
    (e: unknown) => (e as { code?: string }).code === 'NIGHTLY_NOT_TRADING_DAY',
  );
  await assert.rejects(
    () => runNightly(deps(), { date: DATE, mode: 'commit', now: new Date(`${fixtureDay(1)}T02:00:00Z`), poolInfoFile }),
    (e: unknown) => (e as { code?: string }).code === 'NIGHTLY_COMMIT_DEADLINE_PAST',
  );
});
