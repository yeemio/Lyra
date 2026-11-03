/**
 * Lyra · ST 时点表构建 CLI（W16: code-writer）。
 * 合同：docs/specs/ASHARE-RULES.md §3；P1 验收登记缺口（现只有当前快照 isST，无历史状态区间）。
 * 只读 public.pintime_fact 的 ANNOUNCEMENT 事实（ST 公告不一定在六类 events 里，不扫 events），
 * 写自有新表 st_status_timeline（truncate 重建，幂等）。
 *
 * 用法：node --import tsx src/rules/st-cli.ts
 *
 * 输出（回传口径）：
 *   1) 区间总数、涉及股票数、AMBIGUOUS 数量、排除/冗余计数
 *   2) 逐股区间清单
 *   3) 冻结池 26 股一致性核对：区间末端状态 vs DAILY_BAR 最新交易日 isST（当前快照）
 *   4) 逐日核对：区间状态 vs 全部 DAILY_BAR 行 isST（600150 历史区间强验证；默认basis 逐日计数单列）
 *   5) 抽样 10 例真实标题 → 判类核对表
 */
import { readFileSync } from 'node:fs';
import { createPool } from '../db/pool.js';
import {
  BUILDER_VERSION,
  applyStMigration,
  buildSubjectTimeline,
  classifyStTitle,
  loadStatusIntervals,
  stStatusAtFromIntervals,
  stEffectiveDay,
  type StAnnouncementInput,
  type StIntervalRow,
  type StSubjectBuildResult,
} from './st-timeline.js';

interface PoolFile {
  stocks: { code: string; name: string }[];
}

interface AnnRow {
  fact_id: string;
  subject_id: string;
  title: string;
  sec_name: string | null;
  source_published_at: Date | null;
  available_at: Date;
}

async function main(): Promise<void> {
  const poolFile = JSON.parse(readFileSync(new URL('../../data/research-pool.json', import.meta.url), 'utf8')) as PoolFile;
  const poolCodes = poolFile.stocks.map((s) => s.code);
  if (poolCodes.length !== 26) throw new Error(`POOL_SIZE_MISMATCH: ${poolCodes.length}`);

  const pool = createPool();
  try {
    // 1) 建自有表（幂等）
    await applyStMigration(pool);

    // 2) 全库扫描 ANNOUNCEMENT（只读 public）
    const r = await pool.query<AnnRow>(
      `select fact_id, subject_id, typed_value->>'title' as title, typed_value->>'secName' as sec_name,
              source_published_at, available_at
       from pintime_fact
       where fact_kind = 'ANNOUNCEMENT' and subject_type = 'STOCK'
       order by subject_id, source_published_at nulls last, fact_id`,
    );
    const rows = r.rows;
    const missingPublished = rows.filter((x) => x.source_published_at === null).length;
    console.log(`扫描 ANNOUNCEMENT（subject_type=STOCK）: ${rows.length} 条，涉及 ${new Set(rows.map((x) => x.subject_id)).size} 股；source_published_at 缺失 ${missingPublished} 条`);

    // 3) 逐股构建
    const bySubject = new Map<string, StAnnouncementInput[]>();
    for (const row of rows) {
      const list = bySubject.get(row.subject_id) ?? [];
      list.push({
        factId: row.fact_id,
        subjectId: row.subject_id,
        title: row.title,
        sourcePublishedAt: row.source_published_at === null ? null : row.source_published_at.toISOString(),
        availableAt: row.available_at.toISOString(),
        shortNameAtPublication: row.sec_name,
      });
      bySubject.set(row.subject_id, list);
    }

    const builds: StSubjectBuildResult[] = [];
    for (const [subject, inputs] of bySubject) {
      builds.push(buildSubjectTimeline(subject, inputs));
    }
    const conflictSubjects = builds.filter((b) => b.conflictSameDay !== null);
    const okBuilds = builds.filter((b) => b.conflictSameDay === null);
    const intervals: StIntervalRow[] = okBuilds.flatMap((b) => b.intervals);
    const ambiguousAll = builds.flatMap((b) => b.ambiguous.map((a) => ({ subject: b.subject, ...a })));
    const excludedAll = builds.flatMap((b) => b.skipped.map((s) => ({ subject: b.subject, ...s })));
    const redundantCount = excludedAll.filter((s) => s.reason.startsWith('REDUNDANT_SAME_STATUS')).length;

    console.log(`\n=== 构建结果（builder_version=${BUILDER_VERSION}）===`);
    console.log(`区间总数: ${intervals.length}；涉及股票数: ${new Set(intervals.map((i) => i.subject)).size}`);
    console.log(`AMBIGUOUS（不猜，未落区间）: ${ambiguousAll.length}`);
    for (const a of ambiguousAll) console.log(`  AMBIGUOUS ${a.subject} ${a.factId} 「${a.title}」 ${a.reason}`);
    console.log(`排除（预告/申请/警示函/无关键词）: ${excludedAll.length - redundantCount}；同状态冗余公告: ${redundantCount}`);
    console.log(`同日互斥冲突整股拒建: ${conflictSubjects.length}`);
    for (const c of conflictSubjects) console.log(`  CONFLICT ${c.subject} ${JSON.stringify(c.conflictSameDay)}`);

    console.log('\n=== 逐股区间清单 ===');
    const subjectsWithIntervals = [...new Set(intervals.map((i) => i.subject))].sort();
    for (const subject of subjectsWithIntervals) {
      const mine = intervals.filter((i) => i.subject === subject).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const name = mine[0]?.shortNameAtPublication ?? '';
      console.log(`${subject} ${name}:`);
      for (const i of mine) {
        console.log(`  [${i.effectiveFrom}, ${i.effectiveTo ?? '∞'}) ${i.status}  证据=${i.evidenceFactId} 公告available_at=${i.evidenceAvailableAt}`);
      }
    }

    // 4) 落表（truncate 重建自有表，幂等）
    await pool.query('truncate st_status_timeline');
    for (const i of intervals) {
      await pool.query(
        `insert into st_status_timeline
           (subject, status, effective_from, effective_to, evidence_fact_id, evidence_event_id,
            evidence_published_at, evidence_available_at, short_name_at_publication, builder_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          i.subject,
          i.status,
          i.effectiveFrom,
          i.effectiveTo,
          i.evidenceFactId,
          i.evidenceEventId,
          i.evidencePublishedAt,
          i.evidenceAvailableAt,
          i.shortNameAtPublication,
          BUILDER_VERSION,
        ],
      );
    }
    const stored = await loadStatusIntervals(pool);
    console.log(`\n落表 st_status_timeline: ${stored.length} 行（读回校验 ${stored.length === intervals.length ? '一致' : '不一致——数据缺陷'}）`);

    // 5) 冻结池 26 股一致性核对：区间末端 vs DAILY_BAR 最新 isST（当前快照，只读）
    console.log('\n=== 冻结池 26 股一致性核对（区间末端 vs DAILY_BAR 最新 isST）===');
    const mismatch: string[] = [];
    let consistent = 0;
    for (const code of poolCodes) {
      const mine = stored.filter((i) => i.subject === code).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      const last = mine[mine.length - 1];
      const endIsSt = last !== undefined && last.status !== 'NORMAL'; // 无区间（全默认）视为非 ST
      const bar = await pool.query(
        `select distinct on (subject_id) subject_id, typed_value->>'isST' as isst,
                to_char(valid_from at time zone 'Asia/Shanghai','YYYY-MM-DD') as day
         from pintime_fact
         where fact_kind='DAILY_BAR' and subject_type='STOCK' and subject_id=$1
         order by subject_id, valid_from desc`,
        [code],
      );
      const barRow = bar.rows[0];
      const barIsSt = barRow !== undefined && barRow.isst === '1';
      const ok = endIsSt === barIsSt;
      if (ok) consistent += 1;
      else
        mismatch.push(
          `${code} 区间末端=${last === undefined ? '(无区间→默认NORMAL)' : last.status} vs 最新bar isST=${String(barRow?.isst)}（${String(barRow?.day)}）`,
        );
    }
    console.log(`一致: ${consistent}/26；不一致: ${mismatch.length}`);
    for (const m of mismatch) console.log(`  MISMATCH ${m}`);

    // 6) 逐日核对：全部 DAILY_BAR 行 isST vs 区间状态（冻结池范围；默认basis单列）
    console.log('\n=== 逐日核对（DAILY_BAR isST vs 区间状态，冻结池 26 股全历史）===');
    const allIntervals = stored;
    const barRows = await pool.query(
      `select subject_id, typed_value->>'isST' as isst,
              to_char(valid_from at time zone 'Asia/Shanghai','YYYY-MM-DD') as day
       from pintime_fact
       where fact_kind='DAILY_BAR' and subject_type='STOCK'
         and subject_id = any($1)
       order by subject_id, valid_from`,
      [poolCodes],
    );
    let evAgree = 0;
    let defAgree = 0;
    let evMismatch = 0;
    let defMismatch = 0;
    const mismatchSamples: string[] = [];
    for (const row of barRows.rows) {
      const res = stStatusAtFromIntervals(row.subject_id, row.day, allIntervals);
      const barIsSt = row.isst === '1';
      const timelineIsSt = res.status !== 'NORMAL';
      const agree = barIsSt === timelineIsSt;
      if (res.basis === 'EVIDENCED') {
        if (agree) evAgree += 1;
        else {
          evMismatch += 1;
          if (mismatchSamples.length < 5) mismatchSamples.push(`${row.subject_id} ${row.day} bar=${row.isst} 区间=${res.status}（EVIDENCED）`);
        }
      } else {
        if (agree) defAgree += 1;
        else {
          defMismatch += 1;
          if (mismatchSamples.length < 5) mismatchSamples.push(`${row.subject_id} ${row.day} bar=${row.isst} 区间=${res.status}（DEFAULT_BEFORE_EVIDENCE）`);
        }
      }
    }
    console.log(`EVIDENCED 日: 一致 ${evAgree} / 不一致 ${evMismatch}；DEFAULT 日: 一致 ${defAgree} / 不一致 ${defMismatch}（DEFAULT 一致 = 默认恰与非ST快照吻合，仍属未证实区）`);
    for (const m of mismatchSamples) console.log(`  MISMATCH ${m}`);

    // 7) 抽样 10 例真实标题 → 判类核对表
    console.log('\n=== 抽样 10 例：真实标题 → 判类核对 ===');
    const samples = await pool.query(
      `select fact_id, subject_id, typed_value->>'title' as title from pintime_fact
       where fact_kind='ANNOUNCEMENT' and subject_type='STOCK'
         and (typed_value->>'title' ~ '风险警示|撤销|警示函|ST|风险提示|摘帽')
       order by case when subject_id='600150' then 0 else 1 end, event_at
       limit 10`,
    );
    let n = 0;
    for (const row of samples.rows) {
      n += 1;
      const cls = classifyStTitle(row.title);
      const kind = cls.kind === 'EVENT' ? `${cls.to}（${cls.ruleId}）` : cls.kind === 'AMBIGUOUS' ? 'AMBIGUOUS' : '非事件';
      console.log(`${n}. ${row.subject_id} 「${row.title}」 → ${kind}`);
    }
    if (n !== 10) console.log(`（抽样命中 ${n} 条 —— 关键词并集可达标题不足 10 条时如实报告）`);

    console.log('\nST 时点表构建完成。');
  } finally {
    await pool.end();
  }
}

// 生效日抽样自检（600150 真实锚点，防止取法回归）
{
  const probe = stEffectiveDay({
    factId: 'probe',
    subjectId: '600150',
    title: 'probe',
    sourcePublishedAt: '2018-04-22T16:00:00.000Z',
    availableAt: '2018-04-24T00:00:00.000Z',
  });
  if (probe.day !== '2018-04-24') throw new Error(`生效日取法回归：期望 2018-04-24，得 ${probe.day}`);
}

main().catch((err) => {
  console.error('ST 时点表构建失败:', err);
  process.exit(1);
});
