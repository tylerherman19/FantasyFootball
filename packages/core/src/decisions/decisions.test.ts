import { describe, expect, it } from 'vitest';
import {
  asPlayerId,
  type League,
  type LeagueSnapshot,
  type Matchup,
  type PlayerId,
  type Position,
} from '../domain/index.js';
import type { PlayerProjection, TeamContext } from '../sim/roster-projection.js';
import { predictionQuantiles } from '../projections/quantiles.js';
import { evaluatePlayer } from '../valuation/player-evaluation.js';
import { oddsDelta, type SimContext } from './odds.js';
import { fairnessGap, findTrades, evaluateTrade, type TradeAsset } from './trades.js';
import { schemeSignal } from './scheme.js';
import { rankWaivers, suggestBid } from './waivers.js';

const TEAM_IDS = ['1', '2', '3', '4'];

const league = (): League => ({
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
  waiverType: 'faab' as const,
  waiverBudget: 100,
});

const schedule = (): Matchup[] => [
  { week: 1, matchupId: 'w1m1', teamIds: ['1', '2'], points: [null, null], playerPoints: {} },
  { week: 1, matchupId: 'w1m2', teamIds: ['3', '4'], points: [null, null], playerPoints: {} },
  { week: 2, matchupId: 'w2m1', teamIds: ['1', '3'], points: [null, null], playerPoints: {} },
  { week: 2, matchupId: 'w2m2', teamIds: ['2', '4'], points: [null, null], playerPoints: {} },
  { week: 3, matchupId: 'w3m1', teamIds: ['1', '4'], points: [null, null], playerPoints: {} },
  { week: 3, matchupId: 'w3m2', teamIds: ['2', '3'], points: [null, null], playerPoints: {} },
];

const snapshot = (): LeagueSnapshot => ({
  league: league(),
  asOfWeek: 1,
  managers: TEAM_IDS.map((id) => ({ id, displayName: `m${id}`, teamName: `t${id}`, platformUserId: id, coOwnerUserIds: [] })),
  rosters: TEAM_IDS.map((id) => ({
    teamId: id, managerId: id, playerIds: [], starterIds: [], taxiIds: [], irIds: [],
  })),
  records: TEAM_IDS.map((id) => ({
    teamId: id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0,
  })),
  schedule: schedule(),
  weeklyScores: [],
  transactions: [],
  draftPicks: [],
});

const projection = (
  id: string,
  position: Position,
  mean: number,
): PlayerProjection => ({
  playerId: asPlayerId(id),
  position,
  eligiblePositions: [position],
  mean,
  sd: mean * 0.35,
  gameId: `game-${id}`,
  gameLoading: 0.3,
  active: true,
});

/** Each team has QB/RB/WR at a given strength, plus a free-agent pool. */
const buildContext = (): { context: SimContext; teams: TeamContext[] } => {
  const players: PlayerProjection[] = [];

  for (const teamId of TEAM_IDS) {
    const strength = teamId === '1' ? 16 : 18;
    players.push(projection(`qb${teamId}`, 'QB', strength + 4));
    players.push(projection(`rb${teamId}`, 'RB', strength));
    players.push(projection(`wr${teamId}`, 'WR', strength));
  }

  // Free agents: one genuinely useful, one replacement level.
  players.push(projection('fa-good', 'RB', 22));
  players.push(projection('fa-bad', 'RB', 3));

  const weekly = new Map<PlayerId, PlayerProjection>(players.map((p) => [p.playerId, p]));
  const pool = new Map([1, 2, 3].map((week) => [week, weekly]));

  const teams: TeamContext[] = TEAM_IDS.map((teamId) => ({
    teamId,
    playerIds: [asPlayerId(`qb${teamId}`), asPlayerId(`rb${teamId}`), asPlayerId(`wr${teamId}`)],
    rosterSlots: league().rosterSlots,
    lineupEfficiency: 1,
  }));

  return {
    teams,
    context: { snapshot: snapshot(), teams, pool, weeks: [1, 2, 3], iterations: 1500, seed: 99 },
  };
};

describe('oddsDelta', () => {
  it('reports a gain when a clearly better player is added', () => {
    const { context } = buildContext();

    const delta = oddsDelta(
      context,
      [{ teamId: '1', add: [asPlayerId('fa-good')], drop: [asPlayerId('rb1')] }],
      '1',
    );

    expect(delta.titleDelta).toBeGreaterThan(0);
    expect(delta.after.titlePct).toBeGreaterThan(delta.before.titlePct);
  });

  it('reports a loss when a good player is swapped for a bad one', () => {
    const { context } = buildContext();

    const delta = oddsDelta(
      context,
      [{ teamId: '1', add: [asPlayerId('fa-bad')], drop: [asPlayerId('rb1')] }],
      '1',
    );

    expect(delta.titleDelta).toBeLessThan(0);
  });

  it('shares a seed between before and after, so an inert change reads as zero', () => {
    const { context } = buildContext();

    // Adding a player who cannot crack the lineup should not move the odds at
    // all. If the two runs used different randomness, this would show noise.
    const delta = oddsDelta(context, [{ teamId: '1', add: [asPlayerId('fa-bad')] }], '1');

    expect(delta.titleDelta).toBe(0);
    expect(delta.playoffDelta).toBe(0);
  });
});

describe('waivers', () => {
  it('ranks the useful free agent above the replacement-level one', () => {
    const { context } = buildContext();

    const ranked = rankWaivers({
      context,
      teamId: '1',
      candidates: [
        { playerId: asPlayerId('fa-bad'), name: 'Replacement', position: 'RB' },
        { playerId: asPlayerId('fa-good'), name: 'Difference Maker', position: 'RB' },
      ],
      dropCandidates: [asPlayerId('rb1')],
      remainingBudget: 100,
      weeksRemaining: 3,
    });

    expect(ranked[0]?.candidate.name).toBe('Difference Maker');
    expect(ranked[0]?.delta.titleDelta).toBeGreaterThan(ranked[1]!.delta.titleDelta);
  });

  it('bids nothing on a player who does not help', () => {
    expect(suggestBid(0, 100, 0.05).bid).toBe(0);
    expect(suggestBid(-0.01, 100, 0.05).bid).toBe(0);
  });

  it('bids heavily when nothing else on the wire compares', () => {
    const { bid } = suggestBid(0.08, 100, 0.005);
    expect(bid).toBeGreaterThan(80);
  });

  it('bids modestly when similar help is expected to keep appearing', () => {
    const { bid } = suggestBid(0.02, 100, 0.2);
    expect(bid).toBeLessThan(20);
  });
});

describe('trades', () => {
  const asset = (id: string, position: Position, value: number): TradeAsset => ({
    playerId: asPlayerId(id),
    name: id,
    position,
    value,
  });

  it('measures fairness proportionally, not absolutely', () => {
    // 500 apart on small assets is lopsided; on large ones it is noise.
    expect(fairnessGap(1000, 1500)).toBeCloseTo(1 / 3, 5);
    expect(fairnessGap(9500, 10000)).toBeCloseTo(0.05, 5);
  });

  it('scores both sides of a trade', () => {
    const { context } = buildContext();

    const evaluation = evaluateTrade(
      context,
      { teamId: '1', sends: [asset('rb1', 'RB', 1000)] },
      { teamId: '2', sends: [asset('rb2', 'RB', 1100)] },
    );

    expect(evaluation.odds.has('1')).toBe(true);
    expect(evaluation.odds.has('2')).toBe(true);
    // Team 1 receives the better back, so its odds should rise.
    expect(evaluation.odds.get('1')!.titleDelta).toBeGreaterThan(0);
    expect(evaluation.valueDelta.get('1')).toBe(100);
    expect(evaluation.verdict).toBeTruthy();
  });

  it('ranks proposals rather than discarding them on a noisy sign', () => {
    const { context } = buildContext();

    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('wr1', 'WR', 1000), asset('rb1', 'RB', 1000)]],
      ['2', [asset('rb2', 'RB', 1050)]],
      ['3', [asset('rb3', 'RB', 1050)]],
    ]);

    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: ['RB'],
      surplus: ['WR'],
      finalists: 4,
    });

    /*
     * The contract is "ranked", not "all positive".
     *
     * Requiring a positive title delta on every proposal is what made the trade
     * page render empty: below the simulation's resolution that sign is
     * sampling noise, so a real upgrade was discarded about half the time. The
     * finder now returns the closest few when nothing clears the bar, and that
     * is a real answer rather than a blank page.
     */
    expect(found.length).toBeGreaterThan(0);

    for (let i = 1; i < found.length; i += 1) {
      expect(found[i - 1]!.odds.get('1')!.titleDelta).toBeGreaterThanOrEqual(
        found[i]!.odds.get('1')!.titleDelta,
      );
    }
  });

  it('rejects packages outside the fairness band before simulating them', () => {
    const { context } = buildContext();

    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('wr1', 'WR', 100)]],
      ['2', [asset('rb2', 'RB', 5000)]],
    ]);

    // A 100-for-5000 offer is technically great for me and would never be
    // accepted, so it must not be proposed.
    const found = findTrades({ context, myTeamId: '1', assetsByTeam, needs: ['RB'], surplus: ['WR'] });
    expect(found).toHaveLength(0);
  });

  it('scores partner fit from replacement value, not just market fairness', () => {
    const { context } = buildContext();
    const assetsByTeam = new Map<string, TradeAsset[]>([
      [
        '1',
        [
          { ...asset('wr1', 'WR', 1000), projectedPoints: 18 },
          { ...asset('rb1', 'RB', 1000), projectedPoints: 12 },
        ],
      ],
      ['2', [{ ...asset('rb2', 'RB', 1000), projectedPoints: 18 }]],
    ]);
    const profiles = new Map([
      [
        '1',
        {
          marginalByPlayer: new Map([
            ['wr1', 0],
            ['rb1', 12],
          ]),
          startingByPlayer: new Map([
            ['wr1', false],
            ['rb1', true],
          ]),
          exposureByPosition: new Map<Position, number>([
            ['RB', 10],
            ['WR', 2],
          ]),
        },
      ],
      [
        '2',
        {
          marginalByPlayer: new Map([['rb2', 12]]),
          startingByPlayer: new Map([['rb2', true]]),
          exposureByPosition: new Map<Position, number>([['WR', 18]]),
        },
      ],
    ]);

    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: ['RB'],
      surplus: ['WR'],
      rosterProfiles: profiles,
      finalists: 1,
    });

    expect(found).toHaveLength(1);
    expect(found[0]!.fitScore).toBeGreaterThan(0.5);
    expect(found[0]!.acceptanceScore).toBeGreaterThan(0.5);
    expect(found[0]!.rationale.length).toBe(4);
    expect(found[0]!.evidenceScore).toBeGreaterThan(0);
  });

  it('does not sell a young cornerstone for an older player in a rebuild', () => {
    const { context } = buildContext();
    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('young-wr', 'WR', 8_000)]],
      ['2', [asset('old-wr', 'WR', 8_400)]],
    ]);
    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: ['WR'],
      surplus: ['WR'],
      objective: 'rebuild',
      ages: new Map([['young-wr', 22], ['old-wr', 30]]),
    });
    expect(found).toHaveLength(0);
  });

  it('does not offer a current starter just because its marginal value is low', () => {
    const { context } = buildContext();
    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('star-wr', 'WR', 8_000)]],
      ['2', [asset('target-rb', 'RB', 8_000)]],
    ]);
    const profiles = new Map([
      ['1', {
        marginalByPlayer: new Map([['star-wr', 0]]),
        startingByPlayer: new Map([['star-wr', true]]),
        exposureByPosition: new Map<Position, number>([['RB', 10]]),
      }],
      ['2', {
        marginalByPlayer: new Map([['target-rb', 12]]),
        startingByPlayer: new Map([['target-rb', true]]),
        exposureByPosition: new Map<Position, number>([['WR', 12]]),
      }],
    ]);

    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: ['RB'],
      surplus: ['WR'],
      rosterProfiles: profiles,
    });

    expect(found).toHaveLength(0);
  });

  it('prefers the younger return when rebuilding', () => {
    const { context } = buildContext();
    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('prime-wr', 'WR', 5_000)]],
      ['2', [asset('old-wr', 'WR', 5_300)]],
      ['3', [asset('young-wr', 'WR', 4_800)]],
    ]);
    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: ['WR'],
      surplus: ['WR'],
      objective: 'rebuild',
      ages: new Map([['prime-wr', 26], ['old-wr', 31], ['young-wr', 22]]),
      finalists: 4,
    });
    expect(found[0]?.sideB.sends[0]?.playerId).toBe(asPlayerId('young-wr'));
    expect(found.some((trade) => trade.sideB.sends[0]?.playerId === asPlayerId('old-wr'))).toBe(false);
  });
});

describe('player evaluation', () => {
  it('shrinks uncertain production toward this roster\'s replacement level', () => {
    const reliable = evaluatePlayer({
      projectedPoints: 18,
      replacementPoints: 10,
      sd: 6,
      confidence: 0.9,
    });
    const fragile = evaluatePlayer({
      projectedPoints: 18,
      replacementPoints: 10,
      sd: 6,
      confidence: 0.25,
    });

    expect(reliable.evidenceAdjustedPoints).toBeGreaterThan(fragile.evidenceAdjustedPoints);
    expect(fragile.evidenceAdjustedPoints).toBeGreaterThanOrEqual(10);
    expect(fragile.uncertaintyPenalty).toBeGreaterThan(0);
  });

  it('selects p25 for win-now and p75 for rebuild decisions', () => {
    const quantiles = predictionQuantiles(18, 6);
    expect(
      evaluatePlayer({ projectedPoints: 18, sd: 6, confidence: 1, quantiles, objective: 'winNow' })
        .scenarioPoints,
    ).toBeCloseTo(quantiles.p25, 6);
    expect(
      evaluatePlayer({ projectedPoints: 18, sd: 6, confidence: 1, quantiles, objective: 'rebuild' })
        .scenarioPoints,
    ).toBeCloseTo(quantiles.p75, 6);
  });
});

describe('scheme signal', () => {
  it('treats volume and a light box as a small running-back edge', () => {
    const signal = schemeSignal({
      position: 'RB',
      carryShare: 0.65,
      offense: { team: 'R', passRate: 0.44, playsPerGame: 68 },
      defense: { team: 'D', shellIndex: 0.7, pressureIndex: 0, rushEpaAdjusted: 0.06 },
    });

    expect(signal.score).toBeGreaterThan(0);
    expect(signal.decisionWeight).toBeLessThan(0.08);
    expect(signal.reasons).toContain('light-box tendency');
  });
});
