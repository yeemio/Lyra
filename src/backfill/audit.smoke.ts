/**
 * Lyra · 年报审计意见真实冒烟（A 类 A5 / W32: code-writer-pro）。
 *
 * 有界真实抽取 2 份（派发冻结：600519 某两年——取 2018 与 2023 两个年报格式代际）：
 * 真桥（docker + pypdf）读 CAS 原件 → 判类 → 落 AUDIT_OPINION 事实 → 回读断言。
 *
 * 断言：
 * - 桥单次批量调用 2 份（extract 子命令，容器内 CAS 分片路径）；
 * - 两份 pages>50、textLen>10 万、判类 = 标准无保留意见（探测实证：两份重要提示均为
 *   "出具了标准无保留意见的审计报告"）；
 * - 事实落库（audit@p1）：typedValue 类型/报告年度/pdfSha256/announcementFactId 证据绑定；
 *   availableAt 与年报 ANNOUNCEMENT 事实逐字相等（复用，不重复推导）；
 * - as-of 截点无泄漏：availableAt 前一毫秒不可见、当日可见；
 * - 幂等（同进程重跑同批 + 跨次重跑）：factId 与 typedValue 逐字一致，不产生第二事实
 *   （first_observed_at 为抽取时刻，不参与身份与内容断言）。
 *
 * 运行：node --import tsx src/backfill/audit.smoke.ts
 * 目标库：public schema；audit_opinion_state 幂等迁移；原件 LYRA_ARTIFACTS_DIR 缺省 <repo>/data/artifacts。
 */
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/pool.js';
import { applySchema } from '../db/exec.js';
import { asOfFacts, insertFact, loadFact } from '../pintime/facts.js';
import { canonicalJsonString } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import { AuditAdapter, AUDIT_ADAPTER_VERSION, type AuditSourceAnnouncement } from '../adapters/audit.js';
import { applyAuditMigration, loadAuditState, upsertAuditState } from './audit.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 派发冻结：600519 两个年报格式代际（2018 旧式 / 2023 新式），fact_id 取自库内登记。 */
const SMOKE_ANNOUNCEMENTS: readonly { announcementId: string; year: string }[] = [
  { announcementId: '1205958206', year: '2018' },
  { announcementId: '1219506510', year: '2023' },
];

async function loadAnnouncements(pool: ReturnType<typeof createPool>): Promise<AuditSourceAnnouncement[]> {
  const ids = SMOKE_ANNOUNCEMENTS.map((a) => `cninfo:ann:${a.announcementId}@p1`);
  const res = await pool.query(
    `select f.fact_id, f.subject_id,
            coalesce(f.typed_value->>'title', '') as title,
            s.pdf_sha256, f.available_at, f.source_published_at
     from pintime_fact f
     join pdf_backfill_state s on s.fact_id = f.fact_id and s.status = 'DONE'
     where f.fact_id = any($1::text[])`,
    [ids],
  );
  const out: AuditSourceAnnouncement[] = [];
  for (const row of res.rows as {
    fact_id: string; subject_id: string; title: string; pdf_sha256: string;
    available_at: Date; source_published_at: Date | null;
  }[]) {
    out.push({
      factId: row.fact_id,
      subjectId: row.subject_id,
      title: row.title,
      availableAt: row.available_at.toISOString(),
      sourcePublishedAt: row.source_published_at === null ? null : row.source_published_at.toISOString(),
      pdfSha256: row.pdf_sha256,
    });
  }
  if (out.length !== SMOKE_ANNOUNCEMENTS.length) {
    throw new Error(`冒烟公告不全：库内命中 ${String(out.length)} / ${String(SMOKE_ANNOUNCEMENTS.length)}`);
  }
  return out;
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await applySchema(pool);
    await applyAuditMigration(pool);
    const announcements = await loadAnnouncements(pool);
    const adapter = new AuditAdapter({
      artifactsRel: 'data/artifacts',
      now: () => new Date('2026-10-25T12:00:00.000Z'),
    });

    // ---- 真实抽取（一次桥批量调用 2 份）----
    const results = await adapter.extractAnnualReportBatch(announcements);
    const facts: TimePointFact[] = [];
    for (let i = 0; i < announcements.length; i++) {
      const result = results[i]!;
      const announcement = announcements[i]!;
      if (result.status !== 'FACT') {
        throw new Error(`${announcement.title} 抽取非 FACT：${result.status} ${JSON.stringify(result)}`);
      }
      if (result.classification.type !== '标准无保留意见') {
        throw new Error(
          `${announcement.title} 判类 ${result.classification.type}（${result.classification.判类说明}）` +
            `候选：${JSON.stringify(result.classification.candidates.map((c) => c.类型))}`,
        );
      }
      if (result.pages <= 50 || result.textLen < 100_000) {
        throw new Error(`${announcement.title} 深度异常 pages=${String(result.pages)} textLen=${String(result.textLen)}`);
      }
      const tv = result.fact.typedValue as Record<string, unknown>;
      if (tv['报告年度'] !== announcement.title.match(/(19|20)\d{2}/)![0]) {
        throw new Error(`${announcement.title} 报告年度 ${String(tv['报告年度'])} 异常`);
      }
      if (tv['announcementFactId'] !== announcement.factId || tv['pdfSha256'] !== announcement.pdfSha256) {
        throw new Error(`${announcement.title} 证据绑定异常`);
      }
      if (result.fact.availableAt !== announcement.availableAt || result.fact.artifactSha256 !== announcement.pdfSha256) {
        throw new Error(`${announcement.title} availableAt/artifactSha256 未复用年报公告口径`);
      }
      facts.push(result.fact);
    }

    // ---- 落库（存在同 id 事实则断言 typedValue 逐字一致——确定性证明；首次运行插入）----
    const insertedNow: number[] = [];
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i]!;
      const existing = await loadFact(pool, fact.factId);
      if (existing === null) {
        await insertFact(pool, fact);
        insertedNow.push(i);
      } else if (canonicalJsonString(existing.typedValue) !== canonicalJsonString(fact.typedValue)) {
        throw new Error(
          `${announcements[i]!.title} 已存事实与本次抽取 typedValue 不一致（factId 确定性或桥行为漂移）`,
        );
      }
    }
    for (let i = 0; i < announcements.length; i++) {
      const announcement = announcements[i]!;
      const fact = facts[i]!;
      const asOf = new Date(Date.parse(announcement.availableAt));
      const before = await asOfFacts(pool, {
        subjectType: 'STOCK', subjectId: announcement.subjectId, factKind: 'AUDIT_OPINION',
        asOf: new Date(asOf.getTime() - 1),
      });
      // 泄漏断言按 factId：本事实在其 availableAt 前一毫秒不可见（其他年份事实可见属正常）
      if (before.some((f) => f.factId === fact.factId)) {
        throw new Error('as-of 泄漏：本事实在 availableAt 前一毫秒已可见');
      }
      const at = await asOfFacts(pool, {
        subjectType: 'STOCK', subjectId: announcement.subjectId, factKind: 'AUDIT_OPINION', asOf,
      });
      const mine = at.find((f) => f.factId === fact.factId);
      if (mine === undefined) throw new Error('as-of 边界（availableAt 当日）本事实应可见');
      const tv = mine.typedValue as Record<string, unknown>;
      if (tv['类型'] !== '标准无保留意见') throw new Error(`回读判类异常：${String(tv['类型'])}`);
      if (mine.availableAt !== announcement.availableAt) throw new Error('回读 availableAt 与年报公告不一致');
      await upsertAuditState(pool, {
        factId: announcement.factId, pdfSha256: announcement.pdfSha256,
        status: 'DONE', opinion: '标准无保留意见', error: null,
        extractedAt: '2026-10-25T12:00:00.000Z',
      });
    }

    // ---- 幂等：同进程重跑同批 → 同 factId 且 typedValue 逐字一致（不产生第二事实）----
    const rerun = await adapter.extractAnnualReportBatch(announcements);
    let identical = 0;
    for (const result of rerun) {
      if (result.status !== 'FACT') throw new Error(`重跑非 FACT：${result.status}`);
      const reloaded = await loadFact(pool, result.fact.factId);
      if (reloaded === null) throw new Error('重跑后事实应已在库（factId 缺失）');
      if (canonicalJsonString(reloaded.typedValue) !== canonicalJsonString(result.fact.typedValue)) {
        throw new Error('重跑 typedValue 漂移（确定性破坏）');
      }
      identical += 1;
    }

    const stateRows = [];
    for (const a of announcements) {
      const state = await loadAuditState(pool, a.factId);
      if (state === null || state.status !== 'DONE' || state.opinion !== '标准无保留意见') {
        throw new Error(`状态行异常：${JSON.stringify(state)}`);
      }
      stateRows.push({ fact: state.factId, opinion: state.opinion });
    }

    console.log(
      JSON.stringify(
        {
          result: 'AUDIT SMOKE OK',
          adapterVersion: AUDIT_ADAPTER_VERSION,
          bridgeRuns: 2, // extractAnnualReportBatch 每批恰一次 docker run（冒烟跑两批）
          subjects: announcements.map((a, i) => ({
            title: a.title,
            pages: results[i]!.status === 'FACT' ? results[i]!.pages : null,
            textLen: results[i]!.status === 'FACT' ? results[i]!.textLen : null,
            opinion: results[i]!.status === 'FACT' ? results[i]!.classification.type : null,
            判类说明: results[i]!.status === 'FACT' ? results[i]!.classification.判类说明 : null,
            pdfSha256: a.pdfSha256.slice(0, 12),
            availableAt: a.availableAt,
            factId: facts[i]!.factId,
          })),
          rerunIdentical: identical,
          stateRows,
          asOfCheck: 'PASS（availableAt 前一毫秒不可见 / 当日可见）',
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

await main();
