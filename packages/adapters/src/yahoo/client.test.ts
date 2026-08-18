import { describe, expect, it } from 'vitest';
import { asNumber, asString, collection, mergeFragments } from './client.js';

/**
 * Yahoo's JSON is a transliteration of XML rather than a designed shape, and
 * getting these two helpers wrong produces empty leagues rather than errors —
 * the worst kind of failure. So they are pinned against the real structures.
 */

describe('collection', () => {
  it('turns Yahoo numeric-keyed objects into arrays', () => {
    const node = { '0': { team: 'a' }, '1': { team: 'b' }, count: 2 };
    expect(collection(node)).toEqual([{ team: 'a' }, { team: 'b' }]);
  });

  it('drops the count sibling rather than treating it as an entry', () => {
    expect(collection({ '0': 'x', count: 1 })).toHaveLength(1);
  });

  it('is empty for null and non-objects', () => {
    expect(collection(null)).toEqual([]);
    expect(collection('nope')).toEqual([]);
    expect(collection(42)).toEqual([]);
  });
});

describe('mergeFragments', () => {
  it('merges the array-of-partials Yahoo uses for entities', () => {
    const node = [{ team_key: '449.l.1.t.3' }, { name: 'Team Name' }, { waiver_priority: 4 }];
    expect(mergeFragments(node)).toEqual({
      team_key: '449.l.1.t.3',
      name: 'Team Name',
      waiver_priority: 4,
    });
  });

  it('flattens nested arrays, which Yahoo also emits', () => {
    const node = [[{ a: 1 }, { b: 2 }], { c: 3 }];
    expect(mergeFragments(node)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('passes a plain object through', () => {
    expect(mergeFragments({ a: 1 })).toEqual({ a: 1 });
  });

  it('ignores primitives mixed into the fragment list', () => {
    expect(mergeFragments([{ a: 1 }, 'junk', null, { b: 2 }])).toEqual({ a: 1, b: 2 });
  });
});

describe('coercion helpers', () => {
  it('parses Yahoo numeric strings', () => {
    expect(asNumber('12')).toBe(12);
    expect(asNumber('1.5')).toBe(1.5);
  });

  it('falls back rather than producing NaN', () => {
    expect(asNumber(undefined)).toBe(0);
    expect(asNumber('not a number', 7)).toBe(7);
  });

  it('stringifies without turning nullish into "undefined"', () => {
    expect(asString('x')).toBe('x');
    expect(asString(undefined)).toBe('');
    expect(asString(null, 'fallback')).toBe('fallback');
    expect(asString(12)).toBe('12');
  });
});
