/**
 * Lyra · 限售解禁回填 runner 单测（P2 W42: code-writer，C4）。不碰网络、不碰 DB：
 * 段计划为纯池股序列（单股全历史形态，无日期分块），runner 用 tmpdir 断点文件 + 假 fetch。
 * 合同判定：派发冻结（节流 ≥2s、断点续跑、预算段边界停止、rank 升序、26 股范围、
 * ETF 不在范围、空源段如实登记）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  EmUnlockBackfillError,
  emptyEmUnlockProgress,
  loadEmUnlockProgress,
  planEmUnlockSegments,
  runEmUnlockBackfill,
  saveEmUnlockProgress,
  type EmUnlockFetchResult,
  type EmUnlockSegment,
} from './emunlock.js';

// ===== 段计划 =====

test('planEmUnlockSegments：池 rank 升序保序 + segKey 形态 + 坏码/空池具名拒绝', () => {
  const codes = ['603986', '002384', '600176'];
  const segs = planEmUnlockSegments(codes);
  assert.equal(segs.length, 3);
  assert.equal(segs[0]!.kind, 'queue');
  assert.equal(segs[0]!.code, '603986', '池序即研究优先序（rank 升序保序）');
  assert.equal(segs[0]!.segKey, 'queue:603986');
  assert.equal(segs[2]!.segKey, 'queue:600176');
  assert.throws(() => planEmUnlockSegments(['sh603986']), (e: unknown) => e instanceof EmUnlockBackfillError && e.code === 'EMUNLOCK_CODE_INVALID');
  assert.throws(() => planEmUnlockSegments([]), (e: unknown) => e instanceof EmUnlockBackfillError && e.code === 'EMUNLOCK_POOL_EMPTY');
});

// ===== runner（tmpdir 断点 + 假 fetch + 注入时钟/睡眠）=====

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w42-emunlock-run-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const okResult = (rows: number, inserted: number): EmUnlockFetchResult => ({
  rowCount: rows,
  insertedFactIds: Array.from({ length: inserted }, (_, i) => `f${String(i)}`),
  identicalFactIds: [],
  rejectedRows: [],
});

test('runEmUnlockBackfill：节流间隔、空源段登记、断点续跑跳过、进度原子文件', async () => {
  const progressPath = join(stateDir, 'emunlock-progress.json');
  const sleeps: number[] = [];
  const segments: EmUnlockSegment[] = planEmUnlockSegments(['603986', '600036']);
  let clock = 0;
  const r1 = await runEmUnlockBackfill({
    segments,
    progressPath,
    throttleMs: 2_000,
    fetch: async (seg) => {
      clock += 10; // 每次调用自身耗时 10ms（< 节流间隔 → 每跳须补等待 1990ms）
      return seg.code === '600036' ? okResult(0, 0) : okResult(23, 23); // 600036 探测实测空源
    },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(r1.completed, 2);
  assert.equal(r1.skippedDone, 0);
  assert.equal(r1.realCalls, 2);
  assert.deepEqual(r1.emptySegments, ['queue:600036'], '空源段如实登记非失败');
  assert.deepEqual(sleeps, [1_990], '段间节流补足 ≥2s 派发冻结（2 段 → 1 个间隔）');
  const saved = await loadEmUnlockProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 2);
  assert.equal(saved.completed['queue:600036']!.rowCount, 0);
  assert.equal(saved.completed['queue:600036']!.emptySource, true, '空源状态显式落断点');
  assert.equal(saved.completed['queue:603986']!.inserted, 23);

  // 续跑：断点全部命中 → 零调用
  const r2 = await runEmUnlockBackfill({
    segments,
    progressPath,
    fetch: async () => { throw new Error('不应发生真实调用'); },
  });
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 2);
  assert.equal(r2.realCalls, 0);

  // 半截进度损坏回退：写坏 JSON 后按空进度重来（loadEmUnlockProgress 容错）
  await saveEmUnlockProgress(progressPath, emptyEmUnlockProgress());
  assert.equal(Object.keys((await loadEmUnlockProgress(progressPath)).completed).length, 0);
});

test('runEmUnlockBackfill：预算到点在段边界干净停止（partial 非失败）', async () => {
  const progressPath = join(stateDir, 'budget-progress.json');
  let clock = 0;
  const segments = planEmUnlockSegments(['603986', '002384', '600176']); // 3 段 rank 升序
  const r = await runEmUnlockBackfill({
    segments,
    progressPath,
    throttleMs: 2_000,
    budgetMs: 2_005, // 首段 10ms 后，10+节流 2000ms=2010 > 2005 → 第 2 段前停
    fetch: async (seg) => {
      clock += 10;
      return okResult(seg.code.length, 1);
    },
    now: () => clock,
    sleep: async () => { clock += 2_000; },
    log: () => {},
  });
  assert.equal(r.budgetStopped, true);
  assert.equal(r.completed, 1, '只完成首段（rank 最前）');
  assert.equal(r.realCalls, 1);
  const saved = await loadEmUnlockProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 1, '已完成段保留断点');
  assert.ok(saved.completed['queue:603986'] !== undefined, '完成的是升序首段');
});
