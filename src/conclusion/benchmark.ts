/** 冻结基准身份：研究时解析一次，后续只消费该快照；不从当前池/回填事实补写旧身份。 */
import { canonicalSha256 } from '../canonical.js';
import type { ArtifactRef, SubjectKind, TimePointFact } from '../contracts.js';
import { SW_2014_EFFECTIVE, SW_2021_CLASSIFY_EFFECTIVE, SW2014_PREFIX_L1, SW2021_PREFIX_L1 } from '../adapters/sw.js';
import type { IndustryBenchmark } from '../settlement/excess.js';

export const BENCHMARK_MAPPING_VERSION = 'benchmark-mapping@1';
export interface FrozenBenchmark {
  schemaVersion: 1;
  subjectKind: SubjectKind;
  subject: string;
  cutoff: string;
  status: 'RESOLVED' | 'MISSING' | 'CURRENT_PROXY';
  indexCode: string | null;
  industry: IndustryBenchmark | null;
  attributionFact: TimePointFact | null;
  mapping: { version: string; contentHash: string; snapshot: Record<string, unknown> };
  reason: string | null;
  bindingHash: string;
}
export class BenchmarkError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'BenchmarkError'; }
}
export function benchmarkDay(cutoff: string | Date): string {
  const ms = new Date(cutoff).getTime();
  if (!Number.isFinite(ms)) throw new BenchmarkError('BENCHMARK_CUTOFF_INVALID', String(cutoff));
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
export function trackingIndexCode(tracks: string): string | null {
  const matches = [...tracks.matchAll(/\((\d{6})\)/g)];
  return matches.length === 1 && (tracks.match(/\d{6}/g)?.length ?? 0) === 1 ? matches[0]![1]! : null;
}

/** 与原结算窗口体系规则一致：行自带映射或跨体系前缀映射，不使用当前研究池。 */
export function selectIndustryBenchmark(facts: readonly TimePointFact[], subject: string, cutoff: string | Date, frozenPrefixMap?: Readonly<Record<string, string>>):
  { industry: IndustryBenchmark | null; fact: TimePointFact; system: 'pre2014' | '2014' | '2021' } | null {
  const at = new Date(cutoff).getTime();
  const day = benchmarkDay(cutoff);
  const system = day >= SW_2021_CLASSIFY_EFFECTIVE ? '2021' : day >= SW_2014_EFFECTIVE ? '2014' : 'pre2014';
  const candidates = facts.filter((f) => f.subjectType === 'STOCK' && f.subjectId === subject && f.factKind === 'INDUSTRY_CLASS_VERSION' &&
    Date.parse(f.availableAt) <= at && ['pre2014', '2014', '2021'].includes(String((f.typedValue as Record<string, unknown>).体系)) &&
    (f.validFrom === null || Date.parse(f.validFrom) <= at) && (f.validTo === null || at < Date.parse(f.validTo)));
  candidates.sort((a, b) => {
    const rank = Number((a.typedValue as Record<string, unknown>).体系 !== system) - Number((b.typedValue as Record<string, unknown>).体系 !== system);
    return rank || Date.parse(b.validFrom ?? b.availableAt) - Date.parse(a.validFrom ?? a.availableAt) || a.factId.localeCompare(b.factId);
  });
  const fact = candidates[0];
  if (fact === undefined) return null;
  if (system === 'pre2014') return { fact, system, industry: null };
  const v = fact.typedValue as Record<string, unknown>;
  const mintedSystem = String(v.体系);
  const industryCode = typeof v.行业代码 === 'string' ? v.行业代码 : '';
  const l1IndexCodeSource = mintedSystem === system ? 'ROW' : 'WINDOW_TABLE';
  const code = l1IndexCodeSource === 'ROW' ? v.l1IndexCode : (frozenPrefixMap ?? (system === '2021' ? SW2021_PREFIX_L1 : SW2014_PREFIX_L1))[industryCode.slice(0, 2)];
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { fact, system, industry: null };
  return { fact, system, industry: { subject, industryIndexCode: code, system, mintedSystem, industryCode, l1IndexCodeSource, factId: fact.factId } };
}

export interface EtfMappingSnapshot { frozenAt: string; tracks: string; observation?: ArtifactRef }
export function etfMappingContent(subject: string, config: Pick<EtfMappingSnapshot, 'frozenAt' | 'tracks'>) {
  return { kind: 'ETF_MAPPING_SOURCE', subject, frozenAt: config.frozenAt, tracks: config.tracks };
}
interface FreezeBenchmarkArgs {
  subjectKind: SubjectKind; subject: string; cutoff: string | Date; facts: readonly TimePointFact[];
  etfMapping?: EtfMappingSnapshot;
}
export function freezeBenchmark(args: FreezeBenchmarkArgs): FrozenBenchmark { return freeze(args); }
function freeze(args: FreezeBenchmarkArgs, frozenPrefixMap?: Readonly<Record<string, string>>): FrozenBenchmark {
  const cutoff = new Date(args.cutoff).toISOString();
  let industry: IndustryBenchmark | null = null;
  let attributionFact: TimePointFact | null = null;
  let indexCode: string | null = null;
  let reason: string | null = null;
  let status: FrozenBenchmark['status'] = 'MISSING';
  let snapshot: Record<string, unknown>;
  if (args.subjectKind === 'STOCK') {
    const found = selectIndustryBenchmark(args.facts, args.subject, cutoff, frozenPrefixMap);
    industry = found?.industry ?? null;
    attributionFact = found === null ? null : structuredClone(found.fact);
    indexCode = industry?.industryIndexCode ?? null;
    status = indexCode === null ? 'MISSING' : 'RESOLVED';
    reason = indexCode === null ? (found === null ? 'INDUSTRY_BENCHMARK_MISSING' : 'INDUSTRY_INDEX_MAPPING_MISSING') : null;
    snapshot = { kind: 'SW_WINDOW', system: found?.system ?? null,
      prefixMap: { ...(frozenPrefixMap ?? (found?.system === '2014' ? SW2014_PREFIX_L1 : SW2021_PREFIX_L1)) } };
  } else {
    const config = args.etfMapping;
    indexCode = config === undefined ? null : trackingIndexCode(config.tracks);
    const effective = config === undefined ? NaN : Date.parse(config.frozenAt.length === 10 ? `${config.frozenAt}T00:00:00+08:00` : config.frozenAt);
    const observed = config?.observation;
    const witnessed = config !== undefined && observed !== undefined &&
      observed.sha256 === canonicalSha256(etfMappingContent(args.subject, config)) &&
      Number.isFinite(Date.parse(observed.firstObservedAt)) && Date.parse(observed.firstObservedAt) <= Date.parse(cutoff);
    status = indexCode === null ? 'MISSING' : witnessed && Number.isFinite(effective) && effective <= Date.parse(cutoff) ? 'RESOLVED' : 'CURRENT_PROXY';
    reason = status === 'MISSING' ? 'ETF_TRACKING_MISSING' : status === 'CURRENT_PROXY' ? 'ETF_MAPPING_NOT_OBSERVED_AT_CUTOFF' : null;
    snapshot = { kind: 'OBSERVED_POOL_CONFIG', frozenAt: config?.frozenAt ?? null, tracks: config?.tracks ?? null,
      observation: observed === undefined ? null : structuredClone(observed) };
  }
  const core = { schemaVersion: 1 as const, subjectKind: args.subjectKind, subject: args.subject, cutoff, status, indexCode,
    industry, attributionFact, mapping: { version: BENCHMARK_MAPPING_VERSION, contentHash: canonicalSha256(snapshot), snapshot }, reason };
  return { ...core, bindingHash: canonicalSha256(core) };
}

/** 校验自身哈希、归属行内容/窗口映射，以及目标业务身份；不查询当前世界。 */
export function validateFrozenBenchmark(value: FrozenBenchmark | undefined, expected: { subjectKind: SubjectKind; subject: string; cutoff: string | Date }): FrozenBenchmark {
  if (value === undefined || value === null) throw new BenchmarkError('BENCHMARK_NOT_FROZEN', '旧对象无可核验基准身份，禁止事后解析');
  const { bindingHash, ...core } = value;
  if (value.schemaVersion !== 1 || value.subjectKind !== expected.subjectKind || value.subject !== expected.subject ||
      value.cutoff !== new Date(expected.cutoff).toISOString() || canonicalSha256(core) !== bindingHash ||
      value.mapping?.version !== BENCHMARK_MAPPING_VERSION || canonicalSha256(value.mapping.snapshot) !== value.mapping.contentHash) {
    throw new BenchmarkError('BENCHMARK_BINDING_MISMATCH', '基准哈希/映射/业务键不符');
  }
  const snap = value.mapping.snapshot;
  const prefixMap = snap.prefixMap as Record<string, string> | undefined;
  if (expected.subjectKind === 'STOCK' && (prefixMap === undefined || typeof prefixMap !== 'object' || prefixMap === null ||
      Object.entries(prefixMap).some(([k, v]) => !/^\d{2}$/.test(k) || typeof v !== 'string' || !/^\d{6}$/.test(v)))) {
    throw new BenchmarkError('BENCHMARK_MAPPING_MISMATCH', '冻结前缀映射无效');
  }
  // 按保存的映射快照复核，不把后来代码表套到旧身份上。
  const rebuilt = freeze({ ...expected, facts: value.attributionFact === null ? [] : [value.attributionFact],
    ...(expected.subjectKind === 'BROAD_ETF' && typeof snap.tracks === 'string' && typeof snap.frozenAt === 'string'
      ? { etfMapping: { tracks: snap.tracks, frozenAt: snap.frozenAt,
          ...(snap.observation === null || snap.observation === undefined ? {} : { observation: snap.observation as ArtifactRef }) } } : {}) }, prefixMap);
  if (rebuilt.bindingHash !== bindingHash) throw new BenchmarkError('BENCHMARK_MAPPING_MISMATCH', '冻结归属原文与基准映射不一致');
  return value;
}

export function requireResolvedBenchmark(value: FrozenBenchmark | undefined, expected: { subjectKind: SubjectKind; subject: string; cutoff: string | Date }): FrozenBenchmark {
  const result = validateFrozenBenchmark(value, expected);
  if (result.status !== 'RESOLVED' || result.indexCode === null) throw new BenchmarkError(result.reason ?? 'BENCHMARK_UNRESOLVED', '缺历史基准或当前代理，不能用于正式结算');
  return result;
}
