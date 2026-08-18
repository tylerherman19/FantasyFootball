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
}

export const loadPlayerInfo = async (
  season: number,
  week: number,
  rules: Readonly<Record<string, number>> = {},
): Promise<Record<string, PlayerInfo>> => {
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
    };
  }

  for (const [id, player] of Object.entries(artifact?.players ?? {})) {
    out[id] = {
      name: player.name || out[id]?.name || id,
      position: player.position,
      team: player.team,
      mean: scoreFor(player, rules),
      sd: player.sd,
      projected: true,
    };
  }

  return out;
};
