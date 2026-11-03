/**
 * Lyra · 执行内核数据访问层（W1: code-writer-pro）。
 * 合同：docs/specs/EXECUTION-KERNEL.md §2–§8、§10；表结构 src/db/schema.sql（冻结，不改）。
 *
 * 本文件只提供：事务包装、schema 应用/清理（旅程与单元测试的隔离 schema）、
 * exec_permit 行 → ModelPermit 映射。业务语义在 src/kernel/*.ts。
 */
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type {
  ModelCallContract,
  ModelPermit,
  PermitState,
  ResearchKind,
  Stage,
  SubjectKind,
} from '../contracts.js';

/** 既能接 Pool 也能接事务内 client 的最小查询接口。 */
export type DbClient = Pool | PoolClient;

/** 串行执行一组语句：任一失败整体回滚（permit 状态迁移等关键路径用）。 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // 连接已坏时回滚失败可忽略：连接归还/断开即丢弃该事务。
    }
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_NAME_RE = /^[a-z0-9_]{1,63}$/;

/** 隔离 schema 名校验（拼入 SQL 前置条件）。 */
export function assertSchemaName(name: string): void {
  if (!SCHEMA_NAME_RE.test(name)) {
    throw new Error(`非法 schema 名（仅小写字母/数字/下划线，≤63 字符）: ${name}`);
  }
}

const schemaSqlUrl = new URL('./schema.sql', import.meta.url);
/** sr 产品命名空间迁移文件（R31）：applySchema(admin, 'sr', srMigrationSqlUrl)。 */
export const srMigrationSqlUrl = new URL('./sr-migration.sql', import.meta.url);

/**
 * 建隔离 schema（可选）并按 search_path 应用 DDL（幂等）。
 * 旅程/单元测试用法：admin 池上 applySchema(admin, 'w1_x') → createPool({ schema: 'w1_x' })。
 * 〔R31〕sqlFile 参数：产品命名空间迁移（sr-migration.sql）复用同一应用路径；
 * 缺省仍为 schema.sql，既有调用方行为不变。
 */
export async function applySchema(
  pool: Pool,
  schema?: string,
  sqlFile: URL = schemaSqlUrl,
): Promise<void> {
  const ddl = await readFile(sqlFile, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (schema !== undefined) {
      assertSchemaName(schema);
      await client.query(`create schema if not exists "${schema}"`);
      // set local：事务结束自动还原，不污染归还回池的连接。
      await client.query(`set local search_path to "${schema}"`);
    }
    await client.query(ddl); // 无参数多语句简单查询，一次应用
    await client.query('commit');
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // 同上，忽略。
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 删除隔离 schema（测试清理）。 */
export async function dropSchema(pool: Pool, schema: string): Promise<void> {
  assertSchemaName(schema);
  await pool.query(`drop schema if exists "${schema}" cascade`);
}

/** PG 时钟：状态迁移的权威时间源（EK-6 截止判定一律用 DB now()）。 */
export async function dbNow(pool: DbClient): Promise<Date> {
  const r = await pool.query<{ now: Date }>('select now() as now');
  const row = r.rows[0];
  if (!row) throw new Error('dbNow: 查询失败');
  return row.now;
}

/** exec_permit 原始行（bigint 列 pg 驱动返回字符串）。 */
export interface ExecPermitRow {
  permit_id: string;
  stage: string;
  subject_kind: string;
  subject: string;
  research_kind: string;
  cutoff: Date;
  input_hash: string;
  input_bytes: string;
  method_version: string;
  plan_auth_version: string;
  deadline: Date;
  state: string;
  sent_at: Date | null;
  settled_at: Date | null;
  fail_code: string | null;
  simulated: boolean;
  created_at: Date;
}

/** 行 → ModelPermit（EK-3.1 字段完整回读；timestamptz→ISO，bigint→number）。 */
export function rowToPermit(row: ExecPermitRow): ModelPermit {
  const contract: ModelCallContract = {
    businessKey: {
      subjectKind: row.subject_kind as SubjectKind,
      subject: row.subject,
      researchKind: row.research_kind as ResearchKind,
      cutoff: row.cutoff.toISOString(),
    },
    stage: row.stage as Stage,
    inputHash: row.input_hash,
    inputBytes: Number(row.input_bytes),
    methodVersion: row.method_version,
    planAuthVersion: row.plan_auth_version,
    deadline: row.deadline.toISOString(),
  };
  return {
    permitId: row.permit_id,
    contract,
    state: row.state as PermitState,
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    failCode: row.fail_code,
    simulated: row.simulated,
  };
}
