/** PR1 公开合成事实与重算窗口；不来自业务数据，不调用数据库。 */
import { canonicalSha256 } from '../canonical.js';
import type { TimePointFact } from '../contracts.js';
import { industryAsOf, type ReferenceEventLayers } from './groups.js';
import { eventWindowReturns, dailyBarsFromFacts, swIndexBarsFromFacts } from './excess.js';
import { buildGroupLibrary } from './library.js';

export function referenceFixture(materializedAt = '2026-03-01T00:00:00.000Z', id = 'event-1', lastClose = '11') {
  const facts: TimePointFact[] = [];
  const add = (row: Pick<TimePointFact, 'subjectType' | 'subjectId' | 'factKind' | 'typedValue' | 'availableAt'> & Partial<TimePointFact>) => {
    const fact: TimePointFact = { factId: `${id}-f${facts.length}`, validFrom: null, validTo: null, eventAt: null,
      sourcePublishedAt: null, firstObservedAt: row.availableAt, supersedesFactId: null, adapterVersion: 'synthetic-reference@1',
      artifactSha256: canonicalSha256(row), ...row };
    facts.push(fact); return fact;
  };
  const subject = '600101', eventTime = '2026-01-05T08:00:00.000Z';
  const evidence = add({ subjectType: 'STOCK', subjectId: subject, factKind: 'ANNOUNCEMENT', availableAt: eventTime,
    eventAt: eventTime, typedValue: { title: 'TEST_ONLY 业绩预告', text: '合成测试，非真实来源' } });
  const industryFact = add({ subjectType: 'STOCK', subjectId: subject, factKind: 'INDUSTRY_CLASS_VERSION',
    availableAt: '2021-07-30T16:00:00.000Z', validFrom: '2021-07-29T16:00:00.000Z', adapterVersion: 'sw@synthetic',
    typedValue: { 体系: '2021', 计入日期ISO: '2021-07-30', 行业代码: '340501', l1IndexCode: '801120' } });
  let n = 0;
  for (let ms = Date.parse('2026-01-06T00:00:00Z'); n < 20; ms += 86_400_000) {
    if ([0, 6].includes(new Date(ms).getUTCDay())) continue;
    const date = new Date(ms).toISOString().slice(0, 10); n++;
    add({ subjectType: 'STOCK', subjectId: subject, factKind: 'DAILY_BAR', availableAt: `${date}T07:00:00.000Z`,
      typedValue: { date, code: `sh.${subject}`, open: '10', close: n === 20 ? lastClose : '10', volume: '1000', tradestatus: '1' } });
    add({ subjectType: 'INDEX', subjectId: '801120', factKind: 'SW_INDEX_BAR', availableAt: `${date}T07:00:00.000Z`,
      typedValue: { 日期: date, 开盘: '1000', 收盘: '1000' } });
  }
  const industry = industryAsOf([industryFact], eventTime);
  const win = eventWindowReturns({ subject, eventTime, industryL1AsOf: industry!.l1IndexCode,
    bars: dailyBarsFromFacts(facts.filter((f) => f.factKind === 'DAILY_BAR')), factors: [],
    indexBars: swIndexBarsFromFacts(facts.filter((f) => f.factKind === 'SW_INDEX_BAR')) });
  const sample: ReferenceEventLayers = { subject, eventTime, eventKey: 'PERF_FORECAST', industry,
    marketCap: null, marketState: null, h1Excess: win.windows[0]!.excessReturn, h5Excess: win.windows[1]!.excessReturn,
    h20Excess: win.windows[2]!.excessReturn, invalidationDown: win.invalidation.downTriggered, invalidationUp: win.invalidation.upTriggered,
    dataGaps: win.dataGaps, lineage: { eventId: id, evidenceFactId: evidence.factId,
      windows: win.windows.map((w) => ({ h: w.h, status: w.status, endDate: w.endDate,
        maturedAt: w.endDate === null ? null : `${w.endDate}T07:00:00.000Z` })) } };
  const identity = { methodVersion: 'synthetic-reference@1', adapterVersion: 'synthetic-reference@1',
    inputAvailableAtMax: facts.map((f) => f.availableAt).sort().at(-1)!, materializedAt };
  const groups = buildGroupLibrary([sample], { ...identity, minGroupSample: 1 }).groups;
  return { facts, sample, groups, identity };
}
