import { describe, expect, it } from 'vitest';
import { fundamentalPickValue, fundamentalPlayerValue } from './fundamental.js';

describe('dynasty fundamental value', () => {
  it('values the same production more highly when it survives a rebuild window', () => {
    const young = fundamentalPlayerValue({ position: 'WR', age: 22, weeklyPoints: 15, replacementPoints: 8 });
    const old = fundamentalPlayerValue({ position: 'WR', age: 31, weeklyPoints: 15, replacementPoints: 8 });
    expect(young.total).toBeGreaterThan(old.total);
  });

  it('prefers the fitted age curve over the asserted positional decline', () => {
    const base = { position: 'RB', age: 26, weeklyPoints: 15, replacementPoints: 8 } as const;
    const asserted = fundamentalPlayerValue(base);
    const holdsUp = fundamentalPlayerValue({ ...base, futureSeasons: [1, 1, 1] });
    expect(holdsUp.total).toBeGreaterThan(asserted.total);
  });

  it('prices only production above replacement', () => {
    const replacement = fundamentalPlayerValue({ position: 'WR', age: 25, weeklyPoints: 8, replacementPoints: 8 });
    expect(replacement.total).toBe(0);
  });

  it('treats picks as liquid future assets with a time discount', () => {
    expect(fundamentalPickValue(5_000, 1)).toBeGreaterThan(fundamentalPickValue(5_000, 3));
  });
});
