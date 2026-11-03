/**
 * Lyra · 任意历史日期封存验证 harness（P1 W6: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 4（buildSeal → verifySeal 全绿 + assertNoLeakage
 * 零 violation，真实数据）、docs/specs/POINT-IN-TIME.md §7/§8。
 *
 * sealAndVerify（可复用核心）：给定 标的集成员 + 日期 → cutoff = 该日 15:00 Asia/Shanghai
 * （收盘事实口径）→ buildSeal（selector = 该主体全部事实，as-of cutoff）→ verifySeal
 * （manifestHash 重算 + 事实可解析 + 原件哈希校验读回）→ assertNoLeakage（零 violation
 * 断言，非空即抛）→ 报告（factKind 分布 + 各面读回样例——证明历史日期可用）。
 *
 * CLI（真实演示，600519 双日期）：
 *   node --import tsx src/verify/seal-any-date.ts --ensure --subject 600519 --date 2015-06-30 --date 2026-10-22
 * --ensure 先补齐 600519 数据面（幂等：DB 已有即跳过该真实调用）：全历史 K 线（1）、
 * 全历史复权因子（1）、近四季财务（4）、封存月成分快照（如缺，≤2/日期）。
 * 报告写 data/seal-report-<subject>-<date>.json；缺口 gaps 写入 manifest（POINT-IN-TIME §7）。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ArtifactStore } from '../artifacts/store.js';
import type { SubjectKind, TimePointFact } from '../contracts.js';
import { asOfFacts } from '../pintime/facts.js';
import { assertNoLeakage } from '../pintime/leakage.js';
import { buildSeal, verifySeal } from '../pintime/seal.js';
import type { BridgeRow } from '../adapters/adapter-types.js';
import { SW2014_GAP, SW_CLASS_SOURCE_GAP } from '../adapters/swclass.js';

/** 封存标的（标的集成员）。 */
export interface SealSubjectSpec {
  subjectKind: SubjectKind;
  /** 研究业务键 subject（代码）。 */
  subject: string;
  /** pintime 主体 id（股票 6 位代码）。 */
  subjectId: string;
}

export interface SealVersions {
  method: string;
  adapter: string;
  planAuth: string;
}

export const SEAL_VERSIONS: SealVersions = {
  method: '0.1.0-p0',
  adapter: 'baostock@0.9.40-p1',
  planAuth: 'pa-0.1',
};

/** 历史日期 D 的资料截点：D 15:00 Asia/Shanghai（收盘事实口径，含当日收盘面）。 */
export function cutoffOfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期须 YYYY-MM-DD：${date}`);
  return new Date(`${date}T15:00:00+08:00`).toISOString();
}

export interface SealContentSample {
  dailyBars: { count: number; first: string; last: string } | null;
  adjustFactors: { count: number; dates: string[] } | null;
  financials: { count: number; statDates: string[] } | null;
  memberships: { count: number; indexDays: string[] } | null;
  announcements: { count: number; titles: string[] } | null;
  stockBasic: boolean;
  industryClass: boolean;
}

export interface SealAnyDateReport {
  subject: SealSubjectSpec;
  date: string;
  cutoff: string;
  sealId: string;
  manifestHash: string;
  verify: { ok: true; factsChecked: number; artifactsChecked: number };
  leakageViolations: 0;
  gaps: string[];
  factKindCounts: Record<string, number>;
  content: SealContentSample;
}

/** 单标的 × 单日期：封存 → 校验 → 泄漏断言 → 读回样例报告。任一失败抛具名错误。 */
export async function sealAndVerify(
  pool: Pool,
  store: ArtifactStore,
  spec: SealSubjectSpec,
  date: string,
  gaps: string[],
  versions: SealVersions = SEAL_VERSIONS,
): Promise<SealAnyDateReport> {
  const cutoff = cutoffOfDate(date);
  const subjectType = spec.subjectKind === 'STOCK' ? 'STOCK' : 'ETF';
  const seal = await buildSeal(pool, store, {
    businessKey: { subjectKind: spec.subjectKind, subject: spec.subject, researchKind: 'WEEKLY', cutoff },
    cutoff,
    factSelector: { subjectType, subjectId: spec.subjectId },
    gaps,
    methodVersion: versions.method,
    adapterVersion: versions.adapter,
    planAuthVersion: versions.planAuth,
  });
  const verify = await verifySeal(pool, store, seal.sealId);
  if (!verify.ok) throw new Error(`verifySeal 不绿：${seal.sealId}`);
  const violations = await assertNoLeakage(pool, { sealId: seal.sealId, asOf: new Date(cutoff) });
  if (violations.length !== 0) {
    throw new Error(`泄漏违约 ${violations.length} 条：${JSON.stringify(violations.slice(0, 3))}`);
  }

  const facts = await asOfFacts(pool, { subjectType, subjectId: spec.subjectId, asOf: new Date(cutoff) });
  const factKindCounts: Record<string, number> = {};
  for (const f of facts) factKindCounts[f.factKind] = (factKindCounts[f.factKind] ?? 0) + 1;

  const tv = (f: TimePointFact): BridgeRow => f.typedValue as BridgeRow;
  const bars = facts.filter((f) => f.factKind === 'DAILY_BAR').map(tv);
  const barDates = bars.map((r) => r.date).filter((d): d is string => typeof d === 'string').sort();
  const factors = facts.filter((f) => f.factKind === 'ADJUST_FACTOR').map(tv);
  const factorDates = factors
    .map((r) => r.dividOperateDate ?? r.divideOperateDate ?? '')
    .filter((d) => d !== '')
    .sort();
  const fins = facts.filter((f) => f.factKind === 'FINANCIAL').map(tv);
  const statDates = [...new Set(fins.map((r) => r.statDate ?? '').filter((d) => d !== ''))].sort();
  const members = facts.filter((f) => f.factKind === 'INDEX_MEMBERSHIP').map(tv);
  const indexDays = [...new Set(members.map((r) => `${r.bsIndex ?? ''}:${r.updateDate ?? ''}`))].sort();
  const anns = facts.filter((f) => f.factKind === 'ANNOUNCEMENT').map(tv);

  return {
    subject: spec,
    date,
    cutoff,
    sealId: seal.sealId,
    manifestHash: seal.manifestHash,
    verify,
    leakageViolations: 0,
    gaps,
    factKindCounts,
    content: {
      dailyBars: barDates.length > 0 ? { count: barDates.length, first: barDates[0] ?? '', last: barDates[barDates.length - 1] ?? '' } : null,
      adjustFactors: factorDates.length > 0 ? { count: factorDates.length, dates: factorDates } : null,
      financials: statDates.length > 0 ? { count: fins.length, statDates } : null,
      memberships: indexDays.length > 0 ? { count: members.length, indexDays } : null,
      announcements: anns.length > 0 ? { count: anns.length, titles: anns.slice(0, 3).map((r) => r.title ?? '') } : null,
      stockBasic: facts.some((f) => f.factKind === 'STOCK_BASIC'),
      industryClass: facts.some((f) => f.factKind === 'INDUSTRY_CLASS_VERSION'),
    },
  };
}

// ===== 600519 数据面补齐（幂等；每次真实调用前先查 DB）=====

async function hasFacts(
  pool: Pool,
  filter: { subjectType: string; subjectId: string; factKind: string; minCount?: number },
): Promise<number> {
  const res = await pool.query<{ n: string }>(
    'select count(*)::text as n from pintime_fact where subject_type=$1 and subject_id=$2 and fact_kind=$3',
    [filter.subjectType, filter.subjectId, filter.factKind],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export interface EnsureReport {
  realCalls: { kline: number; adjustFactor: number; financials: number; membership: number };
  detail: Record<string, string>;
}

/** 600519 数据面补齐：全历史 K 线/复权因子、近四季财务、封存月成分快照（如缺）。幂等。 */
export async function ensure600519DataFace(
  pool: Pool,
  fetchKline: (start: string, end: string) => Promise<unknown>,
  fetchAdjustFactor: (start: string, end: string) => Promise<unknown>,
  fetchFinancials: (year: number, quarter: number) => Promise<unknown>,
  fetchMembership: (index: 'hs300' | 'zz500', date: string) => Promise<unknown>,
  sealMonthsLastTradingDay: string[],
  today: string,
): Promise<EnsureReport> {
  const realCalls = { kline: 0, adjustFactor: 0, financials: 0, membership: 0 };
  const detail: Record<string, string> = {};
  const bars = await hasFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR' });
  if (bars < 1000) {
    // 期望全历史 ~6000 根；<1000 视为只有冒烟窗口 → 补全历史（真实 1 调用）
    await fetchKline('1990-01-01', today);
    realCalls.kline = 1;
    detail.kline = `补全历史（既有 ${bars} 根）`;
  } else {
    detail.kline = `已有 ${bars} 根，跳过`;
  }
  const factors = await hasFacts(pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ADJUST_FACTOR' });
  if (factors < 10) {
    await fetchAdjustFactor('1990-01-01', today);
    realCalls.adjustFactor = 1;
    detail.adjustFactor = `补全历史（既有 ${factors} 条）`;
  } else {
    detail.adjustFactor = `已有 ${factors} 条，跳过`;
  }
  const quarters: Array<[number, number]> = [[2025, 4], [2026, 1], [2026, 2], [2026, 3]];
  const fetchedQuarters: string[] = [];
  for (const [year, quarter] of quarters) {
    const n = await pool.query<{ n: string }>(
      `select count(*)::text as n from pintime_fact
       where subject_type='STOCK' and subject_id='600519' and fact_kind='FINANCIAL'
         and typed_value->>'statDate' like $1`,
      [`${year}-${String(quarter * 3).padStart(2, '0')}-%`],
    );
    if (Number(n.rows[0]?.n ?? 0) === 0) {
      await fetchFinancials(year, quarter);
      realCalls.financials += 1;
      fetchedQuarters.push(`${year}Q${quarter}`);
    }
  }
  detail.financials = fetchedQuarters.length > 0 ? `补 ${fetchedQuarters.join('/')}` : '四季齐备，跳过';
  const fetchedMembership: string[] = [];
  for (const day of sealMonthsLastTradingDay) {
    const res = await pool.query<{ hs: string; zz: string }>(
      `select
         count(*) filter (where typed_value->>'bsIndex' = 'hs300')::text as hs,
         count(*) filter (where typed_value->>'bsIndex' = 'zz500')::text as zz
       from pintime_fact
       where fact_kind='INDEX_MEMBERSHIP' and typed_value->>'updateDate' = $1`,
      [day],
    );
    const row = res.rows[0];
    if (row === undefined || row.hs === '0') {
      await fetchMembership('hs300', day);
      realCalls.membership += 1;
      fetchedMembership.push(`hs300:${day}`);
    }
    if (row === undefined || row.zz === '0') {
      await fetchMembership('zz500', day);
      realCalls.membership += 1;
      fetchedMembership.push(`zz500:${day}`);
    }
  }
  detail.membership = fetchedMembership.length > 0 ? `补 ${fetchedMembership.join('/')}` : '封存月成分齐备，跳过';
  return { realCalls, detail };
}

// ===== CLI =====

function parseArgs(argv: string[]): { ensure: boolean; subject: string; dates: string[] } {
  let ensure = false;
  let subject: string | undefined;
  const dates: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ensure') ensure = true;
    else if (arg === '--subject') {
      subject = argv[i + 1];
      i += 1;
    } else if (arg === '--date') {
      const d = argv[i + 1];
      if (d === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        console.error(`--date 须 YYYY-MM-DD：${String(d)}`);
        process.exit(1);
      }
      dates.push(d);
      i += 1;
    }
  }
  if (subject === undefined || dates.length === 0) {
    console.error('用法：node --import tsx src/verify/seal-any-date.ts --ensure --subject 600519 --date 2015-06-30 --date 2026-10-22');
    process.exit(1);
  }
  return { ensure, subject, dates };
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('verify/seal-any-date.ts');

if (isMain) {
  await main();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { BaoStockAdapter } = await import('../adapters/baostock.js');
  const { lastTradingDayOfMonth, loadTradeCalendarTable } = await import('../adapters/calendar.js');
  const { fileURLToPath } = await import('node:url');
  const { mkdir } = await import('node:fs/promises');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  const pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const store = new ArtifactStore(artifactsDir);
    const adapter = new BaoStockAdapter({ pool, store });
    const today = new Date().toISOString().slice(0, 10);
    const table = await loadTradeCalendarTable(pool);

    let ensure: EnsureReport | null = null;
    if (args.ensure) {
      const sealMonthDays = args.dates.map((d) => lastTradingDayOfMonth(table, Number(d.slice(0, 4)), Number(d.slice(5, 7))));
      ensure = await ensure600519DataFace(
        pool,
        (start, end) => adapter.fetchDailyBars(args.subject, start, end),
        (start, end) => adapter.fetchAdjustFactor(args.subject, start, end),
        (year, quarter) => adapter.fetchQuarterFinancials(args.subject, year, quarter),
        (index, date) => adapter.fetchIndexMembership(index, date),
        sealMonthDays,
        today,
      );
      console.log(`[seal] ensure 600519：${JSON.stringify(ensure.realCalls)} ${JSON.stringify(ensure.detail)}`);
    }

    // 2021-12（申万 2021 版切换）之前的历史日期封存：申万轴（历史 2014 + 当前 2021 免费
    // 面均不可得，W6 实测）按缺口登记；之后日期：行业分类当前快照 availableAt=抓取时刻，
    // 晚于封存截点属诚实行为（不构成泄漏），同样如实记缺口文本。
    const gaps = [SW2014_GAP, SW_CLASS_SOURCE_GAP];
    const spec: SealSubjectSpec = { subjectKind: 'STOCK', subject: args.subject, subjectId: args.subject };
    const summaries: unknown[] = [];
    for (const date of args.dates) {
      const report = await sealAndVerify(pool, store, spec, date, gaps);
      const outPath = join(repoRoot, 'data', `seal-report-${args.subject}-${date}.json`);
      await writeFile(outPath, JSON.stringify({ ...report, ensure }, null, 2), 'utf8');
      summaries.push({
        date,
        cutoff: report.cutoff,
        sealId: report.sealId,
        manifestHash: report.manifestHash,
        verify: report.verify,
        leakageViolations: report.leakageViolations,
        factKindCounts: report.factKindCounts,
        content: report.content,
        reportPath: outPath,
      });
      console.log(`[seal] ${args.subject}@${date} 绿：facts=${report.verify.factsChecked} artifacts=${report.verify.artifactsChecked} violations=0`);
    }
    console.log(JSON.stringify({ result: 'SEAL ANY DATE OK', subject: args.subject, ensure: ensure?.realCalls ?? null, seals: summaries }, null, 2));
  } finally {
    await pool.end();
  }
}
