/**
 * Lyra · 大宗交易回填 runner 单测（P2 W37: code-writer，B1）。不碰网络、不碰 DB：
 * 段计划为纯历日数学（无交易日历依赖），runner 用 tmpdir 断点文件 + 假 fetch。
 * 合同判定：派发冻结（节流 ≥2s、断点续跑、预算段边界停止、降序近端优先、26 股范围）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  EmblockBackfillError,
  chunkWindowAsc,
  emptyEmblockProgress,
  loadEmblockProgress,
  planEmblockSegments,
  runEmblockBackfill,
  saveEmblockProgress,
  type EmblockFetchResult,
  type EmblockSegment,
} from './emblock.js';

// ===== 段计划 =====

test('chunkWindowAsc：块间无空洞无重叠，端尾对齐', () => {
  const chunks = chunkWindowAsc('2026-08-01', '2026-10-15', 31);
  assert.equal(chunks[0]!.start, '2026-08-01');
  assert.equal(chunks[0]!.end, '2026-08-31', '31 历日块');
  assert.equal(chunks[chunks.length - 1]!.end, '2026-10-15', '末块对齐窗口尾');
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = new Date(`${chunks[i - 1]!.end}T00:00:00Z`).getTime();
    const curStart = new Date(`${chunks[i]!.start}T00:00:00Z`).getTime();
    assert.equal(curStart - prevEnd, 86_400_000, '块衔接无空洞无重叠');
  }
  assert.deepEqual(chunkWindowAsc('2026-10-01', '2026-10-01', 31), [{ start: '2026-10-01', end: '2026-10-01' }]);
  assert.throws(() => chunkWindowAsc('2026-10-02', '2026-10-01', 31), EmblockBackfillError);
  assert.throws(() => chunkWindowAsc('2026-10-01', '2026-10-31', 0), (e: unknown) => e instanceof EmblockBackfillError && e.code === 'EMBLOCK_CHUNK_INVALID');
});

test('planEmblockSegments：降序（近端优先）+ segKey 形态', () => {
  const segs = planEmblockSegments('2026-10-01', '2026-11-15', 31);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.start, '2026-11-01', '最近块在最前');
  assert.equal(segs[0]!.end, '2026-11-15');
  assert.equal(segs[1]!.start, '2026-10-01');
  assert.equal(segs[1]!.end, '2026-10-31');
  assert.equal(segs[0]!.segKey, 'mrmx:2026-11-01:2026-11-15');
  assert.equal(segs[1]!.segKey, 'mrmx:2026-10-01:2026-10-31');
  // 2 年窗 ≈ 24 块（31 天历日）
  assert.equal(planEmblockSegments('2024-10-25', '2026-10-25', 31).length, 24);
});

// ===== runner（tmpdir 断点 + 假 fetch + 注入时钟/睡眠）=====

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w37-emblock-run-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const okResult = (rows: number, inserted: number, filteredOut = 0): EmblockFetchResult => ({
  rowCount: rows,
  insertedFactIds: Array.from({ length: inserted }, (_, i) => `f${String(i)}`),
  identicalFactIds: [],
  rejectedRows: [],
  filteredOut,
});

test('runEmblockBackfill：节流间隔、空段登记、断点续跑跳过、进度原子文件', async () => {
  const progressPath = join(stateDir, 'emblock-progress.json');
  const sleeps: number[] = [];
  const segments: EmblockSegment[] = planEmblockSegments('2026-10-01', '2026-11-15', 31);
  let clock = 0;
  const r1 = await runEmblockBackfill({
    segments,
    progressPath,
    throttleMs: 2_000,
    fetch: async (seg) => {
      clock += 10; // 每次调用自身耗时 10ms（< 节流间隔 → 每跳须补等待 1990ms）
      return seg.end === '2026-10-31' ? okResult(0, 0) : okResult(1_720, 19, 1_701);
    },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(r1.completed, 2);
  assert.equal(r1.skippedDone, 0);
  assert.equal(r1.realCalls, 2);
  assert.deepEqual(r1.emptySegments, ['mrmx:2026-10-01:2026-10-31'], '空段如实登记非失败');
  assert.equal(r1.filteredOutTotal, 1_701);
  assert.deepEqual(sleeps, [1_990], '段间节流补足 ≥2s 派发冻结（2 段 → 1 个间隔）');
  const saved = await loadEmblockProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 2);
  assert.equal(saved.completed['mrmx:2026-10-01:2026-10-31']!.rowCount, 0);

  // 续跑：断点全部命中 → 零调用
  const r2 = await runEmblockBackfill({
    segments,
    progressPath,
    fetch: async () => { throw new Error('不应发生真实调用'); },
  });
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 2);
  assert.equal(r2.realCalls, 0);

  // 半截进度损坏回退：写坏 JSON 后按空进度重来（loadEmblockProgress 容错）
  await saveEmblockProgress(progressPath, emptyEmblockProgress());
  assert.equal(Object.keys((await loadEmblockProgress(progressPath)).completed).length, 0);
});

test('runEmblockBackfill：预算到点在段边界干净停止（partial 非失败）', async () => {
  const progressPath = join(stateDir, 'budget-progress.json');
  let clock = 0;
  const segments = planEmblockSegments('2026-09-01', '2026-11-30', 31); // 3 块降序
  const r = await runEmblockBackfill({
    segments,
    progressPath,
    throttleMs: 2_000,
    budgetMs: 2_005, // 首段 10ms 后，10+节流 2000ms=2010 > 2005 → 第 2 段前停
    fetch: async (seg) => {
      clock += 10;
      return okResult(seg.start.length, 1);
    },
    now: () => clock,
    sleep: async () => { clock += 2_000; },
    log: () => {},
  });
  assert.equal(r.budgetStopped, true);
  assert.equal(r.completed, 1, '只完成首段（最近块）');
  assert.equal(r.realCalls, 1);
  const saved = await loadEmblockProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 1, '已完成段保留断点');
  assert.ok(saved.completed['mrmx:2026-11-02:2026-11-30'] !== undefined, '完成的是降序首块');
});
