/**
 * W12 单测 · 模型路由（P2 Done-when 3）。覆盖：SimulatedTransport 确定性（同 hash
 * 同输出）与 A/J 分派；输入 ↔ 调用合同绑定守卫（MODEL_INPUT_UNBOUND）；
 * UnauthorizedTransport 具名 MODEL_PROVIDER_UNAUTHORIZED；selectTransport 两分支。
 * 全文件无任何网络访问（模拟模型纯函数，真实端点为抛错占位）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSha256 } from '../canonical.js';
import { KernelError, type AOutput, type ModelCallContract } from '../contracts.js';
import { deriveChecklist } from '../research/checklist.js';
import { simulatedModelA, type SimulatedAInput, type SimulatedJInput } from '../research/simulated.js';
import { selectTransport, SimulatedTransport, UnauthorizedTransport } from './transport.js';

const INPUT_HASH = 'ab'.repeat(32);
const OTHER_HASH = 'cd'.repeat(32);
const MANIFEST_HASH = 'ef'.repeat(32);

function contract(overrides?: Partial<ModelCallContract>): ModelCallContract {
  return {
    businessKey: {
      subjectKind: 'STOCK',
      subject: '600000',
      researchKind: 'WEEKLY',
      cutoff: '2026-10-24T15:00:00.000Z',
    },
    stage: 'A',
    inputHash: INPUT_HASH,
    inputBytes: 1000,
    methodVersion: 'method@p2-v1',
    planAuthVersion: 'plan@p2-w12',
    deadline: '2026-10-25T12:00:00.000Z',
    ...overrides,
  };
}

function aPayload(overrides?: Partial<SimulatedAInput>): SimulatedAInput {
  return {
    inputHash: INPUT_HASH,
    subjectKind: 'STOCK',
    subject: '600000',
    material: {
      artifactSha256s: ['11'.repeat(32), '22'.repeat(32)],
      factCount: 42,
      gaps: ['风险项：股权质押比例缺失'],
    },
    ...overrides,
  };
}

function jPayload(aOutput: AOutput): SimulatedJInput {
  return {
    inputHash: INPUT_HASH,
    subjectKind: 'STOCK',
    aOutput,
    checklist: deriveChecklist(aOutput, MANIFEST_HASH),
  };
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

describe('SimulatedTransport（EK-10.1 模拟身份）', () => {
  it('describe 自我声明 simulated:true', () => {
    const t = new SimulatedTransport();
    assert.deepEqual(t.describe(), { provider: 'lyra-simulated', simulated: true });
  });

  it('A 分派：输出绑定 inputHash、证据指向送达原件、simulated:true', async () => {
    const t = new SimulatedTransport();
    const out = (await t.dispatch(contract(), aPayload())) as AOutput;
    assert.equal(out.stage, 'A');
    assert.equal(out.inputHash, INPUT_HASH);
    assert.equal(out.simulated, true);
    assert.ok(out.decisiveLinks.length >= 2);
    for (const link of out.decisiveLinks) {
      assert.ok(aPayload().material.artifactSha256s.includes(link.evidenceArtifactSha256));
    }
  });

  it('确定性：同 hash 同输出（A 与 J 各两次 dispatch 逐字一致）', async () => {
    const t = new SimulatedTransport();
    const a1 = await t.dispatch(contract(), aPayload());
    const a2 = await t.dispatch(contract(), aPayload());
    assert.equal(canonicalSha256(a1), canonicalSha256(a2));

    const aOutput = simulatedModelA(aPayload());
    const jContract = contract({ stage: 'J' });
    const j1 = await t.dispatch(jContract, jPayload(aOutput));
    const j2 = await t.dispatch(jContract, jPayload(aOutput));
    assert.equal(canonicalSha256(j1), canonicalSha256(j2));
  });

  it('J 分派：逐项裁决清单恰好一次、回抄 inputHash', async () => {
    const t = new SimulatedTransport();
    const aOutput = simulatedModelA(aPayload());
    const checklist = deriveChecklist(aOutput, MANIFEST_HASH);
    const out = (await t.dispatch(contract({ stage: 'J' }), jPayload(aOutput))) as {
      stage: string;
      inputHash: string;
      verdicts: { checklistId: string }[];
      simulated: boolean;
    };
    assert.equal(out.stage, 'J');
    assert.equal(out.inputHash, INPUT_HASH);
    assert.equal(out.simulated, true);
    assert.deepEqual(
      out.verdicts.map((v) => v.checklistId),
      checklist.items.map((i) => i.checklistId),
    );
  });
});

describe('输入 ↔ 调用合同绑定守卫', () => {
  it('payload.inputHash 与 contract 不符 → MODEL_INPUT_UNBOUND', async () => {
    const t = new SimulatedTransport();
    await assertKernelError(
      () => t.dispatch(contract(), aPayload({ inputHash: OTHER_HASH })),
      'MODEL_INPUT_UNBOUND',
    );
  });

  it('payload 非 64 位十六进制 inputHash → MODEL_INPUT_UNBOUND', async () => {
    const t = new SimulatedTransport();
    await assertKernelError(
      () => t.dispatch(contract(), aPayload({ inputHash: 'not-a-hash' as SimulatedAInput['inputHash'] })),
      'MODEL_INPUT_UNBOUND',
    );
  });

  it('payload.subjectKind 与 contract 不符 → MODEL_INPUT_UNBOUND', async () => {
    const t = new SimulatedTransport();
    await assertKernelError(
      () => t.dispatch(contract(), aPayload({ subjectKind: 'BROAD_ETF' })),
      'MODEL_INPUT_UNBOUND',
    );
  });

  it('payload 非对象 → MODEL_INPUT_UNBOUND', async () => {
    const t = new SimulatedTransport();
    await assertKernelError(() => t.dispatch(contract(), null), 'MODEL_INPUT_UNBOUND');
    await assertKernelError(() => t.dispatch(contract(), 'raw-string'), 'MODEL_INPUT_UNBOUND');
  });
});

describe('UnauthorizedTransport（真实端点占位，Gate-M 待授权）', () => {
  it('任何 dispatch 抛具名 MODEL_PROVIDER_UNAUTHORIZED，说明含 Owner 有界授权', async () => {
    const t = new UnauthorizedTransport();
    const err = await assertKernelError(() => t.dispatch(contract(), aPayload()), 'MODEL_PROVIDER_UNAUTHORIZED');
    assert.ok(err.message.includes('有界授权'), `错误说明应含授权指引: ${err.message}`);
  });

  it('describe 声明非模拟、无端点信息', () => {
    const t = new UnauthorizedTransport();
    assert.deepEqual(t.describe(), { provider: 'real-endpoint-unauthorized', simulated: false });
    assert.ok(!JSON.stringify(t.describe()).includes('http'));
  });
});

describe('selectTransport', () => {
  it('缺省与 simulated → SimulatedTransport', () => {
    assert.ok(selectTransport() instanceof SimulatedTransport);
    assert.equal(selectTransport().describe().simulated, true);
    assert.ok(selectTransport({ provider: 'simulated' }) instanceof SimulatedTransport);
  });

  it("provider:'real' 且无授权配置 → UnauthorizedTransport（带授权说明）", () => {
    const t = selectTransport({ provider: 'real' });
    assert.ok(t instanceof UnauthorizedTransport);
    assert.equal(t.describe().simulated, false);
    assert.ok(t.reason.includes('有界授权'));
  });
});
