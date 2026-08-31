/**
 * Weekly snapshot job — the accuracy moat.
 *
 * Captures what every source believed BEFORE kickoff. Must run weekly starting
 * before Week 1; the history it builds cannot be reconstructed later.
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/snapshot.ts [week]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JsonlSnapshotStore,
  PostgrestSnapshotStore,
  TeeSnapshotStore,
  fetchOdds,
  fetchSleeperProjections,
  modelSnapshots,
  scoringKey,
  type ArtifactLike,
} from '../packages/ingest/src/index.js';
import { SleeperClient } from '../packages/adapters/src/index.js';

/** Full PPR superflex — Tyler's leagues. Other scoring systems get their own rows. */
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseSecret = process.env.SUPABASE_SECRET_KEY?.trim();

// Always write locally; add Postgres when configured. If Supabase is down, the
// week's snapshot still survives on disk and can be backfilled.
const stores = [new JsonlSnapshotStore('data/snapshots')];
if (supabaseUrl !== undefined && supabaseUrl !== '' && supabaseSecret !== undefined && supabaseSecret !== '') {
  stores.push(new PostgrestSnapshotStore(supabaseUrl, supabaseSecret));
} else {
  console.log('warning: Supabase not configured, writing local files only');
}
const store = new TeeSnapshotStore(stores);
const state = await new SleeperClient().getNflState();
const season = Number(state.season);

// Preseason reports its own week numbering; snapshot Week 1 until games count.
const week = Number(process.argv[2] ?? (state.season_type === 'regular' ? state.week : 1));

console.log(`snapshot: ${season} week ${week} (nfl state: ${state.season_type} wk ${state.week})`);
console.log(`scoring key: ${scoringKey(SCORING)}`);

const projections = await fetchSleeperProjections(season, week, SCORING);
const wrote = await store.writeProjections(projections);
console.log(`projections: ${wrote} rows from sleeper`);

if (projections.length > 0) {
  const top = [...projections].sort((a, b) => b.points - a.points).slice(0, 5);
  console.log(`  top: ${top.map((p) => `${p.playerId}=${p.points}`).join(', ')}`);
}

/*
 * Our own projections, into the same table, before the same kickoff.
 *
 * This job has recorded Sleeper's consensus faithfully since before Week 1 and
 * never once recorded us, which is why the head-to-head the product's central
 * claim depends on could not be computed. It was not a hard problem; half the
 * data was simply missing.
 *
 * Captured from the artifact rather than recomputed, so the row says what the
 * app served that week — a benchmark against a number nobody was shown is a
 * benchmark of the wrong thing.
 */
const artifactPath = join(
  process.cwd(),
  'model',
  'artifacts',
  `projections-${season}-${String(week).padStart(2, '0')}.json`,
);

try {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as ArtifactLike;
  const ours = modelSnapshots(artifact, SCORING);
  const wroteOurs = await store.writeProjections(ours);
  console.log(`projections: ${wroteOurs} rows from ffe (${artifact.modelVersion}, built ${artifact.generatedAt.slice(0, 16)})`);
} catch (error) {
  /*
   * Loud, and not fatal.
   *
   * A missing artifact means this week's capture records the consensus and not
   * us, which leaves a hole in the accuracy series that cannot be backfilled —
   * the whole point of a pre-kickoff snapshot is that it cannot be recreated
   * afterwards. But failing the job here would also lose the consensus rows we
   * did manage to capture, which is strictly worse.
   */
  console.log(
    `projections: NO FFE ROWS — ${error instanceof Error ? error.message : String(error)}`,
  );
  console.log('  this week will have no head-to-head. Rebuild the artifact and rerun before kickoff.');
}

const apiKey = process.env.ODDS_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.log('odds: skipped (ODDS_API_KEY not set)');
} else {
  const { snapshots, creditsRemaining } = await fetchOdds(apiKey, season);
  const thisWeek = snapshots.filter((s) => s.week === week);
  const wroteOdds = await store.writeOdds(thisWeek);
  console.log(`odds: ${wroteOdds} rows for week ${week} (${snapshots.length} total, ${creditsRemaining} credits left)`);

  const sample = thisWeek.find((s) => s.total !== undefined && s.homeSpread !== undefined);
  if (sample !== undefined) {
    console.log(
      `  sample: ${sample.awayTeam} @ ${sample.homeTeam} total ${sample.total} spread ${sample.homeSpread} homeWin ${sample.homeWinProb?.toFixed(3)}`,
    );
  }
}


// Market values are no longer captured here.
//
// They used to be fetched from a third party, which meant the series only
// existed if we wrote it down each day. Values are now derived from our own
// projections at serve time, and every projection this model has ever published
// is already in `player_projections` — so the value history is *recomputable*
// rather than merely recorded, and recomputable per league rather than for the
// four canned market configurations the feed offered.
