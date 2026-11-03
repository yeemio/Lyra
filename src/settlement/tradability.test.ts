/**
 * Lyra · 可成交性分类单测（P3 W13: code-writer-pro）。纯函数，无 DB。
 * 合同判定：ASHARE-RULES §2.1（系数按时点版本化：ST 2026-07-06 前 5%/后 10% 证伪）/
 * §2.4（一字板：四价相等且收盘=涨跌停价；触板非一字按可成交）/
 * §5（方向绑定：涨停挡跑赢、跌停挡跑输、停牌两侧；放弃 N/A）/
 * §6（顺延停牌 UNFILLABLE_SUSPENDED；跨度 > 20 交易日 SUSPENDED_OVER_20D 单独类）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTradability } from './tradability.js';
import { SettlementError } from './decimal.js';
import type { DailyBarView } from './reference.js';

function makeBar(args: {
  date: string; open: string; high: string; low: string; close: string; preclose: string; isST?: '0' | '1';
}): DailyBarView {
  return {
    factId: `bar-${args.date}`,
    date: args.date,
    open: args.open,
    high: args.high,
    low: args.low,
    close: args.close,
    preclose: args.preclose,
    volume: '1000',
    amount: '10000.0000',
    isST: args.isST ?? '0',
    tradestatus: '1',
  };
}

const NORMAL_BAR = makeBar({ date: '2024-01-05', open: '10.20', high: '10.80', low: '10.10', close: '10.60', preclose: '10.00' });
const NO_GAPS = [{ tradingDays: 0 }];

test('ABSTAIN → N_A（放弃无交易意图，不参与可成交性判定）', () => {
  const r = classifyTradability({
    disposition: 'ABSTAIN', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: NORMAL_BAR, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(r.tradability, 'N_A');
  assert.equal(r.oneWordBoard, null);
});

test('参考价顺延：跨度 ≤ 20 → UNFILLABLE_SUSPENDED；跨度 > 20 → SUSPENDED_OVER_20D', () => {
  const base = { disposition: 'RESEARCH_OUTPERFORM' as const, refDayBar: null, windowSuspensionGaps: NO_GAPS };
  const span2 = classifyTradability({ ...base, deferredBySuspension: true, suspensionSpanTradingDays: 2 });
  assert.equal(span2.tradability, 'UNFILLABLE_SUSPENDED');
  const span20 = classifyTradability({ ...base, deferredBySuspension: true, suspensionSpanTradingDays: 20 });
  assert.equal(span20.tradability, 'UNFILLABLE_SUSPENDED'); // 恰 20 不算长期（> 20 严格）
  const span21 = classifyTradability({ ...base, deferredBySuspension: true, suspensionSpanTradingDays: 21 });
  assert.equal(span21.tradability, 'SUSPENDED_OVER_20D');
});

test('一字涨停：跑赢不可成交 / 跑输可成交（ASHARE §5 方向绑定）', () => {
  const bar = makeBar({ date: '2024-01-05', open: '11.00', high: '11.00', low: '11.00', close: '11.00', preclose: '10.00' });
  const up = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: bar, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(up.tradability, 'UNFILLABLE_LIMIT_UP');
  assert.equal(up.oneWordBoard, 'LIMIT_UP');
  assert.equal(up.limit?.up, '11.00'); // 10.00 × 1.1 四舍五入到分
  const down = classifyTradability({
    disposition: 'RESEARCH_UNDERPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: bar, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(down.tradability, 'FILLABLE'); // 一字涨停不挡卖出/回避侧
  assert.equal(down.oneWordBoard, 'LIMIT_UP');
});

test('一字跌停：跑输不可成交 / 跑赢可成交', () => {
  const bar = makeBar({ date: '2024-01-05', open: '9.00', high: '9.00', low: '9.00', close: '9.00', preclose: '10.00' });
  const down = classifyTradability({
    disposition: 'RESEARCH_UNDERPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: bar, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(down.tradability, 'UNFILLABLE_LIMIT_DOWN');
  assert.equal(down.oneWordBoard, 'LIMIT_DOWN');
  assert.equal(down.limit?.down, '9.00');
  const up = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: bar, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(up.tradability, 'FILLABLE');
});

test('四价相等但不在板价（非一字板）→ FILLABLE；触板非一字（盘中打开）→ FILLABLE', () => {
  const flatNotAtLimit = makeBar({ date: '2024-01-05', open: '10.50', high: '10.50', low: '10.50', close: '10.50', preclose: '10.00' });
  for (const disposition of ['RESEARCH_OUTPERFORM', 'RESEARCH_UNDERPERFORM'] as const) {
    const r = classifyTradability({
      disposition, deferredBySuspension: false, suspensionSpanTradingDays: 0,
      refDayBar: flatNotAtLimit, windowSuspensionGaps: NO_GAPS,
    });
    assert.equal(r.tradability, 'FILLABLE');
    assert.equal(r.oneWordBoard, null);
  }
  // 收盘触涨停但盘中打开（high > low）：非一字，按可成交（ASHARE §2.4）
  const touchedOpened = makeBar({ date: '2024-01-05', open: '10.60', high: '11.00', low: '10.50', close: '11.00', preclose: '10.00' });
  const r2 = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: touchedOpened, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(r2.tradability, 'FILLABLE');
  assert.equal(r2.oneWordBoard, null);
});

test('ASHARE §2.1 证伪：ST 系数按时点版本化（2025 ST 日 5%、2026-07-06 起 10%）', () => {
  const stBar2025 = makeBar({ date: '2025-06-02', open: '10.50', high: '10.50', low: '10.50', close: '10.50', preclose: '10.00', isST: '1' });
  const r2025 = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: stBar2025, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(r2025.limit?.up, '10.50'); // 10.00 × 1.05（用当前 10% 判 2025 ST 日即违约）
  assert.equal(r2025.tradability, 'UNFILLABLE_LIMIT_UP');
  assert.equal(r2025.limit?.ruleVersionId, 'ASHARE-LIMIT-2026A-MAINBOARD-ST-5');

  const stBar2026 = makeBar({ date: '2026-07-06', open: '11.00', high: '11.00', low: '11.00', close: '11.00', preclose: '10.00', isST: '1' });
  const r2026 = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: stBar2026, windowSuspensionGaps: NO_GAPS,
  });
  assert.equal(r2026.limit?.up, '11.00'); // 10.00 × 1.10（R19 切换后）
  assert.equal(r2026.tradability, 'UNFILLABLE_LIMIT_UP');
  assert.equal(r2026.limit?.ruleVersionId, 'ASHARE-LIMIT-2026B-MAINBOARD-ST-10');
});

test('窗口内长期停牌：间隔 > 20 市场交易日 → SUSPENDED_OVER_20D（恰 20 不算）', () => {
  const base = {
    disposition: 'RESEARCH_OUTPERFORM' as const,
    deferredBySuspension: false,
    suspensionSpanTradingDays: 0,
    refDayBar: NORMAL_BAR,
  };
  const gap20 = classifyTradability({ ...base, windowSuspensionGaps: [{ tradingDays: 20 }] });
  assert.equal(gap20.tradability, 'FILLABLE');
  const gap21 = classifyTradability({ ...base, windowSuspensionGaps: [{ tradingDays: 21 }] });
  assert.equal(gap21.tradability, 'SUSPENDED_OVER_20D');
});

test('优先级：参考价日一字板 > 窗口内长期停牌（入口可执行性优先，罕见并存按入口阻断）', () => {
  const bar = makeBar({ date: '2024-01-05', open: '11.00', high: '11.00', low: '11.00', close: '11.00', preclose: '10.00' });
  const r = classifyTradability({
    disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
    refDayBar: bar, windowSuspensionGaps: [{ tradingDays: 25 }],
  });
  assert.equal(r.tradability, 'UNFILLABLE_LIMIT_UP');
});

test('具名拒绝：跨类 disposition / 未顺延却无参考价日行情行', () => {
  assert.throws(
    () => classifyTradability({
      disposition: 'RESEARCH_UP', deferredBySuspension: false, suspensionSpanTradingDays: 0,
      refDayBar: NORMAL_BAR, windowSuspensionGaps: NO_GAPS,
    }),
    (e: unknown) => e instanceof SettlementError && e.code === 'SETTLE_INPUT_INVALID',
  );
  assert.throws(
    () => classifyTradability({
      disposition: 'RESEARCH_OUTPERFORM', deferredBySuspension: false, suspensionSpanTradingDays: 0,
      refDayBar: null, windowSuspensionGaps: NO_GAPS,
    }),
    (e: unknown) => e instanceof SettlementError && e.code === 'REFDAY_BAR_MISSING',
  );
});
