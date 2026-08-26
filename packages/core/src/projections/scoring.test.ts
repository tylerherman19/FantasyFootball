import { describe, expect, it } from 'vitest';
import { scoreStatLine } from './scoring.js';

describe('exact league scoring', () => {
  it('awards threshold bonuses exactly like the Python backtest scorer', () => {
    const rules = { rec_yd: 0.1, bonus_rec_yd_100: 3 };

    expect(scoreStatLine({ receiving_yards: 99.9 }, rules)).toBeCloseTo(9.99);
    expect(scoreStatLine({ receiving_yards: 100 }, rules)).toBe(13);
  });
});
