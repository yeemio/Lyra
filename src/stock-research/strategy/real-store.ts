import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertRealDataset, assertRealView, type RealDailyDataset, type RealStrategyView } from './real-research.js';
import { StrategyError } from './money.js';
import { assertRealReviewDependencies, assertRealReviewInput, assertRealReviewResult, type RealReviewInput, type RealReviewResult } from './real-review.js';

export interface RealClientManifest {
  schema: 'lyra-real-strategy-client-manifest-v1';
  datasetId: string;
  researchId: string;
  review?: { baseManifestId: string; inputId: string; resultId: string };
  sources: { id: string; path: string; sha256: string; mediaType: 'application/json' | 'text/html'; label: string }[];
}
export interface RealStrategyStore {
  load(): Promise<{ data: RealDailyDataset; view: RealStrategyView; manifestSha256: string; researchReview?: RealReviewResult }>;
  source(id: string): Promise<{ bytes: Buffer; mediaType: string; sha256: string }>;
}

export function fileStrategyStore(manifestPath: string, expectedSha256: string): RealStrategyStore {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new StrategyError('STRATEGY_MANIFEST_PIN_REQUIRED');
  const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const directory = dirname(resolve(manifestPath));
  const manifest = async (): Promise<RealClientManifest> => {
    const bytes = await readFile(manifestPath);
    if (hash(bytes) !== expectedSha256) throw new StrategyError('STRATEGY_MANIFEST_HASH_MISMATCH');
    const m = JSON.parse(bytes.toString('utf8')) as RealClientManifest;
    if (m.schema !== 'lyra-real-strategy-client-manifest-v1' || !Array.isArray(m.sources) || new Set(m.sources.map((s) => s.id)).size !== m.sources.length) throw new StrategyError('STRATEGY_MANIFEST_INVALID');
    for (const s of m.sources) {
      const r = relative(directory, resolve(directory, s.path));
      if (!/^[a-z0-9-]+$/.test(s.id) || r.startsWith('..') || isAbsolute(r) || !/^[a-f0-9]{64}$/.test(s.sha256) || !['application/json', 'text/html'].includes(s.mediaType)) throw new StrategyError('STRATEGY_SOURCE_PATH_INVALID');
    }
    return m;
  };
  const source = async (id: string) => {
    const m = await manifest(), s = m.sources.find((x) => x.id === id);
    if (!s) throw new StrategyError('STRATEGY_SOURCE_NOT_FOUND');
    const bytes = await readFile(resolve(directory, s.path));
    if (hash(bytes) !== s.sha256) throw new StrategyError('STRATEGY_SOURCE_HASH_MISMATCH', id);
    return { bytes, mediaType: s.mediaType, sha256: s.sha256 };
  };
  return {
    source,
    async load() {
      const m = await manifest();
      const data = JSON.parse((await source(m.datasetId)).bytes.toString('utf8')) as RealDailyDataset;
      const view = JSON.parse((await source(m.researchId)).bytes.toString('utf8')) as RealStrategyView;
      assertRealDataset(data); assertRealView(view, data);
      for (const s of data.sources) if (!m.sources.some((x) => x.id === s.id && x.sha256 === s.sha256)) throw new StrategyError('STRATEGY_LINEAGE_NOT_PINNED', s.id);
      if (!m.review) return { data, view, manifestSha256: expectedSha256 };
      const base = await source(m.review.baseManifestId);
      const baseManifest = JSON.parse(base.bytes.toString('utf8')) as RealClientManifest;
      if (baseManifest.schema !== m.schema || baseManifest.review || baseManifest.datasetId !== m.datasetId || baseManifest.researchId !== m.researchId || !Array.isArray(baseManifest.sources)
        || baseManifest.sources.some((s) => !m.sources.some((r) => r.id === s.id && r.sha256 === s.sha256 && r.mediaType === s.mediaType))) throw new StrategyError('STRATEGY_REVIEW_BASE_MANIFEST_INVALID');
      const input = JSON.parse((await source(m.review.inputId)).bytes.toString('utf8')) as RealReviewInput;
      const result = JSON.parse((await source(m.review.resultId)).bytes.toString('utf8')) as RealReviewResult;
      assertRealReviewInput(input, data, view, base.sha256);
      await assertRealReviewDependencies(input, { source, load: async () => ({ data, view, manifestSha256: base.sha256 }) }, data, view);
      assertRealReviewResult(result, input);
      return { data, view, manifestSha256: expectedSha256, researchReview: result };
    },
  };
}
