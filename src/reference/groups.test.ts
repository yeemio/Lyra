/**
 * Lyra · 历史参照库 · 主群组机械选定单测（W15）。不碰网络不碰 DB：合成事实注入。
 * 口径合同：HISTORICAL-REFERENCE §5（逐层收窄、下限、嵌套声明、不降档）、§8（产出物与空匹配）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimePointFact } from '../contracts.js';
import {
  DEFAULT_MIN_GROUP_SAMPLE,
  NESTED_GROUP_DECLARATION,
  REVISION_NOTICE,
  SW_2021_CLASSIFY_EFFECTIVE,
  industryAsOf,
  marketCapTierOf,
  marketStateOf,
  selectGroups,
  tercileBounds,
  type IndustryAsOf,
  type MarketCapTierResult,
  type ReferenceEventLayers,
} from './groups.js';

// ===== 合成 INDUSTRY_CLASS_VERSION（sw@p1 形态：typedValue 中文键 + 计入日期ISO）=====

function icvFact(code: string, inDate: string, industryCode: string): TimePointFact {
  const availableAt = new Date(new Date(`${inDate}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
  return {
    factId: `icv-${code}-${inDate}-${industryCode}`,
    subjectType: 'STOCK',
    subjectId: code,
    factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: { 股票代码: code, 计入日期: inDate, 行业代码: industryCode, 计入日期ISO: inDate },
    validFrom: `${inDate}T00:00:00+08:00`,
    validTo: null,
    eventAt: `${inDate}T00:00:00+08:00`,
    sourcePublishedAt: null,
    firstObservedAt: '2026-10-25T00:00:00Z',
    availableAt,
    supersedesFactId: null,
    artifactSha256: '0'.repeat(64),
    adapterVersion: 'sw@p1',
  };
}

test('行业版本切换落例：同一股票 2015 与 2022 事件按事件时点取不同体系指数', () => {
  // 600157 永泰能源：2014 版 21（采掘 → 801020，2021-12-10 退役）；2021 版 41（公用事业 → 801160）。
  const rows = [icvFact('600157', '2015-01-05', '210000'), icvFact('600157', '2021-07-30', '410000')];
  const at2015 = industryAsOf(rows, '2015-08-10T16:00:00+08:00');
  assert.equal(at2015?.system, '2014');
  assert.equal(at2015?.l1IndexCode, '801020'); // 2014 版采掘（当时版本指数）
  assert.equal(at2015?.prefix, '21');
  const at2022 = industryAsOf(rows, '2022-03-01T16:00:00+08:00');
  assert.equal(at2022?.system, '2021');
  assert.equal(at2022?.l1IndexCode, '801160'); // 2021 版公用事业
  assert.notEqual(at2015?.l1IndexCode, at2022?.l1IndexCode);
});

test('行业 as-of 可得性：计入+1 未到事件时点的行不可见（保守 D+1，无未来泄漏）', () => {
  // 事件时点 2021-07-30 16:00（盘后）：2021 簇行 availableAt = 07-31 00:00+08 → 不可见，
  // 现行行仍为 2015 行；事件日 07-30 ≥ 切换点 → 窗口体系 2021，携带前缀 21 在 2021 表无映射 → null。
  const rows = [icvFact('600157', '2015-01-05', '210000'), icvFact('600157', '2021-07-30', '410000')];
  const beforeSwitch = industryAsOf(rows, '2021-07-29T16:00:00+08:00');
  assert.equal(beforeSwitch?.system, '2014');
  assert.equal(beforeSwitch?.l1IndexCode, '801020'); // 切换前夜：2014 版
  const atSwitchDay = industryAsOf(rows, '2021-07-30T16:00:00+08:00');
  assert.equal(atSwitchDay?.l1IndexCode, null); // 窗口体系 2021、现行行（不可见的新行之前）前缀 21 无 2021 映射——不猜
  // 无行可得 → null
  assert.equal(industryAsOf([], '2015-08-10T16:00:00+08:00'), null);
});

// ===== 市值档 =====

test('市值档：总股本可得用市值、不可得用成交额代理并标记 proxy=true（不编造股本）', () => {
  const fixed = ['50000000000', '200000000000'] as [string, string];
  // 总股本不可得 → 成交额代理：amount 3e9 < 5e10 → T1
  const proxy = marketCapTierOf({ date: '2022-03-01', close: '12.50', totalShares: null, amount: '3000000000' }, fixed, 'fixed');
  assert.equal(proxy?.tier, 'T1');
  assert.equal(proxy?.proxy, true);
  assert.equal(proxy?.basis, 'amount');
  assert.equal(proxy?.value, '3000000000');
  // 总股本可得：市值 = 12.5 × 4e9 = 5e10 → [5e10, 2e11) → T2
  const real = marketCapTierOf({ date: '2022-03-01', close: '12.50', totalShares: '4000000000', amount: '3000000000' }, fixed, 'fixed');
  assert.equal(real?.tier, 'T2');
  assert.equal(real?.proxy, false);
  assert.equal(real?.basis, 'marketCap');
  assert.equal(real?.value, '50000000000');
  // 输入不可得 → null（缺口，不推算）；分界倒序 → null
  assert.equal(marketCapTierOf({ date: '2022-03-01', close: null, totalShares: null, amount: null }, fixed, 'fixed'), null);
  assert.equal(marketCapTierOf({ date: '2022-03-01', close: '1', totalShares: '1', amount: '1' }, ['9', '1'], 'fixed'), null);
});

test('等分位预留默认：三等分位 P33/P67（次序统计量），样本不足返回 null', () => {
  const bounds = tercileBounds(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(bounds, ['3', '6']); // idx=floor(8/3)=2 → '3'；idx=floor(16/3)=5 → '6'
  assert.equal(tercileBounds(['1']), null);
  assert.equal(tercileBounds([null, undefined]), null);
});

// ===== 市场状态 =====

function hs300Bar(date: string, close: string): { date: string; open: string; close: string; volume: string } {
  return { date, open: close, close, volume: '1' };
}

test('市场状态：沪深300 近 20 个已收盘交易日端点比较；事件时点之后的行不计入', () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2022-02-${String(1 + i).padStart(2, '0')}`);
  const up = marketStateOf(dates.map((d, i) => hs300Bar(d, String(4000 + i * 10))), '2022-02-28T16:00:00+08:00');
  assert.equal(up?.state, 'UP');
  assert.equal(up?.from, '2022-02-01');
  assert.equal(up?.to, '2022-02-20');
  const down = marketStateOf(dates.map((d, i) => hs300Bar(d, String(4000 - i * 10))), '2022-02-28T16:00:00+08:00');
  assert.equal(down?.state, 'DOWN');
  // 恰好相等 → UP（≥ 判定，§5 层 4 默认算子）
  const flat = marketStateOf(dates.map(() => hs300Bar(dates[0]!, '4000')), '2022-02-28T16:00:00+08:00');
  assert.equal(flat?.state, 'UP');
  // 事件时点在 02-20 15:00 收盘前 → 最近已收盘行不足 20 → null（缺口）
  const early = marketStateOf(dates.map((d, i) => hs300Bar(d, String(4000 + i))), '2022-02-20T14:00:00+08:00');
  assert.equal(early, null);
  assert.equal(marketStateOf(dates.slice(0, 19).map((d) => hs300Bar(d, '4000')), '2022-02-28T16:00:00+08:00'), null);
});

// ===== selectGroups：四层收窄与回退 =====

const IND_X: IndustryAsOf = { prefix: '41', system: '2021', l1IndexCode: '801160', industryCode: '410101', inDate: '2021-07-30' };
const IND_Y: IndustryAsOf = { prefix: '48', system: '2021', l1IndexCode: '801780', industryCode: '480101', inDate: '2021-07-30' };

function capOf(tier: 'T1' | 'T2' | 'T3', proxy = true): MarketCapTierResult {
  return {
    tier, proxy, basis: proxy ? 'amount' : 'marketCap', value: '1',
    bounds: ['1', '2'], boundsMethod: 'tercile-reserved', date: '2022-03-01',
  };
}

function sampleOf(i: number, over: Partial<ReferenceEventLayers>): ReferenceEventLayers {
  return {
    subject: `S${String(i).padStart(3, '0')}`,
    eventTime: '2022-03-01T16:00:00+08:00',
    eventKey: 'PERF_FORECAST',
    industry: IND_X,
    marketCap: capOf('T2'),
    marketState: 'UP',
    h1Excess: '0.01',
    h5Excess: '0.02',
    h20Excess: '0.03',
    invalidationDown: false,
    invalidationUp: false,
    dataGaps: [],
    ...over,
  };
}

const OPTS = {
  minGroupSample: DEFAULT_MIN_GROUP_SAMPLE,
  methodVersion: 'method@w15-test',
  adapterVersion: 'sw@p1;baostock@0.9.40-p1',
  inputAvailableAtMax: '2026-10-25T00:00:00Z',
  materializedAt: '2026-10-25T00:00:00Z',
};

const QUERY_BASE = {
  subject: 'S001',
  eventKey: 'PERF_FORECAST',
  eventTime: '2022-03-01T16:00:00+08:00',
  cutoff: '2022-03-01T16:00:00+08:00',
  industry: IND_X,
  marketCap: capOf('T2'),
  marketState: 'UP' as const,
};

test('四层全下钻：各层样本 ≥ 下限 → 主群组 = 市场状态层（最深层）', () => {
  const samples = Array.from({ length: 32 }, (_, i) => sampleOf(i + 1, {}));
  const r = selectGroups(QUERY_BASE, samples, OPTS);
  assert.deepEqual(r.groupPath.map((l) => [l.layer, l.reason]), [
    ['BASE', 'DRILL'],
    ['EVENT_TYPE', 'DRILL'],
    ['INDUSTRY', 'DRILL'],
    ['MARKET_CAP', 'DRILL'],
    ['MARKET_STATE', 'DRILL'],
  ]);
  assert.equal(r.primaryGroup?.layer, 'MARKET_STATE');
  assert.equal(r.primaryGroup?.sampleCount, 32);
  assert.equal(r.primaryGroup?.key, 'mkt:UP');
  // 父层结果：每层样本数与基础比例（同一统计口径）
  for (const layer of r.groupPath) {
    if (layer.reason === 'DRILL') {
      assert.notEqual(layer.baseRate, null);
      assert.equal(layer.baseRate!.sampleCount, layer.sampleCount);
      assert.equal(layer.baseRate!.h20.up, layer.sampleCount); // 全部 +0.03
    }
  }
  // 行业层 note 显式登记版本与切换点
  const ind = r.groupPath.find((l) => l.layer === 'INDUSTRY')!;
  assert.match(ind.note ?? '', /2021版/);
  assert.match(ind.note ?? '', new RegExp(SW_2021_CLASSIFY_EFFECTIVE));
});

test('回退：市值档层样本 < 下限 → 停在行业层，主群组 = 行业层；停止层只给样本数不给比例', () => {
  // 35 个同类型：32 个行业 X（≥30）其中仅 20 个 T2（<30）→ STOP_MIN_SAMPLE。
  const samples = [
    ...Array.from({ length: 20 }, (_, i) => sampleOf(i + 1, { marketCap: capOf('T2') })),
    ...Array.from({ length: 12 }, (_, i) => sampleOf(i + 21, { marketCap: capOf('T3') })),
    ...Array.from({ length: 3 }, (_, i) => sampleOf(i + 33, { industry: IND_Y })),
  ];
  const r = selectGroups(QUERY_BASE, samples, OPTS);
  assert.deepEqual(r.groupPath.map((l) => [l.layer, l.reason]), [
    ['BASE', 'DRILL'],
    ['EVENT_TYPE', 'DRILL'],
    ['INDUSTRY', 'DRILL'],
    ['MARKET_CAP', 'STOP_MIN_SAMPLE'],
  ]);
  assert.equal(r.groupPath.find((l) => l.layer === 'MARKET_CAP')!.sampleCount, 20);
  assert.equal(r.groupPath.find((l) => l.layer === 'MARKET_CAP')!.baseRate, null); // 不降档凑样本，停止层无比例
  assert.equal(r.primaryGroup?.layer, 'INDUSTRY');
  assert.equal(r.primaryGroup?.sampleCount, 32);
});

test('输入缺失回退：目标事件行业不可得 → STOP_MISSING_INPUT + 具名缺口', () => {
  const samples = Array.from({ length: 32 }, (_, i) => sampleOf(i + 1, {}));
  const r = selectGroups({ ...QUERY_BASE, industry: null }, samples, OPTS);
  const ind = r.groupPath.find((l) => l.layer === 'INDUSTRY')!;
  assert.equal(ind.reason, 'STOP_MISSING_INPUT');
  assert.ok(r.dataGaps.some((g) => g.startsWith('INDUSTRY_L1_UNAVAILABLE_AT_EVENT:')));
  assert.equal(r.primaryGroup?.layer, 'EVENT_TYPE');
});

test('空结果 = 缺口：事件类型层无样本 → 空群组路径、无主群组、无任何比例数字', () => {
  const samples = Array.from({ length: 32 }, (_, i) => sampleOf(i + 1, {}));
  const r = selectGroups({ ...QUERY_BASE, eventKey: 'SHARE_UNLOCK' }, samples, OPTS);
  assert.deepEqual(r.groupPath, []);
  assert.equal(r.primaryGroup, null);
  assert.deepEqual(r.dataGaps, ['NO_SAMPLE_AT_EVENT_TYPE_LAYER:SHARE_UNLOCK']);
  // 声明仍强制携带
  assert.equal(r.nestedDeclaration, NESTED_GROUP_DECLARATION);
  assert.equal(r.revisionNotice, REVISION_NOTICE);
  // 无群组行携带样本数 ≥ 1：序列化后不出现 baseRatio/h20 等比例结构
  const serialized = JSON.stringify(r.groupPath);
  assert.equal(serialized, '[]');
});

test('嵌套声明与修订口径声明：固定文本随产出物强制携带（产出物级断言）', () => {
  const samples = Array.from({ length: 32 }, (_, i) => sampleOf(i + 1, {}));
  const r = selectGroups(QUERY_BASE, samples, OPTS);
  assert.match(r.nestedDeclaration, /相互嵌套/);
  assert.match(r.nestedDeclaration, /不是独立证据/);
  assert.match(r.nestedDeclaration, /不构成独立确认/);
  assert.match(r.revisionNotice, /一次性回填 2015–2026/);
  assert.match(r.revisionNotice, /公告 PDF 原文为准/);
  assert.equal(r.request.subject, 'S001');
  assert.equal(r.versionBinding.methodVersion, OPTS.methodVersion);
});

test('事件类型层低于下限：类型层即 STOP（构造小库）', () => {
  const small = Array.from({ length: 5 }, (_, i) => sampleOf(i + 1, {}));
  const r = selectGroups(QUERY_BASE, small, OPTS);
  // 事件类型层样本 5 < 30：层仍登记（样本数与原因），但不下钻、类型层成主群组
  assert.equal(r.groupPath.find((l) => l.layer === 'EVENT_TYPE')!.reason, 'DRILL'); // 类型层是首层（进入即 DRILL）
  assert.equal(r.groupPath.find((l) => l.layer === 'INDUSTRY')!.reason, 'STOP_MIN_SAMPLE');
  assert.equal(r.primaryGroup?.layer, 'EVENT_TYPE');
});
