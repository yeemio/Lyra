import { researchJInputHash } from './validation.js';
import { researchMaterial } from './requests.js';
/**
 * Lyra · 研究输入组装器 + 报告视图单测（P2 W11）。不碰网络；DB 用隔离 schema
 * （每次运行独立 schema + 临时原件目录），与 pintime.test.ts 同款夹具纪律。
 *
 * 覆盖：八维/七维材料映射与 coverage 三态、时点纪律（截点后事实不进包）、分层预算
 * （降级 / INPUT_OVER_BUDGET 阻断不截断 / L0 不可裁剪）、inputHash 与原件读回一致、
 * validateResearchInputPackage 程序校验、分层读回、SUBJECT_NOT_IN_POOL、报告视图与渲染。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { after, before, test } from 'node:test';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { KernelError, type TimePointFact } from '../contracts.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import { readConclusion, persistConclusion } from '../db/conclusion.js';
import { simulatedModelA, simulatedModelJ } from './simulated.js';
import { deriveChecklist } from './checklist.js';
import {
  assembleResearchInput,
  renderInputLayers,
  validateResearchInputPackage,
  type AssembleResearchInputOptions,
  type ResearchInputPackage,
} from './inputs.js';
import { buildReportView, renderReportText, REPORT_DISCLAIMER } from './report.js';

// ===== 隔离环境 =====

const SCHEMA = `w11_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;
let artifactDir: string;
let store: ArtifactStore;
let poolInfoFile: string;

let annIds: Record<string, string> = {};
let stockBasicFutureId = '';
let stockPackage: ResearchInputPackage | null = null;
let etfPackage: ResearchInputPackage | null = null;

const CUTOFF = '2022-06-30T07:00:00.000Z'; // 2022-06-30 15:00 +08（收盘口径）
const DAY = 86_400_000;

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
  artifactDir = await mkdtemp(join(tmpdir(), 'lyra-w11-artifacts-'));
  store = new ArtifactStore(artifactDir);
  // 池信息夹具（合成池：600519 + 510300）
  poolInfoFile = join(artifactDir, 'research-pool.json');
  await writeFile(
    poolInfoFile,
    JSON.stringify({
      frozenAt: '2026-10-25',
      stocks: [{ rank: 1, code: '600519', name: '贵州茅台', swL1IndexCode: '801120', swL1Name: '食品饮料' }],
      etfs: [{ code: '510300', name: '沪深300ETF', tracks: '沪深300(000300)' }],
    }),
    'utf8',
  );
  await seedUniverse();
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
  await rm(artifactDir, { recursive: true, force: true });
});

// ===== 合成宇宙 =====

const iso = (day: string, hour = 0): string => new Date(`${day}T00:00:00.000Z`).toISOString();

let factSeq = 0;
async function addFact(base: {
  subjectType: 'STOCK' | 'ETF' | 'INDEX';
  subjectId: string;
  factKind: string;
  typedValue: Record<string, unknown>;
  availableAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  eventAt?: string | null;
  sourcePublishedAt?: string | null;
  supersedesFactId?: string | null;
}): Promise<string> {
  factSeq += 1;
  const factId = `w11-${factSeq}-${base.factKind.toLowerCase()}`;
  const ref = await store.put(new TextEncoder().encode(`w11:${factId}`), 'application/json', base.availableAt);
  const fact: TimePointFact = {
    factId,
    subjectType: base.subjectType,
    subjectId: base.subjectId,
    factKind: base.factKind,
    typedValue: base.typedValue,
    validFrom: base.validFrom ?? null,
    validTo: base.validTo ?? null,
    eventAt: base.eventAt ?? null,
    sourcePublishedAt: base.sourcePublishedAt ?? null,
    firstObservedAt: base.availableAt,
    availableAt: base.availableAt,
    supersedesFactId: base.supersedesFactId ?? null,
    artifactSha256: ref.sha256,
    adapterVersion: 'test@w11',
  };
  await insertFact(pool, fact);
  return factId;
}

const bar = (date: string, close: string, withTurn = true): Record<string, unknown> => ({
  code: 'sh.600519', date, open: close, high: close, low: close, close, preclose: close,
  volume: '100000', amount: '1000000.0000', isST: '0', tradestatus: '1', adjustflag: '3',
  ...(withTurn ? { turn: '0.500000', pctChg: '1.000000' } : {}),
});

const ANN_HIT_IN_WINDOW = 'w11-ann-hit'; // 预期差命中（窗口内）
const ANN_OVERLAP = 'w11-ann-overlap'; // 同时含 D3/D4 关键词 → 只归 D3
const ANN_EVENT_IN_WINDOW = 'w11-ann-event'; // 事件命中
const ANN_HIT_OLD = 'w11-ann-old'; // 命中但窗口外
const ANN_NON_HIT = 'w11-ann-nonhit'; // 窗口内不命中
const ANN_FUTURE = 'w11-ann-future'; // 截点后（时点纪律：不得进包）
const STOCK_BASIC_FUTURE = 'w11-basic-future'; // 截点后当前快照

async function seedUniverse(): Promise<void> {
  // ---- 主板个股 600519 ----
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', typedValue: bar('2022-06-28', '1305.0000'), availableAt: iso('2022-06-28'), eventAt: iso('2022-06-28') });
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', typedValue: bar('2022-06-29', '1309.0000'), availableAt: iso('2022-06-29'), eventAt: iso('2022-06-29') });
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'DAILY_BAR', typedValue: { ...bar('2022-06-30', '1335.0000'), turn: undefined as unknown as string } , availableAt: iso('2022-06-30'), eventAt: iso('2022-06-30') });
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'ADJUST_FACTOR', typedValue: { code: 'sh.600519', dividOperateDate: '2022-06-01', adjustFactor: '2.500000' }, availableAt: iso('2022-06-01') });
  // 验收低危①补钉：龙虎榜前视列剔除回归夹具（上榜后N日 + 序号 + forwardLookingColumns 必须被材料层剔除）
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'DRAGON_TIGER', typedValue: { 代码: '600519', 名称: '贵州茅台', 上榜日: '2022-06-29', 解读: '', 上榜后1日: '1.23', 上榜后2日: '2.34', 上榜后5日: '5.67', 上榜后10日: '10.11', 序号: '7', forwardLookingColumns: ['上榜后1日', '上榜后2日', '上榜后5日', '上榜后10日'] }, availableAt: iso('2022-06-29'), eventAt: iso('2022-06-29') });
  // 财务：3 个报告期 ×（profit/growth 各 1，最新期只有 profit）
  for (const [statDate, pubDate, queries] of [
    ['2022-03-31', '2022-04-27', ['profit', 'growth']],
    ['2021-12-31', '2022-03-31', ['profit']],
    ['2020-12-31', '2021-03-31', ['profit']],
  ] as const) {
    for (const q of queries) {
      await addFact({
        subjectType: 'STOCK', subjectId: '600519', factKind: 'FINANCIAL',
        typedValue: { code: 'sh.600519', bsQuery: q, statDate, pubDate, epsTTM: '40.000000', totalShare: '1256197800', netProfit: '40000000000.00' },
        availableAt: `${pubDate}T16:00:00.000Z`,
      });
    }
  }
  const ann = async (factIdMark: string, title: string, day: string, availableDay?: string): Promise<string> => {
    const id = await addFact({
      subjectType: 'STOCK', subjectId: '600519', factKind: 'ANNOUNCEMENT',
      typedValue: { title, secCode: '600519', secName: '贵州茅台', adjunctUrl: `finalpage/${day}/x.PDF`, announcementId: factIdMark, announcementTime: Date.parse(`${day}T00:00:00Z`), announcementType: '010' },
      availableAt: iso(availableDay ?? day), eventAt: iso(day),
    });
    return id;
  };
  annIds = {
    [ANN_HIT_IN_WINDOW]: await ann(ANN_HIT_IN_WINDOW, '2021年半年度业绩预告', '2021-07-14'),
    [ANN_OVERLAP]: await ann(ANN_OVERLAP, '关于业绩预告暨回购进展的提示性公告', '2022-06-10'),
    [ANN_EVENT_IN_WINDOW]: await ann(ANN_EVENT_IN_WINDOW, '关于控股股东部分股份解除质押的公告', '2022-06-20'),
    [ANN_HIT_OLD]: await ann(ANN_HIT_OLD, '2019年度业绩预告', '2019-04-10'),
    [ANN_NON_HIT]: await ann(ANN_NON_HIT, '关于召开2021年年度股东大会的通知', '2022-06-15'),
    [ANN_FUTURE]: await ann(ANN_FUTURE, '2022年年度业绩预告', '2023-01-10'),
  } as Record<string, string>;
  stockBasicFutureId = await addFact({
    subjectType: 'STOCK', subjectId: '600519', factKind: 'STOCK_BASIC',
    typedValue: { code: 'sh.600519', code_name: '贵州茅台', ipoDate: '2001-08-27', type: '1', status: '1', outDate: '' },
    availableAt: iso('2026-10-25'),
  });
  // 行业版本：pre2014（截点已过期）+ 2014（区间有效，l1IndexCode=801120）+ 证监会轴（无 体系）
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'INDUSTRY_CLASS_VERSION', typedValue: { 体系: 'pre2014', l1IndexCode: null, 行业代码: '340301', 计入日期ISO: '2001-07-31' }, availableAt: iso('2001-08-01'), validFrom: iso('2001-07-31'), validTo: iso('2019-07-24') });
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'INDUSTRY_CLASS_VERSION', typedValue: { 体系: '2014', l1IndexCode: '801120', 行业代码: '340501', 计入日期ISO: '2019-07-24' }, availableAt: iso('2019-07-25'), validFrom: iso('2019-07-24'), validTo: null });
  await addFact({ subjectType: 'STOCK', subjectId: '600519', factKind: 'INDUSTRY_CLASS_VERSION', typedValue: { classVersion: 'csrc@current', industry: 'C15酒、饮料和精制茶制造业', industryClassification: '证监会行业分类' }, availableAt: iso('2022-01-01') });
  // ---- 行业基准 801120（SW_INDEX_BAR）----
  for (const d of ['2022-06-29', '2022-06-30']) {
    await addFact({ subjectType: 'INDEX', subjectId: '801120', factKind: 'SW_INDEX_BAR', typedValue: { 代码: '801120', 日期: d, 开盘: 13000.5, 最高: 13100, 最低: 12990.25, 收盘: 13050.75, 成交量: 15.5, 成交额: 300.25, swIndexCode: '801120' }, availableAt: iso(d), eventAt: iso(d) });
  }
  // ---- ETF 510300 + 跟踪指数 000300 ----
  for (const [d, c] of [['2022-06-29', '4.1000'], ['2022-06-30', '4.1780']] as const) {
    await addFact({ subjectType: 'ETF', subjectId: '510300', factKind: 'DAILY_BAR', typedValue: { code: 'sh.510300', date: d, open: c, high: c, low: c, close: c, preclose: c, volume: '1000', amount: '2000000.0000', turn: '10.0', pctChg: '1.0', isST: '1', tradestatus: '1', adjustflag: '3' }, availableAt: iso(d), eventAt: iso(d) });
    await addFact({ subjectType: 'INDEX', subjectId: '000300', factKind: 'DAILY_BAR', typedValue: { code: 'sh.000300', date: d, open: '4400.0000', high: '4500.0000', low: '4390.0000', close: '4485.0000', preclose: '4420.0000', volume: '100', amount: '3000000000.0000', turn: '0.5', pctChg: '1.4', isST: '0', tradestatus: '1', adjustflag: '3' }, availableAt: iso(d), eventAt: iso(d) });
  }
}

// ===== 选项构造 =====

const VERSIONS = { methodVersion: 'method@p2-v2-20261103', adapterVersion: 'data@test-1', planAuthVersion: 'pa-test-1' };
const GENEROUS_BUDGET = { l0Bytes: 50_000, l1Bytes: 100_000, l2Bytes: 100_000, totalBytes: 200_000 };

function stockOpts(overrides: Partial<AssembleResearchInputOptions> = {}): AssembleResearchInputOptions {
  return {
    subjectKind: 'STOCK',
    subject: '600519',
    cutoff: CUTOFF,
    budget: GENEROUS_BUDGET,
    versions: VERSIONS,
    poolInfoFile,
    ...overrides,
  };
}

function etfOpts(overrides: Partial<AssembleResearchInputOptions> = {}): AssembleResearchInputOptions {
  return { subjectKind: 'BROAD_ETF', subject: '510300', cutoff: CUTOFF, budget: GENEROUS_BUDGET, versions: VERSIONS, poolInfoFile, ...overrides };
}

// ===== 用例 =====

test('个股组装：八维 coverage、时点纪律、封存复用、程序校验全绿', async () => {
  const { package: pkg, artifactRef, inputHash, inputBytes } = await assembleResearchInput(pool, store, stockOpts());

  // inputHash / 原件读回一致
  const { inputHash: _h, ...core } = pkg;
  assert.equal(canonicalSha256(core), inputHash);
  const readBack = JSON.parse(new TextDecoder().decode(await store.readBytes(artifactRef.sha256))) as ResearchInputPackage;
  assert.equal(canonicalJsonString(readBack), canonicalJsonString(pkg));
  assert.equal(inputBytes, artifactRef.bytes);

  // 封存复用：标的 + 行业基准 + 估值截面精确输入，业务键同为 WEEKLY
  assert.equal(pkg.seals.length, 3);
  assert.equal(pkg.seals[0]?.businessKey.researchKind, 'WEEKLY');
  assert.equal(pkg.seals[0]?.businessKey.subject, '600519');

  // 时点纪律：截点后公告/STOCK_BASIC 不得进任何 seal 与任何材料
  const ann = annIds;
  const sealedIds = new Set(pkg.seals.flatMap((s) => s.factIds));
  assert.equal(sealedIds.has(ann[ANN_FUTURE] as string), false, '截点后公告不得入 seal');
  assert.equal(sealedIds.has(stockBasicFutureId), false, '截点后 STOCK_BASIC 不得入 seal');
  const allMaterialFactIds = pkg.materials.flatMap((m) => m.factIds);
  assert.equal(allMaterialFactIds.includes(ann[ANN_FUTURE] as string), false);

  // 龙虎榜前视列剔除断言（验收低危①）
  const dragonMat = pkg.materials.find((m) => m.materialId === 'mat:5:dragon-tiger');
  assert.ok(dragonMat, '龙虎榜材料在场（夹具已注入）');
  assert.ok(dragonMat.kind === 'RECORDS', '龙虎榜材料为 RECORDS');
  const dragonRecords = (dragonMat as { records: Array<Record<string, unknown>> }).records;
  assert.equal(dragonRecords.length, 1);
  const dragonRow = dragonRecords[0]!;
  assert.equal(dragonRow['上榜后1日'], undefined, '前视列必须剔除');
  assert.equal(dragonRow['上榜后10日'], undefined, '前视列必须剔除');
  assert.equal(dragonRow['序号'], undefined, '序号列口径统一剔除');
  assert.equal(dragonRow['forwardLookingColumns'], undefined, '元数据列剔除');
  assert.equal(dragonRow['上榜日'], '2022-06-29', '当日信息保留');

  // 八维 coverage：全部在场、无降级、三态字段完整
  assert.deepEqual(pkg.dimensions.map((d) => d.dimension), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(pkg.dimensions.every((d) => d.delivered.length > 0), '每维至少送达 1 件（占位说明也算）');
  assert.ok(pkg.dimensions.every((d) => d.demoted.length === 0));
  // 关键缺口声明在场
  const gapText = pkg.dimensions.flatMap((d) => d.gap).join('\n');
  assert.match(gapText, /D7: STOCK_BASIC 截点不可见/);
  assert.match(gapText, /D7: 股权质押比例未入库/);
  assert.match(gapText, /D8: 历史参照群组块不可得/);
  assert.match(gapText, /D5: 融资融券余额未入库/);
  assert.match(gapText, /D2: (估值历史分位与行业分位不可精确计算|本股行业截面分位不可计算)/);

  // D3 预期差摘录：命中 2（窗口内预告 + 双关键词公告归 D3），旧窗口外/非命中/截点后排除
  const d3 = pkg.materials.find((m) => m.materialId === 'mat:3:expectation-excerpts');
  assert.ok(d3 && d3.kind === 'RECORDS');
  if (d3.kind === 'RECORDS') {
    assert.equal(d3.records.length, 2);
    const titles = d3.records.map((r) => String(r.title));
    assert.ok(titles.includes('2021年半年度业绩预告'));
    assert.ok(titles.includes('关于业绩预告暨回购进展的提示性公告'));
  }
  // D4 事件摘录：仅解除质押一条（双关键词公告已被 D3 收纳）
  const d4 = pkg.materials.find((m) => m.materialId === 'mat:4:corporate-event-excerpts');
  assert.ok(d4 && d4.kind === 'RECORDS');
  if (d4.kind === 'RECORDS') {
    assert.deepEqual(d4.records.map((r) => String(r.title)), ['关于控股股东部分股份解除质押的公告']);
  }

  // D6：2014 铸造行按 2021 读取窗口解释（pre2014 已过期；证监会轴不参与）
  const d6 = pkg.materials.find((m) => m.materialId === 'mat:6:industry-attribution');
  assert.ok(d6 && d6.kind === 'RECORDS');
  if (d6.kind === 'RECORDS') {
    assert.equal((d6.records[0] as Record<string, unknown>)['体系'], '2021');
    assert.equal((d6.records[0] as Record<string, unknown>)['l1IndexCode'], '801120');
  }

  // D5 行情表：3 行 + 复权因子列连接值 2.500000
  const d5 = pkg.materials.find((m) => m.materialId === 'mat:5:daily-bar-table');
  assert.ok(d5 && d5.kind === 'BAR_TABLE');
  if (d5.kind === 'BAR_TABLE') {
    assert.equal(d5.table.rows.length, 3);
    const afIdx = d5.table.header.indexOf('adjustFactor');
    assert.ok(afIdx >= 0);
    assert.deepEqual(d5.table.rows.map((r) => r[afIdx]), ['2.500000', '2.500000', '2.500000']);
  }

  // 分层预算与 L0 不可裁剪材料
  assert.ok(pkg.layers.l0.bytes <= pkg.layers.l0.budget);
  assert.ok(pkg.layers.l1.bytes <= pkg.layers.l1.budget);
  assert.ok(pkg.layers.l2.bytes <= pkg.layers.l2.budget);
  assert.ok(pkg.layers.l0.blocks.length >= 5, 'L0 至少含身份/合同/声明/规则/回执五块');

  // 程序校验（Done-when 2）：引用可解析、行情表往返、coverage 完整
  const validation = await validateResearchInputPackage(pool, store, pkg);
  assert.equal(validation.ok, true);
  assert.ok(validation.factsChecked > 0);
  assert.equal(validation.barTablesChecked, 2); // D5 个股表 + D6 基准表
  assert.equal(validation.barRowsChecked, 5);

  // 分层读回
  const view = renderInputLayers(pkg);
  assert.ok(view.l0.some((b) => b.title.includes('决策合同')));
  assert.ok(view.l1.some((b) => b.payload['header'] !== undefined));
  const l2Index = view.l2[0]?.payload;
  assert.ok(Array.isArray(l2Index?.['deliveredFacts']));
  if (Array.isArray(l2Index?.['deliveredFacts'])) {
    const indexed = new Set((l2Index['deliveredFacts'] as { factId: string }[]).map((e) => e.factId));
    assert.equal(indexed.has(ann[ANN_HIT_IN_WINDOW] as string), true, '送达公告在引用目录');
    assert.equal(indexed.has(ann[ANN_NON_HIT] as string), false, '未送达公告不在引用目录（在 seal 目录）');
  }

  stockPackage = pkg;
});

test('L1 预算压力：超层预算材料降级并标记，不静默截断；L2 索引只列送达', async () => {
  const tight = { ...GENEROUS_BUDGET, l1Bytes: 1_500 };
  const { package: pkg } = await assembleResearchInput(pool, store, stockOpts({ budget: tight }));
  const demoted = pkg.dimensions.flatMap((d) => d.demoted);
  assert.ok(demoted.length > 0, '紧预算下应有降级');
  // 降级材料不在 L1 层块
  const l1Ids = new Set(pkg.layers.l1.blocks.map((b) => b.materialId));
  for (const id of demoted) assert.equal(l1Ids.has(id), false);
  assert.ok(pkg.layers.l1.bytes <= tight.l1Bytes);
  // 降级材料在 L2 索引中有目录条目（目录可见、内容未送达）
  const indexForDemoted = pkg.materials.find((m) => m.kind === 'INDEX');
  assert.ok(indexForDemoted && indexForDemoted.kind === 'INDEX');
  if (indexForDemoted.kind === 'INDEX') {
    const demotedInIndex = new Set(indexForDemoted.content.demotedMaterials.map((e) => e.materialId));
    for (const id of demoted) assert.equal(demotedInIndex.has(id), true, `降级材料 ${id} 应在 L2 降级目录`);
  }
  // 目录只能指向实际送达的材料/层；同一事实可由 L0 基准等另一材料送达。
  const index = pkg.materials.find((m) => m.kind === 'INDEX');
  assert.ok(index && index.kind === 'INDEX');
  if (index.kind === 'INDEX') {
    const delivered = new Map([
      ...pkg.layers.l0.blocks.map((b) => [b.materialId, 'L0'] as const),
      ...pkg.layers.l1.blocks.map((b) => [b.materialId, 'L1'] as const),
    ]);
    const expectedFacts = new Set(pkg.materials.filter((m) => delivered.has(m.materialId)).flatMap((m) => m.factIds));
    const indexed = new Set(index.content.deliveredFacts.map((e) => e.factId));
    assert.deepEqual(indexed, expectedFacts, '目录事实集必须恰等于实际送达材料的事实集');
    for (const entry of index.content.deliveredFacts) {
      assert.equal(delivered.get(entry.materialId), entry.layer, `目录不得声称降级材料 ${entry.materialId} 已送达`);
      assert.ok(pkg.materials.find((m) => m.materialId === entry.materialId)?.factIds.includes(entry.factId));
    }
  }
  // 降级包仍能通过程序校验（coverage 与层一致）
  const validation = await validateResearchInputPackage(pool, store, pkg);
  assert.equal(validation.ok, true);
});

test('总预算超限 → KernelError(INPUT_OVER_BUDGET)（阻断不截断）', async () => {
  const tinyTotal = { ...GENEROUS_BUDGET, totalBytes: 6_000 };
  await assert.rejects(
    () => assembleResearchInput(pool, store, stockOpts({ budget: tinyTotal })),
    (error: unknown) => error instanceof KernelError && error.code === 'INPUT_OVER_BUDGET',
  );
});

test('L0 不可裁剪：L0 预算不足 → INPUT_OVER_BUDGET', async () => {
  const tinyL0 = { ...GENEROUS_BUDGET, l0Bytes: 500 };
  await assert.rejects(
    () => assembleResearchInput(pool, store, stockOpts({ budget: tinyL0 })),
    (error: unknown) => error instanceof KernelError && error.code === 'INPUT_OVER_BUDGET',
  );
});

test('ETF 组装：七维映射、跟踪指数材料、缺口声明、程序校验全绿', async () => {
  const { package: pkg } = await assembleResearchInput(pool, store, etfOpts());
  assert.deepEqual(pkg.dimensions.map((d) => d.dimension), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pkg.seals.length, 2); // ETF + INDEX/000300
  assert.equal(pkg.benchmark?.status, 'CURRENT_PROXY'); // 当前池在2022截点没有历史观察证明
  assert.equal(pkg.seals[1]?.businessKey.subject, '510300'); // 同业务键（selector 不同）
  const e5etf = pkg.materials.find((m) => m.materialId === 'mat:5:etf-bar-table');
  const e5idx = pkg.materials.find((m) => m.materialId === 'mat:5:tracking-index-bar-table');
  assert.ok(e5etf && e5etf.kind === 'BAR_TABLE' && e5etf.table.rows.length === 2);
  assert.ok(e5idx && e5idx.kind === 'BAR_TABLE' && e5idx.table.rows.length === 2);
  const gapText = pkg.dimensions.flatMap((d) => d.gap).join('\n');
  for (const expected of [
    'E1: 跟踪指数估值（PE/PB）as-of 不可见',
    'E2: 成分股盈利数据未入库',
    'E3: 宏观与政策数据源未接入',
    'E4: 资金流向专用数据未入库',
    'E5: 市场宽度数据未入库',
    'E6: 可比指数序列未纳入本轮封存',
    'E7: 历史状态参照库未建',
  ]) {
    assert.ok(gapText.includes(expected), `缺缺口声明：${expected}`);
  }
  const validation = await validateResearchInputPackage(pool, store, pkg);
  assert.equal(validation.ok, true);
  assert.equal(validation.barTablesChecked, 2);
  etfPackage = pkg;
});

test('冻结池纪律：池外标的具名拒绝', async () => {
  await assert.rejects(
    () => assembleResearchInput(pool, store, stockOpts({ subject: '999999' })),
    (error: unknown) => error instanceof Error && /SUBJECT_NOT_IN_POOL/.test(String((error as { code?: string }).code)),
  );
});

test('报告视图：A 摘要/清单裁决/J 决定/证据下钻/coverage，末行合规标注', async () => {
  const pkg = stockPackage;
  assert.ok(pkg, '依赖前序用例产出');
  const seal = pkg.seals[0];
  assert.ok(seal);
  const aOutput = simulatedModelA({
    inputHash: pkg.inputHash,
    subjectKind: 'STOCK',
    subject: '600519',
    material: researchMaterial(pkg),
  });
  const checklist = deriveChecklist(aOutput, seal.manifestHash);
  const jInputHash = researchJInputHash(pkg, aOutput, checklist);
  const jOutput = simulatedModelJ({ inputHash: jInputHash, subjectKind: 'STOCK', aOutput, checklist });
  const conclusion = await persistConclusion(pool, {
    businessKey: pkg.businessKey,
    methodVersion: VERSIONS.methodVersion,
    adapterVersion: VERSIONS.adapterVersion,
    planAuthVersion: VERSIONS.planAuthVersion,
    aOutput,
    checklist,
    jOutput,
    manifest: seal,
    researchInput: pkg,
    inheritance: null,
    changeReason: jOutput.changedFromA ? jOutput.changeReason : null, // J 改判时回抄其改判理由
  });

  const view = buildReportView(conclusion, pkg, aOutput, checklist, jOutput);
  assert.equal(view.conclusion.disposition, jOutput.finalDisposition);
  assert.ok(view.aSummary !== null);
  assert.ok(view.checklist !== null);
  assert.equal(view.checklist.items.length, checklist.items.length);
  assert.ok(view.checklist.items.every((item) => item.verdict !== null), 'J 恰好覆盖全部清单条目');
  assert.ok(view.j !== null);
  assert.equal(view.j.finalDisposition, jOutput.finalDisposition);
  assert.ok(view.evidenceDrillDown !== null);
  const drill = view.evidenceDrillDown;
  assert.ok(Object.keys(drill.byFactId).length > 0);
  for (const entry of Object.values(drill.byFactId)) {
    assert.equal(entry.byteRange.start, 0);
    assert.equal(entry.byteRange.end, entry.artifactBytes, 'P2 全区间下钻');
  }
  assert.ok(drill.aEvidenceResolvable !== null && drill.aEvidenceResolvable.every((x) => x));
  assert.ok(view.inputCoverage !== null && view.inputCoverage.inputHash === pkg.inputHash);

  const text = renderReportText(view);
  assert.ok(text.trimEnd().endsWith(REPORT_DISCLAIMER), '末行恒为合规标注');
  assert.ok(text.includes('程序清单逐项与 J 裁决'));
  assert.ok(text.includes('证据引用下钻'));

  // 结论-only 视图（无 A/J/清单/包）：如实呈现缺，不代填
  const fromDb = await readConclusion(pool, conclusion.conclusionId);
  assert.ok(fromDb !== null);
  const bare = buildReportView(fromDb, null, null, null, null);
  const bareText = renderReportText(bare);
  assert.ok(bareText.includes('（本轮无 A 输出可读回——视图不代填）'));
  assert.ok(bareText.trimEnd().endsWith(REPORT_DISCLAIMER));
});
