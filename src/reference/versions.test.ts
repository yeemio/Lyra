import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { loadReferenceGroups, assembleResearchInput } from '../research/inputs.js';
import { pitFixture, PIT_TEST_VERSIONS, PIT_TEST_BUDGET } from '../research/inputs-pit-test-helper.js';
import { referenceVersionPayload, loadReferenceVersion, buildGroupLibrary } from './library.js';
import { referenceFixture } from './versions-test-helper.js';

test('I-02：完整版本绑定输入事实、成员、窗口成熟及统计；输入变动产出新身份不覆盖旧值', () => {
  const first = referenceFixture(), payload = referenceVersionPayload(first.groups, first.facts);
  const before = canonicalJsonString(payload), hash = canonicalSha256(payload);
  assert.equal(payload.inputAvailableAtMax, '2026-02-02T07:00:00.000Z');
  assert.equal(payload.maturityAtMax, '2026-02-02T07:00:00.000Z');
  assert.equal(payload.groups[0]!.members[0]!.lineage?.windows[2]?.h, 20);
  assert.equal(payload.groups[0]!.stats.h20.mean, '0.1');
  assert.equal(payload.inputFacts.length, first.facts.length);
  const later = referenceFixture('2026-03-02T00:00:00.000Z', 'event-2', '12');
  assert.notEqual(canonicalSha256(referenceVersionPayload(later.groups, later.facts)), hash);
  later.sample.h20Excess = '100'; first.groups[0]!.members[0]!.h20Excess = '100';
  assert.equal(canonicalJsonString(payload), before, '发布 payload 深拷贝输入，旧对象不随调用者数组变动');
});

test('I-02：不能靠自报窗口/结果发布；未来成员、来源、观察时间及伪造统计均具名拒绝', () => {
  const x = referenceFixture();
  const publish = (member = x.sample, facts = x.facts, identity = x.identity) => referenceVersionPayload(
    buildGroupLibrary([member], { ...identity, minGroupSample: 1 }).groups, facts);
  const badWindow = structuredClone(x.sample);
  badWindow.lineage!.windows[2] = { h: 20, status: 'OK', endDate: '2026-01-06', maturedAt: '2026-01-06T07:00:00.000Z' };
  assert.throws(() => publish(badWindow), /REFERENCE_WINDOW_UNBOUND/);
  const fakeValue = { ...x.sample, h20Excess: '77.7' };
  assert.throws(() => publish(fakeValue), /REFERENCE_WINDOW_UNBOUND/);
  assert.throws(() => publish(x.sample, x.facts.filter((f) => f.factKind !== 'DAILY_BAR')), /REFERENCE_WINDOW_UNBOUND/);
  assert.throws(() => publish({ ...x.sample, eventTime: '2027-01-01T00:00:00.000Z' }), /REFERENCE_EVENT_UNBOUND/);
  assert.throws(() => publish(x.sample, x.facts.map((f, i) => i === 0 ? { ...f, firstObservedAt: '2027-01-01T00:00:00.000Z' } : f)), /REFERENCE_INPUT_AFTER_BUILD/);
  assert.throws(() => publish(x.sample, x.facts, { ...x.identity, inputAvailableAtMax: '2025-01-01T00:00:00.000Z' }), /REFERENCE_INPUT_BOUND_MISMATCH/);
  const forged = structuredClone(x.groups); forged[0]!.stats.h20.mean = '777';
  assert.throws(() => referenceVersionPayload(forged, x.facts), /REFERENCE_STATS_UNBOUND/);
});

test('I-02：截点查询绑定完整版本；追加未来版本后旧组装材料/哈希不变；空发布有独立身份', async () => {
  const f = await pitFixture();
  try {
    const published: { version_id: string; content_hash: string; payload: ReturnType<typeof referenceVersionPayload>; published_at: Date }[] = [];
    // 查询端口明确模拟 SQL 返回；真实 SQL 时间过滤与写保护另由 versions.pg.test.ts 验证。
    const realPort = f.pool.query.bind(f.pool);
    f.pool.query = (async (sql: string, params: unknown[] = []) => {
      if (!sql.includes('from reference_library_versions')) return realPort(sql, params);
      const at = Date.parse(String(params[0]));
      return { rows: published.filter((p) => p.published_at.getTime() <= at).sort((a, b) => b.published_at.getTime() - a.published_at.getTime()).slice(0, 1) };
    }) as Pool['query'];
    const add = (payload: ReturnType<typeof referenceVersionPayload>, at: string) => {
      const hash = canonicalSha256(payload); published.push({ version_id: `rl-${hash}`, content_hash: hash, payload, published_at: new Date(at) });
    };
    const first = referenceFixture(); add(referenceVersionPayload(first.groups, first.facts), '2026-03-01T00:00:01.000Z');
    const cutoff = '2026-03-01T00:01:00.000Z';
    const opts = { subject: '600101', subjectKind: 'STOCK' as const, cutoff, versions: PIT_TEST_VERSIONS, budget: PIT_TEST_BUDGET, poolInfoFile: f.poolFile };
    const before = (await assembleResearchInput(f.pool, f.store, opts)).package;
    const id = (await loadReferenceVersion(f.pool, cutoff))!.versionId;
    assert.match(canonicalJsonString(before.materials), new RegExp(id));
    const later = referenceFixture('2026-03-02T00:00:00.000Z', 'event-2');
    add(referenceVersionPayload(later.groups, later.facts), '2026-03-02T00:00:01.000Z');
    assert.equal((await assembleResearchInput(f.pool, f.store, opts)).inputHash, before.inputHash);
    const empty = referenceVersionPayload([], [], { ...later.identity, materializedAt: '2026-03-03T00:00:00.000Z', inputAvailableAtMax: null });
    add(empty, '2026-03-03T00:00:01.000Z');
    const zero = await loadReferenceGroups(f.pool, '801120', '2026-03-03T00:01:00.000Z');
    assert.ok(zero.version); assert.equal(zero.rows.length, 0);
    assert.equal((await loadReferenceGroups(f.pool, null, '2026-01-01T00:00:00.000Z')).version, null);
    const emptyPack = (await assembleResearchInput(f.pool, f.store, { ...opts, cutoff: '2026-03-03T00:01:00.000Z' })).package;
    assert.match(canonicalJsonString(emptyPack.materials), /REFERENCE_VERSION_EMPTY/);
    assert.match(canonicalJsonString(emptyPack.materials), new RegExp(zero.version!.versionId));
    published.at(-1)!.payload.groups.push(first.groups[0]!);
    await assert.rejects(() => loadReferenceVersion(f.pool, '2026-03-03T00:01:00.000Z'), /REFERENCE_VERSION_CORRUPT/);
  } finally { await f.cleanup(); }
});
