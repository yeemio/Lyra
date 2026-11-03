/**
 * Lyra · 本地 Web 看板服务器（W47: code-writer-pro）。
 * 合同：派发冻结——纯 node:http + src/db/pool.ts 连接池，零新依赖；端口 3456
 * （env LYRA_WEB_PORT 覆盖）；绑 127.0.0.1 仅本机；所有 DB 查询只读且参数化（$n 绑定）；
 * 全部 DB 来源字符串经 pages.escapeHtml 嵌入；页面模板见 src/web/pages.ts，
 * 设计系统（Metis 移植）经 /style.css 只读读回（src/web/style.css，进程内缓存一份）。
 *
 * 只读边界：本服务器不写任何表、不落任何原件；唯一"重"读为报告读回绑定链
 * （A/J 输出按 canonicalSha256 哈希绑定 var/sol-invocations；程序清单由 A 机械
 * 重导出并校验 checklistHash；输入包按封存 manifestHash 绑定原件库 CAS 读回），
 * 任一环未命中即如实呈现缺（诚实边界），不代填。
 *
 * 用法：node --import tsx src/web/server.ts  →  终端打印 http://127.0.0.1:3456
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { canonicalSha256 } from '../canonical.js';
import { createPool } from '../db/pool.js';
import { readConclusion } from '../db/conclusion.js';
import {
  calendarCoverage,
  isTradingDay,
  loadTradeCalendarTable,
  nextTradingDay,
  tradingDaysBetween,
  type TradeCalendarTable,
} from '../adapters/calendar.js';
import { shanghaiInstant, shanghaiWall, shanghaiWeekday, WEEKLY_DEADLINE } from '../schedule/windows.js';
import { nightSubjects, rotationTableFromPool } from '../schedule/weekly.js';
import { deriveChecklist } from '../research/checklist.js';
import { buildReportView, renderReportText } from '../research/report.js';
import type { ReportView } from '../research/report.js';
import type { ResearchInputPackage } from '../research/inputs.js';
import type { DimensionCoveragePkg } from '../research/checklist.js';
import type {
  AOutput,
  ConclusionObject,
  JOutput,
  ProgramChecklist,
  ResearchBusinessKey,
} from '../contracts.js';
import {
  renderConclusionsHtml,
  renderErrorPage,
  renderHomePage,
  renderSubjectHtml,
  type ConclusionRowData,
  type EventPanelRow,
  type HomeData,
  type SubjectPageData,
  type SubjectTab,
  type SystemStatusData,
} from './pages.js';

// ===== 常量（P5 观察轴）=====

/** P5 前瞻观察起点（R29 冻结生效日，AGENTS.md）。 */
export const P5_START = '2026-10-26';
/** P5 观察第 N 周（1 起）。 */
export function p5WeekOf(now: Date): number {
  const start = shanghaiInstant(P5_START, '00:00:00').getTime();
  return Math.max(1, Math.floor((now.getTime() - start) / 604_800_000) + 1);
}

export const EVENT_LABELS: Record<string, string> = {
  EARNINGS_FORECAST: '业绩预告',
  EARNINGS_FLASH: '业绩快报',
  PERIOD_GROWTH_DELTA: '定期增速变化',
  SHARE_UNLOCK: '限售解禁',
  HOLDER_TRADE: '大股东增减持',
  BUYBACK: '回购',
  REGULATORY_INQUIRY: '监管问询',
};

// ===== 路由匹配（纯函数）=====

export type Route =
  | { name: 'home' }
  | { name: 'subject'; code: string }
  | { name: 'conclusions' }
  | { name: 'status' }
  | { name: 'style' };

const SUBJECT_RE = /^\/subject\/(\d{6})$/;

/** 已知路由匹配；未知返回 null（调用方 404）。 */
export function matchRoute(method: string, pathname: string): Route | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (pathname === '/' || pathname === '/index.html') return { name: 'home' };
  if (pathname === '/style.css') return { name: 'style' };
  if (pathname === '/conclusions') return { name: 'conclusions' };
  if (pathname === '/api/status') return { name: 'status' };
  const m = SUBJECT_RE.exec(pathname);
  if (m !== null) return { name: 'subject', code: m[1] as string };
  return null;
}

/** 标的页标签页解析（?t= 白名单，缺省/非法回落 A 摘要）。 */
export function parseSubjectTab(raw: string | null): SubjectTab {
  return raw === 'checklist' || raw === 'j' || raw === 'settlement' ? raw : 'a';
}

// ===== 结论列表筛选解析（纯函数，白名单校验）=====

export interface ConclusionsFilters {
  kind: 'STOCK' | 'BROAD_ETF' | null;
  disposition: string | null;
  settlement: 'UNSETTLED' | 'SETTLED' | 'ANOMALY' | null;
  page: number;
}

export const CONCLUSIONS_PAGE_SIZE = 50;

/** 解析 /conclusions 查询串；非法值具名拒绝（返回 error）。 */
export function parseConclusionsQuery(query: URLSearchParams): { filters: ConclusionsFilters } | { error: string } {
  const rawKind = query.get('kind');
  const rawDisposition = query.get('disposition');
  const rawSettlement = query.get('settlement');
  const rawPage = query.get('page');
  if (rawKind !== null && rawKind !== '' && rawKind !== 'STOCK' && rawKind !== 'BROAD_ETF') {
    return { error: `未知 kind：${rawKind}` };
  }
  const kind = rawKind === null || rawKind === '' ? null : rawKind;
  if (
    rawDisposition !== null &&
    rawDisposition !== '' &&
    rawDisposition !== 'RESEARCH_OUTPERFORM' &&
    rawDisposition !== 'RESEARCH_UNDERPERFORM' &&
    rawDisposition !== 'RESEARCH_UP' &&
    rawDisposition !== 'RESEARCH_DOWN' &&
    rawDisposition !== 'ABSTAIN'
  ) {
    return { error: `未知 disposition：${rawDisposition}` };
  }
  const disposition = rawDisposition === null || rawDisposition === '' ? null : rawDisposition;
  if (
    rawSettlement !== null &&
    rawSettlement !== '' &&
    rawSettlement !== 'UNSETTLED' &&
    rawSettlement !== 'SETTLED' &&
    rawSettlement !== 'ANOMALY'
  ) {
    return { error: `未知 settlement：${rawSettlement}` };
  }
  const settlement = rawSettlement === null || rawSettlement === '' ? null : rawSettlement;
  let page = 1;
  if (rawPage !== null && rawPage !== '') {
    if (!/^\d+$/.test(rawPage)) return { error: `page 须为正整数：${rawPage}` };
    page = Number(rawPage);
    if (page < 1 || page > 100000) return { error: `page 超界：${rawPage}` };
  }
  return {
    filters: {
      kind,
      disposition,
      settlement,
      page,
    },
  };
}

// ===== 轮转预览（纯函数）=====

export type RotationNight = { date: string; nth: number };

/**
 * 下一晚轮转：今天（上海墙钟）为交易日且未过 23:30 截止 → 今晚；否则下一个交易日。
 * nth = 该晚在本自然周（周一起）交易日序列中的序号（W17 轮转映射的输入）。
 * 日历覆盖外或界内无下一交易日 → 具名 error，不猜测。
 */
export function nextRotationNight(
  tradingDays: readonly string[],
  wall: { date: string; time: string },
): RotationNight | { error: string } {
  const table: TradeCalendarTable = { tradingDays: [...tradingDays] };
  try {
    let night: string;
    if (isTradingDay(table, wall.date) && wall.time < WEEKLY_DEADLINE) {
      night = wall.date;
    } else {
      night = nextTradingDay(table, wall.date);
    }
    // 本自然周交易日序列（周一起；尾界截到日历覆盖尾，与 nightly.ts 同口径——
    // nth 只依赖该晚之前的交易日，截尾不影响序号）。
    const { last } = calendarCoverage(table);
    const weekday = shanghaiWeekday(night);
    const offset = weekday === 0 ? 6 : weekday - 1;
    const monday = shanghaiWall(new Date(shanghaiInstant(night, '00:00:00').getTime() - offset * 86_400_000)).date;
    const sunday = shanghaiWall(new Date(shanghaiInstant(monday, '00:00:00').getTime() + 6 * 86_400_000)).date;
    const weekDays = tradingDaysBetween(table, monday, sunday > last ? last : sunday);
    const nth = weekDays.indexOf(night) + 1;
    if (nth < 1) return { error: `轮转序号不可得：${night} 不在本周交易日序列内` };
    return { date: night, nth };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const name = typeof code === 'string' && code.length > 0 ? code : error instanceof Error ? error.name : 'ERROR';
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `${name}: ${detail}` };
  }
}

// ===== 报告读回绑定链（A/J 哈希索引 + 输入包索引 + 清单重导出）=====

export interface InvocationSources {
  aByHash: Map<string, AOutput>;
  jByHash: Map<string, JOutput>;
}

const emptySources: InvocationSources = { aByHash: new Map(), jByHash: new Map() };

/** 扫描 var/sol-invocations/<dir>/final.txt，按 canonicalSha256 建哈希索引（绑定即校验）。 */
export async function buildInvocationIndex(dir: string): Promise<InvocationSources> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return emptySources; // 目录不存在 → 空索引（报告如实呈现缺）
  }
  const aByHash = new Map<string, AOutput>();
  const jByHash = new Map<string, JOutput>();
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    let text: string;
    try {
      text = await readFile(join(dir, d.name, 'final.txt'), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const stage = (parsed as { stage?: unknown }).stage;
    if (stage !== 'A' && stage !== 'J') continue;
    const hash = canonicalSha256(parsed);
    if (stage === 'A') aByHash.set(hash, parsed as AOutput);
    else jByHash.set(hash, parsed as JOutput);
  }
  return { aByHash, jByHash };
}

/** 调用记录索引：懒构建 + 未命中且距上次扫描 >30s 时重扫（拾取运行期新增调用）。 */
export class InvocationIndex {
  private sources: InvocationSources = emptySources;
  private builtAt = 0;
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  async sourcesFor(needAHashes: readonly string[], needJHashes: readonly string[]): Promise<InvocationSources> {
    const hit =
      needAHashes.every((h) => this.sources.aByHash.has(h)) && needJHashes.every((h) => this.sources.jByHash.has(h));
    if (hit) return this.sources;
    if (this.now().getTime() - this.builtAt > 30_000) {
      this.sources = await buildInvocationIndex(this.dir);
      this.builtAt = this.now().getTime();
    }
    return this.sources;
  }
}

// ===== 输入包索引（原件库前缀扫描 + manifestHash 绑定）=====

/** RESEARCH_INPUT 包 canonical JSON 的固定前缀（键序按字典序，assemblerRulesVersion 恒为首键）。 */
export const PACKAGE_PREFIX = '{"assemblerRulesVersion":"research-inputs@p2-v1"';
const HEAD_BYTES = 320;

export interface PackageIndexEntry {
  sha: string;
  subjectKind: string;
  subject: string;
  researchKind: string;
  cutoff: string;
}

const BUSINESS_KEY_HEAD_RE =
  /,"businessKey":\{"cutoff":"([^"]*)","researchKind":"([^"]*)","subject":"([^"]*)","subjectKind":"([^"]*)"\}/;

/**
 * 原件库前缀扫描：只读每个文件头 320 字节识别 RESEARCH_INPUT 包并提取业务键，
 * 不整读不解析正文。返回索引条目（正文按需经 ArtifactStore 哈希校验读回）。
 */
export async function scanPackageIndex(artifactsRoot: string): Promise<PackageIndexEntry[]> {
  const shards = (await readdir(artifactsRoot)).filter((d) => /^[0-9a-f]{2}$/.test(d));
  const entries: PackageIndexEntry[] = [];
  for (const shard of shards) {
    const names = await readdir(join(artifactsRoot, shard));
    const files = names.filter((n) => /^[0-9a-f]{64}$/.test(n));
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const heads = await Promise.all(
        batch.map(async (name): Promise<string | null> => {
          let fh;
          try {
            fh = await open(join(artifactsRoot, shard, name), 'r');
            const buf = Buffer.alloc(HEAD_BYTES);
            const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
            return buf.toString('utf8', 0, bytesRead);
          } catch {
            return null;
          } finally {
            await fh?.close().catch(() => {});
          }
        }),
      );
      for (let j = 0; j < batch.length; j += 1) {
        const head = heads[j];
        if (head === null || head === undefined || !head.startsWith(PACKAGE_PREFIX)) continue;
        const m = BUSINESS_KEY_HEAD_RE.exec(head);
        if (m === null) continue;
        entries.push({
          sha: batch[j] as string,
          cutoff: m[1] as string,
          researchKind: m[2] as string,
          subject: m[3] as string,
          subjectKind: m[4] as string,
        });
      }
    }
  }
  return entries;
}

/** 包与结论的绑定判定：包内任一封存 manifestHash 命中结论 evidence.manifestHash。 */
export function packageBound(pkg: ResearchInputPackage, manifestHash: string): boolean {
  return Array.isArray(pkg.seals) && pkg.seals.some((s) => s?.manifestHash === manifestHash);
}

/** 程序清单重导出：由 A 机械派生（p0，无覆盖包），哈希不符再试 p2（带覆盖包）；仍不符 → null。 */
export function checklistFor(
  aOutput: AOutput,
  manifestHash: string,
  expectedChecklistHash: string,
  coverage: DimensionCoveragePkg | null,
): ProgramChecklist | null {
  const p0 = deriveChecklist(aOutput, manifestHash);
  if (p0.checklistHash === expectedChecklistHash) return p0;
  if (coverage !== null) {
    const p2 = deriveChecklist(aOutput, manifestHash, coverage);
    if (p2.checklistHash === expectedChecklistHash) return p2;
  }
  return null;
}

/** 包 dimensions → 清单 p2 覆盖参数（维度名用中文名以匹配 A 论述提及，与 gate-m.ts 同口径）。 */
export function coverageOfPackage(pkg: ResearchInputPackage): DimensionCoveragePkg {
  return {
    dimensions: pkg.dimensions.map((d) => ({ dimension: d.name, deliveredCount: d.delivered.length, gap: d.gap })),
  };
}

/** 输入包源：索引懒扫描（10 分钟 TTL）+ CAS 哈希校验读回 + 小缓存。 */
export class PackageSources {
  private entriesCache: PackageIndexEntry[] | null = null;
  private entriesAt = 0;
  private readonly pkgCache = new Map<string, ResearchInputPackage>();

  constructor(
    private readonly store: ArtifactStore,
    private readonly artifactsRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async entries(): Promise<PackageIndexEntry[]> {
    if (this.entriesCache !== null && this.now().getTime() - this.entriesAt <= 600_000) {
      return this.entriesCache;
    }
    this.entriesCache = await scanPackageIndex(this.artifactsRoot);
    this.entriesAt = this.now().getTime();
    return this.entriesCache;
  }

  /** CAS 哈希校验读回并解析；读失败/解析失败返回 null（调用方如实呈现缺）。 */
  async read(sha: string): Promise<ResearchInputPackage | null> {
    const cached = this.pkgCache.get(sha);
    if (cached !== undefined) return cached;
    try {
      const bytes = await this.store.readBytes(sha);
      const pkg = JSON.parse(new TextDecoder().decode(bytes)) as ResearchInputPackage;
      if (pkg?.packageKind !== 'RESEARCH_INPUT' || !Array.isArray(pkg.seals) || !Array.isArray(pkg.dimensions)) {
        return null;
      }
      if (this.pkgCache.size >= 8) {
        const oldest = this.pkgCache.keys().next().value;
        if (oldest !== undefined) this.pkgCache.delete(oldest);
      }
      this.pkgCache.set(sha, pkg);
      return pkg;
    } catch {
      return null;
    }
  }

  /** 按业务键 + manifestHash 找绑定包；未命中返回 null。 */
  async boundPackage(businessKey: ResearchBusinessKey, manifestHash: string): Promise<ResearchInputPackage | null> {
    const entries = await this.entries();
    for (const entry of entries) {
      if (
        entry.subject !== businessKey.subject ||
        entry.subjectKind !== businessKey.subjectKind ||
        entry.researchKind !== businessKey.researchKind ||
        entry.cutoff !== businessKey.cutoff
      ) {
        continue;
      }
      const pkg = await this.read(entry.sha);
      if (pkg !== null && packageBound(pkg, manifestHash)) return pkg;
    }
    return null;
  }
}

// ===== 只读 DB 查询 =====

interface LatestConclusionRow {
  subject: string;
  disposition: string;
  settlement_state: string | null;
  created_at: Date;
}

async function fetchLatestConclusionsBySubject(pool: Pool): Promise<Map<string, LatestConclusionRow>> {
  const res = await pool.query<LatestConclusionRow>(
    `select distinct on (business_key->>'subject')
       business_key->>'subject' as subject,
       disposition,
       settlement->>'state' as settlement_state,
       created_at
     from conclusion
     order by business_key->>'subject', created_at desc`,
  );
  return new Map(res.rows.map((r) => [r.subject, r]));
}

async function fetchSystemStatus(pool: Pool): Promise<Omit<SystemStatusData, 'p5Week'>> {
  const facts = await pool.query<{ n: string }>('select count(*)::text as n from pintime_fact');
  const permits = await pool.query<{ state: string; n: string }>(
    'select state, count(*)::text as n from exec_permit group by state',
  );
  const install = await pool.query<{ green: boolean; version_id: string; recorded_at: Date }>(
    'select green, version_id, recorded_at from install_log order by id desc limit 1',
  );
  const byState: Record<string, number> = {};
  let total = 0;
  for (const row of permits.rows) {
    byState[row.state] = Number(row.n);
    total += Number(row.n);
  }
  const unknown = byState['UNKNOWN'] ?? 0;
  const latestInstall = install.rows[0];
  const installGreen = latestInstall !== undefined && latestInstall.green === true;
  const battery: 'GREEN' | 'RED' = installGreen && unknown === 0 ? 'GREEN' : 'RED';
  const basis =
    `绿 = DB 可达 + 最近 install_log 全绿（${latestInstall === undefined ? '无记录' : `${latestInstall.version_id} @ ${latestInstall.recorded_at.toISOString()}`}）+ 无 UNKNOWN permit` +
    `；当前 UNKNOWN=${String(unknown)}。系统状态不含全量测试电池实时结果（仓库级事实，见 delivery 记录）`;
  return {
    battery,
    batteryBasis: basis,
    factCount: Number(facts.rows[0]?.n ?? 0),
    permitsTotal: total,
    permitsByState: byState,
    dbError: null,
  };
}

async function fetchEventPanel(pool: Pool, todayStart: Date, weekStart: Date): Promise<EventPanelRow[]> {
  const res = await pool.query<{ type: string; today: string; week: string }>(
    `select type,
       count(*) filter (where event_time >= $1)::text as today,
       count(*) filter (where event_time >= $2)::text as week
     from events
     where event_time >= $2
     group by type
     order by type`,
    [todayStart, weekStart],
  );
  return res.rows.map((r) => ({
    type: r.type,
    label: EVENT_LABELS[r.type] ?? r.type,
    today: Number(r.today),
    week: Number(r.week),
  }));
}

function rowToConclusionRow(r: {
  conclusion_id: string;
  subject: string;
  subject_kind: string;
  research_kind: string;
  disposition: string;
  settlement_state: string | null;
  direction_hit: string | null;
  excess_return: string | null;
  tradability: string | null;
  created_at: Date;
}): ConclusionRowData {
  return {
    conclusionId: r.conclusion_id,
    subject: r.subject,
    subjectKind: r.subject_kind,
    researchKind: r.research_kind,
    disposition: r.disposition,
    settlementState: r.settlement_state,
    directionHit: r.direction_hit,
    excessReturn: r.excess_return,
    tradability: r.tradability,
    createdAt: r.created_at.toISOString(),
  };
}

const CONCLUSION_SELECT = `select conclusion_id,
  business_key->>'subject' as subject,
  business_key->>'subjectKind' as subject_kind,
  business_key->>'researchKind' as research_kind,
  disposition,
  settlement->>'state' as settlement_state,
  (settlement->>'directionHit')::text as direction_hit,
  settlement->>'excessReturn' as excess_return,
  settlement->>'tradability' as tradability,
  created_at`;

async function fetchConclusionsOfSubject(pool: Pool, subject: string): Promise<ConclusionRowData[]> {
  const res = await pool.query(
    `${CONCLUSION_SELECT} from conclusion
     where business_key->>'subject' = $1
     order by created_at desc`,
    [subject],
  );
  return res.rows.map(rowToConclusionRow);
}

async function fetchConclusionsPage(
  pool: Pool,
  filters: ConclusionsFilters,
): Promise<{ rows: ConclusionRowData[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.kind !== null) {
    params.push(filters.kind);
    where.push(`business_key->>'subjectKind' = $${String(params.length)}`);
  }
  if (filters.disposition !== null) {
    params.push(filters.disposition);
    where.push(`disposition = $${String(params.length)}`);
  }
  if (filters.settlement !== null) {
    params.push(filters.settlement);
    where.push(`settlement->>'state' = $${String(params.length)}`);
  }
  const whereSql = where.length === 0 ? '' : `where ${where.join(' and ')}`;
  const countRes = await pool.query<{ n: string }>(`select count(*)::text as n from conclusion ${whereSql}`, params);
  const total = Number(countRes.rows[0]?.n ?? 0);
  params.push(CONCLUSIONS_PAGE_SIZE);
  const limitIdx = params.length;
  params.push((filters.page - 1) * CONCLUSIONS_PAGE_SIZE);
  const res = await pool.query(
    `${CONCLUSION_SELECT} from conclusion ${whereSql}
     order by created_at desc
     limit $${String(limitIdx)} offset $${String(limitIdx + 1)}`,
    params,
  );
  return { rows: res.rows.map(rowToConclusionRow), total };
}

// ===== 冻结池文件 =====

export interface PoolInfo {
  frozenAt: string;
  version: string;
  stocks: { code: string; name: string; swL1Name: string }[];
  etfs: { code: string; name: string; tracks: string }[];
}

export function parsePoolInfo(parsed: unknown): PoolInfo {
  const info = parsed as Partial<PoolInfo> & { stocks?: unknown; etfs?: unknown; version?: unknown };
  if (
    typeof info?.frozenAt !== 'string' ||
    (typeof info?.version !== 'string' && typeof info?.version !== 'number') ||
    !Array.isArray(info.stocks) ||
    !Array.isArray(info.etfs)
  ) {
    throw new Error('研究池文件形状不合法（缺 frozenAt/version/stocks/etfs）');
  }
  const stocks = (info.stocks as PoolInfo['stocks']).map((s) => {
    if (typeof s?.code !== 'string' || typeof s?.name !== 'string' || typeof s?.swL1Name !== 'string') {
      throw new Error(`研究池 stocks 条目形状不合法：${String(s?.code)}`);
    }
    return { code: s.code, name: s.name, swL1Name: s.swL1Name };
  });
  const etfs = (info.etfs as PoolInfo['etfs']).map((e) => {
    if (typeof e?.code !== 'string' || typeof e?.name !== 'string' || typeof e?.tracks !== 'string') {
      throw new Error(`研究池 etfs 条目形状不合法：${String(e?.code)}`);
    }
    return { code: e.code, name: e.name, tracks: e.tracks };
  });
  return { frozenAt: info.frozenAt, version: String(info.version), stocks, etfs };
}

async function loadPoolInfo(file: string): Promise<PoolInfo> {
  return parsePoolInfo(JSON.parse(await readFile(file, 'utf8')));
}

// ===== 报告视图组装（绑定链）=====

export interface BoundReport {
  view: ReportView;
  text: string;
}

/**
 * 组装选定结论的报告视图：结论（库）+ A/J（哈希绑定）+ 清单（重导出 + 哈希校验）
 * + 输入包（manifestHash 绑定，CAS 校验读回）。任一环缺 → 视图内该段为 null（不代填）。
 */
export async function buildBoundReport(
  conclusion: ConclusionObject,
  invocations: InvocationSources,
  packages: PackageSources,
): Promise<BoundReport> {
  const aOutput = invocations.aByHash.get(conclusion.evidence.aOutputHash) ?? null;
  const jOutput = invocations.jByHash.get(conclusion.evidence.jOutputHash) ?? null;
  let pkg: ResearchInputPackage | null = null;
  try {
    pkg = await packages.boundPackage(conclusion.businessKey, conclusion.evidence.manifestHash);
  } catch {
    pkg = null;
  }
  const checklist =
    aOutput === null
      ? null
      : checklistFor(
          aOutput,
          conclusion.evidence.manifestHash,
          conclusion.evidence.checklistHash,
          pkg === null ? null : coverageOfPackage(pkg),
        );
  let view: ReportView;
  try {
    view = buildReportView(conclusion, pkg, aOutput, checklist, jOutput);
  } catch {
    view = buildReportView(conclusion, null, aOutput, checklist, jOutput); // 包异常降级，其余如实
  }
  return { view, text: renderReportText(view) };
}

// ===== 请求处理 =====

export interface WebDeps {
  pool: Pool;
  store: ArtifactStore;
  poolInfo: PoolInfo;
  invocations: InvocationIndex;
  packages: PackageSources;
  /** 交易日历缓存（懒加载）。 */
  calendar: () => Promise<TradeCalendarTable>;
  now: () => Date;
}

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

function replyHtml(status: number, body: string): Reply {
  return { status, contentType: 'text/html; charset=utf-8', body };
}

function replyJson(status: number, value: unknown): Reply {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value, null, 2) };
}

// ===== /style.css（Metis 移植设计系统，进程内缓存一份）=====

let cssCache: string | null = null;

async function readStylesheet(): Promise<string> {
  if (cssCache !== null) return cssCache;
  cssCache = await readFile(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf8');
  return cssCache;
}

/** 周一（上海墙钟）零点 instant。 */
function mondayInstantOf(date: string): Date {
  const wall = shanghaiWall(shanghaiInstant(date, '00:00:00'));
  const offset = wall.weekday === 0 ? 6 : wall.weekday - 1;
  return shanghaiInstant(
    shanghaiWall(new Date(shanghaiInstant(date, '00:00:00').getTime() - offset * 86_400_000)).date,
    '00:00:00',
  );
}

async function handleHome(deps: WebDeps): Promise<Reply> {
  const now = deps.now();
  const wall = shanghaiWall(now);
  let status: Omit<SystemStatusData, 'p5Week'>;
  let latest: Map<string, LatestConclusionRow> = new Map();
  let events: EventPanelRow[] = [];
  let dbError: string | null = null;
  try {
    status = await fetchSystemStatus(deps.pool);
    latest = await fetchLatestConclusionsBySubject(deps.pool);
    events = await fetchEventPanel(deps.pool, shanghaiInstant(wall.date, '00:00:00'), mondayInstantOf(wall.date));
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
    status = {
      battery: 'RED',
      batteryBasis: 'DB 不可达，状态降级',
      factCount: 0,
      permitsTotal: 0,
      permitsByState: {},
      dbError,
    };
  }
  const statusData: SystemStatusData = { ...status, p5Week: p5WeekOf(now) };

  // 轮转预览（日历覆盖外如实呈现不可得）
  let rotation: HomeData['rotation'] = null;
  let rotationNote: string | null = null;
  try {
    const table = await deps.calendar();
    const night = nextRotationNight(table.tradingDays, { date: wall.date, time: wall.time });
    if ('error' in night) {
      rotationNote = `轮转预览不可得：${night.error}`;
    } else {
      const rotationTable = rotationTableFromPool({
        frozenAt: deps.poolInfo.frozenAt,
        stocks: deps.poolInfo.stocks,
        etfs: deps.poolInfo.etfs,
      });
      const names = new Map<string, string>([
        ...deps.poolInfo.stocks.map((s) => [s.code, s.name] as const),
        ...deps.poolInfo.etfs.map((e) => [e.code, e.name] as const),
      ]);
      rotation = {
        date: night.date,
        nth: night.nth,
        subjects: nightSubjects(rotationTable, night.nth).map((s) => ({
          code: s.subject,
          name: names.get(s.subject) ?? s.subject,
        })),
      };
    }
  } catch (error) {
    rotationNote = `轮转预览不可得：${error instanceof Error ? error.message : String(error)}`;
  }

  const cards = [
    ...deps.poolInfo.stocks.map((s) => ({ s, kind: 'STOCK' as const, industry: s.swL1Name })),
    ...deps.poolInfo.etfs.map((e) => ({ s: e, kind: 'BROAD_ETF' as const, industry: e.tracks })),
  ].map(({ s, kind, industry }) => {
    const row = latest.get(s.code);
    return {
      code: s.code,
      name: s.name,
      kind,
      industry,
      disposition: row?.disposition ?? null,
      settlementState: row?.settlement_state ?? null,
      lastResearchAt: row?.created_at.toISOString() ?? null,
    };
  });

  const data: HomeData = {
    nowShanghai: `${wall.date} ${wall.time} +08`,
    poolVersion: deps.poolInfo.version,
    poolFrozenAt: deps.poolInfo.frozenAt,
    status: statusData,
    cards,
    events,
    eventsTodayTotal: events.reduce((n, e) => n + e.today, 0),
    eventsWeekTotal: events.reduce((n, e) => n + e.week, 0),
    rotation,
    rotationNote,
  };
  return replyHtml(200, renderHomePage(data));
}

async function handleSubject(deps: WebDeps, code: string, selected: string | null, tab: SubjectTab): Promise<Reply> {
  const poolStock = deps.poolInfo.stocks.find((s) => s.code === code);
  const poolEtf = deps.poolInfo.etfs.find((e) => e.code === code);
  try {
    let kind: 'STOCK' | 'BROAD_ETF';
    let name: string;
    let industry: string | null;
    if (poolStock !== undefined) {
      kind = 'STOCK';
      name = poolStock.name;
      industry = poolStock.swL1Name;
    } else if (poolEtf !== undefined) {
      kind = 'BROAD_ETF';
      name = poolEtf.name;
      industry = poolEtf.tracks;
    } else {
      const kindRes = await deps.pool.query<{ subject_type: string }>(
        'select subject_type from pintime_fact where subject_id = $1 limit 1',
        [code],
      );
      kind = kindRes.rows[0]?.subject_type === 'ETF' ? 'BROAD_ETF' : 'STOCK';
      name = code;
      industry = null;
    }

    let ipoDate: string | null = null;
    let basicName: string | null = null;
    if (kind === 'STOCK') {
      const basic = await deps.pool.query<{ typed_value: unknown }>(
        `select typed_value from pintime_fact
         where subject_type = 'STOCK' and subject_id = $1 and fact_kind = 'STOCK_BASIC'
         order by available_at desc limit 1`,
        [code],
      );
      const v = basic.rows[0]?.typed_value as { ipoDate?: unknown; code_name?: unknown } | undefined;
      if (typeof v?.ipoDate === 'string') ipoDate = v.ipoDate;
      if (typeof v?.code_name === 'string' && poolStock === undefined) basicName = v.code_name;
    }

    let stStatus: string;
    if (kind === 'BROAD_ETF') {
      stStatus = 'N/A（ST 规则不适用 ETF）';
    } else {
      const st = await deps.pool.query<{ status: string; effective_from: string }>(
        `select status, effective_from from st_status_timeline
         where subject = $1 and effective_from <= current_date
           and (effective_to is null or effective_to > current_date)
         order by effective_from desc limit 1`,
        [code],
      );
      const row = st.rows[0];
      stStatus = row === undefined ? '时点表无行（未命中 ST 公告，按非 ST 呈现）' : `${row.status}（自 ${row.effective_from}）`;
    }

    const facts = await deps.pool.query<{ n: string }>(
      'select count(*)::text as n from pintime_fact where subject_id = $1',
      [code],
    );
    const conclusions = await fetchConclusionsOfSubject(deps.pool, code);

    // 报告读回（选定结论；缺省最新）
    const chosen =
      selected !== null
        ? (conclusions.find((c) => c.conclusionId === selected) ?? conclusions[0])
        : conclusions[0];
    let view: ReportView | null = null;
    let selectedId: string | null = chosen?.conclusionId ?? null;
    if (chosen !== undefined) {
      const conclusion = await readConclusion(deps.pool, chosen.conclusionId);
      if (conclusion !== null) {
        const sources = await deps.invocations.sourcesFor(
          [conclusion.evidence.aOutputHash],
          [conclusion.evidence.jOutputHash],
        );
        const bound = await buildBoundReport(conclusion, sources, deps.packages);
        view = bound.view;
      } else {
        selectedId = null;
      }
    }

    const data: SubjectPageData = {
      basic: {
        code,
        name: poolStock?.name ?? poolEtf?.name ?? basicName ?? code,
        kind,
        industry,
        ipoDate,
        stStatus,
        poolVersion: poolStock !== undefined || poolEtf !== undefined ? deps.poolInfo.version : '—（不在当前冻结池）',
        poolFrozenAt: poolStock !== undefined || poolEtf !== undefined ? deps.poolInfo.frozenAt : '—',
        factsCount: Number(facts.rows[0]?.n ?? 0),
      },
      conclusions,
      selectedConclusionId: selectedId,
      tab,
      view,
    };
    return replyHtml(200, renderSubjectHtml(data));
  } catch (error) {
    return replyHtml(
      503,
      renderErrorPage(503, `标的详情读回失败：${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

async function handleConclusions(deps: WebDeps, filters: ConclusionsFilters): Promise<Reply> {
  try {
    const { rows, total } = await fetchConclusionsPage(deps.pool, filters);
    return replyHtml(
      200,
      renderConclusionsHtml({
        rows,
        total,
        page: filters.page,
        pageSize: CONCLUSIONS_PAGE_SIZE,
        filters: { kind: filters.kind, disposition: filters.disposition, settlement: filters.settlement },
        poolVersion: deps.poolInfo.version,
      }),
    );
  } catch (error) {
    return replyHtml(
      503,
      renderErrorPage(503, `结论列表读回失败：${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

async function handleStatus(deps: WebDeps): Promise<Reply> {
  const now = deps.now();
  const wall = shanghaiWall(now);
  let system: Omit<SystemStatusData, 'p5Week'>;
  let recent: unknown[] = [];
  let events: EventPanelRow[] = [];
  let rotation: unknown = null;
  let error: string | null = null;
  try {
    system = await fetchSystemStatus(deps.pool);
    const recentRes = await deps.pool.query(
      `select conclusion_id, business_key->>'subject' as subject, business_key->>'subjectKind' as subject_kind,
         business_key->>'researchKind' as research_kind, disposition, settlement->>'state' as settlement_state, created_at
       from conclusion order by created_at desc limit 10`,
    );
    recent = recentRes.rows.map((r) => ({
      conclusionId: r.conclusion_id,
      subject: r.subject,
      subjectKind: r.subject_kind,
      researchKind: r.research_kind,
      disposition: r.disposition,
      settlementState: r.settlement_state,
      createdAt: r.created_at.toISOString(),
    }));
    events = await fetchEventPanel(deps.pool, shanghaiInstant(wall.date, '00:00:00'), mondayInstantOf(wall.date));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    system = {
      battery: 'RED',
      batteryBasis: 'DB 不可达，状态降级',
      factCount: 0,
      permitsTotal: 0,
      permitsByState: {},
      dbError: error,
    };
  }
  if (error === null) {
    try {
      const table = await deps.calendar();
      const night = nextRotationNight(table.tradingDays, { date: wall.date, time: wall.time });
      rotation =
        'error' in night
          ? { error: night.error }
          : {
              date: night.date,
              nth: night.nth,
              subjects: nightSubjects(
                rotationTableFromPool({
                  frozenAt: deps.poolInfo.frozenAt,
                  stocks: deps.poolInfo.stocks,
                  etfs: deps.poolInfo.etfs,
                }),
                night.nth,
              ).map((s) => ({ subjectKind: s.subjectKind, subject: s.subject })),
            };
    } catch (err) {
      rotation = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return replyJson(200, {
    ok: error === null && system.dbError === null,
    generatedAt: now.toISOString(),
    shanghaiWall: `${wall.date} ${wall.time}`,
    error,
    system: { ...system, p5Week: p5WeekOf(now) },
    pool: {
      version: deps.poolInfo.version,
      frozenAt: deps.poolInfo.frozenAt,
      stocks: deps.poolInfo.stocks.length,
      etfs: deps.poolInfo.etfs.length,
    },
    p5: { start: P5_START, week: p5WeekOf(now) },
    events: { today: events.reduce((n, e) => n + e.today, 0), thisWeek: events.reduce((n, e) => n + e.week, 0), byType: events },
    conclusions: { recent },
    nextRotation: rotation,
  });
}

/** 纯数据请求处理（无 res 依赖）：单测可注入假 deps 直接调用。 */
export async function handleRequest(deps: WebDeps, method: string, url: string): Promise<Reply> {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://127.0.0.1');
  } catch {
    return replyHtml(400, renderErrorPage(400, '请求 URL 不合法'));
  }
  const route = matchRoute(method, parsed.pathname);
  if (route === null) {
    if (parsed.pathname.startsWith('/api/')) {
      return replyJson(404, { error: 'not found', path: parsed.pathname });
    }
    return replyHtml(404, renderErrorPage(404, `未知路径：${parsed.pathname}`));
  }
  switch (route.name) {
    case 'home':
      return handleHome(deps);
    case 'style': {
      try {
        return { status: 200, contentType: 'text/css; charset=utf-8', body: await readStylesheet() };
      } catch (error) {
        return {
          status: 500,
          contentType: 'text/plain; charset=utf-8',
          body: `stylesheet read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    case 'subject': {
      const selectedRaw = parsed.searchParams.get('c');
      const selected = selectedRaw !== null && /^cc-[0-9a-zA-Z]{6,64}$/.test(selectedRaw) ? selectedRaw : null;
      return handleSubject(deps, route.code, selected, parseSubjectTab(parsed.searchParams.get('t')));
    }
    case 'conclusions': {
      const parsedFilters = parseConclusionsQuery(parsed.searchParams);
      if ('error' in parsedFilters) {
        return replyHtml(400, renderErrorPage(400, parsedFilters.error));
      }
      return handleConclusions(deps, parsedFilters.filters);
    }
    case 'status':
      return handleStatus(deps);
  }
}

// ===== HTTP 服务器 =====

export function createWebServer(deps: WebDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = req.url ?? '/';
    handleRequest(deps, req.method ?? 'GET', url)
      .then((reply) => {
        res.writeHead(reply.status, {
          'content-type': reply.contentType,
          'content-length': String(Buffer.byteLength(reply.body)),
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : reply.body);
        console.log(`[lyra-web] ${req.method ?? 'GET'} ${url} → ${String(reply.status)}（${String(Date.now() - started)}ms）`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderErrorPage(500, `内部错误：${message}`));
        } else {
          res.end();
        }
        console.error(`[lyra-web] ${req.method ?? 'GET'} ${url} → 500：${message}`);
      });
  });
}

// ===== CLI 入口 =====

const isMain =
  process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('web/server.ts');

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const poolInfoFile = process.env.LYRA_POOL_INFO_FILE ?? join(projectRoot, 'data', 'research-pool.json');
  const artifactsRoot = process.env.LYRA_ARTIFACTS_DIR ?? join(projectRoot, 'data', 'artifacts');
  const invocationsDir = process.env.LYRA_SOL_INVOCATIONS_DIR ?? join(projectRoot, 'var', 'sol-invocations');
  const port = Number(process.env.LYRA_WEB_PORT ?? 3456);

  const pool = createPool();
  const poolInfo = await loadPoolInfo(poolInfoFile);
  let calendarCache: { table: TradeCalendarTable; at: number } | null = null;
  const deps: WebDeps = {
    pool,
    store: new ArtifactStore(artifactsRoot),
    poolInfo,
    invocations: new InvocationIndex(invocationsDir),
    packages: new PackageSources(new ArtifactStore(artifactsRoot), artifactsRoot),
    calendar: async () => {
      if (calendarCache !== null && Date.now() - calendarCache.at < 3_600_000) return calendarCache.table;
      const table = await loadTradeCalendarTable(pool);
      calendarCache = { table, at: Date.now() };
      return table;
    },
    now: () => new Date(),
  };
  const server = createWebServer(deps);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[lyra-web] 本地看板已启动：http://127.0.0.1:${String(port)}（Ctrl+C 停止；只读，不写库）`);
  });
  const shutdown = (): void => {
    console.log('[lyra-web] 关闭中…');
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[lyra-web] FATAL ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
