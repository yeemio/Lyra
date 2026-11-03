/**
 * Lyra · 研究输入组装器（P2 W11: code-writer-pro）。
 * 合同：docs/specs/P2-RESEARCH.md Done-when 2；docs/specs/RESEARCH-METHOD.md §4（八维度/宽基七维）、
 * §5（输入分层〔R2〕）、§8（结论对象引用的封存 manifest）；docs/specs/POINT-IN-TIME.md §7（封存复用）。
 *
 * 流程：冻结池标的 → 复用 buildSeal（WEEKLY 业务键；标的 seal + 行业基准/跟踪指数 seal，
 * 同一业务键多 selector）→ 按下方冻结规则表映射维度材料（行情一律 tables.ts 无损表格）→
 * L0（背景）/L1（会改变判断的证据）/L2（索引目录）分层，每层独立字节预算；
 * L1 按维度优先级装填，超层预算的材料降入 L2 目录并在 coverage 标记（禁止静默截断）；
 * L0 与 L2 不可裁剪，超预算即 KernelError('INPUT_OVER_BUDGET')（EK-4.4 阻断不截断）；
 * inputHash = canonicalSha256(包内容除 inputHash 外)；包整体（含 coverage）作为 JSON 原件入 store。
 *
 * 字节口径（冻结）：某材料的字节数 = 其"模型载荷" canonical JSON 的 UTF-8 字节数——
 * BAR_TABLE 载荷 {title,header,rows}（meta 不进模型视野）、RECORDS {title,records}、
 * NOTE {title,text}、INDEX {title,deliveredFacts,seals,note}；层字节 = 块字节之和。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import {
  KernelError,
  type AdapterVersionId,
  type ArtifactRef,
  type MethodVersionId,
  type PlanAuthVersionId,
  type ResearchBusinessKey,
  type ResearchKind,
  type SealManifest,
  type SubjectKind,
  type TimePointFact,
} from '../contracts.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { asOfFacts, loadFact } from '../pintime/facts.js';
import { buildSeal, sealManifestContent } from '../pintime/seal.js';
import { SW2014_GAP, SW_CLASS_SOURCE_GAP } from '../adapters/swclass.js';
import { SW_CLASS_SOURCE_GAP_CLOSED } from '../adapters/sw.js';
import { loadStockPESamples, industryMedianPE, stockPEOf, pePercentileOf } from './industry-valuation.js';
import { decFromString } from '../settlement/decimal.js';
import { computeIndicators } from './indicators.js';
import { qualityIndicators } from './quality.js';
import { industryMomentumTable, type IndustryMomentumTable } from './rotation.js';
import { assertRoundTrip, barsToTable, type BarTable } from './tables.js';

/** 组装器具名错误（超预算除外——超预算按 EK-4.4 用 KernelError('INPUT_OVER_BUDGET')）。 */
export class ResearchInputError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ResearchInputError';
  }
}

// ===== 冻结常量（规则表随包携带并哈希钉扎）=====

export const ASSEMBLER_RULES_VERSION = 'research-inputs@p2-v1';
export const PACKAGE_VERSION = 1;

/** 维度材料映射规则（可验收条款）。priority 小者先装填 L1。 */
export interface DimensionRule {
  dimension: number;
  code: string;
  name: string;
  priority: number;
  clause: string;
}

/** 个股八维度（RESEARCH-METHOD §4；L1 优先序按 P2 合同：预期差>基本面>价格行为>行业>事件>风险）。 */
export const STOCK_DIMENSION_RULES: readonly DimensionRule[] = [
  {
    dimension: 1, code: 'FUNDAMENTALS', name: '基本面变化', priority: 2,
    clause:
      'FINANCIAL 事实（subject=本股，pubDate 口径 as-of 截点）：取 as-of 可见事实中 distinct statDate 最近 8 个报告期，' +
      '期内全部 bsQuery 行整行原样送达（typedValue 不改写）；不足 8 期或无事实如实声明。',
  },
  {
    dimension: 2, code: 'VALUATION', name: '估值', priority: 7,
    clause:
      '不编造 PE/PB：只送达 最新 DAILY_BAR 收盘（原始值）+ 最新 FINANCIAL(profit) 股本/净利字段（原始值）+ 计算说明文本；' +
      '估值分位不可精确计算（长历史 PE/PB 序列与行业分布未入库）→ 输出"原始材料+计算说明"，不输出算好的值。',
  },
  {
    dimension: 3, code: 'EXPECTATION_GAP', name: '预期差', priority: 1,
    clause:
      'ANNOUNCEMENT 事实（as-of 截点；事件时间 eventAt??availableAt ∈ [cutoff−730 天, cutoff] 即近 8 季度）标题含' +
      '{业绩预告,业绩快报,预增,预减,略增,略减,扭亏,首亏,续亏,续盈}之一 → 摘录 标题+时间+adjunctUrl 引用；' +
      '正文不做 L1 解析；窗口内无命中 → 空命中材料如实送达。',
  },
  {
    dimension: 4, code: 'CORPORATE_EVENTS', name: '公司事件', priority: 5,
    clause:
      '同维度 3 的窗口与 as-of 口径，标题含 {解禁,增持,减持,回购,分红,送转,送股,转增,定增,非公开发行,配股,股权激励,质押}' +
      '之一且未被维度 3 命中的公告 → 同款摘录。',
  },
  {
    dimension: 5, code: 'PRICE_ACTION', name: '资金与价格行为', priority: 3,
    clause:
      'DAILY_BAR 按 date 取最近 120 个交易日（不足如实）表格化无损表示（全部原始字段不丢列）+ 复权因子列' +
      '（dividOperateDate<=当行日期的最近一次 ADJUST_FACTOR.adjustFactor，无则 null；无因子事实则不设列）+' +
      '换手率与单位说明；融资余额与龙虎榜未入库 → 缺口声明。',
  },
  {
    dimension: 6, code: 'INDUSTRY', name: '行业景气', priority: 4,
    clause:
      'INDUSTRY_CLASS_VERSION(申万轴) 按 [validFrom, validTo) 区间含截点选有效归属（多版本并存取体系序 ' +
      'pre2014<2014<2021 最末；同序取 validFrom 最新）→ 归属记录 + 对应 SW_INDEX_BAR 最近 120 交易日表格化；' +
      '无有效归属 / 无 l1IndexCode / 基准无 as-of 可见行情 → 各自缺口声明。',
  },
  {
    dimension: 7, code: 'RISKS', name: '风险项', priority: 6,
    clause:
      'STOCK_BASIC（as-of 可见才送达）+ 股权质押比例周度快照（PLEDGE_RATIO，最近 8 期）+ 股东户数（HOLDER_COUNT，最近 8 期）' +
      '+ 具名缺口：商誉占净资产比例、审计意见、监管问询（未入库）。',
  },
  {
    dimension: 8, code: 'HISTORICAL_REFERENCE', name: '历史事件参照', priority: 8,
    clause: 'P4 前输出占位说明段 + 缺口声明（历史参照库未建，无参照数据进入输入）。',
  },
] as const;

/** 宽基 ETF 七维（FREEZE-P0 §四〔R18〕）；材料 = ETF DAILY_BAR + 跟踪指数 DAILY_BAR/SW_INDEX_BAR。 */
export const ETF_DIMENSION_RULES: readonly DimensionRule[] = [
  {
    dimension: 1, code: 'ETF_VALUATION_PERCENTILE', name: '估值分位', priority: 3,
    clause: '跟踪指数估值（PE/PB）历史未入库 → 送达原始材料（指数行情表）+ 计算说明，不输出分位值；缺口声明。',
  },
  {
    dimension: 2, code: 'ETF_CONSTITUENT_EARNINGS', name: '成分盈利趋势', priority: 5,
    clause: '成分股盈利数据未入库 → 占位说明 + 缺口声明。',
  },
  {
    dimension: 3, code: 'ETF_MACRO_POLICY', name: '宏观与政策', priority: 6,
    clause: '宏观与政策数据源未接入（FREEZE §四已知缺口）→ 占位说明 + 缺口声明。',
  },
  {
    dimension: 4, code: 'ETF_FLOWS', name: '资金', priority: 2,
    clause: 'ETF DAILY_BAR 的 amount/turn 字段为资金侧原始材料（随维度 5 表格送达）+ 字段说明；资金流向专用数据未入库 → 缺口声明。',
  },
  {
    dimension: 5, code: 'ETF_PRICE_BREADTH', name: '价格行为与市场宽度', priority: 1,
    clause:
      'ETF DAILY_BAR 最近 120 交易日表格化无损表示 + 跟踪指数 DAILY_BAR/SW_INDEX_BAR 最近 120 交易日表格化；' +
      '市场宽度数据未入库 → 缺口声明。',
  },
  {
    dimension: 6, code: 'ETF_STYLE_RELATIVE', name: '风格相对', priority: 4,
    clause: '可比指数序列未纳入本轮封存 → 送达计算说明，不输出相对强弱值；缺口声明。',
  },
  {
    dimension: 7, code: 'ETF_HISTORICAL_STATE', name: '历史状态参照', priority: 7,
    clause: 'P4 前占位说明 + 缺口声明（历史状态参照库未建）。',
  },
] as const;

export const EXPECTATION_GAP_KEYWORDS = [
  '业绩预告', '业绩快报', '预增', '预减', '略增', '略减', '扭亏', '首亏', '续亏', '续盈',
] as const;
export const CORPORATE_EVENT_KEYWORDS = [
  '解禁', '增持', '减持', '回购', '分红', '送转', '送股', '转增', '定增', '非公开发行', '配股', '股权激励', '质押',
] as const;
/** 近 8 季度窗口（自然日）：D3/D4 公告摘录的事件时间窗。 */
export const RECENT_QUARTERS_WINDOW_DAYS = 730;
/** 行情表最近交易日数（D5 / 维度 6 基准 / ETF 维度 5）。 */
export const RECENT_BARS = 120;
/** 财务近报告期数（D1）。 */
export const RECENT_REPORT_PERIODS = 8;

/** 申万体系序（D6 规则：多版本并存取体系序最末）。 */
const SW_SYSTEM_RANK: Record<string, number> = { pre2014: 0, '2014': 1, '2021': 2 };

// ===== 池信息 =====

export interface PoolSubjectEntry {
  code: string;
  name: string;
  swL1IndexCode?: string;
  swL1Name?: string;
  tracks?: string;
}

interface PoolInfo {
  frozenAt: string;
  stocks: PoolSubjectEntry[];
  etfs: PoolSubjectEntry[];
}

const DEFAULT_POOL_INFO_FILE = fileURLToPath(new URL('../../data/research-pool.json', import.meta.url));

async function loadPoolInfo(file: string): Promise<PoolInfo> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ResearchInputError('POOL_INFO_INVALID', `${file}: ${String(error)}`);
  }
  const info = parsed as Partial<PoolInfo>;
  if (typeof info.frozenAt !== 'string' || !Array.isArray(info.stocks) || !Array.isArray(info.etfs)) {
    throw new ResearchInputError('POOL_INFO_INVALID', `${file}: 缺 frozenAt/stocks/etfs`);
  }
  return info as PoolInfo;
}

function findPoolSubject(info: PoolInfo, kind: SubjectKind, subject: string): PoolSubjectEntry | null {
  const list = kind === 'STOCK' ? info.stocks : info.etfs;
  return list.find((entry) => entry.code === subject) ?? null;
}

/** 跟踪指数代码：池文件 tracks 形如 "沪深300(000300)"。 */
export function trackingIndexOf(tracks: string): string | null {
  const m = /(\d{6})/.exec(tracks);
  return m === null ? null : (m[1] as string);
}

// ===== 材料 / 层 / 包对象 =====

export interface MaterialBase {
  materialId: string;
  title: string;
  /** 维度号；0 = 非维度材料（L0 身份/规则/回执、L2 索引）。 */
  dimension: number;
  factIds: string[];
}

export interface BarTableMaterial extends MaterialBase {
  kind: 'BAR_TABLE';
  table: BarTable;
}

export interface RecordsMaterial extends MaterialBase {
  kind: 'RECORDS';
  records: Record<string, unknown>[];
}

export interface NoteMaterial extends MaterialBase {
  kind: 'NOTE';
  text: string;
}

export interface InputIndexSealEntry {
  sealId: string;
  manifestHash: string;
  subject: string;
  cutoff: string;
  facts: number;
  artifacts: number;
  factKindCounts: Record<string, number>;
  artifactRefs: ArtifactRef[];
}

export interface InputIndexContent {
  /** 送达材料（L0/L1）引用目录：factId → 材料与原件哈希（证据引用命中检查用）。 */
  deliveredFacts: { factId: string; materialId: string; artifactSha256: string; layer: 'L0' | 'L1' }[];
  /** 降入 L2 目录的材料条目（超 L1 预算；目录可见、内容未送达——引用纪律照常约束）。 */
  demotedMaterials: { materialId: string; dimension: number; title: string; bytes: number; factCount: number }[];
  /** 封存目录摘要（全部封存事实 factId 完整清单 = seals[].factIds，seal manifest 随包携带）。 */
  seals: InputIndexSealEntry[];
  note: string;
}

export interface IndexMaterial extends MaterialBase {
  kind: 'INDEX';
  content: InputIndexContent;
}

export type Material = BarTableMaterial | RecordsMaterial | NoteMaterial | IndexMaterial;

/** 模型载荷（字节计量口径；BAR_TABLE 的 meta 不进模型视野）。 */
export function modelPayloadOf(material: Material): Record<string, unknown> {
  switch (material.kind) {
    case 'BAR_TABLE':
      return { title: material.title, header: material.table.header, rows: material.table.rows };
    case 'RECORDS':
      return { title: material.title, records: material.records };
    case 'NOTE':
      return { title: material.title, text: material.text };
    case 'INDEX':
      return {
        title: material.title,
        deliveredFacts: material.content.deliveredFacts,
        demotedMaterials: material.content.demotedMaterials,
        seals: material.content.seals,
        note: material.content.note,
      };
  }
}

export function materialBytes(material: Material): number {
  return Buffer.byteLength(canonicalJsonString(modelPayloadOf(material)), 'utf8');
}

export interface LayerReceipt {
  name: 'L0' | 'L1' | 'L2';
  budget: number;
  bytes: number;
  blocks: { materialId: string; bytes: number }[];
}

export interface DimensionCoverage {
  dimension: number;
  code: string;
  name: string;
  delivered: string[];
  demoted: string[];
  gap: string[];
}

export interface InputBudget {
  l0Bytes: number;
  l1Bytes: number;
  l2Bytes: number;
  totalBytes: number;
}

export interface AssembleVersions {
  methodVersion: MethodVersionId;
  adapterVersion: AdapterVersionId;
  planAuthVersion: PlanAuthVersionId;
}

export interface ResearchInputPackage {
  packageKind: 'RESEARCH_INPUT';
  packageVersion: number;
  assemblerRulesVersion: string;
  businessKey: ResearchBusinessKey;
  cutoff: string;
  pool: { file: string; frozenAt: string; subject: PoolSubjectEntry };
  versions: AssembleVersions;
  /** 本轮全部封存（第一个 = 标的 seal；后续 = 行业基准/跟踪指数 seal；同一业务键）。 */
  seals: SealManifest[];
  /** 全部材料（含被降级材料；layers 只引用 id）。 */
  materials: Material[];
  dimensions: DimensionCoverage[];
  rules: DimensionRule[];
  layers: { l0: LayerReceipt; l1: LayerReceipt; l2: LayerReceipt };
  inputHash: string;
}

export interface AssembleResearchInputOptions {
  subjectKind: SubjectKind;
  subject: string;
  cutoff: string;
  budget: InputBudget;
  versions: AssembleVersions;
  researchKind?: ResearchKind;
  poolInfoFile?: string;
}

export interface AssembledResearchInput {
  package: ResearchInputPackage;
  artifactRef: ArtifactRef;
  inputHash: string;
  inputBytes: number;
}

// ===== 内部工具 =====


function parseDateStrict(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ResearchInputError('INVALID_INPUT', `${field}: ${value}`);
  return d;
}

function validateBudget(budget: InputBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ResearchInputError('INVALID_INPUT', `budget.${key} 须为正整数：${String(value)}`);
    }
  }
}

function subjectTypeOfKind(kind: SubjectKind): 'STOCK' | 'ETF' {
  return kind === 'STOCK' ? 'STOCK' : 'ETF';
}

function rulesOfKind(kind: SubjectKind): readonly DimensionRule[] {
  return kind === 'STOCK' ? STOCK_DIMENSION_RULES : ETF_DIMENSION_RULES;
}

function tv(fact: TimePointFact): Record<string, unknown> {
  return fact.typedValue as Record<string, unknown>;
}

function barDateOf(fact: TimePointFact): string | null {
  if (fact.factKind === 'DAILY_BAR') {
    const d = tv(fact).date;
    return typeof d === 'string' ? d : null;
  }
  if (fact.factKind === 'SW_INDEX_BAR') {
    const d = tv(fact)['日期'];
    return typeof d === 'string' ? d : null;
  }
  return null;
}

/** 最近 n 个交易日行情（按日期取最新 n 根，返回升序）。 */
function recentBarFacts(facts: TimePointFact[], n: number): TimePointFact[] {
  const bars = facts.filter((f) => f.factKind === 'DAILY_BAR' || f.factKind === 'SW_INDEX_BAR');
  bars.sort((a, b) => {
    const da = barDateOf(a) ?? '';
    const db = barDateOf(b) ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a.factId < b.factId ? -1 : 1;
  });
  return bars.slice(Math.max(0, bars.length - n));
}

function factTimeMs(fact: TimePointFact): number {
  const t = fact.eventAt ?? fact.availableAt;
  return new Date(t).getTime();
}

function titleOf(fact: TimePointFact): string {
  return String(tv(fact).title ?? '');
}

function announcementRecord(fact: TimePointFact): Record<string, unknown> {
  const v = tv(fact);
  const ms = typeof v.announcementTime === 'number' ? v.announcementTime : null;
  return {
    factId: fact.factId,
    artifactSha256: fact.artifactSha256,
    title: titleOf(fact),
    announcementTime: ms === null ? null : new Date(ms).toISOString(),
    adjunctUrl: v.adjunctUrl ?? null,
    announcementType: v.announcementType ?? null,
    eventAt: fact.eventAt,
  };
}

interface SwAttribution {
  fact: TimePointFact;
  system: string;
  l1IndexCode: string | null;
}

/** 截点当时有效申万归属（D6 规则：区间含截点；体系序最末；同序 validFrom 最新）。 */
export function pickSwIndustryAt(facts: TimePointFact[], cutoff: Date): SwAttribution | null {
  const valid = facts.filter((f) => {
    if (f.factKind !== 'INDUSTRY_CLASS_VERSION') return false;
    const system = tv(f).体系;
    if (typeof system !== 'string') return false; // 证监会轴（classVersion）不参与申万基准选择
    const from = f.validFrom === null ? null : new Date(f.validFrom).getTime();
    const to = f.validTo === null ? null : new Date(f.validTo).getTime();
    const c = cutoff.getTime();
    if (from !== null && from > c) return false;
    if (to !== null && to <= c) return false;
    return true;
  });
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const ra = SW_SYSTEM_RANK[String(tv(a).体系)] ?? -1;
    const rb = SW_SYSTEM_RANK[String(tv(b).体系)] ?? -1;
    if (ra !== rb) return ra - rb;
    const fa = new Date(a.validFrom ?? a.availableAt).getTime();
    const fb = new Date(b.validFrom ?? b.availableAt).getTime();
    if (fa !== fb) return fa - fb;
    return a.factId < b.factId ? -1 : 1;
  });
  const fact = valid[valid.length - 1] as TimePointFact;
  const l1 = tv(fact).l1IndexCode;
  return {
    fact,
    system: String(tv(fact).体系),
    l1IndexCode: typeof l1 === 'string' && l1.length > 0 ? l1 : null,
  };
}

function countByKind(facts: TimePointFact[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of facts) counts[f.factKind] = (counts[f.factKind] ?? 0) + 1;
  return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k] as number]));
}

// ===== 材料构造（个股八维）=====

interface DimensionBuild {
  materials: Material[];
  gaps: string[];
}


/** 监管问询事件行（assembleResearchInput 预查询传入，保持维度构建纯函数）。 */
interface InquiryEventRow { subtype: string; letterKind: string; issuer: string; eventTime: string; evidenceFactId: string }
function buildStockDimensions(
  facts: TimePointFact[],
  benchmarkFacts: TimePointFact[],
  poolSubject: PoolSubjectEntry,
  cutoff: Date,
  sw: SwAttribution | null,
inquiryEvents?: InquiryEventRow[], referenceGroups?: ReferenceGroupRow[], rotationTable?: IndustryMomentumTable | null, industryValuation?: { table: ReturnType<typeof industryMedianPE>; stockPE: string | null; stockIndustryPercentile: string | null } | null): DimensionBuild[] {
  const builds: DimensionBuild[] = [];
  const windowStart = cutoff.getTime() - RECENT_QUARTERS_WINDOW_DAYS * 86_400_000;
  const gapsOf = (dim: number, list: string[]): string[] => list.map((g) => `D${dim}: ${g}`);

  // ---- D1 基本面 ----
  {
    const fins = facts.filter((f) => f.factKind === 'FINANCIAL');
    const statDates = [...new Set(fins.map((f) => String(tv(f).statDate ?? '')))].filter((s) => s !== '').sort().reverse();
    const keep = new Set(statDates.slice(0, RECENT_REPORT_PERIODS));
    const selected = fins.filter((f) => keep.has(String(tv(f).statDate ?? '')));
    selected.sort((a, b) => {
      const sa = String(tv(a).statDate ?? '');
      const sb = String(tv(b).statDate ?? '');
      if (sa !== sb) return sa < sb ? 1 : -1; // 报告期新在前
      return String(tv(a).bsQuery ?? '') < String(tv(b).bsQuery ?? '') ? -1 : 1;
    });
    const gaps = gapsOf(1, fins.length === 0 ? ['无 as-of 可见财务事实'] : []);
    const materials: Material[] = [];
    if (selected.length > 0) {
      materials.push({
        materialId: 'mat:1:financials',
        title: `基本面：财务指标（近 ${keep.size} 个报告期，pubDate 口径 as-of，typedValue 原样）`,
        dimension: 1,
        kind: 'RECORDS',
        records: selected.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
        factIds: selected.map((f) => f.factId),
      });
    }
    // W35 接线：财报质量确定性指标（纯函数，输入全部来自封存内 FINANCIAL/BALANCE 事实；中性命名，无定性词）
    if (fins.length > 0) {
      const bals = facts.filter((f) => f.factKind === 'BALANCE');
      if (bals.length > 0) {
        try {
          const qi = qualityIndicators(fins, bals, cutoff);
          materials.push({
            materialId: 'mat:1:quality-indicators',
            title: '基本面：财报质量确定性指标（程序复算，公式随 formulaRef；营收字段仅年报/中报披露——Q1/Q3 期背离度为 null 属源披露边界，消费取 series）',
            dimension: 1,
            kind: 'NOTE',
            text: JSON.stringify(qi, null, 1),
            factIds: [],
          });
        } catch { /* 质量指标计算失败不阻断基本面材料 */ }
      }
    }
    builds.push({ materials, gaps });
  }

  // ---- D2 估值（原始材料 + 计算说明，不算值）----
  {
    const bars = facts.filter((f) => f.factKind === 'DAILY_BAR');
    const latestBar = recentBarFacts(bars, 1)[0] ?? null;
    const profits = facts
      .filter((f) => f.factKind === 'FINANCIAL' && String(tv(f).bsQuery ?? '') === 'profit')
      .sort((a, b) => (String(tv(a).statDate ?? '') < String(tv(b).statDate ?? '') ? 1 : -1));
    const latestProfit = profits[0] ?? null;
    const lines: string[] = [
      '估值维度按合同输出"原始材料+计算说明"，不输出算好的值（估值历史分位与行业分位不可精确计算）。',
      '原始材料（原样引用，未改写）：',
    ];
    if (latestBar !== null) {
      lines.push(`- 最新收盘（DAILY_BAR ${latestBar.factId}）：date=${String(tv(latestBar).date)} close=${String(tv(latestBar).close)}`);
    }
    if (latestProfit !== null) {
      const p = tv(latestProfit);
      lines.push(
        `- 最新财务（FINANCIAL/profit ${latestProfit.factId}）：statDate=${String(p.statDate)} pubDate=${String(p.pubDate)} ` +
          `epsTTM=${String(p.epsTTM ?? '缺')} totalShare=${String(p.totalShare ?? '缺')} liqaShare=${String(p.liqaShare ?? '缺')} ` +
          `netProfit=${String(p.netProfit ?? '缺')} roeAvg=${String(p.roeAvg ?? '缺')}`,
      );
    }
    lines.push(
      '计算说明（模型按需自行计算，程序不预置结果）：',
      '- 市盈率可用 最新收盘 / epsTTM 近似（epsTTM 为滚动口径，注意其 pubDate 时点）；',
      '- 市净率需要每股净资产（未入库，不可计算）；',
      '- 估值自身历史分位：跟踪指数面已入库（宽基）；个股面长历史自身 PE 序列未预置（可由 D5 行情表+财务序列按需近似）。',
      '- 行业截面：送达下方"行业估值截面表"（自算中位 PE，含覆盖标记——lowCoverage 行业的代表性受限声明见材料标题）。',
    );
    const d2Materials: Material[] = [{
      materialId: 'mat:2:valuation-raw-and-method',
      title: '估值：原始材料与计算说明（不输出计算值）',
      dimension: 2,
      kind: 'NOTE',
      text: lines.join('\n'),
      factIds: [latestBar?.factId, latestProfit?.factId].filter((x): x is string => x !== undefined),
    }];
    const d2Gaps = [
      ...(industryValuation === null || industryValuation === undefined
        ? ['估值历史分位与行业分位不可精确计算——只送达原始材料与计算说明，不输出算好的值']
        : [
            ...(industryValuation.stockIndustryPercentile === null
              ? ['本股行业截面分位不可计算（行业样本不足或本股 PE 不可得）——行业中位见表，代表性按覆盖标记评估']
              : []),
            '市净率所需每股净资产未入库',
          ]),
      ...(latestBar === null ? ['无 as-of 可见行情，最新收盘缺失'] : []),
      ...(latestProfit === null ? ['无 as-of 可见 FINANCIAL(profit) 事实'] : []),
    ];
    if (industryValuation !== null && industryValuation !== undefined) {
      d2Materials.push({
        materialId: 'mat:2:industry-valuation-cross-section',
        title: `估值：行业估值截面表（自算中位 PE，as-of ${industryValuation.table.asOf}；口径=行业成分股 close/epsTTM 中位数，覆盖 n<5 标 lowCoverage——代表性受限，随财务覆盖扩展自动改善；缺失行业：${industryValuation.table.missingIndustries.length} 个）${industryValuation.stockPE !== null ? `；本股 PE=${industryValuation.stockPE}` : ''}${industryValuation.stockIndustryPercentile !== null ? `，本股行业截面分位=${industryValuation.stockIndustryPercentile}` : ''}`,
        dimension: 2,
        kind: 'RECORDS',
        records: industryValuation.table.rows.map((r) => ({ 行业代码: r.industryIndexCode, 行业名称: r.name, n: r.n, medianPE: r.medianPE, lowCoverage: r.lowCoverage, 非正剔除: r.excludedNonPositive })),
        factIds: [],
      });
    }
    builds.push({
      materials: d2Materials,
      gaps: gapsOf(2, d2Gaps),
    });
  }

  // ---- D3 预期差 / D4 公司事件（标题摘录，近 8 季度窗口）----
  const announcements = facts.filter((f) => f.factKind === 'ANNOUNCEMENT');
  const inWindow = announcements.filter((f) => {
    const t = factTimeMs(f);
    return t >= windowStart && t <= cutoff.getTime();
  });
  const expectationHits = inWindow.filter((f) => EXPECTATION_GAP_KEYWORDS.some((k) => titleOf(f).includes(k)));
  const expectationIds = new Set(expectationHits.map((f) => f.factId));
  const eventHits = inWindow.filter(
    (f) => !expectationIds.has(f.factId) && CORPORATE_EVENT_KEYWORDS.some((k) => titleOf(f).includes(k)),
  );
  const byTimeDesc = (a: TimePointFact, b: TimePointFact): number => factTimeMs(b) - factTimeMs(a);
  builds.push({
    materials: [{
      materialId: 'mat:3:expectation-excerpts',
      title: `预期差：业绩预告/快报类公告标题摘录（近 ${RECENT_QUARTERS_WINDOW_DAYS} 天窗口，正文不做 L1 解析，adjunctUrl 引用）`,
      dimension: 3,
      kind: 'RECORDS',
      records: [...expectationHits].sort(byTimeDesc).map(announcementRecord),
      factIds: [...expectationHits].sort(byTimeDesc).map((f) => f.factId),
    }],
    gaps: gapsOf(3, announcements.length === 0 ? ['无 as-of 可见公告事实'] : []),
  });
  // W42 接线：解禁双源——标题级事件（公告时刻可见=前瞻）+ 明细金额（解禁日后可得=事后核实），时点口径差异在标题声明
  const unlockDetails = facts.filter((f) => f.factKind === 'UNLOCK_DETAIL').slice(-8);
  const d4Materials: Material[] = [{
    materialId: 'mat:4:corporate-event-excerpts',
    title: `公司事件：事件类公告标题摘录（近 ${RECENT_QUARTERS_WINDOW_DAYS} 天窗口，不含维度 3 已命中；含解禁类公告——公告时刻即可见，具前瞻性）`,
    dimension: 4,
    kind: 'RECORDS',
    records: [...eventHits].sort(byTimeDesc).map(announcementRecord),
    factIds: [...eventHits].sort(byTimeDesc).map((f) => f.factId),
  }];
  if (unlockDetails.length > 0) {
    d4Materials.push({
      materialId: 'mat:4:unlock-detail',
      title: `公司事件：限售解禁明细（最近 ${String(unlockDetails.length)} 批次，东财 emunlock@p1；availableAt=解禁日次日——**明细节点为事后核实口径，前瞻请以解禁类公告标题为准**；解禁数量股/市值元/占总市值比例；全流通无解禁记录的股票不在此列）`,
      dimension: 4,
      kind: 'RECORDS',
      records: unlockDetails.map((f) => {
        const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
        delete row['序号'];
        return row;
      }),
      factIds: unlockDetails.map((f) => f.factId),
    });
  }
  builds.push({
    materials: d4Materials,
    gaps: gapsOf(4, unlockDetails.length === 0 ? ['解禁明细：as-of 无可见批次（全流通股无解禁记录或截点早于最近批次）——解禁前瞻以公告标题事件为准'] : []),
  });

  // ---- D5 资金与价格行为（行情表 + 换手率说明）----
  {
    const bars = recentBarFacts(facts, RECENT_BARS);
    const factors = facts.filter((f) => f.factKind === 'ADJUST_FACTOR');
    const materials: Material[] = [];
    if (bars.length > 0) {
      materials.push({
        materialId: 'mat:5:daily-bar-table',
        title: `资金与价格行为：DAILY_BAR 无损表格（最近 ${bars.length} 个交易日${bars.length < RECENT_BARS ? '，不足 ' + String(RECENT_BARS) + ' 如实' : ''}）`,
        dimension: 5,
        kind: 'BAR_TABLE',
        table: barsToTable(bars, factors.length > 0 ? { adjustFactors: factors } : undefined),
        factIds: bars.map((f) => f.factId),
      });
    }
    materials.push({
      materialId: 'mat:5:field-note',
      title: '资金与价格行为：字段与口径说明',
      dimension: 5,
      kind: 'NOTE',
      text: [
        '行情表为无损表格（R2）：列为来源原生字段（不丢列、不改写、不舍入）；单元格 null ⇔ 该行事实缺该字段。',
        '字段口径：close/open/high/low 价格（元，未复权 adjustflag 原样）；volume 成交量（股）；amount 成交额（元）；turn 换手率（%）；pctChg 涨跌幅（%）；isST 当日 ST 标记；tradestatus 停复牌状态。',
        factors.length > 0
          ? `复权因子列 ${'adjustFactor'}：dividOperateDate<=当行日期的最近一次 ADJUST_FACTOR.adjustFactor（无则 null）；价格列本身未复权，复权计算由模型按需进行。`
          : '无 as-of 可见 ADJUST_FACTOR 事实，表格不设复权因子列。',
      ].join('\n'),
      factIds: [],
    });
    // W28 接线：两融余额序列（最近 60 交易日）与龙虎榜（最近 12 次上榜，剔除前视列——泄漏防护）
    const margins = facts.filter((f) => f.factKind === 'MARGIN_BALANCE').slice(-60);
    if (margins.length > 0) {
      materials.push({
        materialId: 'mat:5:margin-balance',
        title: `资金与价格行为：融资融券余额（最近 ${String(margins.length)} 个交易日，交易所官方口径 em@p1，availableAt=当日 15:00+08 近似口径——实际盘后公布时刻未实测，注记随行）`,
        dimension: 5,
        kind: 'RECORDS',
        records: margins.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
        factIds: margins.map((f) => f.factId),
      });
    }
    const dragons = facts.filter((f) => f.factKind === 'DRAGON_TIGER').slice(-12);
    if (dragons.length > 0) {
      // 泄漏防护（W28 登记）：来源行含"上榜后 1/2/5/10 日"前视列——构造材料时显式剔除，只保留当日及以前信息
      const FORWARD_COLS = ['上榜后1日', '上榜后2日', '上榜后5日', '上榜后10日'];
      materials.push({
        materialId: 'mat:5:dragon-tiger',
        title: `资金与价格行为：龙虎榜上榜明细（最近 ${String(dragons.length)} 次，东财 em@p1；前视列（上榜后N日）已剔除——as-of 纪律）`,
        dimension: 5,
        kind: 'RECORDS',
        records: dragons.map((f) => {
          const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
          for (const col of FORWARD_COLS) delete row[col];
          delete row['序号']; // 口径统一（验收低危②）：与大宗材料一致剔除来源序号列
          if (Array.isArray(row.forwardLookingColumns)) delete row.forwardLookingColumns;
          return row;
        }),
        factIds: dragons.map((f) => f.factId),
      });
    }
    // W37 接线：大宗交易（最近 12 笔，折溢率为核心信号列；同日同价同量重复行为来源真实重复，去重声明）
    const blocks = facts.filter((f) => f.factKind === 'BLOCK_TRADE').slice(-12);
    if (blocks.length > 0) {
      materials.push({
        materialId: 'mat:5:block-trade',
        title: `资金与价格行为：大宗交易明细（最近 ${String(blocks.length)} 笔，东财 emblock@p1；折溢率=成交价/收盘价-1 由来源给出；availableAt=交易日次日 00:00 保守口径，注记随行）`,
        dimension: 5,
        kind: 'RECORDS',
        records: blocks.map((f) => {
          const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
          delete row['序号'];
          return row;
        }),
        factIds: blocks.map((f) => f.factId),
      });
    }

    // W39 接线：基金持仓家数（近 8 报告期；机构关注度信号；availableAt=季末+92 天保守上界，披露在途季度会以 supersedes 链更新）
    const fundHolds = facts.filter((f) => f.factKind === 'FUND_HOLD').slice(-8);
    if (fundHolds.length > 0) {
      materials.push({
        materialId: 'mat:5:fund-hold',
        title: `资金与价格行为：基金持仓家数（近 ${String(fundHolds.length)} 报告期，东财 eminstitution@p1；机构关注度信号，非持股比例）`,
        dimension: 5,
        kind: 'RECORDS',
        records: fundHolds.map((f) => {
          const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
          delete row['序号'];
          return row;
        }),
        factIds: fundHolds.map((f) => f.factId),
      });
    }

    // W41b 接线：机构调研记录（近 12 条；月频机构关注度信号；"源无记录≠零关注度"——纪要库覆盖特性声明）
    const surveys = facts.filter((f) => f.factKind === 'SURVEY_RECORD').slice(-12);
    if (surveys.length > 0) {
      materials.push({
        materialId: 'mat:5:survey-record',
        title: `资金与价格行为：机构调研记录（最近 ${String(surveys.length)} 条，东财 emsurvey@p1；availableAt=披露日次日 D+1 保守；同接待日多机构各自成条——按接待日去重计数归模型；该源纪要库对部分股票无覆盖，无记录不等于零关注度）`,
        dimension: 5,
        kind: 'RECORDS',
        records: surveys.map((f) => {
          const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
          delete row['序号'];
          return row;
        }),
        factIds: surveys.map((f) => f.factId),
      });
    }

    // W40 接线：技术指标（程序复算的确定性特征；未复权 close 口径与 D5 表格一致——RSI 为 Wilder 口径、MACD 柱=2×(DIF−DEA)，公式冻结于 indicators.ts）
    if (bars.length >= 5) {
      try {
        const sortedBars = [...bars].sort((a, b) => (String(tv(a).date ?? '') < String(tv(b).date ?? '') ? -1 : 1));
        const closes = sortedBars.map((f) => ({ date: String(tv(f).date ?? ''), close: String(tv(f).close ?? '') })).filter((x) => x.close !== '');
        const ind = computeIndicators(closes, cutoff.toISOString().slice(0, 10));
        materials.push({
          materialId: 'mat:5:technical-indicators',
          title: `资金与价格行为：技术指标（程序复算，未复权 close 口径与行情表一致；MA5/20/60、RSI14（Wilder）、MACD(12,26,9) 柱=2×(DIF−DEA)；数据不足项为 null）`,
          dimension: 5,
          kind: 'NOTE',
          text: JSON.stringify(ind, null, 1),
          factIds: [],
        });
      } catch { /* 指标计算失败不阻断 */ }
    }

    builds.push({
      materials,
      gaps: gapsOf(5, [
        ...(margins.length === 0 ? ['融资融券余额未入库（该股非两融标的或截点窗口外）'] : []),
        ...(dragons.length === 0 ? ['龙虎榜未上榜（窗口内无上榜记录，非数据缺口）'] : []),
        ...(blocks.length === 0 ? ['大宗交易：as-of 窗口内无成交记录（非数据缺口，小盘低频正常）'] : []),
        ...(fundHolds.length === 0 ? ['基金持仓：as-of 无可见记录（该股无基金持仓披露或截点早于首期）'] : []),
        ...(bars.length === 0 ? ['无 as-of 可见行情事实'] : []),
      ]),
    });
  }

  // ---- D6 行业景气（归属 + 基准指数表）----
  {
    const materials: Material[] = [];
    const gaps: string[] = [];
    if (sw === null) {
      gaps.push('截点当时申万归属不可得（申万轴无区间含截点的有效行）');
    } else {
      const v = tv(sw.fact);
      materials.push({
        materialId: 'mat:6:industry-attribution',
        title: '行业景气：截点当时申万归属（INDUSTRY_CLASS_VERSION，区间有效版本）',
        dimension: 6,
        kind: 'RECORDS',
        records: [{
          factId: sw.fact.factId,
          artifactSha256: sw.fact.artifactSha256,
          体系: v.体系,
          l1IndexCode: v.l1IndexCode ?? null,
          行业代码: v.行业代码 ?? null,
          计入日期ISO: v.计入日期ISO ?? null,
          更新日期ISO: v.更新日期ISO ?? null,
          validFrom: sw.fact.validFrom,
          validTo: sw.fact.validTo,
        }],
        factIds: [sw.fact.factId],
      });
      if (sw.l1IndexCode === null) {
        gaps.push('有效归属无 l1IndexCode，行业基准不可封存');
      } else if (poolSubject.swL1IndexCode !== undefined && poolSubject.swL1IndexCode !== sw.l1IndexCode) {
        gaps.push(`时点归属 l1IndexCode=${sw.l1IndexCode} 与冻结池当前快照 ${poolSubject.swL1IndexCode} 不一致——以时点归属为准，池值仅参考`);
      }
      const bench = recentBarFacts(benchmarkFacts, RECENT_BARS);
      if (bench.length === 0) {
        if (sw.l1IndexCode !== null) gaps.push(`行业基准 ${sw.l1IndexCode} 无 as-of 可见行情事实`);
      } else {
        materials.push({
          materialId: 'mat:6:benchmark-index-table',
          title: `行业景气：申万一级行业指数 ${sw.l1IndexCode ?? ''}${poolSubject.swL1Name ? '（' + poolSubject.swL1Name + '）' : ''} 无损表格（最近 ${bench.length} 个交易日）`,
          dimension: 6,
          kind: 'BAR_TABLE',
          table: barsToTable(bench),
          factIds: bench.map((f) => f.factId),
        });
      }
    }
    // W34 接线：行业轮动监测表（as-of 装载 SW_INDEX_BAR 计算面——非本股封存内事实，时点纪律同 as-of 过滤；体系随截点）
    if (rotationTable !== null && rotationTable !== undefined && rotationTable.rows.length > 0) {
      materials.push({
        materialId: 'mat:6:industry-rotation-table',
        title: `行业景气：申万一级行业轮动表（${String(rotationTable.rows.length)} 行业，20/60/120 收盘日收益 + 20 日波动（总体口径）+ 20 日收益排名；体系 ${rotationTable.system}，as-of ${rotationTable.asOf}；缺失行业：${rotationTable.missingIndustries.length > 0 ? rotationTable.missingIndustries.join(',') : '无'}）`,
        dimension: 6,
        kind: 'RECORDS',
        records: rotationTable.rows.map((r) => ({ rank: r.rank, 行业代码: r.industryIndexCode, 行业名称: r.name, r20: r.return20, r60: r.return60, r120: r.return120, vol20: r.volatility20, barsUsed: r.barsUsed })),
        factIds: [],
      });
    }
    builds.push({ materials, gaps: gapsOf(6, gaps) });
  }

  // ---- D7 风险项（W29 接线：质押快照与股东户数已入库，as-of 可见即送达）----
  {
    const basics = facts.filter((f) => f.factKind === 'STOCK_BASIC');
    const pledges = facts.filter((f) => f.factKind === 'PLEDGE_RATIO').slice(-8); // 最近 8 个周度快照
    const holders = facts.filter((f) => f.factKind === 'HOLDER_COUNT').slice(-8); // 最近 8 期
    const materials: Material[] = [];
    if (basics.length > 0) {
      materials.push({
        materialId: 'mat:7:stock-basic',
        title: '风险项：STOCK_BASIC（as-of 可见）',
        dimension: 7,
        kind: 'RECORDS',
        records: basics.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
        factIds: basics.map((f) => f.factId),
      });
    }
    if (pledges.length > 0) {
      materials.push({
        materialId: 'mat:7:pledge-ratio',
        title: `风险项：股权质押比例周度快照（最近 ${String(pledges.length)} 期，东财 emrisk@p1，快照口径 R4 声明随行）`,
        dimension: 7,
        kind: 'RECORDS',
        records: pledges.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
        factIds: pledges.map((f) => f.factId),
      });
    }
    if (holders.length > 0) {
      materials.push({
        materialId: 'mat:7:holder-count',
        title: `风险项：股东户数（最近 ${String(holders.length)} 期，公告披露口径 emrisk@p1）`,
        dimension: 7,
        kind: 'RECORDS',
        records: holders.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
        factIds: holders.map((f) => f.factId),
      });
    }
    // W30 接线：商誉原始材料 + 计算说明（与维度2 估值同款诚实模式——程序不预计算比率，分母口径属研究语义）
    const goodwillRows = facts
      .filter((f) => f.factKind === 'BALANCE' && tv(f).GOODWILL !== null && tv(f).GOODWILL !== undefined && tv(f).GOODWILL !== '')
      .slice(-8);
    if (goodwillRows.length > 0) {
      materials.push({
        materialId: 'mat:7:goodwill',
        title: `风险项：商誉与净资产原始材料（最近 ${String(goodwillRows.length)} 期 BALANCE，GOODWILL/TOTAL_PARENT_EQUITY/TOTAL_EQUITY 元，计算说明：占净资产比例 = GOODWILL / 归母股东权益，由模型按需计算并声明口径）`,
        dimension: 7,
        kind: 'RECORDS',
        records: goodwillRows.map((f) => {
          const row = tv(f) as Record<string, unknown>;
          return {
            factId: f.factId,
            artifactSha256: f.artifactSha256,
            REPORT_DATE: row.REPORT_DATE ?? row.REPORT_DATE_ISO ?? null,
            GOODWILL: row.GOODWILL ?? null,
            TOTAL_PARENT_EQUITY: row.TOTAL_PARENT_EQUITY ?? null,
            TOTAL_EQUITY: row.TOTAL_EQUITY ?? null,
          };
        }),
        factIds: goodwillRows.map((f) => f.factId),
      });
    }
    materials.push({
      materialId: 'mat:7:risk-gap-note',
      title: '风险项：可得项与缺口清单',
      dimension: 7,
      kind: 'NOTE',
      text: '风险项以已入库可得材料为准；下列字段无数据源，按缺口声明（R11），不虚构：审计意见、监管问询。质押比例、股东户数、商誉原始材料已入库（as-of 可见即送达，库内无记录亦按缺口声明）。商誉占净资产比例为原始材料+计算说明模式（程序不预计算）。ST 状态以行情表 isST 列逐日呈现（时点口径）。',
      factIds: [],
    });
    // W33 接线：监管问询事件（assembleResearchInput 预查询传入；evidence factIds 绑定封存内公告事实）
    const inquiryRows = inquiryEvents ?? [];
    const sealedFactIds = new Set(facts.map((f) => f.factId));
    const inquiryRecords = inquiryRows.filter((r) => sealedFactIds.has(r.evidenceFactId));
    if (inquiryRecords.length > 0) {
      materials.push({
        materialId: 'mat:7:regulatory-inquiry',
        title: `风险项：监管问询函事件（as-of 可见最近 ${String(inquiryRecords.length)} 条，RECEIVED=收函/REPLY=回复；letterKind/issuer 按标题判定，UNDETERMINED 为不猜；元数据级判定——函件编号与问询事项需 PDF 原文）`,
        dimension: 7,
        kind: 'RECORDS',
        records: inquiryRecords.map((r) => ({ factId: r.evidenceFactId, 事件时点: r.eventTime, 子类: r.subtype, 函件类别: r.letterKind, 发函机构: r.issuer })),
        factIds: inquiryRecords.map((r) => r.evidenceFactId),
      });
    }

    // W32 接线：审计意见（最近 4 期年报，PDF 原文确定性判类；UNDETERMINED 如实带候选摘录）
    const audits = facts.filter((f) => f.factKind === 'AUDIT_OPINION').slice(-4);
    if (audits.length > 0) {
      materials.push({
        materialId: 'mat:7:audit-opinion',
        title: `风险项：审计意见（最近 ${String(audits.length)} 期年报，年报 PDF 确定性判类 audit@p1；UNDETERMINED 为多命中/零命中不猜，候选摘录随行）`,
        dimension: 7,
        kind: 'RECORDS',
        records: audits.map((f) => {
          const row = { factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) } as Record<string, unknown>;
          delete row['候选'];
          return row;
        }),
        factIds: audits.map((f) => f.factId),
      });
    }

    builds.push({
      materials,
      gaps: gapsOf(7, [
        ...(basics.length === 0 ? ['STOCK_BASIC 截点不可见（当前快照 availableAt 晚于截点，时点纪律不回填）'] : []),
        ...(pledges.length === 0 ? ['股权质押比例未入库（该股无快照记录或截点早于首个快照）'] : []),
        ...(holders.length === 0 ? ['股东户数未入库（该股无披露记录）'] : []),
        ...(goodwillRows.length === 0 ? ['商誉原始材料未入库（该股无含商誉字段的 as-of 可见报告期，或商誉为空——空商誉非缺口，此处指无 BALANCE 行）'] : []),
        ...(inquiryRecords.length === 0 ? ['监管问询：as-of 窗口内无问询事件（或 events 表未建）'] : []),
        ...(audits.length === 0 ? ['审计意见：as-of 无可见年报判类（截点早于首份或该股无年报 PDF）'] : []),
      ]),
    });
  }

  // ---- D8 历史参照（P4 已建库，W 面接线：群组统计块 + 判断义务框架声明）----
  {
    const groups = referenceGroups ?? [];
    const industryCode = sw === null ? null : sw.l1IndexCode;
    const materials8: Material[] = [];
    if (groups.length > 0) {
      materials8.push({
        materialId: 'mat:8:reference-group-stats',
        title: `历史事件参照：群组统计块（${String(groups.length)} 块 = 全事件基础层 + 六类事件类型层${industryCode === null ? '' : ` + 本股所属行业（${industryCode}）层`}；样本期 2015–2026 池内事件，R4 修订口径随行；统计为描述性关联，非预测）`,
        dimension: 8,
        kind: 'RECORDS',
        records: groups.map((g) => ({ groupKey: g.groupKey, sampleCount: g.sampleCount, baseRatio: g.baseRatio, stats: g.stats, 嵌套声明: g.nestedDeclaration })),
        factIds: [],
      });
    }
    materials8.push({
      materialId: 'mat:8:judgment-duty-note',
      title: '历史事件参照：判断义务框架（RM §6 / 方法正文已冻结）',
      dimension: 8,
      kind: 'NOTE',
      text: [
        '判断义务：引用任何群组统计必须写明——对决定性连接的作用、权重等级、对结论强度的影响；回应了历史证据不等于结论必须改变。',
        '嵌套纪律：群组相互嵌套、不是独立证据（每块自带嵌套声明原文）。',
        '口径纪律：前缀 only（本材料统计截至资料截点可用的事件窗口）、描述与预测分开、口径换算须有真实数据。',
        '失效阈值提示：invalidation 阈值已冻结 12%（R29）；统计中历史 invalidation 比例按 10% 落库保留为审计面，不重算。',
      ].join('\n'),
      factIds: [],
    });
    builds.push({
      materials: materials8,
      gaps: gapsOf(8, [
        ...(groups.length === 0 ? ['历史参照群组块不可得（参照库未建或行业层无匹配）'] : []),
        ...(industryCode === null ? ['本股 as-of 申万行业归属不可得，行业层参照缺失'] : []),
      ]),
    });
  }

  return builds;
}

// ===== 材料构造（宽基 ETF 七维）=====

function buildEtfDimensions(
  etfFacts: TimePointFact[],
  indexFacts: TimePointFact[],
  poolSubject: PoolSubjectEntry,
  trackingIndex: string | null,
): DimensionBuild[] {
  const gapsOf = (dim: number, list: string[]): string[] => list.map((g) => `E${dim}: ${g}`);
  const etfBars = recentBarFacts(etfFacts, RECENT_BARS);
  const indexBars = recentBarFacts(indexFacts, RECENT_BARS);
  const latestEtfBar = etfBars[etfBars.length - 1] ?? null;
  const latestIndexBar = indexBars[indexBars.length - 1] ?? null;

  // E5 价格行为与市场宽度（两份行情表）
  const e5Materials: Material[] = [];
  if (etfBars.length > 0) {
    e5Materials.push({
      materialId: 'mat:5:etf-bar-table',
      title: `价格行为与市场宽度：ETF DAILY_BAR 无损表格（最近 ${etfBars.length} 个交易日）`,
      dimension: 5,
      kind: 'BAR_TABLE',
      table: barsToTable(etfBars),
      factIds: etfBars.map((f) => f.factId),
    });
  }
  if (indexBars.length > 0 && trackingIndex !== null) {
    e5Materials.push({
      materialId: 'mat:5:tracking-index-bar-table',
      title: `价格行为与市场宽度：跟踪指数 ${trackingIndex}（${poolSubject.tracks ?? ''}）行情无损表格（最近 ${indexBars.length} 个交易日）`,
      dimension: 5,
      kind: 'BAR_TABLE',
      table: barsToTable(indexBars),
      factIds: indexBars.map((f) => f.factId),
    });
  }
  const e5: DimensionBuild = {
    materials: e5Materials,
    gaps: gapsOf(5, [
      '市场宽度数据未入库',
      ...(etfBars.length === 0 ? ['ETF 无 as-of 可见行情事实'] : []),
      ...(trackingIndex === null ? ['冻结池 tracks 字段无法解析跟踪指数代码'] : []),
      ...(trackingIndex !== null && indexBars.length === 0 ? [`跟踪指数 ${trackingIndex} 无 as-of 可见行情事实`] : []),
    ]),
  };

  // E4 资金（W30 接线：ETF 份额序列 emfund@p1，季报口径 availableAt=季末+92 天保守上界）
  const etfShares = etfFacts.filter((f) => f.factKind === 'ETF_SHARE').slice(-16); // 最近 16 期
  const e4Materials: Material[] = [];
  if (etfShares.length > 0) {
    e4Materials.push({
      materialId: 'mat:4:etf-share',
      title: `资金：ETF 份额序列（最近 ${String(etfShares.length)} 期，季报口径，emfund@p1；份额增减为资金侧原始材料，availableAt 为法定披露期限统一保守上界）`,
      dimension: 4,
      kind: 'RECORDS',
      records: etfShares.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
      factIds: etfShares.map((f) => f.factId),
    });
  }
  if (latestEtfBar !== undefined && latestEtfBar !== null) {
    e4Materials.push({
      materialId: 'mat:4:flows-note',
      title: '资金：ETF 行情资金侧字段说明',
      dimension: 4,
      kind: 'NOTE',
      text: '资金侧原始材料另含维度 5 ETF 行情表：amount 成交额（元）、turn 换手率（%）、volume 成交量（股），字段口径与个股一致（BaoStock 原生）。资金流向专用数据（申赎、净流入）未入库。',
      factIds: [latestEtfBar.factId],
    });
  }
  const e4: DimensionBuild = {
    materials: e4Materials,
    gaps: gapsOf(4, [
      '资金流向专用数据未入库（以 ETF 行情 amount/turn 与份额序列为原始材料）',
      ...(etfShares.length === 0 ? ['ETF 份额序列 as-of 不可见（截点早于首个保守上界或该 ETF 无记录）'] : []),
    ]),
  };

  // E1 估值分位（W31 接线：跟踪指数 PE/PB 序列已入库——legulegu 月末全史 + csindex 日频近 20 日，月末口径为主，R4 声明随行；分位由模型按需计算）
  const valuations = indexFacts.filter((f) => f.factKind === 'INDEX_VALUATION').slice(-120); // 最近 120 期（月末为主）
  const e1Materials: Material[] = [];
  if (valuations.length > 0) {
    e1Materials.push({
      materialId: 'mat:1:index-valuation-series',
      title: `估值分位：跟踪指数 PE/PB 序列（最近 ${String(valuations.length)} 期，月末频率为主（legulegu 全史）+ 日频近 20 日（中证官方）并存——不得混频，typedValue 带来源/频率标记，valuation@p1，R4 声明随行）`,
      dimension: 1,
      kind: 'RECORDS',
      records: valuations.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256, ...tv(f) })),
      factIds: valuations.map((f) => f.factId),
    });
  }
  e1Materials.push({
    materialId: 'mat:1:valuation-percentile-note',
    title: '估值分位：计算说明（程序不预计算分位）',
    dimension: 1,
    kind: 'NOTE',
    text: [
      '估值分位以送达的 PE/PB 序列为原始材料由模型按需计算：月末序列为分位基准（全史），日频近 20 日为当前值参考——两种频率不得混算。',
      '指数点位分位可另以维度 5 行情表全序列计算。',
      '当前进行中月份的最新行是快照值，月末终值将作为新事实并存（分叉暴露，消费方须知）。',
    ].join('\n'),
    factIds: latestIndexBar === undefined || latestIndexBar === null ? [] : [latestIndexBar.factId],
  });
  const e1: DimensionBuild = {
    materials: e1Materials,
    gaps: gapsOf(1, [
      ...(valuations.length === 0 ? ['跟踪指数估值（PE/PB）as-of 不可见（截点早于首个月末次日）——估值分位不可计算'] : []),
    ]),
  };

  // E6 风格相对
  const e6: DimensionBuild = {
    materials: [{
      materialId: 'mat:6:style-relative-note',
      title: '风格相对：计算说明（不输出相对强弱值）',
      dimension: 6,
      kind: 'NOTE',
      text: '风格相对（相对其他宽基指数的强弱）需要可比指数序列进入本轮封存；本轮只封存本标的跟踪指数，可比序列未纳入。不输出相对强弱值；待调度合同扩展封存范围后启用。',
      factIds: [],
    }],
    gaps: gapsOf(6, ['可比指数序列未纳入本轮封存，风格相对强弱不计算']),
  };

  // E2 / E3 / E7 占位
  const e2: DimensionBuild = {
    materials: [{
      materialId: 'mat:2:constituent-earnings-placeholder',
      title: '成分盈利趋势：占位说明',
      dimension: 2,
      kind: 'NOTE',
      text: '成分股盈利数据（指数成分盈利趋势）未入库，本维度无材料。',
      factIds: [],
    }],
    gaps: gapsOf(2, ['成分股盈利数据未入库']),
  };
  const e3: DimensionBuild = {
    materials: [{
      materialId: 'mat:3:macro-policy-placeholder',
      title: '宏观与政策：占位说明',
      dimension: 3,
      kind: 'NOTE',
      text: '宏观与政策数据源未接入（FREEZE-P0 §四已知缺口），本维度无材料。',
      factIds: [],
    }],
    gaps: gapsOf(3, ['宏观与政策数据源未接入']),
  };
  const e7: DimensionBuild = {
    materials: [{
      materialId: 'mat:7:historical-state-placeholder',
      title: '历史状态参照：P4 前占位',
      dimension: 7,
      kind: 'NOTE',
      text: '历史状态参照库按总规划于 P4 构建；本轮输入不含任何历史参照材料。',
      factIds: [],
    }],
    gaps: gapsOf(7, ['历史状态参照库未建（P4），本维度占位']),
  };

  // 按 ETF_DIMENSION_RULES 维度号输出（1..7）
  return [e1, e2, e3, e4, e5, e6, e7];
}

// ===== L0 材料 =====

function stockDecisionContractText(poolSubject: PoolSubjectEntry): string {
  return [
    '决策合同（个股，RESEARCH-METHOD §3）：',
    '- RESEARCH_OUTPERFORM：预期未来 20 个交易日相对资料截点当时版本申万一级行业指数取得正超额收益；',
    '- RESEARCH_UNDERPERFORM：预期负超额收益；含义为回避或减持，不是做空（A 股融券受限）；',
    '- ABSTAIN：不表达方向判断；仍产生结论对象并进入复盘分母的放弃分类。',
    '参考价：研究完成后的下一交易日开盘价（T+1 下最现实的可成交价）；结算周期 20 个交易日（诊断周期 5/60 日只记录不参与决策）。',
    `行业基准：截点当时申万分类版本归属（随维度 6 材料送达）；冻结池当前快照 ${poolSubject.swL1IndexCode ?? '缺'}（仅参考，以时点归属为准）。`,
    '选项空间互不通用：个股结论不得出现 UP/DOWN；宽基结论不得出现 OUTPERFORM/UNDERPERFORM（程序校验）。',
  ].join('\n');
}

function etfDecisionContractText(poolSubject: PoolSubjectEntry): string {
  return [
    '决策合同（宽基 ETF，RESEARCH-METHOD §3〔R18〕）：',
    '- RESEARCH_UP：预期跟踪指数未来 20 个交易日绝对收益为正；',
    '- RESEARCH_DOWN：预期绝对收益为负；含义为回避或减持，不是做空；',
    '- ABSTAIN：同个股。',
    `跟踪指数：${poolSubject.tracks ?? '（池文件未解析）'}；宽基无行业基准，方向比较的"同一行业基准"改为"同一跟踪指数"。`,
    '参考价与结算周期同个股口径；选项空间互不通用（不得出现 OUTPERFORM/UNDERPERFORM）。',
  ].join('\n');
}

function buildL0FixedMaterials(
  businessKey: ResearchBusinessKey,
  cutoff: string,
  pool: { file: string; frozenAt: string; subject: PoolSubjectEntry },
  versions: AssembleVersions,
  rules: readonly DimensionRule[],
): Material[] {
  const subjectName = pool.subject.name;
  const identity: Material = {
    materialId: 'mat:0:identity',
    title: '研究身份（L0，不可裁剪）',
    dimension: 0,
    kind: 'NOTE',
    text: [
      `标的类别 ${businessKey.subjectKind}；标的 ${businessKey.subject}（${subjectName}）；研究类型 ${businessKey.researchKind}；资料截点 ${cutoff}。`,
      `冻结池：${pool.file}（frozenAt ${pool.frozenAt}）。`,
      `版本轴：方法 ${versions.methodVersion} / 数据与适配器 ${versions.adapterVersion} / 执行计划与授权 ${versions.planAuthVersion}；包版本 v${String(PACKAGE_VERSION)}；组装规则 ${ASSEMBLER_RULES_VERSION}。`,
    ].join('\n'),
    factIds: [],
  };
  const contract: Material = {
    materialId: 'mat:0:decision-contract',
    title: '决策合同与规则声明（L0，不可裁剪）',
    dimension: 0,
    kind: 'NOTE',
    text: businessKey.subjectKind === 'STOCK' ? stockDecisionContractText(pool.subject) : etfDecisionContractText(pool.subject),
    factIds: [],
  };
  const statements: Material = {
    materialId: 'mat:0:numeric-and-table-statements',
    title: '财务数字声明与行情表口径声明（L0，不可裁剪）',
    dimension: 0,
    kind: 'NOTE',
    text: [
      '财务数字声明（RM §4）：所有财务数字必须引用确切的报表期间和科目，由程序复算核对；正文里只核对统计形态的数字（比例、百分比、样本数），其余数字照常书写。',
      '行情表口径（R2）：行情类数据只用表格化无损格式——列为来源原生字段，不丢列、不改写、不舍入、不做叙事化改写；单元格 null ⇔ 该行事实缺该字段。',
      '证据纪律（RM §2）：只使用本轮封存池内材料与分层实际送达内容；引用未送达材料即为结构违规；L2 索引目录为引用命中检查的目录。',
    ].join('\n'),
    factIds: [],
  };
  const rulesNote: Material = {
    materialId: 'mat:0:dimension-rules',
    title: '八维度/七维材料映射规则表（本轮适用，随包冻结）',
    dimension: 0,
    kind: 'NOTE',
    text: rules
      .map((r) => `维度${r.dimension} ${r.code}（${r.name}，L1 装填优先级 ${r.priority}）：${r.clause}`)
      .join('\n'),
    factIds: [],
  };
  return [identity, contract, statements, rulesNote];
}

function buildCoverageReceiptMaterial(
  dimensions: DimensionCoverage[],
  usage: {
    l0FixedBytes: number;
    l0Budget: number;
    l1Bytes: number;
    l1Budget: number;
    l1Blocks: number;
    l2Bytes: number;
    l2Budget: number;
  },
): Material {
  const lines = ['分层回执（RM §5：送达了什么、裁了什么、各层字节 vs 预算；权威数字见 layers 层回执）：'];
  lines.push(`- L0：固定材料 ${String(usage.l0FixedBytes)} 字节 + 本回执块（自身字节亦计入 L0），预算 ${String(usage.l0Budget)}；不可裁剪。`);
  lines.push(`- L1：${String(usage.l1Bytes)} / ${String(usage.l1Budget)} 字节，${String(usage.l1Blocks)} 块；超层预算材料已降级并在 coverage 标记。`);
  lines.push(`- L2：${String(usage.l2Bytes)} / ${String(usage.l2Budget)} 字节（索引目录）；不可裁剪。`);
  for (const d of dimensions) {
    lines.push(
      `- 维度${d.dimension} ${d.code}：送达 ${String(d.delivered.length)} 件；降级 ${String(d.demoted.length)} 件；缺口 ${String(d.gap.length)} 条。`,
    );
  }
  const totalGaps = dimensions.reduce((n, d) => n + d.gap.length, 0);
  lines.push(`合计缺口声明 ${String(totalGaps)} 条（逐条见 coverage；禁止静默截断）。`);
  return {
    materialId: 'mat:0:coverage-receipt',
    title: 'coverage 回执（L0，不可裁剪）',
    dimension: 0,
    kind: 'NOTE',
    text: lines.join('\n'),
    factIds: [],
  };
}

// ===== 组装主流程 =====


/** 预查询 as-of 可见的监管问询事件（events 表缺失时返回空，缺口如实）。 */
async function loadInquiryEvents(pool: Pool, subject: string, cutoff: string): Promise<InquiryEventRow[]> {
  try {
    const q = await pool.query(
      `select subtype, attrs->>'letterKind' as "letterKind", attrs->>'issuer' as issuer, event_time, evidence_fact_id
         from events
        where subject = $1 and type = 'REGULATORY_INQUIRY' and event_time <= $2
        order by event_time desc limit 12`,
      [subject, cutoff],
    );
    return q.rows.map((r: { subtype: string; letterKind: string | null; issuer: string | null; event_time: Date; evidence_fact_id: string }) => ({
      subtype: r.subtype, letterKind: r.letterKind ?? 'UNDETERMINED', issuer: r.issuer ?? 'UNDETERMINED',
      eventTime: new Date(r.event_time).toISOString(), evidenceFactId: r.evidence_fact_id,
    }));
  } catch {
    return [];
  }
}


/** 参照库群组块行（assembleResearchInput 预查询传入，保持维度构建纯函数）。 */
interface ReferenceGroupRow { groupKey: string; sampleCount: number; baseRatio: unknown; stats: unknown; nestedDeclaration: string }
async function loadReferenceGroups(pool: Pool, industryIndexCode: string | null): Promise<ReferenceGroupRow[]> {
  try {
    const likeIndustry = industryIndexCode === null ? '' : `or group_key like '%|${industryIndexCode.replace(/'/g, "''")}'`;
    const q = await pool.query(
      `select group_key as "groupKey", sample_count as "sampleCount", base_ratio as "baseRatio", stats, nested_declaration as "nestedDeclaration"
         from reference_group_library
        where group_key = 'all-events' or group_key like 'type:%' ${likeIndustry}
        order by group_key`,
    );
    return q.rows.map((r: Record<string, unknown>) => ({ groupKey: String(r.groupKey), sampleCount: Number(r.sampleCount), baseRatio: r.baseRatio, stats: r.stats, nestedDeclaration: String(r.nestedDeclaration) }));
  } catch {
    return [];
  }
}


/** 预计算行业轮动表（全行业 SW_INDEX_BAR as-of 装载 → W34 纯函数；SW_INDEX_LIST 名称快照注入）。 */
async function loadRotationTable(pool: Pool, cutoff: string): Promise<IndustryMomentumTable | null> {
  try {
    const asOf = cutoff.slice(0, 10);
    const bars = await pool.query(
      `select subject_id, typed_value from pintime_fact
        where fact_kind = 'SW_INDEX_BAR' and available_at <= $1::timestamptz and (typed_value->>'日期') is not null
        order by subject_id, typed_value->>'日期'`,
      [cutoff],
    );
    const byIndustry = new Map<string, Array<{ date: string; close: string }>>();
    for (const row of bars.rows as Array<{ subject_id: string; typed_value: Record<string, unknown> }>) {
      const date = String(row.typed_value['日期'] ?? '');
      const close = row.typed_value['收盘'];
      if (date === '' || close === null || close === undefined) continue;
      const list = byIndustry.get(row.subject_id) ?? [];
      list.push({ date, close: String(close) });
      byIndustry.set(row.subject_id, list);
    }
    let names: Map<string, string> | undefined;
    try {
      const listRows = await pool.query(`select typed_value from pintime_fact where fact_kind = 'SW_INDEX_LIST' limit 1`);
      const industries = (listRows.rows[0]?.typed_value as { rows?: Array<Record<string, unknown>> } | undefined)?.rows;
      if (Array.isArray(industries)) {
        names = new Map(
          industries
            .map((r) => [String(r['行业代码'] ?? '').replace(/\.SI$/, ''), String(r['行业名称'] ?? '')] as const)
            .filter(([code]) => code !== ''),
        );
      }
    } catch { /* 名称缺省 null */ }
    return names === undefined ? industryMomentumTable(byIndustry, asOf) : industryMomentumTable(byIndustry, asOf, { names });
  } catch {
    return null;
  }
}


/** 预计算行业估值截面（W36 纯函数 + DB 装载；任何失败返回 null，D2 回退纯说明模式）。 */
async function loadIndustryValuation(pool: Pool, subject: string, cutoff: string): Promise<{ table: ReturnType<typeof industryMedianPE>; stockPE: string | null; stockIndustryPercentile: string | null } | null> {
  try {
    const asOf = cutoff.slice(0, 10);
    const load = await loadStockPESamples(pool, asOf);
    if (load.samples.length === 0) return null;
    const table = industryMedianPE(load.samples, asOf);
    const own = load.samples.find((x) => x.code === subject) ?? null;
    const stockPEDec = own === null ? null : stockPEOf(own, asOf);
    const stockPE = stockPEDec === null ? null : String(stockPEDec);
    let stockIndustryPercentile: string | null = null;
    if (own !== null && stockPE !== null) {
      const ownRow = own === null ? undefined : table.rows.find((r) => r.industryIndexCode === own.industryIndexCode);
      if (ownRow !== undefined && ownRow.peSeries.length >= 2 && stockPEDec !== null) {
        stockIndustryPercentile = String(pePercentileOf(stockPEDec, ownRow.peSeries.map((x) => decFromString(x))));
      }
    }
    return { table, stockPE, stockIndustryPercentile };
  } catch {
    return null;
  }
}

export async function assembleResearchInput(
  pool: Pool,
  store: ArtifactStore,
  opts: AssembleResearchInputOptions,
): Promise<AssembledResearchInput> {
  validateBudget(opts.budget);
  const cutoffDate = parseDateStrict(opts.cutoff, 'cutoff');
  const cutoff = cutoffDate.toISOString();
  const researchKind: ResearchKind = opts.researchKind ?? 'WEEKLY';
  if (opts.subject.length === 0) throw new ResearchInputError('INVALID_INPUT', 'subject 为空');
  for (const [key, value] of Object.entries(opts.versions)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ResearchInputError('INVALID_INPUT', `versions.${key} 为空`);
    }
  }

  const poolInfoFile = opts.poolInfoFile ?? DEFAULT_POOL_INFO_FILE;
  const poolInfo = await loadPoolInfo(poolInfoFile);
  const poolSubject = findPoolSubject(poolInfo, opts.subjectKind, opts.subject);
  if (poolSubject === null) {
    throw new ResearchInputError('SUBJECT_NOT_IN_POOL', `${opts.subjectKind} ${opts.subject} 不在冻结池 ${poolInfoFile}`);
  }
  const poolMeta = { file: poolInfoFile, frozenAt: poolInfo.frozenAt, subject: poolSubject };

  const businessKey: ResearchBusinessKey = {
    subjectKind: opts.subjectKind,
    subject: opts.subject,
    researchKind,
    cutoff,
  };
  const rules = rulesOfKind(opts.subjectKind);
  const subjectType = subjectTypeOfKind(opts.subjectKind);
  const standingGaps =
    opts.subjectKind === 'STOCK' ? [SW2014_GAP, SW_CLASS_SOURCE_GAP] : [SW_CLASS_SOURCE_GAP_CLOSED];

  const sealInput = {
    businessKey,
    cutoff,
    gaps: standingGaps,
    methodVersion: opts.versions.methodVersion,
    adapterVersion: opts.versions.adapterVersion,
    planAuthVersion: opts.versions.planAuthVersion,
  };

  // ---- 封存：标的 seal ----
  const subjectSeal = await buildSeal(pool, store, {
    ...sealInput,
    factSelector: { subjectType, subjectId: opts.subject },
  });
  const subjectFacts = await asOfFacts(pool, { subjectType, subjectId: opts.subject, asOf: cutoffDate });

  // ---- 封存：基准 seal（个股=行业指数；ETF=跟踪指数）----
  // 包内 seals 一律剥离 reused 调用期标记（W26）：inputHash 与包原件内容只含封存内容身份。
  const seals: SealManifest[] = [sealManifestContent(subjectSeal)];
  const sealFactSets: TimePointFact[][] = [subjectFacts];
  const sealSubjects: string[] = [`${subjectType}/${opts.subject}`];
  let benchmarkFacts: TimePointFact[] = [];
  if (opts.subjectKind === 'STOCK') {
    const sw = pickSwIndustryAt(subjectFacts, cutoffDate);
    if (sw?.l1IndexCode != null) {
      const seal = await buildSeal(pool, store, {
        ...sealInput,
        factSelector: { subjectType: 'INDEX', subjectId: sw.l1IndexCode },
      });
      seals.push(sealManifestContent(seal));
      sealSubjects.push(`INDEX/${sw.l1IndexCode}`);
      benchmarkFacts = await asOfFacts(pool, { subjectType: 'INDEX', subjectId: sw.l1IndexCode, asOf: cutoffDate });
      sealFactSets.push(benchmarkFacts);
    }
  } else {
    const tracking = poolSubject.tracks === undefined ? null : trackingIndexOf(poolSubject.tracks);
    if (tracking !== null) {
      const seal = await buildSeal(pool, store, {
        ...sealInput,
        factSelector: { subjectType: 'INDEX', subjectId: tracking },
      });
      seals.push(sealManifestContent(seal));
      sealSubjects.push(`INDEX/${tracking}`);
      benchmarkFacts = await asOfFacts(pool, { subjectType: 'INDEX', subjectId: tracking, asOf: cutoffDate });
      sealFactSets.push(benchmarkFacts);
    }
  }

  // ---- 维度材料 ----
  const sw = opts.subjectKind === 'STOCK' ? pickSwIndustryAt(subjectFacts, cutoffDate) : null;
  const builds =
    opts.subjectKind === 'STOCK'
      ? buildStockDimensions(subjectFacts, benchmarkFacts, poolSubject, cutoffDate, sw, await loadInquiryEvents(pool, opts.subject, cutoff), await loadReferenceGroups(pool, sw === null ? null : sw.l1IndexCode), await loadRotationTable(pool, cutoff), await loadIndustryValuation(pool, opts.subject, cutoff))
      : buildEtfDimensions(
          subjectFacts,
          benchmarkFacts,
          poolSubject,
          poolSubject.tracks === undefined ? null : trackingIndexOf(poolSubject.tracks),
        );

  // ---- L1 装填（按维度优先级；超层预算降级并标记）----
  const dimMaterials: Material[] = [];
  const dimOfMaterial = new Map<string, number>();
  for (const build of builds) {
    for (const material of build.materials) {
      dimMaterials.push(material);
      dimOfMaterial.set(material.materialId, material.dimension);
    }
  }
  const priorityOf = (dimension: number): number => {
    const rule = rules.find((r) => r.dimension === dimension);
    if (rule === undefined) throw new ResearchInputError('INVALID_INPUT', `维度 ${dimension} 无规则`);
    return rule.priority;
  };
  const l1Order = [...dimMaterials].sort((a, b) => {
    const pa = priorityOf(a.dimension);
    const pb = priorityOf(b.dimension);
    if (pa !== pb) return pa - pb;
    if (a.dimension !== b.dimension) return a.dimension - b.dimension;
    return dimMaterials.indexOf(a) - dimMaterials.indexOf(b);
  });

  let l1Bytes = 0;
  const l1Blocks: { materialId: string; bytes: number }[] = [];
  const demotedIds = new Set<string>();
  for (const material of l1Order) {
    const bytes = materialBytes(material);
    if (l1Bytes + bytes <= opts.budget.l1Bytes) {
      l1Blocks.push({ materialId: material.materialId, bytes });
      l1Bytes += bytes;
    } else {
      demotedIds.add(material.materialId);
    }
  }

  // ---- coverage ----
  const dimensions: DimensionCoverage[] = rules.map((rule) => {
    const build = builds[rule.dimension - 1];
    if (build === undefined) throw new ResearchInputError('INVALID_INPUT', `维度 ${rule.dimension} 无构造结果`);
    const delivered = build.materials.map((m) => m.materialId).filter((id) => !demotedIds.has(id));
    const demoted = build.materials.map((m) => m.materialId).filter((id) => demotedIds.has(id));
    return { dimension: rule.dimension, code: rule.code, name: rule.name, delivered, demoted, gap: build.gaps };
  });

  // ---- L0（固定材料）----
  const l0Fixed = buildL0FixedMaterials(businessKey, cutoff, poolMeta, opts.versions, rules);
  const l0FixedBlocks = l0Fixed.map((m) => ({ materialId: m.materialId, bytes: materialBytes(m) }));
  const l0FixedBytes = l0FixedBlocks.reduce((n, b) => n + b.bytes, 0);

  // ---- L2 索引（送达引用目录 + 封存目录摘要；先于回执构建，回执可引用其最终字节数）----
  const artifactOf = new Map<string, string>();
  for (const facts of sealFactSets) {
    for (const f of facts) artifactOf.set(f.factId, f.artifactSha256);
  }
  const deliveredFacts: { factId: string; materialId: string; artifactSha256: string; layer: 'L0' | 'L1' }[] = [];
  const seenFacts = new Set<string>();
  const deliveredMaterials: { material: Material; layer: 'L0' | 'L1' }[] = [
    ...l0Fixed.map((material) => ({ material, layer: 'L0' as const })),
    ...l1Blocks.map((block) => ({
      material: dimMaterials.find((m) => m.materialId === block.materialId) as Material,
      layer: 'L1' as const,
    })),
  ];
  for (const { material, layer } of deliveredMaterials) {
    for (const factId of material.factIds) {
      if (seenFacts.has(factId)) continue;
      seenFacts.add(factId);
      const artifact = artifactOf.get(factId);
      if (artifact === undefined) {
        throw new ResearchInputError('FACT_NOT_IN_SEAL', `送达材料引用的事实 ${factId} 不在本轮封存池（引用纪律：只送达封存材料）`);
      }
      deliveredFacts.push({ factId, materialId: material.materialId, artifactSha256: artifact, layer });
    }
  }
  const indexMaterial: IndexMaterial = {
    materialId: 'mat:0:input-index',
    title: 'L2 索引：送达材料引用目录 + 降级目录 + 封存目录摘要',
    dimension: 0,
    kind: 'INDEX',
    content: {
      deliveredFacts,
      demotedMaterials: [...demotedIds].map((materialId) => {
        const material = dimMaterials.find((m) => m.materialId === materialId) as Material;
        return {
          materialId,
          dimension: material.dimension,
          title: material.title,
          bytes: materialBytes(material),
          factCount: material.factIds.length,
        };
      }),
      seals: seals.map((seal, i) => ({
        sealId: seal.sealId,
        manifestHash: seal.manifestHash,
        subject: sealSubjects[i] as string,
        cutoff: seal.cutoff,
        facts: seal.factIds.length,
        artifacts: seal.artifactRefs.length,
        factKindCounts: countByKind(sealFactSets[i] as TimePointFact[]),
        artifactRefs: seal.artifactRefs,
      })),
      note:
        '全部封存事实的 factId 完整清单 = 各 seal manifest 的 factIds（manifest 随包携带，为本包的权威目录）；' +
        '本索引列出送达材料（L0/L1）的引用目录、降入 L2 的材料目录（目录可见、内容未送达——引用纪律照常）与封存目录摘要，' +
        '供证据引用命中检查与原件下钻（factId → artifactSha256 → 字节区间）。',
    },
    factIds: [],
  };
  const indexBytes = materialBytes(indexMaterial);

  // ---- coverage 回执（L0；自身字节计入 L0，文本注明）----
  const receipt = buildCoverageReceiptMaterial(dimensions, {
    l0FixedBytes,
    l0Budget: opts.budget.l0Bytes,
    l1Bytes,
    l1Budget: opts.budget.l1Bytes,
    l1Blocks: l1Blocks.length,
    l2Bytes: indexBytes,
    l2Budget: opts.budget.l2Bytes,
  });
  const receiptBytes = materialBytes(receipt);
  const l0Bytes = l0FixedBytes + receiptBytes;
  const l0Blocks = [...l0FixedBlocks, { materialId: receipt.materialId, bytes: receiptBytes }];

  const layers = {
    l0: { name: 'L0' as const, budget: opts.budget.l0Bytes, bytes: l0Bytes, blocks: l0Blocks },
    l1: { name: 'L1' as const, budget: opts.budget.l1Bytes, bytes: l1Bytes, blocks: l1Blocks },
    l2: {
      name: 'L2' as const,
      budget: opts.budget.l2Bytes,
      bytes: indexBytes,
      blocks: [{ materialId: indexMaterial.materialId, bytes: indexBytes }],
    },
  };

  // ---- 预算闸（EK-4.4：阻断不截断；L0/L2 不可裁剪）----
  if (l0Bytes > opts.budget.l0Bytes) {
    throw new KernelError('INPUT_OVER_BUDGET', `L0 身份层 ${String(l0Bytes)} 字节超预算 ${String(opts.budget.l0Bytes)}（L0 不可裁剪，RM §5.1）`);
  }
  if (indexBytes > opts.budget.l2Bytes) {
    throw new KernelError('INPUT_OVER_BUDGET', `L2 索引层 ${String(indexBytes)} 字节超预算 ${String(opts.budget.l2Bytes)}（L2 不可裁剪）`);
  }
  const totalBytes = l0Bytes + l1Bytes + indexBytes;
  if (totalBytes > opts.budget.totalBytes) {
    throw new KernelError(
      'INPUT_OVER_BUDGET',
      `分层总字节 ${String(totalBytes)} 超总预算 ${String(opts.budget.totalBytes)}（L0=${String(l0Bytes)} L1=${String(l1Bytes)} L2=${String(indexBytes)}，降级已按层预算执行，不截断）`,
    );
  }

  // ---- 成包 + 入库 ----
  const materials: Material[] = [
    ...l0Fixed,
    receipt,
    ...dimMaterials,
    indexMaterial,
  ];
  const core = {
    packageKind: 'RESEARCH_INPUT' as const,
    packageVersion: PACKAGE_VERSION,
    assemblerRulesVersion: ASSEMBLER_RULES_VERSION,
    businessKey,
    cutoff,
    pool: poolMeta,
    versions: opts.versions,
    seals,
    materials,
    dimensions,
    rules: [...rules],
    layers,
  };
  const inputHash = canonicalSha256(core);
  const pkg: ResearchInputPackage = { ...core, inputHash };
  const artifactBytes = new TextEncoder().encode(canonicalJsonString(pkg));
  const artifactRef = await store.put(artifactBytes, 'application/json', new Date().toISOString());
  return { package: pkg, artifactRef, inputHash, inputBytes: artifactRef.bytes };
}

// ===== 分层读回 =====

export interface LayerBlockView {
  materialId: string;
  dimension: number;
  title: string;
  kind: Material['kind'];
  bytes: number;
  payload: Record<string, unknown>;
}

export interface LayeredInputView {
  l0: LayerBlockView[];
  l1: LayerBlockView[];
  l2: LayerBlockView[];
}

/** 分层读回：把层回执还原为实际模型载荷（Done-when 2"分层可读回"）。 */
export function renderInputLayers(pkg: ResearchInputPackage): LayeredInputView {
  const byId = new Map(pkg.materials.map((m) => [m.materialId, m]));
  const view = (blocks: { materialId: string; bytes: number }[]): LayerBlockView[] =>
    blocks.map((block) => {
      const material = byId.get(block.materialId);
      if (material === undefined) {
        throw new ResearchInputError('PACKAGE_MALFORMED', `层块引用的材料缺失：${block.materialId}`);
      }
      const bytes = materialBytes(material);
      if (bytes !== block.bytes) {
        throw new ResearchInputError('LAYER_BYTES_MISMATCH', `${block.materialId}: 声明 ${String(block.bytes)} ≠ 实际 ${String(bytes)}`);
      }
      return {
        materialId: material.materialId,
        dimension: material.dimension,
        title: material.title,
        kind: material.kind,
        bytes,
        payload: modelPayloadOf(material),
      };
    });
  return { l0: view(pkg.layers.l0.blocks), l1: view(pkg.layers.l1.blocks), l2: view(pkg.layers.l2.blocks) };
}

// ===== 程序校验（Done-when 2）=====

export interface PackageValidationSummary {
  ok: true;
  factsChecked: number;
  artifactsChecked: number;
  barTablesChecked: number;
  barRowsChecked: number;
  dimensions: number;
  inputHash: string;
}

/**
 * 样本包程序校验：引用全部可解析（每个 factId 在库且 artifact 哈希可校验读、
 * 且属于某个 seal）、行情表可逆无损（与库内事实逐值一致）、coverage 完整、
 * 分层字节数一致、inputHash 重算一致、规则表与本模块冻结规则哈希钉扎一致。
 */
export async function validateResearchInputPackage(
  pool: Pool,
  store: ArtifactStore,
  pkg: ResearchInputPackage,
): Promise<PackageValidationSummary> {
  const { inputHash, ...core } = pkg;
  if (canonicalSha256(core) !== inputHash) {
    throw new ResearchInputError('INPUT_HASH_MISMATCH', 'inputHash 重算不一致');
  }
  const frozenRules = rulesOfKind(pkg.businessKey.subjectKind);
  if (canonicalJsonString(pkg.rules) !== canonicalJsonString([...frozenRules])) {
    throw new ResearchInputError('PACKAGE_MALFORMED', '规则表与组装器冻结规则不一致（哈希钉扎失败）');
  }

  // 分层字节数一致 + 层块存在 + 维度材料归属唯一
  const byId = new Map(pkg.materials.map((m) => [m.materialId, m]));
  const layerBytes = { L0: 0, L1: 0, L2: 0 };
  const deliveredIds = new Set<string>();
  for (const layer of [pkg.layers.l0, pkg.layers.l1, pkg.layers.l2]) {
    let sum = 0;
    for (const block of layer.blocks) {
      const material = byId.get(block.materialId);
      if (material === undefined) throw new ResearchInputError('PACKAGE_MALFORMED', `层块引用材料缺失 ${block.materialId}`);
      const bytes = materialBytes(material);
      if (bytes !== block.bytes) throw new ResearchInputError('LAYER_BYTES_MISMATCH', block.materialId);
      sum += bytes;
      deliveredIds.add(block.materialId);
    }
    if (sum !== layer.bytes) throw new ResearchInputError('LAYER_BYTES_MISMATCH', `${layer.name} 层字节合计不符`);
    if (layer.name === 'L0') layerBytes.L0 = sum;
    else if (layer.name === 'L1') layerBytes.L1 = sum;
    else layerBytes.L2 = sum;
  }
  for (const [name, limit] of [['l0', pkg.layers.l0.budget], ['l1', pkg.layers.l1.budget], ['l2', pkg.layers.l2.budget]] as const) {
    const used = name === 'l0' ? layerBytes.L0 : name === 'l1' ? layerBytes.L1 : layerBytes.L2;
    if (used > limit) throw new ResearchInputError('PACKAGE_MALFORMED', `${name} 层 ${String(used)} 超预算 ${String(limit)}`);
  }

  // coverage 完整：规则维度逐条在场；维度材料 delivered/demoted 划分与层一致
  const expectedDims = frozenRules.map((r) => r.dimension);
  const gotDims = pkg.dimensions.map((d) => d.dimension);
  if (canonicalJsonString(expectedDims) !== canonicalJsonString(gotDims)) {
    throw new ResearchInputError('COVERAGE_INCOMPLETE', `维度清单不符：期望 ${JSON.stringify(expectedDims)} 实际 ${JSON.stringify(gotDims)}`);
  }
  for (const dim of pkg.dimensions) {
    for (const id of dim.delivered) {
      if (!deliveredIds.has(id)) throw new ResearchInputError('COVERAGE_INCOMPLETE', `${id} 声明送达但不在任何层`);
    }
    for (const id of dim.demoted) {
      if (deliveredIds.has(id)) throw new ResearchInputError('COVERAGE_INCOMPLETE', `${id} 声明降级却出现在层内`);
    }
  }

  // 封存事实目录（factId → 属于某 seal）
  const sealedFactIds = new Set<string>();
  for (const seal of pkg.seals) {
    for (const id of seal.factIds) sealedFactIds.add(id);
  }

  // 每个 factId 在库、artifact 哈希一致、属于封存池；行情表逐值往返
  let factsChecked = 0;
  let barTablesChecked = 0;
  let barRowsChecked = 0;
  const factCache = new Map<string, TimePointFact>();
  const loadCached = async (factId: string): Promise<TimePointFact> => {
    const hit = factCache.get(factId);
    if (hit !== undefined) return hit;
    const fact = await loadFact(pool, factId);
    if (fact === null) throw new ResearchInputError('SEALED_FACT_MISSING', factId);
    factCache.set(factId, fact);
    return fact;
  };
  for (const material of pkg.materials) {
    for (const factId of material.factIds) {
      if (!sealedFactIds.has(factId)) {
        throw new ResearchInputError('FACT_NOT_IN_SEAL', `${material.materialId} 引用 ${factId} 不在封存池`);
      }
      const fact = await loadCached(factId);
      if (material.kind === 'BAR_TABLE') {
        const rowMeta = material.table.meta.rowFacts.find((r) => r.factId === factId);
        if (rowMeta !== undefined && rowMeta.artifactSha256 !== fact.artifactSha256) {
          throw new ResearchInputError('FACT_ARTIFACT_MISMATCH', `${factId} 行级 artifact 与库不一致`);
        }
      }
      factsChecked += 1;
    }
    if (material.kind === 'BAR_TABLE') {
      const originals: TimePointFact[] = [];
      for (const row of material.table.meta.rowFacts) {
        originals.push(await loadCached(row.factId));
      }
      assertRoundTrip(originals, material.table); // 与库内事实逐值一致（内部逐 factId 比较）
      barTablesChecked += 1;
      barRowsChecked += originals.length;
    }
  }

  // 每个 artifact 哈希可校验读回（readBytes 内建哈希比对）
  let artifactsChecked = 0;
  for (const seal of pkg.seals) {
    for (const ref of seal.artifactRefs) {
      await store.readBytes(ref.sha256);
      artifactsChecked += 1;
    }
  }

  return {
    ok: true,
    factsChecked,
    artifactsChecked,
    barTablesChecked,
    barRowsChecked,
    dimensions: pkg.dimensions.length,
    inputHash,
  };
}
