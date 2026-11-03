/**
 * Lyra · 行情序列表格化无损表示〔R2〕（P2 W11: code-writer-pro）。
 * 合同：docs/specs/P2-RESEARCH.md Done-when 2、docs/specs/RESEARCH-METHOD.md §5 第 3 条
 * （行情类数据只用表格化无损格式进入输入，不做叙事化改写）。
 *
 * 无损口径（硬约束）：
 *   - 列 = 该组事实 typedValue 键的并集（已知键按固定序，额外键字典序），不丢列；
 *   - 值 = 原始值原样（字符串保字符串，含尾部零；数字保 IEEE-754 双精度；不改写不舍入）；
 *   - 单元格 null ⇔ 该行事实的 typedValue 缺该键（null 语义二值化：typedValue 内出现
 *     字面 null 值即拒绝，保证 null 单元格唯一解释为"缺键"）；
 *   - meta.rowFacts 与 rows 同长同序，携带 typedValue 之外的全部事实信封字段
 *     （factId / 时间五字段 / supersedes / artifactSha256 / adapterVersion / 主体），
 *     tableToBars 据此逐值重建 TimePointFact——往返后与原事实全等（canonical 比较）；
 *   - 复权因子列（source='adjustFactor'）是按日期连接的派生列，不属于任何 bar 事实的
 *     typedValue；tableToBars 重建时跳过该列。往返无损保证覆盖 bar 事实本身；
 *     ADJUST_FACTOR 事实由封存池另行携带（不在本表内重建）。
 */
import { canonicalJsonString } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';

/** 表格化层具名错误。code 为稳定错误名，不携带实现细节。 */
export class TableError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'TableError';
  }
}

/** 支持表格化的行情事实类型（typedValue 结构由适配器冻结）。 */
export type BarFactKind = 'DAILY_BAR' | 'SW_INDEX_BAR';

/** DAILY_BAR 列首选序（date 前置便于阅读；缺键不补列）。 */
const DAILY_BAR_COLUMN_ORDER = [
  'date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'preclose',
  'turn', 'pctChg', 'isST', 'tradestatus', 'adjustflag', 'code',
] as const;

/** SW_INDEX_BAR 列首选序（来源原生中文键原样保留）。 */
const SW_INDEX_BAR_COLUMN_ORDER = [
  '日期', '开盘', '最高', '最低', '收盘', '成交量', '成交额', '代码', 'swIndexCode',
] as const;

/** 复权因子连接列列名（与 BaoStock 原生字段名一致）。 */
export const ADJUST_FACTOR_COLUMN = 'adjustFactor';

/** typedValue 之外、重建事实所需的全部信封字段（与 TimePointFact 一一对应）。 */
export interface BarTableMetaRow {
  factId: string;
  subjectType: string;
  subjectId: string;
  factKind: string;
  validFrom: string | null;
  validTo: string | null;
  eventAt: string | null;
  sourcePublishedAt: string | null;
  firstObservedAt: string;
  availableAt: string;
  supersedesFactId: string | null;
  artifactSha256: string;
  adapterVersion: string;
}

export interface BarTableMeta {
  factKind: BarFactKind;
  /** 列语义：typedValue 原生键，或复权因子连接列。与 header 同长同序。 */
  columns: { name: string; source: 'typedValue' | 'adjustFactor' }[];
  /** 与 rows 同长同序的行级事实信封。 */
  rowFacts: BarTableMetaRow[];
}

/**
 * 行情表格（R2 无损表示）：
 * - header/rows 是给模型读的紧凑表示（meta 不进入模型视野，随包携带供校验与重建）；
 * - reversible 字面量 true：本模块产出的表恒可逆；tableToBars 对 reversible!==true 的
 *   输入一律拒绝（外部手造表不可冒充可逆）。
 */
export interface BarTable {
  header: string[];
  rows: (string | number | null)[][];
  reversible: true;
  meta: BarTableMeta;
}

export interface BarsToTableOptions {
  /** 参与按日期连接的 ADJUST_FACTOR 事实（已按 as-of 口径取好）；空/缺省则不设连接列。 */
  adjustFactors?: TimePointFact[];
}

function preferredOrder(kind: BarFactKind): readonly string[] {
  return kind === 'DAILY_BAR' ? DAILY_BAR_COLUMN_ORDER : SW_INDEX_BAR_COLUMN_ORDER;
}

function dateKeyOf(kind: BarFactKind): string {
  return kind === 'DAILY_BAR' ? 'date' : '日期';
}

function factKindOf(fact: TimePointFact): BarFactKind {
  if (fact.factKind === 'DAILY_BAR') return 'DAILY_BAR';
  if (fact.factKind === 'SW_INDEX_BAR') return 'SW_INDEX_BAR';
  throw new TableError('TABLE_FACT_KIND_UNSUPPORTED', `${fact.factKind} (${fact.factId})`);
}

function metaRowOf(fact: TimePointFact): BarTableMetaRow {
  return {
    factId: fact.factId,
    subjectType: fact.subjectType,
    subjectId: fact.subjectId,
    factKind: fact.factKind,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    eventAt: fact.eventAt,
    sourcePublishedAt: fact.sourcePublishedAt,
    firstObservedAt: fact.firstObservedAt,
    availableAt: fact.availableAt,
    supersedesFactId: fact.supersedesFactId,
    artifactSha256: fact.artifactSha256,
    adapterVersion: fact.adapterVersion,
  };
}

/**
 * 复权因子按日期连接：对每个 bar 日期取 dividOperateDate <= 该日期的最近一次因子。
 * 因子缺失（该日期之前无任何因子事实）→ null（如实呈现，不外推）。
 */
function joinAdjustFactors(
  rows: (string | number | null)[][],
  dateIdx: number,
  factors: TimePointFact[],
): void {
  const dated = factors.map((f) => {
    if (f.factKind !== 'ADJUST_FACTOR') {
      throw new TableError('TABLE_ADJUST_FACTOR_KIND', `${f.factKind} (${f.factId})`);
    }
    const tv = f.typedValue as Record<string, unknown>;
    const opDate = tv.dividOperateDate ?? tv.divideOperateDate;
    const value = tv.adjustFactor;
    if (typeof opDate !== 'string' || opDate.length === 0) {
      throw new TableError('TABLE_ADJUST_FACTOR_MALFORMED', `dividOperateDate 缺失 (${f.factId})`);
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TableError('TABLE_ADJUST_FACTOR_MALFORMED', `adjustFactor 缺失 (${f.factId})`);
    }
    return { opDate, value: value as string | number };
  });
  dated.sort((a, b) => (a.opDate < b.opDate ? -1 : a.opDate > b.opDate ? 1 : 0));
  for (const row of rows) {
    const barDate = row[dateIdx];
    if (typeof barDate !== 'string') {
      throw new TableError('TABLE_DATE_COLUMN_MISSING', '日期列值非字符串');
    }
    let hit: string | number | null = null;
    for (const f of dated) {
      if (f.opDate <= barDate) hit = f.value;
      else break;
    }
    row.push(hit);
  }
}

/**
 * 行情事实 → 无损表格。列序确定性：首选序（出现过的）→ 额外键字典序 → 复权因子列（如有）。
 * 行序确定性：按日期列字符串升序（最旧在前）。
 */
export function barsToTable(facts: TimePointFact[], options?: BarsToTableOptions): BarTable {
  if (facts.length === 0) {
    return { header: [], rows: [], reversible: true, meta: { factKind: 'DAILY_BAR', columns: [], rowFacts: [] } };
  }
  const kind = factKindOf(facts[0] as TimePointFact);
  for (const fact of facts) {
    if (fact.factKind !== kind) {
      throw new TableError('TABLE_FACT_KIND_MIXED', `${kind} 与 ${fact.factKind} (${fact.factId})`);
    }
    if (fact.typedValue === null || typeof fact.typedValue !== 'object' || Array.isArray(fact.typedValue)) {
      throw new TableError('TABLE_TYPED_VALUE_INVALID', fact.factId);
    }
    for (const [key, value] of Object.entries(fact.typedValue as Record<string, unknown>)) {
      if (value === null || value === undefined) {
        throw new TableError('TABLE_NULL_IN_TYPED_VALUE', `${fact.factId}.${key}（null 语义保留给"缺键"）`);
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        // 行情 typedValue 只允许字符串/数字（来源原生口径）；布尔等改写为字符串即失真，拒绝
        throw new TableError('TABLE_TYPED_VALUE_INVALID', `${fact.factId}.${key} 非 string/number`);
      }
    }
  }

  const preferred = preferredOrder(kind);
  const union = new Set<string>();
  for (const fact of facts) {
    for (const key of Object.keys(fact.typedValue as Record<string, unknown>)) union.add(key);
  }
  const ordered = [
    ...preferred.filter((name) => union.has(name)),
    ...[...union].filter((name) => !(preferred as readonly string[]).includes(name)).sort(),
  ];
  const dateKey = dateKeyOf(kind);
  if (!ordered.includes(dateKey)) {
    throw new TableError('TABLE_DATE_COLUMN_MISSING', `${kind} 缺日期键 ${dateKey}`);
  }

  const sorted = [...facts].sort((a, b) => {
    const da = String((a.typedValue as Record<string, unknown>)[dateKey]);
    const db = String((b.typedValue as Record<string, unknown>)[dateKey]);
    return da < db ? -1 : da > db ? 1 : a.factId < b.factId ? -1 : 1;
  });

  const columns: { name: string; source: 'typedValue' | 'adjustFactor' }[] = ordered.map((name) => ({
    name,
    source: 'typedValue' as const,
  }));
  const rows = sorted.map((fact) => {
    const tv = fact.typedValue as Record<string, unknown>;
    return ordered.map((name) => {
      const value = tv[name];
      return value === undefined ? null : (value as string | number);
    });
  });
  const factors = options?.adjustFactors ?? [];
  if (factors.length > 0) {
    joinAdjustFactors(rows, ordered.indexOf(dateKey), factors);
    columns.push({ name: ADJUST_FACTOR_COLUMN, source: 'adjustFactor' });
  }

  return {
    header: columns.map((c) => c.name),
    rows,
    reversible: true,
    meta: { factKind: kind, columns, rowFacts: sorted.map(metaRowOf) },
  };
}

/** tableToBars 的重建结果（bar 事实本体；复权因子列不参与重建）。 */
export function tableToBars(table: BarTable): TimePointFact[] {
  if (table.reversible !== true) {
    throw new TableError('TABLE_NOT_REVERSIBLE', '仅接受本模块产出的可逆表');
  }
  const { meta } = table;
  if (meta.columns.length !== table.header.length || meta.rowFacts.length !== table.rows.length) {
    throw new TableError('TABLE_MALFORMED', 'columns/header/rowFacts/rows 形状不一致');
  }
  for (const row of table.rows) {
    if (row.length !== meta.columns.length) {
      throw new TableError('TABLE_MALFORMED', '行宽与列数不一致');
    }
  }
  return table.rows.map((row, i) => {
    const typedValue: Record<string, unknown> = {};
    meta.columns.forEach((col, j) => {
      if (col.source !== 'typedValue') return; // 派生列（复权因子）不属于事实本体
      const cell = row[j];
      if (cell !== null) typedValue[col.name] = cell; // null ⇔ 缺键
    });
    const m = meta.rowFacts[i] as BarTableMetaRow | undefined;
    if (m === undefined) throw new TableError('TABLE_MALFORMED', `rowFacts[${i}] 缺失`);
    return {
      factId: m.factId,
      subjectType: m.subjectType as TimePointFact['subjectType'],
      subjectId: m.subjectId,
      factKind: m.factKind as TimePointFact['factKind'],
      typedValue,
      validFrom: m.validFrom,
      validTo: m.validTo,
      eventAt: m.eventAt,
      sourcePublishedAt: m.sourcePublishedAt,
      firstObservedAt: m.firstObservedAt,
      availableAt: m.availableAt,
      supersedesFactId: m.supersedesFactId,
      artifactSha256: m.artifactSha256,
      adapterVersion: m.adapterVersion,
    };
  });
}

/** 事实逐值相等（canonical 比较 typedValue；信封字段严格相等）。 */
export function factsEqual(a: TimePointFact, b: TimePointFact): boolean {
  return (
    a.factId === b.factId &&
    a.subjectType === b.subjectType &&
    a.subjectId === b.subjectId &&
    a.factKind === b.factKind &&
    canonicalJsonString(a.typedValue) === canonicalJsonString(b.typedValue) &&
    a.validFrom === b.validFrom &&
    a.validTo === b.validTo &&
    a.eventAt === b.eventAt &&
    a.sourcePublishedAt === b.sourcePublishedAt &&
    a.firstObservedAt === b.firstObservedAt &&
    a.availableAt === b.availableAt &&
    a.supersedesFactId === b.supersedesFactId &&
    a.artifactSha256 === b.artifactSha256 &&
    a.adapterVersion === b.adapterVersion
  );
}

/**
 * 往返无损断言：tableToBars(barsToTable(facts)) 与 facts 按 factId 逐值全等。
 * 供组装器校验与 Done-when 2 程序校验复用；违约抛 TABLE_ROUND_TRIP_MISMATCH。
 */
export function assertRoundTrip(facts: TimePointFact[], table: BarTable): void {
  const rebuilt = tableToBars(table);
  if (rebuilt.length !== facts.length) {
    throw new TableError('TABLE_ROUND_TRIP_MISMATCH', `行数 ${rebuilt.length} ≠ ${facts.length}`);
  }
  const byId = new Map(rebuilt.map((f) => [f.factId, f]));
  for (const original of facts) {
    const got = byId.get(original.factId);
    if (got === undefined || !factsEqual(got, original)) {
      throw new TableError('TABLE_ROUND_TRIP_MISMATCH', original.factId);
    }
  }
}
