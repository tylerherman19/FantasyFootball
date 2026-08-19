import { readArtifactFile } from './projections';

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
  /**
   * nflverse's player id.
   *
   * The bridge to everything historical: Sleeper keys rosters by its own id,
   * every league-independent dataset keys by gsis, and without this the two
   * halves of the product cannot be joined at all.
   */
  readonly gsisId: string | null;
}

let cache: Record<string, Identity> | null = null;

export const loadIdentities = async (): Promise<Record<string, Identity>> => {
  if (cache !== null) return cache;

  try {
    const raw = await readArtifactFile('crosswalk.json');
    if (raw === null) return {};

    const payload = JSON.parse(raw) as {
      by_sleeper_id: Record<
        string,
        {
          name: string;
          position: string | null;
          team: string | null;
          birthdate: string | null;
          gsis_id: string | null;
        }
      >;
    };

    const out: Record<string, Identity> = {};
    for (const [id, entry] of Object.entries(payload.by_sleeper_id)) {
      out[id] = {
        name: entry.name,
        position: entry.position,
        team: entry.team,
        birthdate: entry.birthdate ?? null,
        gsisId: entry.gsis_id ?? null,
      };
    }

    cache = out;
    return out;
  } catch {
    return {};
  }
};
