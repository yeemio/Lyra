/**
 * Lyra · 年报审计意见回填 runner 单测（A 类 A5 / W32: code-writer-pro）。不碰 docker、不碰网络：
 * 适配器经 fixture 桥注入（窗口形态照真实桥输出）；DB 用本地 lyra-pg 隔离 schema
 * （schema.sql + l2-migration + audit 内联 DDL）。合同判定：候选标题过滤（只处理年报 +
 * audit@p2 监管回函噪声排除）、断点续跑（DONE/SKIPPED 跳过、FAILED 重试）、NO_AUDIT_SECTION 不产事实、UNDETERMINED 如实入库、
 * 桥级失败中止、FACT_CONFLICT 落库冲突登记 FAILED、完成度统计。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { asOfFacts } from '../pintime/facts.js';
import { insertFact } from '../pintime/facts.js';
import { AuditAdapter, auditOpinionFactId, dockerPdfPath, type AuditWindow } from '../adapters/audit.js';
import { applyL2Migration } from './l2-pdf.js';
import {
  applyAuditMigration,
  computeAuditCoverageStats,
  isAuditNoiseTitle,
  loadAnnualReportCandidates,
  loadAuditState,
  runAuditBackfill,
  selectPendingCandidates,
} from './audit.js';
import type { TimePointFact } from '../contracts.js';

const SCHEMA = `w32_audit_${Math.random().toString(36).slice(2, 10)}`;

const SHA_STD = '1'.repeat(64); // 年报 A：标准无保留
const SHA_NOAUDIT = '2'.repeat(64); // 噪声公告（无审计节）
const SHA_FLAKY = '3'.repeat(64); // 首跑桥失败、重试成功
const SHA_CONFLICT = '4'.repeat(64); // 落库冲突（预插同 id 异内容事实）
const SHA_UNDET = '5'.repeat(64); // 多命中冲突 → UNDETERMINED

interface Fixture {
  announcementId: string;
  subjectId: string;
  title: string;
  sha: string;
  publishedMs: number;
}

const FIXTURES: Fixture[] = [
  { announcementId: '9000000001', subjectId: '600519', title: '贵州茅台2023年年度报告', sha: SHA_STD, publishedMs: Date.parse('2024-04-03T00:00:00+08:00') },
  { announcementId: '9000000002', subjectId: '600519', title: '关于举行2023年度报告网上业绩说明会的公告', sha: SHA_NOAUDIT, publishedMs: Date.parse('2024-04-10T00:00:00+08:00') },
  { announcementId: '9000000003', subjectId: '600519', title: '2023年半年度报告', sha: '6'.repeat(64), publishedMs: Date.parse('2023-08-30T00:00:00+08:00') },
  { announcementId: '9000000004', subjectId: '600519', title: '2024年第一季度报告', sha: '7'.repeat(64), publishedMs: Date.parse('2024-04-29T00:00:00+08:00') },
  { announcementId: '9000000005', subjectId: '600519', title: '2022年年度报告摘要', sha: '8'.repeat(64), publishedMs: Date.parse('2023-04-01T00:00:00+08:00') },
  { announcementId: '9000000006', subjectId: '601318', title: '中国平安2023年年度报告', sha: SHA_FLAKY, publishedMs: Date.parse('2024-03-22T00:00:00+08:00') },
  { announcementId: '9000000007', subjectId: '601318', title: '中国平安2022年年度报告', sha: SHA_CONFLICT, publishedMs: Date.parse('2023-03-16T00:00:00+08:00') },
  { announcementId: '9000000008', subjectId: '601318', title: '中国平安2021年年度报告', sha: SHA_UNDET, publishedMs: Date.parse('2022-03-18T00:00:00+08:00') },
  { announcementId: '9000000009', subjectId: '601318', title: '中国平安2020年年度报告（已取消）', sha: '9'.repeat(64), publishedMs: Date.parse('2021-03-20T00:00:00+08:00') },
];

function announcementFact(f: Fixture): TimePointFact {
  const availableAt = new Date(f.publishedMs + 86_400_000).toISOString(); // D+1 00:00 UTC 口径
  return {
    factId: `cninfo:ann:${f.announcementId}@p1`,
    subjectType: 'STOCK',
    subjectId: f.subjectId,
    factKind: 'ANNOUNCEMENT',
    typedValue: { title: f.title, adjunctUrl: `finalpage/x/${f.announcementId}.PDF`, announcementTime: f.publishedMs, announcementId: f.announcementId, secCode: f.subjectId, secName: '', announcementType: '', adjunctSize: null },
    validFrom: null,
    validTo: null,
    eventAt: availableAt,
    sourcePublishedAt: new Date(f.publishedMs).toISOString(),
    firstObservedAt: '2026-01-01T00:00:00.000Z',
    availableAt,
    supersedesFactId: null,
    artifactSha256: '0'.repeat(64),
    adapterVersion: 'cninfo@p1',
  };
}

const WIN_STD: AuditWindow[] = [
  { anchor: '意见的审计报告', page: 2, text: '重要提示\n……会计师事务所（特殊普通合伙）为本公司出具了标准无保留意见的审计报告。' },
];
const WIN_UNDET: AuditWindow[] = [
  { anchor: '意见的审计报告', page: 2, text: '……出具了标准无保留意见的审计报告。' },
  { anchor: '审计意见', page: 60, text: '一、保留意见\n除……所述事项的影响外，我们认为，后附的财务报表……' },
];

/** fixture 桥：按 sha 出窗口（未知 sha 按标准意见成功返回——测试中途新增的候选）；
 *  failShas 之列按单份失败返回。 */
function makeBridge(opts: { failShas?: Set<string> } = {}) {
  return async (args: string[]) => {
    assert.equal(args[0], 'extract');
    const results = args.slice(1).map((path) => {
      const sha = path.slice(-64);
      if (opts.failShas?.has(sha) === true) {
        return { ok: false, path, error_code: 'AUDIT_PDF_FAILED', error: 'PdfReadError: stream broken（fixture 首跑失败）' };
      }
      if (sha === SHA_STD) {
        return { ok: true, path, sha256: sha, pages: 143, textLen: 160000, windows: WIN_STD, truncatedWindows: false };
      }
      if (sha === SHA_UNDET) {
        return { ok: true, path, sha256: sha, pages: 120, textLen: 140000, windows: WIN_UNDET, truncatedWindows: false };
      }
      if (sha === SHA_NOAUDIT) {
        return { ok: true, path, sha256: sha, pages: 1, textLen: 640, windows: [], truncatedWindows: false };
      }
      return { ok: true, path, sha256: sha, pages: 130, textLen: 150000, windows: WIN_STD, truncatedWindows: false };
    });
    return { ok: true, results };
  };
}

let pool: Pool;

before(async () => {
  pool = createPool({ schema: SCHEMA });
  await applySchema(pool, SCHEMA);
  await applyL2Migration(pool, SCHEMA);
  await applyAuditMigration(pool, SCHEMA);
  for (const f of FIXTURES) {
    await insertFact(pool, announcementFact(f));
    await pool.query(
      'insert into pdf_backfill_state (fact_id, pdf_sha256, bytes, status, error) values ($1, $2, $3, $4, null)',
      [`cninfo:ann:${f.announcementId}@p1`, f.sha, 1_000_000, 'DONE'],
    );
  }
});

after(async () => {
  await dropSchema(pool, SCHEMA);
  await pool.end();
});

test('候选：年报标题收录；半年报/季报/摘要/已取消排除（只处理年报）', async () => {
  const rows = await loadAnnualReportCandidates(pool);
  assert.deepEqual(
    rows.map((r) => r.title).sort(),
    [
      '中国平安2021年年度报告',
      '中国平安2022年年度报告',
      '中国平安2023年年度报告',
      '关于举行2023年度报告网上业绩说明会的公告', // 冻结标题过滤字面收录（无审计节 → SKIPPED 可见）
      '贵州茅台2023年年度报告',
    ].sort(),
  );
});

test('首跑：DONE/SKIPPED/FAILED 落状态；事实入库；availableAt 复用年报公告口径', async () => {
  const adapter = new AuditAdapter({
    execBridge: makeBridge({ failShas: new Set([SHA_FLAKY]) }),
    now: () => new Date('2026-10-25T08:00:00.000Z'),
  });
  // 预插同 factId 异内容事实 → 落库冲突路径（SHA_CONFLICT）
  const conflictFixture = FIXTURES.find((f) => f.sha === SHA_CONFLICT)!;
  const conflictFact = announcementFact(conflictFixture);
  await insertFact(pool, {
    factId: auditOpinionFactId(conflictFact.factId, SHA_CONFLICT),
    subjectType: 'STOCK',
    subjectId: '601318',
    factKind: 'AUDIT_OPINION',
    typedValue: { 类型: '保留意见', 摘录: '预插异内容', 报告年度: '2022', pdfSha256: SHA_CONFLICT, announcementFactId: conflictFact.factId, 年报标题: conflictFixture.title, 候选: [], 判类说明: '预插' },
    validFrom: null, validTo: null, eventAt: null, sourcePublishedAt: null,
    firstObservedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-02T00:00:00.000Z',
    supersedesFactId: null, artifactSha256: SHA_CONFLICT, adapterVersion: 'audit@p1',
  });

  const summary = await runAuditBackfill({ pool, adapter, batchSize: 10 });
  assert.equal(summary.considered, 5);
  assert.equal(summary.classified, 1); // 茅台标准无保留
  assert.equal(summary.undetermined, 1); // 平安 2021 多命中冲突
  assert.equal(summary.skippedNoAudit, 1); // 业绩说明会公告无审计节
  assert.equal(summary.failed, 2); // FLAKY 桥失败 + CONFLICT 落库冲突
  assert.equal(summary.factsInserted, 2);
  assert.equal(summary.factsIdentical, 0);
  assert.equal(summary.aborted, null);

  // 事实断言：茅台 2023 → 标准无保留意见，五时间字段复用公告口径，证据绑定
  const before = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'AUDIT_OPINION',
    asOf: new Date(Date.parse('2024-04-03T00:00:00.000Z')),
  });
  assert.equal(before.length, 0); // as-of 早于年报公告 D+1 → 不可见（无泄漏）
  const after = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'AUDIT_OPINION',
    asOf: new Date(Date.parse('2024-04-05T00:00:00.000Z')),
  });
  assert.equal(after.length, 1);
  const tv = after[0]!.typedValue as Record<string, unknown>;
  assert.equal(tv['类型'], '标准无保留意见');
  assert.equal(tv['报告年度'], '2023');
  assert.equal(tv['pdfSha256'], SHA_STD);
  assert.equal(tv['announcementFactId'], 'cninfo:ann:9000000001@p1');
  assert.equal(after[0]!.availableAt, announcementFact(FIXTURES[0]!).availableAt);
  assert.equal(after[0]!.artifactSha256, SHA_STD);
  assert.equal(after[0]!.adapterVersion, 'audit@p1');

  // UNDETERMINED 如实入库
  const undet = await asOfFacts(pool, {
    subjectType: 'STOCK',
    subjectId: '601318',
    factKind: 'AUDIT_OPINION',
    asOf: new Date('2026-01-01T00:00:00.000Z'),
  });
  const undetFact = undet.find((f) => (f.typedValue as Record<string, unknown>)['类型'] === 'UNDETERMINED');
  assert.ok(undetFact !== undefined);
  const undetTv = undetFact.typedValue as Record<string, unknown>;
  assert.equal((undetTv['候选'] as unknown[]).length, 2);

  // 状态行
  assert.equal((await loadAuditState(pool, 'cninfo:ann:9000000001@p1'))!.status, 'DONE');
  assert.equal((await loadAuditState(pool, 'cninfo:ann:9000000002@p1'))!.status, 'SKIPPED');
  assert.equal((await loadAuditState(pool, 'cninfo:ann:9000000006@p1'))!.status, 'FAILED');
  const conflictState = await loadAuditState(pool, 'cninfo:ann:9000000007@p1');
  assert.equal(conflictState!.status, 'FAILED');
  assert.ok(conflictState!.error!.includes('FACT_CONFLICT'));
});

test('断点续跑：DONE/SKIPPED 跳过；FAILED 重试成功', async () => {
  const pending = selectPendingCandidates(await loadAnnualReportCandidates(pool));
  assert.deepEqual(
    pending.map((r) => r.factId).sort(),
    ['cninfo:ann:9000000006@p1', 'cninfo:ann:9000000007@p1'].sort(),
  );
  const adapter = new AuditAdapter({
    execBridge: makeBridge(), // FLAKY 不再失败
    now: () => new Date('2026-10-25T08:00:00.000Z'),
  });
  const summary = await runAuditBackfill({ pool, adapter, batchSize: 10 });
  assert.equal(summary.considered, 2); // 冲突项 FACT_CONFLICT 仍失败（同 id 异内容不可覆盖），FLAKY 转成功
  assert.equal(summary.classified, 1);
  assert.equal(summary.failed, 1);
  assert.equal((await loadAuditState(pool, 'cninfo:ann:9000000006@p1'))!.status, 'DONE');
  assert.equal((await loadAuditState(pool, 'cninfo:ann:9000000006@p1'))!.opinion, '标准无保留意见');
});

test('桥级失败：当前批登记 FAILED 并中止；恢复 = 重跑', async () => {
  // 造一个未处理候选（新年报公告）
  const extra: Fixture = { announcementId: '9000000010', subjectId: '600519', title: '贵州茅台2024年年度报告', sha: 'a'.repeat(64), publishedMs: Date.parse('2025-04-02T00:00:00+08:00') };
  await insertFact(pool, announcementFact(extra));
  await pool.query(
    'insert into pdf_backfill_state (fact_id, pdf_sha256, bytes, status, error) values ($1, $2, $3, $4, null)',
    [`cninfo:ann:${extra.announcementId}@p1`, extra.sha, 1_000_000, 'DONE'],
  );
  const adapter = new AuditAdapter({
    execBridge: async () => {
      throw new Error('AUDIT_BRIDGE_TIMEOUT: 超过 600000ms');
    },
  });
  const summary = await runAuditBackfill({ pool, adapter, batchSize: 10 });
  assert.ok(summary.aborted !== null && summary.aborted.includes('AUDIT_BRIDGE_TIMEOUT'));
  assert.equal(summary.failed, summary.considered);
  const state = await loadAuditState(pool, `cninfo:ann:${extra.announcementId}@p1`);
  assert.equal(state!.status, 'FAILED');
  assert.ok(state!.error!.includes('桥级失败'));
  // 重跑（桥恢复）→ FAILED 项重试成功，运行可收敛
  const fixed = await runAuditBackfill({ pool, adapter: new AuditAdapter({ execBridge: makeBridge() }), batchSize: 10 });
  assert.equal(fixed.failed, 1); // 仅剩不可恢复的 CONFLICT 项
  assert.equal(fixed.aborted, null);
  assert.equal((await loadAuditState(pool, `cninfo:ann:${extra.announcementId}@p1`))!.status, 'DONE');
});

test('完成度统计：候选全集/处理分布/五类分布', async () => {
  const stats = await computeAuditCoverageStats(pool);
  assert.equal(stats.candidatesTotal, 6); // 5 原候选 + 新增茅台 2024（半年报/季报/摘要/已取消不计）
  assert.equal(stats.processedDone, 4);
  assert.equal(stats.processedSkipped, 1);
  assert.equal(stats.processedFailed, 1);
  assert.equal(stats.pending, 1); // 未处理 0 + FAILED 1（CONFLICT）= pending（FAILED 重跑会重试）
  assert.equal(stats.stateOpinionCounts['标准无保留意见'], 3);
  assert.equal(stats.stateOpinionCounts['UNDETERMINED'], 1);
  assert.equal(stats.factCounts['标准无保留意见'], 3); // 预插冲突事实 1（保留意见）+ 新增 3
  assert.equal(stats.factCounts['保留意见'], 1);
  assert.equal(stats.factCounts['UNDETERMINED'], 1);
});

test('selectPendingCandidates：subject/limit 收窄', async () => {
  const rows = await loadAnnualReportCandidates(pool);
  assert.equal(selectPendingCandidates(rows, { subject: '601318' }).length, 1); // 仅剩 CONFLICT 项
  assert.equal(selectPendingCandidates(rows, { limit: 0 }).length, 0);
});

// ===== audit@p2 候选过滤收紧（W43；REVISION-LOG 迭代循环 19 登记待办）=====
// 追加在本文件末尾：新插入的 fixture 只影响下列断言，不回扰上方既有计数断言。

test('audit@p2 过滤：监管回函噪声标题排除（W32 噪声形态不入候选）', async () => {
  // 谓词级：W32 实测噪声形态（问询函/关注函/监管工作函及其回复）全部命中保守组合规则
  assert.equal(isAuditNoiseTitle('永鼎股份关于上海证券交易所对公司2023年年度报告的信息披露监管工作函的回复公告'), true);
  assert.equal(isAuditNoiseTitle('关于上海证券交易所对公司2018年年度报告的事后审核问询函的回复公告'), true);
  assert.equal(isAuditNoiseTitle('关于收到上海证券交易所对公司2016年年度报告事后审核问询函的公告'), true);
  assert.equal(isAuditNoiseTitle('关于xx公司关注函的回复'), true);
  // 缺组合任一边即不命中（保守）
  assert.equal(isAuditNoiseTitle('关于举行2023年度报告网上业绩说明会的公告'), false);

  // 库级：PDF 已完成的监管回函公告不再入候选（audit@p1 旧过滤曾字面收录并产生噪声事实）
  const noise: Fixture = {
    announcementId: '9000000021', subjectId: '600519',
    title: '永鼎股份关于上海证券交易所对公司2023年年度报告的信息披露监管工作函的回复公告',
    sha: 'b'.repeat(64), publishedMs: Date.parse('2024-05-10T00:00:00+08:00'),
  };
  await insertFact(pool, announcementFact(noise));
  await pool.query(
    'insert into pdf_backfill_state (fact_id, pdf_sha256, bytes, status, error) values ($1, $2, $3, $4, null)',
    [`cninfo:ann:${noise.announcementId}@p1`, noise.sha, 1_000_000, 'DONE'],
  );
  const rows = await loadAnnualReportCandidates(pool);
  assert.ok(!rows.some((r) => r.title === noise.title)); // 噪声标题被排除
});

test('audit@p2 过滤：年报本体保留（组合规则不命中本体标题）', async () => {
  // 谓词级：年报本体标题不含（回复|函）×（问询|监管|关注）组合，天然保留
  assert.equal(isAuditNoiseTitle('贵州茅台2023年年度报告'), false);
  assert.equal(isAuditNoiseTitle('中国平安2023年年度报告'), false);
  assert.equal(isAuditNoiseTitle('2020年年度报告（更新版）'), false);
  // 库级：既有候选不受收紧影响
  const rows = await loadAnnualReportCandidates(pool);
  const titles = rows.map((r) => r.title);
  assert.ok(titles.includes('贵州茅台2023年年度报告'));
  assert.ok(titles.includes('中国平安2023年年度报告'));
});

test('audit@p2 过滤：带"函"字但无问询/监管/关注限定的标题不过度排除', async () => {
  // 反例（现实年报库中不存在，构造以证明不过度排除）：含"函"但缺监管限定词 → 不排除
  assert.equal(isAuditNoiseTitle('关于xx的函'), false);
  assert.equal(isAuditNoiseTitle('关于贵州茅台2022年年度报告相关事项的函'), false);
  // 库级：该标题通过本体过滤且噪声组合不命中 → 仍入候选
  const letter: Fixture = {
    announcementId: '9000000022', subjectId: '600519',
    title: '关于贵州茅台2022年年度报告相关事项的函',
    sha: 'c'.repeat(64), publishedMs: Date.parse('2023-05-01T00:00:00+08:00'),
  };
  await insertFact(pool, announcementFact(letter));
  await pool.query(
    'insert into pdf_backfill_state (fact_id, pdf_sha256, bytes, status, error) values ($1, $2, $3, $4, null)',
    [`cninfo:ann:${letter.announcementId}@p1`, letter.sha, 1_000_000, 'DONE'],
  );
  const rows = await loadAnnualReportCandidates(pool);
  assert.equal(rows.some((r) => r.title === letter.title), true);
});
