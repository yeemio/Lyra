import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalSha256 } from '../../canonical.js';
import { createRiskExport, RiskInputError } from './risk-input.js';

export const TEST_ONLY_RISK_INPUT = { subject: '601919', asOf: '2026-10-20', cashYuan: '100000.01', maxPositionYuan: '20000', maxLossYuan: '600', stressGapPercent: '2.25', noHoldings: 'yes', confirm: 'yes' };
test('explicit risk export binds fixed source bytes, fresh knowledge times and canonical export; test identity stays synthetic', () => {
  const before = new Date().toISOString(), r = createRiskExport(TEST_ONLY_RISK_INPUT, 'TEST_ONLY_INPUT'), after = new Date().toISOString();
  assert.equal(r.identity, 'TEST_ONLY_INPUT'); assert.equal(r.account.identity, 'SYNTHETIC_ACCOUNT');
  assert.equal(r.sourceSha256, createHash('sha256').update(r.sourceBytes).digest('hex')); assert.equal(r.account.artifactSha256, r.sourceSha256);
  const { exportHash, ...core } = r; assert.equal(exportHash, canonicalSha256(core));
  const source = JSON.parse(r.sourceBytes); assert.deepEqual(source.holdings, []); assert.deepEqual(source.constraints, r.account.constraints);
  for (const time of [r.account.confirmedAt, r.account.firstObservedAt, r.account.recordedAt, r.account.availableAt]) assert.ok(time >= before && time <= after);
  assert.ok(r.account.availableAt > r.account.asOf); assert.equal(r.account.cashFen, 10000001); assert.equal(r.account.constraints.stressGapBps, 225);
  assert.equal(createRiskExport(TEST_ONLY_RISK_INPUT).account.identity, 'USER_CONFIRMED');
});
test('missing fields, unsafe values, conflicting holdings, dates and constraints fail specifically', () => {
  const cases = [ [{ cashYuan: '' }, /cashYuan/], [{ cashYuan: '1e7' }, /cashYuan/], [{ cashYuan: '-1' }, /cashYuan/], [{ cashYuan: '9007199254740992' }, /cashYuan/], [{ stressGapPercent: '100.01' }, /stressGapPercent/], [{ maxLossYuan: '20001' }, /maxLossYuan/], [{ asOf: '2026-02-30' }, /asOf/], [{ asOf: '2999-01-01' }, /asOf/], [{ subject: '600519' }, /subject/], [{ confirm: '' }, /confirm/], [{ noHoldings: '' }, /holdings/], [{ identity: 'TEST_ONLY_INPUT' }, /identity/], [{ availableAt: '2020-01-01' }, /identity/] ] as const;
  for (const [patch, expected] of cases) assert.throws(() => createRiskExport({ ...TEST_ONLY_RISK_INPUT, ...patch }), (err) => err instanceof RiskInputError && expected.test(err.field));
  const lot = (patch: Record<string, string>) => ({ ...TEST_ONLY_RISK_INPUT, noHoldings: '', lot_1_quantity: '100', lot_1_sellableQuantity: '100', lot_1_acquiredOn: '2026-10-01', lot_1_unlocksOn: '2026-10-02', lot_1_costYuan: '1000.25', ...patch });
  const fails = (input: Record<string, string>, field: string) => assert.throws(() => createRiskExport(input), (err) => err instanceof RiskInputError && err.field === field);
  fails(lot({ lot_1_sellableQuantity: '101' }), 'holdings[1].sellableQuantity');
  fails(lot({ lot_1_acquiredOn: '2026-10-20', lot_1_unlocksOn: '2026-10-21' }), 'holdings[1].sellableQuantity');
  fails(lot({ lot_1_acquiredOn: '2026-10-21', lot_1_unlocksOn: '2026-10-22' }), 'holdings[1]');
  fails(lot({ lot_1_unlocksOn: '2026-10-01' }), 'holdings[1]');
  fails(lot({ noHoldings: 'yes' }), 'holdings');
  fails(lot({ lot_1_quantity: '' }), 'holdings[1].quantity');
  fails(lot({ lotCount: '101' }), 'lotCount');
  fails(lot({ lot_2_quantity: '200' }), 'holdings');
  const r = createRiskExport(lot({ lotCount: '3', lot_2_quantity: '200', lot_2_sellableQuantity: '0', lot_2_acquiredOn: '2026-10-20', lot_2_unlocksOn: '2026-10-21', lot_2_costYuan: '2000' }), 'TEST_ONLY_INPUT');
  assert.equal(r.account.holdings.length, 2); assert.equal(r.account.holdings[0]!.costFen, 100025); assert.equal(r.account.holdings[1]!.quantity, 200);
  assert.throws(() => createRiskExport(lot({ lot_1_sellableQuantity: '101' })), /第1批持仓 · 可卖股数/);
});
