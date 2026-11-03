/**
 * Lyra · 基金重仓回填 runner 单测（P1 W39: code-writer，B2）。不碰网络、不碰 DB：
 * 段计划/进度/runner 全部纯函数 + 注入 fetch 与注入 sleep。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile as writeFileRaw } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PoolBackfillError } from './pool-market.js';
import { EMINSTITUTION_ADAPTER_VERSION } from '../adapters/eminstitution.js';
import {
  EMINSTITUTION_QUARTERS,
  fundHoldQuarterEnds,
  emptyInstitutionProgress,
  loadInstitutionProgress,
  planInstitutionSegments,
  runInstitutionBackfill,
  saveInstitutionProgress,
  type InstitutionFetchResult,
  type InstitutionSegment,
} from './eminstitution.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lyra-w39-runner-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mkResult = (rowCount: number): InstitutionFetchResult => ({
  rowCount,
  fullRowCount: 1556,
  insertedFactIds: Array.from({ length: rowCount }, (_, i) => `f${String(i)}`),
  identicalFactIds: [],
  rejectedRows: [],
});

test('fundHoldQuarterEnds：anchor 前最近 8 个季末（旧→新、严格 ≤ anchor、跨年回退）', () => {
  const ends = fundHoldQuarterEnds(new Date('2026-10-25T03:00:00.000Z'), EMINSTITUTION_QUARTERS);
  assert.deepEqual(ends, [
    '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30',
    '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30',
  ]);
  // anchor 恰为季末日：当日计入
  assert.equal(fundHoldQuarterEnds(new Date('2026-09-30T00:00:00.000Z'), 1)[0], '2026-09-30');
  // anchor 在季初：该季末尚未到达，不含
  assert.equal(fundHoldQuarterEnds(new Date('2026-01-01T00:00:00.000Z'), 1)[0], '2025-12-31');
});

test('planInstitutionSegments：段=报告期日期、segKey 形态、数量非法具名拒绝', () => {
  const segments = planInstitutionSegments(new Date('2026-10-25T03:00:00.000Z'));
  assert.equal(segments.length, EMINSTITUTION_QUARTERS);
  assert.equal(segments[0]!.date, '2024-12-31');
  assert.equal(segments.at(-1)!.date, '2026-09-30');
  assert.deepEqual(
    segments.map((s) => s.segKey),
    segments.map((s) => `eminstitution:fund_hold:${s.date}`),
  );
  assert.throws(() => planInstitutionSegments(new Date('2026-10-25T03:00:00.000Z'), 0), (e: unknown) => e instanceof PoolBackfillError);
  assert.throws(() => planInstitutionSegments(new Date('2026-10-25T03:00:00.000Z'), 1.5), (e: unknown) => e instanceof PoolBackfillError);
});

test('进度：缺失文件回空、save/load 往返、原子写无 tmp 残留、坏形状回空', async () => {
  const path = join(dir, 'progress-basic.json');
  const fresh = await loadInstitutionProgress(path);
  assert.equal(fresh.version, 1);
  assert.equal(fresh.adapterVersion, EMINSTITUTION_ADAPTER_VERSION);
  assert.deepEqual(fresh.completed, {});

  const progress = emptyInstitutionProgress();
  progress.completed['eminstitution:fund_hold:2026-09-30'] = {
    date: '2026-09-30',
    rowCount: 2,
    fullRowCount: 1556,
    inserted: 2,
    identical: 0,
    rejected: 0,
    emptySource: false,
    completedAt: '2026-10-26T00:00:00.000Z',
  };
  await saveInstitutionProgress(path, progress);
  const loaded = await loadInstitutionProgress(path);
  assert.equal(loaded.completed['eminstitution:fund_hold:2026-09-30']?.rowCount, 2);
  assert.equal(loaded.completed['eminstitution:fund_hold:2026-09-30']?.fullRowCount, 1556);
  const listing = await readFile(`${path}.tmp`, 'utf8').then(() => 'tmp-exists', () => 'no-tmp');
  assert.equal(listing, 'no-tmp');

  await writeFileRaw(`${path}-bad.json`, '{broken');
  assert.deepEqual(await loadInstitutionProgress(`${path}-bad.json`), emptyInstitutionProgress());
});

test('runInstitutionBackfill：全量段完成、节流生效（≥2s 下限，注入 sleep 记录等待）、池命中累计', async () => {
  const path = join(dir, 'progress-run1.json');
  const segments = planInstitutionSegments(new Date('2026-10-25T03:00:00.000Z'), 3);
  const waits: number[] = [];
  const result = await runInstitutionBackfill({
    segments,
    progressPath: path,
    fetch: async (segment: InstitutionSegment) => {
      return mkResult(segment.date === '2026-06-30' ? 0 : 2);
    },
    throttleMs: 2000,
    sleep: async (ms) => { waits.push(ms); },
    log: () => {},
  });
  assert.equal(result.completed, 3);
  assert.equal(result.skippedDone, 0);
  assert.equal(result.realCalls, 3);
  assert.equal(result.emptySource, 1, '2026-06-30 空集如实完成态');
  assert.equal(result.poolHitsTotal, 4);
  // 注入 fetch 即时返回 → 段间等待 = 节流值 − 实际耗时（间隔保 ≥ 节流值；首段不等待）
  assert.equal(waits.length, 2);
  for (const wait of waits) {
    assert.ok(wait > 1900 && wait <= 2000, `等待应在 (1900,2000]：${String(wait)}`);
  }
  const progress = await loadInstitutionProgress(path);
  assert.equal(Object.keys(progress.completed).length, 3);
  assert.equal(progress.completed['eminstitution:fund_hold:2026-06-30']?.emptySource, true);
});

test('runInstitutionBackfill：断点续跑跳过已完成段；节流下限具名拒绝；拒绝行累计', async () => {
  const path = join(dir, 'progress-run2.json');
  const segments = planInstitutionSegments(new Date('2026-10-25T03:00:00.000Z'), 3);
  // 预完成首段
  const progress = emptyInstitutionProgress();
  progress.completed[segments[0]!.segKey] = {
    date: segments[0]!.date,
    rowCount: 1,
    fullRowCount: 1000,
    inserted: 1,
    identical: 0,
    rejected: 0,
    emptySource: false,
    completedAt: '2026-10-26T00:00:00.000Z',
  };
  await saveInstitutionProgress(path, progress);

  const fetched: string[] = [];
  const result = await runInstitutionBackfill({
    segments,
    progressPath: path,
    fetch: async (segment) => {
      fetched.push(segment.segKey);
      return { ...mkResult(1), rejectedRows: [{ rowIndex: 0, code: 'EMINSTITUTION_ROW_FIELDS_INVALID' }] };
    },
    throttleMs: 2000,
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(result.skippedDone, 1);
  assert.equal(result.completed, 2);
  assert.equal(fetched.length, 2, '已完成段不再发起真实调用');
  assert.equal(result.rejectedRowsTotal, 2);

  await assert.rejects(
    runInstitutionBackfill({ segments, progressPath: path, fetch: async () => mkResult(0), throttleMs: 1999 }),
    (e: unknown) => e instanceof PoolBackfillError,
  );
});
