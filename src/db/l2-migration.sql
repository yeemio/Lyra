-- Lyra L2 公告 PDF 回填状态表（W21: code-writer，合同 docs/specs/DATA-SOURCES.md §4 L2）。
-- 不带 schema 限定：按应用时的 search_path 落位（public）；幂等（if not exists）。
-- 列按派发冻结：fact_id / pdf_sha256 / bytes / status / error / downloaded_at；
-- 幂等键 fact_id（断点续跑：重跑跳过 DONE，FAILED/SKIPPED 行可被重跑覆写）。
-- pdf_sha256/bytes 为原件库 CAS 哈希与字节数（mediaType=application/pdf，见 src/artifacts/store.ts）。
create table if not exists pdf_backfill_state (
  fact_id text primary key,
  pdf_sha256 text,
  bytes bigint,
  status text not null check (status in ('DONE', 'FAILED', 'SKIPPED')),
  error text,
  downloaded_at timestamptz not null default now()
);
