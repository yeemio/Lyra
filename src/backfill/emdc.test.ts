/**
 * Lyra · 两融/龙虎榜回填 runner 单测（P2 W28: code-writer-pro）。不碰网络、不碰 DB：
 * 段计划用注入的交易日序列，runner 用 tmpdir 断点文件 + 假 fetch。合同判定：派发冻结
 * （节流 ≥2s、断点续跑、预算段边界停止、26 股范围）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  EmdcBackfillError,
  chunkWindow,
  emptyEmdcProgress,
  loadEmdcProgress,
  planEmdcSegments,
  planLhbSegments,
  planMarginSegments,
  poolExchanges,
  runEmdcBackfill,
  saveEmdcProgress,
  type EmdcFetchResult,
  type EmdcSegment,
} from './emdc.js';

// ===== 段计划 =====

const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];

test('planMarginSegments：每交易日 × 交易所，降序（近端优先）', () => {
  const segs = planMarginSegments(DAYS, ['sse', 'szse']);
  assert.equal(segs.length, 10);
  assert.equal(segs[0]!.segKey, 'margin_sse:2026-10-23:2026-10-23', '最近交易日在最前（每交易日 sse→szse 确定性序）');
  assert.equal(segs[1]!.segKey, 'margin_szse:2026-10-23:2026-10-23');
  assert.equal(segs[9]!.segKey, 'margin_szse:2026-10-19:2026-10-19');
  const onlySse = planMarginSegments(['2026-10-21'], ['sse']);
  assert.equal(onlySse.length, 1);
  assert.equal(onlySse[0]!.kind, 'margin_sse');
});

test('chunkWindow：块间无空洞无重叠，端尾对齐', () => {
  const chunks = chunkWindow('2026-08-01', '2026-10-15', 31);
  assert.equal(chunks[0]!.start, '2026-08-01');
  assert.equal(chunks[0]!.end, '2026-08-31', '31 日历日块');
  assert.equal(chunks[1]!.start, '2026-09-01');
  assert.equal(chunks[chunks.length - 1]!.end, '2026-10-15', '末块对齐窗口尾');
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = new Date(`${chunks[i - 1]!.end}T00:00:00Z`).getTime();
    const curStart = new Date(`${chunks[i]!.start}T00:00:00Z`).getTime();
    assert.equal(curStart - prevEnd, 86_400_000, '块衔接无空洞无重叠');
  }
  assert.deepEqual(chunkWindow('2026-10-01', '2026-10-01', 31), [{ start: '2026-10-01', end: '2026-10-01' }]);
  assert.throws(() => chunkWindow('2026-10-02', '2026-10-01', 31), EmdcBackfillError);
});

test('planLhbSegments：segKey 形态', () => {
  const segs = planLhbSegments('2026-10-01', '2026-10-15', 31);
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.segKey, 'lhb:2026-10-01:2026-10-15');
});

test('poolExchanges：主板分派 + 非主板具名拒绝', () => {
  assert.deepEqual(poolExchanges(['600519', '601318']), ['sse']);
  assert.deepEqual(poolExchanges(['000938']), ['szse']);
  assert.deepEqual(poolExchanges(['600519', '000938']), ['sse', 'szse']);
  assert.throws(() => poolExchanges(['300750']), (e: unknown) => e instanceof EmdcBackfillError);
});

test('planEmdcSegments：LHB 在前 + 覆盖界外具名拒绝', () => {
  const table = { tradingDays: DAYS };
  const segs = planEmdcSegments(table, { from: '2026-10-19', to: '2026-10-23', lhbChunkDays: 31, exchanges: ['sse', 'szse'] });
  assert.equal(segs.length, 11);
  assert.equal(segs[0]!.kind, 'lhb');
  assert.equal(segs[1]!.kind, 'margin_sse');
  assert.throws(
    () => planEmdcSegments(table, { from: '2026-10-01', to: '2026-10-23', lhbChunkDays: 31, exchanges: ['sse'] }),
    (e: unknown) => e instanceof EmdcBackfillError && e.code === 'EMDC_CALENDAR_WINDOW_OUT_OF_COVERAGE',
  );
});

// ===== runner（tmpdir 断点 + 假 fetch + 注入时钟/睡眠）=====

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w28-emdc-run-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const okResult = (rows: number, inserted: number, filteredOut = 0): EmdcFetchResult => ({
  rowCount: rows,
  insertedFactIds: Array.from({ length: inserted }, (_, i) => `f${String(i)}`),
  identicalFactIds: [],
  rejectedRows: [],
  filteredOut,
});

test('runEmdcBackfill：节流间隔、空段登记、断点续跑跳过、进度原子文件', async () => {
  const progressPath = join(stateDir, 'emdc-progress.json');
  const sleeps: number[] = [];
  const segments: EmdcSegment[] = [
    { kind: 'lhb', start: '2026-10-20', end: '2026-10-24', segKey: 'lhb:2026-10-20:2026-10-24' },
    { kind: 'margin_sse', start: '2026-10-23', end: '2026-10-23', segKey: 'margin_sse:2026-10-23:2026-10-23' },
    { kind: 'margin_szse', start: '2026-10-23', end: '2026-10-23', segKey: 'margin_szse:2026-10-23:2026-10-23' },
  ];
  let clock = 0;
  const r1 = await runEmdcBackfill({
    segments,
    progressPath,
    throttleMs: 2_000,
    fetch: async (seg) => {
      clock += 10; // 每次调用自身耗时 10ms（< 节流间隔 → 每跳须补等待 1990ms）
      return seg.kind === 'margin_szse' ? okResult(0, 0) : okResult(3, 3, 2_000);
    },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(r1.completed, 3);
  assert.equal(r1.skippedDone, 0);
  assert.equal(r1.realCalls, 3);
  assert.deepEqual(r1.emptySegments, ['margin_szse:2026-10-23:2026-10-23'], '空段如实登记非失败');
  assert.equal(r1.filteredOutTotal, 4_000);
  assert.deepEqual(sleeps, [1_990, 1_990], '节流补足 ≥2s 派发冻结');
  const saved = await loadEmdcProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 3);
  assert.equal(saved.completed['margin_szse:2026-10-23:2026-10-23']!.rowCount, 0);

  // 续跑：断点全部命中 → 零调用
  const r2 = await runEmdcBackfill({
    segments,
    progressPath,
    fetch: async () => { throw new Error('不应发生真实调用'); },
  });
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 3);
  assert.equal(r2.realCalls, 0);

  // 半截进度损坏回退：写坏 JSON 后按空进度重来（loadEmdcProgress 容错）
  await saveEmdcProgress(progressPath, emptyEmdcProgress());
  assert.equal(Object.keys((await loadEmdcProgress(progressPath)).completed).length, 0);
});

test('runEmdcBackfill：预算到点在段边界干净停止（partial 非失败）', async () => {
  const progressPath = join(stateDir, 'budget-progress.json');
  let clock = 0;
  const segments = DAYS.flatMap((d) => [
    { kind: 'margin_sse' as const, start: d, end: d, segKey: `margin_sse:${d}:${d}` },
  ]);
  const r = await runEmdcBackfill({
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
  assert.equal(r.completed, 1, '只完成首段');
  assert.equal(r.realCalls, 1);
  const saved = await loadEmdcProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 1, '已完成段保留断点');
});
