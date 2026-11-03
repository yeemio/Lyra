/**
 * Lyra · 东财机构调研记录适配器真实冒烟（P2 W41b；派发预算 ≤4 真实桥调用）。
 *
 * 真实请求 2 次桥调用（601318 / 600519，池内样本，每股一次容器桥调用，内部逐页 pageSize=50），
 * ≤ 4 预算。事实身份由原始行派生（不含抓取时刻）→ 重放去重由单测与全量回填 IDENTICAL 计数
 * 证明，冒烟不重复请求。
 *
 * 断言：原始行 canonical JSON 原件入库（哈希校验读回）+ 事实落库（SURVEY_RECORD
 * subjectType=STOCK、availableAt=披露日次日 00:00+08、sourcePublishedAt=披露日 00:00+08、
 * eventAt=validFrom=调研日 00:00+08）+ as-of 读回无泄漏 + 窗界纪律（全部事实调研日 ≥ 近 2 年
 * 窗界）+ 前视防泄漏（原件无 CLOSE_PRICE/CHANGE_RATE 行情快照列）+ 事实数 = 行数 − 拒绝行数。
 *
 * 运行：node --import tsx src/adapters/emsurvey.smoke.ts
 * 目标库：默认 public schema；p1-migration 幂等应用。原件目录：env LYRA_ARTIFACTS_DIR，
 * 缺省 <repo>/data/artifacts（冒烟事实/原件并入正式库，全量回填同内容重放 → IDENTICAL 去重）。
 */
import { asOfFacts } from '../pintime/facts.js';
import { applySchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { ArtifactStore } from '../artifacts/store.js';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResponse } from './adapter-types.js';
import {
  SURVEY_NOTICE_ISO,
  SURVEY_RECEIVE_START_ISO,
  SurveyAdapter,
  makeSurveyBridgeExecutor,
  shanghaiDayStart,
  shanghaiNextDayStart,
} from './emsurvey.js';
import { surveyWindowFromIso } from '../backfill/emsurvey.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 池内两个调研活跃样本（机构调研高频股；601318/600519 实测近 2 年合法空集不入选）。 */
const CODES = ['603986', '002384'];

interface SurveySmokeRow {
  [key: string]: unknown;
}

async function main(): Promise<number> {
  const pool = createPool();
  await applySchema(pool); // 幂等
  const { applyP1Migration } = await import('./backoff.js');
  await applyP1Migration(pool);

  const artifactsDir = process.env.LYRA_ARTIFACTS_DIR ?? join(repoRoot, 'data', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const store = new ArtifactStore(artifactsDir);

  const anchor = new Date();
  const fromIso = surveyWindowFromIso(anchor);

  let bridgeCalls = 0;
  const realExec = makeSurveyBridgeExecutor();
  const countingExec = async (args: string[]): Promise<BridgeResponse> => {
    bridgeCalls += 1;
    return realExec(args);
  };
  const adapter = new SurveyAdapter({ pool, store, execBridge: countingExec });
  const nowMs = Date.now();

  const perCode: Record<string, unknown> = {};
  let totalFacts = 0;
  for (const code of CODES) {
    const r = await adapter.fetchSurvey(code, fromIso);
    const rows = JSON.parse(
      new TextDecoder().decode(await store.readBytes(r.artifact.sha256)),
    ) as SurveySmokeRow[];

    // ---- 断言：原件与事实账目自洽（含窗界外行）----
    if (r.rowCount !== rows.length) {
      throw new Error(`${code} 行数不一致：rowCount=${String(r.rowCount)} 原件=${String(rows.length)}`);
    }
    if (r.gapRows !== 0) {
      throw new Error(`${code} 桥块自校验残余缺口 ${String(r.gapRows)} 行（完成度纪律：样本股零缺口）`);
    }
    if (r.insertedFactIds.length + r.identicalFactIds.length + r.rejectedRows.length + r.windowExcludedRows !== r.rowCount) {
      throw new Error(`${code} 事实数 + 拒绝数 + 窗界外数 ≠ 行数（有未解释行）`);
    }
    for (const row of rows) {
      if ('CLOSE_PRICE' in row || 'CHANGE_RATE' in row) {
        throw new Error(`${code} 原件含行情快照列（前视泄漏防线失效）`);
      }
      if (typeof row[SURVEY_RECEIVE_START_ISO] !== 'string' || typeof row[SURVEY_NOTICE_ISO] !== 'string') {
        throw new Error(`${code} 原件行缺 *_ISO 前缀列（桥转换未生效）`);
      }
    }

    // ---- 断言：逐事实五时间字段自洽 + 窗界纪律 + 无泄漏 ----
    const facts = await asOfFacts(pool, {
      subjectType: 'STOCK', subjectId: code, factKind: 'SURVEY_RECORD', asOf: new Date(nowMs),
    });
    for (const f of facts) {
      const tv = f.typedValue as SurveySmokeRow;
      const receive = tv[SURVEY_RECEIVE_START_ISO];
      const notice = tv[SURVEY_NOTICE_ISO];
      if (typeof receive !== 'string' || typeof notice !== 'string') throw new Error(`${code} 事实缺时点字段`);
      if (f.availableAt !== shanghaiNextDayStart(notice)) {
        throw new Error(`${code} SURVEY_RECORD availableAt ≠ 披露日+1：${f.availableAt} vs notice=${notice}`);
      }
      if (f.sourcePublishedAt !== shanghaiDayStart(notice)) {
        throw new Error(`${code} SURVEY_RECORD sourcePublishedAt ≠ 披露日 00:00+08`);
      }
      if (f.eventAt !== shanghaiDayStart(receive)) {
        throw new Error(`${code} SURVEY_RECORD eventAt ≠ 调研日 00:00+08`);
      }
      if (new Date(f.availableAt).getTime() > nowMs) throw new Error(`${code} 泄漏：availableAt 在当前时刻之后`);
      if (receive < fromIso) throw new Error(`${code} 窗界纪律失效：调研日 ${receive} < 窗界 ${fromIso}`);
    }
    totalFacts += facts.length;
    const receives = (rows.map((row) => row[SURVEY_RECEIVE_START_ISO]) as string[]).sort();
    perCode[code] = {
      scope: r.scope,
      rowCount: r.rowCount,
      gapRows: r.gapRows,
      windowExcluded: r.windowExcludedRows,
      inserted: r.insertedFactIds.length,
      identical: r.identicalFactIds.length,
      rejected: r.rejectedRows.length,
      receiveRange: receives.length > 0 ? [receives[0], receives[receives.length - 1]] : null,
      artifact: { sha256: r.artifact.sha256, bytes: r.artifact.bytes },
    };
  }

  if (bridgeCalls > 4) throw new Error(`真实桥调用超预算：${String(bridgeCalls)} > 4`);
  if (totalFacts === 0) {
    throw new Error('两个样本股近 2 年事实数合计为 0——与机构调研高频股先验不符，选型/过滤需复查');
  }

  console.log(JSON.stringify({
    result: 'SMOKE PASS',
    adapterVersion: 'emsurvey@p1',
    realRequests: { bridgeCalls, budget: 4 },
    window: { fromIso, eventBasis: 'RECEIVE_START_DATE（接待日）' },
    perCode,
    asOfReadback: { totalFacts, noLeak: true },
  }, null, 2));
  await pool.end();
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error('SMOKE FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
