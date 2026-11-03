/**
 * Lyra · 东财风险面回填 runner 单测（P1 W29: code-writer）。不碰网络、不碰 DB：
 * fetch 用假函数注入，节流用记录式 sleep 注入。合同判定：派发（26 股 × 2 资源段计划、
 * 断点续跑、节流 ≥2s 冻结、空集如实完成态）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  EMRISK_THROTTLE_FLOOR_MS,
  emptyEmriskProgress,
  loadEmriskProgress,
  planEmriskSegments,
  runEmriskBackfill,
  saveEmriskProgress,
  type EmriskFetchFn,
  type EmriskSegment,
} from './emrisk.js';
import { PoolBackfillError } from './pool-market.js';
import { emriskCompletion } from '../adapters/emrisk-test-helper.js';

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w29-emrisk-runner-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

// ===== 段计划 =====

test('planEmriskSegments：26 股 × 2 资源、每股先质押后户数、顺序确定', () => {
  const stocks = ['603986', '002384', '600519'];
  const segments = planEmriskSegments(stocks);
  assert.equal(segments.length, 6);
  assert.deepEqual(
    segments.map((s) => s.segKey),
    [
      'emrisk:pledge_ratio:603986',
      'emrisk:holder_count:603986',
      'emrisk:pledge_ratio:002384',
      'emrisk:holder_count:002384',
      'emrisk:pledge_ratio:600519',
      'emrisk:holder_count:600519',
    ],
  );
  // 冻结池真实规模：26 股 → 52 段
  const codes26 = ['603986', '002384', '600176', '600183', '000938', '603259', '601899', '600522',
    '002281', '000977', '600105', '000988', '600519', '000657', '002407', '002008', '601318',
    '603993', '600276', '600150', '002851', '603019', '600036', '600900', '603256', '600030'];
  assert.equal(planEmriskSegments(codes26).length, 52);
});

test('planEmriskSegments：非法代码与重复代码具名拒绝；ETF 排除由上游池解析保证', () => {
  assert.throws(() => planEmriskSegments(['6005190']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'EMRISK_CODE_INVALID');
  assert.throws(() => planEmriskSegments(['600519', '600519']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'EMRISK_CODE_DUPLICATE');
  // 段计划只做 6 位形状校验；主板（R17 60/00 前缀）与 ETF 排除在 parseResearchPool 边界完成
  // （runner 只消费 researchPool.stocks，ETF 不会进入段计划——见 pool-market.test.ts 的池校验测试）。
});

// ===== 断点进度 =====

test('进度：缺失文件回空、save/load 往返、原子写无 tmp 残留', async () => {
  const path = join(stateDir, 'prog-roundtrip.json');
  const loaded = await loadEmriskProgress(path);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.adapterVersion, emptyEmriskProgress().adapterVersion);
  assert.deepEqual(loaded.completed, {});

  const progress = emptyEmriskProgress();
  progress.completed['emrisk:pledge_ratio:600519'] = {
    code: '600519', resource: 'pledge_ratio', rowCount: 608,
    inserted: 608, identical: 0, rejected: 0, emptySource: false,
    completedAt: '2026-10-25T04:00:00.000Z',
  };
  await saveEmriskProgress(path, progress);
  const again = await loadEmriskProgress(path);
  assert.equal(again.completed['emrisk:pledge_ratio:600519']?.rowCount, 608);
  assert.equal(again.adapterVersion, emptyEmriskProgress().adapterVersion);

  const files = await readFile(path, 'utf8');
  assert.ok(files.includes('"version": 1'));
  await assert.rejects(readFile(`${path}.tmp`, 'utf8')); // tmp 已 rename，无残留
});

test('进度：坏形状文件回空（不崩）', async () => {
  const path = join(stateDir, 'prog-bad.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, '{"version": 99}', 'utf8');
  const before = Date.now();
  const loaded = await loadEmriskProgress(path);
  assert.deepEqual({ ...loaded, updatedAt: '' }, { ...emptyEmriskProgress(), updatedAt: '' });
  assert.ok(Date.parse(loaded.updatedAt) >= before && Date.parse(loaded.updatedAt) <= Date.now());
});

// ===== runner =====

function fakeFetch(
  result: Partial<Record<string, unknown>>,
): EmriskFetchFn & { calls: EmriskSegment[] } {
  const calls: EmriskSegment[] = [];
  const fn: EmriskFetchFn = async (segment: EmriskSegment) => {
    calls.push(segment);
    return {
      rowCount: (result.rowCount as number) ?? 10,
      insertedFactIds: Array.from({ length: (result.inserted as number) ?? 10 }, (_, i) => `f${String(i)}`),
      identicalFactIds: [],
      rejectedRows: (result.rejectedRows as unknown[]) ?? [],
      completion: emriskCompletion(segment.resource, segment.code, (result.rowCount as number) ?? 10),
    };
  };
  return Object.assign(fn, { calls });
}

test('runEmriskBackfill：全量段完成、节流生效（≥2s 冻结下限，注入 sleep 记录等待）', async () => {
  const path = join(stateDir, 'prog-run1.json');
  const segments = planEmriskSegments(['600519', '601318']); // 4 段
  const fetch = fakeFetch({ rowCount: 5, inserted: 5 });
  const waits: number[] = [];
  const result = await runEmriskBackfill({
    segments,
    progressPath: path,
    fetch,
    throttleMs: EMRISK_THROTTLE_FLOOR_MS,
    sleep: async (ms) => { waits.push(ms); },
    log: () => {},
  });
  assert.equal(result.completed, 4);
  assert.equal(result.skippedDone, 0);
  assert.equal(result.realCalls, 4);
  assert.equal(result.emptySource, 0);
  assert.equal(fetch.calls.length, 4);
  assert.equal(waits.length, 3, '相邻调用间的等待次数 = 段数 − 1');
  for (const w of waits) assert.ok(w >= 0 && w <= EMRISK_THROTTLE_FLOOR_MS);

  const progress = await loadEmriskProgress(path);
  assert.equal(Object.keys(progress.completed).length, 4);
  assert.equal(progress.completed['emrisk:holder_count:601318']?.resource, 'holder_count');
});

test('runEmriskBackfill：断点续跑跳过已完成段；空集如实完成态；节流下限具名拒绝', async () => {
  const path = join(stateDir, 'prog-run2.json');
  const segments = planEmriskSegments(['600519', '601318']);
  const progress = emptyEmriskProgress();
  progress.completed['emrisk:pledge_ratio:600519'] = {
    code: '600519', resource: 'pledge_ratio', rowCount: 608,
    inserted: 608, identical: 0, rejected: 0, emptySource: false,
    completedAt: '2026-10-25T04:00:00.000Z',
    completion: emriskCompletion('pledge_ratio', '600519', 608),
  };
  await saveEmriskProgress(path, progress);

  const fetch = fakeFetch({ rowCount: 0, inserted: 0 }); // 空集段
  const result = await runEmriskBackfill({
    segments, progressPath: path, fetch, throttleMs: 2000,
    sleep: async () => {}, log: () => {},
  });
  assert.equal(result.completed, 3);
  assert.equal(result.skippedDone, 1);
  assert.equal(result.realCalls, 3);
  assert.equal(result.emptySource, 3);
  assert.deepEqual(result.emptySample[0], 'emrisk:holder_count:600519');
  assert.ok(!fetch.calls.some((s) => s.segKey === 'emrisk:pledge_ratio:600519'), '已完成段不再调用');

  // 节流下限（派发冻结 ≥2s）：低于 2000ms 具名拒绝
  await assert.rejects(runEmriskBackfill({
    segments, progressPath: path, fetch, throttleMs: 1999,
    sleep: async () => {}, log: () => {},
  }), (e: unknown) => e instanceof PoolBackfillError && e.code === 'EMRISK_THROTTLE_INVALID');
});

test('runEmriskBackfill：拒绝行计数如实累计', async () => {
  const path = join(stateDir, 'prog-run3.json');
  const segments = planEmriskSegments(['600519']);
  const calls: EmriskSegment[] = [];
  const fetch: EmriskFetchFn = async (segment) => {
    calls.push(segment);
    return {
      rowCount: 3,
      insertedFactIds: ['f1'],
      identicalFactIds: ['f2'],
      rejectedRows: [{ rowIndex: 1, code: 'X' }, { rowIndex: 2, code: 'Y' }],
      completion: emriskCompletion(segment.resource, segment.code, 3),
    };
  };
  const result = await runEmriskBackfill({
    segments, progressPath: path, fetch, throttleMs: 2000,
    sleep: async () => {}, log: () => {},
  });
  assert.equal(result.rejectedRowsTotal, 4); // 2 段（质押+户数）× 各 2 拒绝行
  const progress = await loadEmriskProgress(path);
  const stat = progress.completed['emrisk:pledge_ratio:600519'];
  assert.equal(stat?.rejected, 2);
  assert.equal(stat?.identical, 1);
});
