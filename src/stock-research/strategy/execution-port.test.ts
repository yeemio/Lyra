/** Pure SQL/transport-double compatibility only; expressly not a PostgreSQL gate. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { KernelError } from '../../contracts.js';
import { callSrModel } from '../engine.js';
import { defaultSrPlanBudget, type SrModelTransport } from '../contracts.js';
import { registerSrFrozenReview, srGetCall } from '../store.js';
import { IsolatedSrPool } from './review-isolated.js';

test('isolated strategy SQL port keeps original input/checkpoint/call IDs and never resends UNKNOWN', async () => {
  const db = new IsolatedSrPool(), pool = db.asPool(), taskId = randomUUID(), aId = randomUUID(), jId = randomUUID();
  const budget = { ...defaultSrPlanBudget(), planAuthVersion: 'public-synthetic-strategy-port' };
  await registerSrFrozenReview(pool, { taskId, accountId: randomUUID(), subject: '600101', subjectName: 'TEST_ONLY',
    focus: 'FULL', emphasis: 'FROZEN_STRATEGY_REVIEW:TEST_ONLY', horizon: 'MID_TERM', cutoff: '2026-11-01T00:00:00.000Z',
    idemKey: 'TEST_ONLY', methodVersion: 'test-method', adapterVersion: 'test-adapter', planAuthVersion: budget.planAuthVersion,
    steps: [{ stepId: aId, stepKind: 'A_FINAL', sequence: 1 }, { stepId: jId, stepKind: 'JUDGE', sequence: 2 }] });
  let sends = 0;
  const transport: SrModelTransport = { describe: () => ({ provider: 'SQL_DOUBLE_NOT_PG', modelId: 'no-model', simulated: true }),
    dispatch: async (step, ctx) => { assert.equal(db.sent(ctx.callId), true); sends++;
      if (step === 'JUDGE') throw new KernelError('TIMEOUT'); return { text: 'synthetic' }; } };
  const deps = { srPool: pool, transport, budget, lease: db.lease };
  const args = { contract: { taskId, stepId: aId, methodVersion: 'test-method', planAuthVersion: budget.planAuthVersion,
    deadline: new Date(Date.now()+60000).toISOString() }, modelStep: 'A_FINAL' as const, input: { marker: 'TEST_ONLY' }, validate: (v: unknown) => v };
  const a = await callSrModel(deps, args), again = await callSrModel(deps, args);
  assert.equal(a.permit.callId, again.permit.callId); assert.deepEqual(a.output, again.output); assert.equal(sends, 1);
  const judge = { ...args, contract: { ...args.contract, stepId: jId }, modelStep: 'JUDGE' as const };
  await assert.rejects(callSrModel(deps, judge), { code: 'TIMEOUT' });
  await assert.rejects(callSrModel(deps, judge), { code: 'REQUEST_UNKNOWN' });
  assert.equal(sends, 2); assert.equal(db.snapshot().calls.length, 2);
  assert.equal((await srGetCall(pool, String(db.snapshot().calls[1]!.call_id)))!.state, 'UNKNOWN');
});
