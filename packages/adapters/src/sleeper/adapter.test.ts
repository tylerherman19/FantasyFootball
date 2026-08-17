import { describe, expect, it } from 'vitest';
import type { SleeperLeague } from './client.js';
import { regularSeasonWeeks, toFormat } from './adapter.js';

/** Minimal league fixture; each test overrides only the settings it cares about. */
const league = (settings: SleeperLeague['settings']): SleeperLeague => ({
  league_id: '1',
  name: 'Test',
  season: '2026',
  total_rosters: 10,
  roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
  scoring_settings: {},
  settings,
});

describe('toFormat', () => {
  it('maps Sleeper league types', () => {
    expect(toFormat(league({ type: 0 }))).toBe('redraft');
    expect(toFormat(league({ type: 1 }))).toBe('keeper');
    expect(toFormat(league({ type: 2 }))).toBe('dynasty');
    expect(toFormat(league({ type: 3 }))).toBe('guillotine');
  });

  it('treats a missing type as redraft, since older leagues predate the field', () => {
    expect(toFormat(league({}))).toBe('redraft');
  });

  it('detects guillotine from last_chopped_leg even when type is unset', () => {
    expect(toFormat(league({ last_chopped_leg: 15 }))).toBe('guillotine');
  });
});

describe('regularSeasonWeeks', () => {
  it('counts the weeks before the playoffs', () => {
    expect(regularSeasonWeeks(league({ playoff_week_start: 15 }))).toBe(14);
  });

  /**
   * Regression: guillotine leagues report playoff_week_start 0, which the naive
   * `playoffStartWeek - 1` turned into -1 and silently fetched zero matchups.
   */
  it('falls back to the last chop for guillotine leagues with no playoffs', () => {
    expect(regularSeasonWeeks(league({ type: 3, playoff_week_start: 0, last_chopped_leg: 15 }))).toBe(15);
  });

  it('falls back to a full season when the league tells us nothing', () => {
    expect(regularSeasonWeeks(league({}))).toBe(17);
  });
});
