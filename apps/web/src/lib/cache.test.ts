import { describe, expect, it } from 'vitest';
import { ttlCache } from './cache';

describe('ttlCache invalidation', () => {
  it('does not cache work that began before invalidation', async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;

    const cached = ttlCache(
      60_000,
      (key: string) => key,
      async () => {
        calls += 1;
        return calls === 1 ? first : 'fresh';
      },
      { name: 'cache-invalidation-test' },
    );

    const staleRequest = cached('league');
    cached.invalidate();
    const freshRequest = cached('league');
    resolveFirst('stale');

    expect(await staleRequest).toBe('stale');
    expect(await freshRequest).toBe('fresh');
    expect(await cached('league')).toBe('fresh');
    expect(calls).toBe(2);
  });
});

describe('ttlCache sharing', () => {
  it('computes once for concurrent callers, which is what the six tabs rely on', async () => {
    let calls = 0;
    const cached = ttlCache(
      60_000,
      (key: string) => key,
      async (key: string) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `${key}-built`;
      },
      { name: 'cache-sharing-test' },
    );

    const all = await Promise.all([cached('a'), cached('a'), cached('a')]);

    expect(all).toEqual(['a-built', 'a-built', 'a-built']);
    expect(calls).toBe(1);
  });

  it('keys separately, so two leagues do not share one answer', async () => {
    let calls = 0;
    const cached = ttlCache(
      60_000,
      (key: string) => key,
      async (key: string) => {
        calls += 1;
        return key;
      },
      { name: 'cache-keying-test' },
    );

    expect(await cached('league-a')).toBe('league-a');
    expect(await cached('league-b')).toBe('league-b');
    expect(await cached('league-a')).toBe('league-a');
    expect(calls).toBe(2);
  });

  it('evicts oldest first so one process serving many leagues stays bounded', async () => {
    let calls = 0;
    const cached = ttlCache(
      60_000,
      (key: string) => key,
      async (key: string) => {
        calls += 1;
        return key;
      },
      { name: 'cache-bound-test', maxEntries: 2 },
    );

    await cached('one');
    await cached('two');
    await cached('three');
    // 'one' was evicted when 'three' arrived, so asking again recomputes it.
    await cached('one');

    expect(calls).toBe(4);
  });
});
