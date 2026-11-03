/**
 * sr 命名空间迁移应用（幂等）。用法：npm run sr:apply-schema
 * 服务端启动时也会自动应用；此脚本供独立初始化/升级使用。
 */
import { createPool } from '../db/pool.js';
import { applySchema, srMigrationSqlUrl } from '../db/exec.js';

const pool = createPool();
try {
  await applySchema(pool, 'sr', srMigrationSqlUrl);
  console.log('sr schema applied (idempotent)');
} finally {
  await pool.end();
}
