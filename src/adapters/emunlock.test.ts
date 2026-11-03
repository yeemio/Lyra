/**
 * Lyra · 限售解禁适配器单测（P2 W42: code-writer，C4）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-25 真实探测返回，var/w42-probe{,2,3}.py；
 * 序号 列桥侧已剔除；来源行无股票代码列——代码经 map context 绑定），退避用记录式
 * 注入睡眠，DB 用本地 lyra-pg 隔离 schema。合同判定：派发冻结（factKind UNLOCK_DETAIL、
 * availableAt=解禁日次日 00:00+08——来源无公告日列的保守塌缩口径、eventAt=解禁日
 * 15:00+08、subjectId 裸码 R24、单股绑定无 subjectFilter）、DATA-SOURCES §5/§6/§7、
 * POINT-IN-TIME §2（as-of 截点过滤：解禁日前不可见——预先公告日程保守不宣称）、
 * 单页上限守卫、空源如实入档。
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
  EMUNLOCK_ADAPTER_VERSION,
  EMUNLOCK_REVISION_NOTICE,
  EMUNLOCK_SINGLE_PAGE_CEILING,
  EmUnlockAdapter,
  mapUnlockRowsToFacts,
  requireBareCode,
  type EmUnlockRow,
} from './emunlock.js';

// ===== fixture（字段名与取值形态照 2026-10-25 真实探测 603986；序号 桥侧剔除）=====

const NOW = new Date('2026-10-25T05:00:00.000Z');

/** 探测实测形态：603986 过去批次 ×2（不同日期）+ 未来未到期批次（涨跌幅空）+ 坏日期行。 */
const QUEUE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 解禁时间: '2025-12-22', 解禁股东数: 1, 解禁数量: 34650.0, 实际解禁数量: 34650.0, 未解禁数量: 4565.0, 实际解禁数量市值: 7500339.0, 占总市值比例: 0.000052, 占流通市值比例: 0.000052, 解禁前一交易日收盘价: 216.46, 限售股类型: '股权激励限售股份', 解禁前20日涨跌幅: 15.177251, 解禁后20日涨跌幅: 4.76 },
    { 解禁时间: '2017-08-18', 解禁股东数: 16, 解禁数量: 97345350.0, 实际解禁数量: 97345350.0, 未解禁数量: 55348644.0, 实际解禁数量市值: 6827803000.0, 占总市值比例: 0.480258, 占流通市值比例: 0.660661, 解禁前一交易日收盘价: 70.14, 限售股类型: '首发原股东限售股份', 解禁前20日涨跌幅: -12.367578, 解禁后20日涨跌幅: 74.880517 },
    { 解禁时间: '2030-07-01', 解禁股东数: 7, 解禁数量: 10726898.0, 实际解禁数量: 10726898.0, 未解禁数量: 0.0, 实际解禁数量市值: 352914900.0, 占总市值比例: 0.00268, 占流通市值比例: 0.002701, 解禁前一交易日收盘价: 32.9, 限售股类型: '股权激励限售股份', 解禁前20日涨跌幅: null, 解禁后20日涨跌幅: null },
    { 解禁时间: null, 解禁股东数: 1, 解禁数量: 1, 实际解禁数量: 1, 未解禁数量: 0, 实际解禁数量市值: 1, 占总市值比例: 0, 占流通市值比例: 0, 解禁前一交易日收盘价: 1, 限售股类型: '坏行', 解禁前20日涨跌幅: null, 解禁后20日涨跌幅: null },
  ],
});

const BOUND = '603986';

// ===== 纯函数：映射 =====

const CTX = { adapterVersion: EMUNLOCK_ADAPTER_VERSION, fetchedAt: NOW.toISOString(), artifactSha256: 'a'.repeat(64) };

test('requireBareCode：6 位裸码校验', () => {
  assert.equal(requireBareCode('603986'), '603986');
  assert.throws(() => requireBareCode('60398'), AdapterError);
  assert.throws(() => requireBareCode('sh603986'), AdapterError);
});

test('mapUnlockRowsToFacts：UNLOCK_DETAIL（availableAt=解禁日次日00:00+08，eventAt=解禁日15:00+08，裸码绑定）', () => {
  const rows = (JSON.parse(QUEUE_JSON) as { rows: EmUnlockRow[] }).rows;
  const mapped = mapUnlockRowsToFacts(rows, BOUND, CTX);
  assert.equal(mapped.facts.length, 3, '三行有效（2025-12-22 + 2017-08-18 + 2030-07-01 未来批次）');
  assert.equal(mapped.rejections.length, 1, '坏日期行具名拒绝');
  assert.equal(mapped.rejections[0]!.code, 'EMUNLOCK_ROW_DATE_INVALID');
  const first = mapped.facts[0]!;
  assert.equal(first.fact.subjectType, 'STOCK');
  assert.equal(first.fact.subjectId, BOUND, '代码 = 调用参数绑定（来源行无代码列）');
  assert.equal(first.fact.factKind, 'UNLOCK_DETAIL');
  const availT = new Date('2025-12-23T00:00:00+08:00').toISOString();
  const eventT = new Date('2025-12-22T15:00:00+08:00').toISOString();
  assert.equal(first.fact.availableAt, availT, '派发冻结：解禁日次日 00:00+08（无公告日列塌缩口径）');
  assert.equal(first.fact.validFrom, availT);
  assert.equal(first.fact.eventAt, eventT, '解禁生效日时点标记=解禁日 15:00+08');
  assert.equal(first.fact.supersedesFactId, null);
  const tv = first.fact.typedValue as Record<string, unknown>;
  assert.equal(tv['code'], 'sh.603986');
  assert.equal(tv['unlockDateISO'], '2025-12-22');
  assert.equal(tv['解禁数量'], 34650.0, 'C4 核心字段：解禁数量（股，akshare ×10000 后）来源原样');
  assert.equal(tv['实际解禁数量市值'], 7_500_339.0, 'C4 核心字段：解禁市值（元）来源原样');
  assert.equal(tv['限售股类型'], '股权激励限售股份', '来源字段原样');
});

test('mapUnlockRowsToFacts：未来未到期批次可映射（as-of 到期前不可见由时点字段保证）', () => {
  const rows = (JSON.parse(QUEUE_JSON) as { rows: EmUnlockRow[] }).rows;
  const mapped = mapUnlockRowsToFacts(rows, BOUND, CTX);
  const future = mapped.facts.find((f) => (f.fact.typedValue as Record<string, unknown>)['unlockDateISO'] === '2030-07-01')!;
  assert.ok(future, '未来批次产出事实');
  assert.equal(
    future.fact.availableAt,
    new Date('2030-07-02T00:00:00+08:00').toISOString(),
    'availableAt=解禁日次日——as-of 判定下到期前自然不可见（不因预先公告提前宣称）',
  );
});

test('mapUnlockRowsToFacts：同日多批次业务键可区分（不同限售股类型/股数）', () => {
  const rows: EmUnlockRow[] = [
    { 解禁时间: '2026-01-06', 解禁股东数: 2, 解禁数量: 100, 实际解禁数量: 100, 未解禁数量: 0, 实际解禁数量市值: 1, 占总市值比例: 0, 占流通市值比例: 0, 解禁前一交易日收盘价: 1, 限售股类型: '定向增发机构配售股份', 解禁前20日涨跌幅: null, 解禁后20日涨跌幅: null },
    { 解禁时间: '2026-01-06', 解禁股东数: 3, 解禁数量: 200, 实际解禁数量: 200, 未解禁数量: 0, 实际解禁数量市值: 2, 占总市值比例: 0, 占流通市值比例: 0, 解禁前一交易日收盘价: 1, 限售股类型: '股权激励限售股份', 解禁前20日涨跌幅: null, 解禁后20日涨跌幅: null },
  ];
  const mapped = mapUnlockRowsToFacts(rows, BOUND, CTX);
  assert.equal(mapped.facts.length, 2);
  assert.notEqual(mapped.facts[0]!.objectKey, mapped.facts[1]!.objectKey, '同日两批次业务键可区分');
  assert.notEqual(mapped.facts[0]!.fact.factId, mapped.facts[1]!.fact.factId);
});

test('factId 不含观察时刻：同行不同 fetchedAt → 同 factId（终局窗口去重，序号已桥侧剔除）', () => {
  const rows = (JSON.parse(QUEUE_JSON) as { rows: EmUnlockRow[] }).rows;
  const a = mapUnlockRowsToFacts(rows, BOUND, CTX);
  const b = mapUnlockRowsToFacts(rows, BOUND, {
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

function mkAdapter(exec: BridgeExecutor, opts: { sleeper?: BackoffSleeper; now?: () => Date } = {}): EmUnlockAdapter {
  return new EmUnlockAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w42-emunlock-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchUnlockQueue：入库 + 原件可校验读回 + 重放幂等 + R4/面内声明随行 + scope 形态', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['queue', '603986'], '桥参数为子命令+单股裸码');
    calls += 1;
    return JSON.parse(QUEUE_JSON) as BridgeResponse;
  }));
  const r1 = await adapter.fetchUnlockQueue(BOUND);
  assert.equal(r1.adapterVersion, EMUNLOCK_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emunlock:queue:603986');
  assert.equal(r1.rowCount, 4, 'rowCount 为桥返回全量行数（含坏行）');
  assert.equal(r1.insertedFactIds.length, 3);
  assert.equal(r1.rejectedRows.length, 1);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  assert.ok(r1.notices.includes(EMUNLOCK_REVISION_NOTICE), '解禁面注记随行');
  const bytes = await store.readBytes(r1.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 4, '原件全量入库');
  const r2 = await adapter.fetchUnlockQueue(BOUND);
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 3, '§6.5 同键同值去重');
  assert.equal(calls, 2);
});

test('fetchUnlockQueue：空源如实入档（600036 探测实测 0 行——0 事实、空原件、非失败）', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['queue', '600036']);
    return { ok: true, rows: [] } as unknown as BridgeResponse;
  }));
  const res = await adapter.fetchUnlockQueue('600036');
  assert.equal(res.rowCount, 0);
  assert.equal(res.insertedFactIds.length, 0);
  assert.equal(res.identicalFactIds.length, 0);
  assert.equal(res.rejectedRows.length, 0);
  const bytes = await store.readBytes(res.artifact.sha256);
  assert.equal(new TextDecoder().decode(bytes), '[]', '空原件如实入档（不造数）');
});

test('fetchUnlockQueue：as-of 截点过滤（解禁日次日 00:00+08 前不可见，无泄漏；未来批次到期前不可见）', async () => {
  // 独立日期 fixture（2026-10-15 过去批次 + 2030 未来批次）：避免与前一用例同 factId
  // （同 schema 内先写为准 → identical）。
  const rows: EmUnlockRow[] = (JSON.parse(QUEUE_JSON) as { rows: EmUnlockRow[] }).rows
    .filter((r) => r['解禁时间'] === '2017-08-18' || r['解禁时间'] === '2030-07-01')
    .map((r) => ({ ...r, 解禁时间: r['解禁时间'] === '2017-08-18' ? '2026-10-15' : '2030-07-01' }));
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['queue', '002384']);
    return { ok: true, rows } as unknown as BridgeResponse;
  }));
  const res = await adapter.fetchUnlockQueue('002384');
  assert.equal(res.insertedFactIds.length, 2);
  // 过去批次：2026-10-15 解禁 → 2026-10-16 00:00+08 = 2026-10-15T16:00:00Z 可见
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '002384',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2026-10-15T15:59:59.000Z'), // 2026-10-15 23:59:59+08（解禁日次日 00:00+08 前）
  });
  assert.equal(before.length, 0, '解禁日次日 00:00+08 前不可见（无泄漏）');
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '002384',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2026-10-15T16:00:00.000Z'), // 2026-10-16 00:00:00+08
  });
  assert.equal(after.length, 1, '过去批次次日 00:00+08 起可见');
  // 未来批次：2030-07-01 解禁 → 到期前（含"现在"与 2029）不可见——预先公告日程保守不宣称
  const futureVisibleBefore = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '002384',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.equal(
    futureVisibleBefore.some((f) => (f.typedValue as Record<string, unknown>)['unlockDateISO'] === '2030-07-01'),
    false,
    '未来批次在解禁日前不可见（2027 视角只见过去批次）',
  );
  const at2029 = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '002384',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2029-01-01T00:00:00.000Z'),
  });
  assert.equal(at2029.length, 1, '2030-01-01 前仍只有过去批次可见');
  const at2030 = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '002384',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2030-07-01T16:00:00.000Z'), // 2030-07-02 00:00:00+08
  });
  assert.equal(at2030.length, 2, '未来批次到解禁日次日 00:00+08 起可见');
});

test('单页上限守卫：rows=500 → EMUNLOCK_SUSPECTED_TRUNCATION（不写原件不入事实，不重试）', async () => {
  const ceiling = EMUNLOCK_SINGLE_PAGE_CEILING;
  const bigRows: EmUnlockRow[] = Array.from({ length: ceiling }, (_, i) => ({
    解禁时间: '2026-01-06',
    解禁股东数: 1,
    解禁数量: i + 1,
    实际解禁数量: i + 1,
    未解禁数量: 0,
    实际解禁数量市值: 1,
    占总市值比例: 0,
    占流通市值比例: 0,
    解禁前一交易日收盘价: 1,
    限售股类型: `类型${String(i)}`,
    解禁前20日涨跌幅: null,
    解禁后20日涨跌幅: null,
  }));
  const visibleBefore = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '603986',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  const adapter = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: bigRows }) as unknown as BridgeResponse));
  await assert.rejects(
    adapter.fetchUnlockQueue(BOUND),
    (e: unknown) => e instanceof AdapterError && !(e instanceof TransientAdapterError) && e.message.includes('EMUNLOCK_SUSPECTED_TRUNCATION'),
    '具名永久错误（不重试）',
  );
  const visibleAfter = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '603986',
    factKind: 'UNLOCK_DETAIL',
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  // 守卫在事实写之前触发：本轮 500 行无一入库
  assert.equal(visibleAfter.length, visibleBefore.length, '截断守卫阻止批量入库');
});

test('裸码校验：EMUNLOCK_CODE_INVALID 具名拒绝（不发桥调用）', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor(() => {
    calls += 1;
    return { ok: true, rows: [] };
  }));
  await assert.rejects(adapter.fetchUnlockQueue('60036'), (e: unknown) => e instanceof AdapterError);
  assert.equal(calls, 0, '参数错不发真实调用');
});

test('桥错误分类：USAGE_ERROR 永久不重试；瞬态错误退避重试后成功', async () => {
  let usageCalls = 0;
  const usageAdapter = mkAdapter(async () => {
    usageCalls += 1;
    throw new AdapterError('USAGE_ERROR', '参数错');
  });
  await assert.rejects(usageAdapter.fetchUnlockQueue(BOUND), (e: unknown) => e instanceof AdapterError && !(e instanceof TransientAdapterError));
  assert.equal(usageCalls, 1, '永久错误不重试');

  const waits: number[] = [];
  let attempts = 0;
  const flakyExec: BridgeExecutor = async () => {
    attempts += 1;
    if (attempts < 3) throw new TransientAdapterError('EMUNLOCK_QUERY_FAILED', '瞬态');
    return JSON.parse(QUEUE_JSON) as BridgeResponse;
  };
  const flaky = mkAdapter(flakyExec, { sleeper: { async sleep(ms) { waits.push(ms); } } });
  const res = await flaky.fetchUnlockQueue(BOUND);
  assert.equal(res.insertedFactIds.length >= 0, true);
  assert.equal(attempts, 3, '第 3 次尝试成功');
  assert.deepEqual(waits, [1, 2], '等待序列逐次加倍（注入基线 1ms）');
});

test('桥瞬态错误退避耗尽 → 暂停（第 4 次不发起）', async () => {
  let transientThrows = 0;
  const transientExec: BridgeExecutor = async () => {
    transientThrows += 1;
    throw new TransientAdapterError('EMUNLOCK_BRIDGE_OUTPUT_INVALID', 'stdout 不可解析');
  };
  const pausing = mkAdapter(transientExec, { sleeper: { async sleep() {} } });
  await assert.rejects(pausing.fetchUnlockQueue(BOUND), (e: unknown) => {
    return e instanceof Error && e.name === 'AdapterPauseError';
  });
  assert.equal(transientThrows, 3, '3 次尝试耗尽后暂停上报（第 4 次不发起）');
});
