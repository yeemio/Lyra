/**
 * Lyra · BaoStock 适配器单测（P1 W4）。不碰外网：桥响应用 fixture 字符串注入，
 * 退避用立即放行的注入睡眠，DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：DATA-SOURCES §2/§6/§7、POINT-IN-TIME §2/§3/§4、P1-DATA 冻结 availableAt 规则。
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
  TransientAdapterError,
  type BridgeResponse,
  type BridgeRow,
} from './adapter-types.js';
import { ConcurrencyGate, applyP1Migration, loadPauseReports } from './backoff.js';
import {
  BAOSTOCK_ADAPTER_VERSION,
  BaoStockAdapter,
  classifySubject,
  mapRowsToFacts,
  normalizeCode,
  p1RunId,
  type BridgeExecutor,
} from './baostock.js';

// ===== fixture（桥 stdout 形态的 JSON 字符串；BaoStock 字段名与取值形态照真实返回）=====

const KLINE_JSON = JSON.stringify({
  ok: true,
  rows: [
    { date: '2026-10-20', code: 'sh.600519', open: '1460.0000', high: '1471.1100', low: '1455.0000', close: '1466.0000', preclose: '1455.0000', volume: '3326400', amount: '4879194496.0000', adjustflag: '3', turn: '0.265900', tradestatus: '1', pctChg: '0.759500', isST: '0' },
    { date: '2026-10-21', code: 'sh.600519', open: '1470.0000', high: '1478.0000', low: '1462.0000', close: '1465.0000', preclose: '1466.0000', volume: '3100000', amount: '4550000000.0000', adjustflag: '3', turn: '0.247000', tradestatus: '1', pctChg: '-0.068200', isST: '0' },
    { date: '2026-10-22', code: 'sh.600519', open: '1465.0000', high: '1470.0000', low: '1450.0000', close: '1455.0000', preclose: '1465.0000', volume: '3000000', amount: '4380000000.0000', adjustflag: '3', turn: '0.239000', tradestatus: '1', pctChg: '-0.682600', isST: '0' },
  ],
});

const FIN_V1_JSON = JSON.stringify({
  ok: true,
  rows: [
    { code: 'sh.600519', pubDate: '2026-10-28', statDate: '2026-09-30', roeAvg: '24.830694', npMargin: '0.498566', gpMargin: '0.919929', netProfit: '74650264343.190002', epsTTM: '59.366545', MBRevenue: '123855368413.030027', totalShare: '1256197800', liqaShare: '1256197800', bsQuery: 'profit' },
    { code: 'sh.600519', pubDate: '2026-10-28', statDate: '2026-09-30', YOYEquity: '9.456789', YOYAsset: '6.123456', YOYNI: '8.765432', YOYEPSBasic: '8.500000', YOYPNI: '8.700000', bsQuery: 'growth' },
    { code: 'sh.600519', pubDate: '', statDate: '2026-09-30', netProfit: '1.000000', bsQuery: 'profit' },
  ],
});

const FIN_V2_JSON = JSON.stringify({
  ok: true,
  rows: [
    { code: 'sh.600519', pubDate: '2026-11-05', statDate: '2026-09-30', roeAvg: '24.900000', npMargin: '0.500000', gpMargin: '0.920000', netProfit: '74800000000.000000', epsTTM: '59.500000', MBRevenue: '123900000000.000000', totalShare: '1256197800', liqaShare: '1256197800', bsQuery: 'profit' },
    { code: 'sh.600519', pubDate: '2026-10-28', statDate: '2026-09-30', YOYEquity: '9.456789', YOYAsset: '6.123456', YOYNI: '8.765432', YOYEPSBasic: '8.500000', YOYPNI: '8.700000', bsQuery: 'growth' },
  ],
});

const ADJ_JSON = JSON.stringify({
  ok: true,
  rows: [
    { code: 'sh.600519', dividOperateDate: '2025-06-25', foreAdjustFactor: '0.890000', backAdjustFactor: '1.080000', adjustFactor: '1.180000' },
    { code: 'sh.600519', dividOperateDate: '2026-06-25', foreAdjustFactor: '0.912345', backAdjustFactor: '1.096000', adjustFactor: '1.200000' },
  ],
});

const ADJ_V2_JSON = JSON.stringify({
  ok: true,
  rows: [
    { code: 'sh.600519', dividOperateDate: '2026-06-25', foreAdjustFactor: '0.910000', backAdjustFactor: '1.095000', adjustFactor: '1.210000' },
  ],
});

const HS300_JSON = JSON.stringify({
  ok: true,
  rows: [
    { updateDate: '2026-10-22', code: 'sh.600519', code_name: '贵州茅台', bsIndex: 'hs300' },
    { updateDate: '2026-10-22', code: 'sh.600036', code_name: '招商银行', bsIndex: 'hs300' },
  ],
});

const POOL_JSON = JSON.stringify({
  ok: true,
  rows: [{ code: 'sh.600519', tradeStatus: '1', code_name: '贵州茅台', bsDay: '2026-10-22' }],
});

const CALENDAR_JSON = JSON.stringify({
  ok: true,
  rows: [
    { calendar_date: '2026-10-20', is_trading_day: '1' },
    { calendar_date: '2026-10-24', is_trading_day: '0' },
  ],
});

const parse = (s: string): BridgeResponse => JSON.parse(s) as BridgeResponse;
const rowsOf = (s: string): BridgeRow[] => (parse(s).rows ?? []) as BridgeRow[];

/** 按子命令分派的注入执行器；可抛瞬态错误模拟限流。 */
function scriptedExecutor(script: (args: string[], call: number) => BridgeResponse | Promise<BridgeResponse>): {
  exec: BridgeExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: BridgeExecutor = async (args) => {
    calls.push(args);
    return await script(args, calls.length);
  };
  return { exec, calls };
}

const NOW = () => new Date('2026-10-25T02:00:00Z');
const instantSleeper = { sleep: async () => {} };

// ===== 纯映射（无 DB、无网络）=====

const MAP_CTX = { adapterVersion: BAOSTOCK_ADAPTER_VERSION, fetchedAt: '2026-10-25T02:00:00.000Z', artifactSha256: 'a'.repeat(64) };

test('映射·K线：availableAt=交易日 15:00+08，typedValue 原样，factId 内容确定', () => {
  const rows = rowsOf(KLINE_JSON);
  const { facts, rejections } = mapRowsToFacts('kline', ['sh.600519', '2026-10-20', '2026-10-22'], rows, MAP_CTX);
  assert.equal(rejections.length, 0);
  assert.equal(facts.length, 3);
  const [f0, f1, f2] = facts;
  assert.ok(f0 && f1 && f2);
  assert.equal(f0.fact.factKind, 'DAILY_BAR');
  assert.equal(f0.fact.subjectType, 'STOCK');
  assert.equal(f0.fact.subjectId, '600519');
  assert.equal(f0.fact.availableAt, '2026-10-20T07:00:00.000Z', '该交易日 15:00 Asia/Shanghai（收盘事实）');
  assert.equal(f2.fact.availableAt, '2026-10-22T07:00:00.000Z');
  assert.equal(f0.fact.eventAt, '2026-10-20T07:00:00.000Z');
  assert.equal(f0.fact.sourcePublishedAt, null);
  assert.equal(f0.supersedesWiring, false, '已终局窗口不接 supersedes');
  assert.deepEqual(f0.fact.typedValue, rows[0], 'typedValue 保留原始字段');

  const again = mapRowsToFacts('kline', ['sh.600519', '2026-10-20', '2026-10-22'], rows, MAP_CTX);
  assert.deepEqual(again.facts.map((m) => m.fact.factId), facts.map((m) => m.fact.factId), '同 rows 同适配器版本重放同 factId');
  const mutated = rows.map((r, i) => (i === 1 ? { ...r, close: '9999.0000' } : r));
  const changed = mapRowsToFacts('kline', ['sh.600519', '2026-10-20', '2026-10-22'], mutated, MAP_CTX);
  assert.notEqual(changed.facts[1]?.fact.factId, facts[1]?.fact.factId, '行内容变化 → 新 factId');
});

test('映射·财务：pubDate 次日 00:00+08 可得，statDate 只进 validFrom，无 pubDate 具名拒绝', () => {
  const rows = rowsOf(FIN_V1_JSON);
  const { facts, rejections } = mapRowsToFacts('financial', ['sh.600519', '2026', '3'], rows, MAP_CTX);
  assert.equal(facts.length, 2, 'profit + growth 两行入库');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.code, 'FINANCIAL_PUBDATE_MISSING', '冻结具名错误：无 pubDate 拒绝入库');
  assert.equal(rejections[0]?.rowIndex, 2);
  const profit = facts.find((m) => (m.fact.typedValue as BridgeRow).bsQuery === 'profit');
  assert.ok(profit);
  assert.equal(profit.fact.factKind, 'FINANCIAL');
  assert.equal(profit.fact.availableAt, '2026-10-28T16:00:00.000Z', 'pubDate 2026-10-28 → 次日 00:00+08（保守 D+1）');
  assert.equal(profit.fact.validFrom, '2026-09-29T16:00:00.000Z', 'statDate 2026-09-30 → 当日 00:00+08，只进 validFrom');
  assert.equal(profit.fact.sourcePublishedAt, '2026-10-27T16:00:00.000Z');
  assert.equal(profit.supersedesWiring, true, '可变窗口接 supersedes');
  assert.equal(profit.objectKey, '2026-09-30:profit');
});

test('映射·复权因子/成分/股票池/日历：15:00+08 与主体归类', () => {
  const adj = mapRowsToFacts('adjust_factor', ['sh.600519', '2024-01-01', '2026-10-22'], rowsOf(ADJ_JSON), MAP_CTX);
  assert.equal(adj.facts.length, 2);
  assert.equal(adj.facts[1]?.fact.availableAt, '2026-06-25T07:00:00.000Z', '复权因子按除权日 15:00+08');
  assert.equal(adj.facts[1]?.fact.validFrom, '2026-06-25T07:00:00.000Z', 'valid_from = 除权日（POINT-IN-TIME §5.4）');
  assert.equal(adj.facts[1]?.supersedesWiring, true);

  const hs300 = mapRowsToFacts('hs300', ['2026-10-22'], rowsOf(HS300_JSON), MAP_CTX);
  assert.equal(hs300.facts.length, 2);
  assert.equal(hs300.facts[0]?.fact.factKind, 'INDEX_MEMBERSHIP');
  assert.equal(hs300.facts[0]?.fact.subjectType, 'STOCK');
  assert.equal(hs300.facts[0]?.fact.subjectId, '600519');
  assert.equal(hs300.facts[0]?.fact.availableAt, '2026-10-22T07:00:00.000Z', '成分归属按 updateDate 15:00+08');
  const zz500Rows = rowsOf(HS300_JSON).map((r) => ({ ...r, bsIndex: 'zz500' }));
  const zz500 = mapRowsToFacts('zz500', ['2026-10-22'], zz500Rows, MAP_CTX);
  assert.notEqual(zz500.facts[0]?.fact.factId, hs300.facts[0]?.fact.factId, '同股同日不同指数 → 不同事实（对象键含指数）');

  const pool = mapRowsToFacts('stock_pool', ['2026-10-22'], rowsOf(POOL_JSON), MAP_CTX);
  assert.equal(pool.facts[0]?.fact.factKind, 'STOCK_POOL');
  assert.equal(pool.facts[0]?.fact.subjectId, '600519');
  assert.equal(pool.facts[0]?.fact.availableAt, '2026-10-22T07:00:00.000Z');

  const cal = mapRowsToFacts('trade_dates', ['2026-10-20', '2026-10-24'], rowsOf(CALENDAR_JSON), MAP_CTX);
  assert.equal(cal.facts[0]?.fact.subjectType, 'RULE');
  assert.equal(cal.facts[0]?.fact.subjectId, 'ashare-calendar');
  assert.equal(cal.facts[0]?.fact.factKind, 'TRADE_CALENDAR');
  assert.equal(cal.facts[0]?.fact.availableAt, '2026-10-20T07:00:00.000Z');

  const badKline = mapRowsToFacts('kline', ['sh.600519', '2026-10-20', '2026-10-22'], [{ code: 'sh.600519', open: '1' }], MAP_CTX);
  assert.equal(badKline.rejections[0]?.code, 'DAILY_BAR_DATE_MISSING');
});

test('代码归一与主体归类', () => {
  assert.equal(normalizeCode('600519'), 'sh.600519');
  assert.equal(normalizeCode('000001'), 'sz.000001');
  assert.equal(normalizeCode('sh.600519'), 'sh.600519');
  assert.throws(() => normalizeCode('12345'), (e: unknown) => e instanceof AdapterError && e.code === 'BAOSTOCK_CODE_INVALID');
  assert.deepEqual(classifySubject('sh.000300'), { subjectType: 'INDEX', subjectId: '000300' });
  assert.deepEqual(classifySubject('sz.399001'), { subjectType: 'INDEX', subjectId: '399001' });
  assert.deepEqual(classifySubject('sz.000001'), { subjectType: 'STOCK', subjectId: '000001' });
  assert.deepEqual(classifySubject('sh.510300'), { subjectType: 'ETF', subjectId: '510300' });
});

// ===== 适配器端到端（注入执行器；本地 lyra-pg 隔离 schema；不碰外网）=====

let admin: Pool;
let schema: string;
let pool: Pool;
let artifactsDir: string;
let store: ArtifactStore;

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w4-bs-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
});

function makeAdapter(exec: BridgeExecutor, extra?: Partial<ConstructorParameters<typeof BaoStockAdapter>[0]>): BaoStockAdapter {
  return new BaoStockAdapter({ pool, store, execBridge: exec, now: NOW, ...extra });
}

test('适配器·K线：原件入库（canonical rows JSON）+ 事实落库 + as-of 读回 + 幂等重放', async () => {
  const { exec, calls } = scriptedExecutor((args) => (args[0] === 'kline' ? parse(KLINE_JSON) : parse('{}')));
  const adapter = makeAdapter(exec);
  const r1 = await adapter.fetchDailyBars('600519', '2026-10-20', '2026-10-22');
  assert.deepEqual(calls[0], ['kline', 'sh.600519', '2026-10-20', '2026-10-22'], '裸代码归一为 sh.600519');
  assert.equal(r1.scope, 'baostock:daily_kline:sh.600519:2026-10-20:2026-10-22');
  assert.equal(r1.rowCount, 3);
  assert.equal(r1.insertedFactIds.length, 3);
  assert.equal(r1.identicalFactIds.length, 0);
  assert.deepEqual(r1.rejectedRows, []);
  assert.deepEqual(r1.notices, [], '非财务输出不带修订声明');

  // 原件读回：哈希校验读 + canonical 序列化幂等
  const bytes = await store.readBytes(r1.artifact.sha256);
  const parsedRows = JSON.parse(new TextDecoder().decode(bytes)) as BridgeRow[];
  assert.equal(parsedRows.length, 3);
  assert.equal(r1.artifact.mediaType, 'application/json');
  assert.equal(r1.artifact.firstObservedAt, '2026-10-25T02:00:00.000Z', 'firstObservedAt=抓取时刻');

  // as-of 读回：截点在 10-21 收盘前一秒只见 10-20；10-22 收盘后全见
  const before = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', asOf: new Date('2026-10-21T06:59:59.000Z') });
  assert.equal(before.length, 1);
  assert.equal((before[0]?.typedValue as BridgeRow).date, '2026-10-20');
  const after = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', asOf: new Date('2026-10-22T07:00:00.000Z') });
  assert.equal(after.length, 3);
  assert.ok(after.every((f) => new Date(f.availableAt).getTime() <= new Date('2026-10-22T07:00:00.000Z').getTime()), '无 available_at > 截点');

  // 幂等重放：同 rows 同哈希同 factId → 全 IDENTICAL，不新增
  const r2 = await adapter.fetchDailyBars('sh.600519', '2026-10-20', '2026-10-22');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 3);
  assert.equal(r2.artifact.sha256, r1.artifact.sha256, '同 rows 同原件哈希');
});

test('适配器·财务：修订声明原样携带；修订走 supersedes 链 + as-of 版本切换', async () => {
  let version = 1;
  const { exec } = scriptedExecutor(() => (version === 1 ? parse(FIN_V1_JSON) : parse(FIN_V2_JSON)));
  const adapter = makeAdapter(exec);

  const v1 = await adapter.fetchQuarterFinancials('600519', 2026, 3);
  assert.equal(v1.insertedFactIds.length, 2, 'profit + growth 入库');
  assert.deepEqual(v1.rejectedRows, [{ rowIndex: 2, code: 'FINANCIAL_PUBDATE_MISSING' }]);
  assert.equal(v1.notices.length, 1);
  assert.equal(v1.notices[0], BACKFILL_REVISION_NOTICE, 'DATA-SOURCES §5 修订口径声明原文原样携带');

  version = 2;
  const v2 = await adapter.fetchQuarterFinancials('sh.600519', 2026, 3);
  const v2ProfitId = v2.insertedFactIds[0];
  assert.ok(v2ProfitId, '修订版 profit 行为新 factId');
  assert.equal(v2.identicalFactIds.length, 1, 'growth 行未变 → IDENTICAL（不重复入库）');
  const v2Fact = await loadFact(pool, v2ProfitId ?? '');
  assert.ok(v2Fact);
  const v1ProfitId = v1.insertedFactIds[0]; // rows 顺序：[profit, growth]，profit 先入库
  assert.ok(v1ProfitId);
  assert.equal(v2Fact.supersedesFactId, v1ProfitId, '新版本 supersedes 旧版本（不覆盖，POINT-IN-TIME §4）');

  // as-of：v2 可得前只见 v1；可得后旧版被链头遮蔽
  const mid = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'FINANCIAL', asOf: new Date('2026-11-01T00:00:00.000Z') });
  assert.equal(mid.length, 2);
  const profitMid = mid.find((f) => (f.typedValue as BridgeRow).bsQuery === 'profit');
  assert.equal((profitMid?.typedValue as BridgeRow).netProfit, '74650264343.190002', 'v2 前 = v1 值');
  const late = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'FINANCIAL', asOf: new Date('2026-11-06T00:00:00.000Z') });
  assert.equal(late.length, 2, 'growth + 链头 v2');
  const profitLate = late.find((f) => (f.typedValue as BridgeRow).bsQuery === 'profit');
  assert.equal(profitLate?.factId, v2ProfitId);
  assert.equal((profitLate?.typedValue as BridgeRow).netProfit, '74800000000.000000', 'v2 后 = 修订值');

  // 重放 v2：supersedes 稳定 → IDENTICAL，不 FACT_CONFLICT
  const v2again = await adapter.fetchQuarterFinancials('sh.600519', 2026, 3);
  assert.equal(v2again.insertedFactIds.length, 0);
  assert.equal(v2again.identicalFactIds.length, 2);
});

test('适配器·复权因子修订：同除权日新值 supersedes 旧值，as-of 只见链头', async () => {
  let version = 1;
  const { exec } = scriptedExecutor(() => (version === 1 ? parse(ADJ_JSON) : parse(ADJ_V2_JSON)));
  const adapter = makeAdapter(exec);
  const r1 = await adapter.fetchAdjustFactor('600519', '2024-01-01', '2026-10-22');
  assert.equal(r1.insertedFactIds.length, 2);

  version = 2;
  const r2 = await adapter.fetchAdjustFactor('sh.600519', '2024-01-01', '2026-10-22');
  const newId = r2.insertedFactIds[0];
  assert.ok(newId, '修订值为新 factId');
  const newFact = await loadFact(pool, newId ?? '');
  assert.ok(newFact);
  assert.ok(newFact.supersedesFactId !== null, 'v2 supersedes 指向 v1 同除权日事实');
  assert.equal(newFact.supersedesFactId, r1.insertedFactIds[1], '被修正对象 = v1 的 2026-06-25 因子事实');

  // as-of：除权日 2026-06-25 收盘前不见该因子；收盘后只见链头（修订值）
  const before = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ADJUST_FACTOR', asOf: new Date('2026-06-24T07:00:00.000Z') });
  assert.equal(before.length, 1, '仅 2025-06-25 因子可得');
  assert.equal((before[0]?.typedValue as BridgeRow).dividOperateDate, '2025-06-25');
  const after = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ADJUST_FACTOR', asOf: new Date('2026-06-26T00:00:00.000Z') });
  assert.equal(after.length, 2, '2025 行 + 2026 链头（v1 被遮蔽不消失）');
  const head2026 = after.find((f) => (f.typedValue as BridgeRow).dividOperateDate === '2026-06-25');
  assert.equal(head2026?.factId, newId);
  assert.equal((head2026?.typedValue as BridgeRow).adjustFactor, '1.210000', 'as-of 只见链头修订值');
  const supersededStillReadable = await loadFact(pool, newFact.supersedesFactId ?? '');
  assert.ok(supersededStillReadable, '被修正事实保留可解析（POINT-IN-TIME §4）');
});

test('适配器·退避接线：连续瞬态失败 → 暂停上报落库，成功后 RESUMED（注入睡眠秒级加速）', async () => {
  const { exec, calls } = scriptedExecutor(() => {
    throw new TransientAdapterError('BAOSTOCK_QUERY_FAILED', '网络接口错误');
  });
  const adapter = new BaoStockAdapter({ pool, store, execBridge: exec, now: NOW, backoffSleeper: instantSleeper });
  await assert.rejects(
    adapter.fetchTradeDates('2026-10-20', '2026-10-24'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'ADAPTER_PAUSED');
      return true;
    },
  );
  assert.equal(calls.length, 3, '3 次尝试后暂停，第 4 次不再发起');
  const pauses = await loadPauseReports(pool, 'baostock');
  const row = pauses.find((p) => p.scope === 'baostock:trade_calendar:2026-10-20:2026-10-24');
  assert.ok(row, '暂停上报已落库（scope=恢复位置）');
  assert.equal(row.retries, 3);
  assert.equal(row.status, 'PAUSED');

  // 恢复：从断点续跑成功 → 状态置 RESUMED
  const { exec: okExec } = scriptedExecutor((args) => (args[0] === 'trade_dates' ? parse(CALENDAR_JSON) : parse('{}')));
  const okAdapter = new BaoStockAdapter({ pool, store, execBridge: okExec, now: NOW, backoffSleeper: instantSleeper });
  const r = await okAdapter.fetchTradeDates('2026-10-20', '2026-10-24');
  assert.equal(r.insertedFactIds.length, 2);
  const resumed = (await loadPauseReports(pool, 'baostock')).find((p) => p.scope === 'baostock:trade_calendar:2026-10-20:2026-10-24');
  assert.equal(resumed?.status, 'RESUMED', '断点恢复标记');
});

test('适配器·并发闸：在途 ≤2（注入慢执行器）', async () => {
  let inFlight = 0;
  let peak = 0;
  // 独立日期窗口（区别于前述 K 线 fixture，避免去重命中干扰首见断言）
  const CONC_JSON = JSON.stringify({
    ok: true,
    rows: [
      { date: '2026-09-28', code: 'sh.600519', open: '1', high: '1', low: '1', close: '1', preclose: '1', volume: '1', amount: '1', adjustflag: '3', turn: '1', tradestatus: '1', pctChg: '1', isST: '0' },
      { date: '2026-09-29', code: 'sh.600519', open: '1', high: '1', low: '1', close: '1', preclose: '1', volume: '1', amount: '1', adjustflag: '3', turn: '1', tradestatus: '1', pctChg: '1', isST: '0' },
      { date: '2026-09-30', code: 'sh.600519', open: '1', high: '1', low: '1', close: '1', preclose: '1', volume: '1', amount: '1', adjustflag: '3', turn: '1', tradestatus: '1', pctChg: '1', isST: '0' },
    ],
  });
  const { exec } = scriptedExecutor(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return parse(CONC_JSON);
  });
  const adapter = new BaoStockAdapter({ pool, store, execBridge: exec, now: NOW, gate: new ConcurrencyGate(2) });
  const dates: Array<[string, string]> = [
    ['2026-09-28', '2026-09-30'],
    ['2026-09-21', '2026-09-23'],
    ['2026-09-14', '2026-09-16'],
    ['2026-09-07', '2026-09-09'],
  ];
  const results = await Promise.all(dates.map(([s, e]) => adapter.fetchDailyBars('sh.600519', s, e)));
  assert.equal(results.length, 4);
  assert.ok(peak <= 2, `适配器在途峰值 ${peak} 应 ≤2`);
  assert.ok(peak === 2, `应真实到达并发上限（峰值 ${peak}）`);
  // 同一 fixture rows → 各窗口同 rows → 同 factId：全批首见一次 INSERTED，其余为去重命中
  const totalInserted = results.reduce((n, r) => n + (r?.insertedFactIds.length ?? 0), 0);
  assert.equal(totalInserted, 3, '三行事实只首见一次');
  for (const r of results) {
    assert.ok(r !== undefined && r.insertedFactIds.length + r.identicalFactIds.length === 3, '每个窗口读回三行，全部入库或去重命中');
  }
});

test('适配器·参数校验具名错误（不发请求）与 year/quarter 约束', async () => {
  const { exec, calls } = scriptedExecutor(() => parse(KLINE_JSON));
  const adapter = makeAdapter(exec);
  await assert.rejects(adapter.fetchDailyBars('600519', 'bad-date', '2026-10-22'), (e: unknown) => e instanceof AdapterError && e.code === 'BAOSTOCK_DATE_INVALID');
  await assert.rejects(adapter.fetchQuarterFinancials('600519', 2026), (e: unknown) => e instanceof AdapterError && e.code === 'BAOSTOCK_ARGS_INVALID');
  await assert.rejects(adapter.fetchQuarterFinancials('600519', 1800, 1), (e: unknown) => e instanceof AdapterError && e.code === 'BAOSTOCK_ARGS_INVALID');
  assert.equal(calls.length, 0, '校验在请求前拦截，零真实调用');
});
