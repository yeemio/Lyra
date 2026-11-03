/**
 * Lyra · 历史参照库 · 群组统计对象单测（W15）。不碰网络不碰 DB：纯函数构建统计块；
 * 持久化（reference_group_library）不在单测覆盖（applyReferenceMigration/saveGroupStats
 * 由 build.cli 真实运行验证）。
 * 口径合同：HISTORICAL-REFERENCE §8（产出物、匹配为空只有缺口）、§4（描述性统计）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NESTED_GROUP_DECLARATION, REVISION_NOTICE, type IndustryAsOf, type MarketCapTierResult, type ReferenceEventLayers } from './groups.js';
import { buildGroupLibrary } from './library.js';

const IND_X: IndustryAsOf = { prefix: '41', system: '2021', l1IndexCode: '801160', industryCode: '410101', inDate: '2021-07-30' };
const IND_Y: IndustryAsOf = { prefix: '48', system: '2021', l1IndexCode: '801780', industryCode: '480101', inDate: '2021-07-30' };

function capOf(tier: 'T1' | 'T2' | 'T3'): MarketCapTierResult {
  return { tier, proxy: true, basis: 'amount', value: '1', bounds: ['1', '2'], boundsMethod: 'tercile-reserved', date: '2022-03-01' };
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
  minGroupSample: 3,
  methodVersion: 'method@w15-test',
  adapterVersion: 'sw@p1;baostock@0.9.40-p1',
  inputAvailableAtMax: '2026-10-25T00:00:00Z',
  materializedAt: '2026-10-25T00:00:00Z',
};

test('全量构建：BASE/事件类型/行业/市值/市场状态块产出（各层 ≥ 下限即下钻），声明原样携带', () => {
  const samples = [
    sampleOf(1, { h20Excess: '0.1', invalidationUp: true }),
    sampleOf(2, { h20Excess: '0.2' }),
    sampleOf(3, { h20Excess: '0.3', invalidationDown: true }),
    sampleOf(4, { industry: IND_Y }), // 行业 Y 单样本 <3 → 无 Y 块（不降档凑样本）
  ];
  const lib = buildGroupLibrary(samples, OPTS);
  assert.equal(lib.totalSamples, 4);
  const keys = lib.groups.map((g) => g.groupKey).sort();
  assert.deepEqual(keys, [
    'all-events',
    'type:PERF_FORECAST',
    'type:PERF_FORECAST|sw2021:801160',
    'type:PERF_FORECAST|sw2021:801160|cap:T2:proxy-amount',
    'type:PERF_FORECAST|sw2021:801160|cap:T2:proxy-amount|mkt:UP',
  ]);

  const ind = lib.groups.find((g) => g.groupKey === 'type:PERF_FORECAST|sw2021:801160')!;
  assert.equal(ind.sampleCount, 3);
  assert.equal(ind.path.length, 2);
  assert.equal(ind.stats.h20.mean, '0.2'); // (0.1+0.2+0.3)/3 定点
  assert.equal(ind.stats.h20.median, '0.2');
  assert.equal(ind.stats.h20.n, 3);
  assert.equal(ind.stats.invalidation.upTriggered, 1);
  assert.equal(ind.stats.invalidation.downTriggered, 1);
  assert.equal(ind.stats.invalidation.n, 3);
  assert.equal(ind.stats.invalidation.thresholdPct, '10');
  assert.equal(ind.stats.invalidation.reserved, true);
  assert.equal(ind.baseRatio.h20.up, 3);
  assert.equal(ind.baseRatio.invalidation.n, 3);
  assert.equal(ind.nestedDeclaration, NESTED_GROUP_DECLARATION);
  assert.equal(ind.revisionNotice, REVISION_NOTICE);
  assert.ok(ind.reservedParams.some((p) => p.includes('INVALIDATION_THRESHOLD_PCT=10')));
  assert.ok(ind.reservedParams.some((p) => p.includes('MIN_GROUP_SAMPLE')));
  assert.ok(ind.reservedParams.some((p) => p.includes('MARKET_CAP_TIERS')));
  assert.equal(ind.versionBinding.materializedAt, OPTS.materializedAt);

  // 事件类型块 = 行业块父层（同口径）
  const typeBlock = lib.groups.find((g) => g.groupKey === 'type:PERF_FORECAST')!;
  assert.equal(typeBlock.sampleCount, 4);
  assert.equal(typeBlock.stats.h20.n, 4);
});

test('均值/中位数：偶数样本中位数取中间两数均值（定点）；缺样本窗口统计 n 减少', () => {
  const samples = [
    sampleOf(1, { h20Excess: '0.1' }),
    sampleOf(2, { h20Excess: '0.2' }),
    sampleOf(3, { h20Excess: '0.3' }),
    sampleOf(4, { h20Excess: '0.4', h5Excess: null }),
  ];
  const lib = buildGroupLibrary(samples, { ...OPTS, minGroupSample: 4 });
  const typeBlock = lib.groups.find((g) => g.groupKey === 'type:PERF_FORECAST')!;
  assert.equal(typeBlock.stats.h20.mean, '0.25');
  assert.equal(typeBlock.stats.h20.median, '0.25'); // (0.2+0.3)/2
  assert.equal(typeBlock.stats.h5.n, 3); // 一个样本 h5 缺失
  assert.equal(typeBlock.baseRatio.incompleteCount, 1); // 缺失样本计数
});

test('低于下限不产出群组块：事件类型样本 < MIN_GROUP_SAMPLE → 只有 BASE 块', () => {
  const samples = [sampleOf(1, {}), sampleOf(2, {})];
  const lib = buildGroupLibrary(samples, OPTS);
  assert.deepEqual(lib.groups.map((g) => g.groupKey), ['all-events']);
});

test('空库：缺口是合法产出——无群组块（BASE 亦不产出），dataGaps 为空集', () => {
  const lib = buildGroupLibrary([], OPTS);
  assert.deepEqual(lib.groups, []);
  assert.equal(lib.totalSamples, 0);
  assert.deepEqual(lib.dataGaps, []);
});

test('层输入缺失计数与样本缺口汇总（不静默）', () => {
  const samples = [
    sampleOf(1, { industry: null, dataGaps: ['SW_INDEX_BAR_MISSING:801160:2022-03-03'] }),
    sampleOf(2, {}),
    sampleOf(3, { marketState: null }),
  ];
  const lib = buildGroupLibrary(samples, OPTS);
  assert.equal(lib.layerInputMissing.industry, 1);
  assert.equal(lib.layerInputMissing.marketState, 1);
  assert.equal(lib.layerInputMissing.marketCap, 0);
  assert.ok(lib.dataGaps.includes('S001@2022-03-01T16:00:00+08:00:SW_INDEX_BAR_MISSING:801160:2022-03-03'));
});
