import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SleeperClient, clearSleeperCache } from './client.js';

const user = (id: string) => ({ user_id: id, username: id, display_name: id });

describe('SleeperClient reliability', () => {
  beforeEach(() => {
    clearSleeperCache();
    vi.restoreAllMocks();
  });

  it('does not retry permanent 4xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SleeperClient().getUser('missing')).rejects.toThrow('Sleeper request failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a pre-refresh request repopulate cache', async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(Response.json(user('fresh')));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SleeperClient();
    const staleRequest = client.getUser('tyler');
    clearSleeperCache();
    const freshRequest = client.getUser('tyler');

    resolveFirst(Response.json(user('stale')));

    expect((await staleRequest).user_id).toBe('stale');
    expect((await freshRequest).user_id).toBe('fresh');
    expect((await client.getUser('tyler')).user_id).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
