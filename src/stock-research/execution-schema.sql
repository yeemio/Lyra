alter table sr_engine_lock add column if not exists generation bigint not null default 0;
alter table sr_engine_lock add column if not exists lease_until timestamptz not null default '-infinity';
alter table sr_engine_lock add column if not exists lease_ttl_ms integer not null default 60000;
alter table sr_call add column if not exists execution_generation bigint;
alter table sr_call add column if not exists response_checkpoint jsonb;
alter table sr_call add column if not exists response_hash text;
alter table sr_task add column if not exists execution_owner text;
alter table sr_task add column if not exists execution_generation bigint;
alter table sr_task add column if not exists initial_evidence jsonb;
alter table sr_task add column if not exists initial_evidence_hash text;
alter table sr_step add column if not exists input_checkpoint jsonb;
alter table sr_step add column if not exists input_checkpoint_hash text;

create table if not exists sr_request (
  account_id uuid not null references sr_account(account_id),
  request_key text not null,
  kind text not null check(kind in ('CHAT','REVISE')),
  intent_hash text not null,
  intent jsonb not null,
  task_id uuid not null references sr_task(task_id),
  report_id uuid not null,
  report_version integer not null,
  report_hash text not null,
  thread_id uuid references sr_chat_thread(thread_id),
  step_id uuid references sr_step(step_id),
  result_task_id uuid references sr_task(task_id),
  response_message_id uuid,
  state text not null default 'PENDING',
  error jsonb,
  quota_reservation jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(account_id,request_key),
  foreign key(report_id,report_version) references sr_report(report_id,version)
);
alter table sr_chat_message add column if not exists request_key text;
create unique index if not exists sr_chat_message_request_role on sr_chat_message(thread_id,request_key,role) where request_key is not null;

create or replace function sr_keep_execution_checkpoint() returns trigger language plpgsql as $$
begin
  if old.sent_at is not null and
     row(new.call_id,new.task_id,new.step_id,new.input_hash,new.input_bytes,new.method_version,new.plan_auth_version,new.deadline,new.simulated,new.sent_at,new.execution_generation)
     is distinct from row(old.call_id,old.task_id,old.step_id,old.input_hash,old.input_bytes,old.method_version,old.plan_auth_version,old.deadline,old.simulated,old.sent_at,old.execution_generation) then
    raise exception 'EXECUTION_IDENTITY_IMMUTABLE';
  end if;
  if old.sent_at is not null and old.state in ('SUCCEEDED','FAILED','UNKNOWN') and new.state<>old.state then
    raise exception 'EXECUTION_TERMINAL_IMMUTABLE';
  end if;
  if old.response_checkpoint is not null and row(new.response_checkpoint,new.response_hash) is distinct from row(old.response_checkpoint,old.response_hash) then
    raise exception 'EXECUTION_CHECKPOINT_IMMUTABLE';
  end if;
  if (new.response_checkpoint is null) <> (new.response_hash is null) or (new.response_checkpoint is not null and new.state<>'SUCCEEDED') then
    raise exception 'EXECUTION_CHECKPOINT_STATE_INVALID';
  end if;
  return new;
end $$;
drop trigger if exists sr_call_checkpoint_immutable on sr_call;
create trigger sr_call_checkpoint_immutable before update on sr_call for each row execute function sr_keep_execution_checkpoint();

create or replace function sr_keep_input_checkpoint() returns trigger language plpgsql as $$
begin
  if old.input_checkpoint is not null and
     row(new.task_id,new.step_id,new.step_kind,new.section_key,new.sequence,new.input_checkpoint,new.input_checkpoint_hash)
     is distinct from row(old.task_id,old.step_id,old.step_kind,old.section_key,old.sequence,old.input_checkpoint,old.input_checkpoint_hash) then
    raise exception 'SR_INPUT_CHECKPOINT_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists sr_step_input_immutable on sr_step;
create trigger sr_step_input_immutable before update on sr_step for each row execute function sr_keep_input_checkpoint();

create or replace function sr_keep_task_input() returns trigger language plpgsql as $$
begin
  if (old.execution_owner is not null or old.initial_evidence is not null) and
     row(new.task_id,new.account_id,new.subject,new.subject_name,new.focus,new.emphasis,new.horizon,new.cutoff,new.method_version,new.adapter_version,new.plan_auth_version)
     is distinct from row(old.task_id,old.account_id,old.subject,old.subject_name,old.focus,old.emphasis,old.horizon,old.cutoff,old.method_version,old.adapter_version,old.plan_auth_version) then
    raise exception 'SR_TASK_INPUT_IMMUTABLE';
  end if;
  if old.initial_evidence is not null and row(new.initial_evidence,new.initial_evidence_hash) is distinct from row(old.initial_evidence,old.initial_evidence_hash) then
    raise exception 'SR_INITIAL_EVIDENCE_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists sr_task_input_immutable on sr_task;
create trigger sr_task_input_immutable before update on sr_task for each row execute function sr_keep_task_input();

create or replace function sr_keep_request_identity() returns trigger language plpgsql as $$
begin
  if row(new.account_id,new.request_key,new.kind,new.intent_hash,new.intent,new.task_id,new.report_id,new.report_version,new.report_hash,
         new.thread_id,new.step_id,new.result_task_id,new.quota_reservation,new.created_at)
     is distinct from row(old.account_id,old.request_key,old.kind,old.intent_hash,old.intent,old.task_id,old.report_id,old.report_version,old.report_hash,
         old.thread_id,old.step_id,old.result_task_id,old.quota_reservation,old.created_at)
     or (old.response_message_id is not null and new.response_message_id is distinct from old.response_message_id) then
    raise exception 'SR_REQUEST_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists sr_request_identity_immutable on sr_request;
create trigger sr_request_identity_immutable before update on sr_request for each row execute function sr_keep_request_identity();

create table if not exists execution_budget_authorization (
  space text not null check(space in ('kernel','sr')), plan_auth_version text not null,
  limits jsonb not null, primary key(space,plan_auth_version)
);
create or replace function lyra_immutable_budget_authorization() returns trigger language plpgsql as $$
begin raise exception 'EXECUTION_BUDGET_AUTH_IMMUTABLE'; end $$;
drop trigger if exists immutable_budget_authorization on execution_budget_authorization;
create trigger immutable_budget_authorization before update or delete on execution_budget_authorization
for each row execute function lyra_immutable_budget_authorization();
