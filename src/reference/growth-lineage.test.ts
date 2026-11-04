/** PR1 R2：公开合成原件 + 真实检测/窗口/发布函数；查询端口不冒充 PostgreSQL。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { detectGrowthEvents, eventIdOf, type GrowthInput } from '../events/detect.js';
import { asOfFacts } from '../pintime/facts.js';
import { pitFixture } from '../research/inputs-pit-test-helper.js';
import { REVISION_NOTICE, type ReferenceEventLayers } from './groups.js';
import { buildGroupLibrary, growthReferenceLineage, loadGrowthReferenceFacts, referenceVersionPayload } from './library.js';
import { referenceFixture } from './versions-test-helper.js';

async function growthFixture() {
  const source = await pitFixture();
  const rows: GrowthInput[] = [
    { factId: 'growth-prev', statDate: '2025-06-30', pubDate: '2025-08-01', availableAt: '2025-08-02T00:00:00.000Z', yoyNi: 0 },
    { factId: 'growth-first', statDate: '2025-09-30', pubDate: '2026-01-04', availableAt: '2026-01-05T08:00:00.000Z', yoyNi: 0.4 },
    { factId: 'growth-revised', statDate: '2025-09-30', pubDate: '2026-01-06', availableAt: '2026-01-06T08:00:00.000Z', yoyNi: 0.8 },
  ];
  for (const r of rows) await source.add({ factId: r.factId, subjectType: 'STOCK', subjectId: '600101', factKind: 'FINANCIAL',
    typedValue: { bsQuery: 'growth', statDate: r.statDate, pubDate: r.pubDate, YOYNI: String(r.yoyNi) },
    availableAt: r.availableAt, firstObservedAt: r.factId === 'growth-revised' ? '2026-02-25T00:00:00.000Z' : r.availableAt,
    supersedesFactId: r.factId === 'growth-revised' ? 'growth-first' : null });
  const x = referenceFixture();
  const event = detectGrowthEvents('600101', rows, 0.2).events[0]!;
  const sample: ReferenceEventLayers = { ...x.sample, eventKey: event.eventType, eventTime: event.eventTime,
    lineage: { ...x.sample.lineage!, eventId: eventIdOf(event.subject, event.eventType, event.evidenceFactId),
      evidenceFactId: event.evidenceFactId, growth: growthReferenceLineage(event, source.facts) } };
  const facts = [...x.facts.filter((f) => f.factKind !== 'ANNOUNCEMENT'), ...source.facts];
  const publish = (member = sample, inputs = facts, identity = x.identity) =>
    referenceVersionPayload(buildGroupLibrary([member], { ...identity, minGroupSample: 1 }).groups, inputs);
  return { source, rows, event, sample, facts, identity: x.identity, publish };
}

test('R2：真实检测器的初披锚点/最新修订值可发布；三份 CAS 原件与真实输入时间进入身份', async () => {
  const x = await growthFixture();
  try {
    const payload = x.publish(), lineage = payload.groups[0]!.members[0]!.lineage!;
    assert.equal(x.event.eventTime, '2026-01-05T08:00:00.000Z');
    assert.equal(lineage.evidenceFactId, 'growth-revised');
    assert.equal(lineage.growth!.firstDisclosureFactId, 'growth-first');
    assert.equal(lineage.growth!.previousEvidenceFactId, 'growth-prev');
    assert.deepEqual(lineage.growth!.revisionFactIds, ['growth-first', 'growth-prev', 'growth-revised']);
    assert.equal(lineage.growth!.attrs.valueCaliber, 'LATEST_REVISION');
    assert.equal(lineage.growth!.attrs.delta, 0.8);
    assert.equal(lineage.growth!.attrs.revisionCaliberStatement, REVISION_NOTICE);
    assert.ok(payload.groups.every((g) => g.revisionNotice === REVISION_NOTICE));
    assert.equal(payload.inputAvailableAtMax, '2026-02-02T07:00:00.000Z');
    assert.equal(payload.inputObservedAtMax, '2026-02-25T00:00:00.000Z');
    assert.equal(payload.groups[0]!.stats.h20.mean, '0.1');
    for (const f of x.source.facts) {
      const ref = payload.inputFacts.find((r) => r.factId === f.factId)!;
      assert.equal(ref.factHash, canonicalSha256(f));
      assert.equal(ref.artifactSha256, f.artifactSha256);
      assert.equal(ref.availableAt, f.availableAt);
      assert.equal(ref.firstObservedAt, f.firstObservedAt);
      const original = JSON.parse(new TextDecoder().decode(await x.source.store.readBytes(ref.artifactSha256)));
      assert.equal(original.factId, f.factId);
      assert.deepEqual(original.typedValue, f.typedValue);
    }
    // pubDate 改变的修订可能没有 supersedes 指针；仍需同股同报告期的实际初披行，不伪造指针。
    const unlinked = x.facts.map((f) => ({ ...f, supersedesFactId: null }));
    assert.doesNotThrow(() => x.publish(x.sample, unlinked));
  } finally { await x.source.cleanup(); }
});

test('R2：缺初披/比较证据、错误股票/报告期、伪造锚点/修订声明/差值/链均拒绝', async () => {
  const x = await growthFixture();
  try {
    const rejectMember = (change: (m: ReferenceEventLayers) => void) => {
      const bad = structuredClone(x.sample); change(bad);
      assert.throws(() => x.publish(bad), /REFERENCE_(GROWTH_LINEAGE|EVENT)_UNBOUND/);
    };
    rejectMember((m) => { delete m.lineage!.growth; });
    rejectMember((m) => { m.lineage!.growth!.firstDisclosureFactId = 'invented'; });
    rejectMember((m) => { m.lineage!.growth!.revisionFactIds.pop(); });
    rejectMember((m) => { m.lineage!.eventId = 'wrong-event'; });
    rejectMember((m) => { m.lineage!.growth!.attrs.valueCaliber = 'STRICT_PIT'; });
    rejectMember((m) => { m.lineage!.growth!.attrs.delta = 99; });
    rejectMember((m) => { m.lineage!.growth!.attrs.threshold = 0.9; });
    for (const time of ['2026-01-04T08:00:00.000Z', '2026-01-06T08:00:00.000Z']) rejectMember((m) => { m.eventTime = time; });
    for (const id of ['growth-first', 'growth-prev', 'growth-revised']) {
      assert.throws(() => x.publish(x.sample, x.facts.filter((f) => f.factId !== id)), /REFERENCE_(GROWTH_LINEAGE|EVENT)_UNBOUND/);
      assert.throws(() => x.publish(x.sample, x.facts.map((f) => f.factId === id ? { ...f, subjectId: '600102' } : f)), /REFERENCE_(GROWTH_LINEAGE|EVENT)_UNBOUND/);
    }
    for (const change of [
      { factKind: 'ANNOUNCEMENT' },
      { typedValue: { bsQuery: 'growth', statDate: '2025-12-31', pubDate: '2026-01-04', YOYNI: '0.4' } },
      { supersedesFactId: 'missing-parent' },
    ]) assert.throws(() => x.publish(x.sample, x.facts.map((f) => f.factId === 'growth-first' ? { ...f, ...change } : f)), /REFERENCE_GROWTH_LINEAGE_UNBOUND/);
  } finally { await x.source.cleanup(); }
});

test('R2：修订例外不放开未来输入/观察/成员、未成熟/伪造窗口或统计', async () => {
  const x = await growthFixture();
  try {
    const future = '2027-01-01T00:00:00.000Z';
    assert.throws(() => x.publish({ ...x.sample, eventTime: future }), /REFERENCE_EVENT_UNBOUND/);
    for (const id of ['growth-first', 'growth-prev', 'growth-revised']) {
      assert.throws(() => x.publish(x.sample, x.facts.map((f) => f.factId === id ? { ...f, firstObservedAt: future } : f)), /REFERENCE_INPUT_AFTER_BUILD/);
    }
    assert.throws(() => x.publish(x.sample, x.facts.map((f) => f.factId === 'growth-revised' ? { ...f, availableAt: future } : f),
      { ...x.identity, inputAvailableAtMax: future }), /REFERENCE_INPUT_AFTER_BUILD/);
    assert.throws(() => x.publish(x.sample, x.facts, { ...x.identity, inputAvailableAtMax: x.event.eventTime }), /REFERENCE_INPUT_BOUND_MISMATCH/);
    assert.throws(() => x.publish(x.sample, x.facts, { ...x.identity, materializedAt: '2026-01-20T00:00:00.000Z' }), /REFERENCE_MATURITY_INVALID/);
    const badWindow = structuredClone(x.sample);
    badWindow.lineage!.windows[2] = { h: 20, status: 'OK', endDate: '2026-01-06', maturedAt: '2026-01-06T07:00:00.000Z' };
    assert.throws(() => x.publish(badWindow), /REFERENCE_WINDOW_UNBOUND/);
    assert.throws(() => x.publish({ ...x.sample, h20Excess: '99' }), /REFERENCE_WINDOW_UNBOUND/);
    const groups = buildGroupLibrary([x.sample], { ...x.identity, minGroupSample: 1 }).groups;
    groups[0]!.stats.h20.mean = '99';
    assert.throws(() => referenceVersionPayload(groups, x.facts), /REFERENCE_STATS_UNBOUND/);
  } finally { await x.source.cleanup(); }
});

test('R2：CLI 历史装载保留 superseded 初披；后续修订不替换旧事件快照及已构造版本', async () => {
  const x = await growthFixture();
  try {
    const before = x.publish(), beforeJson = canonicalJsonString(before);
    const at = new Date(x.identity.materializedAt);
    const loaded = await loadGrowthReferenceFacts(x.source.pool, '600101', at);
    assert.deepEqual(loaded.map((f) => f.factId), ['growth-prev', 'growth-first', 'growth-revised']);
    const visible = await asOfFacts(x.source.pool, { subjectType: 'STOCK', subjectId: '600101', factKind: 'FINANCIAL', asOf: at });
    assert.equal(visible.some((f) => f.factId === 'growth-first'), false, '普通 as-of 隐去旧行，不能证明初披');
    assert.deepEqual(growthReferenceLineage(x.event, loaded), x.sample.lineage!.growth);
    const late = await x.source.add({ factId: 'growth-later', subjectType: 'STOCK', subjectId: '600101', factKind: 'FINANCIAL',
      typedValue: { bsQuery: 'growth', statDate: '2025-09-30', pubDate: '2026-03-02', YOYNI: '1.2' },
      availableAt: '2026-03-02T08:00:00.000Z', supersedesFactId: 'growth-revised' });
    assert.equal((await loadGrowthReferenceFacts(x.source.pool, '600101', at)).length, 3, '建库截点后事实不加载');
    assert.deepEqual(growthReferenceLineage(x.event, x.source.facts), x.sample.lineage!.growth, '旧事件已有的数值边界保留');
    const event = detectGrowthEvents('600101', [...x.rows, { factId: late.factId, statDate: '2025-09-30', pubDate: '2026-03-02', availableAt: late.availableAt, yoyNi: 1.2 }], 0.2).events[0]!;
    const member = structuredClone(x.sample);
    member.lineage = { ...member.lineage!, eventId: eventIdOf(event.subject, event.eventType, event.evidenceFactId), evidenceFactId: event.evidenceFactId,
      growth: growthReferenceLineage(event, x.source.facts) };
    assert.equal(event.eventTime, x.event.eventTime);
    const after = x.publish(member, [...x.facts, late], { ...x.identity, inputAvailableAtMax: late.availableAt, materializedAt: '2026-03-03T00:00:00.000Z' });
    assert.notEqual(canonicalSha256(after), canonicalSha256(before));
    assert.equal(canonicalJsonString(before), beforeJson);
    assert.equal(before.inputFacts.some((f) => f.factId === late.factId), false);
  } finally { await x.source.cleanup(); }
});
