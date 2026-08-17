-- Projection snapshots: the accuracy moat.
--
-- Every projection we ever make is written here BEFORE kickoff, then scored
-- after. Without this, measuring our own error — or any source's systematic
-- bias — is impossible retroactively. It is the one table that must exist
-- before Week 1.

create table if not exists projection_snapshots (
  id              bigint generated always as identity primary key,

  -- what was projected
  season          smallint     not null,
  week            smallint     not null,
  player_id       text         not null,   -- internal id via the crosswalk
  source          text         not null,   -- 'sleeper' | 'vegas' | 'mfa_v0' | ...
  source_version  text         not null,   -- model artifact version, '' for external

  -- the projection itself
  points          numeric(7,2) not null,
  -- full predictive distribution when the source produces one
  p10             numeric(7,2),
  p50             numeric(7,2),
  p90             numeric(7,2),
  stddev          numeric(7,2),
  -- probability the player is active at all; NULL when the source doesn't say
  play_prob       numeric(4,3),

  -- scoring context, so a projection is comparable across leagues
  scoring_key     text         not null,   -- hash of the ScoringRules used

  -- point-in-time discipline
  captured_at     timestamptz  not null default now(),
  -- kickoff of the player's game. captured_at must precede it or the row is
  -- contaminated by hindsight and cannot be used to measure accuracy.
  kickoff_at      timestamptz,

  -- filled in after the game; NULL until then
  actual_points   numeric(7,2),
  scored_at       timestamptz
);

-- One projection per source per player per week. Re-running the pipeline
-- updates in place rather than double-counting.
create unique index if not exists projection_snapshots_unique
  on projection_snapshots (season, week, player_id, source, source_version, scoring_key);

create index if not exists projection_snapshots_scoring_queue
  on projection_snapshots (season, week)
  where actual_points is null;

create index if not exists projection_snapshots_by_source
  on projection_snapshots (source, season, week);

-- Rows captured after kickoff are useless for accuracy measurement. Flag them
-- loudly rather than letting them quietly inflate our scores later.
create or replace view projection_snapshots_valid as
  select *
  from projection_snapshots
  where kickoff_at is null or captured_at < kickoff_at;


-- Vegas lines, snapshotted the same way and for the same reason: the closing
-- line is the market's final answer, and comparing our projection to it is how
-- we find out whether we know anything the market doesn't.
create table if not exists odds_snapshots (
  id             bigint generated always as identity primary key,
  season         smallint     not null,
  week           smallint     not null,
  game_id        text         not null,
  home_team      text         not null,
  away_team      text         not null,
  commence_at    timestamptz  not null,
  bookmaker      text         not null,
  total          numeric(5,1),
  home_spread    numeric(5,1),
  -- de-vigged win probability, not the raw juiced price
  home_win_prob  numeric(4,3),
  captured_at    timestamptz  not null default now()
);

create index if not exists odds_snapshots_game
  on odds_snapshots (season, week, game_id, captured_at desc);
