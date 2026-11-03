/**
 * Lyra · sr 空间账户与会话（S4）。R31，code-writer-pro。
 * 载体：sr_account / sr_session（src/db/sr-migration.sql，schema `sr`，测试用隔离 schema）。
 *
 * 纪律：
 * - 密码只存 node:crypto scrypt 标准记录（scrypt$N$r$p$saltB64$hashB64，默认
 *   N=16384, r=8, p=1），校验用 timingSafeEqual；绝不落明文、绝不在错误消息中
 *   携带密码或令牌。
 * - 会话 cookie 令牌只在签发时返回一次；库里只存哈希（复用工程统一身份哈希
 *   canonicalSha256）。csrf_token 随机、明文存（需回传给页面表单做校验）。
 * - 全部 SQL 参数化、显式列清单；过期/吊销/禁用判定统一用 DB 时钟（now()）。
 */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalSha256 } from '../canonical.js';
import {
  defaultTrialQuota,
  type SrAccount,
  type SrAccountQuota,
  type SrRole,
  type SrSession,
} from './contracts.js';

// ===== 具名错误 =====

export type SrAccountErrorCode =
  | 'INVALID_USERNAME'
  | 'INVALID_PASSWORD'
  | 'USERNAME_TAKEN'
  | 'ACCOUNT_NOT_FOUND';

/** 账户域具名错误（区别于 pg 原始错误；调用方按 code 分流）。 */
export class SrAccountError extends Error {
  constructor(readonly code: SrAccountErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SrAccountError';
  }
}

// ===== 常量 =====

/** 会话默认 TTL：7 天。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN_LEN = 8;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

// ===== scrypt 记录 =====

function scryptDerive(
  password: string,
  salt: Buffer,
  keylen: number,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** 生成 scrypt 记录：scrypt$N$r$p$saltB64$hashB64。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptDerive(password, salt, SCRYPT_KEYLEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 校验密码是否匹配记录；记录格式损坏一律 false（口令侧问题永不抛错）。 */
async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parts = record.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scryptDerive(password, salt, expected.length, N, r, p);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ===== 行映射 =====

interface AccountRow {
  account_id: string;
  username: string;
  display_name: string;
  role: string;
  quota: SrAccountQuota;
  created_at: Date;
  disabled_at: Date | null;
}

const ACCOUNT_COLUMNS = 'account_id, username, display_name, role, quota, created_at, disabled_at';

function toAccount(row: AccountRow): SrAccount {
  return {
    accountId: row.account_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'ADMIN' ? 'ADMIN' : 'USER',
    quota: row.quota,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at ? row.disabled_at.toISOString() : null,
  };
}

interface SessionRow {
  session_id: string;
  account_id: string;
  csrf_token: string;
  created_at: Date;
  expires_at: Date;
}

function toSession(row: SessionRow): SrSession {
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    csrfToken: row.csrf_token,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/** pg 错误码提取（唯一冲突 23505 / 外键 23503 等）。 */
function pgErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// ===== 账户 =====

export interface CreateAccountInput {
  username: string;
  password: string;
  displayName?: string;
  role?: SrRole;
  quota?: SrAccountQuota;
}

/** 创建账户：username 唯一（冲突 → USERNAME_TAKEN），密码最短 8 字符，配额缺省试用档。 */
export async function createAccount(srPool: Pool, input: CreateAccountInput): Promise<SrAccount> {
  if (!USERNAME_RE.test(input.username)) {
    throw new SrAccountError(
      'INVALID_USERNAME',
      `用户名须为 3–32 位字母/数字/下划线: ${input.username}`,
    );
  }
  if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LEN) {
    throw new SrAccountError('INVALID_PASSWORD', `密码至少 ${PASSWORD_MIN_LEN} 字符`);
  }
  const passwordRec = await hashPassword(input.password);
  try {
    const res = await srPool.query<AccountRow>(
      `insert into sr_account (account_id, username, display_name, role, password_rec, quota)
       values ($1::uuid, $2, $3, $4, $5, $6::jsonb)
       returning ${ACCOUNT_COLUMNS}`,
      [
        randomUUID(),
        input.username,
        input.displayName ?? '',
        input.role ?? 'USER',
        passwordRec,
        JSON.stringify(input.quota ?? defaultTrialQuota()),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('createAccount: returning 未返回行');
    return toAccount(row);
  } catch (err) {
    // username 唯一约束是权威裁决（并发注册也只有一个成功）。
    if (pgErrorCode(err) === '23505') {
      throw new SrAccountError('USERNAME_TAKEN', `用户名已存在: ${input.username}`);
    }
    throw err;
  }
}

/** 用户名 + 密码认证：成功返回账户；用户不存在 / 密码错 / 已禁用一律返回 null（不抛错，调用方记日志限流）。 */
export async function authenticate(
  srPool: Pool,
  username: string,
  password: string,
): Promise<SrAccount | null> {
  const res = await srPool.query<AccountRow & { password_rec: string }>(
    `select ${ACCOUNT_COLUMNS}, password_rec
     from sr_account where username = $1 and disabled_at is null`,
    [username],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!(await verifyPassword(password, row.password_rec))) return null;
  return toAccount(row);
}

/** 按 ID 读账户（含已禁用，管理视角；不存在返回 null）。 */
export async function getAccount(srPool: Pool, accountId: string): Promise<SrAccount | null> {
  const res = await srPool.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from sr_account where account_id = $1::uuid`,
    [accountId],
  );
  const row = res.rows[0];
  return row ? toAccount(row) : null;
}

/** 覆盖账户配额（管理员调）；账户不存在 → ACCOUNT_NOT_FOUND。 */
export async function setAccountQuota(
  srPool: Pool,
  accountId: string,
  quota: SrAccountQuota,
): Promise<void> {
  const res = await srPool.query(
    'update sr_account set quota = $2::jsonb where account_id = $1::uuid',
    [accountId, JSON.stringify(quota)],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new SrAccountError('ACCOUNT_NOT_FOUND', `账户不存在: ${accountId}`);
  }
}

/** 禁用账户（已禁用时幂等无操作）；账户不存在 → ACCOUNT_NOT_FOUND。 */
export async function disableAccount(srPool: Pool, accountId: string): Promise<void> {
  const res = await srPool.query(
    'update sr_account set disabled_at = now() where account_id = $1::uuid and disabled_at is null',
    [accountId],
  );
  if ((res.rowCount ?? 0) === 0) {
    const exists = await srPool.query('select 1 from sr_account where account_id = $1::uuid', [
      accountId,
    ]);
    if ((exists.rowCount ?? 0) === 0) {
      throw new SrAccountError('ACCOUNT_NOT_FOUND', `账户不存在: ${accountId}`);
    }
    // 已禁用：幂等。
  }
}

// ===== 会话 =====

/** 签发结果：原始 cookie 令牌只此一次返回（库里只存哈希）。 */
export interface IssuedSession {
  session: SrSession;
  cookieToken: string;
}

/** 签发会话：令牌/CSRF 均 32 字节随机 base64url；TTL 缺省 7 天；过期时刻按 DB 时钟计算。 */
export async function createSession(
  srPool: Pool,
  accountId: string,
  opts?: { ttlMs?: number },
): Promise<IssuedSession> {
  const ttlMs = opts?.ttlMs ?? SESSION_TTL_MS;
  const cookieToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const tokenHash = canonicalSha256(cookieToken);
  try {
    const res = await srPool.query<SessionRow>(
      `insert into sr_session (session_id, account_id, token_hash, csrf_token, expires_at)
       values ($1::uuid, $2::uuid, $3, $4, now() + ($5::double precision * interval '1 millisecond'))
       returning session_id, account_id, csrf_token, created_at, expires_at`,
      [randomUUID(), accountId, tokenHash, csrfToken, ttlMs],
    );
    const row = res.rows[0];
    if (!row) throw new Error('createSession: returning 未返回行');
    return { session: toSession(row), cookieToken };
  } catch (err) {
    if (pgErrorCode(err) === '23503') {
      throw new SrAccountError('ACCOUNT_NOT_FOUND', `账户不存在，无法签发会话: ${accountId}`);
    }
    throw err;
  }
}

interface JoinedSessionRow extends SessionRow {
  a_account_id: string;
  a_username: string;
  a_display_name: string;
  a_role: string;
  a_quota: SrAccountQuota;
  a_created_at: Date;
  a_disabled_at: Date | null;
}

/** 令牌 → 会话 + 账户：一次联查校验哈希命中、未过期（DB now()）、未吊销、账户未禁用；任一不满足返回 null。 */
export async function resolveSession(
  srPool: Pool,
  cookieToken: string,
): Promise<{ session: SrSession; account: SrAccount } | null> {
  const res = await srPool.query<JoinedSessionRow>(
    `select s.session_id, s.account_id, s.csrf_token, s.created_at, s.expires_at,
            a.account_id as a_account_id, a.username as a_username, a.display_name as a_display_name,
            a.role as a_role, a.quota as a_quota, a.created_at as a_created_at, a.disabled_at as a_disabled_at
     from sr_session s
     join sr_account a on a.account_id = s.account_id
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
       and a.disabled_at is null`,
    [canonicalSha256(cookieToken)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    session: toSession({
      session_id: row.session_id,
      account_id: row.account_id,
      csrf_token: row.csrf_token,
      created_at: row.created_at,
      expires_at: row.expires_at,
    }),
    account: toAccount({
      account_id: row.a_account_id,
      username: row.a_username,
      display_name: row.a_display_name,
      role: row.a_role,
      quota: row.a_quota,
      created_at: row.a_created_at,
      disabled_at: row.a_disabled_at,
    }),
  };
}

/** 吊销会话（幂等；吊销后立即不可 resolve）。 */
export async function revokeSession(srPool: Pool, sessionId: string): Promise<void> {
  await srPool.query(
    'update sr_session set revoked_at = now() where session_id = $1::uuid and revoked_at is null',
    [sessionId],
  );
}

/** 活跃痕迹：更新 last_seen_at（信息列，不参与鉴权判定）。 */
export async function touchSession(srPool: Pool, sessionId: string): Promise<void> {
  await srPool.query('update sr_session set last_seen_at = now() where session_id = $1::uuid', [
    sessionId,
  ]);
}

/** 清理死会话（已过期或已吊销；两者 resolve 均已拒绝，删除只回收存储）。返回删除行数。 */
export async function purgeExpiredSessions(srPool: Pool): Promise<number> {
  const res = await srPool.query(
    'delete from sr_session where expires_at <= now() or revoked_at is not null',
  );
  return res.rowCount ?? 0;
}
