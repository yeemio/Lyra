/**
 * Lyra · 监管问询函事件识别（W33: code-writer，A 类需求 A6）。
 * 合同：Gate-M coverage 实证缺口"监管问询未入库"（维度7 风险项，R11 后置项）；W33 派发冻结裁定：
 * 公告分类以函件本体为准——"关于XX问询函的回复"归问询类，不归 W14 六类（本文件写死，见
 * INQUIRY_PRIORITY_RULING / arbitrateInquiryOverSixTypes）。
 *
 * 数据来源：零新数据源。问询族公告本来就在 P1 冻结的 41,041 条 L1 巨潮 ANNOUNCEMENT 元数据里
 * （2026-10-25 W33 探测实证：冻结池 26 股中 22 股共 258 条，2015-01 至 2026-09；关键词分布
 * 问询函 231 / 问询 241 / 回复函 2 / 关注函 2 / 监管工作函 14；bare 监管函 0）。
 *
 * 事件实例 = 股票 × REGULATORY_INQUIRY × 触发公告（HISTORICAL-REFERENCE §3 通用规则 2 同一纪律，
 * 一公告一实例，不 dedupe 同日多公告）；event_id 确定性 → 重放幂等。events 表 type 列为无约束
 * text（src/db/events-migration.sql），REGULATORY_INQUIRY 字面量直接可用（W33 派发确认）。
 *
 * 纯函数部分（本文件）无 DB 依赖；落库与 CLI 在 inquiry.cli.ts。W14 的 rules.ts / detect.ts /
 * library.ts / detect.cli.ts 一律不改（只读复用 AnnouncementInput / sha256Hex）。
 */
import { sha256Hex } from './detect.js';
import type { AnnouncementInput } from './detect.js';
import type { EventType } from './rules.js';

/** 事件类型字面量（events.type 为无约束 text，W33 派发确认后使用）。 */
export const REGULATORY_INQUIRY_TYPE = 'REGULATORY_INQUIRY';

/** 子类：收到问询函 / 回复问询函（派发冻结两类）+ UNDETERMINED 兜底（候选命中但两类动词词均无，不猜）。 */
export type InquirySubtype = 'RECEIVED' | 'REPLY' | 'UNDETERMINED';

/** 函件类别（标题可判时取，首个命中词表生效；问询函为兜底族）。 */
export type InquiryLetterKind = 'INQUIRY_LETTER' | 'CONCERN_LETTER' | 'WORK_LETTER' | 'UNDETERMINED';

/** 发函机构（标题可判时取；不可判 UNDETERMINED，不猜）。 */
export type InquiryIssuer = 'SSE' | 'SZSE' | 'CSRC' | 'UNDETERMINED';

// ===== 候选门槛与子类词表（真实标题锚定，探测全量 258 条归纳，见各 evidence）=====

/**
 * 问询族候选门槛：任一命中才进入判定（排除在前无意义——先门槛后排除，统计口径见 CLI）。
 * 真实语料形态：
 * - 问询函/问询：231/241 条主族（年报问询函、重组问询函、审核问询函、异常波动问询函、信息披露问询函）；
 * - 关注函（深交所）2 条："关于关注函回复的公告"、"关于对深圳证券交易所关注函的回复公告"；
 * - 监管工作函（上交所）14 条（信息披露监管工作函族）；bare 监管函 0 条（探测实证）；
 * - 裸回复函 2 条："实际控制人、大股东回复函"（603993，标题无任何问询词，实为异常波动问询回复）。
 */
export const INQUIRY_FAMILY_RE = /问询|关注函|监管工作函|回复函/;

/** 收到问询：动词词。与"的回复"属格结构互斥（见 GENITIVE_REPLY_RE）。 */
export const INQUIRY_RECEIVED_RE = /收到/;

/**
 * 属格回复结构："收到…问询函的回复(公告)"= 对已收函件的回复，标题中心词是回复而非收函
 * （真实语料 n=2："关于收到上海证券交易所问询函的回复公告"、"永鼎股份关于收到上海证券交易所问询函的回复公告"，
 * 均前有收函公告与延期回复公告链条佐证）。与连词结构"进一步问询函及回复"/"监管工作函及回复"
 * （新函件+回复合并送达，收函优先）相区分。
 */
export const INQUIRY_GENITIVE_REPLY_RE = /的(回复|答复|回函|复函)/;

/**
 * 回复问询：动词词。真实形态扩展（证据）：回复（回复公告/回复说明/回复报告/及回复/的回复）、
 * 答复（异常波动问询函的答复）、复函（异常波动情况问询的复函）、回函（异常波动问询实控人回函、
 * 问询函》的回函）、说明（"关于公司2015年年报的问询函有关财务事项的说明"——公司对问询函的书面说明，
 * n=1；"问询函专项说明"族已在排除表处理，不进本分支）。
 */
export const INQUIRY_REPLY_RE = /回复|答复|复函|回函|说明/;

// ===== 中介伴生文档排除表（W14 同款纪律：伴生文档不计实例，具名登记不静默）=====

export interface InquiryExclusion {
  name: string;
  re: RegExp;
  /** 真实标题锚定（2026-10-25 全量 258 条语料）。 */
  evidence: string;
}

/**
 * 问询事件只记函件本体当事人（公司收到 / 公司或其控股股东实际控制人回复）；
 * 中介机构（券商/会计师/评估/律师/独立董事）就同一问询出具的伴生文档排除，同日公司回复公告不损失实例。
 */
export const INQUIRY_EXCLUSIONS: readonly InquiryExclusion[] = [
  {
    name: '核查意见',
    re: /核查意见/,
    evidence:
      '券商/会计师/评估机构专项核查意见族（最大伴生类，n≈22）："华泰联合证券有限责任公司关于上海证券交易所《…重组问询函》相关问题之核查意见"、"中信建投证券股份有限公司关于…问询函回复之核查意见"、"瑞华会计师事务所（特殊普通合伙）关于公司的问询函之核查意见"、"…问询函相关问题核查意见"（无机构前缀变体）。公司回复实例由同日"…的回复公告/之回复"承担。',
  },
  {
    name: '法律意见',
    re: /法律意见/,
    evidence: '律师伴生："北京市中伦（上海）律师事务所关于公司回购股份之法律意见书"形态同源；本语料问询族内未出现，防御性保留（与 W14 排除表对齐）。',
  },
  {
    name: '独立意见',
    re: /独立意见/,
    evidence: '独立董事伴生 n=2："独立董事关于上海证券交易所问询函相关事项的独立意见"、"独立董事关于永鼎股份2022年年度报告的信息披露监管工作函相关事项的独立意见"。',
  },
  {
    name: '独立财务顾问',
    re: /独立财务顾问/,
    evidence: '"天风证券股份有限公司关于公司重组问询函相关事项之独立财务顾问核查意见"（与核查意见双命中，防御性单列对齐 W14）。',
  },
  {
    name: '会计师事务所',
    re: /会计师事务所/,
    evidence:
      '会计师专项说明/回复族（n≈20）："天健会计师事务所（特殊普通合伙）关于苏州东山精密制造股份有限公司向特定对象发行股票审核问询函中有关财务事项的说明"、"中审众环会计师事务所（特殊普通合伙）关于…问询函的回复"、"安永华明会计师事务所（特殊普通合伙）关于对紫光股份有限公司…审核问询函回复的专项说明"、"德勤华永会计师事务所（特殊普通合伙）关于…问询函反馈意见"。',
  },
  {
    name: '资产评估',
    re: /资产评估|评估咨询/,
    evidence:
      '评估机构伴生 n≈7："北京中企华资产评估有限责任公司关于深圳证券交易所《…重组问询函》之回复说明"、"上海东洲资产评估有限公司…回复说明之专项核查意见"、"中联资产评估集团有限公司…资产评估相关问题答复的核查意见"、"中盛评估咨询有限公司…中有关评估事项的回复"。',
  },
  {
    name: '律师事务所',
    re: /律师事务所/,
    evidence: '"上海市锦天城律师事务所关于上海证券交易所《…问询函》的专项回复意见"（n=1）。',
  },
  {
    name: '回复意见',
    re: /回复意见/,
    evidence:
      '中介"回复意见"尾缀族 n=3："天职国际对上海证券交易所《…问询函》的回复意见"（天职国际为会计师事务所但标题不含"会计师事务所"字样）、"上海东洲资产评估有限公司…的专项回复意见"、"上海市锦天城律师事务所…的专项回复意见"。公司回复用"回复公告/回复报告/的回复/回复说明"，不含"回复意见"，零误伤。',
  },
  {
    name: '会计师部分',
    re: /会计师部分|会计师相关/,
    evidence:
      '问询函中拆分的会计师部分回复 n=4："发行股份及支付现金购买资产…问询函涉及会计师部分的回复"（603986 n=2）、"关于…问询函中与会计师相关问题之回复"（603993 n=2）——回复包中会计师分册，公司整体回复实例由同日"…的回复公告"承担。',
  },
  {
    name: '专项说明',
    re: /专项说明/,
    evidence:
      '残余"专项说明"族："中汇会专[2025]11470 号 关于…审核问询函有关财务问题回复的专项说明"（文号开头无机构名，n=1）；"问询函专项说明"（002384 n=2，标题无作者前缀、同日存在公司回复公告，按专项说明族排除不猜作者）。其余专项说明均已被"会计师事务所"先行排除。',
  },
];

// ===== 函件类别与发函机构词表（顺序即判定顺序，首个命中生效）=====

/** 函件类别词表：监管工作函 > 关注函 > 问询函（问询函含裸"问询/回复函"兜底）。 */
export const INQUIRY_LETTER_KINDS: readonly (readonly [InquiryLetterKind, RegExp])[] = [
  ['WORK_LETTER', /监管工作函/],
  ['CONCERN_LETTER', /关注函/],
  ['INQUIRY_LETTER', /问询函|问询|回复函/],
];

/**
 * 发函机构词表：上交所 / 深交所 / 证监会（含地方监管局，如"中国证监会河南监管局"）。
 * 顺序即判定；标题不含任何机构词 → UNDETERMINED（真实高频形态："股票交易异常波动问询函的回复"、
 * "对《关于对紫光股份有限公司的重组问询函》的回复"等均不点名机构）。
 */
export const INQUIRY_ISSUERS: readonly (readonly [InquiryIssuer, RegExp])[] = [
  ['SSE', /上海证券交易所|上交所/],
  ['SZSE', /深圳证券交易所|深交所/],
  ['CSRC', /证监会|证监局|监管局/],
];

// ===== 事件对象与判定 =====

export interface InquiryEvent {
  subject: string;
  eventType: typeof REGULATORY_INQUIRY_TYPE;
  subtype: InquirySubtype;
  eventTime: string; // = 输入 availableAt（与 W14 同基准）
  evidenceFactId: string;
  attrs: Record<string, unknown>;
}

export type InquiryOutcome =
  | { kind: 'EVENT'; event: InquiryEvent }
  | { kind: 'NONE'; reason: 'NO_INQUIRY_KEYWORD' }
  | { kind: 'COMPANION_EXCLUDED'; excludedBy: string };

export interface InquiryClassification {
  candidate: boolean;
  excludedBy: string | null;
  subtype: InquirySubtype;
  letterKind: InquiryLetterKind;
  issuer: InquiryIssuer;
}

/** 标题判定（门槛 → 排除 → 收到优先 → 回复 → UNDETERMINED 兜底；类别与机构独立取词）。 */
export function classifyInquiryTitle(title: string): InquiryClassification {
  const candidate = INQUIRY_FAMILY_RE.test(title);
  const excluded = candidate ? INQUIRY_EXCLUSIONS.find((x) => x.re.test(title)) : undefined;
  if (!candidate) {
    return { candidate: false, excludedBy: null, subtype: 'UNDETERMINED', letterKind: 'UNDETERMINED', issuer: 'UNDETERMINED' };
  }
  if (excluded !== undefined) {
    return { candidate: true, excludedBy: excluded.name, subtype: 'UNDETERMINED', letterKind: 'UNDETERMINED', issuer: 'UNDETERMINED' };
  }
  const subtype: InquirySubtype =
    INQUIRY_RECEIVED_RE.test(title) && !INQUIRY_GENITIVE_REPLY_RE.test(title)
      ? 'RECEIVED'
      : INQUIRY_REPLY_RE.test(title)
        ? 'REPLY'
        : 'UNDETERMINED';
  const kindHit = INQUIRY_LETTER_KINDS.find(([, re]) => re.test(title));
  const issuerHit = INQUIRY_ISSUERS.find(([, re]) => re.test(title));
  return {
    candidate: true,
    excludedBy: null,
    subtype,
    letterKind: kindHit !== undefined ? kindHit[0] : 'UNDETERMINED',
    issuer: issuerHit !== undefined ? issuerHit[0] : 'UNDETERMINED',
  };
}

/**
 * 单条公告 → 问询事件实例（或具名非实例结果）。
 * sixTypePrimary：W14 classifyTitle 的主命中（由调用方传入或用 arbitrateInquiryOverSixTypes 组合）。
 */
export function detectInquiry(input: AnnouncementInput): InquiryOutcome {
  const cls = classifyInquiryTitle(input.title);
  if (!cls.candidate) return { kind: 'NONE', reason: 'NO_INQUIRY_KEYWORD' };
  if (cls.excludedBy !== null) return { kind: 'COMPANION_EXCLUDED', excludedBy: cls.excludedBy };
  return {
    kind: 'EVENT',
    event: {
      subject: input.subjectId,
      eventType: REGULATORY_INQUIRY_TYPE,
      subtype: cls.subtype,
      eventTime: input.availableAt,
      evidenceFactId: input.factId,
      attrs: {
        title: input.title,
        letterKind: cls.letterKind,
        issuer: cls.issuer,
        detectionBasis: 'TITLE_KEYWORD_METADATA_LEVEL',
        source: 'CNINFO_L1_ANNOUNCEMENT',
      },
    },
  };
}

// ===== 与 W14 六类的优先级裁定（W33 派发冻结，写死）=====

export const INQUIRY_PRIORITY_RULING =
  'W33 派发冻结裁定：公告分类以函件本体为准——问询族标题（含"关于XX问询函的回复"，即使同时含业绩预告等六类词）' +
  '归 REGULATORY_INQUIRY，不归 W14 六类。真实语料中问询族与六类词交叉为 0（2026-10-25 探测实证，258 条零交叉），' +
  '本裁定为组合层安全网，仅在合成/未来标题双命中时生效。';

/**
 * 优先级仲裁：inquiry 命中 → REGULATORY_INQUIRY 胜；否则回落六类主命中（可为 null）。
 * 组合层（总控接线 D7 时）用它统一双规则表的归属；本文件不修改 W14 任何文件。
 */
export function arbitrateInquiryOverSixTypes<T extends EventType>(
  sixTypePrimary: T | null,
  inquiryHit: boolean,
): 'REGULATORY_INQUIRY' | T | null {
  if (inquiryHit) return 'REGULATORY_INQUIRY';
  return sixTypePrimary;
}

// ===== 事件身份与实例 =====
// 身份方案与 W14 同构：evt:sha256(subject|TYPE|evidenceFactId) → 重放幂等。

export function inquiryEventIdOf(subject: string, evidenceFactId: string): string {
  return `evt:${sha256Hex(`${subject}|${REGULATORY_INQUIRY_TYPE}|${evidenceFactId}`)}`;
}

export interface InquiryEventInstance {
  eventId: string;
  subject: string;
  type: typeof REGULATORY_INQUIRY_TYPE;
  subtype: InquirySubtype;
  eventTime: string;
  evidenceFactId: string;
  attrs: Record<string, unknown>;
}

export function toInquiryInstance(event: InquiryEvent): InquiryEventInstance {
  return {
    eventId: inquiryEventIdOf(event.subject, event.evidenceFactId),
    subject: event.subject,
    type: event.eventType,
    subtype: event.subtype,
    eventTime: event.eventTime,
    evidenceFactId: event.evidenceFactId,
    attrs: event.attrs,
  };
}
