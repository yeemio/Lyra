/** I-04：正常 SR 证据入口，公开合成事实/临时目录；无私有资料、模型、业务库。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJsonString } from '../canonical.js';
import { buildEvidencePack } from './evidence.js';
import { pitFixture, barValue } from '../research/inputs-pit-test-helper.js';

test('I-04 SR：无历史归属不回退当前池；沪深300仅标市场代理，归属缺口与名称不伪造', async () => {
  const f = await pitFixture();
  try {
    await f.add({ subjectType: 'INDEX', subjectId: '000300', factKind: 'DAILY_BAR', availableAt: '2026-01-05T07:00:00.000Z', typedValue: barValue('000300', '2026-01-05') });
    const built = await buildEvidencePack(f.pool, { taskId: 'synthetic-missing', subject: '600101', cutoff: '2026-01-06T02:00:00.000Z', focus: 'FULL', outputDir: f.dir });
    assert.equal(built.pack.benchmark?.status, 'MISSING');
    assert.equal(built.pack.benchmark?.attributionFact, null);
    assert.equal(built.pack.coverage.industry.swL1, null);
    assert.equal(built.pack.comparisonBenchmark?.kind, 'MARKET_PROXY');
    assert.equal(built.pack.comparisonBenchmark?.indexCode, '000300');
    assert.match(built.pack.tables.find((t) => t.tableId === 'index-bars')!.title, /沪深300市场代理，非行业基准/);
    assert.match(built.pack.coverage.gaps.join('\n'), /INDUSTRY_BENCHMARK_MISSING/);
    assert.doesNotMatch(canonicalJsonString(built.pack), /当前池错误名称|801999/);
  } finally { await f.cleanup(); }
});

test('I-04 SR：归属、名称都取截点；后续回填和池修改不改变旧包身份/报告表格', async () => {
  const f = await pitFixture();
  try {
    const fact = await f.add({ subjectType: 'STOCK', subjectId: '600101', factKind: 'INDUSTRY_CLASS_VERSION', availableAt: '2021-07-30T16:00:00.000Z', validFrom: '2021-07-29T16:00:00.000Z',
      typedValue: { 体系: '2021', 行业代码: '480101', l1IndexCode: '801780', 计入日期ISO: '2021-07-30' } });
    await f.add({ subjectType: 'INDEX', subjectId: 'SW-L1-LIST', factKind: 'SW_INDEX_LIST', availableAt: '2025-01-01T00:00:00.000Z',
      typedValue: { rows: [{ 行业代码: '801780.SI', 行业名称: '历史银行名称' }] } });
    await f.add({ subjectType: 'INDEX', subjectId: 'SW-L1-LIST', factKind: 'SW_INDEX_LIST', availableAt: '2026-01-06T07:00:00.000Z',
      typedValue: { rows: [{ 行业代码: '801780.SI', 行业名称: '下午才可见名称' }] } });
    await f.add({ subjectType: 'INDEX', subjectId: '801780', factKind: 'SW_INDEX_BAR', availableAt: '2026-01-05T07:00:00.000Z', typedValue: { 日期: '2026-01-05', 开盘: 1000, 收盘: 1000 } });
    const opts = { taskId: 'synthetic-old', subject: '600101', cutoff: '2026-01-06T02:00:00.000Z', focus: 'FULL' as const, outputDir: f.dir };
    const before = await buildEvidencePack(f.pool, opts);
    assert.equal(before.pack.coverage.industry.swL1, '历史银行名称');
    assert.equal(before.pack.benchmark?.attributionFact?.factId, fact.factId);
    assert.equal(before.pack.comparisonBenchmark?.kind, 'INDUSTRY');
    assert.match(before.pack.coverage.financials.note ?? '', /金融口径/);
    assert.doesNotMatch(canonicalJsonString(before.pack), /下午才可见名称|当前池错误名称/);
    const originalBytes = await readFile(before.packPath, 'utf8');
    f.poolData.stocks[0]!.swL1Name = '后来的池名称'; await writeFile(f.poolFile, JSON.stringify(f.poolData));
    await f.add({ ...fact, factId: 'later-backfill', validFrom: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z',
      typedValue: { 体系: '2021', 行业代码: '220101', l1IndexCode: '801030' } });
    const after = await buildEvidencePack(f.pool, { ...opts, taskId: 'synthetic-new' });
    assert.equal(after.pack.benchmark?.indexCode, '801030');
    assert.equal(before.pack.benchmark?.indexCode, '801780');
    assert.equal(await readFile(before.packPath, 'utf8'), originalBytes);
    assert.equal(JSON.parse(originalBytes).benchmark.bindingHash, before.pack.benchmark?.bindingHash);
  } finally { await f.cleanup(); }
});
