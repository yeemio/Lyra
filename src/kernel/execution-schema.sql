-- PR4 source migration. Applied only by the explicitly selected schema initializer.
alter table kernel_lock add column if not exists generation bigint not null default 0;
alter table kernel_lock add column if not exists lease_until timestamptz not null default '-infinity';
alter table kernel_lock add column if not exists lease_ttl_ms integer not null default 60000;
alter table exec_permit add column if not exists execution_generation bigint;
alter table exec_permit add column if not exists response_checkpoint jsonb;
alter table exec_permit add column if not exists response_hash text;

create table if not exists research_execution (
  execution_key text primary key,
  business_key jsonb not null,
  request_hash text not null,
  snapshot jsonb not null,
  snapshot_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  conclusion_id text,
  conclusion_hash text
);

create table if not exists execution_budget_reservation (
  week_start date not null,
  scope text not null check (scope in ('WEEKLY','POST_EVENT')),
  business_key text not null,
  stage text not null check (stage in ('A','J')),
  state text not null check (state in ('HELD','CONSUMED','RELEASED')),
  plan_auth_version text not null,
  scope_limit integer not null,
  plan_limit integer not null,
  deadline timestamptz not null,
  permit_id uuid,
  primary key (business_key,stage)
);
create index if not exists execution_budget_week on execution_budget_reservation(week_start,scope,state);

create or replace function lyra_keep_execution_checkpoint() returns trigger language plpgsql as $$
begin
  if old.sent_at is not null and
     row(new.permit_id,new.stage,new.subject_kind,new.subject,new.research_kind,new.cutoff,new.input_hash,new.input_bytes,
         new.method_version,new.plan_auth_version,new.deadline,new.simulated,new.sent_at,new.execution_generation)
     is distinct from
     row(old.permit_id,old.stage,old.subject_kind,old.subject,old.research_kind,old.cutoff,old.input_hash,old.input_bytes,
         old.method_version,old.plan_auth_version,old.deadline,old.simulated,old.sent_at,old.execution_generation) then
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
drop trigger if exists execution_checkpoint_immutable on exec_permit;
create trigger execution_checkpoint_immutable before update on exec_permit for each row execute function lyra_keep_execution_checkpoint();

create or replace function lyra_keep_research_snapshot() returns trigger language plpgsql as $$
begin
  if row(new.execution_key,new.business_key,new.request_hash,new.snapshot,new.snapshot_hash,new.created_at)
     is distinct from row(old.execution_key,old.business_key,old.request_hash,old.snapshot,old.snapshot_hash,old.created_at)
     or (old.conclusion_id is not null and row(new.conclusion_id,new.conclusion_hash) is distinct from row(old.conclusion_id,old.conclusion_hash)) then
    raise exception 'RESEARCH_CHECKPOINT_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists research_snapshot_immutable on research_execution;
create trigger research_snapshot_immutable before update on research_execution for each row execute function lyra_keep_research_snapshot();

create table if not exists execution_budget_authorization (
  space text not null check(space in ('kernel','sr')), plan_auth_version text not null,
  limits jsonb not null, primary key(space,plan_auth_version)
);
create or replace function lyra_immutable_budget_authorization() returns trigger language plpgsql as $$
begin raise exception 'EXECUTION_BUDGET_AUTH_IMMUTABLE'; end $$;
drop trigger if exists immutable_budget_authorization on execution_budget_authorization;
create trigger immutable_budget_authorization before update or delete on execution_budget_authorization
for each row execute function lyra_immutable_budget_authorization();

create table if not exists research_execution_claim (
 execution_key text primary key, owner uuid not null, generation bigint not null
);
