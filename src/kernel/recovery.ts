/**
 * Lyra · 启动诊断与恢复（EK-8）。W1: code-writer-pro。
 * - bootRecovery：发现非闭合 permit（SENT 未终结 / UNKNOWN 未退役）→ lifecycle=RECONCILING
 *   并登记 pending；不自动续跑、不自动发送、不自动改写任何 permit 状态（EK-8.2）。
 *   RECONCILING 只能经 confirmRecovery 显式确认退出，bootRecovery 永不自动转回 RUNNING。
 * - assertRunning：RECONCILING 下任何执行操作抛 RECOVERY_CONFIRM_REQUIRED（零模型调用）。
 * - confirmRecovery(owner)：显式确认后回 RUNNING；无法配对到确认终态的 SENT permit
 *   默认转 UNKNOWN（EK-5.1 无证据不改口；EK-8.3），UNKNOWN 保持 UNKNOWN 待退役（EK-5.3）。
 * - diagnose：冷启动诊断三问——缺什么 / 什么状态 / 下一步（EK-8.1）。
 */
import type { Pool, PoolClient } from 'pg';
import {
  KernelError,
  type Lifecycle,
  type ModelPermit,
  type PermitState,
  type RecoveryState,
} from '../contracts.js';
import { withTransaction, type ExecPermitRow, rowToPermit } from '../db/exec.js';
import { pgEnv } from '../db/pool.js';
import { listUnclosedPermits, settle } from './permit.js';
import { readExecutorLock } from './lock.js';

interface RecoveryRow {
  lifecycle: string;
  pending_permit_ids: string[] | null;
  updated_at: Date;
}

function toState(row: RecoveryRow): RecoveryState {
  return {
    lifecycle: row.lifecycle === 'RECONCILING' ? 'RECONCILING' : 'RUNNING',
    pendingPermitIds: Array.isArray(row.pending_permit_ids) ? row.pending_permit_ids : [],
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getRecoveryState(pool: Pool): Promise<RecoveryState> {
  const res = await pool.query<RecoveryRow>(
    'select lifecycle, pending_permit_ids, updated_at from recovery_state where id = 1',
  );
  const row = res.rows[0];
  if (!row) throw new Error('recovery_state 单行缺失：schema 未应用或被破坏');
  return toState(row);
}

async function getPermitOn(client: PoolClient, permitId: string): Promise<ModelPermit | null> {
  const res = await client.query<ExecPermitRow>(
    'select * from exec_permit where permit_id = $1::uuid',
    [permitId],
  );
  const row = res.rows[0];
  return row ? rowToPermit(row) : null;
}

/**
 * 启动/重启恢复扫描。存在非闭合 permit（或已处于 RECONCILING）→ 登记为
 * RECONCILING + pending 集；全程零模型调用、零状态改写（除 recovery_state 自身）。
 */
export async function bootRecovery(pool: Pool): Promise<RecoveryState> {
  const pending = await listUnclosedPermits(pool);
  const current = await getRecoveryState(pool);
  if (pending.length > 0 || current.lifecycle === 'RECONCILING') {
    const ids = JSON.stringify(pending.map((p) => p.permitId));
    await pool.query(
      `update recovery_state set lifecycle = 'RECONCILING', pending_permit_ids = $1::jsonb, updated_at = now()
       where id = 1`,
      [ids],
    );
    return getRecoveryState(pool);
  }
  return current; // 干净启动：保持 RUNNING，不触碰任何行
}

/** 执行前置守卫：RECONCILING → RECOVERY_CONFIRM_REQUIRED（EK-8.2/8.3）。 */
export async function assertRunning(pool: Pool): Promise<RecoveryState> {
  const s = await getRecoveryState(pool);
  if (s.lifecycle === 'RECONCILING') {
    throw new KernelError(
      'RECOVERY_CONFIRM_REQUIRED',
      `生命周期 RECONCILING：待处置 permit ${s.pendingPermitIds.length} 个` +
        `（${s.pendingPermitIds.join(', ')}）。零模型调用；确认后经 confirmRecovery 恢复（EK-8.3）`,
    );
  }
  return s;
}

/** 确认时对单个 SENT permit 的结局裁决；不提供（或返回 UNKNOWN）即维持 UNKNOWN 语义。 */
export type PendingResolver = (permit: ModelPermit) => {
  outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  failCode?: string;
};

export interface RecoveryResolution {
  permitId: string;
  from: PermitState;
  to: PermitState;
}

export interface ConfirmRecoveryResult {
  state: RecoveryState;
  resolved: RecoveryResolution[];
  owner: string;
}

/**
 * RECONCILING 的唯一出口：显式确认（EK-8.3）。owner 必填（确认人登记）。
 * - pending 中 SENT permit：resolver 判"结果可知"则按其终态关闭；无法配对到确认终态的
 *   默认转 UNKNOWN（EK-5.1/8.3）；
 * - pending 中 UNKNOWN permit：保持 UNKNOWN，待 Owner 经 retireUnknown 退役（EK-5.3、R21）；
 * - 之后 lifecycle=RUNNING、pending 清空。RUNNING 下调用为幂等 no-op。
 */
export async function confirmRecovery(
  pool: Pool,
  owner: string,
  resolve?: PendingResolver,
): Promise<ConfirmRecoveryResult> {
  const who = (owner ?? '').trim();
  if (!who) {
    throw new KernelError(
      'RECOVERY_CONFIRM_REQUIRED',
      '恢复确认必须登记确认人（owner 非空）；无确认人的确认无效（EK-8.3）',
    );
  }
  return withTransaction(pool, async (tx) => {
    const cur = await tx.query<RecoveryRow>(
      'select lifecycle, pending_permit_ids, updated_at from recovery_state where id = 1 for update',
    );
    const row = cur.rows[0];
    if (!row) throw new Error('recovery_state 单行缺失：schema 未应用或被破坏');
    if (row.lifecycle !== 'RECONCILING') {
      return { state: toState(row), resolved: [], owner: who };
    }
    const ids = Array.isArray(row.pending_permit_ids) ? row.pending_permit_ids : [];
    const resolved: RecoveryResolution[] = [];
    for (const permitId of ids) {
      const permit = await getPermitOn(tx, permitId);
      if (!permit) continue;
      if (permit.state === 'SENT') {
        const decision = resolve?.(permit) ?? { outcome: 'UNKNOWN' as const };
        const failCode = decision.outcome === 'FAILED'
          ? (decision.failCode ?? 'RECOVERY_CONFIRMED_FAIL')
          : decision.outcome === 'UNKNOWN' ? 'RECOVERY_UNCONFIRMED' : undefined;
        const outcome = decision.outcome === 'SUCCEEDED' ? { result: 'SUCCEEDED' as const }
          : decision.outcome === 'FAILED' ? { result: 'FAILED' as const, failCode: failCode ?? 'RECOVERY_CONFIRMED_FAIL' }
          : { result: 'UNKNOWN' as const, basis: failCode ?? 'RECOVERY_UNCONFIRMED' };
        const after = await settle(tx, permitId, outcome);
        resolved.push({ permitId, from: 'SENT', to: after.state });
      } else if (permit.state === 'UNKNOWN') {
        // 保持 UNKNOWN 待退役（终态无出边；退役只经 retireUnknown）
        resolved.push({ permitId, from: 'UNKNOWN', to: 'UNKNOWN' });
      }
      // 其余状态（PREPARED/FAILED 等）不在 pending 语义内，跳过。
    }
    const updated = await tx.query<RecoveryRow>(
      `update recovery_state set lifecycle = 'RUNNING', pending_permit_ids = '[]'::jsonb, updated_at = now()
       where id = 1 returning lifecycle, pending_permit_ids, updated_at`,
    );
    const after = updated.rows[0];
    if (!after) throw new Error('confirmRecovery: 状态更新失败');
    return { state: toState(after), resolved, owner: who };
  });
}

// ===== 冷启动诊断（EK-8.1）=====

export interface DiagnoseReport {
  ok: boolean;
  /** 具名缺失项（如 PG_CONNECT:…、TABLE_MISSING:exec_permit），非泛化"启动失败"。 */
  missing: string[];
  lifecycle: Lifecycle | null;
  /** 非闭合 permit（SENT 未终结 / UNKNOWN 未退役）的 permit_id。 */
  pendingPermits: string[];
  /** 人可读下一步动作。 */
  hint: string;
}

const KERNEL_TABLES = ['kernel_lock', 'recovery_state', 'exec_permit', 'retirement_receipt', 'install_log'];

/**
 * 冷启动诊断：回答三问——缺什么（missing）、什么状态（lifecycle/pending/锁）、
 * 下一步（hint）。任何连接层失败都收敛为报告而非异常。
 */
export async function diagnose(pool: Pool): Promise<DiagnoseReport> {
  const cfg = pgEnv();
  const endpoint = `${cfg.host ?? '127.0.0.1'}:${String(cfg.port ?? 5432)}/${cfg.database ?? 'lyra'}`;
  const missing: string[] = [];
  try {
    await pool.query('select 1');
  } catch (err) {
    missing.push(`PG_CONNECT:${endpoint}`);
    return {
      ok: false,
      missing,
      lifecycle: null,
      pendingPermits: [],
      hint:
        `缺什么：PostgreSQL 不可达（${endpoint}，错误摘要：${err instanceof Error ? err.message : String(err)}）。` +
        `下一步：启动数据库（OrbStack 容器 lyra-pg）或用 LYRA_PG_HOST/PORT/USER/PASSWORD/DATABASE 指向可用实例后重试。`,
    };
  }
  for (const table of KERNEL_TABLES) {
    const r = await pool.query(
      `select 1 from information_schema.tables
       where table_schema = current_schema() and table_name = $1`,
      [table],
    );
    if (!r.rows[0]) missing.push(`TABLE_MISSING:${table}`);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      lifecycle: null,
      pendingPermits: [],
      hint:
        `缺什么：内核表未就位（${missing.join('、')}；当前 schema 未应用 src/db/schema.sql）。` +
        `下一步：对目标 schema 应用 schema.sql（src/db/exec.ts 的 applySchema）后再启动。`,
    };
  }
  const state = await getRecoveryState(pool);
  const pending = await listUnclosedPermits(pool);
  let hint: string;
  if (state.lifecycle === 'RECONCILING') {
    hint =
      `什么状态：生命周期 RECONCILING，非闭合 permit ${pending.length} 个` +
      `（${pending.map((p) => p.permitId).join(', ') || '无'}）。` +
      `下一步：读回各 permit 实际结局后运行 confirmRecovery（显式确认）；UNKNOWN permit 由 Owner 经 retireUnknown 退役。`;
  } else {
    let lockHint: string;
    try {
      const lock = await readExecutorLock(pool);
      lockHint = lock.holder
        ? `执行器 ${lock.holder} 持锁中（心跳 ${Date.now() - Date.parse(lock.heartbeatAt)}ms 前）`
        : '执行器锁空闲';
    } catch {
      lockHint = '执行器锁不可读';
    }
    hint = `什么状态：内核就绪，生命周期 RUNNING，${lockHint}，非闭合 permit ${pending.length} 个。下一步：acquireExecutorLock 取得执行权后正常运行；如存在非闭合 permit 先走 bootRecovery。`;
  }
  return { ok: true, missing: [], lifecycle: state.lifecycle, pendingPermits: pending.map((p) => p.permitId), hint };
}
