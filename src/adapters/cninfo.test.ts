/**
 * Lyra · 巨潮适配器单元测试（P1 W5；2026-10-25 回工：暂停上报统一落库）。
 * 不碰网络：fetchImpl 注入 fixture 响应体，sleepImpl 注入即时返回并记录退避时延，
 * nowImpl 固定 firstObservedAt。暂停上报断言走隔离 schema 的 adapter_pause_report
 * （applySchema + applyP1Migration 建套件，after 中 drop），向后兼容分支（无 pool）单列。
 * 合同：DATA-SOURCES §2.1/§6.5/§7（去重、退避、暂停上报）、POINT-IN-TIME §2/§3（时间映射）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { after, before, test } from 'node:test';
import {
  announcementTiming,
  CnInfoAdapter,
  CnInfoPauseError,
  CninfoError,
  classifyCninfoCode,
  cninfoPauseScope,
  CNINFO_ADAPTER_VERSION,
  defaultDayPrecisionAvailableAt,
  isDayPrecisionCst,
  mapAnnouncementToFact,
  pdfUrlOf,
  type CnInfoAdapterOptions,
} from './cninfo.js';
import { applyP1Migration, loadPauseReports } from './backoff.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';

// ===== 假基础设施 =====

interface RecordedCall {
  url: string;
  body: URLSearchParams;
}

interface StubResponse {
  status: number;
  text: string;
}

function fakeFetch(options: {
  queue: Map<string, StubResponse[]>;
  calls: RecordedCall[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    options.calls.push({ url, body });
    const next = options.queue.get(url)?.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(next.text, { status: next.status });
  }) as typeof fetch;
}

const sleepRecorder = (): { sleepImpl: (ms: number) => Promise<void>; delays: number[] } => {
  const delays: number[] = [];
  return { delays, sleepImpl: async (ms: number) => { delays.push(ms); } };
};

const FIXED_NOW = Date.UTC(2026, 9, 25, 1, 0, 0); // 2026-10-25T01:00:00Z

function makeAdapter(options: {
  store: ArtifactStore;
  queue: Map<string, StubResponse[]>;
  calls: RecordedCall[];
  pool?: Pool;
  dayPrecisionPolicy?: (publishedMs: number) => string;
}): { adapter: CnInfoAdapter; delays: number[] } {
  const { delays, sleepImpl } = sleepRecorder();
  const adapter = new CnInfoAdapter({
    store: options.store,
    fetchImpl: fakeFetch({ queue: options.queue, calls: options.calls }),
    sleepImpl,
    throttleMs: 0,
    nowImpl: () => FIXED_NOW,
    ...(options.pool !== undefined ? { pool: options.pool } : {}),
    ...(options.dayPrecisionPolicy !== undefined ? { dayPrecisionPolicy: options.dayPrecisionPolicy } : {}),
  } satisfies CnInfoAdapterOptions);
  return { adapter, delays };
}

// fixture：公告行（announcementTime 用实测过的毫秒值）
function ann(id: number, timeMs: number, code = '600519'): Record<string, unknown> {
  return {
    announcementId: id,
    announcementTitle: `第${id}号公告`,
    announcementTime: timeMs,
    adjunctUrl: `finalpage/2025-03-19/${id}.PDF`,
    adjunctSize: 124,
    announcementType: '01010503||010113',
    secCode: code,
    secName: '贵州茅台',
  };
}

function pageJson(announcements: Record<string, unknown>[], hasMore: boolean): string {
  return JSON.stringify({
    classifiedAnnouncements: null,
    totalSecurities: 1,
    totalAnnouncement: announcements.length,
    totalRecordNum: announcements.length,
    announcements,
    categoryList: [],
    hasMore,
    totalpages: hasMore ? 2 : 0,
  });
}

function topSearchJson(code: string, orgId: string): string {
  return JSON.stringify([{ code, pinyin: 'gzmt', sjstsBond: '', category: 'A股', type: '1', delisted: null, orgId, zwjc: '茅台' }]);
}

const QUERY_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
const SEARCH_URL = 'http://www.cninfo.com.cn/new/information/topSearch/query';

// ===== 隔离原件目录 + 隔离 schema（暂停上报落库断言用；P0 schema + P1 增量迁移）=====

let artifactDir: string;
let store: ArtifactStore;
let admin: Pool;
let schema: string;
let pool: Pool;

before(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'lyra-w5-cninfo-'));
  store = new ArtifactStore(artifactDir);
  admin = createPool();
  schema = `p1_cninfo_t_${Date.now().toString(36)}`;
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactDir, { recursive: true, force: true });
});

// ===== 代码分类（R17 主板收窄）=====

test('classifyCninfoCode: 沪/深主板放行，创业板/科创板/ETF/非法拒绝', () => {
  assert.deepEqual(classifyCninfoCode('600519'), { column: 'sse', plate: 'sh', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('601318'), { column: 'sse', plate: 'sh', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('605117'), { column: 'sse', plate: 'sh', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('000002'), { column: 'szse', plate: 'sz', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('001979'), { column: 'szse', plate: 'sz', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('003816'), { column: 'szse', plate: 'sz', subjectType: 'STOCK' });
  assert.deepEqual(classifyCninfoCode('002384'), { column: 'szse', plate: 'sz', subjectType: 'STOCK' }); // 002 并入深主板（R17）
  assert.equal(classifyCninfoCode('300750'), null); // 创业板
  assert.equal(classifyCninfoCode('688981'), null); // 科创板
  assert.equal(classifyCninfoCode('510300'), null); // ETF
  assert.equal(classifyCninfoCode('430047'), null); // 北交所
  assert.equal(classifyCninfoCode('abc123'), null);
  assert.equal(classifyCninfoCode('60051'), null);
});

// ===== 时间映射（POINT-IN-TIME §3.1）=====

test('announcementTiming: 盘中时刻按时刻（TIMED）', () => {
  const timing = announcementTiming(1741856747000); // 2025-03-13 17:05:47 CST（实测值）
  assert.equal(timing.precision, 'TIMED');
  assert.equal(timing.publishedIso, '2025-03-13T09:05:47.000Z'); // CST → UTC 减 8 小时
  assert.equal(timing.availableIso, '2025-03-13T09:05:47.000Z');
});

test('announcementTiming: 日精度（CST 零点）保守 D+1；周五 → 次周一', () => {
  assert.equal(isDayPrecisionCst(1742313600000), true); // 2025-03-19 00:00 CST（周三，实测值）
  assert.equal(isDayPrecisionCst(1743177600000), true); // 2025-03-29 00:00 CST——注意这是周六
  assert.equal(isDayPrecisionCst(1741856747000), false);

  const wed = announcementTiming(1742313600000); // 周三公告 → 次日（周四）08:00 CST
  assert.equal(wed.precision, 'DAY');
  assert.equal(wed.publishedIso, '2025-03-18T16:00:00.000Z');
  assert.equal(wed.availableIso, '2025-03-20T00:00:00.000Z'); // 周四 08:00 CST = 00:00 UTC

  // 实测样本 1222946022：announcementTime = 2025-03-29（周六）→ 次周一 08:00 CST
  const sat = announcementTiming(1743177600000);
  assert.equal(sat.availableIso, '2025-03-31T00:00:00.000Z'); // 周一 2025-03-31 08:00 CST
  assert.equal(defaultDayPrecisionAvailableAt(1743177600000), '2025-03-31T00:00:00.000Z');
});

test('announcementTiming: 自定义策略注入；早于 D+1 下界即拒绝', () => {
  const custom = announcementTiming(1742313600000, () => '2025-03-20T01:30:00.000Z'); // 交易日历策略（假想 W6）
  assert.equal(custom.availableIso, '2025-03-20T01:30:00.000Z');
  assert.throws(() => announcementTiming(1742313600000, () => '2025-03-18T16:00:00.000Z'), (error: unknown) =>
    error instanceof CninfoError && error.code === 'INVALID_AVAILABILITY_POLICY',
  );
});

// ===== 事实映射 =====

test('mapAnnouncementToFact: 确定性 factId、typedValue 原生字段、时间字段三立', () => {
  const fact = mapAnnouncementToFact(ann(1222834722, 1742313600000), 'ab'.repeat(32), '2026-10-25T01:00:00.000Z');
  assert.equal(fact.factId, 'cninfo:ann:1222834722@p1');
  assert.equal(fact.subjectType, 'STOCK');
  assert.equal(fact.subjectId, '600519');
  assert.equal(fact.factKind, 'ANNOUNCEMENT');
  assert.equal(fact.adapterVersion, CNINFO_ADAPTER_VERSION);
  assert.equal(fact.artifactSha256, 'ab'.repeat(32));
  assert.equal(fact.availableAt, '2025-03-20T00:00:00.000Z'); // 日精度保守 D+1
  assert.equal(fact.eventAt, fact.availableAt); // 事件时点同 availableAt（派发冻结）
  assert.equal(fact.sourcePublishedAt, '2025-03-18T16:00:00.000Z'); // 来源标注时刻独立保存
  assert.equal(fact.firstObservedAt, '2026-10-25T01:00:00.000Z'); // 实际抓取时刻
  assert.equal(fact.validFrom, null);
  assert.equal(fact.validTo, null);
  assert.equal(fact.supersedesFactId, null);
  const typed = fact.typedValue as Record<string, unknown>;
  assert.equal(typed.title, '第1222834722号公告');
  assert.equal(typed.announcementTime, 1742313600000); // 原始毫秒值
  assert.equal(typed.adjunctUrl, 'finalpage/2025-03-19/1222834722.PDF');
  assert.equal(pdfUrlOf(String(typed.adjunctUrl)), 'http://static.cninfo.com.cn/finalpage/2025-03-19/1222834722.PDF');

  // 重放同一条：同一 factId（同原件 + 同适配器版本不产生新 fact_id，POINT-IN-TIME §4）
  const replay = mapAnnouncementToFact(ann(1222834722, 1742313600000), 'ab'.repeat(32), '2026-10-26T01:00:00.000Z');
  assert.equal(replay.factId, fact.factId);
  assert.notEqual(replay.firstObservedAt, fact.firstObservedAt);
});

test('mapAnnouncementToFact: 非法 announcementTime / announcementId / secCode 拒绝', () => {
  const base = ann(1, 1742313600000);
  assert.throws(
    () => mapAnnouncementToFact({ ...base, announcementTime: null }, 'ab'.repeat(32), FIXED_NOW_AS_ISO()),
    (error: unknown) => error instanceof CninfoError && error.code === 'INVALID_ANNOUNCEMENT_TIME',
  );
  assert.throws(
    () => mapAnnouncementToFact({ ...base, announcementId: undefined }, 'ab'.repeat(32), FIXED_NOW_AS_ISO()),
    (error: unknown) => error instanceof CninfoError && error.code === 'INVALID_ANNOUNCEMENT_ID',
  );
  assert.throws(
    () => mapAnnouncementToFact({ ...base, secCode: '300750' }, 'ab'.repeat(32), FIXED_NOW_AS_ISO()),
    (error: unknown) => error instanceof CninfoError && error.code === 'INVALID_ANNOUNCEMENT_SUBJECT',
  );
});

function FIXED_NOW_AS_ISO(): string {
  return new Date(FIXED_NOW).toISOString();
}

// ===== 适配器：orgId 流程 + 参数组装 + 原件入库 =====

test('fetchAnnouncements: topSearch 解析 orgId 并缓存；stock 参数 code,orgId；原件入库', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [
      QUERY_URL,
      [
        { status: 200, text: pageJson([ann(1, 1742313600000), ann(2, 1742313600000)], false) },
        { status: 200, text: pageJson([ann(7, 1745193600000)], false) }, // 第二段（4 月窗口）
      ],
    ],
  ]);
  const { adapter } = makeAdapter({ store, queue, calls });

  const pages = await adapter.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31' });
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.facts.length, 2);

  const search = calls.find((call) => call.url === SEARCH_URL);
  assert.ok(search !== undefined);
  assert.equal(search.body.get('keyWord'), '600519');
  const query = calls.find((call) => call.url === QUERY_URL);
  assert.ok(query !== undefined);
  assert.equal(query.body.get('stock'), '600519,gssh0600519'); // code,orgId 形式
  assert.equal(query.body.get('column'), 'sse');
  assert.equal(query.body.get('plate'), 'sh');
  assert.equal(query.body.get('seDate'), '2025-03-01~2025-03-31');
  assert.equal(query.body.get('pageSize'), '30');

  // 原件入库：bytes = 页 JSON 原文，哈希可读回校验，firstObservedAt 为抓取时刻
  const artifact = pages[0]?.artifact;
  assert.ok(artifact !== undefined);
  assert.equal(artifact.mediaType, 'application/json');
  assert.equal(artifact.firstObservedAt, FIXED_NOW_AS_ISO());
  const bytes = await store.readBytes(artifact.sha256);
  assert.equal(new TextDecoder().decode(bytes), pageJson([ann(1, 1742313600000), ann(2, 1742313600000)], false));
  assert.equal(pages[0]?.facts[0]?.artifactSha256, artifact.sha256);

  // 第二次段查询复用缓存：不再发 topSearch
  const callsBefore = calls.length;
  await adapter.fetchAnnouncements({ code: '600519', from: '2025-04-01', to: '2025-04-30' });
  assert.equal(calls.length, callsBefore + 1); // 仅 1 个 query 请求
  assert.equal(calls[calls.length - 1]?.url, QUERY_URL);
});

test('fetchAnnouncements: 深市代码用 column=szse/plate=sz；seedOrgId 免 topSearch', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [QUERY_URL, [{ status: 200, text: pageJson([ann(9, 1742313600000, '000002')], false) }]],
  ]);
  const { adapter } = makeAdapter({ store, queue, calls });
  adapter.seedOrgId('000002', 'gssz0000002');
  const pages = await adapter.fetchAnnouncements({ code: '000002', from: '2025-03-01', to: '2025-03-31' });
  assert.equal(pages.length, 1);
  assert.ok(!calls.some((call) => call.url === SEARCH_URL)); // 未触发 topSearch
  const query = calls.find((call) => call.url === QUERY_URL);
  assert.equal(query?.body.get('column'), 'szse');
  assert.equal(query?.body.get('plate'), 'sz');
  assert.equal(query?.body.get('stock'), '000002,gssz0000002');
});

test('fetchAnnouncements: 翻页（满页 + hasMore）与 maxPages 上限', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [
      QUERY_URL,
      [
        { status: 200, text: pageJson([ann(1, 1742313600000), ann(2, 1742313600000)], true) }, // 满 2 条（pageSize=2）
        { status: 200, text: pageJson([ann(3, 1742313600000)], false) }, // 不满页 → 最后一页
      ],
    ],
  ]);
  const { adapter } = makeAdapter({ store, queue, calls });
  const pages = await adapter.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31', pageSize: 2 });
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.raw.hasMore, true);
  assert.deepEqual(pages.flatMap((page) => page.facts).map((fact) => (fact.typedValue as { announcementId: string }).announcementId), ['1', '2', '3']);
  assert.equal(calls.filter((call) => call.url === QUERY_URL).length, 2);
  const second = calls.filter((call) => call.url === QUERY_URL)[1];
  assert.equal(second?.body.get('pageNum'), '2');

  // maxPages 上限：有更多页也在上限停
  const calls2: RecordedCall[] = [];
  const queue2 = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [
      QUERY_URL,
      [
        { status: 200, text: pageJson([ann(1, 1742313600000)], true) },
        { status: 200, text: pageJson([ann(2, 1742313600000)], true) },
        { status: 200, text: pageJson([ann(3, 1742313600000)], false) },
      ],
    ],
  ]);
  const adapter2 = makeAdapter({ store, queue: queue2, calls: calls2 }).adapter;
  const capped = await adapter2.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31', pageSize: 1, maxPages: 2 });
  assert.equal(capped.length, 2); // 第 3 页不发
  assert.equal(calls2.filter((call) => call.url === QUERY_URL).length, 2);
});

test('fetchAnnouncements: 空结果段返回单页零事实；越界代码不发请求', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [QUERY_URL, [{ status: 200, text: pageJson([], false) }]],
  ]);
  const { adapter } = makeAdapter({ store, queue, calls });
  const pages = await adapter.fetchAnnouncements({ code: '600519', from: '2025-01-01', to: '2025-01-31' });
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.facts.length, 0);

  await assert.rejects(
    () => makeAdapter({ store, queue: new Map(), calls: [] }).adapter.fetchAnnouncements({ code: '300750', from: '2025-01-01', to: '2025-01-31' }),
    (error: unknown) => error instanceof CninfoError && error.code === 'CODE_OUT_OF_SCOPE',
  );
});

test('fetchAnnouncements: 日期格式与倒序区间拒绝', async () => {
  const adapter = makeAdapter({ store, queue: new Map(), calls: [] }).adapter;
  adapter.seedOrgId('600519', 'gssh0600519');
  await assert.rejects(
    () => adapter.fetchAnnouncements({ code: '600519', from: '20250301', to: '2025-03-31' }),
    (error: unknown) => error instanceof CninfoError && error.code === 'INVALID_DATE_RANGE',
  );
  await assert.rejects(
    () => adapter.fetchAnnouncements({ code: '600519', from: '2025-04-01', to: '2025-03-01' }),
    (error: unknown) => error instanceof CninfoError && error.code === 'INVALID_DATE_RANGE',
  );
});

test('resolveOrgId: topSearch 无匹配 → ORGID_NOT_FOUND', async () => {
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('999999', 'gssh0999999') }]],
  ]);
  const adapter = makeAdapter({ store, queue, calls: [] }).adapter;
  await assert.rejects(
    () => adapter.resolveOrgId('600519'),
    (error: unknown) => error instanceof CninfoError && error.code === 'ORGID_NOT_FOUND',
  );
});

// ===== 退避与暂停上报（DATA-SOURCES §7 / EK-7 语义）=====

test('退避：连续可恢复错误 → 等待 30s/60s/120s 重试 3 次后暂停上报（四要素 + 落库 adapter_pause_report）', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [
      QUERY_URL,
      [
        { status: 429, text: 'rate limited' },
        { status: 502, text: 'bad gateway' },
        { status: 500, text: 'server error' },
        { status: 503, text: 'service unavailable' }, // 第 4 次尝试仍失败 → 暂停
      ],
    ],
  ]);
  const scope = cninfoPauseScope({ step: 'hisAnnouncement', code: '600519', seDate: '2025-03-01~2025-03-31', pageNum: 1 });
  const { adapter, delays } = makeAdapter({ store, queue, calls, pool });
  adapter.seedOrgId('600519', 'gssh0600519');

  await assert.rejects(
    () => adapter.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31' }),
    (error: unknown) => {
      assert.ok(error instanceof CnInfoPauseError);
      assert.equal(error.report.retried, 3);
      assert.match(error.report.lastError, /HTTP 503/);
      assert.deepEqual(error.report.resumePoint, { step: 'hisAnnouncement', code: '600519', seDate: '2025-03-01~2025-03-31', pageNum: 1 });
      assert.match(error.report.nextAction, /重跑/);
      return true;
    },
  );
  assert.deepEqual(delays, [30_000, 60_000, 120_000]); // 等待序列约 30s/60s/120s，第 4 次等待重试不再发起
  assert.equal(calls.filter((call) => call.url === QUERY_URL).length, 4); // 初次 + 3 次重试

  // 暂停上报落库（R21）：adapter_pause_report 恰一行，四要素映射，状态 PAUSED
  const rows = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.adapter, CNINFO_ADAPTER_VERSION);
  assert.equal(row.scope, scope); // 'cninfo:hisAnnouncement:600519:2025-03-01~2025-03-31:1'
  assert.equal(row.retries, 3);
  assert.equal(row.last_error, 'HTTP 503');
  assert.equal(row.status, 'PAUSED');
  assert.ok(row.updated_at instanceof Date);
});

test('退避·向后兼容：无 pool 注入 → 仍抛 CnInfoPauseError（四要素不变），不落库、无文件载体', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 200, text: topSearchJson('600519', 'gssh0600519') }]],
    [
      QUERY_URL,
      [
        { status: 429, text: 'rate limited' },
        { status: 502, text: 'bad gateway' },
        { status: 500, text: 'server error' },
        { status: 503, text: 'service unavailable' },
      ],
    ],
  ]);
  const rowsBefore = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  const { adapter, delays } = makeAdapter({ store, queue, calls }); // 不注入 pool
  adapter.seedOrgId('600519', 'gssh0600519');

  await assert.rejects(
    () => adapter.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31' }),
    (error: unknown) => {
      assert.ok(error instanceof CnInfoPauseError);
      assert.equal(error.report.retried, 3);
      assert.match(error.report.lastError, /HTTP 503/);
      assert.deepEqual(error.report.resumePoint, { step: 'hisAnnouncement', code: '600519', seDate: '2025-03-01~2025-03-31', pageNum: 1 });
      assert.match(error.report.nextAction, /重跑/);
      return true;
    },
  );
  assert.deepEqual(delays, [30_000, 60_000, 120_000]);
  assert.equal(calls.filter((call) => call.url === QUERY_URL).length, 4);
  // 无 pool：仅 console.error，不落库（前后行集合逐行相等，含 updated_at 不变 → 无 insert 也无 upsert），
  // l1-pause.json 文件载体已移除。
  const rowsAfter = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  assert.deepEqual(rowsAfter, rowsBefore);
});

test('退避：每次调用独立计数——topSearch 与 query 各重试一次（各等 30s）后成功', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [
      SEARCH_URL,
      [
        { status: 200, text: 'not-json-at-all' }, // 200 非 JSON：疑似反爬拦截页 → 可恢复
        { status: 200, text: topSearchJson('600519', 'gssh0600519') },
      ],
    ],
    [
      QUERY_URL,
      [
        { status: 500, text: 'server error' }, // 可恢复
        { status: 200, text: pageJson([ann(1, 1742313600000)], false) },
      ],
    ],
  ]);
  const { adapter, delays } = makeAdapter({ store, queue, calls });
  const pages = await adapter.fetchAnnouncements({ code: '600519', from: '2025-03-01', to: '2025-03-31' });
  assert.equal(pages.length, 1);
  assert.deepEqual(delays, [30_000, 30_000]); // 退避按调用重置：每次调用首次重试等 30s
});

test('不可恢复：404 不重试、不落暂停上报', async () => {
  const calls: RecordedCall[] = [];
  const queue = new Map<string, StubResponse[]>([
    [SEARCH_URL, [{ status: 404, text: 'nope' }]],
  ]);
  const { adapter, delays } = makeAdapter({ store, queue, calls, pool });
  await assert.rejects(
    () => adapter.resolveOrgId('600519'),
    (error: unknown) => error instanceof CninfoError && error.code === 'SOURCE_HTTP',
  );
  assert.deepEqual(delays, []);
  assert.equal(calls.filter((call) => call.url === SEARCH_URL).length, 1);
  // 不可恢复错误不走暂停上报：adapter_pause_report 无该 scope 行
  const rows = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  assert.ok(!rows.some((row) => row.scope === cninfoPauseScope({ step: 'topSearch', code: '600519' })));
});
