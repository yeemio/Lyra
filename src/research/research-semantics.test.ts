/** PR#3：公开合成输入、临时 CAS、无外发 transport。内存回执测试不冒充 PG 证据。 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { KernelError, type AOutput, type ConclusionObject, type JOutput, type ModelCallContract, type ModelPermit, type PlanAuthBudget, type TimePointFact } from '../contracts.js';
import { buildConclusionObject, type ConclusionInput } from '../conclusion/object.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { AJ_PERMIT_SPACE } from '../kernel/executor.js';
import type { ModelTransport } from '../kernel/transport.js';
import { runNightly } from '../schedule/nightly.js';
import { runGateM, GATE_M_VERSIONS } from './gate-m.js';
import { runPostEventResearch } from './post-event.js';
import { deriveChecklist } from './checklist.js';
import { assembleResearchInput, buildCoverageReceiptMaterial, materialBytes, type AssembledResearchInput, type ResearchInputPackage } from './inputs.js';
import { buildARequest, buildJRequest, type ResearchDispatchPayload } from './requests.js';
import { deliveredEvidence, researchJInputHash, researchTraceOf, validateResearchA, validateResearchJ } from './validation.js';
import { assertVerifiedPrior, loadPriorResearch, priorEligibilityReason, validatePostEventContext, withPostEventContext, type PostEventContext, type PostEventTriggerEvent } from './inheritance.js';
import { syntheticConclusionInput } from './research-test-helper.js';
import { RESEARCH_REPAIR_METHOD_VERSION } from './indicators.js';

const VERSIONS = { methodVersion: RESEARCH_REPAIR_METHOD_VERSION, adapterVersion: 'test:data', planAuthVersion: 'test:auth' };
const BUDGET: PlanAuthBudget = { planAuthVersion: VERSIONS.planAuthVersion, maxModelCallsPerWeek: 50, maxInputBytes: 1_000_000, maxInFlight: 2 };
const INPUT_BUDGET = { l0Bytes: 1_000_000, l1Bytes: 1_000_000, l2Bytes: 1_000_000, totalBytes: 3_000_000 };
const CUTOFF = '2026-11-02T07:00:00.000Z';
const EXTRA_HASH = canonicalSha256('TEST_ONLY sealed but not delivered');

function rehash(pkg: ResearchInputPackage): ResearchInputPackage {
  for (const layer of [pkg.layers.l0, pkg.layers.l1, pkg.layers.l2]) {
    for (const b of layer.blocks) b.bytes = materialBytes(pkg.materials.find((m) => m.materialId === b.materialId)!);
    layer.bytes = layer.blocks.reduce((n, b) => n + b.bytes, 0);
  }
  const { inputHash: _old, ...core } = pkg;
  pkg.inputHash = canonicalSha256(core);
  return pkg;
}

function packageFixture(kind: 'WEEKLY' | 'POST_EVENT' = 'WEEKLY', cutoff = CUTOFF): ResearchInputPackage {
  const pkg = syntheticConclusionInput({ subjectKind: 'STOCK', subject: '600519', researchKind: kind, cutoff }, VERSIONS).researchInput;
  const seal = pkg.seals[0]!;
  seal.factIds.push('test:hidden');
  seal.artifactRefs.push({ sha256: EXTRA_HASH, bytes: 0, firstObservedAt: cutoff, mediaType: 'text/plain' });
  const { manifestHash: _old, ...sealed } = seal;
  seal.manifestHash = canonicalSha256(sealed);
  pkg.materials.push({ materialId: 'test:hidden', kind: 'NOTE', dimension: 8, title: '仅封存，未送达', text: 'TEST_ONLY hidden',
    factIds: ['test:hidden'], evidenceRefs: [{ factId: 'test:hidden', artifactSha256: EXTRA_HASH }] });
  const receipt = buildCoverageReceiptMaterial(pkg.dimensions, { l0FixedBytes: 0, l0Budget: pkg.layers.l0.budget,
    l1Bytes: pkg.layers.l1.bytes, l1Budget: pkg.layers.l1.budget, l1Blocks: pkg.layers.l1.blocks.length,
    l2Bytes: pkg.layers.l2.bytes, l2Budget: pkg.layers.l2.budget });
  pkg.materials.push(receipt); pkg.layers.l0.blocks.push({ materialId: receipt.materialId, bytes: materialBytes(receipt) });
  return rehash(pkg);
}

function goodA(pkg: ResearchInputPackage, simulated = true): AOutput {
  const hash = [...deliveredEvidence(pkg)][0]!;
  return { stage: 'A', inputHash: pkg.inputHash, subjectKind: 'STOCK', candidate: 'RESEARCH_OUTPERFORM',
    decisiveLinks: [{ text: 'TEST_ONLY 原条件一：现金流持续为正', evidenceArtifactSha256: hash },
      { text: 'TEST_ONLY 原条件二：估值条件保持', evidenceArtifactSha256: hash }],
    strongestCounter: 'TEST_ONLY 需求转弱反证', confidence: 'MEDIUM', limitations: ['TEST_ONLY'], simulated };
}

function goodRound(pkg = packageFixture(), simulated = true): ConclusionInput {
  const a = goodA(pkg, simulated), checklist = deriveChecklist(a, pkg.seals[0]!.manifestHash);
  const j: JOutput = { stage: 'J', inputHash: researchJInputHash(pkg, a, checklist), finalDisposition: a.candidate,
    verdicts: checklist.items.map((item) => ({ checklistId: item.checklistId, verdict: 'SUPPORTED', decisionBearing: true,
      correction: null, reason: `TEST_ONLY ${item.checklistId} 已核查`, evidenceArtifactSha256s: [a.decisiveLinks[0]!.evidenceArtifactSha256], remainingBasisChecklistIds: [] })),
    changedFromA: false, changeReason: null, strongestCaseDisposition: 'ACCEPTED', limitations: ['TEST_ONLY'], simulated };
  return { businessKey: pkg.businessKey, ...pkg.versions, aOutput: a, checklist, jOutput: j, manifest: pkg.seals[0]!,
    researchInput: pkg, inheritance: null, changeReason: null };
}

function expectCode(fn: () => unknown, code: string) { assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code); }

test('I-08：封存外、仅封存未送达及同 seal 错配 hash 均拒绝；结论构造不可旁路', () => {
  const r = goodRound();
  assert.equal(buildConclusionObject(r).disposition, 'RESEARCH_OUTPERFORM');
  for (const hash of ['f'.repeat(64), EXTRA_HASH]) {
    const bad = structuredClone(r);
    bad.aOutput.decisiveLinks[0]!.evidenceArtifactSha256 = hash;
    bad.checklist = deriveChecklist(bad.aOutput, r.researchInput.seals[0]!.manifestHash);
    expectCode(() => validateResearchA(bad.aOutput, bad.researchInput, true), 'A_EVIDENCE_NOT_DELIVERED');
    expectCode(() => buildConclusionObject(bad), 'A_EVIDENCE_NOT_DELIVERED');
  }
  const paired = structuredClone(r.researchInput);
  const index = paired.materials.find((m) => m.kind === 'INDEX')!;
  assert.equal(index.kind, 'INDEX');
  index.content.deliveredFacts[0]!.artifactSha256 = EXTRA_HASH;
  rehash(paired);
  expectCode(() => deliveredEvidence(paired), 'RESEARCH_EVIDENCE_UNBOUND');
  const duplicated = structuredClone(r.researchInput);
  duplicated.materials.push({ ...duplicated.materials[0]! }); rehash(duplicated);
  expectCode(() => deliveredEvidence(duplicated), 'RESEARCH_INPUT_UNBOUND');
  expectCode(() => buildConclusionObject({ ...r, researchInput: undefined as never }), 'MANIFEST_UNBOUND');
});

test('I-08：承重、剩余依据、未解处置和真实改判逐项校验', async (t) => {
  const cases: [string, string, (r: ConclusionInput) => void][] = [
    ['全非承重', 'J_NO_DECISION_BASIS', (r) => { r.jOutput.verdicts.forEach((v) => { v.decisionBearing = false; }); }],
    ['承重未知仍有方向', 'J_UNRESOLVED_DIRECTION', (r) => { const v = r.jOutput.verdicts[0]!; v.verdict = 'UNRESOLVED'; r.jOutput.limitations.push(v.checklistId); }],
    ['遗漏未知限制', 'J_UNRESOLVED_LIMITATION_REQUIRED', (r) => { r.jOutput.verdicts[0]!.verdict = 'UNRESOLVED'; }],
    ['最强论证未知', 'J_UNRESOLVED_DIRECTION', (r) => { r.jOutput.strongestCaseDisposition = 'UNRESOLVED'; }],
    ['无承重决定性连接', 'J_NO_DECISION_BASIS', (r) => { r.jOutput.verdicts.forEach((v) => { v.verdict = 'REJECTED'; v.correction = '已拒绝'; }); }],
    ['缺剩余依据', 'J_REMAINING_BASIS_INVALID', (r) => { r.jOutput.verdicts[1]!.decisionBearing = false; }],
    ['剩余依据不存在', 'J_REMAINING_BASIS_INVALID', (r) => { Object.assign(r.jOutput.verdicts[1]!, { decisionBearing: false, remainingBasisChecklistIds: ['absent'] }); }],
    ['剩余依据仍未知', 'J_REMAINING_BASIS_INVALID', (r) => { const v = r.jOutput.verdicts[0]!; v.verdict = 'UNRESOLVED'; r.jOutput.limitations.push(v.checklistId); Object.assign(r.jOutput.verdicts[1]!, { decisionBearing: false, remainingBasisChecklistIds: [v.checklistId] }); }],
    ['J 引用未送达', 'J_EVIDENCE_NOT_DELIVERED', (r) => { r.jOutput.verdicts[0]!.evidenceArtifactSha256s = [EXTRA_HASH]; }],
    ['J 已解决却无证据', 'J_EVIDENCE_REQUIRED', (r) => { r.jOutput.verdicts[0]!.evidenceArtifactSha256s = []; }],
    ['实际改判却自报未改', 'J_CHANGE_FLAG_MISMATCH', (r) => { r.jOutput.finalDisposition = 'ABSTAIN'; }],
    ['方向相同却自报改判', 'J_CHANGE_FLAG_MISMATCH', (r) => { r.jOutput.changedFromA = true; }],
    ['改判无 J 理由，外部理由不能代填', 'J_CHANGE_REASON_REQUIRED', (r) => { r.jOutput.finalDisposition = 'ABSTAIN'; r.jOutput.changedFromA = true; r.changeReason = '外部桥接'; }],
  ];
  for (const [label, code, mutate] of cases) await t.test(label, () => { const r = goodRound(); mutate(r); expectCode(() => buildConclusionObject(r), code); });
  const unknown = goodRound(), v = unknown.jOutput.verdicts[0]!;
  v.verdict = 'UNRESOLVED'; unknown.jOutput.limitations.push(v.checklistId);
  Object.assign(unknown.jOutput, { finalDisposition: 'ABSTAIN', changedFromA: true, changeReason: '承重未知，放弃' }); unknown.changeReason = '承重未知，放弃';
  assert.equal(buildConclusionObject(unknown).disposition, 'ABSTAIN');
  const nonbearing = goodRound(), n = nonbearing.jOutput.verdicts[1]!;
  Object.assign(n, { decisionBearing: false, verdict: 'UNRESOLVED', remainingBasisChecklistIds: [nonbearing.jOutput.verdicts[0]!.checklistId] });
  nonbearing.jOutput.limitations.push(n.checklistId);
  assert.equal(buildConclusionObject(nonbearing).disposition, 'RESEARCH_OUTPERFORM');
});

test('I-08：J 实际序列化包含材料全文；材料变化同时改变 A/J 输入身份，字节按实际 prompt', () => {
  const r = goodRound(), a = buildARequest(r.researchInput, true), j = buildJRequest(r.researchInput, r.aOutput, r.checklist, true);
  assert.ok(j.payload.prompt.includes('TEST_ONLY synthetic delivered content'));
  assert.ok(j.payload.prompt.includes(canonicalJsonString(r.aOutput)));
  assert.ok(j.payload.prompt.includes(canonicalJsonString(r.checklist)));
  for (const request of [a, j]) assert.equal(request.inputBytes, Buffer.byteLength(request.payload.prompt, 'utf8'));
  const changed = structuredClone(r.researchInput), material = changed.materials[0]!;
  assert.equal(material.kind, 'RECORDS'); material.records[0]!.value = 'new-content'; rehash(changed);
  const later = goodRound(changed);
  assert.notEqual(later.aOutput.inputHash, r.aOutput.inputHash);
  assert.notEqual(later.jOutput.inputHash, r.jOutput.inputHash);
  expectCode(() => validateResearchJ(r.jOutput, changed, later.aOutput, later.checklist, true), 'MODEL_OUTPUT_SCHEMA_INVALID');
});

class MemoryRows {
  readonly conclusions = new Map<string, Record<string, unknown>>();
  fact: TimePointFact | null = null;
  writes = 0;
  readonly pool = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('insert into conclusion')) {
      const [id, business, method, adapter, plan, disposition, evidence, inheritance, note, reason, settlement, created, hash] = values;
      if (this.conclusions.has(String(id))) return { rows: [] };
      const row = { conclusion_id: id, business_key: JSON.parse(String(business)), method_version: method, adapter_version: adapter,
        plan_auth_version: plan, disposition, adoption: false, evidence: JSON.parse(String(evidence)), inheritance: inheritance === null ? null : JSON.parse(String(inheritance)),
        standalone_note: note, change_reason: reason, settlement: JSON.parse(String(settlement)), created_at: created, conclusion_hash: hash };
      this.writes++; this.conclusions.set(String(id), row); return { rows: [row] };
    }
    if (sql.includes('from conclusion where conclusion_id')) return { rows: this.conclusions.has(String(values[0])) ? [this.conclusions.get(String(values[0]))] : [] };
    if (sql.includes('from pintime_fact') && this.fact?.factId === values[0]) {
      const f = this.fact!, date = (s: string | null) => s === null ? null : new Date(s);
      return { rows: [{ fact_id: f.factId, subject_type: f.subjectType, subject_id: f.subjectId, fact_kind: f.factKind, typed_value: f.typedValue,
        valid_from: date(f.validFrom), valid_to: date(f.validTo), event_at: date(f.eventAt), source_published_at: date(f.sourcePublishedAt), first_observed_at: date(f.firstObservedAt),
        available_at: date(f.availableAt), supersedes_fact_id: f.supersedesFactId, artifact_sha256: f.artifactSha256, adapter_version: f.adapterVersion }] };
    }
    throw new Error(`UNEXPECTED_TEST_SQL: ${sql.slice(0, 80)}`);
  } } as unknown as Pool;

  add(c: ConclusionObject) {
    this.conclusions.set(c.conclusionId, { conclusion_id: c.conclusionId, business_key: c.businessKey, method_version: c.methodVersion, adapter_version: c.adapterVersion,
      plan_auth_version: c.planAuthVersion, disposition: c.disposition, adoption: false, evidence: c.evidence, inheritance: c.inheritance, standalone_note: c.standaloneNote,
      change_reason: c.changeReason, settlement: c.settlement, created_at: new Date(c.createdAt), conclusion_hash: c.conclusionHash });
  }
}

function memoryPermits(t: TestContext) {
  const permits: ModelPermit[] = [];
  t.mock.method(AJ_PERMIT_SPACE, 'assertRunning', async () => {});

  t.mock.method(AJ_PERMIT_SPACE, 'preparePermit', async (_p: Pool, c: ModelCallContract, b: PlanAuthBudget, opts: { simulated?: boolean }) => {
    if (c.inputBytes > b.maxInputBytes) throw new KernelError('INPUT_OVER_BUDGET');
    const p: ModelPermit = { permitId: randomUUID(), contract: c, state: 'PREPARED', sentAt: null, settledAt: null, failCode: null, simulated: opts.simulated ?? true };
    permits.push(p); return p;
  });
  t.mock.method(AJ_PERMIT_SPACE, 'tryMarkSent', async (_p: Pool, id: string) => {
    const p = permits.find((p) => p.permitId === id)!; p.state = 'SENT'; p.sentAt = new Date().toISOString(); return { kind: 'SENT', permit: p };
  });
  t.mock.method(AJ_PERMIT_SPACE, 'settle', async (_p: Pool, id: string, outcome: { result: ModelPermit['state']; failCode?: string }) => {
    const p = permits.find((p) => p.permitId === id)!; p.state = outcome.result; p.failCode = outcome.failCode ?? null; p.settledAt = new Date().toISOString(); return p;
  });
  return permits;
}

function fakeTransport(mutate?: (stage: 'A' | 'J', output: AOutput | JOutput) => void, simulated = true) {
  const calls: { call: ModelCallContract; payload: ResearchDispatchPayload }[] = [];
  const transport: ModelTransport = {
    describe: () => ({ provider: 'TEST_ONLY fake', simulated }),
    dispatch: async (call, raw) => {
      const p = raw as ResearchDispatchPayload; calls.push({ call, payload: structuredClone(p) });
      let output: AOutput | JOutput;
      if (call.stage === 'A') output = { stage: 'A', inputHash: call.inputHash, subjectKind: 'STOCK', candidate: 'RESEARCH_OUTPERFORM',
        decisiveLinks: [1, 2].map((i) => ({ text: `TEST_ONLY 条件 ${i}`, evidenceArtifactSha256: p.material.artifactSha256s[0]! })),
        strongestCounter: 'TEST_ONLY 反证', confidence: 'MEDIUM', limitations: ['TEST_ONLY'], simulated };
      else output = { stage: 'J', inputHash: call.inputHash, finalDisposition: p.aOutput!.candidate,
        verdicts: p.checklist!.items.map((item) => ({ checklistId: item.checklistId, verdict: 'SUPPORTED', decisionBearing: true, correction: null,
          reason: 'TEST_ONLY 已核查', evidenceArtifactSha256s: [p.material.artifactSha256s[0]!], remainingBasisChecklistIds: [] })),
        changedFromA: false, changeReason: 'TEST_ONLY 比较原判断条件与新增事件后维持', strongestCaseDisposition: 'ACCEPTED', limitations: ['TEST_ONLY'], simulated };
      mutate?.(call.stage, output); return output;
    },
  };
  return { transport, calls };
}

async function assembly(store: ArtifactStore, pkg: ResearchInputPackage): Promise<AssembledResearchInput> {
  const ref = await store.put(new TextEncoder().encode(canonicalJsonString(pkg)), 'application/json', pkg.cutoff);
  return { package: pkg, inputHash: pkg.inputHash, artifactRef: ref, inputBytes: ref.bytes };
}

test('I-08 正常 Gate-M 调用链：内存回执/临时 CAS，坏 A 零 J；坏 J 零结论；正例原文可读回', async (t) => {
  const permits = memoryPermits(t), root = await mkdtemp(join(tmpdir(), 'lyra-pr3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  for (const badStage of ['A', 'J', null] as const) {
    const rows = new MemoryRows(), pkg = packageFixture();
    const fake = fakeTransport((stage, out) => {
      if (stage === 'A' && badStage === 'A') (out as AOutput).decisiveLinks[0]!.evidenceArtifactSha256 = EXTRA_HASH;
      if (stage === 'J' && badStage === 'J') (out as JOutput).verdicts.forEach((v) => { v.decisionBearing = false; });
    }, badStage !== null); // 正例另覆盖非模拟身份的 fake channel，仍无任何外发。
    const invoke = (): ReturnType<typeof runGateM> => runGateM({ dataPool: rows.pool, execPool: rows.pool, store, transport: fake.transport, assembleInput: async () => assembly(store, pkg) },
      { subject: '600519', cutoff: CUTOFF, execute: true, validatePackage: false, versions: VERSIONS, budget: BUDGET, deadline: new Date(Date.now() + 60_000).toISOString() });
    if (badStage !== null) {
      await assert.rejects(invoke, (e: unknown) => (e as { code?: string }).code === (badStage === 'A' ? 'A_EVIDENCE_NOT_DELIVERED' : 'J_NO_DECISION_BASIS'));
      assert.deepEqual(fake.calls.map((c) => c.call.stage), badStage === 'A' ? ['A'] : ['A', 'J']);
      assert.equal(rows.writes, 0); assert.equal(permits.at(-1)!.state, 'FAILED');
    } else {
      const out: Awaited<ReturnType<typeof runGateM>> = await invoke(); assert.equal(out.mode, 'execute'); if (out.mode !== 'execute') return;
      assert.equal(rows.writes, 1); assert.equal(out.permits.j.state, 'SUCCEEDED');
      const trace = JSON.parse(new TextDecoder().decode(await store.readBytes(out.conclusion.evidence.researchTraceSha256!)));
      assert.equal(trace.input.inputHash, pkg.inputHash);
      assert.equal(canonicalSha256(trace.aOutput), out.conclusion.evidence.aOutputHash);
      for (const c of fake.calls) assert.equal(c.call.inputBytes, Buffer.byteLength(c.payload.prompt, 'utf8'));
      assert.ok(fake.calls[1]!.payload.prompt.includes('TEST_ONLY synthetic delivered content'));
    }
  }
});

test('I-08 正常入口：错绑组装哈希或授权版本在任何 permit/发送前拒绝', async (t) => {
  const permits = memoryPermits(t);
  const root = await mkdtemp(join(tmpdir(), 'lyra-pr3-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root), rows = new MemoryRows(), fake = fakeTransport(), pkg = packageFixture();
  for (const badHash of [true, false]) {
    await assert.rejects(() => runGateM({ dataPool: rows.pool, execPool: rows.pool, store, transport: fake.transport,
      assembleInput: async () => ({ ...await assembly(store, pkg), ...(badHash ? { inputHash: 'f'.repeat(64) } : {}) }) },
    { subject: '600519', cutoff: CUTOFF, execute: true, validatePackage: false, versions: VERSIONS,
      budget: { ...BUDGET, planAuthVersion: badHash ? BUDGET.planAuthVersion : 'wrong:auth' } }),
    (error: unknown) => (error as { code?: string }).code === 'RESEARCH_INPUT_UNBOUND');
  }
  assert.equal(permits.length, 0); assert.equal(fake.calls.length, 0); assert.equal(rows.writes, 0);
});

const EVENT: PostEventTriggerEvent = { eventId: 'test:event', subject: '600519', type: 'EARNINGS', subtype: null,
  eventTime: '2026-11-03T08:00:00+08:00', evidenceFactId: 'test:f1' };
const ADMITTED = '2026-11-03T01:00:00.000Z';
function eventFact(pkg: ResearchInputPackage): TimePointFact {
  return { factId: 'test:f1', subjectType: 'STOCK', subjectId: '600519', factKind: 'ANNOUNCEMENT',
    typedValue: { title: 'TEST_ONLY 新增业绩公告', text: 'TEST_ONLY 新增订单超过旧条件，需比较' },
    validFrom: null, validTo: null, eventAt: pkg.cutoff, sourcePublishedAt: pkg.cutoff, firstObservedAt: pkg.cutoff,
    availableAt: pkg.cutoff, supersedesFactId: null, artifactSha256: pkg.seals[0]!.artifactRefs[0]!.sha256, adapterVersion: VERSIONS.adapterVersion };
}

async function priorFixture(store: ArtifactStore, rows: MemoryRows) {
  const r = goodRound(), c = buildConclusionObject(r);
  // 明确合成的数据库行时间，非改写任何历史/业务样本。
  c.createdAt = '2026-11-03T00:30:00.000Z';
  const trace = researchTraceOf({ input: r.researchInput, aOutput: r.aOutput, checklist: r.checklist, jOutput: r.jOutput });
  const ref = await store.put(new TextEncoder().encode(canonicalJsonString(trace)), 'application/json', CUTOFF);
  assert.equal(ref.sha256, c.evidence.researchTraceSha256);
  rows.add(c);
  return { c, r };
}

test('I-15：原文资格、不可伪造核验收据、同一时刻表示及新事实截点', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lyra-pr3-prior-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root), rows = new MemoryRows();
  const { c } = await priorFixture(store, rows);
  // 原结论完成于事件之后、准入之前，按准入时刻符合资格。
  assert.equal(priorEligibilityReason(EVENT, c, VERSIONS.methodVersion, ADMITTED), null);
  const loaded = await loadPriorResearch(rows.pool, store, c, EVENT, VERSIONS.methodVersion, ADMITTED);
  assert.ok(loaded.prior); assert.ok(loaded.verification);
  const base = packageFixture('POST_EVENT', '2026-11-03T00:00:00.000Z');
  const context: PostEventContext = { kind: 'POST_EVENT_CONTEXT_V2', basis: 'INHERITED', prior: loaded.prior,
    event: EVENT, eventFact: eventFact(base), admittedAt: ADMITTED, reason: loaded.reason };
  const pkg = withPostEventContext(base, context, INPUT_BUDGET);
  const receipt = pkg.materials.find((m) => m.materialId === 'mat:0:coverage-receipt');
  assert.equal(receipt?.kind, 'NOTE');
  assert.ok(receipt.text.includes(`- L2：${pkg.layers.l2.bytes} /`));
  assert.ok(receipt.text.includes(`固定材料 ${pkg.layers.l0.bytes - materialBytes(receipt)} 字节`));
  const r = goodRound(pkg); r.inheritance = { fromConclusionId: c.conclusionId, fromConclusionHash: c.conclusionHash };
  r.changeReason = '外部桥接'; r.jOutput.changeReason = 'J 比较旧现金流/估值条件与新增订单，维持';
  expectCode(() => buildConclusionObject(r), 'POST_EVENT_CONTEXT_INVALID');
  r.verifiedPrior = loaded.verification;
  assert.equal(buildConclusionObject(r).inheritance?.fromConclusionHash, c.conclusionHash);
  for (const mutate of [
    (ctx: PostEventContext) => { if (ctx.basis === 'INHERITED') ctx.prior.conclusion.createdAt = '2026-11-03T00:45:00.000Z'; },
    (ctx: PostEventContext) => { ctx.admittedAt = '2026-11-03T01:30:00.000Z'; },
  ]) {
    const changed: PostEventContext = structuredClone(context); mutate(changed);
    if (changed.basis !== 'INHERITED') throw new Error('TEST_ONLY expected inherited'); expectCode(() => assertVerifiedPrior(changed, loaded.verification), 'POST_EVENT_CONTEXT_INVALID');
  }
  for (const mutate of [
    (ctx: PostEventContext) => { if (ctx.basis === 'INHERITED') ctx.prior.aOutput.strongestCounter = '伪造原判断'; },
    (ctx: PostEventContext) => { ctx.eventFact.availableAt = '2026-11-04T00:00:00.000Z'; },
    (ctx: PostEventContext) => { ctx.eventFact.subjectId = '600000'; },
    (ctx: PostEventContext) => { ctx.eventFact.factId = 'unsealed'; },
  ]) { const bad = structuredClone(context); mutate(bad); expectCode(() => withPostEventContext(base, bad, INPUT_BUDGET), 'POST_EVENT_CONTEXT_INVALID'); }
  const changed = goodRound(pkg); changed.inheritance = r.inheritance; changed.changeReason = '程序代填桥接'; changed.verifiedPrior = loaded.verification;
  expectCode(() => buildConclusionObject(changed), 'J_INHERITANCE_REASON_REQUIRED');
  expectCode(() => withPostEventContext(base, context, { ...INPUT_BUDGET, l0Bytes: 1 }), 'INPUT_OVER_BUDGET');
  const missing = structuredClone(pkg); missing.materials = missing.materials.filter((m) => m.materialId !== 'mat:0:post-event-context');
  expectCode(() => validatePostEventContext(missing), 'POST_EVENT_CONTEXT_INVALID');
  const old = structuredClone(c); delete old.evidence.researchTraceSha256;
  const { conclusionHash: _old, conclusionId: _id, settlement: _s, createdAt: _at, ...core } = old;
  old.conclusionHash = canonicalSha256(core); old.conclusionId = `cc-${old.conclusionHash.slice(0, 24)}`; rows.add(old);
  const fallback = await loadPriorResearch(rows.pool, store, old, EVENT, VERSIONS.methodVersion, ADMITTED);
  assert.equal(fallback.prior, null); assert.match(fallback.reason, /缺可核验/);
  assert.match(priorEligibilityReason(EVENT, { ...c, createdAt: '2026-10-29T00:00:00.000Z' }, VERSIONS.methodVersion, ADMITTED)!, /本周/);
  assert.match(priorEligibilityReason(EVENT, { ...c, createdAt: '2026-11-04T00:00:00.000Z' }, VERSIONS.methodVersion, ADMITTED)!, /准入/);
});

test('I-15 正常事件入口：A/J payload 都送达原判断/条件与新事实；完整重研不冒称继承', async (t) => {
  memoryPermits(t);
  const root = await mkdtemp(join(tmpdir(), 'lyra-pr3-event-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root), rows = new MemoryRows();
  const { c } = await priorFixture(store, rows), pkg = packageFixture('POST_EVENT', '2026-11-03T00:00:00.000Z');
  rows.fact = eventFact(pkg);
  for (const inherited of [true, false]) {
    const fake = fakeTransport();
    const out = await runPostEventResearch({ dataPool: rows.pool, execPool: rows.pool, store, transport: fake.transport,
      calendar: { tradingDays: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'] }, assembleInput: async () => assembly(store, pkg) },
    { event: EVENT, inheritance: inherited ? { priorConclusion: c } : null, budget: BUDGET, versions: VERSIONS,
      inputBudget: INPUT_BUDGET, now: new Date(ADMITTED), deadline: new Date(Date.now() + 60_000).toISOString() });
    assert.deepEqual(fake.calls.map((x) => x.call.stage), ['A', 'J']);
    for (const { call, payload } of fake.calls) {
      assert.ok(payload.prompt.includes('TEST_ONLY 新增订单超过旧条件'));
      assert.equal(call.inputBytes, Buffer.byteLength(payload.prompt, 'utf8'));
      if (inherited) {
        assert.ok(payload.prompt.includes(c.conclusionHash));
        assert.ok(payload.prompt.includes('TEST_ONLY 原条件一'));
        assert.ok(payload.prompt.includes(c.evidence.aOutputHash));
        assert.ok(payload.prompt.includes(c.evidence.jOutputHash));
      }
    }
    assert.equal(out.declaration.basis, inherited ? 'INHERITED' : 'STANDALONE');
    assert.equal(out.conclusion.inheritance?.fromConclusionHash ?? null, inherited ? c.conclusionHash : null);
    if (!inherited) assert.match(out.conclusion.standaloneNote!, /^完整重研/);
    assert.notEqual(out.inputHash, pkg.inputHash);
    assert.equal(out.permits.jPermitId.length > 0, true);
  }
});

test('I-14/冻结边界：普通入口选新方法；P5 真实 commit 在读取/permit 前拒绝；aFrom 不猜配', async () => {
  assert.equal(GATE_M_VERSIONS.methodVersion, RESEARCH_REPAIR_METHOD_VERSION);
  const legacy = packageFixture(); legacy.versions.methodVersion = 'method@p2-v1';
  expectCode(() => buildARequest(legacy, false), 'RESEARCH_METHOD_PROTOCOL_MISMATCH');
  const denied = new Proxy({}, { get() { throw new Error('不应访问数据或执行依赖'); } }) as Pool;
  await assert.rejects(() => assembleResearchInput(denied, {} as ArtifactStore, { subjectKind: 'STOCK', subject: '600519', cutoff: CUTOFF, budget: INPUT_BUDGET, versions: { ...VERSIONS, methodVersion: 'unknown' } }), /INDICATOR_METHOD_UNSUPPORTED/);
  const real: ModelTransport = { describe: () => ({ provider: 'TEST_ONLY real identity, never dispatch', simulated: false }), dispatch: async () => { throw new Error('不应外发'); } };
  await assert.rejects(() => runNightly({ dataPool: denied, execPool: denied, store: {} as ArtifactStore,
    transport: real, calendar: { tradingDays: [] } }, { date: '2026-11-03', mode: 'commit' }), (e: unknown) => (e as { code?: string }).code === 'P5_PROTOCOL_FROZEN');
  await assert.rejects(() => runGateM({ dataPool: denied, execPool: denied, store: {} as ArtifactStore, transport: real },
    { subject: '600519', cutoff: CUTOFF, execute: true, aFrom: '/never-read/final.txt' }), (e: unknown) => (e as { code?: string }).code === 'SALVAGE_A_UNBOUND');
});

test('隔离 PG gate：真实 permit/结论 SQL，坏 A 不发送 J，正例 CAS/读回', {
  skip: process.env.LYRA_REPAIR_TEST_PG ? false : 'NOT_RUN: LYRA_REPAIR_TEST_PG 未提供隔离 PostgreSQL',
}, async (t) => {
  const connectionString = process.env.LYRA_REPAIR_TEST_PG!;
  const schema = `pr3_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const root = await mkdtemp(join(tmpdir(), 'lyra-pr3-pg-'));
  let isolated: Pool | undefined;
  t.after(async () => { await isolated?.end(); await dropSchema(admin, schema); await admin.end(); await rm(root, { recursive: true, force: true }); });
  await applySchema(admin, schema);
  isolated = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const store = new ArtifactStore(root);
  for (const bad of [true, false]) {
    const pkg = packageFixture('WEEKLY', bad ? CUTOFF : '2026-11-03T07:00:00.000Z');
    const fake = fakeTransport((stage, output) => { if (bad && stage === 'A') (output as AOutput).decisiveLinks[0]!.evidenceArtifactSha256 = EXTRA_HASH; });
    const invoke = (): ReturnType<typeof runGateM> => runGateM({ dataPool: {} as Pool, execPool: isolated!, store, transport: fake.transport, assembleInput: async () => assembly(store, pkg) },
      { subject: '600519', cutoff: pkg.cutoff, execute: true, validatePackage: false, versions: VERSIONS, budget: BUDGET, deadline: new Date(Date.now() + 60_000).toISOString() });
    if (bad) {
      await assert.rejects(invoke, (e: unknown) => (e as { code?: string }).code === 'A_EVIDENCE_NOT_DELIVERED');
      const permits: { rows: { stage: string; state: string }[] } = await isolated.query('select stage,state from exec_permit');
      assert.deepEqual(permits.rows, [{ stage: 'A', state: 'FAILED' }]);
      assert.equal((await isolated.query('select count(*)::int as n from conclusion')).rows[0].n, 0);
    } else {
      const out: Awaited<ReturnType<typeof runGateM>> = await invoke(); assert.equal(out.mode, 'execute'); if (out.mode !== 'execute') return;
      assert.equal((await isolated.query('select count(*)::int as n from conclusion')).rows[0].n, 1);
      const trace = JSON.parse(new TextDecoder().decode(await store.readBytes(out.conclusion.evidence.researchTraceSha256!)));
      assert.equal(canonicalSha256(trace.jOutput), out.conclusion.evidence.jOutputHash);
    }
  }
});
