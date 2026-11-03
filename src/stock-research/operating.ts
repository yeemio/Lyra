/** Deterministic channel stress test. No company constants or forecast probabilities. */
import type { ComputedTable, ComputeResult, EvidencePack } from './contracts.js';
export interface OperatingScenario {
  name: string;
  volumeChangePct: number;
  realizedPriceChangePct: number;
  assumptions: string;
  channelChanges?: { channel: string; volumeChangePct: number; realizedPriceChangePct: number }[];
}
const STRESSES: OperatingScenario[] = [
  { name: '基线复算', volumeChangePct: 0, realizedPriceChangePct: 0, assumptions: '冻结原报告期销量和渠道实现均价，仅复算，不是未来预测' },
  { name: '量减压力', volumeChangePct: -5, realizedPriceChangePct: 0, assumptions: '各渠道销量减少5%，实现均价与单位成本维持；5%为显式压力参数，无预测依据或概率' },
  { name: '量增压力', volumeChangePct: 5, realizedPriceChangePct: 0, assumptions: '各渠道销量增加5%，实现均价与单位成本维持；5%为显式压力参数，无预测依据或概率' },
];
export function computeOperatingScenarios(pack: EvidencePack, close: number | null, scenarios: OperatingScenario[] = STRESSES): Pick<ComputeResult, 'tables' | 'checks'> {
  const channels = pack.tables.find((t) => t.tableId === 'operating-segments');
  const financial = pack.tables.find((t) => t.tableId === 'official-financials');
  const rows: ComputedTable['rows'] = [];
  const channelRows: ComputedTable['rows'] = [];
  const n = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  const periodIdx = channels?.columns.indexOf('reportPeriod') ?? -1;
  const periods = [...new Set(channels?.rows.map((r) => String(r[periodIdx] ?? '')) ?? [])].sort().reverse();
  let period: string | undefined;
  let segmentRows: (string | number | null)[][] = [];
  for (const p of periods) {
    const rs = channels!.rows.filter((r) => r[periodIdx] === p);
    if (p.endsWith('-12-31') && rs.length >= 2 && rs.every((r) => ['revenue', 'cost', 'volumeTon'].every((c) => n(r[channels!.columns.indexOf(c)]) !== null) && (n(r[channels!.columns.indexOf('volumeTon')]) ?? 0) > 0)) { period = p; segmentRows = rs; break; }
  }
  const get = (metric: string): number | null => {
    if (!financial || !period) return null;
    const r = financial.rows.find((r) => r[financial.columns.indexOf('metric')] === metric && r[financial.columns.indexOf('reportPeriod')] === period && r[financial.columns.indexOf('periodBasis')] === 'FY');
    return r ? n(r[financial.columns.indexOf('value')]) : null;
  };
  const revenue = get('operatingRevenue'), parent = get('parentNetProfit'), np = get('consolidatedNetProfit'), pretax = get('profitBeforeTax'), tax = get('incomeTax'), shares = get('closingShares');
  const ready = period !== undefined && revenue !== null && parent !== null && np !== null && np > 0 && pretax !== null && pretax > 0 && tax !== null && shares !== null && shares > 0;
  const limitations = '缺终端动销、渠道库存与回款分拆，不能据渠道收入认定终端需求；合并现金流含财务子公司存款变化，不外推渠道回款。仅使用同一完整年度，不混用半年与全年、不将H1年化、不与TTM冒充可比。';
  if (ready) {
    const baseSegmentRevenue = segmentRows.reduce((sum, r) => sum + Number(r[channels!.columns.indexOf('revenue')]), 0);
    const baseCost = segmentRows.reduce((sum, r) => sum + Number(r[channels!.columns.indexOf('cost')]), 0);
    const taxRate = tax! / pretax!;
    const parentShare = parent! / np!;
    for (const r of segmentRows) {
      const rev = Number(r[channels!.columns.indexOf('revenue')]), cost = Number(r[channels!.columns.indexOf('cost')]), volume = Number(r[channels!.columns.indexOf('volumeTon')]);
      channelRows.push([period!, String(r[channels!.columns.indexOf('channel')]), rev, cost, volume, rev / baseSegmentRevenue * 100, rev / volume, cost / volume, (rev - cost) / rev * 100]);
    }
    for (const s of scenarios) {
      if (![s.volumeChangePct, s.realizedPriceChangePct].every(Number.isFinite) || s.volumeChangePct <= -100 || s.realizedPriceChangePct <= -100 || !s.assumptions.trim()) throw new Error('OPERATING_ASSUMPTIONS_INVALID');
      for (const change of s.channelChanges ?? []) {
        if (!segmentRows.some((r) => r[channels!.columns.indexOf('channel')] === change.channel) || ![change.volumeChangePct, change.realizedPriceChangePct].every(Number.isFinite) || change.volumeChangePct <= -100 || change.realizedPriceChangePct <= -100) throw new Error('OPERATING_CHANNEL_ASSUMPTIONS_INVALID');
      }
      let scenarioRevenue = 0, scenarioCost = 0;
      for (const r of segmentRows) {
        const v = Number(r[channels!.columns.indexOf('volumeTon')]);
        const rev = Number(r[channels!.columns.indexOf('revenue')]), cost = Number(r[channels!.columns.indexOf('cost')]);
        const change = s.channelChanges?.find((c) => c.channel === r[channels!.columns.indexOf('channel')]);
        const volume = v * (1 + (change?.volumeChangePct ?? s.volumeChangePct) / 100);
        scenarioRevenue += volume * (rev / v) * (1 + (change?.realizedPriceChangePct ?? s.realizedPriceChangePct) / 100);
        scenarioCost += volume * (cost / v);
      }
      const grossDelta = (scenarioRevenue - scenarioCost) - (baseSegmentRevenue - baseCost);
      // Fixed other income/expenses and taxes other than income tax are assumptions, not observations.
      const parentScenario = parent! + grossDelta * (1 - taxRate) * parentShare;
      const earningsPerClosingShare = parentScenario / shares!;
      rows.push([s.name, period!, s.volumeChangePct, s.realizedPriceChangePct, scenarioRevenue, revenue! + scenarioRevenue - baseSegmentRevenue, scenarioCost, grossDelta, taxRate, parentShare, parentScenario, shares!, earningsPerClosingShare, close, close !== null && earningsPerClosingShare > 0 ? close / earningsPerClosingShare : null, s.assumptions + (s.channelChanges?.length ? `；分渠道覆盖参数：${JSON.stringify(s.channelChanges)}` : ''), limitations]);
    }
  }
  return {
    tables: [{ tableId: 'channel-economics', title: '同期间渠道收入结构、实现均价与毛利率（非同产品提价）', columns: ['period', 'channel', 'revenue', 'cost', 'volumeTon', 'revenueSharePct', 'realizedRevenuePerTon', 'costPerTon', 'grossMarginPct'], rows: channelRows, unitNote: '事实派生：人民币元/吨、百分数。各渠道组合不同，均价差异不能证明同一产品提价；成本率按同报告期。', formula: '收入占比=渠道收入/所披露渠道收入合计×100；实现均价=收入/销量；单位成本=成本/销量；毛利率=(收入−成本)/收入×100。', inputs: ['operating-segments'], locators: [{ kind: 'COMPUTED', tableId: 'operating-segments' }], cutoff: pack.cutoff }, { tableId: 'operating-scenarios', title: '渠道经营压力测试：销量/实现均价→收入/成本→归母利润→同价PE', columns: ['scenario', 'basePeriod', 'volumeChangePct', 'realizedPriceChangePct', 'segmentRevenue', 'operatingRevenue', 'segmentCost', 'grossProfitDelta', 'incomeTaxRate', 'parentProfitShare', 'parentNetProfit', 'closingShares', 'earningsPerClosingShare', 'observedPrice', 'peOnScenarioAnnualEarnings', 'assumptions', 'limitations'], rows,
      unitNote: `人民币元/股/吨；比例字段incomeTaxRate、parentProfitShare为小数，其余Pct列为百分数。${ready ? '事实基线来自同年度官方原件；未来量价变化、单位成本与费用税率不变均为假设；不是盈利预测。' : '不可计算：缺同年度完整渠道收入/成本/销量及合并/归母利润、税前利润、所得税、期末股本；不套其他行业或补零。'} ${limitations}`,
      formula: '各渠道收入=基期销量×(1+销量变化%)×基期收入/销量×(1+实现均价变化%)；成本=情景销量×基期成本/销量；归母利润=基期归母利润+毛利增量×(1−基期所得税/税前利润)×基期归母/合并净利（其他费用、税金及其他收益不变是假设）；同价PE=截点内收盘价÷(情景年度归母利润/基期期末股数)。每股值为压力测试按期末股数摊算，非会计基本EPS、非TTM。现金流不计算。',
      inputs: ['operating-segments', 'official-financials', 'bars-daily'], locators: ['operating-segments', 'official-financials', 'bars-daily'].map((tableId) => ({ kind: 'COMPUTED' as const, tableId })), cutoff: pack.cutoff }],
    checks: [{ name: 'operating-scenario-applicability', ok: true, detail: ready ? `使用${period}同期间官方基线；结果仅为条件压力测试；${limitations}` : `经营情景受限：必需材料不全，表为空，未套用任何公司参数。${limitations}` }],
  };
}
