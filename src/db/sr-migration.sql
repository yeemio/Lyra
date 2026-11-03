-- Lyra · 单股研究报告产品（sr 空间）表结构。R31，2026-10-26。
-- 应用方式：applySchema(admin, 'sr', 'src/db/sr-migration.sql') —— 全部表位于新建
-- schema `sr`，幂等（create if not exists），不触碰 public 下任何既有对象。
-- 语义对照：src/stock-research/contracts.ts；permit 状态机与 A/J（schema.sql exec_permit）
-- 一致，业务键改为 (task_id, step_id)。

create table if not exists sr_account (
  account_id   uuid primary key,
  username     text not null unique,
  display_name text not null default '',
  role         text not null check (role in ('ADMIN','USER')),
  password_rec text not null, -- scrypt 记录：scrypt$N$r$p$saltB64$hashB64（不落明文）
  quota        jsonb not null, -- SrAccountQuota
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);

create table if not exists sr_session (
  session_id    uuid primary key,
  account_id    uuid not null references sr_account(account_id),
  token_hash    text not null unique, -- sha256(cookie 令牌)；令牌本身不落库
  csrf_token    text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  last_seen_at  timestamptz
);
create index if not exists sr_session_account_idx on sr_session(account_id);

create table if not exists sr_task (
  task_id            uuid primary key,
  account_id         uuid not null references sr_account(account_id),
  subject            text not null, -- 6 位代码
  subject_name       text not null default '',
  focus              text not null check (focus in ('FULL','BUSINESS','FINANCIAL_QUALITY','VALUATION','EVENTS')),
  emphasis           text,
  horizon            text not null check (horizon in ('MID_TERM','LONG_TERM','NEAR_TERM')),
  cutoff             timestamptz not null,
  status             text not null check (status in ('QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','CANCELLED')),
  idem_key           text not null,
  revised_from_task_id uuid references sr_task(task_id),
  method_version     text not null,
  adapter_version    text not null,
  plan_auth_version  text not null,
  error              jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  unique (account_id, idem_key) -- 幂等：双击/重传不重复建任务
);
create index if not exists sr_task_account_idx on sr_task(account_id, created_at desc);
create index if not exists sr_task_queue_idx on sr_task(status, created_at) where status = 'QUEUED';

create table if not exists sr_step (
  step_id     uuid primary key,
  task_id     uuid not null references sr_task(task_id),
  step_kind   text not null check (step_kind in ('PLAN','EVIDENCE','COMPUTE','ANALYZE','A_FINAL','CHECKLIST','JUDGE','SYNTHESIZE','QA_CHECK','ASSEMBLE','CHAT_ANSWER')),
  section_key text,
  sequence    integer not null,
  status      text not null check (status in ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  note        text,
  started_at  timestamptz,
  finished_at timestamptz,
  unique (task_id, step_kind, sequence)
);
create index if not exists sr_step_task_idx on sr_step(task_id, sequence);

-- 〔C3/R0〕已建 sr schema 的步骤类型扩展（幂等：先建表的新约束同名，drop+add 对新旧安装均成立）
alter table sr_step drop constraint if exists sr_step_step_kind_check;
alter table sr_step add constraint sr_step_step_kind_check
  check (step_kind in ('PLAN','EVIDENCE','COMPUTE','ANALYZE','A_FINAL','CHECKLIST','JUDGE','SYNTHESIZE','QA_CHECK','ASSEMBLE','CHAT_ANSWER'));

-- sr 空间 permit：与 exec_permit 同一状态机；send-once 载体 = unique(task_id, step_id)。
-- 修改输入 = 新步骤（新 stepId），不得换 ID 绕过 once 约束（TASK-PACKAGE §5.2.2）。
create table if not exists sr_call (
  call_id          uuid primary key,
  task_id          uuid not null references sr_task(task_id),
  step_id          uuid not null references sr_step(step_id),
  input_hash       text not null,
  input_bytes      integer not null,
  method_version   text not null,
  plan_auth_version text not null,
  deadline         timestamptz not null,
  state            text not null check (state in ('PREPARED','SENT','UNKNOWN','SUCCEEDED','FAILED')),
  sent_at          timestamptz,
  settled_at       timestamptz,
  fail_code        text,
  simulated        boolean not null,
  provider         text,
  model_id         text,
  usage            jsonb,
  created_at       timestamptz not null default now(),
  unique (task_id, step_id)
);
create index if not exists sr_call_state_idx on sr_call(state);
create index if not exists sr_call_task_idx on sr_call(task_id);

create table if not exists sr_call_receipt ( -- UNKNOWN 退役回执（对应 retirement_receipt）
  receipt_id    uuid primary key,
  call_id       uuid not null unique references sr_call(call_id),
  confirmed_by  text not null,
  confirmed_at  timestamptz not null default now(),
  remote_result text not null default 'UNKNOWN',
  remote_cost   text not null default 'UNKNOWN'
);

create table if not exists sr_recovery_state (
  id               integer primary key default 1 check (id = 1),
  lifecycle        text not null check (lifecycle in ('RUNNING','RECONCILING')),
  pending_call_ids jsonb not null default '[]',
  updated_at       timestamptz not null default now()
);
insert into sr_recovery_state (id, lifecycle, pending_call_ids)
values (1, 'RUNNING', '[]'::jsonb)
on conflict (id) do nothing;

create table if not exists sr_engine_lock (
  id           integer primary key default 1 check (id = 1),
  holder       text not null,
  acquired_at  timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
insert into sr_engine_lock (id, holder)
values (1, '')
on conflict (id) do nothing;

create table if not exists sr_report (
  report_id        uuid not null,
  task_id          uuid not null references sr_task(task_id),
  version          integer not null,
  status           text not null check (status in ('DRAFT','PUBLISHED','SUPERSEDED')),
  subject          text not null,
  subject_name     text not null default '',
  focus            text not null,
  horizon          text not null,
  cutoff           timestamptz not null,
  method_version   text not null,
  adapter_version  text not null,
  plan_auth_version text not null,
  generated_by     text not null check (generated_by in ('PRODUCT_SIMULATED','PRODUCT_REAL','EXECUTOR_COLLAB')),
  content          jsonb not null, -- ReportDocument（sections 等）
  qa_findings      jsonb not null default '[]',
  change_summary   text,
  content_hash     text not null,
  created_at       timestamptz not null default now(),
  published_at     timestamptz,
  unique (task_id, version) -- 不可变发布版本：修订只新增行
);
create index if not exists sr_report_task_idx on sr_report(task_id, version desc);

-- 〔C3/R0〕发布门与证据绑定四哈希（对齐 Metis ConclusionEvidence；幂等）
alter table sr_report add column if not exists report_gate jsonb;
alter table sr_report add column if not exists evidence_refs jsonb;
alter table sr_report drop constraint if exists sr_report_status_check;
alter table sr_report add constraint sr_report_status_check
  check (status in ('DRAFT','PUBLISHED','PUBLISHED_RESTRICTED','SUPERSEDED'));

create table if not exists sr_chat_thread (
  thread_id  uuid primary key,
  report_id  uuid not null, -- 报告身份（版本切换不改线程绑定）
  account_id uuid not null references sr_account(account_id),
  created_at timestamptz not null default now()
);
create index if not exists sr_chat_thread_report_idx on sr_chat_thread(report_id);

create table if not exists sr_chat_message (
  message_id       uuid primary key,
  thread_id        uuid not null references sr_chat_thread(thread_id),
  role             text not null check (role in ('USER','ASSISTANT')),
  kind             text not null check (kind in ('EXPLAIN','CHALLENGE','ADJUST_ASSUMPTION','MISSING_DATA','NEW_CUTOFF','OTHER')),
  content          text not null,
  citations        jsonb not null default '[]',
  call_id          uuid references sr_call(call_id),
  suggested_action jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists sr_chat_msg_thread_idx on sr_chat_message(thread_id, created_at);

-- 配额：原子条件自增做预约（update ... where used < limit returning）。
create table if not exists sr_quota_usage (
  account_id uuid not null references sr_account(account_id),
  period     text not null, -- 'YYYY-MM'（账户本地月）
  kind       text not null check (kind in ('REPORT_TASK','MODEL_CALL')),
  used       integer not null default 0,
  primary key (account_id, period, kind)
);

-- 用量事件（使用量页面与成本核算原始账）
create table if not exists sr_usage_event (
  event_id   uuid primary key,
  account_id uuid not null references sr_account(account_id),
  task_id    uuid,
  kind       text not null, -- TASK_CREATED / TASK_COMPLETED / CALL_SETTLED / QUOTA_REFUND ...
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists sr_usage_event_account_idx on sr_usage_event(account_id, created_at desc);
