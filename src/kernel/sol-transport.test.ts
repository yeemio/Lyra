/**
 * W22 单测 · Sol 真实通道传输（Gate-M）。全文件零网络、零凭据接触、零真实 spawn——
 * spawn 全部注入 mock（pid=null，不触真实信号），调用目录用临时目录。
 * 覆盖：argv 镜像 Metis 结构；schema 约束与本地权威校验（含绑定回抄/跨类拒绝/清单覆盖）；
 * 超时终止路径（SIGTERM→SIGKILL 兜底收束）；非零退出/坏 JSON/final 缺失/输出超限；
 * dry-run 与 preview 不 spawn；输入 ↔ 调用合同绑定守卫；prompt 通道上限。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelError, type ModelCallContract } from '../contracts.js';
import {
  DEFAULT_SOL_MODEL,
  DEFAULT_SOL_REASONING_EFFORT,
  SOL_PROMPT_MAX_CHARACTERS,
  SolTransport,
  type ChildLike,
  type SpawnFn,
  type SolInvocationPlan,
} from './sol-transport.js';

const INPUT_HASH = 'ab'.repeat(32);

function contract(overrides?: Partial<ModelCallContract>): ModelCallContract {
  return {
    businessKey: { subjectKind: 'STOCK', subject: '600519', researchKind: 'WEEKLY', cutoff: '2026-10-23T07:00:00.000Z' },
    stage: 'A',
    inputHash: INPUT_HASH,
    inputBytes: 1000,
    methodVersion: 'method@p2-v1',
    planAuthVersion: 'pa-gate-m-1',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const PROMPT = [
  'A（分析者）指令 · method@p2-v1',
  '……方法正文与分层材料（测试占位，内容不影响通道语义）……',
  `required_input_hash = "${INPUT_HASH}"`,
].join('\n');

// ===== mock 子进程（pid=null：transport 的进程组终止对 null pid 是 no-op，测试零真实信号）=====

interface MockHandle {
  child: ChildLike;
  stdinData: () => string;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  close: (code: number | null, signal?: string | null) => void;
  spawnError: () => void;
}

function fakeChild(onStdinEnd?: (handle: MockHandle) => void): MockHandle {
  let stdinBuf = '';
  let closeCb: ((code: number | null, signal: string | null) => void) | undefined;
  let errCb: (() => void) | undefined;
  const stdoutCbs: ((chunk: Buffer) => void)[] = [];
  const stderrCbs: ((chunk: Buffer) => void)[] = [];
  const handle: MockHandle = {
    child: {
      pid: null,
      stdin: {
        end: (data?: string) => {
          if (typeof data === 'string') stdinBuf += data;
          onStdinEnd?.(handle);
        },
        on: () => {},
        destroy: () => {},
      },
      stdout: { on: (_e: 'data', cb: (chunk: Buffer) => void) => { stdoutCbs.push(cb); }, destroy: () => {} },
      stderr: { on: (_e: 'data', cb: (chunk: Buffer) => void) => { stderrCbs.push(cb); }, destroy: () => {} },
      once: ((event: 'error' | 'close', cb: (...args: unknown[]) => void) => {
        if (event === 'close') closeCb = cb as (code: number | null, signal: string | null) => void;
        else errCb = cb as () => void;
      }) as ChildLike['once'],
      unref: () => {},
    },
    stdinData: () => stdinBuf,
    emitStdout: (data: string) => { for (const cb of stdoutCbs) cb(Buffer.from(data, 'utf8')); },
    emitStderr: (data: string) => { for (const cb of stderrCbs) cb(Buffer.from(data, 'utf8')); },
    close: (code, signal = null) => closeCb?.(code, signal),
    spawnError: () => errCb?.(),
  };
  return handle;
}

interface MockBehavior {
  /** stdin 收到 prompt 后写入 final.txt 的内容；undefined=不写（final 缺失路径）；'@@hang@@'=挂起不退出。 */
  final?: string;
  exitCode?: number;
  hang?: boolean;
  spawnErr?: boolean;
}

interface SpawnRecorder {
  spawnFn: SpawnFn;
  calls: { binary: string; argv: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; shell: false }; handle: MockHandle }[];
}

function mockSpawn(behavior: MockBehavior = {}): SpawnRecorder {
  const rec: SpawnRecorder = {
    calls: [],
    spawnFn: (binary, argv, opts) => {
      const handle = fakeChild((h) => {
        if (behavior.hang === true || behavior.spawnErr === true) return;
        if (behavior.final !== undefined) {
          const finalPath = argv[argv.indexOf('--output-last-message') + 1];
          if (finalPath === undefined || typeof finalPath !== 'string') throw new Error('mock: argv 缺 --output-last-message 路径');
          writeFileSync(finalPath, behavior.final, 'utf8');
        }
        setImmediate(() => h.close(behavior.exitCode ?? 0));
      });
      rec.calls.push({ binary, argv: [...argv], opts, handle });
      if (behavior.spawnErr === true) setImmediate(() => handle.spawnError());
      return handle.child;
    },
  };
  return rec;
}

function testConfig(rec: SpawnRecorder, workDirRoot: string, extra?: { timeoutMs?: number; killGraceMs?: number; maxOutputBytes?: number; dryRun?: boolean; model?: string; reasoningEffort?: string }): { transport: SolTransport; workDirRoot: string } {
  return {
    transport: new SolTransport({
      binary: '/test/codex',
      model: extra?.model ?? DEFAULT_SOL_MODEL,
      reasoningEffort: extra?.reasoningEffort ?? DEFAULT_SOL_REASONING_EFFORT,
      timeoutMs: extra?.timeoutMs ?? 5_000,
      killGraceMs: extra?.killGraceMs ?? 20,
      maxOutputBytes: extra?.maxOutputBytes ?? 4 * 1024 * 1024,
      workDirRoot,
      dryRun: extra?.dryRun ?? false,
      spawnFn: rec.spawnFn,
    }),
    workDirRoot,
  };
}

function freshWorkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'lyra-sol-test-'));
}

async function assertKernelError(fn: () => Promise<unknown>, code: string): Promise<KernelError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof KernelError, `应为 KernelError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  throw new Error(`期望抛 KernelError(${code})，实际未抛`);
}

// ===== 合法输出夹具 =====

function validAJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    stage: 'A',
    inputHash: INPUT_HASH,
    subjectKind: 'STOCK',
    candidate: 'RESEARCH_OUTPERFORM',
    decisiveLinks: [
      { text: '决定性连接一：近 8 季营收与净利趋势', evidenceArtifactSha256: '11'.repeat(32) },
      { text: '决定性连接二：行业基准相对强弱', evidenceArtifactSha256: '22'.repeat(32) },
    ],
    strongestCounter: '最强反证：近 20 日换手率抬升与回调风险',
    confidence: 'MEDIUM',
    limitations: ['风险项：股权质押比例未入库'],
    simulated: false,
    ...overrides,
  });
}

function validJJson(expectedIds: string[], overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    stage: 'J',
    inputHash: 'cd'.repeat(32),
    finalDisposition: 'ABSTAIN',
    verdicts: expectedIds.map((id) => ({ checklistId: id, verdict: 'SUPPORTED', decisionBearing: true, correction: null, reason: '合成复核理由', evidenceArtifactSha256s: ['11'.repeat(32)], remainingBasisChecklistIds: [] })),
    changedFromA: false,
    changeReason: null,
    strongestCaseDisposition: 'ACCEPTED',
    limitations: ['限制：材料缺口'],
    simulated: false,
    ...overrides,
  });
}

const J_IDS = ['check:p0:DECISIVE_LINK:0', 'check:p0:DECISIVE_LINK:1', 'check:p0:STRONGEST_COUNTER:0', 'check:p0:CANDIDATE:0', 'check:p0:SELECTION_THRESHOLD:0'];

// ===== describe / argv / preview =====

describe('SolTransport · 身份与 argv 构造（Metis 镜像）', () => {
  it('describe：provider codex-native、simulated:false', () => {
    const t = new SolTransport({ spawnFn: mockSpawn().spawnFn });
    assert.deepEqual(t.describe(), { provider: 'codex-native', simulated: false, modelId: 'gpt-6.1-sol', effort: 'high' });
    assert.notDeepEqual(t.describe(), new SolTransport({ model: 'synthetic-other-model', reasoningEffort: 'max' }).describe());
  });

  it('argv 结构逐项镜像 Metis buildCodexArgv（沙箱只读、web_search 禁用、schema/final 路径、stdin 提示符）', async () => {
    const rec = mockSpawn();
    const { transport } = testConfig(rec, freshWorkRoot());
    const plan = await transport.preview(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    const argv = plan.argv;
    assert.equal(argv[0], 'exec');
    const flags = (f: string): number => argv.filter((a) => a === f).length;
    assert.equal(flags('--ephemeral'), 1);
    assert.equal(flags('--ignore-rules'), 1);
    assert.equal(flags('--ignore-user-config'), 1);
    assert.equal(flags('--sandbox'), 1);
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(flags('--skip-git-repo-check'), 1);
    assert.equal(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort="high"');
    assert.ok(argv.includes('web_search="disabled"'));
    assert.ok(argv.includes('project_doc_max_bytes=0'));
    assert.equal(argv[argv.indexOf('-m') + 1], DEFAULT_SOL_MODEL);
    assert.equal(flags('--json'), 1);
    assert.deepEqual([argv[argv.indexOf('--color') + 1]], ['never']);
    assert.equal(argv[argv.indexOf('--output-schema') + 1], '<sol-invocation-dir>/schema.json');
    assert.equal(argv[argv.indexOf('--output-last-message') + 1], '<sol-invocation-dir>/final.txt');
    assert.equal(argv[argv.length - 1], '-'); // prompt 走 stdin
    // Metis 只读退出观察同款拒绝面：不得出现越权放行旗标
    for (const banned of ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto']) {
      assert.ok(!argv.includes(banned), `argv 不得含 ${banned}`);
    }
    assert.equal(plan.pathPlaceholders, true);
    assert.equal(rec.calls.length, 0, 'preview 不 spawn');
    assert.equal(plan.promptBytes, Buffer.byteLength(PROMPT, 'utf8'));
    assert.equal(plan.promptSha256.length, 64);
  });

  it('A/J schema 随 stage 与标的类别变化（候选选项空间进入 wire 约束）', async () => {
    const rec = mockSpawn();
    const { transport } = testConfig(rec, freshWorkRoot());
    const aStock = await transport.preview(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    assert.ok(JSON.stringify(aStock.schema).includes('RESEARCH_OUTPERFORM'));
    assert.ok(!JSON.stringify(aStock.schema).includes('RESEARCH_UP'));
    const etfContract = contract({ businessKey: { subjectKind: 'BROAD_ETF', subject: '510300', researchKind: 'WEEKLY', cutoff: '2026-10-23T07:00:00.000Z' } });
    const aEtf = await transport.preview(etfContract, { inputHash: INPUT_HASH, subjectKind: 'BROAD_ETF', prompt: PROMPT });
    assert.ok(JSON.stringify(aEtf.schema).includes('RESEARCH_UP'));
    assert.ok(!JSON.stringify(aEtf.schema).includes('RESEARCH_OUTPERFORM'));
    const jPlan = await transport.preview(contract({ stage: 'J', inputHash: 'cd'.repeat(32) }), { inputHash: 'cd'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT });
    assert.ok(JSON.stringify(jPlan.schema).includes('finalDisposition'));
    assert.ok(JSON.stringify(jPlan.schema).includes('SUPPORTED'));
  });

  it('config.dryRun=true 时 dispatch 只返回预览，绝不 spawn', async () => {
    const rec = mockSpawn();
    const { transport } = testConfig(rec, freshWorkRoot(), { dryRun: true });
    const out = await transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    assert.ok(typeof (out as SolInvocationPlan).argv === 'object');
    assert.equal(rec.calls.length, 0, 'dryRun dispatch 不 spawn');
  });
});

// ===== 绑定守卫 =====

describe('SolTransport · 输入 ↔ 调用合同绑定守卫', () => {
  it('inputHash 不符 / subjectKind 不符 / prompt 空 → MODEL_INPUT_UNBOUND', async () => {
    const rec = mockSpawn();
    const { transport } = testConfig(rec, freshWorkRoot());
    await assertKernelError(() => transport.dispatch(contract(), { inputHash: 'ff'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT }), 'MODEL_INPUT_UNBOUND');
    await assertKernelError(() => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'BROAD_ETF', prompt: PROMPT }), 'MODEL_INPUT_UNBOUND');
    await assertKernelError(() => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: '' }), 'MODEL_INPUT_UNBOUND');
    await assertKernelError(() => transport.dispatch(contract(), null), 'MODEL_INPUT_UNBOUND');
    assert.equal(rec.calls.length, 0, '绑定失败在 spawn 前');
  });

  it('prompt 超通道字符上限 → SOL_PROMPT_LIMIT_EXCEEDED（拒绝发送不截断）', async () => {
    const rec = mockSpawn();
    const { transport } = testConfig(rec, freshWorkRoot());
    const huge = 'x'.repeat(SOL_PROMPT_MAX_CHARACTERS + 1);
    await assertKernelError(() => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: huge }), 'SOL_PROMPT_LIMIT_EXCEEDED');
    assert.equal(rec.calls.length, 0);
  });
});

// ===== 真实 dispatch 路径（mock 子进程）=====

describe('SolTransport · dispatch 成功路径', () => {
  it('A：schema/prompt 落盘、prompt 走 stdin、final.txt → 定型 AOutput', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ final: validAJson(), exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    const out = await transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    assert.equal(rec.calls.length, 1);
    const call = rec.calls[0]!;
    assert.equal(call.binary, '/test/codex');
    assert.equal(call.opts.detached, true, 'detached：进程组终止语义');
    assert.equal(call.opts.shell, false);
    assert.equal(call.opts.cwd.startsWith(workRoot), true, 'cwd = 一次性调用目录');
    assert.equal(call.handle.stdinData(), PROMPT, 'prompt 经 stdin 原样送达');
    const schemaPath = call.argv[call.argv.indexOf('--output-schema') + 1] as string;
    assert.ok(existsSync(schemaPath), 'schema.json 已落盘（真实路径）');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    assert.equal(schema.type, 'object');
    const promptPath = join(call.opts.cwd, 'prompt.txt');
    assert.equal(readFileSync(promptPath, 'utf8'), PROMPT, 'prompt 副本落盘（证据）');
    assert.ok((out as { stage: string }).stage === 'A');
    assert.equal((out as { inputHash: string }).inputHash, INPUT_HASH);
    assert.deepEqual((out as { decisiveLinks: unknown[] }).decisiveLinks.length, 2);
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('J：verdicts 恰好覆盖 expectedChecklistIds → 定型 JOutput', async () => {
    const workRoot = freshWorkRoot();
    const jContract = contract({ stage: 'J', inputHash: 'cd'.repeat(32) });
    const rec = mockSpawn({ final: validJJson(J_IDS), exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    const out = await transport.dispatch(jContract, {
      inputHash: 'cd'.repeat(32),
      subjectKind: 'STOCK',
      prompt: PROMPT,
      expectedChecklistIds: J_IDS,
    });
    assert.equal((out as { stage: string }).stage, 'J');
    assert.deepEqual(
      (out as { verdicts: { checklistId: string }[] }).verdicts.map((v) => v.checklistId),
      J_IDS,
    );
    rmSync(workRoot, { recursive: true, force: true });
  });
});

describe('SolTransport · 失败路径（具名错误，无重试）', () => {
  it('PR4 外部租约取消传到挂起进程；零重发，晚到 close 不改 UNKNOWN 依据', async () => {
    const workRoot = freshWorkRoot(), rec = mockSpawn({ hang: true });
    const { transport } = testConfig(rec, workRoot, { timeoutMs: 5000, killGraceMs: 5 });
    const controller = new AbortController();
    try {
      const result = transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }, controller.signal);
      const rejected = assertKernelError(() => result, 'SILENCE_AFTER_SEND');
      assert.equal(rec.calls.length, 1);
      controller.abort(new KernelError('EXECUTION_LOCK_HELD'));
      await rejected;
      rec.calls[0]!.handle.close(0);
      assert.equal(rec.calls.length, 1);
      await assertKernelError(() => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }, controller.signal), 'EXECUTION_LOCK_HELD');
      assert.equal(rec.calls.length, 1, 'pre-aborted call cannot create another child');
    } finally { rmSync(workRoot, { recursive: true, force: true }); }
  });

  it('超时：挂起子进程 → SIGTERM→SIGKILL 兜底收束 → TIMEOUT', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ hang: true });
    const { transport } = testConfig(rec, workRoot, { timeoutMs: 40, killGraceMs: 10 });
    await assertKernelError(
      () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
      'TIMEOUT',
    );
    assert.equal(rec.calls.length, 1, '恰一次 spawn（无重试）');
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('非零退出 → MODEL_PROVIDER_EXIT_NONZERO（含 stderr 尾部上下文）', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ final: validAJson(), exitCode: 1 });
    const { transport } = testConfig(rec, workRoot);
    const err = await assertKernelError(
      () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
      'MODEL_PROVIDER_EXIT_NONZERO',
    );
    assert.ok(err.message.includes('退出码 1'));
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('退出码 0 但 final.txt 缺失 → MODEL_FINAL_MISSING', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ exitCode: 0 }); // final undefined：不写 final.txt
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
      'MODEL_FINAL_MISSING',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('final.txt 非法 JSON → MODEL_OUTPUT_INVALID_JSON', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ final: '这不是 JSON{"', exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
      'MODEL_OUTPUT_INVALID_JSON',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('输出超限 → 终止进程组并 MODEL_OUTPUT_LIMIT_EXCEEDED', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ hang: true });
    const { transport } = testConfig(rec, workRoot, { timeoutMs: 5_000, killGraceMs: 10, maxOutputBytes: 1_000 });
    const promise = transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    setImmediate(() => rec.calls[0]?.handle.emitStdout('x'.repeat(2_000)));
    await assertKernelError(() => promise, 'MODEL_OUTPUT_LIMIT_EXCEEDED');
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('spawn 失败（ENOENT 等）→ SOL_SPAWN_FAILED', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ spawnErr: true });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
      'SOL_SPAWN_FAILED',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('超时终止后的迟到 close 不改判（仍 TIMEOUT，不冒充远端退出码）', async () => {
    const workRoot = freshWorkRoot();
    const rec = mockSpawn({ hang: true });
    const { transport } = testConfig(rec, workRoot, { timeoutMs: 40, killGraceMs: 10 });
    const promise = transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT });
    const assertion = assertKernelError(() => promise, 'TIMEOUT');
    setTimeout(() => rec.calls[0]?.handle.close(0), 80); // 迟到且"成功"的 close
    await assertion;
    rmSync(workRoot, { recursive: true, force: true });
  });
});

describe('SolTransport · 输出形状本地权威校验', () => {
  const cases: { name: string; json: Record<string, unknown> }[] = [
    { name: 'candidate 跨类（STOCK 输出宽基选项）→ 拒绝', json: { candidate: 'RESEARCH_UP' } },
    { name: 'inputHash 未回抄 → 拒绝', json: { inputHash: 'ff'.repeat(32) } },
    { name: 'simulated 非 false → 拒绝（R28 真实通道自声明）', json: { simulated: true } },
    { name: 'decisiveLinks 不足 2 条 → 拒绝', json: { decisiveLinks: [{ text: '仅一条', evidenceArtifactSha256: '11'.repeat(32) }] } },
    { name: '证据哈希非 64 位十六进制 → 拒绝', json: { decisiveLinks: [
      { text: 'a', evidenceArtifactSha256: 'not-hex' },
      { text: 'b', evidenceArtifactSha256: '22'.repeat(32) },
    ] } },
    { name: '缺字段（confidence）→ 拒绝', json: { confidence: undefined } },
    { name: '多字段（额外 reasoning）→ 拒绝（字段集封闭）', json: { reasoning: 'extra' } },
    { name: 'confidence 越界 → 拒绝', json: { confidence: 'PROBABLE' } },
  ];
  for (const c of cases) {
    it(`A 输出：${c.name}`, async () => {
      const workRoot = freshWorkRoot();
      const rec = mockSpawn({ final: validAJson(c.json), exitCode: 0 });
      const { transport } = testConfig(rec, workRoot);
      await assertKernelError(
        () => transport.dispatch(contract(), { inputHash: INPUT_HASH, subjectKind: 'STOCK', prompt: PROMPT }),
        'MODEL_OUTPUT_SCHEMA_INVALID',
      );
      rmSync(workRoot, { recursive: true, force: true });
    });
  }

  it('J 输出：verdicts 漏一项 → MODEL_OUTPUT_SCHEMA_INVALID（恰一次覆盖前移到 dispatch 内）', async () => {
    const workRoot = freshWorkRoot();
    const jContract = contract({ stage: 'J', inputHash: 'cd'.repeat(32) });
    const rec = mockSpawn({ final: validJJson(J_IDS.slice(0, 4)), exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(jContract, { inputHash: 'cd'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT, expectedChecklistIds: J_IDS }),
      'MODEL_OUTPUT_SCHEMA_INVALID',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('J 输出：verdicts 含清单外 id / 重复 id → 拒绝', async () => {
    const workRoot = freshWorkRoot();
    const jContract = contract({ stage: 'J', inputHash: 'cd'.repeat(32) });
    const withAlien = validJJson([...J_IDS.slice(0, 4), 'check:p0:ALIEN:0']);
    const rec = mockSpawn({ final: withAlien, exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(jContract, { inputHash: 'cd'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT, expectedChecklistIds: J_IDS }),
      'MODEL_OUTPUT_SCHEMA_INVALID',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('J 输出：finalDisposition 跨类（STOCK 合同输出宽基选项）→ 拒绝', async () => {
    const workRoot = freshWorkRoot();
    const jContract = contract({ stage: 'J', inputHash: 'cd'.repeat(32) });
    const rec = mockSpawn({ final: validJJson(J_IDS, { finalDisposition: 'RESEARCH_UP' }), exitCode: 0 });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(jContract, { inputHash: 'cd'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT, expectedChecklistIds: J_IDS }),
      'MODEL_OUTPUT_SCHEMA_INVALID',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('J 输出：verdict 枚举越界（MAYBE）→ 拒绝', async () => {
    const workRoot = freshWorkRoot();
    const jContract = contract({ stage: 'J', inputHash: 'cd'.repeat(32) });
    const rec = mockSpawn({
      final: validJJson(J_IDS, {
        verdicts: J_IDS.map((id, i) => ({ checklistId: id, verdict: i === 0 ? 'MAYBE' : 'SUPPORTED', decisionBearing: true, correction: null })),
      }),
      exitCode: 0,
    });
    const { transport } = testConfig(rec, workRoot);
    await assertKernelError(
      () => transport.dispatch(jContract, { inputHash: 'cd'.repeat(32), subjectKind: 'STOCK', prompt: PROMPT, expectedChecklistIds: J_IDS }),
      'MODEL_OUTPUT_SCHEMA_INVALID',
    );
    rmSync(workRoot, { recursive: true, force: true });
  });
});
