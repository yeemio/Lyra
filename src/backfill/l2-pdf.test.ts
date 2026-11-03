/**
 * Lyra · L2 公告 PDF 回填 runner 单测（P1 后置面 W21: code-writer）。不碰外网：
 * 分类/候选选择为纯函数；下载经 fetchImpl/sleepImpl 注入（模式同 src/adapters/backoff.test.ts）；
 * DB 用隔离 schema（本地 lyra-pg），原件入临时目录 ArtifactStore。
 * 合同判定：DATA-SOURCES §4 L2（分层）、§7（节流 + 30s/60s/120s 退避、暂停上报落库）、
 * 断点续跑（fact_id 幂等，重跑跳过 DONE）、adjunctUrl 为空的行跳过登记。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { applyP1Migration, loadPauseReports } from '../adapters/backoff.js';
import { CNINFO_ADAPTER_VERSION, pdfUrlOf } from '../adapters/cninfo.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import type { TimePointFact } from '../contracts.js';
import {
  applyL2Migration,
  classifyTier,
  computeTierStats,
  isPdfBytes,
  L2PdfBackfill,
  l2PauseScope,
  loadAnnouncementIndex,
  loadPdfState,
  selectTierCandidates,
  upsertPdfState,
  type AnnouncementIndexRow,
} from './l2-pdf.js';

const SCHEMA = `w21_l2_${Math.random().toString(36).slice(2, 10)}`;
const FACTOR_MILLIS = 1_700_000_000_000; // 夹具公告时间基点（毫秒）

function shaOf(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** PDF 夹具：真实 %PDF- 头 + 填充；另一份内容不同（哈希不同）。 */
const PDF_A = Buffer.from(`%PDF-1.7\n${'A'.repeat(2048)}`, 'latin1');
const PDF_B = Buffer.from(`%PDF-1.4\n${'B'.repeat(1536)}`, 'latin1');
const PDF_C = Buffer.from(`%PDF-1.5\n${'C'.repeat(1024)}`, 'latin1');
const HTML_PAGE = Buffer.from('<!DOCTYPE html><html><body>blocked</body></html>', 'utf8');

function announcementFact(input: {
  announcementId: string;
  title: string;
  adjunctUrl?: string | undefined;
  offsetMs: number;
  secCode?: string;
}): TimePointFact {
  const iso = new Date(FACTOR_MILLIS + input.offsetMs).toISOString();
  const adjunctUrl = input.adjunctUrl === undefined ? '' : input.adjunctUrl;
  const secCode = input.secCode ?? '600519';
  return {
    factId: `cninfo:ann:${input.announcementId}@p1`,
    subjectType: 'STOCK',
    subjectId: secCode,
    factKind: 'ANNOUNCEMENT',
    typedValue: {
      title: input.title,
      adjunctUrl,
      announcementTime: FACTOR_MILLIS + input.offsetMs,
      announcementId: input.announcementId,
      secCode,
      secName: '夹具',
      announcementType: '',
      adjunctSize: null,
    },
    validFrom: null,
    validTo: null,
    eventAt: iso,
    sourcePublishedAt: iso,
    firstObservedAt: iso,
    availableAt: iso,
    supersedesFactId: null,
    artifactSha256: shaOf(input.announcementId),
    adapterVersion: CNINFO_ADAPTER_VERSION,
  };
}

/** 注入 fetch：按 URL 路由响应并记录请求序列（含每次退避重试）。 */
function makeFetch(respond: (url: string) => { status: number; body: Buffer }): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const { status, body } = respond(url);
    return new Response(new Uint8Array(body), { status, headers: { 'Content-Type': 'application/pdf' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 注入 sleep：记录等待序列并立即放行（节流与退避共用，秒级加速）。 */
function makeSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleepImpl: async (ms) => { waits.push(ms); } };
}

function makeRunner(injections: {
  pool: Pool;
  store: ArtifactStore;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}): L2PdfBackfill {
  return new L2PdfBackfill({
    pool: injections.pool,
    store: injections.store,
    fetchImpl: injections.fetchImpl,
    sleepImpl: injections.sleepImpl,
    throttleMs: 2_000,
    nowImpl: () => 1_760_000_000_000, // 固定观察时刻
  });
}

let admin: Pool;
let pool: Pool;
let artifactsDir: string;
let store: ArtifactStore;

before(async () => {
  admin = createPool();
  await applySchema(admin, SCHEMA);
  await applyP1Migration(admin, SCHEMA); // adapter_pause_report（暂停上报落库断言用）
  await applyL2Migration(admin, SCHEMA);
  pool = createPool({ schema: SCHEMA });
  artifactsDir = await mkdtemp(join(tmpdir(), 'l2-pdf-test-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await pool.end().catch(() => {});
  await dropSchema(admin, SCHEMA).catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
});

// ===== 纯函数 =====

test('classifyTier：三层关键词与优先级（派发冻结）', () => {
  // tier 1：预告/快报/更正（最高优先级，含同时命中多层关键词的标题）
  assert.equal(classifyTier('2025年度业绩预告'), 1);
  assert.equal(classifyTier('2024年业绩快报'), 1);
  assert.equal(classifyTier('关于2023年年度报告的更正公告'), 1);
  assert.equal(classifyTier('2022年年度业绩预告修正公告'), 1);
  // tier 2：定期报告（非摘要）
  assert.equal(classifyTier('2023年年度报告'), 2);
  assert.equal(classifyTier('2024年第一季度报告'), 2);
  assert.equal(classifyTier('2023年半年度报告'), 2);
  assert.equal(classifyTier('公司2023年报'), 2);
  assert.equal(classifyTier('2024年三季报'), 2);
  // "摘要"排除：定期报告摘要不属 tier 2，落入 tier 3
  assert.equal(classifyTier('2023年年度报告摘要'), 3);
  assert.equal(classifyTier('2024年第一季度报告摘要'), 3);
  // tier 3：其余
  assert.equal(classifyTier('关于召开2024年年度股东大会的通知'), 3);
  assert.equal(classifyTier('投资者关系活动记录表'), 3);
  assert.equal(classifyTier(''), 3);
});

test('isPdfBytes：%PDF- 头判定（拦截页拒绝入库）', () => {
  assert.equal(isPdfBytes(PDF_A), true);
  const junkPrefixed = Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from('%PDF-1.6\n', 'latin1')]);
  assert.equal(isPdfBytes(junkPrefixed), true); // 头部前 1024 字节内的少量前置噪声可容忍
  const lateHeader = Buffer.concat([Buffer.alloc(2048, 0x20), Buffer.from('%PDF-1.6\n', 'latin1')]);
  assert.equal(isPdfBytes(lateHeader), false); // 超出 1024 窗口：拒绝
  assert.equal(isPdfBytes(HTML_PAGE), false);
  assert.equal(isPdfBytes(new Uint8Array(0)), false);
});

test('l2PauseScope 与 pdfUrlOf：scope/URL 构造单一来源', () => {
  assert.equal(l2PauseScope('cninfo:ann:123@p1'), 'cninfo:announcement_pdf:cninfo:ann:123@p1');
  assert.equal(pdfUrlOf('finalpage/2025-01-05/a.PDF'), 'http://static.cninfo.com.cn/finalpage/2025-01-05/a.PDF');
  assert.equal(pdfUrlOf('/finalpage/2025-01-05/a.PDF'), 'http://static.cninfo.com.cn/finalpage/2025-01-05/a.PDF');
});

function indexRow(input: { factId: string; title: string; announcementTime: number; done?: boolean; adjunctUrl?: string }): AnnouncementIndexRow {
  return {
    factId: input.factId,
    subjectId: '600519',
    title: input.title,
    adjunctUrl: input.adjunctUrl ?? `finalpage/x/${input.factId}.PDF`,
    announcementTime: input.announcementTime,
    done: input.done ?? false,
  };
}

test('selectTierCandidates：倒序保持、跳过 DONE、tier 过滤、limit 截断', () => {
  const rows: AnnouncementIndexRow[] = [
    indexRow({ factId: 'f1', title: '2024年年度报告', announcementTime: 5_000, done: true }),
    indexRow({ factId: 'f2', title: '2025年度业绩预告', announcementTime: 4_000 }),
    indexRow({ factId: 'f3', title: '投资者关系活动记录表', announcementTime: 3_000 }),
    indexRow({ factId: 'f4', title: '2024年年度报告摘要', announcementTime: 2_000 }),
    indexRow({ factId: 'f5', title: '2023年度业绩快报', announcementTime: 1_000 }),
  ];
  const tier1 = selectTierCandidates(rows, 1);
  assert.deepEqual(tier1.map((row) => row.factId), ['f2', 'f5'], '跳过 DONE，公告时间倒序');
  const tier1Limited = selectTierCandidates(rows, 1, 1);
  assert.deepEqual(tier1Limited.map((row) => row.factId), ['f2'], 'limit 截断取最优先者');
  const tier3 = selectTierCandidates(rows, 3);
  assert.deepEqual(tier3.map((row) => row.factId), ['f3', 'f4'], '摘要类落 tier 3');
});

test('computeTierStats：分层合计与 pending/done', () => {
  const rows: AnnouncementIndexRow[] = [
    indexRow({ factId: 'a', title: '业绩预告', announcementTime: 3 }),
    indexRow({ factId: 'b', title: '业绩预告', announcementTime: 2, done: true }),
    indexRow({ factId: 'c', title: '年度报告', announcementTime: 1 }),
    indexRow({ factId: 'd', title: '年度报告摘要', announcementTime: 0, done: true }),
  ];
  const stats = computeTierStats(rows);
  assert.deepEqual(
    stats.map((entry) => ({ tier: entry.tier, total: entry.total, done: entry.done, pending: entry.pending })),
    [
      { tier: 1, total: 2, done: 1, pending: 1 },
      { tier: 2, total: 1, done: 0, pending: 1 },
      { tier: 3, total: 1, done: 1, pending: 0 },
    ],
  );
});

// ===== 集成（隔离 schema + 注入 fetch/sleep）=====

// 夹具事实（offsetMs 决定公告时间倒序；F6 最新）：
// F1 tier1 正常 PDF（a.PDF）；F2 tier1 空 adjunctUrl；F5 tier1 404（b.PDF）；F3 tier2 不参与 tier1；F6 tier1 瞬态 503（c.PDF）
const F1 = announcementFact({ announcementId: '9001', title: '2025年度业绩预告', adjunctUrl: 'finalpage/2025-01-05/a.PDF', offsetMs: 5_000 });
const F2 = announcementFact({ announcementId: '9002', title: '2024年度业绩快报（更正后）', offsetMs: 2_000 }); // 无 adjunctUrl
const F3 = announcementFact({ announcementId: '9003', title: '2024年年度报告', adjunctUrl: 'finalpage/2024-03-28/c.PDF', offsetMs: 4_000 });
const F5 = announcementFact({ announcementId: '9005', title: '2024年度业绩预告修正公告', adjunctUrl: '/finalpage/2024-02-15/b.PDF', offsetMs: 3_000 });
const F6 = announcementFact({ announcementId: '9006', title: '2025年第一季度业绩预告', adjunctUrl: 'finalpage/2025-04-10/c.PDF', offsetMs: 6_000 });

async function seedFacts(facts: TimePointFact[]): Promise<void> {
  for (const fact of facts) await insertFact(pool, fact);
}

test('首次运行 tier1：下载入库、空 URL 跳过登记、永久失败继续（DATA-SOURCES §4 L2）', async () => {
  await seedFacts([F1, F2, F3, F5]);
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.endsWith('/a.PDF')) return { status: 200, body: PDF_A };
    if (url.endsWith('/b.PDF')) return { status: 404, body: HTML_PAGE };
    return { status: 404, body: HTML_PAGE };
  });
  const { sleepImpl } = makeSleep();
  const runner = makeRunner({ pool, store, fetchImpl, sleepImpl });
  const summary = await runner.run(1);
  // 候选（公告时间倒序）：F1(5000) → F5(3000) → F2(2000)；F3 为 tier2 不参与
  assert.equal(summary.considered, 3);
  assert.equal(summary.downloaded, 1);
  assert.equal(summary.failedPermanent, 1);
  assert.equal(summary.skippedEmptyUrl, 1);
  assert.equal(summary.pause, null);
  assert.equal(summary.bytesTotal, PDF_A.length);
  // URL 构造：前导斜杠剥除 + 静态域前缀（派发要点 2/单测要点 URL 构造）
  assert.deepEqual(calls, ['http://static.cninfo.com.cn/finalpage/2025-01-05/a.PDF', 'http://static.cninfo.com.cn/finalpage/2024-02-15/b.PDF']);
  // 原件入 CAS：哈希读回一致（POINT-IN-TIME §9）
  const stateF1 = await loadPdfState(pool, F1.factId);
  assert.equal(stateF1?.status, 'DONE');
  assert.equal(stateF1?.pdfSha256, shaOf(PDF_A));
  assert.equal(stateF1?.bytes, PDF_A.length);
  const roundtrip = await store.readBytes(shaOf(PDF_A));
  assert.deepEqual(Buffer.from(roundtrip), PDF_A);
  // 永久失败登记 FAILED，错误具名
  const stateF5 = await loadPdfState(pool, F5.factId);
  assert.equal(stateF5?.status, 'FAILED');
  assert.ok(stateF5?.error?.includes('SOURCE_HTTP'), `应含 SOURCE_HTTP，得到 ${String(stateF5?.error)}`);
  assert.equal(stateF5?.pdfSha256, null);
  // 空 adjunctUrl：跳过登记（不静默）
  const stateF2 = await loadPdfState(pool, F2.factId);
  assert.equal(stateF2?.status, 'SKIPPED');
  assert.equal(stateF2?.error, 'EMPTY_ADJUNCT_URL');
  // tier2 事实不受 tier1 运行影响
  assert.equal(await loadPdfState(pool, F3.factId), null);
});

test('瞬态退避：30s/60s/120s 后暂停上报落库，本次运行中止（DATA-SOURCES §7 判定）', async () => {
  await seedFacts([F6]);
  const { fetchImpl, calls } = makeFetch(() => ({ status: 503, body: HTML_PAGE }));
  const { sleepImpl, waits } = makeSleep();
  const runner = makeRunner({ pool, store, fetchImpl, sleepImpl });
  const summary = await runner.run(1);
  // 候选倒序：F6(6000) 最先 → 瞬态耗尽 → 暂停即中止（F5/F2 本次不处理）
  assert.equal(summary.considered, 1);
  assert.equal(summary.downloaded, 0);
  assert.notEqual(summary.pause, null, '应暂停上报而非 FAILED');
  assert.equal(summary.pause?.retries, 3);
  assert.equal(summary.pause?.scope, l2PauseScope(F6.factId));
  assert.ok(summary.pause?.lastError.includes('SOURCE_RATE_LIMITED'), '最后错误含具名错误码');
  assert.ok(summary.pause?.nextAction.length, '唯一下一步动作非空（四要素齐）');
  assert.equal(calls.filter((url) => url.endsWith('/c.PDF')).length, 3, '同一调用至多 3 次尝试，第 4 次不再发起');
  const backoffWaits = waits.filter((ms) => ms >= 30_000);
  assert.deepEqual(backoffWaits, [30_000, 60_000, 120_000], '等待序列约 30s/60s/120s');
  // 状态行 FAILED + 暂停上报落库 adapter_pause_report（PAUSED）
  const stateF6 = await loadPdfState(pool, F6.factId);
  assert.equal(stateF6?.status, 'FAILED');
  assert.ok(stateF6?.error?.includes('SOURCE_RATE_LIMITED'));
  const pauses = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  const f6Pause = pauses.find((row) => row.scope === l2PauseScope(F6.factId));
  assert.notEqual(f6Pause, undefined, '暂停上报应落库');
  assert.equal(f6Pause?.status, 'PAUSED');
});

test('断点续跑：FAILED 重试成功、DONE 跳过不重发、暂停行置 RESUMED', async () => {
  // 来源恢复：c.PDF 与 b.PDF 现在可下载
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.endsWith('/c.PDF')) return { status: 200, body: PDF_C };
    if (url.endsWith('/b.PDF')) return { status: 200, body: PDF_B };
    if (url.endsWith('/a.PDF')) return { status: 200, body: PDF_A };
    return { status: 404, body: HTML_PAGE };
  });
  const { sleepImpl } = makeSleep();
  const runner = makeRunner({ pool, store, fetchImpl, sleepImpl });
  const summary = await runner.run(1);
  // 候选倒序：F6(6000 FAILED→重试) → F5(3000 FAILED→重试) → F2(2000 SKIPPED→重登记)
  assert.equal(summary.considered, 3);
  assert.equal(summary.downloaded, 2);
  assert.equal(summary.skippedEmptyUrl, 1);
  assert.equal(summary.failedPermanent, 0);
  assert.equal(summary.pause, null);
  assert.equal(summary.bytesTotal, PDF_B.length + PDF_C.length);
  // 暂停行恢复：该 scope 置 RESUMED（从断点续跑成功）
  const pauses = await loadPauseReports(pool, CNINFO_ADAPTER_VERSION);
  const f6Pause = pauses.find((row) => row.scope === l2PauseScope(F6.factId));
  assert.equal(f6Pause?.status, 'RESUMED', '成功后暂停记录置 RESUMED');
  const stateF6 = await loadPdfState(pool, F6.factId);
  assert.equal(stateF6?.status, 'DONE');
  assert.equal(stateF6?.pdfSha256, shaOf(PDF_C));

  // 再跑一次：全部 DONE（除 F2 空 URL）——幂等跳过，不产生任何网络请求重发
  const callsBefore = calls.length;
  const summary2 = await runner.run(1);
  assert.equal(summary2.considered, 1, '重跑只触及空 URL 行的重登记');
  assert.equal(summary2.downloaded, 0);
  assert.equal(summary2.skippedEmptyUrl, 1);
  assert.equal(calls.length, callsBefore, '重跑零网络请求：DONE 行在候选查询即被排除（断点续跑）');
  // tier2 仍未触碰
  assert.equal(await loadPdfState(pool, F3.factId), null);
});

test('upsertPdfState：FAILED→DONE 覆写、同键幂等', async () => {
  const fact = announcementFact({ announcementId: '9007', title: '更正公告', adjunctUrl: 'finalpage/x/d.PDF', offsetMs: 1_000 });
  await seedFacts([fact]);
  await upsertPdfState(pool, { factId: fact.factId, pdfSha256: null, bytes: null, status: 'FAILED', error: 'SOURCE_HTTP: HTTP 500', downloadedAt: '2026-10-25T00:00:00.000Z' });
  await upsertPdfState(pool, { factId: fact.factId, pdfSha256: shaOf(PDF_A), bytes: PDF_A.length, status: 'DONE', error: null, downloadedAt: '2026-10-25T01:00:00.000Z' });
  const row = await loadPdfState(pool, fact.factId);
  assert.equal(row?.status, 'DONE');
  assert.equal(row?.bytes, PDF_A.length);
  assert.equal(row?.pdfSha256, shaOf(PDF_A));
  assert.equal(row?.error, null);
  const index = await loadAnnouncementIndex(pool);
  const mine = index.find((entry) => entry.factId === fact.factId);
  assert.equal(mine?.done, true, 'DONE 标记使该行退出候选');
});

test('loadAnnouncementIndex：只取 ANNOUNCEMENT、按公告时间倒序、空 URL 保留为候选', async () => {
  const rows = await loadAnnouncementIndex(pool);
  assert.ok(rows.length >= 5, `库内夹具事实应可见，实际 ${rows.length}`);
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    assert.ok(prev !== undefined && curr !== undefined && prev.announcementTime >= curr.announcementTime, '公告时间倒序');
  }
  const f2 = rows.find((row) => row.factId === F2.factId);
  assert.equal(f2?.adjunctUrl, '', '空 adjunctUrl 行保留（runner 侧跳过登记）');
  const titles = rows.filter((row) => row.factId === F3.factId).map((row) => classifyTier(row.title));
  assert.deepEqual(titles, [2], 'tier2 事实在库但 tier1 运行不触碰');
});
