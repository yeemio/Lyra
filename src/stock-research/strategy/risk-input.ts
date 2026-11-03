import { createHash, randomUUID } from 'node:crypto';
import { canonicalJsonString, canonicalSha256 } from '../../canonical.js';
import type { AccountSnapshot } from './contracts.js';
import type { L2RiskExport } from './workbench-contracts.js';

const fieldLabels: Record<string, string> = { identity: '输入身份或确认时间', confirm: '输入确认', subject: '标的', asOf: '快照日期', cashYuan: '可用资金', maxPositionYuan: '最大持仓金额', maxLossYuan: '最大压力损失预算', stressGapPercent: '压力跳空假设', holdings: '持仓', lotCount: '持仓批数', quantity: '持有股数', sellableQuantity: '可卖股数', acquiredOn: '取得日期', unlocksOn: '解锁日期', costYuan: '该批总成本' };
function fieldLabel(field: string): string {
  const lot = /^holdings\[(\d+)\](?:\.(\w+))?$/.exec(field);
  return lot ? `第${lot[1]}批持仓${lot[2] ? ` · ${fieldLabels[lot[2]] ?? lot[2]}` : ''}` : fieldLabels[field] ?? field;
}
export class RiskInputError extends Error {
  constructor(readonly field: string, detail: string) { super(`${fieldLabel(field)}：${detail}`); }
}

export const RISK_LOT_LIMIT = 100;
export function riskLotCount(input: Record<string, string>): number {
  const raw = input.lotCount ?? '1';
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > RISK_LOT_LIMIT) throw new RiskInputError('lotCount', `请保留1至${RISK_LOT_LIMIT}个批次；空白批次不计为持仓`);
  return Number(raw);
}
const fail = (field: string, detail: string): never => { throw new RiskInputError(field, detail); };
function scaled(raw: string | undefined, field: string, decimals: number): number {
  if (!raw || !new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(raw)) return fail(field, '请填写非负数，最多两位小数');
  const [whole, part = ''] = raw.split('.');
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(part.padEnd(decimals, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail(field, '数值超过安全整数范围');
  return Number(value);
}
function shares(raw: string | undefined, field: string, minimum = 0): number {
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) return fail(field, `请填写不小于${minimum}的安全整数股数`);
  return Number(raw);
}
function date(raw: string | undefined, field: string): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) return fail(field, '请填写有效日期 YYYY-MM-DD');
  return raw;
}

/** 纯内存导出。HTTP调用者固定USER_CONFIRMED_INPUT；TEST_ONLY只供隔离夹具显式调用。 */
export function createRiskExport(input: Record<string, string>, identity: L2RiskExport['identity'] = 'USER_CONFIRMED_INPUT'): L2RiskExport {
  if (identity !== 'USER_CONFIRMED_INPUT' && identity !== 'TEST_ONLY_INPUT') return fail('identity', '未知输入身份');
  if (input.identity !== undefined || input.confirmedAt !== undefined || input.availableAt !== undefined) return fail('identity', '身份与确认时间由本机生成，不能指定');
  if (input.confirm !== 'yes') return fail('confirm', '请明确确认全部输入及风险假设');
  if (input.subject !== '601919') return fail('subject', '本工作区标的必须为601919');
  const now = new Date().toISOString();
  const asOfDate = date(input.asOf, 'asOf');
  if (asOfDate > now.slice(0, 10)) return fail('asOf', '快照日期不能晚于本次确认日期（UTC）');
  const cashFen = scaled(input.cashYuan, 'cashYuan', 2);
  const maxPositionValueFen = scaled(input.maxPositionYuan, 'maxPositionYuan', 2);
  const maxLossFen = scaled(input.maxLossYuan, 'maxLossYuan', 2);
  const stressGapBps = scaled(input.stressGapPercent, 'stressGapPercent', 2);
  if (stressGapBps >= 10_000) return fail('stressGapPercent', '百分比应不小于0且小于100');
  if (maxPositionValueFen === 0) return fail('maxPositionYuan', '最大持仓金额必须大于0');
  if (maxLossFen === 0) return fail('maxLossYuan', '压力损失预算必须大于0');
  if (maxLossFen > maxPositionValueFen) return fail('maxLossYuan', '压力损失预算不能超过最大持仓金额');
  const count = riskLotCount(input);
  if (input.holdings?.trim()) return fail('holdings', '请使用每批独立字段填写持仓');
  const keys = ['quantity', 'sellableQuantity', 'acquiredOn', 'unlocksOn', 'costYuan'] as const;
  for (const name of Object.keys(input)) {
    const lot = /^lot_(\d+)_(.+)$/.exec(name);
    if (lot && input[name]?.trim() && (Number(lot[1]) < 1 || Number(lot[1]) > count || !keys.some((key) => key === lot[2]))) return fail('holdings', '批次字段与页面批数不符，请重新录入');
  }
  const holdings: AccountSnapshot['holdings'] = [];
  for (let index = 1; index <= count; index++) {
    const field = `holdings[${index}]`;
    const raw = Object.fromEntries(keys.map((key) => [key, (input[`lot_${index}_${key}`] ?? '').trim()]));
    if (Object.values(raw).every((value) => value === '')) continue;
    const quantity = shares(raw.quantity, `${field}.quantity`, 1), sellableQuantity = shares(raw.sellableQuantity, `${field}.sellableQuantity`);
    const acquiredOn = date(raw.acquiredOn, `${field}.acquiredOn`), unlocksOn = date(raw.unlocksOn, `${field}.unlocksOn`);
    const costFen = scaled(raw.costYuan, `${field}.costYuan`, 2);
    if (sellableQuantity > quantity) return fail(`${field}.sellableQuantity`, '可卖不能超过持有');
    if (acquiredOn > asOfDate || unlocksOn <= acquiredOn) return fail(field, '取得日期不得晚于快照日；解锁日期须晚于取得日期');
    if (sellableQuantity > 0 && unlocksOn > asOfDate) return fail(`${field}.sellableQuantity`, '快照日尚未解锁，不能录为可卖');
    holdings.push({ lotId: `user-lot-${index}`, subject: input.subject!, quantity, sellableQuantity, acquiredOn, unlocksOn, costFen });
  }
  if ((input.noHoldings === 'yes') === (holdings.length > 0)) return fail('holdings', '请填写各批持仓，或明确勾选无该标的持仓，二选一');
  for (const key of ['quantity', 'sellableQuantity', 'costFen'] as const) {
    if (!Number.isSafeInteger(holdings.reduce((sum, lot) => sum + lot[key], 0))) return fail('holdings', `${key}合计超出安全整数范围`);
  }
  const asOf = `${asOfDate}T00:00:00.000Z`;
  const sourceBytes = canonicalJsonString({ schema: 'lyra-l2-confirmed-risk-input-v1', identity, subject: input.subject, confirmedAt: now, asOf, cashFen, holdings, constraints: { maxPositionValueFen, maxLossFen, stressGapBps }, confirmation: 'EXPLICIT_ALL_FIELDS_CONFIRMED' });
  const sourceSha256 = createHash('sha256').update(sourceBytes, 'utf8').digest('hex');
  const account: AccountSnapshot = { factId: `local-risk:${randomUUID()}`, artifactSha256: sourceSha256, source: 'local-user-risk-export', adapterVersion: 'user-risk-input@v1', sourcePublishedAt: now, firstObservedAt: now, recordedAt: now, availableAt: now, supersedesFactId: null, identity: identity === 'TEST_ONLY_INPUT' ? 'SYNTHETIC_ACCOUNT' : 'USER_CONFIRMED', confirmedAt: now, asOf, cashFen, holdings, constraints: { maxPositionValueFen, maxLossFen, stressGapBps } };
  const core = { schema: 'lyra-l2-risk-export-v1' as const, identity, subject: input.subject!, sourceBytes, sourceSha256, account };
  return { ...core, exportHash: canonicalSha256(core) };
}
