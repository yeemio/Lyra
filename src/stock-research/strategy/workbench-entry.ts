import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StrategyError } from './money.js';
import { writeWorkbench } from './workbench-runner.js';

export async function runWorkbenchCli(args: string[]): Promise<void> {
  if (args.length !== 6 || args[0] !== '--request' || !args[1] || args[2] !== '--request-sha256' || !args[3] || args[4] !== '--out' || !args[5]) {
    throw new StrategyError('WORKBENCH_USAGE', 'node --import tsx src/stock-research/strategy/workbench-entry.ts --request <json> --request-sha256 <sha256> --out <directory>');
  }
  const receipt = await writeWorkbench(args[1], args[3], args[5]);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runWorkbenchCli(process.argv.slice(2));
