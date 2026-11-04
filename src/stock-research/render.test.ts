/**
 * sr 渲染层测试（R31/C9）：内容安全（XSS）与结构底线；C9 增补首页/报告页布局回归。
 * 模型文本视为不可信内容。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage, ReportDocument, ReportSection, SrTask } from './contracts.js';
import { renderDashboard, renderLoginPage, renderMarkdown, renderReportPage, renderErrorPage } from './render.js';

function section(p: Partial<ReportSection>): ReportSection {
  return { key: 'summary', title: '首页与研究摘要', narrative: '', findings: [], tables: [], citations: [], gaps: [], ...p };
}

function report(narrative: string, subjectName = '测试'): ReportDocument {
  return {
    reportId: 'b1b1b1b1-1111-1111-1111-111111111111',
    taskId: 'a1a1a1a1-1111-1111-1111-111111111111',
    version: 1,
    status: 'PUBLISHED',
    subject: '002384',
    subjectName,
    focus: 'FULL',
    horizon: 'MID_TERM',
    cutoff: '2026-10-23T16:00:00.000Z',
    methodVersion: 'sr-m1',
    adapterVersion: 'pool-1',
    planAuthVersion: 'sr-auth-1',
    generatedBy: 'PRODUCT_SIMULATED',
    sections: [section({ narrative })],
    qaFindings: [], evidenceRefs: null, gate: null, changeSummary: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    publishedAt: '2026-10-26T00:00:00.000Z',
    contentHash: '0'.repeat(64),
  };
}

const msgs: ChatMessage[] = [{
  messageId: 'm1', threadId: 't1', role: 'USER', kind: 'EXPLAIN',
  content: '问<script>alert(1)</script>', citations: [], callId: null, suggestedAction: null,
  createdAt: '2026-10-26T00:00:00.000Z',
}];

it('PR5 版本导航隔离坏旧版，所选有效版与追问/修订版本一致', () => {
  const current = { ...report('第二版有效正文'), version: 2 };
  const invalid = { reportId: current.reportId, version: 1, status: 'PUBLISHED' as const,
    createdAt: current.createdAt, publishedAt: current.publishedAt, unavailableReason: 'SR_REPORT_HASH_MISMATCH' };
  const html = renderReportPage({ report: current, versions: [invalid, current], tablesById: {}, messages: [], csrf: 'synthetic' });
  assert.ok(html.includes('第二版有效正文') && html.includes('v1（材料不可验证）'));
  assert.ok(!html.includes(`href="/reports/${current.reportId}?v=1"`));
  assert.equal((html.match(/name="report_version" value="2"/g) ?? []).length, 2);
  assert.ok(html.includes(`/pdf?v=2`));
});

describe('渲染安全：模型/用户文本不可信', () => {
  it('script 注入被转义（narrative 与用户消息）', () => {
    const doc = report('正文中 <script>alert("x")</script> 与 <img src=x onerror=alert(1)> 结束');
    const html = renderReportPage({ report: doc, versions: [doc], tablesById: {}, messages: msgs, csrf: 'tok' });
    assert.ok(!/<script\b/i.test(html), 'script 开标签不得原样出现');
    assert.ok(!/<img\b/i.test(html), 'img 开标签不得原样出现');
    assert.ok(html.includes('&lt;script&gt;'), '应以转义形式出现');
  });

  it('markdown 加粗/列表受控渲染，不产生新标签注入', () => {
    const out = renderMarkdown('**粗体** 与 `code`\n- 列表项 <b>hi</b>');
    assert.ok(out.includes('<strong>粗体</strong>'), '受控加粗生效');
    assert.ok(!out.includes('<b>hi</b>'), '未转义标签不得透传');
    assert.ok(out.includes('列表项 &lt;b&gt;hi&lt;/b&gt;'), '列表内保持转义');
  });

  it('股票名/错误消息中的尖括号被转义', () => {
    const doc = report('n', '公<司>&"引"');
    const html = renderReportPage({ report: doc, versions: [doc], tablesById: {}, messages: [], csrf: 'x' });
    assert.ok(!html.includes('公<司>'), '股票名尖括号必须转义');
    const err = renderErrorPage(400, '输入包含 <svg onload=alert(1)>');
    assert.ok(!err.includes('<svg'), '错误消息必须转义');
  });

  it('登录页错误提示转义 + CSP 头存在', () => {
    const html = renderLoginPage({ error: '<img src=x onerror=x>' });
    assert.ok(!html.includes('<img'), '登录错误必须转义');
    assert.ok(html.includes('Content-Security-Policy'), 'CSP meta 存在');
  });

  it('生成身份徽章：模拟通道显著提示', () => {
    const doc = report('n');
    const html = renderReportPage({ report: doc, versions: [doc], tablesById: {}, messages: [], csrf: 'x' });
    assert.ok(html.includes('模拟通道生成'), '模拟身份必须显著标注');
  });
});

// ===== C9：首页与报告阅读页布局回归 =====

function srTask(p: Partial<SrTask> = {}): SrTask {
  return {
    taskId: 't0000000-0000-0000-0000-000000000001',
    accountId: 'acc-1',
    subject: '600519',
    subjectName: '贵州茅台',
    focus: 'FULL',
    emphasis: null,
    horizon: 'MID_TERM',
    cutoff: '2026-10-23T16:00:00.000Z',
    status: 'COMPLETED',
    idemKey: 'idem-1',
    revisedFromTaskId: null,
    methodVersion: 'sr-m1',
    adapterVersion: 'pool-1',
    planAuthVersion: 'sr-auth-1',
    error: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    completedAt: '2026-10-26T01:00:00.000Z',
    ...p,
  };
}

const pool = {
  stocks: [
    { code: '600519', name: '贵州茅台', swL1: '食品饮料' },
    { code: '601166', name: '兴业银行', swL1: '银行' },
  ],
  etfs: [{ code: '510300', name: '沪深300ETF' }],
};

function dashboardHtml(tasks: SrTask[], usedTask = 1, usedCall = 20): string {
  return renderDashboard({
    account: { username: 'owner', role: 'ADMIN', displayName: 'Owner' },
    tasks,
    pool,
    csrf: 'tok',
    usage: { period: '2026-10', rows: [{ kind: 'REPORT_TASK', used: usedTask }, { kind: 'MODEL_CALL', used: usedCall }] },
    quota: { monthlyReportTasks: 5, monthlyModelCalls: 60, maxConcurrentTasks: 1 },
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('C9 首页：先发起，再找回', () => {
  it('表单提交语义保留；股票输入显式 type=text；主操作为开始研究', () => {
    const html = dashboardHtml([srTask()]);
    assert.ok(html.includes('<form method="post" action="/tasks"'), '提交地址与方法不变');
    assert.ok(html.includes('name="_csrf"'), 'CSRF 字段保留');
    assert.ok(html.includes('name="subject"') && html.includes('name="focus"') && html.includes('name="horizon"') && html.includes('name="emphasis"'), '字段名保留');
    assert.ok(/<input id="sr-subject"[^>]*type="text"/.test(html), 'subject 输入显式 type=text（命中统一控件样式）');
    assert.ok(html.includes('>开始研究</button>'), '唯一主提交动作为开始研究');
  });

  it('输入示例来自实际支持列表（研究池第一只）；最近研究紧随发起区', () => {
    const html = dashboardHtml([srTask()]);
    assert.ok(html.includes('placeholder="如 600519 或 贵州茅台"'), '示例为池内标的（动态取自池）');
    assert.ok(html.indexOf('id="launch-title"') < html.indexOf('id="recent-title"'), '发起区在前');
    assert.ok(html.indexOf('id="recent-title"') < html.indexOf('支持列表：'), '最近研究先于次级支持列表');
    assert.ok(html.includes('>查看任务</a>'), '任务入口明确写查看任务');
  });

  it('额度与支持列表收纳为次级折叠；用满额度警示在折叠外显著可见', () => {
    const full = dashboardHtml([srTask()], 5, 60); // 用满 5/5 与 60/60
    assert.ok(full.includes('本月研究任务额度已用满（5/5）'), '任务额度用满警示可见');
    assert.ok(full.includes('本月模型调用额度已用满（60/60）'), '调用额度用满警示可见');
    const alertPos = full.indexOf('本月研究任务额度已用满');
    const firstFold = full.indexOf('<details class="sr-card sr-secondary"');
    assert.ok(alertPos > -1 && alertPos < firstFold, '额度警示不在折叠区内');
    const html = dashboardHtml([srTask()]);
    assert.ok(count(html, '<details class="sr-card sr-secondary"') === 2, '支持列表与额度各为次级折叠卡');
  });

  it('空任务诚实空态；管理入口收进次级菜单但保留 ADMIN 分支与 POST 语义', () => {
    const html = dashboardHtml([]);
    assert.ok(html.includes('还没有研究'), '空态说明怎样开始');
    assert.ok(html.includes('<details class="sr-nav-more">'), '次级更多菜单存在');
    assert.ok(html.includes('<a href="/admin">管理</a>'), 'ADMIN 保留管理入口');
    assert.ok(html.includes('action="/logout"') && html.includes('name="_csrf"'), '退出保留 POST + CSRF');
    assert.ok(!html.includes('研究池暂不可用') || pool === null, '池可用时不误报不可用');
  });
});

describe('C9 报告页：结论先读，证据可达', () => {
  const doc = report('本章摘要正文。', '贵州茅台');
  const html = renderReportPage({ report: doc, versions: [doc], tablesById: {}, messages: [], csrf: 'x' });

  it('导出 PDF / 追问 / 修订 三个动作可辨认且绑定原地址', () => {
    assert.ok(html.includes(`href="/reports/${doc.reportId}/pdf?v=1"`), 'PDF 链接绑定版本');
    assert.ok(html.includes('>导出 PDF</a>'), 'PDF 动作有清晰文字');
    assert.ok(html.includes('href="#chat"') && html.includes('>追问</a>'), '追问动作为锚点入口');
    assert.ok(html.includes('href="#revise"') && html.includes('>修订</a>'), '修订动作为锚点入口');
  });

  it('引用默认可见：不折叠进 details，锚点目标直接渲染', () => {
    const s = section({
      key: 'summary',
      narrative: 'n',
      citations: [{ label: '年报', locator: { kind: 'FILE', path: 'docs/annual.md', note: '经营讨论' }, quote: '原文摘录' }],
    });
    const d2 = { ...doc, sections: [s] };
    const h2 = renderReportPage({ report: d2, versions: [d2], tablesById: {}, messages: [], csrf: 'x' });
    assert.ok(h2.includes('id="cite-summary-1"'), '引用锚点目标存在');
    assert.ok(!h2.includes('sr-evidence-drawer'), '证据引用不再折叠（跳转不落空）');
  });

  it('目录锚点齐全（章节+质检+表+追问+修订），桌面与窄屏各一份', () => {
    for (const anchor of ['#sec-summary', '#qa', '#tables']) {
      assert.equal(count(html, `href="${anchor}"`), 2, `${anchor} 应在侧栏与折叠目录各出现一次`);
    }
    for (const anchor of ['#chat', '#revise']) {
      assert.equal(count(html, `href="${anchor}"`), 3, `${anchor} 两份目录 + 报告头动作入口`);
    }
  });

  it('方法/授权版本与哈希收进研究与证据详情；时间标明北京时间并保留原值', () => {
    const detailsPos = html.indexOf('<details class="sr-meta-details"');
    assert.ok(detailsPos > -1, '详情折叠存在');
    assert.ok(html.indexOf('sr-m1') > detailsPos, '方法版本在详情内');
    assert.ok(html.includes('（北京时间）'), '时间标明北京时间');
    assert.ok(html.includes('2026-10-26T00:00:00.000Z'), '精确原值保留');
    const headEnd = html.indexOf('</header>');
    assert.ok(headEnd > -1 && html.slice(0, headEnd).indexOf('（北京时间）') === -1, '报告头保持紧凑，不被时间/版本元数据占据');
    assert.ok(html.slice(0, headEnd).indexOf('sr-m1') === -1, '方法版本不出现在报告头');
  });

  it('追问/修订表单提交语义与字段不变', () => {
    assert.ok(html.includes(`action="/reports/${doc.reportId}/chat"`), '追问提交地址不变');
    assert.ok(html.includes(`action="/reports/${doc.reportId}/revise"`), '修订提交地址不变');
    assert.ok(html.includes('name="question"') && html.includes('name="emphasis"') && html.includes('name="new_cutoff"'), '字段名保留');
  });

  it('发布门未过：受限横幅与承重未解项默认可见；四哈希在详情内且完整', () => {
    const restricted: ReportDocument = {
      ...doc,
      status: 'PUBLISHED_RESTRICTED',
      gate: { mandatoryJDone: true, decisionBearingUnresolved: ['清单项 X1：渠道库存口径未闭环'], passed: false, reason: 'J 遗留承重项' },
      evidenceRefs: { packHash: 'a'.repeat(64), aOutputHash: 'b'.repeat(64), checklistHash: 'c'.repeat(64), jOutputHash: 'd'.repeat(64) },
    };
    const hr = renderReportPage({ report: restricted, versions: [restricted], tablesById: {}, messages: [], csrf: 'x' });
    assert.ok(hr.includes('受限发布'), '受限状态默认可见');
    assert.ok(hr.indexOf('清单项 X1：渠道库存口径未闭环') > -1, '承重未解项具名可见');
    const detailsPos = hr.indexOf('<details class="sr-meta-details"');
    assert.ok(hr.indexOf('清单项 X1：渠道库存口径未闭环') < detailsPos, '未解项在详情折叠之外');
    assert.ok(hr.indexOf('a'.repeat(64)) > detailsPos, '证据四哈希完整收纳于详情');
  });
});


describe('C10 Metis 适配：可读状态与键盘查证', () => {
  it('失败原因取自真实任务并转义，部分完成不冒充报告完成', () => {
    const html = dashboardHtml([srTask({ status: 'FAILED', error: { code: 'E_TEST', message: '<img src=x>失败原文' } }), srTask({ status: 'PARTIAL' })]);
    assert.ok(html.includes('&lt;img src=x&gt;失败原文'));
    assert.ok(html.includes('E_TEST'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('部分完成'));
    assert.equal(count(html, '>查看任务</a>'), 2);
  });

  it('资料不可用在展开之前可见；不宣称当前覆盖可用', () => {
    const html = renderDashboard({ account: { username: 'owner', role: 'USER', displayName: 'Owner' }, tasks: [], pool: null, csrf: 'tok', usage: { period: '2026-10', rows: [] }, quota: { monthlyReportTasks: 5, monthlyModelCalls: 60, maxConcurrentTasks: 1 } });
    assert.ok(html.indexOf('研究池暂不可用，当前无法确认支持范围') < html.indexOf('<details class="sr-card sr-secondary"'));
    assert.ok(!html.includes('href="/admin"'));
  });

  it('完整叙述与 J 改判先于元数据；受限原因保持默认可见且转义', () => {
    const doc = report('J 修正：原承重假设被驳回，当前判断按条件收窄。');
    doc.status = 'PUBLISHED_RESTRICTED';
    doc.gate = { mandatoryJDone: true, passed: false, reason: '<script>未过原因</script>', decisionBearingUnresolved: ['具名未知 X1'] };
    const html = renderReportPage({ report: doc, versions: [doc], tablesById: {}, messages: [], csrf: 'tok' });
    assert.ok(html.indexOf('J 修正：原承重假设被驳回，当前判断按条件收窄。') < html.indexOf('id="research-details"'));
    assert.ok(html.includes('&lt;script&gt;未过原因&lt;/script&gt;'));
    assert.ok(html.indexOf('具名未知 X1') < html.indexOf('id="sec-summary"'));
    assert.ok(html.includes(doc.contentHash));
  });

  it('长表完整值不截断；滚动容器和引用目标可键盘到达', () => {
    const doc = report('正文');
    doc.sections[0]!.tables = ['wide'];
    doc.sections[0]!.citations = [{ label: '原件', locator: { kind: 'FILE', path: 'original.md', note: '原文位置' } }];
    const html = renderReportPage({ report: doc, versions: [doc], tablesById: { wide: { title: '宽表', columns: ['完整金额', '未知值'], rows: [['12345678901234567890', null]], note: '原单位' } }, messages: [], csrf: 'tok' });
    assert.ok(html.includes('12345678901234567890'));
    assert.ok(html.includes('<td>—</td>'));
    assert.ok(html.includes('tabindex="0" role="region" aria-label="宽表"'));
    assert.ok(html.includes('id="cite-summary-1" tabindex="-1"'));
    assert.ok(html.includes('href="#sr-main"'));
    const md = renderMarkdown('|项目|数值|\n|---|---|\n|值|12345678901234567890|');
    assert.ok(md.includes('tabindex="0" role="region"'));
    assert.ok(md.includes('12345678901234567890'));
  });
});

it('派生固定阅读版：C编号跳到实际引用，引用再跳到证据表，完整原表可核对', () => {
  const doc=report('有来源的阅读版');doc.generatedBy='OFFLINE_DERIVED';
  doc.sections[0]!.findings=[{text:'判断',status:'FACT',citations:['C1']}];
  doc.sections[0]!.citations=[{label:'证据',locator:{kind:'COMPUTED',tableId:'proof'}}];
  doc.sections[0]!.tables=['proof'];
  const html=renderReportPage({report:doc,versions:[doc],tablesById:{proof:{title:'证据',columns:['value','sourceUrl'],rows:[['123.000000','https://source']],note:'原单位'}},messages:[],csrf:'none',readOnly:true});
  assert.ok(html.includes('离线派生阅读版'));
  assert.ok(html.includes('href="#cite-summary-1"')&&html.includes('id="cite-summary-1"'));
  assert.ok(html.includes('href="#table-proof"')&&html.includes('id="table-proof"'));
  assert.ok(html.includes('核对完整原表（1 行 · 2 列'));
  assert.ok(html.includes('<th>sourceUrl</th>')&&html.includes('123.000000'));
  assert.ok(!html.includes('<form'));
});
