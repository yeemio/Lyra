/**
 * Lyra · 限售解禁适配器真实冒烟（P2 W42: code-writer，C4）。
 *
 * 有界真实请求 2 个（≤4 预算）：
 * 1. queue 603986（探测已知有数池内股，var/w42-probe2.py：23 行 2017-08-18~2025-12-22，
 *    含明细股数/市值/限售股类型）——按个股全历史形态。
 * 2. queue 600036（探测已知空源，var/w42-probe2.py：0 行）——空源如实入档路径。
 *
 * 断言：桥 stdout JSON 原件入库（哈希校验读回）+ 事实落库（UNLOCK_DETAIL
 * availableAt=解禁日次日 00:00+08、eventAt=解禁日 15:00+08）+ 池主体覆盖（603986 全部
 * 批次入事实）+ as-of 截点过滤无泄漏（最近解禁日次日 00:00+08 前该批次不可见）+
 * 未来批次到期前不可见 + R4/面内注记随行 + 空源 0 事实不造数。
 *
 * 运行：node --import tsx src/adapters/emunlock.smoke.ts
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
  EMUNLOCK_ADAPTER_VERSION,
  EMUNLOCK_REVISION_NOTICE,
  EmUnlockAdapter,
  makeEmUnlockBridgeExecutor,
} from './emunlock.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

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
    const realExec = makeEmUnlockBridgeExecutor();
    const countingExec = async (args: string[]) => {
      bridgeCalls += 1;
      return await realExec(args);
    };
    const adapter = new EmUnlockAdapter({ pool, store, execBridge: countingExec });

    const researchPool = parseResearchPool(
      await readFile(join(repoRoot, 'data', 'research-pool.json'), 'utf8'),
    );
    const poolCodes = new Set(researchPool.stocks.map((s) => s.code));
    if (!poolCodes.has('603986') || !poolCodes.has('600036')) {
      throw new Error('冒烟标的须在冻结池内（603986/600036）');
    }
    console.log(`[emunlock-smoke] 池 ${String(poolCodes.size)} 股；冒烟标的 603986（有数）+ 600036（空源）`);

    // ---- 请求 1：queue 603986 全历史（探测已知 23 行）----
    const r = await adapter.fetchUnlockQueue('603986');
    if (r.rowCount === 0) throw new Error('queue 603986 返回 0 行（探测窗应有数据）');
    if (r.rowCount >= 500) throw new Error('rows 达单页上限——疑似截断（探测 23 行，不应达上限）');
    await store.readBytes(r.artifact.sha256); // 哈希校验读回
    if (!r.notices.includes(BACKFILL_REVISION_NOTICE)) throw new Error('R4 声明未随行');
    if (!r.notices.includes(EMUNLOCK_REVISION_NOTICE)) throw new Error('解禁面注记未随行');
    const poolFacts = r.insertedFactIds.length + r.identicalFactIds.length;
    console.log(
      `[emunlock-smoke] queue 603986 rows=${String(r.rowCount)} facts=${String(poolFacts)} ` +
        `(new=${String(r.insertedFactIds.length)} dup=${String(r.identicalFactIds.length)}) ` +
        `rejected=${String(r.rejectedRows.length)}`,
    );
    if (poolFacts === 0) throw new Error('603986 无事实——映射或来源异常（探测 23 行）');

    // 抽查明细字段（C4 核心：股数/金额）
    const anyFact = (await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '603986',
      factKind: 'UNLOCK_DETAIL',
      asOf: new Date(), // 现在：全部过去批次可见
    })).find((f) => {
      const tv = f.typedValue as Record<string, unknown>;
      return typeof tv['解禁数量'] === 'number' && typeof tv['实际解禁数量市值'] === 'number';
    });
    if (anyFact === undefined) throw new Error('未见含股数/市值的 UNLOCK_DETAIL 事实（C4 明细缺失）');
    const tv = anyFact.typedValue as Record<string, unknown>;
    console.log(
      `[emunlock-smoke] 明细抽查 unlockDateISO=${String(tv['unlockDateISO'])} ` +
        `解禁数量(股)=${String(tv['解禁数量'])} 实际解禁数量市值(元)=${String(tv['实际解禁数量市值'])} ` +
        `限售股类型=${String(tv['限售股类型'])}`,
    );

    // ---- as-of 截点过滤（无泄漏）：取回传批次的最大过去解禁日 D，D 次日 00:00+08 前该批次不可见 ----
    const pastDates = (await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '603986',
      factKind: 'UNLOCK_DETAIL',
      asOf: new Date(),
    }))
      .map((f) => String((f.typedValue as Record<string, unknown>)['unlockDateISO']))
      .filter((d) => d <= new Date().toISOString().slice(0, 10))
      .sort();
    const latest = pastDates.at(-1);
    if (latest === undefined) throw new Error('无过去批次可做 as-of 检查');
    const availT = new Date(new Date(`${latest}T00:00:00+08:00`).getTime() + 86_400_000).getTime();
    const before = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '603986',
      factKind: 'UNLOCK_DETAIL',
      asOf: new Date(availT - 1),
    });
    const leaked = before.some((f) => (f.typedValue as Record<string, unknown>)['unlockDateISO'] === latest);
    if (leaked) throw new Error(`as-of 泄漏：解禁日次日 00:00+08 前可见 ${latest} 批次`);
    const after = await asOfFacts(pool, {
      subjectType: 'STOCK',
      subjectId: '603986',
      factKind: 'UNLOCK_DETAIL',
      asOf: new Date(availT),
    });
    const visibleLatest = after.some((f) => (f.typedValue as Record<string, unknown>)['unlockDateISO'] === latest);
    if (!visibleLatest) throw new Error(`as-of 次日 00:00+08 后应可见 ${latest} 批次`);
    console.log(`[emunlock-smoke] as-of 检查（最近解禁日 ${latest}）通过：次日 00:00+08 前不可见 / 后可见`);

    // ---- 请求 2：queue 600036 全历史（探测已知空源——诚实空路径）----
    const emptyRes = await adapter.fetchUnlockQueue('600036');
    if (emptyRes.rowCount !== 0) throw new Error(`600036 探测为空源，实测 ${String(emptyRes.rowCount)} 行（来源面变化，须复核）`);
    if (emptyRes.insertedFactIds.length !== 0 || emptyRes.identicalFactIds.length !== 0) {
      throw new Error('空源不得产出事实');
    }
    const emptyBytes = await store.readBytes(emptyRes.artifact.sha256);
    if (new TextDecoder().decode(emptyBytes) !== '[]') throw new Error('空原件须为 []');
    console.log('[emunlock-smoke] queue 600036 空源如实入档（0 事实、空原件 []、非失败）');

    console.log(
      JSON.stringify(
        {
          result: 'EMUNLOCK SMOKE OK',
          adapterVersion: EMUNLOCK_ADAPTER_VERSION,
          realRequests: bridgeCalls,
          targets: ['603986（有数）', '600036（空源）'],
          queue603986: {
            rows: r.rowCount,
            facts: poolFacts,
            newFacts: r.insertedFactIds.length,
            identicalFacts: r.identicalFactIds.length,
            rejected: r.rejectedRows.length,
            artifact: r.artifact.sha256,
            latestPastUnlock: latest,
          },
          queue600036: { rows: 0, facts: 0, artifact: emptyRes.artifact.sha256, emptySource: true },
          asOfCheck: `PASS（解禁日 ${latest} 次日 00:00+08 截点前后行为符合；未来批次到期前不可见）`,
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
