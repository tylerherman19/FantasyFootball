import { describe, expect, it } from 'vitest';
import { applyAvailability, isRuledOut, playProbability } from './availability.js';

describe('playProbability', () => {
  it('treats a healthy player as certain', () => {
    expect(playProbability(null)).toBe(1);
    expect(playProbability(undefined)).toBe(1);
    expect(playProbability('')).toBe(1);
  });

  it('rules out the season-ending designations completely', () => {
    for (const status of ['IR', 'PUP', 'Out', 'Sus', 'DNR']) {
      expect(playProbability(status)).toBe(0);
      expect(isRuledOut(status)).toBe(true);
    }
  });

  it('treats questionable as likely and doubtful as unlikely', () => {
    // The labels mean what they say, and managers routinely get this backwards.
    expect(playProbability('Questionable')).toBeGreaterThan(0.6);
    expect(playProbability('Doubtful')).toBeLessThan(0.4);
    expect(playProbability('Questionable')).toBeGreaterThan(playProbability('Doubtful'));
  });

  it('passes through an unknown status rather than guessing', () => {
    expect(playProbability('Some New Label')).toBe(1);
  });
});

describe('applyAvailability', () => {
  it('zeroes a player on bye', () => {
    const result = applyAvailability(18, 7, null, true);
    expect(result.mean).toBe(0);
    expect(result.sd).toBe(0);
    expect(result.note).toBe('on bye');
  });

  it('zeroes a ruled-out player so the solver cannot start him', () => {
    const result = applyAvailability(18, 7, 'IR', false);
    expect(result.mean).toBe(0);
    expect(result.playProbability).toBe(0);
  });

  it('leaves a healthy player untouched', () => {
    const result = applyAvailability(18, 7, null, false);
    expect(result.mean).toBe(18);
    expect(result.sd).toBe(7);
    expect(result.note).toBeNull();
  });

  it('scales the mean by the chance of playing', () => {
    const result = applyAvailability(20, 6, 'Questionable', false);
    expect(result.mean).toBeCloseTo(20 * playProbability('Questionable'), 6);
  });

  /**
   * The point most tools miss: a player who might not play at all has a wider
   * range of outcomes than one who certainly will. Scaling the mean alone makes
   * a risky start look deceptively safe.
   */
  it('widens the spread rather than only shrinking the mean', () => {
    const healthy = applyAvailability(20, 6, null, false);
    const questionable = applyAvailability(20, 6, 'Questionable', false);

    expect(questionable.mean).toBeLessThan(healthy.mean);
    expect(questionable.sd).toBeGreaterThan(healthy.sd);
  });

  it('explains itself', () => {
    const result = applyAvailability(20, 6, 'Questionable', false);
    expect(result.note).toContain('Questionable');
    expect(result.note).toContain('%');
  });
});
