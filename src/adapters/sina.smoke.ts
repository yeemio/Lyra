/**
 * Lyra · 新浪行情适配器真实冒烟（P1 W9；Owner 数据源指令：新浪为行情第二源，与 BaoStock 互证）。
 *
 * 有界真实请求 4 个（≤6 预算）：
 * 1. 新浪批量报价一批（sh513330, sz159901, sh601919, sh600519 四样本，一次请求）；
 * 2. 新浪日 K sh513330（跨境 ETF，datalen=15，一次请求）；
 * 3. 新浪日 K sh510300（宽基 ETF，datalen=15，一次请求）；
 * 4. BaoStock sh510300 日线（2026-09-25 起窗口）——库内此前无 510300 BaoStock K 线（public 库
 *    DAILY_BAR 仅 604 只股票），冒烟按派发互证目标补取一次（桥调用 = 1 请求），后续互证可直接读库。
 * 另有一段零请求互证：sh600519 报价快照 vs 库内 BaoStock 2026-10-23 日线（OHLCV 逐字段比对）。
 *
 * 断言：GBK/JSONP 原始字节原件入库（哈希校验读回逐字节一致）+ 事实落库
 * （SINA_QUOTE availableAt=抓取时刻；DAILY_BAR_SINA availableAt=交易日 15:00+08）+
 * as-of 读回无泄漏 + 互证差异报告（crossCheckBars 输出差异不抛错）。
 *
 * 运行：node --import tsx src/adapters/sina.smoke.ts
 * 目标库：默认 public schema（createPool 默认 search_path）；p1-migration 幂等应用。
 * 原件目录：env LYRA_ARTIFACTS_DIR，缺省 <repo>/data/artifacts（R24 冻结根）。
 */
import { asOfFacts } from '../pintime/facts.js';
import { applySchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import type { TimePointFact } from '../contracts.js';
import { BaoStockAdapter } from './baostock.js';
import {
  SinaAdapter,
  crossCheckBars,
  makeRealSinaFetcher,
  type CrossCheckReport,
  type SinaFetcher,
} from './sina.js';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const QUOTE_CODES = ['sh513330', 'sz159901', 'sh601919', 'sh600519'];
const CROSS_CODE = 'sh.510300'; // 互证标的（宽基 ETF）
const BS_WINDOW_START = '2026-09-25';

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data/artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  // 真实请求计数：新浪 fetcher 包装计数 + BaoStock 桥调用计数
  let sinaRequests = 0;
  const realFetcher = makeRealSinaFetcher();
  const countingFetcher: SinaFetcher = async (url) => {
    sinaRequests += 1;
    return await realFetcher(url);
  };
  const sina = new SinaAdapter({ pool, store, fetcher: countingFetcher });
  const baostock = new BaoStockAdapter({ pool, store });
  let baostockRequests = 0;

  // ---- 新浪请求 1：四样本批量报价（一次请求）----
  const quote = await sina.fetchQuote(QUOTE_CODES);
  if (quote.rowCount !== QUOTE_CODES.length) {
    throw new Error(`报价行数不符：${String(quote.rowCount)} ≠ ${String(QUOTE_CODES.length)}`);
  }
  if (quote.rejectedRows.length !== 0) {
    throw new Error(`报价出现拒绝行：${JSON.stringify(quote.rejectedRows)}`);
  }
  if (quote.insertedFactIds.length !== QUOTE_CODES.length) {
    throw new Error(
      `报价事实插入数不符：inserted=${String(quote.insertedFactIds.length)} identical=${String(quote.identicalFactIds.length)}`,
    );
  }

  // ---- 新浪请求 2/3：K 线（513330 跨境 ETF / 510300 宽基 ETF）----
  const k513330 = await sina.fetchDailyBars('sh513330', 15);
  const k510300 = await sina.fetchDailyBars(CROSS_CODE, 15);
  for (const r of [k513330, k510300]) {
    if (r.rowCount < 10) throw new Error(`${r.scope} K 线行数过少：${String(r.rowCount)}`);
    if (r.rejectedRows.length !== 0) throw new Error(`${r.scope} 出现拒绝行：${JSON.stringify(r.rejectedRows)}`);
  }

  // ---- BaoStock 请求 1：sh510300 日线（互证基准；库内无则补取，此后互证直接读库）----
  const existingBs = await asOfFacts(pool, {
    subjectType: 'ETF',
    subjectId: '510300',
    factKind: 'DAILY_BAR',
    asOf: new Date(),
  });
  let bsSource: 'db' | 'fetched';
  if (existingBs.length === 0) {
    const bs = await baostock.fetchDailyBars(CROSS_CODE, BS_WINDOW_START, '2026-10-25');
    baostockRequests += 1;
    if (bs.rowCount === 0) throw new Error(`BaoStock 510300 窗口无行：${bs.scope}`);
    bsSource = 'fetched';
  } else {
    bsSource = 'db';
  }

  // ---- 原件读回：哈希校验 + 原始字节一致（GBK/JSONP 原样）----
  const requestReports: Record<string, unknown>[] = [];
  for (const r of [quote, k513330, k510300]) {
    const bytes = await store.readBytes(r.artifact.sha256); // 哈希不符即抛 HASH_MISMATCH
    if (bytes.length !== r.artifact.bytes) throw new Error(`原件字节数不符：${r.scope}`);
    requestReports.push({
      resource: r.resource,
      params: r.params,
      scope: r.scope,
      rowCount: r.rowCount,
      artifact: { sha256: r.artifact.sha256, bytes: r.artifact.bytes, firstObservedAt: r.artifact.firstObservedAt },
      insertedFacts: r.insertedFactIds.length,
      identicalFacts: r.identicalFactIds.length,
      rejectedRows: r.rejectedRows,
      notices: r.notices,
    });
  }

  // ---- 时点断言：报价 availableAt=抓取时刻；日 K availableAt=交易日 15:00+08；as-of 无泄漏 ----
  const nowMs = Date.now();
  const quoteFacts = await asOfFacts(pool, {
    subjectType: 'ETF',
    subjectId: '513330',
    factKind: 'SINA_QUOTE',
    asOf: new Date(nowMs),
  });
  if (quoteFacts.length === 0) throw new Error('513330 报价事实 as-of 读回为空');
  for (const f of quoteFacts) {
    if (Math.abs(new Date(f.availableAt).getTime() - Date.parse(f.firstObservedAt)) > 1) {
      throw new Error(`SINA_QUOTE availableAt ≠ 抓取时刻：${f.availableAt} vs ${f.firstObservedAt}`);
    }
  }
  const barFacts = await asOfFacts(pool, {
    subjectType: 'ETF',
    subjectId: '510300',
    factKind: 'DAILY_BAR_SINA',
    asOf: new Date(nowMs),
  });
  if (barFacts.length < 10) throw new Error(`510300 新浪日 K 事实过少：${String(barFacts.length)}`);
  for (const f of barFacts) {
    const day = String((f.typedValue as Record<string, unknown>).day).slice(0, 10);
    const expect = new Date(`${day}T15:00:00+08:00`).toISOString();
    if (f.availableAt !== expect) throw new Error(`DAILY_BAR_SINA availableAt ≠ 15:00+08：${f.availableAt}`);
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：available_at 在当前时刻之后');
  }

  // ---- 互证 1：510300 新浪日 K vs 库内 BaoStock 日线（OHLCV 逐日容差比对；amount 缺口跳过计数）----
  // 互证段限定在新浪 15 根的共同窗口（库内 BaoStock 为 2012 起全史，窗口外按覆盖差如实计数）。
  const bsFactsAll = await asOfFacts(pool, {
    subjectType: 'ETF',
    subjectId: '510300',
    factKind: 'DAILY_BAR',
    asOf: new Date(nowMs),
  });
  const sinaDates = new Set(barFacts.map((f) => String((f.typedValue as Record<string, unknown>).day).slice(0, 10)));
  const bsFacts = bsFactsAll.filter((f) => sinaDates.has(String((f.typedValue as Record<string, unknown>).date)));
  const cross510300: CrossCheckReport = crossCheckBars(bsFacts, barFacts);
  const bsOutsideWindow = bsFactsAll.length - bsFacts.length;

  // ---- 互证 2（零请求）：sh600519 报价快照 vs 库内 BaoStock 当日日线 ----
  const maotaiQuote = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'SINA_QUOTE',
    asOf: new Date(nowMs),
  });
  const tv = (maotaiQuote[0]?.typedValue ?? {}) as Record<string, unknown>;
  const quoteDate = String(tv.date ?? '');
  const quoteVsBar = {
    date: quoteDate,
    quote: { open: tv.open, preclose: tv.preclose, high: tv.high, low: tv.low, current: tv.current, volume: tv.volume, amount: tv.amount },
  };
  let maotaiCross: Pick<CrossCheckReport, 'diffs' | 'consistent' | 'matchedDates'> | null = null;
  if (typeof quoteDate === 'string' && quoteDate.length === 10) {
    const bsMaotai = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '600519',
      factKind: 'DAILY_BAR',
      asOf: new Date(nowMs),
    });
    const sameDay = bsMaotai.filter((f) => (f.typedValue as Record<string, unknown>).date === quoteDate);
    if (sameDay.length === 1) {
      // 报价快照 → 当日 OHLCV 形态（close=current；新浪报价无独立 close 列，用现价）
      const pseudo: TimePointFact = {
        factId: 'smoke-quote-pseudo',
        subjectType: 'STOCK',
        subjectId: '600519',
        factKind: 'DAILY_BAR_SINA',
        typedValue: {
          code: 'sh.600519',
          sinaSymbol: 'sh600519',
          day: quoteDate,
          open: tv.open,
          high: tv.high,
          low: tv.low,
          close: tv.current,
          volume: tv.volume,
        },
        validFrom: null,
        validTo: null,
        eventAt: null,
        sourcePublishedAt: null,
        firstObservedAt: String(maotaiQuote[0]?.firstObservedAt ?? ''),
        availableAt: String(maotaiQuote[0]?.availableAt ?? ''),
        supersedesFactId: null,
        artifactSha256: maotaiQuote[0]?.artifactSha256 ?? '',
        adapterVersion: maotaiQuote[0]?.adapterVersion ?? '',
      };
      const r = crossCheckBars(sameDay, [pseudo]);
      maotaiCross = { diffs: r.diffs, consistent: r.consistent, matchedDates: r.matchedDates };
    }
  }

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: quote.adapterVersion,
    realRequests: { sina: sinaRequests, baostock: baostockRequests, total: sinaRequests + baostockRequests },
    requests: requestReports,
    quoteFacts: {
      count: quoteFacts.length,
      sample: {
        subjectType: quoteFacts[0]?.subjectType,
        subjectId: quoteFacts[0]?.subjectId,
        availableAt: quoteFacts[0]?.availableAt,
        eventAt: quoteFacts[0]?.eventAt,
      },
    },
    klineFacts: { sh513330: k513330.insertedFactIds.length, sh510300: k510300.insertedFactIds.length },
    crossCheck510300: {
      bsSource,
      bsFactsAllCount: bsFactsAll.length,
      bsFactsOutsideWindow: bsOutsideWindow,
      ...cross510300,
    },
    quoteVsBaostock600519: { ...quoteVsBar, cross: maotaiCross },
  }, null, 2));
  await pool.end();
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error('SMOKE FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
