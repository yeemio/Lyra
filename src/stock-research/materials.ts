/** Offline official-report extracts. No fetching or business-store writes at read time. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import type { EvidenceTable, SrHorizon } from './contracts.js';
import type { PlanOutput } from './transport.js';

export interface ReportMaterial {
  sourceKind?: 'SNAPSHOT';
  subject: string;
  sourceUrl: string;
  sourcePath: string;
  sha256: string;
  publishedDate: string;
  publishedAt: string; // conservative end of publication day when time is unknown
  retrievedAt: string;
  period: string;
  tables: { tableId: string; title: string; columns: string[]; rows: (string | number | null)[][]; pages: number[]; tags: string[]; unitNote: string }[];
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CATALOG = fileURLToPath(new URL('./report-materials.json', import.meta.url));
export async function loadReportMaterials(subject: string, cutoff: string): Promise<{ tables: EvidenceTable[]; gaps: string[] }> {
  const records = JSON.parse(await readFile(CATALOG, 'utf8')) as ReportMaterial[];
  const tables = new Map<string, EvidenceTable>();
  const gaps: string[] = [];
  for (const m of records.filter((r) => r.subject === subject)) {
    // A current retrieval is never represented as a historical seal. Both dates constrain availability.
    if (new Date(m.publishedAt) > new Date(cutoff) || new Date(m.retrievedAt) > new Date(cutoff)) {
      gaps.push(`原件 ${m.period} 在截点不可用（披露 ${m.publishedDate}；本地首次取证 ${m.retrievedAt}，非历史封存）`);
      continue;
    }
    const path = resolve(ROOT, m.sourcePath);
    const rel = relative(ROOT, path);
    const allowedSource = m.sourceKind === 'SNAPSHOT'
      ? /^https:\/\/(www\.sse\.net\.cn\/index\/singleIndex\?indexType=(scfi|ccfi)|hq\.sinajs\.cn\/list=sh601919)$/.test(m.sourceUrl)
      : /^https:\/\/(big5\.sse\.com\.cn|static\.cninfo\.com\.cn)\//.test(m.sourceUrl);
    if (isAbsolute(rel) || rel.startsWith('..') || !allowedSource) throw new Error('REPORT_MATERIAL_SOURCE_INVALID');
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { gaps.push(`原件文件不可读：${m.sourcePath}`); continue; }
    if (createHash('sha256').update(bytes).digest('hex') !== m.sha256) throw new Error(`REPORT_MATERIAL_HASH_MISMATCH: ${m.sourcePath}`);
    for (const t of m.tables) {
      const locator = { kind: 'FILE' as const, path: m.sourcePath, note: `${m.sourceUrl}；${m.sourceKind === 'SNAPSHOT' ? '固定网页/行情快照，数据日' : `PDF页 ${t.pages.join(',')}；报告期`} ${m.period}；来源日期 ${m.publishedDate}；可用时刻 ${m.publishedAt}；首次取证 ${m.retrievedAt}；SHA256 ${m.sha256}；当前下载原件，不是历史封存` };
      const provenance = [m.period, m.publishedDate, m.retrievedAt, m.sourceUrl, t.pages.join(','), m.sha256, m.subject];
      const existing = tables.get(t.tableId);
      const rows = t.rows.map((r) => [...r, ...provenance]);
      if (existing) { existing.rows.push(...rows); existing.locators.push(locator); }
      else tables.set(t.tableId, { tableId: t.tableId, title: t.title, columns: [...t.columns, 'reportPeriod', 'publishedDate', 'retrievedAt', 'sourceUrl', 'pages', 'sha256', 'sourceSubject'], rows, unitNote: t.unitNote + '；取证时点晚于原披露，非历史封存。', locators: [locator], cutoff });
    }
  }
  if (!tables.size) gaps.push('无截点内已取证的官方报表正文；公告标题不能支持渠道/产品/回款事实');
  return { tables: [...tables.values()], gaps };
}

const ALIASES: Record<string, string[]> = {
  FINANCIAL: ['fin-quarterly', 'official-financials'], BALANCE: ['fin-quarterly'], DAILY_BAR: ['bars-daily'],
  ANNOUNCEMENT: ['announcements-recent', 'report-excerpts'], OPERATING: ['operating-segments', 'operating-revenue', 'report-excerpts'],
  CASH_FLOW: ['official-financials', 'report-excerpts'],
};
export const SHIPPING_MATERIAL_IDS = ['shipping-routes', 'shipping-segments', 'shipping-fleet', 'shipping-comparison', 'freight-snapshot', 'market-snapshot', 'official-financials', 'report-excerpts'];
export function requestedMaterialIds(plan: PlanOutput, tables: EvidenceTable[] = []): string[] {
  const ids = plan.materialPriorities.flatMap((x) => ALIASES[x] ?? [x]);
  const text = plan.questions.join(' ');
  if (/渠道|产品|销量|售价|成本|收入结构/.test(text)) ids.push('operating-segments', 'operating-revenue', 'report-excerpts');
  if (/现金|回款|利润|财务/.test(text)) ids.push('official-financials', 'report-excerpts');
  if (tables.some((t) => t.tableId === 'shipping-routes')) {
    return [...new Set([...ids.filter((id) => !['operating-segments', 'operating-revenue'].includes(id)), ...SHIPPING_MATERIAL_IDS])];
  }
  return [...new Set(ids)];
}
/** Explicit requested materials are included in every A group; missing requests stay visible. */
export function bindResearchPlan(tables: EvidenceTable[], plan: PlanOutput, cutoff: string, horizon: SrHorizon): { tables: EvidenceTable[]; gaps: string[] } {
  const ids = requestedMaterialIds(plan, tables);
  const gaps = ids.filter((id) => !tables.some((t) => t.tableId === id && t.rows.length)).map((id) => `计划所需材料缺失：${id}`);
  const selected = tables.filter((t) => !['official-financials', 'operating-segments', 'operating-revenue', 'report-excerpts'].includes(t.tableId) || ids.includes(t.tableId));
  const rows = plan.questions.map((q, i) => [i + 1, q, horizon, ids.join(', '), gaps.join('；') || '已送达指定材料；证据充分性须由 A/J 裁决', /渠道|回款/.test(q) ? '终端动销/库存与渠道回款分拆未披露时，不得用公司发货或合并现金流替代' : '材料只支持到已披露范围，因果解释与未来假设需独立验证'] as (string | number | null)[]);
  return { tables: [...selected.filter((t) => t.tableId !== 'research-questions'), { tableId: 'research-questions', title: '研究问题、材料义务与反证边界', columns: ['questionId', 'question', 'horizon', 'requiredTables', 'materialGaps', 'countercase'], rows, unitNote: `重点处理：${plan.emphasisNotes.join('；')}；材料选取来自 PLAN，非模型结论。`, locators: [], cutoff }], gaps };
}
export function selectAnalysisTables(tables: EvidenceTable[], plan: PlanOutput, group: string): EvidenceTable[] {
  const base: Record<string, string[]> = { a: ['industry', 'announcements-recent', 'fin-quarterly'], b: ['fin-quarterly'], c: ['bars-daily', 'index-bars', 'margin-series'] };
  const required = new Set([...requestedMaterialIds(plan, tables), 'research-questions', ...(base[group] ?? [])]);
  return tables.filter((t) => required.has(t.tableId));
}
