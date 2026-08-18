import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Player identity, for display.
 *
 * The projection artifact only contains players the model can project. Anyone
 * else — a 2026 rookie with no NFL snaps, an IDP in a league we don't yet model,
 * a team defense — still sits on a roster and still has to render as a name
 * rather than a numeric id. The crosswalk covers everyone.
 */

export interface Identity {
  readonly name: string;
  readonly position: string | null;
  readonly team: string | null;
  /** ISO date. Age drives the contention-window read in dynasty leagues. */
  readonly birthdate: string | null;
}

let cache: Record<string, Identity> | null = null;

export const loadIdentities = async (): Promise<Record<string, Identity>> => {
  if (cache !== null) return cache;

  try {
    const path = join(process.cwd(), '..', '..', 'model', 'artifacts', 'crosswalk.json');
    const payload = JSON.parse(await readFile(path, 'utf8')) as {
      by_sleeper_id: Record<
        string,
        { name: string; position: string | null; team: string | null; birthdate: string | null }
      >;
    };

    const out: Record<string, Identity> = {};
    for (const [id, entry] of Object.entries(payload.by_sleeper_id)) {
      out[id] = {
        name: entry.name,
        position: entry.position,
        team: entry.team,
        birthdate: entry.birthdate ?? null,
      };
    }

    cache = out;
    return out;
  } catch {
    return {};
  }
};
