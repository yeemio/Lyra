/**
 * Lyra · 不重叠样本与分母视图单测（P3 W13: code-writer-pro）。纯函数，无 DB。
 * 合同判定：SETTLEMENT-REVIEW SR-4.1–4.7（终态互斥、错过子类、三条禁令、主统计分母、
 * 分母视图计数项）/ SR-5.1（锚定最近前一个结论含被排除者；参考价日 ≤ 前一窗口结束日即排除）/
 * SR-5.2（排除不豁免）。SR-5.1 示例（A/B/C 链）按合同原文构造。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DenominatorError,
  buildDenominatorView,
  classifyDenominator,
  overlapExcluded,
  overlapJudgement,
  overlappingAnchor,
  type ConclusionWindowInfo,
  type DenominatorSample,
} from './denominator.js';

// ===== SR-5.1 不重叠：合同示例（A 3-02/3-30；B 3-20 落 A 窗口内 → 排除；C 4-10 锚 B 仍排除）=====

const A: ConclusionWindowInfo = {
  conclusionId: 'A', subject: '600000', conclusionTime: '2026-03-01T12:00:00Z',
  referenceDay: '2026-03-02', windowEndDay: '2026-03-30', overlapExcluded: false,
};
const B: ConclusionWindowInfo = {
  conclusionId: 'B', subject: '600000', conclusionTime: '2026-03-19T12:00:00Z',
  referenceDay: '2026-03-20', windowEndDay: '2026-04-17', overlapExcluded: true, // 被 A 排除
};
const C: ConclusionWindowInfo = {
  conclusionId: 'C', subject: '600000', conclusionTime: '2026-04-09T12:00:00Z',
  referenceDay: '2026-04-10', windowEndDay: '2026-05-13', overlapExcluded: true,
};

test('SR-5.1 示例：B 落 A 窗口内被排除', () => {
  const judgement = overlapJudgement('600000', B.conclusionTime, B.referenceDay, [A]);
  assert.equal(judgement.anchor?.conclusionId, 'A');
  assert.equal(judgement.excluded, true); // B.ref 3-20 ≤ A.end 3-30
});

test('SR-5.1 证伪：C 锚定最近前一个结论 B（而非最早的 A）→ 仍被排除', () => {
  const judgement = overlapJudgement('600000', C.conclusionTime, C.referenceDay, [A, B]);
  assert.equal(judgement.anchor?.conclusionId, 'B'); // 含被排除者 B 作锚
  assert.equal(judgement.excluded, true); // C.ref 4-10 ≤ B.end 4-17（虽已晚于 A.end 3-30）
});

test('SR-5.1：锚定含被排除者（B 本身 excluded=true 仍是 C 的锚）；前一个结论不重叠则不排除', () => {
  assert.equal(overlappingAnchor('600000', C.conclusionTime, [A, B])?.conclusionId, 'B');
  const D: ConclusionWindowInfo = {
    conclusionId: 'D', subject: '600000', conclusionTime: '2026-05-12T12:00:00Z',
    referenceDay: '2026-05-14', windowEndDay: '2026-06-15', overlapExcluded: false,
  };
  const judgement = overlapJudgement('600000', D.conclusionTime, D.referenceDay, [A, B, C]);
  assert.equal(judgement.anchor?.conclusionId, 'C');
  assert.equal(judgement.excluded, false); // D.ref 5-14 > C.end 5-13
  assert.equal(overlapExcluded('2026-05-13', C), true); // 等于窗口结束日也排除（≤）
  assert.equal(overlapExcluded('2026-05-14', C), false);
});

test('SR-5.1：异股不锚定；无前一个结论不排除', () => {
  assert.equal(overlappingAnchor('000001', C.conclusionTime, [A, B, C]), null);
  assert.equal(overlapExcluded('2026-03-20', null), false);
});

// ===== SR-4.1/4.2 终态互斥分类 =====

test('六终态互斥分类：SELECTED / ABSTAIN / TECH_FAILURE / MISSED 两子类 / UNKNOWN / PENDING', () => {
  assert.deepEqual(
    classifyDenominator({ attemptId: 't1', conclusion: { disposition: 'RESEARCH_OUTPERFORM' }, execution: { kind: 'SUCCEEDED' } }),
    { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't2', conclusion: { disposition: 'ABSTAIN' }, execution: { kind: 'SUCCEEDED' } }),
    { terminal: 'ABSTAIN', missedSubclass: null, missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't3', conclusion: null, execution: { kind: 'TECH_FAILURE', code: 'A_STRUCTURE_INVALID' } }),
    { terminal: 'TECH_FAILURE', missedSubclass: null, missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't4', conclusion: null, execution: { kind: 'UNKNOWN' } }),
    { terminal: 'UNKNOWN', missedSubclass: null, missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't5', conclusion: null, execution: { kind: 'MISSED_WINDOW' } }),
    { terminal: 'MISSED', missedSubclass: 'MISSED_WINDOW', missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't6', conclusion: null, execution: { kind: 'MISSED_OVERFLOW', completed: false } }),
    { terminal: 'MISSED', missedSubclass: 'MISSED_OVERFLOW', missedOverflowTag: false },
  );
  assert.deepEqual(
    classifyDenominator({ attemptId: 't7', conclusion: null, execution: { kind: 'QUEUED_DEFERRED' } }),
    { terminal: 'PENDING', missedSubclass: null, missedOverflowTag: false },
  );
});

test('SR-4.2 并存标注：降级后完成者终态按结论计入 SELECTED/ABSTAIN + MISSED_OVERFLOW 标注', () => {
  assert.deepEqual(
    classifyDenominator({
      attemptId: 't8',
      conclusion: { disposition: 'RESEARCH_UNDERPERFORM' },
      execution: { kind: 'MISSED_OVERFLOW', completed: true },
    }),
    { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: true },
  );
  assert.deepEqual(
    classifyDenominator({
      attemptId: 't9',
      conclusion: { disposition: 'ABSTAIN' },
      execution: { kind: 'MISSED_OVERFLOW', completed: true },
    }),
    { terminal: 'ABSTAIN', missedSubclass: null, missedOverflowTag: true },
  );
});

test('结构性矛盾输入具名拒绝（互斥性由分类器保证）', () => {
  const conflicts: Array<[{ attemptId: string; conclusion: { disposition: string } | null; execution: object }]> = [
    [{ attemptId: 'x1', conclusion: null, execution: { kind: 'SUCCEEDED' } }], // 成功却无结论
    [{ attemptId: 'x2', conclusion: { disposition: 'ABSTAIN' }, execution: { kind: 'TECH_FAILURE', code: 'X' } }], // 失败却有结论
    [{ attemptId: 'x3', conclusion: { disposition: 'RESEARCH_UP' }, execution: { kind: 'UNKNOWN' } }], // UNKNOWN 却有结论
    [{ attemptId: 'x4', conclusion: null, execution: { kind: 'MISSED_OVERFLOW', completed: true } }], // 降级完成却无结论
    [{ attemptId: 'x5', conclusion: { disposition: 'SOMETHING' }, execution: { kind: 'SUCCEEDED' } }], // 未知 disposition
  ];
  for (const [attempt] of conflicts) {
    assert.throws(() => classifyDenominator(attempt as never), (e: unknown) => e instanceof DenominatorError);
  }
});

// ===== SR-4.3/4.5/4.7 分母视图 =====

function sample(partial: Partial<DenominatorSample> & Pick<DenominatorSample, 'attemptId' | 'classification'>): DenominatorSample {
  return { subjectKind: 'STOCK', tradability: null, overlapExcluded: false, settled: true, ...partial };
}

test('分母视图：全部计数项 + 主统计分母交集 + 互斥断言', () => {
  const view = buildDenominatorView([
    // 主统计内：个股 SELECTED、FILLABLE、不重叠、已结算 ×2（一跑赢一跑输）
    sample({ attemptId: 'm1', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'FILLABLE' }),
    sample({ attemptId: 'm2', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'FILLABLE' }),
    // 不可成交视图三类 + 长期停牌（仍 SELECTED，独立计数不混主统计）
    sample({ attemptId: 'u1', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'UNFILLABLE_LIMIT_UP' }),
    sample({ attemptId: 'u2', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'UNFILLABLE_LIMIT_DOWN' }),
    sample({ attemptId: 'u3', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'UNFILLABLE_SUSPENDED' }),
    sample({ attemptId: 'u4', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'SUSPENDED_OVER_20D' }),
    // 不重叠排除（SELECTED、FILLABLE，但不进主统计）
    sample({ attemptId: 'o1', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'FILLABLE', overlapExcluded: true }),
    // 未到期（SELECTED、FILLABLE、不重叠，但未结算）
    sample({ attemptId: 'n1', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'FILLABLE', settled: false }),
    // 宽基 SELECTED、FILLABLE、不重叠、已结算：可成交视图计入但不进主统计（SR-8A.5）
    sample({ attemptId: 'e1', subjectKind: 'BROAD_ETF', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: false }, tradability: 'FILLABLE' }),
    // 放弃 / 技术失败 / 未知 / 错过两子类 / 顺延
    sample({ attemptId: 'a1', classification: { terminal: 'ABSTAIN', missedSubclass: null, missedOverflowTag: false } }),
    sample({ attemptId: 'f1', classification: { terminal: 'TECH_FAILURE', missedSubclass: null, missedOverflowTag: false } }),
    sample({ attemptId: 'k1', classification: { terminal: 'UNKNOWN', missedSubclass: null, missedOverflowTag: false } }),
    sample({ attemptId: 'w1', classification: { terminal: 'MISSED', missedSubclass: 'MISSED_WINDOW', missedOverflowTag: false } }),
    sample({ attemptId: 'w2', classification: { terminal: 'MISSED', missedSubclass: 'MISSED_OVERFLOW', missedOverflowTag: false } }),
    sample({ attemptId: 'p1', classification: { terminal: 'PENDING', missedSubclass: null, missedOverflowTag: false } }),
    // 降级后完成（并存标注，SR-4.2）
    sample({ attemptId: 'd1', classification: { terminal: 'SELECTED', missedSubclass: null, missedOverflowTag: true }, tradability: 'FILLABLE', overlapExcluded: true }),
  ]);
  assert.equal(view.totalAdmissions, 16);
  assert.equal(view.selected, 10); // m1,m2,u1..u4,o1,n1,e1,d1
  assert.equal(view.abstain, 1);
  assert.equal(view.techFailure, 1);
  assert.equal(view.missed, 2);
  assert.equal(view.unknown, 1);
  assert.equal(view.pending, 1);
  assert.equal(view.missedWindow, 1);
  assert.equal(view.missedOverflow, 1);
  assert.equal(view.missedOverflowCompletedTag, 1); // d1
  assert.equal(view.fillable, 6); // m1,m2,o1,n1,e1,d1（u* 四个不可成交；a1 非 SELECTED）
  assert.equal(view.unfillableLimitUp, 1);
  assert.equal(view.unfillableLimitDown, 1);
  assert.equal(view.unfillableSuspended, 1);
  assert.equal(view.suspendedOver20d, 1);
  assert.equal(view.overlapExcludedCount, 2); // o1,d1
  assert.equal(view.notDue, 1); // n1
  assert.deepEqual(view.mainDenominator, { count: 2, attemptIds: ['m1', 'm2'] }); // SR-4.5 交集 ∩ 个股（SR-8A.5：e1 不入）
  // SR-4.1 证伪：六终态之和 = 全部准入
  assert.equal(view.selected + view.abstain + view.techFailure + view.missed + view.unknown + view.pending, view.totalAdmissions);
});

test('SR-4.4 证伪：注入技术失败与 UNKNOWN 批次，ABSTAIN 计数不变、UNKNOWN 独立可见', () => {
  const base = [sample({ attemptId: 'a1', classification: { terminal: 'ABSTAIN', missedSubclass: null, missedOverflowTag: false } })];
  const before = buildDenominatorView(base);
  const injected = [
    ...base,
    ...Array.from({ length: 5 }, (_, i) =>
      sample({ attemptId: `f${String(i)}`, classification: { terminal: 'TECH_FAILURE', missedSubclass: null, missedOverflowTag: false } })),
    ...Array.from({ length: 3 }, (_, i) =>
      sample({ attemptId: `k${String(i)}`, classification: { terminal: 'UNKNOWN', missedSubclass: null, missedOverflowTag: false } })),
  ];
  const after = buildDenominatorView(injected);
  assert.equal(after.abstain, before.abstain); // 技术失败不冒充放弃
  assert.equal(after.techFailure, 5);
  assert.equal(after.unknown, 3); // UNKNOWN 永久保留"未知（非 0）"，不并入任何比例分母
  assert.equal(after.totalAdmissions, 9);
});
