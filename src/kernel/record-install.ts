/**
 * Lyra · 安装门记录 CLI（EK-10.3）。W1: code-writer-pro。
 *
 * 用法：node --import tsx src/kernel/record-install.ts [lastRunJson]
 *   lastRunJson 缺省为 <cwd>/.last-journey-run.json（旅程套件产物）。
 * 环境：LYRA_PG_* 连接；LYRA_PG_SCHEMA 可指向目标 schema（测试隔离用）。
 *
 * 行为：读 {versionId, testRunId, pass, fail, green}；green===true 且 fail===0 才写
 * install_log 行（退出码 0）；否则不产生安装、退出非零。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '../db/pool.js';
import { recordInstall } from './installlog.js';

interface LastJourneyRun {
  versionId?: string;
  testRunId?: string;
  pass?: number;
  fail?: number;
  green?: boolean;
}

async function main(): Promise<number> {
  const file = process.argv[2] ?? path.join(process.cwd(), '.last-journey-run.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    console.error(`INSTALL_BLOCKED: 读不到旅程运行记录 ${file}（EK-10.3：无全绿记录的安装视为未完成）`);
    return 1;
  }
  let parsed: LastJourneyRun;
  try {
    parsed = JSON.parse(raw) as LastJourneyRun;
  } catch (err) {
    console.error(`INSTALL_BLOCKED: ${file} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`);
    return 1;
  }
  const pass = Number(parsed.pass ?? 0);
  const fail = Number(parsed.fail ?? 0);
  if (parsed.green !== true || fail > 0 || !parsed.versionId || !parsed.testRunId) {
    console.error(
      `INSTALL_BLOCKED: 旅程未全绿（versionId=${parsed.versionId ?? '(缺)'} ` +
        `testRunId=${parsed.testRunId ?? '(缺)'} pass=${pass} fail=${fail} green=${String(parsed.green)}）` +
        `——不产生安装（EK-10.3）`,
    );
    return 1;
  }
  const schema = process.env.LYRA_PG_SCHEMA;
  const pool = createPool(schema ? { schema } : undefined);
  try {
    const entry = await recordInstall(pool, {
      versionId: parsed.versionId,
      testRunId: parsed.testRunId,
      green: true,
      summary: `pass=${pass} fail=${fail}`,
      recordedAt: new Date().toISOString(),
    });
    console.log(
      `INSTALL_RECORDED id=${entry.id} version=${entry.versionId} testRun=${entry.testRunId} summary=${entry.summary} at=${entry.recordedAt}`,
    );
    return 0;
  } catch (err) {
    console.error(`INSTALL_BLOCKED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`INSTALL_BLOCKED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
