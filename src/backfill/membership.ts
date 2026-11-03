/**
 * Lyra · 指数成分月度回填 runner（P1 W6: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 3/4/6（成分归属时点对象、任意历史日期封存的
 * 成分底座、断点续跑回填）、docs/specs/DATA-SOURCES.md §2.6/§7（节流与退避）。
 *
 * 段 = 指数 × 月末快照日：2015-01 至今每月的最后一个交易日（当月未完则截至覆盖尾的
 * 最近交易日，见 calendar.lastTradingDayOfMonth）× {hs300, zz500}，经
 * BaoStockAdapter.fetchIndexMembership 真实调用（INDEX_MEMBERSHIP 事实，W4 映射）。
 *
 * 断点续跑：进度文件 <stateDir>/membership-progress.json（默认 .backfill/），段完成才提交
 * 断点（tmp+rename 原子写）；重跑自动跳过已完成段。节流：相邻真实调用间隔 ≥ throttleMs
 * （默认 1600ms ≥ 派发要求的 1.5s）。暂停（退避耗尽）由适配器抛 AdapterPauseError，
 * 退出码 2；恢复 = 重跑同一命令。
 *
 * 事实与原件经适配器入库（public schema，完成度可从 pintime_fact 读出）；绝不绕过直写。
 * CLI：node --import tsx src/backfill/membership.ts [--from 2015-01] [--to YYYY-MM]
 *      [--throttle 1600]（默认 from=2015-01，to=当前月）
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { BAOSTOCK_ADAPTER_VERSION, BaoStockAdapter } from '../adapters/baostock.js';
import { CalendarError, backfillTradeCalendar, calendarCoverage, lastTradingDayOfMonth, loadTradeCalendarTable, type TradeCalendarTable } from '../adapters/calendar.js';

// ===== 纯计划（单测直接覆盖）=====

export type MembershipIndex = 'hs300' | 'zz500';
export const MEMBERSHIP_INDEXES: readonly MembershipIndex[] = ['hs300', 'zz500'];

export interface MembershipSegment {
  index: MembershipIndex;
  /** 月末快照日（该月最后一个覆盖交易日）。 */
  date: string;
  /** 断点键：index:date。 */
  segKey: string;
}

/** 'YYYY-MM' 月份序列（含端点，字符串序即时间序）。 */
export function planMonths(fromMonth: string, toMonth: string): string[] {
  const re = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!re.test(fromMonth) || !re.test(toMonth)) throw new CalendarError('CALENDAR_MONTH_INVALID', `${fromMonth}~${toMonth}`);
  if (fromMonth > toMonth) throw new CalendarError('CALENDAR_MONTH_INVALID', `${fromMonth} > ${toMonth}`);
  const months: string[] = [];
  let [y, m] = [Number(fromMonth.slice(0, 4)), Number(fromMonth.slice(5, 7))];
  const [ty, tm] = [Number(toMonth.slice(0, 4)), Number(toMonth.slice(5, 7))];
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

/**
 * 月份 × 指数 → 段清单。月内无覆盖交易日（未来月/日历未覆盖）跳过并记入 skippedMonths
 * （不编造快照日）；当月未完则快照日=截至覆盖尾的最近交易日。
 */
export function planMembershipSegments(
  table: TradeCalendarTable,
  fromMonth: string,
  toMonth: string,
): { segments: MembershipSegment[]; skippedMonths: { month: string; reason: string }[] } {
  const skippedMonths: { month: string; reason: string }[] = [];
  const segments: MembershipSegment[] = [];
  for (const month of planMonths(fromMonth, toMonth)) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    let date: string;
    try {
      date = lastTradingDayOfMonth(table, y, m);
    } catch (error) {
      if (error instanceof CalendarError && error.code === 'CALENDAR_RANGE') {
        skippedMonths.push({ month, reason: '月内无覆盖交易日（未来月份或日历未覆盖）' });
        continue;
      }
      throw error;
    }
    for (const index of MEMBERSHIP_INDEXES) {
      segments.push({ index, date, segKey: `${index}:${date}` });
    }
  }
  return { segments, skippedMonths };
}

// ===== 断点进度 =====

export interface MembershipSegmentStat {
  index: MembershipIndex;
  date: string;
  rowCount: number;
  insertedFacts: number;
  identicalFacts: number;
  completedAt: string;
}

export interface MembershipProgress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  completed: Record<string, MembershipSegmentStat>;
}

export function emptyMembershipProgress(): MembershipProgress {
  return { version: 1, adapterVersion: BAOSTOCK_ADAPTER_VERSION, updatedAt: new Date().toISOString(), completed: {} };
}

export async function loadMembershipProgress(path: string): Promise<MembershipProgress> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<MembershipProgress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : BAOSTOCK_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      completed: parsed.completed,
    };
  } catch {
    return emptyMembershipProgress();
  }
}

/** 原子写进度（tmp + rename），中断不留半截 JSON。 */
export async function saveMembershipProgress(path: string, progress: MembershipProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 注入化 runner（单测不碰网络、不碰 DB）=====

export type MembershipFetchFn = (
  index: MembershipIndex,
  date: string,
) => Promise<{ rowCount: number; insertedFactIds: string[]; identicalFactIds: string[] }>;

export interface MembershipRunOptions {
  segments: MembershipSegment[];
  progressPath: string;
  fetch: MembershipFetchFn;
  /** 相邻真实调用最小间隔，默认 1600ms（≥ 派发要求 1.5s）。 */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface MembershipRunResult {
  completed: number;
  skippedDone: number;
  realCalls: number;
  completedSegKeys: string[];
}

export async function runMembershipBackfill(opts: MembershipRunOptions): Promise<MembershipRunResult> {
  const throttleMs = opts.throttleMs ?? 1_600;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const progress = await loadMembershipProgress(opts.progressPath).catch(() => emptyMembershipProgress());
  const pending = opts.segments.filter((s) => progress.completed[s.segKey] === undefined);
  const skippedDone = opts.segments.length - pending.length;
  log(`[membership] segments=${opts.segments.length} done=${skippedDone} pending=${pending.length} throttle=${throttleMs}ms`);
  let realCalls = 0;
  let sinceLastCall = Number.POSITIVE_INFINITY; // 首个调用不额外等待
  for (const segment of pending) {
    if (Number.isFinite(sinceLastCall) && sinceLastCall < throttleMs) await sleep(throttleMs - sinceLastCall);
    const startedAt = Date.now();
    const r = await opts.fetch(segment.index, segment.date);
    realCalls += 1;
    sinceLastCall = Date.now() - startedAt;
    progress.completed[segment.segKey] = {
      index: segment.index,
      date: segment.date,
      rowCount: r.rowCount,
      insertedFacts: r.insertedFactIds.length,
      identicalFacts: r.identicalFactIds.length,
      completedAt: new Date().toISOString(),
    };
    await saveMembershipProgress(opts.progressPath, progress);
    log(`[membership] ${segment.segKey} rows=${r.rowCount} new=${r.insertedFactIds.length} dup=${r.identicalFactIds.length}`);
  }
  return { completed: pending.length, skippedDone, realCalls, completedSegKeys: pending.map((s) => s.segKey) };
}

// ===== CLI =====

function parseArgs(argv: string[]): { from: string; to: string; throttleMs: number } {
  let from = '2015-01';
  let to = new Date().toISOString().slice(0, 7);
  let throttleMs = 1_600;
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
    if (arg === '--from') from = valueOf(i + 1, '--from');
    else if (arg === '--to') to = valueOf(i + 1, '--to');
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
  }
  if (throttleMs < 1_500) {
    console.error(`--throttle 不得低于 1500ms（派发冻结 ≥1.5s）：${String(throttleMs)}`);
    process.exit(1);
  }
  return { from, to, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.MEMBERSHIP_STATE_DIR ?? '.backfill';
  const progressPath = join(stateDir, 'membership-progress.json');
  await mkdir(stateDir, { recursive: true });

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new BaoStockAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    // 日历底座：无 TRADE_CALENDAR 事实则先真实 1 调用（幂等重放不重复计）
    let table: TradeCalendarTable;
    let calendarCalls = 0;
    try {
      table = await loadTradeCalendarTable(pool);
      calendarCoverage(table);
    } catch {
      console.log('[membership] 日历为空，先回填交易日历（真实 1 调用）…');
      await backfillTradeCalendar(adapter, '2015-01-01', new Date().toISOString().slice(0, 10));
      calendarCalls = 1;
      table = await loadTradeCalendarTable(pool);
    }
    const coverage = calendarCoverage(table);
    console.log(`[membership] 日历覆盖 ${coverage.first}~${coverage.last}（${table.tradingDays.length} 个交易日）`);

    const { segments, skippedMonths } = planMembershipSegments(table, args.from, args.to);
    for (const s of skippedMonths) console.log(`[membership] 跳过 ${s.month}：${s.reason}`);
    console.log(`[membership] 计划段数=${segments.length}（${args.from}~${args.to} × ${MEMBERSHIP_INDEXES.join('/')}）`);

    try {
      const result = await runMembershipBackfill({
        segments,
        progressPath,
        throttleMs: args.throttleMs,
        fetch: (index, date) => adapter.fetchIndexMembership(index, date),
        log: (m) => console.log(m),
      });
      const progress = await loadMembershipProgress(progressPath);
      console.log(JSON.stringify({
        result: 'MEMBERSHIP BACKFILL OK',
        months: `${args.from}~${args.to}`,
        segmentsTotal: segments.length,
        ...result,
        totalCompletedInFile: Object.keys(progress.completed).length,
        realCallsTotal: result.realCalls + calendarCalls,
        progressPath,
      }, null, 2));
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[membership] 暂停（退避耗尽）：断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
        process.exitCode = 2;
      } else {
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不执行——单测要导入纯函数）
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/membership.ts');

if (isMain) {
  await main();
}
