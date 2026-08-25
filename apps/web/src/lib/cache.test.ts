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
