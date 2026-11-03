/**
 * Lyra · L1 全量公告元数据回填 runner（P1 W5: code-writer）。
 * 合同：docs/specs/DATA-SOURCES.md §4（L1 层：公告标题/时间/类别元数据，不做全量 PDF）、
 * §7（串行节流 + 退避暂停上报）、docs/specs/P1-DATA.md Done-when 6（断点续跑、完成度可读）。
 *
 * CLI：node --import tsx src/backfill/l1.ts --stocks <file> [--from 2015-01-01] [--to <今天>]
 * - 股票列表文件：每行一个 6 位代码；# 开头为注释；仅沪深主板（R17），其余代码报错拒绝。
 * - 段 = 股票 × 年度区间（from 按年切分）；段完成才提交断点，单次运行可中断可续跑。
 * - 断点：<stateDir>/l1-progress.json（L1_STATE_DIR 缺省 .backfill），含已完成段统计与 orgId 缓存；
 *   重跑自动跳过已完成段；段内中断则该段整体重做（原件幂等、事实按 factId 去重跳过）。
 * - 节流：请求间隔默认 2000ms（L1_THROTTLE_MS 覆盖），单来源串行。
 * - 暂停（退避 3 次仍失败）：经适配器落库 adapter_pause_report（R21，adapter='cninfo@p1'）+
 *   退出码 2；恢复 = 重跑同一命令，每段成功后经 resumePause 将该段触及的 scope 置 RESUMED。
 * - 原件（页 JSON）入 ArtifactStore（LYRA_ARTIFACTS_DIR 缺省 <cwd>/data/artifacts）；
 *   事实 insertFact 进主库（LYRA_PG_*，public schema——回填完成度可从 DB 读出）。
 *
 * 同 factId 已存在时跳过（POINT-IN-TIME §4：同原件 + 同适配器版本重放不产生新 fact_id，
 * 不重做语义计算；观察收据表 P0 schema 未提供，跳过即登记为 dup 计数——schema 冻结，不改）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ArtifactStore } from '../artifacts/store.js';
import type { TimePointFact } from '../contracts.js';
import { createPool } from '../db/pool.js';
import type { Pool } from 'pg';
import { CnInfoAdapter, CnInfoPauseError, classifyCninfoCode, cninfoPauseScope, CNINFO_ADAPTER_VERSION } from '../adapters/cninfo.js';
import { resumePause } from '../adapters/backoff.js';
import { insertFact, loadFact } from '../pintime/facts.js';

// ===== 断点状态 =====

interface SegmentStat {
  code: string;
  from: string;
  to: string;
  pages: number;
  facts: number;
  inserted: number;
  duplicate: number;
  completedAt: string;
}

interface L1Progress {
  version: 1;
  adapterVersion: string;
  updatedAt: string;
  orgIds: Record<string, string>;
  completed: Record<string, SegmentStat>;
}

function segmentKey(code: string, from: string, to: string): string {
  return `${code}:${from}:${to}`;
}

async function loadProgress(path: string): Promise<L1Progress> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<L1Progress>;
    if (parsed.version !== 1 || typeof parsed.completed !== 'object' || parsed.completed === null) {
      throw new Error('bad shape');
    }
    return {
      version: 1,
      adapterVersion: typeof parsed.adapterVersion === 'string' ? parsed.adapterVersion : CNINFO_ADAPTER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      orgIds: typeof parsed.orgIds === 'object' && parsed.orgIds !== null ? parsed.orgIds : {},
      completed: parsed.completed,
    };
  } catch {
    return { version: 1, adapterVersion: CNINFO_ADAPTER_VERSION, updatedAt: new Date().toISOString(), orgIds: {}, completed: {} };
  }
}

/** 原子写断点（tmp + rename），中断不留半截 JSON。 */
async function saveProgress(path: string, progress: L1Progress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== 输入 =====

async function readStocksFile(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  const codes: string[] = [];
  for (const line of raw.split('\n')) {
    const code = line.trim();
    if (code.length === 0 || code.startsWith('#')) continue;
    if (classifyCninfoCode(code) === null) {
      throw new Error(`股票代码越界（仅沪深主板，R17）：${code}`);
    }
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) throw new Error(`股票列表为空：${path}`);
  return codes;
}

/** 股票 × 年度段切分（含端点；[from, to] 均为 YYYY-MM-DD）。 */
export function sliceYearSegments(from: string, to: string, code: string): { code: string; from: string; to: string }[] {
  const segments: { code: string; from: string; to: string }[] = [];
  const startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    const segFrom = from > `${year}-01-01` ? from : `${year}-01-01`;
    const segTo = to < `${year}-12-31` ? to : `${year}-12-31`;
    if (segFrom <= segTo) segments.push({ code, from: segFrom, to: segTo });
  }
  return segments;
}

// ===== 段执行 =====

async function runSegment(
  pool: Pool,
  adapter: CnInfoAdapter,
  segment: { code: string; from: string; to: string },
): Promise<SegmentStat> {
  const pages = await adapter.fetchAnnouncements({ code: segment.code, from: segment.from, to: segment.to });
  let inserted = 0;
  let duplicate = 0;
  let factCount = 0;
  const seen = new Set<string>();
  for (const page of pages) {
    for (const fact of page.facts) {
      if (seen.has(fact.factId)) continue; // 同段内跨页重复键（DATA-SOURCES §6.5 去重）
      seen.add(fact.factId);
      factCount += 1;
      const existing = await loadFact(pool, fact.factId);
      if (existing !== null) {
        duplicate += 1; // 同 factId 已入库（上次运行）：跳过，不产生新 fact_id
        continue;
      }
      await insertFact(pool, fact);
      inserted += 1;
    }
  }
  return {
    code: segment.code,
    from: segment.from,
    to: segment.to,
    pages: pages.length,
    facts: factCount,
    inserted,
    duplicate,
    completedAt: new Date().toISOString(),
  };
}

// ===== CLI =====

function parseArgs(argv: string[]): { stocks: string; from: string; to: string } {
  let stocks: string | undefined;
  let from = '2015-01-01';
  let to = new Date().toISOString().slice(0, 10);
  const valueOf = (index: number, flag: string): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
      console.error(`缺少 ${flag} 的值`);
      process.exit(1);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stocks') stocks = valueOf(i + 1, '--stocks');
    else if (arg === '--from') from = valueOf(i + 1, '--from');
    else if (arg === '--to') to = valueOf(i + 1, '--to');
  }
  if (stocks === undefined) {
    console.error('用法：node --import tsx src/backfill/l1.ts --stocks <file> [--from 2015-01-01] [--to <YYYY-MM-DD>]');
    process.exit(1);
  }
  for (const d of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error(`日期格式须为 YYYY-MM-DD：${d}`);
      process.exit(1);
    }
  }
  if (from > to) {
    console.error(`--from 晚于 --to：${from} > ${to}`);
    process.exit(1);
  }
  return { stocks, from, to };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = process.env.L1_STATE_DIR ?? '.backfill';
  const throttleMs = Number(process.env.L1_THROTTLE_MS ?? 2000);
  const progressPath = join(stateDir, 'l1-progress.json');
  await mkdir(stateDir, { recursive: true });

  const codes = await readStocksFile(resolve(args.stocks));
  const progress = await loadProgress(progressPath);
  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(process.cwd(), 'data', 'artifacts');
  const pool = createPool();
  const adapter = new CnInfoAdapter({
    store: new ArtifactStore(artifactsDir),
    throttleMs,
    pool, // 暂停上报落库（R21）：经共享 recordPause 写 adapter_pause_report
  });

  const allSegments = codes.flatMap((code) => sliceYearSegments(args.from, args.to, code));
  const pending = allSegments.filter((segment) => progress.completed[segmentKey(segment.code, segment.from, segment.to)] === undefined);
  console.log(
    `[l1] adapter=${CNINFO_ADAPTER_VERSION} stocks=${codes.length} segments=${allSegments.length} ` +
      `done=${allSegments.length - pending.length} pending=${pending.length} throttle=${throttleMs}ms state=${progressPath}`,
  );

  try {
    for (const segment of pending) {
      // orgId 缓存复用（断点持久化，重跑不重复 topSearch）
      let orgId = progress.orgIds[segment.code] ?? adapter.peekOrgId(segment.code);
      if (orgId === undefined) {
        orgId = await adapter.resolveOrgId(segment.code);
        progress.orgIds[segment.code] = orgId;
        await saveProgress(progressPath, progress);
      } else {
        adapter.seedOrgId(segment.code, orgId);
      }
      const stat = await runSegment(pool, adapter, segment);
      progress.completed[segmentKey(segment.code, segment.from, segment.to)] = stat;
      await saveProgress(progressPath, progress);
      console.log(
        `[l1] ${segment.code} ${segment.from}~${segment.to} pages=${stat.pages} facts=${stat.facts} ` +
          `new=${stat.inserted} dup=${stat.duplicate}`,
      );
      // 恢复登记（backoff.ts resumePause 语义）：段成功后把该段触及的暂停 scope 置 RESUMED；
      // 无对应暂停行时为无害 no-op（不虚构暂停历史）。scope 与适配器落库侧同源（cninfoPauseScope）。
      await resumePause(pool, CNINFO_ADAPTER_VERSION, cninfoPauseScope({ step: 'topSearch', code: segment.code }));
      for (let page = 1; page <= stat.pages; page++) {
        await resumePause(
          pool,
          CNINFO_ADAPTER_VERSION,
          cninfoPauseScope({ step: 'hisAnnouncement', code: segment.code, seDate: `${segment.from}~${segment.to}`, pageNum: page }),
        );
      }
    }
    const done = Object.keys(progress.completed).length;
    console.log(`[l1] 运行完成：断点共 ${done} 个已完成段；完成度可从 pintime_fact 读出（fact_kind='ANNOUNCEMENT'）。`);
  } catch (error) {
    if (error instanceof CnInfoPauseError) {
      // 暂停上报已由适配器 console.error + 落库 adapter_pause_report；此处只置退出码，断点已保存。
      console.error(
        `[l1] 暂停（重试上限）：断点已保存于 ${progressPath}；暂停记录见 adapter_pause_report（adapter='${CNINFO_ADAPTER_VERSION}'）`,
      );
      process.exitCode = 2;
    } else {
      throw error;
    }
  } finally {
    await pool.end();
  }
}

await main();
