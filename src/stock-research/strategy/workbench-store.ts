import { basename, dirname, resolve } from 'node:path';
import { canonicalSha256 } from '../../canonical.js';
import { StrategyError } from './money.js';
import { fileStrategyStore } from './real-store.js';
import type { L2WorkbenchResult, L2WorkbenchStore } from './workbench-contracts.js';
import { assertWorkbenchPin, assertWorkbenchRelativePath, parseWorkbenchRequest, readWorkbenchPackageFile, readinessWorkbenchResult, realWorkbenchSources, strictWorkbenchInputs, strictWorkbenchResult, workbenchSha256, type WorkbenchManifest } from './workbench-runner.js';

export function fileWorkbenchStore(manifestPath: string, expectedSha256: string): L2WorkbenchStore {
  assertWorkbenchPin(expectedSha256);
  const root = dirname(resolve(manifestPath)), manifestName = basename(manifestPath);
  const verified = async () => {
    const manifestBytes = await readWorkbenchPackageFile(root, manifestName);
    if (workbenchSha256(manifestBytes) !== expectedSha256) throw new StrategyError('WORKBENCH_MANIFEST_HASH_MISMATCH');
    const m = JSON.parse(manifestBytes.toString('utf8')) as WorkbenchManifest;
    if (!m || m.schema !== 'lyra-l2-workbench-manifest-v1' || m.requestId !== 'request' || m.resultId !== 'result' || !Array.isArray(m.sources)
      || new Set(m.sources.map((s) => s.id)).size !== m.sources.length || new Set(m.sources.map((s) => s.path)).size !== m.sources.length) throw new StrategyError('WORKBENCH_MANIFEST_INVALID');
    const bytes = new Map<string, Buffer>();
    for (const s of m.sources) {
      assertWorkbenchRelativePath(s.path); assertWorkbenchPin(s.sha256);
      if (!/^[a-z0-9-]+$/.test(s.id) || !['application/json', 'text/html'].includes(s.mediaType) || typeof s.label !== 'string' || s.path === manifestName) throw new StrategyError('WORKBENCH_SOURCE_INVALID');
      const buffer = await readWorkbenchPackageFile(root, s.path);
      if (workbenchSha256(buffer) !== s.sha256) throw new StrategyError('WORKBENCH_SOURCE_HASH_MISMATCH', s.id);
      bytes.set(s.id, buffer);
    }
    const source = (id: string) => {
      const s = m.sources.find((x) => x.id === id);
      if (!s) throw new StrategyError('WORKBENCH_SOURCE_MISSING', id);
      return s;
    };
    const bound = (id: string, pin: string, path: string, mediaType: string): void => {
      const s = source(id);
      if (s.sha256 !== pin || s.path !== path || s.mediaType !== mediaType) throw new StrategyError('WORKBENCH_INPUT_BINDING_INVALID', id);
    };
    if (source('request').path !== 'request.json' || source('request').mediaType !== 'application/json' || source('result').path !== 'result.json' || source('result').mediaType !== 'application/json') throw new StrategyError('WORKBENCH_MANIFEST_ROLES_INVALID');
    const request = parseWorkbenchRequest(bytes.get('request')!), requestPin = source('request').sha256;
    const expectedIds = ['request', 'result'];
    let recomputed: L2WorkbenchResult;
    if (request.mode === 'STRICT_REPLAY') {
      for (const s of strictWorkbenchInputs(request)) {
        expectedIds.push(s.id);
        bound(s.id, s.pin.sha256, `inputs/${s.id}.${s.mediaType === 'text/html' ? 'html' : 'json'}`, s.mediaType);
      }
      recomputed = strictWorkbenchResult(request, requestPin, bytes);
      if (recomputed.status === 'COMPUTED_OFFLINE') for (const id of ['plan', 'validation', 'review', 'simulation'] as const) {
        expectedIds.push(id);
        if (source(id).path !== `${id}.json` || source(id).mediaType !== 'application/json' || canonicalSha256(JSON.parse(bytes.get(id)!.toString('utf8'))) !== canonicalSha256(recomputed[id])) throw new StrategyError('WORKBENCH_OUTPUT_BINDING_INVALID', id);
      }
    } else {
      expectedIds.push('real-manifest');
      bound('real-manifest', request.manifest.sha256, 'inputs/real/client-manifest.json', 'application/json');
      const real = realWorkbenchSources(bytes.get('real-manifest')!);
      for (const s of real.sources) {
        expectedIds.push(`real-${s.id}`);
        bound(`real-${s.id}`, s.sha256, `inputs/real/${s.path}`, s.mediaType);
      }
      recomputed = readinessWorkbenchResult(request, requestPin, await fileStrategyStore(resolve(root, source('real-manifest').path), request.manifest.sha256).load());
    }
    if (canonicalSha256(expectedIds.sort()) !== canonicalSha256(m.sources.map((s) => s.id).sort())) throw new StrategyError('WORKBENCH_UNEXPECTED_SOURCE');
    const result = JSON.parse(bytes.get('result')!.toString('utf8')) as L2WorkbenchResult;
    // Recompute from the pinned input, rather than trusting a rehashed outer result.
    if (canonicalSha256(result) !== canonicalSha256(recomputed)) throw new StrategyError('WORKBENCH_RESULT_BINDING_INVALID');
    return { result, manifest: m, bytes };
  };
  return {
    async load() {
      const v = await verified();
      return { result: v.result, manifestSha256: expectedSha256, sources: v.manifest.sources.map(({ id, label, mediaType }) => ({ id, label, mediaType })) };
    },
    async source(id: string) {
      const v = await verified(), s = v.manifest.sources.find((x) => x.id === id);
      if (!s) throw new StrategyError('WORKBENCH_SOURCE_NOT_FOUND', id);
      return { bytes: v.bytes.get(id)!, mediaType: s.mediaType, sha256: s.sha256 };
    },
  };
}
