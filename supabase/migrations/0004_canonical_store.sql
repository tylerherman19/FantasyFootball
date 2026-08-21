-- The canonical store (§36, §80, and audit §9.3).
--
-- Serving reads committed JSON artifacts, and that is deliberate and correct:
-- a local file read beats a network round trip on every page, and it is what
-- keeps Python out of the serving path. This does not change that.
--
-- What it fixes is that the artifact is also the *only* copy. It holds one week,
-- it is overwritten in place, and the moment it is rebuilt the previous state is
-- gone. So the product cannot answer the questions the brief asks in §35 and
-- §48 — why did this player's ranking change, what did we think last week, when
-- did the model start disagreeing with the market — not because the model is
-- weak but because nothing remembers.
--
-- So: Postgres becomes the canonical store and the history; the artifact becomes
-- a generated serving format. The pipeline in §36 gets its missing middle
-- without giving up the property that makes the hot path fast.
--
-- Deliberately NOT here: play-by-play, weekly stats, features. Twenty-five
-- seasons of play-level data belongs in Parquet, which is where it already is
-- and what it is shaped for. Postgres is the right home for identity, current
-- state and the history of what we believed, not for a columnar scan.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- One row per person, with every external id we know.
--
-- The audit's §5 finding: identity depends entirely on one third-party CSV, and
-- `sleeper_id` is the de facto primary key everywhere, which makes the
-- "platform-neutral" domain model quietly Sleeper-shaped — a player without a
-- Sleeper id cannot be represented at all. `player_uid` is the internal key that
-- fixes that; the external ids become attributes rather than the identity.
create table if not exists players (
  player_uid      text        primary key,

  -- External identities. All nullable: a player can be missing from any given
  -- provider, and that must not stop him existing here.
  gsis_id         text unique,
  sleeper_id      text unique,
  yahoo_id        text,
  espn_id         text,
  pfr_id          text,

  full_name       text        not null,
  position        text,
  team            text,
  birthdate       date,
  draft_year      smallint,
  draft_round     smallint,
  draft_overall   smallint,
  rookie_year     smallint,

  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists players_by_team on players (team) where team is not null;
create index if not exists players_by_position on players (position);
-- Name lookup for the one join that has no id bridge: the current draft class,
-- which nflverse gives PFR-style ids rather than gsis.
create index if not exists players_by_name on players (lower(full_name));

-- ---------------------------------------------------------------------------
-- What the model believed, and when
-- ---------------------------------------------------------------------------

-- Every projection the model has ever published, versioned.
--
-- Distinct from `projection_snapshots` (migration 0001), which captures a
-- point-in-time projection *for accuracy scoring* against a specific kickoff.
-- This is the model's current published state and its history, which is what
-- answers "why did his ranking change" — a different question that happens to
-- involve similar numbers.
--
-- Stat lines rather than points, for the same reason the artifact uses them:
-- three leagues, 42/64/132 scoring keys, and baking one ruleset in would hand
-- two of them wrong numbers.
create table if not exists player_projections (
  id              bigint generated always as identity primary key,

  player_uid      text        not null references players (player_uid) on delete cascade,
  season          smallint    not null,
  week            smallint    not null,
  model_version   text        not null,

  -- The projected stat line, as exported.
  stats           jsonb       not null,
  sd              numeric(7,3),
  bye_week        smallint,
  -- 'history' | 'rookie-prior'. A draft-capital estimate is not an observation
  -- and the difference must survive into storage, not just the UI.
  basis           text        not null default 'history',
  game_loading    numeric(4,3),

  -- When the model produced this, as opposed to when we stored it.
  generated_at    timestamptz not null,
  recorded_at     timestamptz not null default now()
);

-- One row per player per week per model version. Re-running the exporter with
-- the same version corrects in place; bumping the version keeps both, which is
-- what makes "the ranking changed because the model changed" answerable.
create unique index if not exists player_projections_unique
  on player_projections (player_uid, season, week, model_version);

create index if not exists player_projections_by_week
  on player_projections (season, week);

create index if not exists player_projections_history
  on player_projections (player_uid, generated_at desc);

-- ---------------------------------------------------------------------------
-- Model versions
-- ---------------------------------------------------------------------------

-- What each version was, and what it scored (§35).
--
-- The repository already records its gates in commit messages and docstrings,
-- which is durable but not queryable. This makes "which version is live and did
-- it beat the one before it" a question the application can answer rather than
-- one a person has to go and read.
create table if not exists model_versions (
  model_version   text        primary key,
  description     text,

  -- Out-of-sample results, as measured by the harness.
  mae             numeric(8,4),
  rmse            numeric(8,4),
  crps            numeric(8,4),
  baseline        text,
  skill_vs_baseline numeric(6,4),
  evaluation_window text,
  observations    integer,

  -- False for a rung that was built, measured and declined — v2 and v3 both.
  -- A negative result nobody records is a negative result somebody repeats.
  shipped         boolean     not null default false,
  first_seen_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reading the history
-- ---------------------------------------------------------------------------

-- What changed for a player between consecutive publications.
--
-- The §48 question — annotate a value chart with why it moved — needs the
-- previous state beside the current one, and a window function is a better home
-- for that than application code that would have to fetch both and diff them.
create or replace view projection_changes as
  select
    p.player_uid,
    pl.full_name,
    pl.position,
    pl.team,
    p.season,
    p.week,
    p.model_version,
    p.stats,
    p.generated_at,
    lag(p.stats) over w        as previous_stats,
    lag(p.generated_at) over w as previous_generated_at,
    lag(p.model_version) over w as previous_model_version,
    -- True when the model itself changed between the two, which is a completely
    -- different explanation from the player changing.
    lag(p.model_version) over w is distinct from p.model_version as model_changed
  from player_projections p
  join players pl using (player_uid)
  window w as (partition by p.player_uid order by p.generated_at);

-- Current published projection per player: the common read.
create or replace view current_projections as
  select distinct on (player_uid, season, week)
    player_uid, season, week, model_version, stats, sd, bye_week, basis, generated_at
  from player_projections
  order by player_uid, season, week, generated_at desc;
