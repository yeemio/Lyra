/**
 * Lyra · sr 报告 PDF 导出（R31）。与网页绑定同一 ReportDocument（同一候选）。
 * 中文字体：LYRA_PDF_FONT（path[:psName]）→ 系统 TTC（fontkit 按字体名选择）；
 * 全部缺失时抛 PDF_FONT_MISSING，不以英文静默替代。
 */
import { accessSync } from 'node:fs';
import pdfkit from 'pdfkit';
import type { ReportDocument } from './contracts.js';
import { readableTable, tableBands, materialDateSummary } from './report-tables.js';

interface FontSpec { path: string; psName?: string | undefined }

const FONT_CANDIDATES: FontSpec[] = [
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', psName: 'HiraginoSansGB-W3' },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', psName: 'STHeitiSC-Light' },
  { path: '/System/Library/Fonts/STHeiti Medium.ttc', psName: 'STHeitiSC-Medium' },
];

export function resolvePdfFont(env: NodeJS.ProcessEnv = process.env): FontSpec {
  const fromEnv = env.LYRA_PDF_FONT;
  if (fromEnv) {
    const [path, psName] = fromEnv.split(':');
    if (path) return { path, psName: psName || undefined };
  }
  for (const c of FONT_CANDIDATES) {
    try {
      accessSync(c.path);
      return c;
    } catch { /* 试下一个 */ }
  }
  throw new Error('PDF_FONT_MISSING：未找到 CJK 字体（设 LYRA_PDF_FONT=/path/to/font.ttf[:PostScriptName]）');
}

type Doc = InstanceType<typeof pdfkit> & { y: number };

function ensurePage(doc: Doc, need = 60): void {
  if (doc.y > doc.page.height - 72 - need) doc.addPage();
}

function wrapLines(doc: Doc, text: string, size: number, maxWidth: number): string[] {
  doc.fontSize(size);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) {
      out.push('');
      continue;
    }
    let cur = '';
    for (const ch of raw) {
      const next = cur + ch;
      if (doc.widthOfString(next) > maxWidth && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function text(doc: Doc, s: string, opts: { size?: number; indent?: number; bold?: boolean; gap?: number; align?: 'left' | 'center' } = {}): void {
  const size = opts.size ?? 10.5;
  const indent = opts.indent ?? 0;
  const { font } = doc as unknown as { font: { regular: string; bold: string } };
  void font;
  const maxWidth = doc.page.width - 72 - indent;
  const lines = wrapLines(doc, s, size, opts.align === 'center' ? doc.page.width - 120 : maxWidth);
  for (const line of lines) {
    ensurePage(doc, size + 6);
    if (opts.align === 'center') {
      doc.fontSize(size).text(line, 60, undefined, { width: doc.page.width - 120, align: 'center', lineGap: 1.5 });
    } else {
      doc.fontSize(size).text(line, 36 + indent, undefined, { width: maxWidth, lineGap: 1.5 });
    }
  }
  doc.moveDown((opts.gap ?? 4) / 12);
}

function tableCells(line: string): string[] {
  return line.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));
}

/** Draw bounded narrative tables as real cells, repeating headers across page breaks. */
function grid(doc: Doc, columns: string[], rows: string[][]): void {
  const available = doc.page.width - 72;
  const rowNumbers = columns[0] === '行号';
  const record = columns.length === 2 && columns[0] === '项目';
  const widths = columns.map((_, i) => record ? (i === 0 ? 110 : available - 110) : rowNumbers ? (i === 0 ? 28 : (available - 28) / (columns.length - 1)) : available / columns.length);
  const size = columns.length > 4 ? 8 : 9.5, lineHeight = size + 4;
  const linesOf = (cells: string[]) => columns.map((_, i) => wrapLines(doc, cells[i] ?? '', size, widths[i]! - 12));
  const paint = (lines: string[][], count: number, header: boolean) => {
    const y = doc.y, height = count * lineHeight + 12;
    let x = 36;
    for (let col = 0; col < columns.length; col++) {
      doc.rect(x, y, widths[col]!, height).fillAndStroke(header ? '#e8eff3' : '#ffffff', '#cbd5df');
      doc.fillColor('#18364a').fontSize(size);
      for (let l = 0; l < count; l++) doc.text(lines[col]?.[l] ?? '', x + 6, y + 6 + l * lineHeight, { lineBreak: false });
      x += widths[col]!;
    }
    doc.x = 36; doc.y = y + height;
  };
  const heading = linesOf(columns), headCount = Math.max(...heading.map((x) => x.length));
  ensurePage(doc, (headCount + 3) * lineHeight + 24);
  paint(heading, headCount, true);
  for (const row of rows) {
    const lines = linesOf(row); let offset = 0;
    const total = Math.max(1, ...lines.map((x) => x.length));
    while (offset < total) {
      let room = Math.floor((doc.page.height - 72 - doc.y - 12) / lineHeight);
      if (room < 1 || (offset === 0 && total <= 15 && total > room)) {
        doc.addPage(); paint(heading, headCount, true);
        room = Math.floor((doc.page.height - 72 - doc.y - 12) / lineHeight);
      }
      const count = Math.min(total - offset, room);
      paint(lines.map((x) => x.slice(offset, offset + count)), count, false);
      offset += count;
    }
  }
  doc.y += 8;
}

/** markdown narrative 的 PDF 近似渲染（去标记、保结构：标题/列表/表格/段落）。 */
function mdToPdf(doc: Doc, md: string): void {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const plain = (s: string): string => s.replace(/\*\*/g, '').replace(/`/g, ''); // 〔R5〕不截断：完整文本经 wrapLines 断行
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      text(doc, plain(h[1]!), { size: 12.5, gap: 3 });
    } else if (li) {
      text(doc, '· ' + plain(li[1]!), { size: 10, indent: 14, gap: 2 });
    } else if (/^\|/.test(line)) {
      const all: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        const cells = tableCells(lines[i]!).map(plain);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) all.push(cells);
        i++;
      }
      i--;
      const header = all.shift();
      if (header && header.length <= 6) grid(doc, header, all);
      else if (header) for (const row of all) text(doc, header.map((c, j) => `${c}：${row[j] ?? ''}`).join('；'), { size: 9.5, gap: 4 });
    } else if (line.trim() === '') {
      doc.moveDown(0.3);
    } else {
      text(doc, plain(line), {});
    }
  }
}

interface PdfOptions {
  materialDates?: string;
  evidenceOnly?: boolean;
  evidencePages?: Record<string, { start: number; end: number }>;
  tablePages?: Record<string, { start: number; end: number }>;
}

export async function renderReportPdf(
  report: ReportDocument,
  tablesById: Record<string, { title: string; columns: string[]; rows: (string | number | null)[][]; note: string | null }>,
  options: PdfOptions = {},
): Promise<Buffer> {
  const font = resolvePdfFont();
  const doc = new pdfkit({ size: 'A4', margin: 36, bufferPages: true }) as unknown as Doc;
  if (font.psName) {
    doc.font(font.path, font.psName);
  } else {
    doc.font(font.path);
  }
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', resolve));

  // 封面
  doc.moveDown(6);
  text(doc, `${report.subjectName}（${report.subject}）`, { size: 24, align: 'center', gap: 8 });
  text(doc, options.evidenceOnly ? '完整基础数据 · 证据附册' : '单股研究报告', { size: 16, align: 'center', gap: 10 });
  text(doc, `同源报告内容哈希：${report.contentHash}`, { size: 8, align: 'center', gap: 4 });
  text(doc, `版本 v${report.version} · 资料截点 ${report.cutoff}`, { size: 11, align: 'center', gap: 2 });
  text(doc, `研究重点 ${report.focus} · 方法版本 ${report.methodVersion}`, { size: 11, align: 'center', gap: 2 });
  text(doc,
    report.generatedBy === 'OFFLINE_DERIVED'
      ? '生成身份：离线派生阅读版（复用原研究与 J；无新增调用/发布/质量接受）'
      : report.generatedBy === 'PRODUCT_SIMULATED'
      ? '生成身份：模拟通道生成（工程链验证，非真实研究结论）'
      : report.generatedBy === 'PRODUCT_REAL'
        ? '生成身份：产品研究链生成（真实模型通道）'
        : '生成身份：执行者协作样板',
    { size: 11, align: 'center', gap: 2 });
  text(doc, report.changeSummary ?? '', { size: 10, align: 'center', gap: 2 });
  text(doc, options.materialDates ?? materialDateSummary(tablesById), { size: 9.5, align: 'center', gap: 4 });
  if (report.gate) {
    text(doc,
      report.gate.passed ? `发布门：通过（必经 J 裁决完成，无承重未解项）` : `发布门：未过——受限发布（${report.gate.decisionBearingUnresolved.length} 项承重未解项，报告内具名展示）`,
      { size: 10, align: 'center', gap: 2 });
  }
  if (report.gate) text(doc, report.gate.reason, { size: 9, align: 'center', gap: 3 });
  if (report.derivation) text(doc, `原报告 SHA-256 ${report.derivation.sourceReportSha256}；映射 SHA-256 ${report.derivation.mappingSha256}`, { size: 8, align: 'center', gap: 3 });
  if (report.evidenceRefs) {
    text(doc,
      `证据绑定：包 ${report.evidenceRefs.packHash.slice(0, 12)}… / A ${report.evidenceRefs.aOutputHash.slice(0, 12)}… / 清单 ${report.evidenceRefs.checklistHash.slice(0, 12)}… / J ${report.evidenceRefs.jOutputHash.slice(0, 12)}…`,
      { size: 8.5, align: 'center', gap: 2 });
  }
  doc.moveDown(2);
  text(doc, '个人研究记录，非投资建议', { size: 12, align: 'center', gap: 2 });

  if (!options.evidenceOnly) {
  // 目录
  doc.addPage();
  text(doc, '目录', { size: 16, gap: 6 });
  report.sections.forEach((s, i) => {
    const y = doc.y;
    text(doc, `${i + 1}. ${s.title}`, { size: 11, indent: 10, gap: 2 });
    doc.goTo(36, y, doc.page.width - 72, 18, `sec-${s.key}`);
  });
  text(doc, '附：证据与计算表', { size: 11, indent: 10, gap: 2 });

  // 章节
  for (const s of report.sections) {
    ensurePage(doc, 160);
    doc.moveDown(0.5);
    doc.addNamedDestination(`sec-${s.key}`);
    text(doc, s.title, { size: 14.5, gap: 4 });
    mdToPdf(doc, s.narrative);
    if (s.findings.length) {
      text(doc, '关键判断', { size: 12, gap: 3 });
      for (const f of s.findings) {
        const tag = f.status === 'FACT' ? '已证事实' : f.status === 'INFERENCE' ? '推断' : f.status === 'REJECTED' ? '已否定' : '待验证';
        text(doc, `· 【${tag}】${f.text}`, { size: 10, indent: 12, gap: 2 });
      }
    }
    if (s.scenarios?.length) {
      text(doc, '情景与触发条件', { size: 12, gap: 3 });
      for (const sc of s.scenarios) {
        text(doc, `· ${sc.name}：${sc.condition} → ${sc.implication}`, { size: 10, indent: 12, gap: 2 });
      }
    }
    if (s.gaps.length) text(doc, `缺口：${s.gaps.join('；')}`, { size: 10, indent: 12, gap: 3 });
    if (s.tables.length) text(doc, `证据表：${s.tables.map((id) => tablesById[id]?.title ?? id).join('、')}（见附录）`, { size: 9.5, indent: 12, gap: 3 });
  }

  }
  // 证据与计算表
  doc.addPage();
  text(doc, options.evidenceOnly ? '完整基础原表（全部行列，按行号对应分栏）' : '附：证据与计算表', { size: 16, gap: 6 });
  const used = Array.from(new Set(report.sections.flatMap((s) => s.tables)));
  for (const tid of used) {
    const t = tablesById[tid];
    if (!t) {
      text(doc, `${tid}（缺失）`, { size: 12, gap: 3 });
      continue;
    }
    if (options.evidencePages?.[tid]) {
      const pages = options.evidencePages[tid]!;
      ensurePage(doc, 90);
      text(doc, `${t.title}（${tid}）`, { size: 12.5, gap: 3 });
      text(doc, `完整原表：${t.rows.length} 行 × ${t.columns.length} 列，见 EVIDENCE.pdf 第 ${pages.start}-${pages.end} 页；与本报告 v${report.version}、内容哈希相同。`, { size: 9.5, gap: 3 });
      const y = doc.y;
      text(doc, '打开完整证据附册', { size: 10, gap: 3 });
      doc.link(36, y, 180, 16, `EVIDENCE.pdf#page=${pages.start}`);
      if (t.note) text(doc, `单位/口径：${t.note}`, { size: 9, gap: 3 });
      continue;
    }
    // 附册每张表从新页开始，供正文精确页码定位；所有表逐一建立 PDF 命名目的地。
    if ((options.evidenceOnly && doc.y > 100) || doc.y > doc.page.height - 220) doc.addPage();
    const startPage = doc.bufferedPageRange().count;
    doc.addNamedDestination(`table-${tid}`);
    text(doc, `${t.title}（${tid}）`, { size: 12.5, gap: 3 });
    text(doc, `原表：${t.rows.length} 行 × ${t.columns.length} 列；原字段：${t.columns.join('、')}`, { size: 8.5, gap: 3 });
    if (t.note) text(doc, `口径/公式：${t.note}`, { size: 9.5, gap: 3 });
    const view = readableTable(t);
    const proseRows = view.rows.some((r) => r.some((v) => v.length > 180));
    const bands = proseRows
      ? view.rows.map((r, i) => ({ columns: ['项目', '内容'], rows: [['原表行号', String(i + 1)], ...view.columns.map((c, j) => [c, r[j] ?? ''])] }))
      : tableBands(view.columns, view.rows);
    for (const [i, band] of bands.entries()) {
      if (bands.length > 1) text(doc, proseRows ? `原表第 ${i + 1}/${t.rows.length} 行（长文本逐项展开，内容完整）` : `分栏 ${i + 1}/${bands.length}（按行号对应，共 ${t.rows.length} 行；所有值保持原精度）`, { size: 9, gap: 3 });
      if (t.rows.length === 0) text(doc, '（空表）', { size: 9 });
      else grid(doc, band.columns, band.rows);
    }
    if (view.sources.length) {
      text(doc, '来源定位（表内来源号对应；重复信息集中列示）', { size: 10, gap: 3 });
      view.sources.forEach((source, i) => text(doc, `S${i + 1} · ${source}`, { size: 8.5, gap: 3 }));
    }
    if (options.tablePages) options.tablePages[tid] = { start: startPage, end: doc.bufferedPageRange().count };
  }

  if (!options.evidenceOnly) {
  // 〔R5〕引用附录：逐章引用定位（label + 绑定 tableId + 引文）
  const citedSections = report.sections.filter((x) => x.citations.length > 0);
  if (citedSections.length > 0) {
    doc.addPage();
    text(doc, '附：引用定位（逐章）', { size: 16, gap: 6 });
    for (const sec of citedSections) {
      text(doc, `${sec.title}`, { size: 12.5, gap: 3 });
      sec.citations.forEach((c, i) => {
        const loc = c.locator.kind === 'COMPUTED' ? `表 ${c.locator.tableId}` : c.locator.kind === 'SECTION' ? `章节 ${c.locator.sectionKey}` : c.locator.kind;
        text(doc, `[${i + 1}] ${c.label}（${loc}）${c.quote ? `：「${c.quote}」` : ''}`, { size: 9, indent: 10, gap: 1 });
      });
    }
  }

  // 质检
  ensurePage(doc, 120);
  text(doc, '质量检查', { size: 16, gap: 6 });
  if (report.qaFindings.length === 0) {
    text(doc, '通过（无阻断/提示项）', { size: 11, gap: 4 });
  } else {
    for (const f of report.qaFindings) {
      text(doc, `· [${f.severity}] ${f.code}：${f.detail}`, { size: 10, indent: 10, gap: 2 });
    }
  }

  }
  // 页脚
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#888888');
    // 〔C4/R5〕页脚禁用 width/align 布局与自动换行（两者组合会触发自动分页追加空白页）——手动量宽居中
    const footerText = `个人研究记录，非投资建议 · v${report.version}${options.evidenceOnly ? ' 证据附册' : ''} · ${i - range.start + 1}/${range.count}`;
    const fw = doc.widthOfString(footerText);
    doc.text(footerText, (doc.page.width - fw) / 2, doc.page.height - 42, { lineBreak: false });
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** 离线固定阅读包：研究正文与完整基础证据分册，二者绑定同一报告内容哈希。 */
export async function renderReportPdfBundle(
  report: ReportDocument,
  tablesById: Parameters<typeof renderReportPdf>[1],
): Promise<{ reportPdf: Buffer; evidencePdf: Buffer; evidencePages: Record<string, { start: number; end: number }> }> {
  const materialDates = materialDateSummary(tablesById);
  const denseIds = new Set(['bars-daily', 'index-bars', 'margin-series', 'holder-count', 'pledge', 'announcements-recent', 'fin-quarterly', 'growth-quarterly', 'margins-roe']);
  const denseTables = Object.fromEntries(Object.entries(tablesById).filter(([id]) => denseIds.has(id)));
  const evidencePages: Record<string, { start: number; end: number }> = {};
  const evidenceReport = { ...report, sections: [{ ...report.sections[0]!, tables: Object.keys(denseTables) }] };
  const evidencePdf = await renderReportPdf(evidenceReport, denseTables, { materialDates, evidenceOnly: true, tablePages: evidencePages });
  const reportPdf = await renderReportPdf(report, tablesById, { materialDates, evidencePages });
  return { reportPdf, evidencePdf, evidencePages };
}
