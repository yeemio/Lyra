/**
 * Lyra · 两融/龙虎榜适配器单测（P2 W28: code-writer-pro）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-25 真实探测返回，var/w28-probe.py），
 * 退避用记录式注入睡眠，DB 用本地 lyra-pg 隔离 schema。合同判定：派发冻结
 * （factKind MARGIN_BALANCE/DRAGON_TIGER、availableAt 口径、subjectId 裸码 R24）、
 * DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2（as-of 截点过滤）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  EMDC_ADAPTER_VERSION,
  EmdcAdapter,
  LHB_FORWARD_LOOKING_COLUMNS,
  LHB_REVISION_NOTICE,
  MARGIN_REVISION_NOTICE,
  compactToIso,
  mapLhbRowsToFacts,
  mapMarginRowsToFacts,
  toCompactDate,
  type EmdcRow,
} from './emdc.js';

// ===== fixture（字段名与取值形态照 2026-10-25 真实探测）=====

const NOW = new Date('2026-10-25T05:00:00.000Z');

/** SSE 2026-10-21 实测形态：600519（池内 sh 股）+ 510050（ETF）+ 非法行 ×2。 */
const MARGIN_SSE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 信用交易日期: '20261021', 标的证券代码: '600519', 标的证券简称: '贵州茅台', 融资余额: 15_000_000_000, 融资买入额: 200_000_000, 融资偿还额: 180_000_000, 融券余量: 33_509_040, 融券卖出量: 323_900, 融券偿还量: 524_200 },
    { 信用交易日期: '20261021', 标的证券代码: '510050', 标的证券简称: '50ETF', 融资余额: 1_567_824_434, 融资买入额: 151_258_886, 融资偿还额: 134_089_820, 融券余量: 33_509_040, 融券卖出量: 323_900, 融券偿还量: 524_200 },
    { 信用交易日期: '20261021', 标的证券代码: '', 标的证券简称: '坏行', 融资余额: 1 },
    { 信用交易日期: '2026-10-21', 标的证券代码: '600519', 标的证券简称: '日期形态坏行', 融资余额: 1 },
  ],
});

/** SZSE 2026-10-21 实测形态（无日期列，桥回填 信用交易日期）：000938（池内 sz 股）+ 300750（创业板非池）。 */
const MARGIN_SZSE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 信用交易日期: '20261021', 证券代码: '000938', 证券简称: '紫光股份', 融资买入额: 55_083_323, 融资余额: 4_275_048_513, 融券卖出量: 38_100, 融券余量: 16_031_737, 融券余额: 182_922_120, 融资融券余额: 4_457_970_633 },
    { 信用交易日期: '20261021', 证券代码: '300750', 证券简称: '宁德时代', 融资买入额: 1, 融资余额: 2, 融券卖出量: 3, 融券余量: 4, 融券余额: 5, 融资融券余额: 6 },
  ],
});

/** 东财 LHB 实测形态：600519 池内上榜行 + 000011 非池行 + 非法行。 */
const LHB_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 序号: 1, 代码: '600519', 名称: '贵州茅台', 上榜日: '2026-10-21', 解读: '2家机构卖出，成功率21.14%', 收盘价: 1500.0, 涨跌幅: -9.9638, 龙虎榜净买额: -12_851_723.21, 龙虎榜买入额: 74_667_015.0, 龙虎榜卖出额: 87_518_740.0, 龙虎榜成交额: 162_185_800.0, 市场总成交额: 778_883_100.0, 净买额占总成交比: -1.650020, 成交额占总成交比: 20.822862, 换手率: 13.7342, 流通市值: 5_434_631_000.0, 上榜原因: '日振幅值达到15%的前5只证券', 上榜后1日: 3.118712, 上榜后2日: null, 上榜后5日: null, 上榜后10日: null },
    { 序号: 2, 代码: '000011', 名称: '深物业A', 上榜日: '2026-10-22', 解读: 'x', 收盘价: 9.94, 涨跌幅: -9.9638, 龙虎榜净买额: -1.0, 上榜原因: '日跌幅偏离值达到7%的前5只证券', 上榜后1日: null },
    { 序号: 3, 代码: 'ABC', 名称: '坏行', 上榜日: '2026-10-22', 上榜原因: 'x' },
  ],
});

const POOL = new Set(['600519', '510050', '000938']);

// ===== 纯函数：映射 =====

const CTX = { adapterVersion: EMDC_ADAPTER_VERSION, fetchedAt: NOW.toISOString(), artifactSha256: 'a'.repeat(64) };

test('toCompactDate / compactToIso：往返与非法形态', () => {
  assert.equal(toCompactDate('2026-10-21'), '20261021');
  assert.equal(compactToIso('20261021'), '2026-10-21');
  assert.equal(compactToIso('20261099'), null, '非法月日拒绝');
  assert.throws(() => toCompactDate('20261021'), AdapterError);
});

test('mapMarginRowsToFacts：SSE 行 → MARGIN_BALANCE（availableAt=15:00+08，subject 裸码归类）', () => {
  const rows = (JSON.parse(MARGIN_SSE_JSON) as { rows: EmdcRow[] }).rows;
  const mapped = mapMarginRowsToFacts(rows, 'sse', CTX);
  assert.equal(mapped.facts.length, 2, '两行有效（600519/510050）');
  assert.equal(mapped.rejections.length, 2, '空代码行 + 非紧凑日期行具名拒绝');
  assert.equal(mapped.filteredOut, 0, '无过滤');
  const stock = mapped.facts[0]!;
  assert.equal(stock.fact.subjectType, 'STOCK');
  assert.equal(stock.fact.subjectId, '600519');
  assert.equal(stock.fact.factKind, 'MARGIN_BALANCE');
  const expectAt = new Date('2026-10-21T15:00:00+08:00').toISOString();
  assert.equal(stock.fact.availableAt, expectAt);
  assert.equal(stock.fact.eventAt, expectAt);
  assert.equal(stock.fact.validFrom, expectAt);
  assert.equal(stock.fact.supersedesFactId, null);
  const tv = stock.fact.typedValue as Record<string, unknown>;
  assert.equal(tv['code'], 'sh.600519');
  assert.equal(tv['exchange'], 'sse');
  assert.equal(tv['融资余额'], 15_000_000_000, '来源字段原样');
  const etf = mapped.facts[1]!;
  assert.equal(etf.fact.subjectType, 'ETF', '510050 归类 ETF（同 BaoStock/新浪键）');
  assert.equal(etf.fact.subjectId, '510050');
});

test('mapMarginRowsToFacts：SZSE 行（桥回填日期）+ subjectFilter 过滤显式计数', () => {
  const rows = (JSON.parse(MARGIN_SZSE_JSON) as { rows: EmdcRow[] }).rows;
  const noFilter = mapMarginRowsToFacts(rows, 'szse', CTX);
  assert.equal(noFilter.facts.length, 2);
  assert.equal(noFilter.facts[0]!.fact.subjectType, 'STOCK');
  assert.equal(noFilter.facts[0]!.fact.subjectId, '000938');
  const tv = noFilter.facts[0]!.fact.typedValue as Record<string, unknown>;
  assert.equal(tv['code'], 'sz.000938');
  assert.equal(tv['tradeDateISO'], '2026-10-21');
  const filtered = mapMarginRowsToFacts(rows, 'szse', CTX, POOL);
  assert.equal(filtered.facts.length, 1, '300750 非池被过滤');
  assert.equal(filtered.filteredOut, 1, '过滤计数显式（不静默）');
});

test('mapLhbRowsToFacts：DRAGON_TIGER（availableAt=上榜日15:00+08，前视列标记，objectKey=日:原因）', () => {
  const rows = (JSON.parse(LHB_JSON) as { rows: EmdcRow[] }).rows;
  const mapped = mapLhbRowsToFacts(rows, CTX, POOL);
  assert.equal(mapped.facts.length, 1, '000011 非池被过滤');
  assert.equal(mapped.filteredOut, 1);
  assert.equal(mapped.rejections.length, 1, '非 6 位代码行拒绝');
  const f = mapped.facts[0]!;
  assert.equal(f.fact.subjectType, 'STOCK');
  assert.equal(f.fact.subjectId, '600519');
  assert.equal(f.fact.factKind, 'DRAGON_TIGER');
  assert.equal(f.fact.availableAt, new Date('2026-10-21T15:00:00+08:00').toISOString());
  assert.equal(f.objectKey, '2026-10-21:日振幅值达到15%的前5只证券');
  const tv = f.fact.typedValue as Record<string, unknown>;
  assert.deepEqual(tv['forwardLookingColumns'], LHB_FORWARD_LOOKING_COLUMNS, '前视列显式标记');
  assert.equal(tv['code'], 'sh.600519');
  assert.equal(tv['上榜后1日'], 3.118712, '来源前视列原样保留（原件忠实）');
});

test('factId 不含观察时刻：同行不同 fetchedAt → 同 factId（终局窗口去重）', () => {
  const rows = (JSON.parse(MARGIN_SZSE_JSON) as { rows: EmdcRow[] }).rows;
  const a = mapMarginRowsToFacts(rows, 'szse', CTX);
  const b = mapMarginRowsToFacts(rows, 'szse', {
    ...CTX,
    fetchedAt: new Date('2026-10-26T05:00:00.000Z').toISOString(),
  });
  assert.equal(a.facts[0]!.fact.factId, b.facts[0]!.fact.factId);
});

// ===== 适配器（隔离 schema + fixture 桥 + tmpdir 原件）=====

let admin: Pool;
let schema: string;
let pool: Pool;
let store: ArtifactStore;
let artifactsDir: string;

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => script(args);
}

function mkAdapter(exec: BridgeExecutor, opts: { sleeper?: BackoffSleeper; now?: () => Date } = {}): EmdcAdapter {
  return new EmdcAdapter({
    pool,
    store,
    execBridge: exec,
    now: opts.now ?? (() => NOW),
    gate: new ConcurrencyGate(1),
    ...(opts.sleeper !== undefined ? { backoffSleeper: opts.sleeper } : {}),
    backoffAttempts: 3,
    backoffBaseDelayMs: 1,
  });
}

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w28-emdc-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchMarginDetail(sse)：入库 + 原件可校验读回 + 重放幂等 + 声明随行 + 过滤计数', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['margin_sse', '20261021'], '桥参数为子命令+紧凑日期');
    calls += 1;
    return JSON.parse(MARGIN_SSE_JSON) as BridgeResponse;
  }));
  const filter = new Set(['600519']);
  const r1 = await adapter.fetchMarginDetail('sse', '2026-10-21', filter);
  assert.equal(r1.adapterVersion, EMDC_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emdc:margin_sse:20261021');
  assert.equal(r1.rowCount, 4, 'rowCount 为桥返回全量行数（不受过滤影响）');
  assert.equal(r1.insertedFactIds.length, 1, '只入池内 600519');
  assert.equal(r1.filteredOut, 1, '510050 非过滤集被计出');
  assert.equal(r1.rejectedRows.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  assert.ok(r1.notices.includes(MARGIN_REVISION_NOTICE), '两融面注记随行');
  const bytes = await store.readBytes(r1.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 4, '原件全量入库');
  const r2 = await adapter.fetchMarginDetail('sse', '2026-10-21', filter);
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 1, '§6.5 同键同值去重');
  assert.equal(calls, 2);
});

test('fetchMarginDetail(sse)：跨次观察重放（不同 fetchedAt/artifact）不冲突，先写为准', async () => {
  // 回填真实场景：smoke/前次回填已入同 factId（终局窗口身份），重抓 firstObservedAt 与
  // artifact 不同——按先写为准计 identical，不抛 FACT_CONFLICT（sina DAILY_BAR_SINA 先例）。
  const filter = new Set(['510050']);
  const first = mkAdapter(fixtureExecutor(() => JSON.parse(MARGIN_SSE_JSON) as BridgeResponse));
  const r1 = await first.fetchMarginDetail('sse', '2026-10-22', filter);
  assert.equal(r1.insertedFactIds.length, 1, '510050 该日首插');
  const later = new Date('2026-10-26T08:00:00.000Z');
  const second = mkAdapter(fixtureExecutor(() => JSON.parse(MARGIN_SSE_JSON) as BridgeResponse), {
    now: () => later,
  });
  const r2 = await second.fetchMarginDetail('sse', '2026-10-22', filter);
  assert.equal(r2.insertedFactIds.length, 0, '同 factId 已存在 → 不再插入');
  assert.equal(r2.identicalFactIds.length, 1, '先写为准计 identical');
});

test('fetchMarginDetail(szse)：as-of 截点过滤（15:00+08 前不可见，无泄漏）', async () => {
  const adapter = mkAdapter(fixtureExecutor(() => JSON.parse(MARGIN_SZSE_JSON) as BridgeResponse));
  const res = await adapter.fetchMarginDetail('szse', '2026-10-21', new Set(['000938']));
  assert.equal(res.insertedFactIds.length, 1);
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '000938',
    factKind: 'MARGIN_BALANCE',
    asOf: new Date('2026-10-21T06:59:59.000Z'), // 14:59:59+08
  });
  assert.equal(before.length, 0, '截点在交易日 15:00+08 前不可见');
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '000938',
    factKind: 'MARGIN_BALANCE',
    asOf: new Date('2026-10-21T07:00:00.000Z'), // 15:00:00+08
  });
  assert.equal(after.length, 1);
});

test('fetchLhbDetail：入库 + as-of 读取 + LHB 注记 + 日期区间校验', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['lhb_detail', '20261020', '20261024']);
    return JSON.parse(LHB_JSON) as BridgeResponse;
  }));
  const res = await adapter.fetchLhbDetail('2026-10-20', '2026-10-24', POOL);
  assert.equal(res.scope, 'emdc:lhb_detail:20261020-20261024');
  assert.equal(res.insertedFactIds.length, 1);
  assert.equal(res.filteredOut, 1);
  assert.ok(res.notices.includes(LHB_REVISION_NOTICE), '前视列/公布时刻注记随行');
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DRAGON_TIGER',
    asOf: new Date('2026-10-21T06:59:59.000Z'),
  });
  assert.equal(before.length, 0, '上榜日 15:00+08 前不可见');
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DRAGON_TIGER',
    asOf: new Date('2026-10-21T07:00:00.000Z'),
  });
  assert.equal(after.length, 1);
  await assert.rejects(adapter.fetchLhbDetail('2026-10-24', '2026-10-20'), (e: unknown) => e instanceof AdapterError);
});

test('桥错误分类：USAGE_ERROR 永久不重试；瞬态错误退避重试后成功', async () => {
  // ok=false → 具名错误的分类在真实桥执行器（makeEmdcBridgeExecutor）内完成（sw 冻结形态）；
  // 此处注入已分类的抛错执行器，验证适配器层不重试永久错误。
  let usageCalls = 0;
  const usageAdapter = mkAdapter(async () => {
    usageCalls += 1;
    throw new AdapterError('USAGE_ERROR', '参数错');
  });
  await assert.rejects(usageAdapter.fetchMarginDetail('sse', '2026-10-21'), (e: unknown) => e instanceof AdapterError && !(e instanceof TransientAdapterError));
  assert.equal(usageCalls, 1, '永久错误不重试');

  const waits: number[] = [];
  let attempts = 0;
  const flakyExec: BridgeExecutor = async () => {
    attempts += 1;
    if (attempts < 3) throw new TransientAdapterError('EMDC_QUERY_FAILED', '瞬态');
    return JSON.parse(MARGIN_SZSE_JSON) as BridgeResponse;
  };
  const flaky = mkAdapter(flakyExec, { sleeper: { async sleep(ms) { waits.push(ms); } } });
  const res = await flaky.fetchMarginDetail('szse', '2026-10-21');
  assert.equal(res.insertedFactIds.length >= 0, true);
  assert.equal(attempts, 3, '第 3 次尝试成功');
  assert.deepEqual(waits, [1, 2], '等待序列逐次加倍（注入基线 1ms）');
});

test('桥 stdout 不可解析 → 瞬态错误退避耗尽 → 暂停（第 4 次不发起）', async () => {
  let transientThrows = 0;
  const transientExec: BridgeExecutor = async () => {
    transientThrows += 1;
    throw new TransientAdapterError('EMDC_BRIDGE_OUTPUT_INVALID', 'stdout 不可解析');
  };
  const pausing = mkAdapter(transientExec, { sleeper: { async sleep() {} } });
  await assert.rejects(pausing.fetchLhbDetail('2026-10-20', '2026-10-24'), (e: unknown) => {
    return e instanceof Error && e.name === 'AdapterPauseError';
  });
  assert.equal(transientThrows, 3, '3 次尝试耗尽后暂停上报（第 4 次不发起）');
});
