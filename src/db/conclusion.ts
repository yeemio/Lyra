/**
 * Lyra · 研究结论对象落库/读回（表 conclusion，schema 冻结）。W3: code-writer-pro。
 *
 * - persistConclusion：buildConclusionObject 完成全部字段间校验后一次插入；
 *   研究字段落库后不可变——同 conclusionId 二次写（含完全相同的重放）一律
 *   CONCLUSION_IMMUTABLE 拒绝；落库后立即读回并断言与构造对象全等（含 adoption=false）。
 * - readConclusion：行 → ConclusionObject。
 * - writeSettlementColumn：唯一允许的后续写路径，只写 settlement 列（供结算占位区回填）；
 *   研究字段一致性断言由 src/conclusion/settlement.ts 内建。
 */
import type { Pool } from 'pg';
import { canonicalJsonString } from '../canonical.js';
import {
  buildConclusionObject,
  ConclusionError,
  type ConclusionInput,
} from '../conclusion/object.js';
import type { ConclusionObject, SettlementZone } from '../contracts.js';

interface ConclusionRow {
  conclusion_id: string;
  business_key: unknown;
  method_version: string;
  adapter_version: string;
  plan_auth_version: string;
  disposition: string;
  adoption: boolean;
  evidence: unknown;
  inheritance: unknown;
  standalone_note: string | null;
  change_reason: string | null;
  settlement: unknown;
  created_at: Date;
  conclusion_hash: string;
}

function rowToConclusion(row: ConclusionRow): ConclusionObject {
  if (row.adoption !== false) {
    throw new ConclusionError('RESEARCH_FIELDS_MUTATED', `adoption 落库断言失败: ${String(row.adoption)}（恒 false）`);
  }
  return {
    conclusionId: row.conclusion_id,
    businessKey: row.business_key as ConclusionObject['businessKey'],
    methodVersion: row.method_version,
    adapterVersion: row.adapter_version,
    planAuthVersion: row.plan_auth_version,
    disposition: row.disposition as ConclusionObject['disposition'],
    adoption: false,
    evidence: row.evidence as ConclusionObject['evidence'],
    inheritance: row.inheritance as ConclusionObject['inheritance'],
    standaloneNote: row.standalone_note,
    changeReason: row.change_reason,
    settlement: row.settlement as SettlementZone,
    createdAt: row.created_at.toISOString(),
    conclusionHash: row.conclusion_hash,
  };
}

const COLS = `conclusion_id, business_key, method_version, adapter_version, plan_auth_version,
  disposition, adoption, evidence, inheritance, standalone_note, change_reason, settlement,
  created_at, conclusion_hash`;

/**
 * 持久化结论对象（研究字段写入后不可变）。返回读回对象（与构造对象全等）。
 * 幂等语义：不存在——二次写一律具名拒绝（CONCLUSION_IMMUTABLE）。
 */
export async function persistConclusion(pool: Pool, input: ConclusionInput): Promise<ConclusionObject> {
  const obj = buildConclusionObject(input);
  const res = await pool.query<ConclusionRow>(
    `insert into conclusion (${COLS})
     values ($1, $2::jsonb, $3, $4, $5, $6, false, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13)
     on conflict (conclusion_id) do nothing
     returning ${COLS}`,
    [
      obj.conclusionId,
      JSON.stringify(obj.businessKey),
      obj.methodVersion,
      obj.adapterVersion,
      obj.planAuthVersion,
      obj.disposition,
      JSON.stringify(obj.evidence),
      obj.inheritance === null ? null : JSON.stringify(obj.inheritance),
      obj.standaloneNote,
      obj.changeReason,
      JSON.stringify(obj.settlement),
      new Date(obj.createdAt),
      obj.conclusionHash,
    ],
  );
  const inserted = res.rows[0];
  if (inserted) {
    const read = rowToConclusion(inserted);
    // 落库断言：adoption 恒 false 且整体读回与构造对象全等（研究字段写入即冻结）
    if (read.adoption !== false) {
      throw new ConclusionError('RESEARCH_FIELDS_MUTATED', `落库断言失败：adoption=${String(read.adoption)}`);
    }
    // 落库断言：adoption 恒 false 且整体读回与构造对象一致（研究字段写入即冻结）。
    // 用 canonical 比较：jsonb 往返会重排对象键序，键序不是内容身份。
    if (canonicalJsonString(read) !== canonicalJsonString(obj)) {
      throw new ConclusionError('RESEARCH_FIELDS_MUTATED', '落库读回与构造对象不一致（写入即冻结校验失败）');
    }
    return read;
  }
  const existing = await readConclusion(pool, obj.conclusionId);
  throw new ConclusionError(
    'CONCLUSION_IMMUTABLE',
    `结论 ${obj.conclusionId} 已落库（hash=${existing?.conclusionHash ?? '?'}）：研究字段不可二次写（RM §8）`,
  );
}

export async function readConclusion(pool: Pool, conclusionId: string): Promise<ConclusionObject | null> {
  const res = await pool.query<ConclusionRow>(
    `select ${COLS} from conclusion where conclusion_id = $1`,
    [conclusionId],
  );
  const row = res.rows[0];
  return row ? rowToConclusion(row) : null;
}

/**
 * 结算占位区回填的底层写路径：只更新 settlement 列，不触碰任何研究字段列。
 * （研究字段一致性断言在 settlement.backfillSettlement 内建。）
 */
export async function writeSettlementColumn(
  pool: Pool,
  conclusionId: string,
  settlement: SettlementZone,
): Promise<ConclusionObject> {
  const res = await pool.query<ConclusionRow>(
    `update conclusion set settlement = $2::jsonb
     where conclusion_id = $1
     returning ${COLS}`,
    [conclusionId, JSON.stringify(settlement)],
  );
  const row = res.rows[0];
  if (!row) throw new ConclusionError('CONCLUSION_MISSING', `结论不存在: ${conclusionId}`);
  return rowToConclusion(row);
}
