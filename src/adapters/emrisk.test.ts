/**
 * Lyra · 东财风险面适配器单测（P1 W29: code-writer）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-25 容器真实探测：质押 RPT_CSDC_LIST 东财原生字段，
 * 户数 akshare.stock_zh_a_gdhs_detail_em 中文字段），退避用记录式注入睡眠，
 * DB 用本地 lyra-pg 隔离 schema。合同判定：派发 A3/A4（时点口径冻结：质押=快照日+1 保守、
 * 户数=公告披露日+1 保守）、DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2/§3。
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
import { emriskResponse } from './emrisk-test-helper.js';
import {
  EMRISK_ADAPTER_VERSION,
  EmriskAdapter,
  mapHolderRowsToFacts,
  mapPledgeRowsToFacts,
  shanghaiDayStart,
  shanghaiNextDayStart,
  type EmriskMapContext,
  type EmriskRow,
} from './emrisk.js';

// ===== fixture（桥 stdout 形态；字段名与取值形态照真实返回 2026-10-25 实测）=====

const NOW = new Date('2026-10-25T03:00:00.000Z');

/** 质押周度快照两行（600519 实测首行形态 + 换周）+ 1 行缺 TRADE_DATE_ISO。 */
const PLEDGE_ROWS: EmriskRow[] = [
  {
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    SECURITY_NAME_ABBR: '贵州茅台',
    TRADE_DATE: '2014-03-07 00:00:00',
    TRADE_DATE_ISO: '2014-03-07',
    PLEDGE_RATIO: 0.37,
    PLEDGE_DEAL_NUM: 14,
    PLEDGE_MARKET_CAP: 63755.0225,
    REPURCHASE_BALANCE: 385.25,
    REPURCHASE_UNLIMITED_BALANCE: 385.25,
    REPURCHASE_LIMITED_BALANCE: 0,
    INDUSTRY: '白酒Ⅱ',
    INDUSTRY_CODE: '1277',
    PAYYEAR: '2014-03',
    Y1_CLOSE_ADJCHRATE: -3.54827759,
  },
  {
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    SECURITY_NAME_ABBR: '贵州茅台',
    TRADE_DATE: '2014-03-14 00:00:00',
    TRADE_DATE_ISO: '2014-03-14',
    PLEDGE_RATIO: 0.37,
    PLEDGE_DEAL_NUM: 14,
    PLEDGE_MARKET_CAP: 61115.1,
    REPURCHASE_BALANCE: 385.25,
    REPURCHASE_UNLIMITED_BALANCE: 385.25,
    REPURCHASE_LIMITED_BALANCE: 0,
    INDUSTRY: '白酒Ⅱ',
    INDUSTRY_CODE: '1277',
    PAYYEAR: '2014-03',
    Y1_CLOSE_ADJCHRATE: -4.112,
  },
  { TRADE_DATE: '2024-09-20 00:00:00', PLEDGE_RATIO: 0.01 }, // 缡 ISO（桥转换失败形态）→ 具名拒绝
];

/** 股东户数两行（600519 实测首行形态 + 换期）+ 缺公告日期一行。 */
const GDHS_ROWS: EmriskRow[] = [
  {
    股东户数统计截止日: '2013-03-22',
    区间涨跌幅: -19.122572,
    '股东户数-本次': 69331,
    '股东户数-上次': 49870,
    '股东户数-增减': 19461,
    '股东户数-增减比例': 39.023460998596,
    户均持股市值: 2531397.62876635,
    户均持股数量: 14974.2539412384,
    总市值: 175504329000.0,
    总股本: 1038180000,
    股本变动: 0,
    股本变动原因: null,
    股东户数公告日期: '2013-03-29',
    代码: '600519',
    名称: '贵州茅台',
  },
  {
    股东户数统计截止日: '2013-06-30',
    区间涨跌幅: -10.5,
    '股东户数-本次': 65120,
    '股东户数-上次': 69331,
    '股东户数-增减': -4211,
    '股东户数-增减比例': -6.074,
    户均持股市值: 2500000.0,
    户均持股数量: 15000.0,
    总市值: 162800000000.0,
    总股本: 1038180000,
    股本变动: 0,
    股本变动原因: null,
    股东户数公告日期: '2013-07-06',
    代码: '600519',
    名称: '贵州茅台',
  },
  { 股东户数统计截止日: '2013-09-30', '股东户数-本次': 64000, 代码: '600519' }, // 缺公告日期 → 拒绝
];

const CTX: EmriskMapContext = {
  adapterVersion: EMRISK_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('时间辅助：日始与保守 D+1（+08）', () => {
  assert.equal(shanghaiDayStart('2014-03-07'), '2014-03-06T16:00:00.000Z');
  assert.equal(shanghaiNextDayStart('2014-03-07'), '2014-03-07T16:00:00.000Z');
});

test('mapPledgeRowsToFacts：快照口径 availableAt=快照日+1、原始字段保留、缺日期具名拒绝', () => {
  const { facts, rejections } = mapPledgeRowsToFacts('600519', PLEDGE_ROWS, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [{ rowIndex: 2, code: 'EMRISK_PLEDGE_TRADE_DATE_MISSING' }]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'PLEDGE_RATIO');
  assert.equal(first.subjectType, 'STOCK');
  assert.equal(first.subjectId, '600519');
  assert.equal(first.factId.startsWith('emrisk-'), true);
  // 快照口径冻结：availableAt=快照日次日 00:00+08（保守）；eventAt=validFrom=快照日 00:00+08；
  // 快照表无逐行发布时刻 → sourcePublishedAt=null（不编造）。
  assert.equal(first.availableAt, '2014-03-07T16:00:00.000Z');
  assert.equal(first.eventAt, '2014-03-06T16:00:00.000Z');
  assert.equal(first.validFrom, '2014-03-06T16:00:00.000Z');
  assert.equal(first.validTo, null);
  assert.equal(first.sourcePublishedAt, null);
  assert.equal(first.supersedesFactId, null);
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv['PLEDGE_RATIO'], 0.37);
  assert.equal(tv['TRADE_DATE_ISO'], '2014-03-07');
  assert.equal(tv['SECURITY_CODE'], '600519');
  assert.equal(tv['code'], '600519');

  // factId 由原始行内容派生（不含抓取时刻）→ 同行重放同 factId（§6.5 去重前提）
  const again = mapPledgeRowsToFacts('600519', PLEDGE_ROWS, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
  // 不同快照日 → 不同事实身份
  assert.notEqual(facts[0]!.fact.factId, facts[1]!.fact.factId);
});

test('mapHolderRowsToFacts：公告披露口径 availableAt=披露日+1、sourcePublishedAt=披露日', () => {
  const { facts, rejections } = mapHolderRowsToFacts('600519', GDHS_ROWS, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [{ rowIndex: 2, code: 'EMRISK_GDHS_NOTICE_DATE_MISSING' }]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'HOLDER_COUNT');
  assert.equal(first.subjectType, 'STOCK');
  assert.equal(first.subjectId, '600519');
  // 公告披露口径冻结：availableAt=公告披露日次日 00:00+08（日精度保守 D+1，pubDate 同法）；
  // sourcePublishedAt=披露日 00:00+08；eventAt=validFrom=统计截止日 00:00+08。
  assert.equal(first.availableAt, '2013-03-29T16:00:00.000Z');
  assert.equal(first.sourcePublishedAt, '2013-03-28T16:00:00.000Z');
  assert.equal(first.eventAt, '2013-03-21T16:00:00.000Z');
  assert.equal(first.validFrom, '2013-03-21T16:00:00.000Z');
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv['股东户数-本次'], 69331);
  assert.equal(tv['股东户数统计截止日'], '2013-03-22');
  assert.equal(tv['股东户数公告日期'], '2013-03-29');
  assert.equal(tv['code'], '600519');

  // 缺截止日 / 缺本次户数 也具名拒绝（各具名、不混用）
  const r2 = mapHolderRowsToFacts('600519', [{ 股东户数公告日期: '2026-08-15', '股东户数-本次': 1 }], CTX);
  assert.deepEqual(r2.rejections.map((r) => r.code), ['EMRISK_GDHS_END_DATE_MISSING']);
  const r3 = mapHolderRowsToFacts(
    '600519',
    [{ 股东户数统计截止日: '2026-06-30', 股东户数公告日期: '2026-08-15' }],
    CTX,
  );
  assert.deepEqual(r3.rejections.map((r) => r.code), ['EMRISK_GDHS_NUM_MISSING']);
});

test('非法代码：映射与适配器方法均具名拒绝（EMRISK_CODE_INVALID）', () => {
  assert.throws(() => mapPledgeRowsToFacts('60051', [], CTX), (e: unknown) => e instanceof AdapterError);
  assert.throws(() => mapHolderRowsToFacts('sh.600519', [], CTX), (e: unknown) => e instanceof AdapterError);
});

// ===== 适配器（fixture 注入 + 隔离 schema）=====

let admin: Pool;
let pool: Pool;
let schema: string;
let artifactsDir: string;
let store: ArtifactStore;

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => {
    const response = await script(args);
    return response.ok ? emriskResponse(args[0] === 'pledge' ? 'pledge_ratio' : 'holder_count', args[1]!, response.rows ?? []) : response;
  };
}

function mkAdapter(exec: BridgeExecutor, sleeper?: BackoffSleeper, baseDelayMs?: number): EmriskAdapter {
  return new EmriskAdapter({
    pool,
    store,
    execBridge: exec,
    now: () => NOW,
    gate: new ConcurrencyGate(1),
    backoffSleeper: sleeper,
    backoffBaseDelayMs: baseDelayMs,
  });
}

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w29-emrisk-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchPledgeRatio：入库 + as-of 截点过滤（快照日次日 00:00+08 前不可见）+ 重放幂等 + R4 随行', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['pledge', '600519']);
    calls += 1;
    return { ok: true, rows: PLEDGE_ROWS } as BridgeResponse;
  }));
  const r1 = await adapter.fetchPledgeRatio('600519');
  assert.equal(r1.adapterVersion, EMRISK_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emrisk:pledge_ratio:600519');
  assert.equal(r1.rowCount, 3);
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 1);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256); // 原件写入即校验读回
  assert.equal(JSON.parse(new TextDecoder().decode(bytes)).response.rows.length, 3);

  // as-of 截点：availableAt=2014-03-07T16:00Z（快照日+1）；此前不可见，此后可见。
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'PLEDGE_RATIO',
    asOf: new Date('2014-03-07T15:59:59.000Z'),
  });
  assert.equal(before.length, 0, '快照日次日 00:00+08 前不可见');
  const at = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'PLEDGE_RATIO',
    asOf: new Date('2014-03-07T16:00:00.000Z'),
  });
  assert.equal(at.length, 1, 'availableAt 含边界');

  // 重放：同内容同 factId → IDENTICAL（执行器层不缓存）；用不同时钟（firstObservedAt 不同）
  // 证明重放幂等不依赖批次元数据（POINT-IN-TIME §2.1 首见保留，DATA-SOURCES §6.5）。
  const later = new EmriskAdapter({
    pool, store,
    execBridge: fixtureExecutor(() => {
      calls += 1;
      return { ok: true, rows: PLEDGE_ROWS } as BridgeResponse;
    }),
    now: () => new Date(NOW.getTime() + 3_600_000),
    gate: new ConcurrencyGate(1),
  });
  const r2 = await later.fetchPledgeRatio('600519');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2);
  assert.equal(calls, 2);

  await assert.rejects(adapter.fetchPledgeRatio('60051'), (e: unknown) =>
    e instanceof AdapterError && e.code === 'EMRISK_CODE_INVALID');
});

test('fetchHolderCount：入库 + as-of（披露日次日 00:00+08 前不可见）+ 空集如实空原件', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['gdhs', '600519']);
    return { ok: true, rows: GDHS_ROWS } as BridgeResponse;
  }));
  const r1 = await adapter.fetchHolderCount('600519');
  assert.equal(r1.scope, 'emrisk:holder_count:600519');
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 1);

  const before = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'HOLDER_COUNT',
    asOf: new Date('2013-03-29T15:59:59.000Z'),
  });
  assert.equal(before.length, 0, '披露日次日 00:00+08 前不可见');
  const at = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'HOLDER_COUNT',
    asOf: new Date('2013-03-29T16:00:00.000Z'),
  });
  assert.equal(at.length, 1);
  const tv = at[0]!.typedValue as Record<string, unknown>;
  assert.equal(tv['股东户数-本次'], 69331);

  // 空集：rows=[] 如实空原件入档、计 0 事实（pool-financials 冻结口径先例）
  const empty = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] } as BridgeResponse)));
  const r2 = await empty.fetchHolderCount('000938');
  assert.equal(r2.rowCount, 0);
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.rejectedRows.length, 0);
  const bytes = await store.readBytes(r2.artifact.sha256);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).response.rows, []);
});

test('退避：瞬态错误 3 次尝试（等待逐次加倍）后成功；永久错误不重试', async () => {
  const sleeper: BackoffSleeper & { waits: number[] } = { waits: [], async sleep(ms) { this.waits.push(ms); } };
  let attempts = 0;
  const flaky = fixtureExecutor(() => {
    attempts += 1;
    if (attempts <= 2) throw new TransientAdapterError('EMRISK_QUERY_FAILED', '限流');
    return { ok: true, rows: PLEDGE_ROWS.slice(0, 2) } as BridgeResponse;
  });
  const adapter = mkAdapter(flaky, sleeper, 30);
  const res = await adapter.fetchPledgeRatio('600519');
  // 行已在隔离 schema 首测入库 → 本调用第 3 次尝试成功后命中去重（inserted+identical=2 即全部行）
  assert.equal(res.insertedFactIds.length + res.identicalFactIds.length, 2);
  assert.deepEqual(sleeper.waits, [30, 60]); // 2 次失败各等待一次，第 3 次成功

  // 永久错误（USAGE_ERROR，参数/用法错）零等待零重试
  const permanent = fixtureExecutor(() => {
    throw new AdapterError('USAGE_ERROR', '参数错');
  });
  const adapter2 = mkAdapter(permanent, sleeper, 30);
  const waitsBefore = sleeper.waits.length;
  await assert.rejects(adapter2.fetchPledgeRatio('600519'), (e: unknown) =>
    e instanceof AdapterError && e.code === 'USAGE_ERROR');
  assert.equal(sleeper.waits.length, waitsBefore, '永久错误零等待零重试');
});
