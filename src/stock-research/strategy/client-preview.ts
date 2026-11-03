/** 只为本轮读回启动自己的回环临时实例；复用真实客户端路由，绝不调用main/worker/schema。 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { defaultSrPlanBudget } from '../contracts.js';
import { createSrServer, type SrFullDeps } from '../server.js';
import { fileStrategyStore } from './real-store.js';
import { fileWorkbenchStore } from './workbench-store.js';

export interface WorkbenchFileInput { manifestPath: string; manifestSha256: string }

export function realFileClientDeps(manifestPath: string, manifestSha256: string, workbench?: WorkbenchFileInput): SrFullDeps {
  // 首页的只读空列表替身，不连接业务库；所有事务/写语句均失败，非生产仓储或permit账。
  const noDatabase = {
    async query(sql: string) {
      if (/^\s*select\s/i.test(sql) && /\bfrom\s+(sr_task|sr_account|sr_quota_usage)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('BUSINESS_DATABASE_FORBIDDEN_IN_FILE_PREVIEW');
    },
    async connect() { throw new Error('BUSINESS_DATABASE_FORBIDDEN_IN_FILE_PREVIEW'); },
  } as unknown as Pool;
  return {
    srPool: noDatabase, dataPool: noDatabase,
    config: { port: 0, bind: '127.0.0.1', adminUser: null, adminPassword: null, sessionTtlMs: 3_600_000, mode: 'local' },
    localAccountId: '00000000-0000-4000-8000-000000006019', localCsrf: randomUUID(),
    strategyStore: fileStrategyStore(manifestPath, manifestSha256),
    ...(workbench ? { workbenchStore: fileWorkbenchStore(workbench.manifestPath, workbench.manifestSha256) } : {}),
    transport: { describe: () => ({ provider: 'UNAUTHORIZED_FILE_CLIENT', simulated: false, modelId: null }), dispatch: async () => { throw new Error('MODEL_CALL_FORBIDDEN_IN_FILE_PREVIEW'); } },
    budget: defaultSrPlanBudget(), outputDir: fileURLToPath(new URL('../../../delivery/CODEX-STRATEGY-CLIENT-20261029/runtime', import.meta.url)),
  };
}

export async function startRealFileClient(manifestPath: string, manifestSha256: string, port = 0, workbench?: WorkbenchFileInput) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PREVIEW_PORT');
  const deps = realFileClientDeps(manifestPath, manifestSha256, workbench);
  await deps.strategyStore!.load(); // 先校验真实文件，失败不开服务，不回退模拟。
  if (deps.workbenchStore) await deps.workbenchStore.load(); // 独立校验工作区身份，不从坏文件回退。
  const server = createSrServer(deps);
  // port=0由OS原子选空闲端口；指定端口占用就报错，不切换/停止任何已有实例。
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); }); });
  const address = server.address() as AddressInfo;
  return { server, deps, baseUrl: `http://127.0.0.1:${address.port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), values = new Map<string, string>();
  if (args.length % 2 !== 0) throw new Error('USAGE: --manifest <path> --sha256 <pin> [--workbench-manifest <path> --workbench-sha256 <pin>] [--port 0]');
  for (let i = 0; i < args.length; i += 2) { if (!['--manifest', '--sha256', '--workbench-manifest', '--workbench-sha256', '--port'].includes(args[i]!)) throw new Error('UNKNOWN_PREVIEW_ARGUMENT'); values.set(args[i]!, args[i + 1]!); }
  const manifestPath = values.get('--manifest'), pin = values.get('--sha256');
  if (!manifestPath || !pin) throw new Error('EXPLICIT_REAL_MANIFEST_AND_SHA256_REQUIRED');
  const workbenchPath = values.get('--workbench-manifest'), workbenchPin = values.get('--workbench-sha256');
  if (Boolean(workbenchPath) !== Boolean(workbenchPin)) throw new Error('EXPLICIT_WORKBENCH_MANIFEST_AND_SHA256_REQUIRED');
  const workbench = workbenchPath && workbenchPin ? { manifestPath: workbenchPath, manifestSha256: workbenchPin } : undefined;
  const { server, baseUrl } = await startRealFileClient(manifestPath, pin, Number(values.get('--port') ?? '0'), workbench);
  const runtime = fileURLToPath(new URL(workbench ? '../../../delivery/CODEX-STRATEGY-CLIENT-20261029/workbench-20261031/client/runtime' : '../../../delivery/CODEX-STRATEGY-CLIENT-20261029/runtime', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const receipt = { identity: 'OWN_TEMPORARY_LOOPBACK_CLIENT', pid: process.pid, startedAt: new Date().toISOString(), baseUrl, route: `${baseUrl}/strategies/601919`, api: `${baseUrl}/api/strategies/601919`, manifestPath: resolve(manifestPath), manifestSha256: pin, ...(workbench ? { workbench: { manifestPath: resolve(workbench.manifestPath), manifestSha256: workbench.manifestSha256, route: `${baseUrl}/strategies/601919/workbench`, api: `${baseUrl}/api/strategies/601919/workbench` } } : {}), database: 'ISOLATED_READ_ONLY_EMPTY_LIST_SUBSTITUTE', modelCalls: 0, workerStarted: false, schemaApplied: false, installed: false };
  await writeFile(join(runtime, 'server-receipt.json'), JSON.stringify(receipt, null, 2)+'\n');
  process.stdout.write(JSON.stringify(receipt)+'\n');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
