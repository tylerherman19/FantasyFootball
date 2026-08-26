import { describe, expect, it } from 'vitest';
import { fundamentalPickValue, fundamentalPlayerValue } from './fundamental.js';

describe('dynasty fundamental value', () => {
  it('values the same production more highly when it survives a rebuild window', () => {
    const young = fundamentalPlayerValue({ position: 'WR', age: 22, weeklyPoints: 15, replacementPoints: 8, marketValue: 6_000 });
    const old = fundamentalPlayerValue({ position: 'WR', age: 31, weeklyPoints: 15, replacementPoints: 8, marketValue: 6_000 });
    expect(young.total).toBeGreaterThan(old.total);
  });

  it('treats picks as liquid future assets with a time discount', () => {
    expect(fundamentalPickValue(5_000, 1)).toBeGreaterThan(fundamentalPickValue(5_000, 3));
  });
});
