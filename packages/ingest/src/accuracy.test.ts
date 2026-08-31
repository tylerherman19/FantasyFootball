import { describe, expect, it } from 'vitest';
import { accuracyOf, actualsFrom, commonPlayers, pairedT, type ProjectionRow } from './accuracy.js';
import { modelSnapshots, type ArtifactLike } from './model-projections.js';

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

const projection = (
  playerId: string,
  source: string,
  points: number,
  sourceVersion = '',
): ProjectionRow => ({ playerId, source, sourceVersion, points });

describe('actuals', () => {
  it('scores a stat line with the same rules the projections use', () => {
    const actuals = actualsFrom(
      [{ player_id: '1', stats: { gp: 1, rec: 6, rec_yd: 80, rec_td: 1 } }],
      SCORING,
    );
    // 6 receptions + 8.0 yards + 6 for the touchdown.
    expect(actuals.get('1')).toBeCloseTo(20, 5);
  });

  it('excludes a player who did not appear, rather than scoring him zero', () => {
    const actuals = actualsFrom(
      [
        { player_id: 'played', stats: { gp: 1, rec: 0, rec_yd: 0 } },
        { player_id: 'scratched', stats: { pass_yd: 0 } },
        { player_id: 'empty', stats: null },
      ],
      SCORING,
    );

    // Played and scored nothing is a forecast the model got wrong; a healthy
    // scratch is an availability miss and must not be charged here.
    expect(actuals.get('played')).toBe(0);
    expect(actuals.has('scratched')).toBe(false);
    expect(actuals.has('empty')).toBe(false);
  });
});

describe('head-to-head accuracy', () => {
  const actuals = new Map([
    ['a', 10],
    ['b', 20],
    ['c', 5],
  ]);

  it('measures error, spread and direction separately', () => {
    const rows = [
      projection('a', 'ffe', 12),
      projection('b', 'ffe', 22),
      projection('c', 'ffe', 7),
    ];

    const [ffe] = accuracyOf(rows, actuals);
    expect(ffe!.n).toBe(3);
    expect(ffe!.mae).toBeCloseTo(2, 5);
    expect(ffe!.rmse).toBeCloseTo(2, 5);
    // Every projection was two points high, which is bias rather than noise.
    expect(ffe!.bias).toBeCloseTo(2, 5);
  });

  it('scores sources only on the players they both covered', () => {
    const rows = [
      // Sleeper covers everyone; we cover only the easy one.
      projection('a', 'sleeper', 11),
      projection('b', 'sleeper', 24),
      projection('c', 'sleeper', 6),
      projection('a', 'ffe', 10),
    ];

    const common = commonPlayers(rows, actuals);
    expect([...common]).toEqual(['a']);

    const table = accuracyOf(rows, actuals, { restrictTo: common });
    // Broader coverage must not be punished: both are judged on player 'a'.
    expect(table.every((row) => row.n === 1)).toBe(true);
  });

  it('reports how often each source was closer, not just the average', () => {
    const rows = [
      // We are closer on two of three, and much further on the third — so the
      // mean error prefers the consensus while the win rate prefers us. Both
      // are true and the report shows both.
      projection('a', 'ffe', 10),
      projection('b', 'ffe', 20),
      projection('c', 'ffe', 25),
      projection('a', 'sleeper', 14),
      projection('b', 'sleeper', 24),
      projection('c', 'sleeper', 6),
    ];

    const table = accuracyOf(rows, actuals, { baseline: 'sleeper' });
    const ffe = table.find((row) => row.source === 'ffe')!;
    const sleeper = table.find((row) => row.source === 'sleeper')!;

    expect(ffe.winRate).toBeCloseTo(2 / 3, 5);
    expect(sleeper.winRate).toBeUndefined();
    expect(ffe.mae).toBeGreaterThan(sleeper.mae);
  });

  it('treats an identical gap on every player as decisive, not as no evidence', () => {
    const played = new Map([['a', 10], ['b', 20]]);
    const identical = [
      projection('a', 'ffe', 11),
      projection('a', 'sleeper', 13),
      projection('b', 'ffe', 21),
      projection('b', 'sleeper', 23),
    ];

    const result = pairedT(identical, played, 'ffe', 'sleeper');
    expect(result.meanDifference).toBeCloseTo(-2, 5);
    // Zero spread around a real gap is the strongest possible evidence.
    expect(result.t).toBe(-Infinity);
  });

  it('separates the sources only when the paired difference beats the noise', () => {
    const many = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const played = new Map(many.map((id, i) => [id, 10 + (i % 7)]));

    // Consistently closer on every player, with realistic per-player scatter
    // around it: a real difference the test should be able to detect.
    const wobble = (i: number): number => Math.sin(i * 2.399) * 1.5;
    const decisive = many.flatMap((id, i) => [
      projection(id, 'ffe', (played.get(id) ?? 0) + 1 + wobble(i)),
      projection(id, 'sleeper', (played.get(id) ?? 0) + 3 + wobble(i * 3)),
    ]);

    const strong = pairedT(decisive, played, 'ffe', 'sleeper');
    expect(strong.n).toBe(200);
    expect(strong.meanDifference).toBeLessThan(-1);
    expect(Math.abs(strong.t)).toBeGreaterThan(2);

    // The same sign, but a single player's worth of evidence behind it.
    const thin = [
      projection('a', 'ffe', 11),
      projection('a', 'sleeper', 13),
      projection('b', 'ffe', 25),
      projection('b', 'sleeper', 19),
    ];
    const weak = pairedT(thin, played, 'ffe', 'sleeper');
    expect(Math.abs(weak.t)).toBeLessThan(2);
  });
});

describe('capturing our own projections', () => {
  const artifact: ArtifactLike = {
    modelVersion: 'v1-usage',
    season: 2026,
    week: 5,
    generatedAt: '2026-09-29T10:00:00.000Z',
    players: {
      starter: {
        playerId: 'starter',
        stats: { receptions: 6, receiving_yards: 80, receiving_tds: 1 },
        sd: 6.2,
        p25: 8,
        p50: 14,
        p75: 22,
        active: true,
        byeWeek: 9,
      },
      onBye: {
        playerId: 'onBye',
        stats: { receptions: 5, receiving_yards: 60 },
        active: true,
        byeWeek: 5,
      },
      inactive: { playerId: 'inactive', stats: { receptions: 4 }, active: false, byeWeek: null },
      unprojected: { playerId: 'unprojected', stats: {}, active: true, byeWeek: null },
    },
  };

  it('reshapes the artifact into snapshot rows under the model version', () => {
    const rows = modelSnapshots(artifact, SCORING, '2026-09-30T12:00:00.000Z');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      season: 2026,
      week: 5,
      playerId: 'starter',
      source: 'ffe',
      sourceVersion: 'v1-usage',
      stddev: 6.2,
      capturedAt: '2026-09-30T12:00:00.000Z',
    });
  });

  it('drops byes and inactives rather than recording them as zero', () => {
    const ids = modelSnapshots(artifact, SCORING).map((row) => row.playerId);
    // A player who cannot play is not a forecast anyone got right; leaving him
    // in would hand whichever source lists more inactives free perfect calls.
    expect(ids).not.toContain('onBye');
    expect(ids).not.toContain('inactive');
    expect(ids).not.toContain('unprojected');
  });

  it('agrees with the consensus scorer on the same stat line', () => {
    const [row] = modelSnapshots(artifact, SCORING);

    // The same football, spelled two ways. `receptions`/`receiving_yards` from
    // nflverse must score identically to `rec`/`rec_yd` from Sleeper, or every
    // number in the head-to-head is measuring the feeds rather than the models.
    const sleeperSide = actualsFrom(
      [{ player_id: 'starter', stats: { gp: 1, rec: 6, rec_yd: 80, rec_td: 1 } }],
      SCORING,
    );

    expect(row!.points).toBeCloseTo(20, 5);
    expect(row!.points).toBeCloseTo(sleeperSide.get('starter')!, 5);
  });

  it('refuses to publish a capture whose stat names it does not recognise', () => {
    // The failure this guards against is silent and total: if nflverse renames
    // a field, every affected stat scores zero, the whole league is projected
    // near nothing, and the benchmark reports a catastrophic loss that is
    // entirely an accounting error. Better to have no rows for a week than
    // wrong ones that look plausible enough to believe.
    const drifted: ArtifactLike = {
      ...artifact,
      players: {
        starter: {
          playerId: 'starter',
          stats: { receiving_yardage: 80, receiving_touchdowns: 1 },
          active: true,
          byeWeek: null,
        },
      },
    };

    expect(() => modelSnapshots(drifted, SCORING)).toThrow(/stat names/i);
  });
});
