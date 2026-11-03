/**
 * Lyra · 东财基金面适配器真实冒烟（P1 W30；派发预算 ≤4 真实请求）。
 *
 * 真实请求 1 次桥调用（510050，池内样本，东财 F10 gmbd 全历史季频序列，桥内 1 次 HTTP）：
 * 合计 1 ≤ 4 预算。事实身份由原始行派生（不含抓取时刻）→ 重放去重由单测与全量回填
 * IDENTICAL 计数证明，冒烟不重复请求。
 *
 * 断言：原始行 canonical JSON 原件入库（哈希校验读回）+ 事实落库（ETF_SHARE subjectType=ETF、
 * subjectId=裸码；availableAt=季度末+92 天 00:00+08 法定披露上界；sourcePublishedAt=null）+
 * as-of 读回无泄漏（逐事实与全体 max availableAt ≤ 当前时刻）+ 事实数 = 行数 − 拒绝行数 +
 * **跨源校验**：2025-09-30 期末总份额（亿份）≈ 上交所 fund_etf_scale_sse 探测实测
 * 57,723,966,800 份（=577.24 亿份，容差 ±0.01 亿份=±100 万份，来源公布精度内）——校验值来自
 * W30 探测（/tmp/lyra-w30/probe-etf.json），不产生新请求。
 *
 * 运行：node --import tsx src/adapters/emfund.smoke.ts
 * 目标库：默认 public schema；p1-migration 幂等应用。原件目录：env LYRA_ARTIFACTS_DIR，
 * 缺省 <repo>/data/artifacts（冒烟事实/原件并入正式库，全量回填同内容重放 → IDENTICAL 去重）。
 */
import { asOfFacts } from '../pintime/facts.js';
import { applySchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResponse } from './adapter-types.js';
import {
  EmfundAdapter,
  SHARE_DATE_FIELD,
  SHARE_TOTAL_FIELD,
  makeEmfundBridgeExecutor,
  shareAvailableAt,
} from './emfund.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const CODE = '510050';
/** 上交所 fund_etf_scale_sse 探测实测（2025-09-30，份）：510050 基金份额（W30 探测证据）。 */
const SSE_2025Q3_510050_SHARES = 57_723_966_800;

interface ShareRow {
  [key: string]: unknown;
}

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  let bridgeCalls = 0;
  const realExec = makeEmfundBridgeExecutor();
  const countingExec = async (args: string[]): Promise<BridgeResponse> => {
    bridgeCalls += 1;
    return realExec(args);
  };
  const adapter = new EmfundAdapter({ pool, store, execBridge: countingExec });
  const nowMs = Date.now();

  // ---- 真实请求 1：510050 全历史季度份额序列（一次桥调用）----
  const share = await adapter.fetchEtfShare(CODE);
  const rows = JSON.parse(
    new TextDecoder().decode(await store.readBytes(share.artifact.sha256)),
  ) as ShareRow[];

  // ---- 断言：行数与拒绝 ----
  if (share.rowCount !== rows.length || share.rowCount < 80) {
    throw new Error(`份额行数异常：rowCount=${String(share.rowCount)} 原件=${String(rows.length)}（510050 自 2005 起 ≥80 季）`);
  }
  if (share.rejectedRows.length !== 0) throw new Error(`份额出现拒绝行：${JSON.stringify(share.rejectedRows)}`);
  if (share.insertedFactIds.length + share.identicalFactIds.length !== share.rowCount) {
    throw new Error('份额事实数 ≠ 行数（有未解释行）');
  }

  // ---- 断言：逐事实 availableAt 与行内季度自洽 + 无泄漏 ----
  const facts = await asOfFacts(pool, {
    subjectType: 'ETF', subjectId: CODE, factKind: 'ETF_SHARE', asOf: new Date(nowMs),
  });
  for (const f of facts) {
    const q = (f.typedValue as ShareRow)[SHARE_DATE_FIELD];
    if (typeof q !== 'string') throw new Error('份额事实缺季度日期');
    if (f.availableAt !== shareAvailableAt(q)) {
      throw new Error(`ETF_SHARE availableAt ≠ 季度末+92 天：${f.availableAt} vs 季度末=${q}`);
    }
    if (f.sourcePublishedAt !== null) throw new Error('ETF_SHARE sourcePublishedAt 须为 null（不编造披露日）');
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：份额 availableAt 在当前时刻之后');
  }
  if (facts.length < 80) throw new Error(`份额事实 as-of 读回过少：${String(facts.length)}`);

  // ---- 跨源校验：2025-09-30 行 vs 上交所快照探测值（±0.01 亿份容差 = 来源公布精度）----
  const target = rows.find((r) => r[SHARE_DATE_FIELD] === '2025-09-30');
  if (target === undefined) throw new Error('原件缺 2025-09-30 季度行（跨源校验锚点缺失）');
  const gmbdYi = Number(target[SHARE_TOTAL_FIELD]);
  if (!Number.isFinite(gmbdYi)) throw new Error(`2025-09-30 期末总份额不可解析：${String(target[SHARE_TOTAL_FIELD])}`);
  const sseYi = SSE_2025Q3_510050_SHARES / 1e8;
  const diffYi = Math.abs(gmbdYi - sseYi);
  if (diffYi > 0.01) {
    throw new Error(`跨源校验失败：gmbd=${String(gmbdYi)} 亿份 vs SSE=${String(sseYi)} 亿份（差 ${diffYi.toFixed(4)} 亿份 > 0.01）`);
  }

  // ---- 深度快报（首末季度，证明全历史口径）----
  const quarters = rows.map((r) => String(r[SHARE_DATE_FIELD])).sort();

  if (bridgeCalls > 4) throw new Error(`真实桥调用超预算：${String(bridgeCalls)} > 4`);

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: share.adapterVersion,
    realRequests: { bridgeCalls, budget: 4 },
    share: {
      scope: share.scope,
      rowCount: share.rowCount,
      inserted: share.insertedFactIds.length,
      identical: share.identicalFactIds.length,
      rangeQuarterEnd: [quarters[0], quarters[quarters.length - 1]],
      artifact: { sha256: share.artifact.sha256, bytes: share.artifact.bytes },
    },
    crossCheck: {
      quarterEnd: '2025-09-30',
      gmbdYiShares: gmbdYi,
      sseSharesExact: SSE_2025Q3_510050_SHARES,
      sseYiShares: sseYi,
      diffYiShares: Number(diffYi.toFixed(6)),
      tolerance: '±0.01 亿份（来源公布精度）',
    },
    asOfReadback: { etfShareFacts: facts.length, noLeak: true },
  }, null, 2));
  await pool.end();
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error('SMOKE FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
