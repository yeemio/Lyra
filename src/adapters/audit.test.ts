/**
 * Lyra · 年报审计意见适配器单测（A 类 A5 / W32: code-writer-pro）。不碰 docker、不碰网络、不碰 DB：
 * 判类规则表经合成年报文本注入（形态照真实探测：2026-10-25，600519 2018/2023 + 000657 2015，
 * 重要提示句 / 新式意见节 / 旧式"审计意见类型"摘要行 / 去空白伪影），桥响应用 fixture 注入。
 * 合同判定：判类优先级（无法表示意见 > 否定意见 > 保留意见 > 强调事项段/持续经营+无保留 >
 * 无保留意见）、多命中/零命中 → UNDETERMINED、无审计节 → 不产事实、季报/半年报只处理年报。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_ADAPTER_VERSION,
  AUDIT_EXCERPT_MAX,
  AUDIT_OPINION_UNDETERMINED,
  AuditAdapter,
  auditOpinionFactId,
  buildAuditOpinionFact,
  classifyAuditWindow,
  classifyAuditWindows,
  dockerPdfPath,
  extractReportYear,
  isAnnualReportTitle,
  normalizeAuditText,
  type AuditWindow,
  type AuditSourceAnnouncement,
} from './audit.js';
import { AdapterError } from './adapter-types.js';
import type { TimePointFact } from '../contracts.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function window(text: string, page = 2, anchor = '意见的审计报告'): AuditWindow {
  return { anchor, page, text };
}

// ===== 判类规则：五类各 ≥2 例 =====

test('标准无保留意见：重要提示句（新式）与旧式"审计意见类型"摘要行各判为一类', () => {
  const hit1 = classifyAuditWindow(
    window('重要提示\n一、本公司董事会……\n天职国际会计师事务所（特殊普通合伙）为本公司出具了标准无保留意见的审计报告。'),
  );
  assert.ok(hit1 !== null);
  assert.equal(hit1.type, '标准无保留意见');
  assert.equal(hit1.rule, 'R5 标准无保留意见');

  const hit2 = classifyAuditWindow(
    window('第十节 财务报告\n一、审计报告\n审计意见类型 标准无保留审计意见\n审计报告签署日期 2016 年 04 月 25 日\n审计机构名称 天职国际', 58, '审计意见'),
  );
  assert.ok(hit2 !== null);
  assert.equal(hit2.type, '标准无保留意见');
});

test('标准无保留意见：pypdf 词内空白伪影（"无保留 意见审计报告"）不丢命中', () => {
  const hit = classifyAuditWindow(
    window('监事会认为……不存在导致非标准无保留 意见审计报告\n的事项。', 55, '意见审计报告'),
  );
  assert.ok(hit !== null);
  assert.equal(hit.type, '标准无保留意见'); // "无保留意见"子串命中 R5（该句语义即无保留）
});

test('带强调事项段的无保留意见：强调事项段表述与持续经营重大不确定性表述各判为二类', () => {
  const hit1 = classifyAuditWindow(
    window('重要提示\n立信会计师事务所（特殊普通合伙）为本公司出具了带强调事项段的无保留意见的审计报告。'),
  );
  assert.ok(hit1 !== null);
  assert.equal(hit1.type, '带强调事项段（或持续经营相关重大不确定性）的无保留意见');
  assert.equal(hit1.rule.startsWith('R4'), true);

  // 准则原文句式：持续经营 与 重大不确定性 同句邻接（无"强调事项"字样）
  const hit2 = classifyAuditWindow(
    window(
      '四、与持续经营相关的重大不确定性\n我们提醒财务报表使用者关注……可能导致对公司持续经营能力\n产生重大疑虑的事项或情况存在重大不确定性。'
        + '……我们出具了无保留意见的审计报告。',
      61,
      '审计意见',
    ),
  );
  assert.ok(hit2 !== null);
  assert.equal(hit2.type, '带强调事项段（或持续经营相关重大不确定性）的无保留意见');
});

test('带强调事项段：R4 先于 R5 判定（无保留+强调事项不得落入标准无保留）', () => {
  const hit = classifyAuditWindow(window('……出具了带强调事项段的无保留意见的审计报告。我们认为，后附的财务报表……公允反映了……'));
  assert.ok(hit !== null);
  assert.equal(hit.type, '带强调事项段（或持续经营相关重大不确定性）的无保留意见');
});

test('保留意见：意见节标题句与重要提示句各判为三类', () => {
  const hit1 = classifyAuditWindow(
    window(
      '一、保留意见\n我们审计了……除"形成保留意见的基础"部分第 1 项所述事项的影响外，我们认为，后附的财务报表……公允反映了……',
      60,
      '审计意见',
    ),
  );
  assert.ok(hit1 !== null);
  assert.equal(hit1.type, '保留意见');
  assert.equal(hit1.rule.startsWith('R3'), true);

  const hit2 = classifyAuditWindow(window('重要提示\n……会计师事务所为本公司出具了保留意见的审计报告。'));
  assert.ok(hit2 !== null);
  assert.equal(hit2.type, '保留意见');
});

test('保留意见：旧式"保留审计意见"变体判为三类，"无保留审计意见"不误入三类', () => {
  const hit = classifyAuditWindow(
    window('一、审计报告\n审计意见类型 保留审计意见\n审计报告签署日期 2016 年 03 月 29 日', 58, '审计意见'),
  );
  assert.ok(hit !== null);
  assert.equal(hit.type, '保留意见');

  const standard = classifyAuditWindow(
    window('一、审计报告\n审计意见类型 标准无保留审计意见\n审计报告签署日期 2016 年 03 月 29 日', 58, '审计意见'),
  );
  assert.ok(standard !== null);
  assert.equal(standard.type, '标准无保留意见');
});

test('无法表示意见：意见段句式与重要提示句各判为四类', () => {
  const hit1 = classifyAuditWindow(
    window(
      '四、无法表示意见\n我们接受委托，审计了……我们无法获取充分、适当的审计证据，以为对后附财务报表发表审计意见提供基础，因此我们不对后附财务报表发表审计意见。',
      63,
      '审计意见',
    ),
  );
  assert.ok(hit1 !== null);
  assert.equal(hit1.type, '无法表示意见');
  assert.equal(hit1.rule.startsWith('R1'), true);

  const hit2 = classifyAuditWindow(window('重要提示\n……会计师事务所为本公司出具了无法表示意见的审计报告。'));
  assert.ok(hit2 !== null);
  assert.equal(hit2.type, '无法表示意见');
});

test('否定意见：意见段句式与重要提示句各判为五类', () => {
  const hit1 = classifyAuditWindow(
    window(
      '一、否定意见\n我们认为，由于"形成否定意见的基础"部分所述事项的重要性，后附的财务报表没有在企业会计准则规定的基础上公允反映……',
      60,
      '审计意见',
    ),
  );
  assert.ok(hit1 !== null);
  assert.equal(hit1.type, '否定意见');
  assert.equal(hit1.rule.startsWith('R2'), true);

  const hit2 = classifyAuditWindow(window('重要提示\n……会计师事务所为本公司出具了否定意见的审计报告。'));
  assert.ok(hit2 !== null);
  assert.equal(hit2.type, '否定意见');
});

// ===== 优先级与防误判 =====

test('优先级从强到弱：同窗并存多级关键词取最强（无法表示意见 > 无保留意见）', () => {
  const hit = classifyAuditWindow(
    window('……本年度出具了无法表示意见的审计报告（上年为标准无保留意见的审计报告）。'),
  );
  assert.ok(hit !== null);
  assert.equal(hit.type, '无法表示意见');
});

test('优先级：否定意见 > 保留意见 > 无保留意见', () => {
  const adverse = classifyAuditWindow(window('先说明上年为保留意见，本年最终出具了否定意见的审计报告。'));
  assert.ok(adverse !== null);
  assert.equal(adverse.type, '否定意见');
});

test('责任段"持续经营"不触发二类（探测实证：标准报告持续经营出现于责任段/关键审计事项）', () => {
  const hit = classifyAuditWindow(
    window(
      '……出具了标准无保留意见的审计报告。'
        + '注册会计师对财务报表审计的责任……评价管理层运用持续经营假设的适当性，披露与持续经营相关的事项（如适用），并运用持续经营假设……',
    ),
  );
  assert.ok(hit !== null);
  assert.equal(hit.type, '标准无保留意见'); // 持续经营无"重大不确定性"邻接 → 不入 R4，落 R5
});

test('责任段模板实证片段不误命中（600519 2018 实测原文）："非无保留意见"与"是否存在重大不确定性"', () => {
  // 片段 1：责任段否定式——仅含"非无保留意见" → 零命中（不落入 R4/R5）
  const boilerplateOnly = classifyAuditWindow(
    window(
      '……如果披露不充分，我们应当发表非无保留意见。我们的结论基于截至审计报告日可获得的信息。然而，未来的事项或情况可能导致……',
      50,
      '审计意见',
    ),
  );
  assert.equal(boilerplateOnly, null);

  // 片段 2：假设式持续经营句 + 真实无保留意见表述同窗 → 仍判标准无保留（不入 R4）
  const mixed = classifyAuditWindow(
    window(
      '三、天职国际会计师事务所（特殊普通合伙）为本公司出具了标准无保留意见的审计报告。'
        + '（四）对管理层使用持续经营假设的恰当性得出结论。同时，根据获取的审计证据，就可能导致对贵州茅台公司'
        + '持续经营能力产生重大疑虑的事项或情况是否存在重大不确定性得出结论。如果我们得出结论认为存在重大不确定性，'
        + '审计准则要求我们在审计报告中提醒财务报表使用者注意财务报表中的相关披露；如果披露不充分，我们应当发表非无保留意见。',
    ),
  );
  assert.ok(mixed !== null);
  assert.equal(mixed.type, '标准无保留意见');
});

// ===== UNDETERMINED（多命中 / 零命中）与无审计节 =====

test('UNDETERMINED：多窗口命中冲突带全部候选摘录，不猜', () => {
  const result = classifyAuditWindows([
    window('……出具了标准无保留意见的审计报告。', 2),
    window('一、保留意见\n除……影响外，我们认为……', 60, '审计意见'),
  ]);
  assert.ok(result !== null);
  assert.equal(result.status, 'UNDETERMINED');
  assert.equal(result.type, AUDIT_OPINION_UNDETERMINED);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((c) => c.类型).sort(),
    ['保留意见', '标准无保留意见'].sort(),
  );
  assert.ok(result.判类说明.includes('多命中冲突'));
});

test('UNDETERMINED：零命中带首窗摘录、候选为空（新式标准意见节窗口实证形态）', () => {
  const result = classifyAuditWindows([
    window(
      '一、审计意见\n我们审计了后附的财务报表……我们认为，后附的财务报表在所有重大方面按照企业会计准则的规定编制，公允反映了……',
      56,
      '审计意见',
    ),
  ]);
  assert.ok(result !== null);
  assert.equal(result.status, 'UNDETERMINED');
  assert.equal(result.candidates.length, 0);
  assert.ok(result.excerpt.length > 0);
  assert.ok(result.判类说明.includes('零命中'));
});

test('无审计节：窗口为空 → classifyAuditWindows 返回 null（适配器层判 NO_AUDIT_SECTION）', () => {
  assert.equal(classifyAuditWindows([]), null);
});

test('摘录上限 200 字且含命中关键词上下文', () => {
  const long = '甲'.repeat(500) + '为本公司出具了标准无保留意见的审计报告。' + '乙'.repeat(500);
  const hit = classifyAuditWindow(window(long));
  assert.ok(hit !== null);
  assert.ok(hit.excerpt.length <= AUDIT_EXCERPT_MAX);
  assert.ok(hit.excerpt.includes('标准无保留意见'));
});

test('normalizeAuditText：去空白归一并保留中文原文', () => {
  assert.equal(normalizeAuditText('无保留 意见\n审计报告\t事项'), '无保留意见审计报告事项');
});

// ===== 标题规则（只处理年报；季报/半年报/摘要/英文/已取消跳过）=====

test('isAnnualReportTitle：年报各形态收录', () => {
  assert.equal(isAnnualReportTitle('2015年年度报告'), true);
  assert.equal(isAnnualReportTitle('贵州茅台2023年年度报告'), true);
  assert.equal(isAnnualReportTitle('招商银行股份有限公司2025年度报告'), true);
  assert.equal(isAnnualReportTitle('2020年年度报告（更新版）'), true);
  assert.equal(isAnnualReportTitle('H股市场公告-洛阳钼业2025年年度报告（H股）'), true);
});

test('isAnnualReportTitle：半年报/季报/摘要/英文/已取消排除（"半年度报告"含"年度报告"子串）', () => {
  assert.equal(isAnnualReportTitle('2015年半年度报告'), false);
  assert.equal(isAnnualReportTitle('2015年半年度报告摘要'), false);
  assert.equal(isAnnualReportTitle('2020年年度报告摘要'), false);
  assert.equal(isAnnualReportTitle('2021年年度报告（英文版）'), false);
  assert.equal(isAnnualReportTitle('2019年年度报告（已取消）'), false);
  assert.equal(isAnnualReportTitle('2015年第一季度报告'), false);
  assert.equal(isAnnualReportTitle('2015年第三季度报告'), false);
  assert.equal(isAnnualReportTitle('2025年半年度报告（更新版）'), false);
});

test('extractReportYear：标题四位数年提取，无年不猜', () => {
  assert.equal(extractReportYear('2015年年度报告'), '2015');
  assert.equal(extractReportYear('贵州茅台2023年年度报告'), '2023');
  assert.equal(extractReportYear('H股市场公告-洛阳钼业2025年年度报告（H股）'), '2025');
  assert.equal(extractReportYear('洛阳钼业年度报告信息披露重大差错责任追究管理制度'), null);
});

// ===== 事实映射 =====

const ANNOUNCEMENT: AuditSourceAnnouncement = {
  factId: 'cninfo:ann:1209495421@p1',
  subjectId: '600519',
  title: '贵州茅台2020年年度报告',
  availableAt: '2021-04-01T00:00:00.000Z', // cninfo@p1 日精度 D+1 策略产出
  sourcePublishedAt: '2021-03-31T16:00:00.000Z',
  pdfSha256: SHA_A,
};

function classifiedFact(): TimePointFact {
  const classification = classifyAuditWindows([window('重要提示\n……出具了标准无保留意见的审计报告。')]);
  assert.ok(classification !== null && classification.status === 'CLASSIFIED');
  return buildAuditOpinionFact({ announcement: ANNOUNCEMENT, classification, extractedAt: '2026-10-25T08:00:00.000Z' });
}

test('事实映射：typedValue 含类型/摘录/报告年度/pdfSha256/证据绑定/标题', () => {
  const fact = classifiedFact();
  assert.equal(fact.factKind, 'AUDIT_OPINION');
  assert.equal(fact.subjectType, 'STOCK');
  assert.equal(fact.subjectId, '600519');
  assert.equal(fact.adapterVersion, AUDIT_ADAPTER_VERSION);
  const tv = fact.typedValue as Record<string, unknown>;
  assert.equal(tv['类型'], '标准无保留意见');
  assert.equal(tv['报告年度'], '2020');
  assert.equal(tv['pdfSha256'], SHA_A);
  assert.equal(tv['announcementFactId'], ANNOUNCEMENT.factId); // 年报 ANNOUNCEMENT 证据绑定（派发要求）
  assert.equal(tv['年报标题'], ANNOUNCEMENT.title);
  assert.ok(typeof tv['摘录'] === 'string' && (tv['摘录'] as string).length > 0);
  assert.ok(Array.isArray(tv['候选']) && (tv['候选'] as unknown[]).length === 1);
});

test('事实映射：五时间字段复用年报公告口径，原件哈希即证据', () => {
  const fact = classifiedFact();
  assert.equal(fact.availableAt, ANNOUNCEMENT.availableAt); // 派发冻结：复用 ANNOUNCEMENT.availableAt
  assert.equal(fact.eventAt, ANNOUNCEMENT.availableAt);
  assert.equal(fact.sourcePublishedAt, ANNOUNCEMENT.sourcePublishedAt);
  assert.equal(fact.validFrom, null);
  assert.equal(fact.validTo, null);
  assert.equal(fact.artifactSha256, SHA_A); // 原件即年报 PDF 本体
  assert.equal(fact.supersedesFactId, null);
});

test('factId 确定性：同证据同版本同 id；证据（PDF 哈希）不同即新事实；规则变更走新版本号', () => {
  const fact = classifiedFact();
  assert.equal(fact.factId, auditOpinionFactId(ANNOUNCEMENT.factId, SHA_A));
  assert.equal(fact.factId, classifiedFact().factId); // 重放同 id（判类结果不入身份，防同版本双事实）
  assert.notEqual(fact.factId, auditOpinionFactId(ANNOUNCEMENT.factId, SHA_B));
});

// ===== 适配器（fixture 桥注入；不碰 docker）=====

test('适配器批量：FACT / NO_AUDIT_SECTION / 哈希不符 ERROR / 桥单份失败 ERROR', async () => {
  const goodSha = '1'.repeat(64);
  const noAuditSha = '2'.repeat(64);
  const hashMismatchSha = '3'.repeat(64);
  const pdfFailSha = '4'.repeat(64);
  const seen: string[][] = [];
  const adapter = new AuditAdapter({
    execBridge: async (args) => {
      seen.push(args);
      return {
        ok: true,
        results: [
          {
            ok: true,
            path: dockerPdfPath(goodSha),
            sha256: goodSha,
            pages: 143,
            textLen: 160515,
            windows: [window('重要提示\n……为本公司出具了标准无保留意见的审计报告。', 2)],
          },
          {
            ok: true,
            path: dockerPdfPath(noAuditSha),
            sha256: noAuditSha,
            pages: 2,
            textLen: 800,
            windows: [], // 无审计节锚点（如业绩说明会公告）
          },
          {
            ok: true,
            path: dockerPdfPath(hashMismatchSha),
            sha256: 'f'.repeat(64), // 桥算得哈希 ≠ 登记
            pages: 100,
            textLen: 90000,
            windows: [window('标准无保留意见的审计报告')],
          },
          {
            ok: false,
            path: dockerPdfPath(pdfFailSha),
            error_code: 'AUDIT_PDF_FAILED',
            error: 'PdfReadError: stream is broken',
          },
        ],
      };
    },
  });
  const mk = (sha: string): AuditSourceAnnouncement => ({ ...ANNOUNCEMENT, pdfSha256: sha });
  const results = await adapter.extractAnnualReportBatch([
    mk(goodSha),
    mk(noAuditSha),
    mk(hashMismatchSha),
    mk(pdfFailSha),
  ]);
  // 单次桥调用、extract 子命令、容器内 CAS 分片路径
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], 'extract');
  assert.deepEqual(
    seen[0]!.slice(1),
    [goodSha, noAuditSha, hashMismatchSha, pdfFailSha].map((sha) => `/work/data/artifacts/${sha.slice(0, 2)}/${sha}`),
  );
  assert.equal(results[0]!.status, 'FACT');
  if (results[0]!.status === 'FACT') {
    assert.equal(results[0]!.classification.type, '标准无保留意见');
    assert.equal(results[0]!.fact.factKind, 'AUDIT_OPINION');
    assert.equal(results[0]!.pages, 143);
  }
  assert.equal(results[1]!.status, 'NO_AUDIT_SECTION');
  if (results[1]!.status === 'NO_AUDIT_SECTION') {
    assert.ok(results[1]!.reason.includes('疑似扫描件'));
  }
  assert.equal(results[2]!.status, 'ERROR');
  if (results[2]!.status === 'ERROR') assert.equal(results[2]!.code, 'AUDIT_PDF_HASH_MISMATCH');
  assert.equal(results[3]!.status, 'ERROR');
  if (results[3]!.status === 'ERROR') assert.equal(results[3]!.code, 'AUDIT_PDF_FAILED');
});

test('dockerPdfPath：sha 形态校验与 CAS 分片路径', () => {
  assert.equal(dockerPdfPath(SHA_A), `/work/data/artifacts/${SHA_A.slice(0, 2)}/${SHA_A}`);
  assert.throws(() => dockerPdfPath('xyz'), (e: unknown) => e instanceof AdapterError && e.code === 'AUDIT_PDF_SHA_INVALID');
});
