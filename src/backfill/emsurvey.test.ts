/**
 * Lyra · 机构调研记录回填 runner 单测（P2 W41b: code-writer，C2）。不碰网络、不碰 DB：
 * 段计划/进度/runner 全部纯函数 + 注入 fetch 与注入 sleep。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AdapterPauseError } from '../adapters/backoff.js';
import { EMSURVEY_ADAPTER_VERSION } from '../adapters/emsurvey.js';
import { PoolBackfillError } from './pool-market.js';
import {
  EMSURVEY_WINDOW_YEARS,
  emptySurveyProgress,
  loadSurveyProgress,
  planSurveySegments,
  runSurveyBackfill,
  saveSurveyProgress,
  surveyWindowFromIso,
  type SurveyFetchResult,
  type SurveySegment,
} from './emsurvey.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lyra-w41b-runner-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mkResult = (rowCount: number): SurveyFetchResult => ({
  rowCount,
  gapRows: 0,
  windowExcludedRows: 0,
  insertedFactIds: Array.from({ length: rowCount }, (_, i) => `f${String(i)}`),
  identicalFactIds: [],
  rejectedRows: [],
});

test('surveyWindowFromIso：anchor 前推 2 年日历窗界（跨年/闰界安全）', () => {
  assert.equal(surveyWindowFromIso(new Date('2026-10-26T03:00:00.000Z')), '2024-10-26');
  assert.equal(surveyWindowFromIso(new Date('2026-01-01T00:00:00.000Z')), '2024-01-01');
  assert.equal(surveyWindowFromIso(new Date('2026-12-31T00:00:00.000Z')), '2024-12-31');
  // 2 月 29 界回退 2 月 28（anchor 2028-02-29 → 2026-02-28）
  assert.equal(surveyWindowFromIso(new Date('2028-02-29T00:00:00.000Z')), '2026-02-28');
  // 显式年数参数
  assert.equal(surveyWindowFromIso(new Date('2026-10-26T00:00:00.000Z'), 1), '2025-10-26');
  assert.throws(() => surveyWindowFromIso(new Date('2026-10-26T00:00:00.000Z'), 0), (e: unknown) => e instanceof PoolBackfillError);
  assert.throws(() => surveyWindowFromIso(new Date('2026-10-26T00:00:00.000Z'), 1.5), (e: unknown) => e instanceof PoolBackfillError);
  assert.equal(EMSURVEY_WINDOW_YEARS, 2);
});

test('planSurveySegments：段=个股、segKey 形态、窗界全段一致、空表/重复码具名拒绝', () => {
  const segments = planSurveySegments(['601318', '000938'], new Date('2026-10-26T03:00:00.000Z'));
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.code, '601318');
  assert.equal(segments[0]!.segKey, 'emsurvey:survey:601318');
  assert.equal(segments[1]!.segKey, 'emsurvey:survey:000938');
  assert.equal(segments[0]!.fromIso, '2024-10-26', '窗界=anchor−2 年（映射层执行，窗界不进桥参数）');
  assert.equal(segments[1]!.fromIso, segments[0]!.fromIso, '窗界对全部段一致');
  assert.throws(() => planSurveySegments([], new Date('2026-10-26T00:00:00.000Z')), (e: unknown) => e instanceof PoolBackfillError);
  assert.throws(() => planSurveySegments(['601318', '601318'], new Date('2026-10-26T00:00:00.000Z')), (e: unknown) => e instanceof PoolBackfillError);
});

test('进度：缺失文件回空、save/load 往返、原子写无 tmp 残留、坏形状回空', async () => {
  const path = join(dir, 'progress-basic.json');
  const fresh = await loadSurveyProgress(path);
  assert.equal(fresh.version, 1);
  assert.equal(fresh.adapterVersion, EMSURVEY_ADAPTER_VERSION);
  assert.deepEqual(fresh.completed, {});

  const progress = emptySurveyProgress();
  progress.completed['emsurvey:survey:601318'] = {
    code: '601318',
    rowCount: 42,
    gapRows: 0,
    windowExcluded: 3,
    inserted: 39,
    identical: 0,
    rejected: 0,
    emptySource: false,
    completedAt: '2026-10-26T00:00:00.000Z',
  };
  await saveSurveyProgress(path, progress);
  const loaded = await loadSurveyProgress(path);
  assert.equal(loaded.completed['emsurvey:survey:601318']?.rowCount, 42);
  assert.equal(loaded.completed['emsurvey:survey:601318']?.windowExcluded, 3);
  const listing = await readFile(`${path}.tmp`, 'utf8').then(() => 'tmp-exists', () => 'no-tmp');
  assert.equal(listing, 'no-tmp');

  await writeFileBroken(path);
  const bad = await loadSurveyProgress(path);
  assert.equal(bad.version, 1, '坏形状回空进度');
});

async function writeFileBroken(path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, 'not-json', 'utf8');
}

test('runner：断点续跑跳过已完成段、节流等待、空集计数、汇总数', async () => {
  const segments: SurveySegment[] = [
    { code: '601318', fromIso: '2024-10-26', segKey: 'emsurvey:survey:601318' },
    { code: '000938', fromIso: '2024-10-26', segKey: 'emsurvey:survey:000938' },
    { code: '600036', fromIso: '2024-10-26', segKey: 'emsurvey:survey:600036' },
  ];
  const progressPath = join(dir, 'progress-runner.json');
  const progress = emptySurveyProgress();
  progress.completed[segments[0]!.segKey] = {
    code: '601318', rowCount: 9, gapRows: 0, windowExcluded: 0, inserted: 9, identical: 0, rejected: 0, emptySource: false,
    completedAt: '2026-10-26T00:00:00.000Z',
  };
  await saveSurveyProgress(progressPath, progress);

  const fetched: string[] = [];
  const sleeps: number[] = [];
  const fetch = async (segment: SurveySegment): Promise<SurveyFetchResult> => {
    fetched.push(segment.code);
    return segment.code === '600036' ? mkResult(0) : mkResult(2);
  };
  const result = await runSurveyBackfill({
    segments,
    progressPath,
    fetch,
    throttleMs: 2000,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(fetched, ['000938', '600036'], '已完成段跳过（断点续跑）');
  assert.equal(result.completed, 2);
  assert.equal(result.skippedDone, 1);
  assert.equal(result.realCalls, 2);
  assert.equal(result.emptySource, 1, '600036 空集如实计数');
  assert.equal(result.rowTotal, 2);
  assert.equal(result.rejectedRowsTotal, 0);
  assert.equal(sleeps.length, 1, '第二段前等待一次节流');
  assert.ok(sleeps[0]! >= 1990 && sleeps[0]! <= 2000, `节流等待补足到 2000ms（实测 ${String(sleeps[0])}，上段 fetch 耗时抖动）`);

  const after = await loadSurveyProgress(progressPath);
  assert.equal(after.completed[segments[2]!.segKey]?.emptySource, true, '空集段记完成态');
  assert.equal(Object.keys(after.completed).length, 3);
});

test('runner：throttle 低于下限具名拒绝；fetch 暂停（退避耗尽）原样上抛不吞', async () => {
  assert.rejects(
    runSurveyBackfill({
      segments: [{ code: '601318', fromIso: '2024-10-26', segKey: 'emsurvey:survey:601318' }],
      progressPath: join(dir, 'progress-invalid.json'),
      fetch: async () => mkResult(1),
      throttleMs: 1999,
    }),
    (e: unknown) => e instanceof PoolBackfillError,
  );
  const progressPath = join(dir, 'progress-pause.json');
  const err = await runSurveyBackfill({
    segments: [{ code: '000938', fromIso: '2024-10-26', segKey: 'emsurvey:survey:000938' }],
    progressPath,
    fetch: async () => {
      throw new AdapterPauseError('emsurvey', 'emsurvey:survey:000938', 3, '来源返回失败 code=9701', '暂停上报，恢复=重跑同一命令');
    },
    throttleMs: 2000,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AdapterPauseError, '暂停异常原样上抛（退出码 2 由 CLI 层处理）');
  const saved = await loadSurveyProgress(progressPath);
  assert.equal(Object.keys(saved.completed).length, 0, '失败段不提交进度（恢复=重跑）');
});
