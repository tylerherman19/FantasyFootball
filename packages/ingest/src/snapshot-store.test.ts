import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSnapshotStore } from './snapshot-store.js';

describe('JsonlSnapshotStore', () => {
  it('preserves pre-kickoff projections without a database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffe-snapshots-'));
    const store = new JsonlSnapshotStore(root);
    const capturedAt = '2026-08-20T12:00:00.000Z';

    const wrote = await store.writeProjections([
      {
        season: 2026,
        week: 1,
        playerId: '123',
        source: 'ffe',
        sourceVersion: 'v1-usage',
        points: 14.2,
        scoringKey: 'ppr',
        capturedAt,
      },
    ]);

    expect(wrote).toBe(1);
    const text = await readFile(join(root, 'projections', '2026-01.jsonl'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ playerId: '123', capturedAt });
  });

  it('appends rather than rewriting, so an amended capture keeps the original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffe-snapshots-'));
    const store = new JsonlSnapshotStore(root);
    const row = {
      season: 2026,
      week: 1,
      playerId: '123',
      source: 'ffe',
      sourceVersion: 'v1-usage',
      scoringKey: 'ppr',
    };

    await store.writeProjections([{ ...row, points: 14.2, capturedAt: '2026-08-20T12:00:00.000Z' }]);
    await store.writeProjections([{ ...row, points: 11.9, capturedAt: '2026-08-21T12:00:00.000Z' }]);

    const lines = await store.read<{ points: number }>('projections/2026-01.jsonl');
    expect(lines.map((line) => line.points)).toEqual([14.2, 11.9]);
  });
});
