import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importValidatedValuationBatch, type ValuationPlanStep } from './valuation.js';
import type { ValuationFetchResult, ValuationRow } from '../adapters/valuation.js';

const now = new Date('2026-11-03T00:00:00Z').getTime();
const daily: ValuationPlanStep = { command: 'csindex_daily', params: ['000300'], subject: '000300', lgKey: '', label: 'synthetic daily' };
const monthly: ValuationPlanStep = { command: 'lg_pb', params: ['hs300'], subject: '000300', lgKey: 'hs300', label: 'synthetic monthly' };
const dailyRows = (count = 20): ValuationRow[] => Array.from({ length: count }, (_, i) => ({
  日期ISO: new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10), '市盈率1（总股本）P/E1': 10,
}));
const monthlyRows = (): ValuationRow[] => Array.from({ length: 262 }, (_, i) => ({
  日期: i === 261 ? '2026-10-30' : `${2005 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-28`,
  指数: 10, 市净率: 1, 等权市净率: 1, 市净率中位数: 1,
}));
const result = (step: ValuationPlanStep, rows: ValuationRow[]): ValuationFetchResult => ({
  adapterVersion: 'valuation@p1', command: step.command, params: step.params, scope: `${step.command}:${step.subject}`,
  artifact: { sha256: 'a'.repeat(64), bytes: 1, mediaType: 'application/json', firstObservedAt: new Date(now).toISOString() },
  rowCount: rows.length, insertedFactIds: ['synthetic-write'], identicalFactIds: [], rejectedRows: [], notices: [],
});

test('M-04：100行6行非法，整批零写入且错误报告包含拒绝行和非零退出码', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-valuation-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = monthlyRows().slice(0, 100);
  rows[99] = { ...rows[99], 日期: '2026-10-30' };
  for (let i = 0; i < 6; i++) rows[i]!['市净率'] = 'invalid';
  let writes = 0;
  const reportPath = join(dir, 'rejected.json');
  const run = await importValidatedValuationBatch({ plan: [monthly], responses: new Map([['lg_pb:000300', rows]]),
    fetchedAtMs: now, reportPath, ingest: async (step, data) => { writes++; return result(step, data); } });
  assert.equal(writes, 0);
  assert.equal(run.exitCode, 2);
  assert.deepEqual(run.ingest, []);
  assert.ok(run.failures.some((f) => f.check === 'lg_pb:000300:rejects' && f.detail.includes('6/100')));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.exitCode, 2);
  assert.equal(report.rejectedRows[0].rows.length, 6);
  assert.match(report.conclusion, /未写入/);
});

test('M-04：后续步骤6%超限，前置有效步骤也不能先写入', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-valuation-late-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = monthlyRows();
  for (let i = 0; i < 16; i++) bad[i]!['市净率'] = 'invalid';
  let writes = 0;
  const run = await importValidatedValuationBatch({ plan: [daily, monthly],
    responses: new Map([['csindex_daily:000300', dailyRows()], ['lg_pb:000300', bad]]), fetchedAtMs: now,
    reportPath: join(dir, 'rejected.json'), ingest: async (step, rows) => { writes++; return result(step, rows); } });
  assert.equal(writes, 0);
  assert.equal(run.exitCode, 2);
  assert.deepEqual(run.failures.map((f) => f.check), ['lg_pb:000300:rejects']);
});

test('M-04：5%边界允许，15行坏1行拒绝；日期/结构异常写失败报告', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-valuation-threshold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases: [number, ValuationRow[], number][] = [
    [0, dailyRows(20), 0], [1, dailyRows(15), 2],
    [2, [{ 日期ISO: 'invalid' }], 2], [3, [null] as unknown as ValuationRow[], 2],
  ];
  for (const [index, rows, expected] of cases) {
    if (index < 2) rows[0] = { ...rows[0], '市盈率1（总股本）P/E1': null };
    let writes = 0;
    const reportPath = join(dir, `${index}.json`);
    const run = await importValidatedValuationBatch({ plan: [daily], responses: new Map([['csindex_daily:000300', rows]]),
      fetchedAtMs: now, reportPath, ingest: async (step, data) => { writes++; return result(step, data); } });
    assert.equal(run.exitCode, expected);
    assert.equal(writes, expected === 0 ? 1 : 0);
    if (expected !== 0) assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).exitCode, 2);
  }
});

test('M-04：写入使用已预检的整批快照，外部缓存或计划改动不能替换后续数据', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-valuation-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = structuredClone([daily, monthly]);
  const source = monthlyRows();
  const responses = new Map([['csindex_daily:000300', dailyRows()], ['lg_pb:000300', source]]);
  let writes = 0;
  const run = await importValidatedValuationBatch({ plan, responses, fetchedAtMs: now, reportPath: join(dir, 'unused.json'),
    ingest: async (step, rows) => {
      if (writes++ === 0) {
        source[0]!['市净率'] = 'changed after validation';
        responses.set('lg_pb:000300', []);
        plan[1]!.subject = '999999';
      } else {
        assert.equal(step.subject, '000300');
        assert.equal(rows.length, 262);
        assert.equal(rows[0]!['市净率'], 1);
      }
      return result(step, rows);
    } });
  assert.equal(run.exitCode, 0);
  assert.equal(writes, 2);
});

test('M-04：隔离子进程把批次失败结果转为退出码2，并留下错误报告', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-valuation-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'synthetic-runner.mjs');
  const reportPath = join(dir, 'rejected.json');
  // 执行与正常 runner 相同的质量门及 exitCode 赋值，不启动真实取数/默认数据库入口。
  await writeFile(script, `import { importValidatedValuationBatch } from ${JSON.stringify(new URL('./valuation.ts', import.meta.url).href)};
const result = await importValidatedValuationBatch({plan: [${JSON.stringify(daily)}], responses: new Map(),
fetchedAtMs: ${now}, reportPath: ${JSON.stringify(reportPath)}, ingest: async () => { throw new Error('unexpected write'); }});
process.exitCode = result.exitCode;
`, 'utf8');
  const child = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).exitCode, 2);
});
