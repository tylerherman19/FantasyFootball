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
import { oddsDelta, type SimContext } from './odds.js';
import { fairnessGap, findTrades, evaluateTrade, noiseFloor, type TradeAsset } from './trades.js';
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

  it('proposes trades that help on at least one currency', () => {
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
     * Requiring a positive title delta on every proposal was the old contract,
     * and it is why the trade page went blank: below the simulation's noise
     * floor the sign of that delta is sampling noise, so a genuine upgrade is
     * discarded roughly half the time. A proposal now has to improve either the
     * odds or the projected starter points.
     *
     * This fixture is the case where nothing qualifies — team 1's only receiver
     * is `wr1`, so every package that sends it leaves the WR slot empty and
     * costs more starter points than the incoming back returns. The finder is
     * then required to say so with its closest few rather than render nothing.
     */
    const floor = noiseFloor(context.iterations ?? 4_000);
    const helps = (evaluation: (typeof found)[number]): boolean =>
      evaluation.odds.get('1')!.titleDelta > floor || evaluation.pointsDelta.get('1')! > 0;

    if (found.some(helps)) {
      for (const evaluation of found) expect(helps(evaluation)).toBe(true);
    } else {
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(3);
    }
  });

  it('still finds trades when no position is flagged thin or surplus', () => {
    const { context } = buildContext();

    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('wr1', 'WR', 1000), asset('rb1', 'RB', 1000)]],
      ['2', [asset('rb2', 'RB', 1050), asset('wr2', 'WR', 1050)]],
    ]);

    /*
     * The balanced roster: the depth heuristic finds nothing thin and nothing
     * spare. This used to enumerate zero candidates and report that no good
     * trades existed, which was a statement about the heuristic rather than
     * about the trade market.
     */
    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: [],
      surplus: [],
      finalists: 4,
    });

    expect(found.length).toBeGreaterThan(0);
  });

  it('ranks on starter points when the odds move is below the noise floor', () => {
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

    const floor = noiseFloor(context.iterations ?? 4_000);
    const key = (evaluation: (typeof found)[number]): [number, number] => {
      const titleDelta = evaluation.odds.get('1')!.titleDelta;
      return [
        Math.abs(titleDelta) >= floor ? titleDelta : 0,
        evaluation.pointsDelta.get('1')!,
      ];
    };

    for (let i = 1; i < found.length; i += 1) {
      const [prevTitle, prevPoints] = key(found[i - 1]!);
      const [title, points] = key(found[i]!);
      expect(prevTitle > title || (prevTitle === title && prevPoints >= points)).toBe(true);
    }
  });

  it('reports a trade as too close to call rather than hiding it', () => {
    const { context } = buildContext();

    // Two backs of near-identical value: a real trade, and one no simulation of
    // this size can separate. It must still be evaluated and returned.
    const evaluation = evaluateTrade(
      context,
      { teamId: '1', sends: [asset('rb1', 'RB', 1000)] },
      { teamId: '2', sends: [asset('rb2', 'RB', 1000)] },
    );

    expect(evaluation.pointsDelta.has('1')).toBe(true);
    expect(typeof evaluation.belowNoiseFloor).toBe('boolean');
    expect(evaluation.verdict).toBeTruthy();
  });

  it('only proposes packages that acquire a named target', () => {
    const { context } = buildContext();

    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('wr1', 'WR', 1000), asset('rb1', 'RB', 1000)]],
      ['2', [asset('rb2', 'RB', 1050), asset('wr2', 'WR', 1050)]],
    ]);

    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: [],
      surplus: [],
      targetPlayerIds: [asPlayerId('rb2')],
    });

    expect(found.length).toBeGreaterThan(0);
    for (const evaluation of found) {
      const incoming = evaluation.sideB.sends.map((a) => String(a.playerId));
      expect(incoming).toContain('rb2');
    }
  });

  it('only proposes packages that acquire a targeted position', () => {
    const { context } = buildContext();

    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('wr1', 'WR', 1000), asset('rb1', 'RB', 1000)]],
      ['2', [asset('rb2', 'RB', 1050), asset('wr2', 'WR', 1050)]],
    ]);

    const found = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: [],
      surplus: [],
      targetPositions: ['RB'],
    });

    expect(found.length).toBeGreaterThan(0);
    for (const evaluation of found) {
      for (const asset of evaluation.sideB.sends) expect(asset.position).toBe('RB');
    }
  });

  it('rebuilding prefers market value and youth over this season\u2019s points', () => {
    const { context } = buildContext();

    // An old, productive back for a young, slightly more valuable one.
    const assetsByTeam = new Map<string, TradeAsset[]>([
      ['1', [asset('rb1', 'RB', 1000)]],
      ['2', [asset('rb2', 'RB', 1100)]],
    ]);

    const ages = new Map<string, number>([
      ['rb1', 30],
      ['rb2', 22],
    ]);

    const rebuild = findTrades({
      context,
      myTeamId: '1',
      assetsByTeam,
      needs: [],
      surplus: [],
      objective: 'rebuild',
      ages,
    });

    /*
     * The point of the objective: a rebuilding team accepts a package the
     * balanced ranker might reject, because the thing being bought is the
     * younger, more valuable asset rather than this week's points.
     */
    expect(rebuild.length).toBeGreaterThan(0);
    const first = rebuild[0]!;
    expect(first.valueDelta.get('1')!).toBeGreaterThan(0);
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
});
