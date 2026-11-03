import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalSha256 } from '../../canonical.js';
import type { FrozenA, FrozenJ, FrozenPlan, Issue, StrategyData, StrategyRules } from './contracts.js';
import { assertData } from './data.js';
import { StrategyError } from './money.js';
import { assertRules, freezePlan } from './plan.js';
import { fileStrategyStore, type RealClientManifest, type RealStrategyStore } from './real-store.js';
import { replayFrozenPlan, validateHistory } from './replay.js';
import { reviewFrozenPlan } from './review.js';
import type { L2WorkbenchResult } from './workbench-contracts.js';

export interface WorkbenchFilePin { path: string; sha256: string }
interface RequestBase { schema: 'lyra-l2-workbench-request-v1'; createdAt: string }
export interface StrictWorkbenchRequest extends RequestBase {
  mode: 'STRICT_REPLAY';
  data: WorkbenchFilePin;
  rules: WorkbenchFilePin;
  companyReport: { file: WorkbenchFilePin; reference: FrozenPlan['companyReport'] };
  signalDate: string;
  simulationWindow: { from: string; to: string };
  a?: WorkbenchFilePin | null;
  j?: WorkbenchFilePin | null;
}
export interface ReadinessWorkbenchRequest extends RequestBase {
  mode: 'REAL_READINESS';
  manifest: WorkbenchFilePin;
}
export type WorkbenchRequest = StrictWorkbenchRequest | ReadinessWorkbenchRequest;
export interface WorkbenchSource {
  id: string; path: string; sha256: string;
  mediaType: 'application/json' | 'text/html'; label: string;
}
export interface WorkbenchManifest {
  schema: 'lyra-l2-workbench-manifest-v1';
  requestId: 'request'; resultId: 'result'; sources: WorkbenchSource[];
}
export const workbenchSha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const workbenchJson = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function assertWorkbenchPin(pin: string): void {
  if (typeof pin !== 'string' || !/^[a-f0-9]{64}$/.test(pin)) throw new StrategyError('WORKBENCH_PIN_REQUIRED');
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}
function filePin(value: WorkbenchFilePin): void {
  if (!value || typeof value.path !== 'string' || !value.path || value.path.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value.path)) throw new StrategyError('WORKBENCH_FILE_REFERENCE_INVALID');
  assertWorkbenchPin(value.sha256);
}
export function parseWorkbenchRequest(bytes: Buffer): WorkbenchRequest {
  const r = JSON.parse(bytes.toString('utf8')) as WorkbenchRequest;
  if (!r || r.schema !== 'lyra-l2-workbench-request-v1' || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt)) || new Date(r.createdAt).toISOString() !== r.createdAt) throw new StrategyError('WORKBENCH_REQUEST_INVALID');
  const allowed = r.mode === 'REAL_READINESS' ? ['schema', 'mode', 'createdAt', 'manifest']
    : ['schema', 'mode', 'createdAt', 'data', 'rules', 'companyReport', 'signalDate', 'simulationWindow', 'a', 'j'];
  if (Object.keys(r).some((key) => !allowed.includes(key))) throw new StrategyError('WORKBENCH_REQUEST_FIELD_UNSUPPORTED');
  if (r.mode === 'REAL_READINESS') filePin(r.manifest);
  else if (r.mode === 'STRICT_REPLAY') {
    filePin(r.data); filePin(r.rules); filePin(r.companyReport?.file);
    const company = r.companyReport.reference;
    if (!company || typeof company.path !== 'string' || !company.path || typeof company.acceptedBoundary !== 'string' || !company.acceptedBoundary.trim() || company.sha256 !== r.companyReport.file.sha256) throw new StrategyError('WORKBENCH_COMPANY_REFERENCE_INVALID');
    if (!isDate(r.signalDate) || !isDate(r.simulationWindow?.from) || !isDate(r.simulationWindow?.to) || r.simulationWindow.from > r.simulationWindow.to || r.simulationWindow.from <= r.signalDate) throw new StrategyError('WORKBENCH_SIMULATION_WINDOW_INVALID');
    if (r.a != null) filePin(r.a);
    if (r.j != null) filePin(r.j);
  } else throw new StrategyError('WORKBENCH_REQUEST_MODE_INVALID');
  return r;
}

export function assertWorkbenchRelativePath(path: string): void {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((s) => !s || s === '.' || s === '..')) throw new StrategyError('WORKBENCH_SOURCE_PATH_INVALID');
}
function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
/** All consumer paths are package-relative, including paths in a nested real manifest. */
export async function readWorkbenchPackageFile(root: string, path: string): Promise<Buffer> {
  assertWorkbenchRelativePath(path);
  const physicalRoot = await realpath(root), target = await realpath(resolve(root, path));
  if (!inside(physicalRoot, target) || !(await stat(target)).isFile()) throw new StrategyError('WORKBENCH_SOURCE_LINK_ESCAPE', path);
  return readFile(target);
}
export function strictWorkbenchInputs(request: StrictWorkbenchRequest): { id: string; pin: WorkbenchFilePin; mediaType: WorkbenchSource['mediaType']; label: string }[] {
  return [
    { id: 'data', pin: request.data, mediaType: 'application/json', label: '冻结输入与原时间字段' },
    { id: 'rules', pin: request.rules, mediaType: 'application/json', label: '冻结规则、费用、三轴版本与样本窗' },
    { id: 'company-report', pin: request.companyReport.file, mediaType: 'text/html', label: '公司报告原件与原接受边界' },
    ...(request.a ? [{ id: 'a', pin: request.a, mediaType: 'application/json' as const, label: 'STATIC_SIMULATED_FIXTURE A' }] : []),
    ...(request.j ? [{ id: 'j', pin: request.j, mediaType: 'application/json' as const, label: 'STATIC_SIMULATED_FIXTURE J' }] : []),
  ];
}
export function strictWorkbenchResult(request: StrictWorkbenchRequest, requestSha256: string, inputs: ReadonlyMap<string, Buffer>): L2WorkbenchResult {
  const json = <T>(id: string): T => JSON.parse(inputs.get(id)!.toString('utf8')) as T;
  const data = json<StrategyData>('data'), rules = json<StrategyRules>('rules');
  assertData(data); assertRules(rules);
  if (workbenchSha256(inputs.get('company-report')!) !== request.companyReport.reference.sha256) throw new StrategyError('WORKBENCH_COMPANY_SOURCE_MISMATCH');
  const validation = validateHistory(data, rules), plan = freezePlan(data, rules, request.signalDate, request.companyReport.reference);
  const review = reviewFrozenPlan(plan, data, validation, request.a ? json<FrozenA>('a') : null, request.j ? json<FrozenJ>('j') : null);
  const simulation = replayFrozenPlan(data, plan, review, request.simulationWindow);
  const blockers: Issue[] = [
    ...((plan.snapshot.decision === 'DATA_PENDING' || plan.snapshot.decision === 'TECHNICAL_FAILURE') ? plan.snapshot.issues : []),
    ...(validation.status === 'INCOMPLETE' ? [...validation.inSample.issues, ...validation.outOfSample.issues] : []),
    ...review.gate.blockers.map((code) => ({ code, date: null, detail: '冻结离线复核门仍阻断；不代表真实模型复核' })),
    ...(!['COMPUTED_SYNTHETIC', 'COMPUTED_HISTORICAL'].includes(simulation.status) ? simulation.issues : []),
  ];
  const core = {
    schema: 'lyra-l2-workbench-result-v1' as const, status: 'COMPUTED_OFFLINE' as const,
    subject: data.subject, subjectName: data.subjectName, createdAt: request.createdAt, inputIdentity: data.identity,
    binding: { requestSha256, dataHash: canonicalSha256(data), rulesHash: rules.rulesHash, baseManifestSha256: null },
    account: data.account, blockers, plan, validation, review, simulation,
    realReviewDone: false as const, executionEligible: false as const, efficacyAccepted: false as const,
  };
  return { ...core, resultHash: canonicalSha256(core) };
}
export function readinessWorkbenchResult(request: ReadinessWorkbenchRequest, requestSha256: string, loaded: Awaited<ReturnType<RealStrategyStore['load']>>): L2WorkbenchResult {
  const { data, view, manifestSha256 } = loaded;
  if (manifestSha256 !== request.manifest.sha256) throw new StrategyError('WORKBENCH_REAL_MANIFEST_BINDING_INVALID');
  const core = {
    schema: 'lyra-l2-workbench-result-v1' as const, status: 'INPUT_BLOCKED' as const,
    subject: data.subject, subjectName: data.subjectName, createdAt: request.createdAt, inputIdentity: 'REAL_PUBLIC_DATA' as const,
    binding: { requestSha256, dataHash: data.dataHash, rulesHash: view.rulesHash, baseManifestSha256: manifestSha256 },
    account: null, blockers: [
      ...view.blockers.map((i) => ({ ...i, date: null })),
      ...view.coverage.flatMap((c) => c.missingDates.map((date) => ({ code: 'REAL_SERIES_DATE_MISSING', date, detail: `${c.subject}; observed=${c.observed}; expected=${c.expected}` }))),
    ],
    plan: null, validation: null, review: null, simulation: null,
    realReviewDone: false as const, executionEligible: false as const, efficacyAccepted: false as const,
  };
  return { ...core, resultHash: canonicalSha256(core) };
}

/** The original real manifest and every source remain a byte-for-byte nested package. */
export function realWorkbenchSources(bytes: Buffer): RealClientManifest {
  const m = JSON.parse(bytes.toString('utf8')) as RealClientManifest;
  if (!m || m.schema !== 'lyra-real-strategy-client-manifest-v1' || !Array.isArray(m.sources) || new Set(m.sources.map((s) => s.id)).size !== m.sources.length) throw new StrategyError('WORKBENCH_REAL_MANIFEST_INVALID');
  for (const s of m.sources) {
    assertWorkbenchRelativePath(s.path); assertWorkbenchPin(s.sha256);
    if (!/^[a-z0-9-]+$/.test(s.id) || !['application/json', 'text/html'].includes(s.mediaType) || typeof s.label !== 'string') throw new StrategyError('WORKBENCH_REAL_SOURCE_INVALID');
  }
  return m;
}

export async function writeWorkbench(requestPath: string, expectedRequestSha256: string, outputDirectory: string) {
  assertWorkbenchPin(expectedRequestSha256);
  const requestBytes = await readFile(requestPath);
  if (workbenchSha256(requestBytes) !== expectedRequestSha256) throw new StrategyError('WORKBENCH_REQUEST_HASH_MISMATCH');
  const request = parseWorkbenchRequest(requestBytes), requestRoot = dirname(resolve(requestPath));
  const sources: WorkbenchSource[] = [], files = new Map<string, Buffer>();
  const add = (id: string, path: string, bytes: Buffer, mediaType: WorkbenchSource['mediaType'], label: string): void => {
    assertWorkbenchRelativePath(path);
    if (sources.some((s) => s.id === id || s.path === path)) throw new StrategyError('WORKBENCH_ARTIFACT_COLLISION', path);
    sources.push({ id, path, sha256: workbenchSha256(bytes), mediaType, label }); files.set(path, bytes);
  };
  add('request', 'request.json', requestBytes, 'application/json', '显式冻结请求');
  let result: L2WorkbenchResult;
  if (request.mode === 'STRICT_REPLAY') {
    const inputs = new Map<string, Buffer>();
    for (const s of strictWorkbenchInputs(request)) {
      const bytes = await readFile(resolve(requestRoot, s.pin.path));
      if (workbenchSha256(bytes) !== s.pin.sha256) throw new StrategyError('WORKBENCH_INPUT_HASH_MISMATCH', s.id);
      inputs.set(s.id, bytes);
      add(s.id, `inputs/${s.id}.${s.mediaType === 'text/html' ? 'html' : 'json'}`, bytes, s.mediaType, s.label);
    }
    result = strictWorkbenchResult(request, expectedRequestSha256, inputs);
    if (result.status === 'COMPUTED_OFFLINE') for (const id of ['plan', 'validation', 'review', 'simulation'] as const) add(id, `${id}.json`, workbenchJson(result[id]), 'application/json', `离线${id}原件`);
  } else {
    const manifestPath = resolve(requestRoot, request.manifest.path), bytes = await readFile(manifestPath);
    if (workbenchSha256(bytes) !== request.manifest.sha256) throw new StrategyError('WORKBENCH_INPUT_HASH_MISMATCH', 'real-manifest');
    const m = realWorkbenchSources(bytes);
    add('real-manifest', 'inputs/real/client-manifest.json', bytes, 'application/json', '原真实资料manifest（未刷新）');
    for (const s of m.sources) {
      const original = await readWorkbenchPackageFile(dirname(manifestPath), s.path);
      if (workbenchSha256(original) !== s.sha256) throw new StrategyError('WORKBENCH_INPUT_HASH_MISMATCH', s.id);
      add(`real-${s.id}`, `inputs/real/${s.path}`, original, s.mediaType, s.label);
    }
    result = readinessWorkbenchResult(request, expectedRequestSha256, await fileStrategyStore(manifestPath, request.manifest.sha256).load());
  }
  add('result', 'result.json', workbenchJson(result), 'application/json', 'L2工作区结果（非真实执行许可）');
  const manifest: WorkbenchManifest = { schema: 'lyra-l2-workbench-manifest-v1', requestId: 'request', resultId: 'result', sources };
  const manifestBytes = workbenchJson(manifest);
  files.set('manifest.json', manifestBytes);
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  // Preflight the entire package before creating any artifact. A conflict never overwrites it.
  for (const [path, bytes] of files) {
    try {
      const old = await readWorkbenchPackageFile(out, path);
      if (!old.equals(bytes)) throw new StrategyError('WORKBENCH_IMMUTABLE_CONFLICT', path);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  for (const [path, bytes] of files) {
    const physicalRoot = await realpath(out);
    let directory = out;
    for (const part of path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      if (!inside(physicalRoot, await realpath(directory))) throw new StrategyError('WORKBENCH_OUTPUT_LINK_ESCAPE', path);
    }
    try { await writeFile(join(out, path), bytes, { flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readWorkbenchPackageFile(out, path)).equals(bytes)) throw e;
    }
  }
  return { outputDirectory: out, manifestPath: join(out, 'manifest.json'), manifestSha256: workbenchSha256(manifestBytes), requestSha256: expectedRequestSha256,
    resultHash: result.resultHash, status: result.status, inputIdentity: result.inputIdentity,
    modelCalls: 0, databaseReads: 0, databaseWrites: 0, collections: 0, realReviewDone: false, executionEligible: false, efficacyAccepted: false };
}
