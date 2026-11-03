/**
 * Lyra · 行业分类版本入库与申万缺口登记（P1 W6: code-writer-pro）。
 * 合同：docs/specs/P1-DATA.md Done-when 3（行业分类版本真实样本）/5（候选行业轴）、
 * docs/specs/POINT-IN-TIME.md §2/§3（availableAt 诚实规则）。
 *
 * 实测事实（2026-10-25，真实探测一次 sw_industry，只读未写库；随后经适配器入库）：
 * BaoStock query_stock_industry 返回 **证监会行业分类**（5560/5560 行
 * industryClassification='证监会行业分类'，industry 如 'C15酒、饮料和精制茶制造业'），
 * baostock 0.9.40 包内不存在任何申万接口（全包无「申万」字样）。派发预设的
 * 「version sw-l1@2021」与事实不符——本文件不伪造版本标注：
 * - 实际入库版本轴：INDUSTRY_CLASS_VERSION_TAG = 'csrc@current'（src/adapters/baostock.ts），
 *   availableAt=抓取时刻、validFrom=null（来源未自述生效日）；
 * - 申万轴（2014 历史版 + 2021 当前版）整体登记缺口（SW2014_GAP / SW_CLASS_SOURCE_GAP），
 *   供封存 gaps 与候选计算器引用；来源落实后重算，不回填伪造。
 */
import type { Pool } from 'pg';
import { asOfFacts } from '../pintime/facts.js';
import type { BridgeRow } from './adapter-types.js';
import {
  BAOSTOCK_ADAPTER_VERSION,
  INDUSTRY_CLASS_VERSION_TAG,
  type BaoStockAdapter,
} from './baostock.js';

export { INDUSTRY_CLASS_VERSION_TAG };

/** 申万 2014 版历史时点表缺口 id（派发点名登记）。 */
export const SW2014_GAP_ID = 'SW2014_GAP';

/** 申万行业分类在 BaoStock 免费面不可得（历史 2014 版与当前 2021 版均无）缺口 id（W6 实测新增）。 */
export const SW_CLASS_SOURCE_GAP_ID = 'SW_CLASS_SOURCE_GAP';

/** 缺口登记文本（原文，写入封存 gaps 与候选清单；不得伪造来源补齐）。 */
export const SW2014_GAP =
  `${SW2014_GAP_ID}：申万 2014 版行业分类的历史时点表无免费来源，2014–2021 期间任一历史日期的行业归属` +
  `无法回填；对该区间的历史封存读不到申万口径 INDUSTRY_CLASS_VERSION 事实，按缺口处理，` +
  `不以当前快照回填历史（不得伪造）。获得付费来源或官方历史版本后另行回填。`;

export const SW_CLASS_SOURCE_GAP =
  `${SW_CLASS_SOURCE_GAP_ID}：2026-10-25 实测（真实调用 query_stock_industry 全量 5560 行），BaoStock 免费面` +
  `无任何申万行业分类（包内无申万接口；该查询实际返回证监会行业分类）。申万口径的行业轴——含 2021 当前版` +
  `快照与 2014 历史版——在当前授权数据源内整体不可得。候选计算器的行业分组暂以证监会大类` +
  `（GB/T 门类+大类，如 C15）代行并显著标注，非 PLAN §1 冻结的申万一级口径；最终申万口径待来源落实后重算。` +
  `本缺口与 SW2014_GAP 并存登记。`;

export interface SwClassImportReport {
  adapterVersion: string;
  classVersion: string;
  rowCount: number;
  insertedFacts: number;
  identicalFacts: number;
  /** 行业值为空的行（退市/未分类）按具名错误拒绝入库，不产生事实。 */
  rejectedRows: number;
  rejectionCodes: Record<string, number>;
  /** 来源自述 industryClassification 取值分布（诚实核对：应当只有 '证监会行业分类'）。 */
  classificationValues: Record<string, number>;
  /** 行内 updateDate 取值分布（来源自述的数据时点，原文保留在事实里）。 */
  updateDateValues: Record<string, number>;
  gaps: string[];
}

/**
 * 真实 1 次调用（fetchSwIndustry）入库为 INDUSTRY_CLASS_VERSION，并做诚实核对：
 * 全部行的 industryClassification 取值分布如实上报；入库后从 DB 读回统计。
 */
export async function runSwClassificationImport(
  pool: Pool,
  adapter: BaoStockAdapter,
): Promise<SwClassImportReport> {
  const result = await adapter.fetchSwIndustry(); // 真实 1 调用（login→query→logout）
  const classificationValues: Record<string, number> = {};
  const updateDateValues: Record<string, number> = {};
  const rejectionCodes: Record<string, number> = {};
  const rows = await readIndustryRows(pool);
  if (rows !== null) {
    for (const row of rows) {
      const c = row.industryClassification ?? '(空)';
      classificationValues[c] = (classificationValues[c] ?? 0) + 1;
      const u = row.updateDate ?? '(空)';
      updateDateValues[u] = (updateDateValues[u] ?? 0) + 1;
    }
  }
  for (const r of result.rejectedRows) {
    rejectionCodes[r.code] = (rejectionCodes[r.code] ?? 0) + 1;
  }
  return {
    adapterVersion: result.adapterVersion,
    classVersion: INDUSTRY_CLASS_VERSION_TAG,
    rowCount: result.rowCount,
    insertedFacts: result.insertedFactIds.length,
    identicalFacts: result.identicalFactIds.length,
    rejectedRows: result.rejectedRows.length,
    rejectionCodes,
    classificationValues,
    updateDateValues,
    gaps: [SW2014_GAP, SW_CLASS_SOURCE_GAP],
  };
}

/** 读回行业分类事实行（供分布统计；与原件同一批内容）。 */
async function readIndustryRows(pool: Pool): Promise<BridgeRow[]> {
  const facts = await asOfFacts(pool, { factKind: 'INDUSTRY_CLASS_VERSION', asOf: new Date() });
  return facts.map((f) => f.typedValue as BridgeRow);
}

/** 行业分组键：证监会大类（GB/T 门类+大类前缀，如 'C15酒、饮料和精制茶制造业' → 'C15'）。 */
export function csrcIndustryGroup(industry: string): string {
  const m = /^([A-T]\d{2})/.exec(industry.trim());
  return m?.[1] ?? 'UNCLASSIFIED';
}

// ===== CLI（直接执行本文件时跑一次真实入库；被 import 时不执行）=====

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('adapters/swclass.ts');

if (isMain) {
  const { createPool } = await import('../db/pool.js');
  const { applySchema } = await import('../db/exec.js');
  const { applyP1Migration, ConcurrencyGate } = await import('./backoff.js');
  const { ArtifactStore } = await import('../artifacts/store.js');
  const { BaoStockAdapter } = await import('./baostock.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const pool = createPool();
  try {
    await applySchema(pool);
    await applyP1Migration(pool);
    const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const adapter = new BaoStockAdapter({ pool, store: new ArtifactStore(artifactsDir) });
    const report = await runSwClassificationImport(pool, adapter);
    const reportPath = join(repoRoot, 'data', 'swclass-import-report.json');
    await writeFile(reportPath, JSON.stringify({ ...report, realRequests: 1, declaredAdapterVersion: BAOSTOCK_ADAPTER_VERSION }, null, 2), 'utf8');
    console.log(JSON.stringify({
      result: 'SWCLASS IMPORT OK',
      ...report,
      realRequests: 1,
      reportPath,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
