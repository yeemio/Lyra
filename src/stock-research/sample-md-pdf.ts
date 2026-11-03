/**
 * 样板报告 Markdown → PDF（R31）。供交付 REPORTS/ 用：三份执行者协作样板是
 * markdown 底稿，不经产品 ReportDocument 路径；本工具用与 pdf.ts 相同的字体
 * 解析与 CJK 断行纪律生成可读 PDF。产品内报告导出走 pdf.ts（同候选绑定）。
 *
 * 用法：node --import tsx src/stock-research/sample-md-pdf.ts <input.md> <output.pdf>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pdfkit from 'pdfkit';

type PdfDoc = InstanceType<typeof pdfkit>;

const SYSTEM_FONTS: { path: string; psName: string }[] = [
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', psName: 'HiraginoSansGB-W3' },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', psName: 'STHeitiSC-Light' },
  { path: '/System/Library/Fonts/STHeiti Medium.ttc', psName: 'STHeitiSC-Medium' },
];

export function resolveFontSpec(): { path: string; psName: string | null } {
  const env = process.env.LYRA_PDF_FONT;
  if (env) {
    const idx = env.indexOf(':');
    if (idx > 0) return { path: env.slice(0, idx), psName: env.slice(idx + 1) };
    if (existsSync(env)) return { path: env, psName: null };
  }
  for (const c of SYSTEM_FONTS) {
    if (existsSync(c.path)) return c;
  }
  throw new Error('PDF_FONT_MISSING：未找到 CJK 字体（设 LYRA_PDF_FONT=/path/to/font.ttf[:PostScriptName]）');
}

function wrap(text: string, size: number, doc: PdfDoc): string[] {
  doc.fontSize(size);
  const max = doc.page.width - 72;
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const ch of raw) {
      const next = cur + ch;
      if (doc.widthOfString(next) > max && cur) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

function tableCells(line: string): string[] {
  return line.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));
}

export async function renderMarkdownPdf(mdPath: string, pdfPath: string): Promise<{ bytes: number; pages: number }> {
  const font = resolveFontSpec();
  const md = await readFile(mdPath, 'utf8');
  const doc = new pdfkit({ size: 'A4', margin: 36, bufferPages: true }) as PdfDoc;
  if (font.psName) doc.font(font.path, font.psName);
  else doc.font(font.path);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const para = (text: string, size = 10.5, indent = 0): void => {
    for (const line of wrap(text.replace(/\*\*/g, '').replace(/`/g, ''), size, doc)) {
      if (doc.y > doc.page.height - 64) doc.addPage();
      doc.fontSize(size).text(line, 36 + indent, undefined, { lineGap: 1.5 });
    }
    doc.moveDown(0.3);
  };

  for (const line of md.split('\n')) {
    if (/^#\s+/.test(line)) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.fontSize(17).text(line.replace(/^#\s+/, ''), 36);
      doc.moveDown(0.6);
    } else if (/^##\s+/.test(line)) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.fontSize(14).text(line.replace(/^##\s+/, ''), 36);
      doc.moveDown(0.5);
    } else if (/^###\s+/.test(line)) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.fontSize(12).text(line.replace(/^###\s+/, ''), 36);
      doc.moveDown(0.4);
    } else if (/^>\s?/.test(line)) {
      para(line.replace(/^>\s?/, ''), 9.5, 12);
    } else if (/^[-*]\s+/.test(line)) {
      para('· ' + line.replace(/^[-*]\s+/, ''), 10, 14);
    } else if (/^\|/.test(line)) {
      const cells = tableCells(line);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      para(cells.join('  |  '), 9, 8);
    } else if (/^---+$/.test(line.trim())) {
      doc.moveDown(0.3);
      doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor('#bbbbbb').stroke();
      doc.moveDown(0.4);
    } else if (line.trim() === '') {
      doc.moveDown(0.35);
    } else {
      para(line);
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#888888');
    const footerText = `个人研究记录，非投资建议 · ${i - range.start + 1}/${range.count}`;
    const fw = doc.widthOfString(footerText);
    doc.text(footerText, (doc.page.width - fw) / 2, doc.page.height - 40, { lineBreak: false });
  }
  doc.end();
  await done;
  const buf = Buffer.concat(chunks);
  await writeFile(pdfPath, buf);
  return { bytes: buf.length, pages: range.count };
}

if (process.argv[1] && process.argv[1].endsWith('sample-md-pdf.ts') && process.argv[2] && process.argv[3]) {
  void renderMarkdownPdf(process.argv[2], process.argv[3]).then((r) => {
    console.log(`PDF written: ${process.argv[3]} (${r.bytes} bytes, ${r.pages} pages)`);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
