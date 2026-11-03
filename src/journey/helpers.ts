/**
 * Lyra · 旅程测试隔离环境与合成宇宙构造器（P0 Done-when / EK-10.2）。W3: code-writer-pro。
 *
 * - startJourney：每运行建独立 schema（p0_journey_<runid>，经 W1 的 applySchema 应用
 *   冻结 schema.sql）+ 临时原件目录（ArtifactStore，隐私级 0700）+ 旅程预算。
 * - buildSyntheticUniverse：一只主板个股 + 一只宽基标的的全部合成事实（原件入库、
 *   事实落库），覆盖四类时点对象并**故意埋入截点后事实**（泄漏测试注入方向，
 *   POINT-IN-TIME §8）；含截点当日公告两条路径（有披露时刻 / 日精度 D+1）与
 *   预约披露表、行业分类的版本切换链。
 * - dropAllJourneySchemas：结束清理全部 p0_journey_* schema。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import type { PlanAuthBudget, TimePointFact, TimePointFactKind } from '../contracts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';

export const JOURNEY_VERSION_ID = '0.1.0-p0';
export const HOLDER = 'journey-exec-1';
/** 主板个股（沪主板 600 前缀）与宽基 ETF（51 前缀）合成代码。 */
export const STOCK_CODE = '600519';
export const ETF_CODE = '510300';
/** 资料截点：2026-10-16 15:00 CST（收盘后）。 */
export const CUTOFF = '2026-10-16T07:00:00.000Z';
export const DAY_MS = 86_400_000;

export interface JourneyEnv {
  runId: string;
  schema: string; // p0_journey_<runid>
  admin: Pool; // 无 search_path（建/删 schema 用）
  pool: Pool; // search_path = schema
  store: ArtifactStore;
  artifactsDir: string;
  budget: PlanAuthBudget;
  repoRoot: string;
}

export async function startJourney(): Promise<JourneyEnv> {
  const runId = `${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const schema = `p0_journey_${runId}`;
  const admin = createPool();
  await applySchema(admin, schema);
  const pool = createPool({ schema });
  const artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-p0-journey-'));
  const store = new ArtifactStore(artifactsDir);
  const budget: PlanAuthBudget = {
    planAuthVersion: 'pa-0.1',
    maxModelCallsPerWeek: 40,
    maxInputBytes: 500_000,
    maxInFlight: 2,
  };
  return { runId, schema, admin, pool, store, artifactsDir, budget, repoRoot: fileURLToPath(new URL('../../', import.meta.url)) };
}

/** 删除数据库中全部 p0_journey_* schema（含历史运行残留）。 */
export async function dropAllJourneySchemas(admin: Pool): Promise<string[]> {
  const res = await admin.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname like 'p0_journey_%' order by nspname`,
  );
  const names = res.rows.map((r) => r.nspname);
  for (const name of names) await dropSchema(admin, name);
  return names;
}

/** 旅程结束清理：drop 全部旅程 schema、关闭连接池、删除临时原件目录。 */
export async function stopJourney(env: JourneyEnv): Promise<void> {
  try {
    await dropAllJourneySchemas(env.admin);
  } finally {
    await env.pool.end().catch(() => {});
    await env.admin.end().catch(() => {});
    await rm(env.artifactsDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ===== 合成宇宙 =====

export interface SyntheticUniverse {
  cutoff: string;
  stock: {
    code: string;
    selector: { subjectType: 'STOCK'; subjectId: string };
    /** 边界用例：截点当日公告——有披露时刻（当日可得）。 */
    sameDayTimedFactId: string;
    /** 边界用例：截点当日公告——日精度保守 D+1。 */
    dayPrecisionFactId: string;
    industryV1FactId: string;
    industryV2FactId: string;
    disclosureV1FactId: string;
    disclosureV2FactId: string;
  };
  etf: {
    code: string;
    selector: { subjectType: 'ETF'; subjectId: string };
    futureFactId: string;
  };
  /** 全部故意埋入截点后的事实（泄漏测试断言被挡 / 封存集证伪用）。 */
  plantedFutureFacts: { factId: string; factKind: TimePointFactKind }[];
  /** 零值释放等内核级断言用的最小合法材料。 */
  sampleArtifactSha256: string;
}

const D0_MS = Date.parse(CUTOFF);
const iso = (offsetDays: number, hourShift = 0): string =>
  new Date(D0_MS + offsetDays * DAY_MS + hourShift * 3_600_000).toISOString();

async function addFact(
  pool: Pool,
  store: ArtifactStore,
  base: {
    factId: string;
    subjectType: 'STOCK' | 'ETF';
    subjectId: string;
    factKind: TimePointFactKind;
    availableAt: string;
    supersedesFactId?: string;
    eventAt?: string | null;
    sourcePublishedAt?: string | null;
    typedValue?: Record<string, unknown>;
  },
): Promise<void> {
  const ref = await store.put(
    new TextEncoder().encode(`lyra-p0-journey:${base.factId}`),
    'text/plain',
    base.availableAt,
  );
  const fact: TimePointFact = {
    factId: base.factId,
    subjectType: base.subjectType,
    subjectId: base.subjectId,
    factKind: base.factKind,
    typedValue: base.typedValue ?? { synth: base.factId, note: '合成事实（P0 旅程宇宙）' },
    validFrom: null,
    validTo: null,
    eventAt: base.eventAt ?? null,
    sourcePublishedAt: base.sourcePublishedAt ?? null,
    firstObservedAt: base.availableAt,
    availableAt: base.availableAt,
    supersedesFactId: base.supersedesFactId ?? null,
    artifactSha256: ref.sha256,
    adapterVersion: 'av-0.1',
  };
  await insertFact(pool, fact);
}

/**
 * 建合成宇宙（原件入库 + 事实落库）。时间线相对 CUTOFF（负 = 截点前，正 = 截点后）：
 * 主板个股 600519 覆盖四类时点对象各含截点前可见版 + 故意埋入的截点后版；
 * 宽基 ETF 510300 具备完整研究材料并埋入一条截点后事实。
 */
export async function buildSyntheticUniverse(pool: Pool, store: ArtifactStore): Promise<SyntheticUniverse> {
  // ---- 主板个股 600519 ----
  await addFact(pool, store, { factId: 'p0j-stock-ann-past', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(-3), eventAt: iso(-4) });
  // 边界 1：截点当日公告·有披露时刻（截点前 2 小时披露 → 当日且早于截点，可得）
  await addFact(pool, store, { factId: 'p0j-stock-ann-timed', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(0, -2), eventAt: iso(0, -2), sourcePublishedAt: iso(0, -2) });
  // 边界 2：截点当日公告·日精度（无时刻 → 保守 D+1 可得）
  await addFact(pool, store, { factId: 'p0j-stock-ann-day', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(1), sourcePublishedAt: iso(0) });
  await addFact(pool, store, { factId: 'p0j-stock-ann-future', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(2), eventAt: iso(2) }); // 埋入
  await addFact(pool, store, { factId: 'p0j-stock-fin-past', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'FINANCIAL', availableAt: iso(-5), eventAt: iso(-6) });
  await addFact(pool, store, { factId: 'p0j-stock-fin-future', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'FINANCIAL', availableAt: iso(1) }); // 埋入
  await addFact(pool, store, { factId: 'p0j-stock-icv-v1', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'INDUSTRY_CLASS_VERSION', availableAt: iso(-10), typedValue: { version: '2021' } });
  await addFact(pool, store, { factId: 'p0j-stock-icv-v2', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'INDUSTRY_CLASS_VERSION', availableAt: iso(4), supersedesFactId: 'p0j-stock-icv-v1', typedValue: { version: '2026' } }); // 埋入 + 版本切换
  await addFact(pool, store, { factId: 'p0j-stock-idx-past', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'INDEX_MEMBERSHIP', availableAt: iso(-8), typedValue: { index: '000300' } });
  await addFact(pool, store, { factId: 'p0j-stock-idx-future', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'INDEX_MEMBERSHIP', availableAt: iso(3), typedValue: { index: '000905' } }); // 埋入
  await addFact(pool, store, { factId: 'p0j-stock-adj-past', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ADJUST_FACTOR', availableAt: iso(-2), typedValue: { factor: '1.0000' } });
  await addFact(pool, store, { factId: 'p0j-stock-adj-future', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'ADJUST_FACTOR', availableAt: iso(6), typedValue: { factor: '1.0500' } }); // 埋入
  await addFact(pool, store, { factId: 'p0j-stock-ds-v1', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'DISCLOSURE_SCHEDULE', availableAt: iso(-7), typedValue: { quarter: '2026Q3', date: '2026-10-28' } });
  await addFact(pool, store, { factId: 'p0j-stock-ds-v2', subjectType: 'STOCK', subjectId: STOCK_CODE, factKind: 'DISCLOSURE_SCHEDULE', availableAt: iso(3), supersedesFactId: 'p0j-stock-ds-v1', typedValue: { quarter: '2026Q3', date: '2026-10-30' } }); // 埋入 + 版本切换

  // ---- 宽基 ETF 510300 ----
  await addFact(pool, store, { factId: 'p0j-etf-ann-past', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(-3) });
  await addFact(pool, store, { factId: 'p0j-etf-fin-past', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'FINANCIAL', availableAt: iso(-5) });
  await addFact(pool, store, { factId: 'p0j-etf-idx-past', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'INDEX_MEMBERSHIP', availableAt: iso(-9), typedValue: { tracks: '000300' } });
  await addFact(pool, store, { factId: 'p0j-etf-adj-past', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'ADJUST_FACTOR', availableAt: iso(-4), typedValue: { factor: '1.0000' } });
  await addFact(pool, store, { factId: 'p0j-etf-ds-past', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'DISCLOSURE_SCHEDULE', availableAt: iso(-6), typedValue: { quarter: '2026Q3', date: '2026-10-29' } });
  await addFact(pool, store, { factId: 'p0j-etf-ann-future', subjectType: 'ETF', subjectId: ETF_CODE, factKind: 'ANNOUNCEMENT', availableAt: iso(2) }); // 埋入

  const sample = await store.put(
    new TextEncoder().encode(`lyra-p0-journey:sample-${randomUUID()}`),
    'text/plain',
    iso(-30),
  );

  return {
    cutoff: CUTOFF,    stock: {
      code: STOCK_CODE,
      selector: { subjectType: 'STOCK', subjectId: STOCK_CODE },
      sameDayTimedFactId: 'p0j-stock-ann-timed',
      dayPrecisionFactId: 'p0j-stock-ann-day',
      industryV1FactId: 'p0j-stock-icv-v1',
      industryV2FactId: 'p0j-stock-icv-v2',
      disclosureV1FactId: 'p0j-stock-ds-v1',
      disclosureV2FactId: 'p0j-stock-ds-v2',
    },
    etf: {
      code: ETF_CODE,
      selector: { subjectType: 'ETF', subjectId: ETF_CODE },
      futureFactId: 'p0j-etf-ann-future',
    },
    plantedFutureFacts: [
      { factId: 'p0j-stock-ann-future', factKind: 'ANNOUNCEMENT' },
      { factId: 'p0j-stock-fin-future', factKind: 'FINANCIAL' },
      { factId: 'p0j-stock-icv-v2', factKind: 'INDUSTRY_CLASS_VERSION' },
      { factId: 'p0j-stock-idx-future', factKind: 'INDEX_MEMBERSHIP' },
      { factId: 'p0j-stock-adj-future', factKind: 'ADJUST_FACTOR' },
      { factId: 'p0j-stock-ds-v2', factKind: 'DISCLOSURE_SCHEDULE' },
      { factId: 'p0j-etf-ann-future', factKind: 'ANNOUNCEMENT' },
    ],
    sampleArtifactSha256: sample.sha256,
  };
}

/**
 * 给附加 scratch 标的（零释放/UNKNOWN/版本轴等内核级用例走完整研究轮时）补最小研究材料：
 * 三条截点前事实（公告/财务/复权因子），可封存出非空 manifest。
 */
export async function seedResearchSubject(
  pool: Pool,
  store: ArtifactStore,
  subject: string,
  subjectType: 'STOCK' | 'ETF' = 'STOCK',
): Promise<void> {
  const specs: Array<{ factId: string; factKind: TimePointFactKind }> = [
    { factId: `p0j-${subject}-ann`, factKind: 'ANNOUNCEMENT' },
    { factId: `p0j-${subject}-fin`, factKind: 'FINANCIAL' },
    { factId: `p0j-${subject}-adj`, factKind: 'ADJUST_FACTOR' },
  ];
  for (const spec of specs) {
    await addFact(pool, store, {
      factId: spec.factId,
      subjectType,
      subjectId: subject,
      factKind: spec.factKind,
      availableAt: iso(-3),
    });
  }
}
