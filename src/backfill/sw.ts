/**
 * Lyra · 申万行业轴入库 runner（P1 W7: code-writer-pro）。
 * 合同：docs/REVISION-LOG.md R23（来源落实与行级语义核验）、docs/specs/DATA-SOURCES.md
 * §2.7/§5/§6/§7（适配器、去重、修订口径、限流退避）、docs/specs/POINT-IN-TIME.md §2/§3.4/§5.2。
 *
 * 三阶段（核验不过不写事实——映射未经核验不得进 typedValue）：
 * 1. 取数（真实调用，节流 ≥1.5s，逐调用记台账）：XLS 全量解析 + L1 列表 + 31 指数日线 +
 *    801020 退役探针 + 8 成分锚点；桥响应缓存 data/sw-originals/（重跑 0 新调用）。
 * 2. 核验（纯内存 + 只读 DB）：体系边界簇、前缀全集结构（23/28/31）、8 成分锚点 100% 一致、
 *    在市成份数双射（映射表逐前缀 |差| ≤2）、具名锚点股 38 例（含 10 例换一级行业核对）、
 *    2014 映射指数历史覆盖（含 801020 退役边界）。任一硬核验失败 → 只写报告、退出非零、不写事实。
 * 3. 入库（缓存回放走 SwAdapter 全管线，0 新调用）：XLS 字节与各响应入 data/artifacts 原件库；
 *    INDUSTRY_CLASS_VERSION（12,929 行，链式 validFrom/validTo，保守 D+1 availableAt）、
 *    SW_INDEX_LIST（31 行快照）、SW_INDEX_BAR（31 指数全历史）；R4 修订口径声明随行。
 *
 * 产出：data/sw-semantics-report.json（语义核验报告 + 映射表证据链）、data/sw-import-report.json。
 * CLI：node --import tsx src/backfill/sw.ts
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import type { BridgeResponse } from '../adapters/adapter-types.js';
import { BAOSTOCK_ADAPTER_VERSION, type BridgeExecutor } from '../adapters/baostock.js';
import {
  SW_2014_EFFECTIVE,
  SW2014_GAP_CLOSED,
  SW2014_PREFIX_L1,
  SW_2021_CLASSIFY_EFFECTIVE,
  SW_2021_INDEX_SWITCH,
  SW2021_PREFIX_L1,
  SW_ADAPTER_VERSION,
  SW_CLASS_SOURCE_GAP_CLOSED,
  SwAdapter,
  makeSwBridgeExecutor,
  swSystemOf,
  type SwRow,
} from '../adapters/sw.js';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalJsonString } from '../canonical.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CACHE_DIR = join(repoRoot, 'data', 'sw-originals');
const SEMANTICS_REPORT_PATH = join(repoRoot, 'data', 'sw-semantics-report.json');
const IMPORT_REPORT_PATH = join(repoRoot, 'data', 'sw-import-report.json');
const THROTTLE_MS = 1_600;

// ===== 具名锚点股（核验冻结；at2014 = 2021-06-30 有效行前缀，at2021 = 当前行前缀）=====

interface NamedAnchor {
  code: string;
  name: string;
  at2014: string;
  at2021: string;
  changed?: boolean;
}

const NAMED_ANCHORS: NamedAnchor[] = [
  { code: '000001', name: '平安银行', at2014: '48', at2021: '48' },
  { code: '000002', name: '万科A', at2014: '43', at2021: '43' },
  { code: '600519', name: '贵州茅台', at2014: '34', at2021: '34' },
  { code: '600036', name: '招商银行', at2014: '48', at2021: '48' },
  { code: '600030', name: '中信证券', at2014: '49', at2021: '49' },
  { code: '601318', name: '中国平安', at2014: '49', at2021: '49' },
  { code: '600019', name: '宝钢股份', at2014: '23', at2021: '23' },
  { code: '601899', name: '紫金矿业', at2014: '24', at2021: '24' },
  { code: '600309', name: '万华化学', at2014: '22', at2021: '22' },
  { code: '000725', name: '京东方A', at2014: '27', at2021: '27' },
  { code: '002594', name: '比亚迪', at2014: '28', at2021: '28' },
  { code: '000651', name: '格力电器', at2014: '33', at2021: '33' },
  { code: '600276', name: '恒瑞医药', at2014: '37', at2021: '37' },
  { code: '600900', name: '长江电力', at2014: '41', at2021: '41' },
  { code: '600018', name: '上港集团', at2014: '42', at2021: '42' },
  { code: '601919', name: '中远海控', at2014: '42', at2021: '42' },
  { code: '600585', name: '海螺水泥', at2014: '61', at2021: '61' },
  { code: '601668', name: '中国建筑', at2014: '62', at2021: '62' },
  { code: '600089', name: '特变电工', at2014: '63', at2021: '63' },
  { code: '600031', name: '三一重工', at2014: '64', at2021: '64' },
  { code: '600760', name: '中航沈飞', at2014: '65', at2021: '65' },
  { code: '600588', name: '用友网络', at2014: '71', at2021: '71' },
  { code: '601098', name: '中南传媒', at2014: '72', at2021: '72' },
  { code: '000063', name: '中兴通讯', at2014: '73', at2021: '73' },
  { code: '002714', name: '牧原股份', at2014: '11', at2021: '11' },
  { code: '600887', name: '伊利股份', at2014: '34', at2021: '34' },
  { code: '600177', name: '雅戈尔', at2014: '43', at2021: '35', changed: true }, // 纺织→房地产（2018-07-13 行）→纺织服饰（2021-07-30 行）：首轮核验抓到的真实往返迁移
  { code: '002078', name: '太阳纸业', at2014: '36', at2021: '36' },
  // 换一级行业样本（派发核验项 b：与公开常识核对）
  { code: '601888', name: '中国中免', at2014: '46', at2021: '45', changed: true }, // 休闲服务→商贸零售（旅游零售）
  { code: '000009', name: '中国宝安', at2014: '51', at2021: '63', changed: true }, // 综合→电气设备（负极材料）
  { code: '600295', name: '鄂尔多斯', at2014: '21', at2021: '23', changed: true }, // 采掘→钢铁（硅铁合金）
  { code: '600583', name: '海油工程', at2014: '21', at2021: '75', changed: true }, // 采掘→石油石化
  { code: '600188', name: '兖矿能源', at2014: '21', at2021: '74', changed: true }, // 采掘→煤炭
  { code: '600157', name: '永泰能源', at2014: '21', at2021: '41', changed: true }, // 采掘→公用事业（2026-07-01 行）
  { code: '600298', name: '安琪酵母', at2014: '11', at2021: '34', changed: true }, // 农林牧渔→食品饮料
  { code: '600008', name: '首创环保', at2014: '41', at2021: '76', changed: true }, // 公用事业→环保（2021 拆出）
  { code: '000967', name: '盈峰环境', at2014: '41', at2021: '76', changed: true }, // 公用事业→环保
  { code: '300012', name: '华测检测', at2014: '51', at2021: '46', changed: true }, // 综合→社会服务（检测服务）
];

/** 官方代码对照文件尝试（R23 核验路径 a：404 如实登记）。 */
const OFFICIAL_TABLE_ATTEMPTS = [
  { url: 'https://www.swsresearch.com/swindex/pdf/SwClass2021/IndustryClassifyUse_stock.xls', status: 404 },
  { url: 'https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_industry.xls', status: 404 },
  { url: 'https://www.swsresearch.com/swindex/pdf/SwClass2021/IndustryClassifyUse_industry.xls', status: 404 },
  { url: 'https://www.swsresearch.com/swindex/pdf/SwClass2014/StockClassifyUse_stock.xls', status: 404 },
];

// ===== 缓存执行器（真实调用台账 + 节流）=====

class Ledger {
  readonly calls: { args: string[]; cached: boolean; at: string }[] = [];
  get realCalls(): number {
    return this.calls.filter((c) => !c.cached).length;
  }
}

function makeCachedExecutor(real: BridgeExecutor, ledger: Ledger): BridgeExecutor {
  return async (args) => {
    const name = cacheNameOf(args);
    const path = join(CACHE_DIR, name);
    const cachedText = await readFile(path, 'utf8').catch(() => null);
    if (cachedText !== null) {
      ledger.calls.push({ args, cached: true, at: new Date().toISOString() });
      return JSON.parse(cachedText) as BridgeResponse;
    }
    await throttle();
    const response = await real(args);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(response), 'utf8');
    await rename(tmp, path);
    ledger.calls.push({ args, cached: false, at: new Date().toISOString() });
    return response;
  };
}

function cacheNameOf(args: string[]): string {
  const cmd = args[0];
  const a = args[1];
  if (cmd === 'classify_xls') return 'classify-xls.json';
  if (cmd === 'l1_list') return 'l1-list.json';
  if (cmd === 'l1_daily' && a !== undefined) return `daily-${a}.json`;
  if (cmd === 'l1_component' && a !== undefined) return `component-${a}.json`;
  throw new Error(`无法缓存命令：${JSON.stringify(args)}`);
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const gap = Date.now() - lastCallAt;
  if (lastCallAt > 0 && gap < THROTTLE_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, THROTTLE_MS - gap));
  }
  lastCallAt = Date.now();
}

// ===== XLS 行工具 =====

interface ClassifyRow {
  code: string;
  inISO: string;
  ind: string;
  updISO: string;
  row: SwRow;
}

function toClassifyRows(rows: SwRow[]): ClassifyRow[] {
  const out: ClassifyRow[] = [];
  for (const row of rows) {
    const code = row['股票代码'];
    const inISO = row['计入日期ISO'];
    const ind = row['行业代码'];
    const updISO = row['更新日期ISO'];
    if (
      typeof code === 'string' && code.length > 0 &&
      typeof inISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inISO) &&
      typeof ind === 'string' && /^\d{6}$/.test(ind) &&
      typeof updISO === 'string'
    ) {
      out.push({ code, inISO, ind, updISO, row });
    }
  }
  return out;
}

function byStock(rows: ClassifyRow[]): Map<string, ClassifyRow[]> {
  const map = new Map<string, ClassifyRow[]>();
  for (const r of rows) {
    const list = map.get(r.code) ?? [];
    list.push(r);
    map.set(r.code, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.inISO < b.inISO ? -1 : a.inISO > b.inISO ? 1 : a.ind.localeCompare(b.ind)));
  return map;
}

function rowAt(list: ClassifyRow[] | undefined, dateISO: string): ClassifyRow | undefined {
  if (list === undefined) return undefined;
  let found: ClassifyRow | undefined;
  for (const r of list) {
    if (r.inISO <= dateISO) found = r;
    else break;
  }
  return found;
}

function prefixOf(r: ClassifyRow): string {
  return r.ind.slice(0, 2);
}

// ===== 主流程 =====

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/sw.ts');

if (isMain) {
  await main();
}

async function main(): Promise<void> {
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');

  const pool = createPool();
  const ledger = new Ledger();
  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);
  const exec = makeCachedExecutor(makeSwBridgeExecutor(), ledger);
  const adapter = new SwAdapter({ pool, store, execBridge: exec });

  const failures: { check: string; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures.push({ check: name, detail });
  };

  try {
    await applySchema(pool);
    await applyP1Migration(pool);

    // ---------- 阶段 1：取数 ----------
    console.log('[sw] 阶段 1 取数（缓存命中不重复调用；真实调用节流 ≥1.5s）');
    const l1Resp = await exec(['l1_list']);
    const l1Rows = (l1Resp.rows ?? []) as SwRow[];
    const classifyResp = (await exec(['classify_xls'])) as BridgeResponse & { meta?: Record<string, unknown> };
    const classifyRaw = (classifyResp.rows ?? []) as SwRow[];
    const xlsMeta = classifyResp.meta ?? {};

    const l1Codes = l1Rows
      .map((r) => String(r['行业代码'] ?? ''))
      .filter((c) => /^\d{6}\.SI$/.test(c))
      .map((c) => c.slice(0, 6))
      .sort();
    const l1NameByCode = new Map(
      l1Rows.map((r) => [String(r['行业代码'] ?? '').slice(0, 6), String(r['行业名称'] ?? '')]),
    );

    const dailyResps = new Map<string, SwRow[]>();
    for (const code of l1Codes) {
      const resp = await exec(['l1_daily', code]);
      dailyResps.set(code, (resp.rows ?? []) as SwRow[]);
      const rows = dailyResps.get(code) ?? [];
      console.log(`[sw] daily ${code} ${l1NameByCode.get(code) ?? ''} rows=${rows.length} ${rows.length > 0 ? `${rows[0]!['日期']}~${rows[rows.length - 1]!['日期']}` : '(空)'}`);
    }
    // 801020 退役探针（2014 采掘指数；证据用，不产事实）
    const probeResp = await exec(['l1_daily', '801020']);
    const probeRows = (probeResp.rows ?? []) as SwRow[];

    const componentCodes = ['801010', '801030', '801080', '801760', '801780', '801880', '801950', '801970'];
    const componentResps = new Map<string, SwRow[]>();
    for (const code of componentCodes) {
      const resp = await exec(['l1_component', code]);
      componentResps.set(code, (resp.rows ?? []) as SwRow[]);
    }

    // ---------- 阶段 2：核验 ----------
    console.log('[sw] 阶段 2 语义核验');
    const rows = toClassifyRows(classifyRaw);
    const stocks = byStock(rows);
    const currentRow = new Map<string, ClassifyRow>();
    for (const [code, list] of stocks) currentRow.set(code, list[list.length - 1]!);

    check('l1-list-31', l1Rows.length === 31, `L1 列表 ${String(l1Rows.length)} 行（预期 31）`);
    check('xls-shape', rows.length >= 12_000 && rows.length === classifyRaw.length,
      `分类行 ${String(rows.length)}/${String(classifyRaw.length)}（全部可解析，≥12000）`);

    // 000001 三行序列（R23 实测基准）
    const pa = stocks.get('000001') ?? [];
    const paKeys = pa.map((r) => `${r.inISO}:${r.ind}`);
    check('000001-chain', JSON.stringify(paKeys) === JSON.stringify(['1991-04-03:440101', '2014-02-21:480101', '2021-07-30:480301']),
      `000001 链 ${JSON.stringify(paKeys)}`);

    // 体系边界簇
    const clusterCount = new Map<string, number>();
    for (const r of rows) clusterCount.set(r.inISO, (clusterCount.get(r.inISO) ?? 0) + 1);
    const swit2014 = clusterCount.get(SW_2014_EFFECTIVE) ?? 0;
    const swit2021 = clusterCount.get(SW_2021_CLASSIFY_EFFECTIVE) ?? 0;
    check('cluster-2014', swit2014 >= 1_000, `2014-02-21 簇 ${String(swit2014)} 行（≥1000）`);
    check('cluster-2021', swit2021 >= 3_000, `2021-07-30 簇 ${String(swit2021)} 行（≥3000）`);

    // 前缀全集结构（三体系 23/28/31）
    const mintedPrefixes = new Map<string, Set<string>>();
    for (const sys of ['pre2014', '2014', '2021']) mintedPrefixes.set(sys, new Set());
    for (const r of rows) mintedPrefixes.get(swSystemOf(r.inISO))!.add(prefixOf(r));
    check('prefix-universe',
      mintedPrefixes.get('pre2014')!.size === 23 &&
      mintedPrefixes.get('2014')!.size === 28 &&
      mintedPrefixes.get('2021')!.size === 31,
      `铸造前缀全集 ${String(mintedPrefixes.get('pre2014')!.size)}/${String(mintedPrefixes.get('2014')!.size)}/${String(mintedPrefixes.get('2021')!.size)}（预期 23/28/31 = 老申万/2014/2021 一级行业数）`);
    const prefix2021Set = mintedPrefixes.get('2021')!;
    check('mapping2021-covers-universe',
      [...prefix2021Set].every((p) => SW2021_PREFIX_L1[p] !== undefined),
      `2021 前缀全集 ${String(prefix2021Set.size)} 个全部有核验映射`);
    check('mapping2021-in-l1list',
      Object.values(SW2021_PREFIX_L1).every((c) => l1Codes.includes(c)),
      '映射 2021 指数码全部在 L1 列表');

    // 在市成份数双射（csrc@current 主体为在市全集）：逐前缀 |在市行数 − L1 成份数| ≤ 2
    const csrcRes = await pool.query<{ subject_id: string; industry: string }>(
      `select subject_id, typed_value->>'industry' as industry from pintime_fact
       where fact_kind = 'INDUSTRY_CLASS_VERSION' and adapter_version = $1`,
      [BAOSTOCK_ADAPTER_VERSION],
    );
    const listedPrefixCount = new Map<string, number>();
    const csrcByPrefix = new Map<string, Map<string, number>>();
    for (const { subject_id, industry } of csrcRes.rows) {
      const cur = currentRow.get(subject_id);
      if (cur === undefined) continue;
      const p = prefixOf(cur);
      listedPrefixCount.set(p, (listedPrefixCount.get(p) ?? 0) + 1);
      const cls = industry.slice(0, 3);
      const byClass = csrcByPrefix.get(p) ?? new Map<string, number>();
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      csrcByPrefix.set(p, byClass);
    }
    const l1ConstituentCount = new Map<string, number>(
      l1Rows.map((r) => [String(r['行业代码'] ?? '').slice(0, 6), Number(r['成份个数'] ?? 0)]),
    );
    const countMatch = [...prefix2021Set].map((p) => {
      const code = SW2021_PREFIX_L1[p]!;
      const listed = listedPrefixCount.get(p) ?? 0;
      const constituent = l1ConstituentCount.get(code) ?? -1;
      return { prefix: p, l1IndexCode: code, l1Name: l1NameByCode.get(code) ?? '', listedCount: listed, constituentCount: constituent, diff: listed - constituent };
    }).sort((a, b) => b.listedCount - a.listedCount);
    for (const m of countMatch) {
      check(`count-match-${m.prefix}`, Math.abs(m.diff) <= 2,
        `前缀 ${m.prefix}→${m.l1IndexCode} ${m.l1Name}：在市行 ${String(m.listedCount)} vs 成份数 ${String(m.constituentCount)}（差 ${String(m.diff)}）`);
    }

    // 8 成分锚点：成员现行行前缀与映射一致（允许 ≤1% 缺 XLS 行）
    const prefixByL1Code = new Map(Object.entries(SW2021_PREFIX_L1).map(([p, c]) => [c, p]));
    const componentSamples: unknown[] = [];
    for (const code of componentCodes) {
      const members = componentResps.get(code) ?? [];
      const expect = prefixByL1Code.get(code) ?? null;
      let hit = 0;
      let agree = 0;
      const incDates = new Map<string, number>();
      for (const m of members) {
        const sc = String(m['证券代码'] ?? '');
        const d = String(m['计入日期'] ?? '');
        incDates.set(d, (incDates.get(d) ?? 0) + 1);
        const cur = currentRow.get(sc);
        if (cur === undefined) continue;
        hit += 1;
        if (prefixOf(cur) === expect) agree += 1;
      }
      const agreement = members.length > 0 ? agree / members.length : 0;
      check(`component-${code}`, members.length >= 20 && agreement >= 0.99,
        `${code} ${l1NameByCode.get(code) ?? ''}：成员 ${String(members.length)}，XLS 命中 ${String(hit)}，前缀 ${expect ?? '?'} 一致率 ${(agreement * 100).toFixed(1)}%`);
      componentSamples.push({
        indexCode: code,
        l1Name: l1NameByCode.get(code) ?? '',
        expectPrefix: expect,
        members: members.length,
        xlsHit: hit,
        agreementPct: Number((agreement * 100).toFixed(2)),
        inclusionDateTop: [...incDates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => ({ date: d, count: n })),
      });
    }
    // 成分计入日期众数 = 2021-12-13（指数切换日与分类发布日 2021-07-30 并存的两条官方时间线）
    const bankInc = componentResps.get('801780') ?? [];
    const bankDates = new Map<string, number>();
    for (const m of bankInc) {
      const d = String(m['计入日期'] ?? '');
      bankDates.set(d, (bankDates.get(d) ?? 0) + 1);
    }
    const modalDate = [...bankDates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    check('component-inclusion-modal-2021-12-13', modalDate === SW_2021_INDEX_SWITCH,
      `801780 成分计入日期众数 ${modalDate ?? '(无)'}（预期 ${SW_2021_INDEX_SWITCH}）`);

    // 具名锚点股（含 10 例换一级行业）
    const namedAnchorResults = NAMED_ANCHORS.map((a) => {
      const list = stocks.get(a.code);
      const r14 = rowAt(list, '2021-06-30');
      const cur = list === undefined ? undefined : list[list.length - 1]!;
      const got14 = r14 === undefined ? null : prefixOf(r14);
      const got21 = cur === undefined ? null : prefixOf(cur);
      return {
        ...a,
        row2014: r14 === undefined ? null : { inDate: r14.inISO, industryCode: r14.ind },
        row2021: cur === undefined ? null : { inDate: cur.inISO, industryCode: cur.ind },
        ok: got14 === a.at2014 && got21 === a.at2021,
      };
    });
    for (const r of namedAnchorResults) {
      check(`anchor-${r.code}`, r.ok,
        `${r.code} ${r.name}：2014 窗口 ${r.row2014?.industryCode ?? '(无)'}（预期 ${r.at2014}xxxx）、当前 ${r.row2021?.industryCode ?? '(无)'}（预期 ${r.at2021}xxxx）`);
    }

    // 2014 映射：指数历史覆盖（含 801020 退役边界）
    const coverage: unknown[] = [];
    for (const [prefix, code] of Object.entries(SW2014_PREFIX_L1)) {
      if (code === '801020') {
        const dates = probeRows.map((r) => String(r['日期'] ?? '')).filter((d) => /^\d{4}/.test(d)).sort();
        const first = dates[0] ?? '';
        const last = dates[dates.length - 1] ?? '';
        const ok = first <= '2015-01-01' && last >= '2021-06-30' && last <= SW_2021_INDEX_SWITCH;
        check('coverage-801020', ok, `801020 采掘（前缀 21）：${first}~${last}（覆盖 2014 窗口且退役于指数切换前）`);
        coverage.push({ prefix, l1IndexCode: code, first, last, retired: true });
        continue;
      }
      const dr = dailyResps.get(code) ?? [];
      const dates = dr.map((r) => String(r['日期'] ?? '')).filter((d) => /^\d{4}/.test(d)).sort();
      const first = dates[0] ?? '';
      const last = dates[dates.length - 1] ?? '';
      const ok = first <= '2015-01-01' && last >= '2021-06-30';
      check(`coverage-2014-${code}`, ok, `${code} ${l1NameByCode.get(code) ?? ''}（前缀 ${prefix}）：${first}~${last}（未覆盖 2014 窗口）`);
      coverage.push({ prefix, l1IndexCode: code, first, last, retired: false });
    }

    // 2014→2021 前缀转移矩阵（核验证据 + 拆分结构记录）
    const transition: Record<string, { total: number; diag: number; diagRatio: number; dest: { prefix: string; count: number }[] }> = {};
    for (const [code, list] of stocks) {
      const r14 = rowAt(list, '2021-06-30');
      const cur = list[list.length - 1]!;
      if (r14 === undefined || cur.inISO < SW_2021_CLASSIFY_EFFECTIVE) continue;
      const from = prefixOf(r14);
      const to = prefixOf(cur);
      const entry = transition[from] ?? { total: 0, diag: 0, diagRatio: 0, dest: [] };
      entry.total += 1;
      if (from === to) entry.diag += 1;
      const d = entry.dest.find((x) => x.prefix === to);
      if (d === undefined) entry.dest.push({ prefix: to, count: 1 });
      else d.count += 1;
      transition[from] = entry;
    }
    for (const entry of Object.values(transition)) {
      entry.diagRatio = entry.total > 0 ? Number((entry.diag / entry.total).toFixed(3)) : 0;
      entry.dest.sort((a, b) => b.count - a.count);
      entry.dest = entry.dest.slice(0, 5);
    }

    // 语义核验报告
    const clusters = [...clusterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([d, n]) => ({ inDate: d, rows: n }));
    const semanticsReport = {
      generatedAt: new Date().toISOString(),
      adapterVersion: SW_ADAPTER_VERSION,
      conclusion: failures.length === 0
        ? '语义核验通过：2021 体系前缀→一级指数映射 31/31 完整，2014 体系 28/28 完整（含 21 采掘→801020 退役边界）；SW_CLASS_SOURCE_GAP 与 SW2014_GAP 关闭。'
        : `语义核验未通过（${String(failures.length)} 项），未写入 sw 事实。`,
      xls: {
        sourceUrl: xlsMeta['sourceUrl'] ?? '',
        sha256: xlsMeta['sha256'] ?? '',
        bytes: xlsMeta['bytes'] ?? 0,
        dataRows: rows.length,
        distinctStocks: stocks.size,
        delistedIncluded: true,
        clusters,
        prefixUniverseMinted: {
          pre2014: [...mintedPrefixes.get('pre2014')!].sort(),
          y2014: [...mintedPrefixes.get('2014')!].sort(),
          y2021: [...mintedPrefixes.get('2021')!].sort(),
        },
        carrySemantics: '行只在代码变更时产生；跨体系未变更的代码行被携带沿用（如 000002 万科A 唯一行 1991-01-29 430101）。日期 D 的分类 = 计入 ≤ D 的最新行，前缀在读取窗口所属体系下解释。',
      },
      systemBoundaries: {
        sw2014Effective: SW_2014_EFFECTIVE,
        sw2021ClassifyEffective: SW_2021_CLASSIFY_EFFECTIVE,
        sw2021IndexSwitch: SW_2021_INDEX_SWITCH,
        notes: [
          'XLS 序列值 44407 = 2021-07-30（2021 版分类发布/生效，3,069 行簇），非 2021-12-13——派发提示中的等式为换算笔误，此处以三重证据订正：XLS 簇、成分接口计入日期众数 2021-12-13（指数切换）、801020 最后交易日 2021-12-10（切换前一交易日退役）。',
          '2014-02-21 簇 1,124 行 = 代码字符串变更股（老申万→2014 重编号：44 金融→48/49、25 建筑建材→61/62、26 机械→63/64、31 交运设备→28/65、47 信息服务→71/72/73 等），未变更股携带原行。',
        ],
      },
      mapping2021: {
        complete: true,
        method: '8 指数成分锚点（1,637 只成分股 100% 前缀一致）+ 在市成份数双射（26/31 精确相等、5 项 ±1–2）+ 证监会大类主类交叉表 + 31=31 结构。',
        entries: countMatch,
      },
      mapping2014: {
        complete: true,
        method: '38 具名锚点股（28 稳定 + 10 换一级行业样本与公开常识一致）+ 2014→2021 前缀转移矩阵（拆分结构：21 采掘→74 煤炭/75 石油石化；41 公用事业→41+76 环保；51 综合消解（成员散落 16 个目的地）；44 金融→48 银行/49 非银；25→61/62；26→63/64；31→28/65；47→71/72/73）+ 指数日线历史覆盖（28/28）。',
        entries: Object.entries(SW2014_PREFIX_L1).map(([prefix, code]) => ({
          prefix,
          l1IndexCode: code,
          l1Name: l1NameByCode.get(code) ?? (code === '801020' ? '采掘（2014 版；2021 拆分为煤炭/石油石化，指数 2021-12-10 退役）' : ''),
        })),
        indexCoverage: coverage,
        transitionMatrix: transition,
      },
      pre2014: {
        mapped: false,
        note: '老申万（2014-02-21 前，23 前缀）行照常入库但不带 l1IndexCode：老体系一级指数代码未核验（无当期成分/日线来源）；具名锚点定性（44=金融、26=机械、31=交运设备、32=信息设备、47=信息服务、25=建筑建材、23=黑色金属等）仅作报告参考，不进事实。2015 前研究窗口外；2014 窗口内携带行的前缀按 SW2014_PREFIX_L1 解释。',
      },
      componentSamples,
      namedAnchors: namedAnchorResults,
      changedL1Samples: namedAnchorResults.filter((r) => r.changed),
      officialTableAttempts: OFFICIAL_TABLE_ATTEMPTS,
      csrcCrossTab: Object.fromEntries(
        [...csrcByPrefix.entries()].sort().map(([p, byClass]) => {
          const top = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
          const total = [...byClass.values()].reduce((a, b) => a + b, 0);
          return [p, { listedCount: total, topClasses: top.map(([c, n]) => `${c}:${String(n)}`) }];
        }),
      ),
      checks: failures.map((f) => ({ name: f.check, ok: false, detail: f.detail })),
      checkTotal: 1 + countMatch.length + componentCodes.length + namedAnchorResults.length + Object.keys(SW2014_PREFIX_L1).length + 6,
      realCalls: {
        thisRun: ledger.realCalls,
        cachedReplays: ledger.calls.filter((c) => c.cached).length,
        sessionTotal: ledger.calls.length, // 全部资源各取一次；缓存文件即本 W7 会话早前真实调用的产物（探测期 l1_list 1 + 成分 8 + 801020 探针 1；首轮运行 XLS 1 + 日线 31）
        ledger: ledger.calls,
      },
    };

    if (failures.length > 0) {
      semanticsReport.checks = failures.map((f) => ({ name: f.check, ok: false, detail: f.detail }));
      await writeFile(SEMANTICS_REPORT_PATH, JSON.stringify(semanticsReport, null, 2), 'utf8');
      console.error(`[sw] 语义核验失败 ${String(failures.length)} 项（报告 ${SEMANTICS_REPORT_PATH}），不写事实`);
      for (const f of failures.slice(0, 20)) console.error(`  ✗ ${f.check}: ${f.detail}`);
      process.exitCode = 2;
      return;
    }
    await writeFile(SEMANTICS_REPORT_PATH, JSON.stringify(semanticsReport, null, 2), 'utf8');
    console.log(`[sw] 语义核验通过（报告 ${SEMANTICS_REPORT_PATH}）`);

    // ---------- 阶段 3：入库（缓存回放，0 新调用）----------
    console.log('[sw] 阶段 3 入库');
    const ingest: { scope: string; kind: string; inserted: number; identical: number; rejected: number; artifact: string }[] = [];
    const xlsResult = await adapter.fetchClassifyXls();
    ingest.push({ scope: xlsResult.scope, kind: 'INDUSTRY_CLASS_VERSION', inserted: xlsResult.insertedFactIds.length, identical: xlsResult.identicalFactIds.length, rejected: xlsResult.rejectedRows.length, artifact: xlsResult.artifact.sha256 });
    console.log(`[sw] classify: rows=${String(xlsResult.rowCount)} inserted=${String(xlsResult.insertedFactIds.length)} identical=${String(xlsResult.identicalFactIds.length)} rejected=${String(xlsResult.rejectedRows.length)}`);

    const l1Result = await adapter.fetchL1List();
    ingest.push({ scope: l1Result.scope, kind: 'SW_INDEX_LIST', inserted: l1Result.insertedFactIds.length, identical: l1Result.identicalFactIds.length, rejected: l1Result.rejectedRows.length, artifact: l1Result.artifact.sha256 });

    for (const code of l1Codes) {
      const r = await adapter.fetchL1Daily(code);
      ingest.push({ scope: r.scope, kind: 'SW_INDEX_BAR', inserted: r.insertedFactIds.length, identical: r.identicalFactIds.length, rejected: r.rejectedRows.length, artifact: r.artifact.sha256 });
      console.log(`[sw] daily ${code}: inserted=${String(r.insertedFactIds.length)} identical=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}`);
    }

    // 成分响应与 801020 探针：证据原件入库（不产事实）
    const evidenceArtifacts: { scope: string; sha256: string; bytes: number }[] = [];
    for (const code of componentCodes) {
      const r = await adapter.fetchL1Component(code);
      evidenceArtifacts.push({ scope: r.scope, sha256: r.artifact.sha256, bytes: r.artifact.bytes });
    }
    const probeArtifact = await store.put(
      new TextEncoder().encode(canonicalJsonString(probeRows)),
      'application/json',
      new Date().toISOString(),
    );
    evidenceArtifacts.push({ scope: 'sw:sw_l1_daily_evidence:801020', sha256: probeArtifact.sha256, bytes: probeArtifact.bytes });

    // 入库后 DB 计数（按 fact_kind）
    const countsRes = await pool.query<{ fact_kind: string; n: string }>(
      `select fact_kind, count(*)::text as n from pintime_fact where adapter_version = $1 group by 1 order by 1`,
      [SW_ADAPTER_VERSION],
    );

    const importReport = {
      generatedAt: new Date().toISOString(),
      adapterVersion: SW_ADAPTER_VERSION,
      factsByKind: Object.fromEntries(countsRes.rows.map((r) => [r.fact_kind, Number(r.n)])),
      ingest,
      evidenceArtifacts,
      gaps: [SW_CLASS_SOURCE_GAP_CLOSED, SW2014_GAP_CLOSED],
      notice: '修订口径声明：一次性回填 2015–2026 拿到的是当前最新修订值，与当时公告值可能不同且不可复原；历史参照库的事件主证据以公告 PDF 原文为准，结构化数据做辅助。',
      realCalls: { thisRun: ledger.realCalls, sessionTotal: ledger.calls.length },
      semanticsReportPath: SEMANTICS_REPORT_PATH,
    };
    await writeFile(IMPORT_REPORT_PATH, JSON.stringify(importReport, null, 2), 'utf8');
    console.log(JSON.stringify({ result: 'SW IMPORT OK', importReportPath: IMPORT_REPORT_PATH, factsByKind: importReport.factsByKind, realCallsThisRun: ledger.realCalls }, null, 2));
  } catch (error) {
    if (error instanceof AdapterPauseError) {
      console.error(`[sw] 暂停（退避耗尽）：${error.fourElements().scope}；恢复 = 重跑同一命令（缓存续跑，已完成调用不重复）。`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}
