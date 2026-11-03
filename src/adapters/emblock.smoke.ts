/**
 * Lyra · 大宗交易适配器真实冒烟（P2 W37: code-writer，B1）。
 *
 * 有界真实请求 1 个（≤4 预算）：
 * 1. mrmx 2026-10-19~2026-10-23（探测已知有数窗口，var/w37-probe.py：446 行 13 列、
 *    池内命中 14 行）——东财大宗交易每日明细全市场区间。
 * 池过滤 = data/research-pool.json 26 股（事实面按池，原件全量）。
 *
 * 断言：桥 stdout JSON 原件入库（哈希校验读回）+ 事实落库（BLOCK_TRADE
 * availableAt=交易日次日 00:00+08、eventAt=交易日 15:00+08）+ 池主体覆盖（≥1 笔池内成交）
 * + as-of 截点过滤无泄漏（次日 00:00+08 前不可见）+ R4/面内注记随行。
 *
 * 运行：node --import tsx src/adapters/emblock.smoke.ts
 * 目标库：public schema（createPool 默认）；p1-migration 幂等应用。
 * 原件目录：env LYRA_ARTIFACTS_DIR，缺省 <repo>/data/artifacts。
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/pool.js';
import { applySchema } from '../db/exec.js';
import { asOfFacts } from '../pintime/facts.js';
import { ArtifactStore } from '../artifacts/store.js';
import { parseResearchPool } from '../backfill/pool-market.js';
import { BACKFILL_REVISION_NOTICE } from './adapter-types.js';
import {
  EMBLOCK_ADAPTER_VERSION,
  EMBLOCK_REVISION_NOTICE,
  EmblockAdapter,
  makeEmblockBridgeExecutor,
} from './emblock.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const WINDOW = { start: '2026-10-19', end: '2026-10-23' }; // 探测已知有数窗（var/w37-probe.py）

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await applySchema(pool);
    const { applyP1Migration } = await import('./backoff.js');
    await applyP1Migration(pool);

    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const store = new ArtifactStore(artifactsDir);

    // 真实桥调用计数（每 docker run = 1 次真实请求）
    let bridgeCalls = 0;
    const realExec = makeEmblockBridgeExecutor();
    const countingExec = async (args: string[]) => {
      bridgeCalls += 1;
      return await realExec(args);
    };
    const adapter = new EmblockAdapter({ pool, store, execBridge: countingExec });

    const researchPool = parseResearchPool(await readFile(join(repoRoot, 'data', 'research-pool.json'), 'utf8'));
    const stockCodes = researchPool.stocks.map((s) => s.code);
    const filter = new Set(stockCodes);
    console.log(`[emblock-smoke] 池 ${String(stockCodes.length)} 股（subjectFilter）`);

    // ---- 请求 1：mrmx 近窗（全市场区间）----
    const r = await adapter.fetchBlockTradeDetail(WINDOW.start, WINDOW.end, filter);
    if (r.rowCount === 0) throw new Error('mrmx 返回 0 行（探测窗应有全市场数据）');
    await store.readBytes(r.artifact.sha256); // 哈希校验读回
    if (!r.notices.includes(BACKFILL_REVISION_NOTICE)) throw new Error('R4 声明未随行');
    if (!r.notices.includes(EMBLOCK_REVISION_NOTICE)) throw new Error('大宗注记未随行');
    const poolFacts = r.insertedFactIds.length + r.identicalFactIds.length;
    console.log(
      `[emblock-smoke] mrmx rows=${String(r.rowCount)} poolFacts=${String(poolFacts)} ` +
        `(new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)}) ` +
        `rejected=${String(r.rejectedRows.length)} filteredOut=${String(r.filteredOut)}`,
    );
    if (poolFacts === 0) throw new Error('无池内事实——池过滤或来源异常（探测窗池内命中 14 行）');

    // ---- as-of 截点过滤（无泄漏）：600036 2026-10-21 成交在 2026-10-22 00:00+08 前不可见 ----
    const availT = new Date('2026-10-22T00:00:00+08:00').getTime();
    const before = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '600036',
      factKind: 'BLOCK_TRADE',
      asOf: new Date(availT - 1),
    });
    const after = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '600036',
      factKind: 'BLOCK_TRADE',
      asOf: new Date(availT),
    });
    if (before.length !== 0) throw new Error(`as-of 泄漏：交易日次日 00:00+08 前可见 ${String(before.length)} 条`);
    if (after.length === 0) throw new Error('as-of 次日 00:00+08 后应可见 600036 大宗事实');

    console.log(
      JSON.stringify(
        {
          result: 'EMBLOCK SMOKE OK',
          adapterVersion: EMBLOCK_ADAPTER_VERSION,
          realRequests: bridgeCalls,
          window: WINDOW,
          mrmx: {
            rows: r.rowCount,
            poolFacts,
            newFacts: r.insertedFactIds.length,
            identicalFacts: r.identicalFactIds.length,
            rejected: r.rejectedRows.length,
            filteredOut: r.filteredOut,
            artifact: r.artifact.sha256,
          },
          asOfCheck: 'PASS（交易日次日 00:00+08 截点前后行为符合）',
        },
        null,
        2,
      ),
    );
    if (bridgeCalls > 4) throw new Error(`真实请求超预算：${String(bridgeCalls)} > 4`);
  } finally {
    await pool.end();
  }
}

await main();
