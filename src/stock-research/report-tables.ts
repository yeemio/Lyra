/** 同一份证据表的阅读视图：原值不变，重复来源独立列示，宽表分栏时保留行号。 */
export interface ReportTable {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  note: string | null;
}

const LABELS: Record<string, string> = {
  date: '日期', period: '期间', statDate: '报告期', pubDate: '发布日期', reportPeriod: '报告期',
  publishedDate: '发布日期', retrievedAt: '获取时间', sourceUrl: '来源网址', pages: '原件页码', sha256: '原件 SHA-256',
  open: '开盘', high: '最高', low: '最低', close: '收盘', preclose: '前收盘', volume: '成交量', amount: '成交额',
  turn: '换手率', pctChg: '涨跌幅', isST: 'ST 标识', tradestatus: '交易状态', adjustflag: '复权标识', adjustFactor: '复权因子', code: '证券代码',
  metric: '指标', value: '数值', unit: '单位', note: '说明', item: '项目', scope: '口径', periodBasis: '期间口径',
  route: '航线', segment: '分部', revenueCny: '收入（元）', costCny: '成本（元）', grossMarginPct: '毛利率（%）',
  volumeTeu: '货量（TEU）', revenueCnyThousand: '收入（千元）', priorVolumeTeu: '上期货量（TEU）', priorRevenueCnyThousand: '上期收入（千元）',
  realizedCnyPerTeu: '单箱收入（元/TEU）', volumeYoYPct: '货量同比（%）', revenueYoYPct: '收入同比（%）', realizedUnitYoYPct: '单箱同比（%）',
  current: '本期', prior: '上期', topic: '主题', text: '原文摘录', index: '指数', priorDate: '前期日期', priorValue: '前期点位', changePct: '变化（%）',
  scenario: '情景', basePeriod: '基期', volumeChangePct: '货量假设（%）', realizedPriceChangePct: '单箱收入假设（%）',
  routeRevenueCny: '航线收入（元）', revenueDeltaCny: '收入变化（元）', profit: '利润', cashFlow: '现金流',
  operatingRevenueCny: '营业收入（元）', parentNetProfitCny: '归母净利（元）', operatingCashFlowCny: '经营现金流（元）',
  cashCapexCny: '购建支出（元）', ocfLessCashCapexCny: '经营现金流减购建支出（元）', cashEquivalentsCny: '现金等价物（元）',
  MBRevenue: '来源营业收入', netProfit: '来源净利润', epsTTM: '每股收益 TTM', roeAvg: '平均 ROE', gpMargin: '毛利率原值', npMargin: '净利率原值',
  totalShare: '总股本', liqaShare: '流通股本', YOYNI: '来源净利同比', YOYPNI: '归母净利同比', YOYAsset: '资产同比', YOYEquity: '权益同比', YOYEPSBasic: '每股收益同比',
  balanceReportType: '报表类型', balanceNoticeDate: '资产表公告日', TOTAL_PARENT_EQUITY: '归母权益', SHARE_CAPITAL: '股本', TOTAL_ASSETS: '总资产', TOTAL_LIABILITIES: '总负债', MONETARYFUNDS: '货币资金', GOODWILL: '商誉', MINORITY_EQUITY: '少数股东权益',
  operatingRevenue: '营业收入', parentNetProfit: '归母净利润', deductedParentNetProfit: '扣非归母净利润', consolidatedNetProfit: '合并净利润',
  profitBeforeTax: '税前利润', incomeTax: '所得税', operatingCashFlow: '经营现金流', parentEquity: '归母权益', closingShares: '期末股本', basicEps: '基本每股收益', cashCapex: '购建长期资产支付', cashEquivalents: '现金等价物',
  observedAt: '行情快照时间', symbol: '代码', price: '价格', currency: '币种', label: '来源说明', periodOrTime: '期间/时点',
  revenueCum: '累计收入', netProfitCum: '累计来源净利', netProfitYoYPct: '来源净利同比（%）', deductedCum: '累计扣非净利', deductedYoYPct: '扣非净利同比（%）', parentNetProfitYoYRaw: '归母同比原值', parentNetProfitYoYPct: '归母同比（%）',
  revenueSingleQ: '单季收入', netProfitSingleQ: '单季来源净利', deductedSingleQ: '单季扣非净利', gpMarginPct: '毛利率（%）', npMarginPct: '净利率（%）', roeAvgPct: 'ROE（%）',
  windowDays: '窗口天数', stockReturnPct: '个股回报（%）', benchmarkReturnPct: '参照回报（%）', excessPct: '超额（百分点）', avgAmount: '平均成交额', baseDate: '基准日', benchmarkBaseDate: '参照基准日',
  priceMultiplier: '价格倍数', peTtm: 'PE TTM', pb: 'PB', source: '依据',
  sourceMBRevenueRaw: '来源收入原值', officialOperatingRevenue: '官方营业收入', officialTotalRevenue: '官方总收入', sourceRevenueScope: '来源收入口径', sourceNetProfitRaw: '来源净利原值', officialConsolidatedNetProfit: '官方合并净利', officialParentNetProfit: '官方归母净利', officialDeductedParentNetProfit: '官方扣非净利', sourceProfitScope: '来源净利口径', sourceNpMarginRaw: '来源净利率原值', verifiedMarginDenominator: '已核分母',
  questionId: '问题编号', question: '研究问题', horizon: '期限', requiredTables: '所需证据', materialGaps: '材料缺口', countercase: '反证',
};
export function tableLabel(value: string): string { return LABELS[value] ?? value; }
export function tableCell(value: string | number | null | undefined): string { return value == null ? '—' : String(value); }

export function readableTable(t: ReportTable): { columns: string[]; rows: string[][]; sources: string[] } {
  const meta = new Set(['publishedDate', 'retrievedAt', 'sourceUrl', 'pages', 'sha256']);
  const sourceCols = t.columns.map((c, i) => meta.has(c) ? i : -1).filter((i) => i >= 0);
  const dataCols = t.columns.map((_, i) => i).filter((i) => !sourceCols.includes(i));
  const sources: string[] = [];
  const rows = t.rows.map((row) => {
    const values = dataCols.map((i) => tableCell(row[i]));
    // 只翻译指标名，数值、单位及原文均保持原样；完整原字段仍由网页原表提供。
    if (['metric', 'item'].includes(t.columns[dataCols[0]!] ?? '')) {
      const raw = values[0]!, label = tableLabel(raw);
      values[0] = label === raw ? raw : `${label}（${raw}）`;
    }
    if (sourceCols.length) {
      const source = sourceCols.map((i) => `${tableLabel(t.columns[i]!)}：${tableCell(row[i])}`).join('；');
      let index = sources.indexOf(source);
      if (index < 0) { sources.push(source); index = sources.length - 1; }
      values.push(`S${index + 1}`);
    }
    return values;
  });
  return { columns: [...dataCols.map((i) => tableLabel(t.columns[i]!)), ...(sourceCols.length ? ['来源号'] : [])], rows, sources };
}

/** 宽表分栏保留全部单元格与稳定行号，不做抽样、舍入或截断。 */
export function tableBands(columns: string[], rows: string[][], maxColumns = 6): { columns: string[]; rows: string[][] }[] {
  const width = maxColumns - 1;
  const bands = [];
  for (let start = 0; start < columns.length; start += width) bands.push({
    columns: ['行号', ...columns.slice(start, start + width)],
    rows: rows.map((row, i) => [String(i + 1), ...row.slice(start, start + width)]),
  });
  return bands;
}
