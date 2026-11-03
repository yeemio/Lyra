/**
 * Lyra · 巨潮适配器真实冒烟（P1 W5 / P1-DATA Done-when 1 的巨潮面）。
 *
 * 有界真实窗口：1 只股票（600519）× 1 个月 × 最多 2 页 → 名义 2 次真实请求
 * （topSearch 1 次 + hisAnnouncement 1 次；页未满即停）。断言四件事：
 *   1. 页响应原始 JSON bytes 作为原件入库（CAS，哈希读回一致，带 first_observed_at）；
 *   2. 公告元数据映射为 TimePointFact（factKind='ANNOUNCEMENT'，typedValue 原生字段）落库；
 *   3. as-of 读回：availableAt 晚于截点的公告被挡（POINT-IN-TIME §2.3/§3.1）；
 *   4. 日精度公告的 available_at 保守 D+1（截点在公告日收盘后不可见——§3.1 判定条款）。
 *
 * 隔离运行：独立 schema（用后即删）+ 临时原件目录；不污染主库与生产原件。
 * 运行：node --import tsx src/adapters/cninfo.smoke.ts   （退出码 0 = 冒烟通过）
 * 依赖环境：LYRA_PG_*（缺省 lyra-pg 127.0.0.1:5433）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ArtifactStore } from '../artifacts/store.js';
import { CnInfoAdapter, CninfoError, CNINFO_ADAPTER_VERSION, classifyCninfoCode, isDayPrecisionCst } from './cninfo.js';
import { applySchema, dropSchema } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { asOfFacts, insertFact, loadFact } from '../pintime/facts.js';

const STOCK = '600519';
const FROM = '2025-03-01';
const TO = '2025-03-31';
const MAX_PAGES = 2;

async function main(): Promise<void> {
  const runId = `${Date.now().toString(36)}`;
  const schema = `p1_cninfo_smoke_${runId}`;
  const admin: Pool = createPool();
  const artifactsDir = await mkdtemp(join(tmpdir(), 'lyra-w5-smoke-'));
  let pool: Pool | undefined;
  try {
    await applySchema(admin, schema);
    pool = createPool({ schema });
    const store = new ArtifactStore(artifactsDir);
    const adapter = new CnInfoAdapter({
      store,
      pauseStatePath: join(artifactsDir, 'l1-pause.json'),
      throttleMs: 2_000,
    });

    // ---- 1. 真实查询（有界窗口）----
    assert.equal(classifyCninfoCode(STOCK) !== null, true, '600519 须为主板可查代码');
    const pages = await adapter.fetchAnnouncements({ code: STOCK, from: FROM, to: TO, maxPages: MAX_PAGES });
    assert.ok(pages.length >= 1, '至少返回一页');
    assert.ok(pages.length <= MAX_PAGES, `页数不超过 ${MAX_PAGES}（有界）`);
    const totalAnnouncement = pages[0]?.raw.totalAnnouncement ?? 0;
    const announcements = pages.flatMap((page) => page.announcements);
    const facts = pages.flatMap((page) => page.facts);
    assert.ok(facts.length >= 1, '冒烟窗口内至少一条公告元数据');
    assert.equal(facts.length, announcements.length, '每条公告映射一条事实');

    // ---- 2. 原件入库断言 ----
    const pageArtifactHashes = new Set<string>();
    for (const page of pages) {
      const ref = page.artifact;
      pageArtifactHashes.add(ref.sha256);
      const bytes = await store.readBytes(ref.sha256); // 哈希校验读（不符抛 HASH_MISMATCH）
      assert.ok(bytes.length > 0);
      const reparsed = JSON.parse(new TextDecoder().decode(bytes)) as { announcements?: unknown[] };
      assert.ok(Array.isArray(reparsed.announcements));
      assert.equal(reparsed.announcements.length, page.announcements.length);
      assert.match(ref.firstObservedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(ref.mediaType, 'application/json');
    }

    // ---- 3. 事实字段断言（真实字段清单从数据本身取）----
    const sample = pages[0]?.announcements[0];
    assert.ok(sample !== undefined, '首页至少一条公告');
    const fieldInventory = Object.keys(sample).sort();
    const firstFact = facts[0];
    assert.ok(firstFact !== undefined);
    assert.equal(firstFact.subjectType, 'STOCK');
    assert.equal(firstFact.subjectId, STOCK);
    assert.equal(firstFact.factKind, 'ANNOUNCEMENT');
    assert.equal(firstFact.adapterVersion, CNINFO_ADAPTER_VERSION);
    assert.ok(pageArtifactHashes.has(firstFact.artifactSha256), '事实引用页原件哈希');
    const typed = firstFact.typedValue as Record<string, unknown>;
    assert.ok(typeof typed.title === 'string' && typed.title.length > 0);
    assert.ok(typeof typed.adjunctUrl === 'string' && typed.adjunctUrl.startsWith('finalpage/'));
    assert.ok(typeof typed.announcementTime === 'number');
    assert.ok(firstFact.factId.startsWith('cninfo:ann:'));

    // availableAt 语义（POINT-IN-TIME §3.1）：日精度保守 D+1；有时刻按时刻
    let dayPrecisionCount = 0;
    for (const fact of facts) {
      const ms = (fact.typedValue as { announcementTime: number }).announcementTime;
      const published = fact.sourcePublishedAt;
      assert.ok(published !== null);
      if (isDayPrecisionCst(ms)) {
        dayPrecisionCount += 1;
        const available = new Date(fact.availableAt).getTime();
        assert.ok(available >= ms + 86_400_000, '日精度公告 available_at 不得早于 D+1');
        assert.equal(new Date(published).getTime(), ms, 'sourcePublishedAt = announcementTime 原样转 ISO');
      } else {
        assert.equal(fact.availableAt, published, '有披露时刻按时刻');
      }
      assert.equal(fact.eventAt, fact.availableAt);
    }

    // ---- 4. 落库 + as-of 读回 ----
    for (const fact of facts) {
      const status = await insertFact(pool, fact);
      assert.ok(status === 'INSERTED' || status === 'ALREADY_INSERTED_IDENTICAL');
    }
    const loaded = await loadFact(pool, firstFact.factId);
    assert.ok(loaded !== null);
    assert.equal(loaded.factId, firstFact.factId);

    const minAvailable = Math.min(...facts.map((fact) => new Date(fact.availableAt).getTime()));
    const beforeAll = new Date(minAvailable - 3_600_000);
    const blocked = await asOfFacts(pool, { subjectId: STOCK, factKind: 'ANNOUNCEMENT', asOf: beforeAll });
    assert.equal(blocked.length, 0, 'availableAt 晚于截点：全部被挡');

    const visible = await asOfFacts(pool, { subjectId: STOCK, factKind: 'ANNOUNCEMENT', asOf: new Date() });
    assert.equal(visible.length, facts.length, '截点推进到当前：全部可见');
    assert.deepEqual(
      new Set(visible.map((fact) => fact.factId)),
      new Set(facts.map((fact) => fact.factId)),
    );

    // §3.1 边界：日精度公告在其公告日收盘后仍不可见（availableAt ≥ D+1）
    const dayFact = facts.find((fact) => isDayPrecisionCst((fact.typedValue as { announcementTime: number }).announcementTime));
    if (dayFact !== undefined) {
      const dayMs = (dayFact.typedValue as { announcementTime: number }).announcementTime;
      const atDClose = new Date(dayMs + 7 * 3_600_000); // D 当日 15:00 CST
      const atDayVisible = await asOfFacts(pool, { subjectId: STOCK, factKind: 'ANNOUNCEMENT', asOf: atDClose });
      assert.equal(
        atDayVisible.some((fact) => fact.factId === dayFact.factId),
        false,
        '截点在公告日收盘后：日精度公告仍被挡（§3.1 判定条款）',
      );
    }

    // ---- 摘要（字段名清单 + 计数；不打印公告正文标题）----
    console.log('[cninfo.smoke] PASS');
    console.log(`[cninfo.smoke] window=${FROM}~${TO} stock=${STOCK} pages=${pages.length} announcements=${announcements.length} facts=${facts.length} dayPrecision=${dayPrecisionCount}`);
    console.log(`[cninfo.smoke] verified announcement keys: ${fieldInventory.join(', ')}`);
    console.log(`[cninfo.smoke] page response top-level keys: ${Object.keys(pages[0]?.raw ?? {}).sort().join(', ')}`);
    console.log(`[cninfo.smoke] artifacts: ${[...pageArtifactHashes].map((hash) => `${hash.slice(0, 12)}…`).join(', ')} (dir=${artifactsDir})`);
    console.log(`[cninfo.smoke] adapter=${CNINFO_ADAPTER_VERSION} schema=${schema}（已隔离，结束即删）`);
  } catch (error) {
    if (error instanceof CninfoError) {
      console.error(`[cninfo.smoke] FAIL adapter error ${error.code}: ${error.message}`);
    } else {
      console.error('[cninfo.smoke] FAIL');
    }
    throw error;
  } finally {
    await dropSchema(admin, schema).catch(() => {});
    await admin.end().catch(() => {});
    if (pool !== undefined) await pool.end().catch(() => {});
    await rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
