-- Lyra 调度计划与准入持久化表（P3 W17: code-writer-pro）。
-- 合同：docs/specs/SCHEDULING.md（SC-5 准入、SC-6.2 降级标注、三条版本轴之执行计划与授权版本）。
-- 不带 schema 限定：按应用时 search_path 落位（派发要求 public）；幂等（if not exists）。
-- 计划表只追加不更新：新 planAuthVersion = 新行（SC-8.2 授权与计划身份分离，版本轴独立）。
-- 准入表为调度层对象：执行侧（exec_permit）由 kernel 消费后创建，两表不外键联动。
create table if not exists schedule_plan (
  plan_id            text primary key,
  plan_auth_version  text not null,
  pool_version       text not null,
  capacity_morning   integer not null,
  plan_hash          text not null,
  body               jsonb not null,
  created_at         timestamptz not null default now()
);
create index if not exists schedule_plan_version_idx on schedule_plan (plan_auth_version, created_at);

create table if not exists schedule_admission (
  admission_id     text not null,
  plan_id          text not null,
  queue_class      text not null,
  priority         integer not null,
  subject_kind     text not null,
  subject          text not null,
  research_kind    text not null,
  cutoff           timestamptz not null,
  source           text not null,
  detected_at      timestamptz,
  trigger_event_ids jsonb not null default '[]'::jsonb,
  annotation       text,
  first_queued_at  timestamptz not null,
  started          boolean not null default false,
  sent             boolean not null default false,
  notes            jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  primary key (plan_id, admission_id)
);
create index if not exists schedule_admission_class_idx on schedule_admission (plan_id, priority, first_queued_at);
