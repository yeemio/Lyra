/**
 * Lyra · 可成交性分类（P3 W13: code-writer-pro）。
 * 合同：docs/specs/ASHARE-RULES.md §5（四值分类 + 方向绑定：一字涨停挡买入（跑赢）、
 * 一字跌停挡卖出（跑输）、停牌两侧皆不可成交；放弃 N/A）/ §2（一字板判定：四价按分取整
 * 相等且收盘=涨跌停价；判定用不复权原始价；涨跌停价经 src/rules/limit.ts 限系数按时点
 * 版本化取，四舍五入到分）/ §6（停牌：参考价顺延 → UNFILLABLE_SUSPENDED；停牌超过
 * 20 个交易日 → SUSPENDED_OVER_20D 单独类，不并入普通不可成交组，也不并入主统计）；
 * docs/specs/SETTLEMENT-REVIEW.md SR-4.3（不可成交样本单独分类、独立计数、不混入主统计，
 * 仍照常结算）。
 *
 * 优先级（单一字段的确定性裁定，写死并测试）：
 *   N_A（放弃）> 参考价日一字板方向阻断（UNFILLABLE_LIMIT_UP/DOWN）> 参考价顺延停牌
 *   （跨度 > 20 市场交易日 → SUSPENDED_OVER_20D，否则 UNFILLABLE_SUSPENDED）> 窗口内
 *   长期停牌（任一间隔 > 20 市场交易日 → SUSPENDED_OVER_20D）> FILLABLE。
 * 理由：入口可执行性（参考价日能否按参考价成交）是首要事实；顺延跨度 > 20 按 §6 明文
 * 单独分类；一字板与窗口内长停牌并存的罕见组合按入口阻断归类（登记于本注释，不猜）。
 */
import { fenOf, limitCoefficient, limitPrice } from '../rules/limit.js';
import { SettlementError } from './decimal.js';
import type { DailyBarView } from './reference.js';

export type TradabilityClass =
  | 'FILLABLE'
  | 'UNFILLABLE_LIMIT_UP'
  | 'UNFILLABLE_LIMIT_DOWN'
  | 'UNFILLABLE_SUSPENDED'
  | 'SUSPENDED_OVER_20D'
  | 'N_A';

/** ASHARE-RULES §6：停牌超过 20 个交易日的结论单独分类。 */
export const LONG_SUSPENSION_TRADING_DAYS = 20;

export interface TradabilityInput {
  /** 结论方向（RESEARCH_OUTPERFORM / RESEARCH_UNDERPERFORM / ABSTAIN）。 */
  disposition: string;
  /** 参考价日因停牌顺延（SR-3.2 末行 → UNFILLABLE_SUSPENDED 系）。 */
  deferredBySuspension: boolean;
  /** 顺延跨度（首个候选市场交易日起至复牌前一日的市场交易日数；未顺延为 0）。 */
  suspensionSpanTradingDays: number;
  /** 参考价日行情行（未顺延时必有；一字板判定输入）。 */
  refDayBar: DailyBarView | null;
  /** 窗口内逐段停牌间隔（excessSeries.suspensionGaps；间隔 > 20 → 长期停牌）。 */
  windowSuspensionGaps: readonly { tradingDays: number }[];
}

export interface TradabilityResult {
  tradability: TradabilityClass;
  /** 参考价日一字板方向（非一字板为 null）。 */
  oneWordBoard: 'LIMIT_UP' | 'LIMIT_DOWN' | null;
  /** 涨跌停价与限系数（判定输入审计；未做板判定为 null）。 */
  limit: { up: string; down: string; coefficient: number; ruleVersionId: string; stStatus: string } | null;
  reason: string;
}

function priceFen(price: string, field: string, factId: string): number {
  const n = Number(price);
  if (!Number.isFinite(n)) {
    throw new SettlementError('BAR_FIELD_INVALID', `DAILY_BAR ${factId} ${field} 不可数值化: ${price}`);
  }
  return fenOf(n); // 元 → 整数分（half-up；limit.ts 冻结口径）
}

/**
 * 四值（+§6 两类）可成交性分类（ASHARE-RULES §5/§6；纯函数）。
 * 一字板判定：开=高=低=收（按分取整相等）且收盘=当日涨停价/跌停价（limitPrice，
 * 四舍五入到分，不复权原始价）。
 */
export function classifyTradability(input: TradabilityInput): TradabilityResult {
  if (input.disposition === 'ABSTAIN') {
    return { tradability: 'N_A', oneWordBoard: null, limit: null, reason: '放弃结论无交易意图，不参与可成交性判定（ASHARE-RULES §5）' };
  }
  if (input.disposition !== 'RESEARCH_OUTPERFORM' && input.disposition !== 'RESEARCH_UNDERPERFORM') {
    throw new SettlementError('SETTLE_INPUT_INVALID', `disposition: ${input.disposition}（个股结论空间外，R18 跨类拒绝）`);
  }
  // 参考价日因停牌顺延：可成交性 = UNFILLABLE_SUSPENDED（跨度 > 20 市场交易日 → 单独类）
  if (input.deferredBySuspension) {
    if (input.suspensionSpanTradingDays > LONG_SUSPENSION_TRADING_DAYS) {
      return {
        tradability: 'SUSPENDED_OVER_20D',
        oneWordBoard: null,
        limit: null,
        reason: `参考价顺延跨度 ${String(input.suspensionSpanTradingDays)} 个市场交易日 > ${String(LONG_SUSPENSION_TRADING_DAYS)}（ASHARE-RULES §6 长期停牌单独类）`,
      };
    }
    return {
      tradability: 'UNFILLABLE_SUSPENDED',
      oneWordBoard: null,
      limit: null,
      reason: `参考价日因停牌顺延（跨度 ${String(input.suspensionSpanTradingDays)} 个市场交易日，SR-3.2/ASHARE-RULES §6）`,
    };
  }
  const bar = input.refDayBar;
  if (bar === null) {
    throw new SettlementError('REFDAY_BAR_MISSING', '未顺延但参考价日行情行缺失（输入不一致）');
  }
  const stStatus = bar.isST === '1' ? 'ST' : 'NORMAL'; // isST 0/1；ST 与 *ST 限系数同表同值
  const { coefficient, ruleVersionId } = limitCoefficient({ board: 'MAINBOARD', stStatus, date: bar.date });
  const up = limitPrice(Number(bar.preclose), 'UP', coefficient);
  const down = limitPrice(Number(bar.preclose), 'DOWN', coefficient);
  const limit = { up, down, coefficient, ruleVersionId, stStatus };
  const openFen = priceFen(bar.open, 'open', bar.factId);
  const highFen = priceFen(bar.high, 'high', bar.factId);
  const lowFen = priceFen(bar.low, 'low', bar.factId);
  const closeFen = priceFen(bar.close, 'close', bar.factId);
  const fourEqual = openFen === highFen && highFen === lowFen && lowFen === closeFen;
  const oneWordUp = fourEqual && closeFen === priceFen(up, '涨停价', bar.factId);
  const oneWordDown = fourEqual && closeFen === priceFen(down, '跌停价', bar.factId);
  if (oneWordUp) {
    return input.disposition === 'RESEARCH_OUTPERFORM'
      ? {
          tradability: 'UNFILLABLE_LIMIT_UP',
          oneWordBoard: 'LIMIT_UP',
          limit,
          reason: `参考价日一字涨停（四价 ${bar.open} = 涨停价 ${up}，${ruleVersionId}）：跑赢方向不可成交（ASHARE-RULES §5）`,
        }
      : {
          tradability: 'FILLABLE',
          oneWordBoard: 'LIMIT_UP',
          limit,
          reason: `参考价日一字涨停但结论方向为跑输（卖出/回避侧）：可成交（ASHARE-RULES §5）`,
        };
  }
  if (oneWordDown) {
    return input.disposition === 'RESEARCH_UNDERPERFORM'
      ? {
          tradability: 'UNFILLABLE_LIMIT_DOWN',
          oneWordBoard: 'LIMIT_DOWN',
          limit,
          reason: `参考价日一字跌停（四价 ${bar.open} = 跌停价 ${down}，${ruleVersionId}）：跑输方向不可成交（ASHARE-RULES §5）`,
        }
      : {
          tradability: 'FILLABLE',
          oneWordBoard: 'LIMIT_DOWN',
          limit,
          reason: `参考价日一字跌停但结论方向为跑赢（买入侧）：可成交（ASHARE-RULES §5）`,
        };
  }
  // 窗口内长期停牌（参考价日可成交，但窗口含 > 20 市场交易日停牌段）
  const longGap = input.windowSuspensionGaps.find((g) => g.tradingDays > LONG_SUSPENSION_TRADING_DAYS);
  if (longGap !== undefined) {
    return {
      tradability: 'SUSPENDED_OVER_20D',
      oneWordBoard: null,
      limit,
      reason: `窗口内停牌间隔 ${String(longGap.tradingDays)} 个市场交易日 > ${String(LONG_SUSPENSION_TRADING_DAYS)}（ASHARE-RULES §6 长期停牌单独类；窗口照走不并入主统计）`,
    };
  }
  return {
    tradability: 'FILLABLE',
    oneWordBoard: null,
    limit,
    reason: `参考价日非一字板（四价 ${bar.open}/${bar.high}/${bar.low}/${bar.close}；涨停 ${up} / 跌停 ${down}，${ruleVersionId}）：可成交`,
  };
}
