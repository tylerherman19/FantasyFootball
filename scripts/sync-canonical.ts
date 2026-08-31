/**
 * Load the exported artifacts into the canonical store.
 *
 * The direction matters and is easy to get backwards. Python builds artifacts;
 * this pushes them into Postgres; the app keeps reading the artifact. Postgres
 * is the canonical record and the history, not a step in the hot path — putting
 * a network round trip between a page render and its projections would be a
 * straight regression, and the whole reason the artifact seam exists is to
 * avoid exactly that.
 *
 * What the store buys is memory. The artifact holds one week and is overwritten
 * in place, so the moment it is rebuilt the previous state is gone and the
 * product cannot answer "why did his ranking change" — not because the model is
 * weak but because nothing remembered. After this runs weekly, it can.
 *
 *     npm run sync:canonical
 *
 * Idempotent: re-running the same artifact corrects rows rather than
 * duplicating them, because the unique key is (player, season, week, version).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ARTIFACTS = join(process.cwd(), 'model', 'artifacts');

interface ArtifactPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly stats: Record<string, number>;
  readonly sd: number;
  readonly gameLoading: number;
  readonly byeWeek: number | null;
  readonly basis?: string;
}

interface Identity {
  readonly sleeper_id: string;
  readonly gsis_id: string | null;
  readonly yahoo_id: string | null;
  readonly espn_id: string | null;
  readonly name: string;
  readonly position: string | null;
  readonly team: string | null;
  readonly birthdate: string | null;
  readonly draft_year: number | null;
  readonly draft_round: number | null;
  readonly draft_overall: number | null;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.');
  process.exit(1);
}

const post = async (path: string, rows: unknown[], prefer: string): Promise<number> => {
  if (rows.length === 0) return 0;

  const CHUNK = 500;
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: `return=minimal,${prefer}`,
      },
      body: JSON.stringify(batch),
    });

    if (!res.ok) {
      throw new Error(`PostgREST ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
    }
    written += batch.length;
  }

  return written;
};

/**
 * Update an existing row.
 *
 * Distinct from `post` with an upsert, which PostgREST validates as an INSERT
 * first — so a partial row trips NOT NULL on columns it was never going to
 * write, and any column left out gets silently reset to its default. Both
 * happened here: `label` rejected the write, and `kind` would have been reset
 * from 'offline' back to 'serve', undoing the migration that fixed the panel.
 *
 * These rows are seeded by migration and only ever updated, so PATCH is the
 * honest verb.
 */
const patch = async (path: string, body: unknown): Promise<boolean> => {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  return res.ok;
};

/**
 * Read a table, in pages.
 *
 * PostgREST caps a response at its configured maximum rows and says nothing
 * about it, so a single unbounded GET silently returns a prefix. Reconciliation
 * that runs on a prefix is worse than no reconciliation: it would conclude an
 * id is unclaimed because the row holding it fell off the end.
 */
const getAll = async <T>(path: string, select: string): Promise<T[]> => {
  const PAGE = 1000;
  const out: T[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${url}/rest/v1/${path}?select=${select}&order=player_uid.asc&limit=${PAGE}&offset=${offset}`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } },
    );
    if (!res.ok) {
      throw new Error(`PostgREST ${res.status} reading ${path}: ${(await res.text()).slice(0, 300)}`);
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
};

/** Call a Postgres function. */
const rpc = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`PostgREST ${res.status} calling ${name}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.text()).replace(/^"|"$/g, '');
};

interface StoredIdentity {
  readonly player_uid: string;
  readonly gsis_id: string | null;
  readonly sleeper_id: string | null;
}

/**
 * Resolve every identity collision before writing a single row.
 *
 * `players` has three unique keys and the upsert can only name one of them, so
 * an external id that has changed hands is a 409 the write cannot recover from.
 * The one that broke production: a player stored as `sleeper:13806` before
 * nflverse listed him, whose uid becomes `gsis:00-00…` the moment it does. The
 * new row claims sleeper_id 13806; the old row still holds it; the sync exits 1
 * and two days of fresh projections never left the runner.
 *
 * So the id is freed first. Each stale row is collapsed into the uid that now
 * owns its ids, which moves the projection history rather than discarding it —
 * the point of the rename being a rename and not a delete.
 *
 * Runs before every sync, not just after a schema change, because the crosswalk
 * is rebuilt from nflverse daily and a uid can migrate on any of those days.
 */
const reconcileIdentities = async (
  desired: readonly { player_uid: string; gsis_id: string | null; sleeper_id: string | null }[],
): Promise<void> => {
  const stored = await getAll<StoredIdentity>('players', 'player_uid,gsis_id,sleeper_id');
  if (stored.length === 0) return;

  const owner = new Map<string, string>();
  for (const row of stored) {
    if (row.gsis_id !== null) owner.set(`gsis:${row.gsis_id}`, row.player_uid);
    if (row.sleeper_id !== null) owner.set(`sleeper:${row.sleeper_id}`, row.player_uid);
  }

  const present = new Set(stored.map((row) => row.player_uid));
  let merges = 0;

  for (const row of desired) {
    // Every external id this row is about to claim. A collision on any one of
    // them fails the whole batch, so all of them are checked.
    const claims = [
      row.gsis_id === null ? null : `gsis:${row.gsis_id}`,
      row.sleeper_id === null ? null : `sleeper:${row.sleeper_id}`,
    ].filter((claim): claim is string => claim !== null);

    for (const claim of claims) {
      const held = owner.get(claim);
      if (held === undefined || held === row.player_uid) continue;

      const outcome = await rpc('merge_player', { from_uid: held, to_uid: row.player_uid });
      merges += 1;

      // Keep the local view of the table honest, because one stale row can hold
      // an id that a later row in this same loop also wants.
      present.delete(held);
      present.add(row.player_uid);
      for (const [id, uid] of owner) if (uid === held) owner.set(id, row.player_uid);

      if (merges <= 10) console.log(`  ${held} -> ${row.player_uid}: ${outcome}`);
    }
  }

  if (merges > 0) {
    console.log(
      `identity: ${merges} stale player_uid${merges === 1 ? '' : 's'} migrated` +
        (merges > 10 ? ` (first 10 shown)` : ''),
    );
  }
};

/**
 * The internal key.
 *
 * gsis where we have it, because it is the id every league-independent dataset
 * speaks and the one that survives a platform change. Sleeper only as a
 * fallback, so a player who exists on a roster but not in nflverse still gets a
 * row — the audit's §5 point, that keying on `sleeper_id` makes a
 * "platform-neutral" model quietly Sleeper-shaped.
 */
const uidOf = (identity: Identity): string =>
  identity.gsis_id ? `gsis:${identity.gsis_id}` : `sleeper:${identity.sleeper_id}`;

const main = async (): Promise<void> => {
  const crosswalk = JSON.parse(await readFile(join(ARTIFACTS, 'crosswalk.json'), 'utf8')) as {
    by_sleeper_id: Record<string, Identity>;
  };

  const identities = Object.values(crosswalk.by_sleeper_id);
  const uidBySleeper = new Map<string, string>();

  /*
   * Two Sleeper ids can carry the same gsis, and the crosswalk keeps both.
   *
   * That is a duplicate person, not a duplicate row: a player who was entered
   * twice on the platform, usually after a name change or a re-signing. Keying
   * on `sleeper_id` — as this codebase did everywhere before `player_uid` —
   * hides it completely, because both entries look like distinct players and
   * each gets its own roster slot, its own projection and its own market value.
   *
   * The canonical table refuses to store them twice, which is the point of
   * having one. The winner is the record carrying the most external ids, on the
   * grounds that the better-populated entry is the one the providers agree is
   * real. Both Sleeper ids still resolve to it, so a roster referencing either
   * finds the same person.
   */
  const byUid = new Map<string, Identity>();
  let collapsed = 0;

  for (const identity of identities) {
    const uid = uidOf(identity);
    const existing = byUid.get(uid);
    if (existing === undefined) {
      byUid.set(uid, identity);
      continue;
    }
    collapsed += 1;
    const score = (i: Identity): number =>
      [i.gsis_id, i.yahoo_id, i.espn_id, i.birthdate, i.team].filter(Boolean).length;
    if (score(identity) > score(existing)) byUid.set(uid, identity);
  }

  if (collapsed > 0) {
    console.log(
      `identity: ${collapsed} duplicate Sleeper id${collapsed === 1 ? '' : 's'} collapsed onto an existing player`,
    );
  }

  // Every Sleeper id maps to a uid, including the ones that lost the tie-break,
  // so a roster referencing either entry resolves to the same person.
  for (const identity of identities) uidBySleeper.set(identity.sleeper_id, uidOf(identity));

  const playerRows = [...byUid.values()].map((identity) => {
    const uid = uidOf(identity);
    return {
      player_uid: uid,
      gsis_id: identity.gsis_id,
      sleeper_id: identity.sleeper_id,
      yahoo_id: identity.yahoo_id,
      espn_id: identity.espn_id,
      full_name: identity.name,
      position: identity.position,
      team: identity.team,
      birthdate: identity.birthdate,
      draft_year: identity.draft_year,
      draft_round: identity.draft_round,
      draft_overall: identity.draft_overall,
      updated_at: new Date().toISOString(),
    };
  });

  console.log('identity: reconciling external ids');
  await reconcileIdentities(playerRows);

  const players = await post(
    'players?on_conflict=player_uid',
    playerRows,
    'resolution=merge-duplicates',
  );
  console.log(`players: ${players.toLocaleString()} upserted`);

  // Every projection artifact present, not just the current week — the point is
  // the history, and the files already on disk are history we would otherwise
  // throw away the next time the exporter runs.
  const files = (await readdir(ARTIFACTS)).filter(
    (f) => f.startsWith('projections-') && f.endsWith('.json'),
  );

  let totalProjections = 0;

  for (const file of files.sort()) {
    const artifact = JSON.parse(await readFile(join(ARTIFACTS, file), 'utf8')) as {
      modelVersion: string;
      season: number;
      week: number;
      generatedAt: string;
      players: Record<string, ArtifactPlayer>;
    };

    const rows = Object.values(artifact.players).flatMap((player) => {
      const uid = uidBySleeper.get(player.playerId);
      // A player in the artifact but not the crosswalk cannot get a canonical
      // row, and inventing one would create a second identity for somebody who
      // already has one. Skipped and counted rather than forced.
      if (uid === undefined) return [];

      return [
        {
          player_uid: uid,
          season: artifact.season,
          week: artifact.week,
          model_version: artifact.modelVersion,
          stats: player.stats,
          sd: player.sd,
          bye_week: player.byeWeek,
          basis: player.basis ?? 'history',
          game_loading: player.gameLoading,
          generated_at: artifact.generatedAt,
        },
      ];
    });

    const skipped = Object.keys(artifact.players).length - rows.length;
    const written = await post(
      'player_projections?on_conflict=player_uid,season,week,model_version',
      rows,
      'resolution=merge-duplicates',
    );
    totalProjections += written;
    console.log(
      `${file}: ${written.toLocaleString()} projections` +
        (skipped > 0 ? `, ${skipped} skipped (no canonical identity)` : ''),
    );
  }

  // The ledger of what was tried and what shipped, so "which version is live and
  // did it beat the one before it" is queryable rather than something a person
  // has to go and read in a commit message.
  /*
   * PostgREST requires every object in a batch to carry the same keys, so these
   * are built from a full-shape helper rather than written out with whatever
   * fields happened to apply. A version with no CRPS gets an explicit null,
   * which is also the more honest record: "not measured" and "absent from the
   * object" should not look the same in a table whose job is remembering.
   */
  const version = (
    model_version: string,
    description: string,
    fields: {
      mae?: number;
      rmse?: number;
      crps?: number;
      baseline?: string;
      skill_vs_baseline?: number;
      /**
       * The baseline's MAE on the SAME weeks.
       *
       * Without this a reader sorting the table by `mae` ranks v2 and v3 above
       * v1 — exactly backwards, and entirely an artefact of v2/v3 having been
       * evaluated over 2024-25 while v1 was measured over 2022-25. Storing the
       * comparison on the row makes each one self-contained.
       */
      baseline_mae?: number;
      evaluation_window?: string;
      observations?: number;
      shipped: boolean;
    },
  ) => ({
    model_version,
    description,
    mae: fields.mae ?? null,
    rmse: fields.rmse ?? null,
    crps: fields.crps ?? null,
    baseline: fields.baseline ?? null,
    skill_vs_baseline: fields.skill_vs_baseline ?? null,
    baseline_mae: fields.baseline_mae ?? null,
    evaluation_window: fields.evaluation_window ?? null,
    observations: fields.observations ?? null,
    shipped: fields.shipped,
  });

  const versions = [
    version(
      'v0-marcel',
      'Recency-weighted multi-season average, regressed to the positional mean. The baseline every later rung must beat.',
      { mae: 4.88, rmse: 6.332, crps: 3.498, evaluation_window: '2022-2025', observations: 21679, shipped: false },
    ),
    version(
      'v1-usage+positional',
      'Opportunity x efficiency with empirical-Bayes shrinkage, plus positional models for K/IDP/DEF and a draft-capital rookie prior. Beats v0 in all four seasons separately.',
      {
        mae: 4.608, rmse: 6.151, crps: 3.329,
        baseline: 'v0-marcel', skill_vs_baseline: 0.056, baseline_mae: 4.88,
        evaluation_window: '2022-2025', observations: 21679, shipped: true,
      },
    ),
    version(
      'v2-matchup',
      'v1 scaled by opponent-adjusted points allowed to position. Degraded monotonically as the weight rose. Built, measured, declined.',
      {
        mae: 4.564, baseline: 'v1-usage', skill_vs_baseline: 0.0009, baseline_mae: 4.568,
        evaluation_window: '2024-2025', observations: 10979, shipped: false,
      },
    ),
    version(
      'v3-allocation',
      'v1 with opportunity adjusted by opponent-adjusted opportunity allowed, rates untouched — the "you adjusted the wrong quantity" objection to v2, taken seriously. Same monotone decay. Declined.',
      {
        mae: 4.567, baseline: 'v1-usage', skill_vs_baseline: 0.0002, baseline_mae: 4.568,
        evaluation_window: '2024-2025', observations: 10979, shipped: false,
      },
    ),
  ];

  await post('model_versions?on_conflict=model_version', versions, 'resolution=merge-duplicates');
  console.log(`model_versions: ${versions.length} recorded`);

  /*
   * Record the offline sources.
   *
   * `data_sources` was seeded with seven providers and only two of them —
   * Sleeper and market values — are fetched at serve time. The other five are
   * built here, by the Python pipeline, and nothing ever wrote their status. So
   * they sat at `never` forever and the league home led with "7 data sources
   * not reporting" as its most important insight, about data that was fine.
   *
   * This is the writer they never had. The timestamp is the artifact's own
   * `generatedAt` where it has one, and the file's modification time where it
   * does not — because what a reader wants to know is how old the *data* is,
   * not when this script last ran over it.
   */
  const stamp = async (
    source: string,
    file: string,
    count: number | null,
  ): Promise<void> => {
    const path = join(ARTIFACTS, file);
    let when: string;
    let records = count;

    try {
      const stat = await import('node:fs/promises').then((fs) => fs.stat(path));
      when = stat.mtime.toISOString();

      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        generatedAt?: string;
        count?: number;
        playerCount?: number;
      };
      if (typeof parsed.generatedAt === 'string') when = parsed.generatedAt;
      records ??= parsed.playerCount ?? parsed.count ?? null;
    } catch {
      // A missing artifact is not an error to record — it is a source that has
      // not been built, which the view already reports as unknown.
      return;
    }

    const now = new Date().toISOString();
    const ok = await patch(`data_sources?source=eq.${encodeURIComponent(source)}`, {
      last_attempt_at: now,
      last_success_at: now,
      data_timestamp: when,
      last_status: 'ok',
      last_error: null,
      last_record_count: records,
      consecutive_failures: 0,
      updated_at: now,
    });
    console.log(`  ${source}: ${ok ? `data from ${when.slice(0, 16)}` : 'FAILED'}`);
  };

  console.log('offline sources:');
  const current = files.sort().at(-1);
  if (current !== undefined) await stamp('projections', current, null);
  await stamp('crosswalk', 'crosswalk.json', identities.length);

  // The lake has no artifact of its own, so nflverse and injuries are dated
  // from the ingest manifest that `model/ingest/nflverse.py` writes.
  try {
    const manifestPath = join(process.cwd(), 'data', 'lake', 'manifest.json');
    const stat = await import('node:fs/promises').then((fs) => fs.stat(manifestPath));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      assets?: { rows?: number }[];
    };
    const rows = (manifest.assets ?? []).reduce((sum, a) => sum + (a.rows ?? 0), 0);

    const now = new Date().toISOString();
    for (const source of ['nflverse', 'injuries']) {
      await patch(`data_sources?source=eq.${source}`, {
        last_attempt_at: now,
        last_success_at: now,
        data_timestamp: stat.mtime.toISOString(),
        last_status: 'ok',
        last_error: null,
        last_record_count: rows,
        consecutive_failures: 0,
        updated_at: now,
      });
    }
    console.log(`  nflverse + injuries: lake from ${stat.mtime.toISOString().slice(0, 16)}`);
  } catch {
    // No manifest means the lake has never been synced here, which the view
    // reports as unknown rather than as a failure.
  }
  console.log(`\ntotal: ${totalProjections.toLocaleString()} projections across ${files.length} week(s)`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
