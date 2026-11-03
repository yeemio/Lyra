/**
 * Lyra · 任意历史日期封存验证 harness 单测（P1 W6）。不碰网络：本地 lyra-pg 隔离 schema
 * + 合成事实（原件经 ArtifactStore 真实入临时目录），故意埋截点后事实验证不泄漏。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import type { TimePointFact } from '../contracts.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import { cutoffOfDate, sealAndVerify, type SealSubjectSpec } from './seal-any-date.js';

const SCHEMA = `w6_seal_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
let admin: Pool;
let pool: Pool;
let store: ArtifactStore;
let artifactsDir: string;
let artifactHash: string;

before(async () => {
  admin = createPool();
  await applySchema(admin, SCHEMA);
  pool = createPool({ schema: SCHEMA });
  artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w6-seal-'));
  store = new ArtifactStore(artifactsDir);
  artifactHash = (await store.put(new TextEncoder().encode('w6-seal-fixture-artifact'), 'application/json', '2026-10-25T00:00:00Z')).sha256;
});

after(async () => {
  await dropSchema(admin, SCHEMA).catch(() => {});
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
});

const CUTOFF = '2015-06-30T07:00:00.000Z'; // 2015-06-30 15:00+08

let seq = 0;
function fact(overrides: Partial<TimePointFact>): TimePointFact {
  seq += 1;
  return {
    factId: `w6-seal-fact-${seq}`,
    subjectType: 'STOCK',
    subjectId: '600519',
    factKind: 'DAILY_BAR',
    typedValue: { seq },
    validFrom: null,
    validTo: null,
    eventAt: null,
    sourcePublishedAt: null,
    firstObservedAt: '2026-10-25T00:00:00.000Z',
    availableAt: '2015-06-30T07:00:00.000Z',
    supersedesFactId: null,
    artifactSha256: artifactHash,
    adapterVersion: 'w6-seal-test',
    ...overrides,
  };
}

const SPEC: SealSubjectSpec = { subjectKind: 'STOCK', subject: '600519', subjectId: '600519' };

test('cutoffOfDate：历史日期 → 该日 15:00 Asia/Shanghai', () => {
  assert.equal(cutoffOfDate('2015-06-30'), CUTOFF);
  assert.equal(cutoffOfDate('2026-10-22'), '2026-10-22T07:00:00.000Z');
  assert.throws(() => cutoffOfDate('2015-6-30'));
});

test('sealAndVerify：截点前后事实切分正确、verifySeal 绿、零泄漏、读回样例与缺口入 manifest', async () => {
  const inserted: TimePointFact[] = [
    // 截点前可见面
    fact({ factKind: 'DAILY_BAR', typedValue: { date: '2015-06-29' }, availableAt: '2015-06-29T07:00:00.000Z', eventAt: '2015-06-29T07:00:00.000Z' }),
    fact({ factKind: 'DAILY_BAR', typedValue: { date: '2015-06-30' }, availableAt: CUTOFF, eventAt: CUTOFF }),
    fact({ factKind: 'ADJUST_FACTOR', typedValue: { dividOperateDate: '2015-06-25', adjustFactor: '1.100000' }, availableAt: '2015-06-25T07:00:00.000Z' }),
    fact({ factKind: 'FINANCIAL', typedValue: { pubDate: '2015-06-20', statDate: '2015-03-31', bsQuery: 'profit' }, availableAt: '2015-06-20T16:00:00.000Z', eventAt: '2015-03-31T16:00:00.000Z' }),
    fact({ factKind: 'INDEX_MEMBERSHIP', typedValue: { bsIndex: 'hs300', updateDate: '2015-06-30' }, availableAt: CUTOFF }),
    fact({ factKind: 'ANNOUNCEMENT', typedValue: { title: '2015 年度分配预案' }, availableAt: '2015-06-30T01:00:00.000Z' }),
    // 截点后（故意埋入）：不得进封存
    fact({ factKind: 'DAILY_BAR', typedValue: { date: '2015-07-01' }, availableAt: '2015-07-01T07:00:00.000Z' }),
    fact({ factKind: 'FINANCIAL', typedValue: { pubDate: '2015-08-28', statDate: '2015-06-30', bsQuery: 'profit' }, availableAt: '2015-08-28T16:00:00.000Z' }),
    // 当前快照类：availableAt=抓取时刻（2026）→ 截点后，不进封存
    fact({ factKind: 'STOCK_BASIC', typedValue: { code_name: '贵州茅台' }, availableAt: '2026-10-25T03:00:00.000Z' }),
    fact({ factKind: 'INDUSTRY_CLASS_VERSION', typedValue: { industry: 'C15酒、饮料和精制茶制造业' }, availableAt: '2026-10-25T03:00:00.000Z' }),
  ];
  for (const f of inserted) await insertFact(pool, f);

  const gaps = ['SW2014_GAP：夹具缺口文本'];
  const report = await sealAndVerify(pool, store, SPEC, '2015-06-30', gaps, { method: 'mv-w6', adapter: 'av-w6', planAuth: 'pv-w6' });

  assert.equal(report.cutoff, CUTOFF);
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.factsChecked, 6, '只封存 available_at ≤ cutoff 的 6 条');
  assert.ok(report.verify.artifactsChecked >= 1);
  assert.equal(report.leakageViolations, 0);
  assert.deepEqual(report.gaps, gaps, '缺口写入 manifest 并回读');
  assert.deepEqual(report.factKindCounts, {
    DAILY_BAR: 2, ADJUST_FACTOR: 1, FINANCIAL: 1, INDEX_MEMBERSHIP: 1, ANNOUNCEMENT: 1,
  });
  assert.deepEqual(report.content.dailyBars, { count: 2, first: '2015-06-29', last: '2015-06-30' }, '历史日期读回可用');
  assert.deepEqual(report.content.adjustFactors?.dates, ['2015-06-25']);
  assert.deepEqual(report.content.financials?.statDates, ['2015-03-31'], '截点后财报不进样例');
  assert.deepEqual(report.content.memberships?.indexDays, ['hs300:2015-06-30']);
  assert.deepEqual(report.content.announcements?.titles, ['2015 年度分配预案']);
  assert.equal(report.content.stockBasic, false, '当前快照 availableAt=抓取时刻 → 截点后不可见（诚实）');
  assert.equal(report.content.industryClass, false);

  // manifest 落库可读回：封存 id 与 hash 一致（verifySeal 已重算；此处核对报告字段自洽）
  assert.match(report.sealId, /^[0-9a-f-]{36}$/);
  assert.match(report.manifestHash, /^[a-f0-9]{64}$/);

  // 同日同材料再封：幂等复用同一封存（W26：不再追加同键重复行）；verifySeal 仍绿（复用不改写）
  const again = await sealAndVerify(pool, store, SPEC, '2015-06-30', gaps, { method: 'mv-w6', adapter: 'av-w6', planAuth: 'pv-w6' });
  assert.equal(again.verify.factsChecked, 6);
  assert.equal(again.sealId, report.sealId, '同材料幂等复用：同 sealId，不追加重复行');
  assert.equal(again.manifestHash, report.manifestHash);
});
