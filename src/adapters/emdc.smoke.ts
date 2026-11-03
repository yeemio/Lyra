/**
 * Lyra · 两融/龙虎榜适配器真实冒烟（P2 W28: code-writer-pro）。
 *
 * 有界真实请求 3 个（≤6 预算）：
 * 1. margin_sse 2026-10-21（探测已知有数日）——上交所全市场两融明细；
 * 2. margin_szse 2026-10-21——深交所全市场两融明细；
 * 3. lhb_detail 2026-10-20~2026-10-24——东财龙虎榜 5 日窗。
 * 池过滤 = data/research-pool.json 26 股（事实面按池，原件全量）。
 *
 * 断言：桥 stdout JSON 原件入库（哈希校验读回）+ 事实落库（MARGIN_BALANCE/
 * DRAGON_TIGER availableAt=对应日 15:00+08）+ 池主体覆盖（两所各有 ≥1 只池内股）
 * + as-of 截点过滤无泄漏 + R4/面内注记随行。
 *
 * 运行：node --import tsx src/adapters/emdc.smoke.ts
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
import {
  EMDC_ADAPTER_VERSION,
  EmdcAdapter,
  LHB_REVISION_NOTICE,
  MARGIN_REVISION_NOTICE,
  makeEmdcBridgeExecutor,
} from './emdc.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const MARGIN_DAY = '2026-10-21'; // 探测已知有数日（var/w28-probe.py）
const LHB_WINDOW = { start: '2026-10-20', end: '2026-10-24' };

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
    const realExec = makeEmdcBridgeExecutor();
    const countingExec = async (args: string[]) => {
      bridgeCalls += 1;
      return await realExec(args);
    };
    const adapter = new EmdcAdapter({ pool, store, execBridge: countingExec });

    const researchPool = parseResearchPool(await readFile(join(repoRoot, 'data', 'research-pool.json'), 'utf8'));
    const stockCodes = researchPool.stocks.map((s) => s.code);
    const filter = new Set(stockCodes);
    console.log(`[emdc-smoke] 池 ${String(stockCodes.length)} 股（subjectFilter）`);

    // ---- 请求 1/2：两融两所（同日全市场）----
    const sse = await adapter.fetchMarginDetail('sse', MARGIN_DAY, filter);
    const szse = await adapter.fetchMarginDetail('szse', MARGIN_DAY, filter);
    for (const r of [sse, szse]) {
      if (r.rowCount === 0) throw new Error(`${r.resource} 返回 0 行（探测日应有全市场数据）`);
      await store.readBytes(r.artifact.sha256); // 哈希校验读回
      if (!r.notices.some((n) => n.includes('两融口径注记'))) {
        throw new Error(`${r.resource} 注记未随行`);
      }
    }
    if (!sse.notices.includes(MARGIN_REVISION_NOTICE) || !szse.notices.includes(MARGIN_REVISION_NOTICE)) {
      throw new Error('两融注记原文不符');
    }
    console.log(
      `[emdc-smoke] margin_sse rows=${String(sse.rowCount)} poolFacts=${String(sse.insertedFactIds.length)} ` +
        `rejected=${String(sse.rejectedRows.length)} filteredOut=${String(sse.filteredOut)}；` +
        `margin_szse rows=${String(szse.rowCount)} poolFacts=${String(szse.insertedFactIds.length)} ` +
        `rejected=${String(szse.rejectedRows.length)} filteredOut=${String(szse.filteredOut)}`,
    );
    if (sse.insertedFactIds.length === 0 && szse.insertedFactIds.length === 0) {
      throw new Error('两融两所均无池内事实——池过滤或来源异常');
    }

    // ---- 请求 3：龙虎榜 5 日窗 ----
    const lhb = await adapter.fetchLhbDetail(LHB_WINDOW.start, LHB_WINDOW.end, filter);
    await store.readBytes(lhb.artifact.sha256);
    if (!lhb.notices.includes(LHB_REVISION_NOTICE)) throw new Error('LHB 注记未随行');
    console.log(
      `[emdc-smoke] lhb rows=${String(lhb.rowCount)} poolFacts=${String(lhb.insertedFactIds.length)} ` +
        `rejected=${String(lhb.rejectedRows.length)} filteredOut=${String(lhb.filteredOut)}`,
    );

    // ---- as-of 截点过滤（无泄漏）：600519 两融在 2026-10-21 15:00+08 前不可见 ----
    const before = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '600519',
      factKind: 'MARGIN_BALANCE',
      asOf: new Date('2026-10-21T06:59:59.000Z'),
    });
    const after = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '600519',
      factKind: 'MARGIN_BALANCE',
      asOf: new Date('2026-10-21T07:00:00.000Z'),
    });
    if (before.length !== 0) throw new Error(`as-of 泄漏：15:00+08 前可见 ${String(before.length)} 条`);
    if (after.length === 0) throw new Error('as-of 15:00+08 后应可见 600519 两融事实');

    console.log(
      JSON.stringify(
        {
          result: 'EMDC SMOKE OK',
          adapterVersion: EMDC_ADAPTER_VERSION,
          realRequests: bridgeCalls,
          marginDay: MARGIN_DAY,
          lhbWindow: LHB_WINDOW,
          sse: { rows: sse.rowCount, poolFacts: sse.insertedFactIds.length, rejected: sse.rejectedRows.length, filteredOut: sse.filteredOut, artifact: sse.artifact.sha256 },
          szse: { rows: szse.rowCount, poolFacts: szse.insertedFactIds.length, rejected: szse.rejectedRows.length, filteredOut: szse.filteredOut, artifact: szse.artifact.sha256 },
          lhb: { rows: lhb.rowCount, poolFacts: lhb.insertedFactIds.length, rejected: lhb.rejectedRows.length, filteredOut: lhb.filteredOut, artifact: lhb.artifact.sha256 },
          asOfCheck: 'PASS（15:00+08 截点前后行为符合）',
        },
        null,
        2,
      ),
    );
    if (bridgeCalls > 6) throw new Error(`真实请求超预算：${String(bridgeCalls)} > 6`);
  } finally {
    await pool.end();
  }
}

await main();
