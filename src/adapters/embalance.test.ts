/**
 * Lyra · 东财资产负债表适配器单测（P1 W30: code-writer）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-26 真实探测：东财原生英文字段 + 桥自加 *_ISO 前缀列，
 * NaN 已由桥转 null），退避用记录式注入睡眠，DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：派发 A9（公告披露口径 availableAt=披露日次日 00:00+08、无披露日具名拒绝、
 * typedValue 原样、比率由消费侧计算）、DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2/§3/§4。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { asOfFacts, loadFact } from '../pintime/facts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import { ConcurrencyGate, applyP1Migration, type BackoffSleeper } from './backoff.js';
import { p1RunId, type BridgeExecutor } from './baostock.js';
import {
  BAL_NOTICE_DATE_ISO,
  BAL_REPORT_DATE_ISO,
  EMBALANCE_ADAPTER_VERSION,
  EmbalanceAdapter,
  mapBalanceRowsToFacts,
  shanghaiDayStart,
  shanghaiNextDayStart,
  toEmSymbol,
  type EmbalanceMapContext,
  type EmbalanceRow,
} from './embalance.js';

// ===== fixture（桥 stdout 形态；字段名与取值形态照真实返回 2026-10-26 实测裁剪）=====

const NOW = new Date('2026-10-26T03:00:00.000Z');

/** 两行完整报告期（600519 实测形态：2024 年报 + 2015 一季报，列裁剪为代表集）+ 2 行异常形态。 */
const BALANCE_ROWS: EmbalanceRow[] = [
  {
    REPORT_DATE: '2024-12-31 00:00:00',
    [BAL_REPORT_DATE_ISO]: '2024-12-31',
    NOTICE_DATE: '2025-04-03 00:00:00',
    [BAL_NOTICE_DATE_ISO]: '2025-04-03',
    REPORT_TYPE: '年报',
    REPORT_DATE_NAME: '2024年报',
    CURRENCY: 'CNY',
    GOODWILL: null, // 源无商誉（600519 实测 GOODWILL NaN → 桥转 null）
    TOTAL_ASSETS: 298944579918.7,
    TOTAL_EQUITY: 242011315120.6,
    TOTAL_PARENT_EQUITY: 233105984399.47,
  },
  {
    REPORT_DATE: '2015-03-31 00:00:00',
    [BAL_REPORT_DATE_ISO]: '2015-03-31',
    NOTICE_DATE: '2015-04-21 00:00:00',
    [BAL_NOTICE_DATE_ISO]: '2015-04-21',
    REPORT_TYPE: '一季报',
    REPORT_DATE_NAME: '2015一季报',
    CURRENCY: 'CNY',
    GOODWILL: 435800000, // 有商誉形态（元）
    TOTAL_ASSETS: 68769020638.42,
    TOTAL_EQUITY: 59930148126.96,
    TOTAL_PARENT_EQUITY: 57785581035.92,
  },
  {
    [BAL_REPORT_DATE_ISO]: '2023-12-31',
    GOODWILL: 1000, // 缺披露日 → 具名拒绝（availableAt 不编造）
  },
  {
    REPORT_DATE: '2022-12-31 00:00:00',
    [BAL_NOTICE_DATE_ISO]: '2023-03-15', // 缺报告期 ISO → 具名拒绝
    GOODWILL: 1000,
  },
];

const CTX: EmbalanceMapContext = {
  adapterVersion: EMBALANCE_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('toEmSymbol：主板前缀派生（6→SH，0→SZ）；非主板与非法形态具名拒绝', () => {
  assert.equal(toEmSymbol('600519'), 'SH600519');
  assert.equal(toEmSymbol('000938'), 'SZ000938');
  assert.throws(() => toEmSymbol('300750'), (e: unknown) =>
    e instanceof AdapterError && e.code === 'EMBALANCE_CODE_NOT_MAINBOARD');
  assert.throws(() => toEmSymbol('60051'), (e: unknown) =>
    e instanceof AdapterError && e.code === 'EMBALANCE_CODE_INVALID');
  assert.throws(() => toEmSymbol('sh.600519'), (e: unknown) => e instanceof AdapterError);
});

test('mapBalanceRowsToFacts：公告披露口径 availableAt=披露日+1、字段原样、缺列具名拒绝', () => {
  const { facts, rejections } = mapBalanceRowsToFacts('600519', BALANCE_ROWS, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [
    { rowIndex: 2, code: 'EMBALANCE_NOTICE_DATE_MISSING' },
    { rowIndex: 3, code: 'EMBALANCE_REPORT_DATE_MISSING' },
  ]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'BALANCE');
  assert.equal(first.subjectType, 'STOCK');
  assert.equal(first.subjectId, '600519');
  assert.equal(first.factId.startsWith('embalance-'), true);
  // 公告披露口径冻结（与 FINANCIAL pubDate 同法）：availableAt=披露日次日 00:00+08；
  // sourcePublishedAt=披露日 00:00+08；eventAt=validFrom=报告期 00:00+08。
  assert.equal(first.availableAt, shanghaiNextDayStart('2025-04-03'));
  assert.equal(first.availableAt, '2025-04-03T16:00:00.000Z');
  assert.equal(first.sourcePublishedAt, '2025-04-02T16:00:00.000Z');
  assert.equal(first.eventAt, '2024-12-30T16:00:00.000Z');
  assert.equal(first.validFrom, '2024-12-30T16:00:00.000Z');
  assert.equal(first.validTo, null);
  assert.equal(first.supersedesFactId, null);
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv['GOODWILL'], null, '源无商誉原样保留 null（消费侧算比率处理）');
  assert.equal(tv['TOTAL_PARENT_EQUITY'], 233105984399.47); // 数值原样（单位元）
  assert.equal(tv[BAL_REPORT_DATE_ISO], '2024-12-31');
  assert.equal(tv[BAL_NOTICE_DATE_ISO], '2025-04-03');
  assert.equal(tv['code'], '600519');

  // factId 由原始行内容派生（不含抓取时刻）→ 同行重放同 factId（§6.5 去重前提）
  const again = mapBalanceRowsToFacts('600519', BALANCE_ROWS, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
  // 同行同内容、不同主体 → 不同事实身份
  const other = mapBalanceRowsToFacts('600036', [BALANCE_ROWS[0]!], CTX);
  assert.notEqual(other.facts[0]!.fact.factId, first.factId);
  assert.equal(shanghaiDayStart('2015-03-31'), '2015-03-30T16:00:00.000Z');
});

// ===== 适配器（fixture 注入 + 隔离 schema）=====

let admin: Pool;
let pool: Pool;
let schema: string;
let artifactsDir: string;
let store: ArtifactStore;

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => script(args);
}

function mkAdapter(exec: BridgeExecutor, sleeper?: BackoffSleeper, baseDelayMs?: number): EmbalanceAdapter {
  return new EmbalanceAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w30-embalance-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchBalanceSheet：入库 + as-of 披露日次日过滤 + R4 随行 + 空集如实', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['balance', 'SH600519']);
    calls += 1;
    return { ok: true, rows: BALANCE_ROWS } as BridgeResponse;
  }));
  const r1 = await adapter.fetchBalanceSheet('600519');
  assert.equal(r1.adapterVersion, EMBALANCE_ADAPTER_VERSION);
  assert.equal(r1.scope, 'embalance:balance_sheet:600519');
  assert.equal(r1.rowCount, 4);
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 4);

  // as-of：早于最早可得（2015 一季报披露日+1 = 2015-04-21T16:00Z）不可见；之后可见
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'BALANCE', asOf: new Date('2015-04-21T15:00:00.000Z'),
  });
  assert.equal(before.length, 0);
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'BALANCE', asOf: new Date('2026-06-30T00:00:00.000Z'),
  });
  assert.equal(after.length, 2);
  for (const f of after) {
    const iso = (f.typedValue as EmbalanceRow)[BAL_NOTICE_DATE_ISO] as string;
    assert.equal(f.availableAt, shanghaiNextDayStart(iso));
    if (new Date(f.availableAt).getTime() > NOW.getTime()) throw new Error('泄漏：availableAt 在抓取时刻之后');
  }

  // 重放幂等：同 rows → 全部 IDENTICAL
  const r2 = await adapter.fetchBalanceSheet('600519');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2);
  assert.equal(calls, 2);

  // 空集：rows=[] 如实空原件入档、0 事实、0 拒绝
  const empty = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] } as BridgeResponse)));
  const r3 = await empty.fetchBalanceSheet('600036');
  assert.equal(r3.rowCount, 0);
  assert.equal(r3.insertedFactIds.length, 0);
  const bytes3 = await store.readBytes(r3.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes3)) as unknown[]).length, 0);
});

test('fetchBalanceSheet：更正报表接 supersedes 链——更正值按更晚披露日可得，链头胜出', async () => {
  const v1: EmbalanceRow = {
    REPORT_DATE: '2021-12-31 00:00:00',
    [BAL_REPORT_DATE_ISO]: '2021-12-31',
    NOTICE_DATE: '2022-03-15 00:00:00',
    [BAL_NOTICE_DATE_ISO]: '2022-03-15',
    GOODWILL: 1000000,
    TOTAL_PARENT_EQUITY: 50000000000,
  };
  // 更正报表：同报告期、更晚披露日、更正值
  const v2: EmbalanceRow = {
    REPORT_DATE: '2021-12-31 00:00:00',
    [BAL_REPORT_DATE_ISO]: '2021-12-31',
    NOTICE_DATE: '2022-08-10 00:00:00',
    [BAL_NOTICE_DATE_ISO]: '2022-08-10',
    GOODWILL: 900000,
    TOTAL_PARENT_EQUITY: 50000000000,
  };
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor(() => {
    const rows = calls === 0 ? [v1] : [v1, v2];
    calls += 1;
    return { ok: true, rows } as BridgeResponse;
  }));

  const r1 = await adapter.fetchBalanceSheet('000657');
  assert.equal(r1.insertedFactIds.length, 1);
  const oldId = r1.insertedFactIds[0]!;

  const r2 = await adapter.fetchBalanceSheet('000657');
  assert.equal(r2.insertedFactIds.length, 1);
  assert.equal(r2.identicalFactIds.length, 1);
  const newId = r2.insertedFactIds[0]!;
  assert.notEqual(newId, oldId);

  const loadedNew = await loadFact(pool, newId);
  assert.equal(loadedNew?.supersedesFactId, oldId, '更正事实指向旧事实');

  // 更正披露次日之前（两披露之间）：仍读回原值（原披露口径）
  const mid = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '000657', factKind: 'BALANCE', asOf: new Date('2022-06-01T00:00:00.000Z'),
  });
  assert.equal(mid.length, 1);
  assert.equal(mid[0]!.factId, oldId);
  assert.equal((mid[0]!.typedValue as EmbalanceRow)['GOODWILL'], 1000000);
  // 更正披露次日之后：链头胜出，读回更正值
  const late = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '000657', factKind: 'BALANCE', asOf: new Date('2023-01-01T00:00:00.000Z'),
  });
  assert.equal(late.length, 1);
  assert.equal(late[0]!.factId, newId);
  assert.equal((late[0]!.typedValue as EmbalanceRow)['GOODWILL'], 900000);
});
