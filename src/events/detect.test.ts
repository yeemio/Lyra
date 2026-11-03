/**
 * Lyra · 事件分类器单测（W14: code-writer）。纯函数测试，不碰网络、不碰 DB。
 * 合同判定：P3-EVENTS-REVIEW Done-when 2（每类 ≥3 正例 + ≥2 反例 + 多命中优先级 +
 * UNDETERMINED/UNPARSED_PERIOD 分支）；HISTORICAL-REFERENCE §3；ASHARE-RULES §9。
 * 部分标题取自冻结池真实公告（另注明），其余为按真实形态构造的合成标题。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyTitle,
  detectAnnouncement,
  detectGrowthEvents,
  eventIdOf,
  parsePeriod,
  type AnnouncementInput,
  type GrowthInput,
} from './detect.js';
import { GROWTH_DELTA_THRESHOLD_RESERVED } from './rules.js';

let seq = 0;
function ann(title: string, subjectId = '600000'): AnnouncementInput {
  seq += 1;
  return { factId: `fact:t${seq}`, subjectId, title, availableAt: '2025-01-02T00:00:00.000Z' };
}
function growth(statDate: string, pubDate: string, yoyNi: number | null): GrowthInput {
  return { factId: `fin:${statDate}`, statDate, pubDate, availableAt: '2025-01-02T00:00:00.000Z', yoyNi };
}

// ===== 业绩预告 =====

test('业绩预告：正例 ≥3（真实标题形态），含预告类型与报告期', () => {
  const a = detectAnnouncement(ann('武汉光迅科技股份有限公司2025年半年度业绩预告'), new Set());
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.eventType, 'EARNINGS_FORECAST');
  assert.equal(a.event.subtype, 'FIRST');
  assert.deepEqual(a.event.attrs.period, '2025H1');
  assert.equal(a.event.attrs.forecastType, 'GENERIC');

  const b = detectAnnouncement(ann('2017年年度业绩预增公告'), new Set());
  assert.equal(b.kind, 'EVENT');
  if (b.kind !== 'EVENT') return;
  assert.equal(b.event.attrs.forecastType, 'PRE_INCREASE');
  assert.deepEqual(b.event.attrs.period, '2017FY');

  const c = detectAnnouncement(ann('2015年前三季度业绩预增公告'), new Set());
  assert.equal(c.kind, 'EVENT');
  if (c.kind !== 'EVENT') return;
  assert.deepEqual(c.event.attrs.period, '2015Q3');

  const d = detectAnnouncement(ann('2020年年度业绩预亏公告'), new Set());
  assert.equal(d.kind, 'EVENT');
  if (d.kind !== 'EVENT') return;
  assert.equal(d.event.attrs.forecastType, 'PRE_LOSS');
});

test('业绩预告：更正子类——有在先事件且标题无方向词 → UNDETERMINED（不猜，ASHARE-RULES §9）', () => {
  const prior = new Set(['2019FY']);
  const a = detectAnnouncement(ann('2019年度业绩预告修正的公告'), prior); // 真实标题
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.subtype, 'UNDETERMINED');
  assert.equal(a.event.attrs.correctionOfPriorEvent, true);
});

test('业绩预告：更正子类——标题明示上修/下修 → REVISE_UP/REVISE_DOWN', () => {
  const prior = new Set(['2020FY']);
  const up = detectAnnouncement(ann('2020年年度业绩预告上修的公告'), prior);
  assert.equal(up.kind, 'EVENT');
  if (up.kind !== 'EVENT') return;
  assert.equal(up.event.subtype, 'REVISE_UP');
  const down = detectAnnouncement(ann('2020年年度业绩预告下修的公告'), prior);
  assert.equal(down.kind, 'EVENT');
  if (down.kind !== 'EVENT') return;
  assert.equal(down.event.subtype, 'REVISE_DOWN');
});

test('业绩预告：含更正词但无在先同报告期事件 → 首次实例 + 具名 note（不猜）', () => {
  const a = detectAnnouncement(ann('2018年度业绩预告修正公告'), new Set()); // 真实标题形态
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.subtype, 'FIRST');
  assert.equal(a.event.attrs.note, 'CORRECTION_KEYWORD_WITHOUT_PRIOR_EVENT');
});

test('业绩预告：UNPARSED_PERIOD 分支——裸年份无期别词不成事件（真实标题）', () => {
  const a = detectAnnouncement(ann('紫金矿业集团股份有限公司2021年业绩预增公告'), new Set());
  assert.equal(a.kind, 'FORECAST_UNPARSED_PERIOD');
  assert.equal(parsePeriod('2026年半年度业绩预告')!.key, '2026H1');
  assert.equal(parsePeriod('关于2017年1-6月业绩预告修正公告')!.key, '2017H1'); // 真实标题
  assert.equal(parsePeriod('2022 年半年度业绩预告')!.key, '2022H1'); // 真实空格变体
  assert.equal(parsePeriod('2021年业绩预告'), null);
  assert.equal(parsePeriod('第一季度业绩预告'), null); // 无年份不成事件（真实标题）
});

test('业绩预告：反例 ≥2——业绩说明会预告排除、无关公告零命中', () => {
  const a = detectAnnouncement(ann('2015年度业绩说明会预告公告'), new Set()); // 真实假阳性类
  assert.equal(a.kind, 'NONE');
  const b = detectAnnouncement(ann('关于召开2020年第六次临时股东大会的通知'), new Set());
  assert.equal(b.kind, 'NONE');
});

// ===== 业绩快报 =====

test('业绩快报：正例 ≥3（真实标题）', () => {
  for (const title of ['2019年半年度业绩快报', '兆易创新2021年度业绩快报公告', '中科曙光2023年半年度业绩快报']) {
    const a = detectAnnouncement(ann(title), new Set());
    assert.equal(a.kind, 'EVENT');
    if (a.kind !== 'EVENT') return void 0;
    assert.equal(a.event.eventType, 'EARNINGS_FLASH');
    assert.equal(a.event.subtype, null);
  }
});

test('业绩快报：更正只走 supersedes 不触发新实例（真实标题：2018年度业绩快报修正公告）', () => {
  const a = detectAnnouncement(ann('2018年度业绩快报修正公告'), new Set());
  assert.equal(a.kind, 'FLASH_CORRECTION_NO_INSTANCE');
});

test('业绩快报：反例 ≥2', () => {
  assert.equal(detectAnnouncement(ann('2016年7月份财务数据简报'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('2023年年度审计报告'), new Set()).kind, 'NONE');
});

// ===== 限售解禁 =====

test('限售解禁：正例 ≥3（真实标题，含激励解锁按派发词表纳入）', () => {
  for (const title of [
    '首次公开发行部分限售股上市流通公告',
    '2020年非公开发行限售股上市流通公告',
    '兆易创新2019年发行股份及支付现金购买资产之限售股上市流通公告',
    '关于2016年股票期权与限制性股票激励计划限制性股票第一期解除限售暨上市公告',
  ]) {
    const a = detectAnnouncement(ann(title), new Set());
    assert.equal(a.kind, 'EVENT');
    if (a.kind !== 'EVENT') return void 0;
    assert.equal(a.event.eventType, 'SHARE_UNLOCK');
    assert.equal(a.event.subtype, null);
  }
});

test('限售解禁：反例 ≥3——保荐核查意见、承诺函、"无限售"误命中均排除（真实标题）', () => {
  const a = detectAnnouncement(ann('申万宏源证券承销保荐有限责任公司关于北京兆易创新科技股份有限公司首次公开发行限售股上市流通的核查意见'), new Set());
  assert.equal(a.kind, 'NONE');
  const b = detectAnnouncement(ann('湖南有色金属有限公司关于知悉限售股解禁相关法律法规的承诺'), new Set());
  assert.equal(b.kind, 'NONE');
  const c = detectAnnouncement(ann('关于股东股份解除质押及质押的公告'), new Set());
  assert.equal(c.kind, 'NONE'); // 含"解除质押"但无解禁词
  // 回归：激励股注销假阳性（股份被注销而非上市流通，真实标题）
  const d = detectAnnouncement(ann('生益科技关于回购注销2024年度限制性股票激励计划部分已获授但尚未解除限售的限制性股票的公告'), new Set());
  assert.equal(d.kind, 'NONE');
});

// ===== 大股东增减持 =====

test('大股东增减持：正例 ≥3，方向判定（真实标题）', () => {
  const a = detectAnnouncement(ann('关于持股5%以上股东减持计划的公告'), new Set());
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.eventType, 'HOLDER_TRADE');
  assert.equal(a.event.subtype, 'DECREASE');

  const b = detectAnnouncement(ann('关于控股股东增持公司股份的公告'), new Set());
  assert.equal(b.kind, 'EVENT');
  if (b.kind !== 'EVENT') return;
  assert.equal(b.event.subtype, 'INCREASE');

  const c = detectAnnouncement(ann('高级管理人员减持股份结果公告'), new Set());
  assert.equal(c.kind, 'EVENT');
  if (c.kind !== 'EVENT') return;
  assert.equal(c.event.subtype, 'DECREASE'); // "高级管理人员"为董监高共现扩展
});

test('大股东增减持：反例 ≥3（真实标题）——债券持有人/员工持股计划/无共现词/可转债/不减持承诺', () => {
  assert.equal(detectAnnouncement(ann('关于债券持有人减持公司可转换公司债券的提示性公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('江苏中天科技股份有限公司关于第一期员工持股计划减持完成的公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('关于减持东港股份股票的公告'), new Set()).kind, 'NONE'); // 共现不满足
  // 回归（真实标题）：股东减持可转债非股份增减持；不减持承诺非触发
  assert.equal(detectAnnouncement(ann('关于控股股东减持公司可转换公司债券的提示性公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('关于控股股东承诺不存在减持情况或减持计划的公告'), new Set()).kind, 'NONE');
  // 具名拒绝路径：主词+共现中但命中排除词（"有限公司股份"假阳性）
  const cls = classifyTitle('关于增持加拿大艾芬豪矿业有限公司股份的公告');
  assert.equal(cls.primary, null);
  assert.deepEqual(cls.rejected, [{ type: 'HOLDER_TRADE', reason: 'EXCLUDED' }]);
});

// ===== 回购 =====

test('回购：正例 ≥3，子类 FIRST / PROGRESS_OR_CHANGE（真实标题）', () => {
  const a = detectAnnouncement(ann('兆易创新关于以集中竞价交易方式回购公司股份的回购报告书'), new Set());
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.eventType, 'BUYBACK');
  assert.equal(a.event.subtype, 'FIRST');

  const b = detectAnnouncement(ann('贵州茅台关于回购股份实施进展的公告'), new Set());
  assert.equal(b.kind, 'EVENT');
  if (b.kind !== 'EVENT') return;
  assert.equal(b.event.subtype, 'PROGRESS_OR_CHANGE');

  const c = detectAnnouncement(ann('恒瑞医药关于股份回购实施结果暨股份变动的公告'), new Set());
  assert.equal(c.kind, 'EVENT');
  if (c.kind !== 'EVENT') return;
  assert.equal(c.event.subtype, 'PROGRESS_OR_CHANGE'); // "结果"为非首次扩展
});

test('回购：反例 ≥3——股权激励回购注销、律师法律意见书、质押式回购、一般性授权、逆回购、前十大股东伴生（真实标题）', () => {
  assert.equal(detectAnnouncement(ann('关于回购注销部分限制性股票通知债权人的公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('北京市中伦（上海）律师事务所关于公司回购股份之法律意见书'), new Set()).kind, 'NONE');
  // 回归（真实标题）：质押式回购=股东融资；H股一般性授权=例行授权；国债逆回购=现金理财；前十大股东持股情况=程序性伴生
  assert.equal(detectAnnouncement(ann('关于控股股东进行股票质押式回购交易的公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('董事会获得回购H股一般性授权通知债权人公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('关于利用自有闲置资金进行国债逆回购投资的公告'), new Set()).kind, 'NONE');
  assert.equal(detectAnnouncement(ann('关于回购股份事项前十大股东及前十大无限售条件股东持股情况的公告'), new Set()).kind, 'NONE');
  // 子类回归：继续/终止 → 非首次
  const a = detectAnnouncement(ann('关于继续实施H股回购的公告'), new Set());
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.subtype, 'PROGRESS_OR_CHANGE');
  const b = detectAnnouncement(ann('洛阳钼业关于终止以集中竞价交易方式回购A股股份方案（第一期）的公告'), new Set());
  assert.equal(b.kind, 'EVENT');
  if (b.kind !== 'EVENT') return;
  assert.equal(b.event.subtype, 'PROGRESS_OR_CHANGE');
});

// ===== 多命中：单归属优先级 + 次命中记录 =====

test('多命中：解禁 > 增减持 > 回购，次命中记录', () => {
  const cls = classifyTitle('控股股东关于限售股份解除限售暨减持计划的提示性公告'); // 合成
  assert.equal(cls.primary, 'SHARE_UNLOCK');
  assert.deepEqual(cls.secondary, ['HOLDER_TRADE']);
  const a = detectAnnouncement(ann('控股股东关于限售股份解除限售暨减持计划的提示性公告'), new Set());
  assert.equal(a.kind, 'EVENT');
  if (a.kind !== 'EVENT') return;
  assert.equal(a.event.eventType, 'SHARE_UNLOCK');
  assert.deepEqual(a.event.attrs.secondaryHits, ['HOLDER_TRADE']);
});

test('多命中：预告 > 快报；解禁 > 回购', () => {
  const cls1 = classifyTitle('2025年年度业绩预告暨业绩快报披露的公告'); // 合成
  assert.equal(cls1.primary, 'EARNINGS_FORECAST');
  assert.deepEqual(cls1.secondary, ['EARNINGS_FLASH']);
  const cls2 = classifyTitle('关于限售股份解除限售上市流通暨回购股份用途调整的公告'); // 合成
  assert.equal(cls2.primary, 'SHARE_UNLOCK');
  assert.deepEqual(cls2.secondary, ['BUYBACK']);
});

// ===== 定期报告增速变化（FINANCIAL 驱动）=====

test('增速变化：|Δ| ≥ 阈值触发，阈值参数化，正负双向', () => {
  const facts = [growth('2024-12-31', '2025-04-20', 0.1), growth('2025-03-31', '2025-04-25', 0.5)];
  const r = detectGrowthEvents('600000', facts, 0.2);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.eventType, 'PERIOD_GROWTH_DELTA');
  assert.equal(r.events[0]!.attrs.delta, 0.4);
  assert.equal(r.events[0]!.eventTime, '2025-01-02T00:00:00.000Z');

  const none = detectGrowthEvents('600000', facts, 0.45);
  assert.equal(none.events.length, 0);

  const neg = detectGrowthEvents('600000', [growth('2024-12-31', '2025-04-20', 0.5), growth('2025-03-31', '2025-04-25', 0.1)], 0.2);
  assert.equal(neg.events.length, 1);
  assert.equal(neg.events[0]!.attrs.delta, -0.4);
  assert.equal(GROWTH_DELTA_THRESHOLD_RESERVED, 0.2); // 预留值（P4 校准）
});

test('增速变化：恰等于阈值触发（严格 ≥），低于阈值不触发', () => {
  const facts = [growth('2024-12-31', '2025-04-20', 0.1), growth('2025-03-31', '2025-04-25', 0.3)];
  assert.equal(detectGrowthEvents('600000', facts, 0.2).events.length, 1);
  assert.equal(detectGrowthEvents('600000', facts, 0.2000001).events.length, 0);
});

test('增速变化：YOYNI 缺失不猜（本期/上期缺口分别计数），序列首期无前值', () => {
  const r = detectGrowthEvents(
    '600000',
    [
      growth('2024-09-30', '2024-10-28', 0.2),
      growth('2024-12-31', '2025-04-20', null),
      growth('2025-03-31', '2025-04-25', 0.6),
      growth('2025-06-30', '2025-08-20', 0.7),
    ],
    0.2,
  );
  // 2024-12-31 本期缺失跳过；2025-03-31 的前一期（2024-12-31）缺失 → prevMissing；2025-06-30 Δ=0.1 不触发
  assert.equal(r.events.length, 0);
  assert.equal(r.stats.firstPeriodNoPrev, 1);
  assert.equal(r.stats.yoyNiMissing, 1);
  assert.equal(r.stats.prevYoyNiMissing, 1);
});

test('增速变化：跨年相邻判定与报告期断档标注（periodSequenceGap）', () => {
  const crossYear = [growth('2024-09-30', '2024-10-28', 0.0), growth('2024-12-31', '2025-04-20', 0.5)];
  const r1 = detectGrowthEvents('600000', crossYear, 0.2);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0]!.attrs.periodSequenceGap, false);

  const gap = [growth('2024-09-30', '2024-10-28', 0.0), growth('2025-03-31', '2025-04-25', 0.5)];
  const r2 = detectGrowthEvents('600000', gap, 0.2);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0]!.attrs.periodSequenceGap, true);
  assert.equal(r2.stats.periodSequenceGap, 1);
});

test('增速变化：同报告期重述——数值取最新修订行，事件时点取首次披露', () => {
  const original: GrowthInput = { factId: 'fin:orig', statDate: '2025-03-31', pubDate: '2025-04-25', availableAt: '2025-04-26T00:00:00.000Z', yoyNi: 0.1 };
  const restated: GrowthInput = { factId: 'fin:rest', statDate: '2025-03-31', pubDate: '2025-04-25', availableAt: '2025-08-01T00:00:00.000Z', yoyNi: 0.6 };
  const prior = growth('2024-12-31', '2025-04-20', 0.1);
  const r = detectGrowthEvents('600000', [prior, original, restated], 0.2);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.evidenceFactId, 'fin:rest'); // 数值=最新修订口径（§6）
  assert.equal(r.events[0]!.eventTime, '2025-04-26T00:00:00.000Z'); // 时点=首次披露可得
  assert.equal(r.events[0]!.attrs.valueCaliber, 'LATEST_REVISION');
  assert.equal(r.events[0]!.attrs.thresholdStatus, 'RESERVED_VALUE_PENDING_P4_CALIBRATION');
  assert.equal(r.events[0]!.attrs.revenueYoY, 'UNAVAILABLE_NOT_IN_SOURCE_GROWTH_FIELDS');
});

// ===== 事件身份确定性 =====

test('eventIdOf 确定性：同（股票,类型,证据事实）重放同 id，异输入异 id', () => {
  const id1 = eventIdOf('600000', 'BUYBACK', 'fact:1');
  const id2 = eventIdOf('600000', 'BUYBACK', 'fact:1');
  const id3 = eventIdOf('600000', 'HOLDER_TRADE', 'fact:1');
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.match(id1, /^evt:[a-f0-9]{64}$/);
});
