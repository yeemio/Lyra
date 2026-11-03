/**
 * Lyra · 六类事件分类器（W14: code-writer）。
 * 合同：docs/specs/P3-EVENTS-REVIEW.md Done-when 2；HISTORICAL-REFERENCE §3（事件时点=available_at 基准、
 * 一公告一实例、不自动猜）；ASHARE-RULES §9（预告更正子类 REVISE_UP/REVISE_DOWN/UNDETERMINED）。
 *
 * 纯函数，无 DB/网络依赖；持久化在 library.ts，编排 CLI 在 detect.cli.ts。
 */
import { createHash } from 'node:crypto';
import {
  ANNOUNCEMENT_RULES,
  BUYBACK_NON_FIRST_RE,
  CORRECTION_RE,
  EVENT_TYPE_PRIORITY,
  FORECAST_TYPE_WORDS,
  HOLDER_DECREASE_RE,
  HOLDER_INCREASE_RE,
  PERIOD_MAP,
  PERIOD_RE,
  REVISE_DOWN_RE,
  REVISE_UP_RE,
  type EventType,
  type ForecastType,
  type PeriodLabel,
} from './rules.js';

// ===== 输入 =====

/** 公告事实的检测输入（CLI 从 pintime_fact 行映射；单测可直接构造）。 */
export interface AnnouncementInput {
  factId: string;
  subjectId: string;
  title: string;
  /** 事件时点 = 事实 available_at（POINT-IN-TIME；日精度公告已为 D+1 开盘前）。 */
  availableAt: string;
}

/** 财务增速事实的检测输入（bsQuery=growth 行）。 */
export interface GrowthInput {
  factId: string;
  statDate: string; // 'YYYY-MM-DD'
  pubDate: string; // 'YYYY-MM-DD'
  availableAt: string;
  /** YOYNI（净利润同比，比值口径）；缺失为 null（不猜，跳过并计数）。 */
  yoyNi: number | null;
}

// ===== 标题分类（多命中单归属 + 次命中 + 拒绝具名登记）=====

export type RejectReason = 'EXCLUDED' | 'CO_REQUIRE_UNMET';

export interface TitleClassification {
  /** 优先级最高的命中类型；无命中为 null。 */
  primary: EventType | null;
  /** 其余命中类型（次命中，随事件记录）。 */
  secondary: EventType[];
  /** 候选后被排除/共现不满足的类型（具名登记，不静默）。 */
  rejected: { type: EventType; reason: RejectReason }[];
}

/** 对标题跑全规则表：每类型独立判定 include 全中 + exclude 零中，按优先级排位。 */
export function classifyTitle(title: string): TitleClassification {
  const hits: EventType[] = [];
  const rejected: { type: EventType; reason: RejectReason }[] = [];
  for (const rule of ANNOUNCEMENT_RULES) {
    const includeOk = rule.include.every((re) => re.test(title));
    if (!includeOk) {
      // 只有主词命中而共现词不中的才登记 CO_REQUIRE_UNMET（避免噪音：主词都不中不登记）
      const mainOk = rule.include.slice(0, 1).every((re) => re.test(title));
      if (mainOk && rule.include.length > 1) rejected.push({ type: rule.type, reason: 'CO_REQUIRE_UNMET' });
      continue;
    }
    const excluded = rule.exclude.find((re) => re.test(title));
    if (excluded !== undefined) {
      rejected.push({ type: rule.type, reason: 'EXCLUDED' });
      continue;
    }
    hits.push(rule.type);
  }
  const ordered = EVENT_TYPE_PRIORITY.filter((t) => hits.includes(t));
  return { primary: ordered[0] ?? null, secondary: ordered.slice(1), rejected };
}

// ===== 报告期与子属性提取 =====

export interface ReportPeriod {
  year: number;
  label: PeriodLabel;
  key: string; // 如 '2025H1'（预告更正判定的同报告期键）
}

/** 提取失败返回 null（→ UNPARSED_PERIOD，不成事件，不猜）。 */
export function parsePeriod(title: string): ReportPeriod | null {
  const m = PERIOD_RE.exec(title);
  if (m === null) return null;
  const label = PERIOD_MAP[m[2] as string];
  if (label === undefined) return null; // 词表未覆盖（不会发生：PERIOD_RE 限定词表）
  return { year: Number(m[1]), label, key: `${m[1]}${label}` };
}

export function forecastTypeOf(title: string): ForecastType {
  for (const [type, re] of FORECAST_TYPE_WORDS) {
    if (re.test(title)) return type;
  }
  return 'GENERIC';
}

// ===== 检测结果 =====

export type EventSubtype =
  | 'FIRST' // 预告首次 / 回购首次
  | 'REVISE_UP' // 预告更正上修（标题明示）
  | 'REVISE_DOWN' // 预告更正下修（标题明示）
  | 'UNDETERMINED' // 预告更正方向无法从标题判定（不猜）
  | 'INCREASE' // 增持
  | 'DECREASE' // 减持
  | 'PROGRESS_OR_CHANGE'; // 回购进展/变更（非首次）

export interface DetectedEvent {
  subject: string;
  eventType: EventType;
  subtype: EventSubtype | null;
  eventTime: string; // = 输入 availableAt
  evidenceFactId: string;
  attrs: Record<string, unknown>;
}

export type DetectOutcome =
  | { kind: 'EVENT'; event: DetectedEvent }
  | { kind: 'NONE'; reason: string }
  | { kind: 'FORECAST_UNPARSED_PERIOD' } // 提取失败不成事件（派发冻结）
  | { kind: 'FLASH_CORRECTION_NO_INSTANCE' }; // 快报更正只走 supersedes（§3.2），具名不落实例

/**
 * 单条公告 → 事件实例（或具名非实例结果）。
 * priorForecastKeys：该股已发出预告事件的报告期键集合（更正子类判定状态，由调用方按时序维护）。
 */
export function detectAnnouncement(
  input: AnnouncementInput,
  priorForecastKeys: ReadonlySet<string>,
): DetectOutcome {
  const cls = classifyTitle(input.title);
  if (cls.primary === null) return { kind: 'NONE', reason: 'NO_RULE_HIT' };

  const base = {
    subject: input.subjectId,
    eventTime: input.availableAt,
    evidenceFactId: input.factId,
  };
  const titleAttr = { title: input.title, secondaryHits: cls.secondary };

  switch (cls.primary) {
    case 'EARNINGS_FORECAST': {
      const period = parsePeriod(input.title);
      if (period === null) return { kind: 'FORECAST_UNPARSED_PERIOD' };
      const isCorrection = CORRECTION_RE.test(input.title);
      let subtype: EventSubtype;
      const attrs: Record<string, unknown> = { ...titleAttr, period: period.key, forecastType: forecastTypeOf(input.title) };
      if (isCorrection && priorForecastKeys.has(period.key)) {
        // 更正子类（ASHARE-RULES §9）：方向优先标题明示（上修/下修）；区间端点规则需 PDF 数值，元数据级不可得 → UNDETERMINED 不猜
        if (REVISE_UP_RE.test(input.title)) subtype = 'REVISE_UP';
        else if (REVISE_DOWN_RE.test(input.title)) subtype = 'REVISE_DOWN';
        else {
          subtype = 'UNDETERMINED';
          attrs.directionBasis = 'TITLE_INDETERMINABLE_ENDPOINT_RULE_NEEDS_PDF';
        }
        attrs.correctionOfPriorEvent = true;
      } else {
        subtype = 'FIRST';
        if (isCorrection) {
          // 含更正词但无同报告期在先事件：如实标注（可能是更正链原件未入池/期键不同），不猜
          attrs.note = 'CORRECTION_KEYWORD_WITHOUT_PRIOR_EVENT';
        }
      }
      return {
        kind: 'EVENT',
        event: { ...base, eventType: 'EARNINGS_FORECAST', subtype, attrs },
      };
    }
    case 'EARNINGS_FLASH': {
      if (CORRECTION_RE.test(input.title)) return { kind: 'FLASH_CORRECTION_NO_INSTANCE' };
      const period = parsePeriod(input.title);
      if (period === null) return { kind: 'FORECAST_UNPARSED_PERIOD' }; // 同报告期提取纪律（快报属同一披露族）
      return {
        kind: 'EVENT',
        event: { ...base, eventType: 'EARNINGS_FLASH', subtype: null, attrs: { ...titleAttr, period: period.key } },
      };
    }
    case 'SHARE_UNLOCK':
      return { kind: 'EVENT', event: { ...base, eventType: 'SHARE_UNLOCK', subtype: null, attrs: { ...titleAttr } } };
    case 'HOLDER_TRADE': {
      const up = HOLDER_INCREASE_RE.test(input.title);
      const down = HOLDER_DECREASE_RE.test(input.title);
      const subtype: EventSubtype = up && down ? 'UNDETERMINED' : up ? 'INCREASE' : 'DECREASE';
      return {
        kind: 'EVENT',
        event: {
          ...base,
          eventType: 'HOLDER_TRADE',
          subtype,
          attrs: { ...titleAttr, direction: subtype },
        },
      };
    }
    case 'BUYBACK':
      return {
        kind: 'EVENT',
        event: {
          ...base,
          eventType: 'BUYBACK',
          subtype: BUYBACK_NON_FIRST_RE.test(input.title) ? 'PROGRESS_OR_CHANGE' : 'FIRST',
          attrs: { ...titleAttr },
        },
      };
    case 'PERIOD_GROWTH_DELTA':
      return { kind: 'NONE', reason: 'NON_ANNOUNCEMENT_TYPE' }; // 财务驱动类型不经本入口
  }
}

// ===== 定期报告增速变化（FINANCIAL 驱动，§3.3）=====

export interface GrowthStats {
  periodsConsidered: number;
  firstPeriodNoPrev: number; // 无上一份报告可比（序列首元素）
  yoyNiMissing: number; // YOYNI 为空/非数值的期（不猜，跳过）
  prevYoyNiMissing: number; // 上一期 YOYNI 缺失导致的不可比对
  periodSequenceGap: number; // 相邻报告期不连续（缺失中间报告），事件属性如实标注
}

export interface GrowthDetectResult {
  events: DetectedEvent[];
  stats: GrowthStats;
}

function statQuarter(statDate: string): { y: number; q: number } | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(statDate);
  if (m === null) return null;
  const month = Number(m[2]);
  if (month % 3 !== 0 || month < 3 || month > 12) return null;
  return { y: Number(m[1]), q: month / 3 };
}

/** 十进制 10 位定点化（增速差值比较的确定性前提）。 */
function round10(x: number): number {
  return Math.round(x * 1e10) / 1e10;
}

/**
 * 相邻定期报告增速变化检测。facts = 该股全部 growth 事实（允许同 statDate 多行=重述链）；
 * - 数值口径：同 statDate 取 availableAt 最新的行（最新修订口径，§6——随事件属性携带声明原文）；
 * - 事件时点：该报告期最早 availableAt（首次披露时点，重述不改历史事件时点）；
 * - 上一份报告：按披露时间序（pubDate）紧邻的前一份；阈值=增速比值单位（0.20 = 20 个百分点）。
 */
export function detectGrowthEvents(
  stock: string,
  facts: GrowthInput[],
  threshold: number,
): GrowthDetectResult {
  const stats: GrowthStats = { periodsConsidered: 0, firstPeriodNoPrev: 0, yoyNiMissing: 0, prevYoyNiMissing: 0, periodSequenceGap: 0 };
  if (facts.length === 0) return { events: [], stats };

  // 同 statDate 归组：数值行 = availableAt 最新；披露时点 = availableAt 最早
  const byStat = new Map<string, { valueRow: GrowthInput; firstAvailableAt: string }>();
  for (const f of facts) {
    const cur = byStat.get(f.statDate);
    if (cur === undefined) {
      byStat.set(f.statDate, { valueRow: f, firstAvailableAt: f.availableAt });
      continue;
    }
    if (new Date(f.availableAt).getTime() > new Date(cur.valueRow.availableAt).getTime()) cur.valueRow = f;
    if (new Date(f.availableAt).getTime() < new Date(cur.firstAvailableAt).getTime()) cur.firstAvailableAt = f.availableAt;
  }

  // 按披露时间序（pubDate，后按 statDate 兜底排序）
  const ordered = [...byStat.entries()]
    .map(([statDate, g]) => ({ statDate, ...g }))
    .sort((a, b) => {
      const pd = a.valueRow.pubDate.localeCompare(b.valueRow.pubDate);
      return pd !== 0 ? pd : a.statDate.localeCompare(b.statDate);
    });

  const events: DetectedEvent[] = [];
  let prev: { statDate: string; pubDate: string; yoyNi: number | null } | null = null;
  for (const g of ordered) {
    stats.periodsConsidered += 1;
    if (prev === null) {
      stats.firstPeriodNoPrev += 1;
      prev = { statDate: g.statDate, pubDate: g.valueRow.pubDate, yoyNi: g.valueRow.yoyNi };
      continue;
    }
    const prevCopy = prev;
    prev = { statDate: g.statDate, pubDate: g.valueRow.pubDate, yoyNi: g.valueRow.yoyNi };
    if (g.valueRow.yoyNi === null) {
      stats.yoyNiMissing += 1;
      continue;
    }
    if (prevCopy.yoyNi === null) {
      stats.prevYoyNiMissing += 1;
      continue;
    }
    // 增速差值 10 位小数定点化：消除浮点漂移（如 0.3−0.1=0.199…98），保证阈值比较确定
    const delta = round10(g.valueRow.yoyNi - prevCopy.yoyNi);
    if (Math.abs(delta) < threshold) continue;
    const qThis = statQuarter(g.statDate);
    const qPrev = statQuarter(prevCopy.statDate);
    const sequenceGap =
      qThis === null || qPrev === null ||
      !(qThis.y === qPrev.y && qThis.q === qPrev.q + 1) && !(qThis.y === qPrev.y + 1 && qPrev.q === 4 && qThis.q === 1);
    if (sequenceGap) stats.periodSequenceGap += 1;
    events.push({
      subject: stock,
      eventType: 'PERIOD_GROWTH_DELTA',
      subtype: null,
      eventTime: g.firstAvailableAt, // 事件时点 = 本期报告首次披露可得时点（pubDate 日精度 → D+1）
      evidenceFactId: g.valueRow.factId,
      attrs: {
        statDate: g.statDate,
        pubDate: g.valueRow.pubDate,
        prevStatDate: prevCopy.statDate,
        prevPubDate: prevCopy.pubDate,
        yoyNiThis: g.valueRow.yoyNi,
        yoyNiPrev: prevCopy.yoyNi,
        delta,
        threshold,
        thresholdStatus: 'RESERVED_VALUE_PENDING_P4_CALIBRATION', // 预留值标注（§9：冻结前不冒称冻结值）
        caliber: 'YOYNI_NET_PROFIT_YOY_RATIO',
        revenueYoY: 'UNAVAILABLE_NOT_IN_SOURCE_GROWTH_FIELDS', // 数据源无营收同比字段，具名缺口
        periodSequenceGap: sequenceGap,
        valueCaliber: 'LATEST_REVISION', // §6 修订口径：数值为最新修订口径
        revisionCaliberStatement:
          '修订口径声明：一次性回填 2015–2026 拿到的是当前最新修订值，与当时公告值可能不同且不可复原；历史参照库的事件主证据以公告 PDF 原文为准，结构化数据做辅助。',
      },
    });
  }
  return { events, stats };
}

// ===== 事件身份 =====
// 事件实例 = 股票 × 事件类型 × 触发公告（§3 通用规则 2）→ 确定性 id，重放幂等。
export function eventIdOf(subject: string, eventType: EventType, evidenceFactId: string): string {
  return `evt:${sha256Hex(`${subject}|${eventType}|${evidenceFactId}`)}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
