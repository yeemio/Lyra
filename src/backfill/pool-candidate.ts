/**
 * Lyra · 研究池候选计算器（P1 W6: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 5（候选计算与依据可回溯）、docs/PLAN.md §1
 * （筛选标准：沪深主板、非 ST、上市满一年、60 日日均成交额 ≥1 亿、行业每业 ≤3 只）、
 * docs/specs/DATA-SOURCES.md §6/§7（适配器取数 + 节流）。
 *
 * 输入（全部真实数据）：
 * - 当前 hs300+zz500 成分（月度回填的最新快照，INDEX_MEMBERSHIP 事实读回）∩ 沪深主板
 *   （600/601/603/605/000/001/002/003 前缀，R17 主板口径含 002/003）；
 * - 每候选：fetchStockBasic（名称/ipoDate，真实 1 调用）+ fetchDailyBars（近 60 交易日，
 *   真实 1 调用，算日均成交额与最新 isST——isST 按交易日时点取最新值，不回填历史）；
 * - 行业：INDUSTRY_CLASS_VERSION 事实（W6 实测为证监会行业分类，申万轴缺口登记，
 *   见 src/adapters/swclass.ts——行业分组以证监会大类代行并显著标注，非申万一级冻结口径）。
 *
 * 输出 data/pool-candidates.json：全部候选的输入证据（basic 原文/行业/成交额序列）+
 * 筛选参数 + 筛选标注（excludedReason）+ 每业前 3 后按日均成交额降序的前 40 名。
 * ETF 由总控另行冻结（不在本计算器范围）。总控从本清单裁定 26 只。
 *
 * 断点续跑：.backfill/pool-progress.json（每股一段，段完成才提交）；节流 ≥1.5s。
 * CLI：node --import tsx src/backfill/pool-candidate.ts [--top 40] [--throttle 1600]
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { BAOSTOCK_ADAPTER_VERSION, BaoStockAdapter } from '../adapters/baostock.js';
import type { BridgeRow } from '../adapters/adapter-types.js';
import {
  SW2014_GAP,
  SW_CLASS_SOURCE_GAP,
  csrcIndustryGroup,
} from '../adapters/swclass.js';
import {
  SW_2014_EFFECTIVE,
  SW_2021_CLASSIFY_EFFECTIVE,
  SW2014_PREFIX_L1,
  SW_ADAPTER_VERSION,
  SW2021_PREFIX_L1,
} from '../adapters/sw.js';
import type { ArtifactStore } from '../artifacts/store.js';

// ===== 纯筛选（单测直接覆盖）=====

/** 沪深主板前缀（R17）：沪 600/601/603/605，深 000/001/002/003（002 原中小板已并主板）。 */
export const MAINBOARD_RE = /^(600|601|603|605|000|001|002|003)\d{3}$/;

export function isMainboardStock(code: string): boolean {
  return MAINBOARD_RE.test(code);
}

export const ST_NAME_RE = /^S?\*?ST/;

export interface CandidateEvidence {
  code: string;
  name: string;
  ipoDate: string;
  /** 最新交易日 isST（DAILY_BAR 行内字段，当前快照；不回填历史）。 */
  isST: string;
  /** 行业原文（INDUSTRY_CLASS_VERSION 事实，实测为证监会行业分类）。 */
  industry: string;
  industryGroup: string;
  /** 窗口内日均成交额（元）。 */
  avgAmountYuan: number;
  barCount: number;
  windowStart: string;
  windowEnd: string;
  /** 窗口内逐日成交额（元，原文 float）。 */
  amounts: number[];
  /** query_stock_basic 原始行（原文存档可回溯）。 */
  basicRow: BridgeRow;
  /** 由 selectPool 填写；null = 未被排除。 */
  excludedReason: string | null;
  /** 由 selectPool 填写；入选前 40 名的名次（1 起）；null = 未入选。 */
  selectedRank: number | null;
}

export interface SelectPoolOptions {
  /** 行业内每业上限（PLAN §1：申万一级每业 ≤3 只；本轴为证监会大类代行，见文件头）。 */
  topPerIndustry: number;
  /** 最终输出名次数（派发：前 40 名）。 */
  topN: number;
  /** 日均成交额下限（元），PLAN §1：≥1 亿。 */
  minAvgAmountYuan: number;
  /** 上市须满一年的锚点日（快照日）。 */
  asOf: string;
  /** 一年按 365 天。 */
  listingMinDays?: number;
}

export interface SelectPoolResult {
  selected: CandidateEvidence[];
  annotated: CandidateEvidence[];
  filterCounts: Record<string, number>;
}

/** 标注排除原因 → 每业前 N → 全表按日均成交额降序取前 M。纯函数。 */
export function selectPool(evidence: CandidateEvidence[], opts: SelectPoolOptions): SelectPoolResult {
  const listingMinDays = opts.listingMinDays ?? 365;
  const annotated: CandidateEvidence[] = evidence.map((e) => ({ ...e, excludedReason: null, selectedRank: null }));
  const filterCounts: Record<string, number> = { TOTAL: annotated.length };

  const dayMs = 86_400_000;
  const asOfMs = new Date(`${opts.asOf}T00:00:00+08:00`).getTime();
  for (const e of annotated) {
    if (e.barCount === 0) e.excludedReason = 'NO_BARS';
    else if (e.isST === '1') e.excludedReason = 'IS_ST';
    else if (ST_NAME_RE.test(e.name)) e.excludedReason = 'ST_IN_NAME';
    else if (e.ipoDate === '' || Number.isNaN(new Date(`${e.ipoDate}T00:00:00+08:00`).getTime())) e.excludedReason = 'IPO_DATE_MISSING';
    else if (asOfMs - new Date(`${e.ipoDate}T00:00:00+08:00`).getTime() < listingMinDays * dayMs) e.excludedReason = 'LISTING_LT_1Y';
    else if (!(e.avgAmountYuan >= opts.minAvgAmountYuan)) e.excludedReason = 'AVG_AMOUNT_BELOW_1E8';
    else if (e.industry === '') e.excludedReason = 'INDUSTRY_MISSING';
    if (e.excludedReason !== null) filterCounts[e.excludedReason] = (filterCounts[e.excludedReason] ?? 0) + 1;
  }

  const pass = annotated
    .filter((e) => e.excludedReason === null)
    .sort((a, b) => b.avgAmountYuan - a.avgAmountYuan || a.code.localeCompare(b.code));
  filterCounts.PASS_FILTER = pass.length;

  // 每业前 N（业 = industryGroup；并列按代码升序稳定）
  const perGroupCount = new Map<string, number>();
  const capped: CandidateEvidence[] = [];
  for (const e of pass) {
    const n = perGroupCount.get(e.industryGroup) ?? 0;
    if (n >= opts.topPerIndustry) {
      e.excludedReason = `INDUSTRY_CAP_${opts.topPerIndustry}`;
      filterCounts[e.excludedReason] = (filterCounts[e.excludedReason] ?? 0) + 1;
      continue;
    }
    perGroupCount.set(e.industryGroup, n + 1);
    capped.push(e);
  }
  filterCounts.AFTER_INDUSTRY_CAP = capped.length;

  const selected = capped.slice(0, opts.topN);
  selected.forEach((e, i) => {
    e.selectedRank = i + 1;
  });
  filterCounts.SELECTED = selected.length;
  return { selected, annotated, filterCounts };
}

/** 窗口内日均成交额（元）；空窗口返回 NaN。amount 为 BaoStock 原文字段。 */
export function computeAvgAmount(amounts: string[]): number {
  if (amounts.length === 0) return Number.NaN;
  let sum = 0;
  for (const a of amounts) sum += Number(a);
  return sum / amounts.length;
}

// ===== 断点进度 =====

export interface PoolProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  windowStart: string;
  windowEnd: string;
  snapshotDate: string;
  /** 每候选证据（段完成才提交；重跑跳过）。 */
  evidence: Record<string, CandidateEvidence>;
}

export async function loadPoolProgress(path: string): Promise<PoolProgress | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PoolProgress>;
    if (parsed.version !== 1 || typeof parsed.evidence !== 'object' || parsed.evidence === null) return null;
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : BAOSTOCK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      windowStart: typeof parsed.windowStart === 'string' ? parsed.windowStart : '',
      windowEnd: typeof parsed.windowEnd === 'string' ? parsed.windowEnd : '',
      snapshotDate: typeof parsed.snapshotDate === 'string' ? parsed.snapshotDate : '',
      evidence: parsed.evidence,
    };
  } catch {
    return null;
  }
}

export async function savePoolProgress(path: string, progress: PoolProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress), 'utf8');
  await rename(tmp, path);
}

// ===== DB 读回辅助（只读，不绕过适配器写）=====

interface MembershipDayRow {
  d: string;
  idx: string;
  n: string;
}

/** 最新两指数齐全的成分快照日 + 该日成员并集。 */
export async function latestMembershipSnapshot(
  pool: Pool,
): Promise<{ date: string; hs300Count: number; zz500Count: number; members: string[] }> {
  const res = await pool.query<MembershipDayRow>(
    `select typed_value->>'updateDate' as d, typed_value->>'bsIndex' as idx, count(*)::text as n
     from pintime_fact where fact_kind = 'INDEX_MEMBERSHIP'
     group by 1, 2 order by 1 desc`,
  );
  const byDate = new Map<string, { hs300?: number; zz500?: number }>();
  for (const row of res.rows) {
    const entry = byDate.get(row.d) ?? {};
    if (row.idx === 'hs300') entry.hs300 = Number(row.n);
    if (row.idx === 'zz500') entry.zz500 = Number(row.n);
    byDate.set(row.d, entry);
  }
  let date: string | undefined;
  for (const [d, counts] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    if (counts.hs300 !== undefined && counts.zz500 !== undefined) {
      date = d;
      break;
    }
  }
  if (date === undefined) throw new Error('无两指数齐全的成分快照日（先跑 membership 回填）');
  const memberRes = await pool.query<{ subject_id: string }>(
    `select distinct subject_id from pintime_fact
     where fact_kind = 'INDEX_MEMBERSHIP' and typed_value->>'updateDate' = $1`,
    [date],
  );
  const counts = byDate.get(date);
  return {
    date,
    hs300Count: counts?.hs300 ?? 0,
    zz500Count: counts?.zz500 ?? 0,
    members: memberRes.rows.map((r) => r.subject_id),
  };
}

/** 行业分类事实 → subjectId → industry 原文。 */
export async function industryMap(pool: Pool): Promise<Map<string, string>> {
  const { asOfFacts } = await import('../pintime/facts.js');
  const facts = await asOfFacts(pool, { factKind: 'INDUSTRY_CLASS_VERSION', asOf: new Date() });
  const map = new Map<string, string>();
  for (const f of facts) {
    const tv = f.typedValue as BridgeRow;
    if (typeof tv.industry === 'string') map.set(f.subjectId, tv.industry);
  }
  return map;
}

/** 原件读回（canonical rows JSON）→ BridgeRow[]。 */
export async function artifactRows(store: ArtifactStore, sha256: string): Promise<BridgeRow[]> {
  const bytes = await store.readBytes(sha256);
  return JSON.parse(new TextDecoder().decode(bytes)) as BridgeRow[];
}

// ===== CLI =====

function parseArgs(argv: string[]): { topN: number; throttleMs: number; axis: 'csrc' | 'sw' } {
  let topN = 40;
  let throttleMs = 1_600;
  let axis: 'csrc' | 'sw' = 'csrc';
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`缺少 ${flag} 的值`);
      process.exit(1);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--top') topN = Number(valueOf(i + 1, '--top'));
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
    else if (arg === '--axis') {
      const v = valueOf(i + 1, '--axis');
      if (v !== 'csrc' && v !== 'sw') {
        console.error(`--axis 须为 csrc 或 sw：${v}`);
        process.exit(1);
      }
      axis = v;
    }
  }
  if (!Number.isInteger(topN) || topN < 1) {
    console.error(`--top 须为正整数：${String(topN)}`);
    process.exit(1);
  }
  if (throttleMs < 1_500) {
    console.error(`--throttle 不得低于 1500ms（派发冻结 ≥1.5s）：${String(throttleMs)}`);
    process.exit(1);
  }
  return { topN, throttleMs, axis };
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/pool-candidate.ts');

if (isMain) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.axis === 'sw') {
    await mainSwAxis(cliArgs);
  } else {
    await main();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.POOL_STATE_DIR ?? '.backfill';
  const progressPath = join(stateDir, 'pool-progress.json');
  await mkdir(stateDir, { recursive: true });

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { fileURLToPath } = await import('node:url');
  const { loadTradeCalendarTable } = await import('../adapters/calendar.js');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  const pool: Pool = createPool();
  let realCalls = 0;
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const store = new ArtifactStore(artifactsDir);
    const adapter = new BaoStockAdapter({ pool, store });

    const table = await loadTradeCalendarTable(pool);
    const snapshot = await latestMembershipSnapshot(pool);
    const industry = await industryMap(pool);
    if (industry.size === 0) throw new Error('INDUSTRY_CLASS_VERSION 事实为空（先跑 src/adapters/swclass.ts）');
    console.log(`[pool] 成分快照 ${snapshot.date}（hs300=${snapshot.hs300Count} zz500=${snapshot.zz500Count} 并集=${snapshot.members.length}），行业事实 ${industry.size} 行`);

    const candidates = [...new Set(snapshot.members.filter(isMainboardStock))].sort();
    const tradingDays = table.tradingDays.filter((d) => d <= snapshot.date);
    const windowDays = tradingDays.slice(-60);
    const windowStart = windowDays[0];
    if (windowStart === undefined) throw new Error('60 交易日窗口为空');
    console.log(`[pool] 主板候选 ${candidates.length} 只；窗口 ${windowStart}~${snapshot.date}（${windowDays.length} 交易日）`);

    let progress = await loadPoolProgress(progressPath);
    if (progress === null || progress.windowStart !== windowStart || progress.windowEnd !== snapshot.date) {
      // 窗口变化 → 旧证据口径不一致，重置（如实申报重置，旧段调用已计入既往运行）
      if (progress !== null) console.log('[pool] 窗口变化，重置断点重新采集');
      progress = { version: 1, adapterVersion: BAOSTOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), windowStart, windowEnd: snapshot.date, snapshotDate: snapshot.date, evidence: {} };
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let sinceLastCall = Number.POSITIVE_INFINITY;
    const throttle = async () => {
      if (Number.isFinite(sinceLastCall) && sinceLastCall < args.throttleMs) {
        await sleep(args.throttleMs - sinceLastCall);
      }
    };

    try {
      for (const code of candidates) {
        if (progress.evidence[code] !== undefined) continue;
        // ---- 调用 1：stock_basic（名称/ipoDate）----
        await throttle();
        let startedAt = Date.now();
        const basic = await adapter.fetchStockBasic(code);
        realCalls += 1;
        sinceLastCall = Date.now() - startedAt;
        const basicRow = (await artifactRows(store, basic.artifact.sha256))[0];
        if (basicRow === undefined) throw new Error(`stock_basic 原件为空：${code}`);
        // ---- 调用 2：近 60 交易日日线（成交额/isST）----
        await throttle();
        startedAt = Date.now();
        const bars = await adapter.fetchDailyBars(code, windowStart, snapshot.date);
        realCalls += 1;
        sinceLastCall = Date.now() - startedAt;
        const barRows = await artifactRows(store, bars.artifact.sha256);
        const amounts = barRows.map((r) => Number(r.amount));
        const lastBar = barRows[barRows.length - 1];
        const ind = industry.get(code) ?? '';
        progress.evidence[code] = {
          code,
          name: basicRow.code_name ?? '',
          ipoDate: basicRow.ipoDate ?? '',
          isST: lastBar?.isST ?? '',
          industry: ind,
          industryGroup: csrcIndustryGroup(ind),
          avgAmountYuan: computeAvgAmount(barRows.map((r): string => r.amount ?? '')),
          barCount: barRows.length,
          windowStart,
          windowEnd: snapshot.date,
          amounts,
          basicRow,
          excludedReason: null,
          selectedRank: null,
        };
        await savePoolProgress(progressPath, progress);
        console.log(`[pool] ${code} ${basicRow.code_name ?? ''} bars=${barRows.length} avgAmount=${progress.evidence[code]?.avgAmountYuan.toFixed(0)} calls=${realCalls}/${candidates.length * 2}`);
      }
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[pool] 暂停（退避耗尽）：断点 ${progressPath}；恢复 = 重跑同一命令。`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }

    // ---- 筛选 ----
    const evidence = candidates.map((code) => progress?.evidence[code]).filter((e): e is CandidateEvidence => e !== undefined);
    const selection = selectPool(evidence, { topPerIndustry: 3, topN: args.topN, minAvgAmountYuan: 1e8, asOf: snapshot.date });

    const report = {
      generatedAt: new Date().toISOString(),
      adapterVersion: BAOSTOCK_ADAPTER_VERSION,
      parameters: {
        topPerIndustry: 3,
        topN: args.topN,
        minAvgAmountYuan: 1e8,
        windowTradingDays: 60,
        listingMinDays: 365,
        mainboardPrefixes: ['600', '601', '603', '605', '000', '001', '002', '003'],
        industryAxis: 'csrc（证监会行业分类大类，GB/T 门类+大类）——PLAN §1 冻结口径为申万一级，申万轴缺口见 gaps，本分组为代行口径待总控裁定',
        asOf: snapshot.date,
      },
      membershipSnapshot: { date: snapshot.date, hs300Count: snapshot.hs300Count, zz500Count: snapshot.zz500Count, unionCount: snapshot.members.length },
      window: { start: windowStart, end: snapshot.date, tradingDays: windowDays.length },
      gaps: [SW_CLASS_SOURCE_GAP, SW2014_GAP],
      filterCounts: selection.filterCounts,
      selected: selection.selected.map((e) => ({
        rank: e.selectedRank,
        code: e.code,
        name: e.name,
        industry: e.industry,
        industryGroup: e.industryGroup,
        avgAmountYuan: Math.round(e.avgAmountYuan),
        ipoDate: e.ipoDate,
      })),
      evidence: selection.annotated,
      realCalls: { thisRunStockBasicPlusBars: realCalls },
    };
    const outPath = join(repoRoot, 'data', 'pool-candidates.json');
    await writeFile(outPath, JSON.stringify(report), 'utf8');
    console.log(JSON.stringify({
      result: 'POOL CANDIDATES OK',
      outPath,
      candidates: candidates.length,
      filterCounts: selection.filterCounts,
      selectedTop: selection.selected.slice(0, 5).map((e) => `${e.selectedRank}.${e.code} ${e.name} ${e.industryGroup} ${Math.round(e.avgAmountYuan / 1e8)}亿`),
      realCallsThisRun: realCalls,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

// ===== 申万一级轴重算（P1 W7: code-writer-pro，R23；追加式修改，不改上文 csrc 轴行为）=====

/** 申万轴候选证据附加字段（industry/industryGroup 复用为活动轴：L1 名称 / L1 指数码）。 */
export interface SwAxisEvidence {
  /** 行业代码原文（XLS 行业代码，6 位；现行链头行）。 */
  swIndustryCode: string;
  /** 申万一级指数代码（如 801780）；现行行前缀按读取窗口（2021 体系）解释。 */
  swL1IndexCode: string;
  /** 行铸造体系（pre2014/2014/2021；跨体系携带行标注原铸造体系）。 */
  swSystem: string;
  /** 现行分类行的 factId（证据链）。 */
  swFactId: string;
  /** 证据：分类行指向的原件 sha256。 */
  swArtifactSha256: string;
  /** 证监会行业原文（csrc@current 辅助输出，W6 事实保留）。 */
  csrcIndustry: string;
  csrcIndustryGroup: string;
}

export interface SwIndustryRow {
  code: string;
  industryCode: string;
  l1IndexCode: string | null;
  system: string;
  inDate: string;
  factId: string;
  artifactSha256: string;
}

/**
 * 申万分类 as-of 读取（POINT-IN-TIME §2.3 + §3.4）：available_at <= now 且适用期覆盖 D
 * （valid_from <= D 00:00+08 < valid_to，链式区间语义）。每股取现行行（链头）。
 * 60 日线/basic/csrc 事实已在库——本函数与其余 sw 轴读取全部走 DB，零新增真实请求。
 */
export async function swIndustryMapAsOf(pool: Pool, dateISO: string): Promise<Map<string, SwIndustryRow>> {
  const cutoff = new Date(`${dateISO}T00:00:00+08:00`).toISOString();
  const res = await pool.query<{
    subject_id: string;
    fact_id: string;
    artifact_sha256: string;
    valid_from: Date;
    typed_value: Record<string, unknown>;
  }>(
    `select subject_id, fact_id, artifact_sha256, valid_from, typed_value
     from pintime_fact
     where fact_kind = 'INDUSTRY_CLASS_VERSION' and adapter_version = 'sw@p1'
       and available_at <= now()
       and valid_from <= $1
       and (valid_to is null or valid_to > $1)
     order by subject_id asc, valid_from desc`,
    [cutoff],
  );
  const map = new Map<string, SwIndustryRow>();
  // 前缀按读取窗口所属体系解释（携带语义：跨体系未变更的代码字符串在后续体系沿用同一行业；
  // 如 000002 万科A 的 1991 行 43xxxx 在 2021 窗口读作房地产 801180）。
  const readSystemTable =
    dateISO >= SW_2021_CLASSIFY_EFFECTIVE
      ? SW2021_PREFIX_L1
      : dateISO >= SW_2014_EFFECTIVE
        ? SW2014_PREFIX_L1
        : null;
  for (const row of res.rows) {
    if (map.has(row.subject_id)) continue; // 链区间互斥；防御性保留最新 valid_from
    const tv = row.typed_value;
    const industryCode = typeof tv['行业代码'] === 'string' ? (tv['行业代码'] as string) : '';
    const system = typeof tv['体系'] === 'string' ? (tv['体系'] as string) : '';
    const inDate = typeof tv['计入日期ISO'] === 'string' ? (tv['计入日期ISO'] as string) : '';
    const l1 = readSystemTable === null ? null : readSystemTable[industryCode.slice(0, 2)] ?? null;
    map.set(row.subject_id, {
      code: row.subject_id,
      industryCode,
      l1IndexCode: l1,
      system,
      inDate,
      factId: row.fact_id,
      artifactSha256: row.artifact_sha256,
    });
  }
  return map;
}

/** SW_INDEX_LIST 事实 → L1 指数码（801xxx）→ 行业名称。 */
export async function swL1NameMap(pool: Pool): Promise<Map<string, string>> {
  const { asOfFacts } = await import('../pintime/facts.js');
  const facts = await asOfFacts(pool, { factKind: 'SW_INDEX_LIST', asOf: new Date() });
  const map = new Map<string, string>();
  for (const f of facts) {
    const rows = (f.typedValue as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    for (const r of rows) {
      const code = typeof r['行业代码'] === 'string' ? (r['行业代码'] as string).slice(0, 6) : '';
      const name = typeof r['行业名称'] === 'string' ? (r['行业名称'] as string) : '';
      if (/^\d{6}$/.test(code)) map.set(code, name);
    }
  }
  return map;
}

/**
 * 申万 L1 轴重算：行业分组 = 申万一级（PLAN §1 冻结口径，R23 恢复），每业 ≤3、60 日日均
 * 成交额 ≥1 亿、按日均成交额降序前 N。全部输入 as-of 读库（成分快照/交易日历/日线/basic/
 * 申万分类/证监会分类），零新增真实请求。输出 data/pool-candidates-sw.json。
 */
async function mainSwAxis(cliArgs: { topN: number }): Promise<void> {
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { loadTradeCalendarTable } = await import('../adapters/calendar.js');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);

    const table = await loadTradeCalendarTable(pool);
    const snapshot = await latestMembershipSnapshot(pool);
    const csrcIndustry = await industryMap(pool);
    const swIndustry = await swIndustryMapAsOf(pool, snapshot.date);
    const l1Name = await swL1NameMap(pool);
    if (swIndustry.size === 0) throw new Error('sw@p1 INDUSTRY_CLASS_VERSION 事实为空（先跑 src/backfill/sw.ts）');
    console.log(`[pool-sw] 成分快照 ${snapshot.date}（并集 ${String(snapshot.members.length)}），申万分类事实覆盖 ${String(swIndustry.size)} 股，L1 名称 ${String(l1Name.size)} 项`);

    const candidates = [...new Set(snapshot.members.filter(isMainboardStock))].sort();
    const tradingDays = table.tradingDays.filter((d) => d <= snapshot.date);
    const windowDays = tradingDays.slice(-60);
    const windowStart = windowDays[0];
    if (windowStart === undefined) throw new Error('60 交易日窗口为空');
    console.log(`[pool-sw] 主板候选 ${String(candidates.length)} 只；窗口 ${windowStart}~${snapshot.date}（${String(windowDays.length)} 交易日）；零新增真实请求`);

    // 日线/basic 事实读回（as-of 全量，一次查询）
    interface BarRow { subject_id: string; d: string; amount: string; is_st: string }
    const barsRes = await pool.query<BarRow>(
      `select subject_id, typed_value->>'date' as d, typed_value->>'amount' as amount, typed_value->>'isST' as is_st
       from pintime_fact
       where fact_kind = 'DAILY_BAR' and available_at <= now()
         and typed_value->>'date' between $1 and $2
       order by subject_id asc, typed_value->>'date' asc`,
      [windowStart, snapshot.date],
    );
    const barsByStock = new Map<string, { amounts: string[]; lastIsST: string }>();
    for (const b of barsRes.rows) {
      const entry = barsByStock.get(b.subject_id) ?? { amounts: [], lastIsST: '' };
      entry.amounts.push(b.amount);
      entry.lastIsST = b.is_st;
      barsByStock.set(b.subject_id, entry);
    }
    interface BasicRow { subject_id: string; name: string; ipo: string }
    const basicRes = await pool.query<BasicRow>(
      `select subject_id, typed_value->>'code_name' as name, typed_value->>'ipoDate' as ipo
       from pintime_fact where fact_kind = 'STOCK_BASIC' and available_at <= now()`,
    );
    const basicByStock = new Map(basicRes.rows.map((r) => [r.subject_id, r]));

    const diagnostics = { swRowMissing: 0, swL1Unmapped: 0, barsMissing: 0 };
    const evidence: Array<CandidateEvidence & Partial<SwAxisEvidence>> = [];
    for (const code of candidates) {
      const bars = barsByStock.get(code);
      if (bars === undefined) {
        diagnostics.barsMissing += 1;
        continue;
      }
      const basic = basicByStock.get(code);
      const sw = swIndustry.get(code);
      if (sw === undefined) diagnostics.swRowMissing += 1;
      else if (sw.l1IndexCode === null) diagnostics.swL1Unmapped += 1;
      const csrc = csrcIndustry.get(code) ?? '';
      const l1 = sw?.l1IndexCode ?? '';
      evidence.push({
        code,
        name: basic?.name ?? '',
        ipoDate: basic?.ipo ?? '',
        isST: bars.lastIsST,
        industry: l1 !== '' ? (l1Name.get(l1) ?? l1) : '',
        industryGroup: l1,
        avgAmountYuan: computeAvgAmount(bars.amounts),
        barCount: bars.amounts.length,
        windowStart,
        windowEnd: snapshot.date,
        amounts: bars.amounts.map((a) => Number(a)),
        basicRow: basic === undefined ? {} : { code, code_name: basic.name, ipoDate: basic.ipo },
        excludedReason: null,
        selectedRank: null,
        swIndustryCode: sw?.industryCode ?? '',
        swL1IndexCode: l1,
        swSystem: sw?.system ?? '',
        swFactId: sw?.factId ?? '',
        swArtifactSha256: sw?.artifactSha256 ?? '',
        csrcIndustry: csrc,
        csrcIndustryGroup: csrcIndustryGroup(csrc),
      });
    }

    const selection = selectPool(evidence, {
      topPerIndustry: 3,
      topN: cliArgs.topN,
      minAvgAmountYuan: 1e8,
      asOf: snapshot.date,
    });

    const report = {
      generatedAt: new Date().toISOString(),
      adapterVersion: BAOSTOCK_ADAPTER_VERSION,
      industryAxisAdapter: SW_ADAPTER_VERSION,
      parameters: {
        topPerIndustry: 3,
        topN: cliArgs.topN,
        minAvgAmountYuan: 1e8,
        windowTradingDays: 60,
        listingMinDays: 365,
        mainboardPrefixes: ['600', '601', '603', '605', '000', '001', '002', '003'],
        industryAxis: '申万一级行业（sw-l1@2021，R23 恢复 PLAN §1 冻结口径；W6 的证监会大类代行口径废止，csrc 事实保留为辅助输出）',
        asOf: snapshot.date,
      },
      membershipSnapshot: { date: snapshot.date, hs300Count: snapshot.hs300Count, zz500Count: snapshot.zz500Count, unionCount: snapshot.members.length },
      window: { start: windowStart, end: snapshot.date, tradingDays: windowDays.length },
      gaps: [],
      gapNotes: '行业轴申万 L1 全量映射（31/31，证据 data/sw-semantics-report.json），本清单无行业轴缺口；历史封存缺口文本见 src/adapters/sw.ts（SW_CLASS_SOURCE_GAP / SW2014_GAP 关闭文本）。',
      diagnostics,
      filterCounts: selection.filterCounts,
      selected: selection.selected.map((e) => {
        const s = e as CandidateEvidence & Partial<SwAxisEvidence>;
        return {
          rank: e.selectedRank,
          code: e.code,
          name: e.name,
          swL1IndexCode: s.swL1IndexCode ?? e.industryGroup,
          swL1Name: e.industry,
          swIndustryCode: s.swIndustryCode ?? '',
          avgAmountYuan: Math.round(e.avgAmountYuan),
          ipoDate: e.ipoDate,
          evidence: { swFactId: s.swFactId ?? '', swArtifactSha256: s.swArtifactSha256 ?? '', csrcIndustry: s.csrcIndustry ?? '' },
        };
      }),
      evidence: selection.annotated,
      realCalls: { thisRunTotal: 0 },
    };
    const outPath = join(repoRoot, 'data', 'pool-candidates-sw.json');
    await writeFile(outPath, JSON.stringify(report), 'utf8');
    const progressPath = join(process.env.POOL_STATE_DIR ?? '.backfill', 'pool-sw-progress.json');
    await mkdir(dirname(progressPath), { recursive: true });
    await writeFile(progressPath, JSON.stringify({
      version: 1,
      axis: 'sw',
      adapterVersion: SW_ADAPTER_VERSION,
      updatedAt: new Date().toISOString(),
      windowStart,
      windowEnd: snapshot.date,
      snapshotDate: snapshot.date,
      diagnostics,
      evidenceCount: evidence.length,
    }), 'utf8');
    console.log(JSON.stringify({
      result: 'POOL CANDIDATES (SW L1) OK',
      outPath,
      candidates: candidates.length,
      diagnostics,
      filterCounts: selection.filterCounts,
      selectedTop: selection.selected.slice(0, 5).map((e) => `${String(e.selectedRank)}.${e.code} ${e.name} ${e.industry}(${e.industryGroup}) ${Math.round(e.avgAmountYuan / 1e8)}亿`),
      realCallsThisRun: 0,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
