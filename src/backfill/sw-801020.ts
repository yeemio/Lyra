/**
 * Lyra · 801020（申万采掘指数，2014 窗口行业基准）事实化 runner（P1 W8: code-writer-pro）。
 * 合同：docs/REVISION-LOG.md R24.3（裁定入事实面；全史止于 2021-12-10 退役边界）、
 * R23（sw@p1 适配器与证据链）、docs/specs/DATA-SOURCES.md §6（适配器管线）。
 *
 * 事实化方式（派发优先级）：**证据原件重放**——W7 已真实抓取 801020 全史并存于
 * data/sw-originals/daily-801020.json（证据原件 data/artifacts 同字节）；本 runner 以
 * 只读重放执行器喂 SwAdapter.fetchL1Daily('801020') 全管线（原件 CAS 同哈希幂等、
 * SW_INDEX_BAR 事实 availableAt=交易日 15:00+08、R4 修订口径声明随行），**0 新网络调用**。
 * 重放不入缓存的数据一律拒绝执行（不做新请求、不降级）。
 *
 * 前置核验（不过不写事实）：重放响应 ok 且行非空；日期全史覆盖（首行 ≤ 2000-01-01，
 * 末行 = 2021-12-10 退役边界，R24.3）。入库后 DB 读回复核（行数 = 响应行数、
 * max(object_key) = 2021-12-10），失败如实退出非零。
 * CLI：node --import tsx src/backfill/sw-801020.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SW_ADAPTER_VERSION, SwAdapter } from '../adapters/sw.js';
import type { BridgeResponse } from '../adapters/adapter-types.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** W7 证据缓存（真实调用产物；重放数据源）。 */
export const CACHE_PATH = join(repoRoot, 'data', 'sw-originals', 'daily-801020.json');
/** 2014 采掘指数退役边界（R23 三重证据：最后交易日 2021-12-10）。 */
export const RETIRED_LAST_DATE = '2021-12-10';
/** 全史起点核验上限（实际首行 1999-12-30）。 */
export const FULL_HISTORY_FIRST_BOUND = '2000-01-01';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 重放执行器：仅服务 ['l1_daily','801020']，读缓存文件；其他命令一律拒绝（不做新请求）。 */
export function makeReplayExecutor(response: BridgeResponse): (args: string[]) => Promise<BridgeResponse> {
  return async (args) => {
    if (args[0] === 'l1_daily' && args[1] === '801020') return response;
    throw new Error(`SW_REPLAY_ONLY_801020: 本重放执行器只服务 l1_daily 801020，拒绝 ${JSON.stringify(args)}`);
  };
}

/** 响应行日期域核验（纯函数）：非空、格式合法、全史覆盖至退役边界。 */
export function verify801020Dates(rows: Record<string, unknown>[]): { first: string; last: string; n: number } {
  const dates = rows.map((r) => r['日期']).filter((d): d is string => typeof d === 'string' && DATE_RE.test(d));
  if (dates.length !== rows.length || dates.length === 0) {
    throw new Error(`SW_801020_ROWS_INVALID: 日期字段缺失/非法（${String(rows.length - dates.length)}/${String(rows.length)} 行）`);
  }
  const sorted = [...dates].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first > FULL_HISTORY_FIRST_BOUND) {
    throw new Error(`SW_801020_NOT_FULL_HISTORY: 首行 ${first} 晚于全史起点核验上限 ${FULL_HISTORY_FIRST_BOUND}（预期 1999-12-30 起）`);
  }
  if (last !== RETIRED_LAST_DATE) {
    throw new Error(`SW_801020_RETIRE_BOUNDARY_MISMATCH: 末行 ${last} ≠ 退役边界 ${RETIRED_LAST_DATE}（R24.3）`);
  }
  return { first, last, n: rows.length };
}

async function main(): Promise<void> {
  const raw = await readFile(CACHE_PATH, 'utf8').catch((error: unknown) => {
    throw new Error(`SW_801020_CACHE_MISSING: ${CACHE_PATH}（${String(error)}）——重放数据源不存在，如实停下（不做新请求）`);
  });
  const response = JSON.parse(raw) as BridgeResponse;
  if (response.ok !== true || !Array.isArray(response.rows)) {
    throw new Error(`SW_801020_CACHE_INVALID: 重放缓存不是成功响应（ok=${String(response.ok)}）`);
  }
  const rows = response.rows as Record<string, unknown>[];
  const preCheck = verify801020Dates(rows);
  console.log(`[sw-801020] 重放前置核验通过：${String(preCheck.n)} 行，${preCheck.first}~${preCheck.last}（0 新网络调用）`);

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    const adapter = new SwAdapter({
      pool,
      store: new ArtifactStore(artifactsDir),
      execBridge: makeReplayExecutor(response),
    });

    const r = await adapter.fetchL1Daily('801020');

    // 入库后 DB 读回复核（证据绑当前候选，不采信插入返回值单边）。
    // 对象键不落列（schema 冻结），日期域从 typed_value->>'日期' 读回（YYYY-MM-DD 字典序）。
    const check = await pool.query<{ n: number; first: string; last: string }>(
      `select count(*)::int as n, min(typed_value->>'日期') as first, max(typed_value->>'日期') as last
       from pintime_fact f
       where adapter_version = $1 and fact_kind = 'SW_INDEX_BAR'
         and subject_type = 'INDEX' and subject_id = '801020'
         and not exists (select 1 from pintime_fact child where child.supersedes_fact_id = f.fact_id)`,
      [SW_ADAPTER_VERSION],
    );
    const row = check.rows[0];
    if (row === undefined || row.n !== rows.length || row.last !== RETIRED_LAST_DATE) {
      throw new Error(`SW_801020_DB_VERIFY_FAILED: DB ${row === undefined ? '(无行)' : `${String(row.n)} 行 ${row.first}~${row.last}`} ≠ 响应 ${String(rows.length)} 行（末行 ${RETIRED_LAST_DATE}）`);
    }
    console.log(JSON.stringify({
      result: 'SW 801020 FACTUALIZED',
      method: '证据原件重放（data/sw-originals/daily-801020.json → SwAdapter 全管线，0 新网络调用）',
      rows: rows.length,
      coverage: `${row.first}~${row.last}`,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      artifactSha256: r.artifact.sha256,
      dbCount: row.n,
      adapterVersion: SW_ADAPTER_VERSION,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不执行——单测导入纯函数）
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/sw-801020.ts');

if (isMain) {
  await main();
}
