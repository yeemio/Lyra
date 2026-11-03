/**
 * Lyra · 结算占位区骨架（RESEARCH-METHOD §8 / SETTLEMENT-REVIEW 合同占位）。W3: code-writer-pro。
 *
 * backfillSettlement：只写 settlement 列；回填后重读并内建断言——
 *   a) 研究字段与回填前逐字段一致（本函数没有任何研究字段入参，试图经结算改
 *      disposition 在 API 形状上无路径，此处再以读回比对证伪）；
 *   b) conclusionHash 按研究字段重算一致（settlement/createdAt 不进哈希，回填不改身份）。
 * settleNeverTouchesResearchFields 的证伪路径由旅程测试保证：回填前后研究字段
 * 快照全等 + 哈希重算一致；再次回填（占位区可再写）同样不得触碰研究字段。
 */
import { canonicalJsonString } from '../canonical.js';
import type { Pool } from 'pg';
import { readConclusion, writeSettlementColumn } from '../db/conclusion.js';
import {
  ConclusionError,
  conclusionHashOf,
  researchCoreOf,
  validateSettlementResult,
  type SettlementBackfill,
} from './object.js';
import type { ConclusionObject } from '../contracts.js';

function coreKey(c: ConclusionObject): string {
  return canonicalJsonString(researchCoreOf(c));
}

/**
 * 结算回填：验证 SETTLED/ANOMALY 形态（R26.2）→ 只更新 settlement 列 → 重读并断言研究字段未动、
 * 哈希重算一致。返回回填后的完整结论对象。
 */
export async function backfillSettlement(
  pool: Pool,
  conclusionId: string,
  result: SettlementBackfill,
): Promise<ConclusionObject> {
  validateSettlementResult(result);
  const before = await readConclusion(pool, conclusionId);
  if (before === null) throw new ConclusionError('CONCLUSION_MISSING', conclusionId);

  const after = await writeSettlementColumn(pool, conclusionId, result);

  // 内建断言 a：研究字段快照全等（结算路径触碰研究字段即违约）
  if (coreKey(after) !== coreKey(before)) {
    throw new ConclusionError('RESEARCH_FIELDS_MUTATED', `结算回填改变了研究字段（conclusion=${conclusionId}）`);
  }
  // 内建断言 b：conclusionHash 按研究字段重算一致
  if (conclusionHashOf(researchCoreOf(after)) !== after.conclusionHash) {
    throw new ConclusionError('RESEARCH_FIELDS_MUTATED', `结算回填后 conclusionHash 重算不一致（conclusion=${conclusionId}）`);
  }
  if (after.settlement.state !== 'SETTLED' && after.settlement.state !== 'ANOMALY') {
    throw new ConclusionError('SETTLEMENT_INVALID', '回填后结算区仍非 SETTLED/ANOMALY');
  }
  return after;
}
