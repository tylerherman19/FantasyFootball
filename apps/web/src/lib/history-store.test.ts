import { describe, expect, it } from 'vitest';
import { explainChange, type ProjectionChange } from './history-store';

/**
 * The distinction this whole feature exists for: a projection moving because
 * the *player* changed is different news from one moving because the *model*
 * changed, and a product that conflates them invents stories about players.
 */

const change = (over: Partial<ProjectionChange> = {}): ProjectionChange => ({
  generatedAt: '2026-08-21T00:00:00Z',
  previousGeneratedAt: '2026-08-14T00:00:00Z',
  modelVersion: 'v1-usage+positional',
  previousModelVersion: 'v1-usage+positional',
  modelChanged: false,
  points: 14,
  previousPoints: 18,
  delta: -4,
  driver: { stat: 'targets', change: -2.4 },
  ...over,
});

describe('explainChange', () => {
  it('names the stat that moved, in its own units', () => {
    // "His targets fell by 2.4 a game" is a fact about football. "He lost 3.1
    // points" is a fact about your scoring settings.
    const text = explainChange(change())!;

    expect(text).toMatch(/targets/);
    expect(text).toMatch(/fell by 2\.4 a game/);
    expect(text).toMatch(/4\.0 down/);
  });

  it('refuses to blame the player when the model moved underneath him', () => {
    const text = explainChange(
      change({ modelChanged: true, previousModelVersion: 'v1-usage', modelVersion: 'v2-blend' }),
    )!;

    expect(text).toMatch(/the model changed/i);
    expect(text).toMatch(/v1-usage → v2-blend/);
    expect(text).toMatch(/not a different player/i);
    // Crucially, it does NOT attribute the move to his usage.
    expect(text).not.toMatch(/targets/);
  });

  it('says so when nothing in particular moved', () => {
    const text = explainChange(change({ driver: null }))!;

    expect(text).toMatch(/no single stat moving much/i);
    expect(text).toMatch(/broad re-estimate/i);
  });

  it('stays quiet about noise', () => {
    expect(explainChange(change({ delta: 0.05 }))).toBeNull();
    expect(explainChange(change({ delta: -0.1 }))).toBeNull();
  });

  it('has nothing to say about a first publication', () => {
    expect(explainChange(change({ delta: null, previousPoints: null }))).toBeNull();
  });

  it('reads an increase as an increase', () => {
    const text = explainChange(
      change({ delta: 3.2, driver: { stat: 'carries', change: 4.1 } }),
    )!;

    expect(text).toMatch(/3\.2 up/);
    expect(text).toMatch(/carries rose by 4\.1/);
  });
});
