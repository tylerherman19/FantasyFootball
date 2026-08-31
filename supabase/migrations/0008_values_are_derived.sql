-- Values stopped being a source and became a calculation.
--
-- `values` was seeded as a serve-time provider because it was one: the app
-- fetched market prices from a third party, on a daily cadence, and the panel
-- correctly reported how long ago that had last worked.
--
-- It no longer fetches anything. Asset value is now derived from the projection
-- artifact on every render, under the scoring and lineup of the league being
-- viewed — see `apps/web/src/lib/values.ts` and `packages/core/src/valuation`.
-- There is no request to succeed or fail, so `last_success_at` can only ever go
-- stale, and a panel that reports a permanently ageing source nobody can
-- refresh is the exact failure mode migration 0005 was written to remove.
--
-- `derived` says what it is: healthy whenever the artifact behind it is, which
-- is a claim about the projections and is already made about the projections.

alter table data_sources drop constraint if exists data_sources_kind_check;
alter table data_sources
  add constraint data_sources_kind_check
  check (kind in ('live', 'serve', 'offline', 'derived'));

update data_sources
   set kind = 'derived',
       label = 'Asset values',
       rebuild_command = null,
       last_error = null,
       consecutive_failures = 0
 where source = 'values';

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
      -- Read on every request. If it were failing, the page would be failing.
      when s.kind = 'live' then 'healthy'
      -- Computed from an artifact on each render. Its freshness is the
      -- artifact's freshness, which the app overlays from `generatedAt`.
      when s.kind = 'derived' then 'healthy'
      -- A source that should be pushed and never has been is a real failure.
      when s.kind = 'serve' and s.last_success_at is null then 'never'
      -- Built offline and not yet recorded: unknown, not broken.
      when s.last_success_at is null and s.data_timestamp is null then 'unknown'
      when s.consecutive_failures >= 3 then 'failing'
      when coalesce(s.data_timestamp, s.last_success_at)
           < now() - make_interval(mins => s.stale_after_minutes) then 'stale'
      else 'healthy'
    end as health
  from data_sources s;

-- `value_snapshots` (migration 0002) is left in place and stops receiving
-- writes. The rows already in it are a real record of what the market said
-- while we were reading it, and deleting history to tidy up a schema is how a
-- product loses the ability to answer questions about its own past. Nothing
-- reads it today; the replacement series is `player_projections`, which is
-- richer — value is a function of a projection, so a stored projection
-- reconstructs the value for any league, where the old table held four canned
-- configurations.
comment on table value_snapshots is
  'Historical third-party market values, captured until 2026-08. No longer written: asset value is derived from player_projections. Retained as history.';
