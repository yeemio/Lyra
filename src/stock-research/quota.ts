/**
 * Lyra · sr 空间配额预约与用量事件。R31，code-writer-pro。
 * 载体：sr_quota_usage / sr_usage_event（src/db/sr-migration.sql，schema `sr`）。
 *
 * 纪律：
 * - period = Asia/Shanghai 自然月 'YYYY-MM'（标准本地化机制取年月，不引第三方依赖）。
 * - reserveQuota 抗并发超额：insert on conflict do nothing 落行 + 单条条件自增
 *   （update ... where used < limit returning used），无先读后写竞态窗口。
 * - refundQuota 用 greatest(used-1, 0)，绝不退成负数。
 * - reserve/refund 不自动记用量事件；何时落账（TASK_CREATED / QUOTA_REFUND 等）
 *   由调用方（引擎层）经 recordUsageEvent 决定，本层只管计数正确。
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type QuotaKind = 'REPORT_TASK' | 'MODEL_CALL';

export interface ReserveResult {
  ok: boolean;
  used: number; // ok=true 为自增后的用量；ok=false 为拒绝时的当前用量
  limit: number;
  period: string;
}

/** 当前时刻的上海自然月 'YYYY-MM'（toLocaleString('en-US', { timeZone }) 同源的本地化部件提取）。 */
function shanghaiMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  if (!y || !m || !/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m)) {
    throw new Error(`shanghaiMonth: 本地化年月解析失败: ${y ?? '?'}-${m ?? '?'}`);
  }
  return `${y}-${m.padStart(2, '0')}`;
}

/**
 * 预约一个名额（原子）：
 * 1) insert on conflict do nothing 确保计数行存在（并发首约安全，0 行副作用）；
 * 2) 条件自增 used < limit 命中即占位（returning used），未命中 = 该月已满。
 * limit ≤ 0 永不放行（contracts：0 = 仅管理员设置）。
 */
export async function reserveQuota(
  srPool: Pool,
  accountId: string,
  kind: QuotaKind,
  limit: number,
  now?: Date,
): Promise<ReserveResult> {
  const period = shanghaiMonth(now ?? new Date());
  await srPool.query(
    `insert into sr_quota_usage (account_id, period, kind, used)
     values ($1::uuid, $2, $3, 0)
     on conflict (account_id, period, kind) do nothing`,
    [accountId, period, kind],
  );
  const res = await srPool.query<{ used: number }>(
    `update sr_quota_usage set used = used + 1
     where account_id = $1::uuid and period = $2 and kind = $3 and used < $4
     returning used`,
    [accountId, period, kind, limit],
  );
  const row = res.rows[0];
  if (row) return { ok: true, used: row.used, limit, period };
  // 超额：回读当前用量供展示（行必存在——上一句 insert 已保证）。
  const cur = await srPool.query<{ used: number }>(
    'select used from sr_quota_usage where account_id = $1::uuid and period = $2 and kind = $3',
    [accountId, period, kind],
  );
  return { ok: false, used: cur.rows[0]?.used ?? 0, limit, period };
}

/** 退还一个名额（任务硬失败退款）：greatest 兜底，绝不退成负数；行缺失时无操作。 */
export async function refundQuota(
  srPool: Pool,
  accountId: string,
  kind: QuotaKind,
  period: string,
): Promise<void> {
  await srPool.query(
    `update sr_quota_usage set used = greatest(used - 1, 0)
     where account_id = $1::uuid and period = $2 and kind = $3`,
    [accountId, period, kind],
  );
}

/** 当月（或指定时刻所在月）用量汇总：只返回已有计数行的 kind。 */
export async function getQuotaUsage(
  srPool: Pool,
  accountId: string,
  now?: Date,
): Promise<{ period: string; rows: { kind: QuotaKind; used: number }[] }> {
  const period = shanghaiMonth(now ?? new Date());
  const res = await srPool.query<{ kind: QuotaKind; used: number }>(
    'select kind, used from sr_quota_usage where account_id = $1::uuid and period = $2 order by kind',
    [accountId, period],
  );
  return { period, rows: res.rows.map((r) => ({ kind: r.kind, used: r.used })) };
}

/** 记一条用量事件（使用量页面与成本核算的原始账）；detail 缺省 {}。 */
export async function recordUsageEvent(
  srPool: Pool,
  accountId: string,
  kind: string,
  detail?: unknown,
  taskId?: string,
): Promise<void> {
  const detailJson = JSON.stringify(detail === undefined ? {} : detail);
  if (taskId === undefined) {
    await srPool.query(
      `insert into sr_usage_event (event_id, account_id, kind, detail)
       values ($1::uuid, $2::uuid, $3, $4::jsonb)`,
      [randomUUID(), accountId, kind, detailJson],
    );
  } else {
    await srPool.query(
      `insert into sr_usage_event (event_id, account_id, task_id, kind, detail)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)`,
      [randomUUID(), accountId, taskId, kind, detailJson],
    );
  }
}
