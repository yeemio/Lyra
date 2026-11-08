/** I-04：冻结、结论/报告消费和真实结算函数的合成查询端口回归；非 SQL/业务证据。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalSha256 } from '../canonical.js';
import { SW2021_PREFIX_L1 } from '../adapters/sw.js';
import { freezeBenchmark, validateFrozenBenchmark, requireResolvedBenchmark, trackingIndexCode } from './benchmark.js';
import { buildConclusionObject } from './object.js';
import { syntheticConclusionInput } from '../research/research-test-helper.js';
import { buildReportView, renderReportText } from '../research/report.js';
import { deriveChecklist } from '../research/checklist.js';
import { simulatedModelJ } from '../research/simulated.js';
import { deliveredEvidence, researchJInputHash } from '../research/validation.js';
import { materialBytes } from '../research/inputs.js';
import { settleConclusion } from '../settlement/settle.js';
import { settleEtfConclusion } from '../settlement/etf.js';
import { pitFixture, barValue, PIT_TEST_VERSIONS, testEtfMapping } from '../research/inputs-pit-test-helper.js';

const key = { subjectKind: 'STOCK' as const, subject: '600101', researchKind: 'WEEKLY' as const, cutoff: '2026-01-06T02:00:00.000Z' };
test('I-04：有效归属缺指数时保留原 fact；跨体系基准按保存的映射验证，当前表变化不改旧报告', async () => {
  const f = await pitFixture();
  try {
    const fact = await f.add({ subjectType: 'STOCK', subjectId: key.subject, factKind: 'INDUSTRY_CLASS_VERSION',
      typedValue: { 体系: '2021', 行业代码: '340501', l1IndexCode: null }, availableAt: '2021-07-30T16:00:00.000Z', validFrom: '2021-07-29T16:00:00.000Z' });
    const missing = freezeBenchmark({ ...key, facts: [fact] });
    assert.equal(missing.status, 'MISSING'); assert.equal(missing.attributionFact?.factId, fact.factId);
    assert.equal(missing.reason, 'INDUSTRY_INDEX_MAPPING_MISSING');
    assert.throws(() => requireResolvedBenchmark(missing, key), /INDUSTRY_INDEX_MAPPING_MISSING/);
    const carried = { ...fact, typedValue: { 体系: 'pre2014', 行业代码: '410102', l1IndexCode: null } };
    const binding = freezeBenchmark({ ...key, facts: [carried] });
    assert.equal(binding.indexCode, '801160');
    const persisted = JSON.parse(JSON.stringify(binding));
    const table = SW2021_PREFIX_L1 as Record<string, string>, original = table['41'];
    try {
      table['41'] = '801999';
      assert.equal(validateFrozenBenchmark(persisted, key).indexCode, '801160');
      assert.equal(validateFrozenBenchmark(binding, key).indexCode, '801160');
      (carried.typedValue as Record<string, unknown>).行业代码 = '340501';
      assert.equal(validateFrozenBenchmark(binding, key).indexCode, '801160');
    } finally { table['41'] = original!; }
    const wrong = structuredClone(persisted); wrong.indexCode = '801999';
    const { bindingHash: _hash, ...core } = wrong; wrong.bindingHash = canonicalSha256(core);
    assert.throws(() => validateFrozenBenchmark(wrong, key), /BENCHMARK_MAPPING_MISMATCH/);
    assert.throws(() => validateFrozenBenchmark(persisted, { ...key, subject: '600102' }), /BENCHMARK_BINDING_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('I-04：新结论冻结原基准；后来历史回填/池映射变动不改变结算和报告', async () => {
  const f = await pitFixture();
  try {
    const original = await f.add({ subjectType: 'STOCK', subjectId: key.subject, factKind: 'INDUSTRY_CLASS_VERSION',
      typedValue: { 体系: '2021', 行业代码: '340501', l1IndexCode: '801120' }, availableAt: '2021-07-30T16:00:00.000Z', validFrom: '2021-07-29T16:00:00.000Z' });
    const frozen = freezeBenchmark({ ...key, facts: [original] });
    const input = syntheticConclusionInput(key, PIT_TEST_VERSIONS, frozen);
    const conclusion = JSON.parse(JSON.stringify(buildConclusionObject(input)));
    const text = renderReportText(buildReportView(conclusion, input.researchInput, input.aOutput, input.checklist, input.jOutput));
    assert.match(text, /冻结基准：801120/); assert.match(text, new RegExp(frozen.bindingHash));
    for (const date of ['2026-01-07', '2026-01-08']) {
      await f.add({ subjectType: 'RULE', subjectId: 'ashare-calendar', factKind: 'TRADE_CALENDAR', availableAt: `${date}T07:00:00.000Z`,
        typedValue: { calendar_date: date, is_trading_day: '1' } });
      await f.add({ subjectType: 'STOCK', subjectId: key.subject, factKind: 'DAILY_BAR', availableAt: `${date}T07:00:00.000Z`,
        typedValue: barValue(key.subject, date, date.endsWith('08') ? '11' : '10') });
      await f.add({ subjectType: 'INDEX', subjectId: '801120', factKind: 'SW_INDEX_BAR', availableAt: `${date}T07:00:00.000Z`,
        typedValue: { 日期: date, 开盘: 1000, 收盘: 1000 } });
    }
    const args = { subject: key.subject, cutoff: key.cutoff, conclusionTime: '2026-01-06T04:00:00.000Z',
      disposition: 'RESEARCH_OUTPERFORM' as const, benchmark: conclusion.evidence.benchmark, asOf: new Date('2026-01-10T00:00:00Z'), window: 2 };
    const settled = await settleConclusion(f.pool, args);
    assert.equal(settled.state, 'SETTLED', JSON.stringify(settled));
    if (settled.state === 'SETTLED') assert.equal(settled.zone.excessReturn, '0.1');
    const backfill = await f.add({ ...original, factId: 'later-historical-backfill', typedValue: { 体系: '2021', 行业代码: '220101', l1IndexCode: '801030' },
      validFrom: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z', supersedesFactId: original.factId });
    assert.equal(freezeBenchmark({ ...key, facts: [original, backfill] }).indexCode, '801030');
    f.poolData.stocks[0]!.swL1IndexCode = '801030';
    assert.deepEqual(await settleConclusion(f.pool, args), settled);
    assert.equal(renderReportText(buildReportView(conclusion, input.researchInput, input.aOutput, input.checklist, input.jOutput)), text);
    const unbound = await settleConclusion(f.pool, { ...args, benchmark: undefined });
    assert.equal(unbound.state === 'ANOMALY' && unbound.code, 'BENCHMARK_NOT_FROZEN');
    const wrong = freezeBenchmark({ ...key, facts: [{ ...original, typedValue: { 体系: '2021', 行业代码: '340501', l1IndexCode: '801999' } }] });
    const rejected = await settleConclusion(f.pool, { ...args, benchmark: wrong });
    assert.equal(rejected.state === 'ANOMALY' && rejected.code, 'BENCHMARK_FACT_MISMATCH');
  } finally { await f.cleanup(); }
});

test('I-04：ETF 只消费有观察证明的冻结指数，错配 trackedIndex 或历史代理不能正式结算', async () => {
  const f = await pitFixture();
  try {
    const subject = '510300';
    for (const date of ['2026-01-07', '2026-01-08']) {
      await f.add({ subjectType: 'RULE', subjectId: 'ashare-calendar', factKind: 'TRADE_CALENDAR', availableAt: `${date}T07:00:00.000Z`, typedValue: { calendar_date: date, is_trading_day: '1' } });
      await f.add({ subjectType: 'ETF', subjectId: subject, factKind: 'DAILY_BAR', availableAt: `${date}T07:00:00.000Z`, typedValue: barValue(subject, date) });
      await f.add({ subjectType: 'INDEX', subjectId: '000300', factKind: 'DAILY_BAR', availableAt: `${date}T07:00:00.000Z`, typedValue: barValue('000300', date, date.endsWith('08') ? '11' : '10') });
    }
    const args = { subject, cutoff: key.cutoff, disposition: 'RESEARCH_UP' as const, conclusionTime: '2026-01-06T04:00:00.000Z',
      asOf: new Date('2026-01-10T00:00:00Z'), window: 2 };
    const benchmark = freezeBenchmark({ ...args, subjectKind: 'BROAD_ETF', facts: [], etfMapping: testEtfMapping(subject, '原指数(000300)') });
    const result = await settleEtfConclusion(f.pool, { ...args, benchmark });
    assert.equal(result.state, 'SETTLED');
    if (result.state === 'SETTLED') { assert.equal(result.diagnostics.trackedIndex, '000300'); assert.equal(result.zone.excessReturn, '0.1'); }
    const mismatch = await settleEtfConclusion(f.pool, { ...args, benchmark, trackedIndex: '000905' });
    assert.equal(mismatch.state === 'ANOMALY' && mismatch.code, 'BENCHMARK_BINDING_MISMATCH');
    const proxy = freezeBenchmark({ ...args, subjectKind: 'BROAD_ETF', facts: [], etfMapping: { frozenAt: '2023-01-01', tracks: '原指数(000300)' } });
    const blocked = await settleEtfConclusion(f.pool, { ...args, benchmark: proxy });
    assert.equal(blocked.state === 'ANOMALY' && blocked.code, 'ETF_MAPPING_NOT_OBSERVED_AT_CUTOFF');
    for (const text of ['无代码', 'A(000300) B(000905)', '000300(000300)']) assert.equal(trackingIndexCode(text), null);
  } finally { await f.cleanup(); }
});

test('I-04：旧 v1 送达包仍可核验读取，但不能直接构造缺冻结身份的新结论', () => {
  const input = syntheticConclusionInput(key, PIT_TEST_VERSIONS);
  const pkg = input.researchInput;
  delete pkg.benchmark; pkg.packageVersion = 1;
  pkg.materials = pkg.materials.filter((m) => m.materialId !== 'mat:0:frozen-benchmark');
  pkg.layers.l0.blocks = []; pkg.layers.l0.bytes = 0;
  const { inputHash: _hash, ...core } = pkg; pkg.inputHash = canonicalSha256(core);
  assert.ok(deliveredEvidence(pkg).size > 0);
  // 重新绑定 A/J，确保失败来自基准缺失，而非旧输入哈希。
  input.aOutput.inputHash = pkg.inputHash;
  input.checklist = deriveChecklist(input.aOutput, input.manifest.manifestHash);
  input.jOutput = simulatedModelJ({ inputHash: researchJInputHash(pkg, input.aOutput, input.checklist), subjectKind: 'STOCK',
    aOutput: input.aOutput, checklist: input.checklist });
  assert.throws(() => buildConclusionObject(input), /BENCHMARK_NOT_FROZEN/);
  assert.ok(pkg.layers.l1.blocks.every((b) => b.bytes === materialBytes(pkg.materials.find((m) => m.materialId === b.materialId)!)));
});
