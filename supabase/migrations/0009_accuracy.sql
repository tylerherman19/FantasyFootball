-- The benchmark that was never run.
--
-- `projection_snapshots` was created before Week 1 and called "the accuracy
-- moat". It has done half its job perfectly: every projection, from every
-- source, recorded before kickoff, under a shared scoring key, never rewritten.
--
-- The other half never happened. `actual_points` and `scored_at` have been null
-- in every row for the life of the table, so nothing was ever marked right or
-- wrong, and the comparison the product's central claim rests on — that the
-- model is worth using instead of the free consensus a manager already has —
-- could not be computed. Not disproven. Unmeasured.
--
-- `scripts/score-snapshots.ts` now fills those columns weekly. These views read
-- them.

-- ---------------------------------------------------------------------------
-- Per source, per week
-- ---------------------------------------------------------------------------

-- Only rows captured before kickoff and since resolved.
--
-- Built on `projection_snapshots_valid` rather than the base table, so a row
-- captured late — after the inactives dropped, say — cannot quietly improve
-- anyone's score. That view has existed since 0001 for exactly this moment.
create or replace view projection_accuracy_weekly as
  select
    season,
    week,
    source,
    source_version,
    scoring_key,
    count(*)                                              as n,
    avg(abs(points - actual_points))                      as mae,
    sqrt(avg((points - actual_points) ^ 2))               as rmse,
    -- Signed, so a source that is systematically high is distinguishable from
    -- one that is merely noisy. The two call for completely different fixes.
    avg(points - actual_points)                           as bias,
    -- Correlation matters separately from error: a source can be badly
    -- calibrated and still rank players correctly, which is most of what a
    -- start/sit decision needs.
    corr(points, actual_points)                           as correlation
  from projection_snapshots_valid
  where actual_points is not null
  group by season, week, source, source_version, scoring_key;

-- ---------------------------------------------------------------------------
-- Head to head, on shared coverage
-- ---------------------------------------------------------------------------

-- Every player-week both sources projected.
--
-- The comparison is only fair on the intersection. A source that projects only
-- starters looks accurate because starters are predictable; one that projects
-- the whole league looks worse for being more useful. Joining the two sources
-- on the player enforces that without anyone having to remember to.
create or replace view projection_head_to_head as
  select
    ours.season,
    ours.week,
    ours.scoring_key,
    ours.source_version                                   as model_version,
    ours.player_id,
    ours.points                                           as our_points,
    theirs.points                                         as consensus_points,
    ours.actual_points,
    abs(ours.points - ours.actual_points)                 as our_error,
    abs(theirs.points - theirs.actual_points)             as consensus_error
  from projection_snapshots_valid ours
  join projection_snapshots_valid theirs
    on theirs.season      = ours.season
   and theirs.week        = ours.week
   and theirs.player_id   = ours.player_id
   and theirs.scoring_key = ours.scoring_key
   and theirs.source      = 'sleeper'
  where ours.source = 'ffe'
    and ours.actual_points is not null
    and theirs.actual_points is not null;

-- The scoreboard: one row per season, week and model version.
--
-- `weeks_won` and the mean error answer different questions and both belong
-- here. A model can carry the better average and still be the wrong one to
-- trust on any given player, which is the question a manager setting a lineup
-- is actually asking.
create or replace view projection_scoreboard as
  select
    season,
    week,
    model_version,
    scoring_key,
    count(*)                                                        as n,
    avg(our_error)                                                  as our_mae,
    avg(consensus_error)                                            as consensus_mae,
    avg(our_error) - avg(consensus_error)                           as mae_gap,
    avg(case when our_error < consensus_error then 1.0 else 0.0 end) as win_rate,
    -- Paired t on the difference in absolute error. The pairing is what makes
    -- this readable at all: both sources faced the same week, and the week's
    -- own difficulty is the largest term in the variance and cancels exactly.
    --
    -- Below about two in magnitude, one week has not separated them. That is
    -- the usual answer and it should be reported as the answer, not rounded up
    -- into a claim.
    case
      when count(*) < 2 or stddev_samp(our_error - consensus_error) = 0 then null
      else avg(our_error - consensus_error)
           / (stddev_samp(our_error - consensus_error) / sqrt(count(*)))
    end                                                             as paired_t
  from projection_head_to_head
  group by season, week, model_version, scoring_key;

-- Season to date, which is the number that will actually settle it.
--
-- One week is mostly whichever quarterback threw four touchdowns that both
-- sources missed together. The claim is a season-length claim and this is where
-- it should be read.
create or replace view projection_scoreboard_season as
  select
    season,
    model_version,
    scoring_key,
    count(distinct week)                                            as weeks,
    count(*)                                                        as n,
    avg(our_error)                                                  as our_mae,
    avg(consensus_error)                                            as consensus_mae,
    avg(our_error) - avg(consensus_error)                           as mae_gap,
    avg(case when our_error < consensus_error then 1.0 else 0.0 end) as win_rate,
    case
      when count(*) < 2 or stddev_samp(our_error - consensus_error) = 0 then null
      else avg(our_error - consensus_error)
           / (stddev_samp(our_error - consensus_error) / sqrt(count(*)))
    end                                                             as paired_t
  from projection_head_to_head
  group by season, model_version, scoring_key;

comment on view projection_scoreboard_season is
  'Head-to-head against the free consensus, season to date. A negative mae_gap means we are closer on average; |paired_t| >= 2 means the gap is larger than the noise. This is the number behind the product claim.';
