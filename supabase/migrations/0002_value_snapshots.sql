-- Market value history.
--
-- Buy-low and sell-high are differences over time, and nobody publishes
-- yesterday's values. The series only exists if we record it, so this table
-- starts filling from the first run and becomes useful a few weeks later.

create table if not exists value_snapshots (
  id             bigint generated always as identity primary key,
  sleeper_id     text        not null,
  name           text        not null,
  position       text        not null,

  -- Dynasty and redraft price the same player very differently, and superflex
  -- reprices every quarterback, so each market is its own series.
  is_dynasty     boolean     not null,
  super_flex     boolean     not null,

  value          integer     not null,
  overall_rank   integer,
  position_rank  integer,
  rostered_pct   numeric(5,2),

  captured_at    timestamptz not null default now(),
  -- One row per player per market per day; intraday movement is noise.
  captured_date  date        not null
);

create unique index if not exists value_snapshots_unique
  on value_snapshots (sleeper_id, is_dynasty, super_flex, captured_date);

create index if not exists value_snapshots_series
  on value_snapshots (sleeper_id, is_dynasty, super_flex, captured_date desc);
