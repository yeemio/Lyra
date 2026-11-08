import type { ExecutionLease } from '../../kernel/lease.js';
/** Isolated SQL/transport doubles only. No database connection, credential lookup or model process. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { canonicalSha256 } from '../../canonical.js';
import { KernelError } from '../../contracts.js';
import { defaultSrPlanBudget, type SrModelStepKind, type SrModelTransport, type SrTransportDescribe } from '../contracts.js';
import type { AFinalOutput, JInput, JOutput } from '../transport.js';
import { REAL_DATA_ROOT } from './real-seal.js';
import { fileStrategyStore, type RealClientManifest } from './real-store.js';
import { freezeRealReviewInput, REAL_REVIEW_TABLES, runRealStrategyReview, type RealReviewInput, type RealReviewResult, type StrategyReviewRequest } from './real-review.js';

type Row = Record<string, unknown>;
export interface IsolatedSrSnapshot {
  identity: 'ISOLATED_SR_SQL_DOUBLE_NOT_DATABASE_EVIDENCE';
  tasks: Row[]; steps: Row[]; calls: Row[];
}
export class IsolatedSrPool {
  readonly queries: string[] = [];
  readonly holderId = 'isolated-strategy-review-writer';
  readonly lease: ExecutionLease = { space: 'sr', holderId: this.holderId, generation: '1', ttlMs: 60000 };
  lifecycle = 'RUNNING';
  private tasks = new Map<string, Row>();
  private steps = new Map<string, Row>();
  private calls = new Map<string, Row>();
  private budgetLimits = new Map<string, Row>();
  private attempts = new Map<string, Row>();
  constructor(snapshot?: IsolatedSrSnapshot) {
    if (snapshot) {
      if (snapshot.identity !== 'ISOLATED_SR_SQL_DOUBLE_NOT_DATABASE_EVIDENCE') throw new Error('NOT_ISOLATED_SNAPSHOT');
      const revive = (row: Row, fields: string[]) => { const r = structuredClone(row); for (const k of fields) if (r[k] !== null && r[k] !== undefined) r[k] = new Date(String(r[k])); return r; };
      for (const r of snapshot.tasks) this.tasks.set(String(r.task_id), revive(r, ['cutoff', 'created_at', 'updated_at', 'completed_at']));
      for (const r of snapshot.steps) this.steps.set(String(r.step_id), revive(r, ['started_at', 'finished_at']));
      for (const r of snapshot.calls) this.calls.set(String(r.call_id), revive(r, ['deadline', 'sent_at', 'settled_at', 'created_at']));
    }
  }
  asPool(): Pool { return this as unknown as Pool; }
  snapshot(): IsolatedSrSnapshot { return structuredClone({ identity: 'ISOLATED_SR_SQL_DOUBLE_NOT_DATABASE_EVIDENCE' as const, tasks: [...this.tasks.values()], steps: [...this.steps.values()], calls: [...this.calls.values()] }); }
  sent(callId: string): boolean { return this.calls.get(callId)?.state === 'SENT'; }
  corruptCall(callId: string, patch: Row): void { const row = this.calls.get(callId); if (!row) throw new Error('ISOLATED_CALL_NOT_FOUND'); Object.assign(row, patch); }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async query(sql: string, args: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase(); this.queries.push(q);
    const result = (rows: Row[]) => ({ rows: structuredClone(rows), rowCount: rows.length });
    const now = new Date();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select pg_advisory_xact_lock')) return result([]);
    if (q.startsWith('insert into execution_attempt')) {
      this.attempts.set(String(args[0]), { attempt_id: args[0], space: args[1], contract: JSON.parse(String(args[2])) }); return result([]);
    }
    if (q.startsWith('update execution_attempt set finished_at=')) {
      const row = this.attempts.get(String(args[0])); if (!row) return result([]);
      Object.assign(row, { finished_at: now, outcome: args[1], fail_code: args[2], permit_id: args[3] }); return result([row]);
    }
    if (q.startsWith('insert into execution_budget_authorization')) {
      const key = `${String(args[0])}:${String(args[1])}`;
      if (!this.budgetLimits.has(key)) this.budgetLimits.set(key, { limits: JSON.parse(String(args[2])) }); return result([]);
    }
    if (q.startsWith('select limits from execution_budget_authorization')) return result([this.budgetLimits.get(`${String(args[0])}:${String(args[1])}`)!]);
    if (q === 'select clock_timestamp() as current_time') return result([{ current_time: now }]);
    if (q.startsWith('select holder,generation::text,lease_until from sr_engine_lock')) return result([{ holder: this.holderId, generation: '1', lease_until: new Date(now.getTime()+60000) }]);
    if (q.startsWith('update sr_engine_lock set heartbeat_at')) return result([{ holder: this.holderId }]);
    if (q.startsWith('select lifecycle from sr_recovery_state')) return result([{ lifecycle: this.lifecycle }]);
    if (q === 'select now() as now') return result([{ now }]);
    if (q.startsWith('select holder, heartbeat_at from sr_engine_lock')) return result([{ holder: this.holderId, heartbeat_at: now }]);
    if (q.startsWith('select lifecycle, pending_call_ids, updated_at from sr_recovery_state')) return result([{ lifecycle: this.lifecycle, pending_call_ids: [], updated_at: now }]);
    if (q.startsWith('insert into sr_task')) {
      const [id, account, subject, name, focus, emphasis, horizon, cutoff, idem, method, adapter, auth] = args;
      if (this.tasks.has(String(id)) || [...this.tasks.values()].some((r) => r.account_id === account && r.idem_key === idem)) return result([]);
      const row = { task_id: id, account_id: account, subject, subject_name: name, focus, emphasis, horizon, cutoff: new Date(String(cutoff)), status: 'RUNNING', idem_key: idem, revised_from_task_id: null, method_version: method, adapter_version: adapter, plan_auth_version: auth, error: null, created_at: now, updated_at: now, completed_at: null };
      this.tasks.set(String(id), row); return result([row]);
    }
    if (q.startsWith('select * from sr_task where task_id')) return result(this.tasks.has(String(args[0])) ? [this.tasks.get(String(args[0]))!] : []);
    if (q.startsWith('update sr_task set')) {
      const r = this.tasks.get(String(args[0])); if (!r) return result([]);
      if (args[1] !== null) r.status = args[1]; if (args[2] !== null) r.error = JSON.parse(String(args[2])); if (args[3]) r.completed_at = now; r.updated_at = now; return result([r]);
    }
    if (q.startsWith('insert into sr_step')) {
      const [id, task, kind, sequence] = args;
      if (!this.tasks.has(String(task))) throw new Error('ISOLATED_TASK_FK');
      if (this.steps.has(String(id)) || [...this.steps.values()].some((r) => r.task_id === task && r.sequence === sequence)) return result([]);
      const row = { step_id: id, task_id: task, step_kind: kind, section_key: null, sequence, status: 'PENDING', note: null, started_at: null, finished_at: null };
      this.steps.set(String(id), row); return result([row]);
    }
    if (q.startsWith('select * from sr_step where task_id')) return result([...this.steps.values()].filter((r) => r.task_id === args[0]).sort((a, b) => Number(a.sequence) - Number(b.sequence)));
    if (q.startsWith('select input_checkpoint,input_checkpoint_hash from sr_step')) {
      const row = this.steps.get(String(args[1])); return result(row ? [{ input_checkpoint: row.input_checkpoint ?? null, input_checkpoint_hash: row.input_checkpoint_hash ?? null }] : []);
    }
    if (q.startsWith('update sr_step set input_checkpoint=')) {
      const row = this.steps.get(String(args[1])); if (!row) return result([]);
      row.input_checkpoint=JSON.parse(String(args[2])); row.input_checkpoint_hash=args[3]; return result([row]);
    }
    if (q.startsWith('update sr_step set')) {
      const r = this.steps.get(String(args[0])); if (!r) return result([]);
      if (args[1] !== null) r.status = args[1]; if (args[2] !== null) r.note = args[2]; if (args[3]) r.started_at = now; if (args[4]) r.finished_at = now; return result([r]);
    }
    if (q.startsWith('insert into sr_call')) {
      const [id, task, step, inputHash, bytes, method, auth, deadline, simulated, failCode] = args;
      if (!this.tasks.has(String(task)) || this.steps.get(String(step))?.task_id !== task) throw new Error('ISOLATED_SR_CALL_FK');
      const prior = [...this.calls.values()].find((r) => r.task_id === task && r.step_id === step);
      if (prior && (prior.sent_at !== null || !['PREPARED', 'FAILED'].includes(String(prior.state)))) return result([]);
      const callId = prior?.call_id ?? id;
      const row = { call_id: callId, task_id: task, step_id: step, input_hash: inputHash, input_bytes: bytes, method_version: method, plan_auth_version: auth, deadline: new Date(String(deadline)), state: failCode ? 'FAILED' : 'PREPARED', simulated, sent_at: null, settled_at: failCode ? now : null, fail_code: failCode ?? null, provider: null, model_id: null, usage: null, created_at: now };
      this.calls.set(String(callId), row); return result([row]);
    }
    if (q.startsWith('select call_id as permit_id from sr_call')) return result([...this.calls.values()]
      .filter((r) => r.task_id === args[0] && r.step_id === args[1] && r.input_hash === args[2]).map((r) => ({ permit_id: r.call_id })));
    if (q.startsWith('select * from sr_call where task_id')) return result([...this.calls.values()].filter((r) => r.task_id === args[0] && r.step_id === args[1]));
    if (q.startsWith('select * from sr_call where call_id')) return result(this.calls.has(String(args[0])) ? [this.calls.get(String(args[0]))!] : []);
    if (q.startsWith('select state,simulated,response_checkpoint,response_hash from sr_call')) {
      const row = this.calls.get(String(args[0])); return result(row ? [row] : []);
    }
    if (q.startsWith('select c.task_id,c.state,clock_timestamp()>c.deadline')) {
      const row = this.calls.get(String(args[0])); return result(row ? [{ task_id: row.task_id, state: row.state,
        expired: now > (row.deadline as Date), week_used: String([...this.calls.values()].filter((c) => c.sent_at).length),
        task_used: String([...this.calls.values()].filter((c) => c.task_id===row.task_id && c.sent_at).length) }] : []);
    }
    if (q.startsWith("update sr_call set state='succeeded',settled_at=clock_timestamp()")) {
      const row = this.calls.get(String(args[0])); if (!row || row.state!=='SENT' || row.execution_generation!==args[4]) return result([]);
      row.state='SUCCEEDED'; row.settled_at=now; row.fail_code=args[3]; row.response_checkpoint=JSON.parse(String(args[1])); row.response_hash=args[2]; return result([row]);
    }
    if (q.startsWith('update sr_call as c set state')) {
      const r = this.calls.get(String(args[0]));
      if (!r || r.state !== 'PREPARED' || now > (r.deadline as Date) || [...this.calls.values()].filter((x) => x.state === 'SENT').length >= Number(args[1])) return result([]);
      r.state = 'SENT'; r.sent_at = now; r.execution_generation=args[2]; return result([r]);
    }
    if (q.startsWith('select *, clock_timestamp() > deadline as deadline_exceeded from sr_call')) {
      const r = this.calls.get(String(args[0])); return result(r ? [{ ...r, deadline_exceeded: now > (r.deadline as Date) }] : []);
    }
    if (q.startsWith("update sr_call set state = 'failed'")) {
      const r = this.calls.get(String(args[0])); if (r?.state === 'PREPARED') { r.state = 'FAILED'; r.settled_at = now; r.fail_code = 'DEADLINE_EXCEEDED'; return result([r]); } return result([]);
    }
    if (q.startsWith('update sr_call set state = $2')) {
      const r = this.calls.get(String(args[0])); if (!r || !(args[3] as string[]).includes(String(r.state))) return result([]);
      r.state = args[1]; r.settled_at = now; r.fail_code = args[2]; return result([r]);
    }
    if (q.startsWith('update sr_call set provider = $2')) {
      const r = this.calls.get(String(args[0])); if (!r) return result([]);
      r.provider = args[1]; r.model_id = args[2]; if (args[3] !== null) r.usage = JSON.parse(String(args[3])); return result([r]);
    }
    throw new Error(`UNSUPPORTED_ISOLATED_SQL: ${q}`);
  }
}

export type IsolatedFault = 'NONE' | 'A_UNKNOWN' | 'A_PENDING' | 'A_SCHEMA' | 'J_UNKNOWN' | 'J_SCHEMA' | 'J_NARROWED' | 'J_CHANGED' | 'J_REJECTED' | 'J_UNRESOLVED';
export class IsolatedReviewTransport implements SrModelTransport {
  readonly events: { step: SrModelStepKind; callId: string; inputHash: string; promptBytes: number; evidenceContentHash: string }[] = [];
  constructor(readonly pool: IsolatedSrPool, readonly fault: IsolatedFault = 'NONE') {}
  describe(step?: SrModelStepKind): SrTransportDescribe { return { provider: 'isolated-deterministic-fixture', modelId: step === 'JUDGE' ? 'fixture-j-v1' : 'fixture-a-v1', simulated: true, effort: 'no-model' }; }
  async dispatch(step: SrModelStepKind, ctx: { callId: string; inputHash: string; deadline?: string }, payload: unknown): Promise<unknown> {
    if (!this.pool.sent(ctx.callId)) throw new Error('DISPATCH_WITHOUT_EXISTING_SR_SENT_PERMIT');
    const p = payload as { evidenceBundle: JEvidenceBundleTableLike[] };
    const prompt = JSON.stringify(payload, null, 1);
    if (createHash('sha256').update(prompt).digest('hex') !== ctx.inputHash || !ctx.deadline) throw new Error('ISOLATED_CALL_CONTEXT_INVALID');
    this.events.push({ step, callId: ctx.callId, inputHash: ctx.inputHash, promptBytes: Buffer.byteLength(prompt), evidenceContentHash: canonicalSha256(p.evidenceBundle.map((t) => ({ tableId: t.tableId, columns: t.columns, rows: t.rows }))) });
    if ((step === 'A_FINAL' && this.fault === 'A_UNKNOWN') || (step === 'JUDGE' && this.fault === 'J_UNKNOWN')) throw new KernelError('SILENCE_AFTER_SEND', 'Isolated fault; no real request');
    if (step === 'A_FINAL' && this.fault === 'A_PENDING') return new Promise<never>(() => {});
    if (step === 'A_FINAL' && this.fault === 'A_SCHEMA') return { invalid: true };
    if (step === 'A_FINAL') {
      return { narrative: 'Isolated deterministic review of the current restricted draft; no model research.', conclusion: 'Keep the current conditional draft restricted; missing data and execution inputs remain unresolved.', conclusionConditions: ['Current frozen draft only; no historical efficacy or execution claim'], decisiveLinks: REAL_REVIEW_TABLES.map((tableId) => ({ tableId, text: `Keep the complete ${tableId} dependency and its limitations binding.` })), strongestCounter: 'Missing industry dates, historical availability and account inputs prevent execution.', catalysts: [], gaps: ['Real A/J was not run', 'Historical efficacy was not evaluated'] } satisfies AFinalOutput;
    }
    if (step !== 'JUDGE') throw new Error('UNEXPECTED_ISOLATED_MODEL_STEP');
    const input = payload as JInput;
    const j: JOutput = { verdicts: input.checklist.items.map((item) => ({ checklistId: item.checklistId, verdict: 'SUPPORTED', decisionBearing: true, bearingReason: 'The dependency affects the restricted research conclusion', remainingBasis: null, evidenceRef: item.tableId ?? 'gaps-and-lineage', correction: null })), conclusionRuling: { finalConclusion: input.aFinal.conclusion, changedFromA: false, changeReason: null, conditions: input.aFinal.conclusionConditions }, unresolvedDisposition: [], limitations: ['Isolated fixture only; no real model, account, execution or efficacy acceptance'] };
    if (this.fault === 'J_NARROWED') { j.verdicts[0]!.verdict = 'NARROWED'; j.verdicts[0]!.correction = 'A revised frozen version is required'; }
    if (this.fault === 'J_REJECTED') { j.verdicts[0]!.verdict = 'REJECTED'; j.verdicts[0]!.correction = 'Reject this dependency'; }
    if (this.fault === 'J_UNRESOLVED') { j.verdicts[0]!.verdict = 'UNRESOLVED'; j.unresolvedDisposition.push({ checklistId: j.verdicts[0]!.checklistId, handling: 'Keep blocked pending evidence' }); }
    if (this.fault === 'J_CHANGED' || this.fault === 'J_SCHEMA') { j.conclusionRuling.finalConclusion = 'Proposed revision: retain only the missing-evidence observation.'; j.conclusionRuling.changedFromA = this.fault !== 'J_SCHEMA'; j.conclusionRuling.changeReason = 'The isolated J fixture changes the scope'; }
    return j;
  }
}
interface JEvidenceBundleTableLike { tableId: string; columns: string[]; rows: (string | number | null)[][] }

export function isolatedRequest(): StrategyReviewRequest {
  return { accountId: '00000000-0000-4000-8000-000000000001', authorizationRef: 'strategy-review-source-r1-20261031:isolated-only', authorizationMode: 'ISOLATED_SIMULATED_ONLY',
    budget: { ...defaultSrPlanBudget(), planAuthVersion: 'strategy-review-isolated-20261031-v1' },
    deadlines: { A: new Date(Date.now() + 120_000).toISOString(), J: new Date(Date.now() + 180_000).toISOString() } };
}
export async function originalStrategyStore() {
  const path = join(REAL_DATA_ROOT, 'client-manifest.json');
  return fileStrategyStore(path, createHash('sha256').update(await readFile(path)).digest('hex'));
}

export async function writeReviewClientManifest(out: string, inputPath: string, resultPath: string): Promise<{ manifestPath: string; manifestSha256: string }> {
  const baseBytes = await readFile(join(REAL_DATA_ROOT, 'client-manifest.json'));
  const base = JSON.parse(baseBytes.toString('utf8')) as RealClientManifest;
  await mkdir(out, { recursive: true });
  const files = [];
  for (const s of base.sources) {
    const target = join(out, 'original', s.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(REAL_DATA_ROOT, s.path)), { flag: 'wx' });
    files.push({ ...s, path: relative(out, target) });
  }
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const additions = [['base-manifest', 'base-manifest.json', baseBytes], ['review-input', 'review-input.json', await readFile(inputPath)], ['review-result', 'review-result.json', await readFile(resultPath)]] as const;
  for (const [id, path, bytes] of additions) { await writeFile(join(out, path), bytes, { flag: 'wx' }); files.push({ id, path, sha256: hash(bytes), mediaType: 'application/json' as const, label: id }); }
  const manifest: RealClientManifest = { ...base, sources: files, review: { baseManifestId: 'base-manifest', inputId: 'review-input', resultId: 'review-result' } };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); const manifestPath = join(out, 'client-manifest.json');
  await writeFile(manifestPath, bytes, { flag: 'wx' });
  return { manifestPath, manifestSha256: hash(bytes) };
}

export function blockExternalEffects() {
  const originalQuery = Pool.prototype.query, originalConnect = Pool.prototype.connect, originalFetch = globalThis.fetch;
  const attempts = { database: 0, externalFetch: 0 };
  Pool.prototype.query = (() => { attempts.database++; throw new Error('REAL_DATABASE_FORBIDDEN_IN_ISOLATED_REVIEW'); }) as typeof originalQuery;
  Pool.prototype.connect = (() => { attempts.database++; throw new Error('REAL_DATABASE_FORBIDDEN_IN_ISOLATED_REVIEW'); }) as typeof originalConnect;
  globalThis.fetch = async (target, init) => {
    const url = new URL(typeof target === 'string' || target instanceof URL ? target : target.url);
    if (url.hostname !== '127.0.0.1') { attempts.externalFetch++; throw new Error('EXTERNAL_FETCH_FORBIDDEN_IN_ISOLATED_REVIEW'); }
    return originalFetch(target, init);
  };
  return { attempts, restore() { Pool.prototype.query = originalQuery; Pool.prototype.connect = originalConnect; globalThis.fetch = originalFetch; } };
}

export async function reproduceIsolatedReview(out: string) {
  const guard = blockExternalEffects();
  try {
    const sourceStore = await originalStrategyStore();
    const summary = [];
    for (const fault of ['NONE', 'A_UNKNOWN', 'A_SCHEMA', 'J_UNKNOWN', 'J_SCHEMA', 'J_NARROWED', 'J_CHANGED', 'J_REJECTED', 'J_UNRESOLVED'] as const) {
      const pool = new IsolatedSrPool(), transport = new IsolatedReviewTransport(pool, fault);
      const input = await freezeRealReviewInput(sourceStore, transport, isolatedRequest());
      const args = { sourceStore, input, expectedInputHash: input.inputHash, srPool: pool.asPool(), transport, budget: input.execution.budget, outputDir: join(out, fault.toLowerCase()), holderId: pool.holderId, lease: pool.lease };
      const first = await runRealStrategyReview(args);
      const snapshot = pool.snapshot();
      await writeFile(join(dirname(first.inputPath), 'isolated-sr-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
      const restoredPool = new IsolatedSrPool(JSON.parse(JSON.stringify(snapshot)) as IsolatedSrSnapshot), restoredTransport = new IsolatedReviewTransport(restoredPool, fault);
      const recovered = await runRealStrategyReview({ ...args, srPool: restoredPool.asPool(), transport: restoredTransport, holderId: restoredPool.holderId, lease: restoredPool.lease });
      if (restoredTransport.events.length !== 0) throw new Error('RECOVERY_RESENT');
      if (fault === 'NONE' && first.result.resultHash !== recovered.result.resultHash) throw new Error('RECOVERY_CHANGED_SUCCESS');
      const client = await writeReviewClientManifest(join(out, `${fault.toLowerCase()}-client`), recovered.inputPath, recovered.resultPath);
      const readback = await fileStrategyStore(client.manifestPath, client.manifestSha256).load();
      if (readback.researchReview?.resultHash !== recovered.result.resultHash) throw new Error('CLIENT_READBACK_MISMATCH');
      summary.push({ fault, status: recovered.result.status, inputHash: input.inputHash, resultHash: recovered.result.resultHash, calls: transport.events.length, recoveredCalls: restoredTransport.events.length,
        promptBytes: recovered.result.promptBytes, aEvidenceHash: transport.events[0]?.evidenceContentHash ?? null, jEvidenceHash: transport.events.find((e) => e.step === 'JUDGE')?.evidenceContentHash ?? null, executionEligible: recovered.result.executionEligible, manifest: client, resultPath: recovered.resultPath, isolatedQueries: pool.queries.length + restoredPool.queries.length });
    }
    const receipt = { identity: 'ISOLATED_SOURCE_VERIFICATION_ONLY', databaseEvidence: false, realModelCalls: 0, attempts: guard.attempts, cases: summary };
    await writeFile(join(out, 'reproduction.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } finally { guard.restore(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw new Error('USAGE: node --import tsx src/stock-research/strategy/review-isolated.ts --out <fresh-isolated-output-directory>');
  process.stdout.write(JSON.stringify(await reproduceIsolatedReview(resolve(process.argv[3]!)), null, 2) + '\n');
}
