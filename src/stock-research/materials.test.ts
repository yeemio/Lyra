import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { defaultSrPlanBudget } from './contracts.js';
import { loadReportMaterials, bindResearchPlan, selectAnalysisTables } from './materials.js';
import { applyPlanToEvidence } from './evidence.js';
import { computeMetrics } from './compute.js';
import { SimSrTransport, validateAnalyzeOutput, validateAFinalOutput, validateJOutput, type PlanOutput, type AnalyzeInput, type AFinalInput, type JInput } from './transport.js';
import { deriveSrChecklist, evaluatePublishGate } from './engine.js';
import type { EvidencePack, SrCoverage } from './contracts.js';
const CUTOFF = '2026-10-28T06:40:00.000Z';
const plan: PlanOutput = { questions: ['贵州茅台渠道/产品结构、销量与实现均价如何影响收入、利润和回款？'], materialPriorities: ['operating-segments', 'official-financials', 'report-excerpts', 'operating-revenue'], emphasisNotes: ['保留财务子公司存款的竞争解释'] };
function coverage(): SrCoverage { return { financials: { periods: 0, latestPeriod: null, note: null }, bars: { count: 0, firstDate: null, lastDate: null, note: null }, announcements: { count: 0, latestTitleAt: null, note: null }, margin: { count: 0, latestDate: null, note: null }, holderCount: { count: 0, latestDate: null, note: null }, pledge: { count: 0, latestDate: null, note: null }, industry: { swL1: null, note: null }, valuationInputs: { closePriceDate: null, sharesSource: null, epsTtmSource: null, note: null }, gaps: [] }; }
async function pack(): Promise<EvidencePack> { const m = await loadReportMaterials('600519', CUTOFF); return applyPlanToEvidence({ taskId: 'offline', subject: '600519', cutoff: CUTOFF, builtAt: CUTOFF, tables: m.tables, coverage: coverage(), packHash: '' }, plan, 'LONG_TERM'); }

describe('官方原件、计划选料与经营链（离线、零数据库）', () => {
  it('股票/截点/首次取证约束：不把本次下载冒称历史封存', async () => {
    assert.equal((await loadReportMaterials('002384', CUTOFF)).tables.length, 0);
    const historical = await loadReportMaterials('600519', '2026-10-23T16:00:00.000Z');
    assert.equal(historical.tables.length, 0);
    assert.ok(historical.gaps.some((g) => g.includes('非历史封存')));
    const beforePublication = await loadReportMaterials('600519', '2026-04-16T16:00:00.000Z');
    assert.equal(beforePublication.tables.length, 0);
    const material = await loadReportMaterials('600519', CUTOFF);
    const official = material.tables.find((t) => t.tableId === 'official-financials')!;
    assert.ok(official.rows.some((r) => r[0] === 'consolidatedNetProfit' && r[1] === '85310324833.67'));
    assert.ok(official.rows.some((r) => r[0] === 'parentNetProfit' && r[1] === '82320067101.68'));
    assert.ok(official.rows.some((r) => r[0] === 'parentNetProfit' && r[1] === '44516880421.86'));
    assert.ok(official.rows.some((r) => r[0] === 'deductedParentNetProfit' && r[1] === '44464207646.01'));
    assert.ok(official.locators.every((l) => l.kind === 'FILE' && /SHA256/.test(l.note)));
  });
  it('两期真实来源收入匹配营业总收入，净利率分母独立核对，原件营业收入另列', async () => {
    const p = await pack();
    p.tables.push({ tableId: 'fin-quarterly', title: '来源字段原值', columns: ['statDate', 'MBRevenue', 'netProfit', 'npMargin'], rows: [['2025-12-31', '172054171890.910000', '85310324833.670000', '0.505279'], ['2026-06-30', '92278072083.210000', '46033330566.780000', '0.507516']], unitNote: '本项目封存的BaoStock来源字段，科目须核原件', locators: [], cutoff: CUTOFF });
    const computed = computeMetrics(p);
    const table = computed.tables.find((t) => t.tableId === 'financial-source-reconciliation')!;
    assert.equal(table.rows.length, 2);
    const get = (i: number, c: string) => table.rows[i]![table.columns.indexOf(c)];
    assert.equal(get(0, 'sourceMBRevenueRaw'), '172054171890.910000');
    assert.equal(get(0, 'officialOperatingRevenue'), '168838102514.79');
    assert.equal(get(0, 'officialTotalRevenue'), '172054171890.91');
    assert.equal(get(1, 'sourceMBRevenueRaw'), '92278072083.210000');
    assert.equal(get(1, 'officialOperatingRevenue'), '90703260964.48');
    assert.equal(get(1, 'officialTotalRevenue'), '92278072083.21');
    for (const i of [0, 1]) {
      assert.match(String(get(i, 'sourceRevenueScope')), /营业总收入/);
      assert.match(String(get(i, 'sourceProfitScope')), /合并净利润/);
      assert.match(String(get(i, 'verifiedMarginDenominator')), /^营业收入/);
      assert.ok(String(get(i, 'pages')).length > 0);
    }
    assert.equal(get(0, 'officialParentNetProfit'), '82320067101.68');
    assert.equal(get(1, 'officialParentNetProfit'), '44516880421.86');
    const operating = computed.tables.find((t) => t.tableId === 'operating-scenarios')!;
    assert.ok(Math.abs(Number(operating.rows[0]![operating.columns.indexOf('operatingRevenue')]) - 168838102514.79) < 0.001);
  });
  it('PLAN实际裁剪原件材料与分组输入，缺材料明确留义务', async () => {
    const all = await loadReportMaterials('600519', CUTOFF);
    const narrow = bindResearchPlan(all.tables, { questions: ['市场价格'], materialPriorities: ['bars-daily'], emphasisNotes: [] }, CUTOFF, 'NEAR_TERM');
    assert.ok(!narrow.tables.some((t) => t.tableId === 'operating-segments'));
    assert.ok(narrow.gaps.some((g) => g.includes('bars-daily')));
    const selected = selectAnalysisTables((await pack()).tables, plan, 'c');
    assert.ok(selected.some((t) => t.tableId === 'operating-segments'));
    assert.ok(selected.some((t) => t.tableId === 'report-excerpts' && t.rows.some((r) => String(r[1]).includes('成员单位存款'))));
    assert.ok(selected.some((t) => t.tableId === 'research-questions' && t.rows[0]![2] === 'LONG_TERM'));
  });
  it('经营变量改变收入、利润和PE；不混用H1与全年、不把期末股数当基本EPS', async () => {
    const p = await pack();
    const price = { tableId: 'bars-daily', title: '测试价格', columns: ['date', 'close'], rows: [['2026-10-27', 1400]], unitNote: '合成价格仅供公式验证，非真实行情', cutoff: CUTOFF, locators: [] };
    p.tables.push(price);
    const result = computeMetrics(p, { operatingScenarios: [{ name: 'base', volumeChangePct: 0, realizedPriceChangePct: 0, assumptions: '复算' }, { name: 'up', volumeChangePct: 5, realizedPriceChangePct: 0, assumptions: '假设销量+5%，不是预测' }] });
    const t = result.tables.find((t) => t.tableId === 'operating-scenarios')!;
    const val = (i: number, k: string) => t.rows[i]![t.columns.indexOf(k)];
    assert.equal(val(0, 'basePeriod'), '2025-12-31');
    assert.equal(val(0, 'parentNetProfit'), 82320067101.68);
    assert.ok(Number(val(1, 'operatingRevenue')) > Number(val(0, 'operatingRevenue')));
    assert.ok(Number(val(1, 'parentNetProfit')) > Number(val(0, 'parentNetProfit')));
    assert.ok(Number(val(1, 'peOnScenarioAnnualEarnings')) < Number(val(0, 'peOnScenarioAnnualEarnings')));
    assert.match(t.formula, /非会计基本EPS、非TTM/);
    const incomplete = structuredClone(p);
    incomplete.tables = incomplete.tables.filter((t) => t.tableId !== 'operating-segments');
    const blocked = computeMetrics(incomplete).tables.find((t) => t.tableId === 'operating-scenarios')!;
    assert.equal(blocked.rows.length, 0);
    assert.match(blocked.unitNote!, /不可计算/);
  });
  it('同一正文与经营结果到达ANALYZE/A_FINAL/清单/J，承重未知限制发布', async () => {
    const p = await pack();
    const computed = computeMetrics(p);
    const sim = new SimSrTransport();
    const input: AnalyzeInput = { subject: '600519', subjectName: '贵州茅台', cutoff: CUTOFF, sectionKeys: ['company', 'drivers', 'financials', 'outlook', 'valuation', 'risk'], tables: [...selectAnalysisTables(p.tables, plan, 'a'), ...computed.tables], planQuestions: plan.questions, coverageGaps: p.coverage.gaps, researchContext: { focus: 'BUSINESS', horizon: 'LONG_TERM', emphasis: '渠道与回款', materialPriorities: plan.materialPriorities, emphasisNotes: plan.emphasisNotes } };
    const a = validateAnalyzeOutput(await sim.dispatch('ANALYZE', { callId: 'offline', inputHash: 'offline' }, input));
    assert.ok(a.sections.some((s) => s.narrative.includes('成员单位存款') && s.narrative.includes('82320067101.68')));
    const finalInput: AFinalInput = { subject: input.subject, subjectName: input.subjectName, cutoff: CUTOFF, sections: a.sections, valuationNote: '压力测试非盈利预测', decisiveLinkContract: '绑定原件与情景', evidenceBundle: [...p.tables, ...computed.tables], researchContext: { focus: 'BUSINESS', horizon: 'LONG_TERM', emphasis: '渠道与回款', plan } };
    const final = validateAFinalOutput(await sim.dispatch('A_FINAL', { callId: 'offline', inputHash: 'offline' }, finalInput));
    const checklist = deriveSrChecklist([a], final);
    assert.ok(checklist.items.some((i) => i.tableId === 'operating-scenarios'));
    assert.ok(checklist.items.some((i) => i.status === 'HYPOTHESIS' && i.text.includes('终端')));
    const evidenceBundle = [...p.tables, ...computed.tables].map((t) => ({ ...t, note: t.unitNote }));
    const jInput: JInput = { subject: input.subject, subjectName: input.subjectName, cutoff: CUTOFF, checklist, aFinal: final, sectionSummaries: [], evidenceBundle };
    const j = validateJOutput(await sim.dispatch('JUDGE', { callId: 'offline', inputHash: 'offline' }, jInput), checklist.items.map((i) => i.checklistId), { deliveredTableIds: evidenceBundle.map((t) => t.tableId), aConclusion: final.conclusion });
    // Fully typed context; this gate check never queries either unconnected pool.
    const inertPool = new Pool({ max: 1 });
    const context: Parameters<typeof evaluatePublishGate>[0] = {
      deps: { dataPool: inertPool, srPool: inertPool, transport: sim, budget: defaultSrPlanBudget(), outputDir: '' },
      task: { taskId: 'offline', accountId: 'offline', subject: input.subject, subjectName: input.subjectName, focus: 'BUSINESS', emphasis: '渠道与回款', horizon: 'LONG_TERM', cutoff: CUTOFF, status: 'RUNNING', idemKey: 'offline', revisedFromTaskId: null, methodVersion: 'sr-m1', adapterVersion: 'offline', planAuthVersion: 'sr-auth-1', error: null, createdAt: CUTOFF, updatedAt: CUTOFF, completedAt: null },
      analyze: new Map([['a', a]]), pack: p, computed, plan, aFinal: final, checklist, judge: j, qa: [],
    };
    const { gate } = evaluatePublishGate(context);
    await inertPool.end();
    assert.equal(gate.passed, false);
    assert.ok(gate.decisionBearingUnresolved.some((x) => x.includes('终端')));
    assert.ok(j.unresolvedDisposition.every((d) => d.handling.length > 0));
  });
});
