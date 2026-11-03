/** 真实回溯资料的条件研究；有意不扩宽严格PIT StrategyData或FrozenPlan执行门。 */
import { canonicalSha256 } from '../../canonical.js';
import { DEC_ZERO, decAdd, decDiv, decFromInt, decFromString, decMul, decToString } from '../../settlement/decimal.js';
import type { StrategyRules } from './contracts.js';
import { ratio, StrategyError } from './money.js';
import { assertRules } from './plan.js';

export interface RealSource {
  id: string;
  path: string;
  sha256: string;
  label: string;
  mediaType: 'application/json' | 'text/html';
  confirmedAt: string;
}
export interface RealObservation {
  subject: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  priceBasis: 'RAW';
  sourceId: string;
  sourceRow: number;
  factId: string | null;
  sourcePublishedAt: string | null;
  sourcePublishedAtBasis: 'UNREPORTED' | 'LEGACY_RECORDED_VALUE_NOT_INDEPENDENTLY_VERIFIED';
  firstObservedAt: string;
  recordedAt: string;
  availableAt: string;
  legacyAvailableAt: string | null;
}
export interface RealDailyDataset {
  schema: 'lyra-real-daily-dataset-v1';
  identity: 'REAL_PUBLIC_DATA';
  mode: 'LATEST_REVISED';
  subject: '601919';
  subjectName: string;
  marketBenchmark: '000300';
  industryBenchmark: '801170';
  industryBasis: string;
  knowledgeCutoff: string;
  marketDate: string;
  researchWindow: { from: string; to: string };
  calendar: { from: string; to: string; sourceId: string; days: { date: string; trading: boolean }[] };
  bars: RealObservation[];
  factors: { effectiveOn: string; backwardFactor: string; firstObservedAt: string; sourcePublishedAt: string | null; legacyAvailableAt: string; sourceId: string; factId: string }[];
  sources: RealSource[];
  companyReportSourceId: string;
  rules: StrategyRules;
  dataHash: string;
}

export interface RealStrategyView {
  schema: 'lyra-real-strategy-research-v1';
  identity: 'REAL_PUBLIC_DATA';
  mode: 'LATEST_REVISED';
  subject: '601919';
  subjectName: string;
  dataHash: string;
  rulesHash: string;
  materializedAt: string;
  knowledgeCutoff: string;
  marketDate: string;
  researchWindow: { from: string; to: string };
  coverage: { subject: string; label: string; expected: number; observed: number; missingDates: string[]; duplicateDates: string[]; nonCalendarDates: string[]; first: string | null; last: string | null }[];
  evidenceStatus: 'CONTINUOUS_RETROSPECTIVE_DATA' | 'DATA_INCOMPLETE';
  fit: 'PROVISIONAL_TREND_MATCH' | 'WAIT_STOCK_TREND' | 'WAIT_ENVIRONMENT' | 'DATA_PENDING';
  condition: 'RULE_TRIGGERED_RESEARCH_ONLY' | 'NOT_TRIGGERED' | 'DATA_PENDING';
  publication: 'UNREVIEWED_CONDITIONAL_DRAFT';
  features: { subject: string; label: string; date: string; rawClose: string; featureClose: string; fastMean: string; slowMean: string; priceBasis: string; lastObservationAvailableAt: string }[];
  draft: {
    draftId: string;
    entryLowerFen: number | null;
    entryUpperFen: number | null;
    priceInvalidBelowFen: number | null;
    profitAboveFen: number | null;
    expiresOn: null;
    quantity: null;
    account: null;
    riskBudget: null;
    conditions: string[];
    alternatives: { family: string; selected: boolean; reason: string }[];
    scenarios: { name: string; rawExitFen: number; quantity: null; feesFen: null; netPnlFen: null; assumption: string }[];
  };
  validation: {
    status: 'BLOCKED_MISSING_EXECUTION_INPUTS';
    windows: { kind: 'IS' | 'OOS'; from: string; to: string; expectedSessions: number; alignedSessions: number }[];
    evaluatedOpportunities: null;
    metrics: null;
    efficacyAccepted: false;
  };
  review: { a: 'NOT_RUN'; checklist: 'NOT_DERIVED_WITHOUT_A'; j: 'NOT_RUN'; gatePassed: false; executionEligible: false; modelCalls: 0; newPermits: 0 };
  blockers: { code: string; detail: string }[];
  limitations: string[];
  sources: { id: string; label: string; sha256: string }[];
  companyReportSourceId: string;
  viewHash: string;
}

function mean(values: string[]): string {
  return decToString(decDiv(values.reduce((a, b) => decAdd(a, decFromString(b)), DEC_ZERO), decFromInt(values.length)));
}

export function assertRealDataset(data: RealDailyDataset): void {
  const { dataHash, ...core } = data;
  if (data.schema !== 'lyra-real-daily-dataset-v1' || data.identity !== 'REAL_PUBLIC_DATA' || data.mode !== 'LATEST_REVISED' || data.subject !== '601919' || canonicalSha256(core) !== dataHash) throw new StrategyError('REAL_DATA_IDENTITY_INVALID');
  assertRules(data.rules);
  const sources = new Set(data.sources.map((s) => s.id));
  if (sources.size !== data.sources.length || !sources.has(data.calendar.sourceId) || !sources.has(data.companyReportSourceId)) throw new StrategyError('REAL_SOURCE_DIRECTORY_INVALID');
  const days = new Set<string>();
  for (const d of data.calendar.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || days.has(d.date)) throw new StrategyError('REAL_CALENDAR_INVALID');
    days.add(d.date);
  }
  for (const b of data.bars) {
    if (!sources.has(b.sourceId) || b.priceBasis !== 'RAW' || !days.has(b.date) || !['601919', '000300', '801170'].includes(b.subject)) throw new StrategyError('REAL_BAR_SOURCE_OR_CALENDAR_INVALID');
    for (const price of [b.open, b.high, b.low, b.close]) if (decFromString(price).scaled <= 0n) throw new StrategyError('REAL_BAR_PRICE_INVALID');
    if (decFromString(b.high).scaled < decFromString(b.low).scaled || decFromString(b.low).scaled > decFromString(b.close).scaled || decFromString(b.high).scaled < decFromString(b.close).scaled
      || decFromString(b.low).scaled > decFromString(b.open).scaled || decFromString(b.high).scaled < decFromString(b.open).scaled) throw new StrategyError('REAL_BAR_OHLC_INVALID');
    if (!Number.isFinite(Date.parse(b.firstObservedAt)) || !Number.isFinite(Date.parse(b.recordedAt)) || b.firstObservedAt > b.recordedAt || b.recordedAt > b.availableAt || b.availableAt > data.knowledgeCutoff) throw new StrategyError('REAL_ACQUISITION_TIME_INVALID');
  }
  for (const f of data.factors) if (!sources.has(f.sourceId) || f.firstObservedAt > data.knowledgeCutoff || decFromString(f.backwardFactor).scaled <= 0n) throw new StrategyError('REAL_FACTOR_INVALID');
}

export function buildRealStrategyView(data: RealDailyDataset, materializedAt: string): RealStrategyView {
  assertRealDataset(data);
  if (materializedAt < data.knowledgeCutoff || !Number.isFinite(Date.parse(materializedAt))) throw new StrategyError('REAL_MATERIALIZATION_TIME_INVALID');
  const expected = data.calendar.days.filter((d) => d.trading && d.date >= data.researchWindow.from && d.date <= data.researchWindow.to).map((d) => d.date);
  const subjects = [{ subject: data.subject, label: data.subjectName }, { subject: data.marketBenchmark, label: '沪深300市场基准' }, { subject: data.industryBenchmark, label: '申万交通运输行业基准' }];
  const coverage = subjects.map(({ subject, label }) => {
    const rows = data.bars.filter((b) => b.subject === subject && b.date >= data.researchWindow.from && b.date <= data.researchWindow.to);
    const dates = rows.map((b) => b.date).sort(), unique = new Set(dates);
    return { subject, label, expected: expected.length, observed: unique.size, missingDates: expected.filter((d) => !unique.has(d)), duplicateDates: [...new Set(dates.filter((d, i) => dates.indexOf(d) !== i))], nonCalendarDates: dates.filter((d) => !expected.includes(d)), first: dates[0] ?? null, last: dates.at(-1) ?? null };
  });
  const complete = expected.length > 0 && coverage.every((c) => c.missingDates.length === 0 && c.duplicateDates.length === 0 && c.nonCalendarDates.length === 0);
  const features: RealStrategyView['features'] = [];
  const reasons: RealStrategyView['blockers'] = [];
  for (const { subject, label } of subjects) {
    const rows = data.bars.filter((b) => b.subject === subject && b.date <= data.marketDate).sort((a, b) => a.date.localeCompare(b.date));
    const window = rows.slice(-data.rules.slowSessions), latest = window.at(-1);
    if (window.length < data.rules.slowSessions || !latest || latest.date !== data.marketDate) { reasons.push({ code: 'REAL_FEATURE_WARMUP_OR_ENDPOINT_MISSING', detail: `${subject} 慢均线/共同末日未覆盖` }); continue; }
    const adjusted = window.map((b) => {
      if (subject !== data.subject) return b.close;
      const factor = data.factors.filter((f) => f.effectiveOn <= b.date).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)).at(-1);
      if (!factor) throw new StrategyError('REAL_RETROSPECTIVE_FACTOR_MISSING', b.date);
      return decToString(decMul(decFromString(b.close), decFromString(factor.backwardFactor)));
    });
    features.push({ subject, label, date: latest.date, rawClose: latest.close, featureClose: adjusted.at(-1)!, fastMean: mean(adjusted.slice(-data.rules.fastSessions)), slowMean: mean(adjusted), priceBasis: subject === data.subject ? '当前取得的后复权因子按生效日连接，仅回溯特征；成交条款仍用原始价' : '来源原生指数点位；价格指数参照，不冒称可交易含息基准', lastObservationAvailableAt: latest.availableAt });
  }
  let fit: RealStrategyView['fit'] = 'DATA_PENDING';
  const stock = features.find((f) => f.subject === data.subject), market = features.find((f) => f.subject === data.marketBenchmark), industry = features.find((f) => f.subject === data.industryBenchmark);
  if (complete && stock && market && industry) fit = decFromString(market.featureClose).scaled <= decFromString(market.slowMean).scaled || decFromString(industry.featureClose).scaled <= decFromString(industry.slowMean).scaled ? 'WAIT_ENVIRONMENT'
    : decFromString(stock.fastMean).scaled > decFromString(stock.slowMean).scaled && decFromString(stock.featureClose).scaled > decFromString(stock.fastMean).scaled ? 'PROVISIONAL_TREND_MATCH' : 'WAIT_STOCK_TREND';
  const rawCloseFen = stock ? ratio(decFromString(stock.rawClose).scaled, 100, 10n ** 12n) : null;
  const lower = rawCloseFen === null ? null : ratio(rawCloseFen, 10_000 - data.rules.entryGapBps, 10_000), upper = rawCloseFen === null ? null : ratio(rawCloseFen, 10_000 + data.rules.entryGapBps, 10_000), stop = rawCloseFen === null ? null : ratio(rawCloseFen, 10_000 - data.rules.stopBps, 10_000), profit = rawCloseFen === null ? null : ratio(rawCloseFen, 10_000 + data.rules.profitBps, 10_000);
  const blockers = [
    ...reasons,
    ...(!complete ? [{ code: 'REAL_CONTINUOUS_COVERAGE_INCOMPLETE', detail: '交易日历与三条序列未完全对齐；缺日不当作停牌' }] : []),
    { code: 'LATEST_REVISED_NOT_HISTORICAL_PIT', detail: '真实历史资料于本次或此前实际回填取得，不能倒签为历史当时已取得；未运行严格PIT历史验证' },
    { code: 'INDEPENDENT_OPEN_OBSERVATIONS_MISSING', detail: '日终OHLC里的open只是来源历史字段，不是当时独立可得的开盘观测' },
    { code: 'DAILY_RULE_AND_ACTION_EXECUTION_INPUTS_UNVERIFIED', detail: '日终isST/tradestatus与因子不替代逐日规则/限价、停牌证据及公司行为股数/现金条款' },
    { code: 'USER_ACCOUNT_AND_RISK_BUDGET_MISSING', detail: '缺用户确认的资金、持仓、可卖数量和风险预算；数量与金额情景为空' },
    { code: 'REAL_A_AND_MANDATORY_J_NOT_RUN', detail: '没有真实A产物，未机械导出对应清单，必经J未运行；原公司报告和静态演示不能放行本草案' },
    { code: 'FUTURE_CALENDAR_AND_FRESH_OPEN_REQUIRED', detail: '不外推当前封存日历以编造到期日；行动前仍须刷新资料、确认未来交易日及实际下一开盘' },
  ];
  const windows = ([['IS', data.rules.inSample], ['OOS', data.rules.outOfSample]] as const).map(([kind, w]) => {
    const days = expected.filter((d) => d >= w.from && d <= w.to);
    return { kind, ...w, expectedSessions: days.length, alignedSessions: days.filter((d) => subjects.every((s) => data.bars.some((b) => b.subject === s.subject && b.date === d))).length };
  });
  const core = {
    schema: 'lyra-real-strategy-research-v1' as const, identity: 'REAL_PUBLIC_DATA' as const, mode: 'LATEST_REVISED' as const, subject: data.subject, subjectName: data.subjectName, dataHash: data.dataHash, rulesHash: data.rules.rulesHash, materializedAt, knowledgeCutoff: data.knowledgeCutoff, marketDate: data.marketDate, researchWindow: data.researchWindow,
    coverage, evidenceStatus: complete ? 'CONTINUOUS_RETROSPECTIVE_DATA' as const : 'DATA_INCOMPLETE' as const, fit,
    condition: fit === 'DATA_PENDING' ? 'DATA_PENDING' as const : fit === 'PROVISIONAL_TREND_MATCH' ? 'RULE_TRIGGERED_RESEARCH_ONLY' as const : 'NOT_TRIGGERED' as const,
    publication: 'UNREVIEWED_CONDITIONAL_DRAFT' as const, features,
    draft: { draftId: `real-draft:${data.subject}:${data.marketDate}:${data.dataHash.slice(0, 16)}`, entryLowerFen: lower, entryUpperFen: upper, priceInvalidBelowFen: stop, profitAboveFen: profit, expiresOn: null, quantity: null, account: null, riskBudget: null,
      conditions: ['本页只形成真实行情的条件研究草案；股票、市场及行业均线条件分开显示', `沿用R2快/慢${data.rules.fastSessions}/${data.rules.slowSessions}日、入场范围±${data.rules.entryGapBps / 100}%、价格失效${data.rules.stopBps / 100}%及止盈${data.rules.profitBps / 100}%的未经效力验证参数，未按结果调参`, '收盘后判断、下一可交易日开盘处理；历史日终open不能直接用于本轮严格执行回放', '价格/逻辑失效、等待过期、错过与持有期限分别保存；本草案尚未激活事件或模拟', `持有期限假设为${data.rules.maxHoldingSessions}个市场交易日；未来日历未封存，不编造具体到期日`, '跳空、停牌、限价和可卖约束可使触发无法成交，失效阈值不保证成交价或损失上限'],
      alternatives: [{ family: 'DAILY_TREND', selected: fit === 'PROVISIONAL_TREND_MATCH', reason: fit === 'PROVISIONAL_TREND_MATCH' ? '当前冻结行情下机械条件成立，但严格验证和A/J仍阻断执行' : fit }, { family: 'WAIT_NO_NEW_POSITION', selected: fit !== 'PROVISIONAL_TREND_MATCH', reason: '保留等待选择；资料、账户、机制和复核未齐前不产生个人数量或模拟成交' }],
      scenarios: rawCloseFen === null ? [] : [{ name: '参考价不变情景', rawExitFen: rawCloseFen, quantity: null, feesFen: null, netPnlFen: null, assumption: '只列原始价格参照；无数量/费用账户条件，不计算金额' }, { name: '失效阈值情景', rawExitFen: stop!, quantity: null, feesFen: null, netPnlFen: null, assumption: '阈值不是可保证成交价，跳空可更差' }, { name: '止盈阈值情景', rawExitFen: profit!, quantity: null, feesFen: null, netPnlFen: null, assumption: '无概率或期望收益主张；触价不保证成交' }] },
    validation: { status: 'BLOCKED_MISSING_EXECUTION_INPUTS' as const, windows, evaluatedOpportunities: null, metrics: null, efficacyAccepted: false as const },
    review: { a: 'NOT_RUN' as const, checklist: 'NOT_DERIVED_WITHOUT_A' as const, j: 'NOT_RUN' as const, gatePassed: false as const, executionEligible: false as const, modelCalls: 0 as const, newPermits: 0 as const },
    blockers, limitations: ['真实行情与合成离线样本是不同输入身份，本页没有退回synthetic/demo数据', '行情共同截止日是2026-10-23，资料实际封存于2026-10-29；非实时行情，不自动刷新', data.industryBasis, '历史材料按最新修订口径回溯，不是历史当时已知的可执行验证；收益/回撤/换手/概率等指标未计算', '规则、费用、滑点和期限假设在数据分析前冻结；未提供真实账户和真实复核，不生成可执行仓位', '仅个人研究，不发模型请求、不写业务库、不启动监控或通知；P5保持隔离'],
    sources: data.sources.map(({ id, label, sha256 }) => ({ id, label, sha256 })), companyReportSourceId: data.companyReportSourceId,
  };
  return { ...core, viewHash: canonicalSha256(core) };
}

export function assertRealView(view: RealStrategyView, data: RealDailyDataset): void {
  const { viewHash, ...core } = view;
  if (view.schema !== 'lyra-real-strategy-research-v1' || view.identity !== 'REAL_PUBLIC_DATA' || view.mode !== 'LATEST_REVISED' || view.dataHash !== data.dataHash || view.rulesHash !== data.rules.rulesHash || canonicalSha256(core) !== viewHash
    || canonicalSha256(buildRealStrategyView(data, view.materializedAt)) !== canonicalSha256(view)) throw new StrategyError('REAL_RESEARCH_BINDING_INVALID');
}
