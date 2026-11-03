/**
 * Lyra · 结算真实样本验证 CLI（P3 W13: code-writer-pro，Done-when 1 证据生成器）。
 * 直接执行本文件时对**真实库**（lyra-pg 127.0.0.1:5433，只读查询）跑冻结样本清单，
 * 打印每例结算输出，并把原始消费输入（参考价、逐日原始收盘、除权事件分子分母、
 * 指数开收）落 var/w13-real-samples.json，供独立手算基准（Python Fraction）对照。
 * 被 import 时不执行；不做任何写入（除 var/ 下的验证工件）。
 *
 * 样本清单（真实库实测选定，覆盖 Done-when 1 全部情形）：
 *  S1 正常跑赢 002407（2025-08-11 完成，FILLABLE，e>0）
 *  S2 正常跑输 002851（2025-08-11 完成，FILLABLE，e<0，窗口内 e_d ≥ +10% 触发跑输侧失效）
 *  S3 窗口内含除权日 600519（2024-06-17 完成 → 参考价日 06-18，06-19 除权 10派308.76 在窗口内）
 *  S4 窗口内含停牌 603019（2025-05-20 完成 → 参考价日 05-21，05-26..06-09 停牌 10 个交易日）
 *  S5 参考价顺延 603019（2025-05-23 完成 → 首候选 05-26 停牌 → 参考价日 = 复牌日 06-10）
 *  S6 一字板涨停不可成交 600030（2024-09-30 完成 → 参考价日 10-08 开盘 29.92 = 涨停价一字）
 *  S7 一字板跌停不可成交 603256（2024-07-04 完成 → 参考价日 07-05 开盘 7.65 = 跌停价一字）
 *  S8 放弃 600519（同 S3 窗口，ABSTAIN 非计算分支）
 *  S9 未到期 600519（2026-10-21 完成，窗口仅 2/20，SR-2.4 非计算分支）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPool } from '../db/pool.js';
import { asOfFacts } from '../pintime/facts.js';
import { settleConclusion } from './settle.js';

const SAMPLES = [
  { id: 'S1-normal-outperform', subject: '002407', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2025-08-11T20:00:00+08:00', note: '正常跑赢' },
  { id: 'S2-normal-underperform', subject: '002851', disposition: 'RESEARCH_UNDERPERFORM', conclusionTime: '2025-08-11T20:00:00+08:00', note: '正常跑输（窗口内触发跑输侧失效）' },
  { id: 'S3-exdiv-in-window', subject: '600519', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2024-06-17T20:00:00+08:00', note: '窗口内含除权日 2024-06-19' },
  { id: 'S4-suspension-in-window', subject: '603019', disposition: 'RESEARCH_UNDERPERFORM', conclusionTime: '2025-05-20T20:00:00+08:00', note: '窗口内含停牌 2025-05-26..06-09' },
  { id: 'S5-deferred-reference', subject: '603019', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2025-05-23T20:00:00+08:00', note: '参考价日停牌顺延至复牌日' },
  { id: 'S6-oneword-limit-up', subject: '600030', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2024-09-30T20:00:00+08:00', note: '参考价日一字涨停（真实一字日）' },
  { id: 'S7-oneword-limit-down', subject: '603256', disposition: 'RESEARCH_UNDERPERFORM', conclusionTime: '2024-07-04T20:00:00+08:00', note: '参考价日一字跌停（真实一字日）' },
  { id: 'S8-abstain', subject: '600519', disposition: 'ABSTAIN', conclusionTime: '2024-06-17T20:00:00+08:00', note: '放弃（非计算分支）' },
  { id: 'S9-not-due', subject: '600519', disposition: 'RESEARCH_OUTPERFORM', conclusionTime: '2026-10-21T20:00:00+08:00', note: '未到期（非计算分支）' },
] as const;

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('settlement/real-samples.cli.ts');

if (isMain) {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const pool = createPool();
  try {
    const dump: unknown[] = [];
    for (const s of SAMPLES) {
      const cutoff = `${s.conclusionTime.slice(0, 10)}T15:00:00+08:00`;
      const outcome = await settleConclusion(pool, {
        subject: s.subject,
        disposition: s.disposition,
        conclusionTime: s.conclusionTime,
        cutoff,
      });
      console.log('='.repeat(100));
      console.log(`${s.id} ${s.note} | ${s.subject} ${s.disposition} 结论完成 ${s.conclusionTime} 截点 ${cutoff}`);
      if (outcome.state === 'SETTLED') {
        const d = outcome.diagnostics;
        console.log(
          `  参考价日 ${d.referenceDay} 开盘 ${d.referenceOpen}（顺延 ${String(d.deferredBySuspension)} 跨度 ${String(d.suspensionSpanTradingDays)}）` +
          ` 窗口结束 ${d.windowEndDay}（${String(d.tradedDays)} 个有成交日）` +
          ` 行业 ${d.industry.industryIndexCode}（${d.industry.system} 窗口 / ${d.industry.l1IndexCodeSource}）`,
        );
        console.log(
          `  e_window = ${outcome.zone.excessReturn} | directionHit = ${String(outcome.zone.directionHit)}` +
          ` | maxAdverse = ${String(outcome.zone.maxAdverse)}` +
          ` | invalidation = ${String(outcome.zone.invalidationTriggered)}${d.invalidationFirstDay ? ' 首触发日 ' + d.invalidationFirstDay : ''}` +
          ` | tradability = ${outcome.zone.tradability}`,
        );
        console.log(`  可成交理由：${d.tradability.reason}`);
        if (d.suspensionGaps.length > 0) console.log(`  停牌间隔：${JSON.stringify(d.suspensionGaps)}`);
        const inWindow = d.factorEvents.filter((e) => e.day >= d.referenceDay && e.day <= d.windowEndDay);
        if (inWindow.length > 0) {
          console.log(`  窗口内除权事件：${inWindow.map((e) => `${e.day} r=${e.ratio}（${e.prevClose}/${e.preclose}）`).join('; ')}`);
        }
        // 原始消费输入（Python Fraction 手算基准用）
        const baf = await loadBackAdjustFactors(pool, s.subject);
        const eStrings = d.series.map((x) => x.e);
        const maxAdverseFromSeries =
          d.disposition === 'RESEARCH_OUTPERFORM'
            ? eStrings.reduce((m, e) => (m === null || Number(e) < Number(m) ? e : m), null as string | null)
            : d.disposition === 'RESEARCH_UNDERPERFORM'
              ? eStrings.reduce((m, e) => (m === null || Number(e) > Number(m) ? e : m), null as string | null)
              : null;
        dump.push({
          id: s.id, subject: s.subject, disposition: s.disposition,
          conclusionTime: s.conclusionTime, cutoff,
          referenceDay: d.referenceDay, referenceOpenRaw: d.referenceOpen,
          indexCode: d.industry.industryIndexCode, indexOpenRef: d.indexOpenRef,
          windowEndDay: d.windowEndDay,
          days: d.series.map((x) => ({ day: x.day, rawClose: x.stockRawClose, factor: x.stockFactor, adjClose: x.stockAdjClose, indexClose: x.indexClose, e: x.e })),
          factorEvents: d.factorEvents.map((e) => ({ day: e.day, ratio: e.ratio, prevClose: e.prevClose, preclose: e.preclose })),
          backAdjustFactors: baf,
          zone: outcome.zone,
          maxAdverseFromSeries,
          invalidationFirstDay: d.invalidationFirstDay,
          tradability: outcome.zone.tradability,
          tradabilityReason: d.tradability.reason,
          limit: d.tradability.limit,
        });
      } else if (outcome.state === 'UNSETTLED') {
        console.log(`  UNSETTLED（${outcome.reason}）：${outcome.detail}`);
        dump.push({ id: s.id, subject: s.subject, disposition: s.disposition, state: 'UNSETTLED', reason: outcome.reason, detail: outcome.detail });
      } else {
        console.log(`  ANOMALY（${outcome.code}）：${outcome.detail}`);
        dump.push({ id: s.id, subject: s.subject, disposition: s.disposition, state: 'ANOMALY', code: outcome.code, detail: outcome.detail });
      }
    }
    const outPath = join(repoRoot, 'var', 'w13-real-samples.json');
    await mkdir(join(repoRoot, 'var'), { recursive: true });
    await writeFile(outPath, JSON.stringify(dump, null, 1), 'utf8');
    console.log('='.repeat(100));
    console.log(`原始消费输入已落 ${outPath}（供独立手算基准对照）`);
  } finally {
    await pool.end();
  }
}

/** 数据源累计后复权因子链（backAdjustFactor，仅供交叉核对证据，不进结算计算）。 */
async function loadBackAdjustFactors(pool: Parameters<typeof asOfFacts>[0], subject: string): Promise<{ day: string; baf: string }[]> {
  const facts = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: subject, factKind: 'ADJUST_FACTOR', asOf: new Date() });
  const rows = facts
    .map((f) => {
      const v = f.typedValue as Record<string, unknown>;
      const day = typeof v.dividOperateDate === 'string' ? v.dividOperateDate : null;
      const baf = typeof v.backAdjustFactor === 'string' ? v.backAdjustFactor : null;
      return day === null || baf === null ? null : { day, baf };
    })
    .filter((x): x is { day: string; baf: string } => x !== null);
  rows.sort((a, b) => (a.day < b.day ? -1 : 1));
  return rows;
}
