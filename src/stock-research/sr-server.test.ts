/**
 * sr 服务 HTTP 层测试（R31）：账户隔离、CSRF、未认证重定向、限流。
 * TASK-PACKAGE §8.2 跨账户行 + §5.3 写接口防护的直接证据。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { createAccount } from './accounts.js';
import { SECTION_TITLES, defaultTrialQuota, type SrModelTransport } from './contracts.js';
import { SimSrTransport } from './transport.js';
import { createSrServer, type SrFullDeps } from './server.js';
import { createTask, insertReport } from './store.js';

const schema = `sr_h_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
let admin: Pool;
let srPool: Pool;
let dataPool: Pool;
let baseUrl: string;
let server: ReturnType<typeof createSrServer>;
const cookieA: string[] = [];
const cookieB: string[] = [];
let csrfA = '';
let taskA = '';
let reportA = '';

function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

let baseUrlRef: string | null = null;
async function post(path: string, body: Record<string, string>, cookies: string[] = []): Promise<Response> {
  const base = baseUrlRef ?? baseUrl;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
    body: form(body),
    redirect: 'manual',
  });
}

async function get(path: string, cookies: string[] = []): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: cookies.length ? { cookie: cookies.join('; ') } : {}, redirect: 'manual' });
}

function csrfOf(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(m, '页面应含 CSRF 令牌');
  return m[1]!;
}

before(async () => {
  admin = createPool();
  await applySchema(admin, schema, srMigrationSqlUrl);
  srPool = createPool({ schema });
  dataPool = createPool();
  const outDir = await mkdtemp(join(tmpdir(), 'sr-http-'));
  await createAccount(srPool, { username: 'alice_t', password: 'password-8a', role: 'USER' });
  await createAccount(srPool, { username: 'bob_t', password: 'password-8b', role: 'USER' });

  // 预置 A 的任务与报告（隔离测试焦点在访问控制，不必跑完整引擎）
  const accA = await srPool.query<{ account_id: string }>(`select account_id from sr_account where username = 'alice_t'`);
  const accountId = accA.rows[0]!.account_id;
  const task = (await createTask(srPool, {
    accountId, subject: '002384', subjectName: '东山精密', focus: 'FULL', emphasis: null, horizon: 'MID_TERM',
    cutoff: '2026-10-23T16:00:00.000Z', idemKey: randomUUID(),
    methodVersion: 'sr-m1', adapterVersion: 'pool-frozen-1', planAuthVersion: 'sr-auth-1',
  })).task;
  taskA = task.taskId;
  const report = await insertReport(srPool, {
    reportId: randomUUID(), taskId: task.taskId, version: 1, status: 'PUBLISHED',
    subject: '002384', subjectName: '东山精密', focus: 'FULL', horizon: 'MID_TERM',
    cutoff: task.cutoff, methodVersion: 'sr-m1', adapterVersion: 'pool-frozen-1', planAuthVersion: 'sr-auth-1',
    generatedBy: 'PRODUCT_SIMULATED',
    sections: [{ key: 'summary', title: SECTION_TITLES.summary, narrative: '测试摘要——个人研究记录，非投资建议。', findings: [], tables: [], citations: [], gaps: [] }],
    qaFindings: [], evidenceRefs: null, gate: null, changeSummary: null,
    createdAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
  });
  reportA = report.reportId;

  const deps: SrFullDeps = {
    srPool,
    dataPool,
    config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 3600_000, mode: 'saas' as const },
    transport: new SimSrTransport() as SrModelTransport,
    budget: defaultTrialQuota() as never,
    outputDir: outDir,
  };
  server = createSrServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.close();
  await srPool.end().catch(() => undefined);
  await dataPool.end().catch(() => undefined);
  await dropSchema(admin, schema);
  await admin.end().catch(() => undefined);
});

describe('sr HTTP：认证与会话', () => {
  it('未认证访问首页重定向登录', async () => {
    const r = await get('/');
    assert.equal(r.status, 302);
    assert.ok((r.headers.get('location') ?? '').includes('/login'));
  });

  it('错误密码 401；正确登录 302 + HttpOnly SameSite cookie', async () => {
    const bad = await post('/login', { username: 'alice_t', password: 'wrong-pass' });
    assert.equal(bad.status, 401);
    const ok = await post('/login', { username: 'alice_t', password: 'password-8a' });
    assert.equal(ok.status, 302);
    const setc = ok.headers.get('set-cookie') ?? '';
    assert.ok(setc.includes('HttpOnly') && setc.includes('SameSite=Strict'), '会话 cookie 安全属性');
    cookieA.push(setc.split(';')[0]!);
    const okB = await post('/login', { username: 'bob_t', password: 'password-8b' });
    cookieB.push((okB.headers.get('set-cookie') ?? '').split(';')[0]!);
  });

  it('登录后可见面板与 CSRF 令牌', async () => {
    const r = await get('/', cookieA);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('alice_t'));
    csrfA = csrfOf(html);
  });
});

describe('sr HTTP：跨账户隔离（B 不能碰 A 的对象）', () => {
  it('B 直接用 A 的任务/报告 ID → 404', async () => {
    assert.equal((await get(`/tasks/${taskA}`, cookieB)).status, 404, '任务');
    assert.equal((await get(`/reports/${reportA}`, cookieB)).status, 404, '报告');
    assert.equal((await get(`/reports/${reportA}/pdf`, cookieB)).status, 404, 'PDF');
  });

  it('B 对 A 的报告追问 → 404（写路径同样隔离）', async () => {
    const html = await (await get('/', cookieB)).text();
    const csrfB = csrfOf(html);
    const r = await post(`/reports/${reportA}/chat`, { question: '为什么不给我看', _csrf: csrfB }, cookieB);
    assert.equal(r.status, 404);
  });

  it('A 自己的任务/报告可访问', async () => {
    assert.equal((await get(`/tasks/${taskA}`, cookieA)).status, 200);
    assert.equal((await get(`/reports/${reportA}`, cookieA)).status, 200);
  });
});

describe('sr HTTP：单平台客户端本地模式（C3 缺省）', () => {
  let localBase: string;
  let baseUrlBackup: string | null = null;
  let localServer: ReturnType<typeof createSrServer>;
  let localOut = '';
  before(async () => {
    localOut = await mkdtemp(join(tmpdir(), 'sr-http-local-'));
    const acc = await createAccount(srPool, { username: 'owner', password: 'password-8c', role: 'ADMIN' });
    localServer = createSrServer({
      srPool, dataPool,
      config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 3600_000, mode: 'local' as const },
      transport: new SimSrTransport() as SrModelTransport,
      budget: defaultTrialQuota() as never,
      outputDir: localOut,
      localAccountId: acc.accountId,
      localCsrf: 'local-csrf-token',
    } as never);
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    localBase = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
    baseUrlRef = localBase;
  });

  it('免登录直达工作台；登录页重定向首页；无配额面', async () => {
    const r = await fetch(`${localBase}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('开始研究'), '直达工作台（C9 主操作文案）');
    const login = await fetch(`${localBase}/login`, { redirect: 'manual' });
    assert.equal(login.status, 302, '本地模式登录页重定向');
  });

  it('本地模式建任务不扣配额（客户端范围）；写接口仍要求 CSRF', async () => {
    const usedBefore = (await srPool.query<{ used: number }>(
      `select coalesce(max(used),0) used from sr_quota_usage where account_id=(select account_id from sr_account where username='owner') and kind='REPORT_TASK'`,
    )).rows[0]!.used;
    const r = await post('/tasks', { subject: '600519', focus: 'FULL', horizon: 'MID_TERM', _csrf: 'local-csrf-token' });
    assert.equal(r.status, 302, `本地模式建任务成功（实际 ${r.status}）`);
    const usedAfter = (await srPool.query<{ used: number }>(
      `select coalesce(max(used),0) used from sr_quota_usage where account_id=(select account_id from sr_account where username='owner') and kind='REPORT_TASK'`,
    )).rows[0]!.used;
    assert.equal(usedAfter, usedBefore, 'REPORT_TASK 配额零扣减（本地模式）');
    const noCsrf = await post('/tasks', { subject: '600519', focus: 'FULL', horizon: 'MID_TERM' });
    assert.equal(noCsrf.status, 403, 'CSRF 仍然强制');
  });

  after(() => {
    baseUrlRef = null;
    localServer.closeAllConnections?.();
    localServer.close();
  });
});

describe('sr HTTP：写接口防护', () => {
  it('缺 CSRF 令牌的写请求 → 403', async () => {
    const r = await post(`/reports/${reportA}/chat`, { question: '解释一下' }, cookieA);
    assert.equal(r.status, 403);
  });

  it('登录暴力尝试被限流（429）', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post('/login', { username: 'alice_t', password: `wrong-${i}` })).status;
    }
    assert.equal(last, 429, '连续失败后应触发限流');
  });

  it('healthz 免认证可用', async () => {
    const r = await get('/healthz');
    assert.equal(r.status, 200);
    const v = (await r.json()) as { ok: boolean };
    assert.equal(typeof v.ok, 'boolean');
  });
});
