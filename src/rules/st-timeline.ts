/**
 * Lyra · ST 时点表（ASHARE-RULES §3；W16: code-writer）。
 * 合同：docs/specs/ASHARE-RULES.md §3（事件与状态、表结构与读取、三条禁令）、
 * docs/specs/POINT-IN-TIME.md §3.1（日精度公告 → D+1 开盘前可得）、
 * docs/specs/P1-DATA.md 验收登记缺口（现只有当前快照 isST，无历史状态区间）。
 *
 * 消费方：rules/limit.ts limitCoefficient 的 stStatus 输入（本文件只提供查询，不改 limit.ts）。
 *
 * ── 规则定稿（2026-10-25 真实标题抽样，全库 41,041 条 ANNOUNCEMENT 原文扫描）──
 * 含"风险警示"字样的真实标题全库仅 6 条，全部来自 600150（中国船舶 / *ST船舶）：
 *   1) 2018-02-01 / 03-22 / 04-16 「关于公司股票可能被实施退市风险警示的提示性公告」（第一/二/三次）
 *      → 预告非实施（exclude：可能被实施）。
 *   2) 2018-04-24 「关于公司股票被实施退市风险警示的公告」→ 实施 *ST（唯一真实正例）。
 *      对照 DAILY_BAR：isST 于 2018-04-24 当日翻 1 = 公告日（2018-04-23）次日，生效日取法互证吻合。
 *   3) 2019-03-21 「关于申请撤销公司股票退市风险警示的公告」→ 申请非撤销（exclude：申请撤销）。
 *   4) 2019-03-29 「关于公司股票撤销退市风险警示的公告」→ 撤销 *ST → NORMAL（标题无"其他风险警示"
 *      共现 → NORMAL；对照 DAILY_BAR：isST 于 2019-03-29 当日翻 0 = 公告日（2018-03-28）次日，吻合）。
 * 全库"其他风险警示"标题 0 条、"摘帽"0 条、含"ST"字样仅 1 条且为假阳性（"许可韩国DONG-AST公司"，
 * 公司名非状态词）。对照组"风险提示"（n=67：股票交易风险提示 / 异常波动暨风险提示 / 一般风险提示 /
 * 可能被暂停上市的风险提示）均不含"风险警示"，天然不命中包含式。证监局"警示函"（n=5：大族激光 /
 * 光迅 / 永鼎×2 / 巨石）无"风险警示"子串，另加显式排除防未来形态。境外退市（"MFLX公司完成NASDAQ
 * 退市程序"）、上市辅导（"终止上市辅导的提示性公告"）、恢复上市督导（"恢复上市持续督导保荐总结报告书"）
 * 均无"风险警示"子串，天然不命中。
 * 兜底：标题含"风险警示"但四类包含式均未命中且未被排除 → AMBIGUOUS（不猜）；"摘帽/戴帽"为俗称，
 * 无法从标题机械判定摘的是 ST 帽还是 *ST 帽 → AMBIGUOUS（不猜）。
 *
 * ── 生效日取法 ──
 * 生效日 = 公告日次日。公告日 = source_published_at 的北京日历日（巨潮 announcementTime，CST 语义）；
 * source_published_at 缺失时保守取 available_at 的北京日历日（该字段已按 P-i-T §3.1 落在 D+1 开盘前）。
 * 中国大陆无夏令时，北京日历日 = epoch + 8h 后取 ISO 日期部。
 *
 * ── 区间外默认状态（诚实边界）──
 * 不知道首个证据日之前的真实状态，不编造：查询对早于首个证据日的日期返回 NORMAL 但带
 * basis='DEFAULT_BEFORE_EVIDENCE'（绝大多数主板股非 ST，默认 NORMAL 但声明依据，缺证据可审计）。
 *
 * ── 三条禁令落实（ASHARE-RULES §3.2）──
 * ① 不用当前股票简称回填历史状态：状态只从公告标题机械判定；short_name_at_publication 仅存
 *    巨潮随公告返回的元数据简称（审计参考列），不参与任何判定。
 * ② 不假设状态区间可由名称推断：无公告证据 → 无区间 → DEFAULT_BEFORE_EVIDENCE，不造区间。
 * ③ 摘帽后显式恢复 NORMAL 记录：撤销类事件显式落 NORMAL 区间行。
 */
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../db/pool.js';
import { normalizeRuleDate } from './limit.js';

export type StStatus = 'NORMAL' | 'ST' | '*ST';
/** 状态依据：EVIDENCED = 落在证据区间内；DEFAULT_BEFORE_EVIDENCE = 早于首个证据日的默认值。 */
export type StBasis = 'EVIDENCED' | 'DEFAULT_BEFORE_EVIDENCE';

export const BUILDER_VERSION = 'st-timeline-v1';

export class StTimelineError extends Error {
  constructor(
    readonly code: 'ST_TIMELINE_RANGE_INVALID' | 'ST_TIMELINE_GAP' | 'ST_TIMELINE_SAME_DAY_CONFLICT' | 'ST_EFFECTIVE_DAY_UNKNOWN',
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'StTimelineError';
  }
}

// ===== 标题分类（纯函数；顺序即判定顺序：排除 → 撤销其他 → 撤销退市 → 实施其他 → 实施退市 → 俗称 → 兜底）=====

export interface StClassifiedEvent {
  kind: 'EVENT';
  to: StStatus;
  /** 命中规则 id（审计定位用）。 */
  ruleId: string;
}
export interface StClassifiedNone {
  kind: 'NONE';
  /** 非事件的具名理由（排除词命中 / 无关键词）。 */
  reason: string;
}
export interface StClassifiedAmbiguous {
  kind: 'AMBIGUOUS';
  /** 不猜的具名理由。 */
  reason: string;
}
export type StTitleClassification = StClassifiedEvent | StClassifiedNone | StClassifiedAmbiguous;

/** 排除词（任一命中即非事件；证据见文件头注）。 */
const EXCLUDE_RULES: readonly (readonly [RegExp, string])[] = [
  [/可能被实施/, 'EXCLUDE_POSSIBLE_FUTURE（可能被实施…提示性公告 = 预告，非实施；600150 2018-02-01/03-22/04-16 三例）'],
  [/申请撤销/, 'EXCLUDE_APPLICATION（申请撤销 = 申请程序，非生效撤销；600150 2019-03-21 一例，生效以 2019-03-29 撤销公告为准）'],
  [/警示函/, 'EXCLUDE_REGULATORY_LETTER（证监局警示函 ≠ 交易所风险警示；真实假阳性族 n=5）'],
];

/** 包含式（按判定顺序；命中即分类）。 */
const INCLUDE_RULES: readonly (readonly [RegExp, StStatus, string, string])[] = [
  [/撤销.{0,12}其他风险警示/, 'NORMAL', 'REVOKE_OTHER_RISK_WARNING', '撤销其他风险警示 → NORMAL'],
  [/被实施.{0,12}其他风险警示|实施其他风险警示/, 'ST', 'IMPLEMENT_OTHER_RISK_WARNING', '实施其他风险警示 → ST'],
  [/被实施.{0,12}退市风险警示|实施退市风险警示/, '*ST', 'IMPLEMENT_DELIST_RISK_WARNING', '实施退市风险警示 → *ST（600150 2018-04-24 真实正例）'],
];

/** 撤销退市风险警示（含"其他风险警示"共现分支的先行判定，见 classifyStTitle）。 */
const REVOKE_DELIST_RE = /撤销.{0,12}退市风险警示/;
const OTHER_WARNING_RE = /其他风险警示/;

/** 俗称（摘的是哪顶帽无法机械判定 → 不猜）。 */
const INFORMAL_RE = /摘帽|戴帽/;

/** 兜底关键词：含"风险警示"但未落入任何包含式（未预见的新形态 → 不猜）。 */
const RISK_WARNING_RE = /风险警示/;

export function classifyStTitle(title: string): StTitleClassification {
  for (const [re, reason] of EXCLUDE_RULES) {
    if (re.test(title)) return { kind: 'NONE', reason };
  }
  // 撤销退市风险警示先行分支（派发冻结规则）：标题无"其他风险警示"共现 → NORMAL；
  // 有共现（"撤销退市风险警示及其他风险警示"双撤销 / "撤销退市风险警示暨被实施其他风险警示"
  // 混合形态）→ 标题层无法机械判定终态 → AMBIGUOUS 不猜（共现形态全库 0 例，届时按
  // ASHARE-RULES §4 精神以公告 PDF 原文人工核对，不进自动区间）。
  if (REVOKE_DELIST_RE.test(title)) {
    if (OTHER_WARNING_RE.test(title)) {
      return { kind: 'AMBIGUOUS', reason: 'AMBIGUOUS_REVOKE_DELIST_WITH_OTHER_COOCCUR（撤销退市风险警示与"其他风险警示"同题共现，终态不明，不猜；全库 0 例）' };
    }
    return { kind: 'EVENT', to: 'NORMAL', ruleId: 'REVOKE_DELIST_RISK_WARNING' };
  }
  for (const [re, to, ruleId, evidence] of INCLUDE_RULES) {
    if (re.test(title)) return { kind: 'EVENT', to, ruleId };
  }
  if (INFORMAL_RE.test(title)) {
    return { kind: 'AMBIGUOUS', reason: 'AMBIGUOUS_INFORMAL_HAT_TERM（摘帽/戴帽为俗称，无法机械判定 ST 帽或 *ST 帽，不猜）' };
  }
  if (RISK_WARNING_RE.test(title)) {
    return { kind: 'AMBIGUOUS', reason: 'AMBIGUOUS_UNCLASSIFIED_RISK_WARNING（含风险警示但四类包含式均未命中，未预见形态，不猜）' };
  }
  return { kind: 'NONE', reason: 'NO_KEYWORD（无风险警示关键词，非 ST 事件域）' };
}

// ===== 生效日 =====

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** epoch 毫秒 → 北京日历日 YYYY-MM-DD（CST 无夏令时，固定 +08:00）。 */
export function beijingDayOf(epochMs: number): string {
  return new Date(epochMs + CST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface StAnnouncementInput {
  factId: string;
  subjectId: string;
  title: string;
  /** 巨潮 announcementTime（CST 语义）原样 ISO；缺失时生效日回退 availableAt 的北京日。 */
  sourcePublishedAt: string | null;
  /** P-i-T §3.1：日精度公告 → D+1 开盘前。 */
  availableAt: string;
  /** 巨潮随公告元数据返回的简称（仅审计参考，不参与判定）。 */
  shortNameAtPublication?: string | null;
}

export interface StEffectiveDay {
  day: string; // YYYY-MM-DD，公告日次日
  /** 生效日由哪个字段导出（审计）。 */
  from: 'SOURCE_PUBLISHED_AT_PLUS_1' | 'AVAILABLE_AT_DAY';
}

/** 生效日 = 公告日次日；公告日优先 source_published_at 北京日，缺失回退 available_at 北京日。 */
export function stEffectiveDay(input: StAnnouncementInput): StEffectiveDay {
  if (input.sourcePublishedAt !== null) {
    const ms = new Date(input.sourcePublishedAt).getTime();
    if (Number.isNaN(ms)) {
      throw new StTimelineError('ST_EFFECTIVE_DAY_UNKNOWN', `source_published_at 不可解析: ${input.sourcePublishedAt}`);
    }
    return { day: beijingDayOf(ms + 24 * 60 * 60 * 1000), from: 'SOURCE_PUBLISHED_AT_PLUS_1' };
  }
  const ms = new Date(input.availableAt).getTime();
  if (Number.isNaN(ms)) {
    throw new StTimelineError('ST_EFFECTIVE_DAY_UNKNOWN', `available_at 不可解析: ${input.availableAt}`);
  }
  // available_at 已按 P-i-T §3.1 落在公告日 D+1 开盘前，其北京日历日即生效日。
  return { day: beijingDayOf(ms), from: 'AVAILABLE_AT_DAY' };
}

// ===== 区间构建 =====

export interface StIntervalRow {
  subject: string;
  status: StStatus;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // null = 开区间至今
  evidenceFactId: string;
  evidenceEventId: string | null; // ST 公告不属六类事件 → 恒 null（合同字段保留）
  evidencePublishedAt: string;
  evidenceAvailableAt: string;
  shortNameAtPublication: string | null;
}

export interface StSkippedItem {
  factId: string;
  title: string;
  reason: string;
}

export interface StSubjectBuildResult {
  subject: string;
  intervals: StIntervalRow[];
  /** 不猜的标题（分类 AMBIGUOUS），不产生区间，逐条具名留审计。 */
  ambiguous: StSkippedItem[];
  /** 排除的标题（预告/申请/警示函/无关键词等），逐条具名留审计。 */
  skipped: StSkippedItem[];
  /** 同一生效日出现互斥目标状态 → 该股整体拒建（不猜择一），具名上报。 */
  conflictSameDay: { day: string; targets: StStatus[] } | null;
}

/** 单股时间线构建：按生效日切段、相邻同状态合并；同日互斥目标 → conflictSameDay（不猜）。 */
export function buildSubjectTimeline(subjectId: string, inputs: readonly StAnnouncementInput[]): StSubjectBuildResult {
  const ambiguous: StSkippedItem[] = [];
  const skipped: StSkippedItem[] = [];
  const events: { day: string; to: StStatus; input: StAnnouncementInput }[] = [];

  for (const input of inputs) {
    const cls = classifyStTitle(input.title);
    if (cls.kind === 'NONE') {
      skipped.push({ factId: input.factId, title: input.title, reason: cls.reason });
      continue;
    }
    if (cls.kind === 'AMBIGUOUS') {
      ambiguous.push({ factId: input.factId, title: input.title, reason: cls.reason });
      continue;
    }
    events.push({ day: stEffectiveDay(input).day, to: cls.to, input });
  }

  events.sort((a, b) => (a.day === b.day ? a.input.factId.localeCompare(b.input.factId) : a.day < b.day ? -1 : 1));

  // 同日互斥目标检测（不猜择一，整股拒建）。
  let conflictSameDay: StSubjectBuildResult['conflictSameDay'] = null;
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const cur = events[i];
    if (cur && prev && cur.day === prev.day && cur.to !== prev.to) {
      conflictSameDay = { day: cur.day, targets: [...new Set(events.filter((e) => e.day === cur.day).map((e) => e.to))] };
    }
  }
  if (conflictSameDay !== null) {
    return { subject: subjectId, intervals: [], ambiguous, skipped, conflictSameDay };
  }

  // 切段：状态未变的事件（同状态重复公告）不产生新区间，具名记入 skipped。
  const intervals: StIntervalRow[] = [];
  let current: { status: StStatus; from: string; evidence: StAnnouncementInput } | null = null;
  for (const ev of events) {
    if (current !== null && current.status === ev.to) {
      skipped.push({
        factId: ev.input.factId,
        title: ev.input.title,
        reason: `REDUNDANT_SAME_STATUS（生效日 ${ev.day} 目标状态 ${ev.to} 与在区间相同，无状态变化，不切段）`,
      });
      continue;
    }
    if (current !== null) {
      intervals.push(rowOf(subjectId, current.status, current.from, ev.day, current.evidence));
    }
    current = { status: ev.to, from: ev.day, evidence: ev.input };
  }
  if (current !== null) {
    intervals.push(rowOf(subjectId, current.status, current.from, null, current.evidence));
  }
  return { subject: subjectId, intervals, ambiguous, skipped, conflictSameDay };
}

function rowOf(
  subject: string,
  status: StStatus,
  from: string,
  to: string | null,
  evidence: StAnnouncementInput,
): StIntervalRow {
  return {
    subject,
    status,
    effectiveFrom: from,
    effectiveTo: to,
    evidenceFactId: evidence.factId,
    evidenceEventId: null, // ST 公告不属首版六类事件；合同字段保留
    evidencePublishedAt: evidence.sourcePublishedAt ?? evidence.availableAt,
    evidenceAvailableAt: evidence.availableAt,
    shortNameAtPublication: evidence.shortNameAtPublication ?? null,
  };
}

// ===== 查询 =====

export interface StStatusAtResult {
  status: StStatus;
  basis: StBasis;
  /** basis=EVIDENCED 时：命中区间的生效日。 */
  effectiveFrom?: string;
}

/** 纯查询（供 limitCoefficient 消费方与测试同步使用）：区间覆盖 D → 该状态；区间外 → 默认 NORMAL + 标记。 */
export function stStatusAtFromIntervals(
  subject: string,
  date: string | Date,
  intervals: readonly StIntervalRow[],
): StStatusAtResult {
  const day = normalizeRuleDate(date);
  let firstFrom: string | null = null;
  for (const r of intervals) {
    if (r.subject !== subject) continue;
    if (firstFrom === null || r.effectiveFrom < firstFrom) firstFrom = r.effectiveFrom;
    if (r.effectiveFrom <= day && (r.effectiveTo === null || day < r.effectiveTo)) {
      return { status: r.status, basis: 'EVIDENCED', effectiveFrom: r.effectiveFrom };
    }
  }
  // 未覆盖：只有"早于首个证据日"是合法情形（构建保证区间连续不重叠；覆盖内空隙为数据缺陷）。
  if (firstFrom !== null && day >= firstFrom) {
    throw new StTimelineError('ST_TIMELINE_GAP', `${subject} 在 ${day} 落于证据区间覆盖范围内的空隙（区间应连续），数据缺陷`);
  }
  return { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' };
}

// ===== DB 访问 =====

const stMigrationUrl = new URL('../db/st-migration.sql', import.meta.url);

/** 建隔离 schema（可选）并按 search_path 应用 st-migration.sql（幂等；与 applyP1Migration 同语义）。 */
export async function applyStMigration(pool: Pool, schema?: string): Promise<void> {
  const ddl = await readFile(stMigrationUrl, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (schema !== undefined) {
      await client.query(`create schema if not exists "${schema}"`);
      await client.query(`set local search_path to "${schema}"`);
    }
    await client.query(ddl);
    await client.query('commit');
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时回滚失败可忽略。
    }
    throw err;
  } finally {
    client.release();
  }
}

function rowToInterval(row: {
  subject: string;
  status: string;
  effective_from: Date | string;
  effective_to: Date | string | null;
  evidence_fact_id: string;
  evidence_event_id: string | null;
  evidence_published_at: Date;
  evidence_available_at: Date;
  short_name_at_publication: string | null;
}): StIntervalRow {
  const day = (d: Date | string): string => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  if (row.status !== 'NORMAL' && row.status !== 'ST' && row.status !== '*ST') {
    throw new StTimelineError('ST_TIMELINE_RANGE_INVALID', `非法状态 ${row.status}`);
  }
  return {
    subject: row.subject,
    status: row.status,
    effectiveFrom: day(row.effective_from),
    effectiveTo: row.effective_to === null ? null : day(row.effective_to),
    evidenceFactId: row.evidence_fact_id,
    evidenceEventId: row.evidence_event_id,
    evidencePublishedAt: row.evidence_published_at.toISOString(),
    evidenceAvailableAt: row.evidence_available_at.toISOString(),
    shortNameAtPublication: row.short_name_at_publication,
  };
}

/** 读取区间（整表或单股；date 列按字符串取回，避免时区位移）。 */
export async function loadStatusIntervals(client: Pool | PoolClient, subject?: string): Promise<StIntervalRow[]> {
  const where = subject === undefined ? '' : 'where subject = $1';
  const params = subject === undefined ? [] : [subject];
  const r = await client.query(
    `select subject, status, effective_from::text, effective_to::text, evidence_fact_id,
            evidence_event_id, evidence_published_at, evidence_available_at, short_name_at_publication
     from st_status_timeline ${where} order by subject, effective_from`,
    params,
  );
  return r.rows.map(rowToInterval);
}

/**
 * DB 查询：subject 在 date（YYYY-MM-DD 或可归一日）的状态与依据。
 * 区间覆盖 → EVIDENCED；早于该股首个证据日 → 默认 NORMAL + DEFAULT_BEFORE_EVIDENCE（诚实标记）；
 * 覆盖范围内空隙 → ST_TIMELINE_GAP（数据缺陷必须暴露）。
 */
export async function stStatusAt(subject: string, date: string | Date, pool?: Pool): Promise<StStatusAtResult> {
  const day = normalizeRuleDate(date);
  const owned = pool === undefined;
  const p = pool ?? createPool();
  try {
    const intervals = await loadStatusIntervals(p, subject);
    return stStatusAtFromIntervals(subject, day, intervals);
  } finally {
    if (owned) await p.end();
  }
}
