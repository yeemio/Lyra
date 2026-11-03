/**
 * Lyra · 行业分类/股票基本资料映射与缺口登记单测（P1 W6）。不碰网络：
 * 纯映射用 fixture 行；适配器端到端用注入执行器 + 本地 lyra-pg 隔离 schema。
 * 真实口径锁定（2026-10-25 实测）：query_stock_industry 返回证监会行业分类。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { asOfFacts } from '../pintime/facts.js';
import type { BridgeResponse, BridgeRow } from './adapter-types.js';
import { applyP1Migration } from './backoff.js';
import { BAOSTOCK_ADAPTER_VERSION, BaoStockAdapter, INDUSTRY_CLASS_VERSION_TAG, mapRowsToFacts, type BridgeExecutor } from './baostock.js';
import { SW2014_GAP, SW2014_GAP_ID, SW_CLASS_SOURCE_GAP, SW_CLASS_SOURCE_GAP_ID, csrcIndustryGroup } from './swclass.js';

// ===== fixture（桥 stdout 形态；字段照 2026-10-25 真实探测）=====

const SW_JSON = JSON.stringify({
  ok: true,
  rows: [
    { updateDate: '2026-10-19', code: 'sh.600519', code_name: '贵州茅台', industry: 'C15酒、饮料和精制茶制造业', industryClassification: '证监会行业分类' },
    { updateDate: '2026-10-19', code: 'sz.000001', code_name: '平安银行', industry: 'J66货币金融服务', industryClassification: '证监会行业分类' },
    { updateDate: '2026-10-19', code: 'sh.600001', code_name: '邯郸钢铁', industry: '', industryClassification: '证监会行业分类' }, // 退市无分类 → 拒绝
    { updateDate: '2026-10-19', code: 'sh.510300', code_name: '沪深300ETF', industry: 'J金融业', industryClassification: '证监会行业分类' }, // ETF → 拒绝
  ],
});

const BASIC_JSON = JSON.stringify({
  ok: true,
  rows: [{ code: 'sh.600519', code_name: '贵州茅台', ipoDate: '2001-08-27', outDate: '', type: '1', status: '1' }],
});

const MAP_CTX = { adapterVersion: BAOSTOCK_ADAPTER_VERSION, fetchedAt: '2026-10-25T03:00:00.000Z', artifactSha256: 'b'.repeat(64) };

test('映射·sw_industry：INDUSTRY_CLASS_VERSION，版本轴如实 csrc@current，availableAt=抓取时刻', () => {
  const rows = (JSON.parse(SW_JSON) as BridgeResponse).rows as BridgeRow[];
  const { facts, rejections } = mapRowsToFacts('sw_industry', [], rows, MAP_CTX);
  assert.equal(facts.length, 2);
  assert.equal(rejections.length, 2);
  assert.equal(rejections[0]?.code, 'INDUSTRY_CLASS_VALUE_MISSING', '行业值为空（退市）拒绝');
  assert.equal(rejections[1]?.code, 'INDUSTRY_CLASS_CODE_INVALID', '非 STOCK 主体拒绝');
  const f0 = facts[0]?.fact;
  assert.ok(f0);
  assert.equal(f0.factKind, 'INDUSTRY_CLASS_VERSION');
  assert.equal(f0.subjectType, 'STOCK');
  assert.equal(f0.subjectId, '600519');
  assert.equal(f0.availableAt, MAP_CTX.fetchedAt, '当前快照 availableAt=抓取时刻（我们此刻才知道该表）');
  assert.equal(f0.eventAt, MAP_CTX.fetchedAt);
  assert.equal(f0.validFrom, null, '官方生效日未知 → null，不编造');
  assert.equal(f0.sourcePublishedAt, null);
  const tv = f0.typedValue as BridgeRow;
  assert.equal(tv.industry, 'C15酒、饮料和精制茶制造业', 'industry 原文保留');
  assert.equal(tv.industryClassification, '证监会行业分类', 'industryClassification 原文保留');
  assert.equal(tv.updateDate, '2026-10-19', '来源自述数据时点原文保留');
  assert.equal(tv.classVersion, INDUSTRY_CLASS_VERSION_TAG, '适配器自加上下文字段 classVersion');
  assert.equal(INDUSTRY_CLASS_VERSION_TAG, 'csrc@current', '实测口径：证监会行业分类，不伪造 sw-l1@2021');
  assert.equal(facts[0]?.objectKey, 'csrc@current');
  assert.equal(facts[0]?.supersedesWiring, false, '当前快照不接 supersedes');
  // 重放同 rows 同 factId（版本轴进 factId 派生）
  const again = mapRowsToFacts('sw_industry', [], rows, MAP_CTX);
  assert.equal(again.facts[0]?.fact.factId, f0.factId);
});

test('映射·stock_basic：STOCK_BASIC 当前快照，availableAt=抓取时刻，无 isST 字段如实', () => {
  const rows = (JSON.parse(BASIC_JSON) as BridgeResponse).rows as BridgeRow[];
  const { facts, rejections } = mapRowsToFacts('stock_basic', ['sh.600519'], rows, MAP_CTX);
  assert.equal(facts.length, 1);
  assert.equal(rejections.length, 0);
  const f = facts[0]?.fact;
  assert.ok(f);
  assert.equal(f.factKind, 'STOCK_BASIC');
  assert.equal(f.subjectId, '600519');
  assert.equal(f.availableAt, MAP_CTX.fetchedAt);
  assert.equal(f.validFrom, null, '现名/状态生效日未知 → null');
  assert.equal(facts[0]?.objectKey, 'current');
  assert.deepEqual(f.typedValue, rows[0], 'query_stock_basic 行原文（无 isST，实测字段集）');
  // 拒绝路径
  const missing = mapRowsToFacts('stock_basic', [], [{ code: '', code_name: 'x' }], MAP_CTX);
  assert.equal(missing.rejections[0]?.code, 'STOCK_BASIC_CODE_MISSING');
  const etf = mapRowsToFacts('stock_basic', [], [{ code: 'sh.510300', code_name: 'ETF' }], MAP_CTX);
  assert.equal(etf.rejections[0]?.code, 'STOCK_BASIC_CODE_INVALID');
});

test('缺口登记：SW2014_GAP 与 SW_CLASS_SOURCE_GAP 文本含 id 与诚实声明', () => {
  assert.ok(SW2014_GAP.startsWith(`${SW2014_GAP_ID}：`));
  assert.ok(SW2014_GAP.includes('不得伪造'));
  assert.ok(SW_CLASS_SOURCE_GAP.startsWith(`${SW_CLASS_SOURCE_GAP_ID}：`));
  assert.ok(SW_CLASS_SOURCE_GAP.includes('证监会行业分类'), '实测事实入缺口文本');
  assert.ok(SW_CLASS_SOURCE_GAP.includes('非 PLAN §1 冻结的申万一级口径') || SW_CLASS_SOURCE_GAP.includes('申万一级'), '代行口径显著标注');
});

test('csrcIndustryGroup：GB/T 门类+大类前缀提取', () => {
  assert.equal(csrcIndustryGroup('C15酒、饮料和精制茶制造业'), 'C15');
  assert.equal(csrcIndustryGroup('J66货币金融服务'), 'J66');
  assert.equal(csrcIndustryGroup('A01农业'), 'A01');
  assert.equal(csrcIndustryGroup('食品饮料'), 'UNCLASSIFIED', '申万式命名不可分组（如实落 UNCLASSIFIED）');
  assert.equal(csrcIndustryGroup(''), 'UNCLASSIFIED');
});

// ===== 适配器端到端（注入执行器；本地 lyra-pg 隔离 schema；不碰外网）=====

let admin: Pool;
let schema: string;
let pool: Pool;
let artifactsDir: string;
let store: ArtifactStore;

before(async () => {
  admin = createPool();
  schema = `p1_w6_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w6-sw-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
});

test('适配器·fetchSwIndustry/fetchStockBasic：原件入库 + 事实落库 + as-of 可见 + 幂等', async () => {
  const responses = new Map<string, BridgeResponse>([
    ['sw_industry', JSON.parse(SW_JSON) as BridgeResponse],
    ['stock_basic', JSON.parse(BASIC_JSON) as BridgeResponse],
  ]);
  const calls: string[][] = [];
  const exec: BridgeExecutor = async (args) => {
    calls.push(args);
    const r = responses.get(args[0] ?? '');
    if (r === undefined) throw new Error(`unexpected command ${args[0]}`);
    return r;
  };
  const adapter = new BaoStockAdapter({ pool, store, execBridge: exec, now: () => new Date('2026-10-25T03:00:00Z') });

  const sw = await adapter.fetchSwIndustry();
  assert.deepEqual(calls[0], ['sw_industry'], '全量无参数');
  assert.equal(sw.scope, 'baostock:industry_class:');
  assert.equal(sw.rowCount, 4);
  assert.equal(sw.insertedFactIds.length, 2);
  assert.equal(sw.rejectedRows.length, 2);

  const basic = await adapter.fetchStockBasic('600519');
  assert.deepEqual(calls[1], ['stock_basic', 'sh.600519'], '裸代码归一');
  assert.equal(basic.scope, 'baostock:stock_basic:sh.600519');
  assert.equal(basic.insertedFactIds.length, 1);

  // as-of 读回：抓取时刻前不可见（诚实），抓取时刻后可见
  const beforeFetch = await asOfFacts(pool, { factKind: 'INDUSTRY_CLASS_VERSION', asOf: new Date('2026-10-25T02:59:59Z') });
  assert.equal(beforeFetch.length, 0, '抓取前一秒不可见');
  const afterFetch = await asOfFacts(pool, { factKind: 'INDUSTRY_CLASS_VERSION', asOf: new Date('2026-10-25T03:00:00Z') });
  assert.equal(afterFetch.length, 2);
  const mt = await asOfFacts(pool, { subjectId: '600519', factKind: 'STOCK_BASIC', asOf: new Date('2026-10-26T00:00:00Z') });
  assert.equal(mt.length, 1);
  assert.equal((mt[0]?.typedValue as BridgeRow).ipoDate, '2001-08-27');

  // 幂等重放：同 rows 同 factId → IDENTICAL
  const sw2 = await adapter.fetchSwIndustry();
  assert.equal(sw2.insertedFactIds.length, 0);
  assert.equal(sw2.identicalFactIds.length, 2);
});
