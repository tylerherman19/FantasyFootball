import { describe, expect, it } from 'vitest';
import { buildPool, type ArtifactPlayer, type ProjectionArtifact } from './projections';

/**
 * The bug these cover, stated once.
 *
 * Availability used to be a single boolean baked into the artifact, meaning
 * "this player's team had a game in the one week we exported". The pool reuses
 * that week's projection for every remaining week, so the flag was reused too —
 * and it is a fact about one week being applied to fourteen. Both directions
 * failed: a player on bye in the exported week was written off for the season,
 * and everyone else was simulated as playing every week including their own bye.
 */

const player = (over: Partial<ArtifactPlayer> & { playerId: string }): ArtifactPlayer => ({
  name: over.playerId,
  position: 'RB',
  team: 'ARI',
  stats: { rushing_yards: 80, rushing_tds: 0.5 },
  sd: 6,
  gameId: 'g1',
  gameLoading: 0.3,
  byeWeek: null,
  active: true,
  basis: 'history',
  ...over,
});

const artifactOf = (...players: ArtifactPlayer[]): ProjectionArtifact => ({
  modelVersion: 'test',
  season: 2026,
  week: 1,
  generatedAt: '2026-08-21T00:00:00Z',
  playerCount: players.length,
  players: Object.fromEntries(players.map((p) => [p.playerId, p])),
});

const RULES = { rush_yd: 0.1, rush_td: 6 };
const QB_RULES = { pass_yd: 0.04, pass_td: 4 };

describe('buildPool bye handling', () => {
  it('zeroes a player only in his own bye week', () => {
    const pool = buildPool(artifactOf(player({ playerId: 'a', byeWeek: 8 })), [6, 7, 8, 9], RULES);

    const meanAt = (week: number) => pool.get(week)?.get('a' as never)?.mean ?? -1;

    expect(meanAt(8)).toBe(0);
    expect(meanAt(6)).toBeGreaterThan(0);
    expect(meanAt(7)).toBeGreaterThan(0);
    expect(meanAt(9)).toBeGreaterThan(0);
  });

  it('marks him inactive in the bye week and active otherwise', () => {
    const pool = buildPool(artifactOf(player({ playerId: 'a', byeWeek: 8 })), [7, 8, 9], RULES);

    expect(pool.get(8)?.get('a' as never)?.active).toBe(false);
    expect(pool.get(7)?.get('a' as never)?.active).toBe(true);
    expect(pool.get(9)?.get('a' as never)?.active).toBe(true);
  });

  it('does not let one player\'s bye zero anyone else', () => {
    const pool = buildPool(
      artifactOf(player({ playerId: 'a', byeWeek: 8 }), player({ playerId: 'b', byeWeek: 11 })),
      [8, 11],
      RULES,
    );

    expect(pool.get(8)?.get('b' as never)?.mean).toBeGreaterThan(0);
    expect(pool.get(11)?.get('a' as never)?.mean).toBeGreaterThan(0);
  });

  it('keeps a player on bye out of his team\'s correlated game', () => {
    const pool = buildPool(artifactOf(player({ playerId: 'a', byeWeek: 8 })), [7, 8], RULES);

    expect(pool.get(7)?.get('a' as never)?.gameId).toBe('week-7-ARI');
    expect(pool.get(8)?.get('a' as never)?.gameId).toBe('bye-a');
  });

  it('treats a null bye as "no bye known", never as week zero', () => {
    const pool = buildPool(artifactOf(player({ playerId: 'a', byeWeek: null })), [0, 1, 2], RULES);

    for (const week of [0, 1, 2]) {
      expect(pool.get(week)?.get('a' as never)?.mean).toBeGreaterThan(0);
    }
  });

  it('applies injury status to the current week only', () => {
    const pool = buildPool(artifactOf(player({ playerId: 'a' })), [5, 6], RULES, {
      a: { injuryStatus: 'Out' },
    });

    expect(pool.get(5)?.get('a' as never)?.mean).toBe(0);
    expect(pool.get(6)?.get('a' as never)?.mean).toBeGreaterThan(0);
  });

  it('covers every requested week', () => {
    const weeks = [4, 5, 6, 7, 8];
    const pool = buildPool(artifactOf(player({ playerId: 'a', byeWeek: 6 })), weeks, RULES);

    expect([...pool.keys()]).toEqual(weeks);
  });

  it('uses the actual NFL game identity for every future week', () => {
    const artifact: ProjectionArtifact = {
      ...artifactOf(
        player({ playerId: 'a', team: 'ARI', gameId: 'week-1-game' }),
        player({ playerId: 'b', team: 'SEA', gameId: 'week-1-game' }),
      ),
      teamGameIdsByWeek: {
        '1': { ARI: 'week-1-game', SEA: 'week-1-game' },
        '2': { ARI: 'week-2-game', LAR: 'week-2-game', SEA: 'other-week-2-game' },
      },
    };

    const pool = buildPool(artifact, [1, 2], RULES);

    expect(pool.get(1)?.get('a' as never)?.gameId).toBe('week-1-game');
    expect(pool.get(2)?.get('a' as never)?.gameId).toBe('week-2-game');
    expect(pool.get(2)?.get('b' as never)?.gameId).toBe('other-week-2-game');
  });
});

describe('backup quarterback role handling', () => {
  const qb1 = player({
    playerId: 'qb1',
    position: 'QB',
    stats: { passing_yards: 250, passing_tds: 2 },
    depthRank: 1,
  });
  const qb2 = player({
    playerId: 'qb2',
    position: 'QB',
    active: false,
    stats: { passing_yards: 0, passing_tds: 0 },
    sd: 0,
    depthRank: 2,
    contingencyStats: { passing_yards: 230, passing_tds: 1.5 },
    contingencySd: 8,
  });

  it('does not count QB2 while QB1 is healthy', () => {
    const pool = buildPool(artifactOf(qb1, qb2), [1], QB_RULES);

    expect(pool.get(1)?.get('qb1' as never)?.mean).toBeGreaterThan(0);
    expect(pool.get(1)?.get('qb2' as never)?.mean).toBe(0);
    expect(pool.get(1)?.get('qb2' as never)?.active).toBe(false);
  });

  it('activates exactly one contingency QB when QB1 is ruled out', () => {
    const pool = buildPool(artifactOf(qb1, qb2), [1, 2], QB_RULES, {
      qb1: { injuryStatus: 'Out' },
    });

    expect(pool.get(1)?.get('qb1' as never)?.mean).toBe(0);
    expect(pool.get(1)?.get('qb2' as never)?.mean).toBeGreaterThan(0);
    // The injury is a current-week fact; the future baseline does not carry it.
    expect(pool.get(2)?.get('qb1' as never)?.mean).toBeGreaterThan(0);
    expect(pool.get(2)?.get('qb2' as never)?.mean).toBe(0);
  });

  it('splits expected QB volume when QB1 is questionable', () => {
    const pool = buildPool(artifactOf(qb1, qb2), [1], QB_RULES, {
      qb1: { injuryStatus: 'Questionable' },
    });

    const starter = pool.get(1)?.get('qb1' as never)?.mean ?? 0;
    const backup = pool.get(1)?.get('qb2' as never)?.mean ?? 0;

    expect(starter).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(0);
    expect(backup).toBeLessThan(starter);
  });
});

/**
 * The same bug, on the other side of the wire.
 *
 * `buildPool` fixes byes on the server. The browser what-if sim builds its own
 * weekly pool from serialized players, so it needs the bye carried across —
 * otherwise it plays everyone every week including their own bye, which is the
 * server bug arriving from the opposite direction.
 */
describe('bye information survives serialization', () => {
  it('carries byeWeek onto the wire shape the client sim reads', async () => {
    const { buildPool: build } = await import('./projections');

    const pool = build(artifactOf(player({ playerId: 'a', byeWeek: 9 })), [9], RULES);
    const projection = pool.get(9)?.get('a' as never);

    // The server pool has already applied it...
    expect(projection?.active).toBe(false);
    // ...and the artifact still states it, which is what gets serialized.
    expect(artifactOf(player({ playerId: 'a', byeWeek: 9 })).players.a?.byeWeek).toBe(9);
  });
});
