/**
 * Lyra · Web 看板页面模板单测（W47: code-writer-pro）。
 * 纯函数与正常路由合成查询端口测试（零网络零 DB）：escapeHtml、disposition 语义映射、Metis 布局骨架
 * （.metis-app / sidebar / topbar / app-footer）、三个页面渲染器（数据对象 → HTML）、
 * 标的页标签页与证据抽屉（:target）、注入转义（XSS 防护）、合规标注恒在、无 JS。
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  dispositionLabel,
  escapeHtml,
  renderConclusionsHtml,
  renderErrorPage,
  renderHomePage,
  renderLayout,
  renderSubjectHtml,
  type ConclusionsPageData,
  type HomeData,
  type LayoutOptions,
  type SubjectPageData,
} from './pages.js';
import { buildReportView, type ReportView } from '../research/report.js';
import type { AOutput, ConclusionObject, JOutput } from '../contracts.js';

const H64 = 'a'.repeat(64);

function fakeConclusion(overrides: Partial<ConclusionObject['businessKey']> = {}): ConclusionObject {
  return {
    conclusionId: 'cc-abc123def45678901234567',
    businessKey: {
      subjectKind: 'STOCK',
      subject: '600519',
      researchKind: 'WEEKLY',
      cutoff: '2026-10-23T07:00:00.000Z',
      ...overrides,
    },
    methodVersion: 'method@p2-v1',
    adapterVersion: 'data@p1',
    planAuthVersion: 'pa-gate-m-1',
    disposition: 'ABSTAIN',
    adoption: false,
    evidence: { aOutputHash: H64, checklistHash: H64, jOutputHash: H64, manifestHash: H64 },
    inheritance: null,
    standaloneNote: '无基础结论可继承',
    changeReason: null,
    settlement: { state: 'UNSETTLED' },
    createdAt: '2026-10-25T15:55:20.552Z',
    conclusionHash: H64,
  };
}

function layoutFixture(body = '<p>正文</p>'): LayoutOptions {
  return {
    title: '测试页',
    active: 'home',
    body,
    breadcrumb: { label: '今日研究' },
    versionTag: '研究池 v2 · P5 W1',
    connectionOk: true,
    pendingToday: true,
  };
}

// ===== escapeHtml =====

test('escapeHtml 转义五个 HTML 特殊字符', () => {
  assert.equal(escapeHtml('<script>"a"&\'b\'</script>'), '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;');
});

test('escapeHtml 普通文本与中文原样', () => {
  assert.equal(escapeHtml('贵州茅台 600519'), '贵州茅台 600519');
  assert.equal(escapeHtml(''), '');
});

// ===== disposition 语义映射 =====

test('dispositionLabel：绿/红/灰三分（个股与宽基两套空间）', () => {
  assert.equal(dispositionLabel('RESEARCH_OUTPERFORM').cls, 'green');
  assert.equal(dispositionLabel('RESEARCH_UP').cls, 'green');
  assert.equal(dispositionLabel('RESEARCH_UNDERPERFORM').cls, 'danger');
  assert.equal(dispositionLabel('RESEARCH_DOWN').cls, 'danger');
  assert.equal(dispositionLabel('ABSTAIN').cls, 'neutral');
  assert.ok(dispositionLabel('RESEARCH_OUTPERFORM').text.includes('跑赢'));
  assert.ok(dispositionLabel('ABSTAIN').text.includes('放弃'));
});

// ===== 布局骨架（Metis .metis-app）=====

test('renderLayout：DOCTYPE、标题、侧栏导航、顶栏、页脚合规标注恒在', () => {
  const html = renderLayout(layoutFixture());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>测试页</title>'));
  assert.ok(html.includes('href="/style.css"')); // 样式表（Metis 移植设计系统）
  assert.ok(html.includes('metis-app'));
  assert.ok(html.includes('class="sidebar"'));
  assert.ok(html.includes('brandmark'));
  assert.ok(html.includes('nav-item active')); // active 态
  assert.ok(html.includes('今日研究'));
  assert.ok(html.includes('研究池'));
  assert.ok(html.includes('结论'));
  assert.ok(html.includes('历史'));
  assert.ok(html.includes('系统'));
  assert.ok(html.includes('pending-dot')); // 今日事件 pending 点
  assert.ok(html.includes('class="topbar"'));
  assert.ok(html.includes('class="breadcrumb"'));
  assert.ok(html.includes('version-tag'));
  assert.ok(html.includes('研究池 v2 · P5 W1'));
  assert.ok(html.includes('class="app-footer"'));
  assert.ok(html.includes('个人研究记录，非投资建议'));
  assert.ok(!html.includes('<script')); // 无 JS
  assert.ok(!/<style/.test(html)); // 无内联样式块（只经 /style.css）
});

test('renderLayout：标题经转义', () => {
  const page = layoutFixture();
  page.title = '</title><script>x</script>';
  const html = renderLayout(page);
  assert.ok(!html.includes('</title><script>'));
});

test('renderLayout：连接点降级为 unknown 琥珀', () => {
  const page = layoutFixture();
  page.connectionOk = false;
  const html = renderLayout(page);
  assert.ok(html.includes('connection-dot unknown'));
});

// ===== 首页（今日研究）=====

function homeFixture(): HomeData {
  return {
    nowShanghai: '2026-10-26 10:00:00 +08',
    poolVersion: '2',
    poolFrozenAt: '2026-10-26',
    status: {
      battery: 'GREEN',
      batteryBasis: '绿 = DB 可达 + 最近 install_log 全绿 + 无 UNKNOWN permit',
      factCount: 523272,
      permitsTotal: 5,
      permitsByState: { SUCCEEDED: 3, FAILED: 2 },
      p5Week: 1,
      dbError: null,
    },
    cards: [
      {
        code: '603986',
        name: '兆易创新<script>',
        kind: 'STOCK',
        industry: '电子',
        disposition: 'RESEARCH_OUTPERFORM',
        settlementState: 'UNSETTLED',
        lastResearchAt: '2026-10-25T15:55:20.552Z',
      },
      { code: '510300', name: '沪深300ETF', kind: 'BROAD_ETF', industry: '沪深300(000300)', disposition: null, settlementState: null, lastResearchAt: null },
    ],
    events: [
      { type: 'BUYBACK', label: '回购', today: 2, week: 5 },
      { type: 'REGULATORY_INQUIRY', label: '监管问询', today: 0, week: 3 },
    ],
    eventsTodayTotal: 2,
    eventsWeekTotal: 8,
    rotation: {
      date: '2026-10-26',
      nth: 1,
      subjects: [
        { code: '603986', name: '兆易创新' },
        { code: '002384', name: '东山精密' },
      ],
    },
    rotationNote: null,
  };
}

test('renderHomePage：今日研究面、状态条、事件分色卡、轮转预览、池表', () => {
  const html = renderHomePage(homeFixture());
  assert.ok(html.includes('今日研究'));
  assert.ok(html.includes('事实 523,272'));
  assert.ok(html.includes('permit 5'));
  assert.ok(html.includes('P5 观察第 1 周'));
  assert.ok(html.includes('系统 绿'));
  assert.ok(html.includes('下一晚轮转预览 · 2026-10-26'));
  assert.ok(html.includes('href="/subject/603986"'));
  assert.ok(html.includes('未研究')); // 无结论标的如实呈现
  assert.ok(html.includes('监管问询'));
  assert.ok(html.includes('source-class-card ev-BUYBACK')); // 事件分色卡
  assert.ok(html.includes('source-class-card ev-REGULATORY_INQUIRY'));
  assert.ok(html.includes('id="research-pool"')); // 池锚点（侧栏导航目标）
  assert.ok(html.includes('table-scroll'));
  assert.ok(html.includes('个人研究记录，非投资建议'));
});

test('renderHomePage：DB 来源字符串经转义（XSS 防护）', () => {
  const html = renderHomePage(homeFixture());
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('兆易创新&lt;script&gt;'));
});

test('renderHomePage：DB 不可达降级呈现', () => {
  const data = homeFixture();
  data.status.dbError = 'connection refused';
  data.status.battery = 'RED';
  const html = renderHomePage(data);
  assert.ok(html.includes('DB 不可达'));
  assert.ok(html.includes('系统 红'));
});

test('renderHomePage：轮转不可得时呈现具名原因', () => {
  const data = homeFixture();
  data.rotation = null;
  data.rotationNote = '轮转预览不可得：CALENDAR_RANGE';
  const html = renderHomePage(data);
  assert.ok(html.includes('轮转预览不可得：CALENDAR_RANGE'));
});

// ===== 标的详情（Metis report-reader 形态）=====

function subjectFixture(view: ReportView | null = null): SubjectPageData {
  const conclusion = fakeConclusion();
  const v = view ?? buildReportView(conclusion, null, null, null, null);
  return {
    basic: {
      code: '600519',
      name: '贵州茅台',
      kind: 'STOCK',
      industry: '食品饮料',
      ipoDate: '2001-08-27',
      stStatus: '时点表无行（未命中 ST 公告，按非 ST 呈现）',
      poolVersion: '2',
      poolFrozenAt: '2026-10-26',
      factsCount: 8878,
    },
    conclusions: [
      {
        conclusionId: 'cc-abc123def45678901234567',
        subject: '600519',
        subjectKind: 'STOCK',
        researchKind: 'WEEKLY',
        disposition: 'ABSTAIN',
        settlementState: 'UNSETTLED',
        directionHit: null,
        excessReturn: null,
        tradability: null,
        createdAt: '2026-10-25T15:55:20.552Z',
      },
    ],
    selectedConclusionId: 'cc-abc123def45678901234567',
    tab: 'a',
    view: v,
  };
}

function fullViewFixture(): ReportView {
  const a: AOutput = {
    stage: 'A',
    inputHash: H64,
    subjectKind: 'STOCK',
    candidate: 'RESEARCH_OUTPERFORM',
    decisiveLinks: [
      { text: '决定性连接一 <强>', evidenceArtifactSha256: H64 },
      { text: '决定性连接二', evidenceArtifactSha256: 'b'.repeat(64) },
    ],
    strongestCounter: '最强反证',
    confidence: 'LOW',
    limitations: ['限制一'],
    simulated: true,
  };
  const pkg = {
    packageKind: 'RESEARCH_INPUT',
    seals: [
      { manifestHash: H64, artifactRefs: [{ sha256: H64, bytes: 120, mediaType: 'application/json' }] },
    ],
    materials: [],
    dimensions: [
      { dimension: 1, code: 'FUNDAMENTALS', name: '基本面变化', delivered: ['m1'], demoted: [], gap: [] },
      { dimension: 2, code: 'VALUATION', name: '估值', delivered: [], demoted: ['m2'], gap: ['截点当时申万归属不可得'] },
    ],
    layers: {
      l0: { name: 'L0', budget: 1, bytes: 1, blocks: [] },
      l1: { name: 'L1', budget: 1, bytes: 1, blocks: [] },
      l2: { name: 'L2', budget: 1, bytes: 1, blocks: [] },
    },
    inputHash: H64,
  } as unknown as Parameters<typeof buildReportView>[1];
  return buildReportView(fakeConclusion({ subject: '600519' }), pkg, a, null, null);
}

test('renderSubjectHtml：对象工具条、缺省如实（A/J/清单/包全未读回）', () => {
  const html = renderSubjectHtml(subjectFixture());
  assert.ok(html.includes('贵州茅台'));
  assert.ok(html.includes('2001-08-27'));
  assert.ok(html.includes('食品饮料'));
  assert.ok(html.includes('object-toolbar'));
  assert.ok(html.includes('A 输出未绑定读回')); // A tab 缺省如实
  assert.ok(html.includes('研究链部分绑定')); // 绑定横幅点名各缺段
  assert.ok(html.includes('A 输出未读回'));
  assert.ok(html.includes('程序清单未读回'));
  assert.ok(html.includes('J 输出未读回'));
  assert.ok(html.includes('输入包未读回'));
  assert.ok(html.includes('无输入包可读回——coverage 八维/七维如实缺省，不代填'));
  assert.ok(html.includes('历史结论（1）'));
  assert.ok(html.includes('个人研究记录，非投资建议'));
});

test('renderSubjectHtml：标签页导航 + 默认 A 摘要 + 维度导航左列', () => {
  const html = renderSubjectHtml(subjectFixture(fullViewFixture()));
  assert.ok(html.includes('class="tabs"'));
  assert.ok(html.includes('A 摘要</a>'));
  assert.ok(html.includes('程序清单</a>'));
  assert.ok(html.includes('J 裁决</a>'));
  assert.ok(html.includes('结算</a>'));
  assert.ok(html.includes('aria-current="page"')); // 当前 tab
  assert.ok(html.includes('决定性连接一 &lt;强&gt;')); // A 正文（转义）
  assert.ok(html.includes('dimension-index')); // 维度导航
  assert.ok(html.includes('subject-reading'));
});

test('renderSubjectHtml：证据引用 → :target 抽屉（原件哈希 + 来源）', () => {
  const html = renderSubjectHtml(subjectFixture(fullViewFixture()));
  assert.ok(html.includes('href="#ev-link-0"')); // 引用按钮
  assert.ok(html.includes('id="ev-link-0"')); // 抽屉
  assert.ok(html.includes('evidence-drawer'));
  assert.ok(html.includes('drawer-heading'));
  assert.ok(html.includes('drawer-body'));
  assert.ok(html.includes('命中封存原件目录')); // 命中时的读回状态
  assert.ok(html.includes('[0, 120)')); // 字节区间
  assert.ok(html.includes('未命中封存原件目录')); // 第二条链接未封存，如实呈现
});

test('renderSubjectHtml：tab=checklist / j / settlement 服务端切换', () => {
  const base = subjectFixture(fullViewFixture());
  const cl = renderSubjectHtml({ ...base, tab: 'checklist' });
  assert.ok(cl.includes('程序清单未读回'));
  const j = renderSubjectHtml({ ...base, tab: 'j' });
  assert.ok(j.includes('J 输出未绑定读回'));
  const s = renderSubjectHtml({ ...base, tab: 'settlement' });
  assert.ok(s.includes('结算占位区原值'));
  assert.ok(s.includes('UNSETTLED')); // settlement JSON 原值（引号经 HTML 转义）
});

// ===== 结论列表 =====

function conclusionsFixture(): ConclusionsPageData {
  return {
    rows: [
      {
        conclusionId: 'cc-111111111111111111111111',
        subject: '601318',
        subjectKind: 'STOCK',
        researchKind: 'WEEKLY',
        disposition: 'ABSTAIN',
        settlementState: 'UNSETTLED',
        directionHit: null,
        excessReturn: null,
        tradability: null,
        createdAt: '2026-10-25T15:55:20.552Z',
      },
      {
        conclusionId: 'cc-222222222222222222222222',
        subject: '002384',
        subjectKind: 'STOCK',
        researchKind: 'WEEKLY',
        disposition: 'RESEARCH_UNDERPERFORM',
        settlementState: 'SETTLED',
        directionHit: 'true',
        excessReturn: '0.031200000000',
        tradability: 'T1_NORMAL',
        createdAt: '2026-10-26T01:23:51.860Z',
      },
    ],
    total: 52,
    page: 2,
    pageSize: 50,
    filters: { kind: 'STOCK', disposition: null, settlement: 'UNSETTLED' },
    poolVersion: '2',
  };
}

test('renderConclusionsHtml：表行、筛选选中态、分页链接、合规标注', () => {
  const html = renderConclusionsHtml(conclusionsFixture());
  assert.ok(html.includes('结论'));
  assert.ok(html.includes('共 52 条'));
  assert.ok(html.includes('第 2 / 2 页'));
  assert.ok(html.includes('href="/conclusions?kind=STOCK&amp;settlement=UNSETTLED"')); // 上一页（page=1 省略）保留筛选
  assert.ok(html.includes('value="STOCK" selected'));
  assert.ok(html.includes('value="UNSETTLED" selected'));
  assert.ok(html.includes('命中'));
  assert.ok(html.includes('0.031200000000'));
  for (const c of conclusionsFixture().rows) {
    assert.ok(html.includes(`href="/subject/${c.subject}?c=${encodeURIComponent(c.conclusionId)}"`));
  }
  assert.ok(html.includes('个人研究记录，非投资建议'));
});

test('renderConclusionsHtml：已结算筛选 → 历史导航态', () => {
  const data = conclusionsFixture();
  data.filters = { kind: null, disposition: null, settlement: 'SETTLED' };
  const html = renderConclusionsHtml(data);
  assert.ok(html.includes('已结算历史'));
});

test('I-18 历史列表两种链接经正常路由选择原结论，同股新结论不替换旧报告（合成查询端口，非 SQL 验证）', async () => {
  const { handleRequest } = await import('./server.js');
  const older = { ...fakeConclusion(), conclusionId: 'cc-111111111111111111111111' };
  const latest = { ...fakeConclusion({ cutoff: '2026-10-30T07:00:00.000Z' }),
    conclusionId: 'cc-222222222222222222222222', createdAt: '2026-11-01T00:00:00.000Z' };
  const rows = [latest, older].map((c) => ({
    conclusion_id: c.conclusionId, business_key: c.businessKey, method_version: c.methodVersion,
    adapter_version: c.adapterVersion, plan_auth_version: c.planAuthVersion, disposition: c.disposition,
    adoption: false, evidence: c.evidence, inheritance: c.inheritance, standalone_note: c.standaloneNote,
    change_reason: c.changeReason, settlement: c.settlement, created_at: new Date(c.createdAt), conclusion_hash: c.conclusionHash,
    subject: c.businessKey.subject, subject_kind: 'STOCK', research_kind: 'WEEKLY', settlement_state: 'UNSETTLED',
    direction_hit: null, excess_return: null, tradability: null,
  }));
  const selectedIds: string[] = [];
  const deps = {
    pool: { query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('from conclusion where conclusion_id = $1')) {
        selectedIds.push(String(values[0])); return { rows: rows.filter((r) => r.conclusion_id === values[0]) };
      }
      if (sql.includes('count(*)::text as n from conclusion')) return { rows: [{ n: '2' }] };
      if (sql.includes('from conclusion')) return { rows };
      if (sql.includes('count(*)::text as n from pintime_fact')) return { rows: [{ n: '0' }] };
      if (sql.includes('from pintime_fact') || sql.includes('from st_status_timeline')) return { rows: [] };
      throw new Error(`Unsupported synthetic query: ${sql}`);
    } },
    poolInfo: { version: 'synthetic', frozenAt: '2026-10-01', stocks: [{ code: '600519', name: '公开合成公司', swL1Name: '未验证' }], etfs: [] },
    invocations: { sourcesFor: async () => ({ aByHash: new Map(), jByHash: new Map() }) },
    packages: { boundPackage: async () => null },
  } as unknown as import('./server.js').WebDeps;
  const list = await handleRequest(deps, 'GET', '/conclusions');
  assert.equal(list.status, 200);
  const hrefs = [...list.body.matchAll(/href="(\/subject\/600519\?c=cc-[a-zA-Z0-9]+)"/g)].map((m) => m[1]!);
  assert.equal(hrefs.length, 4, '每行股票和报告两个入口');
  const oldLinks = hrefs.filter((href) => href.endsWith(older.conclusionId));
  assert.equal(oldLinks.length, 2);
  for (const href of oldLinks) {
    const report = await handleRequest(deps, 'GET', href);
    assert.equal(report.status, 200);
    assert.ok(report.body.includes(`研究报告 · 结论 ${older.conclusionId} · 资料截点 ${older.businessKey.cutoff}`));
    assert.ok(!report.body.includes(`研究报告 · 结论 ${latest.conclusionId}`));
  }
  assert.deepEqual(selectedIds, [older.conclusionId, older.conclusionId]);
  const defaultReport = await handleRequest(deps, 'GET', '/subject/600519');
  assert.equal(defaultReport.status, 200);
  assert.ok(defaultReport.body.includes(`研究报告 · 结论 ${latest.conclusionId}`));
});

test('renderConclusionsHtml：无匹配如实呈现', () => {
  const data = conclusionsFixture();
  data.rows = [];
  data.total = 0;
  data.page = 1;
  const html = renderConclusionsHtml(data);
  assert.ok(html.includes('无匹配结论'));
});

// ===== 错误页 =====

test('renderErrorPage：具名原因且不泄露堆栈', () => {
  const html = renderErrorPage(404, '未知路径：/x<y>');
  assert.ok(html.includes('404'));
  assert.ok(html.includes('未知路径：/x&lt;y&gt;'));
  assert.ok(html.includes('status-banner error'));
});
