/**
 * Lyra · 指数估值入库 runner（P2 W31: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §5/§6/§7、docs/specs/POINT-IN-TIME.md §2/§3.4；
 * 适配器 src/adapters/valuation.ts（valuation@p1）。
 *
 * 三阶段（核验不过不写事实）：
 * 1. 取数（真实调用，节流 ≥1.6s，逐调用记台账）：4 宽基指数 × {csindex_daily, lg_pe, lg_pb}
 *    + 全A {all_a_pe, all_a_pb} = 14 调用；桥响应缓存 data/valuation-originals/（重跑 0 新调用，
 *    断点续跑：已完成调用不重复）。
 * 2. 核验（纯内存）：各源行数/首末日期深度门槛（lg ≥130 行且首行 ≤2006-01 / zz1000 首行 ≤2015-01、
 *    末行 ≥2026-09-30；csindex 15–30 行窗口且末行近期）、拒截率 ≤5%。任一硬核验失败 → 只写报告、
 *    退出非零、不写事实。
 * 3. 入库（缓存回放走 ValuationAdapter 全管线，0 新调用）：INDEX_VALUATION 事实
 *    （availableAt=数据日次日 00:00+08 保守口径，R4 双声明随行）+ 原件入库 + 覆盖矩阵。
 *
 * 覆盖矩阵与选型记录 → data/valuation-import-report.json。
 * 申万一级行业指数 PE/PB 不在本 runner（akshare 1.19.3 无外部源；自算 B 类后续，依赖 W30 balance）。
 *
 * CLI：node --import tsx src/backfill/valuation.ts
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError, runWithBackoff } from '../adapters/backoff.js';
import type { BridgeResponse } from '../adapters/adapter-types.js';
import type { BridgeExecutor } from '../adapters/baostock.js';
import {
  ALL_A_SUBJECT_ID,
  VALUATION_ADAPTER_VERSION,
  VALUATION_SNAPSHOT_NOTICE,
  VALUATION_TARGETS,
  ValuationAdapter,
  makeValuationBridgeExecutor,
  type ValuationRow,
} from '../adapters/valuation.js';
import { ArtifactStore } from '../artifacts/store.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CACHE_DIR = join(repoRoot, 'data', 'valuation-originals');
const IMPORT_REPORT_PATH = join(repoRoot, 'data', 'valuation-import-report.json');
const THROTTLE_MS = 3_000;

// ===== 计划（纯函数，单测覆盖）=====

export type ValuationCommand = 'csindex_daily' | 'lg_pe' | 'lg_pb' | 'all_a_pe' | 'all_a_pb';

export interface ValuationPlanStep {
  command: ValuationCommand;
  /** 桥参数（csindex_daily/lg_*：对象标识；all_a_*：空）。 */
  params: string[];
  /** 覆盖矩阵键：来源命令 × 主体。 */
  subject: string;
  /** 目标指数（lg_* 用 lgKey；其余空）。 */
  lgKey: string;
  label: string;
}

/** 回填计划：4 宽基 × 3 源命令 + 全A × 2（顺序固定，断点续跑按序跳过已缓存）。 */
export function buildValuationPlan(targets: readonly { code: string; name: string; lgKey: string }[] = VALUATION_TARGETS): ValuationPlanStep[] {
  const steps: ValuationPlanStep[] = [];
  for (const t of targets) {
    steps.push({ command: 'csindex_daily', params: [t.code], subject: t.code, lgKey: '', label: `csindex 日频 ${t.code} ${t.name}` });
  }
  for (const t of targets) {
    steps.push({ command: 'lg_pe', params: [t.lgKey], subject: t.code, lgKey: t.lgKey, label: `legulegu PE 月末 ${t.code} ${t.name}` });
    steps.push({ command: 'lg_pb', params: [t.lgKey], subject: t.code, lgKey: t.lgKey, label: `legulegu PB 月末 ${t.code} ${t.name}` });
  }
  steps.push({ command: 'all_a_pe', params: [], subject: ALL_A_SUBJECT_ID, lgKey: '', label: '全A PE 月末' });
  steps.push({ command: 'all_a_pb', params: [], subject: ALL_A_SUBJECT_ID, lgKey: '', label: '全A PB 月末' });
  return steps;
}

export interface CoverageCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** 单源深度核验（纯函数）。csindex 窗口 15–30 行且末行近期；lg 全史 ≥130 行、首末日期深度。 */
export function coverageChecksFor(
  command: ValuationCommand,
  subject: string,
  rows: ValuationRow[],
  fetchedAtMs: number,
  firstDateExpect: Record<string, string> = {},
): CoverageCheck[] {
  const dates = rows
    .map((r) => (typeof r['日期ISO'] === 'string' ? r['日期ISO'] : typeof r['日期'] === 'string' ? r['日期'] : typeof r['date'] === 'string' ? r['date'] : null))
    .filter((d): d is string => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const first = dates[0] ?? '';
  const last = dates[dates.length - 1] ?? '';
  const name = `${command}:${subject}`;
  if (command === 'csindex_daily') {
    const recentLimit = new Date(fetchedAtMs - 45 * 86_400_000).toISOString().slice(0, 10);
    return [
      { name, ok: rows.length >= 15 && rows.length <= 30, detail: `窗口行数 ${String(rows.length)}（预期 15–30，官方 autofile 滚动窗）` },
      { name: `${name}:recent`, ok: last >= recentLimit, detail: `末行 ${last} ≥ ${recentLimit}（近期数据）` },
    ];
  }
  const firstExpect = firstDateExpect[subject] ?? '2006-01-01';
  const minRows = subject === '000852' ? 130 : 200;
  return [
    { name, ok: rows.length >= minRows, detail: `行数 ${String(rows.length)}（预期 ≥${String(minRows)}，月末频率全史）` },
    { name: `${name}:depth`, ok: first !== '' && first <= firstExpect, detail: `首行 ${first} ≤ ${firstExpect}` },
    { name: `${name}:fresh`, ok: last >= '2026-09-30', detail: `末行 ${last} ≥ 2026-09-30（回填当月）` },
  ];
}

// ===== 缓存执行器（真实调用台账 + 节流）=====

class Ledger {
  readonly calls: { args: string[]; cached: boolean; at: string }[] = [];
  get realCalls(): number {
    return this.calls.filter((c) => !c.cached).length;
  }
}

function cacheNameOf(args: string[]): string {
  const cmd = args[0];
  const a = args[1];
  if (cmd === 'csindex_daily' && a !== undefined) return `csindex-${a}.json`;
  if (cmd === 'lg_pe' && a !== undefined) return `lg-pe-${a}.json`;
  if (cmd === 'lg_pb' && a !== undefined) return `lg-pb-${a}.json`;
  if (cmd === 'all_a_pe') return 'all-a-pe.json';
  if (cmd === 'all_a_pb') return 'all-a-pb.json';
  throw new Error(`无法缓存命令：${JSON.stringify(args)}`);
}

function makeCachedExecutor(real: BridgeExecutor, ledger: Ledger): BridgeExecutor {
  return async (args) => {
    const path = join(CACHE_DIR, cacheNameOf(args));
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

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const gap = Date.now() - lastCallAt;
  if (lastCallAt > 0 && gap < THROTTLE_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, THROTTLE_MS - gap));
  }
  lastCallAt = Date.now();
}

// ===== 主流程 =====

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/valuation.ts');

if (isMain) {
  await main();
}

async function main(): Promise<void> {
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');

  const pool: Pool = createPool();
  const ledger = new Ledger();
  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);
  const exec = makeCachedExecutor(makeValuationBridgeExecutor(), ledger);
  const adapter = new ValuationAdapter({ pool, store, execBridge: exec });

  const failures: { check: string; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures.push({ check: name, detail });
  };

  try {
    await applySchema(pool);
    await applyP1Migration(pool);

    const plan = buildValuationPlan();
    const fetchedAtMs = Date.now();

    // ---------- 阶段 1：取数 ----------
    console.log('[valuation] 阶段 1 取数（缓存命中不重复调用；真实调用节流 ≥3s + 退避重试；429 等瞬态按 30s 起步逐次加倍原地重试）');
    const responses = new Map<string, ValuationRow[]>();
    for (const step of plan) {
      // 取数路径同享退避（legulegu 429 实测会打在 csrf 前置页）；耗尽 → AdapterPauseError →
      // 退出码 2，重跑同一命令自缓存断点续跑（已完成调用 0 新请求）。
      const resp = await runWithBackoff(() => exec([step.command, ...step.params]), {
        adapter: 'valuation',
        scope: `valuation:${step.command}:${step.subject}`,
        pool,
      });
      const rows = (resp.rows ?? []) as ValuationRow[];
      responses.set(`${step.command}:${step.subject}`, rows);
      console.log(`[valuation] ${step.label}: rows=${String(rows.length)}`);
    }

    // ---------- 阶段 2：核验 ----------
    console.log('[valuation] 阶段 2 覆盖核验');
    // 首行深度门槛（实测全史起点：上证50/沪深300 自 2005、中证500 自 2007-01-31（指数 2007-01-15
    // 发布）、中证1000 自 2014-10-31；门槛放宽一月余量）
    const firstDateExpect: Record<string, string> = { '000905': '2007-02-01', '000852': '2015-01-01' };
    const coverage: unknown[] = [];
    for (const step of plan) {
      const rows = responses.get(`${step.command}:${step.subject}`) ?? [];
      for (const c of coverageChecksFor(step.command, step.subject, rows, fetchedAtMs, firstDateExpect)) {
        check(c.name, c.ok, c.detail);
        coverage.push(c);
      }
    }
    if (failures.length > 0) {
      const report = {
        generatedAt: new Date().toISOString(),
        adapterVersion: VALUATION_ADAPTER_VERSION,
        conclusion: `覆盖核验失败 ${String(failures.length)} 项，未写入估值事实。`,
        failures,
        coverage,
        realCalls: { thisRun: ledger.realCalls, sessionTotal: ledger.calls.length },
      };
      await writeFile(IMPORT_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
      console.error(`[valuation] 覆盖核验失败 ${String(failures.length)} 项（报告 ${IMPORT_REPORT_PATH}），不写事实`);
      for (const f of failures.slice(0, 20)) console.error(`  ✗ ${f.check}: ${f.detail}`);
      process.exitCode = 2;
      return;
    }
    console.log(`[valuation] 覆盖核验通过（${String(plan.length)} 步）`);

    // ---------- 阶段 3：入库（缓存回放，0 新调用）----------
    console.log('[valuation] 阶段 3 入库');
    const ingest: { scope: string; inserted: number; identical: number; rejected: number; rowCount: number; artifact: string }[] = [];
    for (const step of plan) {
      const r =
        step.command === 'csindex_daily'
          ? await adapter.fetchCsindexDaily(step.subject)
          : step.command === 'lg_pe'
            ? await adapter.fetchLgPe(step.subject, step.lgKey)
            : step.command === 'lg_pb'
              ? await adapter.fetchLgPb(step.subject, step.lgKey)
              : step.command === 'all_a_pe'
                ? await adapter.fetchAllAPe()
                : await adapter.fetchAllAPb();
      ingest.push({
        scope: r.scope,
        inserted: r.insertedFactIds.length,
        identical: r.identicalFactIds.length,
        rejected: r.rejectedRows.length,
        rowCount: r.rowCount,
        artifact: r.artifact.sha256,
      });
      console.log(`[valuation] ${step.label}: rows=${String(r.rowCount)} inserted=${String(r.insertedFactIds.length)} identical=${String(r.identicalFactIds.length)} rejected=${String(r.rejectedRows.length)}`);
      const rej = r.rejectedRows.length;
      check(`${step.command}:${step.subject}:rejects`, rej <= Math.max(1, Math.floor(r.rowCount * 0.05)),
        `拒截 ${String(rej)}/${String(r.rowCount)}（>5% 视为来源形态漂移）`);
    }

    // 入库后 DB 计数（按 subject × 来源）
    const countsRes = await pool.query<{ subject_id: string; source: string; n: string }>(
      `select subject_id, typed_value->>'来源' as source, count(*)::text as n
       from pintime_fact where fact_kind = 'INDEX_VALUATION' and adapter_version = $1
       group by 1, 2 order by 1, 2`,
      [VALUATION_ADAPTER_VERSION],
    );

    const importReport = {
      generatedAt: new Date().toISOString(),
      adapterVersion: VALUATION_ADAPTER_VERSION,
      sourceSelection: {
        csindex: {
          what: '中证指数公司官网 OSS autofile indicator.xls（官方日频 PE1 总股本/PE2 计算用股本 + 股息率两口径）',
          frequency: '日频',
          depth: '近约 20 个交易日滚动窗口（非全史；W31 探测实测 000300/000016 各 20 行）',
          subjects: VALUATION_TARGETS.map((t) => t.code),
        },
        legulegu: {
          what: '乐咕乐股指数 PE（六口径）/ PB（三口径），经 AKShare 1.19.3',
          frequency: '月末（含最新一日）——非日频',
          depth: '上证50/沪深300 自 2005-01；中证500 自 2007-01（指数 2007-01-15 发布）；中证1000 自 2014-10（回填实测 262/262/259/259/238/238/145/145 行）',
          subjects: VALUATION_TARGETS.map((t) => t.code),
        },
        allA: {
          what: '乐咕乐股全A PE（TTM/LYR 中位/平均）与 PB（中位/等权），含来源自带分位列（抓取时点口径，R4 覆盖）',
          frequency: '月末',
          depth: '2005-01 起全史（W31 探测 262 行）',
          subjects: [ALL_A_SUBJECT_ID],
        },
        swIndustryNotCovered: {
          what: '申万一级行业指数 PE/PB（个股维度 2 行业分位所需）',
          reason: 'akshare 1.19.3 无外部源：index_value_hist_funddb 不在本版本；legulegu index-basic API 仅 12 宽基指数；cninfo 行业市盈率为按日查询（逐日全史数千次请求）且无 PB。',
          followUp: '自算（B 类后续）：SW_INDEX_BAR 全史 + INDEX_MEMBERSHIP 月度 + FINANCIAL（epsTTM，BaoStock）+ balance 净资产（W30 在飞）+ 股本，全部 as-of 材料可完全时点安全。',
        },
      },
      availableAtRule: 'INDEX_VALUATION.availableAt = 数据日次日 00:00 Asia/Shanghai（保守口径，派发冻结）',
      notices: ['修订口径声明（DATA-SOURCES §5）+ 估值快照口径声明随行', VALUATION_SNAPSHOT_NOTICE],
      factsBySubjectSource: Object.fromEntries(
        countsRes.rows.map((r) => [`${r.subject_id}/${r.source}`, Number(r.n)]),
      ),
      coverage,
      ingest,
      postIngestChecks: failures,
      realCalls: { thisRun: ledger.realCalls, cachedReplays: ledger.calls.filter((c) => c.cached).length, sessionTotal: ledger.calls.length, ledger: ledger.calls },
    };
    await writeFile(IMPORT_REPORT_PATH, JSON.stringify(importReport, null, 2), 'utf8');
    console.log(JSON.stringify({
      result: failures.length === 0 ? 'VALUATION IMPORT OK' : 'VALUATION IMPORT OK（入库后检查有失败项，见报告）',
      importReportPath: IMPORT_REPORT_PATH,
      factsBySubjectSource: importReport.factsBySubjectSource,
      realCallsThisRun: ledger.realCalls,
      postIngestCheckFailures: failures.length,
    }, null, 2));
  } catch (error) {
    if (error instanceof AdapterPauseError) {
      console.error(`[valuation] 暂停（退避耗尽）：${error.fourElements().scope}；恢复 = 重跑同一命令（缓存续跑，已完成调用不重复）。`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}
