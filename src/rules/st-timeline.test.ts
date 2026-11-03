/**
 * Lyra · ST 时点表单测（W16: code-writer）。
 * 合同判定：ASHARE-RULES §3（四类事件识别、区间不重叠连续、三条禁令、生效日）+
 * P-i-T §3.1（D+1 开盘前）+ 派发（默认状态 DEFAULT_BEFORE_EVIDENCE 标记、AMBIGUOUS 不猜、区间合并）。
 * 标注"真实"的标题取自全库 ANNOUNCEMENT 扫描（2026-10-25，证据见 st-timeline.ts 头注），
 * 其余为按真实形态构造的合成标题。DB 路径用隔离 schema，不碰 public 生产表。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { after, before, test } from 'node:test';
import { createPool } from '../db/pool.js';
import {
  applyStMigration,
  beijingDayOf,
  buildSubjectTimeline,
  classifyStTitle,
  loadStatusIntervals,
  stEffectiveDay,
  stStatusAt,
  stStatusAtFromIntervals,
  type StAnnouncementInput,
  type StIntervalRow,
} from './st-timeline.js';

// ===== 标题分类 =====

test('实施退市风险警示 → *ST：正例 ≥3（含真实标题）', () => {
  const cases = [
    '关于公司股票被实施退市风险警示的公告', // 真实：600150 2018-04-24
    '关于公司股票被实施退市风险警示（*ST）的公告', // 派发预期形态（带括注）
    'XX控股关于公司股票实施退市风险警示的公告', // 无"被"字变体
    '关于公司股票被实施退市风险警示暨停牌的公告', // 暨伴生事项变体
  ];
  for (const t of cases) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'EVENT', t);
    if (c.kind !== 'EVENT') return;
    assert.equal(c.to, '*ST', t);
    assert.equal(c.ruleId, 'IMPLEMENT_DELIST_RISK_WARNING', t);
  }
});

test('实施其他风险警示 → ST：正例 ≥3（合成，派发预期形态）', () => {
  const cases = [
    '关于公司股票被实施其他风险警示（ST）的公告', // 派发预期形态
    '关于公司股票被实施其他风险警示的公告',
    'XX股份关于公司股票实施其他风险警示的公告',
    '关于公司股票被实施其他风险警示暨停牌一天公告',
  ];
  for (const t of cases) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'EVENT', t);
    if (c.kind !== 'EVENT') return;
    assert.equal(c.to, 'ST', t);
    assert.equal(c.ruleId, 'IMPLEMENT_OTHER_RISK_WARNING', t);
  }
});

test('撤销退市风险警示（无共现）→ NORMAL：正例 ≥3（含真实标题）', () => {
  const cases = [
    '关于公司股票撤销退市风险警示的公告', // 真实：600150 2019-03-29
    '关于撤销公司股票退市风险警示的公告',
    '关于公司股票撤销退市风险警示暨复牌的公告', // 暨复牌变体
    'XX股份关于公司股票撤销退市风险警示的公告',
  ];
  for (const t of cases) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'EVENT', t);
    if (c.kind !== 'EVENT') return;
    assert.equal(c.to, 'NORMAL', t);
    assert.equal(c.ruleId, 'REVOKE_DELIST_RISK_WARNING', t);
  }
});

test('撤销其他风险警示 → NORMAL：正例 ≥3（合成）', () => {
  const cases = [
    '关于公司股票撤销其他风险警示的公告',
    '关于撤销公司股票其他风险警示的公告',
    'XX股份关于公司股票撤销其他风险警示（ST）的公告',
    '关于公司股票撤销其他风险警示暨复牌的公告',
  ];
  for (const t of cases) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'EVENT', t);
    if (c.kind !== 'EVENT') return;
    assert.equal(c.to, 'NORMAL', t);
    assert.equal(c.ruleId, 'REVOKE_OTHER_RISK_WARNING', t);
  }
});

test('排除：预告 / 申请 / 警示函 / 无关键词（真实假阳性形态）', () => {
  const none: readonly (readonly [string, RegExp])[] = [
    ['关于公司股票可能被实施退市风险警示的提示性公告', /EXCLUDE_POSSIBLE_FUTURE/], // 真实 600150
    ['关于公司股票可能被实施退市风险警示的第三次提示性公告', /EXCLUDE_POSSIBLE_FUTURE/], // 真实 600150
    ['关于申请撤销公司股票退市风险警示的公告', /EXCLUDE_APPLICATION/], // 真实 600150 2019-03-21
    ['关于监事收到深圳证监局警示函的公告', /EXCLUDE_REGULATORY_LETTER/], // 真实 大族激光
    ['关于收到湖北证监局警示函和对公司相关人员采取监管谈话措施的公告', /EXCLUDE_REGULATORY_LETTER/], // 真实 光迅
    ['贵州茅台关于修订公司《章程》及附件暨撤销监事会的公告', /NO_KEYWORD/], // 真实 茅台（撤销监事会）
    ['中国船舶关于披露重组预案的一般风险提示暨公司股票复牌的公告', /NO_KEYWORD/], // 真实 一般风险提示
    ['宏和科技股票交易异常波动暨风险提示公告', /NO_KEYWORD/], // 真实 风险提示
    ['关于公司股票可能被暂停上市的风险提示公告', /NO_KEYWORD/], // 真实 600150 暂停上市提示
    ['关于MFLX公司完成NASDAQ退市程序的公告', /NO_KEYWORD/], // 真实 境外子公司退市
    ['关于控股子公司终止上市辅导的提示性公告', /NO_KEYWORD/], // 真实 上市辅导
    ['中信证券股份有限公司关于公司恢复上市持续督导保荐总结报告书', /NO_KEYWORD/], // 真实 恢复上市督导
    ['关于许可韩国DONG-AST公司SHR-1701的公告', /NO_KEYWORD/], // 真实 含ST字样假阳性（公司名）
  ];
  for (const [t, re] of none) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'NONE', t);
    if (c.kind !== 'NONE') return;
    assert.match(c.reason, re, t);
  }
});

test('AMBIGUOUS 分支：摘帽俗称 / 撤销退市共现其他 / 未预见风险警示形态（不猜）', () => {
  const amb: readonly (readonly [string, RegExp])[] = [
    ['关于公司股票摘帽的公告', /AMBIGUOUS_INFORMAL_HAT_TERM/], // 俗称：摘的是 ST 帽还是 *ST 帽不明
    ['关于撤销公司股票退市风险警示及其他风险警示的公告', /AMBIGUOUS_REVOKE_DELIST_WITH_OTHER_COOCCUR/], // 双撤销共现
    ['关于公司股票撤销退市风险警示暨被实施其他风险警示的公告', /AMBIGUOUS_REVOKE_DELIST_WITH_OTHER_COOCCUR/], // 混合形态
    ['关于公司股票风险警示情况的公告', /AMBIGUOUS_UNCLASSIFIED_RISK_WARNING/], // 未预见新形态
    ['关于公司股票被实行退市风险警示的公告', /AMBIGUOUS_UNCLASSIFIED_RISK_WARNING/], // "实行"≠"实施"（合成近似形态，宁歧义不猜）
  ];
  for (const [t, re] of amb) {
    const c = classifyStTitle(t);
    assert.equal(c.kind, 'AMBIGUOUS', t);
    if (c.kind !== 'AMBIGUOUS') return;
    assert.match(c.reason, re, t);
  }
});

// ===== 生效日 =====

test('生效日 = 公告日次日：日精度与盘中时刻两类公告、缺失回退 available_at', () => {
  // 真实锚点：600150 实施 *ST，announcementTime = 2018-04-23 00:00 CST（= 2018-04-22T16:00Z）
  const a = stEffectiveDay({
    factId: 'f1',
    subjectId: '600150',
    title: '关于公司股票被实施退市风险警示的公告',
    sourcePublishedAt: '2018-04-22T16:00:00.000Z',
    availableAt: '2018-04-24T00:00:00.000Z', // D+1 08:00 CST（P-i-T §3.1 落点）
  });
  assert.deepEqual(a, { day: '2018-04-24', from: 'SOURCE_PUBLISHED_AT_PLUS_1' });
  assert.equal(beijingDayOf(new Date('2018-04-22T16:00:00.000Z').getTime()), '2018-04-23'); // 公告日

  // 盘中时刻公告（真实形态：少数带盘中时刻，17:05 CST）→ 公告日次日
  const b = stEffectiveDay({
    factId: 'f2',
    subjectId: '600000',
    title: '关于公司股票被实施其他风险警示（ST）的公告',
    sourcePublishedAt: '2020-01-06T09:05:00.000Z', // 2020-01-06 17:05 CST
    availableAt: '2020-01-07T00:00:00.000Z',
  });
  assert.deepEqual(b, { day: '2020-01-07', from: 'SOURCE_PUBLISHED_AT_PLUS_1' });

  // source_published_at 缺失 → 回退 available_at 的北京日（已按合同落在 D+1 开盘前）
  const c = stEffectiveDay({
    factId: 'f3',
    subjectId: '600000',
    title: '关于公司股票撤销退市风险警示的公告',
    sourcePublishedAt: null,
    availableAt: '2019-03-29T00:00:00.000Z',
  });
  assert.deepEqual(c, { day: '2019-03-29', from: 'AVAILABLE_AT_DAY' });
});

// ===== 区间构建 =====

function ann(factId: string, subjectId: string, title: string, publishedIso: string): StAnnouncementInput {
  return {
    factId,
    subjectId,
    title,
    sourcePublishedAt: publishedIso,
    availableAt: new Date(new Date(publishedIso).getTime() + 32 * 60 * 60 * 1000).toISOString(), // D+1 08:00 CST 近似
    shortNameAtPublication: '测试股',
  };
}

test('600150 真实序列重放：两区间、精确日期、末区间开区间', () => {
  const r = buildSubjectTimeline('600150', [
    ann('fa', '600150', '关于公司股票可能被实施退市风险警示的提示性公告', '2018-01-31T16:00:00.000Z'), // 真实排除
    ann('fb', '600150', '关于公司股票可能被实施退市风险警示的第二次提示性公告', '2018-03-21T16:00:00.000Z'),
    ann('fc', '600150', '关于公司股票可能被实施退市风险警示的第三次提示性公告', '2018-04-15T16:00:00.000Z'),
    ann('fd', '600150', '关于公司股票被实施退市风险警示的公告', '2018-04-22T16:00:00.000Z'), // → *ST @2018-04-24
    ann('fe', '600150', '关于公司股票可能被暂停上市的风险提示公告', '2019-01-20T16:00:00.000Z'), // 真实排除
    ann('ff', '600150', '关于申请撤销公司股票退市风险警示的公告', '2019-03-20T16:00:00.000Z'), // 真实排除
    ann('fg', '600150', '关于公司股票撤销退市风险警示的公告', '2019-03-27T16:00:00.000Z'), // → NORMAL @2019-03-29
  ]);
  assert.equal(r.conflictSameDay, null);
  assert.deepEqual(r.ambiguous, []);
  assert.equal(r.skipped.length, 5);
  assert.equal(r.intervals.length, 2);

  const i0 = r.intervals[0];
  const i1 = r.intervals[1];
  assert.ok(i0 && i1);
  assert.deepEqual([i0.status, i0.effectiveFrom, i0.effectiveTo], ['*ST', '2018-04-24', '2019-03-29']);
  assert.deepEqual([i1.status, i1.effectiveFrom, i1.effectiveTo], ['NORMAL', '2019-03-29', null]);
  assert.equal(i0.evidenceFactId, 'fd');
  assert.equal(i1.evidenceFactId, 'fg');
  assert.equal(i0.evidenceEventId, null); // ST 公告不属六类事件，字段保留恒 null
  assert.equal(i0.shortNameAtPublication, '测试股');
});

test('区间构建：生效日乱序输入按日切段；同日同状态去重不切段', () => {
  const r = buildSubjectTimeline('600000', [
    ann('f2', '600000', '关于公司股票撤销退市风险警示的公告', '2020-05-10T16:00:00.000Z'), // → NORMAL @05-12
    ann('f1', '600000', '关于公司股票被实施其他风险警示（ST）的公告', '2019-01-02T16:00:00.000Z'), // → ST @01-04
    ann('f3', '600000', '关于公司股票被实施其他风险警示的公告', '2019-01-03T16:00:00.000Z'), // 同状态冗余（01-04）
  ]);
  assert.equal(r.intervals.length, 2);
  const [i0, i1] = [r.intervals[0], r.intervals[1]];
  assert.ok(i0 && i1);
  assert.deepEqual([i0.status, i0.effectiveFrom, i0.effectiveTo], ['ST', '2019-01-04', '2020-05-12']);
  assert.deepEqual([i1.status, i1.effectiveFrom, i1.effectiveTo], ['NORMAL', '2020-05-12', null]);
  assert.ok(r.skipped.some((s) => s.reason.startsWith('REDUNDANT_SAME_STATUS')));
});

test('区间构建：同日互斥目标 → 整股拒建（不猜择一）', () => {
  const r = buildSubjectTimeline('600000', [
    ann('f1', '600000', '关于公司股票被实施其他风险警示（ST）的公告', '2019-01-02T16:00:00.000Z'),
    ann('f2', '600000', '关于公司股票撤销退市风险警示的公告', '2019-01-02T16:00:00.000Z'), // 同日 → NORMAL
  ]);
  assert.deepEqual(r.intervals, []);
  assert.ok(r.conflictSameDay);
  assert.deepEqual(r.conflictSameDay.targets, ['ST', 'NORMAL']);
});

test('区间构建：AMBIGUOUS 不产生区间、逐条具名留审计', () => {
  const r = buildSubjectTimeline('600000', [
    ann('f1', '600000', '关于公司股票摘帽的公告', '2019-01-02T16:00:00.000Z'),
  ]);
  assert.deepEqual(r.intervals, []);
  assert.equal(r.ambiguous.length, 1);
  assert.match(r.ambiguous[0]?.reason ?? '', /AMBIGUOUS_INFORMAL_HAT_TERM/);
});

test('区间构建：首事件即撤销也机械成立（首区间自撤销日起，之前保持默认）', () => {
  const r = buildSubjectTimeline('600000', [
    ann('f1', '600000', '关于公司股票撤销退市风险警示的公告', '2016-01-04T16:00:00.000Z'),
  ]);
  assert.equal(r.intervals.length, 1);
  const i0 = r.intervals[0];
  assert.ok(i0);
  assert.deepEqual([i0.status, i0.effectiveFrom, i0.effectiveTo], ['NORMAL', '2016-01-06', null]);
});

// ===== 查询（纯函数）=====

function iv(subject: string, status: StIntervalRow['status'], from: string, to: string | null): StIntervalRow {
  return {
    subject,
    status,
    effectiveFrom: from,
    effectiveTo: to,
    evidenceFactId: 'f',
    evidenceEventId: null,
    evidencePublishedAt: '2019-01-01T16:00:00.000Z',
    evidenceAvailableAt: '2019-01-03T00:00:00.000Z',
    shortNameAtPublication: null,
  };
}

test('stStatusAtFromIntervals：区间边界 [from, to) 语义 + 默认状态标记', () => {
  const rows = [iv('600150', '*ST', '2018-04-24', '2019-03-29'), iv('600150', 'NORMAL', '2019-03-29', null)];
  // 覆盖内
  assert.deepEqual(stStatusAtFromIntervals('600150', '2018-04-24', rows), { status: '*ST', basis: 'EVIDENCED', effectiveFrom: '2018-04-24' });
  assert.deepEqual(stStatusAtFromIntervals('600150', '2019-03-28', rows), { status: '*ST', basis: 'EVIDENCED', effectiveFrom: '2018-04-24' });
  assert.deepEqual(stStatusAtFromIntervals('600150', '2019-03-29', rows), { status: 'NORMAL', basis: 'EVIDENCED', effectiveFrom: '2019-03-29' });
  assert.deepEqual(stStatusAtFromIntervals('600150', '2026-10-25', rows), { status: 'NORMAL', basis: 'EVIDENCED', effectiveFrom: '2019-03-29' });
  // 早于首个证据日 → 默认 NORMAL + 诚实标记
  assert.deepEqual(stStatusAtFromIntervals('600150', '2018-04-23', rows), { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' });
  assert.deepEqual(stStatusAtFromIntervals('600150', '2015-01-01', rows), { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' });
  // Date 归一
  assert.equal(stStatusAtFromIntervals('600150', new Date('2018-04-24T00:00:00.000Z'), rows).status, '*ST');
});

test('stStatusAtFromIntervals：无任何证据的股票 → 全默认 + 标记；覆盖内空隙 → 具名错误', () => {
  assert.deepEqual(stStatusAtFromIntervals('999999', '2020-01-01', []), { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' });
  const gapped = [iv('600000', 'ST', '2019-01-04', '2019-03-01'), iv('600000', 'ST', '2019-04-01', null)];
  assert.throws(() => stStatusAtFromIntervals('600000', '2019-03-15', gapped), /ST_TIMELINE_GAP/);
  assert.equal(stStatusAtFromIntervals('600000', '2019-02-01', gapped).status, 'ST');
});

// ===== DB 路径（隔离 schema）=====

const SCHEMA = `w16_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;

before(async () => {
  adminPool = createPool();
  pool = createPool({ schema: SCHEMA });
  await applyStMigration(adminPool, SCHEMA);
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
});

test('迁移 + 落表 + stStatusAt 读回（含 basis 标记与 GAP 防线）', async () => {
  const intervals = buildSubjectTimeline('600150', [
    ann('fd', '600150', '关于公司股票被实施退市风险警示的公告', '2018-04-22T16:00:00.000Z'),
    ann('fg', '600150', '关于公司股票撤销退市风险警示的公告', '2019-03-27T16:00:00.000Z'),
  ]).intervals;
  assert.equal(intervals.length, 2);
  for (const r of intervals) {
    await pool.query(
      `insert into st_status_timeline
         (subject, status, effective_from, effective_to, evidence_fact_id, evidence_event_id,
          evidence_published_at, evidence_available_at, short_name_at_publication, builder_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        r.subject,
        r.status,
        r.effectiveFrom,
        r.effectiveTo,
        r.evidenceFactId,
        r.evidenceEventId,
        r.evidencePublishedAt,
        r.evidenceAvailableAt,
        r.shortNameAtPublication,
        'st-timeline-test',
      ],
    );
  }
  const loaded = await loadStatusIntervals(pool, '600150');
  assert.equal(loaded.length, 2);
  assert.deepEqual([loaded[0]?.status, loaded[0]?.effectiveFrom, loaded[0]?.effectiveTo], ['*ST', '2018-04-24', '2019-03-29']);
  assert.deepEqual([loaded[1]?.status, loaded[1]?.effectiveFrom, loaded[1]?.effectiveTo], ['NORMAL', '2019-03-29', null]);

  assert.equal((await stStatusAt('600150', '2018-04-24', pool)).status, '*ST');
  assert.equal((await stStatusAt('600150', '2018-04-24', pool)).basis, 'EVIDENCED');
  assert.equal((await stStatusAt('600150', '2019-03-29', pool)).status, 'NORMAL');
  const before = await stStatusAt('600150', '2018-04-23', pool);
  assert.deepEqual(before, { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' });
  const unknown = await stStatusAt('999999', '2020-01-01', pool);
  assert.deepEqual(unknown, { status: 'NORMAL', basis: 'DEFAULT_BEFORE_EVIDENCE' });
});
