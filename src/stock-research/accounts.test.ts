/**
 * sr 账户/会话单测 · code-writer-pro。隔离 schema + 真实 PG（127.0.0.1:5433）。
 * 覆盖：创建/重复用户名唯一冲突具名错误、认证（成功/密码错/禁用）、会话签发→
 * resolve→过期（短 TTL）→revoke 后拒绝、账户禁用联动、touch、purge 清理、
 * 密码记录不含明文（直查库断言）。
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applySchema, dropSchema, srMigrationSqlUrl } from '../db/exec.js';
import { createPool } from '../db/pool.js';
import { defaultTrialQuota } from './contracts.js';
import {
  SrAccountError,
  authenticate,
  createAccount,
  createSession,
  disableAccount,
  getAccount,
  purgeExpiredSessions,
  resolveSession,
  revokeSession,
  setAccountQuota,
  touchSession,
} from './accounts.js';

const schema = `sracc_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let pool: Pool;
let admin: Pool;

before(async () => {
  admin = createPool();
  await applySchema(admin, schema, srMigrationSqlUrl);
  pool = createPool({ schema });
});

after(async () => {
  await pool.end();
  await dropSchema(admin, schema);
  await admin.end();
});

async function expectSrError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof SrAccountError, `应为 SrAccountError，实为 ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  throw new Error(`期望抛 SrAccountError(${code})，实际未抛`);
}

describe('createAccount', () => {
  it('默认试用配额/USER/空显示名；自定义字段可覆盖；库中落行', async () => {
    const acc = await createAccount(pool, { username: 'alice', password: 'pw-12345678' });
    assert.equal(acc.username, 'alice');
    assert.equal(acc.displayName, '');
    assert.equal(acc.role, 'USER');
    assert.deepEqual(acc.quota, defaultTrialQuota());
    assert.ok(acc.accountId);
    assert.equal(acc.disabledAt, null);
    const cnt = await pool.query<{ n: number }>(
      'select count(*)::int as n from sr_account where account_id = $1::uuid',
      [acc.accountId],
    );
    assert.equal(cnt.rows[0]?.n, 1);

    const bob = await createAccount(pool, {
      username: 'bob_admin',
      password: 'pw-87654321',
      displayName: 'Bob',
      role: 'ADMIN',
      quota: { monthlyReportTasks: 1, monthlyModelCalls: 2, maxConcurrentTasks: 1 },
    });
    assert.equal(bob.role, 'ADMIN');
    assert.equal(bob.displayName, 'Bob');
    assert.equal(bob.quota.monthlyReportTasks, 1);
  });

  it('重复用户名 → USERNAME_TAKEN（唯一约束权威裁决）', async () => {
    await createAccount(pool, { username: 'dup_user', password: 'pw-12345678' });
    await expectSrError(
      () => createAccount(pool, { username: 'dup_user', password: 'other-pw-123' }),
      'USERNAME_TAKEN',
    );
  });

  it('输入校验：非法用户名 / 短密码具名错误', async () => {
    await expectSrError(
      () => createAccount(pool, { username: 'ab', password: 'pw-12345678' }),
      'INVALID_USERNAME',
    );
    await expectSrError(
      () => createAccount(pool, { username: 'bad name!', password: 'pw-12345678' }),
      'INVALID_USERNAME',
    );
    await expectSrError(
      () => createAccount(pool, { username: 'validuser', password: 'short7' }),
      'INVALID_PASSWORD',
    );
  });
});

describe('authenticate', () => {
  it('认证成功返回账户；密码错/用户不存在返回 null（不抛错）', async () => {
    await createAccount(pool, { username: 'carol', password: 'pw-12345678', displayName: 'Carol' });
    const ok = await authenticate(pool, 'carol', 'pw-12345678');
    assert.equal(ok?.username, 'carol');
    assert.equal(ok?.displayName, 'Carol');
    assert.equal(await authenticate(pool, 'carol', 'wrong-pass-99'), null);
    assert.equal(await authenticate(pool, 'nobody_x', 'pw-12345678'), null);
  });

  it('禁用账户认证返回 null；getAccount 管理视角仍可见', async () => {
    const acc = await createAccount(pool, { username: 'dave', password: 'pw-12345678' });
    await disableAccount(pool, acc.accountId);
    assert.equal(await authenticate(pool, 'dave', 'pw-12345678'), null);
    const still = await getAccount(pool, acc.accountId);
    assert.equal(still?.username, 'dave');
    assert.ok(still?.disabledAt, '禁用时刻已落库');
    await disableAccount(pool, acc.accountId); // 幂等
  });

  it('setAccountQuota 覆盖配额；未知账户 → ACCOUNT_NOT_FOUND', async () => {
    const acc = await createAccount(pool, { username: 'erin', password: 'pw-12345678' });
    await setAccountQuota(pool, acc.accountId, {
      monthlyReportTasks: 9,
      monthlyModelCalls: 99,
      maxConcurrentTasks: 2,
      note: '正式',
    });
    const after = await getAccount(pool, acc.accountId);
    assert.equal(after?.quota.monthlyReportTasks, 9);
    assert.equal(after?.quota.note, '正式');
    await expectSrError(
      () =>
        setAccountQuota(pool, randomUUID(), {
          monthlyReportTasks: 1,
          monthlyModelCalls: 1,
          maxConcurrentTasks: 1,
        }),
      'ACCOUNT_NOT_FOUND',
    );
  });
});

describe('会话', () => {
  it('签发→resolve：原始令牌只此一次返回、库里只存哈希、csrf 随会话回传', async () => {
    const acc = await createAccount(pool, { username: 'frank', password: 'pw-12345678' });
    const issued = await createSession(pool, acc.accountId);
    assert.ok(issued.cookieToken.length >= 32, '32 字节 base64url 令牌');
    const raw = await pool.query<{ token_hash: string }>(
      'select token_hash from sr_session where session_id = $1::uuid',
      [issued.session.sessionId],
    );
    assert.notEqual(raw.rows[0]?.token_hash, issued.cookieToken);
    assert.ok(!raw.rows[0]?.token_hash.includes(issued.cookieToken), '哈希不含原始令牌');

    const resolved = await resolveSession(pool, issued.cookieToken);
    assert.equal(resolved?.session.sessionId, issued.session.sessionId);
    assert.equal(resolved?.session.csrfToken, issued.session.csrfToken, 'csrf 明文随会话回传');
    assert.equal(resolved?.account.accountId, acc.accountId);
    assert.equal(await resolveSession(pool, 'not-a-real-token'), null, '未知令牌拒绝');
  });

  it('短 TTL 过期后 resolve 拒绝（过期判定走 DB 时钟）', async () => {
    const acc = await createAccount(pool, { username: 'grace', password: 'pw-12345678' });
    const issued = await createSession(pool, acc.accountId, { ttlMs: 300 });
    assert.ok(await resolveSession(pool, issued.cookieToken), 'TTL 内有效');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await resolveSession(pool, issued.cookieToken), null, '过期即拒绝');
  });

  it('revoke 后 resolve 拒绝（未过期也拒）；重复 revoke 幂等', async () => {
    const acc = await createAccount(pool, { username: 'heidi', password: 'pw-12345678' });
    const issued = await createSession(pool, acc.accountId);
    assert.ok(await resolveSession(pool, issued.cookieToken));
    await revokeSession(pool, issued.session.sessionId);
    assert.equal(await resolveSession(pool, issued.cookieToken), null);
    await revokeSession(pool, issued.session.sessionId);
  });

  it('账户禁用后已签发会话立即拒绝', async () => {
    const acc = await createAccount(pool, { username: 'ivan', password: 'pw-12345678' });
    const issued = await createSession(pool, acc.accountId);
    assert.ok(await resolveSession(pool, issued.cookieToken));
    await disableAccount(pool, acc.accountId);
    assert.equal(await resolveSession(pool, issued.cookieToken), null);
  });

  it('touchSession 更新 last_seen_at', async () => {
    const acc = await createAccount(pool, { username: 'judy', password: 'pw-12345678' });
    const issued = await createSession(pool, acc.accountId);
    const before = await pool.query<{ last_seen_at: Date | null }>(
      'select last_seen_at from sr_session where session_id = $1::uuid',
      [issued.session.sessionId],
    );
    assert.equal(before.rows[0]?.last_seen_at, null, '签发时无活跃痕迹');
    await touchSession(pool, issued.session.sessionId);
    const after = await pool.query<{ last_seen_at: Date | null }>(
      'select last_seen_at from sr_session where session_id = $1::uuid',
      [issued.session.sessionId],
    );
    assert.ok(after.rows[0]?.last_seen_at, 'touch 后落 last_seen_at');
  });

  it('purgeExpiredSessions 清掉过期与已吊销会话，保留活跃会话', async () => {
    const acc = await createAccount(pool, { username: 'kate', password: 'pw-12345678' });
    const expired = await createSession(pool, acc.accountId, { ttlMs: 50 });
    const revoked = await createSession(pool, acc.accountId);
    await revokeSession(pool, revoked.session.sessionId);
    const live = await createSession(pool, acc.accountId);
    await new Promise((r) => setTimeout(r, 250));
    const n = await purgeExpiredSessions(pool);
    assert.ok(n >= 2, `至少清掉本用例两个死会话，实删 ${n}`);
    const gone = await pool.query<{ n: number }>(
      'select count(*)::int as n from sr_session where session_id = any($1::uuid[])',
      [[expired.session.sessionId, revoked.session.sessionId]],
    );
    assert.equal(gone.rows[0]?.n, 0);
    assert.ok(await resolveSession(pool, live.cookieToken), '活跃会话不受 purge 影响');
  });

  it('对不存在账户签发会话 → ACCOUNT_NOT_FOUND（外键转具名错误）', async () => {
    await expectSrError(() => createSession(pool, randomUUID()), 'ACCOUNT_NOT_FOUND');
  });
});

describe('密码记录', () => {
  it('password_rec 为 scrypt 记录、不含明文（直查库断言）', async () => {
    const pw = 'secret-pw-42';
    const acc = await createAccount(pool, { username: 'leo', password: pw });
    const row = await pool.query<{ password_rec: string }>(
      'select password_rec from sr_account where account_id = $1::uuid',
      [acc.accountId],
    );
    const rec = row.rows[0]?.password_rec ?? '';
    assert.ok(rec.startsWith('scrypt$'), '记录应以 scrypt$ 开头');
    assert.ok(!rec.includes(pw), '记录不得含明文密码');
    const parts = rec.split('$');
    assert.equal(parts.length, 6, '格式 scrypt$N$r$p$saltB64$hashB64 六段');
    assert.equal(parts[1], '16384');
    assert.equal(parts[2], '8');
    assert.equal(parts[3], '1');
  });
});
