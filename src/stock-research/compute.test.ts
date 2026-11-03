/**
 * sr 空间 · 计算层单测（COMPUTE，确定性纯函数）。
 * 用手工构造的最小证据包断言精确值：单季拆分、同比、窗口收益/超额、PE/PB 敏感性；
 * 缺值路径（无 epsTTM/无基准/少 K 线/零基数）一律 null 不硬算。
 * 不依赖数据库。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EvidencePack, EvidenceTable, SrCoverage } from './contracts.js';
import { computeMetrics } from './compute.js';

const CUTOFF = '2026-10-23T16:00:00Z';

function mkTable(tableId: string, columns: string[], rows: (string | number | null)[][]): EvidenceTable {
  return { tableId, title: tableId, columns, rows, unitNote: null, locators: [], cutoff: CUTOFF };
}

function mkCoverage(): SrCoverage {
  return {
    financials: { periods: 0, latestPeriod: null, note: null },
    bars: { count: 0, firstDate: null, lastDate: null, note: null },
    announcements: { count: 0, latestTitleAt: null, note: null },
    margin: { count: 0, latestDate: null, note: null },
    holderCount: { count: 0, latestDate: null, note: null },
    pledge: { count: 0, latestDate: null, note: null },
    industry: { swL1: null, note: null },
    valuationInputs: { closePriceDate: null, sharesSource: null, epsTtmSource: null, note: null },
    gaps: [],
  };
}

function mkPack(tables: EvidenceTable[]): EvidencePack {
  return {
    taskId: 't-compute',
    subject: '002384',
    cutoff: CUTOFF,
    builtAt: '2026-10-26T00:00:00.000Z',
    tables,
    coverage: mkCoverage(),
    packHash: '0'.repeat(64),
  };
}

// ---- 日期序列（连续自然日，字符串升序） ----

function dates(n: number): string[] {
  const out: string[] = [];
  const d = new Date('2025-01-01T00:00:00Z');
  for (let i = 0; i < n; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const FIN_COLUMNS = [
  'statDate', 'pubDate', 'MBRevenue', 'netProfit', 'epsTTM', 'YOYPNI',
  'totalShare', 'TOTAL_PARENT_EQUITY', 'SHARE_CAPITAL', 'gpMargin', 'npMargin', 'roeAvg',
] as const;

/** 累计口径季频财务：2022 全年 + 2023 全年（收入/净利同比恒 25%）。 */
function finRows(): (string | number | null)[][] {
  const data: Array<[string, string, string]> = [
    ['2022-03-31', '80', '8'],
    ['2022-06-30', '200', '20'],
    ['2022-09-30', '320', '32'],
    ['2022-12-31', '480', '48'],
    ['2023-03-31', '100', '10'],
    ['2023-06-30', '250', '25'],
    ['2023-09-30', '400', '40'],
    ['2023-12-31', '600', '60'],
  ];
  return data.map(([statDate, rev, np], i) => [
    statDate,
    '2024-04-20',
    rev,
    np,
    i >= 4 ? '5' : null, // epsTTM 仅 2023 各期可见
    i === 7 ? '0.125' : null, // YOYPNI 归母同比小数，仅最新期
    '8000',
    i === 7 ? 40000 : null,
    i === 7 ? 8000 : null,
    i === 7 ? '0.201514' : null,
    i === 7 ? '0.107370' : null,
    i === 7 ? '0.129044' : null,
  ]);
}

/** 250 根日线：全 100，基准锚点 idx0=25 / idx130=50 / idx190=80 / idx249=200。 */
function stockBars(): EvidenceTable {
  const d = dates(250);
  const close = new Array<string>(250).fill('100.0000');
  close[0] = '25.0000';
  close[130] = '50.0000';
  close[190] = '80.0000';
  close[249] = '200.0000';
  return mkTable(
    'bars-daily',
    ['date', 'open', 'close', 'amount'],
    d.map((date, i) => [date, '100.0000', close[i] ?? '100.0000', '1000']),
  );
}

/** 基准 250 根：全 100，末根 150（各窗口收益恒 50%）。 */
function benchBars(): EvidenceTable {
  const d = dates(250);
  const close = new Array<number>(250).fill(100);
  close[249] = 150;
  return mkTable('index-bars', ['日期', '开盘', '收盘'], d.map((date, i) => [date, 100, close[i] ?? 100]));
}

function fullPack(): EvidencePack {
  return mkPack([mkTable('fin-quarterly', [...FIN_COLUMNS], finRows()), stockBars(), benchBars()]);
}

function rowOf(result: ReturnType<typeof computeMetrics>, tableId: string, periodOrWindow: string | number) {
  const table = result.tables.find((t) => t.tableId === tableId);
  assert.ok(table !== undefined, `缺计算表 ${tableId}`);
  const firstCol = table.columns[0];
  assert.ok(firstCol !== undefined);
  const row = table.rows.find((r) => String(r[0]) === String(periodOrWindow));
  assert.ok(row !== undefined, `${tableId} 缺行 ${String(periodOrWindow)}`);
  const value = (col: string): string | number | null => {
    const idx = table.columns.indexOf(col);
    assert.ok(idx >= 0, `${tableId} 缺列 ${col}`);
    return row[idx] ?? null;
  };
  return { value, table };
}

describe('computeMetrics 增长与单季拆分', () => {
  it('同比精确值：来源收入字段MBRevenue/来源净利润 2023 各期均 25%', () => {
    const r = computeMetrics(fullPack());
    for (const p of ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31']) {
      assert.equal(rowOf(r, 'growth-quarterly', p).value('revenueYoYPct'), 25);
      assert.equal(rowOf(r, 'growth-quarterly', p).value('netProfitYoYPct'), 25);
    }
    // 原值字符串原样保留
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('revenueCum'), '600');
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('netProfitCum'), '60');
    // 扣非：累计和同比都缺；归母同比与小数原值独立保存
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('deductedCum'), null);
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('deductedYoYPct'), null);
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('parentNetProfitYoYPct'), 12.5);
    assert.equal(rowOf(r, 'growth-quarterly', '2023-12-31').value('parentNetProfitYoYRaw'), '0.125');
  });

  it('2023 Q1–Q4 累计拆单季：收入 100/150/150/200，净利 10/15/15/20', () => {
    const r = computeMetrics(fullPack());
    const expect: Array<[string, number, number]> = [
      ['2023-03-31', 100, 10],
      ['2023-06-30', 150, 15],
      ['2023-09-30', 150, 15],
      ['2023-12-31', 200, 20],
    ];
    for (const [p, rev, np] of expect) {
      assert.equal(rowOf(r, 'quarterly-single', p).value('revenueSingleQ'), rev);
      assert.equal(rowOf(r, 'quarterly-single', p).value('netProfitSingleQ'), np);
    }
    assert.equal(rowOf(r, 'quarterly-single', '2023-12-31').value('deductedSingleQ'), null);
  });

  it('缺上期 → 单季 null（不硬算）且入自检', () => {
    const onlyQ2 = finRows().slice(5, 8); // 2023 Q2/Q3/Q4：Q2 缺 Q1 上期
    const r = computeMetrics(mkPack([mkTable('fin-quarterly', [...FIN_COLUMNS], onlyQ2), stockBars(), benchBars()]));
    assert.equal(rowOf(r, 'quarterly-single', '2023-06-30').value('revenueSingleQ'), null);
    assert.equal(rowOf(r, 'quarterly-single', '2023-09-30').value('revenueSingleQ'), 150); // Q3 = 400−250
    const check = r.checks.find((c) => c.name === 'single-quarter-missing-prev');
    assert.ok(check !== undefined && !check.ok && check.detail.includes('revenue@2023-06-30'));
  });

  it('上年同期基数为 0 → 同比 null 并入 yoy-base-guard', () => {
    const rows = finRows();
    rows[0] = ['2022-03-31', '2024-04-20', '0', '8', null, null, '8000', null, null, null, null, null];
    const r = computeMetrics(mkPack([mkTable('fin-quarterly', [...FIN_COLUMNS], rows), stockBars(), benchBars()]));
    assert.equal(rowOf(r, 'growth-quarterly', '2023-03-31').value('revenueYoYPct'), null);
    const check = r.checks.find((c) => c.name === 'yoy-base-guard');
    assert.ok(check !== undefined && check.detail.includes('收入同比@2023-03-31'));
  });
});

describe('computeMetrics 价格表现与超额', () => {
  it('窗口收益/超额/区间成交额均值精确值', () => {
    const r = computeMetrics(fullPack());
    const expect: Array<[number, number, number, number]> = [
      [20, 100, 50, 50],
      [60, 150, 50, 100],
      [120, 300, 50, 250],
      [250, 700, 50, 650],
    ];
    for (const [w, stock, bench, excess] of expect) {
      assert.equal(rowOf(r, 'price-performance', w).value('stockReturnPct'), stock);
      assert.equal(rowOf(r, 'price-performance', w).value('benchmarkReturnPct'), bench);
      assert.equal(rowOf(r, 'price-performance', w).value('excessPct'), excess);
      assert.equal(rowOf(r, 'price-performance', w).value('avgAmount'), 1000);
    }
    // 基期日期列 = 窗口首根（len−N）
    const d = dates(250);
    assert.equal(rowOf(r, 'price-performance', 250).value('baseDate'), d[0]);
    assert.equal(rowOf(r, 'price-performance', 20).value('baseDate'), d[230]);
  });

  it('K 线不足窗口 → null；无基准表 → 基准与超额 null', () => {
    const short = mkTable('bars-daily', ['date', 'close', 'amount'], dates(10).map((date, i) => [date, String(100 + i), '1000']));
    const r = computeMetrics(mkPack([mkTable('fin-quarterly', [...FIN_COLUMNS], finRows()), short]));
    for (const w of [20, 60, 120, 250]) {
      assert.equal(rowOf(r, 'price-performance', w).value('stockReturnPct'), null);
      assert.equal(rowOf(r, 'price-performance', w).value('benchmarkReturnPct'), null);
      assert.equal(rowOf(r, 'price-performance', w).value('excessPct'), null);
    }
    const check = r.checks.find((c) => c.name === 'missing-inputs');
    assert.ok(check !== undefined && !check.ok && check.detail.includes('index-bars'));
  });
});

describe('computeMetrics 估值', () => {
  it('PE-TTM=40、PB=40（BPS=40000÷8000），最新收盘原样', () => {
    const r = computeMetrics(fullPack());
    const summary = rowOf(r, 'valuation-summary', 'latestClose');
    assert.equal(summary.value('value'), '200.0000');
    assert.equal(rowOf(r, 'valuation-summary', 'epsTtm').value('value'), '5');
    assert.equal(rowOf(r, 'valuation-summary', 'bps').value('value'), 5);
    assert.equal(rowOf(r, 'valuation-summary', 'peTtm').value('value'), 40);
    assert.equal(rowOf(r, 'valuation-summary', 'pb').value('value'), 40);
  });

  it('敏感性 ×0.7/1.0/1.3 的价格与 PE/PB', () => {
    const r = computeMetrics(fullPack());
    const approx = (got: string | number | null, want: number, tol = 1e-9): void => {
      assert.ok(got !== null && typeof got === 'number' && Math.abs(got - want) < tol, `期望 ≈${want}，实为 ${String(got)}`);
    };
    const rowOfMult = (m: number) => {
      const row = r.tables.find((t) => t.tableId === 'valuation-sensitivity')?.rows.find((x) => x[0] === m);
      assert.ok(row !== undefined, `缺乘数 ${m} 行`);
      return row;
    };
    let row = rowOfMult(0.7);
    approx(row[1] ?? null, 140);
    approx(row[2] ?? null, 28);
    approx(row[3] ?? null, 28);
    row = rowOfMult(1);
    approx(row[1] ?? null, 200);
    approx(row[2] ?? null, 40);
    approx(row[3] ?? null, 40);
    row = rowOfMult(1.3);
    approx(row[1] ?? null, 260);
    approx(row[2] ?? null, 52);
    approx(row[3] ?? null, 52);
  });

  it('缺 epsTTM/BALANCE → PE/PB null，来源注明不可得', () => {
    const cols = FIN_COLUMNS.filter((c) => c !== 'epsTTM' && c !== 'TOTAL_PARENT_EQUITY' && c !== 'SHARE_CAPITAL') as string[];
    const rows = finRows().map((r) => r.filter((_, i) => cols.includes(FIN_COLUMNS[i] ?? '')));
    const r = computeMetrics(mkPack([mkTable('fin-quarterly', [...cols], rows), stockBars(), benchBars()]));
    assert.equal(rowOf(r, 'valuation-summary', 'peTtm').value('value'), null);
    assert.equal(rowOf(r, 'valuation-summary', 'pb').value('value'), null);
    const epsCheck = r.checks.find((c) => c.name === 'eps-ttm-source');
    assert.ok(epsCheck !== undefined && epsCheck.detail.includes('不可得'));
    const bpsCheck = r.checks.find((c) => c.name === 'bps-source');
    assert.ok(bpsCheck !== undefined && !bpsCheck.ok);
  });

  it('利润率/ROE 原值与百分数', () => {
    const r = computeMetrics(fullPack());
    const row = rowOf(r, 'margins-roe', '2023-12-31');
    assert.equal(row.value('gpMargin'), '0.201514');
    assert.ok(Math.abs((row.value('gpMarginPct') as number) - 20.1514) < 1e-9);
    assert.equal(row.value('roeAvg'), '0.129044');
    assert.ok(Math.abs((row.value('roeAvgPct') as number) - 12.9044) < 1e-9);
  });

  it('空包（缺全部输入表）不抛异常，自检记录缺表', () => {
    const r = computeMetrics(mkPack([]));
    assert.equal(r.tables.find((t) => t.tableId === 'growth-quarterly')?.rows.length, 0);
    const check = r.checks.find((c) => c.name === 'missing-inputs');
    assert.ok(check !== undefined && !check.ok && check.detail.includes('fin-quarterly'));
  });
});

describe('财务语义修订', () => {
  it('负的归母同比小数转换为百分数，扣非不伪补', () => {
    const pack = mkPack([mkTable('fin-quarterly', ['statDate', 'MBRevenue', 'netProfit', 'YOYPNI'], [['2026-06-30', '90703260964.48', '46033330566.78', '-0.019516']])]);
    const result = computeMetrics(pack);
    const growth = result.tables.find((t) => t.tableId === 'growth-quarterly')!;
    assert.ok(Math.abs(Number(growth.rows[0]![growth.columns.indexOf('parentNetProfitYoYPct')]) - (-1.9516)) < 1e-12);
    assert.equal(growth.rows[0]![growth.columns.indexOf('deductedYoYPct')], null);
    assert.equal(growth.rows[0]![growth.columns.indexOf('netProfitCum')], '46033330566.78');
    assert.match(growth.unitNote!, /未标归母/);
    assert.match(growth.unitNote!, /来源收入字段 MBRevenue/);
  });
});
