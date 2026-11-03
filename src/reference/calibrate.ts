/**
 * Lyra · 历史参照库 · 价格失效阈值校准引擎（P4 / W18: code-writer-pro）。
 * 合同：docs/specs/HISTORICAL-REFERENCE.md §9〔R3〕（校准程序）、§4（衡量口径：两侧分列）；
 * docs/specs/SETTLEMENT-REVIEW.md SR-6.1（触发定义：跑赢侧 e_d ≤ −θ / 跑输侧 e_d ≥ +θ）、
 * SR-6.2（只记录不改结算）、SR-6.3（校准只推荐不生效，P5 冻结；评价窗口内不改阈值）。
 *
 * 输入：逐事件 20 日累计超额序列（W15 `eventWindowReturns` 的 cumulativeExcess，本模块只读
 * 复用、不重算算式）。W15 群组统计只落了 10% 预留值下的两侧布尔，逐事件完整序列未持久化
 * ——校准需对全量事件重算序列后多阈值扫描（CLI 侧负责重算并组装样本，本模块纯函数）。
 *
 * 样本三分类（剔除规则显式、计数如实，不静默）：
 * - USABLE：序列完整 20 点（20 个有成交交易日全部超额可得）——唯一进触发率分母的类；
 * - WINDOW_INCOMPLETE：序列可用但 < 20 点（事件后窗口未走完，前缀判定虽是事实，
 *   "20 日内是否触发"不可完整回答；计入会低估未触发率，整体剔除并单列计数）；
 * - DATA_GAP：参考价不可得（无事件后交易日/开盘价不可解析）或超额序列中断
 *   （指数/收盘缺行、行业不可得；W15 invalidation 两侧 null 的同一人群）。
 *
 * 触发口径（SR-6.1/SR-3.4，精确十进制定点比较，禁浮点阈值比较）：
 * - 下行（跑赢侧不利）：e_d ≤ −θ；上行（跑输侧不利）：e_d ≥ +θ；首个触发日 = 序列内首个
 *   命中日（1 基序，起算日 = 第 1 个有成交交易日）；
 * - 三个口径：any（任一侧触发，边际）/ down / up（边际：对侧是否也触发不计）；
 *   另给仅下行/仅上行（单侧且对侧未触发）与两侧都触发计数（口径写明，不合并歪读）。
 *
 * 推荐规则（数据驱动、规则先声明，HISTORICAL-REFERENCE §9.3"建议值 + 失真风险评估"）：
 * 在扫描档 θ ∈ 预留扫描集上取同时满足（A）统计口径整体 any 触发率 ≤ TAIL_BAND_ANY、
 * （B）六类每一类 any 触发率 ≤ TYPE_CAP_ANY、（C）整体首个任一侧触发中位日 ≤ EARLY_DAY_CAP
 * 的**最小** θ（最小 = 对真实失效最灵敏，过早失效信号丢失最少）；A/B 全不满足时取最大档并
 * 如实声明带外。校准只推荐不生效（SR-6.3），P5 冻结才换值。
 *
 * 宽基（SR-8A.4 预留 5%）：宽基事件库/状态参照库（HISTORICAL-REFERENCE §2 R18）未建、
 * 细则未定 → 无校准样本定义，如实标 NOT_CALIBRATABLE、维持预留，不编造。
 *
 * 单测（calibrate.test.ts）不碰网络不碰 DB：合成序列注入。
 */
import {
  fCmp,
  fDiv,
  parseFixed,
  type EventWindowReturns,
  type Fixed,
} from './excess.js';
import { REVISION_NOTICE } from './groups.js';

// ===== 常量（规则先声明；数值锚定见文末推荐理由组装）=====

/** 阈值扫描档（百分比数值字符串；'10' = 预留值 HISTORICAL-REFERENCE §9）。 */
export const CALIBRATION_THRESHOLDS_PCT: readonly string[] = ['5', '8', '10', '12', '15'];

/** 预留值（个股口径，SR-6.1）。 */
export const STOCK_RESERVED_PCT = '10' as const;

/** 宽基预留值（SR-8A.4）。 */
export const BROAD_BASE_RESERVED_PCT = '5' as const;

/** 规则 A：统计口径整体任一侧触发率上限（百分数）——超过则失效信号趋近常态（尾部标记失能）。 */
export const TAIL_BAND_ANY_PCT = 40;

/** 规则 B：六类逐类任一侧触发率上限（百分数）——任何一类失效成常态即带外。 */
export const TYPE_CAP_ANY_PCT = 50;

/** 规则 C：整体首个任一侧触发中位日上限（1 基交易日序，窗口 20 日）——保证早期信号。 */
export const EARLY_DAY_CAP = 15;

/** R25：回购普通进展子类非统计实例（存储超集、统计过滤）。 */
export const PROGRESS_EVENT_KEY = 'BUYBACK:PROGRESS_OR_CHANGE';

// ===== 样本 =====

export type SampleClass = 'USABLE' | 'WINDOW_INCOMPLETE' | 'DATA_GAP';

export interface CalibrationSample {
  subject: string;
  eventTime: string;
  /** 子类细分键（事件库 type:subtype 原样）。 */
  eventKey: string;
  /** 六类轴（eventKey 冒号前）。 */
  eventType: string;
  cls: SampleClass;
  /** 逐日累计超额（SR-3.4；DATA_GAP 样本仍携带可用前缀供审计，不进任何分母）。 */
  series: { date: string; e: string }[];
  /** W15 内嵌预留 10% 判定（交叉核对锚点；null = 不可判）。 */
  reserved10: { down: boolean | null; up: boolean | null };
  dataGaps: string[];
}

/**
 * 样本分类（剔除规则的程序形态）：
 * referenceDate 不可得 → DATA_GAP；invalidation 两侧 null（序列中断/行业或指数不可得）→ DATA_GAP；
 * 序列 < 20 点 → WINDOW_INCOMPLETE（前缀有效但 20 日问题不可完整回答）；否则 USABLE。
 */
export function classifyWindow(win: EventWindowReturns): SampleClass {
  if (win.referenceDate === null) return 'DATA_GAP';
  if (win.invalidation.downTriggered === null || win.invalidation.upTriggered === null) return 'DATA_GAP';
  if (win.cumulativeExcess.length < 20) return 'WINDOW_INCOMPLETE';
  return 'USABLE';
}

/** 由 W15 窗口结果组装校准样本（纯投影，不重算算式）。 */
export function sampleOf(
  subject: string,
  eventTime: string,
  eventKey: string,
  win: EventWindowReturns,
): CalibrationSample {
  return {
    subject,
    eventTime,
    eventKey,
    eventType: eventKey.split(':')[0] ?? eventKey,
    cls: classifyWindow(win),
    series: win.cumulativeExcess.map((p) => ({ date: p.date, e: p.e })),
    reserved10: { down: win.invalidation.downTriggered, up: win.invalidation.upTriggered },
    dataGaps: [...win.dataGaps],
  };
}

// ===== 阈值与扫描（SR-2.2 定点纪律）=====

/** 百分数字符串 → θ 定点小数（'5' → 0.05）；不可解析返回 null（调用方按输入错误处置）。 */
export function thetaOf(pct: string): Fixed | null {
  const p = parseFixed(pct);
  if (p === null) return null;
  return fDiv(p, { int: 100n, scale: 0 }, 10);
}

function negate(f: Fixed): Fixed {
  return { int: -f.int, scale: f.scale };
}

export type TriggerSide = 'down' | 'up';

export interface TriggerPoint {
  /** 首个触发日（1 基交易日序，起算日 = 1；≤ 20）。 */
  dayIndex: number;
  date: string;
}

/**
 * 首个触发日扫描：下行 = e_d ≤ −θ（跑赢侧不利），上行 = e_d ≥ +θ（跑输侧不利）；
 * 恰等于阈值触发（SR-6.1"达到"）。序列条目 e 非法定点 → 视该日不可判（跳过；
 * 正常序列不会出现——eventWindowReturns 只输出可解析值，防御分支不猜）。
 */
export function firstTrigger(
  series: readonly { date: string; e: string }[],
  theta: Fixed,
  side: TriggerSide,
): TriggerPoint | null {
  const bound = side === 'down' ? negate(theta) : theta;
  for (const [i, point] of series.entries()) {
    const e = parseFixed(point.e);
    if (e === null) continue;
    const hit = side === 'down' ? fCmp(e, bound) <= 0 : fCmp(e, bound) >= 0;
    if (hit) return { dayIndex: i + 1, date: point.date };
  }
  return null;
}

// ===== 聚合（描述性统计，非预测概率；HISTORICAL-REFERENCE §4）=====

/** 百分率（分子/分母 → 两位小数百分数字符串；分母 0 → null，不虚构 0%）。 */
export function pctRate(hit: number, n: number): string | null {
  if (n <= 0) return null;
  const r = fDiv({ int: BigInt(hit) * 100n, scale: 0 }, { int: BigInt(n), scale: 0 }, 2);
  return r === null ? null : rateToString(r);
}

/** fDiv(scale=2) → '12.34' 形态（去尾零由 fixedToString 承担）。 */
function rateToString(f: Fixed): string {
  const neg = f.int < 0n;
  const digits = (neg ? -f.int : f.int).toString().padStart(3, '0');
  const body = `${digits.slice(0, digits.length - 2)}.${digits.slice(-2)}`;
  return neg ? `-${body}` : body;
}

export interface TriggerStatCell {
  thresholdPct: string;
  /** 分母 = USABLE 样本数（DATA_GAP / WINDOW_INCOMPLETE 均剔除，计数见 sampleScope）。 */
  n: number;
  downTriggered: number;
  upTriggered: number;
  anyTriggered: number;
  bothSides: number;
  downOnly: number;
  upOnly: number;
  /** 两位小数百分数（定点）；n = 0 时为 null。 */
  downRatePct: string | null;
  upRatePct: string | null;
  anyRatePct: string | null;
  /** 20 日内未触发比例（= 100 − anyRate，独立定点计算）。 */
  noTriggerRatePct: string | null;
  /** 首个触发日中位数（1..20；偶数个样本取中间两数均值，可含 .5；无触发样本为 null）。 */
  medianFirstDownDay: number | null;
  medianFirstUpDay: number | null;
  medianFirstAnyDay: number | null;
  /** 首个任一侧触发日分布（长度 20，下标 i = 第 i+1 日；未触发不计入）。 */
  firstAnyDayHistogram: number[];
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 单阈值聚合（仅 USABLE 样本进分母）。 */
export function aggregateTriggerStats(samples: readonly CalibrationSample[], pct: string): TriggerStatCell {
  const theta = thetaOf(pct);
  if (theta === null) throw new Error(`CALIBRATION_THRESHOLD_UNPARSEABLE:${pct}`);
  const usable = samples.filter((s) => s.cls === 'USABLE');
  const firstDown: number[] = [];
  const firstUp: number[] = [];
  const firstAny: number[] = [];
  const histogram = new Array<number>(20).fill(0);
  let down = 0;
  let up = 0;
  let any = 0;
  let both = 0;
  for (const s of usable) {
    const d = firstTrigger(s.series, theta, 'down');
    const u = firstTrigger(s.series, theta, 'up');
    if (d !== null) down += 1;
    if (u !== null) up += 1;
    if (d !== null || u !== null) any += 1;
    if (d !== null && u !== null) both += 1;
    if (d !== null) firstDown.push(d.dayIndex);
    if (u !== null) firstUp.push(u.dayIndex);
    if (d !== null || u !== null) {
      const day = Math.min(d?.dayIndex ?? 99, u?.dayIndex ?? 99);
      firstAny.push(day);
      histogram[day - 1] = (histogram[day - 1] ?? 0) + 1;
    }
  }
  const n = usable.length;
  return {
    thresholdPct: pct,
    n,
    downTriggered: down,
    upTriggered: up,
    anyTriggered: any,
    bothSides: both,
    downOnly: down - both,
    upOnly: up - both,
    downRatePct: pctRate(down, n),
    upRatePct: pctRate(up, n),
    anyRatePct: pctRate(any, n),
    noTriggerRatePct: pctRate(n - any, n),
    medianFirstDownDay: medianOf(firstDown),
    medianFirstUpDay: medianOf(firstUp),
    medianFirstAnyDay: medianOf(firstAny),
    firstAnyDayHistogram: histogram,
  };
}

/** 百分数定点字符串 → 数值（仅规则比较用；两位小数档内无精度损失）。 */
function pctValue(s: string | null): number | null {
  if (s === null) return null;
  const f = parseFixed(s);
  return f === null ? null : Number(f.int) / 10 ** f.scale;
}

// ===== 推荐（规则先声明；只推荐不生效，SR-6.3）=====

export interface RecommendationInput {
  /** 统计口径整体（R25：剔进展子类）逐阈值单元。 */
  overall: { pct: string; cell: TriggerStatCell }[];
  /** 六类逐类逐阈值单元（与 overall 同阈值集）。 */
  byType: { pct: string; type: string; cell: TriggerStatCell }[];
}

export interface RecommendationBlock {
  stock: {
    reservedPct: typeof STOCK_RESERVED_PCT;
    recommendedPct: string;
    /** 规则文本（先声明后取数）。 */
    rule: string;
    /** 由实测数字组装的理由（引用本报告矩阵数值）。 */
    rationale: string;
    /** 规则 A/B/C 逐档命中明细（含逐档最差类型点名）。 */
    ruleCheck: { pct: string; overallAnyPct: string | null; worstType: string | null; maxTypeAnyPct: string | null; medianFirstAnyDay: number | null; passA: boolean; passB: boolean; passC: boolean }[];
    calibrationOnly: true;
    effectiveAt: 'P5 冻结';
  };
  broadBase: {
    reservedPct: typeof BROAD_BASE_RESERVED_PCT;
    status: 'NOT_CALIBRATABLE';
    conclusion: string;
  };
}

/**
 * 推荐规则（声明见模块头）：满足 A（整体 any ≤ 40%）且 B（逐类 any ≤ 50%）的最小 θ；
 * 同档多候选时再看 C（中位首触发日 ≤ 15）。A/B 全不满足 → 取最大档并声明带外。
 */
export function recommendThreshold(input: RecommendationInput): RecommendationBlock {
  const ruleText =
    `规则（先声明后取数）：在扫描档 {${input.overall.map((o) => o.pct).join('%,')}%} 上，`
    + `取同时满足 A（统计口径整体任一侧触发率 ≤ ${TAIL_BAND_ANY_PCT}%，失效保持尾部标记而非常态）`
    + `与 B（六类逐类任一侧触发率 ≤ ${TYPE_CAP_ANY_PCT}%）的最小 θ（对真实失效最灵敏、过早失效信号丢失最少）；`
    + `同档以 C（首个任一侧触发中位日 ≤ ${EARLY_DAY_CAP}）复核早期信号；A/B 全不满足时取最大档并声明带外。`;
  const check = input.overall.map((o) => {
    const typeCells = input.byType.filter((t) => t.pct === o.pct && t.cell.n > 0);
    let worstType: string | null = null;
    let maxTypeAny: number | null = null;
    for (const t of typeCells) {
      const v = pctValue(t.cell.anyRatePct);
      if (v === null) continue;
      if (maxTypeAny === null || v > maxTypeAny) {
        maxTypeAny = v;
        worstType = t.type;
      }
    }
    const overallAny = pctValue(o.cell.anyRatePct);
    return {
      pct: o.pct,
      overallAnyPct: o.cell.anyRatePct,
      worstType,
      maxTypeAnyPct: typeCells.length === 0 ? null : maxTypeAny === null ? null : rateToString({ int: BigInt(Math.round(maxTypeAny * 100)), scale: 2 }),
      medianFirstAnyDay: o.cell.medianFirstAnyDay,
      passA: overallAny !== null && overallAny <= TAIL_BAND_ANY_PCT,
      passB: typeCells.length === 0 || (maxTypeAny !== null && maxTypeAny <= TYPE_CAP_ANY_PCT),
      passC: o.cell.medianFirstAnyDay !== null && o.cell.medianFirstAnyDay <= EARLY_DAY_CAP,
    };
  });
  const abPass = check.filter((c) => c.passA && c.passB);
  const chosen = abPass.length > 0 ? abPass[0]! : check[check.length - 1]!;
  const bandFail = abPass.length === 0;
  const reservedCell = input.overall.find((o) => o.pct === STOCK_RESERVED_PCT)?.cell ?? null;
  const reservedCheck = check.find((c) => c.pct === STOCK_RESERVED_PCT) ?? null;
  const rationale =
    (bandFail
      ? `扫描档内无一同时满足规则 A/B（整体 any ≤ ${TAIL_BAND_ANY_PCT}%、逐类 ≤ ${TYPE_CAP_ANY_PCT}%）：按规则取最大档 ${chosen.pct}% 并如实声明带外。`
      : `θ = ${chosen.pct}% 为满足规则 A/B 的最小档：统计口径整体任一侧触发率 ${chosen.overallAnyPct}%（≤ ${TAIL_BAND_ANY_PCT}%），`
        + `六类最差 ${chosen.worstType} ${chosen.maxTypeAnyPct ?? 'n/a'}%（≤ ${TYPE_CAP_ANY_PCT}%）；`)
    + (chosen.passC
      ? `首个任一侧触发中位日第 ${chosen.medianFirstAnyDay} 个交易日（≤ ${EARLY_DAY_CAP}），早期信号保留。`
      : `首个任一侧触发中位日第 ${chosen.medianFirstAnyDay} 个交易日 > ${EARLY_DAY_CAP}，规则 C 未过（已如实标注，早期信号偏晚）。`)
    + (reservedCheck !== null && reservedCell !== null && reservedCell.anyRatePct !== null
      ? `对照预留值 10%：整体任一侧 ${reservedCell.anyRatePct}%（下行 ${reservedCell.downRatePct}% / 上行 ${reservedCell.upRatePct}%，两侧分列）；`
        + (reservedCheck.passA && reservedCheck.passB
          ? chosen.pct === STOCK_RESERVED_PCT
            ? '10% 即满足 A/B 的最小档——维持预留值。'
            : `10% 亦满足 A/B，但更小档 ${chosen.pct}% 同样满足且对真实失效更灵敏，按最小档规则取 ${chosen.pct}%。`
          : `10% 未过 ${!reservedCheck.passA ? `A（${reservedCell.anyRatePct}% > ${TAIL_BAND_ANY_PCT}%）` : ''}${!reservedCheck.passA && !reservedCheck.passB ? '且' : ''}${!reservedCheck.passB ? `B（${reservedCheck.worstType} ${reservedCheck.maxTypeAnyPct}% > ${TYPE_CAP_ANY_PCT}%，该类失效趋近常态）` : ''}`)
        + (reservedCheck.passA && !reservedCheck.passB && reservedCell.anyRatePct !== null
          ? `——A 侧已压线（${reservedCell.anyRatePct}% vs 上限 ${TAIL_BAND_ANY_PCT}%）`
          : '')
        + '。'
      : '')
    + `低档拒绝依据：更小档触发趋近常态（5%/8% 整体任一侧 ${check.find((c) => c.pct === '5')?.overallAnyPct ?? 'n/a'}%/${check.find((c) => c.pct === '8')?.overallAnyPct ?? 'n/a'}%），尾部标记失能、参照库基础比例信息量下降；θ 越大早期失效信号丢失越多（15% 整体 ${check.find((c) => c.pct === '15')?.overallAnyPct ?? 'n/a'}%）。`
    + `本推荐为机械取档（规则先声明后取数），非唯一合理解，P5 冻结时由总控/Owner 终裁；校准只推荐不生效（SR-6.3），评价窗口内不改任何阈值。`;
  return {
    stock: {
      reservedPct: STOCK_RESERVED_PCT,
      recommendedPct: chosen.pct,
      rule: ruleText,
      rationale,
      ruleCheck: check,
      calibrationOnly: true,
      effectiveAt: 'P5 冻结',
    },
    broadBase: {
      reservedPct: BROAD_BASE_RESERVED_PCT,
      status: 'NOT_CALIBRATABLE',
      conclusion:
        '宽基不可校准：宽基状态参照库（HISTORICAL-REFERENCE §2〔R18〕，跟踪指数自身历史、按状态机械选定）未建、'
        + '其样本细则未在 P4 合同补入，本报告无宽基事件样本可依——如实维持预留值 5%（SR-8A.4），不编造校准结论；'
        + '宽基校准随 R18 库构建另行执行（P5 冻结前）。',
    },
  };
}

// ===== 与 W15 群组库的交叉核对（真实数据一致性锚点）=====

export interface CrossCheckBlock {
  definition: string;
  libraryN: number;
  libraryDown: number;
  libraryUp: number;
  recomputedN: number;
  recomputedDown: number;
  recomputedUp: number;
  match: boolean;
}

/**
 * 预留 10% 交叉核对：W15 baseRateOf 的 invalidation.n 计"两侧均非 null"人群（含窗口未走完
 * 的前缀判定）；本引擎对同一人群（reserved10 两侧非 null）以 θ=10 重扫两侧触发，计数应逐值
 * 相等（同一 eventWindowReturns 同一序列，扫描算式与内嵌判定同构）。
 */
export function crossCheckReserved10(
  samples: readonly CalibrationSample[],
  lib: { n: number; downTriggered: number; upTriggered: number },
): CrossCheckBlock {
  const theta = thetaOf(STOCK_RESERVED_PCT)!;
  let n = 0;
  let down = 0;
  let up = 0;
  for (const s of samples) {
    if (s.eventKey === PROGRESS_EVENT_KEY) continue; // R25.1：交叉核对人群与群组库同口径（剔除回购进展）
    if (s.reserved10.down === null || s.reserved10.up === null) continue;
    n += 1;
    if (firstTrigger(s.series, theta, 'down') !== null) down += 1;
    if (firstTrigger(s.series, theta, 'up') !== null) up += 1;
  }
  return {
    definition:
      '人群 = W15 invalidation 两侧非 null（含窗口未走完前缀判定，与 baseRateOf 同口径）且剔除 BUYBACK:PROGRESS_OR_CHANGE（R25.1，与群组库消费同口径）；'
      + 'θ=10 两侧触发计数逐值比对（引擎重扫 vs 群组库落库值）。',
    libraryN: lib.n,
    libraryDown: lib.downTriggered,
    libraryUp: lib.upTriggered,
    recomputedN: n,
    recomputedDown: down,
    recomputedUp: up,
    match: n === lib.n && down === lib.downTriggered && up === lib.upTriggered,
  };
}

// ===== 报告构建 =====

export interface CalibrationReportOptions {
  thresholdsPct: readonly string[];
  materializedAt: string;
  methodVersion: string;
  adapterVersion: string;
  inputAvailableAtMax: string | null;
}

export interface CalibrationReport {
  result: 'REFERENCE CALIBRATION OK';
  procedure: {
    contract: string;
    windowHorizonTradingDays: 20;
    calibrationOnly: true;
    freezeAt: 'P5';
    noThresholdChangeWithinEvaluationWindow: true;
  };
  generatedAt: string;
  thresholdsPct: string[];
  sampleScope: {
    eventsTotal: number;
    byClass: Record<SampleClass, number>;
    exclusionRules: { DATA_GAP: string; WINDOW_INCOMPLETE: string };
    byEventType: Record<string, { total: number; USABLE: number; WINDOW_INCOMPLETE: number; DATA_GAP: number }>;
    byEventKey: Record<string, { total: number; USABLE: number; WINDOW_INCOMPLETE: number; DATA_GAP: number }>;
    scopeArithmetic: {
      allEvents: string;
      statisticsScopeExProgress: string;
      buybackTypeRow: string;
      supplementaryByEventKey: string;
    };
  };
  triggerDefinition: {
    series: string;
    down: string;
    up: string;
    any: string;
    downUpMarginal: string;
    dayIndex: string;
    arithmetic: string;
  };
  matrix: {
    byEventType: Record<string, Record<string, TriggerStatCell>>;
    overall: {
      allEvents: Record<string, TriggerStatCell>;
      statisticsScopeExProgress: Record<string, TriggerStatCell>;
    };
  };
  supplementaryByEventKey: Record<string, Record<string, TriggerStatCell>>;
  consistencyCheck: CrossCheckBlock;
  recommendation: RecommendationBlock;
  limitations: string[];
  revisionNotice: string;
  versionBinding: {
    methodVersion: string;
    adapterVersion: string;
    inputAvailableAtMax: string | null;
    materializedAt: string;
  };
  reportPath: string | null;
}

function classCountsOf(samples: readonly CalibrationSample[]): { total: number; USABLE: number; WINDOW_INCOMPLETE: number; DATA_GAP: number } {
  return {
    total: samples.length,
    USABLE: samples.filter((s) => s.cls === 'USABLE').length,
    WINDOW_INCOMPLETE: samples.filter((s) => s.cls === 'WINDOW_INCOMPLETE').length,
    DATA_GAP: samples.filter((s) => s.cls === 'DATA_GAP').length,
  };
}

function matrixOf(samples: readonly CalibrationSample[], pcts: readonly string[]): Record<string, TriggerStatCell> {
  const out: Record<string, TriggerStatCell> = {};
  for (const pct of pcts) out[pct] = aggregateTriggerStats(samples, pct);
  return out;
}

/**
 * 校准报告构建（纯函数）。样本 = 全量事件（派发基线）；六类矩阵 BUYBACK 行按 §3.6+R25
 * 剔除普通进展子类，进展子类随 supplementaryByEventKey 与整体 allEvents 口径如实可见。
 */
export function buildCalibrationReport(
  samples: readonly CalibrationSample[],
  crossCheck: CrossCheckBlock,
  opts: CalibrationReportOptions,
): CalibrationReport {
  const pcts = [...opts.thresholdsPct];
  const eventTypes = [...new Set(samples.map((s) => s.eventType))].sort();
  const eventKeys = [...new Set(samples.map((s) => s.eventKey))].sort();

  const byTypeMatrix: Record<string, Record<string, TriggerStatCell>> = {};
  for (const type of eventTypes) {
    // 六类行：BUYBACK 行 = 该类除 PROGRESS_OR_CHANGE 外全部子类（§3.6 首次 + 重要变更；R25 统计过滤）。
    const typeSamples = samples.filter(
      (s) => s.eventType === type && !(type === 'BUYBACK' && s.eventKey === PROGRESS_EVENT_KEY),
    );
    byTypeMatrix[type] = matrixOf(typeSamples, pcts);
  }
  const statisticsScope = samples.filter((s) => s.eventKey !== PROGRESS_EVENT_KEY);
  const overall = {
    allEvents: matrixOf(samples, pcts),
    statisticsScopeExProgress: matrixOf(statisticsScope, pcts),
  };
  const supplementary: Record<string, Record<string, TriggerStatCell>> = {};
  for (const key of eventKeys) supplementary[key] = matrixOf(samples.filter((s) => s.eventKey === key), pcts);

  const recommendation = recommendThreshold({
    overall: pcts.map((pct) => ({ pct, cell: overall.statisticsScopeExProgress[pct]! })),
    byType: eventTypes.flatMap((type) => pcts.map((pct) => ({ pct, type, cell: byTypeMatrix[type]![pct]! }))),
  });

  const byEventTypeCounts: CalibrationReport['sampleScope']['byEventType'] = {};
  for (const type of eventTypes) {
    byEventTypeCounts[type] = classCountsOf(
      samples.filter((s) => s.eventType === type && !(type === 'BUYBACK' && s.eventKey === PROGRESS_EVENT_KEY)),
    );
  }
  const byEventKeyCounts: CalibrationReport['sampleScope']['byEventKey'] = {};
  for (const key of eventKeys) byEventKeyCounts[key] = classCountsOf(samples.filter((s) => s.eventKey === key));

  return {
    result: 'REFERENCE CALIBRATION OK',
    procedure: {
      contract: 'docs/REVISION-LOG.md R3 程序 + docs/specs/HISTORICAL-REFERENCE.md §9 + docs/specs/SETTLEMENT-REVIEW.md SR-6.3',
      windowHorizonTradingDays: 20,
      calibrationOnly: true,
      freezeAt: 'P5',
      noThresholdChangeWithinEvaluationWindow: true,
    },
    generatedAt: opts.materializedAt,
    thresholdsPct: pcts,
    sampleScope: {
      eventsTotal: samples.length,
      byClass: {
        USABLE: samples.filter((s) => s.cls === 'USABLE').length,
        WINDOW_INCOMPLETE: samples.filter((s) => s.cls === 'WINDOW_INCOMPLETE').length,
        DATA_GAP: samples.filter((s) => s.cls === 'DATA_GAP').length,
      },
      exclusionRules: {
        DATA_GAP: '参考价不可得（无事件后有成交交易日/开盘价不可解析）或超额序列中断（指数/收盘缺行、行业不可得）——剔除数如实列示，不以邻近样本代替。',
        WINDOW_INCOMPLETE: '事件后 20 个有成交交易日尚未走完（序列可用前缀 < 20 点）——"20 日内是否触发"不可完整回答，整体剔除单列（计入将低估未触发率）。',
      },
      byEventType: byEventTypeCounts,
      byEventKey: byEventKeyCounts,
      scopeArithmetic: {
        allEvents: `全部事件（派发样本基线 ${samples.length} 例，含回购进展子类）——审计面整体口径。`,
        statisticsScopeExProgress: `R25：${PROGRESS_EVENT_KEY}（回购普通进展）非统计实例，整体统计口径剔除（${statisticsScope.length} 例）——推荐规则的取数口径。`,
        buybackTypeRow: `六类矩阵 BUYBACK 行 = 首次 + 重要变更（§3.6；${samples.filter((s) => s.eventType === 'BUYBACK' && s.eventKey !== PROGRESS_EVENT_KEY).length} 例），进展子类不并入。`,
        supplementaryByEventKey: '子类细分逐键矩阵（含进展子类与方向子类，如 HOLDER_TRADE 增/减持）——审计与方向异质性核对用，非推荐取数层。',
      },
    },
    triggerDefinition: {
      series: '20 日窗口逐日累计超额 e_d = (P_d_close/P_ref − 1) − (I_d_close/I_ref − 1)（SR-3.4；后复权；行业指数取事件时点当时版本）。',
      down: '下行（跑赢侧不利）：e_d ≤ −θ（恰等触发，SR-6.1"达到"）。',
      up: '上行（跑输侧不利）：e_d ≥ +θ。',
      any: '任一侧触发 = 下行或上行至少其一（边际口径）。',
      downUpMarginal: 'downTriggered/upTriggered 为边际口径（对侧是否也触发不计）；downOnly/upOnly/bothSides 单列，不合并歪读。',
      dayIndex: '首个触发日 = 序列内首个命中日，1 基交易日序（起算日 = 第 1 个有成交交易日，停牌暂停计时）。',
      arithmetic: '阈值比较一律精确十进制定点（SR-2.2），禁浮点。',
    },
    matrix: { byEventType: byTypeMatrix, overall },
    supplementaryByEventKey: supplementary,
    consistencyCheck: crossCheck,
    recommendation,
    limitations: [
      '样本期 2015–2026 市场状态分布不均匀（2015 股灾、2018 熊市、2019–2021 结构市、2022–2024 调整等），触发率为全期混合口径；市场状态分层属 P4 群组层（HISTORICAL-REFERENCE §5 层 4），本报告不做分层过度分析。',
      '样本为六类公告事件后窗口：事件后波动天然大于无事件基准日，本触发率是"事件条件下的触发率"；阈值在结算侧适用于全部决策（含无事件场景），外推到无事件场景触发率会偏低——本报告只标定事件侧分布，不冒称全场景校准。',
      'DATA_GAP 剔除可能非随机（退市股行情缺失与事件类型相关），分母为可得样本；剔除数与规则见 sampleScope。',
      '六类事件本身无"预期方向"属性（事件库只有事件、无方向），两侧分列统计；方向异质性（如增/减持）见 supplementaryByEventKey。',
      '回购进展子类（R25）在六类矩阵与统计口径整体中剔除、审计面整体保留，三套口径的样本算术见 sampleScope.scopeArithmetic。',
      '本报告为描述性统计（HISTORICAL-REFERENCE §4），不构成预测概率；校准只推荐不生效（SR-6.3），P5 冻结。',
    ],
    revisionNotice: REVISION_NOTICE,
    versionBinding: {
      methodVersion: opts.methodVersion,
      adapterVersion: opts.adapterVersion,
      inputAvailableAtMax: opts.inputAvailableAtMax,
      materializedAt: opts.materializedAt,
    },
    reportPath: null,
  };
}
