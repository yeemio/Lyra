/** PR1 查询端口行为测试：真实组装器/CAS；不把端口替身称作 SQL 验证。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { etfMappingContent, freezeBenchmark } from '../conclusion/benchmark.js';
import { buildSeal } from '../pintime/seal.js';
import { assembleResearchInput, renderInputLayers, validateResearchInputPackage, materialBytes, type ResearchInputPackage } from './inputs.js';
import { deliveredEvidence } from './validation.js';
import { loadStockPESamples } from './industry-valuation.js';
import { pitFixture, barValue, PIT_TEST_BUDGET, PIT_TEST_VERSIONS } from './inputs-pit-test-helper.js';

async function seed(f: Awaited<ReturnType<typeof pitFixture>>) {
  for (const [subjectId, close] of [['600101', '10'], ['600102', '20']]) {
    await f.add({ subjectType: 'STOCK', subjectId: subjectId!, factKind: 'FINANCIAL', availableAt: '2025-11-01T00:00:00.000Z',
      typedValue: { code: `sh.${subjectId}`, bsQuery: 'profit', epsTTM: '1', statDate: '2025-09-30', pubDate: '2025-10-31' } });
    await f.add({ subjectType: 'STOCK', subjectId: subjectId!, factKind: 'DAILY_BAR', availableAt: '2026-01-05T07:00:00.000Z',
      typedValue: barValue(subjectId!, '2026-01-05', close) });
    await f.add({ subjectType: 'STOCK', subjectId: subjectId!, factKind: 'INDUSTRY_CLASS_VERSION', availableAt: '2021-07-30T16:00:00.000Z',
      validFrom: '2021-07-29T16:00:00.000Z', adapterVersion: 'sw@synthetic',
      typedValue: { 股票代码: subjectId, 行业代码: '340501', 计入日期ISO: '2021-07-30', 体系: '2021', l1IndexCode: '801120' } });
  }
  await f.add({ subjectType: 'INDEX', subjectId: 'sw-list', factKind: 'SW_INDEX_LIST', availableAt: '2025-01-01T00:00:00.000Z',
    typedValue: { rows: [{ 行业代码: '801120.SI', 行业名称: '截点内合成行业' }] } });
}
const options = (f: Awaited<ReturnType<typeof pitFixture>>, cutoff: string) => ({ subjectKind: 'STOCK' as const,
  subject: '600101', cutoff, poolInfoFile: f.poolFile, budget: PIT_TEST_BUDGET, versions: PIT_TEST_VERSIONS });
function rehash(pkg: ResearchInputPackage) {
  for (const layer of [pkg.layers.l0, pkg.layers.l1, pkg.layers.l2]) {
    for (const b of layer.blocks) b.bytes = materialBytes(pkg.materials.find((m) => m.materialId === b.materialId)!);
    layer.bytes = layer.blocks.reduce((n, b) => n + b.bytes, 0);
  }
  const { inputHash: _old, ...core } = pkg; pkg.inputHash = canonicalSha256(core);
}

test('I-01：旧整行事实经正常材料入口也剔除事后字段；D+1/D+19 包与 seal 不受后续结果影响', async () => {
  const f = await pitFixture();
  try {
    await seed(f);
    await f.add({ subjectType: 'STOCK', subjectId: '600101', factKind: 'UNLOCK_DETAIL', availableAt: '2026-01-05T16:00:00.000Z',
      eventAt: '2026-01-05T07:00:00.000Z', typedValue: { 解禁时间: '2026-01-05', 实际解禁数量: 10000,
        解禁后20日涨跌幅: 77.7, 新增事后列: 999, unlockDateISO: '2026-01-05', code: 'sh.600101' } });
    const cutoffs = ['2026-01-06T02:00:00.000Z', '2026-01-30T08:00:00.000Z'];
    const before = await Promise.all(cutoffs.map(async (cutoff) => (await assembleResearchInput(f.pool, f.store, options(f, cutoff))).package));
    for (const p of before) {
      const delivered = canonicalJsonString(renderInputLayers(p));
      assert.match(delivered, /实际解禁数量/);
      assert.doesNotMatch(delivered, /77\.7|新增事后列|999/);
      const record = p.materials.find((m) => m.materialId.includes('unlock') && m.kind === 'RECORDS');
      assert.ok(record);
    }
    await f.add({ subjectType: 'STOCK', subjectId: '600101', factKind: 'UNLOCK_OUTCOME', availableAt: '2026-02-02T08:00:00.000Z',
      typedValue: { maturedAt: '2026-02-02T07:00:00.000Z', 解禁后20日涨跌幅: 88.8 } });
    for (let i = 0; i < cutoffs.length; i++) {
      const after = (await assembleResearchInput(f.pool, f.store, options(f, cutoffs[i]!))).package;
      assert.equal(after.inputHash, before[i]!.inputHash);
      assert.deepEqual(after.seals, before[i]!.seals);
    }
  } finally { await f.cleanup(); }
});

test('I-03/M-01：上午材料 PE=10、分位=0，下午事实不改变旧包；精确输入 fact IDs 都封存', async () => {
  const f = await pitFixture();
  try {
    await seed(f);
    const cutoff = '2026-01-06T02:00:00.000Z';
    const before = (await assembleResearchInput(f.pool, f.store, options(f, cutoff))).package;
    const valuation = before.materials.find((m) => m.materialId.includes('industry-valuation'));
    assert.ok(valuation);
    const text = canonicalJsonString(valuation);
    assert.match(valuation.title, /本股 PE=10，本股行业截面分位=0/);
    assert.doesNotMatch(text, /\[object Object\]/);
    const { loadIndustryValuation } = await import('./inputs.js');
    const exact = await loadIndustryValuation(f.pool, '600101', cutoff);
    assert.equal(exact?.stockPE, '10'); assert.equal(exact?.stockIndustryPercentile, '0');
    assert.equal(exact?.cutoffIso, cutoff);
    assert.deepEqual([...valuation.factIds].sort(), exact!.inputFacts.map((x) => x.factId).sort());
    assert.ok(valuation.factIds.every((id) => before.seals.some((s) => s.factIds.includes(id))));
    await f.add({ subjectType: 'STOCK', subjectId: '600101', factKind: 'DAILY_BAR', availableAt: '2026-01-06T07:00:00.000Z',
      typedValue: barValue('600101', '2026-01-06', '30') });
    const after = (await assembleResearchInput(f.pool, f.store, options(f, cutoff))).package;
    assert.equal(after.inputHash, before.inputHash);
    assert.deepEqual(after.materials, before.materials);
    assert.equal((await loadIndustryValuation(f.pool, '600101', '2026-01-06T08:00:00.000Z'))?.stockPE, '30');
    assert.equal((await validateResearchInputPackage(f.pool, f.store, before)).ok, true);
    const cross = await loadStockPESamples(f.pool, '2026-01-05T17:00:00.000Z');
    assert.equal(cross.asOf, '2026-01-06'); assert.equal(cross.cutoffIso, '2026-01-05T17:00:00.000Z');
    await assert.rejects(() => loadStockPESamples(f.pool, '2026-01-06'), /INDUSTRY_VALUATION_AS_OF_INVALID/);
  } finally { await f.cleanup(); }
});

test('I-04：L1 被预算降级时基准仍送达 L0；错绑原文及未送达基准均拒绝', async () => {
  const f = await pitFixture();
  try {
    await seed(f);
    const opts = options(f, '2026-01-06T02:00:00.000Z');
    const pkg = (await assembleResearchInput(f.pool, f.store, { ...opts, budget: { ...PIT_TEST_BUDGET, l1Bytes: 1 } })).package;
    assert.equal(pkg.benchmark?.indexCode, '801120');
    assert.ok(pkg.layers.l0.blocks.some((b) => b.materialId === 'mat:0:frozen-benchmark'));
    assert.ok(deliveredEvidence(pkg).has(pkg.benchmark!.attributionFact!.artifactSha256));
    const index = pkg.materials.find((m) => m.kind === 'INDEX');
    assert.ok(index?.kind === 'INDEX');
    assert.deepEqual(index.content.deliveredFacts.map((e) => [e.factId, e.materialId, e.layer]),
      [[pkg.benchmark!.attributionFact!.factId, 'mat:0:frozen-benchmark', 'L0']]);
    const removed = structuredClone(pkg);
    removed.layers.l0.blocks = removed.layers.l0.blocks.filter((b) => b.materialId !== 'mat:0:frozen-benchmark'); rehash(removed);
    assert.throws(() => deliveredEvidence(removed), (e: unknown) => (e as { code?: string }).code === 'BENCHMARK_NOT_DELIVERED');
    const forged = structuredClone(pkg);
    const fact = structuredClone(forged.benchmark!.attributionFact!);
    (fact.typedValue as Record<string, unknown>).l1IndexCode = '801999';
    forged.benchmark = freezeBenchmark({ ...forged.businessKey, facts: [fact] });
    const material = forged.materials.find((m) => m.materialId === 'mat:0:frozen-benchmark')!;
    assert.equal(material.kind, 'RECORDS');
    if (material.kind === 'RECORDS') material.records = [forged.benchmark as unknown as Record<string, unknown>];
    rehash(forged);
    await assert.rejects(() => validateResearchInputPackage(f.pool, f.store, forged), /冻结基准与归属事实原文不符/);
    const future = await f.add({ subjectType: 'STOCK', subjectId: '600101', factKind: 'ANNOUNCEMENT', typedValue: { title: 'future' }, availableAt: '2027-01-01T00:00:00.000Z' });
    await assert.rejects(() => buildSeal(f.pool, f.store, { ...opts.versions, businessKey: pkg.businessKey, cutoff: pkg.cutoff,
      factSelector: {}, selectedFactIds: [future.factId], gaps: [] }), (e: unknown) => (e as { code?: string }).code === 'SEAL_INPUT_FACT_NOT_VISIBLE');
  } finally { await f.cleanup(); }
});

test('I-04：ETF 自述旧 frozenAt 不冒充历史证明；CAS 首见身份固定，改当前池不改旧包', async () => {
  const f = await pitFixture();
  try {
    const cutoff = '2026-01-06T02:00:00.000Z';
    const opts = { ...options(f, cutoff), subjectKind: 'BROAD_ETF' as const, subject: '510300' };
    await f.add({ subjectType: 'INDEX', subjectId: '000300', factKind: 'DAILY_BAR', availableAt: '2026-01-05T07:00:00.000Z',
      typedValue: barValue('000300', '2026-01-05') });
    await f.add({ subjectType: 'INDEX', subjectId: '000300', factKind: 'INDEX_VALUATION', availableAt: '2026-01-01T00:00:00.000Z',
      typedValue: { date: '2025-12-31', pe: '10', pb: '1' } });
    const proxy = (await assembleResearchInput(f.pool, f.store, opts)).package;
    assert.equal(proxy.benchmark?.status, 'CURRENT_PROXY');
    assert.equal(proxy.benchmark?.reason, 'ETF_MAPPING_NOT_OBSERVED_AT_CUTOFF');
    for (const id of ['mat:5:tracking-index-bar-table', 'mat:1:index-valuation-series']) {
      assert.match(proxy.materials.find((m) => m.materialId === id)!.title, /当前映射代理指数（非截点已证实基准）/);
    }
    const style = proxy.materials.find((m) => m.materialId === 'mat:6:style-relative-note');
    assert.ok(style?.kind === 'NOTE'); assert.match(style.text, /仅封存当前映射代理指数/);
    assert.match(canonicalJsonString(renderInputLayers(proxy)), /不具备正式结算资格/);
    const oldHash = proxy.inputHash, oldText = canonicalJsonString(renderInputLayers(proxy));
    f.poolData.etfs[0]!.tracks = '后来的新映射(000905)';
    await writeFile(f.poolFile, JSON.stringify(f.poolData));
    const later = (await assembleResearchInput(f.pool, f.store, opts)).package;
    assert.equal(later.benchmark?.status, 'CURRENT_PROXY'); assert.notEqual(later.benchmark?.bindingHash, proxy.benchmark?.bindingHash);
    assert.ok(later.dimensions.find((d) => d.dimension === 5)!.gap.some((g) => g.includes('当前映射代理指数（非截点已证实基准） 000905 无 as-of')));
    assert.equal(proxy.inputHash, oldHash); assert.equal(canonicalJsonString(renderInputLayers(proxy)), oldText);
    assert.equal((await validateResearchInputPackage(f.pool, f.store, proxy)).ok, true);
    // 明确合成、在实际 CAS 中预置截点前的观察回执，证明可核查正例；不代表真实历史映射。
    const config = { frozenAt: f.poolData.frozenAt, tracks: '已观察合成映射(000852)' };
    await f.store.put(new TextEncoder().encode(canonicalJsonString(etfMappingContent('510300', config))), 'application/json', '2025-01-01T00:00:00.000Z');
    f.poolData.etfs[0]!.tracks = config.tracks; await writeFile(f.poolFile, JSON.stringify(f.poolData));
    const frozen = (await assembleResearchInput(f.pool, f.store, opts)).package;
    assert.equal(frozen.benchmark?.status, 'RESOLVED'); assert.equal(frozen.benchmark?.indexCode, '000852');
    assert.equal((await validateResearchInputPackage(f.pool, f.store, frozen)).ok, true);
    f.poolData.etfs[0]!.tracks = '无法解析'; await writeFile(f.poolFile, JSON.stringify(f.poolData));
    const missing = (await assembleResearchInput(f.pool, f.store, opts)).package;
    assert.equal(missing.benchmark?.status, 'MISSING');
    const missingStyle = missing.materials.find((m) => m.materialId === 'mat:6:style-relative-note');
    assert.ok(missingStyle?.kind === 'NOTE'); assert.match(missingStyle.text, /缺可解析的指数映射/);
  } finally { await f.cleanup(); }
});
