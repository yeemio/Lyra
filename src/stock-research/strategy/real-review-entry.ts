import { keepLeaseAlive, type ExecutionLease } from '../../kernel/lease.js';
/** Explicit CLI: prepare is the default; execution needs a pinned new Owner grant and the old real switch. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultSrPlanBudget } from '../contracts.js';
import { RealSrTransport, selectSrTransport } from '../transport.js';
import { fileStrategyStore } from './real-store.js';
import { REAL_DATA_ROOT } from './real-seal.js';
import { executePreparedStrategyReview, prepareRealStrategyReview, strategyAInput, type RealReviewInput, type ReviewExecutionProposal, type ReviewOwnerGrant } from './real-review.js';
import { StrategyError } from './money.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PUBLIC_CONFIG_KEYS = ['LYRA_SR_REAL_CALLS', 'LYRA_SR_REAL_MODEL', 'LYRA_SR_REAL_EFFORT', 'LYRA_SR_REAL_REVIEW_MODEL', 'LYRA_SR_REAL_REVIEW_EFFORT', 'LYRA_SR_REAL_WINDOW_MS', 'LYRA_SR_REAL_BINARY', 'LYRA_SR_TRANSPORT'] as const;
export function publicReviewEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of PUBLIC_CONFIG_KEYS) if (env[key] !== undefined) selected[key] = env[key];
  return selected;
}

export async function prepareReviewBundle(args: {
  out: string; manifestPath: string; manifestSha256: string; accountId: string | null; deadlines: { A: string; J: string }; planAuthVersion: string; requestRef: string;
  env: NodeJS.ProcessEnv; preparedAt: string;
}) {
  const out = resolve(args.out), executionDir = join(out, 'execution');
  const transport = selectSrTransport({ ...publicReviewEnvironment(args.env), LYRA_SR_INVOCATIONS_DIR: join(executionDir, 'invocations') }, false);
  if (!(transport instanceof RealSrTransport)) throw new StrategyError('STRATEGY_PREPARATION_REQUIRES_CODEX_NATIVE_TRANSPORT');
  const sourceStore = fileStrategyStore(args.manifestPath, args.manifestSha256);
  const prepared = await prepareRealStrategyReview({ sourceStore, transport, request: { accountId: args.accountId, authorizationRef: args.requestRef, authorizationMode: 'OWNER_BOUND_REAL', budget: { ...defaultSrPlanBudget(), planAuthVersion: args.planAuthVersion }, deadlines: args.deadlines }, outputDir: executionDir, preparedAt: args.preparedAt });
  const { view } = await sourceStore.load();
  const notRun = {
    identity: 'REAL_REVIEW_PREPARATION_ONLY', status: 'NOT_RUN', inputHash: prepared.input.inputHash, proposalHash: prepared.proposal.proposalHash,
    accountId: args.accountId, realReviewDone: false, modelCalls: 0, registeredTasks: 0, registeredSteps: 0, createdPermits: 0,
    modelProcessStarted: false, databaseConnected: false, credentialsRead: false, externalRequests: 0,
    blockers: [{ code: 'NEW_OWNER_AUTHORIZATION_REQUIRED', detail: 'At most one A and one J plus explicitly listed sr writes; no old report allowance is reusable' }, ...(args.accountId ? [] : [{ code: 'ACTUAL_SR_ACCOUNT_ID_REQUIRED', detail: 'No account was invented; reprepare with the actual account before authorizing this exact proposal' }]), ...view.blockers],
    currentRealSwitchEnabled: transport.config.enabled, estimatedCost: prepared.proposal.estimatedCost,
    jInput: { state: prepared.proposal.calls.J.inputState, payloadHash: null, payloadBytes: null, rule: prepared.proposal.calls.J.construction },
  };
  await mkdir(out, { recursive: true });
  const files: [string, unknown][] = [['input.json', prepared.input], ['proposal.json', prepared.proposal], ['a-input-preview.json', strategyAInput(prepared.input)], ['NOT_RUN.json', notRun], ['source.json', { manifestPath: resolve(args.manifestPath), manifestSha256: args.manifestSha256 }]];
  for (const [name, value] of files) await writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const text = `# 待Owner明确授权的策略复核提案\n\n状态 NOT_RUN；本命令仅写本准备包，不注册任务/步骤/permit、不连接数据库、不读凭据、不spawn或触网。\n\n方案 ${prepared.proposal.proposalHash}\n输入 ${prepared.input.inputHash}\n资料 ${prepared.input.binding.dataHash}\n规则 ${prepared.input.binding.rulesHash}\n原视图 ${prepared.input.binding.viewHash}\n源manifest ${prepared.input.binding.manifestSha256}\n账户 ${args.accountId ?? '未提供；必须以实际ID重新准备，禁止假造'}\n\n最多2次模型调用：A=A_FINAL，${prepared.proposal.calls.A.transport.modelId}/${prepared.proposal.calls.A.transport.effort}，截止${args.deadlines.A}，payload ${prepared.proposal.calls.A.payloadBytes}字节、wire ${prepared.proposal.calls.A.wirePromptBytes}字节；J=JUDGE，${prepared.proposal.calls.J.transport.modelId}/${prepared.proposal.calls.J.transport.effort}，截止${args.deadlines.J}。J输入须待实际A通过校验后由机械清单和全部原证据生成，hash/bytes现在未知，发送前重新计算并受同一${prepared.proposal.budget.maxInputBytes}字节预算约束。首次失败或UNKNOWN即停，不补采样、不借旧海控额度。\n\n未来执行还需明确授权：固定业务task/step下sr_task、sr_step、sr_call写入，以及sr_engine_lock的有界获取/心跳/释放。账户必须已存在，不创建账户、迁移或schema。业务数据库当前状态未读取，不声称新鲜无在途；已封存的不可恢复状态会在开通道/库前拒绝，获新许可后还须读取原sr状态确认一次发送保证。\n\n实际通道为既有RealSrTransport，保留原LYRA_SR_REAL_CALLS=1守门；开关本身不授予运行权限，还需匹配本方案与输入的新Owner授权原件及其pin。默认仅准备，没有网页发送入口。预计费用未知，不填0。\n\n输出位置 ${executionDir}\n\n八日行业缺口、LATEST_REVISED非PIT、独立开盘、账户/机制及历史/样本外验证阻断全部保留；完成真实复核也不打开执行门，不生成缺依据的数量/收益，不接受策略有效性或整体L2。\n`;
  await writeFile(join(out, 'RUN-PROPOSAL.md'), text, { flag: 'wx' });
  return { ...notRun, bundle: out, taskId: prepared.input.taskId, stepIds: prepared.input.stepIds, calls: prepared.proposal.calls, businessWrites: prepared.proposal.businessWrites, versions: prepared.proposal.versions };
}

export async function executeReviewBundle(args: { bundle: string; expectedProposalHash: string; authorizationPath?: string; authorizationSha256?: string; env: NodeJS.ProcessEnv }) {
  if (!args.authorizationPath || !args.authorizationSha256) throw new StrategyError('STRATEGY_NEW_OWNER_AUTHORIZATION_REQUIRED');
  const grantBytes = await readFile(args.authorizationPath);
  if (sha(grantBytes) !== args.authorizationSha256) throw new StrategyError('STRATEGY_OWNER_AUTHORIZATION_PIN_INVALID');
  const grant = JSON.parse(grantBytes.toString('utf8')) as ReviewOwnerGrant;
  const input = JSON.parse(await readFile(join(args.bundle, 'input.json'), 'utf8')) as RealReviewInput;
  const proposal = JSON.parse(await readFile(join(args.bundle, 'proposal.json'), 'utf8')) as ReviewExecutionProposal;
  const source = JSON.parse(await readFile(join(args.bundle, 'source.json'), 'utf8')) as { manifestPath: string; manifestSha256: string };
  if (source.manifestSha256 !== input.binding.manifestSha256) throw new StrategyError('STRATEGY_SOURCE_MANIFEST_PIN_CHANGED');
  return executePreparedStrategyReview({ sourceStore: fileStrategyStore(source.manifestPath, source.manifestSha256), input, proposal, expectedProposalHash: args.expectedProposalHash, grant, realCallsEnabled: args.env.LYRA_SR_REAL_CALLS === '1', permitStoreOrigin: 'BUSINESS_SR_DATABASE',
    createTransport: () => new RealSrTransport({ ...proposal.transportConfig, enabled: args.env.LYRA_SR_REAL_CALLS === '1' }),
    openPermitStore: async () => {
      // This branch is unreachable until the pinned new grant and every local guard have passed.
      const { createPool } = await import('../../db/pool.js');
      const { acquireSrEngineLock, heartbeatSrEngineLock, releaseSrEngineLock, srListUnclosedCalls } = await import('../store.js');
      const srPool = createPool({ schema: 'sr' }), holderId = `strategy-real-review:${randomUUID()}`;
      let lease: ExecutionLease;
      try {
        if ((await srListUnclosedCalls(srPool)).length) throw new StrategyError('RECOVERY_CONFIRM_REQUIRED');
        lease = await acquireSrEngineLock(srPool, holderId);
      } catch (e) { await srPool.end(); throw e; }
      const keeper = keepLeaseAlive(srPool, lease);
      return { srPool, holderId, lease, close: async () => { await keeper.stop(); try { await releaseSrEngineLock(srPool, lease); } finally { await srPool.end(); } } };
    },
  });
}

export async function reviewEntry(args: string[], env: NodeJS.ProcessEnv) {
  const execute = args[0] === '--execute';
  const tokens = args[0] === '--prepare' || execute ? args.slice(1) : args;
  if (tokens.length % 2 !== 0) throw new StrategyError('STRATEGY_REVIEW_ENTRY_USAGE');
  const values = new Map<string, string>();
  const allowed = execute ? ['--bundle', '--proposal-hash', '--owner-authorization', '--owner-authorization-sha256'] : ['--out', '--manifest', '--manifest-sha256', '--account-id', '--deadline-a', '--deadline-j', '--plan-auth-version', '--request-ref'];
  for (let i = 0; i < tokens.length; i += 2) { if (!allowed.includes(tokens[i]!) || values.has(tokens[i]!)) throw new StrategyError('STRATEGY_REVIEW_ENTRY_ARGUMENT_INVALID', tokens[i]); values.set(tokens[i]!, tokens[i + 1]!); }
  if (execute) return executeReviewBundle({ bundle: values.get('--bundle') ?? '', expectedProposalHash: values.get('--proposal-hash') ?? '', ...(values.has('--owner-authorization') ? { authorizationPath: values.get('--owner-authorization')! } : {}), ...(values.has('--owner-authorization-sha256') ? { authorizationSha256: values.get('--owner-authorization-sha256')! } : {}), env });
  for (const key of ['--out', '--deadline-a', '--deadline-j', '--plan-auth-version']) if (!values.get(key)) throw new StrategyError('STRATEGY_REVIEW_PREPARE_ARGUMENT_REQUIRED', key);
  const manifestPath = resolve(values.get('--manifest') ?? join(REAL_DATA_ROOT, 'client-manifest.json'));
  const manifestSha256 = values.get('--manifest-sha256') ?? sha(await readFile(manifestPath));
  return prepareReviewBundle({ out: values.get('--out')!, manifestPath, manifestSha256, accountId: values.get('--account-id') ?? null, deadlines: { A: values.get('--deadline-a')!, J: values.get('--deadline-j')! }, planAuthVersion: values.get('--plan-auth-version')!, requestRef: values.get('--request-ref') ?? 'strategy-real-review-ready-20261031', env, preparedAt: new Date().toISOString() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await reviewEntry(process.argv.slice(2), process.env), null, 2) + '\n'); }
  catch (e) { process.stderr.write(JSON.stringify({ error: { code: e && typeof e === 'object' && 'code' in e ? String(e.code) : 'LOCAL_ENTRY_ERROR', message: e instanceof Error ? e.message : String(e) } }) + '\n'); process.exitCode = 1; }
}
