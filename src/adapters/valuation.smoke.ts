/**
 * Lyra · 指数估值适配器真实冒烟（P2 W31: code-writer-pro）。
 *
 * 有界真实请求 4 个（≤6 预算）：
 * 1. lg_pe sz50（000016 上证50，月末全史自 2005-01）；
 * 2. lg_pb sz50（000016，月末全史）；
 * 3. csindex_daily 000300（沪深300，官方日频 20 交易日窗）；
 * 4. all_a_pe（全A PE 月末全史）。
 *
 * 断言：原件入库（哈希校验读回）+ 事实落库（INDEX_VALUATION availableAt=数据日次日 00:00+08
 * 保守口径）+ 深度覆盖（lg ≥200 行且首行 ≤2006 / csindex 15–30 行窗）+ as-of 截点过滤无泄漏
 * + 双 R4 声明（通用修订 + 估值快照口径）随行 + typedValue 来源/频率标记。
 *
 * 运行：node --import tsx src/adapters/valuation.smoke.ts
 * 目标库：public schema（createPool 默认）；p1-migration 幂等应用。
 * 原件目录：env LYRA_ARTIFACTS_DIR，缺省 <repo>/data/artifacts。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../db/pool.js';
import { applySchema } from '../db/exec.js';
import { asOfFacts } from '../pintime/facts.js';
import { ArtifactStore } from '../artifacts/store.js';
import {
  BACKFILL_REVISION_NOTICE,
} from './adapter-types.js';
import {
  VALUATION_ADAPTER_VERSION,
  VALUATION_SNAPSHOT_NOTICE,
  ValuationAdapter,
  makeValuationBridgeExecutor,
} from './valuation.js';

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

    let bridgeCalls = 0;
    const realExec = makeValuationBridgeExecutor();
    const countingExec = async (args: string[]) => {
      bridgeCalls += 1;
      return await realExec(args);
    };
    const adapter = new ValuationAdapter({ pool, store, execBridge: countingExec });

    // ---- 请求 1/2：legulegu 上证50 PE + PB（月末全史）----
    const pe = await adapter.fetchLgPe('000016', 'sz50');
    const pb = await adapter.fetchLgPb('000016', 'sz50');
    for (const r of [pe, pb]) {
      await store.readBytes(r.artifact.sha256); // 哈希校验读回
      if (!r.notices.includes(BACKFILL_REVISION_NOTICE) || !r.notices.includes(VALUATION_SNAPSHOT_NOTICE)) {
        throw new Error(`${r.scope} 双 R4 声明未随行`);
      }
      if (r.rowCount < 200) throw new Error(`${r.scope} 行数 ${String(r.rowCount)} < 200（月末全史预期）`);
    }
    const peFacts = pe.insertedFactIds.length + pe.identicalFactIds.length;
    const pbFacts = pb.insertedFactIds.length + pb.identicalFactIds.length;
    if (peFacts < 200 || pbFacts < 200) {
      throw new Error(`上证50 事实数 PE=${String(peFacts)} PB=${String(pbFacts)}（<200）`);
    }

    // typedValue 标记 + 首末日期深度
    const all = await asOfFacts(pool, {
      subjectType: 'INDEX',
      subjectId: '000016',
      factKind: 'INDEX_VALUATION',
      asOf: new Date('2026-10-25T00:00:00.000Z'),
    });
    const peTv = all.find((f) => (f.typedValue as Record<string, unknown>)['指标'] === 'PE');
    if (peTv === undefined) throw new Error('000016 PE 事实 as-of 不可见');
    const tv = peTv.typedValue as Record<string, unknown>;
    if (tv['来源'] !== 'legulegu' || tv['频率'] !== '月末') throw new Error(`typedValue 标记异常：${String(tv['来源'])}/${String(tv['频率'])}`);
    const dates = all.map((f) => f.eventAt!).sort();
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    if (first > '2006-01-15' || last < '2026-09-01') {
      throw new Error(`上证50 深度异常：${first.slice(0, 10)}~${last.slice(0, 10)}`);
    }

    // ---- as-of 截点过滤（无泄漏）：最早月末行在次日 00:00+08 前不可见 ----
    const earliestDay = first.slice(0, 10);
    const boundary = new Date(new Date(`${earliestDay}T00:00:00+08:00`).getTime() + 86_400_000);
    const before = await asOfFacts(pool, {
      subjectType: 'INDEX',
      subjectId: '000016',
      factKind: 'INDEX_VALUATION',
      asOf: new Date(boundary.getTime() - 1),
    });
    const after = await asOfFacts(pool, {
      subjectType: 'INDEX',
      subjectId: '000016',
      factKind: 'INDEX_VALUATION',
      asOf: boundary,
    });
    if (before.length !== 0) throw new Error(`as-of 泄漏：${earliestDay} 次日 00:00+08 前可见 ${String(before.length)} 条`);
    if (after.length === 0) throw new Error('as-of 边界后应可见最早月末行');

    // ---- 请求 3：csindex 官方日频（000300，20 交易日窗）----
    const cs = await adapter.fetchCsindexDaily('000300');
    await store.readBytes(cs.artifact.sha256);
    if (cs.rowCount < 15 || cs.rowCount > 30) {
      throw new Error(`csindex 窗口行数 ${String(cs.rowCount)}（预期 15–30）`);
    }
    if (cs.insertedFactIds.length + cs.identicalFactIds.length !== cs.rowCount) {
      throw new Error(`csindex 事实数 ${String(cs.insertedFactIds.length + cs.identicalFactIds.length)} ≠ 行数 ${String(cs.rowCount)}（拒截 ${String(cs.rejectedRows.length)}）`);
    }

    // ---- 请求 4：全A PE（月末全史，背景口径）----
    const aa = await adapter.fetchAllAPe();
    if (aa.rowCount < 200) throw new Error(`all_a_pe 行数 ${String(aa.rowCount)} < 200`);

    console.log(
      JSON.stringify(
        {
          result: 'VALUATION SMOKE OK',
          adapterVersion: VALUATION_ADAPTER_VERSION,
          realRequests: bridgeCalls,
          lgSz50: {
            pe: { rows: pe.rowCount, facts: peFacts, rejected: pe.rejectedRows.length },
            pb: { rows: pb.rowCount, facts: pbFacts, rejected: pb.rejectedRows.length },
            depth: `${first.slice(0, 10)}~${last.slice(0, 10)}`,
          },
          csindex000300: { rows: cs.rowCount, facts: cs.insertedFactIds.length + cs.identicalFactIds.length, rejected: cs.rejectedRows.length, artifact: cs.artifact.sha256 },
          allAPe: { rows: aa.rowCount, facts: aa.insertedFactIds.length + aa.identicalFactIds.length, rejected: aa.rejectedRows.length },
          asOfCheck: `PASS（${earliestDay} 月末行次日 00:00+08 前不可见）`,
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
