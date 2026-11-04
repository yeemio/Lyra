/**
 * Lyra · 结算主函数（P3 W13: code-writer-pro）。
 * 合同：docs/specs/SETTLEMENT-REVIEW.md SR-2（六结算字段；模型不参与结算，全部输入为
 * 行情原件）/ SR-2.4（未到期不提前结算）/ SR-3（参考价、窗口、逐日序列、行业基准冻结）/
 * SR-6.1（失效触发阈值冻结 12%，R29.3 终裁：跑赢 e_d ≤ −12%、跑输 e_d ≥ +12%，只记录 + 首个触发日）；
 * docs/specs/ASHARE-RULES.md §5/§6/§7（可成交性、停牌、后复权）。
 *
 * 结算字段（SR-2.2 全表逐条落点）：
 * - directionHit：严格不等（=0 两侧均不命中）；ABSTAIN → null（N_A，不参与方向命中）。
 * - excessReturn：e_window（逐日序列第 window 项，SR-3.4；定点字符串）。
 * - maxAdverse：跑赢取序列 min(e_d)、跑输取 max(e_d)，如实记录不为 0 截断；ABSTAIN → null。
 * - invalidationTriggered：跑赢首个 e_d ≤ −阈值、跑输首个 e_d ≥ +阈值（阈值默认 '0.12'，
 *   R29.3 终裁冻结，原预留 10%）；首个触发日记入 diagnostics.invalidationFirstDay；
 *   ABSTAIN → 字段缺席（N/A）。
 * - tradability：tradability.ts 四值 + §6 单独类；ABSTAIN → 'N_A'。
 * - 窗口状态：未到期（UNSETTLED，SR-2.4 不提前结算不做预测性回填）/ 已到期已结算（SETTLED）/
 *   结算异常（ANOMALY 具名登记，SR-10.4：数据缺口不静默跳过、不用替代数据补算）。
 *
 * 范围声明：本实现只覆盖个股结论（RESEARCH_OUTPERFORM/UNDERPERFORM/ABSTAIN）。
 * 宽基 ETF 结算（SR-8A：跟踪指数、RESEARCH_UP/DOWN、5% 阈值）不在 P3-EVENTS W13 派发面，
 * 跨类 disposition 具名拒绝（R18），未实现边界登记于交付回传。
 */
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import { loadFact } from '../pintime/facts.js';
import { BenchmarkError, requireResolvedBenchmark, type FrozenBenchmark } from '../conclusion/benchmark.js';
import { LimitRuleError } from '../rules/limit.js';
import { SettlementError, decCmp, decFromString, decFrom, decMax, decMin, decNeg, decToString, type Dec } from './decimal.js';
import { excessSeries, type ExcessDay, type ExcessSeriesResult, type FactorEvent, type IndustryBenchmark, type SuspensionGap } from './excess.js';
import { referenceOpen, type ReferenceOpenResult } from './reference.js';
import { classifyTradability, type TradabilityResult } from './tradability.js';
import type { SettlementZone } from '../contracts.js';

export const DEFAULT_WINDOW = 20; // SR-3.3
/** SR-6.1 失效触发冻结阈值 12%（R29.3 终裁，原预留 10%；评价窗口内不改，SR-6.3/7.4）。 */
export const DEFAULT_INVALIDATION_THRESHOLD = '0.12';

export type SettleDisposition = 'RESEARCH_OUTPERFORM' | 'RESEARCH_UNDERPERFORM' | 'ABSTAIN';

export interface SettleArgs {
  /** 股票代码（裸 6 位）。 */
  subject: string;
  disposition: SettleDisposition;
  /** 结论完成时刻（SR-3.1 参考价锚点）。 */
  conclusionTime: string | Date;
  /** 资料截点（SR-3.5 行业基准身份冻结时点；结论 businessKey.cutoff）。 */
  cutoff: string | Date;
  /** 研究阶段冻结并存入原结论；缺省不允许按当前库补猜。 */
  benchmark?: FrozenBenchmark | undefined;
  /** 事实读取 as-of（默认当前时刻；只消费窗口内各日事实）。 */
  asOf?: Date;
  /** 窗口长度（默认 20；测试注入用）。 */
  window?: number;
  /** 失效触发阈值（默认 '0.12'，R29.3 冻结值；定点字符串）。 */
  invalidationThreshold?: string;
}

/** 结算占位区 SETTLED 形态（SettlementZone 兼容；ABSTAIN 的 directionHit=null 表 N_A）。 */
export interface SettledZone extends SettlementZone {
  state: 'SETTLED';
  /** HIT=true / MISS=false；ABSTAIN → null（N_A）。 */
  directionHit: boolean | null;
  excessReturn: string;
  /** 跑赢 min(e_d) / 跑输 max(e_d)；ABSTAIN → null（N/A）。 */
  maxAdverse: string | null;
  /** ABSTAIN 时字段缺席（N/A）。 */
  invalidationTriggered?: boolean;
  /** ASHARE-RULES §5 四值 + §6 单独类；ABSTAIN → 'N_A'。 */
  tradability: string;
}

export interface SettleDiagnostics {
  subject: string;
  disposition: SettleDisposition;
  conclusionTime: string;
  cutoff: string;
  asOf: string;
  window: number;
  referenceDay: string;
  referenceOpen: string;
  deferredBySuspension: boolean;
  suspensionSpanTradingDays: number;
  windowEndDay: string;
  tradedDays: number;
  industry: IndustryBenchmark;
  referenceOpenAdj: string;
  indexOpenRef: string;
  series: ExcessDay[];
  suspensionGaps: SuspensionGap[];
  /** 全部除权事件与自算因子（含分子分母原始价，审计重放用）。 */
  factorEvents: FactorEvent[];
  invalidationThreshold: string;
  invalidationFirstDay: string | null;
  tradability: TradabilityResult;
}

export type SettleOutcome =
  | { state: 'UNSETTLED'; reason: 'REFERENCE_NOT_DUE' | 'WINDOW_INCOMPLETE'; detail: string; reference: ReferenceOpenResult }
  | { state: 'ANOMALY'; code: string; detail: string }
  | { state: 'SETTLED'; zone: SettledZone; diagnostics: SettleDiagnostics };

function toDate(value: string | Date, field: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new SettlementError('DATE_INVALID', `${field}: ${String(value)}`);
  return d;
}

/** 结算一个结论（窗口走完后调用；未到期返回 UNSETTLED，原样不提前结算）。 */
export async function settleConclusion(pool: Pool, args: SettleArgs): Promise<SettleOutcome> {
  const asOf = args.asOf ?? new Date();
  const conclusionTime = toDate(args.conclusionTime, 'conclusionTime');
  const cutoff = toDate(args.cutoff, 'cutoff');
  const window = args.window ?? DEFAULT_WINDOW;
  const thresholdStr = args.invalidationThreshold ?? DEFAULT_INVALIDATION_THRESHOLD;
  if (args.disposition !== 'RESEARCH_OUTPERFORM' && args.disposition !== 'RESEARCH_UNDERPERFORM' && args.disposition !== 'ABSTAIN') {
    throw new SettlementError(
      'SETTLE_INPUT_INVALID',
      `disposition ${args.disposition} 不在个股结算空间（宽基 SR-8A 不在本实现面，R18 跨类拒绝）`,
    );
  }
  if (typeof args.subject !== 'string' || !/^\d{6}$/.test(args.subject)) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `subject: ${String(args.subject)}（须裸 6 位代码）`);
  }
  let threshold: Dec;
  try {
    threshold = decFromString(thresholdStr, 'invalidationThreshold');
  } catch (error) {
    if (error instanceof SettlementError) throw new SettlementError('SETTLE_INPUT_INVALID', error.message);
    throw error;
  }
  if (decCmp(threshold, { scaled: 0n }) <= 0) {
    throw new SettlementError('SETTLE_INPUT_INVALID', `invalidationThreshold 须为正: ${thresholdStr}`);
  }

  try {
    // 1) 参考价（SR-3.1/3.2）
    const reference = await referenceOpen(pool, { subject: args.subject, conclusionTime, asOf });
    if (reference.state === 'NOT_DUE') {
      return { state: 'UNSETTLED', reason: 'REFERENCE_NOT_DUE', detail: reference.detail, reference };
    }
    // 2) 行业基准身份（SR-3.5 截点冻结；缺失 = 具名结算异常，不用替代基准）
    const binding = requireResolvedBenchmark(args.benchmark, { subjectKind: 'STOCK', subject: args.subject, cutoff });
    const industry = binding.industry!;
    const original = await loadFact(pool, industry.factId);
    if (original === null || canonicalSha256(original) !== canonicalSha256(binding.attributionFact)) {
      throw new BenchmarkError('BENCHMARK_FACT_MISMATCH', industry.factId);
    }
    // 3) 逐日累计超额序列（SR-3.3/3.4）
    const series: ExcessSeriesResult = await excessSeries(pool, {
      subject: args.subject,
      industryIndexCode: industry.industryIndexCode,
      refDay: reference.referenceDay,
      window,
      asOf,
    });
    if (!series.complete) {
      return {
        state: 'UNSETTLED',
        reason: 'WINDOW_INCOMPLETE',
        detail: `窗口仅走 ${String(series.days.length)}/${String(window)} 个有成交交易日（参考价日 ${reference.referenceDay}），SR-2.4 未到期不提前结算`,
        reference,
      };
    }
    // 4) 可成交性（ASHARE-RULES §5/§6；SR-4.3 不可成交仍照常结算）
    const tradability = classifyTradability({
      disposition: args.disposition,
      deferredBySuspension: reference.deferredBySuspension,
      suspensionSpanTradingDays: reference.suspensionSpanTradingDays,
      refDayBar: reference.bar,
      windowSuspensionGaps: series.suspensionGaps,
    });
    // 5) 六结算字段（SR-2.2；全部由同一份逐日序列导出，SR-3.4 证伪点）
    const eWindow = decFromString(series.eWindow as string, 'eWindow');
    const directionHit =
      args.disposition === 'RESEARCH_OUTPERFORM'
        ? decCmp(eWindow, { scaled: 0n }) > 0
        : args.disposition === 'RESEARCH_UNDERPERFORM'
          ? decCmp(eWindow, { scaled: 0n }) < 0
          : null; // ABSTAIN → N_A
    let maxAdverse: Dec | null = null;
    let invalidationTriggered: boolean | undefined;
    let invalidationFirstDay: string | null = null;
    const firstDay = series.days[0] as ExcessDay; // complete=true ⇒ 序列非空
    const firstE = decFrom(firstDay.e, 'e_d');
    if (args.disposition === 'RESEARCH_OUTPERFORM') {
      maxAdverse = series.days.reduce((m, d) => decMin(m, decFrom(d.e, 'e_d')), firstE);
      const triggerLevel = decNeg(threshold); // 跑赢：不利方向 e_d ≤ −阈值
      const hit = series.days.find((d) => decCmp(decFrom(d.e, 'e_d'), triggerLevel) <= 0);
      invalidationTriggered = hit !== undefined;
      invalidationFirstDay = hit?.day ?? null;
    } else if (args.disposition === 'RESEARCH_UNDERPERFORM') {
      maxAdverse = series.days.reduce((m, d) => decMax(m, decFrom(d.e, 'e_d')), firstE);
      const hit = series.days.find((d) => decCmp(decFrom(d.e, 'e_d'), threshold) >= 0); // 跑输：e_d ≥ +阈值
      invalidationTriggered = hit !== undefined;
      invalidationFirstDay = hit?.day ?? null;
    } // ABSTAIN：maxAdverse null、invalidationTriggered 缺席（N/A，SR-2.2）

    const zone: SettledZone =
      args.disposition === 'ABSTAIN'
        ? {
            state: 'SETTLED',
            directionHit: null,
            excessReturn: decToString(eWindow),
            maxAdverse: null,
            tradability: 'N_A',
          }
        : {
            state: 'SETTLED',
            directionHit,
            excessReturn: decToString(eWindow),
            maxAdverse: decToString(maxAdverse as Dec),
            ...(invalidationTriggered === undefined ? {} : { invalidationTriggered }),
            tradability: tradability.tradability,
          };
    const diagnostics: SettleDiagnostics = {
      subject: args.subject,
      disposition: args.disposition,
      conclusionTime: conclusionTime.toISOString(),
      cutoff: cutoff.toISOString(),
      asOf: asOf.toISOString(),
      window,
      referenceDay: reference.referenceDay,
      referenceOpen: reference.referenceOpen,
      deferredBySuspension: reference.deferredBySuspension,
      suspensionSpanTradingDays: reference.suspensionSpanTradingDays,
      windowEndDay: series.windowEndDay as string,
      tradedDays: series.days.length,
      industry,
      referenceOpenAdj: series.referenceOpenAdj,
      indexOpenRef: series.indexOpenRef,
      series: series.days,
      suspensionGaps: series.suspensionGaps,
      factorEvents: series.factorEvents,
      invalidationThreshold: thresholdStr,
      invalidationFirstDay,
      tradability,
    };
    return { state: 'SETTLED', zone, diagnostics };
  } catch (error) {
    if (error instanceof SettlementError || error instanceof BenchmarkError) {
      return { state: 'ANOMALY', code: error.code, detail: error.message };
    }
    if (error instanceof LimitRuleError) {
      return { state: 'ANOMALY', code: error.code, detail: error.message };
    }
    throw error; // 基础设施故障（DB 等）不冒充结算异常，如实上抛
  }
}
