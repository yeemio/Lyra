import type { AFinalOutput, JOutput, JEvidenceBundleTable, SrChecklist } from '../transport.js';

/** 独立离线对象；不占用旧 sr focus/step、P5 枚举或生产 permit 账。金额均为整数分。 */
export interface Knowledge {
  factId: string;
  artifactSha256: string;
  source: string;
  adapterVersion: string;
  sourcePublishedAt: string;
  firstObservedAt: string;
  recordedAt: string;
  availableAt: string;
  supersedesFactId: string | null;
}

export interface Session {
  date: string;
  openAt: string;
  closeAt: string;
}

export interface DailyBar extends Knowledge {
  subject: string;
  date: string;
  priceBasis: 'RAW';
  openFen: number;
  highFen: number;
  lowFen: number;
  closeFen: number;
  volumeShares: number;
}

/** 单独的开盘事实：成交函数永不接收该日 high/low/close/volume。 */
export interface OpeningQuote extends Knowledge {
  subject: string;
  date: string;
  openFen: number;
  priceBasis: 'RAW';
}

export interface TradingState extends Knowledge {
  date: string;
  subject: string;
  state: 'TRADING' | 'SUSPENDED';
  ruleVersion: string;
  upperLimitFen: number;
  lowerLimitFen: number;
  tickFen: number;
  buyLotShares: number;
  settlementDays: 1;
  actionIds: string[];
}

export interface AdjustmentFactor extends Knowledge {
  subject: string;
  effectiveOn: string;
  numerator: number;
  denominator: number;
  actionId: string | null;
}

export interface CorporateAction extends Knowledge {
  actionId: string;
  subject: string;
  effectiveOn: string;
  kind: 'SPLIT_OR_CASH' | 'UNSUPPORTED';
  sharesNumerator: number;
  sharesDenominator: number;
  cashFenPerOldShare: number;
}

export interface IndustryMembership extends Knowledge {
  subject: string;
  industry: string;
  validFrom: string;
  validTo: string | null;
}

export interface LogicEvidence extends Knowledge {
  subject: string;
  effectiveOn: string;
  invalidates: boolean;
  reason: string;
}

export interface AccountSnapshot extends Knowledge {
  identity: 'SYNTHETIC_ACCOUNT' | 'USER_CONFIRMED';
  confirmedAt: string;
  asOf: string;
  cashFen: number;
  holdings: {
    lotId: string;
    subject: string;
    quantity: number;
    sellableQuantity: number;
    acquiredOn: string;
    unlocksOn: string;
    costFen: number;
  }[];
  /** 显式给定，不设个人默认比例。压力损失是情景预算，非保证亏损上限。 */
  constraints: { maxPositionValueFen: number; maxLossFen: number; stressGapBps: number };
}

export interface StrategyData {
  schema: 'lyra-daily-data-v1';
  identity: 'SYNTHETIC' | 'SEALED_REAL';
  revisionPolicy: 'POINT_IN_TIME_VERSIONS' | 'LATEST_REVISED';
  subject: string;
  subjectName: string;
  marketBenchmark: string;
  calendar: Knowledge & { completeFrom: string; completeTo: string; completeness: 'DECLARED_COMPLETE'; sessions: Session[] };
  bars: DailyBar[];
  openings: OpeningQuote[];
  states: TradingState[];
  factors: AdjustmentFactor[];
  actions: CorporateAction[];
  industries: IndustryMembership[];
  logic: LogicEvidence[];
  account: AccountSnapshot | null;
}

export interface StrategyRules {
  schema: 'lyra-daily-rules-v1';
  family: 'DAILY_TREND_WITH_WAIT';
  methodVersion: string;
  dataContractVersion: string;
  planAuthVersion: string;
  parameterStatus: 'DEMO_NOT_EFFICACY_VALIDATED' | 'FROZEN_RESEARCH_HYPOTHESIS';
  frozenAt: string;
  selectionReason: string;
  fastSessions: number;
  slowSessions: number;
  signalDelayMinutes: number;
  entryGapBps: number;
  stopBps: number;
  profitBps: number;
  maxHoldingSessions: number;
  pendingEntrySessions: number;
  planLifetimeSessions: number;
  costs: { commissionBps: number; minCommissionFen: number; sellTaxBps: number; transferBps: number; slippageBps: number; dividendTaxBps: number };
  inSample: { from: string; to: string };
  outOfSample: { from: string; to: string };
  minimumSessions: number;
  minimumClosedTrades: number;
  metricContract: 'CLOSE_EQUITY_V1';
  rulesHash: string;
}

export interface Issue { code: string; date: string | null; detail: string }
export type Decision = 'TREND_CANDIDATE' | 'WAIT_NO_TRIGGER' | 'NO_FIT_ENVIRONMENT' | 'DATA_PENDING' | 'LOGIC_INVALID' | 'TECHNICAL_FAILURE';

export interface SignalSnapshot {
  cutoff: string;
  inputHash: string;
  evidenceIds: string[];
  decision: Decision;
  issues: Issue[];
  signalCloseFen: number | null;
  currentFactor: { numerator: number; denominator: number } | null;
  features: { stockFastMicros: string; stockSlowMicros: string; stockCloseMicros: string; marketSlowMicros: string; industrySlowMicros: string; industry: string } | null;
}

export interface RiskSizing {
  status: 'SIZED' | 'MISSING_ACCOUNT' | 'ACCOUNT_NOT_AVAILABLE' | 'RISK_REJECTED';
  quantity: number | null;
  buyPriceFen: number;
  stressExitFen: number | null;
  buyGrossFen: number | null;
  buyFeesFen: number | null;
  stressLossFen: number | null;
  accountHash: string | null;
  formula: string;
  issues: string[];
}

export interface FrozenPlan {
  schema: 'lyra-daily-plan-v1';
  planId: string;
  planHash: string;
  rulesHash: string;
  subject: string;
  subjectName: string;
  cutoff: string;
  signalDate: string;
  expiresOn: string | null;
  inputIdentity: StrategyData['identity'];
  snapshot: SignalSnapshot;
  rules: StrategyRules;
  terms: { entryLowerFen: number; entryUpperFen: number; priceInvalidBelowFen: number; profitAboveFen: number } | null;
  indicativeRisk: RiskSizing | null;
  scenarios: { name: string; assumption: string; entryPriceFen: number; exitPriceFen: number; quantity: number | null; totalFeesFen: number | null; netPnlFen: number | null }[];
  accountHash: string | null;
  companyReport: { path: string; sha256: string; acceptedBoundary: string };
  alternatives: { family: 'DAILY_TREND' | 'WAIT_CASH'; selected: boolean; reason: string }[];
  conditions: string[];
  limitations: string[];
}

export interface Lot {
  lotId: string;
  quantity: number;
  costFen: number;
  acquiredOn: string;
  unlocksOn: string;
  initiallySellable: number;
  initialDate: string;
  dividendsFen: number;
}
export interface Portfolio { cashFen: number; lots: Lot[] }

export interface StrategyEvent {
  eventId: string;
  planId: string;
  planHash: string;
  at: string;
  date: string;
  kind: string;
  reason: string;
  attribution: 'RESEARCH' | 'TIMING' | 'RISK' | 'EXECUTION' | 'DATA' | 'RULE';
  quantity: number | null;
  priceFen: number | null;
  feesFen: number | null;
  netPnlFen: number | null;
  evidenceIds: string[];
}
export interface Opportunity {
  opportunityId: string;
  date: string;
  cutoff: string;
  decision: Decision | 'ALREADY_POSITIONED' | 'PENDING_ENTRY';
  reasonCodes: string[];
  planId: string | null;
}

export interface Metrics {
  initialEquityFen: number;
  finalEquityFen: number;
  netPnlFen: number;
  netReturnBps: number;
  maximumDrawdownBps: number;
  meanExposureBps: number;
  turnoverBps: number;
  feesFen: number;
  closedTrades: number;
  fills: number;
  unfilledAttempts: number;
  valuedSessions: number;
  allOpportunities: number;
  benchmarkReturnBps: number | null;
  waitCashReturnBps: 0;
}
export interface ReplayResult {
  schema: 'lyra-daily-replay-v1';
  identity: 'HISTORICAL_RULE_REPLAY' | 'OFFLINE_FROZEN_PLAN_SIMULATION';
  rulesHash: string;
  dataHash: string;
  planHash: string | null;
  window: { from: string; to: string };
  status: 'COMPUTED_SYNTHETIC' | 'COMPUTED_HISTORICAL' | 'INSUFFICIENT_SAMPLE' | 'DATA_INSUFFICIENT' | 'TECHNICAL_FAILURE' | 'REVIEW_BLOCKED';
  issues: Issue[];
  opportunities: Opportunity[];
  events: StrategyEvent[];
  equity: { date: string; equityFen: number; investedFen: number; staleMark: boolean }[];
  metrics: Metrics | null;
  finalPortfolio: Portfolio | null;
  condition: 'UNTRIGGERED' | 'TRIGGERED' | 'INVALID' | 'EXPIRED' | 'MISSED' | 'FAILED';
  efficacyAccepted: false;
}

export interface ValidationReport {
  schema: 'lyra-daily-validation-v1';
  rulesHash: string;
  dataHash: string;
  selection: 'RULES_FROZEN_BEFORE_REPLAY_NO_TUNING';
  inSample: ReplayResult;
  outOfSample: ReplayResult;
  status: 'SYNTHETIC_BEHAVIOR_ONLY' | 'HISTORICAL_COMPUTED_NOT_ACCEPTED' | 'INCOMPLETE';
  efficacyAccepted: false;
  denominatorDefinitions: Record<string, string>;
  validationHash: string;
}

/** 文件夹具而非模型函数：本路径没有 provider、dispatch、permit 或第二执行器。 */
export interface FrozenReviewArtifact<T> {
  identity: 'STATIC_SIMULATED_FIXTURE';
  role: 'A' | 'J';
  fixtureId: string;
  authoredBy: string;
  planHash: string;
  validationHash: string;
  evidenceBundleHash: string;
  aHash: string | null;
  checklistHash: string | null;
  output: T;
  artifactHash: string;
}
export type FrozenA = FrozenReviewArtifact<AFinalOutput>;
export type FrozenJ = FrozenReviewArtifact<JOutput>;
export interface PlanReview {
  planHash: string;
  validationHash: string;
  aHash: string | null;
  jHash: string | null;
  evidenceBundle: JEvidenceBundleTable[];
  evidenceBundleHash: string;
  checklist: SrChecklist | null;
  a: AFinalOutput | null;
  judge: JOutput | null;
  gate: { passed: boolean; blockers: string[] };
  publication: 'DATA_PENDING' | 'VALIDATION_PENDING' | 'DRAFT' | 'J_BLOCKED' | 'OFFLINE_DEMO_REVIEWED';
  effectiveConclusion: string | null;
  modelExecution: { mode: 'FROZEN_FIXTURES_ONLY'; newCalls: 0; newPermits: 0; realReviewDone: false };
  reviewHash: string;
}
