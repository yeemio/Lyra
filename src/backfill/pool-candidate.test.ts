/**
 * Lyra · 研究池候选筛选单测（P1 W6）。不碰网络、不碰 DB：纯函数覆盖
 * 主板口径、ST/上市年限/成交额排除、每业前 3、全表降序前 N、并列稳定。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeRow } from '../adapters/adapter-types.js';
import { computeAvgAmount, isMainboardStock, selectPool, type CandidateEvidence } from './pool-candidate.js';

const BASIC_ROW: BridgeRow = { code: 'sh.600000', code_name: 'x', ipoDate: '2000-01-01', outDate: '', type: '1', status: '1' };

function evidence(overrides: Partial<CandidateEvidence>): CandidateEvidence {
  return {
    code: '600000',
    name: '样本',
    ipoDate: '2000-01-01',
    isST: '0',
    industry: 'C15酒、饮料和精制茶制造业',
    industryGroup: 'C15',
    avgAmountYuan: 2e8,
    barCount: 60,
    windowStart: '2026-07-22',
    windowEnd: '2026-10-23',
    amounts: [],
    basicRow: { ...BASIC_ROW },
    excludedReason: null,
    selectedRank: null,
    ...overrides,
  };
}

test('isMainboardStock：沪深主板前缀（R17，含 002/003），其余拒绝', () => {
  for (const code of ['600519', '601318', '603288', '605117', '000001', '001979', '002415', '003816']) {
    assert.equal(isMainboardStock(code), true, code);
  }
  for (const code of ['300750', '688981', '833171', '430047', '510300', '399001', '60051', '6005190']) {
    assert.equal(isMainboardStock(code), false, code);
  }
});

test('computeAvgAmount：算术平均；空窗口 NaN', () => {
  assert.equal(computeAvgAmount(['100000000', '200000000']), 150_000_000);
  assert.equal(computeAvgAmount(['50000000']), 50_000_000);
  assert.ok(Number.isNaN(computeAvgAmount([])));
});

test('selectPool：ST/名称ST/上市不满一年/成交额不足/行业缺失 各排除', () => {
  const items = [
    evidence({ code: '600001', name: 'ST示例', isST: '1' }),
    evidence({ code: '600002', name: '*ST退档' }),
    evidence({ code: '600003', ipoDate: '2026-01-05' }),
    evidence({ code: '600004', ipoDate: '2026-10-22' }),
    evidence({ code: '600005', avgAmountYuan: 0.5e8 }),
    evidence({ code: '600006', industry: '', industryGroup: 'UNCLASSIFIED' }),
    evidence({ code: '600007', barCount: 0, amounts: [], avgAmountYuan: Number.NaN }),
    evidence({ code: '600008', ipoDate: '' }),
  ];
  const { annotated, filterCounts } = selectPool(items, { topPerIndustry: 3, topN: 40, minAvgAmountYuan: 1e8, asOf: '2026-10-23' });
  const byCode = new Map(annotated.map((e) => [e.code, e.excludedReason]));
  assert.equal(byCode.get('600001'), 'IS_ST');
  assert.equal(byCode.get('600002'), 'ST_IN_NAME');
  assert.equal(byCode.get('600003'), 'LISTING_LT_1Y');
  assert.equal(byCode.get('600004'), 'LISTING_LT_1Y', '恰好差一天也不满一年');
  assert.equal(byCode.get('600005'), 'AVG_AMOUNT_BELOW_1E8');
  assert.equal(byCode.get('600006'), 'INDUSTRY_MISSING');
  assert.equal(byCode.get('600007'), 'NO_BARS');
  assert.equal(byCode.get('600008'), 'IPO_DATE_MISSING');
  assert.equal(filterCounts.TOTAL, 8);
  assert.equal(filterCounts.PASS_FILTER, 0);
});

test('selectPool：每业前 3 → 全表降序前 N（含并列稳定与边界正好一年）', () => {
  const items = [
    // C15 四只：第 4 只被每业上限排除
    evidence({ code: '600101', avgAmountYuan: 5e9 }),
    evidence({ code: '600102', avgAmountYuan: 4e9 }),
    evidence({ code: '600103', avgAmountYuan: 3e9 }),
    evidence({ code: '600104', avgAmountYuan: 2e9 }),
    // J66 两只
    evidence({ code: '600201', name: '银行甲', industry: 'J66货币金融服务', industryGroup: 'J66', avgAmountYuan: 1.5e9 }),
    evidence({ code: '600202', name: '银行乙', industry: 'J66货币金融服务', industryGroup: 'J66', avgAmountYuan: 1.4e9 }),
    // C26 一只（恰好上市满一年边界：2025-10-23，asOf 2026-10-23 → 满 365 天通过）
    evidence({ code: '600301', industry: 'C26化学原料和化学制品制造业', industryGroup: 'C26', avgAmountYuan: 1.2e9, ipoDate: '2025-10-23' }),
    // 并列稳定：与 C26 同额的 C30
    evidence({ code: '600401', industry: 'C30非金属矿物制品业', industryGroup: 'C30', avgAmountYuan: 1.2e9 }),
    evidence({ code: '600400', industry: 'C30非金属矿物制品业', industryGroup: 'C30', avgAmountYuan: 1.2e9 }),
  ];
  const { selected, annotated, filterCounts } = selectPool(items, { topPerIndustry: 3, topN: 40, minAvgAmountYuan: 1e8, asOf: '2026-10-23' });
  assert.equal(filterCounts.PASS_FILTER, 9);
  assert.equal(filterCounts.AFTER_INDUSTRY_CAP, 8, 'C15 第 4 名被每业前 3 排除');
  assert.equal(filterCounts.INDUSTRY_CAP_3, 1);
  assert.equal(selected.length, 8);
  assert.deepEqual(
    selected.map((e) => e.code),
    ['600101', '600102', '600103', '600201', '600202', '600301', '600400', '600401'],
    '全表按日均成交额降序，并列按代码升序（600400 < 600401）',
  );
  assert.deepEqual(selected.map((e) => e.selectedRank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(annotated.find((e) => e.code === '600104')?.excludedReason, 'INDUSTRY_CAP_3');
  // topN 截断
  const cut = selectPool(items, { topPerIndustry: 3, topN: 3, minAvgAmountYuan: 1e8, asOf: '2026-10-23' });
  assert.deepEqual(cut.selected.map((e) => e.code), ['600101', '600102', '600103']);
  assert.equal(cut.filterCounts.SELECTED, 3);
});
