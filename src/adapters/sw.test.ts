/**
 * Lyra · 申万行业轴适配器单测（P1 W7: code-writer-pro）。不碰外网：
 * 桥响应用 fixture 字符串注入（形态照真实返回），退避用记录式注入睡眠，
 * DB 用本地 lyra-pg 隔离 schema。合同判定：R23（来源与语义核验）、DATA-SOURCES §5/§6/§7、
 * POINT-IN-TIME §2/§3.4/§5.2（availableAt 取法、as-of 读取、版本链 validFrom/validTo）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { asOfFacts } from '../pintime/facts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import { ConcurrencyGate, applyP1Migration, type BackoffSleeper } from './backoff.js';
import { p1RunId, type BridgeExecutor } from './baostock.js';
import {
  SW2014_PREFIX_L1,
  SW2014_GAP_CLOSED,
  SW_ADAPTER_VERSION,
  SW_CLASS_SOURCE_GAP_CLOSED,
  SW2021_PREFIX_L1,
  SwAdapter,
  mapClassifyRowsToFacts,
  mapDailyRowsToFacts,
  mapL1ListRowToFacts,
  shanghaiClose,
  shanghaiNextDayStart,
  swL1IndexCodeFor,
  swSystemOf,
  type SwMapContext,
  type SwRow,
} from './sw.js';

// ===== fixture（桥 stdout 形态；字段名与取值形态照真实返回 2026-10-25 实测）=====

const NOW = new Date('2026-10-25T03:00:00.000Z');

/** 000001 三行（1991/2014/2021 真实序列值）+ 000002 单行携带 + 1 行非法。 */
const CLASSIFY_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 股票代码: '000001', 计入日期: 33331.0, 计入日期ISO: '1991-04-03', 行业代码: '440101', 更新日期: 42304.64513888889, 更新日期ISO: '2015-10-27 15:29:00' },
    { 股票代码: '000001', 计入日期: 41691.0, 计入日期ISO: '2014-02-21', 行业代码: '480101', 更新日期: 45562.38055555556, 更新日期ISO: '2024-09-27 09:08:00' },
    { 股票代码: '000001', 计入日期: 44407.0, 计入日期ISO: '2021-07-30', 行业代码: '480301', 更新日期: 46006.68958333333, 更新日期ISO: '2025-12-15 16:33:00' },
    { 股票代码: '000002', 计入日期: 33267.0, 计入日期ISO: '1991-01-29', 行业代码: '430101', 更新日期: 42304.64444444444, 更新日期ISO: '2015-10-27 15:28:00' },
    { 股票代码: '', 计入日期: 44407.0, 计入日期ISO: '2021-07-30', 行业代码: '480301', 更新日期: 46006.6, 更新日期ISO: '2025-12-15 16:33:00' },
  ],
});

const L1_LIST_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 行业代码: '801010.SI', 行业名称: '农林牧渔', 成份个数: '104', 静态市盈率: 29.37 },
    { 行业代码: '801780.SI', 行业名称: '银行', 成份个数: '42', 静态市盈率: 6.5 },
  ],
});

const DAILY_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 代码: '801780', 日期: '2021-07-29', 收盘: 3510.0, 开盘: 3500.0, 最高: 3520.0, 最低: 3490.0, 成交量: 1230000.0, 成交额: 456000000.0 },
    { 代码: '801780', 日期: '2021-07-30', 收盘: 3520.0, 开盘: 3510.0, 最高: 3530.0, 最低: 3500.0, 成交量: 1300000.0, 成交额: 470000000.0 },
    { 代码: '801780', 日期: '', 收盘: 1.0, 开盘: 1.0, 最高: 1.0, 最低: 1.0, 成交量: 0.0, 成交额: 0.0 },
  ],
});

const COMPONENT_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 序号: 1, 证券代码: '000001', 证券名称: '平安银行', 最新权重: 7.5, 计入日期: '2021-12-13' },
  ],
});

const CTX: SwMapContext = {
  adapterVersion: SW_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('swSystemOf 三段边界（2014-02-21 / 2021-07-30）', () => {
  assert.equal(swSystemOf('2014-02-20'), 'pre2014');
  assert.equal(swSystemOf('2014-02-21'), '2014');
  assert.equal(swSystemOf('2021-07-29'), '2014');
  assert.equal(swSystemOf('2021-07-30'), '2021');
  assert.equal(swSystemOf('1991-04-03'), 'pre2014');
});

test('前缀映射表完整性（2021 31/31、2014 28/28）且不含猜测值', () => {
  assert.equal(Object.keys(SW2021_PREFIX_L1).length, 31);
  assert.equal(Object.keys(SW2014_PREFIX_L1).length, 28);
  for (const table of [SW2021_PREFIX_L1, SW2014_PREFIX_L1]) {
    for (const [prefix, code] of Object.entries(table)) {
      assert.match(prefix, /^\d{2}$/);
      assert.match(code, /^\d{6}$/);
    }
  }
  // 2014 指数码 = 2021 指数码 ∪ {801020 采掘（退役，2021-12-10 最后交易日）}
  const set2021 = new Set(Object.values(SW2021_PREFIX_L1));
  for (const code of Object.values(SW2014_PREFIX_L1)) {
    assert.ok(set2021.has(code) || code === '801020', `2014 指数码 ${code} 须在 2021 集或为 801020`);
  }
  assert.equal(SW2014_PREFIX_L1['21'], '801020');
});

test('swL1IndexCodeFor：pre2014 与未知前缀返回 null（不得猜）', () => {
  assert.equal(swL1IndexCodeFor('480301', '2021-07-30'), '801780');
  assert.equal(swL1IndexCodeFor('480101', '2014-02-21'), '801780');
  assert.equal(swL1IndexCodeFor('440101', '1991-04-03'), null); // pre2014（老申万）指数码未核验
  assert.equal(swL1IndexCodeFor('990101', '2021-07-30'), null); // 未知前缀
});

test('mapClassifyRowsToFacts：链式 validFrom/validTo、保守 D+1 availableAt、携带行 l1 判定', () => {
  const rows = (JSON.parse(CLASSIFY_JSON) as { rows: SwRow[] }).rows;
  const { facts, rejections } = mapClassifyRowsToFacts(rows, CTX);
  assert.equal(facts.length, 4);
  assert.deepEqual(rejections, [{ rowIndex: 4, code: 'SW_CLASSIFY_ROW_INVALID' }]);

  const byKey = new Map(facts.map((f) => [`${f.fact.subjectId}:${f.objectKey}`, f.fact]));
  const r1991 = byKey.get('000001:1991-04-03:440101');
  const r2014 = byKey.get('000001:2014-02-21:480101');
  const r2021 = byKey.get('000001:2021-07-30:480301');
  const wk = byKey.get('000002:1991-01-29:430101');
  assert.ok(r1991 && r2014 && r2021 && wk);

  // 链：validTo = 下一行计入日（排他），末行 null
  assert.equal(r1991!.validTo, r2014!.validFrom);
  assert.equal(r2014!.validTo, r2021!.validFrom);
  assert.equal(r2021!.validTo, null);
  assert.equal(r1991!.validFrom, '1991-04-02T16:00:00.000Z'); // 1991-04-03 00:00+08

  // availableAt = 计入+1 日 00:00+08（保守 D+1，POINT-IN-TIME §3.4 / R23.3）
  assert.equal(r2021!.availableAt, '2021-07-30T16:00:00.000Z');
  assert.equal(r2014!.availableAt, '2014-02-21T16:00:00.000Z');

  // sourcePublishedAt = 更新日期（来源标注），+08 时刻
  assert.equal(r2021!.sourcePublishedAt, '2025-12-15T08:33:00.000Z');

  // typedValue：原始序列值原样 + 体系 + l1IndexCode（pre2014 无映射）
  const tv = r2021!.typedValue as Record<string, unknown>;
  assert.equal(tv['计入日期'], 44407);
  assert.equal(tv['计入日期ISO'], '2021-07-30');
  assert.equal(tv['行业代码'], '480301');
  assert.equal(tv['体系'], '2021');
  assert.equal(tv['l1IndexCode'], '801780');
  assert.equal((r1991!.typedValue as Record<string, unknown>)['体系'], 'pre2014');
  assert.equal((r1991!.typedValue as Record<string, unknown>)['l1IndexCode'], null);
  // 万科式携带行：pre2014 铸造、无末级行——validTo null，代码字符串为现行分类
  assert.equal(wk!.validTo, null);
  assert.equal((wk!.typedValue as Record<string, unknown>)['l1IndexCode'], null);

  // factId 由原始行派生（不含派生字段）→ 同原始行重放同 factId
  const again = mapClassifyRowsToFacts(rows, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
});

test('mapL1ListRowToFacts：单条快照事实，availableAt=抓取时刻，validFrom=null', () => {
  const rows = (JSON.parse(L1_LIST_JSON) as { rows: SwRow[] }).rows;
  const { facts } = mapL1ListRowToFacts(rows, CTX);
  assert.equal(facts.length, 1);
  const fact = facts[0]!.fact;
  assert.equal(fact.factKind, 'SW_INDEX_LIST');
  assert.equal(fact.subjectType, 'INDEX');
  assert.equal(fact.subjectId, 'SW-L1-LIST');
  assert.equal(fact.availableAt, NOW.toISOString());
  assert.equal(fact.validFrom, null);
  assert.equal(((fact.typedValue as { rows: SwRow[] }).rows).length, 2);
  assert.equal(mapL1ListRowToFacts([], CTX).rejections[0]?.code, 'SW_L1_LIST_EMPTY');
});

test('mapDailyRowsToFacts：收盘 15:00+08 availableAt、原始字段保留、缺日期拒绝', () => {
  const rows = (JSON.parse(DAILY_JSON) as { rows: SwRow[] }).rows;
  const { facts, rejections } = mapDailyRowsToFacts('801780', rows, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [{ rowIndex: 2, code: 'SW_BAR_DATE_MISSING' }]);
  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'SW_INDEX_BAR');
  assert.equal(first.subjectType, 'INDEX');
  assert.equal(first.subjectId, '801780');
  assert.equal(first.availableAt, '2021-07-29T07:00:00.000Z'); // 15:00+08
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv['代码'], '801780');
  assert.equal(tv['收盘'], 3510.0);
  assert.equal(tv['swIndexCode'], '801780');
  assert.deepEqual(mapDailyRowsToFacts('8017', rows, CTX).rejections.map((r) => r.code), [
    'SW_BAR_INDEX_INVALID',
    'SW_BAR_INDEX_INVALID',
    'SW_BAR_INDEX_INVALID',
  ]);
});

test('时间辅助：D+1 与收盘时刻', () => {
  assert.equal(shanghaiNextDayStart('2021-07-30'), '2021-07-30T16:00:00.000Z');
  assert.equal(shanghaiClose('2021-07-30'), '2021-07-30T07:00:00.000Z');
});

test('缺口收口文本：含缺口 id 与关闭证据', () => {
  assert.ok(SW_CLASS_SOURCE_GAP_CLOSED.includes('SW_CLASS_SOURCE_GAP'));
  assert.ok(SW_CLASS_SOURCE_GAP_CLOSED.includes('关闭'));
  assert.ok(SW_CLASS_SOURCE_GAP_CLOSED.includes('sw-semantics-report.json'));
  assert.ok(SW2014_GAP_CLOSED.includes('SW2014_GAP'));
  assert.ok(SW2014_GAP_CLOSED.includes('801020'));
});

// ===== 适配器（fixture 注入 + 隔离 schema）=====

let admin: Pool;
let pool: Pool;
let schema: string;
let artifactsDir: string;
let store: ArtifactStore;
let repoRootDir: string;

/** 记录式睡眠：立即放行并记录等待序列。 */
const recordingSleeper: BackoffSleeper & { waits: number[] } = {
  waits: [],
  async sleep(ms: number): Promise<void> {
    this.waits.push(ms);
  },
};

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => script(args);
}

function mkAdapter(exec: BridgeExecutor): SwAdapter {
  return new SwAdapter({
    pool,
    store,
    execBridge: exec,
    now: () => NOW,
    gate: new ConcurrencyGate(1),
    repoRootPath: repoRootDir,
  });
}

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w7-sw-'));
  store = new ArtifactStore(artifactsDir);
  repoRootDir = await mkdtemp(join(tmpdir(), 'lyra-w7-root-'));
  await mkdir(join(repoRootDir, 'var'), { recursive: true });
  await writeFile(join(repoRootDir, 'var/sw-StockClassifyUse_stock.xls'), Buffer.from('fake-xls-bytes'));
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(repoRootDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchL1List：入库 + 原件 + 重放幂等 + 修订口径声明随行', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.equal(args[0], 'l1_list');
    calls += 1;
    return JSON.parse(L1_LIST_JSON) as BridgeResponse;
  }));
  const r1 = await adapter.fetchL1List();
  assert.equal(r1.adapterVersion, SW_ADAPTER_VERSION);
  assert.equal(r1.scope, 'sw:sw_l1_list:current');
  assert.equal(r1.insertedFactIds.length, 1);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256); // 写入即校验读回
  assert.ok(JSON.parse(new TextDecoder().decode(bytes)).length === 2);
  const r2 = await adapter.fetchL1List();
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 1); // DATA-SOURCES §6.5 同键同值去重
  assert.equal(calls, 2); // 执行器层不缓存（缓存策略在 runner）
});

test('fetchL1Daily：入库 + as-of 截点过滤（收盘前不可见）', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['l1_daily', '801780']);
    return JSON.parse(DAILY_JSON) as BridgeResponse;
  }));
  const res = await adapter.fetchL1Daily('801780');
  assert.equal(res.insertedFactIds.length, 2);
  assert.equal(res.rejectedRows.length, 1);
  const before = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: '801780',
    factKind: 'SW_INDEX_BAR',
    asOf: new Date('2021-07-30T06:59:59.000Z'),
  });
  assert.equal(before.length, 1, '截点在 07-30 15:00+08 前只见 07-29');
  const after = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: '801780',
    factKind: 'SW_INDEX_BAR',
    asOf: new Date('2021-07-30T07:00:00.000Z'),
  });
  assert.equal(after.length, 2);
  await assert.rejects(adapter.fetchL1Daily('8017'), (e: unknown) => e instanceof AdapterError);
});

test('fetchL1Component：响应入原件库但不产生事实（派发冻结事实面）', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['l1_component', '801780']);
    return JSON.parse(COMPONENT_JSON) as BridgeResponse;
  }));
  const res = await adapter.fetchL1Component('801780');
  assert.equal(res.insertedFactIds.length, 0);
  assert.equal(res.rowCount, 1);
  await store.readBytes(res.artifact.sha256); // 原件可校验读回
});

test('fetchClassifyXls：XLS 字节即原件（sha 一致），事实含 2014/2021 行', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['classify_xls']);
    return { ...JSON.parse(CLASSIFY_JSON), meta: { sha256: createHash('sha256').update('fake-xls-bytes').digest('hex'),
      bytes: Buffer.byteLength('fake-xls-bytes'), dataRows: 5 } } as BridgeResponse;
  }));
  const res = await adapter.fetchClassifyXls();
  assert.equal(res.rowCount, 5);
  assert.equal(res.insertedFactIds.length, 4);
  assert.equal(res.artifact.mediaType, 'application/vnd.ms-excel');
  const digest = createHash('sha256').update(Buffer.from('fake-xls-bytes')).digest('hex');
  assert.equal(res.artifact.sha256, digest);
  const asOf = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '000001',
    factKind: 'INDUSTRY_CLASS_VERSION',
    asOf: new Date('2021-07-30T16:00:00.000Z'),
  });
  // 截点 = 2021 行 availableAt：三行皆可见（asOf 含边界；链按 validFrom/validTo 区分期）
  assert.equal(asOf.length, 3);
  const current = asOf.filter((f) => f.validTo === null);
  assert.equal(current.length, 1);
  assert.equal((current[0]!.typedValue as Record<string, unknown>)['行业代码'], '480301');
});

test('退避：瞬态错误 3 次尝试（等待逐次加倍）后成功；永久错误不重试', async () => {
  const sleeper: BackoffSleeper & { waits: number[] } = { waits: [], async sleep(ms) { this.waits.push(ms); } };
  let attempts = 0;
  const flaky = fixtureExecutor(() => {
    attempts += 1;
    if (attempts <= 2) throw new TransientAdapterError('SW_QUERY_FAILED', '限流');
    return JSON.parse(L1_LIST_JSON) as BridgeResponse;
  });
  const adapter = new SwAdapter({
    pool, store, execBridge: flaky, now: () => NOW, gate: new ConcurrencyGate(1),
    backoffSleeper: sleeper, backoffBaseDelayMs: 30,
  });
  const res = await adapter.fetchL1List();
  assert.equal(res.insertedFactIds.length + res.identicalFactIds.length, 1);
  assert.deepEqual(sleeper.waits, [30, 60]); // 2 次失败各等待一次，第 3 次成功

  // 注入执行器按 makeSwBridgeExecutor 的语义在桥 !ok 且 USAGE_ERROR 时抛永久错误
  const permanent = fixtureExecutor(() => {
    throw new AdapterError('USAGE_ERROR', '参数错');
  });
  const adapter2 = new SwAdapter({
    pool, store, execBridge: permanent, now: () => NOW, gate: new ConcurrencyGate(1),
    backoffSleeper: recordingSleeper, backoffBaseDelayMs: 30,
  });
  const waitsBefore = recordingSleeper.waits.length;
  await assert.rejects(adapter2.fetchL1List(), (e: unknown) => e instanceof AdapterError && e.code === 'USAGE_ERROR');
  assert.equal(recordingSleeper.waits.length, waitsBefore, '永久错误零等待零重试');
});
