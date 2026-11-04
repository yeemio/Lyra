/** Public synthetic inputs only. No private pool, external model or evidence of business effectiveness. */
import { canonicalSha256 } from '../canonical.js';
import type { EvidencePack, SrModelTransport } from './contracts.js';
import { SimSrTransport, type AnalyzeInput } from './transport.js';

export function syntheticInitialEvidence(taskId: string, subject = '600101', cutoff = '2026-11-01T00:00:00.000Z'): EvidencePack {
  const core: Omit<EvidencePack, 'packHash'> = {
    taskId, subject, cutoff, builtAt: cutoff,
    tables: [{ tableId: 'fin-quarterly', title: '公开合成财务', columns: ['statDate', 'MBRevenue', 'netProfit'],
      rows: [['2026-09-30', 1000, 100]], unitNote: 'TEST_ONLY', cutoff,
      locators: [{ kind: 'FACT', factId: 'synthetic-fact', factKind: 'FINANCIAL', subjectId: subject, availableAt: cutoff }] }],
    coverage: { financials: { periods: 1, latestPeriod: '2026-09-30', note: 'TEST_ONLY' },
      bars: { count: 0, firstDate: null, lastDate: null, note: null },
      announcements: { count: 0, latestTitleAt: null, note: null }, margin: { count: 0, latestDate: null, note: null },
      holderCount: { count: 0, latestDate: null, note: null }, pledge: { count: 0, latestDate: null, note: null },
      industry: { swL1: null, note: null }, valuationInputs: { closePriceDate: null, sharesSource: null, epsTtmSource: null, note: null },
      gaps: ['TEST_ONLY: 无真实资料；不改变历史/业务接受'] },
  };
  return { ...core, packHash: canonicalSha256(core) };
}

export class SyntheticRecoveryTransport implements SrModelTransport {
  readonly calls: { kind: string; callId: string; input: unknown }[] = [];
  private readonly inner = new SimSrTransport();
  describe() { return { provider: 'synthetic-recovery-only', simulated: true, modelId: 'no-external-model' }; }
  before?: (kind: string, input: unknown) => void | Promise<void>;
  async dispatch(kind: Parameters<SrModelTransport['dispatch']>[0], ctx: Parameters<SrModelTransport['dispatch']>[1], payload: unknown) {
    this.calls.push({ kind, callId: ctx.callId, input: structuredClone(payload) });
    await this.before?.(kind, payload);
    ctx.signal?.throwIfAborted();
    if (kind === 'ANALYZE') {
      const input = payload as AnalyzeInput;
      return { sections: input.sectionKeys.map((key) => ({ key, narrative: '公开合成章节，非业务判断', findings: [],
        tables: input.tables.slice(0, 1).map((t) => t.tableId), gaps: [],
        ...(key === 'outlook' ? { scenarios: ['基准', '改善', '恶化'].map((name) => ({ name, condition: '合成条件', implication: '不可外推' })) } : {}) })), citations: [] };
    }
    return this.inner.dispatch(kind, ctx, payload);
  }
}
