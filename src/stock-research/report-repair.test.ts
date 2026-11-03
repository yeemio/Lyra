import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validateAnalyzeOutput, type AnalyzeInput, type AnalyzeOutput, type AFinalOutput } from './transport.js';
import { runQaChecks, deriveSrChecklist, evaluatePublishGate } from './engine.js';
import { readableTable, tableBands } from './report-tables.js';

const input: Pick<AnalyzeInput, 'tables'> = { tables: [{ tableId: 'known-table', title: '材料', columns: ['值'], rows: [[1]], unitNote: null }] };
const output = (): AnalyzeOutput => ({ sections: [{ key: 'company', narrative: '有来源的判断', findings: [], tables: ['known-table'], gaps: [] }], citations: [{ label: '材料', tableId: 'known-table' }] });

it('模型输入边界：tableId 必须存在于本次送达表，不接受表格正文、格式错误和未知引用', () => {
  validateAnalyzeOutput(output(), input);
  for (const bad of ['| 列 | 值 |\n|---|---|\n| A | 1 |', 'unknown-but-well-formed', '', 'known-table ', 42, null, {}]) {
    const o = output(); o.sections[0]!.tables = [bad as string];
    assert.throws(() => validateAnalyzeOutput(o, input), /MODEL_OUTPUT_SCHEMA_INVALID|输出合同校验失败/);
  }
  const o = output(); o.citations[0]!.tableId = 'unknown-table';
  assert.throws(() => validateAnalyzeOutput(o, input), /未知 tableId/);
});

it('引擎原 QA 仍阻断未知表，格式归位后保留计算提示与研究缺口', () => {
  const sections = ['company','industry','drivers','financials','outlook','valuation','market','risk'].map((key) => ({ ...output().sections[0]!, key, scenarios: [{name:'基准',condition:'a',implication:'a'},{name:'改善',condition:'b',implication:'b'},{name:'恶化',condition:'c',implication:'c'}] }));
  const groups = [{ ...output(), sections }];
  const aFinal = { conclusion: '有条件', conclusionConditions: ['期限内'], decisiveLinks: [], strongestCounter: '最强反证', catalysts: [], gaps: ['资料未知'], narrative: '摘要' } satisfies AFinalOutput;
  const checklist = deriveSrChecklist(groups,aFinal);
  const ctx = { pack: { tables: [{tableId:'known-table',locators:[]}], cutoff:'2026-10-28',coverage:{gaps:['真实资料缺口']} }, computed: {tables:[],checks:[{name:'计算提示',ok:false,detail:'保持原限制'}]}, analyze:new Map([['a',groups[0]]]), aFinal, checklist, judge:{verdicts:checklist.items.map((i)=>({checklistId:i.checklistId,verdict:'SUPPORTED'})),conclusionRuling:{conditions:['期限内']},unresolvedDisposition:[]} } as unknown as Parameters<typeof runQaChecks>[0];
  sections[0]!.tables=['unknown-table'];
  const broken=runQaChecks(ctx);assert.ok(broken.some((q)=>q.code==='CITATION_UNRESOLVED'&&q.severity==='BLOCKING'));
  assert.equal(evaluatePublishGate({...ctx,qa:broken}).gatePassed,false);
  sections[0]!.tables=['known-table'];
  const fixed=runQaChecks(ctx);assert.equal(fixed.filter((q)=>q.severity==='BLOCKING').length,0);
  assert.deepEqual(fixed.map((q)=>[q.code,q.severity]),[['COMPUTE_CHECK_FAILED','ADVISORY']]);
  assert.deepEqual(ctx.pack!.coverage.gaps,['真实资料缺口']);
});

it('重复来源集中列示，宽表分栏保留全部原值与行号，不截断或抽样', () => {
  const t={title:'原表',columns:['date','value','sourceUrl','pages','sha256'],rows:[['2026-10-28','12345678901234567890','https://source','7','a'.repeat(64)],['2026-10-29',null,'https://source','7','a'.repeat(64)]],note:'单位保持原样'};
  const view=readableTable(t);assert.equal(view.sources.length,1);assert.deepEqual(view.rows,[['2026-10-28','12345678901234567890','S1'],['2026-10-29','—','S1']]);
  assert.ok(view.sources[0]!.includes('7')&&view.sources[0]!.includes('a'.repeat(64)));
  const columns=Array.from({length:13},(_,i)=>`列${i}`),row=columns.map((_,i)=>`值${i}`);
  const bands=tableBands(columns,[row]);assert.deepEqual(bands.flatMap((b)=>b.rows[0]!.slice(1)),row);assert.ok(bands.every((b)=>b.rows[0]![0]==='1'));
});
