/**
 * Lyra · Web 看板服务器单测（W47: code-writer-pro）。
 * 纯函数与本地文件测试（零网络零 DB）：路由匹配（含 /style.css）、标的页标签页
 * 解析白名单、筛选解析白名单、轮转预览（交易日历注入）、P5 周计数、调用记录
 * 哈希索引、输入包前缀扫描与 manifestHash 绑定（原件库 CAS 临时目录）、
 * 清单重导出哈希校验、池文件形状校验。
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJsonString, canonicalSha256 } from '../canonical.js';
import { ArtifactStore } from '../artifacts/store.js';
import { deriveChecklist } from '../research/checklist.js';
import type { DimensionCoveragePkg } from '../research/checklist.js';
import type { AOutput, JOutput } from '../contracts.js';
import type { ResearchInputPackage } from '../research/inputs.js';
import {
  checklistFor,
  coverageOfPackage,
  matchRoute,
  nextRotationNight,
  packageBound,
  PackageSources,
  parseConclusionsQuery,
  parsePoolInfo,
  parseSubjectTab,
  p5WeekOf,
  buildInvocationIndex,
  scanPackageIndex,
  PACKAGE_PREFIX,
} from './server.js';

const H64 = 'a'.repeat(64);

// ===== 路由匹配 =====

test('matchRoute：五个已知路由（GET/HEAD）', () => {
  assert.deepEqual(matchRoute('GET', '/'), { name: 'home' });
  assert.deepEqual(matchRoute('GET', '/index.html'), { name: 'home' });
  assert.deepEqual(matchRoute('GET', '/style.css'), { name: 'style' });
  assert.deepEqual(matchRoute('GET', '/conclusions'), { name: 'conclusions' });
  assert.deepEqual(matchRoute('GET', '/api/status'), { name: 'status' });
  assert.deepEqual(matchRoute('GET', '/subject/600519'), { name: 'subject', code: '600519' });
  assert.deepEqual(matchRoute('HEAD', '/'), { name: 'home' });
  assert.deepEqual(matchRoute('HEAD', '/style.css'), { name: 'style' });
});

test('matchRoute：未知路由与方法拒绝', () => {
  assert.equal(matchRoute('GET', '/favicon.ico'), null);
  assert.equal(matchRoute('GET', '/api/other'), null);
  assert.equal(matchRoute('GET', '/style.css?v=2'), null); // 查询串不属于路由匹配输入（pathname 由调用方解析）
  assert.equal(matchRoute('GET', '/subject/60051'), null); // 5 位
  assert.equal(matchRoute('GET', '/subject/600519/extra'), null);
  assert.equal(matchRoute('GET', '/subject/abc123'), null); // 非数字
  assert.equal(matchRoute('POST', '/'), null);
  assert.equal(matchRoute('PUT', '/api/status'), null);
});

// ===== 标的页标签页解析（?t= 白名单）=====

test('parseSubjectTab：白名单内透传，缺省/非法回落 A 摘要', () => {
  assert.equal(parseSubjectTab(null), 'a');
  assert.equal(parseSubjectTab('a'), 'a');
  assert.equal(parseSubjectTab('checklist'), 'checklist');
  assert.equal(parseSubjectTab('j'), 'j');
  assert.equal(parseSubjectTab('settlement'), 'settlement');
  assert.equal(parseSubjectTab('evil'), 'a');
  assert.equal(parseSubjectTab(''), 'a');
});

// ===== 结论筛选解析（白名单）=====

test('parseConclusionsQuery：合法组合与缺省', () => {
  const r1 = parseConclusionsQuery(new URLSearchParams(''));
  if (!('filters' in r1)) assert.fail('应返回 filters');
  assert.deepEqual(r1.filters, { kind: null, disposition: null, settlement: null, page: 1 });
  const r2 = parseConclusionsQuery(new URLSearchParams('kind=STOCK&disposition=ABSTAIN&settlement=UNSETTLED&page=3'));
  if (!('filters' in r2)) assert.fail('应返回 filters');
  assert.deepEqual(r2.filters, { kind: 'STOCK', disposition: 'ABSTAIN', settlement: 'UNSETTLED', page: 3 });
  const r3 = parseConclusionsQuery(new URLSearchParams('kind=&page=1'));
  if (!('filters' in r3)) assert.fail('应返回 filters');
  assert.equal(r3.filters.kind, null);
});

test('parseConclusionsQuery：白名单外具名拒绝', () => {
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('kind=CRYPTO')));
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('disposition=BUY')));
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('settlement=PAID')));
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('page=0')));
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('page=-1')));
  assert.ok('error' in parseConclusionsQuery(new URLSearchParams('page=abc')));
});

// ===== 轮转预览（日历注入）=====

/** 2026-10-26（周一）至 10-30（周五）+ 次周 11-02（周一）至 11-06（周五）。 */
const CAL = [
  '2026-10-26',
  '2026-10-27',
  '2026-10-28',
  '2026-10-29',
  '2026-10-30',
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
];

test('nextRotationNight：交易日盘后未截止 → 今晚', () => {
  const r = nextRotationNight(CAL, { date: '2026-10-26', time: '20:00:00' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { date: '2026-10-26', nth: 1 }); // 周一 = 本周第 1 个交易日
});

test('nextRotationNight：周五 23:30 后 → 次周一，nth 重置 1', () => {
  const r = nextRotationNight(CAL, { date: '2026-10-30', time: '23:30:01' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { date: '2026-11-02', nth: 1 });
});

test('nextRotationNight：周五截止前 → 当晚 nth=5', () => {
  const r = nextRotationNight(CAL, { date: '2026-10-30', time: '23:29:59' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { date: '2026-10-30', nth: 5 });
});

test('nextRotationNight：周末 → 次周一', () => {
  const r = nextRotationNight(CAL, { date: '2026-10-31', time: '10:00:00' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { date: '2026-11-02', nth: 1 });
});

test('nextRotationNight：周中日晚间 → 次晚 nth 前进', () => {
  const r = nextRotationNight(CAL, { date: '2026-10-27', time: '23:45:00' });
  assert.ok(!('error' in r));
  assert.deepEqual(r, { date: '2026-10-28', nth: 3 });
});

test('nextRotationNight：日历覆盖尾外具名拒绝不猜测', () => {
  const r = nextRotationNight(CAL, { date: '2026-11-06', time: '23:45:00' });
  if (!('error' in r)) assert.fail('覆盖尾后应具名拒绝');
  assert.ok(r.error.includes('CALENDAR_RANGE'));
  const r2 = nextRotationNight(CAL, { date: '2026-12-01', time: '10:00:00' });
  if (!('error' in r2)) assert.fail('覆盖界外应具名拒绝');
});

// ===== P5 观察周 =====

test('p5WeekOf：自 2026-10-26 起 1 起，跨 7 天进位，起点前钳 1', () => {
  assert.equal(p5WeekOf(new Date('2026-10-26T08:00:00+08:00')), 1);
  assert.equal(p5WeekOf(new Date('2026-11-01T23:00:00+08:00')), 1);
  assert.equal(p5WeekOf(new Date('2026-11-02T08:00:00+08:00')), 2);
  assert.equal(p5WeekOf(new Date('2026-10-20T08:00:00+08:00')), 1);
  assert.equal(p5WeekOf(new Date('2026-11-30T08:00:00+08:00')), 6);
});

// ===== 清单重导出（哈希校验）=====

function aOutputFixture(): AOutput {
  return {
    stage: 'A',
    inputHash: H64,
    subjectKind: 'STOCK',
    candidate: 'ABSTAIN',
    decisiveLinks: [
      { text: '决定性连接一', evidenceArtifactSha256: H64 },
      { text: '决定性连接二', evidenceArtifactSha256: 'b'.repeat(64) },
    ],
    strongestCounter: '最强反证',
    confidence: 'LOW',
    limitations: ['限制一'],
    simulated: true,
  };
}

test('checklistFor：p0 重导出哈希命中即采用', () => {
  const a = aOutputFixture();
  const manifestHash = 'c'.repeat(64);
  const expected = deriveChecklist(a, manifestHash).checklistHash;
  const cl = checklistFor(a, manifestHash, expected, null);
  assert.notEqual(cl, null);
  assert.equal(cl?.checklistHash, expected);
  assert.ok(cl?.checklistId.startsWith('checklist:p0:'));
});

test('checklistFor：哈希不符（p0/p2 均不命中）→ null 不代填', () => {
  const a = aOutputFixture();
  const coverage: DimensionCoveragePkg = {
    dimensions: [{ dimension: '基本面变化', deliveredCount: 2, gap: [] }],
  };
  const cl = checklistFor(a, 'c'.repeat(64), '0'.repeat(64), coverage);
  assert.equal(cl, null);
});

// ===== 输入包绑定 =====

test('packageBound：包内任一封存 manifestHash 命中即绑定', () => {
  const pkg = {
    packageKind: 'RESEARCH_INPUT',
    seals: [{ manifestHash: 'x'.repeat(64) }, { manifestHash: 'y'.repeat(64) }],
    dimensions: [],
  } as unknown as ResearchInputPackage;
  assert.equal(packageBound(pkg, 'y'.repeat(64)), true);
  assert.equal(packageBound(pkg, 'z'.repeat(64)), false);
});

test('coverageOfPackage：包 dimensions → p2 覆盖参数（维度名 + 送达计数，与 gate-m 同口径）', () => {
  const pkg = {
    dimensions: [
      { dimension: 1, code: 'FUNDAMENTALS', name: '基本面变化', delivered: ['m1', 'm2'], demoted: [], gap: ['g1'] },
      { dimension: 2, code: 'VALUATION', name: '估值', delivered: [], demoted: ['m3'], gap: [] },
    ],
  } as unknown as ResearchInputPackage;
  const cov = coverageOfPackage(pkg);
  assert.equal(cov.dimensions.length, 2);
  assert.deepEqual(cov.dimensions[0], { dimension: '基本面变化', deliveredCount: 2, gap: ['g1'] });
  assert.equal(cov.dimensions[1]?.deliveredCount, 0);
});

test('scanPackageIndex：前缀识别 + 业务键提取；非包文件跳过', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-web-scan-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const head =
    PACKAGE_PREFIX +
    '","businessKey":{"cutoff":"2026-10-23T07:00:00.000Z","researchKind":"WEEKLY","subject":"600519","subjectKind":"STOCK"},"cutoff":"2026-10-23T07:00:00.000Z","inputHash":"' +
    H64 +
    '"}';
  await mkdir(join(dir, 'ab'));
  const sha = 'ab'.padEnd(64, '0');
  await writeFile(join(dir, 'ab', sha), head, 'utf8');
  await writeFile(join(dir, 'ab', 'cd'.padEnd(64, '0')), '{"other":"nope"}'.padEnd(400, ' '), 'utf8'); // 普通原件
  await mkdir(join(dir, 'ef'));
  const sha2 = 'ef'.padEnd(64, '1');
  await writeFile(join(dir, 'ef', sha2), head.replace('600519', '002384').replace(H64, 'b'.repeat(64)), 'utf8');
  const entries = await scanPackageIndex(dir);
  assert.equal(entries.length, 2);
  const subjects = entries.map((e) => e.subject).sort();
  assert.deepEqual(subjects, ['002384', '600519']);
  const e600519 = entries.find((e) => e.subject === '600519');
  assert.equal(e600519?.sha, sha);
  assert.equal(e600519?.researchKind, 'WEEKLY');
  assert.equal(e600519?.subjectKind, 'STOCK');
});

test('PackageSources：前缀扫描 → CAS 校验读回 → manifestHash 绑定；未命中 null', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-web-pkg-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new ArtifactStore(dir);
  const manifestHash = 'm'.repeat(64);
  const pkg = {
    packageKind: 'RESEARCH_INPUT',
    packageVersion: 1,
    assemblerRulesVersion: 'research-inputs@p2-v1',
    businessKey: { subjectKind: 'STOCK', subject: '600519', researchKind: 'WEEKLY', cutoff: '2026-10-23T07:00:00.000Z' },
    cutoff: '2026-10-23T07:00:00.000Z',
    pool: {},
    versions: {},
    seals: [{ manifestHash }],
    materials: [],
    dimensions: [],
    rules: [],
    layers: { l0: { name: 'L0', budget: 1, bytes: 1, blocks: [] }, l1: { name: 'L1', budget: 1, bytes: 1, blocks: [] }, l2: { name: 'L2', budget: 1, bytes: 1, blocks: [] } },
    inputHash: H64,
  };
  // 与组装器同口径：canonical JSON 字节入 CAS（键序排序 → 前缀扫描可识别）
  await store.put(new TextEncoder().encode(canonicalJsonString(pkg)), 'application/json', new Date().toISOString());

  const sources = new PackageSources(store, dir);
  const businessKey = { subjectKind: 'STOCK', subject: '600519', researchKind: 'WEEKLY', cutoff: '2026-10-23T07:00:00.000Z' } as const;
  const bound = await sources.boundPackage(businessKey, manifestHash);
  assert.notEqual(bound, null);
  assert.equal(bound?.seals[0]?.manifestHash, manifestHash);
  const miss = await sources.boundPackage(businessKey, 'z'.repeat(64));
  assert.equal(miss, null); // manifest 不符 → 不绑定
  const wrongSubject = await sources.boundPackage({ ...businessKey, subject: '002384' }, manifestHash);
  assert.equal(wrongSubject, null); // 业务键不符 → 不绑定
});

// ===== 调用记录哈希索引 =====

test('buildInvocationIndex：final.txt 按 canonicalSha256 建索引；坏文件跳过；空目录安全', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lyra-web-inv-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const a: AOutput = aOutputFixture();
  const j: JOutput = {
    stage: 'J',
    inputHash: H64,
    finalDisposition: 'ABSTAIN',
    verdicts: [{ checklistId: 'check:p0:CANDIDATE:0', verdict: 'SUPPORTED', decisionBearing: true, correction: null }],
    changedFromA: false,
    changeReason: null,
    strongestCaseDisposition: 'ACCEPTED',
    limitations: [],
    simulated: true,
  };
  await mkdir(join(dir, 'inv-a'));
  await writeFile(join(dir, 'inv-a', 'final.txt'), JSON.stringify(a), 'utf8');
  await mkdir(join(dir, 'inv-j'));
  await writeFile(join(dir, 'inv-j', 'final.txt'), JSON.stringify(j), 'utf8');
  await mkdir(join(dir, 'inv-bad'));
  await writeFile(join(dir, 'inv-bad', 'final.txt'), 'not-json', 'utf8');
  await mkdir(join(dir, 'inv-empty'));

  const sources = await buildInvocationIndex(dir);
  assert.equal(sources.aByHash.size, 1);
  assert.equal(sources.jByHash.size, 1);
  assert.equal(sources.aByHash.get(canonicalSha256(a))?.candidate, 'ABSTAIN'); // 哈希键 = canonicalSha256(解析对象)
  assert.equal(sources.jByHash.get(canonicalSha256(j))?.finalDisposition, 'ABSTAIN');

  const missing = await buildInvocationIndex(join(dir, 'no-such-dir'));
  assert.equal(missing.aByHash.size, 0);
  assert.equal(missing.jByHash.size, 0);
});

// ===== 池文件形状 =====

test('parsePoolInfo：合法形状与畸形拒绝', () => {
  const ok = parsePoolInfo({
    frozenAt: '2026-10-26',
    version: '2',
    stocks: [{ code: '603986', name: '兆易创新', swL1Name: '电子' }],
    etfs: [{ code: '510300', name: '沪深300ETF', tracks: '沪深300(000300)' }],
  });
  assert.equal(ok.stocks.length, 1);
  assert.equal(ok.etfs[0]?.tracks, '沪深300(000300)');
  assert.throws(() => parsePoolInfo({ frozenAt: '2026-10-26' }));
  assert.throws(() => parsePoolInfo({ frozenAt: 'x', version: '2', stocks: [{ code: '1', name: 'n' }], etfs: [] })); // 缺 swL1Name
  assert.throws(() => parsePoolInfo({ frozenAt: 'x', version: '2', stocks: [], etfs: [{ code: '1', name: 'n' }] })); // 缺 tracks
});
