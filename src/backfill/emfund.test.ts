/**
 * Lyra · ETF 份额回填 runner 单测（P1 W30: code-writer）。不碰网络、不碰 DB：
 * fetch 用假函数注入，节流用记录式 sleep 注入。合同判定：派发 A7（4 ETF 段计划、
 * 断点续跑、节流 ≥2s、空集如实完成态）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  EMFUND_THROTTLE_FLOOR_MS,
  emptyEmfundProgress,
  loadEmfundProgress,
  planEmfundSegments,
  runEmfundBackfill,
  saveEmfundProgress,
  type EmfundFetchFn,
  type EmfundSegment,
} from './emfund.js';
import { PoolBackfillError } from './pool-market.js';

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w30-emfund-runner-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

// ===== 段计划 =====

test('planEmfundSegments：池 ETF 段计划、顺序确定、segKey 形态', () => {
  const segments = planEmfundSegments(['510050', '510300', '510500', '512100']);
  assert.equal(segments.length, 4);
  assert.deepEqual(
    segments.map((s) => s.segKey),
    [
      'emfund:etf_share:510050',
      'emfund:etf_share:510300',
      'emfund:etf_share:510500',
      'emfund:etf_share:512100',
    ],
  );
});

test('planEmfundSegments：非法代码与重复代码具名拒绝', () => {
  assert.throws(() => planEmfundSegments(['51005']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'EMFUND_CODE_INVALID');
  assert.throws(() => planEmfundSegments(['510050', '510050']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'EMFUND_CODE_DUPLICATE');
});

// ===== 断点进度 =====

test('进度：缺失文件回空、save/load 往返、原子写无 tmp 残留、坏形状回空', async () => {
  const path = join(stateDir, 'prog-roundtrip.json');
  const loaded = await loadEmfundProgress(path);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.adapterVersion, emptyEmfundProgress().adapterVersion);
  assert.deepEqual(loaded.completed, {});

  const progress = emptyEmfundProgress();
  progress.completed['emfund:etf_share:510050'] = {
    code: '510050', rowCount: 85, inserted: 85, identical: 0, rejected: 0,
    emptySource: false, completedAt: '2026-10-26T04:00:00.000Z',
  };
  await saveEmfundProgress(path, progress);
  const again = await loadEmfundProgress(path);
  assert.equal(again.completed['emfund:etf_share:510050']?.rowCount, 85);

  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('"version": 1'));
  await assert.rejects(readFile(`${path}.tmp`, 'utf8')); // tmp 已 rename，无残留

  const bad = join(stateDir, 'prog-bad.json');
  await writeFile(bad, '{"version": 99}', 'utf8');
  assert.deepEqual(await loadEmfundProgress(bad), emptyEmfundProgress());
});

// ===== runner =====

function fakeFetch(result: { rowCount: number; inserted: number; rejected?: unknown[] }): EmfundFetchFn {
  return async () => ({
    rowCount: result.rowCount,
    insertedFactIds: Array.from({ length: result.inserted }, (_, i) => `f${String(i)}`),
    identicalFactIds: [],
    rejectedRows: result.rejected ?? [],
  });
}

test('runEmfundBackfill：全量段完成、节流生效（≥2s 下限，注入 sleep 记录等待）', async () => {
  const path = join(stateDir, 'prog-run1.json');
  const segments = planEmfundSegments(['510050', '510300']);
  const calls: EmfundSegment[] = [];
  const fetch: EmfundFetchFn = async (segment) => {
    calls.push(segment);
    return { rowCount: 85, insertedFactIds: Array.from({ length: 85 }, (_, i) => `f${String(i)}`), identicalFactIds: [], rejectedRows: [] };
  };
  const waits: number[] = [];
  const result = await runEmfundBackfill({
    segments,
    progressPath: path,
    fetch,
    throttleMs: EMFUND_THROTTLE_FLOOR_MS,
    sleep: async (ms) => { waits.push(ms); },
    log: () => {},
  });
  assert.equal(result.completed, 2);
  assert.equal(result.skippedDone, 0);
  assert.equal(result.realCalls, 2);
  assert.equal(result.emptySource, 0);
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1, '相邻调用间的等待次数 = 段数 − 1');

  const progress = await loadEmfundProgress(path);
  assert.equal(Object.keys(progress.completed).length, 2);
});

test('runEmfundBackfill：断点续跑跳过已完成段；空集如实完成态；节流下限具名拒绝；拒绝行累计', async () => {
  const path = join(stateDir, 'prog-run2.json');
  const segments = planEmfundSegments(['510050', '510300']);
  const progress = emptyEmfundProgress();
  progress.completed['emfund:etf_share:510050'] = {
    code: '510050', rowCount: 85, inserted: 85, identical: 0, rejected: 0,
    emptySource: false, completedAt: '2026-10-26T04:00:00.000Z',
  };
  await saveEmfundProgress(path, progress);

  const calls: EmfundSegment[] = [];
  const fetch: EmfundFetchFn = async (segment) => {
    calls.push(segment);
    return { rowCount: 0, insertedFactIds: [], identicalFactIds: [], rejectedRows: [{ rowIndex: 0, code: 'X' }] };
  };
  const result = await runEmfundBackfill({
    segments, progressPath: path, fetch, throttleMs: 2000,
    sleep: async () => {}, log: () => {},
  });
  assert.equal(result.completed, 1);
  assert.equal(result.skippedDone, 1);
  assert.equal(result.realCalls, 1);
  assert.equal(result.emptySource, 1);
  assert.equal(result.rejectedRowsTotal, 1);
  assert.ok(!calls.some((s) => s.segKey === 'emfund:etf_share:510050'), '已完成段不再调用');

  await assert.rejects(runEmfundBackfill({
    segments, progressPath: path, fetch, throttleMs: 1999,
    sleep: async () => {}, log: () => {},
  }), (e: unknown) => e instanceof PoolBackfillError && e.code === 'EMFUND_THROTTLE_INVALID');
});
