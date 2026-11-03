-- Lyra P1 增量 schema（W4: code-writer-pro）。不带 schema 限定：按应用时的 search_path 落位。
-- 只增新表，不改 P0 冻结 schema（src/db/schema.sql）；幂等（if not exists）。
-- 应用入口：src/adapters/backoff.ts 的 applyP1Migration（与 applySchema 同语义，可选隔离 schema）。

-- 适配器暂停上报（DATA-SOURCES §7 / EK-7.2/EK-7.3）：数据源层退避 3 次失败后停止重试，
-- 按暂停上报落库为状态记录（R21：落库为状态记录，不另写文件）。
-- 同 (adapter, scope) 幂等可覆盖：再次暂停覆盖旧记录，恢复后置 RESUMED。
-- 四要素映射：retries=已重试次数，last_error=最后错误（具名错误码与原文摘要），
-- scope=恢复位置（断点 = adapter:resource:对象标识），status=唯一下一步动作的载体
-- （PAUSED → 唯一下一步动作 = 从该 scope 断点续跑；RESUMED → 已从断点恢复）。
create table if not exists adapter_pause_report (
  adapter text not null,
  scope text not null,
  retries integer not null,
  last_error text not null,
  status text not null default 'PAUSED' check (status in ('PAUSED', 'RESUMED')),
  updated_at timestamptz not null default now(),
  primary key (adapter, scope)
);
