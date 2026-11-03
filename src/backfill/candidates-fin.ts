/**
 * Lyra · 池候选 604 股财务面回填 runner（P2 前置 W38: code-writer）。
 * 派发：W38（池候选 604 股财务补齐）——W36 行业中位 PE 实证的结构性限制修复：
 * 604 候选股有 DAILY_BAR 无 FINANCIAL，PE 样本宇宙（as-of 可见 FINANCIAL(profit) 股票集，
 * research/industry-valuation.ts loadStockPESamples）排除了全部候选 → 行业截面 n=1–3
 * 不可代表。本 runner 只补财务面，不改 W36 冻结纯函数。
 *
 * 只读复用（不复制改造）：执行器/断点/节流逻辑全部 import 自 src/backfill/pool-financials.ts
 * 导出纯函数（planFinancialSegments / runFinancialBackfill / loadFinProgress /
 * financialFactCounts / FinSegment / FinFetchFn）；本文件新增的仅是候选清单解析
 * （data/pool-candidates-sw.json 的 evidence 数组 ≠ research-pool.json 形状，parseResearchPool
 * 不适用）与季频子集段计划。适配器语义同 26 股模式（W8 冻结）：fetchQuarterFinancials
 * 每段 1 次真实调用 = profit+growth 两表（baostock.ts 头注），经原件入档 + insertFact
 * 幂等去重（supersedes 链由适配器承载，本 runner 不改）。
 *
 * 范围（派发冻结）：604 候选股（data/pool-candidates-sw.json evidence 全量，含冻结 26 股——
 * 该 26 股 2024Q3..2026Q3 在 W8 已完成，重跑走 dedup identical，不造新事实）× 报告期
 * 2024Q3..2026Q3 共 9 季 × profit+growth = 5,436 段。派发文本"近 8 个报告期"与枚举区间
 * "2024Q3..2026Q3"存在 8/9 出入，取枚举区间超集（宁多勿漏；多出 2024Q3 一季 604 段）。
 * 源空集（如 2026Q3 尚未披露，截至日 2026-10-25 披露期未结束）如实入档空原件、计 0 事实、
 * 段记 emptySource 完成——不重试、不造数（W8 冻结口径同款）。
 *
 * 断点续跑：<stateDir>/cand-fin-progress.json（默认 <repo>/.backfill；段完成才提交，
 * tmp+rename 原子写；与 W8 的 pool-fin-progress.json 分文件互不污染）；重跑自动跳过
 * 已完成段。节流：相邻真实调用 ≥ --throttle（默认 1600ms，下限 1500ms 冻结）。
 * 暂停（退避 3 次耗尽）：AdapterPauseError → 退出码 2；恢复 = 重跑同一命令。
 *
 * CLI：node --import tsx src/backfill/candidates-fin.ts
 *   [--candidates <file>] [--limit N(仅 smoke，真实跑禁用)] [--throttle 1600]
 * 环境：CAND_FIN_STATE_DIR（断点目录，smoke 用临时目录隔离）、LYRA_ARTIFACTS_DIR（同 W8）。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { AdapterPauseError } from '../adapters/backoff.js';
import { BaoStockAdapter } from '../adapters/baostock.js';
import {
  type FinFetchFn,
  type FinSegment,
  financialFactCounts,
  planFinancialSegments,
  runFinancialBackfill,
} from './pool-financials.js';
import { PoolBackfillError, toBsCode } from './pool-market.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// ===== 候选清单解析（纯函数；evidence 形状 ≠ research-pool.json）=====

/**
 * pool-candidates-sw.json 文本 → 候选股裸 6 位代码（文件序去重）。
 * 校验：根对象、evidence 非空数组、逐项 code 6 位数字、沪深主板（R17：60/00 开头，
 * toBsCode 具名拒绝非主板）、去重。name 等其余字段不消费（evidence 是筛选全量证据行，
 * selected 40 是其子集，代码集以 evidence 为准 = 派发的 604 股口径）。
 */
export function parseCandidatesSw(text: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new PoolBackfillError('CAND_JSON_INVALID', 'JSON 解析失败');
  }
  if (typeof root !== 'object' || root === null) {
    throw new PoolBackfillError('CAND_SHAPE_INVALID', '根不是对象');
  }
  const evidence = (root as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new PoolBackfillError('CAND_SHAPE_INVALID', 'evidence 须为非空数组');
  }
  const codes: string[] = [];
  const seen = new Set<string>();
  evidence.forEach((e, i) => {
    if (typeof e !== 'object' || e === null) {
      throw new PoolBackfillError('CAND_ENTRY_INVALID', `evidence[${String(i)}] 不是对象`);
    }
    const code = (e as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new PoolBackfillError('CAND_CODE_INVALID', `evidence[${String(i)}].code=${String(code)}`);
    }
    toBsCode(code, 'stock'); // 主板校验（R17），非主板具名拒绝
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  });
  return codes;
}

// ===== 季频子集段计划（纯函数；复用 W8 段形状与 segKey 约定）=====

/** 派发冻结报告期键：2024Q3..2026Q3 共 9 季（含 2024Q3/Q4；2026Q4 未到不取）。 */
export const CAND_QUARTER_KEYS: readonly string[] = [
  '2024Q3',
  '2024Q4',
  '2025Q1',
  '2025Q2',
  '2025Q3',
  '2025Q4',
  '2026Q1',
  '2026Q2',
  '2026Q3',
];

/**
 * 候选财务段计划：planFinancialSegments(2024..2026 全季) 后按冻结报告期键过滤，
 * 段形状与 segKey（fin:code:year:Qn）与 W8 逐字同款（断点/执行器零改动复用）。
 * 计划顺序 = 池文件序 × 年升序 × 季升序（确定序，断点续跑与审计可复放）。
 */
export function planCandidateSegments(stocks: string[]): FinSegment[] {
  const full = planFinancialSegments(stocks, 2024, 2026);
  const keys = new Set<string>(CAND_QUARTER_KEYS);
  return full.filter((s) => keys.has(`${String(s.year)}Q${String(s.quarter)}`));
}

// ===== CLI =====

function parseArgs(argv: string[]): { candidates: string; limit: number | null; throttleMs: number } {
  let candidates = join(repoRoot, 'data', 'pool-candidates-sw.json');
  let limit: number | null = null;
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
    if (arg === '--candidates') candidates = valueOf(i + 1, '--candidates');
    else if (arg === '--limit') limit = Number(valueOf(i + 1, '--limit'));
    else if (arg === '--throttle') throttleMs = Number(valueOf(i + 1, '--throttle'));
  }
  if (throttleMs < 1_500) {
    console.error(`--throttle 不得低于 1500ms（派发冻结 ≥1.5s）：${String(throttleMs)}`);
    process.exit(1);
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    console.error(`--limit 须为正整数（仅 smoke 用）：${String(limit)}`);
    process.exit(1);
  }
  return { candidates, limit, throttleMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.CAND_FIN_STATE_DIR ?? join(repoRoot, '.backfill');
  const progressPath = join(stateDir, 'cand-fin-progress.json');
  await mkdir(stateDir, { recursive: true });

  let codes = parseCandidatesSw(await readFile(args.candidates, 'utf8'));
  const candidatesTotal = codes.length;
  if (args.limit !== null) {
    codes = codes.slice(0, args.limit);
    console.log(`[cand-fin] --limit ${String(args.limit)}（smoke 模式，仅取清单前 ${String(args.limit)} 股；真实跑禁用本旗标）`);
  }
  const segments = planCandidateSegments(codes);

  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration } = await import('../adapters/backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const pool: Pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new BaoStockAdapter({ pool, store: new ArtifactStore(artifactsDir) });

    const factsBefore = await financialFactCounts(pool, codes);
    const artifactShas = new Set<string>();
    const fetch: FinFetchFn = async (segment) => {
      const r = await adapter.fetchQuarterFinancials(segment.bsCode, segment.year, segment.quarter);
      artifactShas.add(r.artifact.sha256);
      return r;
    };

    try {
      const result = await runFinancialBackfill({
        segments,
        progressPath,
        fetch,
        throttleMs: args.throttleMs,
        log: (m) => console.log(m),
      });
      const factsAfter = await financialFactCounts(pool, codes);
      const { loadFinProgress } = await import('./pool-financials.js');
      const progress = await loadFinProgress(progressPath);
      // 空集/具名拒绝按报告期汇总（如实上报，区分"源未披露"与"行被拒绝"）
      const emptyByQuarter: Record<string, number> = {};
      const rejectedByCode: Record<string, number> = {};
      for (const stat of Object.values(progress.completed)) {
        const qk = `${String(stat.year)}Q${String(stat.quarter)}`;
        if (stat.emptySource) emptyByQuarter[qk] = (emptyByQuarter[qk] ?? 0) + 1;
        if (stat.rejected > 0) rejectedByCode[stat.code] = (rejectedByCode[stat.code] ?? 0) + stat.rejected;
      }
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(factsAfter)) delta[k] = v - (factsBefore[k] ?? 0);
      console.log(
        JSON.stringify(
          {
            result: 'CANDIDATES FINANCIALS BACKFILL OK',
            candidatesFile: args.candidates,
            candidatesTotal,
            limit: args.limit,
            quarters: CAND_QUARTER_KEYS.join(','),
            quartersCount: CAND_QUARTER_KEYS.length,
            segmentsTotal: segments.length,
            ...result,
            artifactsDistinct: artifactShas.size,
            emptyByQuarter,
            rejectedByCode,
            factsBefore,
            factsAfter,
            factsDelta: delta,
            totalCompletedInFile: Object.keys(progress.completed).length,
            throttleMs: args.throttleMs,
            progressPath,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (error instanceof AdapterPauseError) {
        console.error(`[cand-fin] 暂停（退避耗尽）：${error.fourElements().scope}；断点已保存于 ${progressPath}；恢复 = 重跑同一命令。`);
        process.exitCode = 2;
      } else {
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不执行——纯函数可被后续单测导入）
const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('backfill/candidates-fin.ts');

if (isMain) {
  await main();
}
