/**
 * Lyra · 东财风险面适配器真实冒烟（P1 W29；派发预算 ≤4 真实请求）。
 *
 * 真实请求 2 次桥调用（600519，池内样本）：
 * 1. pledge（东财 RPT_CSDC_LIST 按个股过滤，全历史周度快照；桥内按 500 行/页分页，
 *    600519 实测 608 行 → 2 页 HTTP）；
 * 2. gdhs（akshare.stock_zh_a_gdhs_detail_em，全历史；63 行 → 1 页 HTTP）。
 * 底层 HTTP 页数从桥响应 meta.httpCalls 如实采集（户数包装不分页计 1）；合计 ≤4 预算。
 * 事实身份由原始行派生（不含抓取时刻）→ 重放去重由单测与全量回填 IDENTICAL 计数证明，冒烟不重复请求。
 *
 * 断言：原始行 canonical JSON 原件入库（哈希校验读回）+ 事实落库
 * （PLEDGE_RATIO availableAt=快照日次日 00:00+08；HOLDER_COUNT availableAt=公告披露日次日
 * 00:00+08、sourcePublishedAt=披露日 00:00+08、eventAt=统计截止日 00:00+08）+
 * as-of 读回无泄漏（逐事实与全体 max availableAt ≤ 当前时刻）+ 事实数 = 行数（无未解释行）。
 *
 * 运行：node --import tsx src/adapters/emrisk.smoke.ts
 * 目标库：默认 public schema（createPool 默认 search_path）；p1-migration 幂等应用。
 * 原件目录：env LYRA_ARTIFACTS_DIR，缺省 <repo>/data/artifacts（冒烟事实/原件并入正式库，
 * 全量回填同内容重放 → IDENTICAL 去重）。
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
  EmriskAdapter,
  makeEmriskBridgeExecutor,
  shanghaiNextDayStart,
} from './emrisk.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const CODE = '600519';

interface PledgeRow {
  TRADE_DATE_ISO?: string;
}

interface GdhsRow {
  '股东户数统计截止日'?: string;
  '股东户数公告日期'?: string;
}

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  // 真实请求计数：桥调用粒度 + 底层 HTTP 页数（桥 meta.httpCalls 如实采集；户数包装不分页计 1）
  let bridgeCalls = 0;
  let httpPages = 0;
  const realExec = makeEmriskBridgeExecutor();
  const countingExec = async (args: string[]): Promise<BridgeResponse> => {
    bridgeCalls += 1;
    const res = await realExec(args);
    const metaHttp = (res as { meta?: { httpCalls?: number } }).meta?.httpCalls;
    httpPages += typeof metaHttp === 'number' && metaHttp > 0 ? metaHttp : 1;
    return res;
  };
  const adapter = new EmriskAdapter({ pool, store, execBridge: countingExec });
  const nowMs = Date.now();

  // ---- 真实请求 1：质押全历史周度快照（一次桥调用，桥内分页如实计数）----
  const pledge = await adapter.fetchPledgeRatio(CODE);
  const pledgeRows = JSON.parse(
    new TextDecoder().decode(await store.readBytes(pledge.artifact.sha256)),
  ) as PledgeRow[];

  // ---- 真实请求 2：股东户数全历史（一次桥调用）----
  const gdhs = await adapter.fetchHolderCount(CODE);
  const gdhsRows = JSON.parse(
    new TextDecoder().decode(await store.readBytes(gdhs.artifact.sha256)),
  ) as GdhsRow[];

  // ---- 断言：行数与拒绝 ----
  if (pledge.rowCount !== pledgeRows.length || pledge.rowCount < 300) {
    throw new Error(`质押行数异常：rowCount=${String(pledge.rowCount)} 原件=${String(pledgeRows.length)}`);
  }
  if (pledge.rejectedRows.length !== 0) throw new Error(`质押出现拒绝行：${JSON.stringify(pledge.rejectedRows)}`);
  if (gdhs.rowCount !== gdhsRows.length || gdhs.rowCount < 20) {
    throw new Error(`户数行数异常：rowCount=${String(gdhs.rowCount)} 原件=${String(gdhsRows.length)}`);
  }
  if (gdhs.rejectedRows.length !== 0) throw new Error(`户数出现拒绝行：${JSON.stringify(gdhs.rejectedRows)}`);
  if (pledge.insertedFactIds.length + pledge.identicalFactIds.length !== pledge.rowCount) {
    throw new Error('质押事实数 ≠ 行数（有未解释行）');
  }
  if (gdhs.insertedFactIds.length + gdhs.identicalFactIds.length !== gdhs.rowCount) {
    throw new Error('户数事实数 ≠ 行数（有未解释行）');
  }

  // ---- 断言：逐事实 availableAt 与行内时点字段自洽 + 无泄漏 ----
  const pledgeFacts = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: CODE, factKind: 'PLEDGE_RATIO', asOf: new Date(nowMs),
  });
  for (const f of pledgeFacts) {
    const iso = (f.typedValue as PledgeRow).TRADE_DATE_ISO;
    if (typeof iso !== 'string') throw new Error('质押事实缺 TRADE_DATE_ISO');
    if (f.availableAt !== shanghaiNextDayStart(iso)) {
      throw new Error(`PLEDGE_RATIO availableAt ≠ 快照日+1：${f.availableAt} vs iso=${iso}`);
    }
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：质押 availableAt 在当前时刻之后');
  }
  const gdhsFacts = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: CODE, factKind: 'HOLDER_COUNT', asOf: new Date(nowMs),
  });
  for (const f of gdhsFacts) {
    const tv = f.typedValue as GdhsRow;
    const notice = tv['股东户数公告日期'];
    const endDate = tv['股东户数统计截止日'];
    if (typeof notice !== 'string' || typeof endDate !== 'string') throw new Error('户数事实缺时点字段');
    if (f.availableAt !== shanghaiNextDayStart(notice)) {
      throw new Error(`HOLDER_COUNT availableAt ≠ 披露日+1：${f.availableAt} vs notice=${notice}`);
    }
    if (f.sourcePublishedAt !== new Date(`${notice}T00:00:00+08:00`).toISOString()) {
      throw new Error('HOLDER_COUNT sourcePublishedAt ≠ 披露日 00:00+08');
    }
    if (f.eventAt !== new Date(`${endDate}T00:00:00+08:00`).toISOString()) {
      throw new Error('HOLDER_COUNT eventAt ≠ 统计截止日 00:00+08');
    }
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：户数 availableAt 在当前时刻之后');
  }
  if (pledgeFacts.length < 300) throw new Error(`质押事实 as-of 读回过少：${String(pledgeFacts.length)}`);
  if (gdhsFacts.length < 20) throw new Error(`户数事实 as-of 读回过少：${String(gdhsFacts.length)}`);

  // ---- 深度快报（首末时点，证明全历史口径）----
  const pledgeIsos = pledgeFacts.map((f) => (f.typedValue as PledgeRow).TRADE_DATE_ISO as string).sort();
  const gdhsEnds = gdhsFacts.map((f) => (f.typedValue as GdhsRow)['股东户数统计截止日'] as string).sort();
  const gdhsNotices = gdhsFacts.map((f) => (f.typedValue as GdhsRow)['股东户数公告日期'] as string).sort();

  if (httpPages > 4) throw new Error(`真实 HTTP 请求超预算：${String(httpPages)} > 4`);

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: pledge.adapterVersion,
    realRequests: { bridgeCalls, httpPages, budget: 4 },
    pledge: {
      scope: pledge.scope,
      rowCount: pledge.rowCount,
      inserted: pledge.insertedFactIds.length,
      identical: pledge.identicalFactIds.length,
      range: [pledgeIsos[0], pledgeIsos[pledgeIsos.length - 1]],
      artifact: { sha256: pledge.artifact.sha256, bytes: pledge.artifact.bytes },
    },
    gdhs: {
      scope: gdhs.scope,
      rowCount: gdhs.rowCount,
      inserted: gdhs.insertedFactIds.length,
      identical: gdhs.identicalFactIds.length,
      rangeEndDate: [gdhsEnds[0], gdhsEnds[gdhsEnds.length - 1]],
      rangeNoticeDate: [gdhsNotices[0], gdhsNotices[gdhsNotices.length - 1]],
      artifact: { sha256: gdhs.artifact.sha256, bytes: gdhs.artifact.bytes },
    },
    asOfReadback: { pledgeFacts: pledgeFacts.length, gdhsFacts: gdhsFacts.length, noLeak: true },
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
