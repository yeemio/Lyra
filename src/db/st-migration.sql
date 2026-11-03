-- Lyra · ST 时点表增量 schema（W16: code-writer）。
-- 合同：docs/specs/ASHARE-RULES.md §3（独立时点表：股票 × 生效日区间 × 状态；
-- 来源公告标识与公告日 available_at；区间不重叠，新状态生效即旧区间闭合）。
-- 不改 P0/P1 冻结 schema；只增本表；幂等（if not exists）；按应用时 search_path 落位。
-- 构建与读取入口：src/rules/st-timeline.ts；构建 CLI：src/rules/st-cli.ts。

create table if not exists st_status_timeline (
  subject text not null,                        -- 股票代码（A 股主板，ST 规则不适用 ETF）
  status text not null check (status in ('NORMAL', 'ST', '*ST')),
  effective_from date not null,                 -- 生效日 = 公告日次日（保守，P-i-T §3.1 同源）
  effective_to date,                            -- 开区间右端 null = 至今；[from, to)
  evidence_fact_id text not null,               -- 证据公告的 pintime_fact.fact_id（巨潮原件事实）
  evidence_event_id text,                       -- 六类事件表 events.event_id（ST 公告不属六类 → 恒 null，合同字段保留）
  evidence_published_at timestamptz not null,   -- 证据公告 source_published_at（公告日，CST 语义原样）
  evidence_available_at timestamptz not null,   -- 证据公告 available_at（日精度公告 → D+1 开盘前，P-i-T §3.1）
  short_name_at_publication text,               -- 巨潮随公告元数据返回的简称（审计参考；不作为状态依据，三禁令见 st-timeline.ts 头注）
  built_at timestamptz not null default now(),
  builder_version text not null,                -- 构建器版本轴（改规则 = 新版本，重跑重建）
  primary key (subject, effective_from),
  constraint st_status_timeline_range_check check (effective_to is null or effective_to > effective_from)
);
create index if not exists st_status_timeline_cover_idx
  on st_status_timeline (subject, effective_from, effective_to);
