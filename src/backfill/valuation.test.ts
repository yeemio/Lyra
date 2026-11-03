/**
 * Lyra · 指数估值回填 runner 单测（P2 W31: code-writer-pro）。不碰外网、不碰 DB：
 * 只测计划构建与覆盖核验两个纯函数（真实回填走 src/backfill/valuation.ts CLI，缓存断点续跑）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildValuationPlan, coverageChecksFor } from './valuation.js';
import type { ValuationRow } from '../adapters/valuation.js';

test('buildValuationPlan：4 宽基 ×（csindex + lg_pe + lg_pb）+ 全A ×2 = 14 步，顺序固定', () => {
  const plan = buildValuationPlan();
  assert.equal(plan.length, 14);
  assert.deepEqual(
    plan.map((s) => `${s.command}:${s.subject}`).slice(0, 4),
    ['csindex_daily:000016', 'csindex_daily:000300', 'csindex_daily:000905', 'csindex_daily:000852'],
  );
  assert.deepEqual(
    plan.map((s) => `${s.command}:${s.subject}:${s.params.join(',')}`).slice(4, 12),
    [
      'lg_pe:000016:sz50', 'lg_pb:000016:sz50',
      'lg_pe:000300:hs300', 'lg_pb:000300:hs300',
      'lg_pe:000905:zz500', 'lg_pb:000905:zz500',
      'lg_pe:000852:zz1000', 'lg_pb:000852:zz1000',
    ],
  );
  assert.deepEqual(
    plan.map((s) => `${s.command}:${s.subject}`).slice(12),
    ['all_a_pe:ALL-A', 'all_a_pb:ALL-A'],
  );
});

test('coverageChecksFor：csindex 窗口 15–30 行且末行近期；行数越界判失败', () => {
  const now = new Date('2026-10-25T12:00:00.000Z').getTime();
  const rows: ValuationRow[] = Array.from({ length: 20 }, (_, i) => ({
    日期ISO: new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10),
  }));
  const ok = coverageChecksFor('csindex_daily', '000300', rows, now);
  assert.equal(ok[0]!.ok, true);
  assert.equal(ok[1]!.ok, true);

  const tooFew = coverageChecksFor('csindex_daily', '000300', rows.slice(0, 5), now);
  assert.equal(tooFew[0]!.ok, false); // 窗口行数 < 15 = 来源形态漂移
  const stale = coverageChecksFor('csindex_daily', '000300', rows.map((r) => ({ 日期ISO: '2020-01-01' })), now);
  assert.equal(stale[1]!.ok, false); // 末行过旧
});

test('coverageChecksFor：lg 月末全史深度（≥200 行 / zz1000 ≥130 且首行 ≤2015-01）', () => {
  const now = new Date('2026-10-25T12:00:00.000Z').getTime();
  // 构造 262 行月末序列 2005-01 → 2026-10
  const dates: string[] = [];
  for (let y = 2005; y <= 2026; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      if (y === 2026 && m > 10) break;
      dates.push(`${String(y)}-${String(m).padStart(2, '0')}-28`);
    }
  }
  dates[dates.length - 1] = '2026-10-23';
  const rows: ValuationRow[] = dates.map((d) => ({ 日期: d, 指数: 1, 市净率: 1, 等权市净率: 1, 市净率中位数: 1 }));

  const zz500 = coverageChecksFor('lg_pb', '000905', rows, now);
  assert.ok(zz500.every((c) => c.ok), zz500.map((c) => c.detail).join('; '));

  // zz1000：2014-10 起 145 行 → 首行 ≤2015-01、行数 ≥130 通过；删到 100 行失败
  const zz1000Rows = rows.slice(rows.length - 145);
  const zz1000 = coverageChecksFor('lg_pb', '000852', zz1000Rows, now, { '000852': '2015-01-01' });
  assert.ok(zz1000.every((c) => c.ok), zz1000.map((c) => c.detail).join('; '));
  const tooShort = coverageChecksFor('lg_pb', '000852', zz1000Rows.slice(0, 100), now, { '000852': '2015-01-01' });
  assert.equal(tooShort[0]!.ok, false);

  // zz500：全史自 2007-01-31（指数 2007-01-15 发布）——门槛 2007-02-01；2007 起序列对 2006 门槛判失败
  const zz500From2007: ValuationRow[] = [];
  for (let y = 2007; y <= 2026; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      if (y === 2026 && m > 1) break;
      zz500From2007.push({ 日期: `${String(y)}-${String(m).padStart(2, '0')}-28`, 指数: 1, 等权静态市盈率: 1, 静态市盈率: 1, 静态市盈率中位数: 1, 等权滚动市盈率: 1, 滚动市盈率: 1, 滚动市盈率中位数: 1 });
    }
  }
  zz500From2007[zz500From2007.length - 1] = { ...zz500From2007[zz500From2007.length - 1]!, 日期: '2026-10-23' };
  const zz500ok = coverageChecksFor('lg_pe', '000905', zz500From2007, now, { '000905': '2007-02-01' });
  assert.ok(zz500ok.every((c) => c.ok), zz500ok.map((c) => c.detail).join('; '));
  const zz500wrong = coverageChecksFor('lg_pe', '000905', zz500From2007, now, { '000905': '2006-01-01' });
  assert.equal(zz500wrong[1]!.ok, false); // 2007 起点对 2006 门槛应判失败（门槛语义自查）

  // 末行过旧（来源断更）判失败
  const staleRows = rows.map((r) => ({ ...r, 日期: r['日期'] === '2026-10-23' ? '2026-06-30' : r['日期'] }));
  const stale = coverageChecksFor('lg_pb', '000905', staleRows, now);
  assert.equal(stale[2]!.ok, false);
});

test('coverageChecksFor：all_a（date 小写列名）与空响应判失败', () => {
  const now = new Date('2026-10-25T12:00:00.000Z').getTime();
  const rows: ValuationRow[] = Array.from({ length: 262 }, (_, i) => ({
    date: i === 261 ? '2026-10-23' : `20${String(5 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-28`,
  }));
  const ok = coverageChecksFor('all_a_pe', 'ALL-A', rows, now);
  assert.ok(ok.every((c) => c.ok));
  const empty = coverageChecksFor('all_a_pe', 'ALL-A', [], now);
  assert.equal(empty[0]!.ok, false);
});
