import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import type { DshWorkerReply, DshWorkerRequest } from './dsh.js';

const port = parentPort!;
const { openReadOnlyDshAccount } = await import(new URL(import.meta.url.endsWith('.ts') ? './dsh-native-account.ts' : './dsh-native-account.js', import.meta.url).href) as typeof import('./dsh-native-account.js');
const request = workerData as DshWorkerRequest;
const c = request.config;
const send = (reply: DshWorkerReply) => port.postMessage(reply);
let sends = 0, status: number | undefined, finishKind: string | undefined, invalidJson = false;
let account: Awaited<ReturnType<typeof openReadOnlyDshAccount>> | undefined;
const abort = new AbortController();
const nativeFetch = globalThis.fetch.bind(globalThis);
const base = c.endpoint.replace(/\/+$/u, '');
const exactURL = `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`;
// Isolation confines this fetch policy to one call. Account/profile/refresh/files and redirects cannot escape it.
globalThis.fetch = async (input, init) => {
  const outbound = new Request(input, init);
  if (outbound.url !== exactURL || outbound.method !== 'POST' || sends !== 0) throw new Error('DSH_PHYSICAL_REQUEST_DENIED');
  sends++;
  send({ type: 'sent' });
  const response = await nativeFetch(outbound, { signal: AbortSignal.any([abort.signal, outbound.signal]), redirect: 'error' });
  status = response.status;
  let bytes = 0;
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > c.maxResponseBytes) { abort.abort(); throw new Error('DSH_RESPONSE_LIMIT'); }
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await reader.cancel(); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
};

try {
  account = await openReadOnlyDshAccount(c);
  const auth = await account.resolveAuth();
  const connection = resolveAdapterOptions({ baseURL: c.endpoint, reasoningEffort: c.effort, maxTokens: c.maxTokens, streamIdleTimeoutMs: c.callWindowMs, retryPolicy: { mode: 'normal', maxRetries: 0 } });
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => auth, resolveUserId: () => randomUUID() as AnonymousUserId, prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
  const text = new Map<number, string>();
  for await (const chunk of adapter.stream({ provider: 'deepseek', model: c.modelId, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }], signal: abort.signal })) {
    if (chunk.type === 'block-end' && chunk.block.type === 'text') text.set(chunk.index, chunk.block.text);
    if (chunk.type === 'finish') finishKind = chunk.reason.kind;
  }
  if (finishKind === undefined) throw new Error('DSH_NATIVE_TERMINAL_MISSING');
  if (finishKind !== 'stop') throw new Error('DSH_OUTPUT_INCOMPLETE');
  let output: unknown;
  try { output = JSON.parse([...text.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')); }
  catch { invalidJson = true; throw new Error('DSH_OUTPUT_INVALID_JSON'); }
  send({ type: 'result', output });
} catch {
  // Never forward SDK errors, HTTP bodies, credential parser messages or native token material.
  send({ type: 'failure', code: finishKind !== undefined && finishKind !== 'stop' ? 'DSH_OUTPUT_INCOMPLETE' : invalidJson ? 'SR_OUTPUT_INVALID_JSON' : status !== undefined && status >= 400 ? 'DSH_HTTP_REJECTED' : sends ? 'SILENCE_AFTER_SEND' : 'DSH_PREPARATION_FAILED' });
} finally {
  abort.abort();
  await account?.close();
  port.close();
}
