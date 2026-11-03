/**
 * Lyra · 东财机构持仓面适配器单测（P1 W39: code-writer，B2）。不碰外网：
 * 桥响应用 fixture 注入（形态照 2026-10-25 容器真实探测：zlsj/list 原始 JSON 行——
 * 英文字段名、原生数值/字符串/null 值、REPORT_DATE 带 00:00:00 后缀），退避用记录式注入睡眠，
 * DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：B2（基金重仓面成立、北向面止于 2024-08-16 不可得的声明不在本文件断言范围）；
 * 时点冻结：availableAt=报告期季度末+92 天法定披露上界（来源无逐行披露日不编造）、
 * sourcePublishedAt=null；DATA-SOURCES §5/§6/§7；POINT-IN-TIME §2/§3/§4。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { asOfFacts, loadFact } from '../pintime/facts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import {
  BACKFILL_REVISION_NOTICE,
  AdapterError,
  TransientAdapterError,
  type BridgeResponse,
} from './adapter-types.js';
import { ConcurrencyGate, applyP1Migration, type BackoffSleeper } from './backoff.js';
import { p1RunId, type BridgeExecutor } from './baostock.js';
import {
  EMINSTITUTION_ADAPTER_VERSION,
  FUND_HOLD_CODE_FIELD,
  FUND_HOLD_REPORT_DATE_FIELD,
  InstitutionAdapter,
  fundHoldAvailableAt,
  mapFundHoldRowsToFacts,
  shanghaiDayStart,
  type InstitutionMapContext,
  type InstitutionRow,
} from './eminstitution.js';

const NOW = new Date('2026-10-26T03:00:00.000Z');

// ===== fixture（桥 stdout 形态；字段与取值形态照真实返回 2026-10-25 实测）=====

/** zlsj 两行（601318/000938 实测形态：原生数值、REPORT_DATE 带 00:00:00）+ 异常行两行。 */
const FUND_HOLD_ROWS: InstitutionRow[] = [
  {
    SECURITY_INNER_CODE: '1000000001',
    [FUND_HOLD_CODE_FIELD]: '601318',
    SECURITY_NAME_ABBR: '中国平安',
    [FUND_HOLD_REPORT_DATE_FIELD]: '2026-09-30 00:00:00',
    ORG_TYPE: '01',
    HOULD_NUM: 75,
    TOTAL_SHARES: 30385427,
    HOLD_VALUE: 1619239404.83,
    HOLDCHA: '减仓',
    HOLDCHA_NUM: -12345,
    HOLDCHA_RATIO: -1.5,
  },
  {
    SECURITY_INNER_CODE: '1000000002',
    [FUND_HOLD_CODE_FIELD]: '000938',
    SECURITY_NAME_ABBR: '紫光股份',
    [FUND_HOLD_REPORT_DATE_FIELD]: '2026-09-30 00:00:00',
    ORG_TYPE: '01',
    HOULD_NUM: 7,
    TOTAL_SHARES: 1928800,
    HOLD_VALUE: 59831376,
    HOLDCHA: '新进',
    HOLDCHA_NUM: null, // 新进行来源原生 null（不造数，原样保留）
    HOLDCHA_RATIO: null,
  },
  { [FUND_HOLD_CODE_FIELD]: '300750' }, // 缺报告期 → 具名拒绝（即便池外也不会映射）
  {
    [FUND_HOLD_CODE_FIELD]: '601318',
    [FUND_HOLD_REPORT_DATE_FIELD]: '2025-09-30 00:00:00', // 与请求期不一致 → 具名拒绝
  },
];

const CTX: InstitutionMapContext = {
  adapterVersion: EMINSTITUTION_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'a'.repeat(64),
};

// ===== 纯函数 =====

test('时间辅助：季度末日始与 +92 天法定披露上界（+08，与 emfund 同常量）', () => {
  assert.equal(shanghaiDayStart('2026-09-30'), '2026-09-29T16:00:00.000Z');
  // 2026-09-30 + 92 天 = 2026-12-31 00:00+08（覆盖基金年报 3 个月法定期限的保守上界）
  assert.equal(fundHoldAvailableAt('2026-09-30'), '2026-12-30T16:00:00.000Z');
  // 2024-12-31 + 92 天 = 2025-04-02 00:00+08
  assert.equal(fundHoldAvailableAt('2024-12-31'), '2025-04-01T16:00:00.000Z');
});

test('mapFundHoldRowsToFacts：季报口径 availableAt=季度末+92、原始 JSON 原样、异常行具名拒绝', () => {
  const { facts, rejections } = mapFundHoldRowsToFacts('2026-09-30', FUND_HOLD_ROWS, CTX);
  assert.equal(facts.length, 2);
  assert.deepEqual(rejections, [
    { rowIndex: 2, code: 'EMINSTITUTION_ROW_FIELDS_INVALID' },
    { rowIndex: 3, code: 'EMINSTITUTION_ROW_FIELDS_INVALID' },
  ]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'FUND_HOLD');
  assert.equal(first.subjectType, 'STOCK');
  assert.equal(first.subjectId, '601318');
  assert.equal(first.factId.startsWith('eminstitution-'), true);
  // 季报口径冻结：availableAt=季度末+92 天 00:00+08（法定披露上界，zlsj 无逐行披露日不编造）；
  // eventAt=validFrom=季度末 00:00+08；sourcePublishedAt=null。
  assert.equal(first.availableAt, '2026-12-30T16:00:00.000Z');
  assert.equal(first.eventAt, '2026-09-29T16:00:00.000Z');
  assert.equal(first.validFrom, '2026-09-29T16:00:00.000Z');
  assert.equal(first.validTo, null);
  assert.equal(first.sourcePublishedAt, null);
  assert.equal(first.supersedesFactId, null);
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv[FUND_HOLD_CODE_FIELD], '601318');
  assert.equal(tv[FUND_HOLD_REPORT_DATE_FIELD], '2026-09-30 00:00:00'); // 原样（不改写来源形态）
  assert.equal(tv['HOULD_NUM'], 75); // 原生数值不经 pandas（W37 缺陷类规避）
  assert.equal(tv['HOLD_VALUE'], 1619239404.83);
  assert.equal(tv['code'], '601318');
  // 新进行的 null 原样保留
  const second = facts[1]!.fact;
  assert.equal((second.typedValue as Record<string, unknown>)['HOLDCHA_NUM'], null);

  // factId 由原始行内容派生（不含抓取时刻）→ 同行重放同 factId（§6.5 去重前提）
  const again = mapFundHoldRowsToFacts('2026-09-30', FUND_HOLD_ROWS, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
  // 同股不同报告期 → 不同事实身份
  const q2 = mapFundHoldRowsToFacts('2026-06-30', [
    { ...FUND_HOLD_ROWS[0]!, [FUND_HOLD_REPORT_DATE_FIELD]: '2026-06-30 00:00:00' },
  ], CTX);
  assert.notEqual(q2.facts[0]!.fact.factId, first.factId);
  // 同行同内容、不同主体 → 不同事实身份
  const other = mapFundHoldRowsToFacts('2026-09-30', [{
    ...FUND_HOLD_ROWS[0]!,
    [FUND_HOLD_CODE_FIELD]: '600036',
  }], CTX);
  assert.notEqual(other.facts[0]!.fact.factId, first.factId);
});

test('非法请求：映射层非法报告期具名拒绝', () => {
  assert.throws(() => mapFundHoldRowsToFacts('2026-10-05', [], CTX), (e: unknown) => e instanceof AdapterError);
  assert.throws(() => mapFundHoldRowsToFacts('20260930', [], CTX), (e: unknown) => e instanceof AdapterError);
});

// ===== 适配器（fixture 注入 + 隔离 schema）=====

let admin: Pool;
let pool: Pool;
let schema: string;
let artifactsDir: string;
let store: ArtifactStore;

function fixtureExecutor(script: (args: string[]) => BridgeResponse | Promise<BridgeResponse>): BridgeExecutor {
  return async (args) => script(args);
}

function mkAdapter(exec: BridgeExecutor, sleeper?: BackoffSleeper, baseDelayMs?: number): InstitutionAdapter {
  return new InstitutionAdapter({
    pool,
    store,
    execBridge: exec,
    now: () => NOW,
    gate: new ConcurrencyGate(1),
    backoffSleeper: sleeper,
    backoffBaseDelayMs: baseDelayMs,
  });
}

before(async () => {
  admin = createPool();
  schema = p1RunId();
  await applySchema(admin, schema);
  await applyP1Migration(admin, schema);
  pool = createPool({ schema });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w39-eminstitution-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchFundHold：入库 + as-of 截点过滤（季度末+92 前不可见）+ fullRows 申报 + R4 随行 + 空集如实', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['fund_hold', '20260930', '601318,000938']);
    calls += 1;
    return {
      ok: true,
      rows: FUND_HOLD_ROWS,
      meta: { resource: 'fund_hold', fullRows: 1556 },
    } as unknown as BridgeResponse;
  }));
  const r1 = await adapter.fetchFundHold('20260930', ['601318', '000938']);
  assert.equal(r1.adapterVersion, EMINSTITUTION_ADAPTER_VERSION);
  assert.equal(r1.scope, 'eminstitution:fund_hold:2026-09-30');
  assert.equal(r1.rowCount, 4);
  assert.equal(r1.fullRowCount, 1556, '桥池过滤前全市场行数如实申报');
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 2);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256); // 原件写入即校验读回
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 4);

  // as-of：上界（2026-09-30+92=2026-12-31 00:00+08）之前不可见（披露在途的保守口径——
  // 事实已在库但 as-of 读回不可见，无泄漏）；上界后可见。
  const early = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '601318', factKind: 'FUND_HOLD', asOf: new Date('2026-12-30T15:00:00.000Z'),
  });
  assert.equal(early.length, 0);
  const late = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '601318', factKind: 'FUND_HOLD', asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.equal(late.length, 1);
  assert.equal(late[0]!.availableAt, fundHoldAvailableAt('2026-09-30'));

  // 重放幂等：同 rows 同 adapter 版本 → 全部 IDENTICAL
  const r2 = await adapter.fetchFundHold('20260930', ['601318', '000938']);
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2);
  assert.equal(calls, 2, '每次 fetch 恰一次桥调用（fixture 计数）');

  // 空集：rows=[] 如实空原件入档、0 事实、0 拒绝
  const empty = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] } as BridgeResponse)));
  const r3 = await empty.fetchFundHold('20260630', ['600036']);
  assert.equal(r3.rowCount, 0);
  assert.equal(r3.fullRowCount, 0, 'meta 缺失时回退行数');
  assert.equal(r3.insertedFactIds.length, 0);
  assert.equal(r3.rejectedRows.length, 0);
  const bytes3 = await store.readBytes(r3.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes3)) as unknown[]).length, 0);
});

test('fetchFundHold：追加披露聚合值变化接 supersedes 链——不覆盖原件、as-of 链头（当前源视图）胜出', async () => {
  // 口径说明：availableAt 由报告期派生，同报告期聚合值变化（披露在途追加/更正）与原行可得性
  // 相同——链头即来源当前视图（zlsj 可整期重刷，R4 声明覆盖）；更正不覆盖：旧事实原样保留。
  const v1: InstitutionRow = {
    [FUND_HOLD_CODE_FIELD]: '600036',
    [FUND_HOLD_REPORT_DATE_FIELD]: '2025-12-31 00:00:00',
    HOULD_NUM: 100,
  };
  const v2: InstitutionRow = {
    [FUND_HOLD_CODE_FIELD]: '600036',
    [FUND_HOLD_REPORT_DATE_FIELD]: '2025-12-31 00:00:00',
    HOULD_NUM: 120, // 追加披露后聚合值变化
  };
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor(() => {
    const rows = calls === 0 ? [v1] : [v1, v2];
    calls += 1;
    return { ok: true, rows } as BridgeResponse;
  }));

  const r1 = await adapter.fetchFundHold('20251231', ['600036']);
  assert.equal(r1.insertedFactIds.length, 1);
  const oldId = r1.insertedFactIds[0]!;

  // 变化批次：同报告期新值 → 新事实接 supersedes；旧行原样保留（不同 factId，不覆盖）
  const r2 = await adapter.fetchFundHold('20251231', ['600036']);
  assert.equal(r2.insertedFactIds.length, 1);
  assert.equal(r2.identicalFactIds.length, 1, '同内容旧行重放为 IDENTICAL');
  const newId = r2.insertedFactIds[0]!;
  assert.notEqual(newId, oldId);

  const loadedNew = await loadFact(pool, newId);
  assert.equal(loadedNew?.supersedesFactId, oldId, '新事实指向旧事实');
  const loadedOld = await loadFact(pool, oldId);
  assert.ok(loadedOld !== null, '旧事实不覆盖、原样保留');
  assert.equal(loadedOld?.supersedesFactId, null);

  // as-of 上界（2025-12-31+92=2026-04-02 00:00+08）之前：均不可见（保守）
  const early = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600036', factKind: 'FUND_HOLD', asOf: new Date('2026-04-01T00:00:00.000Z'),
  });
  assert.equal(early.length, 0);
  // 上界后：链头胜出，只读回当前源视图值
  const lateRead = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600036', factKind: 'FUND_HOLD', asOf: new Date('2026-06-01T00:00:00.000Z'),
  });
  assert.equal(lateRead.length, 1);
  assert.equal(lateRead[0]!.factId, newId);
  assert.equal((lateRead[0]!.typedValue as Record<string, unknown>)['HOULD_NUM'], 120);
});

test('fetchFundHold：非法入参具名拒绝（不发起桥调用）；瞬态桥失败退避重试后成功', async () => {
  const adapter = mkAdapter(fixtureExecutor(() => {
    throw new Error('should not be called');
  }));
  await assert.rejects(adapter.fetchFundHold('2026-10-05', ['601318']), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchFundHold('202609305', ['601318']), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchFundHold('20260930', ['60131']), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchFundHold('20260930', ['sh601318']), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchFundHold('20260930', []), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchFundHold('20260930', ['601318', '601318']), (e: unknown) => e instanceof AdapterError);

  // 瞬态桥失败（坏输出）→ 退避重试同 scope；第二次成功（用未在他测试入库的 600519，避开去重）
  const sleeps: number[] = [];
  const sleeper: BackoffSleeper = { sleep: async (ms: number) => { sleeps.push(ms); } };
  let attempts = 0;
  const flaky = mkAdapter(fixtureExecutor(() => {
    attempts += 1;
    if (attempts === 1) throw new TransientAdapterError('EMINSTITUTION_QUERY_FAILED', 'HTTP 502');
    return {
      ok: true,
      rows: [{ ...FUND_HOLD_ROWS[0]!, [FUND_HOLD_CODE_FIELD]: '600519' }],
    } as BridgeResponse;
  }), sleeper, 1000);
  const r = await flaky.fetchFundHold('20260930', ['600519']);
  assert.equal(r.insertedFactIds.length, 1);
  assert.equal(attempts, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1000, '首次等待 = baseDelayMs');
});
