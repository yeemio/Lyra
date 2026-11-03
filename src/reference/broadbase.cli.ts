/**
 * Lyra · 宽基状态参照库 · 全量构建 CLI（P4 / W23: code-writer-pro）。
 * 合同：docs/FREEZE-P0-20261025.md §四第 7 维；docs/PLAN.md §5 宽基状态参照〔R18〕。
 *
 * 输入：public 生产库（lyra-pg 127.0.0.1:5433）时点事实**只读**——四只跟踪指数
 * （000016/000300/000905/000852）DAILY_BAR（baostock@0.9.40-p1，P1 回填全史）。
 * 输出：broadbase_reference_library（自有新表，DDL 见 broadbase.ts）+
 * data/broadbase-reference-summary.json。
 *
 * 估值分位档：库内不可得（P1 后置缺口，FREEZE-P0 §五）→ 如实登记，次层以 20 日
 * 已实现波动三档可得替代（不是估值档，声明随全部产出强制携带）。
 * 本地计算，无网络调用。行情窗口为事后统计（全量可得），R4 修订口径声明随 summary 原样携带。
 *
 * CLI：node --import tsx src/reference/broadbase.cli.ts
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asOfFacts } from '../pintime/facts.js';
import { createPool } from '../db/pool.js';
import { dailyBarsFromFacts } from './excess.js';
import { DEFAULT_MIN_GROUP_SAMPLE, NESTED_GROUP_DECLARATION, REVISION_NOTICE } from './groups.js';
import {
  BROADBASE_HORIZONS,
  BROADBASE_INDEX_CODES,
  BROADBASE_INDEX_NAMES,
  BROADBASE_INVALIDATION_THRESHOLD_PCT,
  METHOD_VERSION,
  TREND_WINDOW_DAYS,
  VALUATION_TIER_GAP_DECLARATION,
  applyBroadbaseMigration,
  broadbaseSamplesOf,
  buildBroadbaseLibrary,
  saveBroadbaseStats,
  type BroadbaseSample,
  type VolTier,
} from './broadbase.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SUMMARY_PATH = join(repoRoot, 'data', 'broadbase-reference-summary.json');
const ADAPTER_VERSION = 'baostock@0.9.40-p1';

function sampleMatrixOf(samples: BroadbaseSample[]): unknown {
  const cell = (trend: 'UP' | 'DOWN', vol: VolTier): number =>
    samples.filter((s) => s.trend === trend && s.volTier === vol).length;
  const trendTotal = (trend: 'UP' | 'DOWN'): number => samples.filter((s) => s.trend === trend).length;
  return {
    base: samples.length,
    UP: { total: trendTotal('UP'), LOW: cell('UP', 'LOW'), MID: cell('UP', 'MID'), HIGH: cell('UP', 'HIGH') },
    DOWN: { total: trendTotal('DOWN'), LOW: cell('DOWN', 'LOW'), MID: cell('DOWN', 'MID'), HIGH: cell('DOWN', 'HIGH') },
    volTierMissing: samples.filter((s) => s.volTier === null).length,
  };
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const materializedAt = new Date().toISOString();
    const asOfNow = new Date();
    const samplesByIndex = new Map<string, BroadbaseSample[]>();
    const indexSummaries: unknown[] = [];
    let inputAvailableAtMax: string | null = null;

    for (const code of BROADBASE_INDEX_CODES) {
      const facts = await asOfFacts(pool, { subjectType: 'INDEX', subjectId: code, factKind: 'DAILY_BAR', asOf: asOfNow });
      for (const f of facts) {
        if (inputAvailableAtMax === null || f.availableAt > inputAvailableAtMax) inputAvailableAtMax = f.availableAt;
      }
      const build = broadbaseSamplesOf(code, dailyBarsFromFacts(facts));
      samplesByIndex.set(code, build.samples);
      const incomplete = Object.fromEntries(
        BROADBASE_HORIZONS.map((h) => [`${h}`, build.samples.filter((s) => (h === 1 ? s.h1 : h === 5 ? s.h5 : s.h20) === null).length]),
      ) as Record<string, number>;
      indexSummaries.push({
        indexCode: code,
        name: BROADBASE_INDEX_NAMES[code],
        firstDate: build.firstDate,
        lastDate: build.lastDate,
        barsUsable: build.barsUsable,
        monthEndSamples: build.samples.length,
        volTierBounds:
          build.volBounds === null
            ? null
            : {
                low: build.volBounds[0],
                high: build.volBounds[1],
                method: 'tercile-reserved（逐指数自身全史三等分位，等分位预留值，重建时重算）',
              },
        sampleMatrix: sampleMatrixOf(build.samples),
        forwardIncompleteWindows: incomplete,
        dataGaps: build.dataGaps,
      });
      console.log(
        `[broadbase-build] ${code} ${BROADBASE_INDEX_NAMES[code]}：K线 ${build.barsUsable}（${build.firstDate}..${build.lastDate}），月末样本 ${build.samples.length}，缺口 ${build.dataGaps.length} 种。`,
      );
    }

    const lib = buildBroadbaseLibrary(samplesByIndex, {
      minGroupSample: DEFAULT_MIN_GROUP_SAMPLE,
      methodVersion: METHOD_VERSION,
      adapterVersion: ADAPTER_VERSION,
      inputAvailableAtMax,
      materializedAt,
    });
    await applyBroadbaseMigration(pool);
    const saved = await saveBroadbaseStats(pool, lib.blocks);
    // 全量重建语义 = 库与本次构建一致。本表唯一 writer 为本 CLI，剪除上一轮残留键是安全的
    // （与 W15 事件库分表的理由之一：兄弟构建的剪枝不会跨界删行，反之亦然）。
    const existing = await pool.query<{ block_key: string }>('select block_key from broadbase_reference_library');
    const keptKeys = new Set(lib.blocks.map((b) => b.groupKey));
    const prunedKeys = existing.rows.map((r) => r.block_key).filter((k) => !keptKeys.has(k)).sort();
    for (const key of prunedKeys) {
      await pool.query('delete from broadbase_reference_library where block_key = $1', [key]);
    }
    if (prunedKeys.length > 0) {
      console.log(`[broadbase-build] 残留键清理：清除上一轮构建残留的 ${prunedKeys.length} 个过期块键：${prunedKeys.join(', ')}`);
    }

    const summary = {
      result: 'BROADBASE REFERENCE BUILD OK',
      generatedAt: materializedAt,
      scope: `四只宽基跟踪指数自身历史（${BROADBASE_INDEX_CODES.join('/')}），与六类事件库分开构建`,
      stateDefinition: {
        primary: `趋势状态：${TREND_WINDOW_DAYS} 收盘日端点比较（期末收盘 ≥ 期初收盘 → UP，端点相等归 UP）——与个股参照库市场状态层同一默认算子（groups.marketStateOf 口径，跨库可比）`,
        secondary: `${TREND_WINDOW_DAYS} 日已实现波动三档 LOW/MID/HIGH：序量 = 同窗口 19 个日收益对均值的平方偏差和（与标准差单调同序；全程精确十进制定点，不开方；均值统一截断精度 scale=10，序量确定）`,
        secondaryGap: VALUATION_TIER_GAP_DECLARATION,
        secondaryBounds: '波动三档分界 = 逐指数自身全史抽样点序量的三等分位（全库统一、逐群组不重算；等分位预留值，重建时重算——保证研究时点现场判定与库内分组用同一套分界）',
        sampling: '每月末交易日（每日历月最后一根有成交 K 线；首个抽样点需此前 ≥ 19 根 K 线；序列末月不抽——末月末根 K 线即序列末端，无法证明该月已完结，其序量不进分位分界）。选月末而非每 20 收盘日滚动：相邻月末约隔 20–23 个交易日，后续 20 日窗口基本不重叠，避免滚动抽样的高序列相关',
        returns: `后续 ${BROADBASE_HORIZONS.join('/')} 日绝对收益（收盘/收盘 − 1，指数点位无复权问题，定点）；窗口未走完 = WINDOW_INCOMPLETE（非缺口）；失效触发在已完成前缀上判定（零前缀 = 不可判定 null）`,
        invalidation: `窗口内累计绝对收益 ≤ −${BROADBASE_INVALIDATION_THRESHOLD_PCT}% / ≥ +${BROADBASE_INVALIDATION_THRESHOLD_PCT}% 两侧分列（SR-2.2 定点纪律，精确十进制阈值比较；预留值，P4 校准、P5 冻结）`,
      },
      indices: indexSummaries,
      totalSamples: lib.totalSamples,
      blocksTotal: lib.blocks.length,
      blocksSaved: saved,
      prunedStaleBlockKeys: prunedKeys,
      groupBlocks: lib.blocks.map((b) => ({
        groupKey: b.groupKey,
        indexCode: b.indexCode,
        layers: b.layers,
        sampleCount: b.sampleCount,
        h1: b.stats.h1,
        h5: b.stats.h5,
        h20: b.stats.h20,
        invalidation: b.invalidation,
        incompleteWindows: b.incompleteWindows,
      })),
      layerInputMissing: lib.layerInputMissing,
      dataGaps: lib.dataGaps,
      reservedParams: {
        BROADBASE_INVALIDATION_THRESHOLD_PCT: `${BROADBASE_INVALIDATION_THRESHOLD_PCT}（宽基失效阈值，预留值，P4 校准、P5 冻结，FREEZE-P0 §五）`,
        MIN_GROUP_SAMPLE: `${DEFAULT_MIN_GROUP_SAMPLE}（群组样本下限，预留值，与个股库同源默认，P4 冻结）`,
        TREND_WINDOW_DAYS: `${TREND_WINDOW_DAYS}（趋势/波动窗口收盘日数，预留值）`,
        VOL_TIER_BOUNDS: '逐指数全史三等分位（等分位预留值，重建时重算，P4/P5 校准冻结）',
        SAMPLING: 'month-end（月末交易日抽样，预留口径）',
      },
      nestedDeclaration: NESTED_GROUP_DECLARATION,
      revisionNotice: REVISION_NOTICE,
      valuationTierGapDeclaration: VALUATION_TIER_GAP_DECLARATION,
      versionBinding: {
        methodVersion: METHOD_VERSION,
        adapterVersion: ADAPTER_VERSION,
        inputAvailableAtMax,
        materializedAt,
      },
      summaryPath: SUMMARY_PATH,
    };
    await writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          result: 'BROADBASE REFERENCE BUILD OK',
          totalSamples: lib.totalSamples,
          blocksSaved: saved,
          prunedStaleBlockKeys: prunedKeys.length,
          dataGapKinds: lib.dataGaps.length,
          summaryPath: SUMMARY_PATH,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`[broadbase-build] 失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('reference/broadbase.cli.ts');
if (isMain) {
  await main();
}
