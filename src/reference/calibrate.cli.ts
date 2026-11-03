/**
 * Lyra · 历史参照库 · 价格失效阈值校准 CLI（P4 / W18: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §9〔R3〕、docs/specs/SETTLEMENT-REVIEW.md SR-6.3。
 *
 * 输入（全部只读，无网络调用，本地计算）：
 * - public.events（W14 拥有，只读消费；列弹性映射同 build.cli.ts 口径）；
 * - 时点事实 DAILY_BAR / ADJUST_FACTOR / INDUSTRY_CLASS_VERSION(sw@p1) / SW_INDEX_BAR
 *   （as-of 构建时刻；行情窗口为事后统计非研究输入，R4 修订口径声明随报告原样携带）；
 * - public.reference_group_library（W15 落库，只读）：'all-events' 行 invalidation 块作
 *   θ=10 交叉核对锚点（引擎重扫 vs 落库值逐值比对）。
 *
 * 输出：data/reference-calibration-report.json（多阈值触发率矩阵 + 推荐值 + 剔除数 +
 * 交叉核对 + 限制声明）。校准只推荐不生效（SR-6.3）：不改任何运行时阈值常量，
 * excess.ts 的 INVALIDATION_THRESHOLD 维持预留 10% 不动。
 *
 * CLI：node --import tsx src/reference/calibrate.cli.ts
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { asOfFacts } from '../pintime/facts.js';
import { createPool } from '../db/pool.js';
import { industryAsOf, type IndustryAsOf } from './groups.js';
import {
  adjustFactorsFromFacts,
  dailyBarsFromFacts,
  eventWindowReturns,
  swIndexBarsFromFacts,
  type AdjustFactorInput,
  type DailyBarInput,
  type IndexBarInput,
} from './excess.js';
import {
  CALIBRATION_THRESHOLDS_PCT,
  STOCK_RESERVED_PCT,
  buildCalibrationReport,
  crossCheckReserved10,
  sampleOf,
  type CalibrationSample,
  type CrossCheckBlock,
} from './calibrate.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const REPORT_PATH = join(repoRoot, 'data', 'reference-calibration-report.json');
const SW_ADAPTER = 'sw@p1';
const METHOD_VERSION = 'reference-calibration@w18';

/** events 列弹性映射（与 build.cli.ts 同清单同优先序；events 列名已定型：subject/type/subtype/event_time）。 */
const COLUMN_CANDIDATES = {
  subject: ['subject', 'subject_code', 'stock_code', 'code', 'subject_id'],
  eventType: ['type', 'event_type', 'kind', 'category'],
  eventTime: ['event_time', 'event_at', 'available_at', 'triggered_at', 'announced_at'],
  subtype: ['subtype', 'sub_type', 'sub_kind'],
} as const;

interface EventRow {
  subject: string;
  eventType: string;
  subtype: string | null;
  eventTime: string;
}

function mapColumns(columns: string[]): { subject: string; eventType: string; eventTime: string; subtype: string | null } | null {
  const pick = (candidates: readonly string[]): string | null => {
    for (const c of candidates) if (columns.includes(c)) return c;
    return null;
  };
  const subject = pick(COLUMN_CANDIDATES.subject);
  const eventType = pick(COLUMN_CANDIDATES.eventType);
  const eventTime = pick(COLUMN_CANDIDATES.eventTime);
  const subtype = pick(COLUMN_CANDIDATES.subtype);
  if (subject === null || eventType === null || eventTime === null) return null;
  return { subject, eventType, eventTime, subtype };
}

function isoOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function eventKeyOf(eventType: string, subtype: string | null): string {
  return subtype === null || subtype === '' ? eventType : `${eventType}:${subtype}`;
}

/** 读 W15 'all-events' 行 invalidation 块（交叉核对锚点）；表/行缺失按缺口退出，不猜。 */
async function loadLibraryInvalidation(pool: Pool): Promise<{ n: number; downTriggered: number; upTriggered: number }> {
  const exists = await pool.query<{ reg: string | null }>('select to_regclass($1) as reg', ['public.reference_group_library']);
  if (exists.rows[0]?.reg == null) {
    console.log(JSON.stringify({ result: 'BLOCKED', reason: 'REFERENCE_GROUP_LIBRARY_MISSING', resumeCommand: 'node --import tsx src/reference/calibrate.cli.ts' }, null, 2));
    await pool.end();
    process.exit(3);
  }
  const row = await pool.query<{ stats: { invalidation?: { n?: unknown; downTriggered?: unknown; upTriggered?: unknown } } }>(
    "select stats from reference_group_library where group_key = 'all-events'",
  );
  const inv = row.rows[0]?.stats?.invalidation;
  if (row.rows.length === 0 || inv === undefined) {
    console.log(JSON.stringify({ result: 'BLOCKED', reason: 'ALL_EVENTS_ROW_MISSING', resumeCommand: 'node --import tsx src/reference/calibrate.cli.ts' }, null, 2));
    await pool.end();
    process.exit(3);
  }
  const n = Number(inv.n);
  const down = Number(inv.downTriggered);
  const up = Number(inv.upTriggered);
  if (!Number.isInteger(n) || !Number.isInteger(down) || !Number.isInteger(up)) {
    console.log(JSON.stringify({ result: 'BLOCKED', reason: 'LIBRARY_INVALIDATION_MALFORMED', resumeCommand: 'node --import tsx src/reference/calibrate.cli.ts' }, null, 2));
    await pool.end();
    process.exit(3);
  }
  return { n, downTriggered: down, upTriggered: up };
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    // ---- events（只读；弹性映射同 build.cli）----
    const eventsRes = await pool.query<Record<string, unknown>>('select * from public.events');
    if (eventsRes.rows.length === 0) throw new Error('events 表为空——无校准样本');
    const first = eventsRes.rows[0]!;
    const mapping = mapColumns(Object.keys(first));
    if (mapping === null) throw new Error(`events 列 ${JSON.stringify(Object.keys(first))} 无法映射`);
    const events: EventRow[] = [];
    for (const row of eventsRes.rows) {
      const subject = row[mapping.subject];
      const eventType = row[mapping.eventType];
      const eventTime = isoOf(row[mapping.eventTime]);
      const subtypeRaw = mapping.subtype === null ? null : row[mapping.subtype];
      if (typeof subject !== 'string' || subject.length === 0 || typeof eventType !== 'string' || eventType.length === 0 || eventTime === null) continue;
      events.push({
        subject,
        eventType,
        subtype: typeof subtypeRaw === 'string' && subtypeRaw.length > 0 ? subtypeRaw : null,
        eventTime,
      });
    }
    if (events.length === 0) throw new Error('events 无可读行——按缺口退出，不产出比例');

    // ---- 时点事实加载（只读，与 W15 build 同法；本地计算无网络）----
    const materializedAt = new Date().toISOString();
    const asOfNow = new Date();
    const subjects = [...new Set(events.map((e) => e.subject))].sort();
    const barsBySubject = new Map<string, DailyBarInput[]>();
    const factorsBySubject = new Map<string, AdjustFactorInput[]>();
    const icvBySubject = new Map<string, Parameters<typeof industryAsOf>[0]>();
    for (const code of subjects) {
      barsBySubject.set(code, dailyBarsFromFacts(await asOfFacts(pool, { subjectType: 'STOCK', subjectId: code, factKind: 'DAILY_BAR', asOf: asOfNow })));
      factorsBySubject.set(code, adjustFactorsFromFacts(await asOfFacts(pool, { subjectType: 'STOCK', subjectId: code, factKind: 'ADJUST_FACTOR', asOf: asOfNow })));
      icvBySubject.set(
        code,
        (await asOfFacts(pool, { subjectType: 'STOCK', subjectId: code, factKind: 'INDUSTRY_CLASS_VERSION', asOf: asOfNow }))
          .filter((f) => f.adapterVersion === SW_ADAPTER),
      );
    }

    // ---- 每事件行业 as-of（事件时点当时版本）→ 逐事件窗口收益（逐日累计超额序列重算）----
    const industryByEvent = new Map<number, IndustryAsOf | null>();
    events.forEach((e, i) => industryByEvent.set(i, industryAsOf(icvBySubject.get(e.subject) ?? [], e.eventTime)));
    const indexCodes = [...new Set(
      [...industryByEvent.values()].flatMap((v) => (v !== null && v.l1IndexCode !== null ? [v.l1IndexCode] : [])),
    )].sort();
    const indexBarsByCode = new Map<string, IndexBarInput[]>();
    for (const code of indexCodes) {
      indexBarsByCode.set(code, swIndexBarsFromFacts(await asOfFacts(pool, { subjectType: 'INDEX', subjectId: code, factKind: 'SW_INDEX_BAR', asOf: asOfNow })));
    }

    const samples: CalibrationSample[] = [];
    const gapCounter = new Map<string, number>();
    for (const [i, e] of events.entries()) {
      const industry = industryByEvent.get(i) ?? null;
      const win = eventWindowReturns({
        subject: e.subject,
        eventTime: e.eventTime,
        industryL1AsOf: industry?.l1IndexCode ?? null,
        bars: barsBySubject.get(e.subject) ?? [],
        factors: factorsBySubject.get(e.subject) ?? [],
        indexBars: industry?.l1IndexCode == null ? [] : indexBarsByCode.get(industry.l1IndexCode) ?? [],
      });
      for (const g of win.dataGaps) gapCounter.set(g, (gapCounter.get(g) ?? 0) + 1);
      samples.push(sampleOf(e.subject, e.eventTime, eventKeyOf(e.eventType, e.subtype), win));
    }

    // ---- 交叉核对（W15 群组库 θ=10 锚点）+ 报告 ----
    const libInv = await loadLibraryInvalidation(pool);
    const crossCheck: CrossCheckBlock = crossCheckReserved10(samples, libInv);
    const report = buildCalibrationReport(samples, crossCheck, {
      thresholdsPct: CALIBRATION_THRESHOLDS_PCT,
      materializedAt,
      methodVersion: METHOD_VERSION,
      adapterVersion: `${SW_ADAPTER};baostock@0.9.40-p1`,
      inputAvailableAtMax: materializedAt,
    });
    report.reportPath = REPORT_PATH;
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

    const cls = report.sampleScope.byClass;
    const highlight = report.matrix.overall.statisticsScopeExProgress;
    console.log(JSON.stringify({
      result: 'REFERENCE CALIBRATION OK',
      eventsTotal: report.sampleScope.eventsTotal,
      byClass: cls,
      dataGapKinds: gapCounter.size,
      consistencyCheck10: { match: crossCheck.match, library: `${crossCheck.libraryDown}↓/${crossCheck.libraryUp}↑/n=${crossCheck.libraryN}`, recomputed: `${crossCheck.recomputedDown}↓/${crossCheck.recomputedUp}↑/n=${crossCheck.recomputedN}` },
      scanOverallStatisticsScope: Object.fromEntries(CALIBRATION_THRESHOLDS_PCT.map((pct) => {
        const c = highlight[pct]!;
        return [`${pct}%`, { n: c.n, any: c.anyRatePct, down: c.downRatePct, up: c.upRatePct, medDay: c.medianFirstAnyDay }];
      })),
      recommendation: {
        stock: { reserved: STOCK_RESERVED_PCT, recommended: report.recommendation.stock.recommendedPct, calibrationOnly: true, freezeAt: 'P5' },
        broadBase: { reserved: report.recommendation.broadBase.reservedPct, status: report.recommendation.broadBase.status },
      },
      reportPath: REPORT_PATH,
    }, null, 2));
  } catch (error) {
    console.error(`[reference-calibrate] 失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('reference/calibrate.cli.ts');
if (isMain) {
  await main();
}
