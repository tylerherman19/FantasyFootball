import { loadIdentities } from './crosswalk';
import { loadArtifact, scoreFor } from './projections';

/**
 * Display metadata for players.
 *
 * The projection artifact already carries name, position and team, so there is
 * no reason to pull Sleeper's 3MB player file on every page render. Anyone
 * missing from the artifact simply has no projection, which the UI shows
 * honestly rather than hiding.
 */

export interface PlayerInfo {
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly mean: number;
  readonly sd: number;
  /** False when we carry a name but no projection — rookies, IDP, defenses. */
  readonly projected: boolean;
  /**
   * The week this player's team does not play, or null if none is known.
   *
   * Lives here because this is the one place that reads the artifact purely for
   * display metadata, and a bye is exactly that — a fact about the calendar
   * rather than about a particular week's projection. The per-week
   * `PlayerProjection` cannot carry it, since by construction it describes one
   * week only.
   */
  readonly byeWeek: number | null;
}

/**
 * Cached per league scoring ruleset.
 *
 * Building this walks every player in the crosswalk and the artifact — tens of
 * thousands of entries — and several pages ask for it. The scoring rules are
 * part of the key because points are derived per league, so two leagues reading
 * the same artifact legitimately get different numbers.
 */
const cache = new Map<string, Record<string, PlayerInfo>>();

export const loadPlayerInfo = async (
  season: number,
  week: number,
  rules: Readonly<Record<string, number>> = {},
): Promise<Record<string, PlayerInfo>> => {
  const key = `${season}:${week}:${JSON.stringify(rules)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const [artifact, identities] = await Promise.all([loadArtifact(season, week), loadIdentities()]);

  const out: Record<string, PlayerInfo> = {};

  // Start from identity so unprojected players still render as people.
  for (const [id, identity] of Object.entries(identities)) {
    out[id] = {
      name: identity.name,
      position: identity.position ?? '?',
      team: identity.team ?? '',
      mean: 0,
      sd: 0,
      projected: false,
      byeWeek: null,
    };
  }

  for (const [id, player] of Object.entries(artifact?.players ?? {})) {
    out[id] = {
      name: player.name || out[id]?.name || id,
      position: player.position,
      team: player.team,
      mean: scoreFor(player, rules, null, week),
      sd: player.sd,
      projected: true,
      byeWeek: player.byeWeek,
    };
  }

  // Bounded: a handful of leagues per process, each with one ruleset.
  if (cache.size > 16) cache.clear();
  cache.set(key, out);

  return out;
};
