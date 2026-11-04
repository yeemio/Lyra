/**
 * Lyra · 历史参照库 · 群组统计对象与持久化（P3 随轮提前 / W15: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §8（产出物）、§5（父层同口径、嵌套声明）、
 * §6（修订口径声明随全部输出原样携带）、§4（统计产出为描述性统计，非预测概率）。
 *
 * 群组统计对象（每群组）：样本数、1/5/20 日超额均值/中位数（精确十进制定点，描述性）、
 * 失效触发比例（两侧分列、预留阈值 10%）、基础比例（方向分布 + 触发比例）、缺口清单、
 * 嵌套声明、修订口径声明、版本绑定（方法/适配器版本轴 + 输入 available_at 上限 + materialized_at）。
 * 匹配为空只有缺口没有群组（缺口是合法产出，§8）——buildGroupLibrary 对样本数低于
 * MIN_GROUP_SAMPLE 的节点不产出统计块（不降档凑样本，§5）。
 *
 * 持久化：src/db/reference-migration.sql（reference_library_versions 完整不可变发布，
 * 成员/窗口/输入事实身份/最大可用及观察时刻/构建时刻/DB 发布时间）。旧可变表仅保留审计。
 * 单测不碰网络不碰 DB：统计构建为纯函数，持久化接口由调用方注入 Pool。
 */
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { TimePointFact } from '../contracts.js';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { queryFactRows, rowToFact } from '../db/pintime.js';
import { detectGrowthEvents, eventIdOf, type DetectedEvent, type GrowthInput } from '../events/detect.js';
import {
  NESTED_GROUP_DECLARATION,
  REVISION_NOTICE,
  baseRateOf,
  industryAsOf,
  industryLayerKey,
  marketCapLayerKey,
  type BaseRateBlock,
  type GroupLayerName,
  type ReferenceEventLayers,
} from './groups.js';
import { adjustFactorsFromFacts, dailyBarsFromFacts, eventWindowReturns, swIndexBarsFromFacts, fAdd, fDiv, fixedToString, parseFixed, type Fixed } from './excess.js';

// ===== 群组统计对象 =====

export interface WindowStat {
  /** 超额均值（定点字符串；无有效样本为 null）。 */
  mean: string | null;
  /** 超额中位数（定点字符串；偶数样本取中间两数均值）。 */
  median: string | null;
  /** 有效样本数。 */
  n: number;
}

export interface GroupStatBlock {
  groupKey: string;
  /** 本群组的完整成员快照；与统计和版本一起不可变，不依赖当前 events 表。 */
  members: ReferenceEventLayers[];
  /** 逐层键（与 groupKey 的 '|' 连接一致；嵌套路径）。 */
  path: string[];
  layers: GroupLayerName[];
  sampleCount: number;
  stats: {
    h1: WindowStat;
    h5: WindowStat;
    h20: WindowStat;
    invalidation: BaseRateBlock['invalidation'];
  };
  baseRatio: BaseRateBlock;
  nestedDeclaration: string;
  revisionNotice: string;
  /** 预留值参数清单（P4 校准冻结前全程标注，§9）。 */
  reservedParams: string[];
  dataGaps: string[];
  versionBinding: {
    methodVersion: string;
    adapterVersion: string;
    inputAvailableAtMax: string | null;
    materializedAt: string;
  };
}

export interface GroupLibraryBuildOptions {
  minGroupSample: number;
  methodVersion: string;
  adapterVersion: string;
  inputAvailableAtMax: string | null;
  materializedAt: string;
}

function windowStatOf(samples: ReferenceEventLayers[], pick: (s: ReferenceEventLayers) => string | null): WindowStat {
  const values = samples
    .map((s) => pick(s))
    .filter((v): v is string => v !== null)
    .map((v) => parseFixed(v))
    .filter((v): v is Fixed => v !== null);
  if (values.length === 0) return { mean: null, median: null, n: 0 };
  const sorted = [...values].sort(scaleAlignCmp);
  let sum = { int: 0n, scale: 0 };
  for (const v of values) sum = fAdd(sum, v);
  const mean = fDiv(sum, { int: BigInt(values.length), scale: 0 }, 10);
  const mid = Math.floor(sorted.length / 2);
  let median: string | null;
  if (sorted.length % 2 === 1) {
    median = fixedToString(sorted[mid]!);
  } else {
    const m = fDiv(fAdd(sorted[mid - 1]!, sorted[mid]!), { int: 2n, scale: 0 }, 10);
    median = m === null ? null : fixedToString(m);
  }
  return { mean: mean === null ? null : fixedToString(mean), median, n: values.length };
}

/** 定点升序比较（组内排序用；与 excess.fCmp 同语义）。 */
function scaleAlignCmp(a: Fixed, b: Fixed): number {
  const scale = Math.max(a.scale, b.scale);
  const ai = a.int * 10n ** BigInt(scale - a.scale);
  const bi = b.int * 10n ** BigInt(scale - b.scale);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

const RESERVED_PARAMS = [
  'INVALIDATION_THRESHOLD_PCT=10（价格失效阈值，预留值，P4 校准冻结，HISTORICAL-REFERENCE §9）',
  'MIN_GROUP_SAMPLE（群组样本下限，预留值，P4 冻结，§5）',
  'MARKET_CAP_TIERS（市值三档分界，预留等分位，P4 冻结，§5）',
];

function statBlockOf(
  layers: GroupLayerName[],
  path: string[],
  samples: ReferenceEventLayers[],
  baseRate: BaseRateBlock,
  opts: GroupLibraryBuildOptions,
): GroupStatBlock {
  return {
    groupKey: path.join('|'),
    members: [...samples].sort((a, b) => canonicalJsonString(a).localeCompare(canonicalJsonString(b))),
    path,
    layers,
    sampleCount: samples.length,
    stats: {
      h1: windowStatOf(samples, (s) => s.h1Excess),
      h5: windowStatOf(samples, (s) => s.h5Excess),
      h20: windowStatOf(samples, (s) => s.h20Excess),
      invalidation: baseRate.invalidation,
    },
    baseRatio: baseRate,
    nestedDeclaration: NESTED_GROUP_DECLARATION,
    revisionNotice: REVISION_NOTICE,
    reservedParams: RESERVED_PARAMS,
    dataGaps: baseRate.dataGaps,
    versionBinding: {
      methodVersion: opts.methodVersion,
      adapterVersion: opts.adapterVersion,
      inputAvailableAtMax: opts.inputAvailableAtMax,
      materializedAt: opts.materializedAt,
    },
  };
}

export interface GroupLibraryBuildResult {
  /** 全部满足下限的群组统计块（含 BASE 层与各父层——父层同口径，§5）。 */
  groups: GroupStatBlock[];
  /** 参与构建的样本总数。 */
  totalSamples: number;
  /** 构建期缺口汇总（样本级具名缺口去重）。 */
  dataGaps: string[];
  /** 层输入缺失样本计数（行业/市值/市场状态不可得）。 */
  layerInputMissing: { industry: number; marketCap: number; marketState: number };
}

/**
 * 全量群组库构建（§5 机械枚举：每条真实存在的层路径，节点样本数 ≥ minGroupSample 才成块；
 * 子节点低于下限即停止下钻——与 selectGroups 的单查询收窄规则同构）。
 * 匹配为空（某层无样本/全低于下限）不产出群组块——缺口随 dataGaps 汇总（合法产出，§8）。
 */
export function buildGroupLibrary(
  samples: ReferenceEventLayers[],
  opts: GroupLibraryBuildOptions,
): GroupLibraryBuildResult {
  // 空库：缺口是合法产出，不产出任何群组块（含 BASE——0 样本的比例无意义，§8 空匹配精神）。
  const groups: GroupStatBlock[] =
    samples.length === 0 ? [] : [statBlockOf(['BASE'], ['all-events'], samples, baseRateOf(samples), opts)];
  const gaps = new Set<string>();
  const layerInputMissing = { industry: 0, marketCap: 0, marketState: 0 };
  for (const s of samples) {
    if (s.industry === null) layerInputMissing.industry += 1;
    if (s.marketCap === null) layerInputMissing.marketCap += 1;
    if (s.marketState === null) layerInputMissing.marketState += 1;
    for (const g of s.dataGaps) gaps.add(`${s.subject}@${s.eventTime}:${g}`);
  }

  const byEventKey = new Map<string, ReferenceEventLayers[]>();
  for (const s of samples) {
    const list = byEventKey.get(s.eventKey) ?? [];
    list.push(s);
    byEventKey.set(s.eventKey, list);
  }

  const enumerate = (
    current: ReferenceEventLayers[],
    layers: GroupLayerName[],
    path: string[],
    nextValueOf: (s: ReferenceEventLayers) => string | null,
    nextLayer: GroupLayerName,
    rest: Array<(s: ReferenceEventLayers) => string | null>,
    restLayers: GroupLayerName[],
  ): void => {
    const distinct = new Set<string>();
    for (const s of current) {
      const v = nextValueOf(s);
      if (v !== null) distinct.add(v);
    }
    for (const value of [...distinct].sort()) {
      const next = current.filter((s) => nextValueOf(s) === value);
      if (next.length < opts.minGroupSample) continue; // 低于下限：不降档凑样本，该分支停止
      const nextLayers = [...layers, nextLayer];
      const nextPath = [...path, value];
      groups.push(statBlockOf(nextLayers, nextPath, next, baseRateOf(next), opts));
      const [further, ...restRest] = rest;
      const [furtherLayer, ...restRestLayers] = restLayers;
      if (further !== undefined && furtherLayer !== undefined) {
        enumerate(next, nextLayers, nextPath, further, furtherLayer, restRest, restRestLayers);
      }
    }
  };

  const industryKey = (s: ReferenceEventLayers): string | null =>
    s.industry === null ? null : industryLayerKey(s.industry);
  const capKey = (s: ReferenceEventLayers): string | null =>
    s.marketCap === null ? null : marketCapLayerKey(s.marketCap);
  const stateKey = (s: ReferenceEventLayers): string | null =>
    s.marketState === null ? null : `mkt:${s.marketState}`;

  for (const eventKey of [...byEventKey.keys()].sort()) {
    const sameType = byEventKey.get(eventKey)!;
    if (sameType.length < opts.minGroupSample) continue;
    groups.push(
      statBlockOf(['EVENT_TYPE'], [`type:${eventKey}`], sameType, baseRateOf(sameType), opts),
    );
    enumerate(
      sameType,
      ['EVENT_TYPE'],
      [`type:${eventKey}`],
      industryKey,
      'INDUSTRY',
      [capKey, stateKey],
      ['MARKET_CAP', 'MARKET_STATE'],
    );
  }

  return { groups, totalSamples: samples.length, dataGaps: [...gaps].sort(), layerInputMissing };
}

// ===== 不可变版本持久化（src/db/reference-migration.sql）=====

const migrationSqlUrl = new URL('../db/reference-migration.sql', import.meta.url);

/** 幂等应用参照库迁移（只建自有新表）。 */
export async function applyReferenceMigration(pool: Pool): Promise<void> {
  const ddl = await readFile(migrationSqlUrl, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(ddl);
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时忽略。
    }
    throw error;
  } finally {
    client.release();
  }
}

export class ReferenceVersionError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'ReferenceVersionError'; }
}

export interface ReferenceVersionPayload {
  schemaVersion: 1;
  buildIdentity: GroupStatBlock['versionBinding'];
  materializedAt: string;
  inputAvailableAtMax: string;
  inputObservedAtMax: string;
  maturityAtMax: string;
  groups: GroupStatBlock[];
  inputFacts: { factId: string; artifactSha256: string; factHash: string; availableAt: string; firstObservedAt: string }[];
}
export interface ReferenceVersion {
  versionId: string;
  contentHash: string;
  publishedAt: string;
  payload: ReferenceVersionPayload;
}

function instant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ReferenceVersionError('REFERENCE_TIME_INVALID', value);
  return new Date(ms).toISOString();
}

/** 建库专用历史读取：保留 superseded 原行，不能用 asOfFacts 隐去初披证据。 */
export async function loadGrowthReferenceFacts(pool: Pool, subject: string, asOf: Date): Promise<TimePointFact[]> {
  instant(asOf.toISOString());
  return (await queryFactRows(pool, { subjectType: 'STOCK', subjectId: subject, factKind: 'FINANCIAL' }, asOf))
    .map(rowToFact).filter((f) => (f.typedValue as Record<string, unknown> | null)?.bsQuery === 'growth');
}

/** 用原事实重演检测器；只绑定该事件已选定的数值快照，不把后来修订套到旧事件。 */
export function growthReferenceLineage(
  event: Pick<DetectedEvent, 'subject' | 'eventTime' | 'evidenceFactId' | 'attrs'>,
  facts: readonly TimePointFact[],
): NonNullable<NonNullable<ReferenceEventLayers['lineage']>['growth']> {
  const fail = (): never => { throw new ReferenceVersionError('REFERENCE_GROWTH_LINEAGE_UNBOUND', `${event.subject}@${event.eventTime}`); };
  if (event.attrs === null || typeof event.attrs !== 'object') return fail();
  const threshold = event.attrs.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return fail();
  const rows: { fact: TimePointFact; input: GrowthInput }[] = [];
  for (const fact of facts) {
    const v = fact.typedValue as Record<string, unknown> | null;
    if (fact.subjectType !== 'STOCK' || fact.subjectId !== event.subject || fact.factKind !== 'FINANCIAL' || v?.bsQuery !== 'growth') continue;
    if (typeof v.statDate !== 'string' || typeof v.pubDate !== 'string') return fail();
    const y = v.YOYNI;
    rows.push({ fact, input: { factId: fact.factId, statDate: v.statDate, pubDate: v.pubDate,
      availableAt: instant(fact.availableAt), yoyNi: y != null && y !== '' && Number.isFinite(Number(y)) ? Number(y) : null } });
  }
  const current = rows.find((r) => r.fact.factId === event.evidenceFactId);
  const previous = rows.filter((r) => r.input.statDate === event.attrs.prevStatDate && r.input.pubDate === event.attrs.prevPubDate &&
    r.input.yoyNi === event.attrs.yoyNiPrev).sort((a, b) => a.input.availableAt.localeCompare(b.input.availableAt) || a.fact.factId.localeCompare(b.fact.factId)).at(-1);
  if (current === undefined || previous === undefined || current.input.statDate !== event.attrs.statDate) return fail();
  // 两个报告期各以原选定数值事实的 availableAt 为修订链上限；版本仍绑定这些事实的真实观察/构建时间。
  const history = rows.filter((r) =>
    (r.input.statDate === current.input.statDate && r.input.availableAt <= current.input.availableAt) ||
    (r.input.statDate === previous.input.statDate && r.input.availableAt <= previous.input.availableAt));
  const byId = new Map(history.map((r) => [r.fact.factId, r]));
  for (const row of history) {
    const seen = new Set<string>();
    let cursor = row;
    while (cursor.fact.supersedesFactId !== null) {
      if (seen.has(cursor.fact.factId)) return fail();
      seen.add(cursor.fact.factId);
      const parent = byId.get(cursor.fact.supersedesFactId);
      if (parent === undefined || parent.input.statDate !== cursor.input.statDate || parent.input.availableAt > cursor.input.availableAt) return fail();
      cursor = parent;
    }
  }
  // 相同时刻的并存行不替换原选中的证据身份；阈值、差值及声明仍由现有检测器复算。
  const replay = detectGrowthEvents(event.subject,
    [current, previous, ...history.filter((r) => r !== current && r !== previous)].map((r) => r.input), threshold)
    .events.find((e) => e.evidenceFactId === event.evidenceFactId);
  if (replay === undefined || instant(replay.eventTime) !== instant(event.eventTime) || canonicalSha256(replay.attrs) !== canonicalSha256(event.attrs)) return fail();
  const first = history.filter((r) => r.input.statDate === current.input.statDate)
    .sort((a, b) => a.input.availableAt.localeCompare(b.input.availableAt) || a.fact.factId.localeCompare(b.fact.factId))[0]!;
  return { firstDisclosureFactId: first.fact.factId, previousEvidenceFactId: previous.fact.factId,
    revisionFactIds: history.map((r) => r.fact.factId).sort(), attrs: structuredClone(replay.attrs) };
}

/** 只构造有完整成员/成熟窗口/输入事实身份的版本。当前修订值不升级为严格 PIT。 */
export function referenceVersionPayload(blocks: GroupStatBlock[], inputFacts: readonly TimePointFact[], buildIdentity = blocks[0]?.versionBinding): ReferenceVersionPayload {
  if (buildIdentity === undefined || (blocks.length !== 0 && inputFacts.length === 0)) throw new ReferenceVersionError('REFERENCE_LINEAGE_MISSING', '缺构建身份或非空群组的输入事实');
  const materializedAt = instant(buildIdentity.materializedAt);
  const byId = new Map(inputFacts.map((f) => [f.factId, f]));
  if (byId.size !== inputFacts.length) throw new ReferenceVersionError('REFERENCE_LINEAGE_CONFLICT', '重复输入 factId');
  const keys = new Set<string>();
  const maturities: string[] = [];
  const checkedEvents = new Map<string, string>();
  const factGroups = new Map<string, TimePointFact[]>();
  for (const f of inputFacts) {
    const key = `${f.subjectType}/${f.subjectId}/${f.factKind}`;
    const group = factGroups.get(key) ?? [];
    group.push(f); factGroups.set(key, group);
  }
  for (const b of blocks) {
    if (keys.has(b.groupKey) || canonicalJsonString(b.versionBinding) !== canonicalJsonString(buildIdentity) || b.members.length !== b.sampleCount ||
        new Set(b.members.map((m) => m.lineage?.eventId)).size !== b.members.length) {
      throw new ReferenceVersionError('REFERENCE_LINEAGE_CONFLICT', b.groupKey);
    }
    keys.add(b.groupKey);
    const recalculated = statBlockOf(b.layers, b.path, b.members, baseRateOf(b.members), {
      ...buildIdentity, minGroupSample: 1,
    });
    if (canonicalSha256({ stats: b.stats, baseRatio: b.baseRatio }) !==
        canonicalSha256({ stats: recalculated.stats, baseRatio: recalculated.baseRatio })) {
      throw new ReferenceVersionError('REFERENCE_STATS_UNBOUND', b.groupKey);
    }
    for (const m of b.members) {
      const l = m.lineage;
      const fact = l === undefined ? undefined : byId.get(l.evidenceFactId);
      if (!l?.eventId || fact?.subjectType !== 'STOCK' || fact.subjectId !== m.subject ||
          instant(m.eventTime) > materializedAt) {
        throw new ReferenceVersionError('REFERENCE_EVENT_UNBOUND', `${m.subject}@${m.eventTime}`);
      }
      if (m.eventKey === 'PERIOD_GROWTH_DELTA') {
        if (l.growth === undefined || l.eventId !== eventIdOf(m.subject, 'PERIOD_GROWTH_DELTA', l.evidenceFactId) ||
            canonicalSha256(l.growth) !== canonicalSha256(growthReferenceLineage({ subject: m.subject,
              eventTime: m.eventTime, evidenceFactId: l.evidenceFactId, attrs: l.growth.attrs }, factGroups.get(`STOCK/${m.subject}/FINANCIAL`) ?? []))) {
          throw new ReferenceVersionError('REFERENCE_GROWTH_LINEAGE_UNBOUND', l.eventId);
        }
      } else if (l.growth !== undefined || instant(fact.availableAt) > instant(m.eventTime)) {
        throw new ReferenceVersionError('REFERENCE_EVENT_UNBOUND', `${m.subject}@${m.eventTime}`);
      }
      const memberHash = canonicalSha256(m);
      const previous = checkedEvents.get(l.eventId);
      if (previous !== undefined && previous !== memberHash) throw new ReferenceVersionError('REFERENCE_LINEAGE_CONFLICT', l.eventId);
      if (previous === undefined) {
        const get = (type: string, subject: string, kind: string) => factGroups.get(`${type}/${subject}/${kind}`) ?? [];
        const industry = industryAsOf(get('STOCK', m.subject, 'INDUSTRY_CLASS_VERSION').filter((f) => f.adapterVersion.startsWith('sw@')), m.eventTime);
        if (canonicalSha256(industry) !== canonicalSha256(m.industry)) throw new ReferenceVersionError('REFERENCE_INDUSTRY_UNBOUND', l.eventId);
        const window = eventWindowReturns({ subject: m.subject, eventTime: m.eventTime, industryL1AsOf: industry?.l1IndexCode ?? null,
          bars: dailyBarsFromFacts(get('STOCK', m.subject, 'DAILY_BAR')),
          factors: adjustFactorsFromFacts(get('STOCK', m.subject, 'ADJUST_FACTOR')),
          indexBars: industry?.l1IndexCode == null ? [] : swIndexBarsFromFacts(get('INDEX', industry.l1IndexCode, 'SW_INDEX_BAR')) });
        const expectedWindows = window.windows.map((w) => ({ h: w.h, status: w.status, endDate: w.endDate,
          maturedAt: w.endDate !== null && (w.status === 'OK' || w.status === 'INDEX_GAP') ? instant(`${w.endDate}T15:00:00+08:00`) : null }));
        if (canonicalSha256(expectedWindows) !== canonicalSha256(l.windows) ||
            window.windows.some((w) => w.excessReturn !== (w.h === 1 ? m.h1Excess : w.h === 5 ? m.h5Excess : m.h20Excess)) ||
            window.invalidation.downTriggered !== m.invalidationDown || window.invalidation.upTriggered !== m.invalidationUp) {
          throw new ReferenceVersionError('REFERENCE_WINDOW_UNBOUND', l.eventId);
        }
        checkedEvents.set(l.eventId, memberHash);
      }
      if (l.windows.length !== 3 || new Set(l.windows.map((w) => w.h)).size !== 3) {
        throw new ReferenceVersionError('REFERENCE_MATURITY_MISSING', l.eventId);
      }
      for (const h of [1, 5, 20] as const) {
        const w = l.windows.find((x) => x.h === h);
        const value = h === 1 ? m.h1Excess : h === 5 ? m.h5Excess : m.h20Excess;
        if (w === undefined || (value !== null && (w.status !== 'OK' || w.maturedAt === null || w.endDate === null))) {
          throw new ReferenceVersionError('REFERENCE_MATURITY_MISSING', `${l.eventId}/${h}`);
        }
        if (w.maturedAt !== null) {
          const expected = instant(`${w.endDate}T15:00:00+08:00`);
          if (instant(w.maturedAt) !== expected || expected > materializedAt || expected <= instant(m.eventTime)) {
            throw new ReferenceVersionError('REFERENCE_MATURITY_INVALID', `${l.eventId}/${h}`);
          }
          maturities.push(expected);
        }
      }
    }
  }
  const refs = inputFacts.map((f) => ({ factId: f.factId, artifactSha256: f.artifactSha256,
    factHash: canonicalSha256(f), availableAt: instant(f.availableAt), firstObservedAt: instant(f.firstObservedAt) }))
    .sort((a, b) => a.factId.localeCompare(b.factId));
  const actualAvailable = refs.map((r) => r.availableAt).sort().at(-1) ?? null;
  if ((buildIdentity.inputAvailableAtMax === null ? null : instant(buildIdentity.inputAvailableAtMax)) !== actualAvailable) {
    throw new ReferenceVersionError('REFERENCE_INPUT_BOUND_MISMATCH', '构建声明与实际输入最大可用时间不符');
  }
  const inputAvailableAtMax = actualAvailable ?? materializedAt;
  const inputObservedAtMax = refs.map((r) => r.firstObservedAt).sort().at(-1) ?? materializedAt;
  if (inputAvailableAtMax > materializedAt || inputObservedAtMax > materializedAt) {
    throw new ReferenceVersionError('REFERENCE_INPUT_AFTER_BUILD', materializedAt);
  }
  return { schemaVersion: 1, buildIdentity: structuredClone(buildIdentity), materializedAt, inputAvailableAtMax, inputObservedAtMax,
    maturityAtMax: maturities.sort().at(-1) ?? materializedAt,
    groups: structuredClone(blocks).sort((a, b) => a.groupKey.localeCompare(b.groupKey)), inputFacts: refs };
}

/** 追加一个完整版本；冲突只允许相同内容，不覆盖/删除任何旧群组。published_at 由 DB 生成。 */
export async function saveGroupStats(pool: Pool, blocks: GroupStatBlock[], inputFacts: readonly TimePointFact[] = [], buildIdentity = blocks[0]?.versionBinding): Promise<number> {
  const payload = referenceVersionPayload(blocks, inputFacts, buildIdentity);
  const contentHash = canonicalSha256(payload);
  const versionId = `rl-${contentHash}`;
  const result = await pool.query(
    `insert into reference_library_versions
      (version_id, content_hash, payload, materialized_at, input_available_at_max, input_observed_at_max, maturity_at_max)
     values ($1,$2,$3::jsonb,$4,$5,$6,$7) on conflict (version_id) do nothing`,
    [versionId, contentHash, canonicalJsonString(payload), payload.materializedAt,
      payload.inputAvailableAtMax, payload.inputObservedAtMax, payload.maturityAtMax],
  );
  if (result.rowCount === 0) {
    const row = await pool.query('select content_hash, payload from reference_library_versions where version_id=$1', [versionId]);
    if (row.rows[0]?.content_hash !== contentHash || canonicalSha256(row.rows[0]?.payload) !== contentHash) {
      throw new ReferenceVersionError('REFERENCE_VERSION_CONFLICT', versionId);
    }
  }
  return blocks.length;
}

/** 研究截点可见的最后一次完整发布；不从旧可变表降级读取，不混合不同构建的群组。 */
export async function loadReferenceVersion(pool: Pool, cutoff: string): Promise<ReferenceVersion | null> {
  const at = instant(cutoff);
  const res = await pool.query(
    `select version_id, content_hash, payload, published_at from reference_library_versions
     where published_at <= $1 and materialized_at <= $1 and input_available_at_max <= $1
       and input_observed_at_max <= $1 and maturity_at_max <= $1
     order by published_at desc, version_id desc limit 1`, [at],
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  const payload = row.payload as ReferenceVersionPayload;
  const hash = canonicalSha256(payload);
  if (hash !== row.content_hash || row.version_id !== `rl-${hash}` || payload.schemaVersion !== 1 || new Date(row.published_at).toISOString() > at ||
      [payload.materializedAt, payload.inputAvailableAtMax, payload.inputObservedAtMax, payload.maturityAtMax].some((t) => instant(t) > at)) {
    throw new ReferenceVersionError('REFERENCE_VERSION_CORRUPT', String(row.version_id));
  }
  return { versionId: String(row.version_id), contentHash: hash, publishedAt: new Date(row.published_at).toISOString(), payload };
}

export async function loadGroupLibraryRows(pool: Pool, cutoff: string): Promise<GroupStatBlock[]> {
  return (await loadReferenceVersion(pool, cutoff))?.payload.groups ?? [];
}
