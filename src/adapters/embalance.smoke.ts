/**
 * Lyra · 东财资产负债表适配器真实冒烟（P1 W30；派发预算 ≤4 真实请求）。
 *
 * 真实请求 1 次桥调用（600519，池内样本，东财 F10 资产负债表按报告期全历史；akshare 包装
 * 内部分页如实并入该 1 次桥调用），与 emfund 冒烟合计 2 ≤ 4 预算。事实身份由原始行派生
 * （不含抓取时刻）→ 重放去重由单测与全量回填 IDENTICAL 计数证明，冒烟不重复请求。
 *
 * 断言：原始行 canonical JSON 原件入库（哈希校验读回）+ 事实落库（BALANCE subjectType=STOCK、
 * availableAt=披露日次日 00:00+08；sourcePublishedAt=披露日 00:00+08；eventAt=报告期 00:00+08）
 * + as-of 读回无泄漏 + 事实数 = 行数 − 拒绝行数 + **跨源校验**：2024-12-31 报告期行
 * NOTICE_DATE_ISO='2025-04-03' 与 BaoStock query_profit_data pubDate 探测实测一致
 * （W30 探测证据 /tmp/lyra-w30/probe-bs.py 输出，不产生新请求）+ 2024-12-31 行 GOODWILL=null
 * （600519 实测全历史无商誉形态）。
 *
 * 运行：node --import tsx src/adapters/embalance.smoke.ts
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
  BAL_NOTICE_DATE_ISO,
  BAL_REPORT_DATE_ISO,
  EmbalanceAdapter,
  makeEmbalanceBridgeExecutor,
  shanghaiDayStart,
  shanghaiNextDayStart,
} from './embalance.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const CODE = '600519';
/** BaoStock query_profit_data pubDate 探测实测（2024Q4）：2025-04-03（W30 探测证据，跨源锚点）。 */
const BS_PUBDATE_2024Q4 = '2025-04-03';

interface BalanceRow {
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
  const realExec = makeEmbalanceBridgeExecutor();
  const countingExec = async (args: string[]): Promise<BridgeResponse> => {
    bridgeCalls += 1;
    return realExec(args);
  };
  const adapter = new EmbalanceAdapter({ pool, store, execBridge: countingExec });
  const nowMs = Date.now();

  // ---- 真实请求 1：600519 全历史资产负债表（一次桥调用）----
  const balance = await adapter.fetchBalanceSheet(CODE);
  const rows = JSON.parse(
    new TextDecoder().decode(await store.readBytes(balance.artifact.sha256)),
  ) as BalanceRow[];

  // ---- 断言：行数与拒绝 ----
  if (balance.rowCount !== rows.length || balance.rowCount < 100) {
    throw new Error(`资产行数异常：rowCount=${String(balance.rowCount)} 原件=${String(rows.length)}（600519 实测 103 行）`);
  }
  if (balance.rejectedRows.length !== 0) throw new Error(`资产出现拒绝行：${JSON.stringify(balance.rejectedRows)}`);
  if (balance.insertedFactIds.length + balance.identicalFactIds.length !== balance.rowCount) {
    throw new Error('资产事实数 ≠ 行数（有未解释行）');
  }

  // ---- 断言：逐事实五时间字段自洽 + 无泄漏 ----
  const facts = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: CODE, factKind: 'BALANCE', asOf: new Date(nowMs),
  });
  for (const f of facts) {
    const tv = f.typedValue as BalanceRow;
    const report = tv[BAL_REPORT_DATE_ISO];
    const notice = tv[BAL_NOTICE_DATE_ISO];
    if (typeof report !== 'string' || typeof notice !== 'string') throw new Error('资产事实缺时点字段');
    if (f.availableAt !== shanghaiNextDayStart(notice)) {
      throw new Error(`BALANCE availableAt ≠ 披露日+1：${f.availableAt} vs notice=${notice}`);
    }
    if (f.sourcePublishedAt !== shanghaiDayStart(notice)) {
      throw new Error('BALANCE sourcePublishedAt ≠ 披露日 00:00+08');
    }
    if (f.eventAt !== shanghaiDayStart(report)) {
      throw new Error('BALANCE eventAt ≠ 报告期 00:00+08');
    }
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：资产 availableAt 在当前时刻之后');
  }
  if (facts.length < 100) throw new Error(`资产事实 as-of 读回过少：${String(facts.length)}`);

  // ---- 跨源校验：2024-12-31 报告期披露日与 BaoStock pubDate 探测一致 ----
  const target = rows.find((r) => r[BAL_REPORT_DATE_ISO] === '2024-12-31');
  if (target === undefined) throw new Error('原件缺 2024-12-31 报告期行（跨源校验锚点缺失）');
  const noticeIso = target[BAL_NOTICE_DATE_ISO];
  if (noticeIso !== BS_PUBDATE_2024Q4) {
    throw new Error(`跨源校验失败：东财 NOTICE_DATE=${String(noticeIso)} vs BaoStock pubDate=${BS_PUBDATE_2024Q4}`);
  }
  if (target['GOODWILL'] !== null) {
    throw new Error(`600519 2024 年报 GOODWILL 预期 null（源无商誉），实际 ${String(target['GOODWILL'])}`);
  }
  if (typeof target['TOTAL_PARENT_EQUITY'] !== 'number') {
    throw new Error('2024 年报 TOTAL_PARENT_EQUITY 缺失或非数值');
  }

  // ---- 深度快报（首末报告期 + as-of 披露截点示例）----
  const reports = rows.map((r) => String(r[BAL_REPORT_DATE_ISO])).sort();
  // 披露截点示例：2015-04-22 读回应含 2015-03-31 一季报（披露 2015-04-21 次日起可见）
  const asOfProbe = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: CODE, factKind: 'BALANCE', asOf: new Date('2015-04-22T00:00:00.000Z'),
  });
  const q1_2015Visible = asOfProbe.some((f) => (f.typedValue as BalanceRow)[BAL_REPORT_DATE_ISO] === '2015-03-31');

  if (bridgeCalls > 4) throw new Error(`真实桥调用超预算：${String(bridgeCalls)} > 4`);
  if (!q1_2015Visible) throw new Error('as-of 披露截点校验失败：2015-04-22 未读回 2015-03-31 报告期');

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: balance.adapterVersion,
    realRequests: { bridgeCalls, budget: 4 },
    balance: {
      scope: balance.scope,
      rowCount: balance.rowCount,
      inserted: balance.insertedFactIds.length,
      identical: balance.identicalFactIds.length,
      rangeReportDate: [reports[0], reports[reports.length - 1]],
      artifact: { sha256: balance.artifact.sha256, bytes: balance.artifact.bytes },
    },
    crossCheck: {
      reportDate: '2024-12-31',
      emNoticeDate: noticeIso,
      baostockPubDate: BS_PUBDATE_2024Q4,
      goodwill2024: target['GOODWILL'],
      totalParentEquity2024: target['TOTAL_PARENT_EQUITY'],
    },
    asOfReadback: {
      balanceFacts: facts.length,
      noLeak: true,
      q1_2015VisibleAt_2015_04_22: q1_2015Visible,
    },
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
