/**
 * Lyra · 事件检测 CLI（W14: code-writer）。跑冻结池 26 股 2015 至今的真实事件清单并落 events 表。
 * 合同：docs/specs/P3-EVENTS-REVIEW.md Done-when 2。只读 pintime_fact（asOf 语义外的一次性建库读取：
 * 全库历史重建，非时点查询——事件库为派生特征，materialized_at 即本次运行时刻）。
 *
 * 用法：node --import tsx src/events/detect.cli.ts [--threshold=0.20]
 * 幂等：event_id 确定性 + ON CONFLICT DO NOTHING，重复运行不重复落库。
 */
import { readFileSync } from 'node:fs';
import { createPool } from '../db/pool.js';
import { classifyTitle, detectAnnouncement, detectGrowthEvents, type AnnouncementInput, type GrowthInput } from './detect.js';
import { applyEventsMigration, insertEvents, toInstance, type EventInstance } from './library.js';
import { GROWTH_DELTA_THRESHOLD_RESERVED, type EventType } from './rules.js';

const RANGE_START = '2015-01-01';

function parseThreshold(): number {
  const arg = process.argv.find((a) => a.startsWith('--threshold='));
  const raw = arg !== undefined ? arg.slice('--threshold='.length) : (process.env.EVENT_GROWTH_DELTA_THRESHOLD ?? String(GROWTH_DELTA_THRESHOLD_RESERVED));
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`INVALID_GROWTH_THRESHOLD: ${raw}`);
  }
  return v;
}

interface PoolFile {
  stocks: { code: string; name: string }[];
}

async function main(): Promise<void> {
  const threshold = parseThreshold();
  const poolFile = JSON.parse(readFileSync(new URL('../../data/research-pool.json', import.meta.url), 'utf8')) as PoolFile;
  const codes = poolFile.stocks.map((s) => s.code);
  if (codes.length !== 26) throw new Error(`POOL_SIZE_MISMATCH: ${codes.length}`);

  const pool = createPool();
  try {
    await applyEventsMigration(pool);

    // ===== 公告驱动五类 =====
    const annRows = await pool.query<{ fact_id: string; subject_id: string; available_at: Date; title: string }>(
      `select fact_id, subject_id, available_at, typed_value->>'title' as title
       from pintime_fact
       where fact_kind = 'ANNOUNCEMENT' and subject_id = any($1) and available_at >= $2
       order by available_at, typed_value->>'announcementTime', fact_id`,
      [codes, RANGE_START],
    );

    const priorForecastKeys = new Map<string, Set<string>>();
    const events: EventInstance[] = [];
    const counts: Record<string, number> = {};
    const subtypeCounts: Record<string, number> = {};
    let unparsedPeriod = 0;
    const unparsedTitles = new Set<string>();
    let flashCorrectionNoInstance = 0;
    let zeroHit = 0;
    const rejectedCounts: Record<string, number> = {};

    for (const row of annRows.rows) {
      const input: AnnouncementInput = {
        factId: row.fact_id,
        subjectId: row.subject_id,
        title: row.title ?? '',
        availableAt: row.available_at.toISOString(),
      };
      const outcome = detectAnnouncement(input, priorForecastKeys.get(row.subject_id) ?? new Set());
      switch (outcome.kind) {
        case 'EVENT': {
          if (outcome.event.eventType === 'EARNINGS_FORECAST' && typeof outcome.event.attrs.period === 'string') {
            let set = priorForecastKeys.get(row.subject_id);
            if (set === undefined) {
              set = new Set<string>();
              priorForecastKeys.set(row.subject_id, set);
            }
            set.add(outcome.event.attrs.period);
          }
          counts[outcome.event.eventType] = (counts[outcome.event.eventType] ?? 0) + 1;
          if (outcome.event.subtype !== null) {
            const key = `${outcome.event.eventType}/${outcome.event.subtype}`;
            subtypeCounts[key] = (subtypeCounts[key] ?? 0) + 1;
          }
          events.push(toInstance(outcome.event));
          break;
        }
        case 'FORECAST_UNPARSED_PERIOD':
          unparsedPeriod += 1;
          unparsedTitles.add(input.title);
          break;
        case 'FLASH_CORRECTION_NO_INSTANCE':
          flashCorrectionNoInstance += 1;
          break;
        case 'NONE':
          zeroHit += 1;
          break;
      }
      for (const rj of classifyTitle(input.title).rejected) {
        const key = `${rj.type}:${rj.reason}`;
        rejectedCounts[key] = (rejectedCounts[key] ?? 0) + 1;
      }
    }

    // ===== 定期报告增速变化（FINANCIAL 驱动）=====
    const finRows = await pool.query<{ subject_id: string; fact_id: string; sd: string; pd: string; available_at: Date; y: string | null }>(
      `select subject_id, fact_id, typed_value->>'statDate' as sd, typed_value->>'pubDate' as pd,
              available_at, typed_value->>'YOYNI' as y
       from pintime_fact
       where fact_kind = 'FINANCIAL' and typed_value->>'bsQuery' = 'growth'
         and subject_id = any($1) and available_at >= $2`,
      [codes, RANGE_START],
    );
    const growthByStock = new Map<string, GrowthInput[]>();
    for (const row of finRows.rows) {
      const yoyNi = row.y !== null && row.y !== '' && Number.isFinite(Number(row.y)) ? Number(row.y) : null;
      const list = growthByStock.get(row.subject_id) ?? [];
      list.push({ factId: row.fact_id, statDate: row.sd, pubDate: row.pd, availableAt: row.available_at.toISOString(), yoyNi });
      growthByStock.set(row.subject_id, list);
    }
    const growthStatsTotal = { periodsConsidered: 0, firstPeriodNoPrev: 0, yoyNiMissing: 0, prevYoyNiMissing: 0, periodSequenceGap: 0 };
    for (const stock of codes) {
      const facts = growthByStock.get(stock) ?? [];
      const r = detectGrowthEvents(stock, facts, threshold);
      for (const e of r.events) {
        counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
        events.push(toInstance(e));
      }
      growthStatsTotal.periodsConsidered += r.stats.periodsConsidered;
      growthStatsTotal.firstPeriodNoPrev += r.stats.firstPeriodNoPrev;
      growthStatsTotal.yoyNiMissing += r.stats.yoyNiMissing;
      growthStatsTotal.prevYoyNiMissing += r.stats.prevYoyNiMissing;
      growthStatsTotal.periodSequenceGap += r.stats.periodSequenceGap;
    }

    const inserted = await insertEvents(pool, events);

    // ===== 抽样核对清单（每类取时序前 K 条，共 15 条）=====
    const sampleQuota: Partial<Record<EventType, number>> = {
      EARNINGS_FORECAST: 3,
      EARNINGS_FLASH: 2,
      PERIOD_GROWTH_DELTA: 2,
      SHARE_UNLOCK: 2,
      HOLDER_TRADE: 3,
      BUYBACK: 3,
    };
    const perTypeTaken = new Map<string, number>();
    const sample: EventInstance[] = [];
    for (const e of events) {
      const quota = sampleQuota[e.type];
      if (quota === undefined) continue;
      const taken = perTypeTaken.get(e.type) ?? 0;
      if (taken >= quota) continue;
      perTypeTaken.set(e.type, taken + 1);
      sample.push(e);
    }

    const summary = {
      rangeStart: RANGE_START,
      stocks: codes.length,
      announcementsScanned: annRows.rows.length,
      financialGrowthRowsScanned: finRows.rows.length,
      countsByType: counts,
      countsBySubtype: subtypeCounts,
      forecastUndeterminedDirection: subtypeCounts['EARNINGS_FORECAST/UNDETERMINED'] ?? 0,
      forecastUnparsedPeriod: unparsedPeriod,
      unparsedTitles: [...unparsedTitles], // 具名登记：提取失败不成事件的标题原文（不猜）
      forecastCorrectionWithoutPriorNote: events.filter((e) => e.attrs.note === 'CORRECTION_KEYWORD_WITHOUT_PRIOR_EVENT').length,
      flashCorrectionNoInstance,
      zeroHitTitles: zeroHit,
      rejectedRegistrations: rejectedCounts,
      growthThresholdUsed: threshold,
      growthStats: growthStatsTotal,
      eventsDetected: events.length,
      db: inserted,
    };
    console.log('=== EVENTS SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));

    console.log('=== MANUAL REVIEW SAMPLE (15) ===');
    for (const e of sample) {
      const title = typeof e.attrs.title === 'string' ? e.attrs.title : `(financial) statDate=${String(e.attrs.statDate)} pubDate=${String(e.attrs.pubDate)} yoyNi ${String(e.attrs.yoyNiPrev)}→${String(e.attrs.yoyNiThis)}`;
      console.log([e.subject, e.type, e.subtype ?? '-', e.eventTime, title].join(' | '));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('DETECT_CLI_FAILED:', err);
  process.exit(1);
});
