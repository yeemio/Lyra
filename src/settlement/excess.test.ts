/**
 * Lyra · 逐日累计超额序列单测（P3 W13: code-writer-pro）。
 * 合同判定：SETTLEMENT-REVIEW SR-3.3（窗口计时证伪：含 5 停牌日 → 窗口结束日顺延）/
 * SR-3.4（e_window/MAE/失效触发同源逐日序列；e_d 公式）/ SR-3.5（行业基准版本冻结）；
 * ASHARE-RULES §7（后复权=原始价×因子链，除权日在窗口内时全链重算而非逐段）。
 * 纯函数用例注入日历/行情/指数/事件；DB 用例（行业基准 as-of 冻结）走隔离 schema。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { insertFact } from '../pintime/facts.js';
import type { TimePointFact } from '../contracts.js';
import {
  buildFactorChain,
  computeExcessSeries,
  toIndexBarView,
  type IndexBarView,
} from './excess.js';
import { SettlementError } from './decimal.js';
import type { DailyBarView } from './reference.js';

// ===== 夹具 =====

function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  let day = start;
  while (out.length < n) {
    const dow = new Date(`${day}T00:00:00.00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day);
    day = nextDay(day);
  }
  return out;
}

const CAL = weekdays('2024-01-02', 40);

interface BarSpec {
  open?: string;
  high?: string;
  low?: string;
  close: string;
  preclose?: string;
  tradestatus?: '0' | '1';
}

function stockBars(specs: Record<string, BarSpec>): Map<string, DailyBarView> {
  const bars = new Map<string, DailyBarView>();
  for (const [day, s] of Object.entries(specs)) {
    const price = (v: string | undefined): string => v ?? s.close;
    bars.set(day, {
      factId: `sb-${day}`,
      date: day,
      open: price(s.open),
      high: price(s.high),
      low: price(s.low),
      close: s.close,
      preclose: s.preclose ?? s.close,
      volume: s.tradestatus === '0' ? '0' : '1000',
      amount: s.tradestatus === '0' ? '0.0000' : '10000.0000',
      isST: '0',
      tradestatus: s.tradestatus ?? '1',
    });
  }
  return bars;
}

function indexBars(days: string[], closeOf: (day: string) => string, openOfRef: string): Map<string, IndexBarView> {
  const bars = new Map<string, IndexBarView>();
  days.forEach((day, i) => {
    bars.set(day, { factId: `ix-${day}`, date: day, open: i === 0 ? openOfRef : closeOf(day), close: closeOf(day) });
  });
  return bars;
}

/** 常规价格表：refDay 开盘 open，各日收盘 close（默认 flat），第 20 日 closeLast。 */
function flatSpecs(days: string[], open: string, close: string, closeLast: string): Record<string, BarSpec> {
  const specs: Record<string, BarSpec> = {};
  days.slice(0, 20).forEach((d, i) => {
    specs[d] = { open: i === 0 ? open : close, close: i === 19 ? closeLast : close, preclose: close };
  });
  return specs;
}

// ===== 因子链（ASHARE §7：自算、除权日落例）=====

test('因子链：事件 r = close(前有成交日)/preclose(事件日)；上市基准事件 r=1', () => {
  const days = CAL.slice(0, 5);
  const bars = stockBars({
    [days[0] as string]: { close: '10.00' }, // 上市首日（事件日，前无有成交日）
    [days[1] as string]: { close: '10.00', preclose: '5.00' }, // 除权日：r = 10/5 = 2
    [days[2] as string]: { close: '5.00' },
    [days[3] as string]: { close: '5.00', preclose: '4.00' }, // 除权日：r = 5/4 = 1.25
    [days[4] as string]: { close: '4.00' },
  });
  const chain = buildFactorChain(bars, [days[0] as string, days[1] as string, days[3] as string]);
  assert.deepEqual(
    chain.events.map((e) => ({ day: e.day, ratio: e.ratio })),
    [
      { day: days[0] as string, ratio: '1' }, // 基准事件（前无有成交日）
      { day: days[1] as string, ratio: '2' },
      { day: days[3] as string, ratio: '1.25' },
    ],
  );
  assert.equal(chain.factorAtString(days[0] as string), '1');
  assert.equal(chain.factorAtString(days[1] as string), '2');
  assert.equal(chain.factorAtString(days[2] as string), '2');
  assert.equal(chain.factorAtString(days[3] as string), '2.5'); // 全链累积 2×1.25
  assert.equal(chain.factorAtString(days[4] as string), '2.5');
});

test('因子链：事件日停牌（无行）→ preclose 取其后首个有成交日；重复事件行 r=1 天然免疫', () => {
  const days = CAL.slice(0, 4);
  const bars = stockBars({
    [days[0] as string]: { close: '10.00' },
    // days[1] 无行（停牌）且为事件日 → preclose 取 days[2]
    [days[2] as string]: { close: '4.00', preclose: '5.00' }, // r = 10/5 = 2
    [days[3] as string]: { close: '4.00', preclose: '4.00' }, // 重复事件日（preclose=前收）→ r=1
  });
  const chain = buildFactorChain(bars, [days[1] as string, days[3] as string]);
  assert.deepEqual(
    chain.events.map((e) => e.ratio),
    ['2', '1'],
  );
  assert.equal(chain.factorAtString(days[3] as string), '2');
});

test('因子链：事件晚于最后一根有成交行情 → 跳过（对可见 F(x) 无贡献）', () => {
  const days = CAL.slice(0, 3);
  const bars = stockBars({
    [days[0] as string]: { close: '10.00' },
    [days[1] as string]: { close: '10.00' },
    [days[2] as string]: { close: '10.00' },
  });
  const chain = buildFactorChain(bars, [days[2] as string, '2030-01-01']);
  assert.equal(chain.events.length, 1); // 2030 事件被跳过
  assert.equal(chain.factorAtString(days[2] as string), '1');
});

// ===== 逐日序列（SR-3.4）=====

test('无事件：e_d 逐日与 e_window 手算一致（0.2 − 0.1 = 0.1；含 e=0 精确情形）', () => {
  const days = CAL;
  const bars = stockBars(flatSpecs(days, '10.00', '10.00', '12.00'));
  const index = indexBars(days.slice(0, 20), (d) => (d === days[19] ? '1100' : '1000'), '1000');
  const r = computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [], refDay: days[0] as string });
  assert.equal(r.complete, true);
  assert.equal(r.windowEndDay, days[19]);
  assert.equal(r.eWindow, '0.1'); // (12/10 − 1) − (1100/1000 − 1)
  assert.equal(r.days[0]?.e, '0'); // 第 1 日（参考价日）
  assert.equal(r.days[18]?.e, '0');
  assert.equal(r.days[19]?.e, '0.1');
  assert.equal(r.days[19]?.index, 20);
  // e 恰为 0：两侧均不命中的取值基础
  const bars0 = stockBars(flatSpecs(days, '10.00', '10.00', '11.00'));
  const index0 = indexBars(days.slice(0, 20), () => '1000', '1000');
  index0.set(days[19] as string, { factId: 'ix-last', date: days[19] as string, open: '1000', close: '1100' });
  const r0 = computeExcessSeries({ tradingDays: days, bars: bars0, indexBars: index0, factorEventDates: [], refDay: days[0] as string });
  assert.equal(r0.eWindow, '0'); // 0.1 − 0.1 精确为 0
});

test('除权日在窗口内：全链重算（非逐段拼接）——e_window = 12/10 − 1 = 0.2', () => {
  const days = CAL;
  const specs = flatSpecs(days, '10.00', '10.00', '12.00');
  // 第 2 交易日除权（10 送 10）：r = close(day1)/preclose(day2) = 10/5 = 2；其后价格减半
  const d1 = days[0] as string;
  const d2 = days[1] as string;
  specs[d2] = { open: '5.00', close: '5.50', preclose: '5.00' };
  for (let i = 2; i < 19; i += 1) specs[days[i] as string] = { close: '5.00', preclose: '5.00' };
  specs[days[19] as string] = { close: '6.00', preclose: '5.00' };
  void d1;
  const bars = stockBars(specs);
  const index = indexBars(days.slice(0, 20), () => '1000', '1000');
  const r = computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [d2], refDay: days[0] as string });
  assert.equal(r.factorEvents.length, 1);
  assert.equal(r.factorEvents[0]?.ratio, '2');
  assert.equal(r.days[0]?.stockFactor, '1');
  assert.equal(r.days[1]?.stockFactor, '2');
  assert.equal(r.days[1]?.stockAdjClose, '11'); // 5.50 × 2
  assert.equal(r.days[1]?.e, '0.1'); // (11/10 − 1) − 0
  assert.equal(r.days[19]?.stockAdjClose, '12'); // 6.00 × 2
  assert.equal(r.eWindow, '0.2'); // (12/10 − 1) − 0；逐段拼接（原始价比 6/10 − 1 = −0.4）为错误路径
});

test('除权日在参考价日之前：F(ref) 与 F(d) 同基消去（全链，非字面 P_d×F_d/P_ref 原始价）', () => {
  const days = CAL;
  // 参考价日 = days[5]；除权日在 days[1]（r=2）
  const d0 = days[0] as string;
  const dEvt = days[1] as string;
  const refDay = days[5] as string;
  const specs: Record<string, BarSpec> = {
    [d0]: { close: '10.00' },
    [dEvt]: { open: '5.00', close: '5.00', preclose: '5.00' }, // r = 10/5 = 2
  };
  for (let i = 2; i < 25; i += 1) specs[days[i] as string] = { close: '10.00', preclose: '10.00' };
  specs[refDay] = { open: '10.00', close: '10.00', preclose: '10.00' };
  specs[days[24] as string] = { close: '11.00', preclose: '10.00' };
  const bars = stockBars(specs);
  const index = indexBars(days.slice(5, 25), () => '1000', '1000');
  const r = computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [dEvt], refDay });
  assert.equal(r.referenceOpenAdj, '20'); // 10 × F(ref)=2（后复权参考价）
  assert.equal(r.days[19]?.stockAdjClose, '22'); // 11 × 2
  assert.equal(r.eWindow, '0.1'); // (22/20 − 1) − 0；字面 P_d×F_d/P_ref原始 = 22/10 − 1 = 1.2 为错误路径
  assert.equal(r.factorEvents.length, 1);
});

test('SR-3.3 证伪：窗口内 5 个停牌日 → 窗口结束日 = 参考价日起第 25 个市场交易日', () => {
  const days = CAL;
  const specs: Record<string, BarSpec> = {};
  days.slice(0, 30).forEach((d, i) => {
    specs[d] = { open: '10.00', close: '10.00', preclose: '10.00' };
    void i;
  });
  for (const d of days.slice(3, 8)) delete specs[d]; // 5 个交易日停牌（无行）
  const bars = stockBars(specs);
  const index = indexBars(days.slice(0, 30), () => '1000', '1000');
  const r = computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [], refDay: days[0] as string });
  assert.equal(r.complete, true);
  // 参考价日(第1) + 2 个有成交 + 5 停牌 + 17 有成交 = 第 25 个市场交易日收尾
  assert.equal(r.windowEndDay, days[24]);
  assert.equal(r.days.length, 20);
  assert.deepEqual(
    r.suspensionGaps.map((g) => ({ from: g.from, to: g.to, tradingDays: g.tradingDays })),
    [{ from: days[2] as string, to: days[8] as string, tradingDays: 5 }], // to = 复牌首个有成交日
  );
});

test('窗口未满：complete=false、eWindow=null、尾部停牌间隔诊断（to=null）', () => {
  const days = CAL;
  const specs: Record<string, BarSpec> = {};
  days.slice(0, 12).forEach((d) => {
    specs[d] = { open: '10.00', close: '10.00', preclose: '10.00' };
  });
  const bars = stockBars(specs);
  const index = indexBars(days.slice(0, 12), () => '1000', '1000');
  const r = computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [], refDay: days[0] as string });
  assert.equal(r.complete, false);
  assert.equal(r.eWindow, null);
  assert.equal(r.windowEndDay, null);
  assert.equal(r.days.length, 12);
  const tail = r.suspensionGaps.find((g) => g.to === null);
  assert.ok(tail !== undefined, '尾部停牌间隔（to=null）应出现');
  assert.equal(tail.from, days[11]);
  assert.equal(tail.tradingDays, days.length - 12);
});

test('指数缺行情 → INDEX_BAR_MISSING（不用替代数据补算，SR-10.4）', () => {
  const days = CAL;
  const bars = stockBars(flatSpecs(days, '10.00', '10.00', '11.00'));
  const index = indexBars(days.slice(0, 20), () => '1000', '1000');
  index.delete(days[10] as string);
  assert.throws(
    () => computeExcessSeries({ tradingDays: days, bars, indexBars: index, factorEventDates: [], refDay: days[0] as string }),
    (e: unknown) => e instanceof SettlementError && e.code === 'INDEX_BAR_MISSING',
  );
  const indexNoRef = indexBars(days.slice(0, 20), () => '1000', '1000');
  indexNoRef.delete(days[0] as string);
  assert.throws(
    () => computeExcessSeries({ tradingDays: days, bars, indexBars: indexNoRef, factorEventDates: [], refDay: days[0] as string }),
    (e: unknown) => e instanceof SettlementError && e.code === 'INDEX_BAR_MISSING',
  );
});

test('toIndexBarView：jsonb number（float64 最短往返）与字符串同构解析', () => {
  const view = toIndexBarView({ 日期: '2024-06-19', 开盘: 17318.89, 收盘: 17281.95, swIndexCode: '801120' }, 'f1');
  assert.equal(view.date, '2024-06-19');
  assert.equal(view.open, '17318.89');
  assert.equal(view.close, '17281.95');
  const strView = toIndexBarView({ 日期: '2024-06-19', 开盘: '17318.89', 收盘: '17281.95' }, 'f2');
  assert.equal(strView.close, view.close);
  assert.throws(() => toIndexBarView({ 日期: '2024-06-19', 开盘: 1e21, 收盘: 1 }, 'f3'), (e: unknown) => e instanceof SettlementError);
  assert.throws(() => toIndexBarView({ 开盘: 1, 收盘: 1 }, 'f4'), (e: unknown) => e instanceof SettlementError);
});

// ===== DB：行业基准身份冻结（SR-3.5）=====

const SCHEMA = `w13_exc_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let adminPool: Pool;
let pool: Pool;

before(async () => {
  adminPool = createPool();
  await adminPool.query(`create schema ${SCHEMA}`);
  pool = createPool({ schema: SCHEMA });
  const ddl = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);
});

after(async () => {
  await adminPool.query(`drop schema if exists ${SCHEMA} cascade`);
  await adminPool.end();
  await pool.end();
});

const ART = 'ef'.repeat(32);

function swClassFact(args: {
  factId: string; subjectId: string; inDateISO: string; industryCode: string;
  system: string; l1IndexCode: string | null; validToISO: string | null; availableAtISO: string;
}): TimePointFact {
  const dayStart = (d: string): string => new Date(`${d}T00:00:00+08:00`).toISOString();
  return {
    factId: args.factId,
    subjectType: 'STOCK',
    subjectId: args.subjectId,
    factKind: 'INDUSTRY_CLASS_VERSION',
    typedValue: {
      股票代码: args.subjectId,
      计入日期: 0,
      行业代码: args.industryCode,
      更新日期: 0,
      计入日期ISO: args.inDateISO,
      更新日期ISO: `${args.inDateISO} 00:00:00`,
      体系: args.system,
      l1IndexCode: args.l1IndexCode,
    },
    validFrom: dayStart(args.inDateISO),
    validTo: args.validToISO === null ? null : dayStart(args.validToISO),
    eventAt: dayStart(args.inDateISO),
    sourcePublishedAt: dayStart(args.inDateISO),
    firstObservedAt: '2026-10-25T00:00:00.000Z',
    availableAt: args.availableAtISO,
    supersedesFactId: null,
    artifactSha256: ART,
    adapterVersion: 'sw@p1',
  };
}

test('DB：行业基准 as-of 冻结——2021 链头直取 / 2014 窗口携带行按窗口表 / csrc 轴不参与', async () => {
  const { industryBenchmarkAt } = await import('./excess.js');
  // 600519 形态（真实库同构）：pre2014 携带行（l1=null）→ 2021 行
  await insertFact(pool, swClassFact({
    factId: 'sw-600519-pre2014', subjectId: '600519', inDateISO: '2001-07-31', industryCode: '340301',
    system: 'pre2014', l1IndexCode: null, validToISO: '2021-07-30',
    availableAtISO: new Date('2001-08-01T00:00:00+08:00').toISOString(),
  }));
  await insertFact(pool, swClassFact({
    factId: 'sw-600519-2021', subjectId: '600519', inDateISO: '2021-07-30', industryCode: '340501',
    system: '2021', l1IndexCode: '801120', validToISO: null,
    availableAtISO: new Date('2021-07-31T00:00:00+08:00').toISOString(),
  }));
  // csrc 轴行（无「体系」字段，classVersion 形态）——不参与申万基准
  await insertFact(pool, {
    ...swClassFact({
      factId: 'csrc-600519', subjectId: '600519', inDateISO: '2001-07-31', industryCode: '000000',
      system: 'x', l1IndexCode: null, validToISO: null, availableAtISO: new Date('2020-01-01T00:00:00Z').toISOString(),
    }),
    typedValue: { code: 'sh.600519', industry: 'C15酒、饮料和精制茶制造业', classVersion: 'csrc@current' },
  });

  // 截点 2024（2021 窗口）：链头 = 2021 行，l1 直取
  const b2024 = await industryBenchmarkAt(pool, { subject: '600519', cutoff: '2024-06-17T16:00:00+08:00' });
  assert.ok(b2024 !== null);
  assert.equal(b2024.industryIndexCode, '801120');
  assert.equal(b2024.system, '2021');
  assert.equal(b2024.mintedSystem, '2021');
  assert.equal(b2024.l1IndexCodeSource, 'ROW');

  // 截点 2016（2014 窗口）：链头 = pre2014 携带行（l1=null）→ 前缀 34 按 SW2014 表 → 801120（SR-3.5 重放不变）
  const b2016 = await industryBenchmarkAt(pool, { subject: '600519', cutoff: '2016-06-30T16:00:00+08:00' });
  assert.ok(b2016 !== null);
  assert.equal(b2016.industryIndexCode, '801120');
  assert.equal(b2016.system, '2014');
  assert.equal(b2016.mintedSystem, 'pre2014');
  assert.equal(b2016.l1IndexCodeSource, 'WINDOW_TABLE');
  assert.equal(b2016.industryCode, '340301');
  // 重放一致（SR-3.5 证伪：结算读回的指数身份与当时版本一致，重放结果不变）
  const b2016replay = await industryBenchmarkAt(pool, { subject: '600519', cutoff: '2016-06-30T16:00:00+08:00' });
  assert.deepEqual(b2016, b2016replay);
});

test('DB：行业基准缺失具名——无区间含截点行 / pre2014 窗口 / as-of 不可见行', async () => {
  const { industryBenchmarkAt } = await import('./excess.js');
  // 600030 形态：2003 pre2014 行（validTo 2014-02-20）+ 2014 行（validFrom 2014-02-21, l1=801790）
  await insertFact(pool, swClassFact({
    factId: 'sw-600030-pre2014', subjectId: '600030', inDateISO: '2003-01-06', industryCode: '440301',
    system: 'pre2014', l1IndexCode: null, validToISO: '2014-02-21',
    availableAtISO: new Date('2003-01-07T00:00:00+08:00').toISOString(),
  }));
  await insertFact(pool, swClassFact({
    factId: 'sw-600030-2014', subjectId: '600030', inDateISO: '2014-02-21', industryCode: '490101',
    system: '2014', l1IndexCode: '801790', validToISO: null,
    availableAtISO: new Date('2014-02-22T00:00:00+08:00').toISOString(),
  }));
  // 2024 截点：链头 = 2014 携带行（体系 2014 ≠ 窗口 2021）→ 前缀 49 按 SW2021 表 → 801790
  const b = await industryBenchmarkAt(pool, { subject: '600030', cutoff: '2024-09-30T16:00:00+08:00' });
  assert.ok(b !== null);
  assert.equal(b.industryIndexCode, '801790');
  assert.equal(b.l1IndexCodeSource, 'WINDOW_TABLE');

  // pre2014 窗口（2013）→ null
  assert.equal(await industryBenchmarkAt(pool, { subject: '600030', cutoff: '2013-06-30T16:00:00+08:00' }), null);
  // 截点早于全部区间 → null
  assert.equal(await industryBenchmarkAt(pool, { subject: '600030', cutoff: '2002-01-01T16:00:00+08:00' }), null);
  // as-of 不可见：截点早于行 availableAt → null（600031 只有 2021 后可见行）
  await insertFact(pool, swClassFact({
    factId: 'sw-600031-late', subjectId: '600031', inDateISO: '2020-01-01', industryCode: '710101',
    system: '2014', l1IndexCode: '801750', validToISO: null,
    availableAtISO: new Date('2025-01-01T00:00:00Z').toISOString(),
  }));
  assert.equal(await industryBenchmarkAt(pool, { subject: '600031', cutoff: '2022-01-01T16:00:00+08:00' }), null);
});
