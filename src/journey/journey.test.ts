import { keepLeaseAlive, type ExecutionLease } from '../kernel/lease.js';
import { inputFromTestSeal } from '../research/research-test-helper.js';
import { researchMaterial } from '../research/requests.js';
import { researchJInputHash } from '../research/validation.js';
/**
 * Lyra · 旅程测试安装门（P0 Done-when 1；EK-10.2 七断言 + P0 补充断言）。W3: code-writer-pro。
 *
 * 断言风格（EK-10.4）：计数断言（permit/发送次数）而非旁路日志；阻断具名且不伪造对象；
 * 幂等以重放验证；"未授权零释放"是第一优先断言。全程走公开 API（封存/内核/清单/结论/
 * 结算/泄漏断言均为产品路径），禁止直接表补丁（EK-10.2.3）；对 permit 表只做只读计数。
 *
 * 运行：node --import tsx --test --test-concurrency=1 src/journey/journey.test.ts
 * 套件全绿才写 .last-journey-run.json（green:true）并走 record-install 正路径；
 * 负路径（伪造 green:false → 非零退出、install_log 无行）在套件内独立断言。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, test } from 'node:test';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import {
  BROAD_DISPOSITIONS,
  KernelError,
  STOCK_DISPOSITIONS,
  type AOutput,
  type JOutput,
  type ModelCallContract,
  type ModelPermit,
  type ProgramChecklist,
  type ResearchBusinessKey,
  type SealManifest,
  type SimFault,
  type Stage,
  type SubjectKind,
} from '../contracts.js';
import { runModelCall, type ModelFn } from '../kernel/executor.js';
import {
  findPermitByBusinessKey,
  getPermit,
  markSent,
  preparePermit,
  settle,
} from '../kernel/permit.js';
import { acquireExecutorLock, heartbeatExecutorLock } from '../kernel/lock.js';
import { bootRecovery, confirmRecovery, getRecoveryState } from '../kernel/recovery.js';
import { retireUnknown } from '../kernel/permit.js';
import { asOfFacts } from '../pintime/facts.js';
import { assertNoLeakage } from '../pintime/leakage.js';
import { buildSeal, verifySeal } from '../pintime/seal.js';
import {
  assertModelCallContext,
  oversizedInputBytes,
  simulatedModelA,
  simulatedModelAFn,
  simulatedModelJ,
  simulatedModelJFn,
  withDelay,
  withFault,
  type SimulatedAInput,
  type SimulatedJInput,
} from '../research/simulated.js';
import { deriveChecklist, rederiveChecklistHash } from '../research/checklist.js';
import {
  backfillSettlement,
} from '../conclusion/settlement.js';
import {
  ConclusionError,
  conclusionHashOf,
  researchCoreOf,
  type ConclusionInheritance,
  type ConclusionInput,
} from '../conclusion/object.js';
import { persistConclusion, readConclusion } from '../db/conclusion.js';
import {
  LIMIT_RULE_TABLE,
  LimitRuleError,
  limitCoefficient,
  limitPrice,
  resolveLimitRule,
  type LimitRuleRow,
} from '../rules/limit.js';
import {
  CUTOFF,
  DAY_MS,
  HOLDER,
  JOURNEY_VERSION_ID,
  buildSyntheticUniverse,
  seedResearchSubject,
  startJourney,
  stopJourney,
  type JourneyEnv,
  type SyntheticUniverse,
} from './helpers.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAST_RUN_PATH = join(REPO_ROOT, '.last-journey-run.json');
const PROBE_PATH = fileURLToPath(new URL('../kernel/probe.ts', import.meta.url));
const RECORD_INSTALL_PATH = fileURLToPath(new URL('../kernel/record-install.ts', import.meta.url));

let testLease: ExecutionLease;
let testKeeper: ReturnType<typeof keepLeaseAlive>;
let env: JourneyEnv | undefined;
let universe: SyntheticUniverse | undefined;

// ===== 自计通过/失败（Done-when 6：全绿才写安装门记录）=====
let passCount = 0;
let failCount = 0;
function jt(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    try {
      await fn();
      passCount += 1;
    } catch (err) {
      failCount += 1;
      throw err;
    }
  });
}

before(async () => {
  env = await startJourney();
  testLease = (await acquireExecutorLock(env.pool, HOLDER)).lease;
  testKeeper = keepLeaseAlive(env.pool, testLease);
  universe = await buildSyntheticUniverse(env.pool, env.store);
});

beforeEach(async () => {
  if (env) await heartbeatExecutorLock(env.pool, testLease); // 心跳续租，防长套件 TTL 过期
});

after(async () => {
  await testKeeper?.stop();
  if (!env) return;
  const green = failCount === 0 && passCount > 0;
  const record = {
    versionId: JOURNEY_VERSION_ID,
    testRunId: env.runId,
    pass: passCount,
    fail: failCount,
    green,
  };
  await writeFile(LAST_RUN_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (green) {
    // 正路径：全绿记录经 record-install CLI 落 install_log（EK-10.3）
    const r = await runNodeCli([RECORD_INSTALL_PATH, LAST_RUN_PATH]);
    if (r.code !== 0) {
      await writeFile(LAST_RUN_PATH, `${JSON.stringify({ ...record, green: false }, null, 2)}\n`, 'utf8');
      await stopJourney(env);
      throw new Error(`安装门正路径失败：record-install 退出码 ${r.code}，stderr=${r.stderr}`);
    }
    const rows = await env.pool.query<{ n: string }>(
      `select count(*)::text as n from install_log where test_run_id = $1`,
      [env.runId],
    );
    if (Number(rows.rows[0]?.n ?? 0) !== 1) {
      await writeFile(LAST_RUN_PATH, `${JSON.stringify({ ...record, green: false }, null, 2)}\n`, 'utf8');
      await stopJourney(env);
      throw new Error('安装门正路径失败：install_log 未落行');
    }
    console.log(`[install-gate] INSTALL_RECORDED version=${JOURNEY_VERSION_ID} testRun=${env.runId} pass=${passCount} fail=${failCount}`);
  }
  await stopJourney(env); // drop 全部 p0_journey_* schema、清临时原件目录
});

// ===== 通用助手 =====

function e(): JourneyEnv {
  assert.ok(env, '旅程环境未初始化');
  return env;
}
function u(): SyntheticUniverse {
  assert.ok(universe, '合成宇宙未初始化');
  return universe;
}

async function expectKernel(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof KernelError, `应为 KernelError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function expectConclusion(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ConclusionError, `应为 ConclusionError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

function expectLimit(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof LimitRuleError, `应为 LimitRuleError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function runNodeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  assert.ok(env, '旅程环境未初始化');
  try {
    const ok = await execFileAsync(process.execPath, ['--import', 'tsx', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, LYRA_PG_SCHEMA: env.schema } as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    return { code: 0, stdout: ok.stdout, stderr: ok.stderr };
  } catch (err) {
    const e2 = err as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof e2.code === 'number' ? e2.code : -1, stdout: e2.stdout ?? '', stderr: e2.stderr ?? '' };
  }
}

async function waitPermitState(subject: string, stage: Stage, state: string, timeoutMs = 5000): Promise<ModelPermit> {
  const start = Date.now();
  for (;;) {
    const p = await findPermitByBusinessKey(e().pool, {
      businessKey: { subjectKind: 'STOCK', subject, researchKind: 'WEEKLY', cutoff: CUTOFF },
      stage,
    });
    if (p && p.state === state) return p;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitPermitState 超时：${subject}/${stage}→${state}（当前 ${p?.state ?? '无行'}）`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ===== 研究轮组合助手（全程公开 API）=====

interface RoundVersions {
  methodVersion: string;
  adapterVersion: string;
}

function bkOf(subjectKind: SubjectKind, subject: string, cutoffIso: string): ResearchBusinessKey {
  return { subjectKind, subject, researchKind: 'WEEKLY', cutoff: cutoffIso };
}

async function sealRound(subjectKind: SubjectKind, subject: string, cutoffIso: string, versions: RoundVersions): Promise<SealManifest> {
  return buildSeal(e().pool, e().store, {
    businessKey: bkOf(subjectKind, subject, cutoffIso),
    cutoff: cutoffIso,
    factSelector: { subjectType: subjectKind === 'STOCK' ? 'STOCK' : 'ETF', subjectId: subject },
    gaps: ['合成宇宙：无真实数据源（P0 声明缺口样例）'],
    methodVersion: versions.methodVersion,
    adapterVersion: versions.adapterVersion,
    planAuthVersion: e().budget.planAuthVersion,
  });
}

function mkAInput(seal: SealManifest): SimulatedAInput {
  const pkg = inputFromTestSeal(seal);
  return { inputHash: pkg.inputHash, subjectKind: seal.businessKey.subjectKind,
    subject: seal.businessKey.subject, material: researchMaterial(pkg) };
}

function mkJInput(seal: SealManifest, aOutput: AOutput, checklist: ProgramChecklist): SimulatedJInput {
  return {
    inputHash: researchJInputHash(inputFromTestSeal(seal), aOutput, checklist),
    subjectKind: seal.businessKey.subjectKind,
    aOutput,
    checklist,
  };
}

function mkContract(bk: ResearchBusinessKey, stage: Stage, inputHash: string, inputBytes: number, methodVersion: string): ModelCallContract {
  return {
    businessKey: bk,
    stage,
    inputHash,
    inputBytes,
    methodVersion,
    planAuthVersion: e().budget.planAuthVersion,
    deadline: new Date(Date.now() + 90_000).toISOString(),
  };
}

async function callA(seal: SealManifest, versions: RoundVersions, fault?: SimFault): Promise<{ aOutput: AOutput; permitId: string }> {
  const input = mkAInput(seal);
  const contract = mkContract(seal.businessKey, 'A', input.inputHash, Buffer.byteLength(canonicalJsonString(input)), versions.methodVersion);
  const r = await runModelCall(e().pool, {
    contract,
    budget: e().budget,
    modelFn: withFault(simulatedModelAFn(input), fault),
    simulated: true,
    lease: testLease,
  });
  return { aOutput: r.output, permitId: r.permit.permitId };
}

async function callJ(seal: SealManifest, aOutput: AOutput, checklist: ProgramChecklist, versions: RoundVersions, fault?: SimFault): Promise<{ jOutput: JOutput; permitId: string }> {
  const input = mkJInput(seal, aOutput, checklist);
  const contract = mkContract(seal.businessKey, 'J', input.inputHash, Buffer.byteLength(canonicalJsonString(input)), versions.methodVersion);
  const r = await runModelCall(e().pool, {
    contract,
    budget: e().budget,
    modelFn: withFault(simulatedModelJFn(input), fault),
    simulated: true,
    lease: testLease,
  });
  return { jOutput: r.output, permitId: r.permit.permitId };
}

interface HappyRound {
  seal: SealManifest;
  aOutput: AOutput;
  aPermitId: string;
  checklist: ProgramChecklist;
  jOutput: JOutput;
  jPermitId: string;
  conclusion: Awaited<ReturnType<typeof persistConclusion>>;
  input: ConclusionInput;
}

async function runFullRound(
  subjectKind: SubjectKind,
  subject: string,
  cutoffIso: string,
  versions: RoundVersions,
  opts: { jOverride?: (j: JOutput, aOutput: AOutput) => JOutput; inheritance?: ConclusionInheritance | null; changeReason?: string | null } = {},
): Promise<HappyRound> {
  const seal = await sealRound(subjectKind, subject, cutoffIso, versions);
  const a = await callA(seal, versions);
  const checklist = deriveChecklist(a.aOutput, seal.manifestHash);
  const j = await callJ(seal, a.aOutput, checklist, versions);
  const jOutput = opts.jOverride ? opts.jOverride(j.jOutput, a.aOutput) : j.jOutput;
  const input: ConclusionInput = {
    businessKey: seal.businessKey,
    methodVersion: versions.methodVersion,
    adapterVersion: versions.adapterVersion,
    planAuthVersion: e().budget.planAuthVersion,
    aOutput: a.aOutput,
    checklist,
    jOutput,
    manifest: seal,
    researchInput: inputFromTestSeal(seal),
    inheritance: opts.inheritance ?? null,
    changeReason: opts.changeReason ?? jOutput.changeReason ?? null,
  };
  const conclusion = await persistConclusion(e().pool, input);
  return { seal, aOutput: a.aOutput, aPermitId: a.permitId, checklist, jOutput, jPermitId: j.permitId, conclusion, input };
}

let happyStock: HappyRound | undefined;
let happyEtf: HappyRound | undefined;

/** 依赖完整路径用例产物的 narrowing 取值器。 */
function hs(): HappyRound {
  assert.ok(happyStock, '依赖完整路径用例（EK-10.2.3）先行通过');
  return happyStock;
}
function he(): HappyRound {
  assert.ok(happyEtf, '依赖完整路径用例（EK-10.2.3）先行通过');
  return happyEtf;
}

// =====================================================================
// 1. R19 涨跌幅规则表：切换日系数、舍入与查表具名错误（Done-when 1 补充）
// =====================================================================
jt('R19：ST 主板 2026-07-03 取 5%、2026-07-06 取 10%；NORMAL 恒 10%；查表零行/多行具名错误', () => {
  assert.deepEqual(limitCoefficient({ board: 'MAINBOARD', stStatus: 'ST', date: '2026-07-03' }), {
    coefficient: 0.05,
    ruleVersionId: 'ASHARE-LIMIT-2026A-MAINBOARD-ST-5',
  });
  assert.deepEqual(limitCoefficient({ board: 'MAINBOARD', stStatus: '*ST', date: '2026-07-05' }), {
    coefficient: 0.05,
    ruleVersionId: 'ASHARE-LIMIT-2026A-MAINBOARD-ST-5',
  });
  assert.deepEqual(limitCoefficient({ board: 'MAINBOARD', stStatus: 'ST', date: '2026-07-06' }), {
    coefficient: 0.1,
    ruleVersionId: 'ASHARE-LIMIT-2026B-MAINBOARD-ST-10',
  });
  // NORMAL 全区间恒 10%（横跨切换日的两个取样日）
  for (const day of ['2015-01-05', '2026-10-16']) {
    assert.equal(limitCoefficient({ board: 'MAINBOARD', stStatus: 'NORMAL', date: day }).coefficient, 0.1);
  }
  // 涨跌停价：四舍五入到分（half-up），整数分运算
  assert.equal(limitPrice(10.1, 'UP', 0.05), '10.61'); // 1060.5 → 1061（half-up，禁银行家舍入）
  assert.equal(limitPrice(10.1, 'DOWN', 0.05), '9.60'); // 959.5 → 960
  assert.equal(limitPrice(10.1, 'UP', 0.1), '11.11');
  assert.equal(limitPrice(10.1, 'DOWN', 0.1), '9.09');
  // 一字板判定随切换日变化：同一收盘 10.61 在 07-03 恰为涨停价，在 07-06 不再是
  assert.equal(limitPrice(10.1, 'UP', limitCoefficient({ board: 'MAINBOARD', stStatus: 'ST', date: '2026-07-03' }).coefficient), '10.61');
  assert.notEqual(limitPrice(10.1, 'UP', limitCoefficient({ board: 'MAINBOARD', stStatus: 'ST', date: '2026-07-06' }).coefficient), '10.61');
  // 查表零行（范围外板块）：具名错误，不回退默认值
  expectLimit(() => resolveLimitRule(LIMIT_RULE_TABLE, { board: 'CHINEXT', stStatus: 'NORMAL', date: '2026-07-03' }), 'RULE_NO_MATCH');
  // 查表多行（构造重叠区间表）：具名错误（真实冻结表不会命中，此处证伪解析器）
  const overlapped: LimitRuleRow[] = [
    { board: 'MAINBOARD', stStatus: 'ST', from: null, to: null, coefficient: 0.05, ruleVersionId: 'bad-1' },
    { board: 'MAINBOARD', stStatus: 'ST', from: '2020-01-01', to: null, coefficient: 0.1, ruleVersionId: 'bad-2' },
  ];
  expectLimit(() => resolveLimitRule(overlapped, { board: 'MAINBOARD', stStatus: 'ST', date: '2026-01-01' }), 'RULE_AMBIGUOUS');
  expectLimit(() => limitCoefficient({ board: 'MAINBOARD', stStatus: 'ST', date: 'not-a-date' }), 'RULE_DATE_INVALID');
});

// =====================================================================
// 2. EK-10.1 模拟模型确定性；EK-10.2.2 无 permit 直调模型 → PERMIT_REQUIRED
// =====================================================================
jt('EK-10.1/EK-10.2.2：同 inputHash 同输出；无 permit 直调模型被具名拒绝', async () => {
  const aInput: SimulatedAInput = {
    inputHash: 'ab'.repeat(32),
    subjectKind: 'STOCK',
    subject: '600519',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 5 },
  };
  assert.deepEqual(simulatedModelA(aInput), simulatedModelA(aInput)); // A 确定性
  const checklist = deriveChecklist(simulatedModelA(aInput), 'cd'.repeat(32));
  const jInput: SimulatedJInput = { inputHash: 'ef'.repeat(32), subjectKind: 'STOCK', aOutput: simulatedModelA(aInput), checklist };
  const j1 = simulatedModelJ(jInput);
  assert.deepEqual(j1, simulatedModelJ(jInput)); // J 确定性
  assert.equal(j1.inputHash, jInput.inputHash); // 输入哈希回抄（RM §2.3）

  // 无 permit 直接调模型 → PERMIT_REQUIRED（模型侧守卫，EK-3.2 结构性强制）
  const contract = mkContract(bkOf('STOCK', '600519', CUTOFF), 'A', aInput.inputHash, 128, 'm-0.1');
  const noPermitCtx = { permit: undefined, contract } as unknown as Parameters<ModelFn<AOutput>>[0];
  await assert.rejects(simulatedModelAFn(aInput)(noPermitCtx), (err: unknown) => {
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, 'PERMIT_REQUIRED');
    return true;
  });
  // permit 非 SENT（发送未发起）→ 拒绝
  const preparedCtx = {
    permit: { permitId: 'p-x', contract, state: 'PREPARED', sentAt: null, settledAt: null, failCode: null, simulated: true },
    contract,
  } as unknown as Parameters<ModelFn<AOutput>>[0];
  await assert.rejects(simulatedModelAFn(aInput)(preparedCtx), (err: unknown) => {
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, 'PERMIT_STATE_INVALID');
    return true;
  });
  // 守卫函数本身可独立复核（公开导出）
  assert.throws(
    () => assertModelCallContext(undefined, 'A', 'x'.repeat(64)),
    (err: unknown) => err instanceof KernelError && err.code === 'PERMIT_REQUIRED',
  );
});

// =====================================================================
// 3. EK-10.2.1 零释放：未授权 / RECONCILING 下研究操作零 permit、具名拒绝
// =====================================================================
jt('EK-10.2.1：非执行权持有者与 RECONCILING 态均零 permit、具名拒绝', async () => {
  const baseline = await e().pool.query<{ n: string }>(`select count(*)::text as n from exec_permit`);
  assert.equal(Number(baseline.rows[0]?.n ?? 0), 0, '起始零 permit');

  // a) 未授权执行器（第二执行器同池）→ EXECUTION_LOCK_HELD，零 permit 落位
  const intruderInput: SimulatedAInput = {
    inputHash: canonicalSha256({ t: 'zero-release-intruder' }),
    subjectKind: 'STOCK',
    subject: '600902',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  };
  let intruderCalls = 0;
  const intruderFn: ModelFn<AOutput> = async () => {
    intruderCalls += 1;
    return simulatedModelA(intruderInput);
  };
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: mkContract(bkOf('STOCK', '600902', CUTOFF), 'A', intruderInput.inputHash, 128, 'm-0.1'),
      budget: e().budget,
      modelFn: intruderFn,
      simulated: true,
      holderId: 'intruder-exec',
    }),
    'EXECUTION_LOCK_HELD',
  );
  assert.equal(intruderCalls, 0);
  let rows = await e().pool.query<{ n: string }>(`select count(*)::text as n from exec_permit where subject = '600902'`);
  assert.equal(Number(rows.rows[0]?.n ?? 0), 0, '执行权拒绝先于 permit 落位');

  // b) RECONCILING 下零模型调用：先造一个在途 SENT（250ms 慢模型），bootRecovery 进入 RECONCILING
  const slowInput: SimulatedAInput = {
    inputHash: canonicalSha256({ t: 'zero-release-slow' }),
    subjectKind: 'STOCK',
    subject: '600901',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  };
  const slow = runModelCall(e().pool, {
    contract: mkContract(bkOf('STOCK', '600901', CUTOFF), 'A', slowInput.inputHash, 128, 'm-0.1'),
    budget: e().budget,
    modelFn: withDelay(simulatedModelAFn(slowInput), 250),
    simulated: true,
    lease: testLease,
  });
  await waitPermitState('600901', 'A', 'SENT');
  const state1 = await bootRecovery(e().pool);
  assert.equal(state1.lifecycle, 'RECONCILING');
  assert.ok(state1.pendingPermitIds.length >= 1);
  // RECONCILING 下的研究操作 → RECOVERY_CONFIRM_REQUIRED，零新增 permit
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: mkContract(bkOf('STOCK', '600900', CUTOFF), 'A', canonicalSha256({ t: 'during-reconciling' }), 128, 'm-0.1'),
      budget: e().budget,
      modelFn: simulatedModelAFn({ ...slowInput, subject: '600900' }),
      simulated: true,
      lease: testLease,
    }),
    'RECOVERY_CONFIRM_REQUIRED',
  );
  rows = await e().pool.query<{ n: string }>(`select count(*)::text as n from exec_permit`);
  assert.equal(Number(rows.rows[0]?.n ?? 0), 1, 'RECONCILING 零新增 permit（仅既有 1 条在途）');
  const slowDone = await slow;
  assert.equal(slowDone.permit.state, 'SUCCEEDED', '在途调用本身不受恢复扫描影响');
  const state2 = await confirmRecovery(e().pool, 'owner-journey');
  assert.equal(state2.state.lifecycle, 'RUNNING', '显式确认后恢复 RUNNING');
});

// =====================================================================
// 4. EK-10.2.3 完整公开路径：封存 → A → 清单 → J → 结论落库 → 读回（个股 + 宽基）
// =====================================================================
jt('EK-10.2.3：完整公开路径个股与宽基各一条，读回一致', async () => {
  const versions = { methodVersion: 'm-0.1', adapterVersion: 'av-0.1' };
  happyStock = await runFullRound('STOCK', '600519', CUTOFF, versions);
  happyEtf = await runFullRound('BROAD_ETF', '510300', CUTOFF, versions);

  for (const [round, space] of [[happyStock, STOCK_DISPOSITIONS], [happyEtf, BROAD_DISPOSITIONS]] as const) {
    const verified = await verifySeal(e().pool, e().store, round.seal.sealId);
    assert.equal(verified.ok, true, '封存可校验');
    const leak = await assertNoLeakage(e().pool, { sealId: round.seal.sealId, asOf: new Date(CUTOFF) });
    assert.deepEqual(leak, [], '封存集自身无泄漏');
    // A 结构：候选在合法空间、≥2 决定性连接、证据只指向送达原件
    assert.ok((space as readonly string[]).includes(round.aOutput.candidate), `候选 ${round.aOutput.candidate} 在空间`);
    assert.ok(round.aOutput.decisiveLinks.length >= 2, '决定性连接 ≥2');
    const delivered = new Set(round.seal.artifactRefs.map((r) => r.sha256));
    for (const link of round.aOutput.decisiveLinks) {
      assert.ok(delivered.has(link.evidenceArtifactSha256), '证据引用指向实际送达原件');
    }
    assert.ok(round.aOutput.strongestCounter.length > 0);
    assert.ok(round.aOutput.limitations.length >= 1);
    assert.equal(round.aOutput.simulated, true);
    // 清单：无模型机械抽取
    assert.equal(round.checklist.items.length, round.aOutput.decisiveLinks.length + 3);
    assert.ok(round.checklist.items.every((item) => item.assessment === 'NOT_ASSESSED'));
    assert.equal(round.checklist.checklistHash, rederiveChecklistHash(round.aOutput, round.seal.manifestHash), '清单哈希可由 A 输出机械重导出');
    // J：输入哈希回抄、逐项裁决恰好一次、至少一项承重
    assert.equal(round.jOutput.inputHash.length, 64);
    assert.equal(round.jOutput.verdicts.length, round.checklist.items.length);
    assert.ok(round.jOutput.verdicts.some((v) => v.decisionBearing), '至少一项承重');
    // 结论：读回一致 + 字段间校验全部内建成立
    const read = await readConclusion(e().pool, round.conclusion.conclusionId);
    assert.deepEqual(read, round.conclusion, '结论读回与落库对象全等');
    assert.equal(read?.disposition, round.jOutput.finalDisposition, 'disposition 等于 J 最终决定');
    assert.equal(read?.adoption, false, 'adoption 恒 false');
    assert.deepEqual(read?.settlement, { state: 'UNSETTLED' }, '结算占位区初始未结算');
    assert.equal(read?.standaloneNote, '无基础结论可继承');
    assert.equal(read?.inheritance, null);
    assert.equal(read?.evidence.checklistHash, rederiveChecklistHash(round.aOutput, round.seal.manifestHash));
    assert.equal(conclusionHashOf(researchCoreOf(read as never)), read?.conclusionHash, 'conclusionHash 按研究字段重算一致');
    // A/J permit 均 SUCCEEDED（一次发送语义下各一次）
    const aPermit = await getPermit(e().pool, round.aPermitId);
    const jPermit = await getPermit(e().pool, round.jPermitId);
    assert.equal(aPermit?.state, 'SUCCEEDED');
    assert.equal(jPermit?.state, 'SUCCEEDED');
  }
  // 宽基选项空间（R18）：UP/DOWN/ABSTAIN
  assert.ok(BROAD_DISPOSITIONS.includes(he().conclusion.disposition as never));
});

// =====================================================================
// 5. EK-10.2.4 send-once 幂等：重复提交发送 1 次、读回首次；重跑零新增发送
// =====================================================================
jt('EK-10.2.4：同业务键重复提交 → 发送 1 次、读回首次；重跑已完成研究零新增发送', async () => {
  const h = hs();
  let calls = 0;
  const input = mkAInput(h.seal);
  const counting: ModelFn<AOutput> = async (ctx) => {
    calls += 1;
    return simulatedModelAFn(input)(ctx);
  };
  const firstPermit = await findPermitByBusinessKey(e().pool, { businessKey: h.seal.businessKey, stage: 'A' });
  assert.equal(firstPermit?.state, 'SUCCEEDED');
  const firstSentAt = firstPermit?.sentAt;
  // 同业务键重复提交 A → BUSINESS_KEY_ALREADY_SENT，modelFn 零新增调用
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: mkContract(h.seal.businessKey, 'A', input.inputHash, 256, 'm-0.1'),
      budget: e().budget,
      modelFn: counting,
      simulated: true,
      lease: testLease,
    }),
    'BUSINESS_KEY_ALREADY_SENT',
  );
  assert.equal(calls, 0, '重复提交零新增发送');
  const after = await findPermitByBusinessKey(e().pool, { businessKey: h.seal.businessKey, stage: 'A' });
  assert.equal(after?.permitId, firstPermit?.permitId, '读回首次 permit');
  assert.equal(after?.sentAt, firstSentAt, '发送时刻未被改写');
  // 重跑已完成研究的 J 阶段 → 同样拒绝；结论不重复
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: mkContract(h.seal.businessKey, 'J', canonicalSha256({ t: 'journey-sendonce-j' }), 256, 'm-0.1'),
      budget: e().budget,
      modelFn: simulatedModelJFn(mkJInput(h.seal, h.aOutput, h.checklist)),
      simulated: true,
      lease: testLease,
    }),
    'BUSINESS_KEY_ALREADY_SENT',
  );
  const sentRows = await e().pool.query<{ n: string }>(
    `select count(*)::text as n from exec_permit where subject = '600519' and sent_at is not null`,
  );
  assert.equal(Number(sentRows.rows[0]?.n ?? 0), 2, 'A+J 各恰一次发送');
  const conclCount = await e().pool.query<{ n: string }>(
    `select count(*)::text as n from conclusion where business_key->>'subject' = '600519' and business_key->>'cutoff' = $1`,
    [new Date(CUTOFF).toISOString()],
  );
  assert.equal(Number(conclCount.rows[0]?.n ?? 0), 1, '重跑不产生第二条结论');
  const read = await readConclusion(e().pool, h.conclusion.conclusionId);
  assert.deepEqual(read, h.conclusion, '读回首次结果');
});

// =====================================================================
// 6. 输入超预算阻断（Done-when 1 补充 / EK-4.4/4.5）
// =====================================================================
jt('INPUT_OVER_BUDGET：超预算具名阻断不进 SENT；修复后同键重试最终发送 1 次', async () => {
  const input: SimulatedAInput = {
    inputHash: canonicalSha256({ t: 'over-budget' }),
    subjectKind: 'STOCK',
    subject: '600903',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  };
  let calls = 0;
  const mkCounting = (inp: SimulatedAInput): ModelFn<AOutput> => {
    const raw = simulatedModelAFn(inp);
    return async (ctx) => {
      calls += 1;
      return raw(ctx);
    };
  };
  const blocked = mkContract(bkOf('STOCK', '600903', CUTOFF), 'A', input.inputHash, oversizedInputBytes(e().budget), 'm-0.1');
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: blocked,
      budget: e().budget,
      modelFn: withFault(mkCounting(input), 'INPUT_OVER_BUDGET'), // 若模型侧被调用即闸失效信号
      simulated: true,
      lease: testLease,
    }),
    'INPUT_OVER_BUDGET',
  );
  assert.equal(calls, 0, '预算闸前置拦截，模型零调用');
  let permit = await findPermitByBusinessKey(e().pool, { businessKey: blocked.businessKey, stage: 'A' });
  assert.equal(permit?.state, 'FAILED');
  assert.equal(permit?.failCode, 'INPUT_OVER_BUDGET');
  assert.equal(permit?.sentAt, null, '不进 SENT、不截断');
  // 修复后同键重试（NOT_SENT 出口替换）→ 最终发送次数 1（新输入哈希与新合同一致绑定）
  const fixedInput: SimulatedAInput = {
    inputHash: canonicalSha256({ t: 'over-budget-fixed' }),
    subjectKind: 'STOCK',
    subject: '600903',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  };
  const ok = await runModelCall(e().pool, {
    contract: mkContract(bkOf('STOCK', '600903', CUTOFF), 'A', fixedInput.inputHash, 512, 'm-0.1'),
    budget: e().budget,
    modelFn: mkCounting(fixedInput),
    simulated: true,
    lease: testLease,
  });
  assert.equal(ok.permit.state, 'SUCCEEDED');
  assert.equal(calls, 1, '最终恰一次模型调用');
  const sent = await e().pool.query<{ n: string }>(
    `select count(*)::text as n from exec_permit where subject = '600903' and sent_at is not null`,
  );
  assert.equal(Number(sent.rows[0]?.n ?? 0), 1);
});

// =====================================================================
// 7. EK-10.2.5 UNKNOWN 断点恢复：失联 → UNKNOWN、不自动重采样、Owner 退役、断点续跑
// =====================================================================
jt('EK-10.2.5：SILENCE_AFTER_SEND → UNKNOWN；退役需 Owner 确认；恢复后续跑且已完成步骤零重发', async () => {
  const versions = { methodVersion: 'm-0.1', adapterVersion: 'av-0.1' };
  await seedResearchSubject(e().pool, e().store, '600904');
  const seal = await sealRound('STOCK', '600904', CUTOFF, versions);
  const a = await callA(seal, versions);
  const checklist = deriveChecklist(a.aOutput, seal.manifestHash);
  // J 注入发送后失联
  await expectKernel(() => callJ(seal, a.aOutput, checklist, versions, 'SILENCE_AFTER_SEND'), 'SILENCE_AFTER_SEND');
  const jPermit = await findPermitByBusinessKey(e().pool, { businessKey: seal.businessKey, stage: 'J' });
  assert.equal(jPermit?.state, 'UNKNOWN');
  assert.equal(jPermit?.failCode, 'SILENCE_AFTER_SEND');
  assert.ok(jPermit?.sentAt, '发送确实发起过');
  // 不自动重采样（EK-5.2）：同键重提交被 send-once 拦住
  await expectKernel(() => callJ(seal, a.aOutput, checklist, versions), 'BUSINESS_KEY_ALREADY_SENT');
  // 退役必须 Owner 显式确认（R21）：空确认人被拒
  await expectKernel(() => retireUnknown(e().pool, jPermit?.permitId as string, ''), 'UNKNOWN_NOT_RETIRED');
  // bootRecovery → RECONCILING（UNKNOWN 未退役即非闭合）；期间零发送
  const state1 = await bootRecovery(e().pool);
  assert.equal(state1.lifecycle, 'RECONCILING');
  assert.ok(state1.pendingPermitIds.includes(jPermit?.permitId as string));
  const sentBefore = Number(
    (await e().pool.query<{ n: string }>(`select count(*)::text as n from exec_permit where subject = '600904' and sent_at is not null`)).rows[0]?.n ?? '0',
  );
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: mkContract(bkOf('STOCK', '600908', CUTOFF), 'A', canonicalSha256({ t: 'during-unknown' }), 128, 'm-0.1'),
      budget: e().budget,
      modelFn: simulatedModelAFn({ inputHash: canonicalSha256({ t: 'during-unknown' }), subjectKind: 'STOCK', subject: '600908', material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 } }),
      simulated: true,
      lease: testLease,
    }),
    'RECOVERY_CONFIRM_REQUIRED',
  );
  // confirmRecovery：pending 中 UNKNOWN 保持 UNKNOWN（无证据不改口）
  const confirmed = await confirmRecovery(e().pool, 'owner-journey');
  assert.equal(confirmed.state.lifecycle, 'RUNNING');
  const kept = confirmed.resolved.find((r) => r.permitId === jPermit?.permitId);
  assert.deepEqual(kept, { permitId: jPermit?.permitId, from: 'UNKNOWN', to: 'UNKNOWN' });
  // Owner 显式退役 → 回执落库（remote_result/remote_cost 恒 UNKNOWN）
  const receipt = await retireUnknown(e().pool, jPermit?.permitId as string, 'owner-journey');
  assert.equal(receipt.confirmedBy, 'owner-journey');
  assert.equal(receipt.remoteResult, 'UNKNOWN');
  assert.equal(receipt.remoteCost, 'UNKNOWN');
  // 断点续跑：新一轮（cutoff+7d）完整走完；已完成步骤（本轮 A）零重发
  const nextCutoff = new Date(Date.parse(CUTOFF) + 7 * DAY_MS).toISOString();
  const aSentAtBefore = (await getPermit(e().pool, a.permitId))?.sentAt ?? null;
  const round2 = await runFullRound('STOCK', '600904', nextCutoff, versions);
  assert.equal(round2.conclusion.disposition, round2.jOutput.finalDisposition);
  const aAfter = await getPermit(e().pool, a.permitId);
  assert.equal(aAfter?.state, 'SUCCEEDED');
  assert.ok(aSentAtBefore !== null, '续跑前 A permit 已发送');
  assert.equal(aAfter?.sentAt, aSentAtBefore, 'A permit 保持原发送时刻');
  const sentAfter = Number(
    (await e().pool.query<{ n: string }>(`select count(*)::text as n from exec_permit where subject = '600904' and sent_at is not null`)).rows[0]?.n ?? '0',
  );
  assert.equal(sentAfter, sentBefore + 2, '续跑新增 2 次发送（新一轮 A+J），旧轮零重发');
  const jFinal = await getPermit(e().pool, jPermit?.permitId as string);
  assert.equal(jFinal?.state, 'UNKNOWN', '失联 J 维持 UNKNOWN（已退役）');
});

// =====================================================================
// 8. EK-10.2.6 截止分类（含 R22 三分支）：短截止未按窗完成；改计划模板不影响已启动执行
//    R22 分支映射：分支1 timer胜出/modelFn挂起→UNKNOWN+DEADLINE_EXCEEDED（本用例 a）；
//    分支2 迟到成功→SUCCEEDED+LATE_COMPLETED（内核单测 executor.test.ts 601543 证明）；
//    分支3 发送前过期→FAILED/DEADLINE_EXCEEDED（本用例 c）。
// =====================================================================
jt('EK-10.2.6：短截止 → UNKNOWN/DEADLINE_EXCEEDED（R22）；permit 沿自身 deadline，不从模板继承', async () => {
  // a) 注入短截止 + TIMEOUT：timer 胜出时 modelFn 仍挂起（远端结局不明）→ UNKNOWN + 未按窗完成分类
  const slowInput: SimulatedAInput = {
    inputHash: canonicalSha256({ t: 'deadline-timeout' }),
    subjectKind: 'STOCK',
    subject: '600923',
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  };
  const shortContract: ModelCallContract = {
    ...mkContract(bkOf('STOCK', '600923', CUTOFF), 'A', slowInput.inputHash, 128, 'm-0.1'),
    deadline: new Date(Date.now() + 200).toISOString(),
  };
  await expectKernel(
    () => runModelCall(e().pool, {
      contract: shortContract,
      budget: e().budget,
      modelFn: withFault(simulatedModelAFn(slowInput), 'TIMEOUT'),
      simulated: true,
      lease: testLease,
    }),
    'DEADLINE_EXCEEDED',
  );
  const timeoutPermit = await findPermitByBusinessKey(e().pool, { businessKey: shortContract.businessKey, stage: 'A' });
  assert.equal(timeoutPermit?.state, 'UNKNOWN', 'R22 分支1：截止先到且远端结局不明 → UNKNOWN');
  assert.equal(timeoutPermit?.failCode, 'DEADLINE_EXCEEDED');
  assert.ok(timeoutPermit?.sentAt, '发送已发起，按未按窗完成分类（非未发送）');

  // b) permit 自带 deadline：prepare 后改"计划模板"（合同对象与预算对象均改），markSent/settle 沿原 deadline
  const originalDeadline = new Date(Date.now() + 10_000).toISOString();
  const template = mkContract(bkOf('STOCK', '600921', CUTOFF), 'A', canonicalSha256({ t: 'deadline-selfheld' }), 128, 'm-0.1');
  const prepared = await preparePermit(
    e().pool,
    { ...template, deadline: originalDeadline },
    e().budget,
    { simulated: true },
  );
  assert.equal(prepared.state, 'PREPARED');
  // 模板变更：deadline 提前到过去 + 预算对象整体更换（模拟计划修订）
  const mutatedTemplate = { ...template, deadline: new Date(Date.now() - 1000).toISOString() };
  const mutatedBudget = { ...e().budget, maxModelCallsPerWeek: 99, planAuthVersion: 'pa-0.9' };
  assert.notEqual(mutatedTemplate.deadline, originalDeadline);
  const sent = await markSent(e().pool, prepared.permitId, testLease, e().budget); // 用 DB 行上的原 deadline（未来）→ SENT
  assert.equal(sent.state, 'SENT');
  assert.equal(sent.contract.deadline, originalDeadline, 'permit 沿自身 deadline，不读改后的模板');
  void mutatedBudget; // 预算对象更换不影响已落位 permit 的任何字段
  const done = await settle(e().pool, prepared.permitId, { result: 'SUCCEEDED' });
  assert.equal(done.state, 'SUCCEEDED');
  assert.equal(done.contract.deadline, originalDeadline, 'settle 后读回仍为原 deadline（EK-6.1）');

  // c) 发送前截止已过的 permit：改模板（延后）不能复活——markSent 按行内 deadline 判死
  const expiredContract = mkContract(bkOf('STOCK', '600922', CUTOFF), 'A', canonicalSha256({ t: 'deadline-expired' }), 128, 'm-0.1');
  const expiredPrepared = await preparePermit(
    e().pool,
    { ...expiredContract, deadline: new Date(Date.now() - 1000).toISOString() },
    e().budget,
    { simulated: true },
  );
  await expectKernel(() => markSent(e().pool, expiredPrepared.permitId, testLease, e().budget), 'DEADLINE_EXCEEDED');
  const expiredAfter = await getPermit(e().pool, expiredPrepared.permitId);
  assert.equal(expiredAfter?.state, 'FAILED');
  assert.equal(expiredAfter?.failCode, 'DEADLINE_EXCEEDED');
  assert.equal(expiredAfter?.sentAt, null, '发送从未发起');
});

// =====================================================================
// 9. EK-10.2.7 时点泄漏接线：四类对象 + 边界用例 + 封存集证伪
// =====================================================================
jt('EK-10.2.7：四类时点对象截点后事实被挡；截点当日公告两路径；披露表版本切换；封存集证伪', async () => {
  const D = new Date(CUTOFF);
  const D1 = new Date(D.getTime() + DAY_MS);
  const D3 = new Date(D.getTime() + 3 * DAY_MS);
  const D4 = new Date(D.getTime() + 4 * DAY_MS);
  // 四类时点对象（R14；公告/财务为第一类两形态）各≥1 埋入用例：截点后事实被 as-of 挡住
  for (const planted of u().plantedFutureFacts.filter((f) => f.factId.startsWith('p0j-stock'))) {
    const visible = await asOfFacts(e().pool, {
      subjectType: 'STOCK',
      subjectId: '600519',
      factKind: planted.factKind,
      asOf: D,
    });
    assert.ok(
      !visible.some((f) => f.factId === planted.factId),
      `截点后事实 ${planted.factId}（${planted.factKind}）被挡`,
    );
    assert.ok(visible.length >= 1, `${planted.factKind} 截点前版本可见`);
  }
  // 整体读回无泄漏（selector 路径独立复核）
  const clean = await assertNoLeakage(e().pool, { factSelector: { subjectType: 'STOCK', subjectId: '600519' }, asOf: D });
  assert.deepEqual(clean, []);
  const cleanEtf = await assertNoLeakage(e().pool, { factSelector: { subjectType: 'ETF', subjectId: '510300' }, asOf: D });
  assert.deepEqual(cleanEtf, []);

  // 边界 1：截点当日公告两条路径（POINT-IN-TIME §8）
  const annsAtD = (await asOfFacts(e().pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ANNOUNCEMENT', asOf: D })).map((f) => f.factId);
  assert.ok(annsAtD.includes(u().stock.sameDayTimedFactId), '有披露时刻的当日公告：当日可得');
  assert.ok(!annsAtD.includes(u().stock.dayPrecisionFactId), '日精度当日公告：保守 D+1 可得');
  const annsAtD1 = (await asOfFacts(e().pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'ANNOUNCEMENT', asOf: D1 })).map((f) => f.factId);
  assert.ok(annsAtD1.includes(u().stock.dayPrecisionFactId), 'D+1 日精度公告可见');
  assert.ok(!annsAtD1.includes('p0j-stock-ann-future'), 'D+2 公告在 D+1 仍不可见');

  // 边界 2：预约披露表版本切换（v1 于 D 有效；v2 生效后旧版被 supersede）
  const dsAtD = (await asOfFacts(e().pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DISCLOSURE_SCHEDULE', asOf: D })).map((f) => f.factId);
  assert.deepEqual(dsAtD, [u().stock.disclosureV1FactId]);
  const dsAtD3 = (await asOfFacts(e().pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'DISCLOSURE_SCHEDULE', asOf: D3 })).map((f) => f.factId);
  assert.deepEqual(dsAtD3, [u().stock.disclosureV2FactId], '版本切换后链头胜出');
  const icvAtD4 = (await asOfFacts(e().pool, { subjectType: 'STOCK', subjectId: '600519', factKind: 'INDUSTRY_CLASS_VERSION', asOf: D4 })).map((f) => f.factId);
  assert.deepEqual(icvAtD4, [u().stock.industryV2FactId], '行业分类版本切换同口径');

  // 证伪路径（总控裁定）：干净过滤返回空是正确行为；violation 用封存集触发——
  // 以 D+5 封存（含未来事实）再按 D 断言 → FACT_AFTER_CUTOFF 必须报出
  const lateSeal = await buildSeal(e().pool, e().store, {
    businessKey: bkOf('STOCK', '600519', new Date(D.getTime() + 5 * DAY_MS).toISOString()),
    cutoff: new Date(D.getTime() + 5 * DAY_MS).toISOString(),
    factSelector: { subjectType: 'STOCK', subjectId: '600519' },
    gaps: [],
    methodVersion: 'm-0.1',
    adapterVersion: 'av-0.1',
    planAuthVersion: e().budget.planAuthVersion,
  });
  const violations = await assertNoLeakage(e().pool, { sealId: lateSeal.sealId, asOf: D });
  const leakedAnn = violations.find((v) => v.factId === 'p0j-stock-ann-future');
  assert.ok(leakedAnn, '埋入的截点后公告必须被报出');
  assert.equal(leakedAnn?.reason, 'FACT_AFTER_CUTOFF');
  assert.equal(leakedAnn?.target, 'SEAL');
  assert.ok(violations.length >= 5, '全部埋入类别的截点后事实均被报出');
  // 按其自身截点校验 → 干净
  const selfCheck = await assertNoLeakage(e().pool, { sealId: lateSeal.sealId, asOf: new Date(D.getTime() + 5 * DAY_MS) });
  assert.deepEqual(selfCheck, []);
});

// =====================================================================
// 10. Done-when 2 唯一执行器 + 并发 ≤2（permit 表时间窗峰值断言）
// =====================================================================
jt('Done-when 2：第二执行器探测进程退出码 3；三路并发慢模型在途峰值恰为 2', async () => {
  // a) spawn probe.ts 模拟第二执行器（同 schema env）→ EXECUTION_LOCK_HELD（退出码 3）
  const probe = await runNodeCli([PROBE_PATH]);
  assert.equal(probe.code, 3, `probe 应退出码 3，stdout=${probe.stdout} stderr=${probe.stderr}`);
  assert.match(probe.stderr, /EXECUTION_LOCK_HELD/);

  // b) 三路并发 300ms 慢模拟模型；事后按 permit 表 sent_at/settled_at 时间窗断言峰值 ≤2
  const subjects = ['600931', '600932', '600933'];
  const mkSlowInput = (subject: string): SimulatedAInput => ({
    inputHash: canonicalSha256({ t: 'concurrency', subject }),
    subjectKind: 'STOCK',
    subject,
    material: { artifactSha256s: [u().sampleArtifactSha256], factCount: 1 },
  });
  const runs = subjects.map((subject) =>
    runModelCall(e().pool, {
      contract: mkContract(bkOf('STOCK', subject, CUTOFF), 'A', mkSlowInput(subject).inputHash, 128, 'm-0.1'),
      budget: e().budget,
      modelFn: withDelay(simulatedModelAFn(mkSlowInput(subject)), 300),
      simulated: true,
      lease: testLease,
    }),
  );
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.permit.state === 'SUCCEEDED'));
  const rows = await e().pool.query<{ sent_at: Date; settled_at: Date }>(
    `select sent_at, settled_at from exec_permit where subject = any($1::text[])`,
    [subjects],
  );
  assert.equal(rows.rows.length, 3);
  const events: Array<[number, number]> = [];
  for (const row of rows.rows) {
    assert.ok(row.sent_at && row.settled_at);
    events.push([row.sent_at.getTime(), 1], [row.settled_at.getTime(), -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // 同刻先处理结束事件
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  assert.ok(peak <= 2, `在途 SENT 峰值 ${peak} 违反并发上限（EK-2.3）`);
  assert.equal(peak, 2, '三路并发下闸确实咬合（峰值恰为 2）');
});

// =====================================================================
// 11. Done-when 4 三条版本轴：改任一轴不隐式改变其他轴
// =====================================================================
jt('Done-when 4：换 methodVersion 重跑 → 新结论身份且他轴不动；换 adapterVersion 重建 seal → manifestHash 变、结论不动', async () => {
  await seedResearchSubject(e().pool, e().store, '600905');
  const c1 = new Date(Date.parse(CUTOFF) + 14 * DAY_MS).toISOString();
  const c2 = new Date(Date.parse(CUTOFF) + 21 * DAY_MS).toISOString();
  // 方法轴重跑：同标的同研究类型，换 methodVersion（cutoff 因 send-once 顺延一周）
  const roundA = await runFullRound('STOCK', '600905', c1, { methodVersion: 'm-0.1', adapterVersion: 'av-0.1' });
  const roundB = await runFullRound('STOCK', '600905', c2, { methodVersion: 'm-0.2', adapterVersion: 'av-0.1' });
  assert.notEqual(roundB.conclusion.conclusionId, roundA.conclusion.conclusionId, '新方法版本 → 新结论身份');
  assert.equal(roundB.conclusion.methodVersion, 'm-0.2');
  // 其他两轴不被隐式改动（读回断言）
  assert.equal(roundB.conclusion.adapterVersion, roundA.conclusion.adapterVersion, 'adapter 轴不动');
  assert.equal(roundB.conclusion.planAuthVersion, roundA.conclusion.planAuthVersion, 'planAuth 轴不动');
  assert.equal(roundB.conclusion.planAuthVersion, e().budget.planAuthVersion);
  // 适配器轴：同截点重建 seal（adapterVersion 换版）→ manifestHash 变；既有结论不动
  const reseal = await sealRound('STOCK', '600905', c1, { methodVersion: 'm-0.1', adapterVersion: 'av-0.2' });
  assert.notEqual(reseal.manifestHash, roundA.seal.manifestHash, 'adapter 版本进入 manifest 身份');
  const snapshot = JSON.parse(JSON.stringify(roundA.conclusion)) as typeof roundA.conclusion;
  const reread = await readConclusion(e().pool, roundA.conclusion.conclusionId);
  assert.deepEqual(reread, snapshot, '换 adapterVersion 重建 seal 不触碰既有结论');
  assert.equal(reread?.adapterVersion, 'av-0.1', '结论登记的仍是封存当时的适配器版本');
});

// =====================================================================
// 12. Done-when 5 结论对象字段间校验全组（证伪路径）
// =====================================================================
jt('Done-when 5：跨类选项/清单绑定/哈希重导出/继承配对/覆盖/不可变/adoption/结算占位区全组断言', async () => {
  const h = hs();
  const etf = he();
  const base = h.input;
  // 跨类选项空间（R18）：个股结论带宽基 disposition → 拒绝
  await expectConclusion(
    () => persistConclusion(e().pool, { ...base, jOutput: { ...base.jOutput, finalDisposition: 'RESEARCH_UP' } }),
    'DISPOSITION_SPACE_INVALID',
  );
  // 宽基结论带个股 disposition → 拒绝
  await expectConclusion(
    () => persistConclusion(e().pool, {
      ...etf.input,
      jOutput: { ...etf.input.jOutput, finalDisposition: 'RESEARCH_OUTPERFORM' },
    }),
    'DISPOSITION_SPACE_INVALID',
  );
  // checklistHash 不可手工伪造（须可由 A 输出机械重导出）
  await expectConclusion(
    () => persistConclusion(e().pool, { ...base, checklist: { ...base.checklist, checklistHash: 'f'.repeat(64) } }),
    'CHECKLIST_HASH_MISMATCH',
  );
  // 清单与 manifest 绑定
  const foreignManifest = 'a'.repeat(64);
  await expectConclusion(
    () => persistConclusion(e().pool, {
      ...base,
      checklist: { ...base.checklist, manifestHash: foreignManifest, checklistHash: rederiveChecklistHash(base.aOutput, foreignManifest) },
    }),
    'CHECKLIST_UNBOUND',
  );
  await expectConclusion(
    () => persistConclusion(e().pool, {
      ...base,
      manifest: { ...base.manifest, businessKey: { ...base.businessKey, cutoff: new Date(Date.parse(CUTOFF) + 99 * DAY_MS).toISOString() } },
    }),
    'MANIFEST_UNBOUND',
  );
  // J 裁决须恰好覆盖清单全部条目一次
  await expectConclusion(
    () => persistConclusion(e().pool, { ...base, jOutput: { ...base.jOutput, verdicts: base.jOutput.verdicts.slice(0, -1) } }),
    'J_VERDICTS_MISMATCH',
  );
  // 继承配对：有指针无理由 → 拒绝；有指针有理由 → standaloneNote 为 null
  await expectConclusion(
    () => persistConclusion(e().pool, {
      ...base,
      inheritance: { fromConclusionId: h.conclusion.conclusionId, fromConclusionHash: h.conclusion.conclusionHash },
      changeReason: null,
    }),
    'INHERITANCE_PAIRING_INVALID',
  );
  // 实际改判与自报标志共同核对；外部 reason 不能替代 J 自身理由。
  await assert.rejects(
    () => persistConclusion(e().pool, { ...base, jOutput: { ...base.jOutput, finalDisposition: base.aOutput.candidate === 'ABSTAIN' ? 'RESEARCH_OUTPERFORM' : 'ABSTAIN', changedFromA: true, changeReason: null }, changeReason: null }),
    (error: unknown) => (error as { code?: string }).code === 'J_CHANGE_REASON_REQUIRED',
  );
  // 二次写拒绝（含完全相同的重放）：研究字段落库后不可变
  await expectConclusion(() => persistConclusion(e().pool, base), 'CONCLUSION_IMMUTABLE');

  // disposition 只从 J 取（不从 A 候选抄录）：J 改判轮——最终值 ≠ A 候选且带改判理由
  const c4 = new Date(Date.parse(CUTOFF) + 28 * DAY_MS).toISOString();
  const versions = { methodVersion: 'm-0.1', adapterVersion: 'av-0.1' };
  const overridden = await runFullRound('STOCK', '600519', c4, versions, {
    jOverride: (realJ, a4) => {
      const stockSpace = STOCK_DISPOSITIONS as readonly string[];
      const final = stockSpace.find(
        (d) => d !== realJ.finalDisposition && d !== a4.candidate,
      ) as (typeof STOCK_DISPOSITIONS)[number];
      return { ...realJ, finalDisposition: final, changedFromA: true, changeReason: 'J 复核改判（合成注入演示）',
        strongestCaseDisposition: 'ACCEPTED', verdicts: realJ.verdicts.map((v) => ({ ...v, verdict: 'SUPPORTED', decisionBearing: true, correction: null, remainingBasisChecklistIds: [] })) };
    },
    inheritance: null,
    changeReason: 'J 改判演示（合成注入，独立研究）',
  });
  assert.equal(overridden.conclusion.disposition, overridden.jOutput.finalDisposition);
  assert.notEqual(overridden.conclusion.disposition, overridden.aOutput.candidate, '结论值不抄录 A 候选');
  assert.equal(overridden.conclusion.inheritance, null);
  assert.equal(overridden.conclusion.standaloneNote, '无基础结论可继承');
  assert.ok((overridden.conclusion.changeReason ?? '').length > 0);

  // adoption 恒 false（读回断言）+ 结算占位区：回填只写占位区、研究字段与哈希不动
  const allConclusions = [h.conclusion, etf.conclusion, overridden.conclusion];
  for (const c of allConclusions) {
    const read = await readConclusion(e().pool, c.conclusionId);
    assert.equal(read?.adoption, false, 'adoption 恒 false');
  }
  const before = (await readConclusion(e().pool, h.conclusion.conclusionId)) as NonNullable<Awaited<ReturnType<typeof readConclusion>>>;
  const settled = await backfillSettlement(e().pool, h.conclusion.conclusionId, {
    state: 'SETTLED',
    directionHit: true,
    excessReturn: '0.0312',
    maxAdverse: '-0.0150',
    invalidationTriggered: false,
    tradability: 'NORMAL',
  });
  assert.equal(settled.settlement.state, 'SETTLED');
  assert.equal(settled.disposition, before.disposition, '结算不改 disposition');
  assert.equal(settled.conclusionHash, before.conclusionHash, 'conclusionHash 不变（settlement 不进哈希）');
  assert.equal(canonicalJsonString(researchCoreOf(settled)), canonicalJsonString(researchCoreOf(before)), '研究字段快照全等');
  assert.equal(conclusionHashOf(researchCoreOf(settled)), settled.conclusionHash, '哈希按研究字段重算一致');
  // 占位区可再写，研究字段仍不动（试图经结算路径改研究字段无 API 形状，读回证伪）
  const resettled = await backfillSettlement(e().pool, h.conclusion.conclusionId, {
    state: 'SETTLED',
    directionHit: false,
    excessReturn: '-0.0100',
  });
  assert.equal(resettled.conclusionHash, before.conclusionHash);
  assert.equal(canonicalJsonString(researchCoreOf(resettled)), canonicalJsonString(researchCoreOf(before)));
  await expectConclusion(
    () => backfillSettlement(e().pool, h.conclusion.conclusionId, { state: 'UNSETTLED' } as never),
    'SETTLEMENT_INVALID',
  );
});

// =====================================================================
// 13. Done-when 6 安装门负路径：伪造 green:false → 非零退出且 install_log 无行
// =====================================================================
jt('Done-when 6 负路径：green:false 的运行记录不产生安装（非零退出、零 install_log 行）', async () => {
  const forgedPath = join(tmpdir(), `lyra-p0-forged-${Date.now()}.json`);
  await writeFile(forgedPath, JSON.stringify({ versionId: JOURNEY_VERSION_ID, testRunId: 'forged-not-green', pass: 3, fail: 1, green: false }), 'utf8');
  const r = await runNodeCli([RECORD_INSTALL_PATH, forgedPath]);
  assert.notEqual(r.code, 0, '非绿记录必须非零退出');
  assert.match(r.stderr, /INSTALL_BLOCKED/);
  const forgedRows = await e().pool.query<{ n: string }>(
    `select count(*)::text as n from install_log where test_run_id = 'forged-not-green'`,
  );
  assert.equal(Number(forgedRows.rows[0]?.n ?? 0), 0, '伪造运行无 install_log 行');
  const total = await e().pool.query<{ n: string }>(`select count(*)::text as n from install_log`);
  assert.equal(Number(total.rows[0]?.n ?? 0), 0, '套件运行期不产生任何安装（正路径仅在收尾全绿后）');
});
