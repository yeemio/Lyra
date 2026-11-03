/**
 * Lyra · 成分月度回填单测（P1 W6）。不碰网络、不碰 DB：计划纯函数用夹具日历表，
 * runner 用注入 fetch + 临时目录断点文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { TradeCalendarTable } from '../adapters/calendar.js';
import {
  MEMBERSHIP_INDEXES,
  emptyMembershipProgress,
  loadMembershipProgress,
  planMembershipSegments,
  planMonths,
  runMembershipBackfill,
  saveMembershipProgress,
  type MembershipSegment,
} from './membership.js';

const TABLE: TradeCalendarTable = {
  tradingDays: [
    '2015-01-30', // 1 月末
    '2015-02-27', '2015-02-28', // 2 月末（28 为周末？夹具自定义：以 27 为月末的情形不设，28 记为交易日）
    '2015-03-31',
    '2015-06-30',
    '2016-01-29',
  ],
};

test('planMonths：连续月份、跨年、非法与倒序拒绝', () => {
  assert.deepEqual(planMonths('2015-01', '2015-04'), ['2015-01', '2015-02', '2015-03', '2015-04']);
  assert.deepEqual(planMonths('2015-11', '2016-02'), ['2015-11', '2015-12', '2016-01', '2016-02']);
  assert.deepEqual(planMonths('2026-10', '2026-10'), ['2026-10']);
  assert.throws(() => planMonths('2015-1', '2015-04'), /CALENDAR_MONTH_INVALID/);
  assert.throws(() => planMonths('2015-13', '2016-01'), /CALENDAR_MONTH_INVALID/);
  assert.throws(() => planMonths('2015-04', '2015-01'), /CALENDAR_MONTH_INVALID/);
});

test('planMembershipSegments：月末快照日 × 两指数；无覆盖月跳过并记原因', () => {
  const { segments, skippedMonths } = planMembershipSegments(TABLE, '2015-01', '2016-01');
  // 夹具月份末交易日：2015-01→01-30、2015-02→02-28、2015-03→03-31、2015-04/05 无、
  // 2015-06→06-30、2015-07..12 无、2016-01→01-29
  const expected: MembershipSegment[] = [
    { index: 'hs300', date: '2015-01-30', segKey: 'hs300:2015-01-30' },
    { index: 'zz500', date: '2015-01-30', segKey: 'zz500:2015-01-30' },
    { index: 'hs300', date: '2015-02-28', segKey: 'hs300:2015-02-28' },
    { index: 'zz500', date: '2015-02-28', segKey: 'zz500:2015-02-28' },
    { index: 'hs300', date: '2015-03-31', segKey: 'hs300:2015-03-31' },
    { index: 'zz500', date: '2015-03-31', segKey: 'zz500:2015-03-31' },
    { index: 'hs300', date: '2015-06-30', segKey: 'hs300:2015-06-30' },
    { index: 'zz500', date: '2015-06-30', segKey: 'zz500:2015-06-30' },
    { index: 'hs300', date: '2016-01-29', segKey: 'hs300:2016-01-29' },
    { index: 'zz500', date: '2016-01-29', segKey: 'zz500:2016-01-29' },
  ];
  assert.deepEqual(segments, expected);
  assert.deepEqual(skippedMonths.map((s) => s.month), ['2015-04', '2015-05', '2015-07', '2015-08', '2015-09', '2015-10', '2015-11', '2015-12']);
  assert.deepEqual(MEMBERSHIP_INDEXES, ['hs300', 'zz500']);
});

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w6-membership-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
});

test('runner：真实调用计数 + 断点提交 + 重跑跳过（注入 fetch，零网络零 DB）', async () => {
  const progressPath = join(stateDir, 'membership-progress.json');
  const segments = planMembershipSegments(TABLE, '2015-01', '2015-03').segments;
  assert.equal(segments.length, 6);
  const calls: string[] = [];
  const fetch = async (index: 'hs300' | 'zz500', date: string) => {
    calls.push(`${index}:${date}`);
    return { rowCount: 300 + index.length, insertedFactIds: ['f1', 'f2'], identicalFactIds: [] };
  };
  const sleeps: number[] = [];
  const r1 = await runMembershipBackfill({
    segments,
    progressPath,
    fetch,
    throttleMs: 10,
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  });
  assert.equal(r1.completed, 6);
  assert.equal(r1.realCalls, 6);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], 'hs300:2015-01-30');
  assert.deepEqual(calls[5], 'zz500:2015-03-31');
  assert.ok(sleeps.length >= 5, '相邻调用之间有节流等待');
  // 断点文件已提交且形状正确
  const progress = await loadMembershipProgress(progressPath);
  assert.equal(Object.keys(progress.completed).length, 6);
  assert.equal(progress.completed['hs300:2015-01-30']?.rowCount, 305, 'rowCount = 300 + index.length（夹具约定）');
  assert.equal(progress.completed['zz500:2015-03-31']?.insertedFacts, 2);
  // 重跑：全部跳过，零真实调用
  const r2 = await runMembershipBackfill({ segments, progressPath, fetch, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 6);
  assert.equal(r2.realCalls, 0);
  assert.equal(calls.length, 6, 'fetch 未被再次调用');
  // 部分中断：删两段断点 → 只补这两段
  delete progress.completed['hs300:2015-02-28'];
  delete progress.completed['zz500:2015-03-31'];
  await saveMembershipProgress(progressPath, progress);
  const r3 = await runMembershipBackfill({ segments, progressPath, fetch, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r3.completed, 2);
  assert.equal(r3.realCalls, 2);
  assert.deepEqual(r3.completedSegKeys.sort(), ['hs300:2015-02-28', 'zz500:2015-03-31']);
});

test('进度文件：坏形状按空进度重来；空进度写入读回等价', async () => {
  const path = join(stateDir, 'bad-progress.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, '{not json', 'utf8');
  const loaded = await loadMembershipProgress(path);
  assert.deepEqual(loaded, emptyMembershipProgress());
});
