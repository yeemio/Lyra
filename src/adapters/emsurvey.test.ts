/**
 * Lyra · 东财机构调研记录适配器单测（P2 W41b: code-writer，C2/D5-D7）。不碰外网：
 * 桥响应用 fixture 注入（形态照 RPT_ORG_SURVEY columns=ALL 真实形态（probe6 V1 实测键集）：英文字段名、
 * 原生字符串/null 值、日期带 00:00:00 后缀、NUMBERNEW 活动内序号、桥附 *_ISO 前缀列），
 * 退避用记录式注入睡眠，DB 用本地 lyra-pg 隔离 schema。
 * 合同判定：C2（调研记录面成立；9701 反爬归瞬态的退避行为）；时点冻结：
 * availableAt=披露日次日 00:00+08、sourcePublishedAt=披露日 00:00+08、eventAt=validFrom=
 * 调研日 00:00+08（embalance 逐行 NOTICE_DATE 先例）；登记记录事实不接 supersedes
 * （LHB 先例）；行情快照列防泄漏（EMSURVEY_ROW_QUOTE_COLUMN_LEAK）。
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
  EMSURVEY_ADAPTER_VERSION,
  SURVEY_NOTICE_ISO,
  SURVEY_NUMBERNEW_FIELD,
  SURVEY_RECEIVE_START_ISO,
  SurveyAdapter,
  mapSurveyRowsToFacts,
  shanghaiDayStart,
  shanghaiNextDayStart,
  type SurveyMapContext,
  type SurveyRow,
} from './emsurvey.js';

const NOW = new Date('2026-10-26T03:00:00.000Z');

// ===== fixture（桥 stdout 形态；字段与取值形态照 RPT_ORG_SURVEY columns=ALL 真实形态
// （接待日/公告日带 00:00:00、NUMBERNEW 序号）+ 桥附 *_ISO 前缀）=====

/** 两行有效（同一股两次不同调研活动）+ 异常行三行 + 窗界外一行。 */
const SURVEY_ROWS: SurveyRow[] = [
  {
    SECURITY_CODE: '601318',
    SECURITY_NAME_ABBR: '中国平安',
    NOTICE_DATE: '2026-10-20 00:00:00',
    RECEIVE_START_DATE: '2026-10-18 00:00:00',
    [SURVEY_NUMBERNEW_FIELD]: 1,
    RECEIVE_PLACE: '深圳',
    RECEIVE_WAY_EXPLAIN: '特定对象调研',
    RECEPTIONIST: '董事会秘书',
    [SURVEY_RECEIVE_START_ISO]: '2026-10-18',
    [SURVEY_NOTICE_ISO]: '2026-10-20',
  },
  {
    SECURITY_CODE: '601318',
    SECURITY_NAME_ABBR: '中国平安',
    NOTICE_DATE: '2026-09-12 00:00:00',
    RECEIVE_START_DATE: '2026-09-10 00:00:00',
    [SURVEY_NUMBERNEW_FIELD]: 1,
    RECEIVE_PLACE: '电话会议',
    RECEIVE_WAY_EXPLAIN: '业绩说明会',
    RECEPTIONIST: '副总经理,董事会秘书',
    [SURVEY_RECEIVE_START_ISO]: '2026-09-10',
    [SURVEY_NOTICE_ISO]: '2026-09-12',
  },
  { SECURITY_CODE: '601318', [SURVEY_NOTICE_ISO]: '2026-10-20' }, // 缺接待日 ISO → 具名拒绝
  {                                                                 // 缺披露日 ISO → 具名拒绝（availableAt 不编造）
    SECURITY_CODE: '601318',
    [SURVEY_RECEIVE_START_ISO]: '2026-10-18',
  },
  { [SURVEY_RECEIVE_START_ISO]: '2026-10-18', [SURVEY_NOTICE_ISO]: '2026-10-20' }, // 缺代码 → 具名拒绝
  {
    // 窗界外行（接待日 2024-09-01 < 窗界 2024-10-25）：桥过滤下不会返回；fixture 用于
    // 证明映射层纵深防御（桥过滤失效时窗外行也不入事实）
    SECURITY_CODE: '601318',
    NOTICE_DATE: '2024-09-03 00:00:00',
    RECEIVE_START_DATE: '2024-09-01 00:00:00',
    [SURVEY_NUMBERNEW_FIELD]: 1,
    [SURVEY_RECEIVE_START_ISO]: '2024-09-01',
    [SURVEY_NOTICE_ISO]: '2024-09-03',
  },
];

const CTX: SurveyMapContext = {
  adapterVersion: EMSURVEY_ADAPTER_VERSION,
  fetchedAt: NOW.toISOString(),
  artifactSha256: 'b'.repeat(64),
};

// ===== 纯函数 =====

test('时间辅助：调研日/披露日 00:00+08 与披露日次日 00:00+08', () => {
  assert.equal(shanghaiDayStart('2026-10-18'), '2026-10-17T16:00:00.000Z');
  assert.equal(shanghaiDayStart('2026-10-20'), '2026-10-19T16:00:00.000Z');
  // 披露日次日 00:00+08 = 披露日 08:00 前一 UTC 日 16:00Z + 1 天
  assert.equal(shanghaiNextDayStart('2026-10-20'), '2026-10-20T16:00:00.000Z');
});

test('mapSurveyRowsToFacts：披露口径五时间字段、原始 JSON 原样、异常行具名拒绝', () => {
  const { facts, rejections, outOfWindow } = mapSurveyRowsToFacts('601318', SURVEY_ROWS, CTX);
  assert.equal(facts.length, 3, '无窗界参数时全历史行照常映射（窗外行也在内）');
  assert.equal(outOfWindow.length, 0);
  assert.deepEqual(rejections, [
    { rowIndex: 2, code: 'EMSURVEY_ROW_FIELDS_INVALID' },
    { rowIndex: 3, code: 'EMSURVEY_ROW_FIELDS_INVALID' },
    { rowIndex: 4, code: 'EMSURVEY_ROW_FIELDS_INVALID' },
  ]);

  const first = facts[0]!.fact;
  assert.equal(first.factKind, 'SURVEY_RECORD');
  assert.equal(first.subjectType, 'STOCK');
  assert.equal(first.subjectId, '601318');
  assert.equal(first.factId.startsWith('emsurvey-'), true);
  // 披露口径冻结：availableAt=NOTICE_DATE 次日 00:00+08（保守 D+1，=2026-10-21 00:00+08）；
  // sourcePublishedAt=NOTICE_DATE 00:00+08；eventAt=validFrom=RECEIVE_START_DATE 00:00+08。
  assert.equal(first.availableAt, '2026-10-20T16:00:00.000Z');
  assert.equal(first.sourcePublishedAt, '2026-10-19T16:00:00.000Z');
  assert.equal(first.eventAt, '2026-10-17T16:00:00.000Z');
  assert.equal(first.validFrom, '2026-10-17T16:00:00.000Z');
  assert.equal(first.validTo, null);
  assert.equal(first.supersedesFactId, null, '登记记录事实不接 supersedes（LHB 先例）');
  const tv = first.typedValue as Record<string, unknown>;
  assert.equal(tv['SECURITY_CODE'], '601318');
  assert.equal(tv['NOTICE_DATE'], '2026-10-20 00:00:00'); // 原样（不改写来源形态）
  assert.equal(tv[SURVEY_RECEIVE_START_ISO], '2026-10-18');
  assert.equal(tv[SURVEY_NUMBERNEW_FIELD], 1);
  assert.equal(tv['code'], '601318');
  // objectKey=接待日|公告日|NUMBERNEW（活动登记记录自然键；两次活动两个对象，不互相遮蔽）
  assert.equal(facts[0]!.objectKey, '2026-10-18|2026-10-20|1');
  assert.equal(facts[1]!.objectKey, '2026-09-10|2026-09-12|1');
  assert.notEqual(first.factId, facts[1]!.fact.factId);

  // factId 由原始行内容派生（不含抓取时刻）→ 同行重放同 factId（§6.5 去重前提）
  const again = mapSurveyRowsToFacts('601318', SURVEY_ROWS, CTX);
  assert.deepEqual(
    again.facts.map((f) => f.fact.factId).sort(),
    facts.map((f) => f.fact.factId).sort(),
  );
  // 同行同内容、不同主体 → 不同事实身份
  const other = mapSurveyRowsToFacts('600036', [
    { ...SURVEY_ROWS[0]!, SECURITY_CODE: '600036' },
  ], CTX);
  assert.notEqual(other.facts[0]!.fact.factId, first.factId);
});

test('mapSurveyRowsToFacts：行情快照列（CLOSE_PRICE/CHANGE_RATE）入行 → 防泄漏具名拒绝', () => {
  const leaked: SurveyRow[] = [{
    ...SURVEY_ROWS[0]!,
    CLOSE_PRICE: 13.87, // 抓取时点当前行情——前视，绝不入事实
    CHANGE_RATE: 2.14,
  }];
  const { facts, rejections } = mapSurveyRowsToFacts('601318', leaked, CTX);
  assert.equal(facts.length, 0);
  assert.deepEqual(rejections, [{ rowIndex: 0, code: 'EMSURVEY_ROW_QUOTE_COLUMN_LEAK' }]);
});

test('非法请求：映射层非法裸码具名拒绝（不映射任何行）', () => {
  assert.throws(() => mapSurveyRowsToFacts('60131', [], CTX), (e: unknown) => e instanceof AdapterError);
  assert.throws(() => mapSurveyRowsToFacts('sh601318', [], CTX), (e: unknown) => e instanceof AdapterError);
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

function mkAdapter(exec: BridgeExecutor, sleeper?: BackoffSleeper, baseDelayMs?: number): SurveyAdapter {
  return new SurveyAdapter({
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
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w41b-emsurvey-'));
  store = new ArtifactStore(artifactsDir);
});

after(async () => {
  await dropSchema(admin, schema).catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true });
  await admin.end();
  await pool.end();
});

test('fetchSurvey：入库 + as-of 披露截点过滤（披露日+1 前不可见）+ R4 随行 + 空集如实', async () => {
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor((args) => {
    assert.deepEqual(args, ['survey', '601318', '20241024'], '桥三 term 形态：窗界=windowFrom 前一日（严格大于 → 捕获 ≥ 窗界）');
    calls += 1;
    return {
      ok: true,
      rows: SURVEY_ROWS,
      meta: { resource: 'survey', code: '601318', rows: 6, pages: 1 },
    } as unknown as BridgeResponse;
  }));
  const r1 = await adapter.fetchSurvey('601318', '2024-10-25');
  assert.equal(r1.adapterVersion, EMSURVEY_ADAPTER_VERSION);
  assert.equal(r1.scope, 'emsurvey:survey:601318');
  assert.equal(r1.rowCount, 6);
  assert.equal(r1.windowExcludedRows, 1, '窗界外行（2024-09-01 接待 < 2024-10-25 窗界）具名计数、不入事实');
  assert.equal(r1.insertedFactIds.length, 2);
  assert.equal(r1.rejectedRows.length, 3);
  assert.ok(r1.notices.includes(BACKFILL_REVISION_NOTICE), 'R4 声明原文随行');
  const bytes = await store.readBytes(r1.artifact.sha256); // 原件写入即校验读回（窗外行原件保留）
  assert.equal((JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length, 6);

  // as-of：每条记录按自身披露日次日（保守 D+1）独立可见——record2（公告 2026-09-12，
  // 上界 2026-09-12T16:00Z）先可见；record1（公告 2026-10-20，上界 2026-10-20T16:00Z）后可见。
  // 上界之前事实已在库但 as-of 读回不可见（无泄漏）。
  const early = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '601318', factKind: 'SURVEY_RECORD', asOf: new Date('2026-09-12T15:59:00.000Z'),
  });
  assert.equal(early.length, 0);
  const mid = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '601318', factKind: 'SURVEY_RECORD', asOf: new Date('2026-09-12T16:00:00.000Z'),
  });
  assert.equal(mid.length, 1, '仅公告 2026-09-12 的活动可见');
  const late = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '601318', factKind: 'SURVEY_RECORD', asOf: new Date('2026-10-20T16:00:00.000Z'),
  });
  assert.equal(late.length, 2);

  // 重放幂等：同 rows 同 adapter 版本 → 全部 IDENTICAL
  const r2 = await adapter.fetchSurvey('601318', '2024-10-25');
  assert.equal(r2.insertedFactIds.length, 0);
  assert.equal(r2.identicalFactIds.length, 2);
  assert.equal(calls, 2, '每次 fetch 恰一次桥调用（fixture 计数）');

  // 空集：rows=[] 如实空原件入档、0 事实、0 拒绝
  const empty = mkAdapter(fixtureExecutor(() => ({ ok: true, rows: [] } as BridgeResponse)));
  const r3 = await empty.fetchSurvey('600036', '2024-10-25');
  assert.equal(r3.rowCount, 0);
  assert.equal(r3.insertedFactIds.length, 0);
  assert.equal(r3.rejectedRows.length, 0);
  const bytes3 = await store.readBytes(r3.artifact.sha256);
  assert.equal((JSON.parse(new TextDecoder().decode(bytes3)) as unknown[]).length, 0);
});

test('fetchSurvey：登记记录不接 supersedes——同对象键（接待日|公告日|NUMBERNEW）不同内容两行并存、均 as-of 可读', async () => {
  // 源侧更正/补录以追加记录形态如实入库（LHB 先例）；消费侧计数语义不属适配器。
  const v1: SurveyRow = {
    SECURITY_CODE: '600519',
    NOTICE_DATE: '2026-08-12 00:00:00',
    RECEIVE_START_DATE: '2026-08-10 00:00:00',
    [SURVEY_NUMBERNEW_FIELD]: 1,
    [SURVEY_RECEIVE_START_ISO]: '2026-08-10',
    [SURVEY_NOTICE_ISO]: '2026-08-12',
    RECEPTIONIST: '董事会秘书',
  };
  const v2: SurveyRow = { // 同（接待日|公告日|NUMBERNEW），接待人员文本更正
    ...v1,
    RECEPTIONIST: '副总经理,董事会秘书',
  };
  let calls = 0;
  const adapter = mkAdapter(fixtureExecutor(() => {
    const rows = calls === 0 ? [v1] : [v1, v2];
    calls += 1;
    return { ok: true, rows } as BridgeResponse;
  }));

  const r1 = await adapter.fetchSurvey('600519', '2024-10-25');
  assert.equal(r1.insertedFactIds.length, 1);
  const oldId = r1.insertedFactIds[0]!;

  const r2 = await adapter.fetchSurvey('600519', '2024-10-25');
  assert.equal(r2.insertedFactIds.length, 1, '同键不同内容 = 新事实入库（不接 supersedes）');
  assert.equal(r2.identicalFactIds.length, 1, '同内容旧行重放为 IDENTICAL');
  const newId = r2.insertedFactIds[0]!;
  assert.notEqual(newId, oldId);
  const loadedNew = await loadFact(pool, newId);
  assert.equal(loadedNew?.supersedesFactId, null);
  const loadedOld = await loadFact(pool, oldId);
  assert.ok(loadedOld !== null, '旧事实原样保留（修正不覆盖）');
  assert.equal(loadedOld?.supersedesFactId, null);

  const late = await asOfFacts(pool, {
    subjectType: 'STOCK', subjectId: '600519', factKind: 'SURVEY_RECORD', asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.equal(late.length, 2, '两条记录均 as-of 可读（不互相遮蔽）');
});

test('fetchSurvey：非法入参具名拒绝（不发起桥调用）；瞬态桥失败（来源 9701）退避重试后成功', async () => {
  const adapter = mkAdapter(fixtureExecutor(() => {
    throw new Error('should not be called');
  }));
  await assert.rejects(adapter.fetchSurvey('60131', '2024-10-25'), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchSurvey('sh601318', '2024-10-25'), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchSurvey('601318', '20241025'), (e: unknown) => e instanceof AdapterError);
  await assert.rejects(adapter.fetchSurvey('601318', '2024-13-40'), (e: unknown) => e instanceof AdapterError);

  // 瞬态桥失败（来源 9701 繁忙）→ 退避重试同 scope；第二次成功（用未在他测试入库的 000938）
  const sleeps: number[] = [];
  const sleeper: BackoffSleeper = { sleep: async (ms: number) => { sleeps.push(ms); } };
  let attempts = 0;
  const flaky = mkAdapter(fixtureExecutor(() => {
    attempts += 1;
    if (attempts === 1) throw new TransientAdapterError('EMSURVEY_QUERY_FAILED', "来源返回失败 code=9701 message='服务器繁忙'");
    return {
      ok: true,
      rows: [{
        SECURITY_CODE: '000938',
        NOTICE_DATE: '2026-09-03 00:00:00',
        RECEIVE_START_DATE: '2026-09-01 00:00:00',
        [SURVEY_NUMBERNEW_FIELD]: 1,
        [SURVEY_RECEIVE_START_ISO]: '2026-09-01',
        [SURVEY_NOTICE_ISO]: '2026-09-03',
      }],
    } as unknown as BridgeResponse;
  }), sleeper, 1000);
  const r = await flaky.fetchSurvey('000938', '2024-10-25');
  assert.equal(r.insertedFactIds.length, 1);
  assert.equal(attempts, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1000, '首次等待 = baseDelayMs');
});
