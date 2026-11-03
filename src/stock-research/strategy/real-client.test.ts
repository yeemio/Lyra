import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { canonicalSha256 } from '../../canonical.js';
import type { ReportDocument } from '../contracts.js';
import { renderRealStrategyPage, renderReportPage } from '../render.js';
import { createSrServer, type SrFullDeps } from '../server.js';
import { realFileClientDeps } from './client-preview.js';
import { assertRealDataset, buildRealStrategyView, type RealDailyDataset } from './real-research.js';
import { REAL_DATA_ROOT } from './real-seal.js';
import { fileStrategyStore, type RealClientManifest } from './real-store.js';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
let manifest: RealClientManifest, pin: string, data: RealDailyDataset, deps: SrFullDeps, url: string, temp: string;
let server: ReturnType<typeof createSrServer>;
let realDatabaseAttempts = 0, externalAttempts = 0, modelAttempts = 0;
const originalQuery = Pool.prototype.query, originalConnect = Pool.prototype.connect, originalFetch = globalThis.fetch;

async function listen(d: SrFullDeps) {
  const s = createSrServer(d);
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
async function close(s: ReturnType<typeof createSrServer>) { await new Promise<void>((done, reject) => s.close((err) => err ? reject(err) : done())); }
before(async () => {
  const bytes = await readFile(join(REAL_DATA_ROOT, 'client-manifest.json')); pin = hash(bytes); manifest = JSON.parse(bytes.toString());
  data = JSON.parse(await readFile(join(REAL_DATA_ROOT, 'real-dataset.json'), 'utf8'));
  temp = await mkdtemp(join(tmpdir(), 'lyra-real-client-'));
  Pool.prototype.query = (() => { realDatabaseAttempts++; throw new Error('NO_REAL_DATABASE_IN_CLIENT_TEST'); }) as typeof originalQuery;
  Pool.prototype.connect = (() => { realDatabaseAttempts++; throw new Error('NO_REAL_DATABASE_IN_CLIENT_TEST'); }) as typeof originalConnect;
  globalThis.fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.hostname !== '127.0.0.1') { externalAttempts++; throw new Error('NO_EXTERNAL_FETCH_IN_CLIENT_TEST'); }
    return originalFetch(input, init);
  };
  deps = realFileClientDeps(join(REAL_DATA_ROOT, 'client-manifest.json'), pin);
  deps.transport.dispatch = async () => { modelAttempts++; throw new Error('NO_MODEL_IN_CLIENT_TEST'); };
  const started = await listen(deps); server = started.s; url = started.base;
});
after(async () => {
  if (server) await close(server);
  Pool.prototype.query = originalQuery; Pool.prototype.connect = originalConnect; globalThis.fetch = originalFetch;
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('真实股票/市场按1162交易日连续；行业8日缺口保留，不冒充停牌或全齐', async (t) => {
  const loaded = await deps.strategyStore!.load();
  assert.equal(loaded.data.identity, 'REAL_PUBLIC_DATA'); assert.equal(loaded.data.mode, 'LATEST_REVISED');
  for (const id of ['601919', '000300']) {
    const c = loaded.view.coverage.find((x) => x.subject === id)!;
    assert.equal(c.expected, 1162); assert.equal(c.observed, 1162); assert.deepEqual(c.missingDates, []); assert.deepEqual(c.duplicateDates, []); assert.deepEqual(c.nonCalendarDates, []);
  }
  const industry = loaded.view.coverage.find((x) => x.subject === '801170')!;
  assert.equal(industry.observed, 1154); assert.equal(industry.missingDates.length, 8);
  assert.equal(loaded.view.evidenceStatus, 'DATA_INCOMPLETE'); assert.equal(loaded.view.fit, 'DATA_PENDING');
  assert.ok(loaded.view.blockers.some((b) => b.code === 'REAL_CONTINUOUS_COVERAGE_INCOMPLETE'));
  const plan = JSON.parse(await readFile(join(REAL_DATA_ROOT, 'acquisition-plan.json'), 'utf8'));
  const result = JSON.parse(await readFile(join(REAL_DATA_ROOT, 'acquisition-result.json'), 'utf8'));
  assert.equal(result.filledMissingSessions, 807); assert.deepEqual(result.remainingMissingSessions, []);
  assert.deepEqual(data.rules.inSample, { from: plan.inSample[0], to: plan.inSample[1] });
  assert.deepEqual(data.rules.outOfSample, { from: plan.outOfSample[0], to: plan.outOfSample[1] });
  t.diagnostic(JSON.stringify({ dataHash: data.dataHash, stockAndMarket: '1162/1162', industry: `${industry.observed}/${industry.expected}`, unresolvedIndustryDates: industry.missingDates, evidenceStatus: loaded.view.evidenceStatus }));
});

test('原件、原始行与取得时间可读回；当前取得历史资料不倒签，不升级PIT', async () => {
  const b = data.bars.find((r) => r.subject === '601919' && r.date === '2024-01-02')!;
  const source = await deps.strategyStore!.source(b.sourceId), receipt = await deps.strategyStore!.source(`${b.sourceId}-receipt`);
  const original = JSON.parse(source.bytes.toString()).rows[b.sourceRow];
  const meta = JSON.parse(receipt.bytes.toString());
  assert.equal(source.sha256, meta.sha256); assert.equal(b.close, original.close); assert.equal(b.open, original.open);
  assert.equal(b.firstObservedAt, meta.firstObservedAt); assert.equal(b.recordedAt, meta.recordedAt); assert.equal(b.sourcePublishedAt, null);
  assert.ok(b.firstObservedAt.startsWith('2026-10-29')); assert.ok(b.firstObservedAt > `${b.date}T23:59:59.999Z`);
  assert.throws(() => buildRealStrategyView(data, '2024-01-02T08:00:00.000Z'), /REAL_MATERIALIZATION_TIME_INVALID/);
  const forged = structuredClone(data) as unknown as Record<string, unknown>; forged.mode = 'POINT_IN_TIME_VERSIONS';
  const { dataHash: _, ...core } = forged; forged.dataHash = canonicalSha256(core);
  assert.throws(() => assertRealDataset(forged as unknown as RealDailyDataset), /REAL_DATA_IDENTITY_INVALID/);
});

test('真实草案保持无账户数量/收益为空、真实A/J未运行，原R2参数未据结果调优', async () => {
  const { view } = await deps.strategyStore!.load();
  const r2 = JSON.parse(await readFile(join(REAL_DATA_ROOT, '../../CODEX-DAILY-STRATEGY-20261029/frozen/rules.json'), 'utf8'));
  for (const key of ['fastSessions', 'slowSessions', 'entryGapBps', 'stopBps', 'profitBps', 'maxHoldingSessions', 'pendingEntrySessions', 'planLifetimeSessions', 'minimumSessions', 'minimumClosedTrades'] as const) assert.equal(data.rules[key], r2[key]);
  assert.deepEqual(data.rules.costs, r2.costs);
  assert.equal(view.publication, 'UNREVIEWED_CONDITIONAL_DRAFT'); assert.equal(view.draft.quantity, null); assert.equal(view.draft.riskBudget, null); assert.equal(view.draft.account, null);
  assert.equal(view.validation.metrics, null); assert.equal(view.validation.evaluatedOpportunities, null); assert.equal(view.validation.efficacyAccepted, false);
  assert.equal(view.review.a, 'NOT_RUN'); assert.equal(view.review.j, 'NOT_RUN'); assert.equal(view.review.gatePassed, false); assert.equal(view.review.executionEligible, false);
  assert.ok(view.draft.scenarios.every((s) => s.quantity === null && s.netPnlFen === null && s.feesFen === null));
});

test('实际客户端首页→策略页面→API→数据与原件共享同一真实身份，原报告逐字节保留', async (t) => {
  const home = await fetch(url+'/'); assert.equal(home.status, 200); assert.match(await home.text(), /href="\/strategies\/601919"/);
  const page = await fetch(url+'/strategies/601919'); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /未经A\/J复核的条件草案/); assert.match(html, /LATEST_REVISED/); assert.match(html, /1154/); assert.ok(html.includes(data.dataHash));
  const api = await fetch(url+'/api/strategies/601919'), body = await api.json() as { dataHash: string; viewHash: string; identity: string; mode: string; review: { gatePassed: boolean } };
  assert.equal(api.status, 200); assert.equal(body.dataHash, data.dataHash); assert.equal(page.headers.get('x-lyra-data-hash'), body.dataHash); assert.equal(page.headers.get('x-lyra-strategy-view-hash'), body.viewHash);
  assert.equal(body.identity, 'REAL_PUBLIC_DATA'); assert.equal(body.mode, 'LATEST_REVISED'); assert.equal(body.review.gatePassed, false);
  const dataset = await fetch(url+'/api/strategies/601919/data'), raw = await dataset.json() as { data: RealDailyDataset };
  assert.equal(raw.data.dataHash, data.dataHash);
  const id = data.bars.find((r) => r.subject === '601919' && r.date === '2024-01-02')!.sourceId;
  const actual = await fetch(url+`/api/strategies/601919/sources/${id}`), bytes = Buffer.from(await actual.arrayBuffer());
  assert.equal(hash(bytes), actual.headers.get('x-lyra-source-sha256'));
  const company = await fetch(url+'/strategies/601919/report');
  assert.equal(hash(Buffer.from(await company.arrayBuffer())), data.sources.find((s) => s.id === data.companyReportSourceId)!.sha256);
  assert.equal((await fetch(url+'/api/strategies/601919/sources/not-registered')).status, 404);
  assert.equal((await fetch(url+'/strategies/600519')).status, 404);
  t.diagnostic(JSON.stringify({ routes: ['/', '/strategies/601919', '/api/strategies/601919', '/api/strategies/601919/data', '/strategies/601919/report'], identity: body.identity, dataHash: body.dataHash, viewHash: body.viewHash, sourceHashReadback: true, reportBytePreserved: true }));
});

test('现有鉴权、CSRF和GET只读边界保留；新路由不能旁路模型或写接口', async () => {
  const saas: SrFullDeps = { ...deps, config: { ...deps.config, mode: 'saas' } };
  delete saas.localAccountId; delete saas.localCsrf;
  const { s, base } = await listen(saas);
  try {
    for (const path of ['/strategies/601919', '/api/strategies/601919', '/api/strategies/601919/data', '/api/strategies/601919/sources/stock-db', '/strategies/601919/report']) {
      const r = await fetch(base+path, { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
    }
  } finally { await close(s); }
  const write = await fetch(url+'/tasks', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=invalid&subject=601919', redirect: 'manual' });
  assert.equal(write.status, 403);
  assert.equal((await fetch(url+'/api/strategies/601919', { method: 'POST', body: '{}' })).status, 404);
  assert.equal(realDatabaseAttempts, 0); assert.equal(externalAttempts, 0); assert.equal(modelAttempts, 0);
});

test('未配置、错误pin、坏资料均具名失败，不回退静态或合成数据', async () => {
  const noData = { ...deps }; delete noData.strategyStore;
  const { s, base } = await listen(noData);
  try { const r = await fetch(base+'/api/strategies/601919'); assert.equal(r.status, 503); const body = await r.json() as { fallback: boolean; identity: string }; assert.equal(body.fallback, false); assert.equal(body.identity, 'REAL_DATA_REQUIRED'); } finally { await close(s); }
  await assert.rejects(fileStrategyStore(join(REAL_DATA_ROOT, 'client-manifest.json'), '0'.repeat(64)).load(), /STRATEGY_MANIFEST_HASH_MISMATCH/);
  const copy = structuredClone(data); copy.identity = 'SYNTHETIC' as typeof data.identity;
  const copied = Buffer.from(JSON.stringify(copy)); await writeFile(join(temp, 'real-dataset.json'), copied); await writeFile(join(temp, 'research-view.json'), await readFile(join(REAL_DATA_ROOT, 'research-view.json')));
  const badManifest = structuredClone(manifest); badManifest.sources.find((s) => s.id === badManifest.datasetId)!.sha256 = hash(copied);
  const bytes = Buffer.from(JSON.stringify(badManifest)); await writeFile(join(temp, 'client-manifest.json'), bytes);
  await assert.rejects(fileStrategyStore(join(temp, 'client-manifest.json'), hash(bytes)).load(), /REAL_DATA_IDENTITY_INVALID/);
});

test('来源目录阻止任意路径，页面动态资料转义，现有海控报告可导航回策略', async () => {
  const malicious = structuredClone(manifest); malicious.sources[0]!.path = '../outside.json';
  const bytes = Buffer.from(JSON.stringify(malicious)); await writeFile(join(temp, 'bad-path.json'), bytes);
  await assert.rejects(fileStrategyStore(join(temp, 'bad-path.json'), hash(bytes)).source(malicious.sources[0]!.id), /STRATEGY_SOURCE_PATH_INVALID/);
  const { view } = await deps.strategyStore!.load(), unsafe = structuredClone(view); unsafe.subjectName = '<script>alert(1)</script>';
  const html = renderRealStrategyPage({ view: unsafe, csrf: 'test-local-csrf', account: { username: 'owner', displayName: 'owner', role: 'ADMIN' } });
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  const report = { reportId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', version: 1, status: 'PUBLISHED_RESTRICTED', subject: '601919', subjectName: '中远海控', focus: 'FULL', horizon: 'MID_TERM', cutoff: '2026-10-28T07:54:00.000Z', methodVersion: 'sr-m1', adapterVersion: 'test', planAuthVersion: 'test', generatedBy: 'PRODUCT_REAL', sections: [{ key: 'summary', title: '研究摘要', narrative: '既有公司事实保留', findings: [], tables: [], citations: [], gaps: [] }], qaFindings: [], evidenceRefs: null, gate: null, changeSummary: null, createdAt: '2026-10-28T08:00:00.000Z', publishedAt: '2026-10-28T08:00:00.000Z', contentHash: '0'.repeat(64) } as ReportDocument;
  assert.ok(renderReportPage({ report, versions: [report], tablesById: {}, messages: [], csrf: 'test' }).includes('查看同标的日线条件研究'));
  assert.equal(realDatabaseAttempts, 0); assert.equal(externalAttempts, 0); assert.equal(modelAttempts, 0);
});
