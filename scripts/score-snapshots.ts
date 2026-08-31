/**
 * Score last week's projections, and report who was closer.
 *
 * The missing benchmark, in one job.
 *
 * Every projection this product makes has been recorded before kickoff since
 * before Week 1, alongside Sleeper's consensus, under a shared scoring key. Not
 * one of them was ever marked right or wrong — `actual_points` has been null in
 * every row of `projection_snapshots` for the whole life of the table. So the
 * claim the product rests on, that the model is worth using instead of the free
 * projection a manager already has, was untested. Not disproven: unmeasured.
 *
 * This closes it. Fetch what actually happened, write it back onto every
 * projection of that player, and print the head-to-head.
 *
 * The comparison is deliberately hostile to us in three ways, because a
 * benchmark you have tuned to win is not a benchmark:
 *
 * - **Common players only.** A source that projects only starters looks
 *   accurate because starters are predictable. Both sources are scored on the
 *   intersection, so coverage cannot be mistaken for skill.
 * - **Players who did not appear are excluded.** A projection of eight points
 *   for a healthy scratch is an availability miss, not a projection miss, and
 *   charging it here would let the model hide behind the injury report.
 * - **The result is paired and t-tested.** One week of MAE is mostly the
 *   week's own difficulty. A single green number proves nothing and is reported
 *   as proving nothing.
 *
 *     npm run score:snapshots -- [week]
 *
 * Idempotent: re-running rewrites the same actuals onto the same rows.
 */
import {
  PostgrestSnapshotStore,
  accuracyOf,
  commonPlayers,
  pairedT,
  scoreActuals,
  scoringKey,
} from '../packages/ingest/src/index.js';
import { SleeperClient } from '../packages/adapters/src/index.js';

/** Must match `scripts/snapshot.ts`, or the two captures are not comparable. */
const SCORING = {
  rec: 1,
  passYd: 0.04,
  passTd: 4,
  passInt: -1,
  rushYd: 0.1,
  rushTd: 6,
  recYd: 0.1,
  recTd: 6,
  fumbleLost: -2,
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SECRET_KEY?.trim();

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.');
  process.exit(1);
}

const store = new PostgrestSnapshotStore(url, key);
const state = await new SleeperClient().getNflState();
const season = Number(state.season);

/*
 * The week that has finished, not the one in progress.
 *
 * Scoring the current week mid-Sunday would record partial stat lines as
 * final and permanently understate every source at once. The default is
 * therefore one behind, and an explicit argument is how you rescore an
 * older week.
 */
const week = Number(process.argv[2] ?? Math.max(1, Number(state.week) - 1));

console.log(`scoring: ${season} week ${week}`);
console.log(`scoring key: ${scoringKey(SCORING)}`);

const actuals = await scoreActuals(season, week, SCORING);
console.log(`actuals: ${actuals.size} players recorded a stat line`);

if (actuals.size === 0) {
  console.log('nothing to score — that week has not been played yet.');
  process.exit(0);
}

const written = await store.scoreWeek(season, week, actuals);
console.log(`scored: ${written} player rows updated`);

const rows = await store.readProjections(season, week);
console.log(`projections on file: ${rows.length}`);

if (rows.length === 0) {
  console.log('no pre-kickoff projections captured for that week — nothing to compare.');
  process.exit(0);
}

const common = commonPlayers(rows, actuals);
console.log(`\nhead to head on ${common.size} players both sources projected and who played:\n`);

const table = accuracyOf(rows, actuals, { restrictTo: common, baseline: 'sleeper' });

console.log('  source            version         n      MAE     RMSE     bias    win%');
for (const row of table) {
  console.log(
    `  ${row.source.padEnd(16)}  ${(row.sourceVersion || '—').padEnd(14)} ` +
      `${String(row.n).padStart(5)} ` +
      `${row.mae.toFixed(3).padStart(8)} ` +
      `${row.rmse.toFixed(3).padStart(8)} ` +
      `${row.bias >= 0 ? '+' : ''}${row.bias.toFixed(3).padStart(7)} ` +
      `${row.winRate === undefined ? '     —' : `${(row.winRate * 100).toFixed(1).padStart(6)}`}`,
  );
}

const test = pairedT(rows, actuals, 'ffe', 'sleeper', common);

if (test.n < 2) {
  console.log('\nNot enough overlap to compare. Check that both sources captured this week.');
} else {
  const better = test.meanDifference < 0;
  const decisive = Math.abs(test.t) >= 2;

  console.log(
    `\npaired difference (ffe − sleeper): ${test.meanDifference.toFixed(3)} points of ` +
      `absolute error over ${test.n} players, t = ${test.t.toFixed(2)}`,
  );

  /*
   * Stated as what one week can support, which is usually "nothing yet".
   *
   * The temptation with a benchmark is to read the sign and declare a winner.
   * A single week of fantasy projections is dominated by which quarterback
   * threw four touchdowns, and both sources missed that one together. Weeks
   * accumulate; conclusions should wait for them.
   */
  if (!decisive) {
    console.log(
      `verdict: not separated by this week alone (|t| < 2). ` +
        `${better ? 'We are ahead' : 'We are behind'} on the point estimate, which is not yet a finding.`,
    );
  } else if (better) {
    console.log('verdict: we beat the consensus on this week, and the margin is larger than the noise.');
  } else {
    console.log(
      'verdict: the consensus beat us on this week, and the margin is larger than the noise. ' +
        'This is the number the product claim depends on — treat it as a bug report.',
    );
  }
}
