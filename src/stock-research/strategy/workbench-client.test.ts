import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { canonicalSha256 } from '../../canonical.js';
import { defaultSrPlanBudget } from '../contracts.js';
import { createSrServer, type SrFullDeps } from '../server.js';
import type { L2RiskExport, L2WorkbenchResult, L2WorkbenchStore } from './workbench-contracts.js';
import type { AccountSnapshot, FrozenPlan, PlanReview, ReplayResult, ValidationReport } from './contracts.js';
import { createRiskExport } from './risk-input.js';
import { renderWorkbenchContent } from './workbench-render.js';

const out = 'delivery/CODEX-STRATEGY-CLIENT-20261029/workbench-20261031/client/rework-r1';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const TEST_ONLY_INPUT = { subject: '601919', asOf: '2026-10-20', cashYuan: '100000.01', maxPositionYuan: '20000', maxLossYuan: '600', stressGapPercent: '2.25', noHoldings: 'yes', confirm: 'yes' };
const csrf = 'TEST_ONLY-CSRF-client-workbench';
let databaseAttempts = 0, modelAttempts = 0, externalAttempts = 0;
const query = Pool.prototype.query, connect = Pool.prototype.connect, originalFetch = globalThis.fetch;
const servers: ReturnType<typeof createSrServer>[] = [];
let computed: L2WorkbenchResult, blocked: L2WorkbenchResult;
const sourceBytes = Buffer.from('{"identity":"TEST_ONLY_SOURCE"}');
let url: string, deps: SrFullDeps;
function testStore(result: L2WorkbenchResult): L2WorkbenchStore {
  return { load: async () => ({ result, manifestSha256: hash('TEST_ONLY_INJECTED_STORE'), sources: [{ id: 'test-only-original', label: 'TEST_ONLY原件', mediaType: 'application/json' }] }), source: async (id) => { assert.equal(id, 'test-only-original'); return { bytes: sourceBytes, mediaType: 'application/json', sha256: hash(sourceBytes) }; } };
}
async function listen(d: SrFullDeps) {
  const server = createSrServer(d); servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
before(async () => {
  await mkdir(out, { recursive: true });
  const load = async <T>(name: string) => JSON.parse(await readFile(`delivery/CODEX-DAILY-STRATEGY-20261029/artifacts/${name}.json`, 'utf8')) as T;
  const plan = await load<FrozenPlan>('plan'), validation = await load<ValidationReport>('validation'), review = await load<PlanReview>('review'), simulation = await load<ReplayResult>('simulation');
  const input = await load<{ account: AccountSnapshot }>('inputs');
  const base = { schema: 'lyra-l2-workbench-result-v1' as const, subject: '601919', subjectName: 'TEST_ONLY同标的合成演示', createdAt: new Date().toISOString(), inputIdentity: 'SYNTHETIC' as const, binding: { requestSha256: hash('TEST_ONLY_REQUEST'), dataHash: validation.dataHash, rulesHash: plan.rulesHash, baseManifestSha256: null }, account: input.account, blockers: [], realReviewDone: false as const, executionEligible: false as const, efficacyAccepted: false as const };
  const c = { ...base, status: 'COMPUTED_OFFLINE' as const, plan, validation, review, simulation }; computed = { ...c, resultHash: canonicalSha256(c) };
  const b = { ...base, status: 'INPUT_BLOCKED' as const, subjectName: 'TEST_ONLY阻断', inputIdentity: 'REAL_PUBLIC_DATA' as const, account: null, blockers: [{ code: 'TEST_ONLY_PIT_MISSING', date: null, detail: 'TEST_ONLY资料不足' }], plan: null, validation: null, review: null, simulation: null }; blocked = { ...b, resultHash: canonicalSha256(b) };
  const noDatabase = { query: async () => { databaseAttempts++; throw new Error('TEST_ONLY_DATABASE_FORBIDDEN'); }, connect: async () => { databaseAttempts++; throw new Error('TEST_ONLY_DATABASE_FORBIDDEN'); } } as unknown as Pool;
  Pool.prototype.query = noDatabase.query; Pool.prototype.connect = noDatabase.connect;
  globalThis.fetch = async (input, init) => { const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (u.hostname !== '127.0.0.1') { externalAttempts++; throw new Error('TEST_ONLY_EXTERNAL_FORBIDDEN'); } return originalFetch(input, init); };
  deps = { srPool: noDatabase, dataPool: noDatabase, config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 1000, mode: 'local' }, localAccountId: 'TEST_ONLY_WORKBENCH_ACCOUNT', localCsrf: csrf, transport: { describe: () => ({ provider: 'TEST_ONLY', simulated: true, modelId: null }), dispatch: async () => { modelAttempts++; throw new Error('TEST_ONLY_MODEL_FORBIDDEN'); } }, budget: defaultSrPlanBudget(), workbenchStore: testStore(computed) };
  url = await listen(deps);
});
after(async () => {
  for (const s of servers) await new Promise<void>((done, reject) => s.close((err) => err ? reject(err) : done()));
  Pool.prototype.query = query; Pool.prototype.connect = connect; globalThis.fetch = originalFetch;
  await writeFile(`${out}/zero-effects-test-only.json`, JSON.stringify({ identity: 'TEST_ONLY_INJECTED_STORE', databaseAttempts, modelAttempts, externalAttempts, ownLoopbackInstancesClosed: servers.length, installed: false }, null, 2)+'\n');
  assert.equal(databaseAttempts, 0); assert.equal(modelAttempts, 0); assert.equal(externalAttempts, 0);
});
test('TEST_ONLY injected computed result, IS/OOS, full denominator/events and originals read back in API/HTML', async () => {
  const page = await fetch(url+'/strategies/601919/workbench'), html = await page.text(); assert.equal(page.status, 200);
  for (const text of ['SYNTHETIC', '合成离线演示', '样本内 IS', '样本外 OOS', '全部机会分母', '全部事件与归因', '逐批填写该标的持仓', '个人研究记录，非投资建议', computed.resultHash]) assert.ok(html.includes(text), text);
  const reading = html.slice(0, html.indexOf('<section class="sr-section" id="workbench-originals">'));
  for (const raw of ['netReturnBps', 'cashFen', 'sr_account', '工作区 API', computed.resultHash]) assert.ok(!reading.includes(raw), raw);
  for (const text of ['净收益率', '最大收盘回撤', '冻结计划：条件、期限与风险', '进入价格下界', '10.38 元', '2.00%', '100,000.00 元']) assert.ok(reading.includes(text), text);
  assert.ok(!html.includes('name="holdings"')); assert.ok(html.includes('name="lot_1_quantity"')); assert.ok(html.includes('name="lot_1_costYuan"'));
  assert.ok(!html.includes('value="100000')); assert.match(html, /id="risk-confirm"[^>]*required/);
  const api = await fetch(url+'/api/strategies/601919/workbench'), body = await api.json() as Awaited<ReturnType<L2WorkbenchStore['load']>>; assert.deepEqual(body.result, computed);
  assert.equal(page.headers.get('x-lyra-workbench-result-hash'), computed.resultHash);
  const src = await fetch(url+'/api/strategies/601919/workbench/sources/test-only-original'); assert.equal(hash(Buffer.from(await src.arrayBuffer())), src.headers.get('x-lyra-source-sha256')); assert.equal(src.headers.get('content-disposition'), 'attachment');
  assert.equal((await fetch(url+'/api/strategies/601919/workbench/sources/absent')).status, 404);
  await writeFile(`${out}/test-only-computed.html`, html); await writeFile(`${out}/test-only-computed-api.json`, JSON.stringify(body, null, 2));
});
test('blocked, missing, failed and incomplete results stay distinct without fake numeric results or fallback', async () => {
  const blockedUrl = await listen({ ...deps, workbenchStore: testStore(blocked) });
  const r = await fetch(blockedUrl+'/strategies/601919/workbench'), html = await r.text(); assert.equal(r.status, 200); assert.ok(html.includes('INPUT_BLOCKED')); assert.ok(!html.includes('样本内 IS')); assert.ok(!html.includes('初始组合净值'));
  await writeFile(`${out}/test-only-blocked.html`, html); await writeFile(`${out}/test-only-blocked-api.json`, await (await fetch(blockedUrl+'/api/strategies/601919/workbench')).text());
  const none = { ...deps }; delete none.workbenchStore;
  for (const [d, expected] of [[none, 'NOT_CONFIGURED'], [{ ...deps, workbenchStore: { load: async () => { throw new Error('TEST_ONLY_BAD_PIN'); }, source: deps.workbenchStore!.source } }, 'FAILED']] as const) {
    const base = await listen(d); const res = await fetch(base+'/api/strategies/601919/workbench'); assert.equal(res.status, 503); assert.equal((await res.json() as { status: string }).status, expected);
    const h = await (await fetch(base+'/strategies/601919/workbench')).text(); assert.ok(h.includes(expected)); assert.ok(h.includes('录入并导出')); }
  const incomplete = structuredClone(computed); assert.equal(incomplete.status, 'COMPUTED_OFFLINE'); if (incomplete.status !== 'COMPUTED_OFFLINE') return;
  incomplete.validation.status = 'INCOMPLETE'; incomplete.review.gate.passed = false; incomplete.review.publication = 'J_BLOCKED'; incomplete.simulation.status = 'REVIEW_BLOCKED';
  const h = renderWorkbenchContent({ status: 'LOADED', loaded: await testStore(incomplete).load() }, csrf); for (const text of ['INCOMPLETE', 'REVIEW_BLOCKED', 'J_BLOCKED']) assert.ok(h.includes(text));
});
test('risk POST requires auth/CSRF and explicit confirmation; preserves invalid input, HTTP cannot select TEST_ONLY; download has fresh timestamps', async () => {
  const route = '/strategies/601919/workbench/risk-export';
  const post = (v: Record<string, string>) => fetch(url+route, { method: 'POST', body: new URLSearchParams(v), redirect: 'manual' });
  assert.equal((await post(TEST_ONLY_INPUT)).status, 403);
  const invalid = await post({ ...TEST_ONLY_INPUT, _csrf: csrf, cashYuan: '<script>alert(1)</script>' }); assert.equal(invalid.status, 422); const h = await invalid.text(); assert.ok(h.includes('&lt;script&gt;')); assert.ok(!h.includes('<script>')); assert.match(h, /id="risk-confirm"[^>]*required/); assert.ok(!/id="risk-confirm"[^>]*checked/.test(h));
  assert.equal((await post({ ...TEST_ONLY_INPUT, _csrf: csrf, identity: 'TEST_ONLY_INPUT' })).status, 422);
  const before = new Date().toISOString(), res = await post({ ...TEST_ONLY_INPUT, _csrf: csrf }), output = await res.json() as L2RiskExport;
  assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition')!, /attachment/); assert.equal(output.identity, 'USER_CONFIRMED_INPUT'); assert.equal(output.account.identity, 'USER_CONFIRMED'); assert.ok(output.account.availableAt >= before); assert.equal(output.sourceSha256, hash(output.sourceBytes));
  const { exportHash, ...core } = output; assert.equal(exportHash, canonicalSha256(core));
  // HTTP行为证据所用输入是TEST_ONLY夹具；不把响应中的确认身份当作Owner真实提供。
  await writeFile(`${out}/risk-export-http-test-only-evidence.json`, JSON.stringify({ evidenceIdentity: 'TEST_ONLY_HTTP_FORM_FIXTURE_NOT_OWNER_ACCOUNT', output }, null, 2));
  const testExport = createRiskExport(TEST_ONLY_INPUT, 'TEST_ONLY_INPUT'); await writeFile(`${out}/risk-export-test-only.json`, JSON.stringify(testExport, null, 2));
  const protectedDeps = { ...deps, config: { ...deps.config, mode: 'saas' as const } }; delete protectedDeps.localAccountId; delete protectedDeps.localCsrf; const base = await listen(protectedDeps);
  for (const path of ['/strategies/601919/workbench', '/api/strategies/601919/workbench', '/api/strategies/601919/workbench/sources/test-only-original']) assert.equal((await fetch(base+path, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(base+route, { method: 'POST', body: new URLSearchParams(TEST_ONLY_INPUT), redirect: 'manual' })).status, 302);
  assert.equal((await fetch(url+'/api/strategies/601919/workbench', { method: 'POST' })).status, 404);
  for (let i = 0; i < 9; i++) assert.equal((await post({ ...TEST_ONLY_INPUT, _csrf: csrf })).status, 200);
  assert.equal((await post({ ...TEST_ONLY_INPUT, _csrf: csrf })).status, 429);
});
test('untrusted display strings escape in result and source labels', async () => {
  const loaded = await testStore(blocked).load(); loaded.result.subjectName = '<script>bad</script>'; loaded.sources[0]!.label = '<img onerror=bad>';
  const h = renderWorkbenchContent({ status: 'LOADED', loaded }, csrf); assert.ok(!h.includes('<script>')); assert.ok(!h.includes('<img')); assert.ok(h.includes('&lt;script&gt;'));
});

test('structured lot fields add batches without export, preserve values and require complete explicit lots', async () => {
  const base = await listen({ ...deps, localAccountId: 'TEST_ONLY_STRUCTURED_LOT_ACCOUNT' });
  const route = '/strategies/601919/workbench/risk-export';
  const post = (body: Record<string, string>) => fetch(base+route, { method: 'POST', body: new URLSearchParams({ ...body, _csrf: csrf }) });
  const initial = { ...TEST_ONLY_INPUT, noHoldings: '', lotCount: '1', lot_1_quantity: '300', lot_1_sellableQuantity: '200', lot_1_acquiredOn: '2026-10-01', lot_1_unlocksOn: '2026-10-02', lot_1_costYuan: '3000.25' };
  const added = await post({ ...initial, confirm: '', action: 'add-lot' }); assert.equal(added.status, 200); assert.equal(added.headers.get('content-disposition'), null);
  const html = await added.text(); assert.ok(html.includes('name="lotCount" value="2"')); assert.ok(html.includes('name="lot_1_quantity" type="text" value="300"')); assert.ok(html.includes('name="lot_2_quantity" type="text" value=""'));
  assert.ok(!/id="risk-confirm"[^>]*checked/.test(html));
  const incomplete = await post({ ...initial, lot_1_sellableQuantity: '' }); assert.equal(incomplete.status, 422); const invalid = await incomplete.text(); assert.ok(invalid.includes('第1批持仓 · 可卖股数')); assert.ok(invalid.includes('value="3000.25"'));
  const response = await post({ ...initial, lotCount: '2', lot_2_quantity: '100', lot_2_sellableQuantity: '0', lot_2_acquiredOn: '2026-10-20', lot_2_unlocksOn: '2026-10-21', lot_2_costYuan: '1000.01' });
  assert.equal(response.status, 200); const output = await response.json() as L2RiskExport; assert.equal(output.account.holdings.length, 2); assert.equal(output.account.holdings[0]!.costFen, 300025); assert.equal(output.account.holdings[1]!.quantity, 100);
  assert.equal(output.sourceSha256, hash(output.sourceBytes)); const { exportHash, ...core } = output; assert.equal(exportHash, canonicalSha256(core));
  await writeFile(`${out}/structured-lot-add.html`, html); await writeFile(`${out}/structured-lot-error.html`, invalid); await writeFile(`${out}/structured-lot-export-test-only-evidence.json`, JSON.stringify({ evidenceIdentity: 'TEST_ONLY_HTTP_FORM_FIXTURE_NOT_OWNER_ACCOUNT', output }, null, 2));
});
