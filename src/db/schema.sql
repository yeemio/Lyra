-- Lyra P0 schema（总控冻结）。不带 schema 限定：按应用时的 search_path 落位。
-- 旅程测试每次运行建独立 schema 后应用本文件；幂等（if not exists）。

-- 唯一执行器锁（EK-2.1）：单行表，holder 为执行器实例身份。
create table if not exists kernel_lock (
  id integer primary key default 1 check (id = 1),
  holder text not null,
  acquired_at timestamptz not null,
  heartbeat_at timestamptz not null
);
insert into kernel_lock (id, holder, acquired_at, heartbeat_at)
values (1, '', now() - interval '1 day', now() - interval '1 day')
on conflict (id) do nothing;

-- 恢复状态（EK-8）：单行表。RECONCILING 下未确认恢复即执行 → RECOVERY_CONFIRM_REQUIRED。
create table if not exists recovery_state (
  id integer primary key default 1 check (id = 1),
  lifecycle text not null default 'RUNNING' check (lifecycle in ('RUNNING', 'RECONCILING')),
  pending_permit_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into recovery_state (id) values (1) on conflict (id) do nothing;

-- permit（EK-3）：每次模型调用一个 permit + 调用合同。
-- send-once 键：(subject_kind, subject, research_kind, cutoff, stage) 唯一（EK-4.1）。
create table if not exists exec_permit (
  permit_id uuid primary key,
  stage text not null check (stage in ('A', 'J')),
  subject_kind text not null check (subject_kind in ('STOCK', 'BROAD_ETF')),
  subject text not null,
  research_kind text not null check (research_kind in ('WEEKLY', 'POST_EVENT', 'PRE_EVENT')),
  cutoff timestamptz not null,
  input_hash text not null,
  input_bytes bigint not null,
  method_version text not null,
  plan_auth_version text not null,
  deadline timestamptz not null, -- 本次执行自身持有（EK-6.1）
  state text not null check (state in ('PREPARED', 'SENT', 'UNKNOWN', 'SUCCEEDED', 'FAILED')),
  sent_at timestamptz,
  settled_at timestamptz,
  fail_code text, -- 具名失败/未按窗完成原因（如 DEADLINE_EXCEEDED、INPUT_OVER_BUDGET）
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  unique (subject_kind, subject, research_kind, cutoff, stage)
);
create index if not exists exec_permit_state_idx on exec_permit (state);

-- UNKNOWN 本地退役回执（EK-5.3）：只经 Owner 显式确认触发，不设自动退役（R21）。
create table if not exists retirement_receipt (
  receipt_id uuid primary key,
  permit_id uuid not null references exec_permit (permit_id),
  confirmed_by text not null,
  confirmed_at timestamptz not null default now(),
  remote_result text not null default 'UNKNOWN',
  remote_cost text not null default 'UNKNOWN'
);

-- 时点事实（POINT-IN-TIME §2）：修正只新增 + supersedes，不覆盖。
create table if not exists pintime_fact (
  fact_id text primary key,
  subject_type text not null,
  subject_id text not null,
  fact_kind text not null,
  typed_value jsonb not null,
  valid_from timestamptz,
  valid_to timestamptz,
  event_at timestamptz,
  source_published_at timestamptz,
  first_observed_at timestamptz not null,
  available_at timestamptz not null,
  supersedes_fact_id text references pintime_fact (fact_id),
  artifact_sha256 text not null,
  adapter_version text not null
);
create index if not exists pintime_fact_asof_idx on pintime_fact (subject_type, subject_id, fact_kind, available_at);

-- 封存 manifest（POINT-IN-TIME §7）：封存后不可变。
create table if not exists seal_manifest (
  seal_id text primary key,
  business_key jsonb not null,
  cutoff timestamptz not null,
  artifact_refs jsonb not null,
  fact_ids jsonb not null,
  gaps jsonb not null,
  method_version text not null,
  adapter_version text not null,
  plan_auth_version text not null,
  created_at timestamptz not null,
  manifest_hash text not null unique
);

-- 研究结论对象（RESEARCH-METHOD §8）：研究字段写入后不可变；结算只写 settlement 列。
create table if not exists conclusion (
  conclusion_id text primary key,
  business_key jsonb not null,
  method_version text not null,
  adapter_version text not null,
  plan_auth_version text not null,
  disposition text not null,
  adoption boolean not null default false,
  evidence jsonb not null,
  inheritance jsonb,
  standalone_note text,
  change_reason text,
  settlement jsonb not null default '{"state":"UNSETTLED"}'::jsonb,
  created_at timestamptz not null,
  conclusion_hash text not null unique
);

-- 安装日志（EK-10.3）：只写全绿记录；无全绿记录的安装视为未完成。
create table if not exists install_log (
  id bigserial primary key,
  version_id text not null,
  test_run_id text not null,
  green boolean not null,
  summary text not null,
  recorded_at timestamptz not null default now()
);
