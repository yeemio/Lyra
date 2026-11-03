/**
 * Lyra · 指数估值适配器单测（P2 W31: code-writer-pro）。不碰外网：
 * 桥响应用 fixture 注入（形态照真实返回，var/w31-probe-result.json 2026-10-25 实测），
 * DB 用本地 lyra-pg 隔离 schema。合同判定：DATA-SOURCES §5/§6/§7、POINT-IN-TIME §2/§3.4
 * （availableAt 数据日次日 00:00+08 保守口径、as-of 读取、同日多来源分叉并存）。
 */
import assert from 'node:assert/strict';
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
  ALL_A_SUBJECT_ID,
  CSINDEX_COLS,
  VALUATION_ADAPTER_VERSION,
  VALUATION_SNAPSHOT_NOTICE,
  VALUATION_TARGETS,
  ValuationAdapter,
  mapAllARowsToFacts,
  mapCsindexDailyRowsToFacts,
  mapLgRowsToFacts,
  shanghaiNextDayStart,
  type ValuationMapContext,
  type ValuationRow,
} from './valuation.js';

// ===== fixture（桥 stdout 形态；字段名与取值形态照真实返回 2026-10-25 实测）=====

const NOW = new Date('2026-10-25T03:00:00.000Z');

/** csindex 000300 indicator.xls 实测行（原生 10 列 + 桥附 日期ISO）+ 1 行日期非法 + 1 行指标全空。 */
const CSINDEX_JSON = JSON.stringify({
  ok: true,
  rows: [
    {
      日期Date: 20261023, '指数代码Index Code': 300,
      '指数中文全称Chinese Name(Full)': '沪深300指数', '指数中文简称Index Chinese Name': '沪深300',
      '指数英文全称English Name(Full)': 'CSI 300 Index', '指数英文简称Index English Name': 'CSI 300',
      '市盈率1（总股本）P/E1': 13.9, '市盈率2（计算用股本）P/E2': 15.44,
      '股息率1（总股本）D/P1': 2.84, '股息率2（计算用股本）D/P2': 2.64,
      日期ISO: '2026-10-23',
    },
    {
      日期Date: 20261022, '指数代码Index Code': 300,
      '指数中文全称Chinese Name(Full)': '沪深300指数', '指数中文简称Index Chinese Name': '沪深300',
      '指数英文全称English Name(Full)': 'CSI 300 Index', '指数英文简称Index English Name': 'CSI 300',
      '市盈率1（总股本）P/E1': null, '市盈率2（计算用股本）P/E2': null,
      '股息率1（总股本）D/P1': null, '股息率2（计算用股本）D/P2': null,
      日期ISO: '2026-10-22',
    },
    {
      日期Date: 0, '指数代码Index Code': 300,
      '指数中文全称Chinese Name(Full)': 'x', '指数中文简称Index Chinese Name': 'x',
      '指数英文全称English Name(Full)': 'x', '指数英文简称Index English Name': 'x',
      '市盈率1（总股本）P/E1': 1, '市盈率2（计算用股本）P/E2': 1,
      '股息率1（总股本）D/P1': 1, '股息率2（计算用股本）D/P2': 1,
      日期ISO: 'not-a-date',
    },
  ],
  meta: { sourceUrl: 'https://example/x', sha256: '0'.repeat(64), bytes: 4096, dataRows: 3 },
});

/** legulegu PE 实测行（月末）+ 1 行非法。 */
const LG_PE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 日期: '2005-01-31', 指数: 813.75, 等权静态市盈率: 30.87, 静态市盈率: 20.05, 静态市盈率中位数: 25.07, 等权滚动市盈率: 27.8, 滚动市盈率: 14.54, 滚动市盈率中位数: 18.41 },
    { 日期: '2026-10-23', 指数: 2757.68, 等权静态市盈率: 37.93, 静态市盈率: 11.63, 静态市盈率中位数: 17.0, 等权滚动市盈率: 28.83, 滚动市盈率: 10.68, 滚动市盈率中位数: 18.61 },
    { 日期: '', 指数: 1, 等权静态市盈率: 1, 静态市盈率: 1, 静态市盈率中位数: 1, 等权滚动市盈率: 1, 滚动市盈率: 1, 滚动市盈率中位数: 1 },
  ],
});

const LG_PB_JSON = JSON.stringify({
  ok: true,
  rows: [
    { 日期: '2005-01-31', 指数: 813.75, 市净率: 2.04, 等权市净率: 2.24, 市净率中位数: 2.13 },
    { 日期: '2005-02-28', 指数: 868.89, 市净率: 2.2, 等权市净率: 2.43, 市净率中位数: 'x' }, // 指标非数值 → 拒
  ],
});

/** 全A PE 实测行（来源自带分位列，历史行多为 null）。 */
const ALL_A_PE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { date: '2005-01-31', middlePETTM: 27.36, averagePETTM: 42.35, middlePELYR: 29.71, averagePELYR: 49.37, close: 0.0, quantileInAllHistoryMiddlePeTtm: null, quantileInRecent10YearsMiddlePeTtm: null },
    { date: 'bad', middlePETTM: 1, averagePETTM: 1, middlePELYR: 1, averagePELYR: 1, close: 1, quantileInAllHistoryMiddlePeTtm: null },
  ],
});

const ALL_A_PB_JSON = JSON.stringify({
  ok: true,
  rows: [
    { date: '2005-01-31', middlePB: 1.89, equalWeightAveragePB: 2.3, close: 1191.82, quantileInAllHistoryMiddlePB: null, quantileInRecent10YearsMiddlePB: null, quantileInAllHistoryEqualWeightAveragePB: null, quantileInRecent10YearsEqualWeightAveragePB: null },
    { date: '2026-10-23', middlePB: 2.54, equalWeightAveragePB: 3.8, close: 3623.57, quantileInAllHistoryMiddlePB: 0.37639, quantileInRecent10YearsMiddlePB: 0.43889, quantileInAllHistoryEqualWeightAveragePB: 0.51296, quantileInRecent10YearsEqualWeightAveragePB: 0.58588 },
  ],
});

const CTX: ValuationMapContext = {
  adapterVersion: VALUATION_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('mapCsindexDailyRowsToFacts：原生键原样 + D+1 00:00 availableAt + 15:00 eventAt + 拒截', () => {
  const rows = (JSON.parse(CSINDEX_JSON) as { rows: ValuationRow[] }).rows;
  const { facts, rejections } = mapCsindexDailyRowsToFacts('000300', rows, CTX);
  assert.equal(facts.length, 1); // 指标全空行与日期非法行拒截
  assert.deepEqual(rejections.map((r) => r.code), ['VALUATION_CSINDEX_ALL_METRICS_MISSING', 'VALUATION_CSINDEX_DATE_INVALID']);

  const f = facts[0]!.fact;
  assert.equal(f.subjectType, 'INDEX');
  assert.equal(f.subjectId, '000300');
  assert.equal(f.factKind, 'INDEX_VALUATION');
  assert.equal(f.eventAt, '2026-10-23T07:00:00.000Z'); // 15:00+08
  assert.equal(f.validFrom, '2026-10-23T07:00:00.000Z');
  assert.equal(f.validTo, null);
  assert.equal(f.availableAt, '2026-10-23T16:00:00.000Z'); // = 2026-10-24 00:00+08（保守口径）
  assert.equal(f.sourcePublishedAt, null);
  const tv = f.typedValue as Record<string, unknown>;
  assert.equal(tv['来源'], 'csindex');
  assert.equal(tv['频率'], '日频');
  assert.equal(tv['指数代码'], '000300'); // 原生 int 300 丢前导零，此处补 6 位
  assert.equal(tv['日期ISO'], '2026-10-23');
  for (const k of CSINDEX_COLS) assert.ok(k in tv, `原生键原样保留：${k}`);
  assert.equal(tv['市盈率1（总股本）P/E1'], 13.9); // 数值原样

  // 无效指数代码：全部拒
  const bad = mapCsindexDailyRowsToFacts('300', rows, CTX);
  assert.equal(bad.facts.length, 0);
  assert.equal(bad.rejections.length, rows.length);
});

test('mapLgRowsToFacts：PE/PB 列集、来源/频率元数据、指标非数值拒截', () => {
  const peRows = (JSON.parse(LG_PE_JSON) as { rows: ValuationRow[] }).rows;
  const pe = mapLgRowsToFacts('000016', 'PE', peRows, CTX);
  assert.equal(pe.facts.length, 2);
  assert.deepEqual(pe.rejections, [{ rowIndex: 2, code: 'VALUATION_LG_DATE_INVALID' }]);
  const peTv = pe.facts[0]!.fact.typedValue as Record<string, unknown>;
  assert.equal(peTv['来源'], 'legulegu');
  assert.equal(peTv['频率'], '月末');
  assert.equal(peTv['指标'], 'PE');
  assert.equal(peTv['指数代码'], '000016');
  assert.equal(peTv['滚动市盈率'], 14.54);
  assert.equal(pe.facts[0]!.fact.availableAt, '2005-01-31T16:00:00.000Z'); // = 2005-02-01 00:00+08
  assert.equal(pe.facts[1]!.fact.availableAt, '2026-10-23T16:00:00.000Z'); // = 2026-10-24 00:00+08

  const pbRows = (JSON.parse(LG_PB_JSON) as { rows: ValuationRow[] }).rows;
  const pb = mapLgRowsToFacts('000016', 'PB', pbRows, CTX);
  assert.equal(pb.facts.length, 1);
  assert.deepEqual(pb.rejections, [{ rowIndex: 1, code: 'VALUATION_LG_METRIC_INVALID' }]);
  assert.equal((pb.facts[0]!.fact.typedValue as Record<string, unknown>)['等权市净率'], 2.24);
});

test('mapAllARowsToFacts：subjectId=ALL-A、来源分位列原样随行、拒截', () => {
  const peRows = (JSON.parse(ALL_A_PE_JSON) as { rows: ValuationRow[] }).rows;
  const pe = mapAllARowsToFacts('PE', peRows, CTX);
  assert.equal(pe.facts.length, 1);
  assert.deepEqual(pe.rejections, [{ rowIndex: 1, code: 'VALUATION_ALLA_DATE_INVALID' }]);
  const f = pe.facts[0]!.fact;
  assert.equal(f.subjectId, ALL_A_SUBJECT_ID);
  const tv = f.typedValue as Record<string, unknown>;
  assert.equal(tv['来源'], 'legulegu-allA');
  assert.equal(tv['middlePETTM'], 27.36);
  assert.ok('quantileInAllHistoryMiddlePeTtm' in tv, '来源自带分位列原样随行');

  const pbRows = (JSON.parse(ALL_A_PB_JSON) as { rows: ValuationRow[] }).rows;
  const pb = mapAllARowsToFacts('PB', pbRows, CTX);
  assert.equal(pb.facts.length, 2);
  const last = pb.facts[1]!.fact.typedValue as Record<string, unknown>;
  assert.equal(last['quantileInAllHistoryMiddlePB'], 0.37639);
});

test('目标清单：4 只宽基跟踪指数、lgKey 与池文件 tracks 对应', () => {
  assert.deepEqual(
    VALUATION_TARGETS.map((t) => t.code),
    ['000016', '000300', '000905', '000852'],
  );
  assert.deepEqual(
    VALUATION_TARGETS.map((t) => t.name),
    ['上证50', '沪深300', '中证500', '中证1000'],
  );
});

test('shanghaiNextDayStart：月末行保守次日口径', () => {
  assert.equal(shanghaiNextDayStart('2026-10-23'), '2026-10-23T16:00:00.000Z'); // = 次日 00:00+08
  assert.equal(shanghaiNextDayStart('2005-01-31'), '2005-01-31T16:00:00.000Z'); // = 2005-02-01 00:00+08（跨月）
});

// ===== 适配器管线（隔离 schema DB + fixture 桥）=====

let admin: Pool;
let pool: Pool;
let store: ArtifactStore;
let artifactsDir: string;
let repoRootDir: string;
let schema: string;

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => script(args);
}

function mkAdapter(exec: BridgeExecutor): ValuationAdapter {
  return new ValuationAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w31-val-'));
  store = new ArtifactStore(artifactsDir);
  repoRootDir = await mkdtemp(join(tmpdir(), 'lyra-w31-root-'));
  await mkdir(join(repoRootDir, 'var'), { recursive: true });
  await writeFile(join(repoRootDir, 'var/valuation-csindex-000300indicator.xls'), Buffer.from('fake-xls-bytes'));
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(repoRootDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

const noSleep: BackoffSleeper = { sleep: async () => {} };

test('fetchLgPe：入库 + 原件 + 重放幂等 + 双 R4 声明随行', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['lg_pe', 'sz50']);
    calls += 1;
    return JSON.parse(LG_PE_JSON) as BridgeResponse;
  }));
  const r1 = await adapter.fetchLgPe('000016', 'sz50');
  assert.equal(r1.adapterVersion, VALUATION_ADAPTER_VERSION);
  assert.equal(r1.scope, 'valuation:lg_pe:000016');
  assert.equal(r1.rowCount, 3);
  assert.equal(r1.insertedFactIds.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), '通用 R4 声明随行');
  assert.ok(r1.notices.includes(VALUATION_SNAPSHOT_NOTICE), '估值快照口径声明随行');
  const bytes = await store.readBytes(r1.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 3);

  const r2 = await adapter.fetchLgPe('000016', 'sz50');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2); // DATA-SOURCES §6.5 同键同值去重
  assert.equal(calls, 2);
});

test('fetchCsindexDaily：XLS 字节入原件库 + 日频事实', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['csindex_daily', '000300']);
    return JSON.parse(CSINDEX_JSON) as BridgeResponse;
  }));
  const r = await adapter.fetchCsindexDaily('000300');
  assert.equal(r.scope, 'valuation:csindex_daily:000300');
  assert.equal(r.insertedFactIds.length, 1); // 指标全空 + 日期非法两行拒截（fixture）
  assert.equal(r.rejectedRows.length, 2);
  const bytes = await store.readBytes(r.artifact.sha256);
  assert.equal(new TextDecoder().decode(bytes), 'fake-xls-bytes'); // var/ 下 XLS 字节即原件
});

test('同日多来源分叉并存：csindex 与 legulegu 的 2026-10-23 事实都可见、不合并', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    if (args[0] === 'csindex_daily') return JSON.parse(CSINDEX_JSON) as BridgeResponse;
    if (args[0] === 'lg_pe') return JSON.parse(LG_PE_JSON) as BridgeResponse;
    throw new Error(`unexpected ${JSON.stringify(args)}`);
  }));
  await adapter.fetchCsindexDaily('000300');
  await adapter.fetchLgPe('000300', 'hs300');
  const both = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: '000300',
    factKind: 'INDEX_VALUATION',
    asOf: new Date('2026-10-25T00:00:00.000Z'),
  });
  // 同一数据日 2026-10-23 两来源各一条（分叉并存）；csindex fixture 的 10-22 行因指标全空被拒
  const sameDay = both.filter((f) => f.eventAt === '2026-10-23T07:00:00.000Z');
  const sources = sameDay.map((f) => (f.typedValue as Record<string, unknown>)['来源']).sort();
  assert.deepEqual(sources, ['csindex', 'legulegu']); // POINT-IN-TIME §4 分叉并存暴露
  assert.equal(new Set(sameDay.map((f) => f.factId)).size, 2);
  assert.ok(both.length >= 2, 'as-of 窗口同时含历史月末行');
});

test('as-of 保守截点：2005-01-31 月末行在 02-01 00:00+08 前不可见', async () => {
  // 用独立主体 000905（此前测试未写过该主体的 INDEX_VALUATION，计数不受跨测试事实影响）
  const adapter = mkAdapter(fixtureExecutor(() => JSON.parse(LG_PB_JSON) as BridgeResponse));
  await adapter.fetchLgPb('000905', 'zz500');
  // 边界 = 2005-02-01 00:00+08 = 2005-01-31T16:00:00Z
  const justAfter = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: '000905',
    factKind: 'INDEX_VALUATION',
    asOf: new Date('2005-01-31T16:00:00.000Z'), // 恰在次日 00:00+08
  });
  assert.equal(justAfter.length, 1);
  const before = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: '000905',
    factKind: 'INDEX_VALUATION',
    asOf: new Date('2005-01-31T15:59:59.000Z'), // 2005-01-31 23:59:59+08
  });
  assert.equal(before.length, 0, '数据日次日 00:00+08 前不可见（保守口径无泄漏）');
});

test('fetchAllAPe/AllAPb：ALL-A 主体入库', async () => {
  const adapter = mkAdapter(fixtureExecutor((args) => {
    if (args[0] === 'all_a_pe') return JSON.parse(ALL_A_PE_JSON) as BridgeResponse;
    if (args[0] === 'all_a_pb') return JSON.parse(ALL_A_PB_JSON) as BridgeResponse;
    throw new Error(`unexpected ${JSON.stringify(args)}`);
  }));
  const pe = await adapter.fetchAllAPe();
  assert.equal(pe.scope, 'valuation:all_a_pe:ALL-A');
  assert.equal(pe.insertedFactIds.length, 1);
  const pb = await adapter.fetchAllAPb();
  assert.equal(pb.insertedFactIds.length, 2);
});

test('参数校验：非法 indexCode / lgKey 为永久错误（USAGE 不重试）', async () => {
  const adapter = mkAdapter(fixtureExecutor(() => {
    throw new Error('不应发起调用');
  }));
  await assert.rejects(adapter.fetchLgPe('300', 'sz50'), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchLgPe('000016', 'foo'), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchCsindexDaily('abc'), (e: unknown) => e instanceof AdapterError);
});

test('瞬态失败按退避重试后成功（记录式睡眠）', async () => {
  let attempt = 0;
  const adapter = new ValuationAdapter({
    pool,
    store,
    execBridge: fixtureExecutor(() => {
      attempt += 1;
      if (attempt < 3) {
        // 注入执行器须直接抛瞬态错误（真实桥在执行器内把 ok:false 转为异常）
        throw new TransientAdapterError('VALUATION_QUERY_FAILED', 'transient');
      }
      return JSON.parse(LG_PB_JSON) as BridgeResponse;
    }),
    now: () => NOW,
    gate: new ConcurrencyGate(1),
    repoRootPath: repoRootDir,
    backoffSleeper: noSleep,
    backoffAttempts: 3,
    backoffBaseDelayMs: 1,
  });
  // 独立主体 000852（此前未写），保证重试成功后有新插入
  const r = await adapter.fetchLgPb('000852', 'zz1000');
  assert.equal(attempt, 3);
  assert.ok(r.insertedFactIds.length >= 1);
});

test('VALUATION_SNAPSHOT_NOTICE 声明频度与来源口径（R4 原文要素）', () => {
  assert.ok(VALUATION_SNAPSHOT_NOTICE.includes('月末频率'));
  assert.ok(VALUATION_SNAPSHOT_NOTICE.includes('20 个交易日'));
  assert.ok(VALUATION_SNAPSHOT_NOTICE.includes('不得混频'));
});
