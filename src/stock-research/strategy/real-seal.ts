/** 本次真实文件封存入口：只读已取得原件，所有新增文件在本次delivery内，零网络/数据库。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalSha256 } from '../../canonical.js';
import type { StrategyRules } from './contracts.js';
import { freezeRules } from './plan.js';
import { assertRealDataset, buildRealStrategyView, type RealDailyDataset, type RealObservation, type RealSource } from './real-research.js';
import type { RealClientManifest } from './real-store.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const REAL_DATA_ROOT = join(ROOT, 'delivery/CODEX-STRATEGY-CLIENT-20261029/data');
type DbRow = { fact_id: string; subject_id: string; fact_kind: string; typed_value: Record<string, unknown>; first_observed_at: string; source_published_at: string | null; available_at: string; artifact_sha256: string };
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const text = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const iso = (v: string): string => new Date(v).toISOString();

export async function sealRealStrategyFiles() {
  const sources: RealSource[] = [];
  const read = async <T>(id: string, path: string, label: string): Promise<T> => {
    const bytes = await readFile(join(REAL_DATA_ROOT, path));
    sources.push({ id, path, sha256: sha(bytes), label, mediaType: 'application/json', confirmedAt: new Date().toISOString() });
    return JSON.parse(bytes.toString('utf8')) as T;
  };
  const stock = await read<{ rows: DbRow[] }>('stock-db', 'db-stock-export.json', '现有库只读导出：海控日线/因子/行业原事实与原时间字段');
  const benchmarks = await read<{ rows: DbRow[] }>('benchmarks-db', 'db-benchmark-export.json', '现有库只读导出：沪深300与申万交通运输完整原事实');
  const calendar = await read<{ rows: DbRow[] }>('calendar-db', 'db-calendar-export.json', '现有库只读导出：交易日与非交易日日历');
  const acquisition = JSON.parse(await readFile(join(REAL_DATA_ROOT, 'acquisition-plan.json'), 'utf8')) as { requests: [string, string][]; inSample: [string, string]; outOfSample: [string, string] };
  const rows: RealObservation[] = [];
  const from = '2021-10-01', to = '2026-10-23';
  const legacyObservation = (r: DbRow, sourceId: string, sourceRow: number): RealObservation => {
    const v = r.typed_value, at = sources.find((s) => s.id === sourceId)!.confirmedAt;
    return { subject: r.subject_id, date: text(v.date ?? v['日期']), open: text(v.open ?? v['开盘']), high: text(v.high ?? v['最高']), low: text(v.low ?? v['最低']), close: text(v.close ?? v['收盘']), volume: v.volume === undefined && v['成交量'] === undefined ? null : text(v.volume ?? v['成交量']), priceBasis: 'RAW', sourceId, sourceRow, factId: r.fact_id,
      sourcePublishedAt: r.source_published_at === null ? null : iso(r.source_published_at), sourcePublishedAtBasis: r.source_published_at === null ? 'UNREPORTED' : 'LEGACY_RECORDED_VALUE_NOT_INDEPENDENTLY_VERIFIED', firstObservedAt: iso(r.first_observed_at), recordedAt: at, availableAt: at, legacyAvailableAt: iso(r.available_at) };
  };
  stock.rows.forEach((r, i) => { if (r.fact_kind === 'DAILY_BAR') rows.push(legacyObservation(r, 'stock-db', i)); });
  benchmarks.rows.forEach((r, i) => rows.push(legacyObservation(r, 'benchmarks-db', i)));
  for (const [start, end] of acquisition.requests) {
    const name = `baostock-601919-${start}-${end}.json`, id = `stock-${start.slice(0, 4)}-${start.slice(5, 7)}-${start.slice(8)}`;
    const receipt = JSON.parse(await readFile(join(REAL_DATA_ROOT, `${name}.receipt.json`), 'utf8')) as { sha256: string; firstObservedAt: string; recordedAt: string; availableAt: string; sourcePublishedAt: null; ok: boolean };
    const response = await read<{ ok: boolean; rows: Record<string, unknown>[] }>(id, name, `BaoStock公开补数 ${start} → ${end}（原始响应）`);
    if (!receipt.ok || !response.ok || sources.at(-1)!.sha256 !== receipt.sha256) throw new Error(`PUBLIC_RESPONSE_RECEIPT_MISMATCH:${id}`);
    response.rows.forEach((v, i) => rows.push({ subject: '601919', date: text(v.date), open: text(v.open), high: text(v.high), low: text(v.low), close: text(v.close), volume: text(v.volume), priceBasis: 'RAW', sourceId: id, sourceRow: i, factId: null, sourcePublishedAt: null, sourcePublishedAtBasis: 'UNREPORTED', firstObservedAt: receipt.firstObservedAt, recordedAt: receipt.recordedAt, availableAt: receipt.availableAt, legacyAvailableAt: null }));
    await read(`${id}-receipt`, `${name}.receipt.json`, `补数来源/请求/实际时间与哈希 ${start} → ${end}`);
  }
  const company = JSON.parse(await readFile(join(ROOT, 'delivery/CODEX-DAILY-STRATEGY-20261029/frozen/company-report-ref.json'), 'utf8')) as { path: string; sha256: string };
  const report = await readFile(join(ROOT, company.path));
  if (sha(report) !== company.sha256) throw new Error('ACCEPTED_COMPANY_REPORT_HASH_MISMATCH');
  await writeFile(join(REAL_DATA_ROOT, 'company-report.html'), report, { flag: 'wx' });
  sources.push({ id: 'company-report', path: 'company-report.html', sha256: company.sha256, label: '海控已封存公司研究HTML（引用/源码/PDF接受边界保留，视觉待确认）', mediaType: 'text/html', confirmedAt: new Date().toISOString() });
  const oldRules = JSON.parse(await readFile(join(ROOT, 'delivery/CODEX-DAILY-STRATEGY-20261029/frozen/rules.json'), 'utf8')) as StrategyRules;
  const { rulesHash: _, ...ruleCore } = oldRules;
  const rules = freezeRules({ ...ruleCore, frozenAt: new Date().toISOString(), dataContractVersion: 'real-retrospective-file@v1', planAuthVersion: 'strategy-client-readonly-no-model@v1', selectionReason: '数值参数完全沿用R2未经效力验证假设，未搜索参数；真实IS/OOS按采集前固定自然年边界，仅资料覆盖，不签历史执行或有效性。', inSample: { from: acquisition.inSample[0], to: acquisition.inSample[1] }, outOfSample: { from: acquisition.outOfSample[0], to: acquisition.outOfSample[1] } });
  await writeFile(join(REAL_DATA_ROOT, 'research-rules.json'), JSON.stringify(rules, null, 2)+'\n', { flag: 'wx' });
  await read('research-rules', 'research-rules.json', '真实条件研究规则与成本假设（未调数值参数、未验证效力）');
  const core = {
    schema: 'lyra-real-daily-dataset-v1' as const, identity: 'REAL_PUBLIC_DATA' as const, mode: 'LATEST_REVISED' as const, subject: '601919' as const, subjectName: '中远海控', marketBenchmark: '000300' as const, industryBenchmark: '801170' as const,
    industryBasis: '采用已有申万2021分类事实所述交通运输801170；分类为后来取得的版本，不冒称完整历史当时行业/成分可得证据。',
    knowledgeCutoff: sources.map((s) => s.confirmedAt).sort().at(-1)!, marketDate: to, researchWindow: { from: '2022-01-01', to },
    calendar: { from, to, sourceId: 'calendar-db', days: calendar.rows.map((r) => ({ date: text(r.typed_value.calendar_date), trading: r.typed_value.is_trading_day === '1' })).filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date)) },
    bars: rows.filter((r) => r.date >= from && r.date <= to).sort((a, b) => a.subject.localeCompare(b.subject) || a.date.localeCompare(b.date)),
    factors: stock.rows.filter((r) => r.fact_kind === 'ADJUST_FACTOR').map((r) => ({ effectiveOn: text(r.typed_value.dividOperateDate), backwardFactor: text(r.typed_value.backAdjustFactor), firstObservedAt: iso(r.first_observed_at), sourcePublishedAt: r.source_published_at === null ? null : iso(r.source_published_at), legacyAvailableAt: iso(r.available_at), sourceId: 'stock-db', factId: r.fact_id })),
    sources, companyReportSourceId: 'company-report', rules,
  };
  const data: RealDailyDataset = { ...core, dataHash: canonicalSha256(core) };
  assertRealDataset(data);
  await writeFile(join(REAL_DATA_ROOT, 'real-dataset.json'), JSON.stringify(data, null, 2)+'\n', { flag: 'wx' });
  const view = buildRealStrategyView(data, new Date().toISOString());
  await writeFile(join(REAL_DATA_ROOT, 'research-view.json'), JSON.stringify(view, null, 2)+'\n', { flag: 'wx' });
  const files = sources.map(({ id, path, sha256, mediaType, label }) => ({ id, path, sha256, mediaType, label }));
  for (const [id, path, label] of [['dataset', 'real-dataset.json', '规范化真实回溯行情/原始时间/来源'], ['research', 'research-view.json', '同一真实输入驱动的条件草案/验证阻断']] as const) files.push({ id, path, label, sha256: sha(await readFile(join(REAL_DATA_ROOT, path))), mediaType: 'application/json' });
  const manifest: RealClientManifest = { schema: 'lyra-real-strategy-client-manifest-v1', datasetId: 'dataset', researchId: 'research', sources: files };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2)+'\n');
  await writeFile(join(REAL_DATA_ROOT, 'client-manifest.json'), manifestBytes, { flag: 'wx' });
  const receipt = { manifest: 'data/client-manifest.json', manifestSha256: sha(manifestBytes), dataHash: data.dataHash, viewHash: view.viewHash, rulesHash: rules.rulesHash, marketDate: data.marketDate, mode: data.mode, coverage: view.coverage, validation: view.validation.status, review: view.review, firstObservedAtRange: { min: rows.map((r) => r.firstObservedAt).sort()[0], max: rows.map((r) => r.firstObservedAt).sort().at(-1) }, actualFileConfirmationCutoff: data.knowledgeCutoff, materializedAt: view.materializedAt };
  await writeFile(join(REAL_DATA_ROOT, 'seal-receipt.json'), JSON.stringify(receipt, null, 2)+'\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.stdout.write(JSON.stringify(await sealRealStrategyFiles(), null, 2)+'\n');
