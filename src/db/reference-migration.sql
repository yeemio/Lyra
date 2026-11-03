-- Lyra · 历史参照库群组统计表（P3 随轮提前 / W15: code-writer-pro）。
-- 合同：docs/specs/HISTORICAL-REFERENCE.md §8（群组匹配结果对象）、§5（嵌套声明随产出物强制携带）。
-- 自有新表（W15 拥有）；public 生产库只读事实 + 本表写入。
-- 重建产生新版本：upsert 覆盖群组最新统计（版本绑定在 stats jsonb 的 versionBinding 内，
-- 含 materialized_at；旧 run 的 group_key 引用永远可解析——行不删除，HISTORICAL-REFERENCE §7 第 6 条）。
create table if not exists reference_group_library (
  group_key           text primary key,
  path                jsonb not null,
  sample_count        integer not null,
  base_ratio          jsonb not null,
  stats               jsonb not null,
  nested_declaration  text not null,
  created_at          timestamptz not null default now()
);
