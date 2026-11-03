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
 * 持久化：src/db/reference-migration.sql（reference_group_library：group_key、path、
 * sample_count、base_ratio、stats jsonb、nested_declaration、created_at）。
 * 单测不碰网络不碰 DB：统计构建为纯函数，持久化接口由调用方注入 Pool。
 */
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import {
  NESTED_GROUP_DECLARATION,
  REVISION_NOTICE,
  baseRateOf,
  industryLayerKey,
  marketCapLayerKey,
  type BaseRateBlock,
  type GroupLayerName,
  type ReferenceEventLayers,
} from './groups.js';
import { fAdd, fDiv, fixedToString, parseFixed, type Fixed } from './excess.js';

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

// ===== 持久化（reference_group_library；src/db/reference-migration.sql）=====

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

export interface GroupLibraryRow {
  group_key: string;
  path: unknown;
  sample_count: number;
  base_ratio: unknown;
  stats: unknown;
  nested_declaration: string;
  created_at: Date;
}

/** 群组统计落库（upsert：group_key 恒可解析；版本绑定随 stats jsonb 更新，created_at 保留首建）。 */
export async function saveGroupStats(pool: Pool, blocks: GroupStatBlock[]): Promise<number> {
  let saved = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const b of blocks) {
      await client.query(
        `insert into reference_group_library
          (group_key, path, sample_count, base_ratio, stats, nested_declaration)
         values ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6)
         on conflict (group_key) do update set
           path = excluded.path,
           sample_count = excluded.sample_count,
           base_ratio = excluded.base_ratio,
           stats = excluded.stats,
           nested_declaration = excluded.nested_declaration`,
        [
          b.groupKey,
          JSON.stringify(b.path),
          b.sampleCount,
          JSON.stringify(b.baseRatio),
          JSON.stringify(b.stats),
          b.nestedDeclaration,
        ],
      );
      saved += 1;
    }
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // 同上。
    }
    throw error;
  } finally {
    client.release();
  }
  return saved;
}

export async function loadGroupLibraryRows(pool: Pool): Promise<GroupLibraryRow[]> {
  const res = await pool.query(
    'select group_key, path, sample_count, base_ratio, stats, nested_declaration, created_at from reference_group_library order by group_key asc',
  );
  return res.rows as GroupLibraryRow[];
}
