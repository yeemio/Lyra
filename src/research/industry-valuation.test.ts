/**
 * Lyra · 申万一级行业中位估值单测（B 类 W36: code-writer-pro）。纯函数用例：不碰网络、不碰 DB。
 * 覆盖：体系判定（2014/2021 边界、pre-2014 具名拒绝）、中位数奇偶（偶数取中间两数均值
 * 含 scale-12 half-up 舍入）、剔除非正计数、低覆盖标记（n<5）、缺行如实（missingIndustries）、
 * 行业不在窗口体系具名拒绝、重复代码/未来日期防御拒绝、截面分位（PERCENTRANK 口径：
 * 边界 0/1、1/3 与 2/3 舍入、同值同分位、n=1/空/越界具名拒绝）、行序确定性、
 * 链头选择与 inputs.ts pickSwIndustryAt 等价钉扎（合成分类史，含携带行/重叠行/证监会轴行）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimePointFact } from '../contracts.js';
import { decFromString, decToString } from '../settlement/decimal.js';
import { pickSwIndustryAt } from './inputs.js';
import {
  IndustryValuationError,
  LOW_COVERAGE_MIN,
  industryMedianPE,
  pePercentileOf,
  pickSwChainHeadAt,
  stockPEOf,
  swL1OfWindow,
  valuationIndustryCodes,
  valuationSystemOf,
  type StockPESample,
} from './industry-valuation.js';

const AS_OF = '2026-06-30';

/** 合成样本：close/eps 定点字符串；PE = close/eps；日期默认 ≤ AS_OF（barDate=asOf 合法）。 */
function sample(
  code: string,
  industryIndexCode: string,
  close: string,
  eps: string,
  dates?: Partial<Pick<StockPESample, 'barDate' | 'statDate' | 'pubDate'>>,
): StockPESample {
  return {
    code,
    industryIndexCode,
    close,
    barDate: dates?.barDate ?? AS_OF,
    epsTTM: eps,
    statDate: dates?.statDate ?? '2026-03-31',
    pubDate: dates?.pubDate ?? '2026-04-30',
  };
}

/** 2014 窗口（asOf 2020-06-30）相容日期。 */
const D2020 = { barDate: '2020-06-30', statDate: '2020-03-31', pubDate: '2020-04-30' } as const;

const D = (s: string) => decFromString(s);

// ===== 体系判定 =====

test('valuationSystemOf：2014/2021 边界与 pre-2014 具名拒绝', () => {
  assert.equal(valuationSystemOf('2026-06-30'), '2021');
  assert.equal(valuationSystemOf('2021-07-30'), '2021');
  assert.equal(valuationSystemOf('2021-07-29'), '2014');
  assert.equal(valuationSystemOf('2014-02-21'), '2014');
  assert.throws(() => valuationSystemOf('2014-02-20'), (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_AS_OF_PRE_2014');
  assert.throws(() => valuationSystemOf('2026/06/30'), (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_AS_OF_INVALID');
  assert.equal(valuationIndustryCodes('2021').length, 31);
  assert.equal(valuationIndustryCodes('2014').length, 28);
  assert.ok(valuationIndustryCodes('2021').includes('801950') && !valuationIndustryCodes('2021').includes('801020'));
  assert.ok(valuationIndustryCodes('2014').includes('801020') && !valuationIndustryCodes('2014').includes('801950'));
});

// ===== 中位数：奇偶与偶数 half-up 舍入 =====

test('奇数个样本：中位 = 正中值（乱序输入、peSeries 升序）', () => {
  const t = industryMedianPE([
    sample('600001', '801010', '60', '2'), // PE 30
    sample('600002', '801010', '20', '2'), // PE 10
    sample('600003', '801010', '40', '2'), // PE 20
  ], AS_OF);
  assert.equal(t.rows.length, 1);
  const row = t.rows[0] as (typeof t.rows)[number];
  assert.equal(row.industryIndexCode, '801010');
  assert.equal(row.n, 3);
  assert.equal(row.medianPE, '20');
  assert.deepEqual(row.peSeries, ['10', '20', '30']);
  assert.equal(t.eligibleCount, 3);
  assert.equal(t.excludedNonPositiveTotal, 0);
});

test('偶数个样本：中位 = 中间两数均值（25 = (20+30)/2；15.5 = (10+21)/2）', () => {
  const a = industryMedianPE([
    sample('600001', '801010', '80', '2'), // 40
    sample('600002', '801010', '20', '2'), // 10
    sample('600003', '801010', '60', '2'), // 30
    sample('600004', '801010', '40', '2'), // 20
  ], AS_OF);
  assert.equal((a.rows[0] as (typeof a.rows)[number]).medianPE, '25');
  const b = industryMedianPE([
    sample('600001', '801010', '10', '1'), // 10
    sample('600002', '801010', '21', '1'), // 21
  ], AS_OF);
  assert.equal((b.rows[0] as (typeof b.rows)[number]).medianPE, '15.5');
});

test('偶数中位 scale-12 half-up：均值 15.0000000000005 → 15.000000000001', () => {
  const t = industryMedianPE([
    sample('600001', '801010', '10', '1'),                     // PE 10
    sample('600002', '801010', '20.000000000001', '1'),        // PE 20.000000000001
  ], AS_OF);
  assert.equal((t.rows[0] as (typeof t.rows)[number]).medianPE, '15.000000000001');
});

// ===== 剔除计数与低覆盖 =====

test('非正样本剔除并计数：epsTTM≤0 / 收盘≤0，有效样本照常中位', () => {
  const t = industryMedianPE([
    sample('600001', '801010', '20', '2'),  // 有效 PE 10
    sample('600002', '801010', '60', '2'),  // 有效 PE 30
    sample('600003', '801010', '5', '0'),   // epsTTM=0 剔除
    sample('600004', '801010', '5', '-1.5'),// epsTTM<0 剔除
    sample('600005', '801010', '0', '2'),   // 收盘=0 剔除
  ], AS_OF);
  const row = t.rows[0] as (typeof t.rows)[number];
  assert.equal(row.n, 2);
  assert.equal(row.excludedNonPositive, 3);
  assert.equal(row.medianPE, '20');
  assert.equal(t.inputCount, 5);
  assert.equal(t.eligibleCount, 2);
  assert.equal(t.excludedNonPositiveTotal, 3);
});

test('低覆盖标记：n<5 lowCoverage=true，n=5 false', () => {
  const mk = (n: number) => industryMedianPE(
    Array.from({ length: n }, (_, i) => sample(`60000${String(i + 1)}`, '801010', String(10 + i), '1')),
    AS_OF,
  );
  const four = mk(4);
  const five = mk(5);
  assert.equal((four.rows[0] as (typeof four.rows)[number]).lowCoverage, true);
  assert.equal((five.rows[0] as (typeof five.rows)[number]).lowCoverage, false);
  assert.equal(LOW_COVERAGE_MIN, 5);
  // 偶数 5 样本中位 = 第 3 个（10,11,12,13,14 → 12）
  assert.equal((five.rows[0] as (typeof five.rows)[number]).medianPE, '12');
});

// ===== 缺行、全剔除行、行序 =====

test('缺行如实：单行业输入 → 其余 30 行业列 missingIndustries；空输入全缺', () => {
  const t = industryMedianPE([sample('600519', '801120', '1185.49', '66.052123')], AS_OF);
  assert.equal(t.rows.length, 1);
  assert.equal(t.missingIndustries.length, 30);
  assert.ok(!t.missingIndustries.includes('801120'));
  assert.deepEqual([...t.missingIndustries], [...t.missingIndustries].sort());
  const empty = industryMedianPE([], AS_OF);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.missingIndustries.length, 31);
  assert.equal(empty.inputCount, 0);
});

test('全剔除行业：n=0 行照常输出（medianPE=null），与"无样本缺行"区分', () => {
  const t = industryMedianPE([
    sample('600001', '801010', '5', '0'),
    sample('600002', '801030', '20', '2'),
  ], AS_OF);
  const row801010 = t.rows.find((r) => r.industryIndexCode === '801010') as (typeof t.rows)[number];
  assert.equal(row801010.n, 0);
  assert.equal(row801010.medianPE, null);
  assert.equal(row801010.excludedNonPositive, 1);
  assert.equal(row801010.lowCoverage, true);
  assert.ok(!t.missingIndustries.includes('801010')); // 有输入样本（全剔除）≠ 无样本缺行
  assert.ok(t.missingIndustries.includes('801120'));
});

test('行序确定性：行业代码升序', () => {
  const t = industryMedianPE([
    sample('600001', '801980', '10', '1'),
    sample('600002', '801010', '10', '1'),
    sample('600003', '801150', '10', '1'),
  ], AS_OF);
  assert.deepEqual(t.rows.map((r) => r.industryIndexCode), ['801010', '801150', '801980']);
  assert.deepEqual(t.rows.map((r) => r.name), [null, null, null]); // 未注入名称标签 → null
  const named = industryMedianPE([sample('600519', '801120', '1185.49', '66.052123')], AS_OF, {
    names: new Map([['801120', '食品饮料']]),
  });
  assert.equal((named.rows[0] as (typeof named.rows)[number]).name, '食品饮料');
});

// ===== 防御性具名拒绝 =====

test('行业不在 as-of 窗口体系：具名拒绝（801020 于 2021 窗口 / 801950 于 2014 窗口；2014 窗口 801020 合法）', () => {
  assert.throws(
    () => industryMedianPE([sample('600001', '801020', '10', '1')], AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_INDUSTRY_OUT_OF_SYSTEM',
  );
  assert.throws(
    () => industryMedianPE([sample('600001', '801950', '10', '1', D2020)], '2020-06-30'),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_INDUSTRY_OUT_OF_SYSTEM',
  );
  assert.doesNotThrow(() => industryMedianPE([sample('600001', '801020', '10', '1', D2020)], '2020-06-30'));
});

test('重复代码 / 未来日期（barDate、pubDate、statDate）防御拒绝', () => {
  assert.throws(
    () => industryMedianPE([sample('600001', '801010', '10', '1'), sample('600001', '801030', '10', '1')], AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_DUPLICATE_CODE',
  );
  const futureBar = { ...sample('600001', '801010', '10', '1'), barDate: '2026-07-01' };
  assert.throws(
    () => industryMedianPE([futureBar], AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_FUTURE_DATED',
  );
  const futurePub = { ...sample('600001', '801010', '10', '1'), pubDate: '2026-07-01' };
  assert.throws(
    () => industryMedianPE([futurePub], AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_FUTURE_DATED',
  );
  const futureStat = { ...sample('600001', '801010', '10', '1'), statDate: '2026-07-15' };
  assert.throws(
    () => industryMedianPE([futureStat], AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_FUTURE_DATED',
  );
});

test('stockPEOf：close/epsTTM 精确相除；非正与未来日期具名拒绝', () => {
  assert.equal(decToString(stockPEOf(sample('600519', '801120', '20', '2'), AS_OF)), '10');
  assert.throws(
    () => stockPEOf(sample('600003', '801010', '5', '0'), AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_NON_POSITIVE',
  );
  assert.throws(
    () => stockPEOf({ ...sample('600001', '801010', '10', '1'), barDate: '2026-07-01' }, AS_OF),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_SAMPLE_FUTURE_DATED',
  );
});

// ===== 截面分位（PERCENTRANK 口径）=====

test('pePercentileOf 边界：唯一最小 = 0、唯一最大 = 1（n=4 截面）', () => {
  const s = [D('10'), D('20'), D('30'), D('40')];
  assert.equal(decToString(pePercentileOf(D('10'), s)), '0');
  assert.equal(decToString(pePercentileOf(D('40'), s)), '1');
});

test('pePercentileOf：中位成员 1/3 与 2/3（scale-12 half-up：0.333333333333 / 0.666666666667）', () => {
  const s = [D('10'), D('20'), D('30'), D('40')];
  assert.equal(decToString(pePercentileOf(D('20'), s)), '0.333333333333');
  assert.equal(decToString(pePercentileOf(D('30'), s)), '0.666666666667');
});

test('pePercentileOf 同值同分位：并列最小仍为 0、并列之内取同分位', () => {
  const s = [D('10'), D('10'), D('30')];
  assert.equal(decToString(pePercentileOf(D('10'), s)), '0'); // 严格小于 10 的样本数 0
  assert.equal(decToString(pePercentileOf(D('30'), s)), '1'); // 2/2
  const s2 = [D('10'), D('20'), D('20'), D('40')];
  assert.equal(decToString(pePercentileOf(D('20'), s2)), '0.333333333333'); // 1/3
});

test('pePercentileOf 具名拒绝：空截面 / 单样本（n−1=0）/ 越出截面范围', () => {
  assert.throws(
    () => pePercentileOf(D('10'), []),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_PERCENTILE_EMPTY',
  );
  assert.throws(
    () => pePercentileOf(D('10'), [D('10')]),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_PERCENTILE_SINGLE_SAMPLE',
  );
  const s = [D('10'), D('20'), D('30')];
  assert.throws(
    () => pePercentileOf(D('5'), s),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_PERCENTILE_OUT_OF_RANGE',
  );
  assert.throws(
    () => pePercentileOf(D('50'), s),
    (e: unknown) => e instanceof IndustryValuationError && e.code === 'INDUSTRY_VALUATION_PERCENTILE_OUT_OF_RANGE',
  );
});

test('表与分位联动：row.peSeries 即 pePercentileOf 的截面输入（口径一致）', () => {
  const t = industryMedianPE([
    sample('600001', '801080', '10', '1'), // PE 10
    sample('600002', '801080', '20', '1'), // PE 20
    sample('600003', '801080', '30', '1'), // PE 30
  ], AS_OF);
  const row = t.rows[0] as (typeof t.rows)[number];
  const series = row.peSeries.map(D);
  const pe600002 = stockPEOf(sample('600002', '801080', '20', '1'), AS_OF);
  assert.equal(decToString(pePercentileOf(pe600002, series)), '0.5');
});

// ===== 链头选择与 inputs.ts pickSwIndustryAt 等价钉扎 =====

let synthSeq = 0;
/** 合成申万轴分类行（结构对齐 sw@p1 适配器 typedValue；validFrom/validTo 为 ISO 时间戳字符串）。 */
function classFact(o: {
  体系?: string;
  行业代码: string;
  l1IndexCode?: string | null;
  validFrom: string | null;
  validTo: string | null;
}): TimePointFact {
  synthSeq += 1;
  return {
    factId: `synth-class-${String(synthSeq).padStart(3, '0')}`,
    subjectType: 'STOCK',
    subjectId: '600000',
    factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: {
      体系: o.体系,
      l1IndexCode: o.l1IndexCode ?? null,
      行业代码: o.行业代码,
      股票代码: '600000',
    },
    validFrom: o.validFrom,
    validTo: o.validTo,
    eventAt: o.validFrom,
    sourcePublishedAt: null,
    firstObservedAt: '2026-10-25T00:00:00.000Z',
    availableAt: o.validFrom ?? '2026-10-25T00:00:00.000Z',
    supersedesFactId: null,
    artifactSha256: 'a'.repeat(64),
    adapterVersion: 'sw@p1',
  };
}

const CUTOFF = new Date('2026-06-30T07:00:00.000Z'); // asOf 15:00+08

test('链头选择与 pickSwIndustryAt 等价：携带行 / 区间闭合 / 重叠取 validFrom 最新 / 证监会轴不参与 / 空集', () => {
  // 携带 pre2014 行（区间开放至今）→ 两边同选该行；窗口前缀解释取得归属（存库 l1IndexCode=null 是铸造体系口径）
  const carried = [classFact({ 体系: 'pre2014', 行业代码: '410102', l1IndexCode: null, validFrom: '2003-11-10T16:00:00.000Z', validTo: null })];
  assert.equal(pickSwChainHeadAt(carried, CUTOFF)?.fact.factId, pickSwIndustryAt(carried, CUTOFF)?.fact.factId);
  assert.equal(swL1OfWindow(pickSwChainHeadAt(carried, CUTOFF)!, '2021'), '801160'); // 41 公用事业（读取窗口解释）
  assert.equal(pickSwIndustryAt(carried, CUTOFF)?.l1IndexCode, '801160'); // 研究和结算同用冻结窗口映射

  // pre2014 行被 2021 行闭合 → 只选 2021 行
  const closed = [
    classFact({ 体系: 'pre2014', 行业代码: '340301', l1IndexCode: null, validFrom: '2001-07-30T16:00:00.000Z', validTo: '2021-07-29T16:00:00.000Z' }),
    classFact({ 体系: '2021', 行业代码: '340501', l1IndexCode: '801120', validFrom: '2021-07-29T16:00:00.000Z', validTo: null }),
  ];
  const headClosed = pickSwChainHeadAt(closed, CUTOFF);
  assert.equal(headClosed?.fact.factId, pickSwIndustryAt(closed, CUTOFF)?.fact.factId);
  assert.equal(headClosed?.fact.typedValue && (headClosed.fact.typedValue as Record<string, unknown>)['体系'], '2021');

  // 同体系两行区间重叠（数据异常形态）→ 同取 validFrom 最新
  const overlap = [
    classFact({ 体系: '2021', 行业代码: '340501', l1IndexCode: '801120', validFrom: '2022-05-09T16:00:00.000Z', validTo: null }),
    classFact({ 体系: '2021', 行业代码: '340502', l1IndexCode: '801120', validFrom: '2024-01-02T16:00:00.000Z', validTo: null }),
  ];
  assert.equal(pickSwChainHeadAt(overlap, CUTOFF)?.fact.factId, pickSwIndustryAt(overlap, CUTOFF)?.fact.factId);

  // pre2014 开放区间与 2021 行并存（体系序最末胜出）
  const mixed = [
    classFact({ 体系: 'pre2014', 行业代码: '220311', l1IndexCode: null, validFrom: '2011-10-09T16:00:00.000Z', validTo: null }),
    classFact({ 体系: '2021', 行业代码: '220301', l1IndexCode: '801030', validFrom: '2021-07-29T16:00:00.000Z', validTo: null }),
  ];
  assert.equal(pickSwChainHeadAt(mixed, CUTOFF)?.fact.factId, pickSwIndustryAt(mixed, CUTOFF)?.fact.factId);

  // 证监会轴行（体系 字段缺失）不参与
  const withCsrc = [
    classFact({ 行业代码: '', validFrom: '2026-10-24T16:00:00.000Z', validTo: null }), // 无 体系 → 忽略
    classFact({ 体系: '2021', 行业代码: '340501', l1IndexCode: '801120', validFrom: '2021-07-29T16:00:00.000Z', validTo: null }),
  ];
  assert.equal(pickSwChainHeadAt(withCsrc, CUTOFF)?.fact.factId, pickSwIndustryAt(withCsrc, CUTOFF)?.fact.factId);

  // 截点早于全部 validFrom → 两边同 null；区间内截点（2010）两边同选 pre2014 行
  assert.equal(pickSwChainHeadAt(closed, new Date('2000-01-01T00:00:00.000Z')), null);
  assert.equal(pickSwIndustryAt(closed, new Date('2000-01-01T00:00:00.000Z')), null);
  assert.equal(
    pickSwChainHeadAt(closed, new Date('2010-01-01T00:00:00.000Z'))?.fact.factId,
    pickSwIndustryAt(closed, new Date('2010-01-01T00:00:00.000Z'))?.fact.factId,
  );
});

test('窗口前缀解释：2014 退役于 2021 的前缀（21 采掘 → null 不猜）；21 于 2014 表、51 于两表均有效（表冻结值照用）', () => {
  const head21 = { fact: classFact({ 体系: '2014', 行业代码: '210101', l1IndexCode: '801020', validFrom: '2014-02-20T16:00:00.000Z', validTo: null }), system: '2014' };
  assert.equal(swL1OfWindow(head21, '2014'), '801020');
  assert.equal(swL1OfWindow(head21, '2021'), null); // 采掘在 2021 拆分（74 煤炭/75 石油石化），前缀表无 21 → 不猜
  const head51 = { fact: classFact({ 体系: '2014', 行业代码: '510101', l1IndexCode: '801230', validFrom: '2014-02-20T16:00:00.000Z', validTo: null }), system: '2014' };
  assert.equal(swL1OfWindow(head51, '2021'), '801230'); // 综合 2021 体系仍在（801230）；携带行 = 未变更 → 照表归属
  assert.equal(swL1OfWindow(head51, '2014'), '801230');
  const head22 = { fact: classFact({ 体系: 'pre2014', 行业代码: '220311', l1IndexCode: null, validFrom: '2011-10-09T16:00:00.000Z', validTo: null }), system: 'pre2014' };
  assert.equal(swL1OfWindow(head22, '2021'), '801030'); // 基础化工
});
