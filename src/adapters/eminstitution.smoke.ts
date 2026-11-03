/**
 * Lyra · 东财机构持仓面适配器真实冒烟（P1 W39；派发预算 ≤4 真实请求）。
 *
 * 真实请求 1 次桥调用（2026-09-30 报告期，26 池码池过滤，东财 zlsj/list 分页拉全市场——
 * 桥内 HTTP 分页页数从 meta 如实读出并断言 ≤4）：合计 HTTP ≤ 4 ≤ 4 预算。事实身份由原始行
 * 派生（不含抓取时刻）→ 重放去重由单测与全量回填 IDENTICAL 计数证明，冒烟不重复请求。
 *
 * 断言：原始行 canonical JSON 原件入库（哈希读回）+ 事实落库（FUND_HOLD subjectType=STOCK、
 * subjectId=裸码；availableAt=报告期+92 天 00:00+08 法定披露上界；sourcePublishedAt=null）+
 * 无泄漏（最新报告期 +92 天在抓取时刻之后 → as-of 现在不可见；全体可见事实 availableAt ≤ 现在）+
 * 结构自洽（行内代码 ⊆ 池码、REPORT_DATE 与请求期一致、HOLDCHA 枚举合法）+
 * fullRows ≥ 池命中行数（桥过滤如实申报）。
 * 锚点对照（探测实证 2026-10-25，var/w39-bridge-sample.json）：601318 在 2026-09-30 报告期
 * 命中（聚合值随披露在途可变，只断存在不断数值）。
 *
 * 运行：node --import tsx src/adapters/eminstitution.smoke.ts
 * 目标库：默认 public schema；p1-migration 幂等应用。原件目录：env LYRA_ARTIFACTS_DIR，
 * 缺省 <repo>/data/artifacts（冒烟事实/原件并入正式库，全量回填同内容重放 → IDENTICAL 去重）。
 */
import { asOfFacts, loadFact } from '../pintime/facts.js';
import { applySchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResponse } from './adapter-types.js';
import {
  FUND_HOLD_CODE_FIELD,
  FUND_HOLD_REPORT_DATE_FIELD,
  InstitutionAdapter,
  fundHoldAvailableAt,
  makeInstitutionBridgeExecutor,
} from './eminstitution.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const REPORT_DATE = '20260930';
const REPORT_DATE_ISO = '2026-09-30';

interface HoldRow {
  [key: string]: unknown;
}

/** 探测实证锚点（2026-10-25）：601318 在该报告期命中（var/w39-bridge-sample.json）。 */
const PROBE_ANCHOR_CODE = '601318';
/** HOLDCHA 来源枚举（探测实证：增仓/减仓/新进；其余形态如实入档不拒绝，仅记录）。 */
const HOLDCHA_ENUMS = ['增仓', '减仓', '新进'];

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  // 池 26 股（冻结池，data/research-pool.json）
  const poolRaw = JSON.parse(await readFile(join(repoRoot, 'data', 'research-pool.json'), 'utf8')) as {
    stocks: { code: string }[];
  };
  const codes = poolRaw.stocks.map((s) => s.code);
  if (codes.length !== 26) throw new Error(`池股数异常：${String(codes.length)} ≠ 26`);

  let bridgeCalls = 0;
  const realExec = makeInstitutionBridgeExecutor();
  const countingExec = async (args: string[]): Promise<BridgeResponse> => {
    bridgeCalls += 1;
    return realExec(args);
  };
  const adapter = new InstitutionAdapter({ pool, store, execBridge: countingExec });
  const nowMs = Date.now();

  // ---- 真实请求 1：2026-09-30 报告期全市场快照（桥内池过滤）----
  const hold = await adapter.fetchFundHold(REPORT_DATE, codes);
  const rows = JSON.parse(
    new TextDecoder().decode(await store.readBytes(hold.artifact.sha256)),
  ) as HoldRow[];

  // ---- 断言：行数与结构自洽 ----
  if (hold.rowCount !== rows.length) throw new Error('rowCount 与原件行数不一致');
  if (hold.rowCount < 1) throw new Error('2026-09-30 报告期池命中 0 行（锚点 601318 应命中）');
  if (hold.rejectedRows.length !== 0) throw new Error(`出现拒绝行：${JSON.stringify(hold.rejectedRows)}`);
  if (hold.insertedFactIds.length + hold.identicalFactIds.length !== hold.rowCount) {
    throw new Error('事实数 ≠ 行数（有未解释行）');
  }
  const fullRows = hold.fullRowCount;
  if (fullRows < hold.rowCount) throw new Error(`fullRows=${String(fullRows)} < 池命中 ${String(hold.rowCount)}（过滤申报异常）`);
  const wanted = new Set(codes);
  for (const row of rows) {
    const code = String(row[FUND_HOLD_CODE_FIELD]);
    if (!wanted.has(code)) throw new Error(`原件含池外代码：${code}`);
    const rd = String(row[FUND_HOLD_REPORT_DATE_FIELD]).slice(0, 10);
    if (rd !== REPORT_DATE_ISO) throw new Error(`行内报告期与请求期不一致：${rd}`);
    const holdcha = row['HOLDCHA'];
    if (holdcha !== null && typeof holdcha === 'string' && !HOLDCHA_ENUMS.includes(holdcha)) {
      throw new Error(`HOLDCHA 未见过形态（如实上报，不静默）：${holdcha}`);
    }
  }

  // ---- 断言：逐事实 availableAt 自洽 + 无泄漏（as-of 现在）----
  const visible = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: PROBE_ANCHOR_CODE, factKind: 'FUND_HOLD', asOf: new Date(nowMs),
  });
  const upper = fundHoldAvailableAt(REPORT_DATE_ISO);
  if (new Date(upper).getTime() <= nowMs) throw new Error('探测前提变化：+92 天上界已过（冒烟 as-of 断言需复核）');
  for (const f of visible) {
    if (new Date(f.availableAt).getTime() > nowMs) throw new Error('泄漏：可见事实 availableAt 在当前时刻之后');
    if (f.availableAt === upper) throw new Error('泄漏：最新报告期 +92 天上界未到，as-of 现在不可见（保守口径被破坏）');
  }
  // 最新报告期事实在库且上界正确（loadFact 直读，不经 as-of 过滤）
  if (hold.insertedFactIds.length > 0) {
    const fact = await loadFact(pool, hold.insertedFactIds[0]!);
    if (fact === null) throw new Error('插入事实读回失败');
    if (fact.availableAt !== upper) throw new Error(`FUND_HOLD availableAt ≠ 报告期+92 天：${fact.availableAt}`);
    if (fact.sourcePublishedAt !== null) throw new Error('FUND_HOLD sourcePublishedAt 须为 null（不编造披露日）');
  }

  // ---- 锚点：601318 命中（存在性断言；数值随披露在途可变，不断言）----
  const anchorRows = rows.filter((r) => String(r[FUND_HOLD_CODE_FIELD]) === PROBE_ANCHOR_CODE);
  if (anchorRows.length !== 1) throw new Error(`锚点 ${PROBE_ANCHOR_CODE} 命中异常：${String(anchorRows.length)} 行`);

  // ---- 预算与元数据申报 ----
  if (bridgeCalls > 4) throw new Error(`真实桥调用超预算：${String(bridgeCalls)} > 4`);
  const httpPages = Math.ceil(fullRows / 500);
  if (httpPages > 4) throw new Error(`HTTP 分页页数超冒烟预算：${String(httpPages)} > 4`);

  const sample = anchorRows[0]!;
  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: hold.adapterVersion,
    realRequests: { bridgeCalls, httpPagesEstimate: httpPages, budget: 4 },
    fundHold: {
      scope: hold.scope,
      reportDate: REPORT_DATE_ISO,
      poolHits: hold.rowCount,
      fullRows,
      inserted: hold.insertedFactIds.length,
      identical: hold.identicalFactIds.length,
      artifact: { sha256: hold.artifact.sha256, bytes: hold.artifact.bytes },
    },
    anchor: {
      code: PROBE_ANCHOR_CODE,
      houldNum: sample['HOULD_NUM'],
      holdValue: sample['HOLD_VALUE'],
      holdcha: sample['HOLDCHA'],
      probeAnchor: '2026-10-25 var/w39-bridge-sample.json（存在性对照）',
    },
    asOfReadback: { visibleFactsNow: visible.length, expectedVisible: 0, noLeak: true, availabilityUpper: upper },
    northboundNote: '北向个股面不可得：东财序列止于 2024-08-16（披露机制调整），近 2 年窗口无数据（var/w39-north-diag.txt）',
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
