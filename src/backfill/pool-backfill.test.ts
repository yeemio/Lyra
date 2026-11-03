/**
 * Lyra · 研究池回填单测（P1 W8）。不碰网络、不碰 DB：池解析/代码转换/段计划为纯函数；
 * runner 用注入 fetch + 临时目录断点文件（模式同 membership.test.ts）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  FULL_HISTORY_FROM,
  IndexProbeEmptyError,
  PROBE_INDEX,
  PoolBackfillError,
  emptyMarketProgress,
  loadMarketProgress,
  parseResearchPool,
  planMarketSegments,
  runMarketBackfill,
  saveMarketProgress,
  toBsCode,
  type MarketFetchResult,
} from './pool-market.js';
import {
  emptyFinProgress,
  loadFinProgress,
  planFinancialSegments,
  runFinancialBackfill,
  saveFinProgress,
} from './pool-financials.js';
import { makeReplayExecutor, verify801020Dates } from './sw-801020.js';

const POOL_JSON = JSON.stringify({
  frozenAt: '2026-10-25',
  stocks: [
    { rank: 1, code: '600519', name: '贵州茅台' },
    { rank: 2, code: '000938', name: '紫光股份' },
  ],
  etfs: [
    { code: '510050', name: '上证50ETF', tracks: '上证50(000016)' },
    { code: '510300', name: '沪深300ETF', tracks: '沪深300(000300)' },
  ],
});

test('parseResearchPool：股票/ETF/跟踪指数解析与去重', () => {
  const pool = parseResearchPool(POOL_JSON);
  assert.deepEqual(pool.stocks.map((s) => s.code), ['600519', '000938']);
  assert.equal(pool.stocks[0]?.name, '贵州茅台');
  assert.deepEqual(pool.etfs.map((e) => e.code), ['510050', '510300']);
  assert.deepEqual(pool.etfs[1]?.indexCode, '000300');
  assert.deepEqual(pool.indexCodes, ['000016', '000300']);
});

test('parseResearchPool：坏形状与越界代码具名拒绝', () => {
  const rejects = (text: string, code: string) =>
    assert.throws(() => parseResearchPool(text), (error: unknown) => error instanceof PoolBackfillError && error.code === code);
  rejects('{not json', 'POOL_JSON_INVALID');
  rejects('{"stocks":[],"etfs":[]}', 'POOL_SHAPE_INVALID');
  rejects('{"stocks":[{"code":"60051","name":"x"}],"etfs":[]}', 'POOL_SHAPE_INVALID'); // etfs 空
  rejects('{"stocks":[{"code":"60051A","name":"x"}],"etfs":[{"code":"510050","tracks":"x(000016)"}]}', 'POOL_CODE_INVALID');
  rejects(
    '{"stocks":[{"code":"600519"},{"code":"600519"}],"etfs":[{"code":"510050","tracks":"x(000016)"}]}',
    'POOL_CODE_DUP',
  );
  // R17 主板范围外（创业板 30xxxx）拒绝
  rejects(
    '{"stocks":[{"code":"300750","name":"宁德时代"}],"etfs":[{"code":"510050","tracks":"x(000016)"}]}',
    'POOL_STOCK_NOT_MAINBOARD',
  );
  // ETF 前缀不在支持集（6xxxxx 是指数前缀形态，不是 ETF）
  rejects(
    '{"stocks":[{"code":"600519"}],"etfs":[{"code":"000016","tracks":"x(000016)"}]}',
    'POOL_ETF_CODE_INVALID',
  );
  // tracks 缺 6 位指数括注
  rejects(
    '{"stocks":[{"code":"600519"}],"etfs":[{"code":"510050","tracks":"上证50"}]}',
    'POOL_TRACKS_INDEX_MISSING',
  );
});

test('toBsCode：股票/ETF/指数交易所归属与显式 kind 分派（指数陷阱）', () => {
  assert.equal(toBsCode('600519', 'stock'), 'sh.600519');
  assert.equal(toBsCode('603986', 'stock'), 'sh.603986');
  assert.equal(toBsCode('000938', 'stock'), 'sz.000938');
  assert.equal(toBsCode('002384', 'stock'), 'sz.002384');
  assert.equal(toBsCode('510050', 'etf'), 'sh.510050');
  assert.equal(toBsCode('512100', 'etf'), 'sh.512100');
  assert.equal(toBsCode('159901', 'etf'), 'sz.159901'); // R24 待确认指令含深市 ETF 形态
  assert.equal(toBsCode('000016', 'index'), 'sh.000016');
  assert.equal(toBsCode('000300', 'index'), 'sh.000300');
  assert.equal(toBsCode('000905', 'index'), 'sh.000905');
  assert.equal(toBsCode('000852', 'index'), 'sh.000852');
  assert.equal(toBsCode('399006', 'index'), 'sz.399006');
  // 陷阱证据：同一裸码 000300 按 stock 规则会得到 sz.000300（被适配器归类为个股）——
  // 指数必须显式 kind='index'，planMarketSegments 的指数段一律走 index 规则。
  assert.equal(toBsCode('000300', 'stock'), 'sz.000300');
  assert.throws(() => toBsCode('600519', 'index'), (e: unknown) => e instanceof PoolBackfillError && e.code === 'POOL_INDEX_CODE_INVALID');
  assert.throws(() => toBsCode('688981', 'stock'), (e: unknown) => e instanceof PoolBackfillError && e.code === 'POOL_STOCK_NOT_MAINBOARD');
});

test('planMarketSegments：探测段最前 + 每股 K线/因子 + ETF/指数全历史；范围校验', () => {
  const pool = parseResearchPool(POOL_JSON);
  const segments = planMarketSegments(pool, { from: '2015-01-01', to: '2026-10-25', probeStart: '2026-10-05' });
  assert.equal(segments.length, 1 + 2 * 2 + 2 + 2);
  const [probe, k1, a1, k2, a2, e1, e2, i1, i2] = segments;
  assert.equal(probe?.kind, 'probe');
  assert.equal(probe?.bsCode, 'sh.000300');
  assert.equal(probe?.code, PROBE_INDEX);
  assert.equal(probe?.start, '2026-10-05');
  assert.deepEqual([k1?.kind, k1?.code, k1?.bsCode, k1?.start, k1?.end], ['kline', '600519', 'sh.600519', '2015-01-01', '2026-10-25']);
  assert.deepEqual([a1?.kind, a1?.bsCode], ['adjust', 'sh.600519']);
  assert.deepEqual([k2?.bsCode, a2?.bsCode], ['sz.000938', 'sz.000938']);
  assert.deepEqual([e1?.kind, e1?.bsCode, e1?.start], ['etf-kline', 'sh.510050', FULL_HISTORY_FROM]);
  assert.deepEqual([e2?.bsCode], ['sh.510300']);
  assert.deepEqual([i1?.kind, i1?.bsCode, i1?.start], ['index-kline', 'sh.000016', FULL_HISTORY_FROM]);
  assert.deepEqual([i2?.bsCode], ['sh.000300']);
  // segKey 唯一且含窗口（--to 变化 → 新段，旧行 factId 去重）
  const keys = new Set(segments.map((s) => s.segKey));
  assert.equal(keys.size, segments.length);
  assert.equal(probe?.segKey, 'probe:000300:2026-10-05:2026-10-25');
  // 默认探测窗 = to − 20 天
  const defaulted = planMarketSegments(pool, { from: '2015-01-01', to: '2026-10-25' });
  assert.equal(defaulted[0]?.start, '2026-10-05');
  assert.throws(
    () => planMarketSegments(pool, { from: '2026-10-26', to: '2026-10-25' }),
    (e: unknown) => e instanceof PoolBackfillError && e.code === 'DATE_RANGE_INVALID',
  );
});

test('planFinancialSegments：股 × 年 × Q1..Q4 顺序与校验', () => {
  const segments = planFinancialSegments(['600519', '000938'], 2015, 2016);
  assert.equal(segments.length, 16);
  assert.deepEqual(
    segments.slice(0, 4).map((s) => s.segKey),
    ['fin:600519:2015:Q1', 'fin:600519:2015:Q2', 'fin:600519:2015:Q3', 'fin:600519:2015:Q4'],
  );
  assert.deepEqual(
    segments.slice(-2).map((s) => s.segKey),
    ['fin:000938:2016:Q3', 'fin:000938:2016:Q4'],
  );
  assert.equal(segments[0]?.bsCode, 'sh.600519');
  assert.equal(segments[7]?.bsCode, 'sh.600519'); // 股外层：600519 的 2016Q4
  assert.equal(segments[8]?.bsCode, 'sz.000938'); // 第二股起点
  // 池规模换算：26 股 × 2015..2026 × 4 季 = 1248 段
  assert.equal(planFinancialSegments(Array.from({ length: 26 }, (_, i) => `6005${String(i).padStart(2, '0')}`), 2015, 2026).length, 1_248);
  assert.throws(
    () => planFinancialSegments(['600519'], 2017, 2015),
    (e: unknown) => e instanceof PoolBackfillError && e.code === 'FIN_YEAR_RANGE_INVALID',
  );
});

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lyra-w8-pool-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});
});

function okFetch(rowCount = 10): MarketFetchResult {
  return { rowCount, insertedFactIds: ['f1'], identicalFactIds: [], rejectedRows: [] };
}

test('runMarketBackfill：探测空集 → 停下回报，不启动其余段、不落探测断点', async () => {
  const progressPath = join(stateDir, 'probe-empty.json');
  const pool = parseResearchPool(POOL_JSON);
  const segments = planMarketSegments(pool, { from: '2015-01-01', to: '2026-10-25', probeStart: '2026-10-05' });
  const calls: string[] = [];
  await assert.rejects(
    runMarketBackfill({
      segments,
      progressPath,
      fetch: async (seg) => {
        calls.push(seg.segKey);
        return okFetch(seg.kind === 'probe' ? 0 : 10);
      },
      throttleMs: 10,
      sleep: async () => {},
      log: () => {},
    }),
    (error: unknown) => error instanceof IndexProbeEmptyError,
  );
  assert.deepEqual(calls, [segments[0]?.segKey], '只有探测段被调用');
  const progress = await loadMarketProgress(progressPath);
  assert.equal(Object.keys(progress.completed).length, 0, '空探测不写断点（重跑重探）');
});

test('runMarketBackfill：完整跑 + 断点跳过 + 部分补跑（注入 fetch，零网络零 DB）', async () => {
  const progressPath = join(stateDir, 'market-progress.json');
  const pool = parseResearchPool(POOL_JSON);
  const segments = planMarketSegments(pool, { from: '2015-01-01', to: '2026-10-25', probeStart: '2026-10-05' });
  assert.equal(segments.length, 9);
  const calls: string[] = [];
  const sleeps: number[] = [];
  const r1 = await runMarketBackfill({
    segments,
    progressPath,
    fetch: async (seg) => {
      calls.push(seg.segKey);
      return okFetch(seg.kind === 'adjust' ? 3 : 10);
    },
    throttleMs: 10,
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  });
  assert.equal(r1.probe, 'PASS');
  assert.equal(r1.completed, 8);
  assert.equal(r1.realCalls, 9);
  assert.ok(sleeps.length >= 8, '相邻调用之间有节流等待');
  assert.deepEqual(calls[0], 'probe:000300:2026-10-05:2026-10-25');
  // 断点形状
  const progress = await loadMarketProgress(progressPath);
  assert.equal(Object.keys(progress.completed).length, 9);
  assert.equal(progress.completed['adjust:600519:2015-01-01:2026-10-25']?.rowCount, 3);
  // 重跑：全跳过，零真实调用
  const r2 = await runMarketBackfill({ segments, progressPath, fetch: async (seg) => { calls.push(seg.segKey); return okFetch(); }, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r2.probe, 'SKIPPED_DONE');
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 8);
  assert.equal(r2.realCalls, 0);
  assert.equal(calls.length, 9, 'fetch 未被再次调用');
  // 部分中断：删一段 → 只补该段（探测仍跳过）
  delete progress.completed['kline:000938:2015-01-01:2026-10-25'];
  await saveMarketProgress(progressPath, progress);
  const r3 = await runMarketBackfill({ segments, progressPath, fetch: async (seg) => { calls.push(seg.segKey); return okFetch(); }, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r3.probe, 'SKIPPED_DONE');
  assert.equal(r3.completed, 1);
  assert.equal(r3.realCalls, 1);
  assert.deepEqual(r3.emptyNonProbe, []);
});

test('runMarketBackfill：空返回非探测段如实入档并计入 emptyNonProbe', async () => {
  const progressPath = join(stateDir, 'market-empty.json');
  const pool = parseResearchPool(POOL_JSON);
  const segments = planMarketSegments(pool, { from: '2015-01-01', to: '2026-10-25', probeStart: '2026-10-05' });
  const r = await runMarketBackfill({
    segments,
    progressPath,
    fetch: async (seg) => (seg.kind === 'etf-kline' ? { rowCount: 0, insertedFactIds: [], identicalFactIds: [], rejectedRows: [{ rowIndex: 0, code: 'X' }] } : okFetch()),
    throttleMs: 10,
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(r.emptyNonProbe, ['etf-kline:510050:1999-01-01:2026-10-25', 'etf-kline:510300:1999-01-01:2026-10-25']);
  assert.equal(r.rejectedRowsTotal, 2);
  const progress = await loadMarketProgress(progressPath);
  assert.equal(progress.completed['etf-kline:510050:1999-01-01:2026-10-25']?.rowCount, 0, '空段照常记完成（空原件入档由适配器层保证）');
});

test('runFinancialBackfill：空集源如实完成 + 重跑零调用 + 部分补跑', async () => {
  const progressPath = join(stateDir, 'fin-progress.json');
  const segments = planFinancialSegments(['600519'], 2026, 2026); // 4 段
  const calls: string[] = [];
  const fetch = async (seg: (typeof segments)[number]) => {
    calls.push(seg.segKey);
    // Q3/Q4 未披露 → 空集；Q1/Q2 各 2 行、Q2 有 1 行被具名拒绝（无 pubDate）
    return seg.quarter <= 2
      ? { rowCount: 2, insertedFactIds: ['f1', 'f2'], identicalFactIds: [], rejectedRows: seg.quarter === 2 ? [{ rowIndex: 0, code: 'FINANCIAL_PUBDATE_MISSING' }] : [] }
      : { rowCount: 0, insertedFactIds: [], identicalFactIds: [], rejectedRows: [] };
  };
  const r1 = await runFinancialBackfill({ segments, progressPath, fetch, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r1.completed, 4);
  assert.equal(r1.realCalls, 4);
  assert.equal(r1.emptySource, 2);
  assert.equal(r1.rejectedRowsTotal, 1);
  assert.deepEqual(r1.emptySample, ['fin:600519:2026:Q3', 'fin:600519:2026:Q4']);
  const progress = await loadFinProgress(progressPath);
  assert.equal(progress.completed['fin:600519:2026:Q4']?.emptySource, true);
  assert.equal(progress.completed['fin:600519:2026:Q2']?.rejected, 1);
  // 重跑：全跳过
  const r2 = await runFinancialBackfill({ segments, progressPath, fetch, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r2.completed, 0);
  assert.equal(r2.skippedDone, 4);
  assert.equal(r2.realCalls, 0);
  assert.equal(calls.length, 4);
  // 部分中断：删 Q2 → 只补 Q2
  delete progress.completed['fin:600519:2026:Q2'];
  await saveFinProgress(progressPath, progress);
  const r3 = await runFinancialBackfill({ segments, progressPath, fetch, throttleMs: 10, sleep: async () => {}, log: () => {} });
  assert.equal(r3.completed, 1);
  assert.deepEqual(calls.slice(-1), ['fin:600519:2026:Q2']);
});

test('进度文件：坏形状按空进度重来；save/load 等价（updatedAt 为构造时刻，毫秒级非确定，剥离比较）', async () => {
  const badPath = join(stateDir, 'bad.json');
  await writeFile(badPath, '{not json', 'utf8');
  const strip = (o: { updatedAt?: string }) => { const { updatedAt: _t, ...rest } = o; return rest; };
  assert.deepEqual(strip(await loadMarketProgress(badPath)), strip(emptyMarketProgress()));
  assert.deepEqual(strip(await loadFinProgress(badPath)), strip(emptyFinProgress()));
});

test('801020 重放：执行器只服务 801020；日期域核验（全史起点 + 2021-12-10 退役边界）', async () => {
  const response = { ok: true as const, rows: [{ 日期: '1999-12-30' }, { 日期: '2014-02-21' }, { 日期: '2021-12-10' }] };
  const exec = makeReplayExecutor(response);
  assert.equal(await exec(['l1_daily', '801020']), response);
  await assert.rejects(() => exec(['l1_daily', '801010']), /SW_REPLAY_ONLY_801020/);
  await assert.rejects(() => exec(['l1_list']), /SW_REPLAY_ONLY_801020/);
  const check = verify801020Dates(response.rows);
  assert.deepEqual(check, { first: '1999-12-30', last: '2021-12-10', n: 3 });
  // 乱序行：核验按排序取域
  assert.deepEqual(verify801020Dates([{ 日期: '2021-12-10' }, { 日期: '1999-12-30' }]), { first: '1999-12-30', last: '2021-12-10', n: 2 });
  // 退役边界不符（全史起点正常、末行早于 2021-12-10）/ 非全史 / 日期缺失 → 拒绝
  assert.throws(() => verify801020Dates([{ 日期: '1999-12-30' }, { 日期: '2021-12-09' }]), /SW_801020_RETIRE_BOUNDARY_MISMATCH/);
  assert.throws(() => verify801020Dates([{ 日期: '2015-01-05' }, { 日期: '2021-12-10' }]), /SW_801020_NOT_FULL_HISTORY/);
  assert.throws(() => verify801020Dates([{ 日期: '2021-12-10' }, { noDate: 1 }]), /SW_801020_ROWS_INVALID/);
});
