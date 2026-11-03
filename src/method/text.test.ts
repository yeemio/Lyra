/**
 * W12 单测 · 方法正文 v1 冻结（method@p2-v1）。
 * 覆盖：镜像文档与代码常量逐字一致（读文件比对）；哈希稳定（重算 + 钉扎在镜像中）；
 * 关键纪律句存在（A/J/清单各抽关键句）；正文不含具体股票代码（写作纪律）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSha256 } from '../canonical.js';
import {
  A_INSTRUCTIONS,
  CHECKLIST_RULES_P2,
  J_DUTIES,
  METHOD_P2_VERSION,
  METHOD_TEXT_HASH,
} from './text.js';

const mirrorPath = fileURLToPath(new URL('../../docs/method/P2-METHOD-TEXT.md', import.meta.url));
const mirror = readFileSync(mirrorPath, 'utf8');

/** 从镜像抽取指定标题下 text 围栏块的正文（逐字）。 */
function mirrorSection(name: string): string {
  const re = new RegExp('^## ' + name + '\\n\\n```text\\n([\\s\\S]*?)\\n```$', 'm');
  const m = mirror.match(re);
  assert.ok(m, `镜像缺少 ${name} 的 text 围栏块`);
  return m[1] as string;
}

describe('方法正文 v1 · 镜像逐字一致', () => {
  it('A_INSTRUCTIONS 与镜像逐字一致', () => {
    assert.equal(mirrorSection('A_INSTRUCTIONS'), A_INSTRUCTIONS);
  });
  it('J_DUTIES 与镜像逐字一致', () => {
    assert.equal(mirrorSection('J_DUTIES'), J_DUTIES);
  });
  it('CHECKLIST_RULES_P2 与镜像逐字一致', () => {
    assert.equal(mirrorSection('CHECKLIST_RULES_P2'), CHECKLIST_RULES_P2);
  });
  it('镜像声明同一方法版本与哈希', () => {
    assert.ok(mirror.includes('method@p2-v1'));
    const m = mirror.match(/METHOD_TEXT_HASH[：:]\s*([a-f0-9]{64})/);
    assert.ok(m, '镜像缺少 METHOD_TEXT_HASH 行');
    assert.equal(m[1], METHOD_TEXT_HASH);
  });
});

describe('方法正文 v1 · 哈希稳定', () => {
  it('METHOD_TEXT_HASH 为 64 位十六进制', () => {
    assert.match(METHOD_TEXT_HASH, /^[a-f0-9]{64}$/);
  });
  it('重算 canonicalSha256 与导出值一致', () => {
    const recomputed = canonicalSha256({
      A_INSTRUCTIONS,
      J_DUTIES,
      CHECKLIST_RULES_P2,
      METHOD_P2_VERSION,
    });
    assert.equal(recomputed, METHOD_TEXT_HASH);
  });
  it('版本轴标识冻结为 method@p2-v1', () => {
    assert.equal(METHOD_P2_VERSION, 'method@p2-v1');
  });
});

describe('方法正文 v1 · 关键纪律句', () => {
  it('A：单独永不是结论 / 财务数字声明 / 跨类禁止 / 池外禁止 / ≥2 条连接', () => {
    assert.ok(A_INSTRUCTIONS.includes('单独永远不是最终结论'));
    assert.ok(A_INSTRUCTIONS.includes('所有财务数字必须引用确切的报表期间与科目名称'));
    assert.ok(A_INSTRUCTIONS.includes('两类选项空间互不通用'));
    assert.ok(A_INSTRUCTIONS.includes('不得引入池外信息、资料截点之后的信息、外部报价'));
    assert.ok(A_INSTRUCTIONS.includes('决定性连接：至少 2 条'));
  });
  it('A：个股/宽基选项代码与预期差 R12 降权在场', () => {
    for (const code of ['RESEARCH_OUTPERFORM', 'RESEARCH_UNDERPERFORM', 'RESEARCH_UP', 'RESEARCH_DOWN', 'ABSTAIN']) {
      assert.ok(A_INSTRUCTIONS.includes(code), `A_INSTRUCTIONS 缺 ${code}`);
    }
    assert.ok(A_INSTRUCTIONS.includes('指引兑现记录降权参与〔R12〕'));
    assert.ok(A_INSTRUCTIONS.includes('宽基七维度'));
  });
  it('J：承重 UNRESOLVED→ABSTAIN / 不得全项非承重 / 四值裁决与处置', () => {
    assert.ok(J_DUTIES.includes('承重 UNRESOLVED 存在时必须 ABSTAIN'));
    assert.ok(J_DUTIES.includes('不得把所有项设为非承重'));
    assert.ok(J_DUTIES.includes('SUPPORTED / NARROWED / REJECTED / UNRESOLVED'));
    assert.ok(J_DUTIES.includes('ACCEPTED / NARROWED / REFUTED / UNRESOLVED'));
  });
  it('J：判断义务 / 回应不等于改判 / input_hash 回抄 / 改判理由', () => {
    assert.ok(J_DUTIES.includes('回应不等于改判'));
    assert.ok(J_DUTIES.includes('原样回抄至输出 input_hash'));
    assert.ok(J_DUTIES.includes('改判理由（change_reason）'));
    assert.ok(J_DUTIES.includes('不得虚构参照事件'));
  });
  it('清单：八维度覆盖项强制 J 逐维度过目；漏报维度单列', () => {
    assert.ok(CHECKLIST_RULES_P2.includes('DIMENSION_COVERAGE'));
    assert.ok(CHECKLIST_RULES_P2.includes('保证 J 必须逐维度过目'));
    assert.ok(CHECKLIST_RULES_P2.includes('A 未报告该维度'));
    assert.ok(CHECKLIST_RULES_P2.includes('程序不表达任何独立意见'));
  });
  it('写作纪律：三段正文均不含具体股票代码', () => {
    const stockCode = /\b(?:60|00|30|68)\d{4}\b/;
    assert.doesNotMatch(A_INSTRUCTIONS, stockCode);
    assert.doesNotMatch(J_DUTIES, stockCode);
    assert.doesNotMatch(CHECKLIST_RULES_P2, stockCode);
  });
});
