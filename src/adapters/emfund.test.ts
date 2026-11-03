/**
 * Lyra · 东财基金面适配器单测（P1 W30: code-writer）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-26 容器真实探测：gmbd 表格解析产物，中文字段名、
 * 值为原样字符串），退避用记录式注入睡眠，DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：派发 A7（季报口径时点冻结：availableAt=季度末+92 天法定披露上界、
 * sourcePublishedAt=null 不编造）、DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2/§3/§4。
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
  EMFUND_ADAPTER_VERSION,
  EmfundAdapter,
  SHARE_DATE_FIELD,
  SHARE_TOTAL_FIELD,
  mapShareRowsToFacts,
  shareAvailableAt,
  shanghaiDayStart,
  type EmfundMapContext,
  type EmfundRow,
} from './emfund.js';

// ===== fixture（桥 stdout 形态；字段名与取值形态照真实返回 2026-10-26 实测）=====

const NOW = new Date('2026-10-26T03:00:00.000Z');

/** gmbd 季度两行（510050 实测列形态；值原样字符串）+ 缺日期一行 + 缺份额一行。 */
const SHARE_ROWS: EmfundRow[] = [
  {
    [SHARE_DATE_FIELD]: '2025-09-30',
    '期间申购（亿份）': '101.96',
    '期间赎回（亿份）': '55.11',
    [SHARE_TOTAL_FIELD]: '577.24',
    '期末净资产（亿元）': '1979.02',
    '净资产变动率': '3.11%',
  },
  {
    [SHARE_DATE_FIELD]: '2025-06-30',
    '期间申购（亿份）': '31.00',
    '期间赎回（亿份）': '22.50',
    [SHARE_TOTAL_FIELD]: '530.28',
    '期末净资产（亿元）': '1919.42',
    '净资产变动率': '-1.10%',
  },
  { [SHARE_TOTAL_FIELD]: '500.00' }, // 缺季度日期 → 具名拒绝
  { [SHARE_DATE_FIELD]: '2025-03-31' }, // 缺期末总份额 → 具名拒绝
];

const CTX: EmfundMapContext = {
  adapterVersion: EMFUND_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('时间辅助：季度末日始与 +92 天法定披露上界（+08）', () => {
  assert.equal(shanghaiDayStart('2025-09-30'), '2025-09-29T16:00:00.000Z');
  // 2025-09-30 + 92 天 = 2025-12-31 00:00+08（覆盖年报 3 个月法定期限的保守上界）
  assert.equal(shareAvailableAt('2025-09-30'), '2025-12-30T16:00:00.000Z');
  // 2025-12-31 + 92 天 = 2026-04-02 00:00+08（≥ 年报 3-31 期限 + 安全边）
  assert.equal(shareAvailableAt('2025-12-31'), '2026-04-01T16:00:00.000Z');
});

test('mapShareRowsToFacts：季报口径 availableAt=季度末+92、字段原样、缺列具名拒绝', () => {
  const { facts, rejections } = mapShareRowsToFacts('510050', SHARE_ROWS, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [
    { rowIndex: 2, code: 'EMFUND_SHARE_DATE_MISSING' },
    { rowIndex: 3, code: 'EMFUND_SHARE_VALUE_MISSING' },
  ]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'ETF_SHARE');
  assert.equal(first.subjectType, 'ETF');
  assert.equal(first.subjectId, '510050');
  assert.equal(first.factId.startsWith('emfund-'), true);
  // 季报口径冻结：availableAt=季度末+92 天 00:00+08（法定披露上界，F10 无逐行披露日不编造）；
  // eventAt=validFrom=季度末 00:00+08；sourcePublishedAt=null。
  assert.equal(first.availableAt, '2025-12-30T16:00:00.000Z');
  assert.equal(first.eventAt, '2025-09-29T16:00:00.000Z');
  assert.equal(first.validFrom, '2025-09-29T16:00:00.000Z');
  assert.equal(first.validTo, null);
  assert.equal(first.sourcePublishedAt, null);
  assert.equal(first.supersedesFactId, null);
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv[SHARE_TOTAL_FIELD], '577.24'); // 原样字符串（来源亿份两位小数精度）
  assert.equal(tv[SHARE_DATE_FIELD], '2025-09-30');
  assert.equal(tv['code'], '510050');

  // factId 由原始行内容派生（不含抓取时刻）→ 同行重放同 factId（§6.5 去重前提）
  const again = mapShareRowsToFacts('510050', SHARE_ROWS, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
  // 不同季度 → 不同事实身份
  assert.notEqual(facts[0]!.fact.factId, facts[1]!.fact.factId);
  // 同行同内容、不同主体 → 不同事实身份
  const other = mapShareRowsToFacts('510300', [SHARE_ROWS[0]!], CTX);
  assert.notEqual(other.facts[0]!.fact.factId, first.factId);
});

test('非法代码：映射与适配器方法均具名拒绝（EMFUND_CODE_INVALID）', () => {
  assert.throws(() => mapShareRowsToFacts('51005', [], CTX), (e: unknown) => e instanceof AdapterError);
  assert.throws(() => mapShareRowsToFacts('sh510050', [], CTX), (e: unknown) => e instanceof AdapterError);
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

function mkAdapter(exec: BridgeExecutor, sleeper?: BackoffSleeper, baseDelayMs?: number): EmfundAdapter {
  return new EmfundAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w30-emfund-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchEtfShare：入库 + as-of 截点过滤（季度末+92 前不可见）+ R4 随行 + 空集如实', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['fund_share', '510050']);
    calls += 1;
    return { ok: true, rows: SHARE_ROWS } as BridgeResponse;
  }));
  const r1 = await adapter.fetchEtfShare('510050');
  assert.equal(r1.adapterVersion, EMFUND_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emfund:etf_share:510050');
  assert.equal(r1.rowCount, 4);
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256); // 原件写入即校验读回
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 4);

  // as-of：早于最早可得（2025-06-30 季 +92 天 = 2025-09-29T16:00Z）不可见；之后可见
  const before = await asOfFacts(pool, {
    subjectType: 'ETF', subjectId: '510050', factKind: 'ETF_SHARE', asOf: new Date('2025-09-29T15:00:00.000Z'),
  });
  assert.equal(before.length, 0);
  const after = await asOfFacts(pool, {
    subjectType: 'ETF', subjectId: '510050', factKind: 'ETF_SHARE', asOf: new Date('2026-06-30T00:00:00.000Z'),
  });
  assert.equal(after.length, 2);
  for (const f of after) {
    assert.equal(f.availableAt, shareAvailableAt(String((f.typedValue as EmfundRow)[SHARE_DATE_FIELD])));
    if (new Date(f.availableAt).getTime() > NOW.getTime()) throw new Error('泄漏：availableAt 在抓取时刻之后');
  }

  // 重放幂等：同 rows 同 adapter 版本 → 全部 IDENTICAL（零新事实、零新调用外网络）
  const r2 = await adapter.fetchEtfShare('510050');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2);
  assert.equal(calls, 2, '每次 fetch 恰一次桥调用（fixture 计数）');

  // 空集：rows=[] 如实空原件入档、0 事实、0 拒绝
  const empty = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] } as BridgeResponse)));
  const r3 = await empty.fetchEtfShare('510500');
  assert.equal(r3.rowCount, 0);
  assert.equal(r3.insertedFactIds.length, 0);
  assert.equal(r3.rejectedRows.length, 0);
  const bytes3 = await store.readBytes(r3.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes3)) as unknown[]).length, 0);
});

test('fetchEtfShare：来源更正接 supersedes 链——不覆盖原件、as-of 链头（当前源视图）胜出', async () => {
  // 口径说明：availableAt 由季度末派生，同季度更正行与原行可得性相同——链头即来源当前视图
  // （F10 可整表重刷，R4 声明覆盖）；更正不覆盖：旧事实原样保留在库（POINT-IN-TIME §4）。
  const v1: EmfundRow = { [SHARE_DATE_FIELD]: '2024-12-31', [SHARE_TOTAL_FIELD]: '570.00' };
  const v2: EmfundRow = { [SHARE_DATE_FIELD]: '2024-12-31', [SHARE_TOTAL_FIELD]: '570.99' }; // 更正
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor(() => {
    const rows = calls === 0 ? [v1] : [v1, v2];
    calls += 1;
    return { ok: true, rows } as BridgeResponse;
  }));

  const r1 = await adapter.fetchEtfShare('512100');
  assert.equal(r1.insertedFactIds.length, 1);
  const oldId = r1.insertedFactIds[0]!;

  // 更正批次：同季度新值 → 新事实接 supersedes；旧行原样保留（不同 factId，不覆盖）
  const r2 = await adapter.fetchEtfShare('512100');
  assert.equal(r2.insertedFactIds.length, 1);
  assert.equal(r2.identicalFactIds.length, 1, '同内容旧行重放为 IDENTICAL');
  const newId = r2.insertedFactIds[0]!;
  assert.notEqual(newId, oldId);

  const loadedNew = await loadFact(pool, newId);
  assert.equal(loadedNew?.supersedesFactId, oldId, '更正事实指向旧事实');
  const loadedOld = await loadFact(pool, oldId);
  assert.ok(loadedOld !== null, '旧事实不覆盖、原样保留');
  assert.equal(loadedOld?.supersedesFactId, null);

  // as-of 上界（2024-12-31+92=2025-04-02 00:00+08）之前：均不可见（保守）
  const early = await asOfFacts(pool, {
    subjectType: 'ETF', subjectId: '512100', factKind: 'ETF_SHARE', asOf: new Date('2025-04-01T00:00:00.000Z'),
  });
  assert.equal(early.length, 0);
  // 上界后：链头胜出，只读回更正值（当前源视图）
  const late = await asOfFacts(pool, {
    subjectType: 'ETF', subjectId: '512100', factKind: 'ETF_SHARE', asOf: new Date('2026-06-01T00:00:00.000Z'),
  });
  assert.equal(late.length, 1);
  assert.equal(late[0]!.factId, newId);
  assert.equal((late[0]!.typedValue as EmfundRow)[SHARE_TOTAL_FIELD], '570.99');
});
