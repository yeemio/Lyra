import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidencePack, EvidenceTable } from './contracts.js';
import { computeMetrics } from './compute.js';
import { materialDateSummary, readableTable, tableLabel } from './report-tables.js';

const cutoff = '2026-11-01T00:00:00.000Z';
function table(tableId: string, columns: string[], rows: EvidenceTable['rows']): EvidenceTable {
  return { tableId, title: tableId, columns, rows, locators: [], cutoff, unitNote: null };
}
function pack(tables: EvidenceTable[], subject = '600101'): EvidencePack {
  return { taskId: 'synthetic-calc', subject, cutoff, builtAt: cutoff, packHash: '0'.repeat(64), tables,
    coverage: { financials: { periods: 0, latestPeriod: null, note: null }, bars: { count: 0, firstDate: null, lastDate: null, note: null },
      announcements: { count: 0, latestTitleAt: null, note: null }, margin: { count: 0, latestDate: null, note: null },
      holderCount: { count: 0, latestDate: null, note: null }, pledge: { count: 0, latestDate: null, note: null },
      industry: { swL1: null, note: null }, valuationInputs: { closePriceDate: null, sharesSource: null, epsTtmSource: null, note: null }, gaps: [] } };
}
function alignedPack(): EvidencePack {
  const dates = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 8, i * 2 + 1)).toISOString().slice(0, 10));
  return pack(['bars-daily', 'index-bars'].map((id, index) => ({
    ...table(id, ['date', 'close', 'amount', 'adjustflag'], dates.map((d, i) => [d, i === 19 ? (index ? 120 : 110) : 100, 1000, '3'])),
    priceBasis: 'UNADJUSTED_PRICE' as const,
  })));
}
function priceRow(p: EvidencePack) {
  const result = computeMetrics(p);
  const t = result.tables.find((t) => t.tableId === 'price-performance')!;
  const row = t.rows.find((r) => r[0] === 20)!;
  return { result, get: (col: string) => row[t.columns.indexOf(col)] };
}

test('I-19 非航运股票：同日期同原始价格口径允许精确比较，短窗口单独拒绝', () => {
  const { result, get } = priceRow(alignedPack());
  assert.ok(Math.abs(Number(get('stockReturnPct')) - 10) < 1e-10);
  assert.ok(Math.abs(Number(get('benchmarkReturnPct')) - 20) < 1e-10);
  assert.ok(Math.abs(Number(get('excessPct')) + 10) < 1e-10);
  assert.equal(get('comparisonReason'), null);
  assert.equal(result.checks.find((c) => c.name === 'price-comparison-20')!.ok, true);
  assert.equal(result.checks.find((c) => c.name === 'price-comparison-60')!.ok, false);
});

const failures: [string, (p: EvidencePack) => void, string][] = [
  ['不同末日', (p) => { p.tables[1]!.rows[19]![0] = '2026-10-10'; }, 'DATE_WINDOW_MISMATCH'],
  ['不同基日', (p) => { p.tables[1]!.rows[0]![0] = '2026-08-31'; }, 'DATE_WINDOW_MISMATCH'],
  ['同首尾但中间所给日期不同', (p) => { p.tables[1]!.rows[5]![0] = '2026-09-12'; }, 'DATE_WINDOW_MISMATCH'],
  ['缺少一行', (p) => { p.tables[1]!.rows.splice(5, 1); }, 'BENCHMARK_WINDOW_TOO_SHORT'],
  ['重复日期', (p) => { p.tables[1]!.rows[5]![0] = p.tables[1]!.rows[4]![0]!; }, 'BENCHMARK_DATE_ORDER_OR_DUPLICATE'],
  ['缺失日期', (p) => { p.tables[1]!.rows[0]![0] = null; }, 'BENCHMARK_DATE_INVALID'],
  ['不存在的日期', (p) => { p.tables[1]!.rows[0]![0] = '2026-02-30'; }, 'BENCHMARK_DATE_INVALID'],
  ['零价', (p) => { p.tables[0]!.rows[0]![1] = 0; }, 'STOCK_PRICE_INVALID'],
  ['中间空价', (p) => { p.tables[1]!.rows[5]![1] = null; }, 'BENCHMARK_PRICE_INVALID'],
  ['未知基准价格口径', (p) => { delete p.tables[1]!.priceBasis; }, 'PRICE_BASIS_UNVERIFIED'],
  ['混入复权价格', (p) => { p.tables[0]!.rows[5]![3] = '2'; }, 'PRICE_BASIS_UNVERIFIED'],
];
for (const [name, change, reason] of failures) test(`I-19 ${name}：该窗口基准/超额为空且具名`, () => {
  const p = alignedPack(); change(p);
  const { get } = priceRow(p);
  assert.equal(get('benchmarkReturnPct'), null);
  assert.equal(get('excessPct'), null);
  assert.equal(get('comparisonReason'), reason);
});

test('M-03 通用列名不认定科目；官方对账仅同公司同期间匹配', () => {
  assert.equal(tableLabel('MBRevenue'), '来源收入字段 MBRevenue');
  const fin = table('fin-quarterly', ['statDate', 'pubDate', 'MBRevenue', 'netProfit', 'npMargin'], [
    ['2026-06-30', '2026-08-30', 123, 12, 0.1], ['2026-09-30', '2026-10-30', 456, 45, 0.1],
  ]);
  const official = table('official-financials', ['reportPeriod', 'metric', 'value', 'sourceSubject'], [
    ['2026-06-30', 'operatingRevenue', 123, '600101'], ['2026-09-30', 'operatingRevenue', 456, '600102'],
  ]);
  const scopes = (p: EvidencePack) => {
    const t = computeMetrics(p).tables.find((t) => t.tableId === 'financial-source-reconciliation')!;
    return t.rows.map((r) => r[t.columns.indexOf('sourceRevenueScope')]);
  };
  assert.deepEqual(scopes(pack([fin, official])), ['营业收入（仅本期原件核实）', '未匹配/未核实，不改称报表科目']);
  assert.deepEqual(scopes(pack([fin, official], '600102')), ['未匹配/未核实，不改称报表科目', '营业收入（仅本期原件核实）']);
  const unknown = structuredClone(official); unknown.columns[3] = 'unknownSubject';
  assert.ok(scopes(pack([fin, unknown])).every((s) => String(s).startsWith('未匹配')));
  assert.equal(readableTable({ ...fin, note: null }).columns[2], '来源收入字段 MBRevenue');
});

test('M-02 摘要由所有实际行派生，缺市场快照也显示财报/运价，缺元数据不猜无三季报', () => {
  const tables = {
    'official-financials': { title: '财报', columns: ['reportPeriod'], rows: [['2026-09-30'], ['2025-12-31']], note: null },
    'freight-snapshot': { title: '运价', columns: ['date'], rows: [['2026-10-30'], ['2026-10-29']], note: null },
    'bars-daily': { title: '日线', columns: ['date'], rows: [['2026-10-31'], ['2026-10-28']], note: null },
  };
  const summary = materialDateSummary(tables);
  assert.ok(summary.includes('2025-12-31、2026-09-30') && summary.includes('2026-10-29、2026-10-30'));
  assert.ok(summary.includes('行情快照 未提供') && summary.includes('历史日线截至 2026-10-31'));
  assert.ok(!summary.includes('无三季报') && !summary.includes('2026-10-23'));
  assert.ok(materialDateSummary({}).includes('元数据未提供'));
});
