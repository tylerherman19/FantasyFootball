/**
 * Phase 1 smoke test: load every Sleeper league for a user and print what the
 * domain model made of it. Run with:
 *
 *   node --experimental-strip-types scripts/smoke-sleeper.ts tylerherman 2026
 *
 * This is the "does reality match the model" check — team counts, formats and
 * records here must match what Sleeper's own UI shows.
 */
import { SleeperAdapter } from '../packages/adapters/src/index.js';

const [handle = 'tylerherman', seasonArg] = process.argv.slice(2);
const season = Number(seasonArg ?? new Date().getFullYear());

const adapter = new SleeperAdapter();

const refs = await adapter.listLeagues(handle, season);
console.log(`\n${refs.length} league(s) for ${handle} in ${season}\n`);

for (const ref of refs) {
  const snapshot = await adapter.loadSnapshot(ref.platformLeagueId);
  const { league } = snapshot;

  const playedWeeks = new Set(snapshot.weeklyScores.filter((s) => s.played).map((s) => s.week));
  const trades = snapshot.transactions.filter((t) => t.kind === 'trade').length;
  const me = snapshot.managers.find((m) => m.displayName.toLowerCase() === handle.toLowerCase());
  const myRecord = me === undefined ? undefined : snapshot.records.find((r) => r.teamId === me.id);

  console.log(`${league.name} (${league.season})`);
  console.log(`  format      ${league.format}${league.superFlex ? ' · superflex' : ''}`);
  console.log(`  teams       ${league.teamCount}`);
  console.log(`  scoring     ${league.scoring.rec} PPR`);
  console.log(`  slots       ${league.rosterSlots.filter((s) => s !== 'BN').join(', ')}`);
  console.log(`  playoffs    ${league.playoffTeams} teams, start week ${league.playoffStartWeek}`);
  console.log(`  median wins ${league.medianWins}`);
  console.log(`  as of week  ${snapshot.asOfWeek}`);
  console.log(
    `  matchups    ${snapshot.schedule.length} scheduled${league.format === 'guillotine' ? ' (none — scores vs. field)' : ''}`,
  );
  console.log(`  weeks       ${playedWeeks.size} played of ${league.regularSeasonWeeks}`);
  console.log(`  scores      ${snapshot.weeklyScores.length} team-weeks`);
  console.log(`  trades      ${trades}`);
  console.log(`  picks moved ${snapshot.draftPicks.length}`);
  if (myRecord !== undefined) {
    console.log(`  your record ${myRecord.wins}-${myRecord.losses} (${myRecord.pointsFor.toFixed(1)} PF)`);
  }
  console.log('');
}
