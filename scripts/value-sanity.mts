/**
 * Value sanity check — the model against the market, one-off calibration.
 *
 * The model now prices players itself (packages/core/src/valuation/edge-value.ts);
 * FantasyCalc survives only as this comparison. This script computes both for
 * one canonical league shape (12-team dynasty superflex PPR), joins them on
 * Sleeper id, and reports how the two orderings agree. It is a measurement,
 * not a target: the point is to know where the model differs from the market
 * and to catch an absurd ordering before users do, not to make rho go up.
 *
 * Runs standalone — the projections artifact is committed and the FantasyCalc
 * API is public:
 *
 *   node_modules/.bin/tsx scripts/value-sanity.mts
 */
import { readFileSync } from 'node:fs';
import { asPlayerId, scoreStatLine, type Position } from '../packages/core/src/index.js';
import { edgeValues, starterDemand, type EdgeValuePlayer } from '../packages/core/src/valuation/edge-value.js';

const TEAM_COUNT = 12;
const PPR = 1;
const REGULAR_SEASON_WEEKS = 14;
const AS_OF = new Date('2026-09-03T00:00:00Z');
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX'] as const;

const artifact = JSON.parse(readFileSync('model/artifacts/projections-2026-01.json', 'utf8'));
const crosswalk = JSON.parse(readFileSync('model/artifacts/crosswalk.json', 'utf8')).by_sleeper_id;
const ageCurves = JSON.parse(readFileSync('model/artifacts/age-curves.json', 'utf8'));

/** Same scoring shape as a typical full-PPR dynasty league on Sleeper (Sleeper rule keys). */
const RULES: Record<string, number> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1,
  rush_yd: 0.1, rush_td: 6,
  rec: PPR, rec_yd: 0.1, rec_td: 6,
  fum_lost: -2,
};

const byeWeeksAhead = (byeWeek: number | null): number => (byeWeek !== null && byeWeek >= 1 ? 1 : 0);

const players: EdgeValuePlayer[] = [];
for (const raw of Object.values(artifact.players) as any[]) {
  if (raw.active === false) continue;
  const weekly = Math.max(0, scoreStatLine(raw.stats ?? {}, RULES));
  const identity = crosswalk[raw.playerId];
  const age = identity?.birthdate
    ? (AS_OF.getTime() - new Date(identity.birthdate).getTime()) / (365.25 * 24 * 3600 * 1000)
    : undefined;
  players.push({
    playerId: asPlayerId(raw.playerId),
    position: raw.position as Position,
    weeklyPoints: weekly,
    gamesRemaining: REGULAR_SEASON_WEEKS - byeWeeksAhead(raw.byeWeek ?? null),
    ...(age !== undefined ? { age } : {}),
    ...(identity?.draft_overall ? { draftOverall: identity.draft_overall } : {}),
    basis: raw.basis,
  });
}

const values = edgeValues(players, {
  dynasty: true,
  startersByPosition: starterDemand([...SLOTS] as any, TEAM_COUNT),
  teamCount: TEAM_COUNT,
  ageCurves,
});

// The market, fetched live — the point is comparing against the real feed.
const fc = await fetch(
  `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=${TEAM_COUNT}&ppr=${PPR}`,
);
if (!fc.ok) throw new Error(`FantasyCalc returned ${fc.status}`);
const market = (await fc.json()) as { player: { sleeperId?: string; name: string; position: string }; value: number }[];

const marketBySleeper = new Map<string, number>();
for (const row of market) {
  if (row.player.sleeperId !== undefined) marketBySleeper.set(row.player.sleeperId, row.value);
}

// Join on Sleeper id; market value 0 = freely available there too, so keep zeros.
const joined: { id: string; name: string; position: string; edge: number; market: number }[] = [];
for (const raw of Object.values(artifact.players) as any[]) {
  const edge = values.get(asPlayerId(raw.playerId));
  const marketValue = marketBySleeper.get(raw.playerId);
  if (edge === undefined || marketValue === undefined) continue;
  joined.push({ id: raw.playerId, name: raw.name, position: raw.position, edge: edge.value, market: marketValue });
}

const spearman = (xs: number[], ys: number[]): number => {
  const ranks = (arr: number[]): number[] => {
    const order = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(arr.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1;
      const mean = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[order[k]![1]] = mean;
      i = j + 1;
    }
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (rx[i]! - mx) * (ry[i]! - my);
    vx += (rx[i]! - mx) ** 2;
    vy += (ry[i]! - my) ** 2;
  }
  return cov / Math.sqrt(vx * vy);
};

const rho = spearman(joined.map((j) => j.edge), joined.map((j) => j.market));
console.log(`joined: ${joined.length} players priced by both`);
console.log(`spearman rho (all): ${rho.toFixed(3)}`);

const topN = (arr: typeof joined, key: 'edge' | 'market', n: number) =>
  new Set([...arr].sort((a, b) => b[key] - a[key]).slice(0, n).map((j) => j.id));
for (const n of [25, 50, 100]) {
  const overlap = [...topN(joined, 'edge', n)].filter((id) => topN(joined, 'market', n).has(id)).length;
  console.log(`top-${n} overlap: ${overlap}/${n}`);
}

const byRank = [...joined].sort((a, b) => b.edge - a.edge);
const marketRankOf = new Map([...joined].sort((a, b) => b.market - a.market).map((j, i) => [j.id, i + 1]));
console.log('\nlargest model-vs-market disagreements inside the model top 60:');
for (const j of byRank.slice(0, 60)
  .map((j, i) => ({ ...j, edgeRank: i + 1, marketRank: marketRankOf.get(j.id)! }))
  .sort((a, b) => Math.abs(b.edgeRank - b.marketRank) - Math.abs(a.edgeRank - a.marketRank))
  .slice(0, 10)) {
  console.log(`  #${j.edgeRank} model / #${j.marketRank} market  ${j.name} (${j.position})`);
}
