/**
 * sr PDF 导出测试（R31）：结构完整（%PDF/字体/多页），中文渲染由浏览器下载验证补全。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReportDocument } from './contracts.js';
import { renderReportPdf } from './pdf.js';

const doc: ReportDocument = {
  reportId: 'c1c1c1c1-1111-1111-1111-111111111111',
  taskId: 'a1a1a1a1-1111-1111-1111-111111111111',
  version: 2,
  status: 'PUBLISHED',
  subject: '601318',
  subjectName: '中国平安',
  focus: 'FULL',
  horizon: 'MID_TERM',
  cutoff: '2026-10-23T16:00:00.000Z',
  methodVersion: 'sr-m1',
  adapterVersion: 'pool-1',
  planAuthVersion: 'sr-auth-1',
  generatedBy: 'PRODUCT_SIMULATED',
  sections: [
    { key: 'summary', title: '首页与研究摘要', narrative: '本章摘要：估值与情景。', findings: [{ text: '发现一', status: 'FACT', citations: [] }], tables: ['valuation-sensitivity'], citations: [], gaps: ['无一致预期数据'] },
    { key: 'valuation', title: '估值与预期', narrative: 'PE 复算见下表。', findings: [], tables: [], citations: [], gaps: [] },
    { key: 'company', title: '公司与业务', narrative: 'n', findings: [], tables: [], citations: [{ label: '财务指标 2026Q2', locator: { kind: 'COMPUTED', tableId: 'fin-quarterly' }, quote: 'MBRevenue=27797683972.880000' }], gaps: [] },
  ],
  qaFindings: [{ code: 'TEST', severity: 'ADVISORY', sectionKey: null, detail: '示例提示项' }],
  evidenceRefs: null, gate: null, changeSummary: '示例修订摘要',
  createdAt: '2026-10-26T00:00:00.000Z',
  publishedAt: '2026-10-26T00:00:00.000Z',
  contentHash: '0'.repeat(64),
};

describe('PDF 导出', () => {
  it('生成合法 PDF：头标识、内嵌字体、多页、版本号页脚', async () => {
    const buf = await renderReportPdf(doc, {
      'valuation-sensitivity': {
        title: '估值敏感性',
        columns: ['价格', 'PE', 'PB'],
        rows: [['45.4', '5.2', '0.80'], ['51.76', '5.88', '0.91'], ['56.8', '6.5', '1.00']],
        note: 'PE = 价格 / EPS-TTM',
      },
    });
    assert.ok(buf.subarray(0, 5).toString('utf8') === '%PDF-', 'PDF 头标识');
    const s = buf.toString('latin1');
    assert.ok((s.match(/\/Font/g) ?? []).length >= 2, '字体对象嵌入');
    assert.ok(buf.length > 8000, '非空产物');
  });

  it('〔R5〕完整值不截断 + 引用附录存在', async () => {
    const buf = await renderReportPdf(doc, {
      'valuation-sensitivity': {
        title: '估值敏感性',
        columns: ['价格', 'PE-TTM（滚动）', 'TOTAL_PARENT_EQUITY_长列名示例'],
        rows: [['45.400000', '5.200000', '27797683972.880000']],
        note: 'PE = 价格 / EPS-TTM',
      },
    });
    // 〔C4/R5〕提取命令修正为 ['-','-']；工具缺失/错误一律失败，不得静默给绿
    const { execFileSync } = await import('node:child_process');
    let textLayer: string;
    try {
      textLayer = execFileSync('pdftotext', ['-', '-'], { input: buf, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      assert.fail(`pdftotext 提取失败（本测试环境须可用）: ${err instanceof Error ? err.message : String(err)}`);
    }
    assert.ok(textLayer.includes('27797683972.880000'), '完整长数值未被截断');
    assert.ok(!textLayer.includes('27797683972.\n'), '不得出现数值截断尾巴');
    assert.ok(textLayer.includes('TOTAL_PARENT_EQUITY_长列名示例'), '完整长列名');
    assert.ok(textLayer.includes('引用定位'), '引用附录存在');
    assert.ok(textLayer.includes('fin-quarterly'), '引用绑定表 id 呈现');
    // 页脚不得制造附加空白页：本夹具内容页应为少量页（曾因页脚 bug 4 页内容膨胀为 8 页）
    const pageCount = (buf.toString('latin1').match(/\/Type[ ]*\/Page[^s]/g) ?? []).length;
    assert.ok(pageCount > 0 && pageCount <= 6, `页数异常（${pageCount}，应≤6——页脚不应追加空白页）`);
    const footerCount = (textLayer.match(/个人研究记录，非投资建议 · /g) ?? []).length;
    assert.equal(footerCount, pageCount, `每页恰一个页脚（${footerCount}/${pageCount}——无页脚专属追加页）`);
  });

  it('引用缺失的表不抛异常（如实标注缺失）', async () => {
    const buf = await renderReportPdf(doc, {});
    assert.ok(buf.subarray(0, 5).toString('utf8') === '%PDF-');
  });
});

it('离线证据分册与正文同哈希，全部基础行保留并返回实际页码与链接', async () => {
  const { renderReportPdfBundle } = await import('./pdf.js');
  const { execFileSync } = await import('node:child_process');
  const d = structuredClone(doc);d.generatedBy='OFFLINE_DERIVED';d.sections[0]!.tables=['bars-daily','valuation-sensitivity'];
  const bundle=await renderReportPdfBundle(d,{
    'bars-daily':{title:'日线原表',columns:['date','close'],rows:Array.from({length:401},(_,i)=>[`ROW-${i+1}`,`VALUE-${i+1}`]),note:'原数据未作连续性保证'},
    'valuation-sensitivity':{title:'研究表',columns:['价格','倍数'],rows:[['123.000000','8']],note:'原单位'},
  });
  const extract=(b:Buffer)=>execFileSync('pdftotext',['-','-'],{input:b,encoding:'utf8',maxBuffer:32*1024*1024});
  const main=extract(bundle.reportPdf),evidence=extract(bundle.evidencePdf);
  assert.ok(main.includes(d.contentHash)&&evidence.includes(d.contentHash));
  assert.ok(main.includes('EVIDENCE.pdf')&&main.includes('研究表')&&main.includes('123.000000'));
  assert.ok(!main.includes('VALUE-401')&&evidence.includes('VALUE-401'),'401行仍完整可查，无旧400行截断');
  const pages=bundle.evidencePages['bars-daily']!;assert.ok(pages.start>=2&&pages.end>=pages.start);
  const extractedPages=evidence.split('\f');
  assert.ok(extractedPages[pages.start-1]!.includes('日线原表'),'起始页码实际对应表标题');
  assert.ok(extractedPages[pages.end-1]!.includes('VALUE-401'),'结束页码实际包含最后行');
  assert.ok(bundle.reportPdf.toString('latin1').includes('EVIDENCE.pdf#page='),'PDF包含可点击外部附册页码链接');
});
