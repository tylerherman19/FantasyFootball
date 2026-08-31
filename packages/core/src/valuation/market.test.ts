import { describe, expect, it } from 'vitest';
import { replacementLevels, valueAssets, type ValuationInput, type ValuationSettings } from './market.js';
import type { LineupSlot, Position } from '../domain/index.js';

/** A position's worth of players, descending from `top` in even steps. */
const bench = (position: Position, count: number, top: number, step: number): ValuationInput[] =>
  Array.from({ length: count }, (_, i) => ({
    playerId: `${position}${i}`,
    name: `${position} ${i}`,
    position,
    pointsPerGame: Math.max(0, top - i * step),
  }));

const pool = (): ValuationInput[] => [
  ...bench('QB', 40, 22, 0.4),
  ...bench('RB', 80, 18, 0.25),
  ...bench('WR', 100, 17, 0.2),
  ...bench('TE', 40, 12, 0.35),
];

const settings = (overrides: Partial<ValuationSettings> = {}): ValuationSettings => ({
  teamCount: 12,
  rosterSlots: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'] as LineupSlot[],
  gamesRemaining: 14,
  multiYear: false,
  ...overrides,
});

describe('replacement level', () => {
  it('counts dedicated slots against the team count', () => {
    const levels = replacementLevels(pool(), settings());
    expect(levels.get('QB')?.startersLeagueWide).toBe(12);
    expect(levels.get('TE')!.startersLeagueWide).toBeGreaterThanOrEqual(12);
  });

  it('allocates flex demand to whichever position is actually deepest there', () => {
    const levels = replacementLevels(pool(), settings());
    // 24 RB and 24 WR start in dedicated slots; the twelve flexes go to
    // whichever of RB/WR/TE has the better 25th man, not to a convention.
    const flexed =
      levels.get('RB')!.startersLeagueWide +
      levels.get('WR')!.startersLeagueWide +
      levels.get('TE')!.startersLeagueWide;
    expect(flexed).toBe(24 + 24 + 12 + 12);
  });

  it('raises quarterback demand in superflex without being told about superflex', () => {
    const single = replacementLevels(pool(), settings());
    const superFlex = replacementLevels(
      pool(),
      settings({
        rosterSlots: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'BN'] as LineupSlot[],
      }),
    );

    expect(superFlex.get('QB')!.startersLeagueWide).toBeGreaterThan(
      single.get('QB')!.startersLeagueWide,
    );
    // More quarterbacks starting means a worse one is replacement level.
    expect(superFlex.get('QB')!.pointsPerGame).toBeLessThan(single.get('QB')!.pointsPerGame);
  });

  it('scales demand with the number of teams', () => {
    const small = replacementLevels(pool(), settings({ teamCount: 8 }));
    const large = replacementLevels(pool(), settings({ teamCount: 14 }));
    expect(large.get('RB')!.pointsPerGame).toBeLessThan(small.get('RB')!.pointsPerGame);
  });
});

describe('asset value', () => {
  it('publishes a 0-10,000 index anchored on the best asset', () => {
    const valued = valueAssets(pool(), settings());
    expect(valued[0]!.value).toBe(10_000);
    expect(valued.at(-1)!.value).toBe(0);
    expect(valued[0]!.overallRank).toBe(1);
  });

  it('prices a replacement-level player at nothing', () => {
    const valued = valueAssets(pool(), settings());
    const level = replacementLevels(pool(), settings()).get('RB')!.pointsPerGame;
    const marginal = valued.find(
      (asset) => asset.position === 'RB' && asset.pointsAboveReplacement <= 0,
    );
    expect(marginal!.value).toBe(0);
    expect(level).toBeGreaterThan(0);
  });

  it('reprices quarterbacks upward in superflex', () => {
    const single = valueAssets(pool(), settings());
    const superFlex = valueAssets(
      pool(),
      settings({
        rosterSlots: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'BN'] as LineupSlot[],
      }),
    );

    const topQbRank = (list: typeof single): number =>
      list.find((asset) => asset.position === 'QB')!.overallRank;

    expect(topQbRank(superFlex)).toBeLessThanOrEqual(topQbRank(single));
  });

  it('adds future seasons only in a multi-year league', () => {
    const players = pool().map((player) => ({ ...player, futureSeasons: [0.95, 0.9, 0.85] }));

    const redraft = valueAssets(players, settings());
    const dynasty = valueAssets(players, settings({ multiYear: true }));

    expect(redraft[0]!.futureShare).toBe(0);
    expect(dynasty[0]!.futureShare).toBeGreaterThan(0.5);
  });

  it('separates two equal producers by age once the horizon is multi-year', () => {
    const base = pool();
    const young = { ...base[0]!, playerId: 'young', name: 'Young', futureSeasons: [1, 1, 1, 1] };
    const old = { ...base[0]!, playerId: 'old', name: 'Old', futureSeasons: [0.6, 0.35, 0.2, 0.1] };

    const valued = valueAssets([...base, young, old], settings({ multiYear: true }));
    const valueOf = (id: string): number => valued.find((a) => a.playerId === id)!.value;

    expect(valueOf('young')).toBeGreaterThan(valueOf('old'));
  });
});
