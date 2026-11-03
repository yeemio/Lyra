import { createHash } from 'node:crypto';

/** 确定性 JSON 序列化：对象键按字典序、无空白、UTF-8。数字经 JSON 原生表示。 */
export function canonicalJsonString(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Lyra 内容哈希：canonical JSON 的 SHA-256 十六进制。所有身份哈希（manifest/清单/结论）统一用本函数。 */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value), 'utf8').digest('hex');
}
