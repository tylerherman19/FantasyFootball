-- Not every source can be refreshed by pressing a button, and pretending
-- otherwise made the whole panel permanently red.
--
-- `data_sources` was seeded with seven providers, but only two of them —
-- Sleeper and market values — are fetched at serve time. The other five are
-- built offline by the Python pipeline, and nothing ever wrote their status. So
-- they sat at `never` forever, the view rolled that up to `failing`, and the
-- league home led with "7 data sources not reporting" as its top insight. The
-- data was fine. The bookkeeping was wrong, and it was wrong in the loudest
-- possible place.
--
-- Two changes. `kind` says how a source is produced, so the UI can offer
-- "refresh now" for one and "rebuild with this command" for the other. And the
-- health calculation stops treating "never refreshed on demand" as a failure for
-- a source that is not refreshed on demand.

alter table data_sources
  add column if not exists kind text not null default 'serve'
    check (kind in ('serve', 'offline'));

-- What produces it, for the ones a button cannot.
alter table data_sources
  add column if not exists rebuild_command text;

update data_sources set kind = 'offline', rebuild_command = 'model/ingest/nflverse.py'
  where source = 'nflverse';
update data_sources set kind = 'offline', rebuild_command = 'model/ingest/nflverse.py'
  where source = 'injuries';
update data_sources set kind = 'offline', rebuild_command = 'model/ingest/crosswalk.py'
  where source = 'crosswalk';
update data_sources set kind = 'offline', rebuild_command = 'model/export_projections.py'
  where source = 'projections';

-- Odds are captured by the weekly GitHub Action, not by /api/refresh.
update data_sources set kind = 'offline', rebuild_command = 'npm run snapshot'
  where source = 'odds';

-- Dropped rather than replaced: `create or replace view` cannot insert a column
-- in the middle of the existing column list, and `kind` belongs next to the
-- source it describes rather than bolted on the end.
drop view if exists data_freshness;

create view data_freshness as
  select
    s.source,
    s.label,
    s.kind,
    s.rebuild_command,
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
      -- A serve-time source that has never run is a real failure: something is
      -- meant to be calling it and is not.
      when s.kind = 'serve' and s.last_success_at is null then 'never'
      -- An offline source with no timestamp has simply not been recorded yet.
      -- It is unknown, not broken, and the difference matters because one of
      -- them warrants a red banner and the other does not.
      when s.last_success_at is null and s.data_timestamp is null then 'unknown'
      when s.consecutive_failures >= 3 then 'failing'
      when coalesce(s.data_timestamp, s.last_success_at)
           < now() - make_interval(mins => s.stale_after_minutes) then 'stale'
      else 'healthy'
    end as health
  from data_sources s;
