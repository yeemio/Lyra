/**
 * Lyra · sr 空间页面渲染（R31）：纯函数 SSR，字符串输出，零外部 CDN，零内联脚本。
 *
 * 安全纪律（承重）：
 * - 一切动态内容（模型 narrative、用户输入、股票名、错误消息、表数据）嵌入 HTML
 *   前必经 escapeHtml；narrative 是 markdown：先整体转义，再做受控标记替换
 *   （renderMarkdown），不存在任何绕过转义的注入路径。
 * - CSP 由每页 <meta> 固定：default-src 'self'; style-src 'self' 'unsafe-inline';
 *   script-src 'self'。本模块不输出任何 <script>；任务页自动刷新用 meta refresh。
 * - 全部页面页脚恒为「个人研究记录，非投资建议」（合规标注）。
 */
import { escapeHtml } from '../web/pages.js';
import { renderWorkbenchContent, type WorkbenchPageState } from './strategy/workbench-render.js';
import type {
  ChatMessage,
  ReportDocument,
  ReportQaFinding,
  ReportSection,
  ReportSectionKey,
  SrAccountQuota,
  SrStep,
  SrTask,
} from './contracts.js';
import { REPORT_SECTIONS, SECTION_TITLES } from './contracts.js';
import { readableTable } from './report-tables.js';
import type { RealStrategyView } from './strategy/real-research.js';
import type { RealReviewResult } from './strategy/real-review.js';

/** 客户端真实资料入口；复用既有阅读壳与表格样式，状态不借用模拟发布标签。 */
export function renderRealStrategyPage(args: { view: RealStrategyView; researchReview?: RealReviewResult; csrf: string; account: { username: string; displayName: string; role: 'ADMIN' | 'USER' } }): string {
  const v = args.view, esc = escapeHtml;
  const review = args.researchReview;
  const reviewLabel = !review ? '' : review.identity === 'TEST_ONLY_RESEARCH_REVIEW' ? 'TEST_ONLY 注入runner验证，不是真实模型复核'
    : review.identity === 'SIMULATED_RESEARCH_REVIEW' ? '隔离模拟验证，真实A/J未运行'
      : review.realReviewDone ? '真实A/J复核完成；结论支持情况单独见裁决' : '真实复核尚未完成';
  const table = (heads: string[], rows: (string | number | null)[][]): string => `<div class="sr-table-scroll" tabindex="0" role="region" aria-label="${esc(heads.join('、'))}"><table class="sr-table"><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c === null ? '未计算 / 缺前提' : String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const money = (fen: number | null): string | null => fen === null ? null : `${(fen / 100).toFixed(2)} 元`;
  const fit = { PROVISIONAL_TREND_MATCH: '机械趋势条件暂时匹配', WAIT_STOCK_TREND: '等待个股趋势条件', WAIT_ENVIRONMENT: '等待市场或行业条件', DATA_PENDING: '待补行情资料' }[v.fit];
  const main = `<header class="sr-report-head"><div class="sr-report-title"><h1 class="sr-h1">${esc(v.subjectName)} <span class="sr-mono">${esc(v.subject)}</span> · 日线策略</h1><span class="sr-badge b-amber">${review?.realReviewDone ? '真实复核完成 · 执行门受限' : review ? '未经真实A/J复核的条件草案' : '未经A/J复核的条件草案'}</span></div>
<p>从真实连续行情查看条件与等待原因，再核对历史验证和风险前提。</p>
<p class="sr-report-meta"><span>行情共同截止 <strong>${esc(v.marketDate)}</strong></span><span>资料可得截点 ${esc(fmtDateTime(v.knowledgeCutoff))}</span><span>当前取得的历史修订口径 LATEST_REVISED</span></p>
<p><a href="/strategies/601919/report">同标的封存公司研究</a> · <a href="#real-coverage">真实资料覆盖</a> · <a href="#real-plan">条件与等待</a> · <a href="#real-validation">验证与复核门</a> · <a href="#real-sources">来源原件</a> · <a href="/strategies/601919/workbench">L2 工作区与本地风险输入（另行标明真实/合成身份）</a></p></header>
<section class="sr-section" id="real-status"><h2 class="sr-sec-h">现在能判断到哪一步</h2>
${table(['证据覆盖', '规则适配', '历史验证', '当前条件'], [[v.evidenceStatus === 'CONTINUOUS_RETROSPECTIVE_DATA' ? '股票/市场/行业行情连续对齐；严格执行材料未齐' : '资料不完整', fit, '尚未运行：严格PIT/开盘/规则等前提缺失', v.condition === 'RULE_TRIGGERED_RESEARCH_ONLY' ? '仅机械研究条件触发，不能据此成交' : v.condition === 'NOT_TRIGGERED' ? '未触发，继续等待' : '资料不足']])}
<p class="sr-muted">${v.evidenceStatus === 'CONTINUOUS_RETROSPECTIVE_DATA' ? '当前研究窗内，股票、市场与行业行情已按交易日历连续对齐。' : '当前研究窗内仍有行情缺口，尚未全部连续对齐；各序列覆盖与缺失数量见下表。'}行情覆盖不等于历史当时已可得、策略有效或当前可执行。此页没有使用合成行情、静态模拟A/J或用户虚构仓位。</p></section>
<section class="sr-section" id="real-coverage"><h2 class="sr-sec-h">真实输入覆盖与最新特征</h2>
<p>固定研究窗 ${esc(v.researchWindow.from)} → ${esc(v.researchWindow.to)}；按真实交易日历逐日比较，缺行情不当作停牌。</p>
${table(['序列', '预期交易日', '已覆盖', '缺失', '重复', '非交易日行', '首日 / 末日'], v.coverage.map((c) => [c.label, c.expected, c.observed, c.missingDates.length, c.duplicateDates.length, c.nonCalendarDates.length, `${c.first ?? '缺'} / ${c.last ?? '缺'}`]))}
${table(['序列', '原始末日收盘', '特征末值', '快均线', '慢均线', '计算口径'], v.features.map((f) => [f.label, f.rawClose, f.featureClose, f.fastMean, f.slowMean, f.priceBasis]))}
<p><a href="/api/strategies/601919/data">查看完整真实数据、时间字段与原始行定位 JSON</a></p></section>
<section class="sr-section" id="real-plan"><h2 class="sr-sec-h">条件研究与等待选择</h2>
${table(['候选', '机械适配选择', '理由'], v.draft.alternatives.map((a) => [a.family, a.selected ? '当前匹配' : '保留对照', a.reason]))}
${table(['原始价格条款', '假设值'], [['进入价格下界', money(v.draft.entryLowerFen)], ['进入价格上界', money(v.draft.entryUpperFen)], ['收盘价格失效阈值', money(v.draft.priceInvalidBelowFen)], ['收盘止盈阈值', money(v.draft.profitAboveFen)], ['具体到期日', null]])}
<ul>${v.draft.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
<h3>风险和持仓前提</h3><p>用户确认的资金、持仓、可卖数量与风险预算尚未提供，个人数量和金额均未计算。价格阈值来自固定研究假设，不能当作保证成交价或亏损上限。</p>
${table(['情景（无概率）', '原始价格参照', '数量', '费用', '净损益', '前提'], v.draft.scenarios.map((s) => [s.name, money(s.rawExitFen), s.quantity, s.feesFen, s.netPnlFen, s.assumption]))}</section>
<section class="sr-section" id="real-validation"><h2 class="sr-sec-h">历史验证与必经复核</h2>
${table(['预先冻结窗口', '开始', '结束', '预期交易日', '三序列对齐日'], v.validation.windows.map((w) => [w.kind === 'IS' ? '样本内' : '样本外', w.from, w.to, w.expectedSessions, w.alignedSessions]))}
<p>以上是资料覆盖，尚未执行历史机会回放。收益、回撤、暴露、换手、成交与未成交统计均未计算；不将零次评估写成零收益或验证通过。</p>
${table(['A', '程序清单', 'J', '发布门', '可执行方案'], [[review?.steps.A ?? '未运行', review?.steps.CHECKLIST ?? '无本草案A产物，未导出', review?.steps.J ?? '未运行', '阻断', '未解锁']])}
${review ? `<p>已载入独立复核记录：${esc(reviewLabel)}；状态 ${esc(review.status)}。复核对象仅为当前受限条件草案，未评历史有效性，执行门保持受限。</p><p class="sr-mono">复核 ${esc(review.resultHash)} · 方法 ${esc(review.reviewMethodVersion)} · 授权版本 ${esc(review.executionPlanAuthVersion)}</p>${review.effectiveConclusion ? `<p>${esc(review.effectiveConclusion)}</p>` : ''}${review.proposedRevision ? `<p>J要求新版本，尚未覆盖原草案：${esc(review.proposedRevision)}</p>` : ''}${table(['复核阻断', '原因'], review.blockers.map((b) => [b.code, b.detail]))}` : ''}
${table([review ? '原封存草案阻断' : '具名阻断', '准确缺口'], v.blockers.map((b) => [b.code, b.detail]))}</section>
<section class="sr-section" id="real-sources"><h2 class="sr-sec-h">来源、版本与研究边界</h2>
<p class="sr-mono">数据 ${esc(v.dataHash)}<br>规则 ${esc(v.rulesHash)}<br>研究视图 ${esc(v.viewHash)}</p>
${review ? '<p>以下保留原封存资料的边界说明；本次独立复核状态与结论见上方记录。</p>' : ''}<ul>${v.limitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<ul>${v.sources.map((s) => `<li><a href="/api/strategies/601919/sources/${encodeURIComponent(s.id)}">${esc(s.label)}</a><br><span class="sr-mono">SHA-256 ${esc(s.sha256)}</span></li>`).join('')}</ul>
<p><a href="/api/strategies/601919">同一真实资料身份的研究API</a> · <a href="/">返回公司研究</a></p></section>`;
  return shell({ title: `${v.subjectName} · 日线条件研究`, account: args.account, csrf: args.csrf, wide: true, surface: 'strategy' }, main);
}

export function renderL2WorkbenchPage(args: { state: WorkbenchPageState; csrf: string; values?: Record<string, string>; error?: string; account: { username: string; displayName: string; role: 'ADMIN' | 'USER' } }): string {
  return shell({ title: 'L2 工作区 · Lyra', account: args.account, csrf: args.csrf, wide: true, surface: 'strategy' }, renderWorkbenchContent(args.state, args.csrf, args.values, args.error));
}

// ===== 通用工具 =====

const DISCLAIMER = '个人研究记录，非投资建议';
const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'">';

/** ISO 时间 → 北京时间显示（本产品运营时区，无夏令时）。解析失败原样返回；精确原值仍在各页详情可见。 */
function fmtDateTime(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const b = new Date(d.getTime() + 8 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}（北京时间）`;
}

function fmtDate(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  return iso.slice(0, 10);
}

/** 状态徽章：{text 中文, cls 对应 sr-badge 色}。枚举来自合同，不来自数据。 */
function taskStatusBadge(s: SrTask['status']): { text: string; cls: string } {
  switch (s) {
    case 'QUEUED': return { text: '排队', cls: 'gray' };
    case 'RUNNING': return { text: '运行中', cls: 'blue' };
    case 'PARTIAL': return { text: '部分完成', cls: 'amber' };
    case 'COMPLETED': return { text: '完成', cls: 'green' };
    case 'FAILED': return { text: '失败', cls: 'red' };
    case 'CANCELLED': return { text: '已取消', cls: 'gray' };
  }
}

function stepStatusBadge(s: SrStep['status']): { text: string; cls: string } {
  switch (s) {
    case 'PENDING': return { text: '待处理', cls: 'gray' };
    case 'RUNNING': return { text: '进行中', cls: 'blue' };
    case 'SUCCEEDED': return { text: '完成', cls: 'green' };
    case 'FAILED': return { text: '失败', cls: 'red' };
    case 'SKIPPED': return { text: '跳过', cls: 'gray' };
  }
}

const ANALYZE_GROUP_NOTES: Record<string, string> = {
  a: '组a 业务·行业·驱动',
  b: '组b 财务·前景',
  c: '组c 估值·市场·风险',
};

function stepKindLabel(kind: SrStep['stepKind'], sectionKey: string | null): string {
  switch (kind) {
    case 'PLAN': return '研究计划';
    case 'EVIDENCE': return '证据组装';
    case 'COMPUTE': return '计算';
    case 'ANALYZE': {
      const note = sectionKey === null ? null : ANALYZE_GROUP_NOTES[sectionKey];
      return note === undefined || note === null ? '分节分析' : `分节分析（${note}）`;
    }
    case 'A_FINAL': return 'A 终稿（核心判断+决定性连接+反证）';
    case 'CHECKLIST': return '程序清单（机械抽取）';
    case 'JUDGE': return '必经 J 裁决';
    case 'SYNTHESIZE': return '综合判断（C2 旧链）';
    case 'QA_CHECK': return '质量检查';
    case 'ASSEMBLE': return '报告组装';
    case 'CHAT_ANSWER': return '追问回答';
  }
}

function focusLabel(f: string): string {
  switch (f) {
    case 'FULL': return '全面研究';
    case 'BUSINESS': return '业务与行业';
    case 'FINANCIAL_QUALITY': return '财务质量';
    case 'VALUATION': return '估值与预期';
    case 'EVENTS': return '事件驱动';
    default: return f;
  }
}

function horizonLabel(h: string): string {
  switch (h) {
    case 'MID_TERM': return '中期';
    case 'LONG_TERM': return '长期';
    case 'NEAR_TERM': return '近期';
    default: return h;
  }
}

function claimBadge(s: string): { text: string; cls: string } {
  switch (s) {
    case 'FACT': return { text: '已证事实', cls: 'green' };
    case 'INFERENCE': return { text: '推断', cls: 'blue' };
    case 'REJECTED': return { text: 'J 驳回（已否定记录）', cls: 'red' };
    default: return { text: '待验证', cls: 'amber' };
  }
}

function reportStatusBadge(s: ReportDocument['status']): { text: string; cls: string } {
  switch (s) {
    case 'DRAFT': return { text: '草稿', cls: 'amber' };
    case 'PUBLISHED': return { text: '已发布', cls: 'green' };
    case 'PUBLISHED_RESTRICTED': return { text: '受限发布（发布门未过，承重未解项具名展示）', cls: 'amber' };
    case 'SUPERSEDED': return { text: '已被新版替换', cls: 'gray' };
  }
}

function qaSeverityBadge(s: ReportQaFinding['severity']): { text: string; cls: string } {
  return s === 'BLOCKING' ? { text: '阻断', cls: 'red' } : { text: '提示', cls: 'amber' };
}

function chatKindLabel(k: string): string {
  switch (k) {
    case 'EXPLAIN': return '解释';
    case 'CHALLENGE': return '质疑';
    case 'ADJUST_ASSUMPTION': return '假设调整';
    case 'MISSING_DATA': return '资料不足';
    case 'NEW_CUTOFF': return '更新截点';
    default: return '其他';
  }
}

function badge(text: string, cls: string): string {
  return `<span class="sr-badge b-${cls}">${escapeHtml(text)}</span>`;
}

function usageKindLabel(kind: string): string {
  switch (kind) {
    case 'REPORT_TASK': return '研究任务';
    case 'MODEL_CALL': return '模型调用';
    default: return kind;
  }
}

/** 表格单元格值（string|number|null）→ 安全展示文本（null → —；字符串原样待转义）。 */
function cellText(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return String(v);
  return v === '' ? '' : v;
}

// ===== 极小安全 markdown → HTML（先转义，后受控标记替换） =====

/** 行内标记：**加粗** 与 `代码`。只作用于已转义文本（** 与 ` 不受转义影响）。 */
function inlineMd(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * 极小 markdown 渲染：#/##/### 标题、段落、**加粗**、`代码`、- 列表、| 表格行。
 * 全文先 escapeHtml，再按行做受控替换——不存在未转义内容进入标记输出的路径。
 */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md).split('\n');
  const out: string[] = [];
  let inList = false;
  let inTable = false;
  let tableBody = false;
  const closeList = (): void => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  const closeTable = (): void => {
    if (inTable) { out.push('</tbody></table></div>'); inTable = false; tableBody = false; }
  };
  const openTable = (): void => {
    if (!inTable) { out.push('<div class="sr-table-scroll" tabindex="0" role="region" aria-label="正文数据表"><table class="sr-md-table"><thead>'); inTable = true; tableBody = false; }
  };
  const splitRow = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());
  const isSeparatorRow = (cells: string[]): boolean =>
    cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map((l) => inlineMd(l)).join('<br>')}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      flushParagraph();
      closeList();
      closeTable();
      continue;
    }
    if (line.startsWith('|')) {
      flushParagraph();
      closeList();
      const cells = splitRow(line);
      if (cells.length === 0) continue;
      if (isSeparatorRow(cells)) continue; // | --- | --- | 分隔行不渲染
      openTable();
      if (!tableBody) {
        out.push(`<tr>${cells.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>`);
        tableBody = true;
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      const cls = level === 1 ? 'sr-md-h1' : level === 2 ? 'sr-md-h2' : 'sr-md-h3';
      out.push(`<h4 class="${cls}">${inlineMd(heading[2] ?? '')}</h4>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  closeTable();
  return out.join('\n');
}

// ===== 页面骨架 =====

interface ShellAccount {
  username: string;
  role: 'ADMIN' | 'USER';
  displayName: string;
}

interface ShellOpts {
  title: string;
  account?: ShellAccount;
  csrf?: string;
  refreshSeconds?: number;
  /** 报告阅读页等宽内容页：body 加 sr-wide，顶栏与主栏同步放宽。 */
  wide?: boolean;
  surface?: 'home' | 'report' | 'strategy';
  readOnly?: boolean;
}

/** 本机主线入口；用量/管理/退出保留原角色与POST语义。 */
function navHtml(account: ShellAccount | undefined, csrf: string | undefined, home: boolean, strategy: boolean): string {
  const moreItems = [
    '<a href="/usage">用量</a>',
    account !== undefined && account.role === 'ADMIN' ? '<a href="/admin">管理</a>' : '',
    account !== undefined && csrf !== undefined
      ? `<form method="post" action="/logout" class="sr-inlineform"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button type="submit" class="sr-btn sr-btn-ghost">退出登录</button></form>`
      : '',
  ].filter((x) => x !== '').join('\n');
  return `<a href="/"${home ? ' aria-current="page"' : ''}>首页</a>
<a href="/strategies/601919"${strategy ? ' aria-current="page"' : ''}>日线策略</a>
<details class="sr-nav-more">
<summary>更多</summary>
<div class="sr-nav-more-panel">
${moreItems}
</div>
</details>`;
}

function shell(opts: ShellOpts, main: string): string {
  const account = opts.account;
  const userBox = account === undefined
    ? ''
    : `<div class="sr-user"><span class="sr-user-name">${escapeHtml(account.displayName)}（${escapeHtml(account.username)}）</span></div>`;
  const refresh = opts.refreshSeconds === undefined
    ? ''
    : `<meta http-equiv="refresh" content="${escapeHtml(String(opts.refreshSeconds))}">`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${CSP_META}
<meta name="referrer" content="same-origin">
${refresh}
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/assets/sr.css">
</head>
<body class="sr-body${opts.wide === true ? ' sr-wide' : ''}${opts.surface === undefined ? '' : ` sr-${opts.surface}`}">
<a class="sr-skip" href="#sr-main">跳到主要内容</a>
<header class="sr-top"><div class="sr-top-inner">
<a class="sr-brand" href="${opts.readOnly ? '#sr-main' : '/'}">Lyra <small>公司研究</small></a>
${opts.readOnly ? '<span>固定阅读版</span>' : `<nav class="sr-nav" aria-label="主导航">${navHtml(account, opts.csrf, opts.surface === 'home', opts.surface === 'strategy')}</nav>`}
${userBox}
</div></header>
<main class="sr-shell" id="sr-main" tabindex="-1">
${main}
</main>
<footer class="sr-foot"><span>${DISCLAIMER}</span><span>Lyra · 个人研究平台</span></footer>
</body>
</html>`;
}

// ===== 1. 登录页 =====

export function renderLoginPage(args: { error?: string }): string {
  const errorBox = args.error === undefined ? '' : `<div class="sr-alert sr-alert-red">${escapeHtml(args.error)}</div>`;
  const main = `
<section class="sr-login">
  <div class="sr-card sr-login-card">
    <h1 class="sr-h1">Lyra 单股研究报告</h1>
    <p class="sr-muted">个人研究工具 · 登录后使用</p>
    ${errorBox}
    <form method="post" action="/login" class="sr-form">
      <div class="sr-field">
        <label for="sr-username">用户名</label>
        <input id="sr-username" name="username" type="text" autocomplete="username" required>
      </div>
      <div class="sr-field">
        <label for="sr-password">密码</label>
        <input id="sr-password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" class="sr-btn sr-btn-primary">登录</button>
    </form>
  </div>
</section>`;
  return shell({ title: '登录 · Lyra 单股研究' }, main);
}

// ===== 2. 首页 / 工作台 =====

interface UsageLike { period: string; rows: { kind: string; used: number }[] }

function usageBar(used: number, limit: number): { barHtml: string; text: string } {
  const pct = limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const cls = limit <= 0 || used >= limit ? ' over' : pct >= 80 ? ' warn' : '';
  const barHtml = `<div class="sr-bar${cls}"><span style="width:${pct}%"></span></div>`;
  return { barHtml, text: `${used} / ${limit}` };
}

function usedOf(usage: UsageLike, kind: string): number {
  return usage.rows.find((r) => r.kind === kind)?.used ?? 0;
}

export function renderDashboard(args: {
  account: { username: string; role: 'ADMIN' | 'USER'; displayName: string };
  tasks: SrTask[];
  pool: { stocks: { code: string; name: string; swL1: string }[]; etfs: { code: string; name: string }[] } | null;
  csrf: string;
  usage: UsageLike;
  quota: SrAccountQuota;
}): string {
  const { pool, quota, usage } = args;
  const datalistOptions = pool === null
    ? ''
    : [
        ...pool.stocks.map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)} · ${escapeHtml(s.swL1)}</option>`),
        ...pool.etfs.map((e) => `<option value="${escapeHtml(e.code)}">${escapeHtml(e.name)} · 宽基ETF</option>`),
      ].join('\n');
  // 输入示例必须来自实际支持列表（研究池），池不可用时退化为中性提示，不提示池外标的。
  const firstStock = pool === null ? undefined : pool.stocks[0];
  const subjectPlaceholder = firstStock === undefined
    ? '输入研究池内的股票代码或名称'
    : `如 ${firstStock.code} 或 ${firstStock.name}`;

  const taskRows = args.tasks.map((t) => {
    const b = taskStatusBadge(t.status);
    const error = t.error === null ? '' : `<p class="sr-task-error">${escapeHtml(t.error.message)} <span class="sr-mono">${escapeHtml(t.error.code)}</span></p>`;
    return `<tr>
<td class="sr-task-company"><a class="sr-strong" href="/tasks/${escapeHtml(t.taskId)}">${escapeHtml(t.subjectName)}</a><span class="sr-muted sr-mono">${escapeHtml(t.subject)}</span></td>
<td class="sr-task-state">${badge(b.text, b.cls)}${error}</td>
<td data-label="资料截点">${escapeHtml(fmtDate(t.cutoff))}</td>
<td data-label="创建时间" class="sr-task-time">${escapeHtml(fmtDateTime(t.createdAt))}</td>
<td class="sr-task-link"><a href="/tasks/${escapeHtml(t.taskId)}">查看任务</a></td>
</tr>`;
  }).join('\n');

  const taskUsed = usedOf(usage, 'REPORT_TASK');
  const callUsed = usedOf(usage, 'MODEL_CALL');
  const taskQuota = usageBar(taskUsed, quota.monthlyReportTasks);
  const callQuota = usageBar(callUsed, quota.monthlyModelCalls);
  // 真实限制不因收纳而不可见：用满/超限时在发起区直接给出醒目提示。
  const quotaAlerts = [
    quota.monthlyReportTasks > 0 && taskUsed >= quota.monthlyReportTasks
      ? `本月研究任务额度已用满（${taskUsed}/${quota.monthlyReportTasks}）。新任务会被拒绝，可在「额度与限制」查看详情。`
      : '',
    quota.monthlyModelCalls > 0 && callUsed >= quota.monthlyModelCalls
      ? `本月模型调用额度已用满（${callUsed}/${quota.monthlyModelCalls}）。运行中的任务可能无法完成，可在「额度与限制」查看详情。`
      : '',
  ].filter((x) => x !== '').map((x) => `<div class="sr-alert sr-alert-amber">${escapeHtml(x)}</div>`).join('\n');
  const quotaBars = `
    <div class="sr-quota-row"><span>${usageKindLabel('REPORT_TASK')}</span><span class="sr-mono">${taskQuota.text}</span></div>
    ${taskQuota.barHtml}
    <div class="sr-quota-row"><span>${usageKindLabel('MODEL_CALL')}</span><span class="sr-mono">${callQuota.text}</span></div>
    ${callQuota.barHtml}
    <p class="sr-muted small">并行任务上限 ${quota.maxConcurrentTasks}${quota.note === undefined ? '' : ` · ${escapeHtml(quota.note)}`} · 统计周期 ${escapeHtml(usage.period)}</p>`;

  const poolUnavailable = pool === null || (pool.stocks.length === 0 && pool.etfs.length === 0);
  const poolSummaryText = poolUnavailable
    ? '支持列表：研究池暂不可用'
    : `支持列表：沪深主板股票 ${String(pool.stocks.length)} 只 · 宽基 ETF ${String(pool.etfs.length)} 只`;
  const stockRows = pool === null || pool.stocks.length === 0
    ? '<tr><td colspan="3" class="sr-empty">研究池暂不可用（数据面边界如实呈现，不影响已生成报告）。</td></tr>'
    : pool.stocks.map((s) => `<tr><td class="sr-mono">${escapeHtml(s.code)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.swL1)}</td></tr>`).join('\n');
  const etfRows = pool === null || pool.etfs.length === 0
    ? ''
    : pool.etfs.map((e) => `<tr><td class="sr-mono">${escapeHtml(e.code)}</td><td>${escapeHtml(e.name)}</td><td>宽基 ETF</td></tr>`).join('\n');

  const main = `
<div class="sr-home-heading">
  <div><h1 class="sr-h1">公司研究</h1><p>从一家公司开始，沿着报告查证、追问与修订。</p></div>
  <a class="sr-jump" href="#recent">最近研究</a>
</div>

<section class="sr-launch" aria-labelledby="launch-title">
  <div class="sr-launch-intro">
    <h2 id="launch-title">研究哪家公司？</h2>
    <p>输入代码或名称，确定这次研究的侧重与周期。</p>
    <a href="#support">查看支持范围</a>
  </div>
  <div class="sr-launch-work">
  ${quotaAlerts}
  ${poolUnavailable ? '<div class="sr-alert sr-alert-amber">研究池暂不可用，当前无法确认支持范围。已生成报告仍可从最近研究访问。</div>' : ''}
  <form method="post" action="/tasks" class="sr-form sr-launch-form">
    <input type="hidden" name="_csrf" value="${escapeHtml(args.csrf)}">
    <div class="sr-launch-subject">
      <div class="sr-field">
        <label for="sr-subject">股票代码 / 名称</label>
        <input id="sr-subject" name="subject" type="text" list="sr-pool-list" placeholder="${escapeHtml(subjectPlaceholder)}" required aria-describedby="sr-pool-hint">
      </div>
    </div>
    <div class="sr-form-grid">
      <div class="sr-field">
        <label for="sr-focus">研究侧重</label>
        <select id="sr-focus" name="focus">
          <option value="FULL">全面研究</option>
          <option value="BUSINESS">业务与行业</option>
          <option value="FINANCIAL_QUALITY">财务质量</option>
          <option value="VALUATION">估值与预期</option>
          <option value="EVENTS">事件驱动</option>
        </select>
      </div>
      <div class="sr-field">
        <label for="sr-horizon">研究周期</label>
        <select id="sr-horizon" name="horizon">
          <option value="MID_TERM">中期</option>
          <option value="LONG_TERM">长期</option>
          <option value="NEAR_TERM">近期</option>
        </select>
      </div>
    </div>
    <details class="sr-emphasis">
      <summary>添加关注点<span>可选</span></summary>
      <div class="sr-field">
        <label for="sr-emphasis">本次特别关注的问题</label>
        <input id="sr-emphasis" name="emphasis" type="text" maxlength="500" placeholder="如：资产质量拐点是否成立">
      </div>
    </details>
    <button type="submit" class="sr-btn sr-btn-primary">开始研究</button>
    <datalist id="sr-pool-list">${datalistOptions}</datalist>
    <p class="sr-launch-hint" id="sr-pool-hint">仅支持研究池内标的。提交后进入任务页查看实际进度。</p>
  </form>
  </div>
</section>

<section class="sr-recent" id="recent" tabindex="-1" aria-labelledby="recent-title">
  <div class="sr-recent-head">
    <h2 id="recent-title">最近研究</h2>
    <p>从任务继续，查看进度与报告版本。</p>
  </div>
  ${args.tasks.length === 0 ? '<div class="sr-home-empty"><h3>还没有研究</h3><p>选定一家公司后，任务进度与报告版本会保留在这里。</p><a href="#sr-subject">选择第一家公司</a></div>' : `<div class="sr-table-scroll">
  <table class="sr-table sr-task-table">
    <thead><tr><th scope="col">公司 / 代码</th><th scope="col">研究状态</th><th scope="col">资料截点</th><th scope="col">创建时间</th><th scope="col"><span class="sr-visually-hidden">操作</span></th></tr></thead>
    <tbody>${taskRows}</tbody>
  </table>
  </div>`}
</section>

<div class="sr-home-secondary" id="support" tabindex="-1">
<details class="sr-card sr-secondary">
  <summary>${escapeHtml(poolSummaryText)}</summary>
  <div class="sr-secondary-body">
    <p class="sr-note">范围外标的不可发起研究。</p>
    <div class="sr-table-scroll" tabindex="0" role="region" aria-label="完整支持列表">
    <table class="sr-table">
      <thead><tr><th>代码</th><th>名称</th><th>行业（申万 L1）</th></tr></thead>
      <tbody>${stockRows}${etfRows}</tbody>
    </table>
    </div>
  </div>
</details>
<details class="sr-card sr-secondary">
  <summary>额度与限制</summary>
  <div class="sr-secondary-body">${quotaBars}</div>
</details>
</div>`;
  return shell({ title: '公司研究 · Lyra', account: args.account, csrf: args.csrf, surface: 'home' }, main);
}

// ===== 3. 任务页 =====

export function renderTaskPage(args: {
  task: SrTask;
  steps: SrStep[];
  reports: ReportDocument[];
  account?: { username: string; role: 'ADMIN' | 'USER'; displayName: string };
}): string {
  const { task } = args;
  const st = taskStatusBadge(task.status);
  const running = task.status === 'QUEUED' || task.status === 'RUNNING';
  const errorBox = task.error === null
    ? ''
    : `<div class="sr-alert sr-alert-red"><strong>任务失败（${escapeHtml(task.error.code)}）</strong><br>${escapeHtml(task.error.message)}</div>`;
  const stepRows = args.steps.length === 0
    ? '<tr><td colspan="5" class="sr-empty">尚未生成步骤。</td></tr>'
    : args.steps.map((s) => {
        const b = stepStatusBadge(s.status);
        return `<tr>
<td class="sr-mono">${String(s.sequence).padStart(2, '0')}</td>
<td>${escapeHtml(stepKindLabel(s.stepKind, s.sectionKey))}</td>
<td>${badge(b.text, b.cls)}</td>
<td class="sr-note">${s.note === null || s.note === '' ? '—' : escapeHtml(s.note)}</td>
<td class="sr-muted small">${escapeHtml(fmtDateTime(s.startedAt))} → ${escapeHtml(fmtDateTime(s.finishedAt))}</td>
</tr>`;
      }).join('\n');
  const sortedReports = [...args.reports].sort((a, b) => b.version - a.version);
  const reportRows = sortedReports.length === 0
    ? (running
        ? '<p class="sr-muted">报告生成后将在此出现。</p>'
        : '<p class="sr-muted">本任务没有产出报告（失败或被取消时如实呈现）。</p>')
    : `<div class="sr-table-scroll"><table class="sr-table"><thead><tr><th>版本</th><th>状态</th><th>生成时间</th><th></th></tr></thead><tbody>${sortedReports
        .map((r) => {
          const rb = reportStatusBadge(r.status);
          return `<tr><td class="sr-strong">v${r.version}</td><td>${badge(rb.text, rb.cls)}</td><td>${escapeHtml(fmtDateTime(r.publishedAt ?? r.createdAt))}</td><td><a href="/reports/${escapeHtml(r.reportId)}?v=${r.version}">阅读报告</a></td></tr>`;
        })
        .join('\n')}</tbody></table></div>`;

  const main = `
<nav class="sr-crumbs"><a href="/">首页</a> / 任务 ${escapeHtml(task.subject)}</nav>
<h1 class="sr-h1">${escapeHtml(task.subjectName)} <span class="sr-muted sr-mono">${escapeHtml(task.subject)}</span> ${badge(st.text, st.cls)}</h1>
${errorBox}
${running ? '<div class="sr-alert sr-alert-blue">任务执行中，页面每 5 秒自动刷新。</div>' : ''}

<section class="sr-card">
  <h2 class="sr-h2">任务信息</h2>
  <dl class="sr-meta">
    <div><dt>研究侧重</dt><dd>${escapeHtml(focusLabel(task.focus))}</dd></div>
    <div><dt>研究周期</dt><dd>${escapeHtml(horizonLabel(task.horizon))}</dd></div>
    <div><dt>资料截点</dt><dd>${escapeHtml(task.cutoff)}（封存不变）</dd></div>
    <div><dt>关注点</dt><dd>${task.emphasis === null ? '—' : escapeHtml(task.emphasis)}</dd></div>
    <div><dt>创建时间</dt><dd>${escapeHtml(fmtDateTime(task.createdAt))}</dd></div>
    <div><dt>完成时间</dt><dd>${escapeHtml(fmtDateTime(task.completedAt))}</dd></div>
    <div><dt>方法版本</dt><dd class="sr-mono">${escapeHtml(task.methodVersion)}</dd></div>
    <div><dt>数据/适配器版本</dt><dd class="sr-mono">${escapeHtml(task.adapterVersion)}</dd></div>
    ${task.revisedFromTaskId === null ? '' : `<div><dt>修订自</dt><dd><a href="/tasks/${escapeHtml(task.revisedFromTaskId)}">原任务</a></dd></div>`}
  </dl>
</section>

<section class="sr-card">
  <h2 class="sr-h2">步骤进度</h2>
  <div class="sr-table-scroll">
  <table class="sr-table">
    <thead><tr><th>#</th><th>步骤</th><th>状态</th><th>说明</th><th>时间</th></tr></thead>
    <tbody>
${stepRows}
    </tbody>
  </table>
  </div>
</section>

<section class="sr-card">
  <h2 class="sr-h2">报告版本</h2>
  ${reportRows}
</section>`;
  return shell({
    title: `${task.subjectName} · 任务 · Lyra 单股研究`,
    account: args.account ?? { username: '', role: 'USER', displayName: '' },
    ...(running ? { refreshSeconds: 5 } : {}),
  }, main);
}

// ===== 4. 报告阅读页 =====

interface TableLike {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  note: string | null;
}

/** 〔C3/R0〕发布门横幅：门结果 + 承重未解项具名（默认可见）；证据绑定四哈希由调用方收进“研究与证据详情”。 */
function gateBanner(report: ReportDocument): { visible: string; refs: string } {
  if (report.gate === null) return { visible: '', refs: '' };
  const refs = report.evidenceRefs;
  const refsHtml = refs === null
    ? ''
    : `<p class="sr-small sr-muted">证据绑定（可整链核验）：包 <span class="sr-mono">${escapeHtml(refs.packHash)}</span> / A <span class="sr-mono">${escapeHtml(refs.aOutputHash)}</span> / 清单 <span class="sr-mono">${escapeHtml(refs.checklistHash)}</span> / J <span class="sr-mono">${escapeHtml(refs.jOutputHash)}</span></p>`;
  if (report.gate.passed) {
    return {
      visible: '<div class="sr-genbanner green">发布门：通过——必经 J 裁决完成，无承重未解项</div>',
      refs: refsHtml,
    };
  }
  const items = report.gate.decisionBearingUnresolved
    .map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  return {
    visible: `<div class="sr-gate-restricted" role="note"><strong>发布门未过 · 受限发布</strong><p>${escapeHtml(report.gate.reason)}</p>${items ? `<p>以下承重未解项经 J 裁决仍未解决，结论按条件受限理解：</p><ul>${items}</ul>` : '<p>J 无承重未解项；是否可发布仍须结合上述限制及质量检查。</p>'}</div>`,
    refs: refsHtml,
  };
}

function generatedByBanner(g: ReportDocument['generatedBy']): string {
  switch (g) {
    case 'PRODUCT_SIMULATED':
      return '<div class="sr-genbanner yellow">模拟通道生成（工程链验证，非真实研究结论）</div>';
    case 'PRODUCT_REAL':
      return '<div class="sr-genbanner green">产品研究链生成</div>';
    case 'OFFLINE_DERIVED':
      return '<div class="sr-genbanner amber">离线派生阅读版：复用既有真实研究与 J 裁决，未发起新模型调用，未重新发布或取得研究质量接受。</div>';
    case 'EXECUTOR_COLLAB':
      return '<div class="sr-genbanner blue">执行者协作样板</div>';
  }
}

/** 章节按方法版本固定顺序渲染（REPORT_SECTIONS），未知键退化为出现顺序。 */
function orderedSections(sections: ReportSection[]): ReportSection[] {
  const known: ReportSection[] = [];
  const extra: ReportSection[] = [];
  for (const key of REPORT_SECTIONS) {
    const s = sections.find((x) => x.key === key);
    if (s !== undefined) known.push(s);
  }
  for (const s of sections) {
    if (!REPORT_SECTIONS.includes(s.key)) extra.push(s);
  }
  return [...known, ...extra];
}

/** 目录列表：章节 + 辅助区（质检/表/追问/修订），列表化避免链接挤成一串。 */
function sectionAnchors(sections: ReportSection[], readOnly = false): string {
  const chapterItems = sections.map((s, idx) => {
    const title = SECTION_TITLES[s.key as ReportSectionKey] ?? s.title;
    return `<li><a href="#sec-${escapeHtml(s.key)}"><span class="sr-toc-no">${String(idx + 1).padStart(2, '0')}</span><span>${escapeHtml(title)}</span></a></li>`;
  }).join('\n');
  const auxItems = ['<li class="sr-toc-aux"><a href="#qa">质量检查</a></li>',
    '<li class="sr-toc-aux"><a href="#tables">证据与计算表</a></li>',
    readOnly ? '' : '<li class="sr-toc-aux"><a href="#chat">追问</a></li>',
    readOnly ? '' : '<li class="sr-toc-aux"><a href="#revise">修订</a></li>',
    '<li class="sr-toc-aux"><a href="#research-details">研究与证据详情</a></li>'].join('\n');
  return `<ul>\n${chapterItems}\n${auxItems}\n</ul>`;
}

function tocBlockHtml(sections: ReportSection[], readOnly = false): string {
  return `<nav class="sr-toc" aria-label="目录">
<p class="sr-toc-title">目录</p>
${sectionAnchors(sections, readOnly)}
</nav>`;
}

function citationListHtml(section: ReportSection): string {
  if (section.citations.length === 0 && section.tables.length === 0) return '<p class="sr-muted small">本章无显式引用。</p>';
  const cites = section.citations.length === 0
    ? ''
    : `<ol class="sr-cites">${section.citations
        .map((c, i) => `<li id="cite-${escapeHtml(section.key)}-${i + 1}" tabindex="-1">[${i + 1}] ${c.locator.kind === 'COMPUTED' ? `<a href="#table-${escapeHtml(c.locator.tableId)}">${escapeHtml(c.label)}</a>` : c.locator.kind === 'SECTION' ? `<a href="#sec-${escapeHtml(c.locator.sectionKey)}">${escapeHtml(c.label)}</a>` : escapeHtml(c.label)}${c.quote === undefined ? '' : ` <span class="sr-muted">「${escapeHtml(c.quote)}」</span>`}</li>`)
        .join('')}</ol>`;
  const tbls = section.tables.length === 0
    ? ''
    : `<p class="sr-small">引用数据表：${section.tables
        .map((id) => `<a class="sr-chip" href="#table-${escapeHtml(id)}">${escapeHtml(tablesAnchorTitle(id))}</a>`)
        .join(' ')}</p>`;
  return `${tbls}${cites}`;
}

// tablesById 的标题查询需在渲染时进行——用模块级惰性引用避免层层传参。
let tablesByIdRef: Record<string, TableLike> = {};
function tablesAnchorTitle(id: string): string {
  const t = tablesByIdRef[id];
  return t === undefined ? id : `${t.title}（${id}）`;
}

function evidenceTableHtml(id: string, t: TableLike): string {
  const view = readableTable(t);
  const grid = (columns: string[], rows: (string | number | null)[][]): string => `<div class="sr-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(t.title)}"><table class="sr-table"><thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.length === 0 ? `<tr><td colspan="${columns.length}" class="sr-empty">（空表）</td></tr>` : rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(cellText(v))}</td>`).join('')}</tr>`).join('\n')}</tbody></table></div>`;
  const note = t.note ? `<p class="sr-note">单位/口径/公式：${escapeHtml(t.note)}</p>` : '';
  return `<div class="sr-evtable" id="table-${escapeHtml(id)}" tabindex="-1">
<h3 class="sr-h3">${escapeHtml(t.title)} <span class="sr-muted sr-mono small">${escapeHtml(id)}</span></h3>
${note}
${grid(view.columns, view.rows)}
${view.sources.length ? `<ol class="sr-table-sources">${view.sources.map((source, i) => `<li>S${i + 1} · ${escapeHtml(source)}</li>`).join('')}</ol>` : ''}
<details class="sr-raw-table"><summary>核对完整原表（${t.rows.length} 行 · ${t.columns.length} 列，保留原字段与精度）</summary>${grid(t.columns, t.rows)}</details>
</div>`;
}

function chatMessageHtml(m: ChatMessage): string {
  const role = m.role === 'USER' ? 'user' : 'bot';
  const roleLabel = m.role === 'USER' ? '我' : '研究助理';
  const cites = m.role === 'ASSISTANT' && m.citations.length > 0
    ? `<p class="sr-small sr-muted">引用：${m.citations.map((c) => escapeHtml(c.label)).join('；')}</p>`
    : '';
  const action = m.suggestedAction !== null && m.suggestedAction.type === 'NEW_TASK'
    ? `<p><a class="sr-btn" href="#revise">发起新截点研究</a></p>`
    : '';
  return `<div class="sr-msg ${role}">
<div class="sr-msg-head"><strong>${roleLabel}</strong><span class="sr-muted small">${escapeHtml(chatKindLabel(m.kind))} · ${escapeHtml(fmtDateTime(m.createdAt))}</span></div>
<div class="sr-md"><p>${escapeHtml(m.content).replaceAll('\n', '<br>')}</p></div>
${cites}
${action}
</div>`;
}

export function renderReportPage(args: {
  report: ReportDocument;
  versions: ReportDocument[];
  tablesById: Record<string, TableLike>;
  messages: ChatMessage[];
  csrf: string;
  account?: { username: string; role: 'ADMIN' | 'USER'; displayName: string };
  readOnly?: boolean;
}): string {
  const { report } = args;
  tablesByIdRef = args.tablesById; // 供引用芯片标题查询（单线程 SSR，渲染内即时消费）
  const sections = orderedSections(report.sections);
  const genBanner = generatedByBanner(report.generatedBy);
  const gate = gateBanner(report);
  const rb = reportStatusBadge(report.status);
  const versionPills = [...args.versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => v.version === report.version
      ? `<span class="sr-badge b-blue">v${v.version}（当前）</span>`
      : `<a class="sr-badge b-gray" href="/reports/${escapeHtml(report.reportId)}?v=${v.version}">v${v.version} · ${escapeHtml(reportStatusBadge(v.status).text)}</a>`)
    .join(' ');
  const tocSide = tocBlockHtml(sections, args.readOnly);
  const tocFold = `<details class="sr-toc-fold">
<summary>目录</summary>
${tocBlockHtml(sections, args.readOnly)}
</details>`;
  const metaDetails = `<details class="sr-meta-details" id="research-details">
<summary>研究与证据详情<span>方法、时间与完整哈希</span></summary>
<div class="sr-meta-details-body">
<dl class="sr-meta">
<div><dt>方法版本</dt><dd class="sr-mono">${escapeHtml(report.methodVersion)}</dd></div>
<div><dt>数据/适配器版本</dt><dd class="sr-mono">${escapeHtml(report.adapterVersion)}</dd></div>
<div><dt>授权版本</dt><dd class="sr-mono">${escapeHtml(report.planAuthVersion)}</dd></div>
<div><dt>生成时间</dt><dd>${escapeHtml(fmtDateTime(report.createdAt))}</dd></div>
<div><dt>生成时间（精确原值）</dt><dd class="sr-mono">${escapeHtml(report.createdAt)}</dd></div>
<div><dt>报告 ID</dt><dd class="sr-mono">${escapeHtml(report.reportId)}</dd></div>
<div><dt>内容哈希</dt><dd class="sr-mono">${escapeHtml(report.contentHash)}</dd></div>
<div><dt>任务 ID</dt><dd class="sr-mono">${escapeHtml(report.taskId)}</dd></div>
</dl>
${gate.refs}
${report.derivation ? `<p class="sr-note">派生来源：${escapeHtml(report.derivation.sourceReportPath)}（SHA-256 ${escapeHtml(report.derivation.sourceReportSha256)}）；映射：${escapeHtml(report.derivation.mappingPath)}（SHA-256 ${escapeHtml(report.derivation.mappingSha256)}）。${escapeHtml(report.derivation.note)}</p>` : ''}
</div>
</details>`;

  const sectionsHtml = sections
    .map((s, idx) => {
      const title = SECTION_TITLES[s.key as ReportSectionKey] ?? s.title;
      const findings = s.findings.length === 0
        ? ''
        : `<ul class="sr-findings">${s.findings
            .map((f) => {
              const cb = claimBadge(f.status);
              const cites = f.citations.length === 0
                ? ''
                : ` <span class="sr-cite-mark">${f.citations.map((n) => `<a href="#cite-${escapeHtml(s.key)}-${escapeHtml(n.replace(/^C/, ''))}">[${escapeHtml(n)}]</a>`).join('')}</span>`;
              return `<li>${badge(cb.text, cb.cls)} <span class="sr-finding-text">${escapeHtml(f.text)}</span>${cites}</li>`;
            })
            .join('\n')}</ul>`;
      // 〔C8/C7-01〕协议层 scenarios 可为 null（required+nullable），消费端 null 安全
      const scenarios = s.scenarios == null || s.scenarios.length === 0
        ? ''
        : `<div class="sr-table-scroll" tabindex="0" role="region" aria-label="情景与触发条件"><table class="sr-table sr-scenarios"><thead><tr><th>情景</th><th>触发条件（可观察）</th><th>含义</th></tr></thead><tbody>${s.scenarios
            .map((r) => `<tr><td class="sr-strong">${escapeHtml(r.name)}</td><td>${escapeHtml(r.condition)}</td><td>${escapeHtml(r.implication)}</td></tr>`)
            .join('\n')}</tbody></table></div>`;
      const gaps = s.gaps.length === 0
        ? ''
        : `<div class="sr-gaps"><strong>缺口</strong><ul>${s.gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul></div>`;
      // 证据与引用默认直接可见：引用锚点（#cite-*）不折叠，正文引用跳转不落空。
      const evidenceBlock = `<div class="sr-evidence-block">
<h3>证据与引用（${s.tables.length} 表 · ${s.citations.length} 引用）</h3>
${citationListHtml(s)}
</div>`;
      return `<section class="sr-section" id="sec-${escapeHtml(s.key)}" tabindex="-1">
<h2 class="sr-sec-h"><span class="sr-sec-no">${String(idx + 1).padStart(2, '0')}</span> ${escapeHtml(title)}</h2>
<div class="sr-md">
${renderMarkdown(s.narrative)}
</div>
${findings}
${scenarios}
${gaps}
${evidenceBlock}
</section>`;
    })
    .join('\n');

  const qaHtml = report.qaFindings.length === 0
    ? '<p class="sr-alert sr-alert-green">质检通过：无阻断项与提示项。</p>'
    : `<ul class="sr-qa">${report.qaFindings
        .map((q) => {
          const qb = qaSeverityBadge(q.severity);
          return `<li>${badge(qb.text, qb.cls)} <span class="sr-mono small">${escapeHtml(q.code)}</span>${q.sectionKey === null ? '' : ` <span class="sr-muted small">（${escapeHtml(SECTION_TITLES[q.sectionKey as ReportSectionKey] ?? q.sectionKey)}）</span>`} — ${escapeHtml(q.detail)}</li>`;
        })
        .join('\n')}</ul>`;

  // 只渲染被正文引用过的表（证据抽屉引用交集），保持页面诚实且不膨胀
  const referencedIds: string[] = [];
  for (const s of sections) {
    for (const id of s.tables) {
      if (!referencedIds.includes(id)) referencedIds.push(id);
    }
  }
  const tablesHtml = referencedIds.length === 0
    ? '<p class="sr-muted">正文未引用任何数据表（或表文件缺失——缺失如实呈现，不补造）。</p>'
    : referencedIds
        .map((id) => {
          const t = args.tablesById[id];
          return t === undefined
            ? `<div class="sr-evtable" id="table-${escapeHtml(id)}" tabindex="-1"><h3 class="sr-h3">表 ${escapeHtml(id)}</h3><p class="sr-alert sr-alert-amber">该表在证据/计算输出中缺失（如实呈现）。</p></div>`
            : evidenceTableHtml(id, t);
        })
        .join('\n');

  const chatHtml = args.messages.length === 0
    ? '<p class="sr-muted">还没有追问。可以在下方提问，例如「第 3 章的推断依赖哪个假设？」</p>'
    : args.messages.map(chatMessageHtml).join('\n');
  const snapshot = args.tablesById['market-snapshot'];
  const dateRow = snapshot?.rows[0];
  const marketTime = snapshot && dateRow ? dateRow[snapshot.columns.indexOf('observedAt')] : null;
  const history = args.tablesById['bars-daily'];
  const historyDate = history?.rows.at(-1)?.[history.columns.indexOf('date')];
  const dataDates = snapshot ? `<p class="sr-note">实际材料日期：公司原件为2025年报及2026半年报；运价快照为2026-10-23；行情快照为${escapeHtml(String(marketTime ?? '未知'))}；历史日线截至${escapeHtml(String(historyDate ?? '未知'))}。未取得三季报原件，行情快照不拼接历史日线。</p>` : '';

  const main = `
<div class="sr-report-toolbar">
  ${args.readOnly ? '<span>公司研究 · 固定资料截点</span>' : `<nav class="sr-crumbs" aria-label="面包屑"><a href="/">首页</a><span>/</span><a href="/tasks/${escapeHtml(report.taskId)}">任务 ${escapeHtml(report.subjectName)}</a><span>/</span><span>报告</span></nav>`}
  <div class="sr-head-actions">
    ${args.readOnly ? '' : '<a class="sr-btn sr-btn-quiet" href="#chat">追问</a><a class="sr-btn sr-btn-quiet" href="#revise">修订</a>'}
    <a class="sr-btn sr-btn-primary" href="${args.readOnly ? 'REPORT.pdf' : `/reports/${escapeHtml(report.reportId)}/pdf?v=${report.version}`}">${args.readOnly ? '阅读 PDF' : '导出 PDF'}</a>
  </div>
</div>
${tocFold}
<div class="sr-report-layout">
<aside class="sr-toc-col">
${tocSide}
<div class="sr-version-nav"><p>报告版本</p><div class="sr-versions">${versionPills}</div><span>旧版保留，可随时回看。</span></div>
</aside>
<article class="sr-report-main">
<header class="sr-report-head">
<div class="sr-report-title"><h1 class="sr-h1">${escapeHtml(report.subjectName)} <span class="sr-mono">${escapeHtml(report.subject)}</span></h1><div>${badge(`v${report.version}`, 'blue')} ${badge(rb.text, rb.cls)}</div></div>
<p class="sr-report-meta"><span>${escapeHtml(focusLabel(report.focus))} · ${escapeHtml(horizonLabel(report.horizon))}</span><span>资料截点 <strong class="sr-report-cutoff">${escapeHtml(report.cutoff)}</strong>（封存不变）</span></p>
${report.subject === '601919' && !args.readOnly ? '<p><a href="/strategies/601919">查看同标的日线条件研究、真实资料覆盖与验证状态</a></p>' : ''}
${genBanner}
${dataDates}
${gate.visible}
${report.changeSummary === null ? '' : `<p class="sr-changesummary"><strong>本版变化</strong>${escapeHtml(report.changeSummary)}</p>`}
<div class="sr-mobile-versions"><span>版本：</span>${versionPills}</div>
</header>

${sectionsHtml}

${metaDetails}

<section class="sr-section" id="qa" tabindex="-1">
<h2 class="sr-sec-h">质量检查</h2>
${qaHtml}
</section>

<section class="sr-section" id="tables" tabindex="-1">
<h2 class="sr-sec-h">证据与计算表</h2>
<p class="sr-muted small">以下为正文各章引用的数据表（null 显示 —；注为公式/口径）。</p>
${tablesHtml}
</section>

${args.readOnly ? '' : `<section class="sr-section" id="chat" tabindex="-1">
<h2 class="sr-sec-h">追问</h2>
${chatHtml}
<form method="post" action="/reports/${escapeHtml(report.reportId)}/chat" class="sr-form sr-chat-form">
<input type="hidden" name="_csrf" value="${escapeHtml(args.csrf)}">
<div class="sr-field">
<label for="sr-question">提问（解释 / 质疑 / 假设调整 / 资料不足，回答绑定当版报告）</label>
<textarea id="sr-question" name="question" rows="3" maxlength="2000" required placeholder="例：估值章的 PE 假设为什么取 8 倍下限？"></textarea>
</div>
<button type="submit" class="sr-btn sr-btn-primary">提交问题</button>
</form>
</section>

<section class="sr-section" id="revise" tabindex="-1">
<h2 class="sr-sec-h">修订（产生新版本任务）</h2>
<p class="sr-muted small">修订会产生新版本任务并生成新报告；旧报告与旧版本全部保留、随时可回看。</p>
<form method="post" action="/reports/${escapeHtml(report.reportId)}/revise" class="sr-form">
<input type="hidden" name="_csrf" value="${escapeHtml(args.csrf)}">
<div class="sr-field">
<label for="sr-revise-emphasis">新的关注点 / 修订说明</label>
<textarea id="sr-revise-emphasis" name="emphasis" rows="2" maxlength="500" placeholder="例：补充对毛利率拐点的检验"></textarea>
</div>
<div class="sr-check">
<input type="checkbox" id="sr-new-cutoff" name="new_cutoff" value="1">
<label for="sr-new-cutoff">更新资料截点（以当前时刻重新取数；不勾选则在原截点资料下做假设修订）</label>
</div>
<button type="submit" class="sr-btn">发起修订任务</button>
</form>
</section>`}
</article>
</div>`;
  return shell({
    title: `${report.subjectName} v${report.version} 报告 · Lyra 单股研究`,
    account: args.account ?? { username: '', role: 'USER', displayName: '' },
    csrf: args.csrf,
    wide: true,
    surface: 'report',
    readOnly: args.readOnly === true,
  }, main);
}

// ===== 5. 用量页 =====

export function renderUsagePage(args: {
  username: string;
  usage: UsageLike;
  quota: SrAccountQuota;
  events: { kind: string; detail: Record<string, unknown>; at: string }[];
}): string {
  const taskBar = usageBar(usedOf(args.usage, 'REPORT_TASK'), args.quota.monthlyReportTasks);
  const callBar = usageBar(usedOf(args.usage, 'MODEL_CALL'), args.quota.monthlyModelCalls);
  const eventRows = args.events.length === 0
    ? '<tr><td colspan="3" class="sr-empty">暂无事件。</td></tr>'
    : args.events
        .map((e) => {
          const detail = JSON.stringify(e.detail);
          const brief = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
          return `<tr><td>${escapeHtml(e.kind)}</td><td class="sr-muted">${escapeHtml(fmtDateTime(e.at))}</td><td class="sr-mono small">${escapeHtml(brief)}</td></tr>`;
        })
        .join('\n');
  const main = `
<nav class="sr-crumbs"><a href="/">首页</a> / 用量</nav>
<h1 class="sr-h1">用量 <span class="sr-muted">${escapeHtml(args.username)} · ${escapeHtml(args.usage.period)}</span></h1>

<section class="sr-quota">
  <div class="sr-card">
    <div class="sr-quota-row"><span>${usageKindLabel('REPORT_TASK')}（研究任务）</span><span class="sr-mono">${taskBar.text}</span></div>
    ${taskBar.barHtml}
    <div class="sr-quota-row"><span>${usageKindLabel('MODEL_CALL')}（模型调用）</span><span class="sr-mono">${callBar.text}</span></div>
    ${callBar.barHtml}
    <p class="sr-muted small">并行任务上限 ${args.quota.maxConcurrentTasks}${args.quota.note === undefined ? '' : ` · ${escapeHtml(args.quota.note)}`}</p>
  </div>
</section>

<section class="sr-card">
  <h2 class="sr-h2">最近事件（最多 50 条）</h2>
  <div class="sr-table-scroll">
  <table class="sr-table">
    <thead><tr><th>类型</th><th>时间</th><th>摘要</th></tr></thead>
    <tbody>
${eventRows}
    </tbody>
  </table>
  </div>
</section>`;
  return shell({ title: '用量 · Lyra 单股研究' }, main);
}

// ===== 6. 管理页 =====

export function renderAdminPage(args: {
  accounts: {
    accountId: string;
    username: string;
    displayName: string;
    role: string;
    quota: SrAccountQuota;
    tasks: number;
    disabled: boolean;
  }[];
  csrf: string;
}): string {
  const accountRows = args.accounts.length === 0
    ? '<tr><td colspan="6" class="sr-empty">暂无账户。</td></tr>'
    : args.accounts
        .map((a) => `<tr${a.disabled ? ' class="sr-row-disabled"' : ''}>
<td class="sr-strong">${escapeHtml(a.username)}${a.disabled ? ' ' + badge('已禁用', 'gray') : ''}</td>
<td>${escapeHtml(a.displayName)}</td>
<td>${badge(a.role === 'ADMIN' ? '管理员' : '用户', a.role === 'ADMIN' ? 'blue' : 'gray')}</td>
<td class="sr-mono">${a.tasks}</td>
<td class="sr-mono small">${a.quota.monthlyReportTasks} 任务 / ${a.quota.monthlyModelCalls} 调用 / 并行 ${a.quota.maxConcurrentTasks}${a.quota.note === undefined ? '' : ` · ${escapeHtml(a.quota.note)}`}</td>
<td class="sr-mono small">${escapeHtml(a.accountId)}</td>
</tr>`)
        .join('\n');
  const accountOptions = args.accounts
    .map((a) => `<option value="${escapeHtml(a.accountId)}">${escapeHtml(a.username)}（${escapeHtml(a.displayName)}）</option>`)
    .join('\n');
  const main = `
<nav class="sr-crumbs"><a href="/">首页</a> / 管理</nav>
<h1 class="sr-h1">账户管理</h1>

<section class="sr-card">
  <h2 class="sr-h2">账户</h2>
  <div class="sr-table-scroll">
  <table class="sr-table">
    <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>任务数</th><th>配额</th><th>账户 ID</th></tr></thead>
    <tbody>
${accountRows}
    </tbody>
  </table>
  </div>
</section>

<section class="sr-card">
  <h2 class="sr-h2">创建账户</h2>
  <form method="post" action="/admin/accounts" class="sr-form">
    <input type="hidden" name="_csrf" value="${escapeHtml(args.csrf)}">
    <div class="sr-form-grid">
      <div class="sr-field"><label for="sr-na-username">用户名</label><input id="sr-na-username" name="username" required></div>
      <div class="sr-field"><label for="sr-na-password">密码</label><input id="sr-na-password" name="password" type="password" required></div>
      <div class="sr-field"><label for="sr-na-display">显示名（可选）</label><input id="sr-na-display" name="display_name"></div>
      <div class="sr-field"><label for="sr-na-tasks">每月任务数</label><input id="sr-na-tasks" name="monthly_tasks" type="number" min="0" value="5"></div>
      <div class="sr-field"><label for="sr-na-calls">每月模型调用数</label><input id="sr-na-calls" name="monthly_calls" type="number" min="0" value="60"></div>
    </div>
    <button type="submit" class="sr-btn sr-btn-primary">创建</button>
  </form>
</section>

<section class="sr-card">
  <h2 class="sr-h2">调整配额</h2>
  <form method="post" action="/admin/quota" class="sr-form">
    <input type="hidden" name="_csrf" value="${escapeHtml(args.csrf)}">
    <div class="sr-form-grid">
      <div class="sr-field">
        <label for="sr-q-account">账户</label>
        <select id="sr-q-account" name="account_id" required>
${accountOptions}
        </select>
      </div>
      <div class="sr-field"><label for="sr-q-tasks">每月任务数</label><input id="sr-q-tasks" name="monthly_tasks" type="number" min="0" value="5"></div>
      <div class="sr-field"><label for="sr-q-calls">每月模型调用数</label><input id="sr-q-calls" name="monthly_calls" type="number" min="0" value="60"></div>
      <div class="sr-field"><label for="sr-q-concurrent">并行任务上限</label><input id="sr-q-concurrent" name="max_concurrent" type="number" min="1" value="1"></div>
      <div class="sr-field"><label for="sr-q-note">套餐说明</label><input id="sr-q-note" name="note" value="试用"></div>
    </div>
    <button type="submit" class="sr-btn sr-btn-primary">保存配额</button>
  </form>
</section>`;
  return shell({ title: '管理 · Lyra 单股研究' }, main);
}

// ===== 7. 错误页 =====

export function renderErrorPage(status: number, message: string): string {
  const main = `
<section class="sr-error">
<div class="sr-card">
<h1 class="sr-h1">${String(status)}</h1>
<div class="sr-alert sr-alert-amber">${escapeHtml(message)}</div>
<p><a class="sr-btn" href="/">返回首页</a></p>
</div>
</section>`;
  return shell({ title: `${String(status)} · Lyra 单股研究` }, main);
}
