/**
 * Lyra · 研究报告读回 CLI（P2 W11: code-writer-pro）。
 * 用法：
 *   node --import tsx src/research/report-cli.ts --conclusion <id>
 *     [--schema <testSchema>] [--package <sha256>] [--a <a.json>] [--checklist <c.json>] [--j <j.json>]
 *
 * - --conclusion：从库读回结论对象（必填；--schema 用隔离 schema，测试用）。
 * - --package：输入包原件 sha256（组装器入库返回）→ 原件库校验读回 → 视图含 coverage 与证据下钻。
 * - --a/--checklist/--j：本轮 A 输出/程序清单/J 输出 JSON 文件（旅程/集成波持久化的轮产物）。
 *   缺省时视图如实呈现"缺"，不代填叙事；纯文本末行恒为合规标注。
 * 退出码：0 成功；1 用法错误；2 结论不存在。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AOutput, ConclusionObject, JOutput, ProgramChecklist } from '../contracts.js';
import { ArtifactStore } from '../artifacts/store.js';
import { readConclusion } from '../db/conclusion.js';
import { createPool } from '../db/pool.js';
import { buildReportView, renderReportText } from './report.js';
import type { ResearchInputPackage } from './inputs.js';

interface CliArgs {
  conclusionId: string;
  schema?: string;
  packageSha?: string;
  aFile?: string;
  checklistFile?: string;
  jFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { conclusionId: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--conclusion' && next !== undefined) {
      args.conclusionId = next;
      i += 1;
    } else if (arg === '--schema' && next !== undefined) {
      args.schema = next;
      i += 1;
    } else if (arg === '--package' && next !== undefined) {
      args.packageSha = next;
      i += 1;
    } else if (arg === '--a' && next !== undefined) {
      args.aFile = next;
      i += 1;
    } else if (arg === '--checklist' && next !== undefined) {
      args.checklistFile = next;
      i += 1;
    } else if (arg === '--j' && next !== undefined) {
      args.jFile = next;
      i += 1;
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  if (args.conclusionId === '') {
    console.error('用法：node --import tsx src/research/report-cli.ts --conclusion <id> [--schema <s>] [--package <sha256>] [--a <a.json>] [--checklist <c.json>] [--j <j.json>]');
    process.exit(1);
  }
  return args;
}

async function readJsonFile<T>(file: string | undefined): Promise<T | null> {
  if (file === undefined) return null;
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool(args.schema === undefined ? undefined : { schema: args.schema });
  try {
    const conclusion: ConclusionObject | null = await readConclusion(pool, args.conclusionId);
    if (conclusion === null) {
      console.error(`结论不存在：${args.conclusionId}`);
      process.exit(2);
    }
    let pkg: ResearchInputPackage | null = null;
    if (args.packageSha !== undefined) {
      const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'artifacts');
      const store = new ArtifactStore(artifactsDir);
      pkg = JSON.parse(new TextDecoder().decode(await store.readBytes(args.packageSha))) as ResearchInputPackage;
    }
    const aOutput = await readJsonFile<AOutput>(args.aFile);
    const checklist = await readJsonFile<ProgramChecklist>(args.checklistFile);
    const jOutput = await readJsonFile<JOutput>(args.jFile);
    const view = buildReportView(conclusion, pkg, aOutput, checklist, jOutput);
    console.log(renderReportText(view));
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('research/report-cli.ts');
if (isMain) {
  await main();
}
