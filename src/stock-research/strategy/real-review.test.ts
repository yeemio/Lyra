import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { canonicalSha256 } from '../../canonical.js';
import { DEC_ZERO, decAdd, decDiv, decFromInt, decFromString, decMul, decToString } from '../../settlement/decimal.js';
import { createSrServer } from '../server.js';
import { realFileClientDeps } from './client-preview.js';
import { fileStrategyStore, type RealClientManifest } from './real-store.js';
import { assertRealReviewResult, freezeRealReviewInput, runRealStrategyReview, strategyAInput, type RealReviewArtifact, type RealReviewInput } from './real-review.js';
import { blockExternalEffects, IsolatedReviewTransport, IsolatedSrPool, isolatedRequest, originalStrategyStore, writeReviewClientManifest, type IsolatedFault, type IsolatedSrSnapshot } from './review-isolated.js';

const DELIVERY = new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/continuation-20261031/', import.meta.url);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
let out: string, sourceStore: Awaited<ReturnType<typeof originalStrategyStore>>, guard: ReturnType<typeof blockExternalEffects>;
let serial = 0;
before(async () => { guard = blockExternalEffects(); out = await mkdtemp(join(DELIVERY.pathname, 'test-run-')); sourceStore = await originalStrategyStore(); });
after(async () => { assert.deepEqual(guard.attempts, { database: 0, externalFetch: 0 }); guard.restore(); });
async function scenario(fault: IsolatedFault = 'NONE', mutate?: (request: ReturnType<typeof isolatedRequest>) => void) {
  const pool = new IsolatedSrPool(), transport = new IsolatedReviewTransport(pool, fault), request = isolatedRequest(); mutate?.(request);
  const input = await freezeRealReviewInput(sourceStore, transport, request);
  const args = { sourceStore, input, expectedInputHash: input.inputHash, srPool: pool.asPool(), transport, budget: input.execution.budget, outputDir: join(out, `case-${++serial}`), holderId: pool.holderId, lease: pool.lease };
  const delivery = await runRealStrategyReview(args);
  return { ...delivery, pool, transport, input, args };
}
function rehash<T extends object>(value: T, key: string): T {
  const clone = structuredClone(value) as Record<string, unknown>; delete clone[key]; return { ...clone, [key]: canonicalSha256(clone) } as T;
}
function content<T>(input: RealReviewInput, tableId: string): T { return JSON.parse(String(input.evidenceBundle.find((t) => t.tableId === tableId)!.rows[0]![1])) as T; }

test('当前草案输入完整可复算：窗口、原始行、适用因子、全日期缺口；明确未评历史有效性', async () => {
  const pool = new IsolatedSrPool(), transport = new IsolatedReviewTransport(pool);
  const input = await freezeRealReviewInput(sourceStore, transport, isolatedRequest()), { data, view } = await sourceStore.load();
  const rows = content<{ featureInputs: { subject: string; observations: { normalized: { close: string; date: string }; rawSourceRow: { typed_value?: Record<string, unknown>; close?: unknown } }[] }[]; appliedFactors: { normalized: { effectiveOn: string; backwardFactor: string } }[] }>(input, 'current-feature-inputs');
  for (const window of rows.featureInputs) {
    assert.equal(window.observations.length, data.rules.slowSessions);
    const prices = window.observations.map(({ normalized, rawSourceRow }) => {
      const raw = rawSourceRow.typed_value ?? rawSourceRow;
      assert.equal(String(raw.close ?? (raw as Record<string, unknown>)['收盘']), normalized.close);
      if (window.subject !== data.subject) return normalized.close;
      const factor = rows.appliedFactors.map((f) => f.normalized).filter((f) => f.effectiveOn <= normalized.date).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)).at(-1)!;
      return decToString(decMul(decFromString(normalized.close), decFromString(factor.backwardFactor)));
    });
    const mean = (ps: string[]) => decToString(decDiv(ps.reduce((sum, p) => decAdd(sum, decFromString(p)), DEC_ZERO), decFromInt(ps.length)));
    const feature = view.features.find((f) => f.subject === window.subject)!;
    assert.equal(prices.at(-1), feature.featureClose); assert.equal(mean(prices), feature.slowMean); assert.equal(mean(prices.slice(-data.rules.fastSessions)), feature.fastMean);
  }
  const coverage = content<{ calendar: { days: { date: string; trading: boolean }[]; originalRows: unknown[] }; observationDirectory: [string, string, string, number, string | null][] }>(input, 'coverage-inputs');
  const days = coverage.calendar.days.filter((d) => d.trading).map((d) => d.date);
  for (const c of view.coverage) {
    const observed = new Set(coverage.observationDirectory.filter((r) => r[0] === c.subject).map((r) => r[1]));
    assert.deepEqual(days.filter((d) => !observed.has(d)), c.missingDates); assert.equal(observed.size, c.observed);
  }
  assert.equal(view.coverage.find((c) => c.subject === '801170')!.missingDates.length, 8);
  assert.ok(coverage.calendar.originalRows.length >= days.length);
  assert.equal(input.scope.historicalEfficacyEvaluated, false); assert.ok(input.scope.exclusions.includes('HISTORICAL_EFFICACY'));
  assert.equal(input.binding.dataHash, data.dataHash); assert.equal(input.binding.viewHash, view.viewHash);
  assert.equal(pool.snapshot().calls.length, 0); assert.equal(transport.events.length, 0);
});

test('A→机械清单→J只经现有sr执行器，原始证据相同；缺行业/PIT/账户保持阻断', async (t) => {
  const s = await scenario();
  assert.deepEqual(s.transport.events.map((e) => e.step), ['A_FINAL', 'JUDGE']);
  assert.equal(s.transport.events[0]!.evidenceContentHash, s.transport.events[1]!.evidenceContentHash);
  assert.equal(s.pool.snapshot().calls.length, 2); assert.ok(s.pool.snapshot().calls.every((c) => c.state === 'SUCCEEDED' && c.simulated === true));
  assert.equal(s.pool.snapshot().tasks[0]!.status, 'PARTIAL');
  assert.equal(s.result.status, 'REVIEW_COMPLETE_RESTRICTED'); assert.equal(s.result.reviewGatePassed, true);
  assert.equal(s.result.executionEligible, false); assert.equal(s.result.gatePassed, false); assert.equal(s.result.realReviewDone, false); assert.equal(s.result.historicalEfficacyEvaluated, false);
  for (const code of ['REAL_CONTINUOUS_COVERAGE_INCOMPLETE', 'LATEST_REVISED_NOT_HISTORICAL_PIT', 'USER_ACCOUNT_AND_RISK_BUDGET_MISSING', 'SIMULATED_REVIEW_NOT_REAL_AJ']) assert.ok(s.result.blockers.some((b) => b.code === code));
  const { view } = await sourceStore.load(); assert.equal(view.draft.quantity, null); assert.equal(view.validation.metrics, null); assert.equal(view.review.a, 'NOT_RUN');
  assertRealReviewResult(s.result, s.input);
  assert.ok(s.result.promptBytes.A < s.input.execution.budget.maxInputBytes); assert.ok(s.result.promptBytes.J! < s.input.execution.budget.maxInputBytes);
  t.diagnostic(JSON.stringify({ inputHash: s.input.inputHash, resultHash: s.result.resultHash, promptBytes: s.result.promptBytes, evidenceContentHash: s.transport.events[0]!.evidenceContentHash, realCalls: 0 }));
});

test('序列化后的原调用空间与不可变产物恢复，成功步骤零重发、结果逐字节不变', async () => {
  const s = await scenario(); const pool = new IsolatedSrPool(JSON.parse(JSON.stringify(s.pool.snapshot())) as IsolatedSrSnapshot), transport = new IsolatedReviewTransport(pool);
  const recovered = await runRealStrategyReview({ ...s.args, srPool: pool.asPool(), transport });
  assert.equal(transport.events.length, 0); assert.equal(pool.snapshot().calls.length, 2);
  assert.equal(recovered.result.resultHash, s.result.resultHash); assert.equal(await readFile(recovered.resultPath, 'utf8'), await readFile(s.resultPath, 'utf8'));
});

test('成功A可恢复；J发送后失败禁止再次发送，移动输出目录也不创建新任务或步骤绕行', async () => {
  const s = await scenario('J_SCHEMA');
  assert.equal(s.result.receipts.A?.state, 'SUCCEEDED'); assert.equal(s.result.receipts.J?.state, 'FAILED');
  const transport = new IsolatedReviewTransport(s.pool);
  const retry = await runRealStrategyReview({ ...s.args, transport });
  assert.equal(retry.result.steps.A, 'SUCCEEDED'); assert.equal(retry.result.steps.J, 'FAILED'); assert.equal(transport.events.length, 0);
  assert.match(retry.result.error!.code, /SENT_WITHOUT_RECOVERABLE_OUTPUT/);
  const moved = await runRealStrategyReview({ ...s.args, transport, outputDir: join(out, `moved-${++serial}`) });
  assert.equal(moved.result.status, 'FAILED'); assert.equal(transport.events.length, 0); assert.equal(s.pool.snapshot().tasks.length, 1); assert.equal(s.pool.snapshot().steps.length, 3);
});

test('A或J UNKNOWN保持原键；换授权/期限/模型不能自动重采样', async () => {
  for (const fault of ['A_UNKNOWN', 'J_UNKNOWN'] as const) {
    const s = await scenario(fault); assert.equal(s.result.status, 'UNKNOWN');
    const transport = new IsolatedReviewTransport(s.pool);
    const retry = await runRealStrategyReview({ ...s.args, transport }); assert.equal(retry.result.status, 'UNKNOWN'); assert.equal(transport.events.length, 0);
    const request = structuredClone(s.input.execution); request.deadlines.A = new Date(Date.now() + 300_000).toISOString(); request.authorizationRef += ':changed';
    const changed = await freezeRealReviewInput(sourceStore, transport, request);
    assert.equal(changed.taskId, s.input.taskId); assert.deepEqual(changed.stepIds, s.input.stepIds);
    await assert.rejects(runRealStrategyReview({ ...s.args, input: changed, expectedInputHash: changed.inputHash, transport }), { code: 'BUSINESS_KEY_ALREADY_SENT' });
    const describe = transport.describe.bind(transport); transport.describe = (step) => ({ ...describe(step), modelId: 'switched-fixture' });
    const switched = await freezeRealReviewInput(sourceStore, transport, s.input.execution);
    await assert.rejects(runRealStrategyReview({ ...s.args, input: switched, expectedInputHash: switched.inputHash, transport }), { code: 'BUSINESS_KEY_ALREADY_SENT' });
    assert.equal(transport.events.length, 0); assert.equal(s.pool.snapshot().calls.length, fault === 'A_UNKNOWN' ? 1 : 2);
  }
});

test('每步显式期限：发送前过期零发送，发送后挂起按真实执行器竞速落UNKNOWN', async () => {
  const expired = await scenario('NONE', (r) => { r.deadlines.A = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(expired.transport.events.length, 0); assert.equal(expired.result.modelCalls, 0); assert.equal(expired.result.receipts.A?.state, 'FAILED'); assert.equal(expired.result.receipts.A?.failCode, 'DEADLINE_EXCEEDED');
  const pool = new IsolatedSrPool(), transport = new IsolatedReviewTransport(pool, 'A_PENDING'), request = isolatedRequest();
  // Build dependencies before starting this deliberately short execution window.
  const preliminary = await freezeRealReviewInput(sourceStore, transport, request); request.deadlines.A = new Date(Date.now() + 1000).toISOString();
  const input = rehash({ ...preliminary, execution: { ...preliminary.execution, deadlines: request.deadlines } }, 'inputHash');
  const result = await runRealStrategyReview({ sourceStore, input, expectedInputHash: input.inputHash, srPool: pool.asPool(), transport, budget: input.execution.budget, outputDir: join(out, `pending-${++serial}`), holderId: pool.holderId, lease: pool.lease });
  assert.equal(result.result.status, 'UNKNOWN'); assert.equal(result.result.receipts.A?.failCode, 'DEADLINE_EXCEEDED'); assert.equal(transport.events.length, 1);
});

test('错误结构化A阻止J，J自报未改判却改结论被既有输出校验拒绝', async () => {
  const a = await scenario('A_SCHEMA'); assert.equal(a.result.status, 'FAILED'); assert.equal(a.result.receipts.A?.failCode, 'MODEL_OUTPUT_SCHEMA_INVALID'); assert.equal(a.result.steps.J, 'NOT_RUN'); assert.equal(a.transport.events.length, 1);
  const j = await scenario('J_SCHEMA'); assert.equal(j.result.status, 'FAILED'); assert.equal(j.result.receipts.J?.failCode, 'MODEL_OUTPUT_SCHEMA_INVALID'); assert.equal(j.result.j, null); assert.equal(j.result.executionEligible, false);
});

test('产物重新算哈希仍不能绕过原sr步骤pin；错误回执被阻断且零重发', async () => {
  const s = await scenario(), path = join(dirname(s.inputPath), 'a.json');
  const a = JSON.parse(await readFile(path, 'utf8')) as RealReviewArtifact;
  const changed = structuredClone(a); (changed.output as { conclusion: string }).conclusion = 'tampered'; changed.outputHash = canonicalSha256(changed.output);
  await writeFile(path, JSON.stringify(rehash(changed, 'artifactHash'), null, 2) + '\n');
  const transport = new IsolatedReviewTransport(s.pool), retry = await runRealStrategyReview({ ...s.args, transport });
  assert.equal(retry.result.status, 'FAILED'); assert.match(retry.result.error!.code, /ARTIFACT_PIN_INVALID/); assert.equal(transport.events.length, 0);
  const other = await scenario(); other.pool.corruptCall(other.result.receipts.A!.callId, { model_id: 'wrong-model-receipt' });
  const next = new IsolatedReviewTransport(other.pool), rejected = await runRealStrategyReview({ ...other.args, transport: next });
  assert.equal(rejected.result.status, 'FAILED'); assert.match(rejected.result.error!.code, /RECEIPT_OR_ARTIFACT_INVALID/); assert.equal(next.events.length, 0);
});

test('输入内容、资料身份或回执绑定漂移，不因重算输入hash得到新发送', async () => {
  const s = await scenario();
  const changed = structuredClone(s.input); changed.evidenceBundle[0]!.rows[0]![1] = JSON.stringify({ changedRules: true }); changed.evidenceBundle[0]!.rows[0]![0] = canonicalSha256({ changedRules: true }); changed.evidenceBundleHash = canonicalSha256(changed.evidenceBundle);
  const input = rehash(changed, 'inputHash'), transport = new IsolatedReviewTransport(s.pool);
  await assert.rejects(runRealStrategyReview({ ...s.args, input, expectedInputHash: input.inputHash, transport }), /SOURCE_OR_TRANSPORT_CHANGED/);
  const retargeted = structuredClone(s.input); retargeted.binding.dataHash = '0'.repeat(64); const bad = rehash(retargeted, 'inputHash');
  await assert.rejects(runRealStrategyReview({ ...s.args, input: bad, expectedInputHash: bad.inputHash, transport }), /INPUT_BINDING_INVALID/);
  assert.equal(transport.events.length, 0); assert.equal(s.pool.snapshot().calls.length, 2);
});

test('J承重缩窄、拒绝、未解和改判均阻断；新结论只保留为待修订版本', async () => {
  for (const fault of ['J_NARROWED', 'J_CHANGED', 'J_REJECTED', 'J_UNRESOLVED'] as const) {
    const s = await scenario(fault); assert.equal(s.result.status, 'BLOCKED'); assert.equal(s.result.reviewGatePassed, false); assert.equal(s.result.executionEligible, false); assert.equal(s.result.effectiveConclusion, null);
    assert.equal(s.result.proposedRevision !== null, fault === 'J_CHANGED'); assertRealReviewResult(s.result, s.input);
    assert.ok(s.result.blockers.some((b) => b.code === 'REAL_CONTINUOUS_COVERAGE_INCOMPLETE')); assert.equal((await sourceStore.load()).view.publication, 'UNREVIEWED_CONDITIONAL_DRAFT');
  }
});

test('真实身份transport不获本轮许可，恢复守卫关闭时零permit；输入超预算不截断不发送', async () => {
  const pool = new IsolatedSrPool(), transport = new IsolatedReviewTransport(pool), describe = transport.describe.bind(transport);
  transport.describe = (step) => ({ ...describe(step), simulated: false });
  await assert.rejects(freezeRealReviewInput(sourceStore, transport, isolatedRequest()), /REAL_STRATEGY_CALLS_NOT_AUTHORIZED/);
  assert.equal(transport.events.length, 0); assert.equal(pool.snapshot().calls.length, 0);
  transport.describe = describe; const input = await freezeRealReviewInput(sourceStore, transport, isolatedRequest()); pool.lifecycle = 'RECONCILING';
  await assert.rejects(runRealStrategyReview({ sourceStore, input, expectedInputHash: input.inputHash, srPool: pool.asPool(), transport, budget: input.execution.budget, outputDir: join(out, 'reconciling'), holderId: pool.holderId, lease: pool.lease }), { code: 'RECOVERY_CONFIRM_REQUIRED' });
  assert.equal(pool.snapshot().calls.length, 0);
  const over = await scenario('NONE', (r) => { r.budget.maxInputBytes = 100; });
  assert.equal(over.transport.events.length, 0); assert.equal(over.result.receipts.A?.failCode, 'INPUT_OVER_BUDGET'); assert.equal(over.result.status, 'FAILED'); assert.ok(over.result.promptBytes.A > 100);
});

test('正常客户端GET API按manifest/pin读回成功及UNKNOWN；错误pin和伪造执行门具名拒绝', async (t) => {
  for (const fault of ['NONE', 'J_UNKNOWN'] as const) {
    const s = await scenario(fault), client = await writeReviewClientManifest(join(out, `client-${++serial}`), s.inputPath, s.resultPath);
    const loaded = await fileStrategyStore(client.manifestPath, client.manifestSha256).load(); assert.equal(loaded.researchReview?.resultHash, s.result.resultHash);
    const deps = realFileClientDeps(client.manifestPath, client.manifestSha256), server = createSrServer(deps);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(base + '/api/strategies/601919'), body = await response.json() as { researchReview: typeof s.result; review: { a: string }; draft: { quantity: unknown }; validation: { metrics: unknown } };
      assert.equal(response.status, 200); assert.equal(body.researchReview.resultHash, s.result.resultHash); assert.equal(response.headers.get('x-lyra-strategy-review-hash'), s.result.resultHash);
      assert.equal(body.review.a, 'NOT_RUN'); assert.equal(body.researchReview.executionEligible, false); assert.equal(body.draft.quantity, null); assert.equal(body.validation.metrics, null);
      const page = await fetch(base + '/strategies/601919'), html = await page.text(); assert.equal(page.status, 200); assert.ok(html.includes(s.result.resultHash)); assert.ok(html.includes('未评历史有效性'));
      const raw = await fetch(base + '/api/strategies/601919/sources/review-result'); assert.equal(raw.status, 200); assert.equal(sha(Buffer.from(await raw.arrayBuffer())), raw.headers.get('x-lyra-source-sha256'));
      assert.equal((await fetch(base + '/api/strategies/601919', { method: 'POST', body: '{}' })).status, 404);
      await writeFile(join(dirname(client.manifestPath), 'api-readback.json'), JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
    } finally { await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done())); }
    await assert.rejects(fileStrategyStore(client.manifestPath, '0'.repeat(64)).load(), /MANIFEST_HASH_MISMATCH/);
    const forged = structuredClone(s.result) as unknown as Record<string, unknown>; forged.executionEligible = true; const bytes = Buffer.from(JSON.stringify(rehash(forged, 'resultHash')));
    await writeFile(join(dirname(client.manifestPath), 'review-result.json'), bytes);
    await assert.rejects(fileStrategyStore(client.manifestPath, client.manifestSha256).load(), /SOURCE_HASH_MISMATCH/);
    const manifest = JSON.parse(await readFile(client.manifestPath, 'utf8')) as RealClientManifest; manifest.sources.find((x) => x.id === 'review-result')!.sha256 = sha(bytes);
    const m = Buffer.from(JSON.stringify(manifest)); await writeFile(client.manifestPath, m);
    await assert.rejects(fileStrategyStore(client.manifestPath, sha(m)).load(), /RESULT_BINDING_INVALID/);
    t.diagnostic(JSON.stringify({ fault, resultHash: s.result.resultHash, apiStatus: 200, artifactReadback: true, automaticSendRoute: false }));
  }
  assert.deepEqual(guard.attempts, { database: 0, externalFetch: 0 });
});
