import { describe, expect, it } from 'vitest';
import {
  asPlayerId,
  type League,
  type LeagueSnapshot,
  type LineupSlot,
  type Matchup,
  type PlayerId,
  type Position,
  type WeeklyScore,
} from '../domain/index.js';
import type { PlayerProjection, TeamContext } from '../sim/roster-projection.js';
import type { SimContext } from '../decisions/odds.js';
import { scheduleLuck } from './schedule-luck.js';
import { replacementLevels, teamScarcity, type ScarcityPlayer } from './scarcity.js';
import { fragility } from './fragility.js';
import { powerRankings } from '../valuation/power-rankings.js';
import { pickEquity } from '../valuation/pick-equity.js';
import type { TeamOutcome } from '../sim/season.js';

const TEAM_IDS = ['1', '2', '3', '4'];

const league = (overrides: Partial<League> = {}): League => ({
  id: 'test',
  platform: 'sleeper',
  platformLeagueId: '1',
  name: 'Test',
  season: 2026,
  format: 'redraft',
  teamCount: 4,
  rosterSlots: ['QB', 'RB', 'WR', 'BN', 'BN'],
  scoring: {
    rec: 1, passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1,
    rushTd: 6, recYd: 0.1, recTd: 6, fumbleLost: -2, extra: {}, raw: {},
  },
  playoffTeams: 2,
  playoffStartWeek: 4,
  regularSeasonWeeks: 3,
  medianWins: false,
  superFlex: false,
  waiverBudget: 100,
  ...overrides,
});

/**
 * Two weeks of a four-team league, arranged so the answer is checkable by hand.
 *
 * Team 1 scores the most both weeks but is scheduled against the second-highest
 * scorer each time; team 4 scores the least and draws the other low scorer. This
 * is the classic "great team, bad luck" shape.
 */
const scoreTable: Record<number, Record<string, number>> = {
  1: { '1': 120, '2': 110, '3': 90, '4': 80 },
  2: { '1': 130, '2': 115, '3': 95, '4': 85 },
};

const schedule = (): Matchup[] => [
  { week: 1, matchupId: 'w1m1', teamIds: ['1', '2'], points: [120, 110], playerPoints: {} },
  { week: 1, matchupId: 'w1m2', teamIds: ['3', '4'], points: [90, 80], playerPoints: {} },
  { week: 2, matchupId: 'w2m1', teamIds: ['1', '2'], points: [130, 115], playerPoints: {} },
  { week: 2, matchupId: 'w2m2', teamIds: ['3', '4'], points: [95, 85], playerPoints: {} },
];

const weeklyScores = (): WeeklyScore[] =>
  [1, 2].flatMap((week) =>
    TEAM_IDS.map((teamId) => ({
      week,
      teamId,
      points: scoreTable[week]![teamId]!,
      playerPoints: {},
      played: true,
    })),
  );

const snapshot = (overrides: Partial<LeagueSnapshot> = {}): LeagueSnapshot => ({
  league: league(),
  asOfWeek: 3,
  managers: TEAM_IDS.map((id) => ({
    id, displayName: `m${id}`, teamName: `t${id}`, platformUserId: id, coOwnerUserIds: [],
  })),
  rosters: TEAM_IDS.map((id) => ({
    teamId: id, managerId: id, playerIds: [], starterIds: [], taxiIds: [], irIds: [],
  })),
  // Team 1 and 3 won both their games; 2 and 4 lost both.
  records: [
    { teamId: '1', wins: 2, losses: 0, ties: 0, pointsFor: 250, pointsAgainst: 225 },
    { teamId: '2', wins: 0, losses: 2, ties: 0, pointsFor: 225, pointsAgainst: 250 },
    { teamId: '3', wins: 2, losses: 0, ties: 0, pointsFor: 185, pointsAgainst: 165 },
    { teamId: '4', wins: 0, losses: 2, ties: 0, pointsFor: 165, pointsAgainst: 185 },
  ],
  schedule: schedule(),
  weeklyScores: weeklyScores(),
  transactions: [],
  draftPicks: [],
  ...overrides,
});

describe('scheduleLuck', () => {
  it('gives the top scorer a full all-play record', () => {
    const luck = scheduleLuck(snapshot()).get('1')!;

    // Beat all three others in both weeks: 6 of 6 all-play wins over 2 games.
    expect(luck.expectedWins).toBeCloseTo(2, 6);
    expect(luck.actualWins).toBe(2);
    expect(luck.luck).toBeCloseTo(0, 6);
  });

  it('flags a team whose record is better than its scoring', () => {
    // Team 3 is 2-0 but only outscored one of the three other teams each week.
    const luck = scheduleLuck(snapshot()).get('3')!;

    expect(luck.actualWins).toBe(2);
    expect(luck.expectedWins).toBeCloseTo(2 * (1 / 3), 6);
    expect(luck.luck).toBeGreaterThan(1);
  });

  it('flags a team whose scoring is better than its record', () => {
    // Team 2 is 0-2 despite outscoring two of three teams every week.
    const luck = scheduleLuck(snapshot()).get('2')!;

    expect(luck.actualWins).toBe(0);
    expect(luck.expectedWins).toBeCloseTo(2 * (2 / 3), 6);
    expect(luck.luck).toBeLessThan(-1);
  });

  it('replays a team through every other schedule', () => {
    const luck = scheduleLuck(snapshot()).get('2')!;

    // Under team 3's schedule, team 2 would have faced team 4 twice and won
    // both; under its own it faced team 1 twice and lost both.
    expect(luck.winsBySchedule.get('3')).toBe(2);
    expect(luck.winsBySchedule.get('2')).toBe(0);
    expect(luck.bestScheduleWins).toBe(2);
    expect(luck.worstScheduleWins).toBe(0);
  });

  it('ignores the week currently in progress', () => {
    // Sleeper flips `played` as soon as one player scores, so the current week
    // arrives partially filled. Counting it would compare a half-played week of
    // all-play results against standings that have not banked the matchup, and
    // every team would read as unlucky from Thursday night onward.
    const inProgress = snapshot({ asOfWeek: 2 });
    const luck = scheduleLuck(inProgress).get('1')!;

    expect(luck.weeksPlayed).toBe(1);
    expect(luck.expectedWins).toBeCloseTo(1, 6);
  });

  it('ignores weeks that have not been played', () => {
    const unplayed = weeklyScores().map((score) => ({ ...score, played: score.week === 1 }));
    const luck = scheduleLuck(snapshot({ weeklyScores: unplayed })).get('1')!;

    expect(luck.weeksPlayed).toBe(1);
    expect(luck.expectedWins).toBeCloseTo(1, 6);
  });

  it('adds median wins identically to every schedule', () => {
    const withMedian = snapshot({ league: league({ medianWins: true }) });
    const luck = scheduleLuck(withMedian).get('1')!;

    // Top scorer beats the median both weeks: two head-to-head wins under its
    // own schedule plus two median wins.
    expect(luck.winsBySchedule.get('1')).toBe(4);
    expect(luck.expectedWins).toBeCloseTo(4, 6);
  });
});

describe('replacementLevels', () => {
  const player = (id: string, position: Position, points: number): ScarcityPlayer => ({
    playerId: asPlayerId(id),
    position,
    eligiblePositions: [position],
    points,
  });

  /** Twelve running backs at 30 down to 8, in steps of two. */
  const backs = Array.from({ length: 12 }, (_, i) => player(`rb${i}`, 'RB', 30 - i * 2));
  const receivers = Array.from({ length: 12 }, (_, i) => player(`wr${i}`, 'WR', 25 - i));

  it('puts replacement level at the first player past league-wide demand', () => {
    // 4 teams x 1 RB slot = 4 starters, so the replacement is the 5th back.
    const levels = replacementLevels(backs, ['RB', 'BN'], 4);

    expect(levels.get('RB')!.startersLeagueWide).toBe(4);
    expect(levels.get('RB')!.points).toBe(30 - 4 * 2);
    expect(levels.get('RB')!.extrapolated).toBe(false);
  });

  it('moves replacement level deeper as the league gets bigger', () => {
    const small = replacementLevels(backs, ['RB', 'BN'], 4).get('RB')!;
    const large = replacementLevels(backs, ['RB', 'BN'], 5).get('RB')!;

    expect(large.points).toBeLessThan(small.points);
  });

  it('sends flex demand to whichever position is deeper', () => {
    // Backs start at 30 and fall by 2; receivers start at 25 and fall by 1. Past
    // the dedicated starters the receivers are the better flex play, so flex
    // demand should land mostly on WR.
    const levels = replacementLevels([...backs, ...receivers], ['RB', 'WR', 'FLEX', 'BN'], 4);

    expect(levels.get('WR')!.startersLeagueWide).toBeGreaterThan(4);
    expect(
      levels.get('WR')!.startersLeagueWide + levels.get('RB')!.startersLeagueWide,
    ).toBe(12);
  });

  it('marks the level extrapolated when the pool runs dry', () => {
    const levels = replacementLevels(backs.slice(0, 3), ['RB', 'BN'], 4);

    expect(levels.get('RB')!.extrapolated).toBe(true);
  });
});

describe('teamScarcity', () => {
  const player = (id: string, position: Position, points: number): ScarcityPlayer => ({
    playerId: asPlayerId(id),
    position,
    eligiblePositions: [position],
    points,
  });

  const levels = new Map([
    ['RB' as Position, { position: 'RB' as Position, points: 10, startersLeagueWide: 4, extrapolated: false }],
    ['WR' as Position, { position: 'WR' as Position, points: 8, startersLeagueWide: 4, extrapolated: false }],
  ]);

  it('counts only the players who would actually start', () => {
    const roster = [
      player('rb-a', 'RB', 20),
      player('rb-b', 'RB', 19), // no second RB slot, and no flex — bench.
      player('wr-a', 'WR', 18),
    ];

    const scarcity = teamScarcity('1', roster, levels, ['RB', 'WR', 'BN']);

    expect(scarcity.byPosition.get('RB')).toBe(10); // 20 - 10
    expect(scarcity.byPosition.get('WR')).toBe(10); // 18 - 8
    expect(scarcity.total).toBe(20);
  });

  it('credits a flex starter against his own position', () => {
    const roster = [
      player('rb-a', 'RB', 20),
      player('rb-b', 'RB', 19),
      player('wr-a', 'WR', 18),
    ];

    const scarcity = teamScarcity('1', roster, levels, ['RB', 'WR', 'FLEX', 'BN']);

    // The second back now starts in the flex: (20-10) + (19-10) = 19 at RB.
    expect(scarcity.byPosition.get('RB')).toBe(19);
    expect(scarcity.total).toBe(29);
  });

  it('does not count a multi-position player twice', () => {
    const swiss: ScarcityPlayer = {
      playerId: asPlayerId('flexy'),
      position: 'RB',
      eligiblePositions: ['RB', 'WR'],
      points: 20,
    };

    const scarcity = teamScarcity('1', [swiss], levels, ['RB', 'WR', 'BN']);

    // He fills one slot, not both, so the total is a single player's surplus.
    expect(scarcity.total).toBe(10);
  });
});

describe('powerRankings', () => {
  const team = (teamId: string, marketValue: number, titlePct: number) => ({
    teamId,
    marketValue,
    titlePct,
    expectedWins: titlePct * 20,
    playoffPct: titlePct * 2,
  });

  it('ranks each dimension separately', () => {
    const rankings = powerRankings([
      team('rich-and-losing', 1000, 0.05),
      team('poor-and-winning', 400, 0.40),
      team('middle', 700, 0.25),
      team('bottom', 300, 0.10),
    ]);

    const rich = rankings.find((r) => r.teamId === 'rich-and-losing')!;
    const poor = rankings.find((r) => r.teamId === 'poor-and-winning')!;

    expect(rich.valueRank).toBe(1);
    expect(rich.titleRank).toBe(4);
    expect(poor.valueRank).toBe(3);
    expect(poor.titleRank).toBe(1);
  });

  it('calls out value that is not turning into odds', () => {
    const rankings = powerRankings([
      team('rich-and-losing', 1000, 0.05),
      team('poor-and-winning', 400, 0.40),
      team('middle', 700, 0.25),
      team('bottom', 300, 0.10),
    ]);

    expect(rankings.find((r) => r.teamId === 'rich-and-losing')!.signal).toBe('stranded');
    expect(rankings.find((r) => r.teamId === 'poor-and-winning')!.signal).toBe('overachieving');
  });

  it('reports aligned teams as aligned', () => {
    const rankings = powerRankings([
      team('a', 1000, 0.40),
      team('b', 700, 0.30),
      team('c', 400, 0.20),
      team('d', 300, 0.10),
    ]);

    expect(rankings.every((r) => r.signal === 'aligned')).toBe(true);
  });

  it('lets tied teams share a rank', () => {
    const rankings = powerRankings([team('a', 500, 0.25), team('b', 500, 0.25)]);

    expect(rankings[0]!.valueRank).toBe(1);
    expect(rankings[1]!.valueRank).toBe(1);
  });

  it('reports no divergence when the market priced nothing', () => {
    // Before a draft every roster is empty and worth zero. All teams then tie at
    // rank one, and a naive divergence would label the whole league as wasting
    // talent it does not have.
    const rankings = powerRankings([
      team('a', 0, 0.30),
      team('b', 0, 0.25),
      team('c', 0, 0.20),
      team('d', 0, 0.15),
    ]);

    expect(rankings.every((r) => r.divergence === 0)).toBe(true);
    expect(rankings.every((r) => r.signal === 'aligned')).toBe(true);
  });
});

describe('pickEquity', () => {
  const outcome = (rankDistribution: number[]): TeamOutcome => ({
    teamId: '1',
    expectedWins: 0,
    playoffPct: 0,
    titlePct: 0,
    byePct: 0,
    rankDistribution,
    survivalByWeek: [],
  });

  it('turns a last-place finish into the first pick', () => {
    const equity = pickEquity({
      outcome: outcome([0, 0, 0, 1]), // certain to finish 4th of 4
      season: 2027,
      round: 1,
      teamCount: 4,
    });

    expect(equity.expectedSlot).toBeCloseTo(1, 6);
    expect(equity.expectedOverallPick).toBeCloseTo(1, 6);
  });

  it('turns a first-place finish into the last pick of the round', () => {
    const equity = pickEquity({
      outcome: outcome([1, 0, 0, 0]),
      season: 2027,
      round: 2,
      teamCount: 4,
    });

    expect(equity.expectedSlot).toBeCloseTo(4, 6);
    // Round 2 starts after four picks.
    expect(equity.expectedOverallPick).toBeCloseTo(8, 6);
  });

  it('reports a range rather than a single slot when the finish is uncertain', () => {
    const equity = pickEquity({
      outcome: outcome([0.25, 0.25, 0.25, 0.25]),
      season: 2027,
      round: 1,
      teamCount: 4,
    });

    expect(equity.expectedSlot).toBeCloseTo(2.5, 6);
    expect(equity.slotRange[0]).toBeLessThan(equity.slotRange[1]);
  });

  it('values the distribution rather than the average slot', () => {
    // A convex curve: the 1.01 is worth far more than two mid picks.
    const valueOfPick = (pick: number): number => 1000 / pick;

    const coinFlip = pickEquity({
      outcome: outcome([0.5, 0, 0, 0.5]), // either first or last
      season: 2027,
      round: 1,
      teamCount: 4,
      valueOfPick,
    });

    // Valuing the mean slot (2.5) would give 400; the distribution is worth more.
    expect(coinFlip.value!).toBeGreaterThan(400);
    expect(coinFlip.value!).toBeCloseTo(0.5 * 1000 + 0.5 * 250, 6);
  });

  it('honours a best-picks-first draft order', () => {
    const equity = pickEquity({
      outcome: outcome([1, 0, 0, 0]),
      season: 2027,
      round: 1,
      teamCount: 4,
      worstPicksFirst: false,
    });

    expect(equity.expectedSlot).toBeCloseTo(1, 6);
  });

  it('renormalizes when the simulation did not fill every rank', () => {
    const equity = pickEquity({
      outcome: outcome([0.5, 0.25, 0, 0]),
      season: 2027,
      round: 1,
      teamCount: 4,
    });

    expect(equity.slotDistribution.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 6);
  });
});

describe('fragility', () => {
  const projection = (id: string, position: Position, mean: number): PlayerProjection => ({
    playerId: asPlayerId(id),
    position,
    eligiblePositions: [position],
    mean,
    sd: mean * 0.35,
    gameId: `game-${id}`,
    gameLoading: 0.3,
    active: true,
  });

  /**
   * Team 1 is a star and two spares; everyone else is evenly balanced. The star
   * should carry a large share of team 1's title odds.
   */
  const buildContext = (): SimContext => {
    const rosterSlots: LineupSlot[] = ['QB', 'RB', 'WR', 'BN'];
    const players: PlayerProjection[] = [];

    for (const teamId of TEAM_IDS) {
      const isTopHeavy = teamId === '1';
      players.push(projection(`qb${teamId}`, 'QB', isTopHeavy ? 34 : 20));
      players.push(projection(`rb${teamId}`, 'RB', isTopHeavy ? 8 : 18));
      players.push(projection(`wr${teamId}`, 'WR', isTopHeavy ? 8 : 18));
    }

    const weekly = new Map<PlayerId, PlayerProjection>(players.map((p) => [p.playerId, p]));

    const teams: TeamContext[] = TEAM_IDS.map((teamId) => ({
      teamId,
      playerIds: [asPlayerId(`qb${teamId}`), asPlayerId(`rb${teamId}`), asPlayerId(`wr${teamId}`)],
      rosterSlots,
      lineupEfficiency: 1,
    }));

    return {
      snapshot: snapshot({
        asOfWeek: 1,
        league: league({ rosterSlots }),
        weeklyScores: [],
        records: TEAM_IDS.map((id) => ({
          teamId: id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0,
        })),
      }),
      teams,
      pool: new Map([1, 2, 3].map((week) => [week, weekly])),
      weeks: [1, 2, 3],
      iterations: 1500,
      seed: 99,
    };
  };

  it('ranks the player the season depends on first', () => {
    const context = buildContext();
    const result = fragility({
      context,
      teamId: '1',
      playerIds: [asPlayerId('qb1'), asPlayerId('rb1'), asPlayerId('wr1')],
    });

    expect(result.dependence[0]!.playerId).toBe(asPlayerId('qb1'));
    expect(result.dependence[0]!.titleAtRisk).toBeGreaterThan(0);
  });

  it('reports a top-heavy roster as concentrated', () => {
    const context = buildContext();
    const result = fragility({
      context,
      teamId: '1',
      playerIds: [asPlayerId('qb1'), asPlayerId('rb1'), asPlayerId('wr1')],
      topN: 1,
    });

    expect(result.concentration).toBeGreaterThan(0.5);
    expect(result.concentration).toBeLessThanOrEqual(1);
  });

  it('never reports losing a player as a gain', () => {
    const context = buildContext();
    const result = fragility({
      context,
      teamId: '2',
      playerIds: [asPlayerId('qb2'), asPlayerId('rb2'), asPlayerId('wr2')],
    });

    expect(result.dependence.every((d) => d.titleAtRisk >= 0)).toBe(true);
    expect(result.dependence.every((d) => d.playoffAtRisk >= 0)).toBe(true);
  });
});
