/**
 * Lyra · 监管问询事件识别单测（W33: code-writer）。纯函数测试，不碰网络、不碰 DB。
 * 合同：W33 派发（问询/回复/关注函正反例 + 机构判定 + 与 W14 六类互斥裁定）；
 * 裁定冻结：公告分类以函件本体为准，"关于XX问询函的回复"归问询类不归六类。
 * 部分标题取自冻结池真实公告（探测全量 258 条语料），其余为按真实形态构造的合成标题。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTitle, type AnnouncementInput } from './detect.js';
import {
  arbitrateInquiryOverSixTypes,
  classifyInquiryTitle,
  detectInquiry,
  INQUIRY_PRIORITY_RULING,
  inquiryEventIdOf,
  REGULATORY_INQUIRY_TYPE,
  toInquiryInstance,
} from './inquiry.js';

let seq = 0;
function ann(title: string, subjectId = '600000'): AnnouncementInput {
  seq += 1;
  return { factId: `fact:t${seq}`, subjectId, title, availableAt: '2025-01-02T00:00:00.000Z' };
}

function ev(title: string, subjectId = '600000') {
  const outcome = detectInquiry(ann(title, subjectId));
  assert.equal(outcome.kind, 'EVENT', `expected EVENT for: ${title}`);
  if (outcome.kind !== 'EVENT') throw new Error('unreachable');
  return outcome.event;
}

// ===== 收到问询 =====

test('收到问询：正例 ≥3（真实标题形态），收到优先于回复词', () => {
  const a = ev('关于收到上海证券交易所问询函的公告');
  assert.equal(a.subtype, 'RECEIVED');
  assert.equal(a.attrs.issuer, 'SSE');
  assert.equal(a.attrs.letterKind, 'INQUIRY_LETTER');

  const b = ev('江苏中天科技股份有限公司关于收到上海证券交易所监管工作函的公告');
  assert.equal(b.subtype, 'RECEIVED');
  assert.equal(b.attrs.letterKind, 'WORK_LETTER');

  // 合并公告（收到 + 回复同标题）：连词结构"及回复"= 新函件送达 → 收到优先
  const c = ev('关于收到上海证券交易所进一步问询函及回复的公告');
  assert.equal(c.subtype, 'RECEIVED');

  const d = ev('关于收到上海证券交易所《关于对中国船舶工业股份有限公司发行股份购买资产预案信息披露的问询函》的公告');
  assert.equal(d.subtype, 'RECEIVED');

  const e = ev('关于收到上海证券交易所有关监管工作函及回复的公告');
  assert.equal(e.subtype, 'RECEIVED');
});

test('收到 vs 回复的属格区分：收到…问询函的回复公告 = 对已收函件的回复，归 REPLY', () => {
  // 真实标题（600105 2019-06-13 / 2021-12-27）：前有收函公告与延期回复公告链条，属格中心词是回复
  const a = ev('关于收到上海证券交易所问询函的回复公告');
  assert.equal(a.subtype, 'REPLY');

  const b = ev('永鼎股份关于收到上海证券交易所问询函的回复公告');
  assert.equal(b.subtype, 'REPLY');

  // 无"的回复"属格的收函公告仍是 RECEIVED
  const c = ev('永鼎股份关于收到上海证券交易所问询函的公告');
  assert.equal(c.subtype, 'RECEIVED');
});

// ===== 回复问询 =====

test('回复问询：正例 ≥3，动词词表覆盖（回复/答复/复函/回函/说明）', () => {
  const a = ev('关于对深圳证券交易所问询函的回复公告');
  assert.equal(a.subtype, 'REPLY');
  assert.equal(a.attrs.issuer, 'SZSE');

  const b = ev('关于北京兆易创新科技股份有限公司股票交易异常波动问询函的答复');
  assert.equal(b.subtype, 'REPLY');
  assert.equal(b.attrs.issuer, 'UNDETERMINED'); // 标题不点名机构 → 不猜

  const c = ev('工业集团公司关于股票交易异常波动情况问询的复函');
  assert.equal(c.subtype, 'REPLY');

  const d = ev('股票交易异常波动问询实控人回函-NingZhao（赵宁）');
  assert.equal(d.subtype, 'REPLY');

  const e = ev('关于公司2015年年报的问询函有关财务事项的说明');
  assert.equal(e.subtype, 'REPLY');
});

test('裸回复函与关注函：无问询词的回复函与深交所关注函均入问询族', () => {
  const a = ev('实际控制人、大股东回复函');
  assert.equal(a.subtype, 'REPLY');
  assert.equal(a.attrs.letterKind, 'INQUIRY_LETTER');
  assert.equal(a.attrs.issuer, 'UNDETERMINED');

  const b = ev('关于关注函回复的公告');
  assert.equal(b.subtype, 'REPLY');
  assert.equal(b.attrs.letterKind, 'CONCERN_LETTER');

  const c = ev('关于对深圳证券交易所关注函的回复公告');
  assert.equal(c.subtype, 'REPLY');
  assert.equal(c.attrs.issuer, 'SZSE');
  assert.equal(c.attrs.letterKind, 'CONCERN_LETTER');
});

// ===== 反例 =====

test('反例：W14 六类标题与普通公告不进问询族', () => {
  for (const title of [
    '武汉光迅科技股份有限公司2025年半年度业绩预告',
    '兆易创新关于以集中竞价交易方式回购公司股份的回购报告书',
    '关于持股5%以上股东减持计划的公告',
    '首次公开发行部分限售股上市流通公告',
    '2019年半年度业绩快报',
    '关于利用自有闲置资金进行国债逆回购投资的公告',
  ]) {
    const outcome = detectInquiry(ann(title));
    assert.equal(outcome.kind, 'NONE', `expected NONE for: ${title}`);
  }
});

// ===== 中介伴生文档排除 =====

test('中介伴生文档：核查意见/会计师/评估/律师/独立董事/回复意见族全部具名排除', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['华泰联合证券有限责任公司关于上海证券交易所《关于对洛阳栾川钼业集团股份有限公司重大资产购买报告书的问询函》相关问题之专项核查意见', '核查意见'],
    ['天健会计师事务所（特殊普通合伙）关于苏州东山精密制造股份有限公司向特定对象发行股票审核问询函中有关财务事项的说明', '会计师事务所'],
    ['北京中企华资产评估有限责任公司关于深圳证券交易所《关于对中钨高新材料股份有限公司的重组问询函》之回复说明', '资产评估'],
    ['上海市锦天城律师事务所关于上海证券交易所《关于中国船舶工业股份有限公司发行股份购买资产预案信息披露的问询函》的专项回复意见', '律师事务所'],
    ['独立董事关于上海证券交易所问询函相关事项的独立意见', '独立意见'],
    ['天职国际对上海证券交易所《关于中国船舶工业股份有限公司发行股份购买资产预案信息披露的问询函》的回复意见', '回复意见'],
    ['中汇会专[2025]11470 号 关于深圳麦格米特电气股份有限公司申请向特定对象发行股票审核问询函有关财务问题回复的专项说明', '专项说明'],
    ['发行股份及支付现金购买资产并募集配套资金暨关联交易预案信息披露的问询函涉及会计师部分的回复', '会计师部分'],
  ];
  for (const [title, expectedName] of cases) {
    const outcome = detectInquiry(ann(title));
    assert.equal(outcome.kind, 'COMPANION_EXCLUDED', `expected COMPANION_EXCLUDED for: ${title}`);
    if (outcome.kind !== 'COMPANION_EXCLUDED') throw new Error('unreachable');
    assert.equal(outcome.excludedBy, expectedName, `exclusion name mismatch for: ${title}`);
  }
});

test('公司自撰回复不被中介排除误伤：发行人及保荐机构联合回复与公司回复公告均成实例', () => {
  const a = ev('发行人及保荐机构关于深圳麦格米特电气股份有限公司申请向特定对象发行股票的审核问询函的回复');
  assert.equal(a.subtype, 'REPLY');

  const b = ev('中钨高新材料股份有限公司关于深圳证券交易所《关于对中钨高新材料股份有限公司发行股份及支付现金购买资产并配套募集资金的问询函》的回复');
  assert.equal(b.subtype, 'REPLY');
  assert.equal(b.attrs.issuer, 'SZSE');
});

// ===== UNDETERMINED 兜底 =====

test('UNDETERMINED 兜底：候选命中但无收到/回复动词，不猜子类', () => {
  const cls = classifyInquiryTitle('中小板问询函【2017】第143号');
  assert.equal(cls.candidate, true);
  assert.equal(cls.excludedBy, null);
  assert.equal(cls.subtype, 'UNDETERMINED');

  const outcome = detectInquiry(ann('中小板问询函【2017】第143号'));
  assert.equal(outcome.kind, 'EVENT');
  if (outcome.kind !== 'EVENT') throw new Error('unreachable');
  assert.equal(outcome.event.subtype, 'UNDETERMINED');
});

// ===== 机构判定 =====

test('机构判定：SSE/SZSE/CSRC/UNDETERMINED 词表顺序生效', () => {
  assert.equal(classifyInquiryTitle('关于收到上海证券交易所问询函的公告').issuer, 'SSE');
  assert.equal(classifyInquiryTitle('关于对深交所《中小板问询函【2017】第143号》的回复公告').issuer, 'SZSE');
  assert.equal(classifyInquiryTitle('关于中国证监会河南监管局2014年报问询函回复的公告').issuer, 'CSRC');
  assert.equal(classifyInquiryTitle('关于收到中国证监会问询函的公告').issuer, 'CSRC');
  assert.equal(classifyInquiryTitle('控股股东及实际控制人关于公司股票交易异常波动问询函的回复').issuer, 'UNDETERMINED');
});

// ===== 函件类别 =====

test('函件类别：监管工作函 > 关注函 > 问询函，首命中生效', () => {
  assert.equal(classifyInquiryTitle('关于收到上海证券交易所有关监管工作函及回复的公告').letterKind, 'WORK_LETTER');
  assert.equal(classifyInquiryTitle('关于对深圳证券交易所关注函的回复公告').letterKind, 'CONCERN_LETTER');
  assert.equal(classifyInquiryTitle('关于对深圳证券交易所2016年年报问询函回复的公告').letterKind, 'INQUIRY_LETTER');
});

// ===== 与 W14 六类的互斥与优先级裁定（W33 派发冻结）=====

test('优先级裁定：问询族标题双命中六类词时问询类胜，"关于XX问询函的回复"不归六类', () => {
  assert.ok(INQUIRY_PRIORITY_RULING.length > 0);

  // 合成双命中标题：含"业绩预告"与"问询函"——W14 归 EARNINGS_FORECAST，问询类裁定胜
  const dual = '关于公司业绩预告有关事项的问询函回复的公告';
  assert.equal(classifyTitle(dual).primary, 'EARNINGS_FORECAST'); // W14 规则表自身命中（组合层输入）
  assert.equal(arbitrateInquiryOverSixTypes(classifyTitle(dual).primary, true), 'REGULATORY_INQUIRY');

  // detectInquiry 侧独立成事件（组合层据此仲裁）
  const a = ev(dual);
  assert.equal(a.eventType, REGULATORY_INQUIRY_TYPE);
  assert.equal(a.subtype, 'REPLY');

  // 无问询词：回落六类主命中；双无：null
  assert.equal(arbitrateInquiryOverSixTypes('BUYBACK', false), 'BUYBACK');
  assert.equal(arbitrateInquiryOverSixTypes(null, false), null);
});

test('六类标题零误入：问询族门槛对 W14 全部六类真实标题形态不候选', () => {
  // 派发互斥的另一面：六类公告不得因含"回复/说明"等宽词混入问询族
  for (const title of [
    '关于回购股份实施结果暨股份变动的公告', // 回购类含"结果"，无问询词
    '关于2016年股票期权与限制性股票激励计划限制性股票第一期解除限售暨上市公告', // 解禁
    '湖南有色金属有限公司关于知悉限售股解禁相关法律法规的承诺', // 排除形态
  ]) {
    assert.equal(detectInquiry(ann(title)).kind, 'NONE');
  }
});

// ===== 事件身份与实例 =====

test('event_id 确定性且与 W14 方案同构：重放幂等、跨事实不碰撞', () => {
  const id1 = inquiryEventIdOf('600000', 'fact:a');
  const id2 = inquiryEventIdOf('600000', 'fact:a');
  const id3 = inquiryEventIdOf('600000', 'fact:b');
  const id4 = inquiryEventIdOf('000657', 'fact:a');
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.notEqual(id1, id4);
  assert.match(id1, /^evt:[0-9a-f]{64}$/);

  const inst = toInquiryInstance(ev('关于收到上海证券交易所问询函的公告', '600000'));
  assert.equal(inst.type, 'REGULATORY_INQUIRY');
  assert.equal(inst.eventId, inquiryEventIdOf(inst.subject, inst.evidenceFactId));
  assert.equal(inst.subtype, 'RECEIVED');
  assert.equal(inst.attrs.source, 'CNINFO_L1_ANNOUNCEMENT');
});
