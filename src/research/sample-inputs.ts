/**
 * Lyra · 真实样本输入包驱动（P2 W11: code-writer-pro，Done-when 2）。
 * 对真实库（lyra-pg public）跑 3 份样本输入包：600519 与 002384 @ 2022-06-30、
 * 510300 @ 2022-06-30（BROAD_ETF），程序校验全过后样本包 JSON 落 data/research-input-samples/。
 *
 * 用法：node --import tsx src/research/sample-inputs.ts [--out <dir>]
 *
 * 申明的固定参数（预算与版本轴；回传中登记）：
 *   cutoff = 样本日 15:00 Asia/Shanghai（收盘事实口径，P1 seal-any-date 同款）；
 *   budget = { l0 20000, l1 140000, l2 160000, total 300000 } UTF-8 字节；
 *   versions = { method 'method@p2-v1', adapter 'data@p1', planAuth 'pa-p2-sample-1' }。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import {
  assembleResearchInput,
  validateResearchInputPackage,
  type AssembleVersions,
  type InputBudget,
} from './inputs.js';

interface SampleSpec {
  subjectKind: 'STOCK' | 'BROAD_ETF';
  subject: string;
  date: string; // YYYY-MM-DD
}

const SAMPLES: SampleSpec[] = [
  { subjectKind: 'STOCK', subject: '600519', date: '2022-06-30' },
  { subjectKind: 'STOCK', subject: '002384', date: '2022-06-30' },
  { subjectKind: 'BROAD_ETF', subject: '510300', date: '2022-06-30' },
];

/** 样本预算（本驱动申明；回传登记）。 */
export const SAMPLE_BUDGET: InputBudget = {
  l0Bytes: 20_000,
  l1Bytes: 140_000,
  l2Bytes: 160_000,
  totalBytes: 300_000,
};

/** 样本版本轴（本驱动申明；回传登记）。 */
export const SAMPLE_VERSIONS: AssembleVersions = {
  methodVersion: 'method@p2-v1',
  adapterVersion: 'data@p1',
  planAuthVersion: 'pa-p2-sample-1',
};

function cutoffOfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期须 YYYY-MM-DD：${date}`);
  return new Date(`${date}T15:00:00+08:00`).toISOString();
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('research/sample-inputs.ts');

if (isMain) {
  await main();
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const outDirArg = process.argv.find((_, i, arr) => arr[i - 1] === '--out');
  const outDir = outDirArg !== undefined && process.argv.includes('--out')
    ? outDirArg
    : join(repoRoot, 'data', 'research-input-samples');
  await mkdir(outDir, { recursive: true });

  const pool = createPool();
  const store = new ArtifactStore(process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts'));
  const summaries: unknown[] = [];
  let failed = 0;
  try {
    for (const spec of SAMPLES) {
      const cutoff = cutoffOfDate(spec.date);
      const label = `${spec.subjectKind}:${spec.subject}@${spec.date}`;
      try {
        const assembled = await assembleResearchInput(pool, store, {
          subjectKind: spec.subjectKind,
          subject: spec.subject,
          cutoff,
          budget: SAMPLE_BUDGET,
          versions: SAMPLE_VERSIONS,
        });
        const validation = await validateResearchInputPackage(pool, store, assembled.package);
        const outPath = join(outDir, `${spec.subject}-${spec.date}.json`);
        await writeFile(
          outPath,
          JSON.stringify(
            {
              sample: { ...spec, cutoff, budget: SAMPLE_BUDGET, versions: SAMPLE_VERSIONS },
              inputHash: assembled.inputHash,
              inputBytes: assembled.inputBytes,
              artifactRef: assembled.artifactRef,
              layers: assembled.package.layers,
              dimensions: assembled.package.dimensions,
              seals: assembled.package.seals.map((s) => ({ sealId: s.sealId, manifestHash: s.manifestHash, facts: s.factIds.length, artifacts: s.artifactRefs.length })),
              validation,
              package: assembled.package,
            },
            null,
            1,
          ),
          'utf8',
        );
        const dimLine = assembled.package.dimensions
          .map((d) => `D${d.dimension}${d.code}:+${d.delivered.length}/↓${d.demoted.length}/G${d.gap.length}`)
          .join(' ');
        console.log(
          `[sample] ${label} PASS inputHash=${assembled.inputHash.slice(0, 16)}… inputBytes=${assembled.inputBytes} ` +
            `L0=${assembled.package.layers.l0.bytes}/${SAMPLE_BUDGET.l0Bytes} L1=${assembled.package.layers.l1.bytes}/${SAMPLE_BUDGET.l1Bytes} ` +
            `L2=${assembled.package.layers.l2.bytes}/${SAMPLE_BUDGET.l2Bytes} facts=${validation.factsChecked} ` +
            `bars=${validation.barRowsChecked} artifacts=${validation.artifactsChecked} ${dimLine}`,
        );
        summaries.push({
          label,
          inputHash: assembled.inputHash,
          inputBytes: assembled.inputBytes,
          artifact: assembled.artifactRef.sha256,
          layers: assembled.package.layers,
          dimensions: assembled.package.dimensions.map((d) => ({
            dimension: d.dimension, code: d.code,
            delivered: d.delivered.length, demoted: d.demoted.length, gap: d.gap.length,
          })),
          seals: assembled.package.seals.length,
          validation,
          outPath,
        });
      } catch (error) {
        failed += 1;
        console.log(`[sample] ${label} FAIL ${String(error).slice(0, 400)}`);
      }
    }
    await writeFile(
      join(outDir, 'SUMMARY.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), budget: SAMPLE_BUDGET, versions: SAMPLE_VERSIONS, samples: summaries }, null, 2),
      'utf8',
    );
    console.log(
      JSON.stringify({ result: failed === 0 ? 'SAMPLE INPUTS OK' : 'SAMPLE INPUTS FAILED', failed, outDir, samples: summaries.length }),
    );
  } finally {
    await pool.end();
  }
  process.exit(failed === 0 ? 0 : 1);
}
