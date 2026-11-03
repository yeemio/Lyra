/**
 * Lyra · 单股研究报告产品 · 确定性计算层（sr 空间 COMPUTE 步骤，R31）。
 * 合同：src/stock-research/contracts.ts（ComputeResult/ComputedTable）。
 *
 * 纯函数：只读证据包（evidence.ts 产物），不查库、不落盘、不取时钟——同包输入
 * 必得同输出（便于复算与 QA 抽查）。
 *
 * 口径（冻结）：
 *   - 季频财务为累计口径：单季值 Q1=累计，Q2–Q4 单季=当期累计−上期累计（缺上期 → null，不硬算）；
 *   - 同比 = (当期累计 − 上年同期累计) ÷ 上年同期累计 ×100，基数为 0/负/缺失 → null（防符号误导）；
 *   - 扣非：FINANCIAL 无累计/同比字段；YOYPNI 是归母同比小数比例，标准百分数需乘 100；
 *   - 利润率/ROE 采用 FINANCIAL(profit) 原值（gpMargin/npMargin 小数、roeAvg 平均净资产收益率
 *     累计未年化——适配器口径原样，另给 ×100 百分数列）；
 *   - 价格窗口 = 最近 N 根 K 线（含首尾）：收益 = 末根收盘 ÷ 首根收盘 − 1；K 线不足 N 根 → null；
 *   - 超额 = 个股窗口收益 − 基准同窗口收益（index-bars 同口径）；
 *   - EPS-TTM 无自累计路径（无单季 eps 字段）：采用 FINANCIAL epsTTM 适配器原值；
 *     BPS = TOTAL_PARENT_EQUITY ÷ SHARE_CAPITAL（BALANCE 连接列）；
 *     PE-TTM = 最新收盘 ÷ EPS-TTM；PB = 最新收盘 ÷ BPS；分母 0/null → null。
 *
 * 数值纪律：计算用 number，来源字符串原样保留在 rows（原值列 + 计算列并列）。
 */
import { computeOperatingScenarios, type OperatingScenario } from './operating.js';
import { computeShippingMetrics } from './shipping.js';
import type { ComputedTable, ComputeResult, EvidenceLocator, EvidencePack, EvidenceTable } from './contracts.js';

/** 价格表现窗口（交易日根数）。 */
export const PRICE_WINDOWS = [20, 60, 120, 250] as const;

/** 估值敏感性价格乘数。 */
export const SENSITIVITY_MULTIPLIERS = [0.7, 0.85, 1.0, 1.15, 1.3] as const;

/** 单季拆分期数（近 4 期）。 */
export const SINGLE_QUARTERS = 4;

// ===== 小工具（纯） =====

function findTable(pack: EvidencePack, tableId: string): EvidenceTable | null {
  return pack.tables.find((t) => t.tableId === tableId) ?? null;
}

function colOf(table: EvidenceTable, name: string): number {
  return table.columns.indexOf(name);
}

function cellAt(table: EvidenceTable, row: number, col: number): string | number | null {
  if (col < 0) return null;
  const v = table.rows[row]?.[col];
  return v === undefined ? null : v;
}

/** 单元格 → number（字符串按十进制解析，NaN/空 → null；不改动原值）。 */
function num(v: string | number | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/** 'YYYY-MM-DD' → {year, month}；非法规格返回 null。 */
function parseStatDate(s: string): { year: number; month: number; day: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: m[3] ?? '' };
}

/** 同比期键：上年同日（statDate 均 3/6/9/12 月末，年减一无借位问题）。 */
function yearAgo(statDate: string): string | null {
  const p = parseStatDate(statDate);
  return p === null ? null : `${p.year - 1}-${String(p.month).padStart(2, '0')}-${p.day}`;
}

/** 上一个报告期：Q1 → 上年年报；Q2–Q4 → 本年上一季度末（标准季度末日，不沿用当期“日”）。 */
function prevQuarterEnd(statDate: string): string | null {
  const p = parseStatDate(statDate);
  if (p === null) return null;
  if (p.month === 3) return `${p.year - 1}-12-31`;
  const m = p.month - 3;
  return `${p.year}-${String(m).padStart(2, '0')}-${m === 3 || m === 12 ? '31' : '30'}`;
}

function pct(n: number | null): number | null {
  return n === null ? null : n * 100;
}

function locatorsOf(inputs: string[]): EvidenceLocator[] {
  return inputs.map((tableId) => ({ kind: 'COMPUTED' as const, tableId }));
}

// ===== 主入口 =====

export function computeMetrics(pack: EvidencePack, opts: { operatingScenarios?: OperatingScenario[] } = {}): ComputeResult {
  const checks: ComputeResult['checks'] = [];
  const fin = findTable(pack, 'fin-quarterly');
  const bars = findTable(pack, 'bars-daily');
  const bench = findTable(pack, 'index-bars');
  const tables: ComputedTable[] = [];
  const missing: string[] = [];
  if (fin === null) missing.push('fin-quarterly');
  if (bars === null) missing.push('bars-daily');
  if (bench === null) missing.push('index-bars');

  // ---- 财务期间索引（statDate 升序；重复/乱序记入自检） ----
  interface FinSlice {
    period: string;
    rowIdx: number;
    revenueCum: number | null;
    netProfitCum: number | null;
    epsTtm: number | null;
    tpe: number | null;
    shareCapital: number | null;
    totalShare: number | null;
    yoyPni: string | number | null;
    gpMargin: number | null;
    npMargin: number | null;
    roeAvg: number | null;
  }
  const slices: FinSlice[] = [];
  if (fin !== null) {
    const periodCol = colOf(fin, 'statDate');
    const revCol = colOf(fin, 'MBRevenue');
    const npCol = colOf(fin, 'netProfit');
    const epsCol = colOf(fin, 'epsTTM');
    const tpeCol = colOf(fin, 'TOTAL_PARENT_EQUITY');
    const scCol = colOf(fin, 'SHARE_CAPITAL');
    const tsCol = colOf(fin, 'totalShare');
    const pniCol = colOf(fin, 'YOYPNI');
    const gpCol = colOf(fin, 'gpMargin');
    const npmCol = colOf(fin, 'npMargin');
    const roeCol = colOf(fin, 'roeAvg');
    fin.rows.forEach((_, rowIdx) => {
      const periodRaw = cellAt(fin, rowIdx, periodCol);
      const period = periodRaw === null ? null : String(periodRaw);
      if (period === null) return;
      slices.push({
        period,
        rowIdx,
        revenueCum: num(cellAt(fin, rowIdx, revCol)),
        netProfitCum: num(cellAt(fin, rowIdx, npCol)),
        epsTtm: num(cellAt(fin, rowIdx, epsCol)),
        tpe: num(cellAt(fin, rowIdx, tpeCol)),
        shareCapital: num(cellAt(fin, rowIdx, scCol)),
        totalShare: num(cellAt(fin, rowIdx, tsCol)),
        yoyPni: cellAt(fin, rowIdx, pniCol),
        gpMargin: num(cellAt(fin, rowIdx, gpCol)),
        npMargin: num(cellAt(fin, rowIdx, npmCol)),
        roeAvg: num(cellAt(fin, rowIdx, roeCol)),
      });
    });
  }
  const periodsSortedOk =
    slices.length > 0 && slices.every((s, i) => i === 0 || slices[i - 1]?.period !== undefined && (slices[i - 1] as FinSlice).period < s.period);
  const periodsUnique = new Set(slices.map((s) => s.period)).size === slices.length;
  checks.push({
    name: 'fin-periods-sorted-unique',
    ok: periodsSortedOk && periodsUnique,
    detail: `fin-quarterly 期间 ${slices.length} 个${periodsSortedOk ? '，升序' : '，存在乱序'}${periodsUnique ? '，无重复' : '，存在重复 statDate'}`,
  });

  const cumByPeriod = new Map(slices.map((s) => [s.period, s]));
  const revenueCumByPeriod = new Map(slices.map((s) => [s.period, s.revenueCum]));
  const netProfitCumByPeriod = new Map(slices.map((s) => [s.period, s.netProfitCum]));

  // ---- growth-quarterly：累计原值 + 同比（近 12 期全部计算） ----
  const yoySkipped: string[] = [];
  const growthRows = slices.map((s) => {
    const baseKey = yearAgo(s.period);
    const revenueBase = baseKey === null ? null : (revenueCumByPeriod.get(baseKey) ?? null);
    const netProfitBase = baseKey === null ? null : (netProfitCumByPeriod.get(baseKey) ?? null);
    const yoyOf = (cur: number | null, base: number | null, label: string, period: string): number | null => {
      if (cur === null || base === null) return null;
      if (base <= 0) {
        yoySkipped.push(`${label}@${period}（基数 ${base}）`);
        return null;
      }
      return ((cur - base) / base) * 100;
    };
    return [
      s.period,
      fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'MBRevenue')),
      yoyOf(s.revenueCum, revenueBase, '收入同比', s.period),
      fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'netProfit')),
      yoyOf(s.netProfitCum, netProfitBase, '来源净利润同比', s.period),
      null, // 扣非累计：FINANCIAL 无字段
      null, // 扣非同比来源缺失
      s.yoyPni, pct(num(s.yoyPni)),
    ];
  });
  tables.push({
    tableId: 'growth-quarterly',
    title: '增长：累计值与同比（近报告期）',
    columns: ['period', 'revenueCum', 'revenueYoYPct', 'netProfitCum', 'netProfitYoYPct', 'deductedCum', 'deductedYoYPct', 'parentNetProfitYoYRaw', 'parentNetProfitYoYPct'],
    rows: growthRows,
    unitNote:
      '金额单位元（来源原值字符串原样）；同比列为计算值（%）。' +
      'netProfitCum/同比沿用来源净利润，未标归母；revenueCum 为来源收入字段 MBRevenue，未核实公司/期次不得改称营业收入或营业总收入（官方对照另列）。扣非累计/同比恒 null（来源缺失）；parentNetProfitYoYRaw=YOYPNI 小数，parentNetProfitYoYPct=原值×100（归母同比，非扣非）。',
    locators: locatorsOf(['fin-quarterly']),
    cutoff: pack.cutoff,
    formula:
      '同比% = (当期累计 − 上年同期累计) ÷ 上年同期累计 × 100（基数 ≤0 或缺失 → null）；' +
      '累计列与归母同比原值取自 fin-quarterly；归母同比百分数=YOYPNI×100；扣非来源缺失。',
    inputs: ['fin-quarterly'],
  });
  checks.push({
    name: 'yoy-base-guard',
    ok: true,
    detail: yoySkipped.length === 0 ? '无基数 ≤0/缺失的同比被跳过' : `同比置 null（基数 ≤0/缺失）：${yoySkipped.join('; ')}`,
  });

  // A provider field name is not an accounting scope. Reconcile only against the same-period original.
  const official = findTable(pack, 'official-financials');
  if (official !== null) {
    const getOfficial = (period: string, metric: string): string | number | null => {
      const r = official.rows.find((r) => r[colOf(official, 'reportPeriod')] === period && r[colOf(official, 'metric')] === metric);
      return r?.[colOf(official, 'value')] ?? null;
    };
    const reconciliationRows = slices.filter((s) => getOfficial(s.period, 'operatingRevenue') !== null).map((s) => {
      const operatingRaw = getOfficial(s.period, 'operatingRevenue');
      const totalRaw = getOfficial(s.period, 'totalRevenue');
      const consolidatedRaw = getOfficial(s.period, 'consolidatedNetProfit');
      const parentRaw = getOfficial(s.period, 'parentNetProfit');
      const deductedRaw = getOfficial(s.period, 'deductedParentNetProfit');
      const match = (a: number | null, b: string | number | null): boolean => a !== null && num(b) !== null && Math.abs(a - num(b)!) <= 0.0001;
      const incomeScope = match(s.revenueCum, totalRaw) ? '营业总收入（仅本期原件核实）' : match(s.revenueCum, operatingRaw) ? '营业收入（仅本期原件核实）' : '未匹配/未核实，不改称报表科目';
      const profitScope = match(s.netProfitCum, consolidatedRaw) ? '合并净利润（仅本期原件核实）' : match(s.netProfitCum, parentRaw) ? '归母净利润（仅本期原件核实）' : '未匹配/未核实';
      const sourceMargin = s.npMargin;
      const ratioOp = div(num(consolidatedRaw), num(operatingRaw));
      const ratioTotal = div(num(consolidatedRaw), num(totalRaw));
      const ratioMatches = (r: number | null): boolean => sourceMargin !== null && r !== null && Math.abs(sourceMargin - r) <= 0.00000051;
      const marginDenominator = ratioMatches(ratioOp) ? '营业收入（同期间合并净利/营业收入与来源npMargin在6位小数精度吻合）' : ratioMatches(ratioTotal) ? '营业总收入（同期间数值核对吻合）' : '未核实；npMargin仅保留来源原值，不据MBRevenue反推';
      const origin = official.rows.find((r) => r[colOf(official, 'reportPeriod')] === s.period);
      return [s.period, fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'MBRevenue')), operatingRaw, totalRaw, incomeScope, fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'netProfit')), consolidatedRaw, parentRaw, deductedRaw, profitScope, fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'npMargin')), marginDenominator, origin?.[colOf(official, 'sourceUrl')] ?? null, origin?.[colOf(official, 'pages')] ?? null];
    });
    tables.push({ tableId: 'financial-source-reconciliation', title: '来源字段与同期间官方科目核对（不推广到其他公司/期次）', columns: ['period', 'sourceMBRevenueRaw', 'officialOperatingRevenue', 'officialTotalRevenue', 'sourceRevenueScope', 'sourceNetProfitRaw', 'officialConsolidatedNetProfit', 'officialParentNetProfit', 'officialDeductedParentNetProfit', 'sourceProfitScope', 'sourceNpMarginRaw', 'verifiedMarginDenominator', 'sourceUrl', 'pages'], rows: reconciliationRows,
      unitNote: '人民币元；原值字符串保留。两个收入分母分列；npMargin为来源小数原值，仅在同期间原件数值吻合时注明分母，不把MBRevenue默认为净利率分母。',
      formula: '按报告期连接；来源收入/净利原值分别与官方科目核对；npMargin比对合并净利/营业收入及合并净利/营业总收入（容差0.51×10^-6，仅反映来源6位小数精度）；未匹配则未核实，不重写原字段。', inputs: ['fin-quarterly', 'official-financials'], locators: locatorsOf(['fin-quarterly', 'official-financials']), cutoff: pack.cutoff });
  }

  // ---- quarterly-single：近 4 期单季拆分 ----
  const recent = slices.slice(-SINGLE_QUARTERS);
  const singleMissing: string[] = [];
  const singleRows = recent.map((s) => {
    const prevKey = prevQuarterEnd(s.period);
    const prev = prevKey === null ? null : (cumByPeriod.get(prevKey) ?? null);
    const quarter = Math.floor((parseStatDate(s.period)?.month ?? 0) / 3);
    const singleOf = (cur: number | null, prevCum: number | null): number | null => {
      if (cur === null) return null;
      if (quarter === 1) return cur; // Q1 累计即单季
      if (prevCum === null) {
        return null;
      }
      return cur - prevCum;
    };
    const revSingle = singleOf(s.revenueCum, prev?.revenueCum ?? null);
    const npSingle = singleOf(s.netProfitCum, prev?.netProfitCum ?? null);
    if (s.revenueCum !== null && revSingle === null) singleMissing.push(`revenue@${s.period}`);
    if (s.netProfitCum !== null && npSingle === null) singleMissing.push(`netProfit@${s.period}`);
    return [s.period, revSingle, npSingle, null];
  });
  tables.push({
    tableId: 'quarterly-single',
    title: `近 ${SINGLE_QUARTERS} 期单季拆分（来源收入字段MBRevenue/来源净利润/扣非）`,
    columns: ['period', 'revenueSingleQ', 'netProfitSingleQ', 'deductedSingleQ'],
    rows: singleRows,
    unitNote:
      '单位元。Q1 单季=累计；Q2–Q4 单季=当期累计−上期累计；上期缺失 → null。' +
      'deductedSingleQ 恒 null（无扣非累计字段，缺口已入证据包 gaps）。',
    locators: locatorsOf(['fin-quarterly']),
    cutoff: pack.cutoff,
    formula: '单季(t) = 累计(t) − 累计(t 上一报告期)（Q1 直接取累计）；扣非不可拆（无累计源）。',
    inputs: ['fin-quarterly'],
  });
  checks.push({
    name: 'single-quarter-missing-prev',
    ok: singleMissing.length === 0,
    detail: singleMissing.length === 0 ? '近 4 期单季拆分无缺上期' : `缺上期置 null：${singleMissing.join('; ')}`,
  });

  // ---- margins-roe：原值 + 百分数 ----
  const marginRows = slices.map((s) => [
    s.period,
    fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'gpMargin')),
    pct(s.gpMargin),
    fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'npMargin')),
    pct(s.npMargin),
    fin === null ? null : cellAt(fin, s.rowIdx, colOf(fin, 'roeAvg')),
    pct(s.roeAvg),
  ]);
  tables.push({
    tableId: 'margins-roe',
    title: '利润率与 ROE（适配器原值 + 百分数）',
    columns: ['period', 'gpMargin', 'gpMarginPct', 'npMargin', 'npMarginPct', 'roeAvg', 'roeAvgPct'],
    rows: marginRows,
    unitNote:
      '原值列为 FINANCIAL(profit) 字符串原样（小数）；Pct 列 = 原值 × 100。' +
      'roeAvg = 平均净资产收益率（累计、未年化——BaoStock 口径原值，非自算）。npMargin/gpMargin沿用来源口径，不用MBRevenue推称其分母；已核实的期间分母见财务对照表。',
    locators: locatorsOf(['fin-quarterly']),
    cutoff: pack.cutoff,
    formula: '毛利率/净利率/ROE 采用 FINANCIAL(profit) 原值（若来源直接给出即用原值并注明口径）；Pct = 原值 × 100。',
    inputs: ['fin-quarterly'],
  });

  // ---- price-performance：窗口收益/超额/区间成交额均值 ----
  const dateCol = bars === null ? -1 : colOf(bars, 'date');
  const closeCol = bars === null ? -1 : colOf(bars, 'close');
  const amountCol = bars === null ? -1 : colOf(bars, 'amount');
  const benchDateCol = bench === null ? -1 : colOf(bench, bench.columns.includes('日期') ? '日期' : 'date');
  const benchCloseCol = bench === null ? -1 : colOf(bench, bench.columns.includes('收盘') ? '收盘' : 'close');
  const closes =
    bars !== null && closeCol >= 0
      ? bars.rows.map((r) => num(r[closeCol] ?? null))
      : [];
  const benchCloses =
    bench !== null && benchCloseCol >= 0
      ? bench.rows.map((r) => num(r[benchCloseCol] ?? null))
      : [];
  const amounts =
    bars !== null && amountCol >= 0
      ? bars.rows.map((r) => num(r[amountCol] ?? null))
      : [];
  const windowReturn = (series: (number | null)[], n: number): number | null => {
    if (series.length < n) return null;
    const last = series[series.length - 1];
    const base = series[series.length - n];
    if (last === undefined || last === null || base === undefined || base === null || base === 0) return null;
    return (last / base - 1) * 100;
  };
  const windowAvgAmount = (n: number): number | null => {
    const win = amounts.slice(-n).filter((v): v is number => v !== null);
    if (win.length === 0) return null;
    return win.reduce((a, b) => a + b, 0) / win.length;
  };
  const barDateOf = (series: EvidenceTable | null, dateColIdx: number, fromEnd: number): string | null => {
    if (series === null || dateColIdx < 0) return null;
    const v = series.rows[series.rows.length - fromEnd]?.[dateColIdx];
    return v === undefined || v === null ? null : String(v);
  };
  const priceRows = PRICE_WINDOWS.map((n) => {
    const stockRet = windowReturn(closes, n);
    const benchRet = windowReturn(benchCloses, n);
    return [
      n,
      stockRet,
      benchRet,
      stockRet !== null && benchRet !== null ? stockRet - benchRet : null,
      windowAvgAmount(n),
      closes.length >= n ? barDateOf(bars, dateCol, n) : null,
      benchCloses.length >= n ? barDateOf(bench, benchDateCol, n) : null,
    ];
  });
  tables.push({
    tableId: 'price-performance',
    title: `价格表现与超额（窗口 ${PRICE_WINDOWS.join('/')} 个交易日）`,
    columns: ['windowDays', 'stockReturnPct', 'benchmarkReturnPct', 'excessPct', 'avgAmount', 'baseDate', 'benchmarkBaseDate'],
    rows: priceRows,
    unitNote:
      '收益/超额单位 %；avgAmount 单位元/日（窗口内非空成交额的算术平均）。' +
      'K 线不足 N 根 → 该窗口 null（如实，不外推）。基准为 index-bars 所载指数（口径见证据包 unitNote）。',
    locators: locatorsOf(['bars-daily', 'index-bars']),
    cutoff: pack.cutoff,
    formula:
      '窗口收益% = (窗口末根收盘 ÷ 窗口首根收盘 − 1) × 100（窗口=最近 N 根 K 线，含首尾）；' +
      '超额% = 个股窗口收益 − 基准同窗口收益；两列基准日期列为窗口首根日期。',
    inputs: ['bars-daily', 'index-bars'],
  });
  const lastBarDate = barDateOf(bars, dateCol, 1);
  const lastBenchDate = barDateOf(bench, benchDateCol, 1);
  checks.push({
    name: 'bars-benchmark-last-date-aligned',
    ok:
      lastBarDate !== null &&
      lastBenchDate !== null &&
      lastBarDate === lastBenchDate,
    detail:
      `个股末根 ${lastBarDate ?? '无'}，基准末根 ${lastBenchDate ?? '无'}；` +
      (lastBarDate !== null && lastBenchDate !== null && lastBarDate !== lastBenchDate
        ? '末根日期不一致（超额仍按各自窗口计算，差异如实呈现）'
        : '末根日期一致'),
  });

  // ---- valuation：估值输入 + PE/PB + 敏感性 ----
  const latestClose = closes.length > 0 ? (closes[closes.length - 1] ?? null) : null;
  const latestCloseRaw =
    bars !== null && closeCol >= 0
      ? (bars.rows[bars.rows.length - 1]?.[closeCol] ?? null)
      : null;
  const latestFin = slices.length > 0 ? (slices.at(-1) ?? null) : null;
  const epsSlice = [...slices].reverse().find((s) => s.epsTtm !== null) ?? null;
  const bpsSlice = [...slices]
    .reverse()
    .find((s) => s.tpe !== null && s.shareCapital !== null && s.shareCapital > 0) ?? null;
  const bps = bpsSlice === null ? null : div(bpsSlice.tpe, bpsSlice.shareCapital);
  const epsTtm = epsSlice === null ? null : epsSlice.epsTtm;
  const peTtm = div(latestClose, epsTtm);
  const pb = div(latestClose, bps);
  const sharesSource =
    latestFin !== null && latestFin.totalShare !== null
      ? `fin-quarterly totalShare@${latestFin.period}`
      : bpsSlice !== null
        ? `fin-quarterly SHARE_CAPITAL@${bpsSlice.period}`
        : null;
  tables.push({
    tableId: 'valuation-summary',
    title: '估值输入与 PE-TTM/PB',
    columns: ['item', 'value', 'unit', 'source'],
    rows: [
      ['latestClose', latestCloseRaw, '元', lastBarDate === null ? '无 as-of 行情' : `bars-daily close@${lastBarDate}`],
      ['totalShare', fin === null || latestFin === null ? null : cellAt(fin, latestFin.rowIdx, colOf(fin, 'totalShare')), '股', sharesSource],
      ['epsTtm', fin === null || epsSlice === null ? null : cellAt(fin, epsSlice.rowIdx, colOf(fin, 'epsTTM')), '元', epsSlice === null ? '不可得（无 epsTTM 且无单季 eps 可自累计）' : `FINANCIAL epsTTM 原值@${epsSlice.period}（来源归母TTM÷来源最新总股本，非会计基本EPS，非自累计）`],
      ['bps', bps, '元/股', bpsSlice === null ? '不可得（BALANCE 缺归母权益/股本）' : `TOTAL_PARENT_EQUITY÷SHARE_CAPITAL@${bpsSlice.period}`],
      ['peTtm', peTtm, '倍', 'latestClose ÷ epsTtm'],
      ['pb', pb, '倍', 'latestClose ÷ bps'],
    ],
    unitNote: 'EPS-TTM 采用 FINANCIAL epsTTM 原值（无单季 eps 字段可自累计，口径已注明）；分母 0/null → null。',
    locators: locatorsOf(['bars-daily', 'fin-quarterly']),
    cutoff: pack.cutoff,
    formula: 'PE-TTM = 最新收盘 ÷ EPS-TTM；PB = 最新收盘 ÷ BPS；BPS = TOTAL_PARENT_EQUITY ÷ SHARE_CAPITAL。',
    inputs: ['bars-daily', 'fin-quarterly'],
  });
  tables.push({
    tableId: 'valuation-sensitivity',
    title: '估值敏感性：价格 ×0.7/0.85/1.0/1.15/1.3',
    columns: ['priceMultiplier', 'price', 'peTtm', 'pb'],
    rows: SENSITIVITY_MULTIPLIERS.map((m) => {
      const price = latestClose === null ? null : latestClose * m;
      return [m, price, div(price, epsTtm), div(price, bps)];
    }),
    unitNote: 'price 单位元；PE/PB 倍。乘数作用于最新收盘价；EPS-TTM/BPS 不随情景调整（静态敏感性）。',
    locators: locatorsOf(['bars-daily', 'fin-quarterly']),
    cutoff: pack.cutoff,
    formula: '情景价 = 最新收盘 × 乘数；情景 PE = 情景价 ÷ EPS-TTM；情景 PB = 情景价 ÷ BPS。',
    inputs: ['bars-daily', 'fin-quarterly'],
  });
  checks.push({
    name: 'eps-ttm-source',
    ok: true,
    detail:
      epsSlice === null
        ? 'EPS-TTM 不可得（epsTTM 全缺且无单季 eps 字段）——PE 置 null'
        : `EPS-TTM = FINANCIAL epsTTM 原值@${epsSlice.period}（适配器 TTM 口径，非近 4 单季自累计）`,
  });
  checks.push({
    name: 'bps-source',
    ok: bps !== null,
    detail: bpsSlice === null ? 'BPS 不可得（BALANCE 归母权益/股本缺）——PB 置 null' : `BPS@${bpsSlice?.period ?? ''}（TOTAL_PARENT_EQUITY÷SHARE_CAPITAL）`,
  });
  checks.push({
    name: 'missing-inputs',
    ok: missing.length === 0,
    detail: missing.length === 0 ? '证据包输入表齐备' : `证据包缺表：${missing.join(',')}（相关计算列置 null）`,
  });
  checks.push({
    name: 'units-note',
    ok: true,
    detail:
      '单位：fin/bars 金额为元（来源原值字符串）；SW 基准指数成交额为亿元（sw 适配器口径，本层不换算）；' +
      'margin/pledge 单位见证据包 unitNote；比率列统一 %（利润率原值为小数并列给出）。',
  });

  const shipping = pack.tables.some((t) => t.tableId === 'shipping-routes');
  if (shipping) {
    for (const t of tables.filter((t) => ['price-performance', 'valuation-summary', 'valuation-sensitivity'].includes(t.tableId))) {
      t.title = `历史行情口径（截至${lastBarDate ?? '未知'}）：${t.title}`;
      t.unitNote += ' 历史日线未延伸至资料截点，不代表当前技术信号；当前行情快照及官方期次估值见 shipping-snapshot-valuation，不拼接两类行情。';
      if (t.tableId === 'price-performance') {
        for (const r of t.rows) if (lastBarDate !== lastBenchDate || r[5] !== r[6]) { r[2] = null; r[3] = null; }
        t.unitNote += ` 个股末日${lastBarDate ?? '未知'}，基准末日${lastBenchDate ?? '未知'}；起止日不一致的基准比较与超额列置null。`;
      }
    }
    const alignment = checks.find((c) => c.name === 'bars-benchmark-last-date-aligned');
    if (alignment && !alignment.ok) alignment.detail = `个股末日${lastBarDate ?? '未知'}，基准末日${lastBenchDate ?? '未知'}；区间不可比，基准比较与超额已置null，不形成当前技术信号。`;
  }
  const operating = shipping ? computeShippingMetrics(pack) : computeOperatingScenarios(pack, latestClose, opts.operatingScenarios);
  tables.push(...operating.tables);
  checks.push(...operating.checks);
  return { taskId: pack.taskId, cutoff: pack.cutoff, tables, checks };
}
