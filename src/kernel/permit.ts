/**
 * Lyra · permit 生命周期（EK-3、EK-4、EK-5.2/5.3、EK-6）。W1: code-writer-pro。
 * 状态机（EK-3.3，非法迁移一律 PERMIT_STATE_INVALID）：
 *   —（合同齐备+同键检查通过）→ PREPARED
 *   PREPARED →（发送实际发起，记 sent_at）→ SENT
 *   SENT → SUCCEEDED | FAILED | UNKNOWN；PREPARED → FAILED（发送前置失败，未发送）。
 *   SUCCEEDED/FAILED/UNKNOWN 终态无出边；UNKNOWN 只经 retireUnknown 本地退役关闭（R21）。
 *
 * send-once（EK-4.1）：exec_permit 上 (subject_kind, subject, research_kind, cutoff, stage)
 * 唯一约束保证每键至多一行。从未发送（sent_at IS NULL，即 PREPARED 或发送前置失败的
 * FAILED——NOT_SENT 出口族，EK-4.4）的行可被同键新尝试原子替换；任何 sent_at 非空
 * （SENT 及之后）的链不可覆盖，重复提交抛 BUSINESS_KEY_ALREADY_SENT。
 * sent_at 即 Metis `NOT_SENT_CONTRADICTS_START` 的等价守卫。
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  KernelError,
  type ModelCallContract,
  type ModelPermit,
  type PermitState,
  type PlanAuthBudget,
} from '../contracts.js';
import { rowToPermit, withTransaction, type DbClient, type ExecPermitRow } from '../db/exec.js';

/**
 * settle 的终态结果。UNKNOWN 的 basis 落 fail_code（EK-5.1 判定依据与时刻的记录义务）。
 * 〔R22〕SUCCEEDED 可携带 failCode：仅用于诚实记时标注（LATE_COMPLETED——结果已知但
 * 迟到，不冒充按窗完成），不改变终态语义；DB 无新列，复用 fail_code。
 */
export type PermitOutcome =
  | { result: 'SUCCEEDED'; failCode?: string }
  | { result: 'FAILED'; failCode: string }
  | { result: 'UNKNOWN'; basis?: string };

const PERMIT_COLUMNS = `permit_id, stage, subject_kind, subject, research_kind, cutoff, input_hash,
  input_bytes, method_version, plan_auth_version, deadline, state, sent_at, settled_at, fail_code,
  simulated`; // created_at 走列默认 now()

/** 冲突替换的公共 SET 片段（业务键五列是冲突键，无需重设）。 */
const CONFLICT_SET_COMMON = [
  'permit_id = excluded.permit_id',
  'input_hash = excluded.input_hash',
  'input_bytes = excluded.input_bytes',
  'method_version = excluded.method_version',
  'plan_auth_version = excluded.plan_auth_version',
  'deadline = excluded.deadline',
  'simulated = excluded.simulated',
  'created_at = now()',
].join(',\n       ');

/** 只允许替换从未发送（sent_at is null 且 PREPARED/FAILED）的行。 */
const CONFLICT_WHERE = `where exec_permit.sent_at is null and exec_permit.state in ('PREPARED', 'FAILED')`;

/**
 * 单条原子落位：
 * - 无冲突 → 直接插入目标态；
 * - 冲突且既有行从未发送 → 原子替换（NOT_SENT 出口修复后同键重试，EK-4.4；
 *   最终 SENT 计数仍为 1）；
 * - 冲突且既有行已进入发送链 → 0 行返回，由调用方转具名错误。
 */
async function upsertPermit(
  pool: Pool,
  contract: ModelCallContract,
  variant:
    | { state: 'PREPARED' }
    | { state: 'FAILED'; failCode: string },
  simulated: boolean,
): Promise<ModelPermit | null> {
  const permitId = randomUUID();
  const base: unknown[] = [permitId, contract.stage, contract.businessKey.subjectKind,
    contract.businessKey.subject, contract.businessKey.researchKind, contract.businessKey.cutoff,
    contract.inputHash, contract.inputBytes, contract.methodVersion, contract.planAuthVersion,
    contract.deadline, simulated];
  let sql: string;
  let params: unknown[];
  if (variant.state === 'PREPARED') {
    sql = `insert into exec_permit (${PERMIT_COLUMNS})
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PREPARED', null, null, null, $12)
      on conflict (subject_kind, subject, research_kind, cutoff, stage) do update set
       ${CONFLICT_SET_COMMON},
       state = 'PREPARED', sent_at = null, settled_at = null, fail_code = null
      ${CONFLICT_WHERE}
      returning *`;
    params = base;
  } else {
    params = [...base, variant.failCode];
    sql = `insert into exec_permit (${PERMIT_COLUMNS})
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'FAILED', null, now(), $13, $12)
      on conflict (subject_kind, subject, research_kind, cutoff, stage) do update set
       ${CONFLICT_SET_COMMON},
       state = 'FAILED', sent_at = null, settled_at = now(), fail_code = excluded.fail_code
      ${CONFLICT_WHERE}
      returning *`;
  }
  const res = await pool.query<ExecPermitRow>(sql, params);
  const row = res.rows[0];
  return row ? rowToPermit(row) : null;
}

/** 读键上既有 permit（无则 null）。 */
export async function findPermitByBusinessKey(
  pool: DbClient,
  contract: Pick<ModelCallContract, 'businessKey' | 'stage'>,
): Promise<ModelPermit | null> {
  const res = await pool.query<ExecPermitRow>(
    `select * from exec_permit
     where subject_kind = $1 and subject = $2 and research_kind = $3 and cutoff = $4 and stage = $5`,
    [contract.businessKey.subjectKind, contract.businessKey.subject, contract.businessKey.researchKind,
      contract.businessKey.cutoff, contract.stage],
  );
  const row = res.rows[0];
  return row ? rowToPermit(row) : null;
}

/** 键已被已发送链占用 → BUSINESS_KEY_ALREADY_SENT（send-once，EK-4.1）。 */
function alreadySentError(contract: ModelCallContract, existing: ModelPermit): KernelError {
  return new KernelError(
    'BUSINESS_KEY_ALREADY_SENT',
    `业务键 ${contract.businessKey.subjectKind}:${contract.businessKey.subject}` +
      `×${contract.businessKey.researchKind}×${contract.businessKey.cutoff}/${contract.stage}` +
      ` 已存在已发送 permit（state=${existing.state}, permit=${existing.permitId}），` +
      `send-once 拒绝（EK-4.1）`,
  );
}

function isSentChain(p: ModelPermit): boolean {
  return p.sentAt !== null || p.state === 'SENT' || p.state === 'SUCCEEDED' || p.state === 'UNKNOWN';
}

/** upsert 落位失败（键被占）时转具名错误。 */
async function assertBusinessKeyFreeOrThrow(
  pool: Pool,
  contract: ModelCallContract,
): Promise<never> {
  const existing = await findPermitByBusinessKey(pool, contract);
  if (existing && isSentChain(existing)) throw alreadySentError(contract, existing);
  // 键上是从未发送的行却替换失败：同进程并发竞争的瞬态，具名要求重试，不会产生第二次发送。
  throw new KernelError(
    'PERMIT_STATE_INVALID',
    '同键 permit 并发落位冲突（既有行从未发送）；重试即可，不会产生第二次发送',
  );
}

/**
 * 创建 permit（预算判定 → send-once 同键检查 → 落位）。
 *
 * EK-4.5 预算判定先行：inputBytes > budget.maxInputBytes → 落一行
 * state=FAILED / fail_code=INPUT_OVER_BUDGET / sent_at=null 的具名阻断行并抛
 * INPUT_OVER_BUDGET（不截断、不进 SENT）。键上已有已发送链时 send-once 优先
 * 保护既有链（阻断行不覆盖它，抛 BUSINESS_KEY_ALREADY_SENT）。
 */
export async function preparePermit(
  pool: Pool,
  contract: ModelCallContract,
  budget: PlanAuthBudget,
  opts?: { simulated?: boolean },
): Promise<ModelPermit> {
  const simulated = opts?.simulated ?? true; // P0 全部为模拟模型（EK-10.1/EK-11.2）
  if (contract.inputBytes > budget.maxInputBytes) {
    const blocked = await upsertPermit(pool, contract, { state: 'FAILED', failCode: 'INPUT_OVER_BUDGET' }, simulated);
    if (!blocked) await assertBusinessKeyFreeOrThrow(pool, contract);
    throw new KernelError(
      'INPUT_OVER_BUDGET',
      `输入 ${contract.inputBytes} 字节超过预算 ${budget.maxInputBytes}` +
        `（planAuth ${budget.planAuthVersion}）：具名阻断、不截断、不发送（EK-4.4/4.5）` +
        `${blocked ? `；permit=${blocked.permitId}（FAILED/INPUT_OVER_BUDGET）` : ''}`,
    );
  }
  const permit = await upsertPermit(pool, contract, { state: 'PREPARED' }, simulated);
  if (permit) return permit;
  // 键被已发送链占用（assertBusinessKeyFreeOrThrow 必抛 BUSINESS_KEY_ALREADY_SENT）
  return await assertBusinessKeyFreeOrThrow(pool, contract);
}

export async function getPermit(pool: DbClient, permitId: string): Promise<ModelPermit | null> {
  const res = await pool.query<ExecPermitRow>(
    `select * from exec_permit where permit_id = $1`, [permitId],
  );
  const row = res.rows[0];
  return row ? rowToPermit(row) : null;
}

/** 在途 permit 数（state=SENT，EK-2.3 的度量形式）。 */
export async function countInFlight(pool: DbClient): Promise<number> {
  const res = await pool.query<{ n: string }>(`select count(*)::text as n from exec_permit where state = 'SENT'`);
  return Number(res.rows[0]?.n ?? 0);
}

/** 非闭合 permit：SENT 未终结，或 UNKNOWN 未退役（恢复流程的 pending 集，EK-8.2）。 */
export async function listUnclosedPermits(pool: DbClient): Promise<ModelPermit[]> {
  const res = await pool.query<ExecPermitRow>(
    `select * from exec_permit p
     where p.state = 'SENT'
        or (p.state = 'UNKNOWN'
            and not exists (select 1 from retirement_receipt r where r.permit_id = p.permit_id))
     order by p.created_at, p.permit_id`,
  );
  return res.rows.map(rowToPermit);
}

/** 发送前置的截止判定 + PREPARED→FAILED/DEADLINE_EXCEEDED（仅当已过截止；发送从未发起，sent_at 保持空）。 */
export async function failPreparedDeadline(pool: DbClient, permitId: string): Promise<ModelPermit | null> {
  const res = await pool.query<ExecPermitRow>(
    `update exec_permit set state = 'FAILED', settled_at = now(), fail_code = 'DEADLINE_EXCEEDED'
     where permit_id = $1 and state = 'PREPARED' and now() > deadline
     returning *`,
    [permitId],
  );
  const row = res.rows[0];
  return row ? rowToPermit(row) : null;
}

async function invalidTransition(pool: DbClient, permitId: string, to: string): Promise<KernelError> {
  const cur = await getPermit(pool, permitId);
  if (!cur) return new KernelError('PERMIT_STATE_INVALID', `permit 不存在（${permitId}），无法迁移至 ${to}`);
  return new KernelError('PERMIT_STATE_INVALID', `permit 状态迁移非法：${cur.state} → ${to}（EK-3.3 迁移表之外）`);
}

/**
 * PREPARED → SENT。发送前截止检查（EK-6）：now() > deadline → PREPARED→FAILED/
 * DEADLINE_EXCEEDED 并抛 DEADLINE_EXCEEDED（未按窗完成，发送从未发起）。
 * 非 PREPARED → PERMIT_STATE_INVALID。
 */
export async function markSent(pool: Pool, permitId: string): Promise<ModelPermit> {
  const expired = await failPreparedDeadline(pool, permitId);
  if (expired) {
    throw new KernelError(
      'DEADLINE_EXCEEDED',
      `发送前截止已过（deadline=${expired.contract.deadline}）：按未按窗完成落库 FAILED/DEADLINE_EXCEEDED，未发送（EK-6.2）`,
    );
  }
  const res = await pool.query<ExecPermitRow>(
    `update exec_permit set state = 'SENT', sent_at = now()
     where permit_id = $1 and state = 'PREPARED'
     returning *`,
    [permitId],
  );
  const row = res.rows[0];
  if (row) return rowToPermit(row);
  throw await invalidTransition(pool, permitId, 'SENT');
}

/**
 * tryMarkSent 的四类结果（并发闸轮询用，executor.ts）。
 * 〔R31〕P 参数化：执行器编排泛化（runPermittedCall）后，报告链 permit 空间复用同一
 * 结果形状；缺省仍为 A/J 的 ModelPermit，既有调用方签名不变。
 */
export interface PermitLike {
  permitId: string;
  state: PermitState;
}
export type TryMarkSentOutcome<P extends PermitLike = ModelPermit> =
  | { kind: 'SENT'; permit: P }
  | { kind: 'IN_FLIGHT_FULL' }
  | { kind: 'DEADLINE_EXCEEDED'; permit: P }
  | { kind: 'INVALID_STATE'; permit: P | null };

/** 并发闸判定的串行化键：同一时刻只有一个执行流评估"在途数 + 进 SENT"（EK-2.3）。 */
const EXEC_GATE_ADVISORY_KEY = 7021001;

/**
 * 原子并发闸（EK-2.3/7.1）：仅当在途（state=SENT）数 < maxInFlight 且未过截止时
 * PREPARED→SENT。过截止则就地 FAILED/DEADLINE_EXCEEDED；在途满则 IN_FLIGHT_FULL。
 * 事务内 pg_advisory_xact_lock 串行化"计数+迁移"——否则 READ COMMITTED 下多个
 * 并发 UPDATE 各自快照里 count=0，会全部放行突破上限。
 */
export async function tryMarkSent(
  pool: Pool,
  permitId: string,
  maxInFlight: number,
): Promise<TryMarkSentOutcome> {
  return withTransaction(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [EXEC_GATE_ADVISORY_KEY]);
    const res = await tx.query<ExecPermitRow>(
      `update exec_permit as p
       set state = 'SENT', sent_at = now()
       where p.permit_id = $1::uuid
         and p.state = 'PREPARED'
         and now() <= p.deadline
         and (select count(*) from exec_permit x where x.state = 'SENT') < $2::int
       returning p.*`,
      [permitId, maxInFlight],
    );
    const row = res.rows[0];
    if (row) return { kind: 'SENT', permit: rowToPermit(row) } as TryMarkSentOutcome;
    // 0 行：区分原因——截止已过则关闭为 FAILED/DEADLINE_EXCEEDED；在途满则等待；状态异常具名报错。
    const cur = await tx.query<ExecPermitRow & { deadline_exceeded: boolean }>(
      `select *, now() > deadline as deadline_exceeded from exec_permit where permit_id = $1::uuid`,
      [permitId],
    );
    const curRow = cur.rows[0];
    if (!curRow) return { kind: 'INVALID_STATE', permit: null } as TryMarkSentOutcome;
    if (curRow.state !== 'PREPARED') return { kind: 'INVALID_STATE', permit: rowToPermit(curRow) } as TryMarkSentOutcome;
    if (curRow.deadline_exceeded) {
      const failed = await failPreparedDeadline(tx, permitId);
      return { kind: 'DEADLINE_EXCEEDED', permit: failed ?? rowToPermit(curRow) } as TryMarkSentOutcome;
    }
    return { kind: 'IN_FLIGHT_FULL' } as TryMarkSentOutcome;
  });
}

/**
 * 终态记录（EK-3.3 记录义务）：SENT → SUCCEEDED|FAILED|UNKNOWN；PREPARED → FAILED。
 * 其余迁移 PERMIT_STATE_INVALID。UNKNOWN 的依据落 fail_code，settled_at 即判 UNKNOWN 时刻。
 * 〔R22〕SUCCEEDED.failCode 可选（如 LATE_COMPLETED），缺省写 null，终态语义不变。
 */
export async function settle(pool: DbClient, permitId: string, outcome: PermitOutcome): Promise<ModelPermit> {
  const failCode =
    outcome.result === 'FAILED' ? outcome.failCode
    : outcome.result === 'UNKNOWN' ? (outcome.basis ?? 'OUTCOME_UNCONFIRMED')
    : outcome.result === 'SUCCEEDED' ? (outcome.failCode ?? null)
    : null;
  const allowedFrom: string[] =
    outcome.result === 'FAILED' ? ['SENT', 'PREPARED']
    : ['SENT'];
  const res = await pool.query<ExecPermitRow>(
    `update exec_permit set state = $2, settled_at = now(), fail_code = $3
     where permit_id = $1::uuid and state = any($4::text[])
     returning *`,
    [permitId, outcome.result, failCode, allowedFrom],
  );
  const row = res.rows[0];
  if (row) return rowToPermit(row);
  throw await invalidTransition(pool, permitId, outcome.result);
}

// ===== UNKNOWN 本地退役（EK-5.3 + R21）=====

export interface RetirementReceipt {
  receiptId: string;
  permitId: string;
  confirmedBy: string;
  confirmedAt: string;
  remoteResult: 'UNKNOWN';
  remoteCost: 'UNKNOWN';
}

interface ReceiptRow {
  receipt_id: string;
  permit_id: string;
  confirmed_by: string;
  confirmed_at: Date;
  remote_result: string;
  remote_cost: string;
}

function toReceipt(row: ReceiptRow): RetirementReceipt {
  return {
    receiptId: row.receipt_id,
    permitId: row.permit_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at.toISOString(),
    remoteResult: 'UNKNOWN',
    remoteCost: 'UNKNOWN',
  };
}

/**
 * UNKNOWN 的唯一关闭方式：本地退役回执（EK-5.3）。不重发、不退款、不伪造远端回执、
 * 不合成结果或检查点；remote_result/remote_cost 恒 'UNKNOWN'。
 * 仅 Owner 显式确认触发（R21）：confirmedBy 必填，空值即 UNKNOWN_NOT_RETIRED——
 * 本模块不提供任何无 confirmedBy 的退役路径，也无自动退役。
 * 幂等：同 permit 已有回执则直接返回既有回执，不重复落。
 */
export async function retireUnknown(
  pool: Pool,
  permitId: string,
  confirmedBy: string,
): Promise<RetirementReceipt> {
  const by = (confirmedBy ?? '').trim();
  if (!by) {
    throw new KernelError(
      'UNKNOWN_NOT_RETIRED',
      'UNKNOWN 退役必须由 Owner 显式确认（confirmedBy 非空，R21）；不设自动退役、不设空确认人路径（EK-5.3）',
    );
  }
  return withTransaction(pool, async (tx) => {
    const existing = await tx.query<ReceiptRow>(
      'select * from retirement_receipt where permit_id = $1::uuid',
      [permitId],
    );
    const old = existing.rows[0];
    if (old) return toReceipt(old);
    const cur = await tx.query<ExecPermitRow>(
      'select * from exec_permit where permit_id = $1::uuid for update',
      [permitId],
    );
    const row = cur.rows[0];
    if (!row) {
      throw new KernelError('UNKNOWN_NOT_RETIRED', `permit 不存在，无法退役: ${permitId}`);
    }
    if (row.state !== 'UNKNOWN') {
      throw new KernelError(
        'PERMIT_STATE_INVALID',
        `仅 UNKNOWN 态可退役（EK-5.3）；当前 state=${row.state}（permit=${permitId}）`,
      );
    }
    const ins = await tx.query<ReceiptRow>(
      `insert into retirement_receipt (receipt_id, permit_id, confirmed_by, remote_result, remote_cost)
       values ($1, $2, $3, 'UNKNOWN', 'UNKNOWN')
       returning *`,
      [randomUUID(), permitId, by],
    );
    const created = ins.rows[0];
    if (!created) throw new Error('retireUnknown: 回执写入失败');
    return toReceipt(created);
  });
}
