/**
 * W25 单测 · 程序清单 deriveChecklist 追加式扩展（DIMENSION_COVERAGE，REVISION-LOG 登记缺口）。
 * 纯函数测试：零 DB、零模型、零 spawn。
 * 覆盖：带覆盖包派生条目数=维度数（基础条目同切 p2 前缀）；空维度程序单列缺口项形态
 * （aText 固定文案 + sourceHash 公式）；aText 160 字截断；提及来源顺序（decisiveLinks 先于
 * limitations）与无提及回退；无覆盖包时与 P0 冻结哈希逐字节一致；rederive 有/无包对称；
 * 宽基七维逐维度成条。
 * P0 基准哈希（6c2efd…8879）于改动前由现行实现捕获并冻结于此，钉扎"追加不改旧行为"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A_TEXT_MAX,
  deriveChecklist,
  rederiveChecklistHash,
  type DimensionCoveragePkg,
} from './checklist.js';
import { canonicalSha256 } from '../canonical.js';
import type { AOutput } from '../contracts.js';

const MANIFEST = 'ab'.repeat(32);

// 改动前捕获的 P0 冻结值（夹具 = A_FIXTURE + MANIFEST；勿改夹具，否则钉扎失效）
const P0_FROZEN = {
  checklistHash: '6c2efde0ea2471836595b602e2368c7d295f8562d8219638a611f79ae04b8879',
  checklistId: 'checklist:p0:ddab2509444e:abababab',
  itemIds: [
    'check:p0:DECISIVE_LINK:0',
    'check:p0:DECISIVE_LINK:1',
    'check:p0:STRONGEST_COUNTER:0',
    'check:p0:CANDIDATE:0',
    'check:p0:SELECTION_THRESHOLD:0',
  ],
};

const A_FIXTURE: AOutput = {
  stage: 'A',
  inputHash: '11'.repeat(32),
  subjectKind: 'STOCK',
  candidate: 'RESEARCH_OUTPERFORM',
  decisiveLinks: [
    { text: `估值维度长文本：${'x'.repeat(190)}`, evidenceArtifactSha256: 'aa'.repeat(32) },
    { text: '基本面变化维度出现营收拐点', evidenceArtifactSha256: 'bb'.repeat(32) },
  ],
  strongestCounter: '最强反证：换手率抬升',
  confidence: 'MEDIUM',
  limitations: ['历史事件参照维度本轮无材料', '普通限制说明'],
  simulated: true,
};

const BROAD_A_FIXTURE: AOutput = {
  stage: 'A',
  inputHash: '22'.repeat(32),
  subjectKind: 'BROAD_ETF',
  candidate: 'RESEARCH_UP',
  decisiveLinks: [{ text: '估值分位处于近十年偏低区间', evidenceArtifactSha256: 'cc'.repeat(32) }],
  strongestCounter: '成分盈利趋势可能下修',
  confidence: 'LOW',
  limitations: ['历史状态参照暂缺'],
  simulated: true,
};

/** 个股八维（DimensionRule 名称，src/research/inputs.ts）。 */
const STOCK_DIMS = ['基本面变化', '估值', '预期差', '公司事件', '资金与价格行为', '行业景气', '风险项', '历史事件参照'];
/** 宽基七维。 */
const BROAD_DIMS = ['估值分位', '成分盈利趋势', '宏观与政策', '资金', '价格行为与市场宽度', '风格相对', '历史状态参照'];

test('无覆盖包：与 P0 冻结哈希逐字节一致，id 前缀保持 check:p0:/checklist:p0:，无 DIMENSION_COVERAGE', () => {
  const checklist = deriveChecklist(A_FIXTURE, MANIFEST);
  assert.equal(checklist.checklistHash, P0_FROZEN.checklistHash, 'checklistHash 与改动前 P0 实现逐字节一致');
  assert.equal(checklist.checklistId, P0_FROZEN.checklistId);
  assert.deepEqual(checklist.items.map((i) => i.checklistId), P0_FROZEN.itemIds);
  assert.ok(checklist.items.every((i) => i.category !== 'DIMENSION_COVERAGE'), '无覆盖包不产生维度条目');
  assert.equal(rederiveChecklistHash(A_FIXTURE, MANIFEST), P0_FROZEN.checklistHash, '两参 rederive 与冻结哈希一致');
  assert.ok(checklist.items.every((i) => i.aText.length <= A_TEXT_MAX), 'P0 条目 aText 不超上限');
});

test('带覆盖包派生：维度覆盖条目数=维度数，基础条目与清单身份同切 p2 前缀，assessment 恒 NOT_ASSESSED', () => {
  const pkg: DimensionCoveragePkg = {
    dimensions: STOCK_DIMS.map((dimension) => ({ dimension, deliveredCount: 2, gap: [] })),
  };
  const checklist = deriveChecklist(A_FIXTURE, MANIFEST, pkg);
  const dimItems = checklist.items.filter((i) => i.category === 'DIMENSION_COVERAGE');
  assert.equal(dimItems.length, STOCK_DIMS.length, '覆盖条目数 = 八维度数');
  assert.equal(checklist.items.length, 5 + STOCK_DIMS.length, '基础条目（2 决定性连接 + 3 单类）+ 八维度覆盖条目');
  assert.deepEqual(
    checklist.items.filter((i) => !i.category.startsWith('DIMENSION')).map((i) => i.checklistId),
    [
      'check:p2:DECISIVE_LINK:0',
      'check:p2:DECISIVE_LINK:1',
      'check:p2:STRONGEST_COUNTER:0',
      'check:p2:CANDIDATE:0',
      'check:p2:SELECTION_THRESHOLD:0',
    ],
    '带包派生整体为 p2：基础条目前缀同切 check:p2:',
  );
  assert.ok(checklist.checklistId.startsWith('checklist:p2:'), '清单身份前缀 checklist:p2:');
  assert.deepEqual(
    dimItems.map((i) => i.checklistId),
    STOCK_DIMS.map((_, index) => `check:p2:DIMENSION_COVERAGE:${index}`),
    '覆盖条目 id 按维度序连续编号',
  );
  assert.ok(checklist.items.every((i) => i.assessment === 'NOT_ASSESSED'), '全部 assessment 仍 NOT_ASSESSED');
  assert.notEqual(checklist.checklistHash, P0_FROZEN.checklistHash, '带包派生哈希区别于 P0');
});

test('空维度单列项：deliveredCount=0 且 gap 非空 → 程序缺口项（固定文案 + sourceHash 公式）；gap 空或有交付不单列', () => {
  const pkg: DimensionCoveragePkg = {
    dimensions: [
      { dimension: '估值', deliveredCount: 3, gap: [] },
      { dimension: '公司事件', deliveredCount: 0, gap: ['解禁公告缺失', '回购数据缺失'] },
      { dimension: '行业景气', deliveredCount: 4, gap: ['政策原文降级'] },
    ],
  };
  const checklist = deriveChecklist(A_FIXTURE, MANIFEST, pkg);
  const dimItems = checklist.items.filter((i) => i.category === 'DIMENSION_COVERAGE');
  assert.equal(dimItems.length, 4, '3 覆盖条目 + 1 缺口单列项（有交付的维度即使有缺口也不单列）');
  assert.deepEqual(dimItems.map((i) => i.checklistId), [
    'check:p2:DIMENSION_COVERAGE:0',
    'check:p2:DIMENSION_COVERAGE:1',
    'check:p2:DIMENSION_COVERAGE:2',
    'check:p2:DIMENSION_COVERAGE:3',
  ], '缺口项 id 在覆盖条目间连续编号');
  const gapItem = dimItems[2]!;
  assert.equal(gapItem.aText, '该维度无材料（缺口 2 条）', '缺口项 aText 固定文案（缺口数 = gap 条数）');
  assert.equal(gapItem.sourceHash, canonicalSha256({ dimension: '公司事件', gaps: ['解禁公告缺失', '回购数据缺失'] }), '缺口项 sourceHash = canonicalSha256({dimension, gaps})');
  assert.equal(gapItem.assessment, 'NOT_ASSESSED');
  const coverageItem = dimItems[0]!;
  assert.equal(coverageItem.sourceHash, canonicalSha256({ dimension: '估值', aText: coverageItem.aText }), '覆盖条目 sourceHash 可由 (dimension, aText) 重导出');
});

test('aText 截断：超长提及片段截 160 字符并以省略号收尾', () => {
  const pkg: DimensionCoveragePkg = { dimensions: [{ dimension: '估值', deliveredCount: 1, gap: [] }] };
  const checklist = deriveChecklist(A_FIXTURE, MANIFEST, pkg);
  const item = checklist.items.find((i) => i.category === 'DIMENSION_COVERAGE')!;
  assert.equal(item.aText.length, A_TEXT_MAX, '截断后恰 160 字符');
  assert.ok(item.aText.startsWith('估值维度长文本：'), '截断保留提及片段开头');
  assert.ok(item.aText.endsWith('…'), '截断以省略号收尾');
});

test('提及抽取顺序：decisiveLinks 先于 limitations，无提及回退"该维度无 A 论述"', () => {
  const pkg: DimensionCoveragePkg = {
    dimensions: [
      { dimension: '基本面变化', deliveredCount: 1, gap: [] },
      { dimension: '历史事件参照', deliveredCount: 0, gap: [] },
      { dimension: '风险项', deliveredCount: 1, gap: [] },
    ],
  };
  const items = deriveChecklist(A_FIXTURE, MANIFEST, pkg).items.filter((i) => i.category === 'DIMENSION_COVERAGE');
  assert.equal(items[0]?.aText, '基本面变化维度出现营收拐点', '命中 decisiveLinks 片段');
  assert.equal(items[1]?.aText, '历史事件参照维度本轮无材料', 'decisiveLinks 未命中时取 limitations 片段');
  assert.equal(items[2]?.aText, '该维度无 A 论述', '两处均未命中回退固定文案');
});

test('rederive 对称：有包/无包均可机械重导出；不同覆盖包哈希不同', () => {
  const pkg: DimensionCoveragePkg = {
    dimensions: [
      { dimension: '公司事件', deliveredCount: 0, gap: ['解禁公告缺失'] },
      { dimension: '风险项', deliveredCount: 1, gap: [] },
    ],
  };
  const withPkg = deriveChecklist(A_FIXTURE, MANIFEST, pkg);
  assert.equal(rederiveChecklistHash(A_FIXTURE, MANIFEST, pkg), withPkg.checklistHash, '三参 rederive 与带包派生对称');
  const otherPkg: DimensionCoveragePkg = {
    dimensions: [
      { dimension: '公司事件', deliveredCount: 0, gap: ['另一缺口'] },
      { dimension: '风险项', deliveredCount: 1, gap: [] },
    ],
  };
  assert.notEqual(rederiveChecklistHash(A_FIXTURE, MANIFEST, otherPkg), withPkg.checklistHash, '覆盖包内容不同 → 清单哈希不同');
  const none = deriveChecklist(A_FIXTURE, MANIFEST);
  assert.equal(rederiveChecklistHash(A_FIXTURE, MANIFEST), none.checklistHash, '无包路径同样对称');
});

test('宽基七维：逐维度成条，id 连续，提及与回退文案正确', () => {
  const pkg: DimensionCoveragePkg = {
    dimensions: BROAD_DIMS.map((dimension) => ({ dimension, deliveredCount: 1, gap: [] })),
  };
  const checklist = deriveChecklist(BROAD_A_FIXTURE, MANIFEST, pkg);
  const dimItems = checklist.items.filter((i) => i.category === 'DIMENSION_COVERAGE');
  assert.equal(dimItems.length, 7, '宽基七维各成一条');
  assert.deepEqual(dimItems.map((i) => i.checklistId), BROAD_DIMS.map((_, index) => `check:p2:DIMENSION_COVERAGE:${index}`));
  assert.equal(dimItems[0]?.aText, '估值分位处于近十年偏低区间', '命中 decisiveLinks');
  assert.equal(dimItems[6]?.aText, '历史状态参照暂缺', '命中 limitations');
  assert.equal(dimItems[3]?.aText, '该维度无 A 论述', '"资金"维度无 A 论述回退');
  assert.equal(checklist.items.length, 4 + 7, '基础四类 + 七维覆盖');
  assert.ok(checklist.checklistId.startsWith('checklist:p2:'));
});
