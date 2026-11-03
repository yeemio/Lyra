/**
 * Lyra · 大宗交易适配器单测（P2 W37: code-writer，B1）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-25 真实探测返回，var/w37-probe.py；序号 列
 * 桥侧已剔除），退避用记录式注入睡眠，DB 用本地 lyra-pg 隔离 schema。合同判定：
 * 派发冻结（factKind BLOCK_TRADE、availableAt=交易日次日 00:00+08、subjectId 裸码 R24）、
 * DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2（as-of 截点过滤）、单页上限守卫。
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
  EMBLOCK_ADAPTER_VERSION,
  EMBLOCK_REVISION_NOTICE,
  EMBLOCK_SINGLE_PAGE_CEILING,
  EmblockAdapter,
  compactToIso,
  mapBlockTradeRowsToFacts,
  toCompactDate,
  type EmblockRow,
} from './emblock.js';

// ===== fixture（字段名与取值形态照 2026-10-25 真实探测；序号 桥侧剔除）=====

const NOW = new Date('2026-10-25T05:00:00.000Z');

/** 近窗实测形态：600036 同日两笔（不同营业部/量）+ 002384（池内）+ 000153（非池）+ 坏行 ×2。 */
const MRMX_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 交易日期: '2026-10-21', 证券代码: '600036', 证券简称: '招商银行', 涨跌幅: -0.5644, 收盘价: 42.28, 成交价: 42.28, 折溢率: 0.0, 成交量: 3_600_000, 成交额: 152_208_000, '成交额/流通市值': 0.017451, 买方营业部: '中信证券股份有限公司总部(非营业场所)', 卖方营业部: '机构专用' },
    { 交易日期: '2026-10-21', 证券代码: '600036', 证券简称: '招商银行', 涨跌幅: -0.5644, 收盘价: 42.28, 成交价: 42.28, 折溢率: 0.0, 成交量: 48_000, 成交额: 2_029_400, '成交额/流通市值': 0.000233, 买方营业部: '广发证券股份有限公司天津环湖中路证券营业部', 卖方营业部: '中国国际金融股份有限公司北京建国门外大街证券营业部' },
    { 交易日期: '2026-10-20', 证券代码: '002384', 证券简称: '东山精密', 涨跌幅: 0.0, 收盘价: 122.15, 成交价: 122.15, 折溢率: 0.0, 成交量: 32_000, 成交额: 3_908_800, '成交额/流通市值': 0.002308, 买方营业部: '机构专用', 卖方营业部: '机构专用' },
    { 交易日期: '2026-10-22', 证券代码: '000153', 证券简称: '丰原药业', 涨跌幅: -3.1359, 收盘价: 5.56, 成交价: 5.62, 折溢率: 0.010791, 成交量: 5_796_000, 成交额: 32_573_500, '成交额/流通市值': 1.271231, 买方营业部: '中国银河证券股份有限公司北京安贞门证券营业部', 卖方营业部: '长城国瑞证券有限公司北京远大路证券营业部' },
    { 交易日期: '2026-10-22', 证券代码: '', 证券简称: '坏行', 成交价: 1 },
    { 交易日期: '2026/10/22', 证券代码: '600036', 证券简称: '日期形态坏行', 成交价: 1 },
  ],
});

const POOL = new Set(['600036', '002384']);

// ===== 纯函数：映射 =====

const CTX = { adapterVersion: EMBLOCK_ADAPTER_VERSION, fetchedAt: NOW.toISOString(), artifactSha256: 'a'.repeat(64) };

test('toCompactDate / compactToIso：往返与非法形态', () => {
  assert.equal(toCompactDate('2026-10-21'), '20261021');
  assert.equal(compactToIso('20261021'), '2026-10-21');
  assert.equal(compactToIso('20261099'), null, '非法月日拒绝');
  assert.throws(() => toCompactDate('20261021'), AdapterError);
});

test('mapBlockTradeRowsToFacts：BLOCK_TRADE（availableAt=次日00:00+08，eventAt=交易日15:00+08，裸码归类）', () => {
  const rows = (JSON.parse(MRMX_JSON) as { rows: EmblockRow[] }).rows;
  const mapped = mapBlockTradeRowsToFacts(rows, CTX);
  assert.equal(mapped.facts.length, 4, '四行有效（600036×2 + 002384 + 000153）');
  assert.equal(mapped.rejections.length, 2, '空代码行 + 日期形态坏行具名拒绝');
  assert.equal(mapped.filteredOut, 0, '无过滤');
  const first = mapped.facts[0]!;
  assert.equal(first.fact.subjectType, 'STOCK');
  assert.equal(first.fact.subjectId, '600036');
  assert.equal(first.fact.factKind, 'BLOCK_TRADE');
  const availT = new Date('2026-10-22T00:00:00+08:00').toISOString();
  const eventT = new Date('2026-10-21T15:00:00+08:00').toISOString();
  assert.equal(first.fact.availableAt, availT, '派发冻结：交易日次日 00:00+08');
  assert.equal(first.fact.validFrom, availT);
  assert.equal(first.fact.eventAt, eventT, '成交发生时点标记=交易日 15:00+08');
  assert.equal(first.fact.supersedesFactId, null);
  const tv = first.fact.typedValue as Record<string, unknown>;
  assert.equal(tv['code'], 'sh.600036');
  assert.equal(tv['tradeDateISO'], '2026-10-21');
  assert.equal(tv['折溢率'], 0.0, 'B1 核心字段：折溢率来源原样');
  assert.equal(tv['成交量'], 3_600_000, '来源字段原样');
  // 同日两笔不同营业部/量 → 不同 objectKey/factId
  const second = mapped.facts[1]!;
  assert.notEqual(first.objectKey, second.objectKey, '同日同股两笔业务键可区分');
  assert.notEqual(first.fact.factId, second.fact.factId);
  const szRow = mapped.facts[2]!;
  assert.equal(szRow.fact.subjectId, '002384');
});

test('mapBlockTradeRowsToFacts：subjectFilter 过滤显式计数', () => {
  const rows = (JSON.parse(MRMX_JSON) as { rows: EmblockRow[] }).rows;
  const filtered = mapBlockTradeRowsToFacts(rows, CTX, POOL);
  assert.equal(filtered.facts.length, 3, '000153 非池被过滤');
  assert.equal(filtered.filteredOut, 1, '过滤计数显式（不静默）');
});

test('factId 不含观察时刻：同行不同 fetchedAt → 同 factId（终局窗口去重，序号已桥侧剔除）', () => {
  const rows = (JSON.parse(MRMX_JSON) as { rows: EmblockRow[] }).rows;
  const a = mapBlockTradeRowsToFacts(rows, CTX);
  const b = mapBlockTradeRowsToFacts(rows, {
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

function mkAdapter(exec: BridgeExecutor, opts: { sleeper?: BackoffSleeper; now?: () => Date } = {}): EmblockAdapter {
  return new EmblockAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w37-emblock-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchBlockTradeDetail：入库 + 原件可校验读回 + 重放幂等 + 声明随行 + 过滤计数', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['mrmx', '20261019', '20261023'], '桥参数为子命令+紧凑日期区间');
    calls += 1;
    return JSON.parse(MRMX_JSON) as BridgeResponse;
  }));
  const r1 = await adapter.fetchBlockTradeDetail('2026-10-19', '2026-10-23', POOL);
  assert.equal(r1.adapterVersion, EMBLOCK_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emblock:mrmx:20261019-20261023');
  assert.equal(r1.rowCount, 6, 'rowCount 为桥返回全量行数（不受过滤影响）');
  assert.equal(r1.insertedFactIds.length, 3, '只入池内 3 笔');
  assert.equal(r1.filteredOut, 1, '000153 非过滤集被计出');
  assert.equal(r1.rejectedRows.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  assert.ok(r1.notices.includes(EMBLOCK_REVISION_NOTICE), '大宗面注记随行');
  const bytes = await store.readBytes(r1.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 6, '原件全量入库');
  const r2 = await adapter.fetchBlockTradeDetail('2026-10-19', '2026-10-23', POOL);
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 3, '§6.5 同键同值去重');
  assert.equal(calls, 2);
});

test('fetchBlockTradeDetail：as-of 截点过滤（次日 00:00+08 前不可见，无泄漏）', async () => {
  // 独立日期 fixture（2026-10-15）：避免与前一用例同 factId（同 schema 内先写为准 → identical）
  const asofRows: EmblockRow[] = (JSON.parse(MRMX_JSON) as { rows: EmblockRow[] }).rows
    .slice(0, 2)
    .map((row) => ({ ...row, 交易日期: '2026-10-15' }));
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['mrmx', '20261015', '20261015']);
    return { ok: true, rows: asofRows } as unknown as BridgeResponse;
  }));
  const res = await adapter.fetchBlockTradeDetail('2026-10-15', '2026-10-15', new Set(['600036']));
  assert.equal(res.insertedFactIds.length, 2);
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600036',
    factKind: 'BLOCK_TRADE',
    asOf: new Date('2026-10-15T15:59:59.000Z'), // 2026-10-15 23:59:59+08（披露保守口径前）
  });
  assert.equal(before.length, 0, '交易日次日 00:00+08 前不可见');
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600036',
    factKind: 'BLOCK_TRADE',
    asOf: new Date('2026-10-15T16:00:00.000Z'), // 2026-10-16 00:00:00+08
  });
  assert.equal(after.length, 2);
});

test('单页上限守卫：rows=5000 → EMBLOCK_SUSPECTED_TRUNCATION（不写原件不入事实）', async () => {
  const ceiling = EMBLOCK_SINGLE_PAGE_CEILING;
  const bigRows: EmblockRow[] = Array.from({ length: ceiling }, (_, i) => ({
    交易日期: '2026-10-21',
    证券代码: '600036',
    证券简称: '招商银行',
    成交价: 42.28,
    成交量: i + 1,
    成交额: 1,
    折溢率: 0,
    买方营业部: 'A',
    卖方营业部: 'B',
    '成交额/流通市值': 0,
    涨跌幅: 0,
    收盘价: 42.28,
  }));
  const visibleBefore = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600036',
    factKind: 'BLOCK_TRADE',
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  const adapter = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: bigRows }) as unknown as BridgeResponse));
  await assert.rejects(
    adapter.fetchBlockTradeDetail('2026-10-01', '2026-10-31', POOL),
    (e: unknown) => e instanceof AdapterError && !(e instanceof TransientAdapterError) && e.message.includes('EMBLOCK_SUSPECTED_TRUNCATION'),
    '具名永久错误（缩小窗口重排，不重试）',
  );
  const visibleAfter = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600036',
    factKind: 'BLOCK_TRADE',
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  // 守卫在事实写之前触发：本轮 5000 行无一入库
  assert.equal(visibleAfter.length, visibleBefore.length, '截断守卫阻止批量入库');
});

test('日期区间校验：start > end 具名拒绝', async () => {
  const adapter = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] })));
  await assert.rejects(
    adapter.fetchBlockTradeDetail('2026-10-24', '2026-10-20'),
    (e: unknown) => e instanceof AdapterError,
  );
});

test('桥错误分类：USAGE_ERROR 永久不重试；瞬态错误退避重试后成功', async () => {
  let usageCalls = 0;
  const usageAdapter = mkAdapter(async () => {
    usageCalls += 1;
    throw new AdapterError('USAGE_ERROR', '参数错');
  });
  await assert.rejects(usageAdapter.fetchBlockTradeDetail('2026-10-19', '2026-10-23'), (e: unknown) => e instanceof AdapterError && !(e instanceof TransientAdapterError));
  assert.equal(usageCalls, 1, '永久错误不重试');

  const waits: number[] = [];
  let attempts = 0;
  const flakyExec: BridgeExecutor = async () => {
    attempts += 1;
    if (attempts < 3) throw new TransientAdapterError('EMBLOCK_QUERY_FAILED', '瞬态');
    return JSON.parse(MRMX_JSON) as BridgeResponse;
  };
  const flaky = mkAdapter(flakyExec, { sleeper: { async sleep(ms) { waits.push(ms); } } });
  const res = await flaky.fetchBlockTradeDetail('2026-10-19', '2026-10-23', POOL);
  assert.equal(res.insertedFactIds.length >= 0, true);
  assert.equal(attempts, 3, '第 3 次尝试成功');
  assert.deepEqual(waits, [1, 2], '等待序列逐次加倍（注入基线 1ms）');
});

test('桥瞬态错误退避耗尽 → 暂停（第 4 次不发起）', async () => {
  let transientThrows = 0;
  const transientExec: BridgeExecutor = async () => {
    transientThrows += 1;
    throw new TransientAdapterError('EMBLOCK_BRIDGE_OUTPUT_INVALID', 'stdout 不可解析');
  };
  const pausing = mkAdapter(transientExec, { sleeper: { async sleep() {} } });
  await assert.rejects(pausing.fetchBlockTradeDetail('2026-10-19', '2026-10-23'), (e: unknown) => {
    return e instanceof Error && e.name === 'AdapterPauseError';
  });
  assert.equal(transientThrows, 3, '3 次尝试耗尽后暂停上报（第 4 次不发起）');
});
