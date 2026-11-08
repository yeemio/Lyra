/** 新结论在落库前保存可核验的原输入/A/清单/J；旧结论与旧哈希不回写。 */
import type { Pool } from 'pg';
import { canonicalJsonString } from '../canonical.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { buildConclusionObject, type ConclusionInput } from '../conclusion/object.js';
import { persistConclusion } from '../db/conclusion.js';
import { researchTraceOf } from './validation.js';

export async function persistResearchConclusion(pool: Pool, store: ArtifactStore, input: ConclusionInput) {
  const checked = buildConclusionObject(input); // 先校验，失败不产生结论或有效证据原件
  const trace = researchTraceOf({ input: input.researchInput, aOutput: input.aOutput,
    checklist: input.checklist, jOutput: input.jOutput,
    ...(input.checklistCoverage === undefined ? {} : { checklistCoverage: input.checklistCoverage }) });
  const ref = await store.put(new TextEncoder().encode(canonicalJsonString(trace)), 'application/json', checked.createdAt);
  if (ref.sha256 !== checked.evidence.researchTraceSha256) throw new Error('RESEARCH_TRACE_HASH_MISMATCH');
  return persistConclusion(pool, input);
}
