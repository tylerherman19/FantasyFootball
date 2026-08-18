import { describe, expect, it } from 'vitest';
import { asPlayerId, type League, type LeagueSnapshot, type Matchup } from '../domain/index.js';
import { simulateSeason, type TeamWeekProjection } from './season.js';

const league = (overrides: Partial<League> = {}): League => ({
  id: 'test',
  platform: 'sleeper',
  platformLeagueId: '1',
  name: 'Test',
  season: 2026,
  format: 'redraft',
  teamCount: 4,
  rosterSlots: ['QB', 'RB', 'BN'],
  scoring: {
    rec: 1, passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1,
    rushTd: 6, recYd: 0.1, recTd: 6, fumbleLost: -2, extra: {},
  },
  playoffTeams: 2,
  playoffStartWeek: 4,
  regularSeasonWeeks: 3,
  medianWins: false,
  superFlex: false,
  ...overrides,
});

/** Round-robin over 4 teams, 3 weeks. */
const schedule = (): Matchup[] => [
  { week: 1, matchupId: 'w1m1', teamIds: ['1', '2'], points: [null, null], playerPoints: {} },
  { week: 1, matchupId: 'w1m2', teamIds: ['3', '4'], points: [null, null], playerPoints: {} },
  { week: 2, matchupId: 'w2m1', teamIds: ['1', '3'], points: [null, null], playerPoints: {} },
  { week: 2, matchupId: 'w2m2', teamIds: ['2', '4'], points: [null, null], playerPoints: {} },
  { week: 3, matchupId: 'w3m1', teamIds: ['1', '4'], points: [null, null], playerPoints: {} },
  { week: 3, matchupId: 'w3m2', teamIds: ['2', '3'], points: [null, null], playerPoints: {} },
];

const snapshot = (overrides: Partial<LeagueSnapshot> = {}): LeagueSnapshot => ({
  league: league(),
  asOfWeek: 1,
  managers: ['1', '2', '3', '4'].map((id) => ({ id, displayName: `m${id}`, teamName: `t${id}`, platformUserId: id, coOwnerUserIds: [] })),
  rosters: ['1', '2', '3', '4'].map((id) => ({
    teamId: id, managerId: id, playerIds: [], starterIds: [], taxiIds: [], irIds: [],
  })),
  records: ['1', '2', '3', '4'].map((id) => ({
    teamId: id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0,
  })),
  schedule: schedule(),
  weeklyScores: [],
  transactions: [],
  draftPicks: [],
  ...overrides,
});

/** Each team gets one player whose mean encodes its strength. */
const projections = (strength: Record<string, number>, weeks = [1, 2, 3]): TeamWeekProjection[] =>
  weeks.flatMap((week) =>
    Object.entries(strength).map(([teamId, mean]) => ({
      teamId,
      week,
      lineupEfficiency: 1,
      players: [
        {
          playerId: asPlayerId(`p${teamId}`),
          mean,
          sd: 10,
          gameId: `g${teamId}`,
          gameLoading: 0.3,
        },
      ],
    })),
  );

describe('simulateSeason', () => {
  it('is deterministic for a given seed', () => {
    const input = { snapshot: snapshot(), projections: projections({ '1': 100, '2': 100, '3': 100, '4': 100 }), iterations: 500, seed: 42 };

    const first = simulateSeason(input);
    const second = simulateSeason(input);

    expect(first.teams.map((t) => t.titlePct)).toEqual(second.teams.map((t) => t.titlePct));
  });

  it('gives exactly one champion per iteration', () => {
    const result = simulateSeason({
      snapshot: snapshot(),
      projections: projections({ '1': 110, '2': 100, '3': 95, '4': 90 }),
      iterations: 1000,
      seed: 7,
    });

    const totalTitles = result.teams.reduce((sum, t) => sum + t.titlePct, 0);
    expect(totalTitles).toBeCloseTo(1, 6);
  });

  it('fills exactly the playoff field each iteration', () => {
    const result = simulateSeason({
      snapshot: snapshot(),
      projections: projections({ '1': 110, '2': 100, '3': 95, '4': 90 }),
      iterations: 1000,
      seed: 7,
    });

    // Two playoff spots across four teams: shares must sum to 2.
    const totalPlayoffs = result.teams.reduce((sum, t) => sum + t.playoffPct, 0);
    expect(totalPlayoffs).toBeCloseTo(2, 6);
  });

  it('favours the stronger team', () => {
    const result = simulateSeason({
      snapshot: snapshot(),
      projections: projections({ '1': 130, '2': 100, '3': 100, '4': 70 }),
      iterations: 2000,
      seed: 11,
    });

    const byTeam = new Map(result.teams.map((t) => [t.teamId, t]));
    expect(byTeam.get('1')!.playoffPct).toBeGreaterThan(byTeam.get('4')!.playoffPct);
    expect(byTeam.get('1')!.titlePct).toBeGreaterThan(byTeam.get('4')!.titlePct);
    expect(byTeam.get('1')!.expectedWins).toBeGreaterThan(byTeam.get('4')!.expectedWins);
  });

  it('makes equal teams equal, within sampling noise', () => {
    const result = simulateSeason({
      snapshot: snapshot(),
      projections: projections({ '1': 100, '2': 100, '3': 100, '4': 100 }),
      iterations: 4000,
      seed: 3,
    });

    for (const team of result.teams) {
      expect(team.playoffPct).toBeGreaterThan(0.4);
      expect(team.playoffPct).toBeLessThan(0.6);
    }
  });

  it('honours a forced result, which is how leverage is measured', () => {
    const base = { snapshot: snapshot(), projections: projections({ '1': 100, '2': 100, '3': 100, '4': 100 }), iterations: 2000, seed: 5 };

    const ifWin = simulateSeason({ ...base, forcedResults: new Map([['w1m1', '1']]) });
    const ifLose = simulateSeason({ ...base, forcedResults: new Map([['w1m1', '2']]) });

    const winPct = ifWin.teams.find((t) => t.teamId === '1')!.playoffPct;
    const losePct = ifLose.teams.find((t) => t.teamId === '1')!.playoffPct;

    expect(winPct).toBeGreaterThan(losePct);
  });

  it('eliminates one team per week in a guillotine league', () => {
    const guillotine = snapshot({
      league: league({ format: 'guillotine', playoffTeams: 1, regularSeasonWeeks: 3 }),
      schedule: [],
    });

    const result = simulateSeason({
      snapshot: guillotine,
      projections: projections({ '1': 110, '2': 100, '3': 95, '4': 90 }),
      iterations: 1000,
      seed: 9,
    });

    // Everyone is alive in week 1; survival can only fall from there.
    for (const team of result.teams) {
      expect(team.survivalByWeek[1]).toBeCloseTo(1, 6);
      expect(team.survivalByWeek[2]!).toBeLessThanOrEqual(team.survivalByWeek[1]!);
      expect(team.survivalByWeek[3]!).toBeLessThanOrEqual(team.survivalByWeek[2]!);
    }

    // Exactly one survivor.
    expect(result.teams.reduce((sum, t) => sum + t.titlePct, 0)).toBeCloseTo(1, 6);
  });

  it('awards median wins when the league uses them', () => {
    const withMedian = snapshot({ league: league({ medianWins: true }) });

    const plain = simulateSeason({
      snapshot: snapshot(),
      projections: projections({ '1': 130, '2': 100, '3': 100, '4': 70 }),
      iterations: 1000,
      seed: 21,
    });
    const median = simulateSeason({
      snapshot: withMedian,
      projections: projections({ '1': 130, '2': 100, '3': 100, '4': 70 }),
      iterations: 1000,
      seed: 21,
    });

    const plainWins = plain.teams.find((t) => t.teamId === '1')!.expectedWins;
    const medianWins = median.teams.find((t) => t.teamId === '1')!.expectedWins;

    // A strong team should roughly double its wins when beating the median also counts.
    expect(medianWins).toBeGreaterThan(plainWins * 1.5);
  });
});
