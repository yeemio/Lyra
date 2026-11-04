/**
 * Lyra · 历史参照库 · 全量构建 CLI（P3 随轮提前 / W15: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §2–§8（构建口径、六类事件消费、衡量口径、
 * 机械选定、产出物）；docs/specs/P3-EVENTS-REVIEW.md（W15 工件）。
 *
 * 输入：public 生产库（lyra-pg 127.0.0.1:5433）——时点事实**只读**
 * （DAILY_BAR / ADJUST_FACTOR / INDUSTRY_CLASS_VERSION(sw@p1) / SW_INDEX_BAR 含 801020 全史），
 * 事件实例表 `events`（W14 拥有，本 CLI 只读消费，不建不改）。
 * 输出：群组完整版本追加 reference_library_versions（src/db/reference-migration.sql，旧表只审计）+
 * data/reference-library-summary.json。
 *
 * events 表未就绪（W14 并行在建）→ 按派发如实 BLOCKED（退出码 3）并给出续跑命令，
 * **不自建该表、不猜列**；列映射失败同样 BLOCKED（列名清单随 detail 回传由总控对齐）。
 * 本地计算，无网络调用，节流不需要（派发冻结）。
 *
 * 口径要点（与 W15 模块注释一致）：
 * - 事件时点 as-of：行业归属按事件时点（当时申万版本，版本切换不回溯）；
 * - 行情窗口：事后统计（全量可得），R4 修订口径声明随 summary 原样携带；
 * - 市值档：总股本库内无股本事实 → 不编造，成交额代理档位 proxy=true，
 *   分界 = 全库代理值三等分位（等分位预留值，待 P4 校准冻结）；
 * - 失效阈值 10% 与 MIN_GROUP_SAMPLE=30 均为预留值，全程标注。
 *
 * CLI：node --import tsx src/reference/build.cli.ts
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { TimePointFact } from '../contracts.js';
import { asOfFacts, loadFact } from '../pintime/facts.js';
import { createPool } from '../db/pool.js';
import {
  DEFAULT_MIN_GROUP_SAMPLE,
  NESTED_GROUP_DECLARATION,
  REVISION_NOTICE,
  industryAsOf,
  marketCapTierOf,
  marketStateOf,
  tercileBounds,
  type IndustryAsOf,
  type MarketCapTierResult,
  type ReferenceEventLayers,
} from './groups.js';
import {
  INVALIDATION_THRESHOLD_PCT,
  adjustFactorsFromFacts,
  dailyBarsFromFacts,
  eventWindowReturns,
  swIndexBarsFromFacts,
  type AdjustFactorInput,
  type DailyBarInput,
  type IndexBarInput,
} from './excess.js';
import { applyReferenceMigration, buildGroupLibrary, growthReferenceLineage, loadGrowthReferenceFacts, saveGroupStats } from './library.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SUMMARY_PATH = join(repoRoot, 'data', 'reference-library-summary.json');
const SW_ADAPTER = 'sw@p1';
const HS300_INDEX_CODE = '000300';
const METHOD_VERSION = 'reference-library@pit-v2'; // PR1：输入/成员/成熟窗口/发布时间绑定，旧版本和冻结参数不改

/** events 表列映射候选（W14 契约列名未定稿，弹性映射；失败即 BLOCKED 不猜）。 */
const COLUMN_CANDIDATES = {
  subject: ['subject_code', 'subject', 'stock_code', 'code', 'subject_id'],
  eventType: ['event_type', 'type', 'kind', 'category'],
  eventTime: ['event_time', 'event_at', 'available_at', 'triggered_at', 'announced_at'],
  subtype: ['subtype', 'sub_type', 'sub_kind'],
} as const;

interface EventRow {
  eventId: string;
  evidenceFactId: string;
  subject: string;
  eventType: string;
  subtype: string | null;
  eventTime: string;
  attrs: Record<string, unknown>;
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

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const r = await pool.query<{ reg: string | null }>('select to_regclass($1) as reg', [`public.${table}`]);
  return r.rows[0]?.reg != null;
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

/** 事件时点最近已收盘（15:00 ≤ 事件时点）的有成交交易日行（市值档/代理基准）。 */
function lastSettledBar(bars: DailyBarInput[], eventTime: string): DailyBarInput | null {
  const ms = new Date(eventTime).getTime();
  if (Number.isNaN(ms)) return null;
  const settled = bars
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && String(b.tradestatus ?? '1') !== '0' && Number(b.volume) > 0)
    .filter((b) => new Date(`${b.date}T15:00:00+08:00`).getTime() <= ms)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return settled[settled.length - 1] ?? null;
}

async function main(): Promise<void> {
  const pool = createPool();
  const blocked = async (reason: string, detail: string): Promise<never> => {
    console.log(JSON.stringify({
      result: 'BLOCKED',
      reason,
      detail,
      resumeCommand: 'node --import tsx src/reference/build.cli.ts',
      note: reason === 'EVENTS_TABLE_NOT_READY'
        ? 'events 表属 W14（并行在建）；W14 落表后重跑本命令即全量构建（W15 库与单测已就绪）。'
        : 'events 表结构与 W15 候选映射不一致；请总控与 W14 对齐列名后重跑，W15 不猜列。',
    }, null, 2));
    await pool.end();
    process.exit(3);
  };

  try {
    // ---- events 表探测（W14 拥有；只读，不建不改）----
    if (!(await tableExists(pool, 'events'))) {
      return await blocked('EVENTS_TABLE_NOT_READY', 'public.events 不存在（to_regclass null）——W14 事件实例表尚未落库；本 CLI 不自建该表（派发冻结）。');
    }
    const colRes = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'events' order by ordinal_position",
    );
    const columns = colRes.rows.map((r) => r.column_name);
    const mapping = mapColumns(columns);
    if (mapping === null) {
      return await blocked('EVENTS_COLUMNS_UNMAPPED', `events 列 ${JSON.stringify(columns)} 无法映射（W15 候选 ${JSON.stringify(COLUMN_CANDIDATES)}）。`);
    }
    if (!columns.includes('event_id') || !columns.includes('evidence_fact_id')) {
      return await blocked('EVENTS_LINEAGE_MISSING', '不可变群组发布需要 event_id 与 evidence_fact_id');
    }
    const eventsRes = await pool.query<Record<string, unknown>>('select * from public.events');
    let events: EventRow[] = [];
    for (const row of eventsRes.rows) {
      const subject = row[mapping.subject];
      const eventType = row[mapping.eventType];
      const eventTime = isoOf(row[mapping.eventTime]);
      const subtypeRaw = mapping.subtype === null ? null : row[mapping.subtype];
      if (typeof subject !== 'string' || subject.length === 0 || typeof eventType !== 'string' || eventType.length === 0 || eventTime === null) continue;
      if (typeof row.event_id !== 'string' || typeof row.evidence_fact_id !== 'string') continue;
      events.push({
        eventId: row.event_id, evidenceFactId: row.evidence_fact_id,
        subject,
        eventType,
        subtype: typeof subtypeRaw === 'string' && subtypeRaw.length > 0 ? subtypeRaw : null,
        eventTime,
        attrs: row.attrs !== null && typeof row.attrs === 'object' && !Array.isArray(row.attrs) ? row.attrs as Record<string, unknown> : {},
      });
    }
    // ---- R25.1 消费侧过滤：回购普通进展公告不触发新实例（域合同 HISTORICAL-REFERENCE §3.6）。
    // 存储层（events 表，W14）保留超集供审计与复核；参照库统计只算首次与重要变更（REVISION-LOG R25.1）。
    let excludedProgressCount = 0;
    events = events.filter((e) => {
      if (e.eventType === 'BUYBACK' && e.subtype === 'PROGRESS_OR_CHANGE') {
        excludedProgressCount += 1;
        return false;
      }
      return true;
    });
    console.log(`[reference-build] R25.1 消费侧过滤：BUYBACK:PROGRESS_OR_CHANGE 剔除 ${excludedProgressCount} 例（存储层超集保留，不进参照库统计）。`);
    // 零有效事件也发布可审计空版本；不让较早非空统计在新截点继续冒充本次结果。

    // ---- 时点事实加载（只读；构建时刻 as-of。行情窗口为事后统计非研究输入；R4 声明随 summary）----
    const materializedAt = new Date().toISOString();
    const asOfNow = new Date(materializedAt);
    events = events.filter((e) => Date.parse(e.eventTime) <= asOfNow.getTime());
    const inputFacts = new Map<string, TimePointFact>();
    const growthFactsBySubject = new Map<string, TimePointFact[]>();
    const growthByEvent = new Map<string, NonNullable<NonNullable<ReferenceEventLayers['lineage']>['growth']>>();
    const load = async (query: Parameters<typeof asOfFacts>[1]): Promise<TimePointFact[]> => {
      const facts = await asOfFacts(pool, query);
      for (const f of facts) inputFacts.set(f.factId, f);
      return facts;
    };
    for (const e of events) {
      const f = await loadFact(pool, e.evidenceFactId);
      if (f === null || f.subjectType !== 'STOCK' || f.subjectId !== e.subject || Date.parse(f.availableAt) > asOfNow.getTime()) {
        return await blocked('EVENT_EVIDENCE_UNBOUND', e.eventId);
      }
      inputFacts.set(f.factId, f);
      if (e.eventType === 'PERIOD_GROWTH_DELTA') {
        let history = growthFactsBySubject.get(e.subject);
        if (history === undefined) {
          history = await loadGrowthReferenceFacts(pool, e.subject, asOfNow);
          growthFactsBySubject.set(e.subject, history);
        }
        const growth = growthReferenceLineage(e, history);
        growthByEvent.set(e.eventId, growth);
        const ids = new Set(growth.revisionFactIds);
        for (const original of history) if (ids.has(original.factId)) inputFacts.set(original.factId, original);
      }
    }
    const subjects = [...new Set(events.map((e) => e.subject))].sort();
    const barsBySubject = new Map<string, DailyBarInput[]>();
    const factorsBySubject = new Map<string, AdjustFactorInput[]>();
    const icvBySubject = new Map<string, Parameters<typeof industryAsOf>[0]>();
    for (const code of subjects) {
      barsBySubject.set(code, dailyBarsFromFacts(await load({ subjectType: 'STOCK', subjectId: code, factKind: 'DAILY_BAR', asOf: asOfNow })));
      factorsBySubject.set(code, adjustFactorsFromFacts(await load({ subjectType: 'STOCK', subjectId: code, factKind: 'ADJUST_FACTOR', asOf: asOfNow })));
      icvBySubject.set(
        code,
        (await load({ subjectType: 'STOCK', subjectId: code, factKind: 'INDUSTRY_CLASS_VERSION', asOf: asOfNow }))
          .filter((f) => f.adapterVersion.startsWith('sw@')), // csrc@current 快照行排除（非申万轴）
      );
    }

    // ---- 每事件行业 as-of（事件时点当时版本）→ 指数集合 ----
    const industryByEvent = new Map<number, IndustryAsOf | null>();
    events.forEach((e, i) => industryByEvent.set(i, industryAsOf(icvBySubject.get(e.subject) ?? [], e.eventTime)));
    const indexCodes = [...new Set(
      [...industryByEvent.values()].flatMap((v) => (v !== null && v.l1IndexCode !== null ? [v.l1IndexCode] : [])),
    )].sort();
    const indexBarsByCode = new Map<string, IndexBarInput[]>();
    for (const code of indexCodes) {
      indexBarsByCode.set(code, swIndexBarsFromFacts(await load({ subjectType: 'INDEX', subjectId: code, factKind: 'SW_INDEX_BAR', asOf: asOfNow })));
    }
    const hs300Bars = dailyBarsFromFacts(await load({ subjectType: 'INDEX', subjectId: HS300_INDEX_CODE, factKind: 'DAILY_BAR', asOf: asOfNow }));

    // ---- 市值档分界（等分位预留默认，全库统一；总股本不可得 → 成交额代理 proxy=true）----
    const settledByEvent = new Map<number, DailyBarInput>();
    const capInputs: { index: number; close: string; amount: string }[] = [];
    events.forEach((e, i) => {
      const bar = lastSettledBar(barsBySubject.get(e.subject) ?? [], e.eventTime);
      if (bar === null) return;
      settledByEvent.set(i, bar);
      const amount = bar.amount ?? null;
      if (amount !== null && String(amount).trim() !== '') {
        capInputs.push({ index: i, close: String(bar.close), amount: String(amount) });
      }
    });
    const bounds = tercileBounds(capInputs.map((c) => c.amount));
    const boundsMethod = 'tercile-reserved' as const;
    const capByEvent = new Map<number, MarketCapTierResult | null>();
    for (const c of capInputs) {
      capByEvent.set(
        c.index,
        bounds === null ? null : marketCapTierOf(
          { date: settledByEvent.get(c.index)!.date, close: c.close, totalShares: null, amount: c.amount },
          bounds,
          boundsMethod,
        ),
      );
    }

    // ---- 窗口收益 + 样本层元数据 ----
    const samples: ReferenceEventLayers[] = [];
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
      samples.push({
        lineage: { eventId: e.eventId, evidenceFactId: e.evidenceFactId,
          ...(growthByEvent.has(e.eventId) ? { growth: growthByEvent.get(e.eventId)! } : {}),
          windows: win.windows.map((w) => ({ h: w.h, status: w.status, endDate: w.endDate,
            maturedAt: w.endDate !== null && (w.status === 'OK' || w.status === 'INDEX_GAP')
              ? new Date(`${w.endDate}T15:00:00+08:00`).toISOString() : null })) },
        subject: e.subject,
        eventTime: e.eventTime,
        eventKey: eventKeyOf(e.eventType, e.subtype),
        industry,
        marketCap: capByEvent.get(i) ?? null,
        marketState: marketStateOf(hs300Bars, e.eventTime)?.state ?? null,
        h1Excess: win.windows.find((w) => w.h === 1)?.excessReturn ?? null,
        h5Excess: win.windows.find((w) => w.h === 5)?.excessReturn ?? null,
        h20Excess: win.windows.find((w) => w.h === 20)?.excessReturn ?? null,
        invalidationDown: win.invalidation.downTriggered,
        invalidationUp: win.invalidation.upTriggered,
        dataGaps: win.dataGaps,
      });
    }

    // ---- 群组库构建 + 落库 + summary ----
    const inputAvailableAtMax = [...inputFacts.values()].map((f) => f.availableAt).sort().at(-1) ?? null;
    const lib = buildGroupLibrary(samples, {
      minGroupSample: DEFAULT_MIN_GROUP_SAMPLE,
      methodVersion: METHOD_VERSION,
      adapterVersion: `${SW_ADAPTER};baostock@0.9.40-p1`,
      inputAvailableAtMax,
      materializedAt,
    });
    await applyReferenceMigration(pool);
    const saved = await saveGroupStats(pool, lib.groups, [...inputFacts.values()], {
      methodVersion: METHOD_VERSION, adapterVersion: `${SW_ADAPTER};baostock@0.9.40-p1`, inputAvailableAtMax, materializedAt,
    });
    // 旧版本及成员永不删除；本版本缺席的群组不影响旧截点读取。
    const prunedKeys: string[] = [];

    const eventsByType = new Map<string, number>();
    for (const e of events) {
      const k = eventKeyOf(e.eventType, e.subtype);
      eventsByType.set(k, (eventsByType.get(k) ?? 0) + 1);
    }
    const summary = {
      result: 'REFERENCE LIBRARY BUILD OK',
      generatedAt: materializedAt,
      eventsTotal: events.length,
      subjects: subjects.length,
      excludedProgressEvents: {
        eventKey: 'BUYBACK:PROGRESS_OR_CHANGE',
        count: excludedProgressCount,
        basis: 'R25.1：回购普通进展公告不触发新实例（HISTORICAL-REFERENCE §3.6）——存储层保超集，参照库统计消费侧排除。',
      },
      eventsByType: Object.fromEntries([...eventsByType.entries()].sort()),
      groupsTotal: lib.groups.length,
      groupsSaved: saved,
      prunedStaleGroupKeys: prunedKeys,
      groupKeys: lib.groups.map((g) => ({ groupKey: g.groupKey, sampleCount: g.sampleCount })),
      layerInputMissing: lib.layerInputMissing,
      industryIndexCodes: indexCodes,
      dataGapCounts: Object.fromEntries([...gapCounter.entries()].sort()),
      dataGaps: lib.dataGaps,
      reservedParams: {
        INVALIDATION_THRESHOLD_PCT,
        MIN_GROUP_SAMPLE: DEFAULT_MIN_GROUP_SAMPLE,
        MARKET_CAP_TIERS: bounds === null ? 'tercile unavailable（样本不足）' : `${bounds[0]}/${bounds[1]}（等分位预留值，待 P4 校准冻结）`,
      },
      nestedDeclaration: NESTED_GROUP_DECLARATION,
      revisionNotice: REVISION_NOTICE,
      versionBinding: {
        methodVersion: METHOD_VERSION,
        adapterVersion: `${SW_ADAPTER};baostock@0.9.40-p1`,
        inputAvailableAtMax,
        materializedAt,
      },
      summaryPath: SUMMARY_PATH,
    };
    await writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify({
      result: 'REFERENCE LIBRARY BUILD OK',
      eventsTotal: events.length,
      excludedProgressEvents: excludedProgressCount,
      prunedStaleGroupKeys: prunedKeys.length,
      groupsSaved: saved,
      dataGapKinds: Object.keys(summary.dataGapCounts).length,
      summaryPath: SUMMARY_PATH,
    }, null, 2));
  } catch (error) {
    console.error(`[reference-build] 失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('reference/build.cli.ts');
if (isMain) {
  await main();
}
