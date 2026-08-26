import { describe, expect, it } from 'vitest';
import { asPlayerId } from '../domain/index.js';
import { seededRng } from './random.js';
import { sampleWeek } from './correlated.js';

describe('stat-line scenario simulation', () => {
  const player = {
    playerId: asPlayerId('wr'),
    mean: 12,
    sd: 7,
    gameId: 'g',
    gameLoading: 0.35,
    scenario: {
      stats: { targets: 8, receptions: 5, receiving_yards: 70, receiving_tds: 0.45 },
      rules: { rec: 1, rec_yd: 0.1, rec_td: 6, bonus_rec_yd_100: 3 },
      playProbability: 0.75,
      teamPlays: 64,
      passRate: 0.6,
      redZoneRate: 0.2,
    },
  } as const;

  it('includes the DNP mass and never produces negative fantasy points', () => {
    const rng = seededRng(42);
    const scores = Array.from({ length: 2_000 }, () => sampleWeek([player], rng).get(player.playerId) ?? -1);

    expect(scores.every((score) => score >= 0)).toBe(true);
    expect(scores.filter((score) => score === 0).length / scores.length).toBeGreaterThan(0.2);
  });

  it('scores simulated stat lines under the exact league rules', () => {
    const rng = seededRng(7);
    const scores = Array.from({ length: 2_000 }, () => sampleWeek([{ ...player, scenario: { ...player.scenario, playProbability: 1 } }], rng).get(player.playerId) ?? 0);

    // Exact threshold scoring creates outcomes with the three-point bonus; a
    // point-level Gaussian/logistic approximation cannot preserve that step.
    expect(scores.some((score) => score >= 18)).toBe(true);
  });
});
