/**
 * Lyra · 本地 Web 看板页面模板（W47: code-writer-pro）。
 * 设计系统：照 Metis 桌面应用移植（metis/apps/ui/src/style.css + report-reader）——
 * 布局骨架 `.metis-app`（sidebar / topbar / main / app-footer grid）、色板与组件类名
 * 见 src/web/style.css（零新依赖，无 JS，无外部 CDN；样式只经 /style.css 引入）。
 *
 * 形态对应（Metis → Lyra）：
 * - 侧栏 `.brand .brandmark .nav-scroll .nav-item(.active) .pending-dot .side-foot`
 * - 顶栏 `.topbar .breadcrumb .breadcrumb-object .version-tag .top-actions .icon-button`
 * - 主面 `.main .surface-slot .surface .surface-header .surface-actions .status-banner
 *   .empty-state .table-scroll .tabs .pill .metadata .pagination .section-heading`
 * - 标的页照 report-reader：左列维度导航（.dimension-index）→ 右列分段正文；
 *   A/程序清单/J/结算服务端标签页（?t=）；证据引用点开纯 CSS :target 抽屉
 *   （.evidence-drawer，零 JS 的 dialog 等价形态）显示原件哈希 + 字节区间 + 来源。
 *
 * 本模块只做纯渲染：数据对象（server.ts 组装，全部来自只读 DB 查询 / 冻结池文件 /
 * 哈希绑定的轮产物读回）→ HTML 字符串。所有 DB 来源字符串经 escapeHtml 再嵌入；
 * 展示层不改变任何业务语义（disposition/结算状态原码呈现 + 中文注记）。
 *
 * 合规标注（PLAN §9 / RM §8）：看板一切页面 app-footer 恒为"个人研究记录，非投资建议"。
 */
import { REPORT_DISCLAIMER } from '../research/report.js';
import type { ReportView } from '../research/report.js';
import type { DimensionCoverage } from '../research/inputs.js';

// ===== 通用 =====

/** HTML 转义：所有来自 DB / 文件的字符串嵌入 HTML 前必经。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 日期时间显示（ISO → 本地可读，失败原样返回）。 */
function fmtDateTime(iso: string | null): string {
  if (iso === null) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  return iso.slice(0, 10);
}

function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 原码 + 中文注记（注记来自合同枚举，不来自 DB）。cls 对应 .pill 状态色。 */
export function dispositionLabel(disposition: string): { text: string; cls: string } {
  switch (disposition) {
    case 'RESEARCH_OUTPERFORM':
      return { text: '跑赢 RESEARCH_OUTPERFORM', cls: 'green' };
    case 'RESEARCH_UNDERPERFORM':
      return { text: '跑输 RESEARCH_UNDERPERFORM', cls: 'danger' };
    case 'RESEARCH_UP':
      return { text: '看涨 RESEARCH_UP', cls: 'green' };
    case 'RESEARCH_DOWN':
      return { text: '看跌 RESEARCH_DOWN', cls: 'danger' };
    default:
      return { text: '放弃 ABSTAIN', cls: 'neutral' };
  }
}

/** 简短版（首页池表用）。 */
function dispositionShort(disposition: string): { text: string; cls: string } {
  const full = dispositionLabel(disposition);
  return { text: full.text.split(' ')[0] ?? full.text, cls: full.cls };
}

/** 结算状态：已结算=蓝（fact，与研究绿区分——Evidence State Rule）、未结算=琥珀、异常=红。 */
export function settlementLabel(state: string | null): { text: string; cls: string } {
  switch (state) {
    case 'SETTLED':
      return { text: '已结算', cls: 'fact' };
    case 'ANOMALY':
      return { text: '结算异常', cls: 'danger' };
    default:
      return { text: '未结算', cls: 'warn' };
  }
}

/** J 裁决 → pill 色。 */
function verdictLabel(verdict: string | null): { text: string; cls: string } {
  switch (verdict) {
    case 'SUPPORTED':
      return { text: 'SUPPORTED 支持', cls: 'green' };
    case 'NARROWED':
      return { text: 'NARROWED 收窄', cls: 'warn' };
    case 'REJECTED':
      return { text: 'REJECTED 驳回', cls: 'danger' };
    case 'UNRESOLVED':
      return { text: 'UNRESOLVED 未决', cls: 'neutral' };
    default:
      return { text: '未裁决', cls: 'neutral' };
  }
}

function pill(text: string, cls: string, title?: string): string {
  return `<span class="pill ${cls}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>${escapeHtml(text)}</span>`;
}

/** canonical 哈希短形芯片（title 携全值）。 */
function hashChip(hash: string, label: string): string {
  return `<span class="hash" title="${escapeHtml(hash)}">${escapeHtml(label)} ${escapeHtml(hash.slice(0, 16))}…</span>`;
}

// ===== 数据形状（server.ts 组装；渲染只读）=====

export interface SubjectCardData {
  code: string;
  name: string;
  kind: 'STOCK' | 'BROAD_ETF';
  /** 个股 = 冻结池申万 L1 名；宽基 = 跟踪指数说明。 */
  industry: string | null;
  disposition: string | null;
  settlementState: string | null;
  lastResearchAt: string | null;
}

export interface EventPanelRow {
  type: string;
  label: string;
  today: number;
  week: number;
}

export interface RotationPreviewData {
  date: string;
  nth: number;
  subjects: { code: string; name: string }[];
}

export interface SystemStatusData {
  /** 绿 = DB 可达 + 最近 install_log 全绿 + 无 UNKNOWN permit。 */
  battery: 'GREEN' | 'RED';
  batteryBasis: string;
  factCount: number;
  permitsTotal: number;
  permitsByState: Record<string, number>;
  p5Week: number;
  dbError: string | null;
}

export interface HomeData {
  nowShanghai: string;
  poolVersion: string;
  poolFrozenAt: string;
  status: SystemStatusData;
  cards: SubjectCardData[];
  events: EventPanelRow[];
  eventsTodayTotal: number;
  eventsWeekTotal: number;
  rotation: RotationPreviewData | null;
  rotationNote: string | null;
}

export interface SubjectBasicData {
  code: string;
  name: string;
  kind: 'STOCK' | 'BROAD_ETF';
  industry: string | null;
  ipoDate: string | null;
  stStatus: string;
  poolVersion: string;
  poolFrozenAt: string;
  factsCount: number;
}

export interface ConclusionRowData {
  conclusionId: string;
  subject: string;
  subjectKind: string;
  researchKind: string;
  disposition: string;
  settlementState: string | null;
  directionHit: string | null;
  excessReturn: string | null;
  tradability: string | null;
  createdAt: string;
}

/** 标的页标签页（服务端渲染，?t= 白名单）。 */
export type SubjectTab = 'a' | 'checklist' | 'j' | 'settlement';

export interface SubjectPageData {
  basic: SubjectBasicData;
  conclusions: ConclusionRowData[];
  selectedConclusionId: string | null;
  tab: SubjectTab;
  /** 选定结论的视图（结论行必在；A/清单/J/包缺则视图内为 null，如实呈现）。 */
  view: ReportView | null;
}

export interface ConclusionsPageData {
  rows: ConclusionRowData[];
  total: number;
  page: number;
  pageSize: number;
  filters: { kind: string | null; disposition: string | null; settlement: string | null };
  poolVersion: string;
}

// ===== 布局骨架（Metis .metis-app）=====

export type NavKey = 'home' | 'pool' | 'conclusions' | 'history' | 'status';

export interface Breadcrumb {
  label: string;
  href?: string;
  object?: string;
}

export interface LayoutOptions {
  title: string;
  active: NavKey;
  body: string;
  breadcrumb: Breadcrumb;
  /** 顶栏版本标签（如 研究池 v2 · P5 W1；缺省不渲染）。 */
  versionTag?: string | undefined;
  /** side-foot 连接点：绿 = 本请求 DB 读回成功；false → unknown 琥珀。 */
  connectionOk: boolean;
  /** 今日研究导航 pending-dot（首页事件面板今日计数 > 0 时点亮）。 */
  pendingToday?: boolean | undefined;
}

const ICON = {
  calendar:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg>',
  grid: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l2 2 3.6-4"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.5 1.8"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/></svg>',
  doc: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 2v3.2h3.4M6 8.5h4M6 11h4"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  pulse: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8h3l2-5 3 10 2-5h3"/></svg>',
  ok: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.4"/><path d="M5.2 8.3l2 2 3.6-4.2"/></svg>',
  warn: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2l6.2 11H1.8z"/><path d="M8 6.4v3.2M8 11.6v.4"/></svg>',
  empty: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
};

const NAV: { key: NavKey; href: string; label: string; icon: string }[] = [
  { key: 'home', href: '/', label: '今日研究', icon: ICON.calendar },
  { key: 'pool', href: '/#research-pool', label: '研究池', icon: ICON.grid },
  { key: 'conclusions', href: '/conclusions', label: '结论', icon: ICON.check },
  { key: 'history', href: '/conclusions?settlement=SETTLED', label: '历史', icon: ICON.clock },
  { key: 'status', href: '/api/status', label: '系统', icon: ICON.gear },
];

const BRANDMARK =
  '<svg viewBox="0 0 20 22" width="19" height="21" fill="none" stroke="white" stroke-width="1.5" aria-hidden="true"><path d="M6 3v3M6 15v4M14 1v4M14 13v5"/><rect x="3.5" y="6" width="5" height="9" rx="1"/><rect x="11.5" y="5" width="5" height="8" rx="1"/></svg>';

/** 页面骨架（照 Metis .metis-app：sidebar / topbar / main / app-footer）。 */
export function renderLayout(page: LayoutOptions): string {
  const crumbs = page.breadcrumb;
  const crumbLabel =
    crumbs.href === undefined
      ? `<strong>${escapeHtml(crumbs.label)}</strong>`
      : `<a class="text-button" href="${escapeHtml(crumbs.href)}">${escapeHtml(crumbs.label)}</a>`;
  const object =
    crumbs.object === undefined
      ? ''
      : `${ICON.chevron}<strong class="breadcrumb-object">${escapeHtml(crumbs.object)}</strong>`;
  const nav = NAV.map((item) => {
    const pending = item.key === 'home' && page.pendingToday === true ? '<span class="pending-dot" title="今日有事件"></span>' : '';
    return `<a class="nav-item${page.active === item.key ? ' active' : ''}" href="${escapeHtml(item.href)}"${
      page.active === item.key ? ' aria-current="page"' : ''
    }>${item.icon}<span>${escapeHtml(item.label)}</span>${pending}</a>`;
  })
    .join('\n      ');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip-link" href="#main">跳到正文</a>
<div class="metis-app">
  <aside class="sidebar">
    <div class="brand">
      <span class="brandmark">${BRANDMARK}</span>
      <div><strong>Lyra</strong><small>A 股研究 · P5</small></div>
    </div>
    <nav class="nav-scroll" aria-label="主导航">
      <div class="nav-label">研究</div>
      ${nav}
    </nav>
    <div class="side-foot">
      <span class="connection-dot${page.connectionOk ? '' : ' unknown'}"${page.connectionOk ? '' : ' title="读回降级"'}></span>
      <span class="side-status">只读看板 · 127.0.0.1:3456</span>
    </div>
  </aside>
  <header class="topbar">
    <nav class="breadcrumb" aria-label="当前位置">
      ${ICON.doc}
      ${crumbLabel}
      ${object}
      ${page.versionTag === undefined ? '' : `<span class="version-tag">${escapeHtml(page.versionTag)}</span>`}
    </nav>
    <div class="top-actions">
      <a class="icon-button" href="/api/status" title="系统状态 JSON">${ICON.pulse}</a>
    </div>
  </header>
  <main class="main" id="main">
    <div class="surface-slot">
      <div class="surface">
${page.body}
      </div>
    </div>
  </main>
  <footer class="app-footer">
    <span>Lyra · ${escapeHtml(REPORT_DISCLAIMER)} · 本地研究工具，不提供投资建议，不对外分享结论</span>
    <span>数据仅供个人使用，原件不外传 · 只读看板</span>
  </footer>
</div>
</body>
</html>
`;
}

// ===== 首页（今日研究）=====

function statusBanner(status: SystemStatusData): string {
  if (status.dbError !== null) {
    return `<div class="status-banner error">${ICON.warn}
  <p><strong>系统 红 · DB 不可达：${escapeHtml(status.dbError)}</strong>（以下计数为降级呈现，不做代填）</p>
</div>`;
  }
  const states = Object.entries(status.permitsByState)
    .map(([k, v]) => `${escapeHtml(k)} ${String(v)}`)
    .join(' · ');
  const tone = status.battery === 'GREEN' ? '' : ' warning';
  const icon = status.battery === 'GREEN' ? ICON.ok : ICON.warn;
  return `<div class="status-banner${tone}">${icon}
  <p>系统 ${status.battery === 'GREEN' ? '绿' : '红'} · 事实 ${fmtInt(status.factCount)} · permit ${String(status.permitsTotal)}（${states}）· P5 观察第 ${String(status.p5Week)} 周</p>
  <p class="muted">${escapeHtml(status.batteryBasis)}</p>
</div>`;
}

function renderEventCard(row: EventPanelRow): string {
  return `<div class="source-class-card ev-${escapeHtml(row.type)}">
  <span>${escapeHtml(row.label)} · 本周起</span>
  <strong>${String(row.week)}</strong>
  <p>今日 ${String(row.today)} 起（上海时区口径）</p>
  <small>${escapeHtml(row.type)}</small>
</div>`;
}

function renderHome(data: HomeData): string {
  const stockCount = data.cards.filter((c) => c.kind === 'STOCK').length;
  const etfCount = data.cards.length - stockCount;

  const rotation =
    data.rotation === null
      ? `<p class="muted">${escapeHtml(data.rotationNote ?? '轮转预览不可得')}</p>`
      : `<p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${data.rotation.subjects
          .map((s) => `<a class="pill green" href="/subject/${escapeHtml(s.code)}">${escapeHtml(s.name)} ${escapeHtml(s.code)}</a>`)
          .join('\n      ')}</p>
  <p class="muted small">周内第 ${String(data.rotation.nth)} 个交易日晚 · 轮转映射 = 研究池顺序 × 交易日晚（W17 固定映射，不含跨周补齐）</p>`;

  const poolRows = data.cards
    .map((card) => {
      const disp = card.disposition === null ? pill('未研究', 'neutral') : pill(dispositionShort(card.disposition).text, dispositionShort(card.disposition).cls);
      const settle = settlementLabel(card.settlementState);
      const industry = card.industry ?? (card.kind === 'STOCK' ? '—' : '宽基 ETF');
      return `<tr>
  <td><a class="text-button mono" href="/subject/${escapeHtml(card.code)}">${escapeHtml(card.code)}</a></td>
  <td><a class="text-button" href="/subject/${escapeHtml(card.code)}">${escapeHtml(card.name)}</a></td>
  <td>${escapeHtml(industry)}</td>
  <td>${card.kind === 'STOCK' ? '个股' : '宽基'}</td>
  <td>${disp}</td>
  <td>${pill(settle.text, settle.cls)}</td>
  <td><small>${escapeHtml(fmtDateTime(card.lastResearchAt))}</small></td>
  <td class="cell-actions"><a class="text-button" href="/subject/${escapeHtml(card.code)}">报告 →</a></td>
</tr>`;
    })
    .join('\n');

  return `<div class="surface-header">
  <div>
    <h1>今日研究</h1>
    <p>上海时间 ${escapeHtml(data.nowShanghai)} · 研究池 v${escapeHtml(data.poolVersion)}（冻结于 ${escapeHtml(data.poolFrozenAt)}）· ${String(stockCount)} 个股 + ${String(etfCount)} 宽基 · P5 前瞻观察期（三不改）</p>
  </div>
  <div class="surface-actions">
    <a class="button" href="/conclusions">全部结论</a>
  </div>
</div>
${statusBanner(data.status)}
<section id="rotation" style="margin-bottom:24px">
  <div class="section-heading">
    <h2>下一晚轮转预览 · ${escapeHtml(data.rotation?.date ?? '不可得')}</h2>
  </div>
  ${rotation}
</section>
<section id="events" style="margin-bottom:24px">
  <div class="section-heading">
    <h2>事件面板</h2>
    <span class="muted small">今日 ${String(data.eventsTodayTotal)} 起 · 本周 ${String(data.eventsWeekTotal)} 起（上海时区口径）</span>
  </div>
  <div class="source-class-grid">
    ${data.events.map(renderEventCard).join('\n    ')}
  </div>
</section>
<section id="research-pool">
  <div class="section-heading">
    <h2>研究池 · ${String(data.cards.length)} 标的</h2>
    <span class="muted small">颜色语义：绿 = 跑赢/看涨 · 红 = 跑输/看跌 · 灰 = 放弃（ABSTAIN）/ 未研究</span>
  </div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>代码</th><th>名称</th><th>申万 L1 / 跟踪</th><th>类别</th><th>研究判断</th><th>结算</th><th>上次研究</th><th>报告</th></tr></thead>
      <tbody>
${poolRows}
      </tbody>
    </table>
  </div>
</section>`;
}

// ===== 标的详情（照 Metis report-reader）=====

interface DrawerEntry {
  anchorId: string;
  title: string;
  subtitle: string;
  rows: [string, string][];
}

/** 从视图生成证据抽屉条目：A 决定性连接引用 + 送达事实引用（各含哈希/区间/来源）。 */
function drawerEntries(view: ReportView): { entries: DrawerEntry[]; factCount: number } {
  const entries: DrawerEntry[] = [];
  const dd = view.evidenceDrillDown;
  view.aSummary?.decisiveLinks.forEach((link, i) => {
    const hit = dd?.artifacts[link.evidenceArtifactSha256];
    entries.push({
      anchorId: `ev-link-${String(i)}`,
      title: `A 决定性连接 ${String(i + 1)} 引用的原件`,
      subtitle: 'A 输出 decisiveLinks · evidenceArtifactSha256',
      rows: [
        ['原件 sha256', link.evidenceArtifactSha256],
        ['读回状态', hit === undefined ? '未命中封存原件目录（本包内不可读回，如实呈现缺）' : '命中封存原件目录'],
        ['字节数', hit === undefined ? '—' : `${String(hit.bytes)} B（${hit.mediaType}）`],
        ['字节区间', hit === undefined ? '—（原件未封存，无区间可给）' : '[0, ' + String(hit.bytes) + ')（P2 全区间——事实未记录原件内偏移）'],
        ['来源', 'A 摘要 · 决定性连接 ' + String(i + 1)],
      ].map(([k, v]) => [k, v === null || v === undefined ? '—' : String(v)] as [string, string]),
    });
  });
  let factCount = 0;
  if (dd !== null) {
    const facts = Object.values(dd.byFactId);
    factCount = facts.length;
    facts.slice(0, 60).forEach((fact, i) => {
      const art = dd.artifacts[fact.artifactSha256];
      entries.push({
        anchorId: `ev-fact-${String(i)}`,
        title: `送达事实 ${fact.factId}`,
        subtitle: '输入包 INDEX · deliveredFacts',
        rows: [
          ['factId', fact.factId],
          ['原件 sha256', fact.artifactSha256],
          ['字节数 / 类型', `${String(fact.artifactBytes)} B（${art?.mediaType ?? '未知 mediaType'}）`],
          ['字节区间', `[${String(fact.byteRange.start)}, ${String(fact.byteRange.end)})（P2 全区间——事实未记录原件内偏移）`],
          ['送达', fact.deliveredIn === null ? '—' : `${fact.deliveredIn.materialId} / ${fact.deliveredIn.layer}`],
        ].map(([k, v]) => [k, v === null || v === undefined ? '—' : String(v)] as [string, string]),
      });
    });
  }
  return { entries, factCount };
}

function renderDrawers(entries: readonly DrawerEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map(
      (e) => `<div class="evidence-drawer" id="${escapeHtml(e.anchorId)}">
  <a class="drawer-backdrop" href="#reading" aria-label="关闭证据抽屉"></a>
  <section class="drawer-card" role="dialog" aria-label="${escapeHtml(e.title)}">
    <header class="drawer-heading">
      <div>
        <h2>${escapeHtml(e.title)}</h2>
        <p>${escapeHtml(e.subtitle)}</p>
      </div>
      <a class="icon-button" href="#reading" aria-label="关闭">${ICON.chevron}</a>
    </header>
    <div class="drawer-body">
      <dl class="metadata">
${e.rows.map(([k, v]) => `        <div><dt>${escapeHtml(k)}</dt><dd class="hash">${escapeHtml(v)}</dd></div>`).join('\n')}
      </dl>
      <p class="muted small">只读呈现：哈希与区间为封存读回原值，本页不重算、不代填。</p>
    </div>
  </section>
</div>`,
    )
    .join('\n');
}

function emptyState(text: string): string {
  return `<div class="empty-state">${ICON.empty}<p>${escapeHtml(text)}</p></div>`;
}

function dimensionDotClass(d: DimensionCoverage): string {
  if (d.delivered.length === 0) return 'off';
  if (d.gap.length > 0 || d.demoted.length > 0) return 'warn';
  return 'ok';
}

function renderDimensionRail(view: ReportView | null): string {
  const dims = view?.inputCoverage?.dimensions ?? null;
  const index =
    dims === null
      ? `<p class="muted small">无输入包可读回——维度导航缺省，不代填</p>`
      : `<nav class="dimension-index" aria-label="维度导航">
      <div><strong>${dims.length === 7 ? '七维覆盖（宽基）' : '八维覆盖（个股）'}</strong>
${dims
  .map(
    (d) =>
      `        <a href="#dim-${String(d.dimension)}"><i class="dot ${dimensionDotClass(d)}"></i>${String(d.dimension)} · ${escapeHtml(d.name)}</a>`,
  )
  .join('\n')}
      </div>
    </nav>`;

  const roleRow = (symbol: string, name: string, bound: boolean, note: string, missClass = true): string =>
    `<div class="rail-role"><span class="role-symbol${bound || !missClass ? '' : ' miss'}">${escapeHtml(symbol)}</span><div><strong>${escapeHtml(name)}</strong><p>${bound ? '已绑定读回' : '未读回'} · ${escapeHtml(note)}</p></div></div>`;

  const roles = view === null
    ? '<p class="muted small">无结论可读回</p>'
    : [
        roleRow('A', '分析输出', view.aSummary !== null, view.conclusion.evidence.aOutputHash.slice(0, 12) + '…'),
        roleRow('C', '程序清单', view.checklist !== null, view.conclusion.evidence.checklistHash.slice(0, 12) + '…'),
        roleRow('J', '裁决输出', view.j !== null, view.conclusion.evidence.jOutputHash.slice(0, 12) + '…'),
        roleRow('P', '输入包', view.inputCoverage !== null, view.conclusion.evidence.manifestHash.slice(0, 12) + '…'),
      ].join('\n    ');

  return `${index}
  <section class="rail-roles" aria-label="研究链读回">
    <h3>研究链读回</h3>
    ${roles}
    <p class="muted small" style="margin-top:10px">绑定口径：A/J 按 canonicalSha256 命中才采用；清单由 A 机械重导出并校验 checklistHash；输入包按 manifestHash 绑定。</p>
  </section>`;
}

function renderDimensionArticles(view: ReportView | null): string {
  const cov = view?.inputCoverage ?? null;
  if (cov === null || cov.dimensions.length === 0) {
    return emptyState('无输入包可读回——coverage 八维/七维如实缺省，不代填');
  }
  const layers =
    cov.layers === null
      ? ''
      : `<p class="muted small">输入包 ${cov.inputHash === null ? 'inputHash 缺' : `<span class="hash" title="${escapeHtml(String(cov.inputHash))}">${escapeHtml(String(cov.inputHash).slice(0, 16))}…</span>`} · 分层 ${cov.layers.l0.name} ${String(cov.layers.l0.bytes)}B / ${cov.layers.l1.name} ${String(cov.layers.l1.bytes)}B / ${cov.layers.l2.name} ${String(cov.layers.l2.bytes)}B</p>`;
  const articles = cov.dimensions
    .map((d) => {
      const dot = dimensionDotClass(d);
      const pillRow = `<p class="dim-pills">${pill(`送达 ${String(d.delivered.length)}`, dot === 'ok' ? 'green' : dot === 'warn' ? 'warn' : 'neutral')}${d.demoted.length > 0 ? pill(`降级 ${String(d.demoted.length)}`, 'warn') : ''}${
        d.gap.length > 0 ? pill(`缺口 ${String(d.gap.length)}`, 'neutral') : pill('无缺口', 'green')
      }</p>`;
      const delivered =
        d.delivered.length === 0
          ? ''
          : `<details><summary>送达材料（${String(d.delivered.length)}）</summary><ul class="limit-list">${d.delivered.map((m) => `<li class="hash">${escapeHtml(m)}</li>`).join('')}</ul></details>`;
      const demoted =
        d.demoted.length === 0
          ? ''
          : `<details><summary>降级材料（${String(d.demoted.length)}）</summary><ul class="limit-list">${d.demoted.map((m) => `<li class="hash">${escapeHtml(m)}</li>`).join('')}</ul></details>`;
      const gaps =
        d.gap.length === 0
          ? ''
          : `<details open><summary>缺口（${String(d.gap.length)}，如实呈现）</summary><ul class="limit-list">${d.gap.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul></details>`;
      return `<article class="dimension-article" id="dim-${String(d.dimension)}">
  <h4>${String(d.dimension)} · ${escapeHtml(d.name)}<small>${escapeHtml(d.code)}</small></h4>
  ${pillRow}
  ${delivered}
  ${demoted}
  ${gaps}
</article>`;
    })
    .join('\n');
  return `${layers}
${articles}`;
}

function tabHref(code: string, conclusionId: string | null, tab: SubjectTab): string {
  const params = new URLSearchParams();
  if (conclusionId !== null) params.set('c', conclusionId);
  params.set('t', tab);
  return `/subject/${escapeHtml(code)}?${escapeHtml(params.toString())}`;
}

function renderTabA(view: ReportView): string {
  const a = view.aSummary;
  if (a === null) {
    return emptyState('A 输出未绑定读回（canonicalSha256 未命中 var/sol-invocations）——如实呈现缺，不代填');
  }
  const dd = view.evidenceDrillDown;
  const links = a.decisiveLinks
    .map((link, i) => {
      const resolvable = view.evidenceDrillDown?.aEvidenceResolvable?.[i];
      const resolvePill =
        resolvable === undefined ? '' : resolvable ? pill('引用可解析', 'green') : pill('引用未命中封存目录', 'danger');
      return `<article class="reading-feature">
  <h4>决定性连接 ${String(i + 1)}</h4>
  <p>${escapeHtml(link.text)}</p>
  <p class="muted small">${hashChip(link.evidenceArtifactSha256, '证据原件')} ${resolvePill} <a class="metis-reading-citation" href="#ev-link-${String(i)}">核对原件 ${String(i + 1)}</a></p>
</article>`;
    })
    .join('\n');
  const limitations =
    a.limitations.length === 0
      ? '<p class="muted small">A 原件未列限制</p>'
      : `<ul class="limit-list">${a.limitations.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;

  const factsTable =
    dd === null
      ? '<p class="muted small">无输入包可读回——证据引用目录缺省，不代填</p>'
      : (() => {
          const facts = Object.values(dd.byFactId);
          if (facts.length === 0) return '<p class="muted small">输入包 INDEX 无送达事实条目</p>';
          const rows = facts
            .slice(0, 60)
            .map(
              (f, i) =>
                `<tr>
  <td class="hash">${escapeHtml(f.factId)}</td>
  <td class="hash" title="${escapeHtml(f.artifactSha256)}">${escapeHtml(f.artifactSha256.slice(0, 16))}…</td>
  <td class="mono">[${String(f.byteRange.start)}, ${String(f.byteRange.end)})</td>
  <td class="mono">${escapeHtml(f.deliveredIn === null ? '—' : `${f.deliveredIn.materialId}/${f.deliveredIn.layer}`)}</td>
  <td class="cell-actions"><a class="metis-reading-citation" href="#ev-fact-${String(i)}">核对</a></td>
</tr>`,
            )
            .join('\n');
          const more =
            facts.length > 60
              ? `<p class="muted small">其余 ${String(facts.length - 60)} 条见输入包 L2 索引（本页截断呈现，不改变封存事实）</p>`
              : '';
          return `<div class="table-scroll"><table>
  <thead><tr><th>factId</th><th>原件 sha256</th><th>字节区间</th><th>送达</th><th>原件</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>
${more}
<p class="muted small">封存原件目录 ${String(Object.keys(dd.artifacts).length)} 个 · 区间为 P2 全区间（事实未记录原件内偏移，如实标注）</p>`;
        })();

  return `<p class="muted small" style="margin-bottom:14px">候选 ${pill(dispositionLabel(a.candidate).text, dispositionLabel(a.candidate).cls)} · 信心 ${escapeHtml(a.confidence)}${a.simulated ? pill('模拟输出（通道自声明）', 'warn') : ''}</p>
<section class="reading-section" aria-label="决定性连接">
  <h3>决定性连接（${String(a.decisiveLinks.length)}）</h3>
  ${links === '' ? '<p class="muted small">A 原件未交付决定性连接</p>' : links}
  <article class="reading-feature">
    <h4>最强反证</h4>
    <p>${escapeHtml(a.strongestCounter)}</p>
  </article>
</section>
<section class="reading-section" aria-label="A 限制">
  <h3>A 限制</h3>
  ${limitations}
</section>
<section class="reading-section" id="evidence" aria-label="证据引用下钻">
  <h3>证据引用下钻（factId → 原件 sha256 → 字节区间）</h3>
  ${factsTable}
</section>`;
}

function renderTabChecklist(view: ReportView): string {
  const cl = view.checklist;
  if (cl === null) {
    return emptyState('程序清单未读回（A 未绑定，或 p0/p2 重导出哈希均不命中 checklistHash）——如实呈现缺，不代填');
  }
  const rows = cl.items
    .map((item) => {
      const v = verdictLabel(item.verdict);
      return `<tr>
  <td class="hash">${escapeHtml(item.checklistId)}</td>
  <td>${escapeHtml(item.category)}</td>
  <td>${pill(v.text, v.cls)}</td>
  <td>${item.decisionBearing === null ? '<span class="muted">—</span>' : item.decisionBearing ? pill('承重', 'fact') : pill('不承重', 'neutral')}</td>
  <td><small>${escapeHtml(item.aText)}</small></td>
  <td>${item.correction === null ? '<span class="muted">—</span>' : `<small>${escapeHtml(item.correction)}</small>`}</td>
</tr>`;
    })
    .join('\n');
  return `<p class="muted small" style="margin-bottom:14px">清单 ${escapeHtml(cl.checklistId)} · ${String(cl.items.length)} 项 · 必经 J：${cl.mandatoryJ ? '是' : '否'} · 清单由 A 机械重导出并校验哈希后采用</p>
<div class="table-scroll">
  <table>
    <thead><tr><th>条目</th><th>类别</th><th>J 裁决</th><th>承重</th><th>A 原文</th><th>J 修正</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

function renderTabJ(view: ReportView): string {
  const j = view.j;
  if (j === null) {
    return emptyState('J 输出未绑定读回（canonicalSha256 未命中 var/sol-invocations）——如实呈现缺，不代填');
  }
  const d = dispositionLabel(j.finalDisposition);
  const limitations =
    j.limitations.length === 0
      ? '<p class="muted small">J 原件未列限制——这不代表没有风险</p>'
      : `<ul class="limit-list">${j.limitations.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  return `<dl class="metadata">
  <div><dt>最终决定</dt><dd>${pill(d.text, d.cls)}${j.simulated ? ' ' + pill('模拟输出（通道自声明）', 'warn') : ''}</dd></div>
  <div><dt>与 A 候选关系</dt><dd>${j.changedFromA ? `改判（${escapeHtml(j.changeReason ?? '改判理由缺失')}）` : '维持 A 候选'}</dd></div>
  <div><dt>最强待回应论证处置</dt><dd>${escapeHtml(j.strongestCaseDisposition)}</dd></div>
  <div><dt>裁决条数</dt><dd>${String(view.checklist?.items.filter((item) => item.verdict !== null).length ?? 0)} / ${String(view.checklist?.items.length ?? 0)}（对齐程序清单）</dd></div>
</dl>
<section class="reading-section" aria-label="J 限制">
  <h3>J 限制</h3>
  ${limitations}
</section>
<p class="muted small">结论对象 disposition 必须等于 J finalDisposition（字段间校验）；改判必填理由（含继承改判）。</p>`;
}

function renderTabSettlement(view: ReportView): string {
  const c = view.conclusion;
  const row = c.settlement;
  const meta: [string, string][] = [
    ['结算状态', settlementLabel(row.state).text],
    ['方向命中', row.directionHit === null || row.directionHit === undefined ? '—' : String(row.directionHit)],
    ['超额收益', row.excessReturn === null || row.excessReturn === undefined ? '—' : String(row.excessReturn)],
    ['可成交性', row.tradability === null || row.tradability === undefined ? '—' : String(row.tradability)],
  ];
  const inheritance =
    c.inheritance !== null
      ? `继承来源 ${escapeHtml(c.inheritance.fromConclusionId)}（hash ${escapeHtml(c.inheritance.fromConclusionHash.slice(0, 16))}…）`
      : `独立结论：${escapeHtml(c.standaloneNote ?? '—')}`;
  return `<dl class="metadata">
${meta.map(([k, v]) => `  <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('\n')}
</dl>
<p class="muted small">${escapeHtml(inheritance)}${c.changeReason === null ? '' : ` · 改判理由：${escapeHtml(c.changeReason)}`}</p>
<section class="reading-section" aria-label="结算占位区原值">
  <h3>结算占位区原值（settlement JSON）</h3>
  <pre class="original-text">${escapeHtml(JSON.stringify(row, null, 2))}</pre>
  <p class="muted small">结算口径：SR 合同预注册主指标；ANOMALY 不进主统计（R26.2）。第一次效果评价最早 2027-05-31，评价窗口内三不改（SR-7）。</p>
</section>`;
}

function renderSubjectPage(data: SubjectPageData): string {
  const basic = data.basic;
  const selected =
    data.conclusions.find((c) => c.conclusionId === data.selectedConclusionId) ?? data.conclusions[0] ?? null;
  const view = data.view;

  const toolbar = `<div class="object-toolbar">
  <span>类别：<strong>${basic.kind === 'STOCK' ? '沪深主板个股' : '宽基 ETF'}</strong>（${escapeHtml(basic.kind)}）</span>
  <span>${basic.kind === 'STOCK' ? '申万 L1' : '跟踪指数'}：<strong>${escapeHtml(basic.industry ?? '—')}</strong></span>
  <span>上市日：${escapeHtml(fmtDate(basic.ipoDate))}</span>
  <span>ST：${escapeHtml(basic.stStatus)}</span>
  <span>池：v${escapeHtml(basic.poolVersion)}（冻结 ${escapeHtml(basic.poolFrozenAt)}）</span>
  <span>库内事实：${fmtInt(basic.factsCount)} 条</span>
</div>`;

  const conclusionForm =
    data.conclusions.length <= 1
      ? ''
      : `<form class="surface-actions" method="get" action="/subject/${escapeHtml(basic.code)}">
  <label class="field">结论
    <select name="c">${data.conclusions
      .map((c) => `<option value="${escapeHtml(c.conclusionId)}"${selected?.conclusionId === c.conclusionId ? ' selected' : ''}>${escapeHtml(c.conclusionId.slice(0, 18))}… · ${escapeHtml(c.disposition)} · ${escapeHtml(fmtDateTime(c.createdAt))}</option>`)
      .join('')}</select>
  </label>
  <input type="hidden" name="t" value="${escapeHtml(data.tab)}">
  <button class="primary" type="submit">读回该结论</button>
</form>`;

  // 标的页正文
  let readingBody: string;
  let drawersHtml = '';
  if (view === null) {
    readingBody = emptyState(
      selected === null
        ? '该标的尚无落库结论——无报告可读回（如实呈现，不代填）'
        : '选定结论读回失败（结论行缺失或绑定链异常）——如实呈现，不代填',
    );
  } else {
    const { entries, factCount } = drawerEntries(view);
    drawersHtml = renderDrawers(entries);
    const c = view.conclusion;
    const disp = dispositionLabel(c.disposition);
    const a = view.aSummary;
    const j = view.j;
    const bannerTone = a !== null && view.checklist !== null && j !== null && view.inputCoverage !== null ? '' : ' warning';
    const bannerIcon = bannerTone === '' ? ICON.ok : ICON.warn;
    const banner = `<div class="status-banner${bannerTone}">${bannerIcon}
  <p>${bannerTone === '' ? '研究链全绑定：A 输出、程序清单、J 输出、输入包均已哈希校验读回' : '研究链部分绑定：' +
      [a === null ? 'A 输出未读回' : null, view.checklist === null ? '程序清单未读回' : null, j === null ? 'J 输出未读回' : null, view.inputCoverage === null ? '输入包未读回' : null].filter(Boolean).join(' · ') +
      '——缺段如实呈现，不代填'}</p>
</div>`;

    const tabs: { key: SubjectTab; label: string }[] = [
      { key: 'a', label: 'A 摘要' },
      { key: 'checklist', label: '程序清单' },
      { key: 'j', label: 'J 裁决' },
      { key: 'settlement', label: '结算' },
    ];
    const tabsNav = `<nav class="tabs" aria-label="报告阅读分区">
${tabs.map((t) => `  <a href="${tabHref(basic.code, selected?.conclusionId ?? null, t.key)}"${data.tab === t.key ? ' class="active" aria-current="page"' : ''}>${escapeHtml(t.label)}</a>`).join('\n')}
</nav>`;

    let panel: string;
    switch (data.tab) {
      case 'checklist':
        panel = renderTabChecklist(view);
        break;
      case 'j':
        panel = renderTabJ(view);
        break;
      case 'settlement':
        panel = renderTabSettlement(view);
        break;
      default:
        panel = renderTabA(view);
    }

    const verdictJ =
      j === null
        ? ''
        : `<span class="muted small">${j.changedFromA ? `J 改判（${escapeHtml(j.changeReason ?? '改判理由缺失')}）` : 'J 维持 A 候选'}${j.simulated ? ' · J 模拟输出' : ''}</span>`;

    readingBody = `<div class="subject-reading" id="reading">
  <aside class="reading-rail">
    ${renderDimensionRail(view)}
  </aside>
  <div class="reading-column">
    ${banner}
    <header class="metis-reading-heading" style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:4px 0 18px">
      <div>
        <p class="reading-source">研究报告 · 结论 ${escapeHtml(c.conclusionId)} · 资料截点 ${escapeHtml(c.businessKey.cutoff)}</p>
        <div class="reading-verdict">
          ${pill(disp.text, disp.cls)}
          ${verdictJ}
          ${a !== null && a.simulated ? pill('A 模拟输出（通道自声明）', 'warn') : ''}
        </div>
        <p class="reading-meta">
          ${hashChip(c.evidence.aOutputHash, 'A')}
          ${hashChip(c.evidence.checklistHash, '清单')}
          ${hashChip(c.evidence.jOutputHash, 'J')}
          ${hashChip(c.evidence.manifestHash, 'manifest')}
        </p>
        <p class="muted small">研究类型 ${escapeHtml(c.businessKey.researchKind)} · 结论落库 ${escapeHtml(fmtDateTime(c.createdAt))} · adoption 恒 false（不构成采用）${factCount > 0 ? ` · 送达引用 ${String(factCount)} 条` : ''}</p>
      </div>
    </header>
    ${tabsNav}
    <section aria-label="${escapeHtml(tabs.find((t) => t.key === data.tab)?.label ?? 'A 摘要')}">
${panel}
    </section>
    <section class="reading-section" aria-label="Coverage 维度">
      <div class="section-heading">
        <h3>Coverage ${view.inputCoverage?.dimensions.length === 7 ? '七维（宽基）' : '八维（个股）'}</h3>
        <span class="muted small">绿 = 送达 · 琥珀 = 有降级/缺口 · 灰 = 无送达</span>
      </div>
      ${renderDimensionArticles(view)}
    </section>
  </div>
</div>
${drawersHtml}`;
  }

  const historyRows = data.conclusions
    .map((c) => {
      const disp = dispositionLabel(c.disposition);
      const settle = settlementLabel(c.settlementState);
      const current = selected !== null && c.conclusionId === selected.conclusionId;
      return `<tr${current ? ' style="background:#f1f5ef"' : ''}>
  <td>${current ? '▸ ' : ''}<a class="text-button hash" href="/subject/${escapeHtml(basic.code)}?c=${encodeURIComponent(c.conclusionId)}">${escapeHtml(c.conclusionId)}</a></td>
  <td>${escapeHtml(c.researchKind)}</td>
  <td>${pill(disp.text, disp.cls)}</td>
  <td>${pill(settle.text, settle.cls)}</td>
  <td class="mono">${escapeHtml(fmtDateTime(c.createdAt))}</td>
</tr>`;
    })
    .join('\n');

  const history =
    data.conclusions.length === 0
      ? emptyState('该标的尚无落库结论')
      : `<div class="table-scroll"><table>
  <thead><tr><th>结论</th><th>类型</th><th>disposition</th><th>结算</th><th>时间</th></tr></thead>
  <tbody>
${historyRows}
  </tbody>
</table></div>`;

  return `${toolbar}
<div class="surface-header">
  <div>
    <h1>${escapeHtml(basic.name)} <span class="hash" style="font-size:16px">${escapeHtml(basic.code)}</span></h1>
    <p>研究池 v${escapeHtml(basic.poolVersion)}（冻结于 ${escapeHtml(basic.poolFrozenAt)}）· 报告正文分段呈现（维度导航 + A/清单/J/结算标签页），证据引用点开右侧抽屉核对原件哈希与字节区间。</p>
  </div>
  ${conclusionForm}
</div>
${readingBody}
<section class="reading-section" aria-label="历史结论">
  <div class="section-heading">
    <h2 style="font-size:17px">历史结论（${String(data.conclusions.length)}）</h2>
  </div>
  ${history}
</section>`;
}

// ===== 结论列表 =====

function conclusionQueryOf(
  filters: { kind: string | null; disposition: string | null; settlement: string | null },
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.kind !== null) params.set('kind', filters.kind);
  if (filters.disposition !== null) params.set('disposition', filters.disposition);
  if (filters.settlement !== null) params.set('settlement', filters.settlement);
  const base = params.toString();
  const withPage = (p: number): string => {
    const q = new URLSearchParams(base);
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return s === '' ? '/conclusions' : `/conclusions?${s}`;
  };
  return withPage(page);
}

function renderConclusionsPage(data: ConclusionsPageData): string {
  const f = data.filters;
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const rows = data.rows
    .map((c) => {
      const disp = dispositionLabel(c.disposition);
      const settle = settlementLabel(c.settlementState);
      const dir =
        c.directionHit === null || c.directionHit === ''
          ? '<span class="muted">—</span>'
          : c.directionHit === 'true'
            ? pill('命中', 'green')
            : pill('未命中', 'danger');
      return `<tr>
  <td><a class="text-button mono" href="/subject/${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</a></td>
  <td>${c.subjectKind === 'STOCK' ? '个股' : '宽基'}</td>
  <td>${escapeHtml(c.researchKind)}</td>
  <td>${pill(disp.text, disp.cls)}</td>
  <td>${pill(settle.text, settle.cls)}</td>
  <td>${dir}</td>
  <td class="mono">${escapeHtml(c.excessReturn ?? '—')}</td>
  <td class="mono">${escapeHtml(c.tradability ?? '—')}</td>
  <td class="mono">${escapeHtml(fmtDateTime(c.createdAt))}</td>
  <td class="cell-actions"><a class="text-button" href="/subject/${escapeHtml(c.subject)}">报告 →</a></td>
</tr>`;
    })
    .join('\n');

  const option = (value: string, label: string, current: string | null): string =>
    `<option value="${escapeHtml(value)}"${current === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  const pager =
    totalPages <= 1
      ? ''
      : `<div class="pagination">
  <span>第 ${String(data.page)} / ${String(totalPages)} 页 · 共 ${String(data.total)} 条</span>
  ${data.page > 1 ? `<a class="button" href="${escapeHtml(conclusionQueryOf(f, data.page - 1))}">上一页</a>` : '<button disabled>上一页</button>'}
  ${data.page < totalPages ? `<a class="button" href="${escapeHtml(conclusionQueryOf(f, data.page + 1))}">下一页</a>` : '<button disabled>下一页</button>'}
</div>`;

  return `<div class="surface-header">
  <div>
    <h1>结论</h1>
    <p>全量结论对象（只读自结论表，按落库时间倒序）· 研究池 v${escapeHtml(data.poolVersion)} · 结算列只反映 settlement 占位区现状。</p>
  </div>
</div>
<form class="filter-bar" method="get" action="/conclusions">
  <label class="field">类别
    <select name="kind">${option('', '全部', f.kind ?? '')}${option('STOCK', '个股', f.kind)}${option('BROAD_ETF', '宽基', f.kind)}</select>
  </label>
  <label class="field">disposition
    <select name="disposition">${option('', '全部', f.disposition ?? '')}${option('RESEARCH_OUTPERFORM', '跑赢 RESEARCH_OUTPERFORM', f.disposition)}${option('RESEARCH_UNDERPERFORM', '跑输 RESEARCH_UNDERPERFORM', f.disposition)}${option('RESEARCH_UP', '看涨 RESEARCH_UP', f.disposition)}${option('RESEARCH_DOWN', '看跌 RESEARCH_DOWN', f.disposition)}${option('ABSTAIN', '放弃 ABSTAIN', f.disposition)}</select>
  </label>
  <label class="field">结算
    <select name="settlement">${option('', '全部', f.settlement ?? '')}${option('UNSETTLED', '未结算', f.settlement)}${option('SETTLED', '已结算', f.settlement)}${option('ANOMALY', '结算异常', f.settlement)}</select>
  </label>
  <button class="primary" type="submit">筛选</button>
</form>
${
  data.rows.length === 0
    ? emptyState('无匹配结论（筛选条件下 0 条）')
    : `<div class="table-scroll">
  <table>
    <thead><tr><th>标的</th><th>类别</th><th>类型</th><th>disposition</th><th>结算状态</th><th>方向命中</th><th>超额收益</th><th>可成交</th><th>时间</th><th>报告</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`
}
${pager}
<p class="muted small">结算口径：SR 合同预注册主指标；ANOMALY 不进主统计（R26.2）。第一次效果评价最早 2027-05-31，评价窗口内三不改（SR-7）。</p>`;
}

// ===== 页面入口 =====

export function renderHomePage(data: HomeData): string {
  return renderLayout({
    title: 'Lyra · 今日研究',
    active: 'home',
    body: renderHome(data),
    breadcrumb: { label: '今日研究' },
    versionTag: `研究池 v${data.poolVersion} · P5 W${String(data.status.p5Week)}`,
    connectionOk: data.status.dbError === null,
    pendingToday: data.eventsTodayTotal > 0,
  });
}

export function renderSubjectHtml(data: SubjectPageData): string {
  return renderLayout({
    title: `Lyra · ${data.basic.name} ${data.basic.code}`,
    active: 'pool',
    body: renderSubjectPage(data),
    breadcrumb: { label: '今日研究', href: '/', object: `${data.basic.name} ${data.basic.code}` },
    versionTag: data.basic.poolVersion.startsWith('—') ? undefined : `研究池 v${data.basic.poolVersion}`,
    connectionOk: true,
  });
}

export function renderConclusionsHtml(data: ConclusionsPageData): string {
  const isHistory = data.filters.settlement === 'SETTLED';
  return renderLayout({
    title: 'Lyra · 结论',
    active: isHistory ? 'history' : 'conclusions',
    body: renderConclusionsPage(data),
    breadcrumb: isHistory ? { label: '结论', href: '/conclusions', object: '已结算历史' } : { label: '结论' },
    versionTag: `研究池 v${data.poolVersion}`,
    connectionOk: true,
  });
}

/** 通用错误页（不泄露堆栈，只给具名原因）。 */
export function renderErrorPage(status: number, message: string): string {
  const body = `<div class="surface-header">
  <div><h1>${String(status)}</h1></div>
</div>
<div class="status-banner error">${ICON.warn}
  <p>${escapeHtml(message)}</p>
  <p><a class="text-button" href="/">返回今日研究</a></p>
</div>`;
  return renderLayout({
    title: `Lyra · ${String(status)}`,
    active: 'home',
    body,
    breadcrumb: { label: '今日研究' },
    connectionOk: false,
  });
}
