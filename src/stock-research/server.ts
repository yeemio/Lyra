/**
 * Lyra · sr 报告产品服务（R31）：SaaS 候选首版的唯一 HTTP 入口。
 *
 * 边界与纪律（TASK-PACKAGE §5.3）：
 * - 默认仅绑定回环（127.0.0.1），端口 LYRA_SR_PORT（缺省 3470）；公网部署不在本版。
 * - 所有写接口要求：有效会话（HttpOnly SameSite=Strict cookie）+ CSRF 令牌 + 限流。
 * - 对象访问控制全部在服务端取数层执行（getTask/getReportById 带 accountId），
 *   不依赖前端隐藏；直接改 ID 同样被拒。
 * - 模型文本视为不可信内容：渲染层全量转义（render.ts/pdf.ts 负责）。
 * - 任务由进程内 worker 执行（sr_engine_lock 单执行器；RECONCILING 时零调用并如实展示）。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { SR_OUTPUT_DIR } from './contracts.js';
import {
  authenticate,
  createAccount,
  createSession,
  getAccount,
  purgeExpiredSessions,
  resolveSession,
  revokeSession,
  setAccountQuota,
} from './accounts.js';
import { defaultTrialQuota } from './contracts.js';
import { getQuotaUsage, recordUsageEvent, refundQuota, reserveQuota } from './quota.js';
import {
  claimQueuedTask,
  createTask,
  getChatThread,
  getReportById,
  getTask,
  listChatMessages,
  listReportVersions,
  listSteps,
  listTasks,
  srBootRecovery,
  acquireSrEngineLock,
  heartbeatSrEngineLock,
  releaseSrEngineLock,
} from './store.js';
import { askReportQuestion, classifyQuestion, runSrTask } from './engine.js';
import { loadResearchPool, findSubject } from './evidence.js';
import { renderReportPdf } from './pdf.js';
import {
  renderAdminPage,
  renderDashboard,
  renderErrorPage,
  renderLoginPage,
  renderReportPage,
  renderTaskPage,
  renderUsagePage,
  renderRealStrategyPage,
  renderL2WorkbenchPage,
} from './render.js';
import { fileStrategyStore, type RealStrategyStore } from './strategy/real-store.js';
import type { L2WorkbenchStore } from './strategy/workbench-contracts.js';
import type { WorkbenchPageState } from './strategy/workbench-render.js';
import { createRiskExport, riskLotCount, RISK_LOT_LIMIT, RiskInputError } from './strategy/risk-input.js';
import { assertLocalBind, localRequestError } from './server-origin.js';

export interface SrServerConfig {
  port: number;
  bind: string;
  adminUser: string | null; // 首次启动自举管理员（env）
  adminPassword: string | null;
  sessionTtlMs: number;
  /** 〔C3/R0〕单平台客户端本地模式（缺省）：免登录单用户，账户/套餐/商业面退出交付范围。 */
  mode: 'local' | 'saas';
  /** Explicit network-listen opt-in; it does not extend local mode's accepted HTTP authorities. */
  allowNonLoopbackBind?: boolean;
}

export function srServerConfigFromEnv(env: NodeJS.ProcessEnv): SrServerConfig {
  return {
    port: Number(env.LYRA_SR_PORT ?? 3470),
    bind: env.LYRA_SR_BIND ?? '127.0.0.1',
    adminUser: env.LYRA_SR_ADMIN_USER ?? null,
    adminPassword: env.LYRA_SR_ADMIN_PASSWORD ?? null,
    sessionTtlMs: Number(env.LYRA_SR_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    mode: env.LYRA_SR_MODE === 'saas' ? 'saas' : 'local',
    allowNonLoopbackBind: env.LYRA_SR_ALLOW_NON_LOOPBACK_BIND === '1',
  };
}

export interface SrServerDeps {
  srPool: Pool;
  dataPool: Pool;
  config: SrServerConfig;
  outputDir?: string;
  /** 研究池缓存（进程内；首请求加载）。 */
  poolCache?: Awaited<ReturnType<typeof loadResearchPool>> | null;
  /** 〔C3〕本地模式：单用户账户与实例级 CSRF（免登录；写接口仍校验令牌）。 */
  localAccountId?: string;
  localCsrf?: string;
  /** 显式路径+哈希绑定的真实文件资料；缺失时不回退模拟或发起采集。 */
  strategyStore?: RealStrategyStore;
  /** 显式注入的只读L2文件工作区，未配置时不回退演示。 */
  workbenchStore?: L2WorkbenchStore;
}

const COOKIE_NAME = 'lyra_sr_session';

export interface SrFullDeps extends SrServerDeps {
  transport: import('./contracts.js').SrModelTransport;
  budget: import('./contracts.js').SrPlanBudget;
}

// ===== 会话解析 =====

interface AuthedReq {
  accountId: string;
  username: string;
  role: 'ADMIN' | 'USER';
  csrfToken: string;
  sessionId: string;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function authed(deps: SrServerDeps, req: IncomingMessage): Promise<AuthedReq | null> {
  if (deps.config.mode === 'local' && deps.localAccountId) {
    // 〔C3〕单平台客户端：本地单用户（Owner），无登录面；账户体系退出当前交付范围。
    return {
      accountId: deps.localAccountId,
      username: 'owner',
      role: 'ADMIN',
      csrfToken: deps.localCsrf ?? '',
      sessionId: 'local-instance',
    };
  }
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const r = await resolveSession(deps.srPool, token);
  if (!r) return null;
  return {
    accountId: r.account.accountId,
    username: r.account.username,
    role: r.account.role,
    csrfToken: r.session.csrfToken,
    sessionId: r.session.sessionId,
  };
}

// ===== 限流（进程内滑动窗口；登录更严）=====

const rateBuckets = new Map<string, number[]>();
function rateAllow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ===== 请求体 =====

async function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > limitBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(b);
  }
  const params = new URLSearchParams(chunks.join('') || '');
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ===== 工具 =====

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(v));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

// ===== 页面路由处理器 =====

interface HandlerCtx {
  deps: SrFullDeps;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  auth: AuthedReq | null;
  pool: Awaited<ReturnType<typeof loadResearchPool>> | null;
}

type Handler = (ctx: HandlerCtx) => Promise<void>;

function requireAuth(ctx: HandlerCtx): AuthedReq | null {
  if (!ctx.auth) {
    redirect(ctx.res, '/login');
    return null;
  }
  return ctx.auth;
}

function requireCsrf(ctx: HandlerCtx, body: Record<string, string>): boolean {
  if (!ctx.auth || body._csrf !== ctx.auth.csrfToken) {
    send(ctx.res, 403, renderErrorPage(403, '会话校验失败（CSRF），请刷新页面重试。'));
    return false;
  }
  return true;
}

const handleLoginGet: Handler = async (ctx) => {
  if (ctx.auth) return redirect(ctx.res, '/');
  send(ctx.res, 200, renderLoginPage({}));
};

const handleLoginPost: Handler = async (ctx) => {
  if (ctx.deps.config.mode === 'local') return redirect(ctx.res, '/');
  const ip = ctx.req.socket.remoteAddress ?? '?';
  if (!rateAllow(`login:${ip}`, 10, 60_000)) {
    send(ctx.res, 429, renderLoginPage({ error: '尝试过于频繁，请稍后再试。' }));
    return;
  }
  const body = await readBody(ctx.req);
  const account = await authenticate(ctx.deps.srPool, String(body.username ?? ''), String(body.password ?? ''));
  if (!account) {
    send(ctx.res, 401, renderLoginPage({ error: '用户名或密码不正确。' }));
    return;
  }
  const issued = await createSession(ctx.deps.srPool, account.accountId, { ttlMs: ctx.deps.config.sessionTtlMs });
  await recordUsageEvent(ctx.deps.srPool, account.accountId, 'LOGIN', { ip });
  ctx.res.writeHead(302, {
    location: '/',
    'set-cookie': `${COOKIE_NAME}=${issued.cookieToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ctx.deps.config.sessionTtlMs / 1000)}`,
  });
  ctx.res.end();
};

const handleLogout: Handler = async (ctx) => {
  if (ctx.deps.config.mode === 'local') return redirect(ctx.res, '/');
  const body = await readBody(ctx.req);
  if (ctx.auth && requireCsrf(ctx, body)) {
    await revokeSession(ctx.deps.srPool, ctx.auth.sessionId);
  }
  ctx.res.writeHead(302, {
    location: '/login',
    'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  });
  ctx.res.end();
};

const handleHome: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const tasks = await listTasks(ctx.deps.srPool, auth.accountId, 50);
  const usage = await getQuotaUsage(ctx.deps.srPool, auth.accountId);
  const account = await getAccount(ctx.deps.srPool, auth.accountId);
  send(ctx.res, 200, renderDashboard({
    account: { username: auth.username, role: auth.role, displayName: account?.displayName ?? auth.username },
    tasks,
    pool: ctx.pool,
    csrf: auth.csrfToken,
    usage,
    quota: account?.quota ?? defaultTrialQuota(),
  }));
};

const handleTaskCreate: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const body = await readBody(ctx.req);
  if (!requireCsrf(ctx, body)) return;
  if (!rateAllow(`task:${auth.accountId}`, 12, 60_000)) {
    send(ctx.res, 429, renderErrorPage(429, '请求过于频繁，请稍后再试。'));
    return;
  }
  const subjectInput = String(body.subject ?? '').trim();
  if (!subjectInput) {
    send(ctx.res, 400, renderErrorPage(400, '请输入股票代码或名称。'));
    return;
  }
  const subjectInfo = ctx.pool ? await findSubject(ctx.pool, subjectInput) : null;
  if (!subjectInfo) {
    send(ctx.res, 200, renderErrorPage(200,
      `当前不支持「${subjectInput}」：首版支持研究池内的沪深主板股票（26 只，见首页列表）。` +
      `范围外标的未纳入是真实覆盖边界，不是故障。`));
    return;
  }
  const focus = ['FULL', 'BUSINESS', 'FINANCIAL_QUALITY', 'VALUATION', 'EVENTS'].includes(String(body.focus)) ? String(body.focus) as 'FULL' : 'FULL';
  const horizon = ['MID_TERM', 'LONG_TERM', 'NEAR_TERM'].includes(String(body.horizon)) ? String(body.horizon) as 'MID_TERM' : 'MID_TERM';
  const emphasis = String(body.emphasis ?? '').trim().slice(0, 500) || null;
  const account = await getAccount(ctx.deps.srPool, auth.accountId);
  const quota = account?.quota ?? defaultTrialQuota();
  const cutoff = new Date().toISOString();
  const localMode = ctx.deps.config.mode === 'local';

  // 并发任务上限（服务端）
  const running = (await listTasks(ctx.deps.srPool, auth.accountId, 100)).filter(
    (t) => t.status === 'QUEUED' || t.status === 'RUNNING',
  );
  if (running.length >= quota.maxConcurrentTasks) {
    send(ctx.res, 429, renderErrorPage(429, `并行的任务已达上限（${quota.maxConcurrentTasks}）。等待现有任务完成后再发起。`));
    return;
  }
  // 月度任务配额（原子预约；〔C3〕客户端本地模式不做配额——套餐退出当前范围）
  const reserve = localMode
    ? { ok: true, used: 0, limit: 0, period: 'local' }
    : await reserveQuota(ctx.deps.srPool, auth.accountId, 'REPORT_TASK', quota.monthlyReportTasks);
  if (!reserve.ok) {
    send(ctx.res, 429, renderErrorPage(429,
      `本月研究任务额度已用完（${reserve.used}/${reserve.limit}）。已有报告与追问不受影响；下月自动恢复或联系管理员调整。`));
    return;
  }
  const idemKey = sha256([auth.accountId, subjectInfo.code, focus, horizon, cutoff.slice(0, 10), emphasis ?? ''].join('|'));
  const { task, created } = await createTask(ctx.deps.srPool, {
    accountId: auth.accountId,
    subject: subjectInfo.code,
    subjectName: subjectInfo.name,
    focus,
    emphasis,
    horizon,
    cutoff,
    idemKey,
    methodVersion: 'sr-m1',
    adapterVersion: 'pool-frozen-1',
    planAuthVersion: 'sr-auth-1',
  });
  if (!created && !localMode) {
    // 〔R3 修复〕幂等命中既有任务：预约必须退还（此前只记账未退款，造成双扣）
    await refundQuota(ctx.deps.srPool, auth.accountId, 'REPORT_TASK', reserve.period);
    await recordUsageEvent(ctx.deps.srPool, auth.accountId, 'TASK_IDEM_HIT', { taskId: task.taskId, refunded: true });
  } else if (!created && localMode) {
    await recordUsageEvent(ctx.deps.srPool, auth.accountId, 'TASK_IDEM_HIT', { taskId: task.taskId });
  } else {
    await recordUsageEvent(ctx.deps.srPool, auth.accountId, 'TASK_CREATED', { taskId: task.taskId, subject: subjectInfo.code }, task.taskId);
  }
  redirect(ctx.res, `/tasks/${task.taskId}`);
};

const handleTaskPage: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const taskId = ctx.url.pathname.split('/')[2] ?? '';
  const task = await getTask(ctx.deps.srPool, taskId, auth.accountId);
  if (!task) return send(ctx.res, 404, renderErrorPage(404, '任务不存在或不属于当前账户。'));
  const steps = await listSteps(ctx.deps.srPool, taskId);
  const reports = await listReportVersions(ctx.deps.srPool, taskId);
  send(ctx.res, 200, renderTaskPage({ task, steps, reports, account: { username: auth.username, role: auth.role, displayName: (await getAccount(ctx.deps.srPool, auth.accountId))?.displayName ?? auth.username } }));
};

const handleReportPage: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const reportId = ctx.url.pathname.split('/')[2] ?? '';
  const vParam = Number(ctx.url.searchParams.get('v') ?? '0');
  const report = await getReportById(ctx.deps.srPool, reportId, auth.accountId);
  if (!report) return send(ctx.res, 404, renderErrorPage(404, '报告不存在或不属于当前账户。'));
  const versions = await listReportVersions(ctx.deps.srPool, report.taskId);
  const version = vParam > 0 ? versions.find((r) => r.version === vParam) ?? report : report;
  // 证据/计算表从任务输出目录读回（与引擎同一来源）
  const tablesById: Record<string, { title: string; columns: string[]; rows: (string | number | null)[][]; note: string | null }> = {};
  const dir = join(ctx.deps.outputDir ?? SR_OUTPUT_DIR, 'tasks', report.taskId);
  try {
    const pack = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
    for (const t of pack.tables ?? []) tablesById[t.tableId] = { title: t.title, columns: t.columns, rows: t.rows, note: t.unitNote };
  } catch { /* 缺失如实呈现 */ }
  try {
    const computed = JSON.parse(await readFile(join(dir, 'computed.json'), 'utf8'));
    for (const t of computed.tables ?? []) tablesById[t.tableId] = { title: t.title, columns: t.columns, rows: t.rows, note: t.formula ?? null };
  } catch { /* 同上 */ }
  const threadId = await listChatThreadForReport(ctx.deps, report.reportId, auth.accountId);
  const thread = threadId ? await getChatThread(ctx.deps.srPool, threadId) : null;
  const messages = thread ? await listChatMessages(ctx.deps.srPool, thread.threadId) : [];
  send(ctx.res, 200, renderReportPage({ report, versions, tablesById, messages, csrf: auth.csrfToken, account: { username: auth.username, role: auth.role, displayName: (await getAccount(ctx.deps.srPool, auth.accountId))?.displayName ?? auth.username } }));
};

async function listChatThreadForReport(deps: SrServerDeps, reportId: string, accountId: string): Promise<string | null> {
  const t = await deps.srPool.query<{ thread_id: string }>(
    `select t.thread_id from sr_chat_thread t
     join sr_task k on k.task_id = (select task_id from sr_report where report_id = $1::uuid)
     where t.report_id = $1::uuid and k.account_id = $2::uuid limit 1`,
    [reportId, accountId],
  );
  return t.rows[0]?.thread_id ?? null;
}

const handleReportPdf: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const reportId = ctx.url.pathname.split('/')[2] ?? '';
  const vParam = Number(ctx.url.searchParams.get('v') ?? '0');
  const latest = await getReportById(ctx.deps.srPool, reportId, auth.accountId);
  if (!latest) return send(ctx.res, 404, renderErrorPage(404, '报告不存在或不属于当前账户。'));
  const versions = await listReportVersions(ctx.deps.srPool, latest.taskId);
  const report = vParam > 0 ? versions.find((r) => r.version === vParam) ?? latest : latest;
  const tablesById: Record<string, { title: string; columns: string[]; rows: (string | number | null)[][]; note: string | null }> = {};
  const dir = join(ctx.deps.outputDir ?? SR_OUTPUT_DIR, 'tasks', report.taskId);
  try {
    const pack = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8'));
    for (const t of pack.tables ?? []) tablesById[t.tableId] = { title: t.title, columns: t.columns, rows: t.rows, note: t.unitNote };
  } catch { /* 缺失如实呈现 */ }
  try {
    const computed = JSON.parse(await readFile(join(dir, 'computed.json'), 'utf8'));
    for (const t of computed.tables ?? []) tablesById[t.tableId] = { title: t.title, columns: t.columns, rows: t.rows, note: t.formula ?? null };
  } catch { /* 同上 */ }
  const buf = await renderReportPdf(report, tablesById);
  ctx.res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="lyra-${report.subject}-v${report.version}.pdf"`,
  });
  ctx.res.end(buf);
};

const handleChatPost: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const reportId = ctx.url.pathname.split('/')[2] ?? '';
  const body = await readBody(ctx.req);
  if (!requireCsrf(ctx, body)) return;
  if (!rateAllow(`chat:${auth.accountId}`, 30, 60_000)) {
    send(ctx.res, 429, renderErrorPage(429, '提问过于频繁，请稍后再试。'));
    return;
  }
  const report = await getReportById(ctx.deps.srPool, reportId, auth.accountId);
  if (!report) return send(ctx.res, 404, renderErrorPage(404, '报告不存在或不属于当前账户。'));
  const question = String(body.question ?? '').trim().slice(0, 2000);
  if (!question) return send(ctx.res, 400, renderErrorPage(400, '问题不能为空。'));
  const account = await getAccount(ctx.deps.srPool, auth.accountId);
  const quota = account?.quota ?? defaultTrialQuota();
  if (ctx.deps.config.mode !== 'local') {
    const callReserve = await reserveQuota(ctx.deps.srPool, auth.accountId, 'MODEL_CALL', quota.monthlyModelCalls);
    if (!callReserve.ok) {
      send(ctx.res, 429, renderErrorPage(429, `本月模型调用额度已用完（${callReserve.used}/${callReserve.limit}）。报告阅读不受影响。`));
      return;
    }
  }
  const deps = ctx.deps;
  const dir = join(deps.outputDir ?? SR_OUTPUT_DIR, 'tasks', report.taskId);
  let pack: unknown = null;
  let computed: unknown = null;
  try { pack = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8')); } catch { /* 缺失则空 */ }
  try { computed = JSON.parse(await readFile(join(dir, 'computed.json'), 'utf8')); } catch { /* 同上 */ }
  try {
    const { askReportQuestion } = await import('./engine.js');
    await askReportQuestion(
      {
        srPool: deps.srPool,
        dataPool: deps.dataPool,
        transport: deps.transport,
        budget: deps.budget,
        outputDir: deps.outputDir ?? SR_OUTPUT_DIR,
      },
      auth.accountId,
      {
        taskId: report.taskId,
        reportVersion: report.version,
        question,
        questionKind: classifyQuestion(question),
        pack: pack as never,
        computed: computed as never,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(ctx.res, 500, renderErrorPage(500, `回答失败：${message.slice(0, 300)}。额度未消耗成功调用；请重试或稍后再问。`));
    return;
  }
  redirect(ctx.res, `/reports/${reportId}?v=${report.version}#chat`);
};

const handleRevisePost: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const reportId = ctx.url.pathname.split('/')[2] ?? '';
  const body = await readBody(ctx.req);
  if (!requireCsrf(ctx, body)) return;
  const report = await getReportById(ctx.deps.srPool, reportId, auth.accountId);
  if (!report) return send(ctx.res, 404, renderErrorPage(404, '报告不存在或不属于当前账户。'));
  const emphasis = String(body.emphasis ?? '').trim().slice(0, 500) || null;
  const useNewCutoff = String(body.new_cutoff ?? '') === '1';
  const account = await getAccount(ctx.deps.srPool, auth.accountId);
  const quota = account?.quota ?? defaultTrialQuota();
  const reserve = ctx.deps.config.mode === 'local'
    ? { ok: true, used: 0, limit: 0, period: 'local' }
    : await reserveQuota(ctx.deps.srPool, auth.accountId, 'REPORT_TASK', quota.monthlyReportTasks);
  if (!reserve.ok) {
    send(ctx.res, 429, renderErrorPage(429, `本月研究任务额度已用完（${reserve.used}/${reserve.limit}）。`));
    return;
  }
  const cutoff = useNewCutoff ? new Date().toISOString() : report.cutoff; // 不勾选则沿用原截点（同资料下的假设修订）
  const idemKey = sha256([auth.accountId, report.subject, report.focus, 'REVISE', cutoff.slice(0, 10), emphasis ?? '', Date.now()].join('|'));
  const { task } = await createTask(ctx.deps.srPool, {
    accountId: auth.accountId,
    subject: report.subject,
    subjectName: report.subjectName,
    focus: report.focus,
    emphasis,
    horizon: report.horizon,
    cutoff,
    idemKey,
    revisedFromTaskId: report.taskId,
    methodVersion: 'sr-m1',
    adapterVersion: 'pool-frozen-1',
    planAuthVersion: 'sr-auth-1',
  });
  await recordUsageEvent(ctx.deps.srPool, auth.accountId, 'TASK_REVISED', { taskId: task.taskId, from: report.taskId }, task.taskId);
  redirect(ctx.res, `/tasks/${task.taskId}`);
};

const handleUsage: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const usage = await getQuotaUsage(ctx.deps.srPool, auth.accountId);
  const account = await getAccount(ctx.deps.srPool, auth.accountId);
  const events = await ctx.deps.srPool.query(
    `select kind, detail, created_at from sr_usage_event where account_id = $1::uuid order by created_at desc limit 50`,
    [auth.accountId],
  );
  send(ctx.res, 200, renderUsagePage({
    username: auth.username,
    usage,
    quota: account?.quota ?? defaultTrialQuota(),
    events: events.rows.map((r: { kind: string; detail: Record<string, unknown>; created_at: Date }) => ({
      kind: r.kind, detail: r.detail, at: r.created_at.toISOString(),
    })),
  }));
};

const handleAdmin: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  if (ctx.deps.config.mode === 'local') {
    return send(ctx.res, 200, renderErrorPage(200, '单平台客户端模式：账户与套餐管理不在当前交付范围（LYRA_SR_MODE=saas 可启用多账户面）。'));
  }
  if (auth.role !== 'ADMIN') return send(ctx.res, 403, renderErrorPage(403, '需要管理员权限。'));
  const accounts = await ctx.deps.srPool.query(
    `select a.account_id, a.username, a.display_name, a.role, a.quota, a.created_at, a.disabled_at,
            (select count(*) from sr_task t where t.account_id = a.account_id) as tasks
     from sr_account a order by a.created_at`,
  );
  send(ctx.res, 200, renderAdminPage({
    accounts: accounts.rows.map((r: Record<string, unknown>) => ({
      accountId: String(r.account_id), username: String(r.username), displayName: String(r.display_name ?? ''),
      role: String(r.role), quota: r.quota as never, tasks: Number(r.tasks),
      disabled: r.disabled_at !== null,
    })),
    csrf: auth.csrfToken,
  }));
};

const handleAdminCreateAccount: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const body = await readBody(ctx.req);
  if (!requireCsrf(ctx, body)) return;
  if (auth.role !== 'ADMIN') return send(ctx.res, 403, renderErrorPage(403, '需要管理员权限。'));
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const monthly = Number(body.monthly_tasks ?? 5) || 5;
  const monthlyCalls = Number(body.monthly_calls ?? 60) || 60;
  try {
    await createAccount(ctx.deps.srPool, {
      username,
      password,
      displayName: String(body.display_name ?? '').trim() || username,
      role: 'USER',
      quota: { monthlyReportTasks: monthly, monthlyModelCalls: monthlyCalls, maxConcurrentTasks: 1, note: '试用' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(ctx.res, 400, renderErrorPage(400, `创建失败：${message.slice(0, 300)}`));
  }
  redirect(ctx.res, '/admin');
};

const handleAdminSetQuota: Handler = async (ctx) => {
  const auth = requireAuth(ctx);
  if (!auth) return;
  const body = await readBody(ctx.req);
  if (!requireCsrf(ctx, body)) return;
  if (auth.role !== 'ADMIN') return send(ctx.res, 403, renderErrorPage(403, '需要管理员权限。'));
  const accountId = String(body.account_id ?? '');
  const quota = {
    monthlyReportTasks: Number(body.monthly_tasks ?? 5) || 5,
    monthlyModelCalls: Number(body.monthly_calls ?? 60) || 60,
    maxConcurrentTasks: Number(body.max_concurrent ?? 1) || 1,
    note: String(body.note ?? '试用'),
  };
  await setAccountQuota(ctx.deps.srPool, accountId, quota);
  redirect(ctx.res, '/admin');
};

const handleHealthz: Handler = async (ctx) => {
  let db = false;
  try {
    await ctx.deps.srPool.query('select 1');
    db = true;
  } catch { db = false; }
  sendJson(ctx.res, 200, { ok: db, db, uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
};

const handleCss: Handler = async (ctx) => {
  const css = await readFile(new URL('./sr.css', import.meta.url), 'utf8');
  ctx.res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
  ctx.res.end(css);
};

async function realStrategyContext(ctx: HandlerCtx) {
  if (!requireAuth(ctx)) return null;
  try {
    if (!ctx.deps.strategyStore) throw new Error('STRATEGY_REAL_DATA_NOT_CONFIGURED');
    const loaded = await ctx.deps.strategyStore.load();
    ctx.res.setHeader('x-lyra-data-hash', loaded.data.dataHash);
    ctx.res.setHeader('x-lyra-strategy-view-hash', loaded.view.viewHash);
    if (loaded.researchReview) ctx.res.setHeader('x-lyra-strategy-review-hash', loaded.researchReview.resultHash);
    ctx.res.setHeader('cache-control', 'no-store');
    return loaded;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : 'STRATEGY_REAL_DATA_UNAVAILABLE';
    if (ctx.url.pathname.startsWith('/api/')) sendJson(ctx.res, 503, { error: { code }, identity: 'REAL_DATA_REQUIRED', fallback: false });
    else send(ctx.res, 503, renderErrorPage(503, '本机的封存策略资料尚未载入或校验未通过。请载入有效数据包后重新打开；不会切换到模拟资料。'));
    return null;
  }
}

const handleRealStrategyPage: Handler = async (ctx) => {
  const loaded = await realStrategyContext(ctx);
  if (!loaded) return;
  const auth = ctx.auth!;
  send(ctx.res, 200, renderRealStrategyPage({ view: loaded.view, ...(loaded.researchReview ? { researchReview: loaded.researchReview } : {}), csrf: auth.csrfToken, account: { username: auth.username, displayName: auth.username, role: auth.role } }));
};
const handleRealStrategyApi: Handler = async (ctx) => {
  const loaded = await realStrategyContext(ctx);
  if (loaded) sendJson(ctx.res, 200, { ...loaded.view, manifestSha256: loaded.manifestSha256, researchReview: loaded.researchReview ?? { status: 'NOT_RUN', executionEligible: false, realReviewDone: false } });
};
const handleRealStrategyData: Handler = async (ctx) => {
  const loaded = await realStrategyContext(ctx);
  if (loaded) sendJson(ctx.res, 200, { manifestSha256: loaded.manifestSha256, data: loaded.data });
};
const handleRealStrategySource: Handler = async (ctx) => {
  const loaded = await realStrategyContext(ctx);
  if (!loaded) return;
  const id = ctx.url.pathname.endsWith('/report') ? loaded.view.companyReportSourceId : ctx.url.pathname.split('/').at(-1)!;
  try {
    const source = await ctx.deps.strategyStore!.source(id);
    ctx.res.writeHead(200, { 'content-type': `${source.mediaType}; charset=utf-8`, 'x-lyra-source-sha256': source.sha256, 'x-content-type-options': 'nosniff' });
    ctx.res.end(source.bytes);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'STRATEGY_SOURCE_UNAVAILABLE';
    sendJson(ctx.res, code === 'STRATEGY_SOURCE_NOT_FOUND' ? 404 : 503, { error: { code } });
  }
};

async function workbenchState(ctx: HandlerCtx): Promise<WorkbenchPageState> {
  ctx.res.setHeader('cache-control', 'no-store');
  if (!ctx.deps.workbenchStore) return { status: 'NOT_CONFIGURED', detail: '未配置L2封存文件工作区。' };
  try {
    const loaded = await ctx.deps.workbenchStore.load();
    if (loaded.result.subject !== '601919') throw new Error('WORKBENCH_SUBJECT_MISMATCH');
    ctx.res.setHeader('x-lyra-workbench-result-hash', loaded.result.resultHash);
    ctx.res.setHeader('x-lyra-workbench-manifest-sha256', loaded.manifestSha256);
    return { status: 'LOADED', loaded };
  } catch (err) { return { status: 'FAILED', detail: err instanceof Error ? err.message : 'WORKBENCH_LOAD_FAILED' }; }
}
function workbenchPage(ctx: HandlerCtx, state: WorkbenchPageState, status: number, values?: Record<string, string>, error?: string): void {
  const auth = ctx.auth!;
  send(ctx.res, status, renderL2WorkbenchPage({ state, csrf: auth.csrfToken, account: { username: auth.username, displayName: auth.username, role: auth.role }, ...(values ? { values } : {}), ...(error ? { error } : {}) }));
}
const handleWorkbenchPage: Handler = async (ctx) => {
  if (!requireAuth(ctx)) return;
  const state = await workbenchState(ctx);
  workbenchPage(ctx, state, state.status === 'LOADED' ? 200 : 503);
};
const handleWorkbenchApi: Handler = async (ctx) => {
  if (!requireAuth(ctx)) return;
  const state = await workbenchState(ctx);
  sendJson(ctx.res, state.status === 'LOADED' ? 200 : 503, state.status === 'LOADED' ? state.loaded : { ...state, fallback: false });
};
const handleWorkbenchSource: Handler = async (ctx) => {
  if (!requireAuth(ctx)) return;
  const state = await workbenchState(ctx);
  if (state.status !== 'LOADED') { sendJson(ctx.res, 503, { ...state, fallback: false }); return; }
  const id = decodeURIComponent(ctx.url.pathname.split('/').at(-1)!);
  if (!state.loaded.sources.some((s) => s.id === id)) { sendJson(ctx.res, 404, { error: 'WORKBENCH_SOURCE_NOT_FOUND' }); return; }
  try {
    const source = await ctx.deps.workbenchStore!.source(id);
    ctx.res.writeHead(200, { 'content-type': `${source.mediaType}; charset=utf-8`, 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'x-lyra-source-sha256': source.sha256 });
    ctx.res.end(source.bytes);
  } catch (err) { sendJson(ctx.res, 503, { status: 'FAILED', error: err instanceof Error ? err.message : 'WORKBENCH_SOURCE_FAILED', fallback: false }); }
};
const handleRiskExport: Handler = async (ctx) => {
  const auth = requireAuth(ctx); if (!auth) return;
  ctx.res.setHeader('cache-control', 'no-store');
  let body: Record<string, string>;
  try { body = await readBody(ctx.req); } catch { send(ctx.res, 413, renderErrorPage(413, '风险输入过大，请缩短持仓记录。')); return; }
  if (!requireCsrf(ctx, body)) return;
  if (!rateAllow(`risk-export:${auth.accountId}`, 12, 60_000)) { send(ctx.res, 429, renderErrorPage(429, '风险导出过于频繁，请稍后重试。')); return; }
  try {
    if (body.action === 'add-lot') {
      const count = riskLotCount(body);
      if (count >= RISK_LOT_LIMIT) throw new RiskInputError('lotCount', `本次导出最多填写${RISK_LOT_LIMIT}批持仓`);
      workbenchPage(ctx, await workbenchState(ctx), 200, { ...body, lotCount: String(count + 1) });
      return;
    }
    const output = createRiskExport(body, 'USER_CONFIRMED_INPUT');
    ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="lyra-l2-risk-601919-${output.exportHash.slice(0, 12)}.json"`, 'x-content-type-options': 'nosniff' });
    ctx.res.end(JSON.stringify(output, null, 2)+'\n');
  } catch (err) {
    if (!(err instanceof RiskInputError)) throw err;
    // 输入错误独立于工作区文件；保留原值，但必须重新勾选确认。
    workbenchPage(ctx, await workbenchState(ctx), 422, body, err.message);
  }
};

// ===== 服务装配 =====

export function createSrServer(deps: SrFullDeps): Server {
  assertLocalBind(deps.config);
  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
    { method: 'GET', pattern: /^\/login$/, handler: handleLoginGet },
    { method: 'POST', pattern: /^\/login$/, handler: handleLoginPost },
    { method: 'POST', pattern: /^\/logout$/, handler: handleLogout },
    { method: 'GET', pattern: /^\/$/, handler: handleHome },
    { method: 'GET', pattern: /^\/assets\/sr\.css$/, handler: handleCss },
    { method: 'GET', pattern: /^\/strategies\/601919$/, handler: handleRealStrategyPage },
    { method: 'GET', pattern: /^\/strategies\/601919\/workbench$/, handler: handleWorkbenchPage },
    { method: 'GET', pattern: /^\/api\/strategies\/601919\/workbench$/, handler: handleWorkbenchApi },
    { method: 'GET', pattern: /^\/api\/strategies\/601919\/workbench\/sources\/[^/]+$/, handler: handleWorkbenchSource },
    { method: 'POST', pattern: /^\/strategies\/601919\/workbench\/risk-export$/, handler: handleRiskExport },
    { method: 'GET', pattern: /^\/strategies\/601919\/report$/, handler: handleRealStrategySource },
    { method: 'GET', pattern: /^\/api\/strategies\/601919$/, handler: handleRealStrategyApi },
    { method: 'GET', pattern: /^\/api\/strategies\/601919\/data$/, handler: handleRealStrategyData },
    { method: 'GET', pattern: /^\/api\/strategies\/601919\/sources\/[a-z0-9-]+$/, handler: handleRealStrategySource },
    { method: 'POST', pattern: /^\/tasks$/, handler: handleTaskCreate },
    { method: 'GET', pattern: /^\/tasks\/[0-9a-f-]+$/, handler: handleTaskPage },
    { method: 'GET', pattern: /^\/reports\/[0-9a-f-]+$/, handler: handleReportPage },
    { method: 'GET', pattern: /^\/reports\/[0-9a-f-]+\/pdf$/, handler: handleReportPdf },
    { method: 'POST', pattern: /^\/reports\/[0-9a-f-]+\/chat$/, handler: handleChatPost },
    { method: 'POST', pattern: /^\/reports\/[0-9a-f-]+\/revise$/, handler: handleRevisePost },
    { method: 'GET', pattern: /^\/usage$/, handler: handleUsage },
    { method: 'GET', pattern: /^\/admin$/, handler: handleAdmin },
    { method: 'POST', pattern: /^\/admin\/accounts$/, handler: handleAdminCreateAccount },
    { method: 'POST', pattern: /^\/admin\/quota$/, handler: handleAdminSetQuota },
    { method: 'GET', pattern: /^\/healthz$/, handler: handleHealthz },
  ];

  const server = createServer(async (req, res) => {
    try {
      const boundaryError = deps.config.mode === 'local' ? localRequestError(req) : null;
      if (boundaryError) {
        send(res, 403, renderErrorPage(403, boundaryError));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = (req.method ?? 'GET').toUpperCase();
      const auth = await authed(deps, req);
      let pool: Awaited<ReturnType<typeof loadResearchPool>> | null = deps.poolCache ?? null;
      if (!pool) {
        try {
          pool = await loadResearchPool();
          deps.poolCache = pool;
        } catch { pool = null; }
      }
      const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!route) {
        send(res, 404, renderErrorPage(404, '页面不存在。'));
        return;
      }
      if (method === 'POST' && !rateAllow(`write:${auth?.accountId ?? req.socket.remoteAddress ?? '?'}`, 120, 60_000)) {
        send(res, 429, renderErrorPage(429, '请求过于频繁。'));
        return;
      }
      await route.handler({ deps, req, res, url, auth, pool });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        send(res, 500, renderErrorPage(500, `服务内部错误：${message.slice(0, 300)}`));
      } catch { /* 响应已发送 */ }
    }
  });
  return server;
}

// ===== 进程内 worker（单执行器）=====

export interface SrWorkerHandle {
  stop(): Promise<void>;
}

export async function startSrWorker(deps: SrFullDeps): Promise<SrWorkerHandle> {
  const holder = `sr-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  await acquireSrEngineLock(deps.srPool, holder);
  await srBootRecovery(deps.srPool); // 非闭合调用 → RECONCILING（页面如实展示，零自动调用）
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await heartbeatSrEngineLock(deps.srPool, holder);
        const task = await claimQueuedTask(deps.srPool, holder);
        if (!task) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        await runSrTask(
          { srPool: deps.srPool, dataPool: deps.dataPool, transport: deps.transport, budget: deps.budget, outputDir: deps.outputDir ?? SR_OUTPUT_DIR },
          task.taskId,
        );
        await recordUsageEvent(deps.srPool, task.accountId, 'TASK_FINISHED', { taskId: task.taskId }, task.taskId);
      } catch (err) {
        // 引擎自身已把任务落 FAILED；此处只避免 worker 崩溃
        if (!stopped) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void loop();
  return {
    stop: async () => {
      stopped = true;
      await releaseSrEngineLock(deps.srPool, holder).catch(() => undefined);
    },
  };
}

// ===== 启动入口（CLI：node --import tsx src/stock-research/server.ts）=====

export async function main(): Promise<void> {
  const { createPool } = await import('../db/pool.js');
  const { applySchema, srMigrationSqlUrl } = await import('../db/exec.js');
  const { SimSrTransport, selectSrTransport } = await import('./transport.js');
  const { defaultSrPlanBudget } = await import('./contracts.js');

  const config = srServerConfigFromEnv(process.env);
  const adminPool = createPool(); // 应用 sr 命名空间（新建，不触碰 public 既有对象）
  await applySchema(adminPool, 'sr', srMigrationSqlUrl);
  await adminPool.end();
  const srPool = createPool({ schema: 'sr' });
  const dataPool = createPool(); // 只读事实面（public）

  // 管理员自举：无任何账户时，用 env 凭据建 admin（缺省 admin/随机密码打印一次）
  const count = await srPool.query('select count(*)::int as n from sr_account');
  if ((count.rows[0]?.n ?? 0) === 0) {
    const username = config.adminUser ?? 'admin';
    const password = config.adminPassword ?? `lyra-${randomUUID().slice(0, 12)}`;
    await createAccount(srPool, {
      username, password, displayName: '管理员', role: 'ADMIN',
      quota: { monthlyReportTasks: 999, monthlyModelCalls: 9999, maxConcurrentTasks: 2, note: '管理员' },
    });
    if (!config.adminPassword) {
      console.log(`[sr] 已创建管理员账户 ${username}，一次性密码：${password}（请立即登录并妥善保管；本行不会再次显示）`);
    }
  }
  await purgeExpiredSessions(srPool).catch(() => undefined);

  const preferSim = !['real', 'dsh'].includes(process.env.LYRA_SR_TRANSPORT ?? 'sim');
  const transport = selectSrTransport(process.env, preferSim) ?? new SimSrTransport();
  const deps: SrFullDeps = {
    srPool, dataPool, config, transport,
    budget: defaultSrPlanBudget(),
    outputDir: process.env.LYRA_SR_OUTPUT_DIR ?? SR_OUTPUT_DIR,
  };
  const strategyManifest = process.env.LYRA_SR_STRATEGY_MANIFEST;
  if (strategyManifest) deps.strategyStore = fileStrategyStore(strategyManifest, process.env.LYRA_SR_STRATEGY_MANIFEST_SHA256 ?? '');
  if (config.mode === 'local') {
    // 〔C3〕客户端本地单用户：自动持有 owner 账户（无登录面；密码随机不使用）
    const existing = await srPool.query<{ account_id: string }>(`select account_id from sr_account where username = 'owner' limit 1`);
    if (existing.rows[0]) {
      deps.localAccountId = existing.rows[0].account_id;
    } else {
      const acc = await createAccount(srPool, {
        username: 'owner', password: `local-${randomUUID()}`, displayName: 'Owner（本机）', role: 'ADMIN',
        quota: { monthlyReportTasks: 10_000, monthlyModelCalls: 100_000, maxConcurrentTasks: 2, note: '单平台客户端（本机）' },
      });
      deps.localAccountId = acc.accountId;
    }
    deps.localCsrf = randomUUID();
    console.log('[sr] 单平台客户端本地模式：免登录单用户（owner）；账户/套餐面未启用（LYRA_SR_MODE=saas 可切换）');
  }

  const worker = await startSrWorker(deps);
  const server = createSrServer(deps);
  server.listen(config.port, config.bind, () => {
    console.log(`[sr] 单股研究报告服务 http://${config.bind}:${config.port}（通道：${transport.describe().provider}）`);
  });
  const shutdown = async () => {
    await worker.stop();
    server.close();
    await srPool.end().catch(() => undefined);
    await dataPool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('stock-research/server.ts')) {
  void main();
}
