-- Data freshness, and the record of every attempt to refresh it.
--
-- The application had no idea how old its own numbers were, because nothing
-- recorded when they last changed. The weekly GitHub Action that was supposed
-- to refresh them committed artifacts back to git and, as of this migration,
-- had never produced a single commit — a failure that was invisible precisely
-- because there was nowhere for it to be visible.
--
-- Two tables. `data_sources` is current state, one row per provider, cheap to
-- read on every page. `refresh_runs` is the history, which is what turns "the
-- injuries are stale" into "the injuries provider has failed four nights
-- running, here is the error".

create table if not exists data_sources (
  -- Stable slug: 'nflverse', 'sleeper', 'injuries', 'odds', 'values',
  -- 'projections'. Chosen by the caller, not an enum, so adding a provider is
  -- an insert rather than a migration.
  source              text        primary key,
  label               text        not null,

  -- How old this source is allowed to get before the UI should say so. Sources
  -- age at wildly different rates: a schedule is fine for a week, an injury
  -- report is stale in hours, and treating them alike is how a product ends up
  -- either crying wolf or saying nothing.
  stale_after_minutes integer     not null default 1440,

  last_attempt_at     timestamptz,
  last_success_at     timestamptz,
  -- The freshness the user actually cares about: not when we last ran, but how
  -- current the underlying data is. A successful run against a provider that
  -- has not published since Tuesday is fresh work over stale facts.
  data_timestamp      timestamptz,

  last_status         text        not null default 'unknown'
    check (last_status in ('unknown', 'ok', 'failed', 'running')),
  last_error          text,
  last_record_count   integer,
  -- Consecutive failures. One failed run is noise; four is an outage.
  consecutive_failures integer    not null default 0,

  updated_at          timestamptz not null default now()
);

-- Every attempt, successful or not.
--
-- Failures are the rows that matter most and are exactly the ones a
-- "last updated" timestamp throws away.
create table if not exists refresh_runs (
  id             bigint generated always as identity primary key,
  source         text        not null references data_sources (source) on delete cascade,

  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,

  status         text        not null default 'running'
    check (status in ('running', 'ok', 'failed')),

  -- Counted separately because "processed 4,000 rows, changed none" and
  -- "processed 4,000 rows, replaced all of them" are very different events.
  records_processed integer,
  records_added     integer,
  records_updated   integer,
  records_removed   integer,

  error          text,
  -- 'cron' | 'manual' | 'deploy'. Distinguishes "the schedule is working" from
  -- "someone had to press the button", which is the difference between an
  -- automated pipeline and a manual one wearing a costume.
  trigger        text        not null default 'manual'
);

create index if not exists refresh_runs_by_source
  on refresh_runs (source, started_at desc);

create index if not exists refresh_runs_failures
  on refresh_runs (source, started_at desc)
  where status = 'failed';

-- One read for the whole freshness panel, staleness already decided in the
-- database so every caller agrees on what "stale" means.
create or replace view data_freshness as
  select
    s.source,
    s.label,
    s.last_status,
    s.last_success_at,
    s.data_timestamp,
    s.last_record_count,
    s.consecutive_failures,
    s.last_error,
    s.stale_after_minutes,
    extract(epoch from (now() - coalesce(s.data_timestamp, s.last_success_at))) / 60.0
      as age_minutes,
    case
      when s.last_success_at is null then 'never'
      when s.consecutive_failures >= 3 then 'failing'
      when coalesce(s.data_timestamp, s.last_success_at)
           < now() - make_interval(mins => s.stale_after_minutes) then 'stale'
      else 'healthy'
    end as health
  from data_sources s;

-- Seeded so the UI has rows to render before the first refresh ever runs, and
-- so a source that has *never* succeeded is visibly present rather than simply
-- absent. An absent provider looks like one nobody needed.
insert into data_sources (source, label, stale_after_minutes) values
  ('nflverse',    'nflverse (stats, rosters, schedules)', 1440),
  ('sleeper',     'Sleeper leagues and rosters',            60),
  ('injuries',    'Injury designations',                   180),
  ('odds',        'Betting market',                        360),
  ('values',      'Market values',                        1440),
  ('crosswalk',   'Player identity crosswalk',            1440),
  ('projections', 'Model projections',                    1440)
on conflict (source) do nothing;
