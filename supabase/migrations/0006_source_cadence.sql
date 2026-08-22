-- Two remaining lies in the freshness panel.
--
-- **Sleeper was never a source that gets refreshed.** League and roster data is
-- fetched on every render behind a five-minute memo, so it is current by
-- construction. Modelling it as something that must be pushed meant it sat at
-- `never` until somebody pressed a button — asking a manager to certify that
-- live data is live. A third kind fixes it: `live` is always healthy, because
-- the alternative is that the page did not render at all.
--
-- **The thresholds cried wolf.** Everything offline was set to 1440 minutes, so
-- a lake synced yesterday read `stale` in a week with no games played. The brief
-- (§38) asks for per-source cadence and this supplies it: injuries move daily in
-- season, a play-by-play lake does not move at all between Sundays, and a player
-- identity crosswalk changes when the NFL transacts.
--
-- A panel that is always red teaches you to ignore it, which is worse than not
-- having one.

alter table data_sources drop constraint if exists data_sources_kind_check;
alter table data_sources
  add constraint data_sources_kind_check check (kind in ('live', 'serve', 'offline'));

-- Read per request behind a short memo. Nothing to refresh.
update data_sources set kind = 'live', rebuild_command = null where source = 'sleeper';

-- Cadence, per source, in minutes.
update data_sources set stale_after_minutes = 2880  where source = 'nflverse';    -- 2 days
update data_sources set stale_after_minutes = 1440  where source = 'injuries';    -- daily in season
update data_sources set stale_after_minutes = 10080 where source = 'crosswalk';   -- weekly
update data_sources set stale_after_minutes = 10080 where source = 'projections'; -- weekly rebuild
update data_sources set stale_after_minutes = 10080 where source = 'odds';        -- weekly capture
update data_sources set stale_after_minutes = 1440  where source = 'values';      -- daily

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
