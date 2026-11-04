/**
 * Lyra · 单股研究报告产品 · 证据包组装器（sr 空间 EVIDENCE 步骤，R31）。
 * 合同：src/stock-research/contracts.ts（EvidencePack/EvidenceTable/SrCoverage）；
 * 表格纪律沿用 src/research/tables.ts（无损表示，不改写不舍入，null ⇔ 缺键或缺值）。
 *
 * 时点底线：全部事实经 asOfFacts（POINT-IN-TIME §2.3，含 supersedes 链解析）按任务
 * cutoff 读取——证据包内不得出现截点后才可见的任何事实（测试覆盖）。
 *
 * 表集合（tableId）：
 *   fin-quarterly          近 12 个报告期季频财务：FINANCIAL(bsQuery=profit/growth) 按 statDate
 *                          合并 + BALANCE 同报告期连接（含 pubDate/noticeDate）；
 *   bars-daily             近 250 根日线（DAILY_BAR 原始值 + ADJUST_FACTOR 按日期连接列）；
 *   margin-series          近 48 条两融（MARGIN_BALANCE）；
 *   holder-count           近 24 期股东户数（HOLDER_COUNT）；
 *   pledge                 近 24 期质押比例周度快照（PLEDGE_RATIO）；
 *   announcements-recent   近 60 条公告标题+时间（ANNOUNCEMENT）；
 *   industry               截点当时申万归属（INDUSTRY_CLASS_VERSION，复用 P2 pickSwIndustryAt）
 *                          + 指数成分概要（INDEX_MEMBERSHIP）+ STOCK_BASIC 概要；
 *   index-bars             基准指数近 250 根：优先截点申万 L1 对应 SW_INDEX_BAR；
 *                          申万 L1 缺行情时回退沪深300(000300)。上证指数(000001) 未入库
 *                          （2026-10-26 实测），故回退位不是上证指数——见 coverage note。
 *
 * 数值纪律：来源字符串原样进表（不转 float 丢精度）；typedValue 内字面 null 与缺键
 * 一律落 null 单元格；本模块不改写任何来源值（派生列——如公告时间的 ISO 形式——
 * 以独立列携带并在 unitNote 声明，原值列保留）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import { asOfFacts } from '../pintime/facts.js';
import { freezeBenchmark } from '../conclusion/benchmark.js';
import { pickSwIndustryAt } from '../research/inputs.js';
import { barsToTable, type BarTableMetaRow } from '../research/tables.js';
import { loadReportMaterials, bindResearchPlan } from './materials.js';
import type { PlanOutput } from './transport.js';
import type { SrHorizon, EvidenceLocator, EvidencePack, EvidenceTable, SrCoverage, SrFocus } from './contracts.js';

/** 证据组装具名错误。code 为稳定错误名。 */
export class EvidenceError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'EvidenceError';
  }
}

// ===== 冻结常量（表规模与回退位） =====

export const FIN_PERIODS = 12;
export const DAILY_BARS = 250;
export const MARGIN_ROWS = 48;
export const HOLDER_ROWS = 24;
export const PLEDGE_ROWS = 24;
export const ANNOUNCEMENT_ROWS = 60;
/** 申万 L1 缺行情时的基准回退位：沪深300（上证指数 000001 未入库，见模块注释）。 */
export const FALLBACK_BENCHMARK_INDEX = '000300';

/** 金融口径钩子：申万一级为银行/非银金融时 coverage 标注。 */
const FINANCIAL_SW_L1 = new Set(['801780', '801790']);

/** 常见 BaoStock bsIndex 代码 → 展示名（缺省原样）。 */
const BS_INDEX_NAMES: Record<string, string> = {
  sz50: '上证50',
  hs300: '沪深300',
  zz500: '中证500',
  zz100: '中证100',
  cyb: '创业板指',
};

// ===== 研究池 =====

export interface PoolSubjectInfo {
  code: string;
  name: string;
  swL1: string; // 申万一级名称（ETF 无申万归属，为空串）
}

interface PoolFileEntry {
  code: string;
  name: string;
  swL1IndexCode?: string;
  swL1Name?: string;
  tracks?: string;
}

interface PoolFile {
  frozenAt: string;
  stocks: PoolFileEntry[];
  etfs: PoolFileEntry[];
}

const DEFAULT_POOL_FILE = fileURLToPath(new URL('../../data/research-pool.json', import.meta.url));

async function readPoolFile(poolFile: string): Promise<PoolFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(poolFile, 'utf8'));
  } catch (error) {
    throw new EvidenceError('POOL_FILE_INVALID', `${poolFile}: ${String(error)}`);
  }
  const info = parsed as Partial<PoolFile>;
  if (typeof info.frozenAt !== 'string' || !Array.isArray(info.stocks) || !Array.isArray(info.etfs)) {
    throw new EvidenceError('POOL_FILE_INVALID', `${poolFile}: 缺 frozenAt/stocks/etfs`);
  }
  return info as PoolFile;
}

/** 研究池（R29 冻结 v2）：stocks 26 只 + 宽基 ETF 4 只。 */
export async function loadResearchPool(
  poolFile: string = DEFAULT_POOL_FILE,
): Promise<{ stocks: PoolSubjectInfo[]; etfs: { code: string; name: string }[] }> {
  const pool = await readPoolFile(poolFile);
  return {
    stocks: pool.stocks.map((s) => ({ code: s.code, name: s.name, swL1: s.swL1Name ?? '' })),
    etfs: pool.etfs.map((e) => ({ code: e.code, name: e.name })),
  };
}

/** 池内定位：6 位代码精确 → 名称精确 → 名称前缀（池序首个命中）；股票优先于 ETF。 */
export async function findSubject(
  pool: { stocks: PoolSubjectInfo[]; etfs: { code: string; name: string }[] },
  codeOrName: string,
): Promise<PoolSubjectInfo | null> {
  const q = codeOrName.trim();
  if (q.length === 0) return null;
  const byCode = (list: PoolSubjectInfo[]): PoolSubjectInfo | null =>
    list.find((s) => s.code === q) ?? null;
  const byName = (list: PoolSubjectInfo[], exact: boolean): PoolSubjectInfo | null =>
    list.find((s) => (exact ? s.name === q : s.name.startsWith(q))) ?? null;
  const stocks = pool.stocks;
  return (
    byCode(stocks) ??
    byCode(pool.etfs.map((e) => ({ code: e.code, name: e.name, swL1: '' }))) ??
    byName(stocks, true) ??
    byName(pool.etfs.map((e) => ({ code: e.code, name: e.name, swL1: '' })), true) ??
    byName(stocks, false) ??
    byName(pool.etfs.map((e) => ({ code: e.code, name: e.name, swL1: '' })), false)
  );
}

// ===== 通用小工具 =====

function tvOf(fact: TimePointFact): Record<string, unknown> {
  const tv = fact.typedValue;
  if (tv === null || typeof tv !== 'object' || Array.isArray(tv)) {
    throw new EvidenceError('TYPED_VALUE_NOT_OBJECT', fact.factId);
  }
  return tv as Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 单元格口径：null ⇔ 缺键或来源字面 null；字符串/数字原样；其余类型拒绝（不静默改写）。 */
function cell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  throw new EvidenceError('CELL_NOT_SCALAR', `非 string/number 单元格（${typeof v}）`);
}

function factLocator(f: TimePointFact): EvidenceLocator {
  return {
    kind: 'FACT',
    factId: f.factId,
    factKind: f.factKind,
    subjectId: f.subjectId,
    availableAt: f.availableAt,
  };
}

/** 行情表行级信封（tables.ts BarTableMetaRow）→ FACT locator。 */
function metaLocator(m: BarTableMetaRow): EvidenceLocator {
  return {
    kind: 'FACT',
    factId: m.factId,
    factKind: m.factKind,
    subjectId: m.subjectId,
    availableAt: m.availableAt,
  };
}

/** 记录型事实 → 表（tables.ts 同款纪律：首选序 + 额外键字典序；行按日期键升序）。 */
function recordRows(
  facts: TimePointFact[],
  preferred: readonly string[],
  dateKey: string,
  recent: number,
): { columns: string[]; rows: (string | number | null)[][]; rowFacts: TimePointFact[] } {
  if (facts.length === 0) return { columns: [], rows: [], rowFacts: [] };
  const dated = facts
    .map((f) => ({ f, d: str(tvOf(f)[dateKey]) ?? '' }))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : a.f.factId < b.f.factId ? 1 : -1)) // 新→旧
    .slice(0, recent);
  dated.reverse(); // 旧→新（与行情表一致，最旧在前）
  const union = new Set<string>();
  for (const { f } of dated) for (const key of Object.keys(tvOf(f))) union.add(key);
  const columns = [
    ...preferred.filter((name) => union.has(name)),
    ...[...union].filter((name) => !(preferred as readonly string[]).includes(name)).sort(),
  ];
  const rows = dated.map(({ f }) => columns.map((name) => cell(tvOf(f)[name])));
  return { columns, rows, rowFacts: dated.map((x) => x.f) };
}

// ===== 证据包组装 =====

export interface BuildEvidenceOptions {
  taskId: string;
  subject: string; // 6 位股票代码
  cutoff: string; // ISO-8601 资料截点
  focus: SrFocus; // 首版证据面为超集，focus 不裁剪表集合（阶段口径，如实保留）
  outputDir: string;
  plan?: PlanOutput;
  horizon?: SrHorizon;
}

export interface BuiltEvidence {
  pack: EvidencePack;
  packPath: string;
}

const FIN_COLUMNS = [
  'statDate', 'pubDate',
  'MBRevenue', 'netProfit', 'epsTTM', 'roeAvg', 'gpMargin', 'npMargin', 'totalShare', 'liqaShare',
  'YOYNI', 'YOYPNI', 'YOYAsset', 'YOYEquity', 'YOYEPSBasic',
  'balanceReportType', 'balanceNoticeDate',
  'TOTAL_PARENT_EQUITY', 'SHARE_CAPITAL', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES',
  'MONETARYFUNDS', 'GOODWILL', 'MINORITY_EQUITY',
] as const;

const MARGIN_COLUMNS = [
  'tradeDateISO', '信用交易日期', '融资余额', '融资买入额', '融券余额', '融券余量', '融券卖出量',
  '融资融券余额', '证券代码', '证券简称', 'code', 'exchange',
] as const;

const HOLDER_COLUMNS = [
  '股东户数统计截止日', '股东户数公告日期', '股东户数-本次', '股东户数-上次', '股东户数-增减',
  '股东户数-增减比例', '总股本', '股本变动', '总市值', '户均持股市值', '户均持股数量',
  '区间涨跌幅', '股本变动原因', '名称', '代码', 'code',
] as const;

const PLEDGE_COLUMNS = [
  'TRADE_DATE_ISO', 'PAYYEAR', 'PLEDGE_RATIO', 'PLEDGE_DEAL_NUM', 'PLEDGE_MARKET_CAP',
  'REPURCHASE_BALANCE', 'REPURCHASE_LIMITED_BALANCE', 'REPURCHASE_UNLIMITED_BALANCE',
  'Y1_CLOSE_ADJCHRATE', 'INDUSTRY', 'INDUSTRY_CODE', 'SECUCODE', 'SECURITY_NAME_ABBR', 'code', 'TRADE_DATE',
] as const;

/** 申万一级行业名称：SW_INDEX_LIST（as-of 可见时）按 l1IndexCode 前缀匹配。 */
async function swL1NameOf(pool: Pool, l1IndexCode: string, asOf: Date): Promise<string | null> {
  const facts = await asOfFacts(pool, {
    subjectType: 'INDEX',
    subjectId: 'SW-L1-LIST',
    factKind: 'SW_INDEX_LIST',
    asOf,
  });
  for (const f of [...facts].reverse()) {
    const rows = tvOf(f).rows;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (r === null || typeof r !== 'object') continue;
      const code = str((r as Record<string, unknown>)['行业代码']);
      const name = str((r as Record<string, unknown>)['行业名称']);
      if (code !== null && code.replace('.SI', '') === l1IndexCode && name !== null) return name;
    }
  }
  return null;
}

/**
 * 组装证据包并落盘 outputDir/tasks/<taskId>/evidence.json。
 * packHash = canonicalSha256(除 packHash 外的包内容)；返回内存包与文件路径。
 */
export async function buildEvidencePack(dataPool: Pool, opts: BuildEvidenceOptions): Promise<BuiltEvidence> {
  const cutoffDate = new Date(opts.cutoff);
  if (Number.isNaN(cutoffDate.getTime())) {
    throw new EvidenceError('INVALID_CUTOFF', opts.cutoff);
  }
  const gaps: string[] = ['无一致预期数据（卖方盈利预测/目标价未入库）'];

  const loadStock = (factKind: string): Promise<TimePointFact[]> =>
    asOfFacts(dataPool, { subjectType: 'STOCK', subjectId: opts.subject, factKind, asOf: cutoffDate });
  const finFacts = await loadStock('FINANCIAL');
  const balanceFacts = await loadStock('BALANCE');
  const barFacts = await loadStock('DAILY_BAR');
  const adjustFacts = await loadStock('ADJUST_FACTOR');
  const marginFacts = await loadStock('MARGIN_BALANCE');
  const holderFacts = await loadStock('HOLDER_COUNT');
  const pledgeFacts = await loadStock('PLEDGE_RATIO');
  const annFacts = await loadStock('ANNOUNCEMENT');
  const industryFacts = await loadStock('INDUSTRY_CLASS_VERSION');
  const membershipFacts = await loadStock('INDEX_MEMBERSHIP');
  const basicFacts = await loadStock('STOCK_BASIC');

  // 申万归属先行解析（金融口径钩子与基准选择共用）。
  const sw = pickSwIndustryAt(industryFacts, cutoffDate);
  const benchmark = freezeBenchmark({ subjectKind: 'STOCK', subject: opts.subject, cutoff: opts.cutoff, facts: industryFacts });
  const l1IndexCode = benchmark.indexCode;
  const swL1Name = l1IndexCode === null ? null : await swL1NameOf(dataPool, l1IndexCode, cutoffDate);
  const financialScope = l1IndexCode !== null && FINANCIAL_SW_L1.has(l1IndexCode);
  if (benchmark.status !== 'RESOLVED') gaps.push(`${benchmark.reason}：不以当前研究池归属回填历史`);

  const tables: EvidenceTable[] = [];

  // --- fin-quarterly：FINANCIAL 按 (statDate × bsQuery) 取 as-of 可见最新版本，BALANCE 同报告期连接 ---
  const finByStat = new Map<string, { profit?: TimePointFact; growth?: TimePointFact }>();
  for (const f of finFacts) {
    const tv = tvOf(f);
    const statDate = str(tv.statDate);
    const q = str(tv.bsQuery);
    if (statDate === null || (q !== 'profit' && q !== 'growth')) continue;
    const slot = finByStat.get(statDate) ?? {};
    const prev = slot[q];
    if (prev === undefined || f.availableAt > prev.availableAt) slot[q] = f;
    finByStat.set(statDate, slot);
  }
  const balanceByPeriod = new Map<string, TimePointFact>();
  for (const f of balanceFacts) {
    const tv = tvOf(f);
    const period = (str(tv.REPORT_DATE_ISO) ?? str(tv.REPORT_DATE) ?? '')?.slice(0, 10);
    if (period === null || period.length === 0) continue;
    const prev = balanceByPeriod.get(period);
    if (prev === undefined || f.availableAt > prev.availableAt) balanceByPeriod.set(period, f);
  }
  const finPeriods = [...new Set([...finByStat.keys(), ...balanceByPeriod.keys()])]
    .sort()
    .slice(-FIN_PERIODS); // 最近 12 期（旧→新）
  const finLocators: EvidenceLocator[] = [];
  const finRows: (string | number | null)[][] = finPeriods.map((period) => {
    const slot = finByStat.get(period);
    const profit = slot?.profit;
    const growth = slot?.growth;
    const bal = balanceByPeriod.get(period);
    for (const f of [profit, growth, bal]) {
      if (f !== undefined) finLocators.push(factLocator(f));
    }
    const p = profit === undefined ? {} : tvOf(profit);
    const g = growth === undefined ? {} : tvOf(growth);
    const b = bal === undefined ? {} : tvOf(bal);
    const value = (src: Record<string, unknown>, key: string): string | number | null => cell(src[key]);
    return [
      period,
      str(p.pubDate) ?? str(g.pubDate),
      value(p, 'MBRevenue'), value(p, 'netProfit'), value(p, 'epsTTM'), value(p, 'roeAvg'),
      value(p, 'gpMargin'), value(p, 'npMargin'), value(p, 'totalShare'), value(p, 'liqaShare'),
      value(g, 'YOYNI'), value(g, 'YOYPNI'), value(g, 'YOYAsset'), value(g, 'YOYEquity'), value(g, 'YOYEPSBasic'),
      str(b.REPORT_TYPE),
      str(b.NOTICE_DATE_ISO) ?? (str(b.NOTICE_DATE)?.slice(0, 10) ?? null),
      value(b, 'TOTAL_PARENT_EQUITY'), value(b, 'SHARE_CAPITAL'), value(b, 'TOTAL_ASSETS'),
      value(b, 'TOTAL_LIABILITIES'), value(b, 'MONETARYFUNDS'), value(b, 'GOODWILL'), value(b, 'MINORITY_EQUITY'),
    ];
  });
  const balanceCovered = finPeriods.filter((p) => balanceByPeriod.has(p)).length;
  const finNote =
    'FINANCIAL(bsQuery=profit/growth) 按 statDate 合并（同期多版本取 as-of 可见最新）；' +
    `BALANCE 按同报告期连接（${balanceCovered}/${finPeriods.length} 期覆盖）；` +
    '金额单位元（BaoStock 原值字符串）；netProfit=来源净利润，不得改称归母或扣非；MBRevenue=来源收入字段，未核实公司/期次不得改称营业收入或营业总收入（已核实对照另列）；YOYPNI=归母净利润同比小数比例，百分数需×100；扣非累计及同比均缺失；' +
    (financialScope ? `金融口径：申万一级「${swL1Name ?? l1IndexCode ?? '未知'}」财务结构与一般制造业不可直接比较。` : '');
  tables.push({
    tableId: 'fin-quarterly',
    title: `季频财务（近 ${finPeriods.length} 个报告期，含 pubDate/noticeDate）`,
    columns: [...FIN_COLUMNS],
    rows: finRows,
    unitNote: finNote,
    locators: finLocators,
    cutoff: opts.cutoff,
  });
  if (finPeriods.length === 0) gaps.push('无 as-of 可见季频财务事实（FINANCIAL/BALANCE 均为空）');
  if (balanceFacts.length === 0) gaps.push('BALANCE 未覆盖：BPS（每股净资产）不可得');
  gaps.push('FINANCIAL 无扣非归母累计及同比字段；YOYPNI 是归母同比，不是扣非（独立原件核实表另列）');
  const hasEpsTtm = finRows.some((r) => r[FIN_COLUMNS.indexOf('epsTTM')] !== null);
  if (!hasEpsTtm) gaps.push('FINANCIAL 无 epsTTM：EPS-TTM 不可得（且无单季 eps 字段可自累计）');

  // --- bars-daily：最近 250 根 + 复权因子连接列（tables.ts 无损口径） ---
  const barsSorted = [...barFacts]
    .map((f) => ({ f, d: str(tvOf(f).date) ?? '' }))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .slice(0, DAILY_BARS)
    .map((x) => x.f);
  const barsTable = barsToTable(barsSorted, { adjustFactors: adjustFacts });
  const barDates = barsTable.rows.map((r) => {
    const idx = barsTable.header.indexOf('date');
    return idx >= 0 ? String(r[idx] ?? '') : '';
  });
  tables.push({
    tableId: 'bars-daily',
    title: `日线行情（最近 ${barsSorted.length} 个交易日，OHLCV+成交额+复权因子连接列）`,
    columns: barsTable.header,
    rows: barsTable.rows,
    ...(barsSorted.length > 0 && barsSorted.every((f) => String(tvOf(f).adjustflag) === '3') ? { priceBasis: 'UNADJUSTED_PRICE' as const } : {}),
    unitNote:
      'BaoStock DAILY_BAR 原始值（adjustflag=3 不复权，字符串原样保留）；amount 单位元、volume 单位股。' +
      `adjustFactor 列 = dividOperateDate≤当行日期的最近一次后复权因子（ADJUST_FACTOR 按日期连接；` +
      `本包 as-of 可见因子事实 ${adjustFacts.length} 条${adjustFacts.length > 0 ? '' : '（列不设置/值为 null 如实呈现）'}）；` +
      '前复权序列可由 close×adjustFactor÷最新因子重构，本表不做改写。',
    locators: barsTable.meta.rowFacts.map(metaLocator),
    cutoff: opts.cutoff,
  });
  if (barsSorted.length === 0) gaps.push('无 as-of 可见日线行情（DAILY_BAR）');

  // --- margin-series / holder-count / pledge ---
  const margin = recordRows(marginFacts, MARGIN_COLUMNS, 'tradeDateISO', MARGIN_ROWS);
  tables.push({
    tableId: 'margin-series',
    title: `融资融券（最近 ${margin.rows.length} 条）`,
    columns: margin.columns,
    rows: margin.rows,
    unitNote: 'MARGIN_BALANCE 原始值（东财两融口径，金额单位元、量的单位股）；来源原生中文键原样保留。',
    locators: margin.rowFacts.map(factLocator),
    cutoff: opts.cutoff,
  });
  if (margin.rows.length === 0) gaps.push('无 as-of 可见两融数据（MARGIN_BALANCE）');

  const holder = recordRows(holderFacts, HOLDER_COLUMNS, '股东户数统计截止日', HOLDER_ROWS);
  tables.push({
    tableId: 'holder-count',
    title: `股东户数（最近 ${holder.rows.length} 期）`,
    columns: holder.columns,
    rows: holder.rows,
    unitNote: 'HOLDER_COUNT 原始值（统计截止日/公告日期间可能错位，如实呈现；股本变动原因为 null 即来源为空）。',
    locators: holder.rowFacts.map(factLocator),
    cutoff: opts.cutoff,
  });
  if (holder.rows.length === 0) gaps.push('无 as-of 可见股东户数（HOLDER_COUNT）');

  const pledge = recordRows(pledgeFacts, PLEDGE_COLUMNS, 'TRADE_DATE_ISO', PLEDGE_ROWS);
  tables.push({
    tableId: 'pledge',
    title: `股权质押（最近 ${pledge.rows.length} 期周度快照）`,
    columns: pledge.columns,
    rows: pledge.rows,
    unitNote: 'PLEDGE_RATIO 原始值（比例单位 %，市值/余额单位万元——东财口径原样，未换算）。',
    locators: pledge.rowFacts.map(factLocator),
    cutoff: opts.cutoff,
  });
  if (pledge.rows.length === 0) gaps.push('无 as-of 可见质押数据（PLEDGE_RATIO）');

  // --- announcements-recent：按公告时间倒序取 60 条（announcementTime 为原值列，ISO 为派生列） ---
  const annSorted = annFacts
    .map((f) => {
      const tv = tvOf(f);
      const ms = typeof tv.announcementTime === 'number' ? tv.announcementTime : null;
      const sortKey = ms ?? new Date(f.availableAt).getTime();
      return { f, tv, ms, sortKey };
    })
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, ANNOUNCEMENT_ROWS);
  annSorted.reverse();
  const annColumns = [
    'announcementTimeISO', 'announcementTime', 'title', 'announcementType',
    'announcementId', 'secName', 'adjunctUrl', 'adjunctSize', 'availableAtISO',
  ] as const;
  const annRows = annSorted.map(({ f, tv, ms }) => [
    ms === null ? null : new Date(ms).toISOString(),
    cell(tv.announcementTime),
    cell(tv.title),
    cell(tv.announcementType),
    cell(tv.announcementId),
    cell(tv.secName),
    cell(tv.adjunctUrl),
    cell(tv.adjunctSize),
    f.availableAt,
  ]);
  tables.push({
    tableId: 'announcements-recent',
    title: `近期公告（最近 ${annRows.length} 条，标题+时间）`,
    columns: [...annColumns],
    rows: annRows,
    unitNote:
      'ANNOUNCEMENT 原始值；announcementTime 为公告时间原值（epoch 毫秒），' +
      'announcementTimeISO 为其派生 ISO 形式（UTC）；availableAtISO 为事实可见时间。',
    locators: annSorted.map((x) => factLocator(x.f)),
    cutoff: opts.cutoff,
  });
  if (annRows.length === 0) gaps.push('无 as-of 可见公告（ANNOUNCEMENT）');

  // --- industry：截点申万归属 + 指数成分 + 基本信息概要 ---
  const swTv = sw === null ? null : tvOf(sw.fact);
  const csrc = industryFacts.find((f) => str(tvOf(f).industryClassification) !== null) ?? null;
  const membershipLatest = new Map<string, string>();
  for (const f of membershipFacts) {
    const idx = str(tvOf(f).bsIndex);
    const upd = str(tvOf(f).updateDate);
    if (idx === null) continue;
    const prev = membershipLatest.get(idx);
    if (upd !== null && (prev === undefined || upd > prev)) membershipLatest.set(idx, upd);
  }
  const basicTv = basicFacts.length > 0 ? tvOf(basicFacts[basicFacts.length - 1] as TimePointFact) : null;
  const industryRows: (string | number | null)[][] = [
    ['冻结基准身份哈希', benchmark.bindingHash, `${benchmark.status} / ${benchmark.mapping.version}`],
    ['冻结归属事实', benchmark.attributionFact?.factId ?? null, benchmark.reason],
    ['申万分类体系', sw === null ? null : sw.system, sw === null ? '无 as-of 可见申万归属（INDUSTRY_CLASS_VERSION）' : 'INDUSTRY_CLASS_VERSION 区间有效版本（读取窗口体系）'],
    ['申万一级行业指数代码', l1IndexCode, sw !== null && sw.l1IndexCode === null ? '有效归属无 l1IndexCode' : '申万 L1 指数（801xxx）'],
    ['申万一级行业名称', swL1Name, l1IndexCode === null ? '——' : 'as-of SW_INDEX_LIST；缺名称不使用当前池名称'],
    ['申万行业代码（typedValue）', swTv === null ? null : cell(swTv['行业代码']), '来源原生 SW 二级行业代码'],
    ['申万计入日期', swTv === null ? null : cell(swTv['计入日期ISO']), '该归属生效（计入）日期'],
    ['证监会行业（as-of 可见）', csrc === null ? null : cell(tvOf(csrc).industry), 'INDUSTRY_CLASS_VERSION 证监会轴'],
    ...[...membershipLatest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([idx, upd]) => [
        `指数成分：${BS_INDEX_NAMES[idx] ?? idx}`,
        idx,
        `INDEX_MEMBERSHIP bsIndex=${idx}，最新 updateDate=${upd}`,
      ] as (string | number | null)[]),
    ...(basicTv === null
      ? []
      : ([
          ['上市日期', cell(basicTv.ipoDate), 'STOCK_BASIC.ipoDate'],
          ['证券状态（原值）', cell(basicTv.status), 'STOCK_BASIC.status 原值'],
        ] as (string | number | null)[][])),
  ];
  tables.push({
    tableId: 'industry',
    title: '行业归属与指数成分概要（截点时点）',
    columns: ['item', 'value', 'note'],
    rows: industryRows,
    unitNote: '长表：每行一项归属/成分事实概要；行级来源见 locators（与行序对齐）。',
    locators: [
      ...(sw === null ? [] : [factLocator(sw.fact)]),
      ...(csrc === null ? [] : [factLocator(csrc)]),
      ...membershipFacts.map(factLocator),
      ...basicFacts.map(factLocator),
    ],
    cutoff: opts.cutoff,
  });

  // --- index-bars：基准 = 截点申万 L1 的 SW_INDEX_BAR；缺则回退沪深300（上证指数未入库） ---
  let benchKind: 'SW_INDEX_BAR' | 'INDEX_DAILY_BAR' | null = null;
  let benchCode: string | null = null;
  let benchFacts: TimePointFact[] = [];
  if (l1IndexCode !== null) {
    const swBars = await asOfFacts(dataPool, {
      subjectType: 'INDEX',
      subjectId: l1IndexCode,
      factKind: 'SW_INDEX_BAR',
      asOf: cutoffDate,
    });
    if (swBars.length > 0) {
      benchKind = 'SW_INDEX_BAR';
      benchCode = l1IndexCode;
      benchFacts = swBars;
    }
  }
  let benchFallbackNote = '';
  if (benchKind === null) {
    const fb = await asOfFacts(dataPool, {
      subjectType: 'INDEX',
      subjectId: FALLBACK_BENCHMARK_INDEX,
      factKind: 'DAILY_BAR',
      asOf: cutoffDate,
    });
    if (fb.length > 0) {
      benchKind = 'INDEX_DAILY_BAR';
      benchCode = FALLBACK_BENCHMARK_INDEX;
      benchFacts = fb;
      benchFallbackNote = `（回退：申万 L1 ${l1IndexCode ?? '缺失'}无 as-of 可见行情，上证指数 000001 未入库，用沪深300）`;
      gaps.push(`基准回退沪深300(${FALLBACK_BENCHMARK_INDEX})：申万一级行业指数无 as-of 可见行情`);
    }
  }
  if (benchKind !== null) {
    const benchSorted = [...benchFacts]
      .map((f) => ({ f, d: str(tvOf(f)[benchKind === 'SW_INDEX_BAR' ? '日期' : 'date']) ?? '' }))
      .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
      .slice(0, DAILY_BARS)
      .map((x) => x.f);
    const benchTable = barsToTable(benchSorted);
    tables.push({
      tableId: 'index-bars',
      title: `基准指数行情（${benchCode}${benchKind === 'SW_INDEX_BAR' ? swL1Name === null ? '' : '·' + swL1Name : '·沪深300市场代理，非行业基准'}，最近 ${benchSorted.length} 个交易日）`,
      columns: benchTable.header,
      rows: benchTable.rows,
      ...(benchKind === 'INDEX_DAILY_BAR' && benchSorted.length > 0 && benchSorted.every((f) => String(tvOf(f).adjustflag) === '3') ? { priceBasis: 'UNADJUSTED_PRICE' as const } : {}),
      unitNote:
        `基准=${benchKind === 'SW_INDEX_BAR' ? `申万一级行业指数 ${benchCode}（SW_INDEX_BAR）` : `沪深300 ${benchCode}（INDEX DAILY_BAR）`}${benchFallbackNote}；` +
        (benchKind === 'SW_INDEX_BAR'
          ? 'SW 指数原生中文键原样（成交量/成交额单位为亿股/亿元，sw 适配器口径）。'
          : 'BaoStock 原始值（字符串原样）。'),
      locators: benchTable.meta.rowFacts.map(metaLocator),
      cutoff: opts.cutoff,
    });
  } else {
    gaps.push('基准指数无 as-of 可见行情（申万 L1 与沪深300 均无），相对表现不可计算');
    tables.push({
      tableId: 'index-bars',
      title: '基准指数行情（缺失）',
      columns: [],
      rows: [],
      unitNote: '无 as-of 可见基准行情，表为空（缺口已登记）。',
      locators: [],
      cutoff: opts.cutoff,
    });
  }

  const materials = await loadReportMaterials(opts.subject, opts.cutoff);
  tables.push(...materials.tables);
  gaps.push(...materials.gaps);
  if (opts.plan) {
    const bound = bindResearchPlan(tables, opts.plan, opts.cutoff, opts.horizon ?? 'MID_TERM');
    tables.splice(0, tables.length, ...bound.tables);
    gaps.push(...bound.gaps);
  }

  // --- coverage ---
  const firstBarDate = barDates.length > 0 ? (barDates[0] ?? null) : null;
  const lastBarDate = barDates.length > 0 ? (barDates[barDates.length - 1] ?? null) : null;
  const latestFinRow = finRows.length > 0 ? (finRows[finRows.length - 1] ?? null) : null;
  const latestStatDate = latestFinRow === null ? null : String(latestFinRow[0] ?? '');
  const sharesSource =
    latestFinRow !== null && latestFinRow[FIN_COLUMNS.indexOf('totalShare')] !== null
      ? `FINANCIAL(profit) totalShare@${latestStatDate}`
      : latestFinRow !== null && latestFinRow[FIN_COLUMNS.indexOf('SHARE_CAPITAL')] !== null
        ? `BALANCE SHARE_CAPITAL@${latestStatDate}`
        : null;
  const epsTtmSource =
    latestFinRow !== null && latestFinRow[FIN_COLUMNS.indexOf('epsTTM')] !== null
      ? `FINANCIAL(profit) epsTTM@${latestStatDate}（适配器原值口径，非自累计单季）`
      : null;
  const latestAnnIso = [...annRows]
    .map((r) => str(r[0]))
    .filter((v): v is string => v !== null)
    .sort()
    .pop() ?? null;

  const coverage: SrCoverage = {
    financials: {
      periods: finRows.length,
      latestPeriod: latestStatDate === '' ? null : latestStatDate || null,
      note: finNote,
    },
    bars: {
      count: barsSorted.length,
      firstDate: firstBarDate === '' ? null : firstBarDate,
      lastDate: lastBarDate === '' ? null : lastBarDate,
      note:
        `DAILY_BAR as-of 可见 ${barFacts.length} 根，取最近 ${barsSorted.length} 根；` +
        `ADJUST_FACTOR as-of 可见 ${adjustFacts.length} 条（连接列见 bars-daily unitNote）`,
    },
    announcements: {
      count: annRows.length,
      latestTitleAt: latestAnnIso,
      note: annRows.length === 0 ? '无 as-of 可见公告' : '按公告时间（announcementTime）取最近 60 条',
    },
    margin: {
      count: margin.rows.length,
      latestDate: margin.rows.length > 0 ? str(margin.rows[margin.rows.length - 1]?.[margin.columns.indexOf('tradeDateISO')]) : null,
      note: margin.rows.length === 0 ? '无 as-of 可见两融数据' : 'MARGIN_BALANCE 东财口径',
    },
    holderCount: {
      count: holder.rows.length,
      latestDate: holder.rows.length > 0 ? str(holder.rows[holder.rows.length - 1]?.[holder.columns.indexOf('股东户数统计截止日')]) : null,
      note: holder.rows.length === 0 ? '无 as-of 可见股东户数' : 'HOLDER_COUNT，统计截止日口径',
    },
    pledge: {
      count: pledge.rows.length,
      latestDate: pledge.rows.length > 0 ? str(pledge.rows[pledge.rows.length - 1]?.[pledge.columns.indexOf('TRADE_DATE_ISO')]) : null,
      note: pledge.rows.length === 0 ? '无 as-of 可见质押数据' : 'PLEDGE_RATIO 周度快照',
    },
    industry: {
      swL1: swL1Name,
      note:
        (sw === null ? '无 as-of 有效申万归属' : `体系 ${sw.system}，L1=${sw.l1IndexCode ?? '无'}；`) +
        `指数成分（as-of）：${membershipLatest.size > 0 ? [...membershipLatest.keys()].sort().join(',') : '无'}` +
        (benchFallbackNote === '' ? '' : benchFallbackNote),
    },
    valuationInputs: {
      closePriceDate: lastBarDate === '' ? null : lastBarDate,
      sharesSource,
      epsTtmSource,
      note:
        '估值输入在 compute 层计算（PE-TTM=close÷epsTTM，PB=close÷BPS，BPS=TOTAL_PARENT_EQUITY÷SHARE_CAPITAL）；' +
        'EPS-TTM 无自累计路径（无单季 eps 字段），采用 FINANCIAL epsTTM 原值' +
        (financialScope ? '；金融口径：银行/非银估值指标与一般行业不可直接比较' : ''),
    },
    gaps: [...new Set(gaps)],
  };

  const builtAt = new Date().toISOString();
  const packNoHash = {
    taskId: opts.taskId,
    subject: opts.subject,
    cutoff: opts.cutoff,
    benchmark,
    comparisonBenchmark: { kind: benchKind === 'SW_INDEX_BAR' ? 'INDUSTRY' as const : benchCode === null ? 'MISSING' as const : 'MARKET_PROXY' as const,
      indexCode: benchCode, industryBindingHash: benchmark.bindingHash, note: benchFallbackNote,
      factIds: benchFacts.map((f) => f.factId), artifactHashes: [...new Set(benchFacts.map((f) => f.artifactSha256))].sort() },
    builtAt,
    tables,
    coverage,
  };
  const pack: EvidencePack = { ...packNoHash, packHash: canonicalSha256(packNoHash) };
  const dir = join(opts.outputDir, 'tasks', opts.taskId);
  await mkdir(dir, { recursive: true });
  const packPath = join(dir, 'evidence.json');
  await writeFile(packPath, `${JSON.stringify(pack, null, 1)}\n`, 'utf8');
  return { pack, packPath };
}

/** Freeze the actual PLAN obligations into the package consumed by COMPUTE/A/J. */
export function applyPlanToEvidence(pack: EvidencePack, plan: PlanOutput, horizon: SrHorizon): EvidencePack {
  const bound = bindResearchPlan(pack.tables, plan, pack.cutoff, horizon);
  const { packHash: _oldHash, ...base } = pack;
  const next = { ...base, tables: bound.tables, coverage: { ...pack.coverage, gaps: [...new Set([...pack.coverage.gaps, ...bound.gaps])] } };
  return { ...next, packHash: canonicalSha256(next) };
}
