/** Shipping quantities stay in TEU and revenues in CNY; undisclosed route costs stay unknown. */
import type { ComputedTable, ComputeResult, EvidencePack, EvidenceTable } from './contracts.js';

export function computeShippingMetrics(pack: EvidencePack): Pick<ComputeResult, 'tables' | 'checks'> {
  const tables: ComputedTable[] = [];
  const source = (id: string) => pack.tables.find((t) => t.tableId === id);
  const cell = (t: EvidenceTable, r: (string | number | null)[], col: string) => r[t.columns.indexOf(col)] ?? null;
  const n = (v: unknown): number | null => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const ratio = (a: number | null, b: number | null) => a === null || b === null || b <= 0 ? null : a / b;
  const add = (id: string, title: string, columns: string[], rows: ComputedTable['rows'], inputs: string[], unitNote: string, formula: string) => {
    tables.push({ tableId: id, title, columns, rows, inputs, unitNote, formula, cutoff: pack.cutoff, locators: inputs.map((tableId) => ({ kind: 'COMPUTED', tableId })) });
  };
  const routes = source('shipping-routes');
  const routeRows: ComputedTable['rows'] = [];
  if (routes) for (const r of routes.rows) {
    const volume = n(cell(routes, r, 'volumeTeu')), revK = n(cell(routes, r, 'revenueCnyThousand'));
    const priorV = n(cell(routes, r, 'priorVolumeTeu')), priorRK = n(cell(routes, r, 'priorRevenueCnyThousand'));
    const unit = ratio(revK === null ? null : revK * 1000, volume);
    const priorUnit = ratio(priorRK === null ? null : priorRK * 1000, priorV);
    const growth = (a: number | null, b: number | null) => { const v = ratio(a, b); return v === null ? null : (v - 1) * 100; };
    routeRows.push([cell(routes, r, 'reportPeriod'), cell(routes, r, 'route'), volume, revK, unit, growth(volume, priorV), growth(revK, priorRK), growth(unit, priorUnit)]);
  }
  add('shipping-unit-economics', '航线量价拆解：同期间同比', ['period', 'route', 'volumeTeu', 'revenueCnyThousand', 'realizedCnyPerTeu', 'volumeYoYPct', 'revenueYoYPct', 'realizedUnitYoYPct'], routeRows, ['shipping-routes'], '货量TEU；收入人民币千元；实现单箱收入人民币元/TEU；同比%。均价变动含航线内结构、附加费与汇率，不等于同一服务提价；半年不年化。', '单箱收入=航线收入千元×1000/TEU；同比=(本期/上年同期间−1)×100。');
  const latest = routeRows.map((r) => String(r[0])).sort().at(-1);
  const currentRoutes = routeRows.filter((r) => r[0] === latest);
  const baseRevenue = currentRoutes.reduce((sum, r) => sum + Number(r[3]) * 1000, 0);
  const scenarios = [
    ['基线复算', 0, 0], ['货量-5%，单箱收入-10%', -5, -10], ['货量+5%，单箱收入-10%', 5, -10], ['货量+5%，单箱收入+10%', 5, 10],
  ] as const;
  add('shipping-revenue-stress', '航线收入压力情景（不推算利润）', ['scenario', 'basePeriod', 'volumeChangePct', 'realizedPriceChangePct', 'routeRevenueCny', 'revenueDeltaCny', 'profit', 'cashFlow'], currentRoutes.length ? scenarios.map(([label, v, p]) => {
    const rev = baseRevenue * (1 + v / 100) * (1 + p / 100);
    return [label, latest!, v, p, rev, rev - baseRevenue, null, null];
  }) : [], ['shipping-routes'], '人民币元；基于最新同期间航线收入，情景不延长期间。量价变动为显式压力参数，无预测概率；假设各航线结构不变。没有分航线成本、固定/变动成本拆分、税率和营运资金传导，利润与现金流保持未知。', '情景航线收入=基期收入×(1+货量变化%)×(1+实现单箱收入变化%)；本表不计算公司总收入、利润、目标价或未来现金流。');
  const fin = source('official-financials');
  const periods = [...new Set(fin?.rows.map((r) => String(cell(fin, r, 'reportPeriod'))) ?? [])].sort();
  const metric = (p: string, key: string) => {
    const r = fin?.rows.find((r) => cell(fin, r, 'reportPeriod') === p && cell(fin, r, 'metric') === key);
    return fin && r ? n(cell(fin, r, 'value')) : null;
  };
  add('shipping-financial-bridge', '利润、经营现金流与购建支出（各自期间）', ['period', 'operatingRevenueCny', 'parentNetProfitCny', 'operatingCashFlowCny', 'cashCapexCny', 'ocfLessCashCapexCny', 'cashEquivalentsCny'], periods.map((p) => {
    const ocf = metric(p, 'operatingCashFlow'), capex = metric(p, 'cashCapex');
    return [p, metric(p, 'operatingRevenue'), metric(p, 'parentNetProfit'), ocf, capex, ocf === null || capex === null ? null : ocf - capex, metric(p, 'cashEquivalents')];
  }), ['official-financials'], '人民币元；12月为全年、6月为半年，不直接比较增速。购建支出为现金流量表购建长期资产支付；残差未扣收购、租赁本金等，不是可分配现金或完整自由现金流。现金等价物为期末余额，非当期流量。', '经营现金流扣购建支出=同期间经营现金流−购建固定/无形/其他长期资产支付的现金；不由此预测股息。');
  const quote = source('market-snapshot'), q = quote?.rows[0];
  const price = quote && q ? n(cell(quote, q, 'price')) : null;
  const quoteDate = quote && q ? cell(quote, q, 'observedAt') : null;
  const annual = periods.filter((p) => p.endsWith('-12-31')).at(-1);
  const last = periods.at(-1);
  const eps = annual ? metric(annual, 'basicEps') : null;
  const bps = last ? ratio(metric(last, 'parentEquity'), metric(last, 'closingShares')) : null;
  add('shipping-snapshot-valuation', '行情快照与官方期次估值', ['item', 'value', 'unit', 'periodOrTime', 'scope'], [
    ['行情快照价格', price, '人民币元/A股', quoteDate, '新浪；非独立核实交易所收盘价'],
    ['全年基本EPS', eps, '人民币元/股', annual ?? null, '官方会计基本EPS；非TTM、非预测'],
    ['快照价/全年基本EPS', ratio(price, eps), '倍', annual ?? null, 'A股价格对应每股盈利倍数，不是A+H整体市值倍数'],
    ['归母每股净资产', bps, '人民币元/股', last ?? null, '归母权益/同期A+H总股本；期末股本'],
    ['快照PB', ratio(price, bps), '倍', last ?? null, 'A股快照价格/上述每股净资产；不计算A+H总市值'],
  ], ['market-snapshot', 'official-financials'], '估值同时绑定行情时间与财务期间；H1 EPS不年化，没有H股同截点价格，禁止A股价乘A+H总股本称总市值。历史TTM计算见另表，不与此表混称。', '全年盈利倍数=快照价/上一完整年度官方基本EPS；BPS=最新期归母权益/同期期末A+H股数；PB=快照价/BPS。');
  const freight = source('freight-snapshot');
  add('shipping-freight-change', '两期行业指数变化', ['index', 'route', 'priorDate', 'priorValue', 'date', 'value', 'changePct'], freight?.rows.map((r) => {
    const v = n(cell(freight, r, 'value')), old = n(cell(freight, r, 'priorValue')), change = ratio(v, old);
    return [cell(freight, r, 'index'), cell(freight, r, 'route'), cell(freight, r, 'priorDate'), old, cell(freight, r, 'date'), v, change === null ? null : (change - 1) * 100];
  }) ?? [], ['freight-snapshot'], '指数点位与百分数；仅两期，非长期趋势、非公司单箱收入；SCFI未公开分航线值保持缺失。', '周变化%=(本期指数/上期指数−1)×100。');
  return { tables, checks: [{ name: 'shipping-scope', ok: currentRoutes.length === 5 && price !== null && periods.length >= 2, detail: `已接入${currentRoutes.length}条航线与独立行情快照；不使用吨/渠道模型，缺成本不输出利润情景，半年不年化。` }] };
}
