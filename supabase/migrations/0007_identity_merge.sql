-- Identity migration, and the crash it was causing.
--
-- `scripts/sync-canonical.ts` upserts `players` with `on_conflict=player_uid`.
-- That clause resolves exactly one of this table's three unique keys. The other
-- two — `gsis_id` and `sleeper_id` — are not conflict targets, so when a row
-- arrives whose external id already belongs to a *different* `player_uid`,
-- Postgres raises 23505 and PostgREST returns 409. The upsert is not written to
-- survive that, so the script exits 1.
--
-- This is not a hypothetical. `player_uid` is `gsis:<id>` when we have a gsis
-- and `sleeper:<id>` when we do not, so a player who was first stored before
-- nflverse knew about him is stored under `sleeper:13806`, and the moment his
-- gsis appears in the crosswalk his uid *changes* to `gsis:00-00…`. The new row
-- then tries to claim sleeper_id 13806, which the old row still holds:
--
--   duplicate key value violates unique constraint "players_sleeper_id_key"
--   Key (sleeper_id)=(13806) already exists.
--
-- That is the exact failure in Actions runs 33258970969 and 33317688430, and it
-- is why fresh projections stopped reaching production for two straight days
-- while every model step above it reported success. The deck's guess was
-- credentials; the credentials were fine. The identity key moved underneath a
-- table that had no way to let it.
--
-- Two things are needed to let it. A uid that changes must carry its history
-- with it, and two rows that turn out to be the same person must be able to
-- become one.

-- ---------------------------------------------------------------------------
-- A uid that changes keeps its history
-- ---------------------------------------------------------------------------

-- Without `on update cascade`, renaming a `player_uid` is impossible: the
-- projections referencing it block the update, and deleting the row to get
-- around that throws away exactly the history this table exists to keep.
alter table player_projections
  drop constraint if exists player_projections_player_uid_fkey;

alter table player_projections
  add constraint player_projections_player_uid_fkey
  foreign key (player_uid) references players (player_uid)
  on delete cascade
  on update cascade;

-- ---------------------------------------------------------------------------
-- Two rows that are one person become one row
-- ---------------------------------------------------------------------------

-- Collapse `from_uid` into `to_uid`.
--
-- Idempotent and safe to call for a pair that needs no work, because the caller
-- cannot cheaply tell the difference and a sync that has to reason about it is a
-- sync that will get it wrong.
--
-- The rename case and the merge case are genuinely different. If the target does
-- not exist yet this is a *rename* — the same person, newly better identified —
-- and the cascade moves the projections for free. If it does exist these are two
-- records of one person, and the projections have to be reconciled row by row
-- because both may hold the same (season, week, model_version).
--
-- Where they collide the target's row wins. It is the row keyed by the better
-- identifier, so it is the one later runs will keep writing to, and preferring
-- it means a merge cannot resurrect a stale projection over a current one.
create or replace function merge_player(from_uid text, to_uid text)
returns text
language plpgsql
as $$
declare
  moved      integer := 0;
  discarded  integer := 0;
  source     players%rowtype;
begin
  if from_uid is null or to_uid is null or from_uid = to_uid then
    return 'noop';
  end if;

  select * into source from players where player_uid = from_uid;
  if not found then
    return 'noop';
  end if;

  -- Rename: nothing to reconcile, and the cascade carries the projections.
  if not exists (select 1 from players where player_uid = to_uid) then
    update players set player_uid = to_uid, updated_at = now() where player_uid = from_uid;
    return 'renamed';
  end if;

  -- Merge. Move every projection the target does not already have.
  with movable as (
    select p.id
    from player_projections p
    where p.player_uid = from_uid
      and not exists (
        select 1 from player_projections q
        where q.player_uid = to_uid
          and q.season = p.season
          and q.week = p.week
          and q.model_version = p.model_version
      )
  )
  update player_projections p
     set player_uid = to_uid
    from movable m
   where p.id = m.id;
  get diagnostics moved = row_count;

  -- What is left is a duplicate of a row the target already holds.
  delete from player_projections where player_uid = from_uid;
  get diagnostics discarded = row_count;

  -- Free the source's unique ids before claiming them, so the backfill below
  -- cannot trip the very constraint this function exists to resolve.
  delete from players where player_uid = from_uid;

  -- Keep any external id the target was missing. Its own ids always win: the
  -- target is the better-identified record and overwriting it would undo that.
  update players t
     set gsis_id    = coalesce(t.gsis_id,    source.gsis_id),
         sleeper_id = coalesce(t.sleeper_id, source.sleeper_id),
         yahoo_id   = coalesce(t.yahoo_id,   source.yahoo_id),
         espn_id    = coalesce(t.espn_id,    source.espn_id),
         pfr_id     = coalesce(t.pfr_id,     source.pfr_id),
         birthdate  = coalesce(t.birthdate,  source.birthdate),
         updated_at = now()
   where t.player_uid = to_uid;

  return format('merged (%s projections moved, %s duplicates dropped)', moved, discarded);
end;
$$;

comment on function merge_player(text, text) is
  'Collapse one player row into another, moving projection history and freeing the external ids. Called by scripts/sync-canonical.ts when a player_uid migrates.';
