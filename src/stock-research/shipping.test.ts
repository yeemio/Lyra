import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReportMaterials, bindResearchPlan, selectAnalysisTables } from './materials.js';
import { computeShippingMetrics } from './shipping.js';
import type { EvidencePack } from './contracts.js';

const cutoff = '2026-10-28T07:54:00.000Z';
test('海控固定原件：TEU量价、缺成本保持未知、快照估值与期间隔离', async () => {
  const { tables, gaps } = await loadReportMaterials('601919', cutoff);
  assert.deepEqual(gaps, []);
  const computed = computeShippingMetrics({ taskId: 'shipping-unit', cutoff, tables } as EvidencePack);
  assert.ok(computed.checks.every((x) => x.ok));
  const get = (id: string) => computed.tables.find((t) => t.tableId === id)!;
  const routes = get('shipping-unit-economics');
  assert.equal(routes.rows.length, 10);
  const pacific = routes.rows.find((r) => r[0] === '2026-06-30' && r[1] === '跨太平洋')!;
  assert.ok(Math.abs(Number(pacific[4]) - 27633082000 / 2625662) < 1e-8);
  const stress = get('shipping-revenue-stress');
  assert.equal(stress.rows[0]![4], 97479277000);
  assert.ok(Math.abs(Number(stress.rows[1]![4]) - 97479277000 * 0.95 * 0.9) < 1e-4);
  assert.ok(stress.rows.every((r) => r[6] === null && r[7] === null));
  const valuation = get('shipping-snapshot-valuation');
  assert.equal(valuation.rows[0]![1], 16.46);
  assert.equal(valuation.rows[0]![3], '2026-10-28T15:34:59+08:00');
  assert.equal(valuation.rows[1]![1], 1.99, '采用全年官方EPS，不将H1年化');
  assert.equal(valuation.rows[3]![1], 233762206133.57 / 15268122965);
  const plan = { questions: ['运价、货量和成本如何影响利润？'], materialPriorities: ['OPERATING', 'FINANCIAL'], emphasisNotes: [] };
  const bound = bindResearchPlan(tables, plan, cutoff, 'MID_TERM');
  assert.ok(!bound.gaps.some((g) => /operating-segments|operating-revenue/.test(g)));
  for (const group of ['a', 'b', 'c']) {
    const selected = selectAnalysisTables(bound.tables, plan, group);
    for (const id of ['shipping-routes', 'market-snapshot', 'freight-snapshot', 'official-financials']) assert.ok(selected.some((t) => t.tableId === id));
  }
});

test('当前取得的海控原件不能进入首次取证前的历史截点', async () => {
  const { tables, gaps } = await loadReportMaterials('601919', '2026-10-28T07:50:00.000Z');
  assert.equal(tables.length, 0);
  assert.ok(gaps.some((g) => g.includes('非历史封存')));
});
