/**
 * Lyra · BaoStock 适配器真实冒烟（P1 W4: code-writer-pro；P1-DATA Done-when 1 的 BaoStock 面）。
 *
 * 有界真实请求：3 个（≤4 预算）——600519 三日 K 线 + 复权因子窗口 + 沪深300 成分单日。
 * 断言：响应原件入库（application/json，firstObservedAt=抓取时刻，哈希校验读回）+
 * 事实落库（factKind/availableAt 按冻结规则）+ as-of 读回正确（截点前后可见性变化）。
 *
 * 运行：node --import tsx src/adapters/baostock.smoke.ts
 * 目标库：默认 public schema（createPool 默认 search_path）；p1-migration 幂等应用。
 * 原件目录：env LYRA_ARTIFACTS_DIR，缺省 <repo>/data/artifacts（R24 冻结根）。
 */
import { asOfFacts } from '../pintime/facts.js';
import { applySchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import type { BridgeRow } from './adapter-types.js';
import { BaoStockAdapter } from './baostock.js';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const CODE = 'sh.600519';
const K_START = '2026-10-20';
const K_END = '2026-10-22';

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等（if not exists）；public 已有 P0 表则无操作
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data/artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  const adapter = new BaoStockAdapter({ pool, store });
  let realRequests = 0; // 每次 fetch = 1 个桥调用（login→查询→logout）= 1 个真实请求

  // ---- 请求 1：三日日线 ----
  const kline = await adapter.fetchDailyBars(CODE, K_START, K_END);
  realRequests += 1;
  // ---- 请求 2：复权因子窗口（2024 起，覆盖两个年度除权日）----
  const adjust = await adapter.fetchAdjustFactor(CODE, '2024-01-01', K_END);
  realRequests += 1;
  // ---- 请求 3：沪深300 成分单日 ----
  const hs300 = await adapter.fetchIndexMembership('hs300', K_END);
  realRequests += 1;

  const report: Record<string, unknown>[] = [];
  for (const r of [kline, adjust, hs300]) {
    // 原件读回：readBytes 自带哈希校验（HASH_MISMATCH 即抛），再核对行数
    const bytes = await store.readBytes(r.artifact.sha256);
    const rows = JSON.parse(new TextDecoder().decode(bytes)) as BridgeRow[];
    if (rows.length !== r.rowCount) throw new Error(`原件行数不符：${r.scope} rows=${String(rows.length)} rowCount=${String(r.rowCount)}`);
    report.push({
      command: r.command,
      params: r.params,
      scope: r.scope,
      rowCount: r.rowCount,
      artifact: { sha256: r.artifact.sha256, bytes: r.artifact.bytes, firstObservedAt: r.artifact.firstObservedAt },
      insertedFacts: r.insertedFactIds.length,
      identicalFacts: r.identicalFactIds.length,
      rejectedRows: r.rejectedRows,
    });
  }

  // ---- as-of 读回：K 线截点前后可见性 ----
  const winDates = [K_START, '2026-10-21', '2026-10-22'];
  const barsAt = async (asOf: string) => {
    const facts = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', asOf: new Date(asOf) });
    const dates = facts
      .map((f) => (f.typedValue as BridgeRow).date)
      .filter((d): d is string => typeof d === 'string' && winDates.includes(d))
      .sort();
    for (const f of facts) {
      if (new Date(f.availableAt).getTime() > new Date(asOf).getTime()) {
        throw new Error(`泄漏违约：available_at ${f.availableAt} > 截点 ${asOf}`);
      }
    }
    return dates;
  };
  const beforeClose = await barsAt('2026-10-21T06:59:59.000Z'); // 10-21 收盘前一秒：只见 10-20
  const afterClose = await barsAt('2026-10-22T07:00:00.000Z'); // 10-22 收盘（含当日）：三根全见
  if (beforeClose.length !== 1 || afterClose.length !== 3) {
    throw new Error(`as-of 读回不正确：beforeClose=${JSON.stringify(beforeClose)} afterClose=${JSON.stringify(afterClose)}`);
  }

  // ---- 成分/因子事实形状抽查 ----
  const members = await asOfFacts(pool, { subjectType: 'STOCK', factKind: 'INDEX_MEMBERSHIP', asOf: new Date(`${K_END}T07:00:00.000Z`) });
  const hs300Members = members.filter(
    (f) => {
      const tv = f.typedValue as BridgeRow;
      return tv.bsIndex === 'hs300' && typeof tv.updateDate === 'string' && tv.updateDate <= K_END;
    },
  );
  const factors = await asOfFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ADJUST_FACTOR', asOf: new Date(`${K_END}T07:00:00.000Z`) });
  if (hs300Members.length < 250) throw new Error(`沪深300 成分事实过少：${String(hs300Members.length)}`);
  if (factors.length < 1) throw new Error('复权因子事实为空');

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: kline.adapterVersion,
    realRequests,
    requests: report,
    asOf: {
      cutoffBefore: '2026-10-21T06:59:59.000Z',
      visibleBarsBefore: beforeClose,
      cutoffAfter: '2026-10-22T07:00:00.000Z',
      visibleBarsAfter: afterClose,
    },
    spotCheck: { hs300MembershipFacts: hs300Members.length, adjustFactorFacts: factors.length },
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
