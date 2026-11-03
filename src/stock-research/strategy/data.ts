import { canonicalSha256 } from '../../canonical.js';
import type { DailyBar, Knowledge, SignalSnapshot, StrategyData, StrategyRules, Issue } from './contracts.js';
import { integer, ratio, StrategyError } from './money.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(value: string): boolean { return DATE.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value); }
export function known<T extends Knowledge>(rows: readonly T[], at: string): T[] {
  const visible = rows.filter((r) => r.availableAt <= at);
  const shadowed = new Set(visible.map((r) => r.supersedesFactId).filter((x): x is string => x !== null));
  return visible.filter((r) => !shadowed.has(r.factId));
}

export function one<T>(rows: T[], code: string, detail: string): T {
  if (rows.length !== 1) throw new StrategyError(code, detail);
  return rows[0]!;
}

export function closeCutoff(session: { closeAt: string }, rules: StrategyRules): string {
  return new Date(new Date(session.closeAt).getTime() + rules.signalDelayMinutes * 60_000).toISOString();
}

export function assertData(data: StrategyData): void {
  if (data.schema !== 'lyra-daily-data-v1' || !['SYNTHETIC', 'SEALED_REAL'].includes(data.identity)) throw new StrategyError('DATA_SCHEMA_INVALID');
  if (data.revisionPolicy !== 'POINT_IN_TIME_VERSIONS') throw new StrategyError('LATEST_REVISED_NOT_PIT');
  if (!/^(600|601|603|605|000|001|002|003)\d{3}$/.test(data.subject)) throw new StrategyError('SUBJECT_OUT_OF_SCOPE');
  const cal = data.calendar;
  if (!cal || cal.completeness !== 'DECLARED_COMPLETE' || cal.sessions.length === 0) throw new StrategyError('CALENDAR_MISSING');
  const days = new Set<string>();
  let last = '';
  for (const s of cal.sessions) {
    if (!date(s.date) || s.date <= last || s.openAt >= s.closeAt || s.openAt.slice(0, 10) !== s.date || s.closeAt.slice(0, 10) !== s.date) throw new StrategyError('CALENDAR_INVALID', s.date);
    days.add(s.date); last = s.date;
  }
  if (cal.completeFrom > cal.sessions[0]!.date || cal.completeTo < last) throw new StrategyError('CALENDAR_COVERAGE_INVALID');
  const records: Knowledge[] = [cal, ...data.bars, ...data.openings, ...data.states, ...data.factors, ...data.actions, ...data.industries, ...data.logic, ...(data.account ? [data.account] : [])];
  const ids = new Map<string, Knowledge>();
  for (const r of records) {
    if (ids.has(r.factId) || !r.factId || !/^[a-f0-9]{64}$/.test(r.artifactSha256) || !r.source || !r.adapterVersion) throw new StrategyError('FACT_IDENTITY_INVALID', r.factId);
    for (const t of [r.sourcePublishedAt, r.firstObservedAt, r.recordedAt, r.availableAt]) {
      if (typeof t !== 'string' || !Number.isFinite(Date.parse(t)) || new Date(t).toISOString() !== t) throw new StrategyError('FACT_TIME_INVALID', r.factId);
    }
    // 本模块输入均为取得态行情/规则/账户；没有公告类历史近似的隐式豁免。
    if (r.availableAt < r.firstObservedAt || r.availableAt < r.sourcePublishedAt || r.recordedAt > r.availableAt || r.firstObservedAt > r.recordedAt) throw new StrategyError('AVAILABILITY_BEFORE_ACQUISITION', r.factId);
    ids.set(r.factId, r);
  }
  for (const r of records) if (r.supersedesFactId !== null) {
    const old = ids.get(r.supersedesFactId);
    if (!old || old.availableAt >= r.availableAt) throw new StrategyError('REVISION_CHAIN_INVALID', r.factId);
  }
  for (const stream of [data.bars, data.openings, data.states, data.factors, data.actions, data.industries, data.logic]) {
    const key = (r: Knowledge): string => { const x = r as unknown as Record<string, unknown>; return canonicalSha256(['subject', 'date', 'effectiveOn', 'validFrom', 'actionId'].map((k) => x[k] ?? null)); };
    for (const r of stream) if (r.supersedesFactId !== null) {
      const old = stream.find((x) => x.factId === r.supersedesFactId);
      if (!old || key(old) !== key(r)) throw new StrategyError('REVISION_CROSSES_LOGICAL_KEY', r.factId);
    }
  }
  for (const b of [...data.bars, ...data.openings]) {
    if (b.priceBasis !== 'RAW' || !days.has(b.date)) throw new StrategyError('RAW_PRICE_OR_CALENDAR_INVALID', b.factId);
    integer(b.openFen, 'openFen', 1);
    const session = cal.sessions.find((s) => s.date === b.date)!;
    if (b.availableAt < session.openAt) throw new StrategyError('OPEN_NOT_YET_OCCURRED', b.factId);
  }
  for (const b of data.bars) {
    for (const x of [b.closeFen, b.highFen, b.lowFen]) integer(x, 'OHLC', 1);
    integer(b.volumeShares, 'volumeShares');
    if (b.lowFen > Math.min(b.openFen, b.closeFen) || b.highFen < Math.max(b.openFen, b.closeFen) || b.availableAt < cal.sessions.find((s) => s.date === b.date)!.closeAt) throw new StrategyError('DAILY_BAR_INVALID', b.factId);
    const states = b.subject === data.subject ? known(data.states.filter((s) => s.date === b.date), b.availableAt) : [];
    if (states.length === 1 && states[0]!.state === 'TRADING' && (b.highFen > states[0]!.upperLimitFen || b.lowFen < states[0]!.lowerLimitFen)) throw new StrategyError('RAW_BAR_OUTSIDE_DECLARED_LIMITS', b.factId);
  }
  for (const s of data.states) {
    if (!days.has(s.date) || s.subject !== data.subject || !['TRADING', 'SUSPENDED'].includes(s.state) || s.settlementDays !== 1 || !s.ruleVersion || !Array.isArray(s.actionIds)) throw new StrategyError('TRADING_STATE_INVALID', s.factId);
    for (const x of [s.lowerLimitFen, s.upperLimitFen, s.tickFen, s.buyLotShares]) integer(x, 'market rule', 1);
    if (s.upperLimitFen <= s.lowerLimitFen) throw new StrategyError('PRICE_LIMIT_INVALID', s.factId);
  }
  for (const f of data.factors) { integer(f.numerator, 'factor numerator', 1); integer(f.denominator, 'factor denominator', 1); if (!date(f.effectiveOn)) throw new StrategyError('FACTOR_DATE_INVALID'); }
  for (const a of data.actions) {
    integer(a.sharesNumerator, 'action numerator', 1); integer(a.sharesDenominator, 'action denominator', 1); integer(a.cashFenPerOldShare, 'cash dividend');
    if (!days.has(a.effectiveOn)) throw new StrategyError('ACTION_CALENDAR_INVALID');
  }
  if (data.account) {
    const a = data.account;
    if (!['USER_CONFIRMED', 'SYNTHETIC_ACCOUNT'].includes(a.identity) || a.confirmedAt > a.availableAt || a.asOf > a.availableAt || (data.identity === 'SEALED_REAL' && a.identity !== 'USER_CONFIRMED')) throw new StrategyError('ACCOUNT_CONFIRMATION_INVALID');
    integer(a.cashFen, 'account cash');
    for (const n of [a.constraints.maxLossFen, a.constraints.maxPositionValueFen]) integer(n, 'risk budget', 1);
    integer(a.constraints.stressGapBps, 'stressGapBps');
    if (a.constraints.stressGapBps >= 10_000) throw new StrategyError('RISK_BUDGET_INVALID');
    for (const lot of a.holdings) {
      integer(lot.quantity, 'quantity', 1); integer(lot.sellableQuantity, 'sellableQuantity'); integer(lot.costFen, 'costFen');
      if (lot.sellableQuantity > lot.quantity || lot.subject !== data.subject || !date(lot.acquiredOn) || !date(lot.unlocksOn)) throw new StrategyError('HOLDING_INVALID');
    }
  }
}

export function factorAt(data: StrategyData, subject: string, day: string, at: string): StrategyData['factors'][number] {
  const visible = known(data.factors.filter((f) => f.subject === subject && f.effectiveOn <= day), at);
  const latestDay = visible.map((f) => f.effectiveOn).sort().at(-1);
  return one(visible.filter((f) => f.effectiveOn === latestDay), 'FACTOR_MISSING_OR_CONFLICT', `${subject}@${day}`);
}

function adjustedMicros(data: StrategyData, bar: DailyBar, at: string): bigint {
  const f = factorAt(data, bar.subject, bar.date, at);
  return BigInt(ratio(BigInt(bar.closeFen) * BigInt(f.numerator), 1_000_000, f.denominator));
}
function mean(values: bigint[]): bigint { const total = values.reduce((a, b) => a + b, 0n); return BigInt(ratio(total, 1, values.length)); }

/** 快照身份仅含截点内可得事实。追加未来行情/因子不会改写旧 planHash。 */
export function snapshotInput(data: StrategyData, at: string): unknown {
  return {
    subject: data.subject, identity: data.identity, revisionPolicy: data.revisionPolicy,
    calendar: data.calendar.availableAt <= at ? data.calendar : null,
    bars: known(data.bars, at), openings: known(data.openings, at), states: known(data.states, at),
    factors: known(data.factors, at), actions: known(data.actions, at), industries: known(data.industries, at), logic: known(data.logic, at),
    account: data.account && data.account.availableAt <= at ? data.account : null,
  };
}

export function signalAt(data: StrategyData, rules: StrategyRules, day: string): SignalSnapshot {
  const session = one(data.calendar.sessions.filter((s) => s.date === day), 'CALENDAR_DATE_MISSING', day);
  const cutoff = closeCutoff(session, rules);
  const base: SignalSnapshot = { cutoff, inputHash: canonicalSha256(snapshotInput(data, cutoff)), evidenceIds: [], decision: 'DATA_PENDING', issues: [], signalCloseFen: null, currentFactor: null, features: null };
  try {
    if (data.calendar.availableAt > cutoff) throw new StrategyError('CALENDAR_NOT_AVAILABLE');
    if (data.revisionPolicy !== 'POINT_IN_TIME_VERSIONS') throw new StrategyError('LATEST_REVISED_NOT_PIT');
    const dayState = one(known(data.states.filter((s) => s.date === day), cutoff), 'STATE_MISSING_OR_CONFLICT', day);
    base.evidenceIds.push(dayState.factId);
    if (dayState.state === 'SUSPENDED') { base.decision = 'WAIT_NO_TRIGGER'; base.issues.push({ code: 'EXPLICIT_SUSPENSION', date: day, detail: dayState.factId }); return base; }
    const membership = one(known(data.industries.filter((m) => m.subject === data.subject && m.validFrom <= day && (m.validTo === null || day < m.validTo)), cutoff), 'INDUSTRY_MEMBERSHIP_MISSING_OR_CONFLICT', day);
    base.evidenceIds.push(membership.factId);
    const priorSessions = data.calendar.sessions.filter((s) => s.date <= day);
    const series = (subject: string): bigint[] => {
      const values: bigint[] = [];
      // 交易日逐日核验；只有有证据的个股停牌可以跳过，缺行绝不补零/前向填充。
      for (let i = priorSessions.length - 1; i >= 0 && values.length < rules.slowSessions; i--) {
        const d = priorSessions[i]!.date;
        if (subject === data.subject) {
          const s = one(known(data.states.filter((x) => x.date === d), cutoff), 'STATE_MISSING_OR_CONFLICT', d);
          if (s.state === 'SUSPENDED') { base.evidenceIds.push(s.factId); continue; }
        }
        const b = one(known(data.bars.filter((x) => x.subject === subject && x.date === d), cutoff), subject === data.subject ? 'BAR_MISSING_OR_NOT_AVAILABLE' : 'BENCHMARK_UNALIGNED_OR_NOT_AVAILABLE', `${subject}@${d}`);
        base.evidenceIds.push(b.factId, factorAt(data, subject, d, cutoff).factId);
        values.unshift(adjustedMicros(data, b, cutoff));
      }
      if (values.length < rules.slowSessions) throw new StrategyError('WARMUP_INSUFFICIENT', subject);
      return values;
    };
    const stock = series(data.subject), market = series(data.marketBenchmark), industry = series(membership.industry);
    const current = one(known(data.bars.filter((b) => b.subject === data.subject && b.date === day), cutoff), 'BAR_MISSING_OR_NOT_AVAILABLE', day);
    const factor = factorAt(data, data.subject, day, cutoff);
    const sf = mean(stock.slice(-rules.fastSessions)), ss = mean(stock), ms = mean(market), ins = mean(industry);
    base.signalCloseFen = current.closeFen;
    base.currentFactor = { numerator: factor.numerator, denominator: factor.denominator };
    base.features = { stockFastMicros: sf.toString(), stockSlowMicros: ss.toString(), stockCloseMicros: stock.at(-1)!.toString(), marketSlowMicros: ms.toString(), industrySlowMicros: ins.toString(), industry: membership.industry };
    const invalid = known(data.logic.filter((l) => l.subject === data.subject && l.effectiveOn <= day), cutoff).filter((l) => l.invalidates);
    if (invalid.length) { base.decision = 'LOGIC_INVALID'; base.evidenceIds.push(...invalid.map((l) => l.factId)); base.issues.push({ code: 'LOGIC_INVALIDATED', date: day, detail: invalid.map((l) => l.reason).join('; ') }); }
    else if (market.at(-1)! <= ms || industry.at(-1)! <= ins) { base.decision = 'NO_FIT_ENVIRONMENT'; base.issues.push({ code: 'MARKET_OR_INDUSTRY_TREND_NOT_SUPPORTED', date: day, detail: '基准及当时归属行业收盘均须高于各自慢均线' }); }
    else if (sf > ss && stock.at(-1)! > sf) base.decision = 'TREND_CANDIDATE';
    else { base.decision = 'WAIT_NO_TRIGGER'; base.issues.push({ code: 'STOCK_TREND_NOT_TRIGGERED', date: day, detail: '快均线>慢均线且收盘>快均线尚未同时成立' }); }
    base.evidenceIds = [...new Set(base.evidenceIds)].sort();
    return base;
  } catch (e) {
    base.issues.push({ code: e instanceof StrategyError ? e.code : 'SIGNAL_COMPUTE_FAILED', date: day, detail: e instanceof Error ? e.message : String(e) });
    base.decision = e instanceof StrategyError ? 'DATA_PENDING' : 'TECHNICAL_FAILURE';
    return base;
  }
}

export function issueOf(e: unknown): Issue { return { code: e instanceof StrategyError ? e.code : 'COMPUTE_FAILED', date: null, detail: e instanceof Error ? e.message : String(e) }; }
