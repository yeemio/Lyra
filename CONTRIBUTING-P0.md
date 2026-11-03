# Lyra · 共享契约（P0）

状态：v1，2026-10-25，总控冻结。本文件是 P0 各实现模块的唯一共享类型源；实现模块不得在别处重复定义这些身份类型。变更须走 `docs/PLAN.md` 修订程序。

依据：`docs/specs/P0-FOUNDATION.md`（已冻结）、`docs/specs/EXECUTION-KERNEL.md`、`docs/specs/POINT-IN-TIME.md`、`docs/specs/RESEARCH-METHOD.md` §3/§8、`docs/FREEZE-P0-20261025.md` R17–R21。

## 模块边界（单 writer 一览）

| 模块 | 文件 | writer |
|---|---|---|
| 共享契约 | `src/contracts.ts`、`src/canonical.ts`、`src/db/pool.ts`、`src/db/schema.sql` | 总控 |
| 执行内核 | `src/kernel/*.ts`、`src/db/exec.ts` | W1（code-writer-pro） |
| 原件库与时点 | `src/artifacts/store.ts`、`src/pintime/*.ts`、`src/db/pintime.ts` | W2（code-writer） |
| 结论/模拟模型/旅程 | `src/research/*.ts`、`src/conclusion/*.ts`、`src/db/conclusion.ts`、`src/journey/*` | W3（code-writer-pro） |

# Lyra · P0 实施说明

- 运行：Node 24（本机 nvm `v24.18.0`），TypeScript ESM（NodeNext），测试 `node:test`，数据库 PostgreSQL 18（OrbStack 容器 `lyra-pg`，127.0.0.1:5433，库 `lyra`，用户 `lyra`）。
- 旅程测试自建隔离 schema（`p0_journey_<runid>`）并在结束时清理；`src/db/schema.sql` 不带 schema 限定，按 search_path 应用。
- 原件库数据目录默认 `<repo>/data/artifacts`（0700），测试用临时目录覆盖（env `LYRA_ARTIFACTS_DIR`）。
- 数据库连接 env：`LYRA_PG_HOST/PORT/USER/PASSWORD/DATABASE`。默认地址为 `127.0.0.1:5433`，用户和数据库名为 `lyra`；密码通过 `LYRA_PG_PASSWORD` 提供。
- 模拟模型自我声明 `simulated: true`，生产配置不得标注为真实端点（EK-10.1）。
