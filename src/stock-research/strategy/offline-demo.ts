import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalSha256 } from '../../canonical.js';
import type { FrozenA, FrozenJ, FrozenPlan, StrategyData, StrategyRules } from './contracts.js';
import { auditSealedEvidence } from './audit.js';
import { assertData } from './data.js';
import { assertRules, freezePlan } from './plan.js';
import { replayFrozenPlan, validateHistory } from './replay.js';
import { reviewFrozenPlan } from './review.js';
import { renderCompanyBridge, renderEvents, renderRealAudit, renderStrategy, renderValidation } from './render.js';
import { scenarioCases } from './scenarios.js';
import { StrategyError } from './money.js';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DELIVERY_ROOT = join(PROJECT_ROOT, 'delivery/CODEX-DAILY-STRATEGY-20261029');
export const FROZEN_ROOT = join(DELIVERY_ROOT, 'frozen');
const REAL_EVIDENCE = 'delivery/CODEX-COSCO-CODEX-TAIL-20261028/real/tasks/0fa4f98b-f159-43c3-a06f-6eb4745b23a3/evidence.json';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function loadFrozenInputs(dir = FROZEN_ROOT) {
  const load = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(dir, name), 'utf8')) as T;
  const data = await load<StrategyData>('data.json'), rules = await load<StrategyRules>('rules.json');
  assertRules(rules); assertData(data);
  return { data, rules, company: await load<FrozenPlan['companyReport']>('company-report-ref.json'), a: await load<FrozenA>('a.json'), j: await load<FrozenJ>('j.json'),
    rejectedJ: await load<FrozenJ>('j-rejected.json'), unresolvedJ: await load<FrozenJ>('j-unresolved.json'), waitA: await load<FrozenA>('wait-a.json'), waitJ: await load<FrozenJ>('wait-j.json') };
}

export async function computeOfflineBundle() {
  const inputs = await loadFrozenInputs();
  const { data, rules, company, a, j, rejectedJ, unresolvedJ, waitA, waitJ } = inputs;
  const originalReport = await readFile(join(PROJECT_ROOT, company.path));
  if (sha(originalReport) !== company.sha256) throw new StrategyError('COMPANY_REPORT_SOURCE_CHANGED');
  const validation = validateHistory(data, rules);
  const plan = freezePlan(data, rules, data.calendar.sessions[40]!.date, company);
  const review = reviewFrozenPlan(plan, data, validation, a, j);
  const waitPlan = freezePlan(data, rules, data.calendar.sessions[44]!.date, company);
  const waitReview = reviewFrozenPlan(waitPlan, data, validation, waitA, waitJ);
  if (!review.gate.passed || !waitReview.gate.passed) throw new StrategyError('FROZEN_FIXTURES_NO_LONGER_MATCH', JSON.stringify({ main: review.gate.blockers, wait: waitReview.gate.blockers }));
  const forward = replayFrozenPlan(data, plan, review, { from: data.calendar.sessions[41]!.date, to: data.calendar.sessions[50]!.date });
  const cases = scenarioCases(data, rules, plan, validation, review, a, rejectedJ, unresolvedJ, waitPlan, waitReview);
  const audit = auditSealedEvidence(await readFile(join(PROJECT_ROOT, REAL_EVIDENCE)), REAL_EVIDENCE);
  return { inputs, originalReport, validation, plan, review, waitPlan, waitReview, forward, cases, audit };
}

function inside(parent: string, path: string): boolean { const r = relative(parent, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); }

/** 结果不可变；同内容可复用，异内容必须用新目录，不覆盖旧候选。 */
export async function writeOfflineArtifacts(outputDir: string) {
  const out = resolve(outputDir);
  if (!inside(DELIVERY_ROOT, out) && !inside(tmpdir(), out)) throw new StrategyError('OUTPUT_OUTSIDE_ASSIGNMENT');
  const b = await computeOfflineBundle();
  const files = new Map<string, string | Uint8Array>();
  const json = (name: string, value: unknown): void => { files.set(name, `${JSON.stringify(value, null, 2)}\n`); };
  json('inputs.json', b.inputs.data); json('rules.json', b.inputs.rules); json('a.json', b.inputs.a); json('j.json', b.inputs.j);
  json('plan.json', b.plan); json('review.json', b.review); json('validation.json', b.validation); json('simulation.json', b.forward); json('case-results.json', b.cases); json('real-data-audit.json', b.audit);
  json('wait-plan.json', b.waitPlan); json('wait-review.json', b.waitReview);
  files.set('index.html', renderStrategy(b.plan, b.review, b.validation, b.forward));
  files.set('validation.html', renderValidation(b.validation, b.inputs.rules));
  files.set('events.html', renderEvents(b.plan, b.forward, b.cases));
  files.set('real-data-audit.html', renderRealAudit(b.audit));
  files.set('company-report.html', renderCompanyBridge(b.plan));
  files.set('original-report.html', b.originalReport);
  const sourcePaths = (await readdir(dirname(fileURLToPath(import.meta.url)))).filter((n) => n.endsWith('.ts')).sort();
  const sources = [];
  for (const path of sourcePaths) sources.push({ path: `src/stock-research/strategy/${path}`, sha256: sha(await readFile(join(dirname(fileURLToPath(import.meta.url)), path))) });
  json('run-receipt.json', { identity: 'DETERMINISTIC_OFFLINE_REPLAY_RECEIPT', inputRulesFrozenAt: b.inputs.rules.frozenAt, strategySourceCandidate: canonicalSha256(sources), sources,
    dataHash: canonicalSha256(b.inputs.data), rulesHash: b.inputs.rules.rulesHash, planId: b.plan.planId, planHash: b.plan.planHash, validationHash: b.validation.validationHash, reviewHash: b.review.reviewHash,
    inputArtifacts: { a: b.inputs.a.artifactHash, j: b.inputs.j.artifactHash }, modelExecution: b.review.modelExecution, databaseReads: 0, databaseWrites: 0, collections: 0, actualOperations: [],
    resultHashes: { validation: canonicalSha256(b.validation), simulation: canonicalSha256(b.forward), cases: canonicalSha256(b.cases) }, realHistory: b.audit.status, efficacyAccepted: false,
    boundaries: ['SOURCE_AND_OFFLINE_PATH_ONLY', 'NO_INSTALL_OR_SERVICE', 'NO_REAL_MODEL_REVIEW', 'OWNER_HTML_VISUAL_PENDING'] });
  await mkdir(out, { recursive: true });
  for (const [name, bytes] of files) {
    const path = join(out, name), buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    try {
      const old = await readFile(path);
      if (!old.equals(buffer)) throw new StrategyError('IMMUTABLE_ARTIFACT_CONFLICT', name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await writeFile(path, buffer, { flag: 'wx' });
    }
  }
  return { output: out, artifacts: [...files.entries()].map(([path, bytes]) => ({ path, sha256: sha(bytes) })), planId: b.plan.planId, planHash: b.plan.planHash, validation: b.validation.status, review: b.review.publication, efficacyAccepted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--out')) throw new StrategyError('USAGE', 'node --import tsx src/stock-research/strategy/offline-demo.ts [--out <assignment-or-temporary-directory>]');
  const receipt = await writeOfflineArtifacts(args[1] ?? join(DELIVERY_ROOT, 'artifacts'));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
