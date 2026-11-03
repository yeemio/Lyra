/**
 * sr 空间 · 证据包组装器单测（EVIDENCE，真实 DB 只读）。
 * 隔离 schema harness：applySchema(admin, schema, srMigrationSqlUrl) 验证 sr 迁移可干净应用；
 * 事实读取走 public（dataPool 只读，不写入任何业务数据）。
 *
 * 覆盖：截点纪律（包内 FACT locator 的 availableAt 全部 ≤ cutoff）、002384 实包
 * （表规模/关键值/packHash 可复算/文件可解析）、缺口路径（极早截点不抛异常且 gaps 非空）、
 * 研究池解析与 findSubject。
 * 输出目录用 os.tmpdir() 临时目录，结束即清理。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { canonicalSha256 } from '../canonical.js';
import { buildEvidencePack, findSubject, loadResearchPool } from './evidence.js';
import type { EvidencePack } from './contracts.js';

const schema = `sr_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let dataPool: Pool;
let outDir: string;

before(async () => {
  dataPool = createPool(); // public（真实事实面，只读使用）
  await applySchema(dataPool, schema, srMigrationSqlUrl); // sr 迁移在隔离 schema 干净应用（harness）
  outDir = mkdtempSync(join(tmpdir(), 'sr-evidence-'));
});

after(async () => {
  await dropSchema(dataPool, schema);
  await dataPool.end();
  rmSync(outDir, { recursive: true, force: true });
});

const CUTOFF = '2026-10-23T16:00:00Z';

function tableOf(pack: EvidencePack, tableId: string) {
  const table = pack.tables.find((t) => t.tableId === tableId);
  assert.ok(table !== undefined, `证据包缺表 ${tableId}`);
  return table;
}

function cellOf(pack: EvidencePack, tableId: string, rowIdx: number, col: string): string | number | null {
  const table = tableOf(pack, tableId);
  const idx = table.columns.indexOf(col);
  assert.ok(idx >= 0, `${tableId} 缺列 ${col}`);
  return table.rows[rowIdx]?.[idx] ?? null;
}

describe('研究池', () => {
  it('loadResearchPool：26 股 + 4 ETF，字段齐', async () => {
    const pool = await loadResearchPool();
    assert.equal(pool.stocks.length, 26);
    assert.equal(pool.etfs.length, 4);
    const ds = pool.stocks.find((s) => s.code === '002384');
    assert.ok(ds !== undefined && ds.name === '东山精密' && ds.swL1 === '电子');
  });

  it('findSubject：代码精确 / 名称精确 / 名称前缀 / 未命中', async () => {
    const pool = await loadResearchPool();
    assert.deepEqual(await findSubject(pool, '002384'), { code: '002384', name: '东山精密', swL1: '电子' });
    assert.equal((await findSubject(pool, '兆易创新'))?.code, '603986');
    assert.equal((await findSubject(pool, '兆易'))?.code, '603986');
    assert.equal((await findSubject(pool, '上证50ETF'))?.code, '510050');
    assert.equal(await findSubject(pool, '不存在的标的'), null);
  });
});

describe('buildEvidencePack 002384（截点 2026-10-23T16:00:00Z）', () => {
  let pack: EvidencePack;
  let packPath: string;

  it('构建成功（不抛异常）', async () => {
    const built = await buildEvidencePack(dataPool, {
      taskId: randomUUID(),
      subject: '002384',
      cutoff: CUTOFF,
      focus: 'FULL',
      outputDir: outDir,
    });
    pack = built.pack;
    packPath = built.packPath;
  });

  it('截点纪律：全部 FACT locator availableAt ≤ cutoff（截点后事实为零）', () => {
    const cutoffMs = new Date(CUTOFF).getTime();
    let locatorCount = 0;
    for (const table of pack.tables) {
      assert.equal(table.cutoff, CUTOFF);
      for (const loc of table.locators) {
        if (loc.kind !== 'FACT') continue;
        locatorCount += 1;
        const at = new Date(loc.availableAt).getTime();
        assert.ok(
          at <= cutoffMs,
          `${table.tableId} 出现截点后事实 ${loc.factId} availableAt=${loc.availableAt}`,
        );
      }
    }
    assert.ok(locatorCount >= 500, `locator 数应具规模（实为 ${locatorCount}）`);
  });

  it('bars-daily：250 根、末根 2026-10-23、含复权因子连接列', () => {
    const bars = tableOf(pack, 'bars-daily');
    assert.equal(bars.rows.length, 250);
    assert.equal(bars.columns.includes('close'), true);
    assert.equal(bars.columns.includes('adjustFactor'), true);
    const dateIdx = bars.columns.indexOf('date');
    assert.equal(bars.rows[249]?.[dateIdx], '2026-10-23');
    assert.equal(cellOf(pack, 'bars-daily', 249, 'close'), '114.2200');
    assert.equal(pack.coverage.bars.lastDate, '2026-10-23');
  });

  it('fin-quarterly：12 期、最新 2026-06-30、pubDate 在列', () => {
    assert.equal(tableOf(pack, 'fin-quarterly').rows.length, 12);
    assert.equal(pack.coverage.financials.periods, 12);
    assert.equal(pack.coverage.financials.latestPeriod, '2026-06-30');
    assert.equal(cellOf(pack, 'fin-quarterly', 11, 'pubDate'), '2026-08-22');
    assert.ok(cellOf(pack, 'fin-quarterly', 11, 'MBRevenue') !== null);
    // BALANCE 连接列（归母权益/股本）非空 → BPS 可算
    assert.ok(typeof cellOf(pack, 'fin-quarterly', 11, 'TOTAL_PARENT_EQUITY') === 'number');
    assert.ok(typeof cellOf(pack, 'fin-quarterly', 11, 'SHARE_CAPITAL') === 'number');
  });

  it('margin/holder/pledge/announcements 规模', () => {
    assert.equal(tableOf(pack, 'margin-series').rows.length, 48);
    assert.equal(tableOf(pack, 'holder-count').rows.length, 24);
    assert.equal(tableOf(pack, 'pledge').rows.length, 24);
    assert.equal(tableOf(pack, 'announcements-recent').rows.length, 60);
    assert.equal(pack.coverage.margin.latestDate, '2026-10-22');
    assert.ok(pack.coverage.announcements.latestTitleAt !== null);
  });

  it('industry：截点申万 L1 = 801080（电子）；index-bars 250 根基准', () => {
    const industry = tableOf(pack, 'industry');
    const l1Row = industry.rows.find((r) => r[0] === '申万一级行业指数代码');
    assert.equal(l1Row?.[1], '801080');
    assert.equal(pack.coverage.industry.swL1, '电子');
    const bench = tableOf(pack, 'index-bars');
    assert.equal(bench.rows.length, 250);
    assert.ok(bench.columns.includes('收盘'), 'SW 基准应含中文收盘列');
  });

  it('coverage：估值输入来源与缺口（一致预期缺失具名）', () => {
    const v = pack.coverage.valuationInputs;
    assert.equal(v.closePriceDate, '2026-10-23');
    assert.ok(v.epsTtmSource !== null && v.epsTtmSource.includes('epsTTM@2026-06-30'));
    assert.ok(pack.coverage.gaps.some((g) => g.includes('一致预期')));
  });

  it('pack 落盘：文件可解析，packHash 可复算', async () => {
    const parsed = JSON.parse(await readFile(packPath, 'utf8')) as EvidencePack;
    assert.equal(parsed.taskId, pack.taskId);
    assert.equal(parsed.tables.length, pack.tables.length);
    const { packHash, ...rest } = parsed;
    assert.equal(canonicalSha256(rest), packHash);
    assert.equal(packHash, pack.packHash);
  });
});

describe('缺口路径（截点早于一切事实）', () => {
  it('极早截点：不抛异常，gaps 非空，财务/行情为空表', async () => {
    const { pack } = await buildEvidencePack(dataPool, {
      taskId: randomUUID(),
      subject: '002384',
      cutoff: '1998-01-01T00:00:00Z', // 早于一切事实（2010 截点仍会命中 002384 上市前财务史 2 期）
      focus: 'FULL',
      outputDir: outDir,
    });
    assert.equal(pack.coverage.financials.periods, 0);
    assert.equal(tableOf(pack, 'fin-quarterly').rows.length, 0);
    assert.equal(pack.coverage.bars.count, 0);
    assert.ok(pack.coverage.gaps.length > 0);
    assert.ok(pack.coverage.gaps.some((g) => g.includes('季频财务')));
    // 空表也带 cutoff 与空 locators（结构完整，不残缺）
    for (const table of pack.tables) {
      assert.equal(table.cutoff, '1998-01-01T00:00:00Z');
    }
  });
});
