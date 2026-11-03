-- Lyra P3 事件实例表（W14: code-writer，合同 docs/specs/P3-EVENTS-REVIEW.md Done-when 2）。
-- 不带 schema 限定：按应用时的 search_path 落位（派发要求应用到 public）；幂等（if not exists）。
-- 列名按派发冻结：event_id / subject / type / subtype / event_time / evidence_fact_id / created_at。
-- 另加 attrs jsonb：次命中记录（多命中单归属纪律）、增速事件的阈值与"最新修订口径"声明、
-- 预告报告期等事件属性的可追溯载体（HISTORICAL-REFERENCE §3/§6 要求随样本标注）。
create table if not exists events (
  event_id text primary key,
  subject text not null,
  type text not null,
  subtype text,
  event_time timestamptz not null,
  evidence_fact_id text not null,
  attrs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_subject_type_time_idx on events (subject, type, event_time);
create index if not exists events_evidence_fact_idx on events (evidence_fact_id);
