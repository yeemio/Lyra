/** 仅工程夹具：所有日历、行情、规则、行业与账户均为人工合成，绝非实际市场历史。 */
import { canonicalSha256 } from '../../canonical.js';
import type { Knowledge, StrategyData, StrategyRules } from './contracts.js';
import { freezeRules } from './plan.js';
import { ratio } from './money.js';

export function fixtureKnowledge(id: string, at: string): Knowledge {
  return { factId: id, artifactSha256: canonicalSha256({ synthetic: id }), source: `synthetic://${id}`, adapterVersion: 'synthetic-daily-v1', sourcePublishedAt: at, firstObservedAt: at, recordedAt: at, availableAt: at, supersedesFactId: null };
}

export function syntheticData(): StrategyData {
  const dates: string[] = [];
  const cursor = new Date('2026-06-01T00:00:00.000Z');
  while (dates.length < 58) { if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  const before = '2026-05-29T08:00:00.000Z';
  const sessions = dates.map((d) => ({ date: d, openAt: `${d}T01:30:00.000Z`, closeAt: `${d}T07:00:00.000Z` }));
  const data: StrategyData = { schema: 'lyra-daily-data-v1', identity: 'SYNTHETIC', revisionPolicy: 'POINT_IN_TIME_VERSIONS', subject: '601919', subjectName: '中远海控（同标的合成演示）', marketBenchmark: 'SYNTH_MARKET',
    calendar: { ...fixtureKnowledge('calendar', before), completeFrom: dates[0]!, completeTo: dates.at(-1)!, completeness: 'DECLARED_COMPLETE', sessions },
    bars: [], openings: [], states: [], factors: [], actions: [], industries: [], logic: [],
    account: { ...fixtureKnowledge('account', before), identity: 'SYNTHETIC_ACCOUNT', confirmedAt: before, asOf: before, cashFen: 10_000_000, holdings: [], constraints: { maxPositionValueFen: 2_000_000, maxLossFen: 60_000, stressGapBps: 200 } } };
  const cycle = [0, 10, 20, 30, 40, 50, 60, 20, -20, -10, 0, 10];
  const price = (subject: string, i: number): number => subject === data.subject ? 1000 + Math.floor(i / cycle.length) * 10 + cycle[i % cycle.length]! : subject === data.marketBenchmark ? 5000 + i * 8 : 2000 + i * 3;
  for (const subject of [data.subject, data.marketBenchmark, 'SYNTH_INDUSTRY']) data.factors.push({ ...fixtureKnowledge(`factor:${subject}`, before), subject, effectiveOn: dates[0]!, numerator: 1, denominator: 1, actionId: null });
  data.industries.push({ ...fixtureKnowledge('membership', before), subject: data.subject, industry: 'SYNTH_INDUSTRY', validFrom: dates[0]!, validTo: null });
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    for (const subject of [data.subject, data.marketBenchmark, 'SYNTH_INDUSTRY']) {
      const open = price(subject, Math.max(0, i - 1)), close = price(subject, i);
      data.openings.push({ ...fixtureKnowledge(`open:${subject}:${s.date}`, s.openAt), subject, date: s.date, priceBasis: 'RAW', openFen: open });
      data.bars.push({ ...fixtureKnowledge(`bar:${subject}:${s.date}`, s.closeAt), subject, date: s.date, priceBasis: 'RAW', openFen: open, highFen: Math.max(open, close) + 4, lowFen: Math.min(open, close) - 4, closeFen: close, volumeShares: 1_000_000 + i * 1000 });
    }
    const preclose = price(data.subject, Math.max(0, i - 1));
    data.states.push({ ...fixtureKnowledge(`state:${s.date}`, `${s.date}T01:29:00.000Z`), subject: data.subject, date: s.date, state: 'TRADING', ruleVersion: 'SYNTHETIC_MAIN_BOARD_10_PERCENT_NOT_LEGAL_CLAIM', upperLimitFen: ratio(preclose, 11_000, 10_000), lowerLimitFen: ratio(preclose, 9000, 10_000), tickFen: 1, buyLotShares: 100, settlementDays: 1, actionIds: [] });
  }
  return data;
}

export function syntheticRules(data: StrategyData): StrategyRules {
  const day = (i: number): string => data.calendar.sessions[i]!.date;
  return freezeRules({ schema: 'lyra-daily-rules-v1', family: 'DAILY_TREND_WITH_WAIT', methodVersion: 'daily-trend@offline-v1', dataContractVersion: 'daily-pit-input@v1', planAuthVersion: 'offline-static-artifacts-no-model-call@v1', parameterStatus: 'DEMO_NOT_EFFICACY_VALIDATED', frozenAt: '2026-10-29T03:00:00.000Z',
    selectionReason: '人工选择小窗口以覆盖离线行为；规则与IS/OOS分界先冻结，再运行程序；未搜索参数或挑选收益。不是个人策略默认值。', fastSessions: 3, slowSessions: 5, signalDelayMinutes: 5, entryGapBps: 300, stopBps: 400, profitBps: 700,
    maxHoldingSessions: 3, pendingEntrySessions: 3, planLifetimeSessions: 8,
    costs: { commissionBps: 3, minCommissionFen: 500, sellTaxBps: 5, transferBps: 1, slippageBps: 10, dividendTaxBps: 1000 },
    inSample: { from: day(8), to: day(22) }, outOfSample: { from: day(23), to: day(37) }, minimumSessions: 10, minimumClosedTrades: 1, metricContract: 'CLOSE_EQUITY_V1' });
}
