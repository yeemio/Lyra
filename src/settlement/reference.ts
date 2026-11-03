/**
 * Lyra · 参考价与窗口（P3 W13: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md SR-3.1/3.2/3.3（统一参考价裁定：结论完成后
 * 第一个该股有成交交易日的开盘价；停牌顺延；四类情形落点）+ docs/specs/ASHARE-RULES.md
 * §4（T+1 与参考价：reference_open = 第一个 open_time > 结论完成时刻 t 的交易日开盘价，
 * 研究当日价格禁用）/ §6（停牌：交易日无行情行或交易状态标记停牌皆为正常表现）。
 *
 * 实现口径：
 * - 市场交易日历 = TRADE_CALENDAR 事实（RULE/ashare-calendar，is_trading_day='1'），
 *   as-of 读取（日历行 availableAt=该日 15:00+08，未来日不可见属时点纪律，不回填）。
 * - "有成交" = DAILY_BAR 行 tradestatus='1'（停牌行 tradestatus='0' 或无行皆为未成交，
 *   ASHARE-RULES §6：停牌日无行情行是数据层正常表现，不当异常处理）。
 * - 候选日 = 开盘时刻（09:30 Asia/Shanghai，固定 +08）晚于结论完成时刻 t 的市场交易日：
 *   t 在交易日 D 开盘前 → D 当日开盘价（SR-3.2 情形 1）；t 在盘中/收盘后 → 下一交易日；
 *   t 在非交易日 → 下一交易日；完成后首交易（含首个候选日）停牌 → 顺延至复牌首日
 *   （SR-3.2 末行，可成交性由 tradability.ts 记 UNFILLABLE_SUSPENDED）。
 * - NOT_DUE（无下一交易日，太新）：t 之后日历内已无市场交易日（AFTER_LAST_MARKET_DAY），
 *   或有市场交易日但该股其后均无成交（NO_TRADED_DAY_AFTER：停牌未复牌/停止交易）。
 *
 * 价格一律不复权原始价字符串（ASHARE-RULES §2.3 分工：复权只用于收益计算，excess.ts）。
 */
import type { Pool } from 'pg';
import { asOfFacts } from '../pintime/facts.js';
import { SettlementError } from './decimal.js';

export const OPEN_SHANGHAI = '09:30:00+08:00'; // A 股开盘时刻（Asia/Shanghai 固定 +08）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 该交易日开盘时刻（epoch ms）。 */
export function shanghaiOpenMs(date: string): number {
  if (!DATE_RE.test(date)) throw new SettlementError('DATE_INVALID', `shanghaiOpenMs: ${date}`);
  const ms = new Date(`${date}T${OPEN_SHANGHAI}`).getTime();
  if (Number.isNaN(ms)) throw new SettlementError('DATE_INVALID', `shanghaiOpenMs: ${date}`);
  return ms;
}

function parseDayString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new SettlementError('DATE_INVALID', `${field}: ${String(value)}（须 YYYY-MM-DD）`);
  }
  return value;
}

// ===== 行情行视图（DAILY_BAR typedValue 的严格读取；价格字段为原始字符串）=====

export interface DailyBarView {
  factId: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  preclose: string;
  volume: string;
  amount: string;
  isST: string;
  tradestatus: string;
}

function decField(value: unknown, field: string, factId: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new SettlementError('BAR_FIELD_INVALID', `DAILY_BAR ${factId} 字段 ${field} 非十进制定点: ${String(value)}`);
  }
  return value;
}

/** DAILY_BAR 事实 → 行视图（价格字段必备；volume/amount 停牌行可为空串，仅透传）。 */
export function toDailyBarView(typedValue: unknown, factId: string): DailyBarView {
  const v = typedValue as Record<string, unknown>;
  const date = parseDayString(v.date, `DAILY_BAR ${factId} date`);
  const tradestatus = typeof v.tradestatus === 'string' ? v.tradestatus : '';
  if (tradestatus !== '0' && tradestatus !== '1') {
    throw new SettlementError('BAR_FIELD_INVALID', `DAILY_BAR ${factId} tradestatus: ${String(v.tradestatus)}（须 '0'/'1'）`);
  }
  const isST = typeof v.isST === 'string' ? v.isST : '';
  if (isST !== '0' && isST !== '1') {
    throw new SettlementError('BAR_FIELD_INVALID', `DAILY_BAR ${factId} isST: ${String(v.isST)}（须 '0'/'1'）`);
  }
  return {
    factId,
    date,
    open: decField(v.open, 'open', factId),
    high: decField(v.high, 'high', factId),
    low: decField(v.low, 'low', factId),
    close: decField(v.close, 'close', factId),
    preclose: decField(v.preclose, 'preclose', factId),
    volume: typeof v.volume === 'string' ? v.volume : '',
    amount: typeof v.amount === 'string' ? v.amount : '',
    isST,
    tradestatus,
  };
}

/** 该股当日有成交（ASHARE-RULES §6：计数器只在有成交交易日递增）。 */
export function barTraded(bar: DailyBarView): boolean {
  return bar.tradestatus === '1';
}

// ===== 事实装载 =====

/** 市场交易日（升序）= as-of 可见 TRADE_CALENDAR 中 is_trading_day='1' 的日期。 */
export async function loadTradingDays(pool: Pool, asOf: Date): Promise<string[]> {
  const facts = await asOfFacts(pool, {
    subjectType: 'RULE',
    subjectId: 'ashare-calendar',
    factKind: 'TRADE_CALENDAR',
    asOf,
  });
  const days: string[] = [];
  for (const f of facts) {
    const v = f.typedValue as Record<string, unknown>;
    if (v.is_trading_day !== '1') continue;
    days.push(parseDayString(v.calendar_date, `TRADE_CALENDAR ${f.factId} calendar_date`));
  }
  days.sort();
  return days;
}

/** 该股全部 as-of 可见 DAILY_BAR（date → 行视图；同日多事实 = 来源冲突，具名暴露不猜）。 */
export async function loadDailyBars(pool: Pool, subject: string, asOf: Date): Promise<Map<string, DailyBarView>> {
  const facts = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: subject, factKind: 'DAILY_BAR', asOf });
  const byDate = new Map<string, DailyBarView>();
  for (const f of facts) {
    const bar = toDailyBarView(f.typedValue, f.factId);
    const existing = byDate.get(bar.date);
    if (existing !== undefined && existing.factId !== bar.factId) {
      throw new SettlementError(
        'BAR_DATE_CONFLICT',
        `${subject} ${bar.date} 存在多个行情事实（${existing.factId} / ${bar.factId}）：来源冲突不静默合并（DATA-SOURCES §6.5）`,
      );
    }
    byDate.set(bar.date, bar);
  }
  return byDate;
}

// ===== 参考价解析（纯函数，单测直接注入日历与行情）=====

export type ReferenceOpenResult =
  | {
      state: 'OK';
      /** 参考价日（该股有成交交易日，YYYY-MM-DD）。 */
      referenceDay: string;
      /** 参考价：该日开盘价（不复权原始价字符串）。 */
      referenceOpen: string;
      /** 参考价日行情行（一字板判定输入，tradability.ts 消费）。 */
      bar: DailyBarView;
      /** 结论后首个候选市场交易日（未顺延时 = referenceDay）。 */
      firstCandidateDay: string;
      /** 参考价日因停牌顺延（SR-3.2 末行）。 */
      deferredBySuspension: boolean;
      /** 顺延跨度：首个候选市场交易日起至复牌前一日的市场交易日数（未顺延为 0）。 */
      suspensionSpanTradingDays: number;
    }
  | {
      state: 'NOT_DUE';
      /** AFTER_LAST_MARKET_DAY=日历内 t 后已无市场交易日（太新）；NO_TRADED_DAY_AFTER=有市场交易日但该股其后均无成交。 */
      reason: 'AFTER_LAST_MARKET_DAY' | 'NO_TRADED_DAY_AFTER';
      detail: string;
    };

/**
 * 参考价裁定（SR-3.1/3.2）：满足 open_time > 结论完成时刻 t、且该股当日有成交的第一个
 * 交易日的开盘价。停牌顺延（首个候选日起逐市场交易日推进，直到有成交日）。
 */
export function resolveReferenceOpen(
  tradingDays: string[],
  bars: Map<string, DailyBarView>,
  conclusionTime: Date,
): ReferenceOpenResult {
  if (Number.isNaN(conclusionTime.getTime())) {
    throw new SettlementError('DATE_INVALID', `conclusionTime: ${conclusionTime.toISOString()}`);
  }
  const t = conclusionTime.getTime();
  const candidates = tradingDays.filter((d) => shanghaiOpenMs(d) > t);
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    return {
      state: 'NOT_DUE',
      reason: 'AFTER_LAST_MARKET_DAY',
      detail: `结论完成时刻 ${conclusionTime.toISOString()} 之后无 as-of 可见市场交易日（太新，SR-2.4 未到期）`,
    };
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const day = candidates[i] as string;
    const bar = bars.get(day);
    if (bar !== undefined && barTraded(bar)) {
      return {
        state: 'OK',
        referenceDay: day,
        referenceOpen: bar.open,
        bar,
        firstCandidateDay: firstCandidate,
        deferredBySuspension: i > 0,
        suspensionSpanTradingDays: i, // 候选日升序连续，跳过 i 天 = 顺延跨度 i 个市场交易日
      };
    }
  }
  return {
    state: 'NOT_DUE',
    reason: 'NO_TRADED_DAY_AFTER',
    detail: `首个候选市场交易日 ${firstCandidate} 起（至 ${candidates[candidates.length - 1] ?? firstCandidate}）该股均无成交（停牌未复牌或停止交易，SR-2.4 未到期）`,
  };
}

// ===== DB 入口 =====

export interface ReferenceOpenArgs {
  /** 股票代码（裸 6 位，与 DAILY_BAR subjectId 一致）。 */
  subject: string;
  /** 结论完成时刻（SR-3.1 锚点；不得改锚事件/公告时刻）。 */
  conclusionTime: string | Date;
  /** 事实读取 as-of（默认当前时刻；结算只消费窗口内各日事实）。 */
  asOf?: Date;
}

/** 参考价与窗口起点（DB 入口；装载日历与行情后走纯函数裁定）。 */
export async function referenceOpen(pool: Pool, args: ReferenceOpenArgs): Promise<ReferenceOpenResult> {
  const asOf = args.asOf ?? new Date();
  const conclusionTime = args.conclusionTime instanceof Date ? args.conclusionTime : new Date(args.conclusionTime);
  if (Number.isNaN(conclusionTime.getTime())) {
    throw new SettlementError('DATE_INVALID', `conclusionTime: ${String(args.conclusionTime)}`);
  }
  if (typeof args.subject !== 'string' || args.subject.length === 0) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `subject: ${String(args.subject)}`);
  }
  const [tradingDays, bars] = await Promise.all([
    loadTradingDays(pool, asOf),
    loadDailyBars(pool, args.subject, asOf),
  ]);
  return resolveReferenceOpen(tradingDays, bars, conclusionTime);
}

/**
 * (from, to) 开区间内的市场交易日数（停牌跨度与窗口间隔计数的共用口径；
 * to=null 表示数到日历末尾，用于未复牌诊断）。
 */
export function countTradingDaysBetween(tradingDays: string[], fromExclusive: string, toExclusive: string | null): number {
  let n = 0;
  for (const d of tradingDays) {
    if (d <= fromExclusive) continue;
    if (toExclusive !== null && d >= toExclusive) break;
    n += 1;
  }
  return n;
}
