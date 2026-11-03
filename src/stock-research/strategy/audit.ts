import { createHash } from 'node:crypto';
import type { EvidencePack } from '../contracts.js';

/** 只审已有文件；不导入数据库连接、采集器或账户模块。 */
export function auditSealedEvidence(rawBytes: Uint8Array, path: string) {
  const pack = JSON.parse(Buffer.from(rawBytes).toString('utf8')) as EvidencePack;
  const bars = pack.tables.find((t) => t.tableId === 'bars-daily');
  const benchmark = pack.tables.find((t) => t.tableId === 'index-bars');
  const dates = (t: typeof bars): string[] => {
    if (!t) return [];
    const col = t.columns.findIndex((c) => c === 'date' || c === '日期');
    return col < 0 ? [] : t.rows.map((r) => String(r[col])).sort();
  };
  const stockDays = dates(bars), benchmarkDays = dates(benchmark), overlap = stockDays.filter((d) => benchmarkDays.includes(d));
  let largestGap = { from: '', to: '', calendarDays: 0 };
  for (let i = 1; i < stockDays.length; i++) {
    const days = Math.round((Date.parse(stockDays[i]!) - Date.parse(stockDays[i - 1]!)) / 86_400_000);
    if (days > largestGap.calendarDays) largestGap = { from: stockDays[i - 1]!, to: stockDays[i]!, calendarDays: days };
  }
  return {
    identity: 'SEALED_REAL_COVERAGE_AUDIT', path, sha256: createHash('sha256').update(rawBytes).digest('hex'), packHash: pack.packHash, subject: pack.subject, cutoff: pack.cutoff,
    status: 'REJECTED_FOR_CONTINUOUS_HISTORICAL_VALIDATION',
    stock: { rows: stockDays.length, uniqueDates: new Set(stockDays).size, first: stockDays[0] ?? null, last: stockDays.at(-1) ?? null, largestCalendarGap: largestGap },
    benchmark: { rows: benchmarkDays.length, first: benchmarkDays[0] ?? null, last: benchmarkDays.at(-1) ?? null, commonDates: overlap.length, unmatchedStockDates: stockDays.filter((d) => !benchmarkDays.includes(d)).length },
    blockers: [
      { code: 'LONG_UNKNOWN_GAP', detail: `${largestGap.from} → ${largestGap.to}: ${largestGap.calendarDays} calendar days；未把缺行当作停牌` },
      { code: 'TRADING_CALENDAR_NOT_DELIVERED', detail: '表包没有逐日完整日历及其版本原件；不能把250行解释为250个连续交易日' },
      { code: 'OPENING_OBSERVATION_NOT_DELIVERED', detail: '只有日终OHLCV事实，缺独立在开盘时已可得的原始开盘事实，不能倒签取得时间' },
      { code: 'DAILY_RULE_STATE_AND_LIMIT_PROVENANCE_MISSING', detail: 'tradestatus/isST列不能替代每个交易日有可得时间的停牌/规则版本/原始限价合同' },
      { code: 'ADJUSTMENT_AND_ACTION_PIT_PROVENANCE_MISSING', detail: 'adjustFactor连接列无逐版本可得时间、公司行为股数/现金条款；不能据此复原历史取得态输入' },
      { code: 'MARKET_AND_INDUSTRY_COMMON_WINDOW_UNPROVEN', detail: 'index-bars是行业指数，缺独立市场基准及有效区间行业归属，日期亦未对齐' },
      { code: 'CONFIRMED_ACCOUNT_AND_RISK_BUDGET_MISSING', detail: '不虚构空仓、资金、数量或个人风险上限' },
    ],
    inspectedAdditionalFrozenInputs: ['data/research-input-samples/002384-2022-06-30.json（输入摘要/报告材料，不是601919完整日历+开盘+规则+账户合同）'],
    scope: '仅核对具名封存文件；没有扫描业务库，没有新采集或更改原件。未断言仓库/数据库其他位置不存在更完整资料。',
    metrics: null, efficacyAccepted: false,
  };
}
