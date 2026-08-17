import { describe, expect, it } from 'vitest';
import { devig, impliedTeamPoints, weekOf } from './odds.js';

describe('devig', () => {
  it('normalizes a book’s two sides to sum to 1', () => {
    // -110 both ways: each side implies 52.4%, summing to 104.8% — the vig.
    const [a, b] = devig(0.5238, 0.5238);
    expect(a + b).toBeCloseTo(1, 10);
    expect(a).toBeCloseTo(0.5, 10);
  });

  it('keeps the favourite favoured while removing the margin', () => {
    const [fav, dog] = devig(0.65, 0.4);
    expect(fav + dog).toBeCloseTo(1, 10);
    expect(fav).toBeGreaterThan(dog);
    // The naive number overstates the favourite; de-vigging pulls it down.
    expect(fav).toBeLessThan(0.65);
  });
});

describe('impliedTeamPoints', () => {
  it('splits the total by the spread', () => {
    // 44.5 total, home favoured by 3.5 -> home 24, away 20.5
    const { home, away } = impliedTeamPoints(44.5, -3.5);
    expect(home).toBeCloseTo(24, 10);
    expect(away).toBeCloseTo(20.5, 10);
    expect(home + away).toBeCloseTo(44.5, 10);
  });

  it('splits evenly at a pick’em', () => {
    const { home, away } = impliedTeamPoints(48, 0);
    expect(home).toBe(24);
    expect(away).toBe(24);
  });
});

describe('weekOf', () => {
  // Thursday-night opener, 8:20pm ET -> already Friday in UTC.
  const opener = new Date('2026-09-11T00:20:00Z');

  it('puts the opener in week 1', () => {
    expect(weekOf(opener, opener)).toBe(1);
  });

  it('keeps Sunday afternoon in week 1', () => {
    expect(weekOf(new Date('2026-09-13T17:00:00Z'), opener)).toBe(1);
  });

  /**
   * Regression: MNF kicks 8:15pm ET, which is Tuesday 00:15 UTC. A midnight-UTC
   * week boundary pushed every Monday night game into the following week.
   */
  it('keeps Monday Night Football in week 1 despite being Tuesday in UTC', () => {
    expect(weekOf(new Date('2026-09-15T00:15:00Z'), opener)).toBe(1);
  });

  it('rolls to week 2 at the next Thursday game', () => {
    expect(weekOf(new Date('2026-09-18T00:15:00Z'), opener)).toBe(2);
  });

  it('counts further weeks linearly', () => {
    expect(weekOf(new Date('2026-11-01T17:00:00Z'), opener)).toBe(8);
  });
});
