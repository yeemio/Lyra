import { Pool, type PoolConfig } from 'pg';

/**
 * Lyra PG 连接池。默认指向 OrbStack 容器 lyra-pg（127.0.0.1:5433，库 lyra）。
 * 旅程测试用 `createPool({ schema })` 建带独立 search_path 的池（每运行一个 schema）。
 */
export function pgEnv(): PoolConfig {
  return {
    host: process.env.LYRA_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.LYRA_PG_PORT ?? 5433),
    user: process.env.LYRA_PG_USER ?? 'lyra',
    password: process.env.LYRA_PG_PASSWORD,
    database: process.env.LYRA_PG_DATABASE ?? 'lyra',
    max: 8,
  };
}

export function createPool(options?: { schema?: string }): Pool {
  const base = pgEnv();
  const schema = options?.schema;
  const pool = new Pool(schema ? { ...base, options: `-c search_path=${schema}` } : base);
  return pool;
}
