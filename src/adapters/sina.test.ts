/**
 * Lyra · 新浪行情适配器单测（P1 W9）。不碰外网：
 * 报价 fixture 为 2026-10-25 真实探测的 GBK 原始字节（base64，四样本一批）；
 * K 线 fixture 为同日真实探测的 JSONP 原文；退避用立即放行的注入睡眠；
 * DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：DATA-SOURCES §2.4/§5/§6/§7、Owner 数据源指令（REVISION-LOG R24-4）、
 * POINT-IN-TIME §2/§3、派发冻结 availableAt 规则（报价=抓取时刻；日 K=交易日 15:00+08）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { asOfFacts } from '../pintime/facts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import type { TimePointFact } from '../contracts.js';
import { BACKFILL_REVISION_NOTICE, TransientAdapterError, AdapterError } from './adapter-types.js';
import { applyP1Migration, loadPauseReports } from './backoff.js';
import {
  SINA_ADAPTER_VERSION,
  SinaAdapter,
  classifySubjectLikeBaoStock,
  crossCheckBars,
  klineDayToTradeDate,
  mapKlineRowsToFacts,
  mapQuoteLinesToFacts,
  parseKlineResponse,
  parseQuoteResponse,
  p1RunId,
  quoteFieldsToNamed,
  toNormalizedCode,
  toSinaSymbol,
  type CrossCheckOptions,
  type SinaFetcher,
} from './sina.js';

// ===== fixture（真实探测字节与原文；字段位与来源原文照实，不改写）=====

/** 2026-10-25 真实探测：hq.sinajs.cn 一批四样本（sh513330,sz159901,sh601919,sh600519）GBK 原始字节。 */
const QUOTE_GBK_B64 =
  'dmFyIGhxX3N0cl9zaDUxMzMzMD0iuuPJ+rulwarN+EVURruqz8QsMC4zMTUsMC4zMTQsMC4zMjAsMC4zMjEsMC4zMTIsMC4zMjAsMC4zMjEsODI4NTcwNDgxMSwyNjE5NDUwNDI4LjAwMCwyMTE4MzAwLDAuMzIwLDEzNDIwNDUwMCwwLjMxOSwzOTY1MzYwMCwwLjMxOCwyODIyNTEwMCwwLjMxNywzMTY4OTMwMCwwLjMxNiwxMDcwOTgxMDAsMC4zMjEsNTE5MzA5MDAsMC4zMjIsNTI3NjAyMDAsMC4zMjMsMzM2Mjk2MDAsMC4zMjQsMzY2MDQ3MDAsMC4zMjUsMjAyNi0xMC0yMywxNTozNDo1OSwwMCxEfDM0NjMwMDB8MTEwODE2MC4wMCI7CnZhciBocV9zdHJfc3oxNTk5MDE9IsnuMTAwRVRGLDIuODYwLDIuODg3LDIuOTY2LDIuOTc2LDIuODE4LDIuOTY2LDIuOTY3LDE3MDU4NjYyOSw0OTEzMjMwMTYuOTk3LDYzNDAwLDIuOTY2LDIzODAwLDIuOTY1LDIwNDAwLDIuOTY0LDg4MDAsMi45NjMsNDkwMCwyLjk2MiwxMTg2MDAsMi45NjcsMzAyMDAsMi45NjgsMjQwMCwyLjk2OSwyODg0NSwyLjk3MCw2MTAwLDIuOTcxLDIwMjYtMTAtMjMsMTU6MzU6MzAsMDAsRHwzMDAwfDg4OTguMDAwIjsKdmFyIGhxX3N0cl9zaDYwMTkxOT0iWETW0NS2uqMsMTUuNzMwLDE1LjgyMCwxNS44NTAsMTYuMTIwLDE1LjY4MCwxNS44NDAsMTUuODUwLDg1MzY2NjAxLDEzNTUzMDQ2MjYuMDAwLDExNDAwLDE1Ljg0MCw5NDYwMCwxNS44MzAsMzczMDAsMTUuODIwLDEwNjcwMCwxNS44MTAsMjExMzkwLDE1LjgwMCwzMjUwMDAsMTUuODUwLDE5NzQ1LDE1Ljg2MCwxNzU5MDAsMTUuODcwLDE2MjAwLDE1Ljg4MCw3NjQwMCwxNS44OTAsMjAyNi0xMC0yMywxNTozNDo1OSwwMCxEfDIxMjAwfDMzNjAyMC4wMCI7CnZhciBocV9zdHJfc2g2MDA1MTk9Irnz1t3DqcyoLDEzMTEuODQwLDEzMTguNDkwLDEzMzUuMDAwLDEzNDMuODgwLDEzMTAuMDAwLDEzMzMuMDAwLDEzMzUuMDAwLDU3Njg1OTMsNzY3NzIxNjI4My4wMDAsNjAwLDEzMzMuMDAwLDIwMCwxMzMxLjAwMCwyMDAsMTMzMC4wMDAsMzAwLDEzMjkuNTAwLDEwMCwxMzI5LjAyMCwxMTYwMCwxMzM1LjAwMCwyMDAsMTMzNS4wMTAsMjAwLDEzMzUuMTQwLDEwMCwxMzM1LjE5MCwxMDAsMTMzNS4yMDAsMjAyNi0xMC0yMywxNTozNDo1OSwwMCxEfDkwMHwxMjAxNTAwLjAwIjsK';

/** 同日真实探测：CN_MarketDataService.getKLineData sh513330 scale=240 datalen=4 的 JSONP 原文。 */
const KLINE_JSONP =
  "/*<script>location.href='//sina.com';</script>*/\n" +
  'var data=([{"day":"2026-10-20","open":"0.334","high":"0.334","low":"0.330","close":"0.333","volume":"4071356471"},{"day":"2026-10-21","open":"0.336","high":"0.336","low":"0.328","close":"0.328","volume":"3088345700"},{"day":"2026-10-22","open":"0.325","high":"0.325","low":"0.313","close":"0.314","volume":"5764145219"},{"day":"2026-10-23","open":"0.315","high":"0.321","low":"0.312","close":"0.320","volume":"8285704811"}]);';

const QUOTE_BYTES = Uint8Array.from(Buffer.from(QUOTE_GBK_B64, 'base64'));
const KLINE_BYTES = new TextEncoder().encode(KLINE_JSONP);

const NOW = () => new Date('2026-10-25T02:00:00.000Z');
const FETCHED_AT = '2026-10-25T02:00:00.000Z';
const instantSleeper = { sleep: async () => {} };

const QUOTE_CODES = ['sh513330', 'sz159901', 'sh601919', 'sh600519'];

// ===== 纯解析（无 DB、无网络）=====

test('解析·报价：GBK 原始字节解码 + 实测字段位（四样本一批）', () => {
  const lines = parseQuoteResponse(QUOTE_BYTES);
  assert.equal(lines.length, 4);
  const [etf, szEtf, stock, maotai] = lines;
  assert.equal(etf?.symbol, 'sh513330');
  assert.equal(szEtf?.symbol, 'sz159901');
  assert.equal(stock?.symbol, 'sh601919');
  assert.equal(maotai?.symbol, 'sh600519');
  // 实测位（2026-10-25 探测，股票/ETF/跨境 ETF 布局一致 34 位）
  for (const line of lines) {
    assert.equal(line?.fields.length, 34, `${line?.symbol} 应为 34 位字段`);
    const named = quoteFieldsToNamed(line?.fields ?? []);
    assert.notEqual(named, null);
    assert.equal(named?.date, '2026-10-23', '[30]=日期');
    assert.match(named?.time ?? '', /^\d{2}:\d{2}:\d{2}$/, '[31]=时间');
  }
  const named513330 = quoteFieldsToNamed(etf?.fields ?? []);
  assert.equal(named513330?.open, '0.315', '[1]=开');
  assert.equal(named513330?.preclose, '0.314', '[2]=昨收');
  assert.equal(named513330?.current, '0.320', '[3]=现价');
  assert.equal(named513330?.high, '0.321', '[4]=高');
  assert.equal(named513330?.low, '0.312', '[5]=低');
  assert.equal(named513330?.volume, '8285704811', '[8]=成交量(股)');
  assert.equal(named513330?.amount, '2619450428.000', '[9]=成交额(元)');
  // GBK 中文名解码（来源读回原文照实断言）
  assert.equal(named513330?.name, '恒生互联网ETF华夏');
  assert.equal(quoteFieldsToNamed(szEtf?.fields ?? [])?.name, '深100ETF');
  assert.equal(quoteFieldsToNamed(stock?.fields ?? [])?.name, 'XD中远海');
  assert.equal(quoteFieldsToNamed(maotai?.fields ?? [])?.name, '贵州茅台');
});

test('解析·报价：结构坏响应 → 具名瞬态错误（退避器可重试类）', () => {
  const bad = new TextEncoder().encode('<html>blocked</html>');
  assert.throws(() => parseQuoteResponse(bad), (e: unknown) => {
    return e instanceof TransientAdapterError && e.code === 'SINA_RESPONSE_UNPARSEABLE';
  });
});

test('解析·K线：JSONP 剥壳（var data= 锚定 + 前置注释行）+ 字段（无额列）', () => {
  const rows = parseKlineResponse(KLINE_BYTES);
  assert.equal(rows.length, 4);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ['close', 'day', 'high', 'low', 'open', 'volume']);
  assert.equal(rows[3]?.day, '2026-10-23');
  assert.equal(rows[3]?.open, '0.315');
  assert.equal(rows[3]?.close, '0.320');
  assert.equal(rows[3]?.volume, '8285704811', 'K线成交量与报价成交量同位同值（实测同为股）');
  assert.equal('amount' in (rows[0] ?? {}), false, '新浪日 K 无成交额列');
  assert.equal(klineDayToTradeDate('2026-10-23'), '2026-10-23');
  assert.equal(klineDayToTradeDate('2026-10-23 15:00:00'), '2026-10-23', '带时间后缀仍取日期');
  assert.equal(klineDayToTradeDate(''), null);
});

test('解析·K线：无 var data= 锚或内体非数组 → 具名瞬态错误', () => {
  assert.throws(() => parseKlineResponse(new TextEncoder().encode('var other=([1]);')), TransientAdapterError);
  assert.throws(
    () => parseKlineResponse(new TextEncoder().encode('var data=({"x":1})')),
    TransientAdapterError,
  );
});

// ===== 代码归一（与 BaoStock 同形）=====

test('归一：任意形态代码 → BaoStock 形（subjectId 裸 6 位）', () => {
  assert.equal(toNormalizedCode('513330'), 'sh.513330');
  assert.equal(toNormalizedCode('sh.513330'), 'sh.513330');
  assert.equal(toNormalizedCode('sh513330'), 'sh.513330');
  assert.equal(toNormalizedCode('159901'), 'sz.159901');
  assert.equal(toNormalizedCode('sz159901'), 'sz.159901');
  assert.equal(toSinaSymbol('sh.513330'), 'sh513330');
  assert.equal(toSinaSymbol('sz.159901'), 'sz159901');
  assert.deepEqual(classifySubjectLikeBaoStock('sh.513330'), { subjectType: 'ETF', subjectId: '513330' });
  assert.deepEqual(classifySubjectLikeBaoStock('sh.601919'), { subjectType: 'STOCK', subjectId: '601919' });
  assert.throws(() => toNormalizedCode('abc'), AdapterError);
});

// ===== 事实映射（纯函数）=====

const MAP_CTX = { adapterVersion: SINA_ADAPTER_VERSION, fetchedAt: FETCHED_AT, artifactSha256: 'b'.repeat(64) };

test('映射·报价：SINA_QUOTE（快照类，availableAt=抓取时刻；factId 含观察时刻）', () => {
  const lines = parseQuoteResponse(QUOTE_BYTES);
  const symbolToBs = new Map(lines.map((l) => [l.symbol, toNormalizedCode(l.symbol)]));
  const { facts, rejections } = mapQuoteLinesToFacts(lines, symbolToBs, MAP_CTX);
  assert.deepEqual(rejections, []);
  assert.equal(facts.length, 4);
  const f513330 = facts.find((m) => m.fact.subjectId === '513330')?.fact;
  assert.notEqual(f513330, undefined);
  assert.equal(f513330?.subjectType, 'ETF');
  assert.equal(f513330?.factKind, 'SINA_QUOTE');
  assert.equal(f513330?.availableAt, FETCHED_AT, '快照类：availableAt=抓取时刻');
  assert.equal(f513330?.firstObservedAt, FETCHED_AT);
  assert.equal(f513330?.validFrom, null, '快照无声明效力窗');
  assert.equal(f513330?.sourcePublishedAt, null);
  assert.equal(f513330?.eventAt, new Date('2026-10-23T15:34:59+08:00').toISOString(), 'eventAt=来源自述报价时刻+08');
  assert.equal(f513330?.supersedesFactId, null, '快照类不接 supersedes 链');
  const tv = f513330?.typedValue as Record<string, unknown>;
  assert.equal(tv.code, 'sh.513330', '归一代码与 BaoStock 同形');
  assert.equal(tv.sinaSymbol, 'sh513330');
  assert.equal(tv.volume, '8285704811');
  assert.equal((tv.rawFields as string[]).length, 34, 'typedValue 保留全位原样字段');
  assert.equal(f513330?.adapterVersion, 'sina@p1');
  assert.equal(f513330?.artifactSha256, 'b'.repeat(64));
  // factId 确定性：同观察时刻同内容重映射 → 同 factId；观察时刻变化 → 新 factId（快照=新观察）
  const again = mapQuoteLinesToFacts(lines, symbolToBs, MAP_CTX);
  assert.equal(again.facts[0]?.fact.factId, facts[0]?.fact.factId);
  const later = mapQuoteLinesToFacts(lines, symbolToBs, { ...MAP_CTX, fetchedAt: '2026-10-25T03:00:00.000Z' });
  assert.notEqual(later.facts[0]?.fact.factId, facts[0]?.fact.factId, '抓取时刻变化 → 新观察事实');
  assert.equal(later.facts[0]?.fact.availableAt, '2026-10-25T03:00:00.000Z');
});

test('映射·报价：空串行与缺位行具名拒绝，不产生事实', () => {
  const { facts, rejections } = mapQuoteLinesToFacts(
    [
      { symbol: 'sh999999', fields: [''] },
      { symbol: 'sh888888', fields: ['x', '1.0', ''] },
    ],
    new Map([
      ['sh999999', 'sh.999999'],
      ['sh888888', 'sh.888888'],
    ]),
    MAP_CTX,
  );
  assert.deepEqual(facts, []);
  assert.deepEqual(rejections, [
    { symbol: 'sh999999', code: 'SINA_QUOTE_EMPTY' },
    { symbol: 'sh888888', code: 'SINA_QUOTE_FIELDS_TOO_FEW' },
  ]);
});

test('映射·K线：DAILY_BAR_SINA（availableAt=交易日 15:00+08；factId 不含观察时刻）', () => {
  const rows = parseKlineResponse(KLINE_BYTES);
  const { facts, rejections } = mapKlineRowsToFacts(rows, 'sh.513330', MAP_CTX);
  assert.deepEqual(rejections, []);
  assert.equal(facts.length, 4);
  const last = facts[3];
  assert.equal(last?.objectKey, '2026-10-23', '对象键=交易日');
  const f = last?.fact;
  assert.equal(f?.subjectType, 'ETF');
  assert.equal(f?.subjectId, '513330');
  assert.equal(f?.factKind, 'DAILY_BAR_SINA');
  const close = new Date('2026-10-23T15:00:00+08:00').toISOString();
  assert.equal(f?.availableAt, close, 'availableAt=交易日 15:00 Asia/Shanghai');
  assert.equal(f?.eventAt, close);
  assert.equal(f?.validFrom, close);
  assert.equal(f?.firstObservedAt, FETCHED_AT);
  assert.equal(f?.supersedesFactId, null, '已终局窗口不接链：来源改值并行并存');
  const tv = f?.typedValue as Record<string, unknown>;
  assert.equal(tv.code, 'sh.513330');
  assert.equal(tv.day, '2026-10-23', '原始字段保留');
  assert.equal(tv.volume, '8285704811');
  assert.equal(tv.scale, '240');
  // factId 稳定：重放（同行同版本）→ 同 factId；观察时刻不影响（去重不受抓取时间漂移干扰）
  const again = mapKlineRowsToFacts(rows, 'sh.513330', { ...MAP_CTX, fetchedAt: '2026-10-26T02:00:00.000Z' });
  assert.equal(again.facts[3]?.fact.factId, f?.factId);
});

test('映射·K线：坏日期行具名拒绝', () => {
  const { facts, rejections } = mapKlineRowsToFacts(
    [{ day: '', open: '1', high: '1', low: '1', close: '1', volume: '1' }],
    'sh.513330',
    MAP_CTX,
  );
  assert.deepEqual(facts, []);
  assert.deepEqual(rejections, [{ day: '', code: 'DAILY_BAR_SINA_DATE_MISSING' }]);
});

// ===== 适配器（fixture 注入 + 隔离 schema DB）=====

let admin: Pool;
let pool: Pool;
let schema: string;
let artifactsDir: string;
let store: ArtifactStore;

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w9-sina-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
});

function makeAdapter(fetcher: SinaFetcher, extra?: { now?: () => Date; baseDelayMs?: number }): SinaAdapter {
  return new SinaAdapter({
    pool,
    store,
    fetcher,
    now: extra?.now ?? NOW,
    backoffSleeper: instantSleeper,
    backoffAttempts: 3,
    backoffBaseDelayMs: extra?.baseDelayMs,
  });
}

test('适配器·报价：一次批量请求 + GBK 原字节原件入库 + 事实落库 + 定时重放幂等', async () => {
  const urls: string[] = [];
  const fetcher: SinaFetcher = async (url) => {
    urls.push(url);
    return QUOTE_BYTES;
  };
  const adapter = makeAdapter(fetcher);
  const r = await adapter.fetchQuote(QUOTE_CODES);
  assert.equal(r.adapterVersion, 'sina@p1');
  assert.equal(r.source, 'sina');
  assert.equal(r.resource, 'quote');
  assert.equal(urls.length, 1, '四样本一批 = 一次请求');
  assert.equal(urls[0], 'https://hq.sinajs.cn/list=sh513330,sz159901,sh601919,sh600519');
  assert.equal(r.scope, 'sina:quote:sh513330,sz159901,sh601919,sh600519');
  assert.equal(r.rowCount, 4);
  assert.equal(r.insertedFactIds.length, 4);
  assert.equal(r.identicalFactIds.length, 0);
  assert.deepEqual(r.rejectedRows, []);
  assert.deepEqual(r.notices, [BACKFILL_REVISION_NOTICE], 'R4 修订口径声明随行');
  // 原件：GBK 原字节照存（哈希校验读回逐字节一致）
  const bytes = await store.readBytes(r.artifact.sha256);
  assert.deepEqual(Array.from(bytes), Array.from(QUOTE_BYTES), 'GBK 原始字节不改码不重排');
  assert.equal(r.artifact.mediaType, 'application/javascript; charset=gbk');
  assert.equal(r.artifact.firstObservedAt, FETCHED_AT);
  // 定时重放（同一 NOW → 同 factId 同 availableAt）→ IDENTICAL 去重
  const replay = await adapter.fetchQuote(QUOTE_CODES);
  assert.equal(replay.insertedFactIds.length, 0);
  assert.equal(replay.identicalFactIds.length, 4);
});

test('适配器·报价：新观察时刻 → 新事实插入（快照类累积，不冲突不覆盖）', async () => {
  let tick = 1;
  const adapter = makeAdapter(async () => QUOTE_BYTES, {
    now: () => new Date(Date.parse('2026-10-25T02:00:00.000Z') + tick * 60_000),
  });
  const r1 = await adapter.fetchQuote(QUOTE_CODES); // 02:01 观察
  tick = 2;
  const r2 = await adapter.fetchQuote(QUOTE_CODES); // 02:02 观察
  assert.equal(r1.insertedFactIds.length, 4, '02:01 观察 = 新事实');
  assert.equal(r2.insertedFactIds.length, 4, 'availableAt=抓取时刻随观察推进 → 新 factId');
  assert.equal(r2.identicalFactIds.length, 0);
  assert.deepEqual(
    r1.insertedFactIds.filter((id) => r2.insertedFactIds.includes(id)),
    [],
    '两次观察 factId 不相交',
  );
  const facts = await asOfFacts(pool, {
    subjectType: 'ETF',
    subjectId: '513330',
    factKind: 'SINA_QUOTE',
    asOf: new Date('2026-10-25T03:30:00.000Z'),
  });
  const availableAts = facts.map((f) => f.availableAt).sort();
  assert.ok(availableAts.includes('2026-10-25T02:01:00.000Z'), '02:01 观察可见');
  assert.ok(availableAts.includes('2026-10-25T02:02:00.000Z'), '02:02 观察可见');
  for (const f of facts) {
    assert.ok(
      new Date(f.availableAt).getTime() <= new Date('2026-10-25T03:30:00.000Z').getTime(),
      'available_at ≤ 截点（无泄漏）',
    );
  }
});

test('适配器·报价：未知代码空串行具名拒绝，有效行照常入库', async () => {
  const bytes = Uint8Array.from(
    Buffer.concat([Buffer.from(QUOTE_GBK_B64, 'base64'), Buffer.from('var hq_str_sh999999="";\n', 'utf8')]),
  );
  const adapter = makeAdapter(async () => bytes, {
    now: () => new Date('2026-10-25T05:00:00.000Z'), // 独立观察时刻：与本文件早前插入的事实不相交
  });
  const r = await adapter.fetchQuote([...QUOTE_CODES, 'sh999999']);
  assert.equal(r.rowCount, 5);
  assert.equal(r.insertedFactIds.length, 4);
  assert.equal(r.identicalFactIds.length, 0);
  assert.deepEqual(r.rejectedRows, [{ symbol: 'sh999999', code: 'SINA_QUOTE_EMPTY' }]);
});

test('适配器·K线：一次请求 + 原件入库 + 事实落库 + as-of 泄漏边界 + 定时重放幂等', async () => {
  const urls: string[] = [];
  const adapter = makeAdapter(async (url) => {
    urls.push(url);
    return KLINE_BYTES;
  });
  const r = await adapter.fetchDailyBars('513330', 15);
  assert.equal(r.resource, 'daily_kline');
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20data=/CN_MarketDataService.getKLineData' +
      '?symbol=sh513330&scale=240&ma=no&datalen=15',
  );
  assert.equal(r.scope, 'sina:daily_kline:sh.513330:15');
  assert.equal(r.rowCount, 4);
  assert.equal(r.insertedFactIds.length, 4);
  assert.deepEqual(r.rejectedRows, []);
  const bytes = await store.readBytes(r.artifact.sha256);
  assert.equal(new TextDecoder('gbk').decode(bytes), KLINE_JSONP, 'JSONP 原文字节照存');
  // as-of：10-23 收盘前不见当日，收盘后全见（无未来泄漏）
  const datesAt = async (asOf: string): Promise<string[]> => {
    const facts = await asOfFacts(pool, {
      subjectType: 'ETF',
      subjectId: '513330',
      factKind: 'DAILY_BAR_SINA',
      asOf: new Date(asOf),
    });
    for (const f of facts) {
      assert.ok(new Date(f.availableAt).getTime() <= new Date(asOf).getTime(), 'available_at ≤ 截点');
    }
    return facts.map((f) => String((f.typedValue as Record<string, unknown>).day).slice(0, 10)).sort();
  };
  const before = await datesAt('2026-10-23T06:59:59.000Z');
  assert.deepEqual(before, ['2026-10-20', '2026-10-21', '2026-10-22']);
  const after = await datesAt('2026-10-23T07:00:00.000Z');
  assert.deepEqual(after, ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  // 定时重放 → IDENTICAL（已终局窗口同键去重）
  const replay = await adapter.fetchDailyBars('sh513330', 15);
  assert.equal(replay.insertedFactIds.length, 0);
  assert.equal(replay.identicalFactIds.length, 4);
  assert.equal(replay.artifact.sha256, r.artifact.sha256, '重放同字节 → 同哈希原件（CAS 幂等）');
});

test('适配器·K线：坏日期行拒绝照常入库其余行', async () => {
  const badRow = '{"day":"","open":"1.0","high":"1.0","low":"1.0","close":"1.0","volume":"1"}';
  const jsonp = `var data=([${badRow},{"day":"2026-10-23","open":"1.0","high":"1.0","low":"1.0","close":"1.0","volume":"2"}]);`;
  const adapter = makeAdapter(async () => new TextEncoder().encode(jsonp));
  const r = await adapter.fetchDailyBars('sh.510300', 5);
  assert.equal(r.insertedFactIds.length, 1);
  assert.deepEqual(r.rejectedRows, [{ day: '', code: 'DAILY_BAR_SINA_DATE_MISSING' }]);
});

test('适配器·瞬态错误退避：两次瞬态后成功（等待序列 30s/60s），永久错误立即抛出', async () => {
  const waits: number[] = [];
  let calls = 0;
  const sleeperAdapter = new SinaAdapter({
    pool,
    store,
    fetcher: async () => {
      calls += 1;
      if (calls <= 2) throw new TransientAdapterError('SINA_HTTP_STATUS', 'HTTP 456');
      return KLINE_BYTES;
    },
    now: NOW,
    backoffSleeper: { sleep: async (ms: number) => void waits.push(ms) },
    backoffAttempts: 3,
  });
  const r = await sleeperAdapter.fetchDailyBars('sh.600000', 5);
  assert.equal(r.insertedFactIds.length, 4, 'fixture 四行全部落库（subject=600000，本文件未插入过）');
  assert.deepEqual(waits, [30_000, 60_000], '首次约 30 秒逐次加倍（DATA-SOURCES §7）');
  assert.equal(calls, 3, '同一调用至多 3 次尝试内恢复');
  // 永久错误不重试
  const pCalls: number[] = [];
  const pAdapter = makeAdapter(async () => {
    pCalls.push(1);
    throw new AdapterError('SINA_DATALEN_INVALID', 'permanent');
  });
  await assert.rejects(() => pAdapter.fetchDailyBars('sh.600001', 5), AdapterError);
  assert.equal(pCalls.length, 1);
});

test('适配器·持续瞬态失败：暂停上报（四要素落库），恢复后 RESUMED', async () => {
  const adapter = makeAdapter(async () => {
    throw new TransientAdapterError('SINA_TIMEOUT', '超过 30000ms');
  });
  await assert.rejects(
    () => adapter.fetchQuote(QUOTE_CODES),
    (e: unknown) => e instanceof AdapterError && e.name === 'AdapterPauseError',
  );
  const reports = await loadPauseReports(pool, 'sina');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.status, 'PAUSED');
  assert.equal(reports[0]?.retries, 3);
  assert.match(reports[0]?.last_error ?? '', /^SINA_TIMEOUT/);
  assert.match(reports[0]?.scope ?? '', /^sina:quote:/);
  // 恢复：同 scope 成功 → RESUMED（从断点继续）
  const okAdapter = makeAdapter(async () => QUOTE_BYTES);
  await okAdapter.fetchQuote(QUOTE_CODES);
  const after = await loadPauseReports(pool, 'sina');
  assert.equal(after[0]?.status, 'RESUMED');
});

test('适配器·参数边界：空代码表/超批量/坏 datalen 具名拒绝且不发请求', async () => {
  let calls = 0;
  const adapter = makeAdapter(async () => {
    calls += 1;
    return QUOTE_BYTES;
  });
  await assert.rejects(() => adapter.fetchQuote([]), (e: unknown) => {
    return e instanceof AdapterError && (e as AdapterError).code === 'SINA_CODES_EMPTY';
  });
  await assert.rejects(
    () => adapter.fetchQuote(Array.from({ length: 51 }, () => '600519')),
    (e: unknown) => e instanceof AdapterError && (e as AdapterError).code === 'SINA_QUOTE_BATCH_TOO_LARGE',
  );
  await assert.rejects(() => adapter.fetchDailyBars('600519', 0), AdapterError);
  await assert.rejects(() => adapter.fetchDailyBars('600519', 2001), AdapterError);
  await assert.rejects(() => adapter.fetchDailyBars('600519', 2.5), AdapterError);
  assert.equal(calls, 0, '参数错误不发起任何真实请求');
});

// ===== 与 BaoStock DAILY_BAR 互证 =====

function mkBsBar(date: string, o: string, h: string, l: string, c: string, v: string, a: string): TimePointFact {
  return {
    factId: `bs-${date}`,
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DAILY_BAR',
    typedValue: { date, open: o, high: h, low: l, close: c, volume: v, amount: a, preclose: c },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: FETCHED_AT,
    availableAt: new Date(`${date}T15:00:00+08:00`).toISOString(),
    supersedesFactId: null,
    artifactSha256: 'c'.repeat(64),
    adapterVersion: 'baostock@0.9.40-p1',
  };
}

function mkSinaBar(date: string, o: string, h: string, l: string, c: string, v: string): TimePointFact {
  return {
    factId: `sina-${date}`,
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DAILY_BAR_SINA',
    typedValue: { code: 'sh.600519', sinaSymbol: 'sh600519', scale: '240', day: date, open: o, high: h, low: l, close: c, volume: v },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: FETCHED_AT,
    availableAt: new Date(`${date}T15:00:00+08:00`).toISOString(),
    supersedesFactId: null,
    artifactSha256: 'd'.repeat(64),
    adapterVersion: SINA_ADAPTER_VERSION,
  };
}

const BS_BARS = [
  mkBsBar('2026-10-21', '15.820', '16.000', '15.700', '15.900', '83000000', '1310000000.00'),
  mkBsBar('2026-10-22', '15.830', '16.010', '15.710', '15.910', '84000000', '1320000000.00'),
  mkBsBar('2026-10-23', '15.730', '16.120', '15.680', '15.850', '85366601', '1355304626.00'),
];
const SINA_BARS_SAME = [
  mkSinaBar('2026-10-21', '15.820', '16.000', '15.700', '15.900', '83000000'),
  mkSinaBar('2026-10-22', '15.830', '16.010', '15.710', '15.910', '84000000'),
  mkSinaBar('2026-10-23', '15.730', '16.120', '15.680', '15.850', '85366601'),
];

test('互证：逐日 OHLCV 一致 → consistent，amount 因新浪无额列跳过并计数', () => {
  const report = crossCheckBars(BS_BARS, SINA_BARS_SAME);
  assert.equal(report.bsFactCount, 3);
  assert.equal(report.sinaFactCount, 3);
  assert.deepEqual(report.matchedDates, ['2026-10-21', '2026-10-22', '2026-10-23']);
  assert.deepEqual(report.missingInSina, []);
  assert.deepEqual(report.missingInBs, []);
  assert.deepEqual(report.diffs, []);
  assert.equal(report.amountSkippedDates, 3, '新浪日 K 无额字段：3 个交集日全部跳过 amount');
  assert.equal(report.consistent, true);
});

test('互证：价格超容差 → 差异条目（字段/日期/双原文/相对差），consistent=false', () => {
  const sinaOff = [mkSinaBar('2026-10-21', '15.820', '16.000', '15.700', '15.900', '83000000')];
  const bsOff = [mkBsBar('2026-10-21', '15.820', '16.000', '15.700', '15.950', '83000000', '1.00')];
  const report = crossCheckBars(bsOff, sinaOff);
  assert.equal(report.consistent, false);
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0]?.field, 'close');
  assert.equal(report.diffs[0]?.date, '2026-10-21');
  assert.equal(report.diffs[0]?.bsValue, '15.950');
  assert.equal(report.diffs[0]?.sinaValue, '15.900');
  assert.ok(Math.abs((report.diffs[0]?.relDiff ?? 1) - 0.05 / 15.95) < 1e-12);
  // 容差内小差异不算差异（relDiff ≈ 1e-10 < 1e-6）；两源同值不同精度也不算
  const ok = crossCheckBars(
    [mkBsBar('2026-10-21', '1000000.0001', '16.0000', '15.7000', '15.9000', '83000000', '1')],
    [mkSinaBar('2026-10-21', '1000000.000', '16.000', '15.700', '15.900', '83000000')],
  );
  assert.equal(ok.consistent, true);
});

test('互证：成交量量纲比与双向缺失；空输入不抛错', () => {
  // bs=股, sina=手（假设）→ ratio=100 时一致
  const bs = [mkBsBar('2026-10-21', '1', '1', '1', '1', '100', '1')];
  const sinaLots = [mkSinaBar('2026-10-21', '1', '1', '1', '1', '1')];
  const strict = crossCheckBars(bs, sinaLots);
  assert.equal(strict.consistent, false, '默认 ratio=1：量纲不同即差异');
  assert.equal(strict.diffs[0]?.field, 'volume');
  const ratioOpt: CrossCheckOptions = { volumeUnitRatio: 100 };
  const withRatio = crossCheckBars(bs, sinaLots, ratioOpt);
  assert.equal(withRatio.consistent, true, 'bs = sina × 100 量纲换算后一致');
  // 双向缺失
  const missSina = crossCheckBars(BS_BARS, SINA_BARS_SAME.slice(0, 2));
  assert.deepEqual(missSina.missingInSina, ['2026-10-23']);
  assert.equal(missSina.consistent, false);
  const missBs = crossCheckBars(BS_BARS.slice(0, 2), SINA_BARS_SAME);
  assert.deepEqual(missBs.missingInBs, ['2026-10-23']);
  // 空输入：不抛错，空报告
  const empty = crossCheckBars([], []);
  assert.deepEqual(empty.comparedDates, []);
  assert.equal(empty.consistent, true);
});
