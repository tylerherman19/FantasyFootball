import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSnapshotStore } from './snapshot-store.js';

describe('JsonlSnapshotStore', () => {
  it('preserves market-value observations without a database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffe-snapshots-'));
    const store = new JsonlSnapshotStore(root);
    const capturedAt = '2026-08-20T12:00:00.000Z';

    const wrote = await store.writeValues([
      {
        sleeperId: '123',
        name: 'Player One',
        position: 'WR',
        isDynasty: true,
        superFlex: true,
        value: 5000,
        overallRank: 10,
        positionRank: 2,
        rosteredPct: 95,
        capturedAt,
      },
    ]);

    expect(wrote).toBe(1);
    const text = await readFile(join(root, 'values', '2026-08-20.jsonl'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ sleeperId: '123', capturedAt });
  });
});
