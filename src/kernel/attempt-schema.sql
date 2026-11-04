-- Append-only attempt identity; completion may be recorded once. No payload or credentials are stored.
create table if not exists execution_attempt (
  attempt_id uuid primary key,
  space text not null check(space in ('kernel','sr')),
  contract jsonb not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  outcome text check(outcome in ('RETURNED','REJECTED')),
  fail_code text,
  permit_id uuid,
  check ((finished_at is null) = (outcome is null))
);
create index if not exists execution_attempt_time on execution_attempt(space,started_at);
create or replace function lyra_keep_attempt() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'EXECUTION_ATTEMPT_IMMUTABLE'; end if;
  if old.finished_at is not null or row(new.attempt_id,new.space,new.contract,new.started_at)
     is distinct from row(old.attempt_id,old.space,old.contract,old.started_at) then
    raise exception 'EXECUTION_ATTEMPT_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists keep_attempt on execution_attempt;
create trigger keep_attempt before update or delete on execution_attempt for each row execute function lyra_keep_attempt();
