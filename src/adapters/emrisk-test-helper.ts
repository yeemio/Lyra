// 合成协议收据；仅供离线测试，不访问来源。
import type { BridgeResponse } from './adapter-types.js';
import { EMRISK_PROTOCOL, type EmriskCompletion, type EmriskResource, type EmriskRow } from './emrisk.js';

export function emriskCompletion(resource: EmriskResource, code: string, rowCount: number): EmriskCompletion {
  return { protocol: EMRISK_PROTOCOL, resource, code, rowCount, pages: Math.max(1, Math.ceil(rowCount / 500)),
    emptySource: rowCount === 0, artifactSha256: 'a'.repeat(64) };
}

export function emriskResponse(resource: EmriskResource, code: string, rows: EmriskRow[]): BridgeResponse {
  const pages = Math.ceil(rows.length / 500);
  const rawPages = Array.from({ length: Math.max(1, pages) }, (_, index) => ({
    page: index + 1, status: 200,
    body: JSON.stringify({ success: true, result: { pages, count: rows.length, data: rows.slice(index * 500, (index + 1) * 500) } }),
  }));
  return { ok: true, rows, meta: { protocol: EMRISK_PROTOCOL, resource, code, complete: true,
    expectedPages: pages, expectedRows: rows.length, receivedRows: rows.length, emptySource: rows.length === 0,
    httpCalls: rawPages.length, rawPages } } as unknown as BridgeResponse;
}
