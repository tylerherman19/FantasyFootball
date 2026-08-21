import { describe, expect, it } from 'vitest';
import {
  applyAvailability,
  isRuledOut,
  playProbability,
  productionWhenPlaying,
} from './availability.js';

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

  it('prices the game-time labels at their measured rates', () => {
    /*
     * These were hand-set until `model/export_availability.py` joined every
     * injury report since 2016 to who actually recorded a stat line. Both were
     * wrong, and Doubtful badly so: it was priced at one-in-four against a
     * measured 0.8%, which put players who were never going to appear into the
     * lineup solver every week.
     */
    expect(playProbability('Questionable')).toBeCloseTo(0.593, 3);
    expect(playProbability('Doubtful')).toBeCloseTo(0.008, 3);
    expect(playProbability('Questionable')).toBeGreaterThan(playProbability('Doubtful'));
  });

  it('treats a coin-flip label as roughly a coin flip', () => {
    // Managers routinely read "questionable" as "probably out". It is closer to
    // even than that, and much closer to even than "doubtful".
    expect(playProbability('Questionable')).toBeGreaterThan(0.5);
    expect(playProbability('Doubtful')).toBeLessThan(0.05);
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

  it('scales the mean by the chance of playing and by how well he plays', () => {
    /*
     * Two haircuts, because they are two facts. Whether he suits up, and how
     * much of himself he is when he does — measured at 0.774 of his own healthy
     * baseline over 2,359 Questionable appearances. Applying only the first
     * treats a hurt starter as his healthy self, which is exactly the case a
     * manager needs warned about.
     */
    const result = applyAvailability(20, 6, 'Questionable', false);
    const expected = 20 * productionWhenPlaying('Questionable') * playProbability('Questionable');

    expect(result.mean).toBeCloseTo(expected, 6);
    expect(result.mean).toBeLessThan(20 * playProbability('Questionable'));
  });

  it('says both numbers in the note', () => {
    const result = applyAvailability(20, 6, 'Questionable', false);

    expect(result.note).toMatch(/% to play/);
    expect(result.note).toMatch(/% of himself/);
  });

  it('applies no production discount to a healthy player', () => {
    expect(productionWhenPlaying(null)).toBe(1);
    expect(productionWhenPlaying('Some New Label')).toBe(1);
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
