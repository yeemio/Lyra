/**
 * Lyra · 资产负债表（商誉面）回填 runner 单测（P1 W30: code-writer）。不碰网络、不碰 DB：
 * fetch 用假函数注入，节流用记录式 sleep 注入。合同判定：派发 A9 东财落点（26 股段计划、
 * 断点续跑、节流 ≥2s、空集如实完成态、无披露行具名拒绝计数）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  BALANCE_THROTTLE_FLOOR_MS,
  emptyBalanceProgress,
  loadBalanceProgress,
  planBalanceSegments,
  runBalanceBackfill,
  saveBalanceProgress,
  type BalanceFetchFn,
  type BalanceSegment,
} from './pool-balance.js';
import { PoolBackfillError } from './pool-market.js';

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w30-pool-bal-runner-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

// ===== 段计划 =====

test('planBalanceSegments：池个股段计划、顺序确定、segKey 形态；26 股 → 26 段', () => {
  const segments = planBalanceSegments(['600519', '000938', '600036']);
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => s.segKey),
    ['embalance:balance_sheet:600519', 'embalance:balance_sheet:000938', 'embalance:balance_sheet:600036'],
  );
  const codes26 = ['603986', '002384', '600176', '600183', '000938', '603259', '601899', '600522',
    '002281', '000977', '600105', '000988', '600519', '000657', '002407', '002008', '601318',
    '603993', '600276', '600150', '002851', '603019', '600036', '600900', '603256', '600030'];
  assert.equal(planBalanceSegments(codes26).length, 26);
});

test('planBalanceSegments：非法代码与重复代码具名拒绝', () => {
  assert.throws(() => planBalanceSegments(['6005190']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'BALANCE_CODE_INVALID');
  assert.throws(() => planBalanceSegments(['600519', '600519']), (e: unknown) =>
    e instanceof PoolBackfillError && e.code === 'BALANCE_CODE_DUPLICATE');
});

// ===== 断点进度 =====

test('进度：缺失文件回空、save/load 往返、原子写无 tmp 残留、坏形状回空', async () => {
  const path = join(stateDir, 'prog-roundtrip.json');
  const loaded = await loadBalanceProgress(path);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.adapterVersion, emptyBalanceProgress().adapterVersion);
  assert.deepEqual(loaded.completed, {});

  const progress = emptyBalanceProgress();
  progress.completed['embalance:balance_sheet:600519'] = {
    code: '600519', rowCount: 103, inserted: 103, identical: 0, rejected: 0,
    emptySource: false, completedAt: '2026-10-26T04:00:00.000Z',
  };
  await saveBalanceProgress(path, progress);
  const again = await loadBalanceProgress(path);
  assert.equal(again.completed['embalance:balance_sheet:600519']?.rowCount, 103);

  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('"version": 1'));
  await assert.rejects(readFile(`${path}.tmp`, 'utf8'));

  const bad = join(stateDir, 'prog-bad.json');
  await writeFile(bad, '{"version": 99}', 'utf8');
  assert.deepEqual(await loadBalanceProgress(bad), emptyBalanceProgress());
});

// ===== runner =====

test('runBalanceBackfill：全量段完成、节流生效、断点续跑、空集如实、拒绝行累计、下限具名拒绝', async () => {
  const path1 = join(stateDir, 'prog-run1.json');
  const segments = planBalanceSegments(['600519', '601318']);
  const calls: BalanceSegment[] = [];
  const fetch: BalanceFetchFn = async (segment) => {
    calls.push(segment);
    return {
      rowCount: 103,
      insertedFactIds: Array.from({ length: 103 }, (_, i) => `f${String(i)}`),
      identicalFactIds: [],
      rejectedRows: [{ rowIndex: 5, code: 'EMBALANCE_NOTICE_DATE_MISSING' }],
    };
  };
  const waits: number[] = [];
  const result = await runBalanceBackfill({
    segments,
    progressPath: path1,
    fetch,
    throttleMs: BALANCE_THROTTLE_FLOOR_MS,
    sleep: async (ms) => { waits.push(ms); },
    log: () => {},
  });
  assert.equal(result.completed, 2);
  assert.equal(result.skippedDone, 0);
  assert.equal(result.realCalls, 2);
  assert.equal(result.emptySource, 0);
  assert.equal(result.rejectedRowsTotal, 2);
  assert.equal(waits.length, 1);

  const progress = await loadBalanceProgress(path1);
  assert.equal(progress.completed['embalance:balance_sheet:600519']?.rejected, 1);

  // 断点续跑：独立种子进度（仅 600519 已完成）→ 只剩 601318，且该段空集如实完成态
  const path2 = join(stateDir, 'prog-run2.json');
  const seeded = emptyBalanceProgress();
  seeded.completed['embalance:balance_sheet:600519'] = {
    code: '600519', rowCount: 103, inserted: 103, identical: 0, rejected: 0,
    emptySource: false, completedAt: '2026-10-26T04:00:00.000Z',
  };
  await saveBalanceProgress(path2, seeded);
  const calls2: BalanceSegment[] = [];
  const fetch2: BalanceFetchFn = async (segment) => {
    calls2.push(segment);
    return { rowCount: 0, insertedFactIds: [], identicalFactIds: [], rejectedRows: [] };
  };
  const result2 = await runBalanceBackfill({
    segments, progressPath: path2, fetch: fetch2, throttleMs: 2000,
    sleep: async () => {}, log: () => {},
  });
  assert.equal(result2.completed, 1);
  assert.equal(result2.skippedDone, 1);
  assert.equal(result2.emptySource, 1);
  assert.deepEqual(calls2.map((s) => s.segKey), ['embalance:balance_sheet:601318'],
    '续跑只调用未完成段');

  // 节流下限（≥2s）：低于 2000ms 具名拒绝
  await assert.rejects(runBalanceBackfill({
    segments, progressPath: path1, fetch: fetch2, throttleMs: 1999,
    sleep: async () => {}, log: () => {},
  }), (e: unknown) => e instanceof PoolBackfillError && e.code === 'BALANCE_THROTTLE_INVALID');
});
