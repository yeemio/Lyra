-- Lyra · 历史参照库群组统计表（P3 随轮提前 / W15: code-writer-pro）。
-- 合同：docs/specs/HISTORICAL-REFERENCE.md §8（群组匹配结果对象）、§5（嵌套声明随产出物强制携带）。
-- 自有新表（W15 拥有）；public 生产库只读事实 + 本表写入。
-- 旧可变表仅保留为历史审计；新研究不得从该表读取或自动提升旧行。
create table if not exists reference_group_library (
  group_key           text primary key,
  path                jsonb not null,
  sample_count        integer not null,
  base_ratio          jsonb not null,
  stats               jsonb not null,
  nested_declaration  text not null,
  created_at          timestamptz not null default now()
);

-- I-02：一次完整构建作为一个不可变版本，DB 发布时间阻止后来构建伪装旧截点材料。
create table if not exists reference_library_versions (
  version_id text primary key,
  content_hash text not null unique,
  payload jsonb not null,
  materialized_at timestamptz not null,
  input_available_at_max timestamptz not null,
  input_observed_at_max timestamptz not null,
  maturity_at_max timestamptz not null,
  published_at timestamptz not null default clock_timestamp(),
  check (version_id = 'rl-' || content_hash),
  check (input_available_at_max <= materialized_at and input_observed_at_max <= materialized_at
         and maturity_at_max <= materialized_at and materialized_at <= published_at)
);
create index if not exists reference_library_versions_asof on reference_library_versions(published_at desc);
create or replace function reference_version_publish() returns trigger language plpgsql as $$
begin
  -- 外部指定的 published_at 不能让新发布倒退到旧研究截点。
  new.published_at := clock_timestamp();
  return new;
end;
$$;
create or replace function reference_version_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'REFERENCE_VERSION_IMMUTABLE' using errcode = '55000';
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname='reference_version_publish'
                 and tgrelid='reference_library_versions'::regclass) then
    create trigger reference_version_publish before insert on reference_library_versions
      for each row execute function reference_version_publish();
  end if;
  if not exists (select 1 from pg_trigger where tgname='reference_version_immutable_rows'
                 and tgrelid='reference_library_versions'::regclass) then
    create trigger reference_version_immutable_rows before update or delete on reference_library_versions
      for each row execute function reference_version_immutable();
    create trigger reference_version_immutable_truncate before truncate on reference_library_versions
      for each statement execute function reference_version_immutable();
  end if;
end $$;
