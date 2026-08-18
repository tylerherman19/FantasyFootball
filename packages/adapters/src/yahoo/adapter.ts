import {
  asPlayerId,
  type League,
  type LeagueFormat,
  type LeagueSnapshot,
  type LineupSlot,
  type Manager,
  type Matchup,
  type Roster,
  type ScoringRules,
  type TeamRecord,
  type WeeklyScore,
} from '@ffe/core/domain';
import { AdapterError, type LeagueRef, type PlatformAdapter } from '../platform-adapter.js';
import { asNumber, asString, collection, mergeFragments, YahooClient } from './client.js';

/**
 * Yahoo Fantasy, mapped onto the same domain model as Sleeper.
 *
 * Everything platform-specific stops here: the XML-shaped JSON, the league key
 * format, Yahoo's own slot names. Downstream, a Yahoo league is just a league.
 */

/** Yahoo's roster slot names, normalized to ours. */
const SLOT_MAP: Readonly<Record<string, LineupSlot>> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DEF: 'DEF',
  'W/R': 'WRRB_FLEX',
  'W/T': 'REC_FLEX',
  'W/R/T': 'FLEX',
  'Q/W/R/T': 'SUPER_FLEX',
  BN: 'BN',
  IR: 'IR',
  'IR+': 'IR',
  D: 'DL',
  DL: 'DL',
  LB: 'LB',
  DB: 'DB',
  LS: 'BN',
  P: 'BN',
};

const toSlot = (raw: string): LineupSlot => {
  const slot = SLOT_MAP[raw];
  if (slot === undefined) throw new AdapterError('Unknown Yahoo roster slot', { raw });
  return slot;
};

/**
 * Yahoo doesn't expose a single "format" field. Keeper and dynasty leagues are
 * distinguished by settings rather than a type code, so we infer conservatively
 * and default to redraft — the same convention the Sleeper adapter uses when a
 * league predates the field.
 */
const toFormat = (settings: Record<string, unknown>): LeagueFormat => {
  if (asNumber(settings['uses_keeper']) > 0 || settings['is_keeper_league'] === '1') return 'keeper';
  return 'redraft';
};

/** Yahoo scoring is a list of stat ids with modifiers; map the ones we model. */
const YAHOO_STAT_IDS: Readonly<Record<string, keyof Omit<ScoringRules, 'extra'>>> = {
  '4': 'passYd',
  '5': 'passTd',
  '6': 'passInt',
  '9': 'rushYd',
  '10': 'rushTd',
  '11': 'recYd',
  '12': 'recTd',
  '11.1': 'rec',
  '18': 'fumbleLost',
};

const toScoring = (statModifiers: unknown): ScoringRules => {
  const base: ScoringRules = {
    rec: 0, passYd: 0, passTd: 0, passInt: 0, rushYd: 0,
    rushTd: 0, recYd: 0, recTd: 0, fumbleLost: 0, extra: {},
  };

  const extra: Record<string, number> = {};
  const mutable = { ...base, extra } as ScoringRules & Record<string, number>;

  for (const entry of collection(statModifiers)) {
    const stat = mergeFragments((entry as Record<string, unknown>)['stat']);
    const statId = asString(stat['stat_id']);
    const value = asNumber(stat['value']);
    const field = YAHOO_STAT_IDS[statId];

    if (field === undefined) extra[statId] = value;
    else (mutable as Record<string, number>)[field] = value;
  }

  return { ...mutable, extra };
};

export class YahooAdapter implements PlatformAdapter {
  readonly platform = 'yahoo' as const;

  constructor(private readonly client: YahooClient) {}

  async listLeagues(_userHandle: string, season: number): Promise<LeagueRef[]> {
    // Yahoo identifies the user by the token, not by a handle — there is no way
    // to look up someone else's leagues, which is the point of the OAuth flow.
    const payload = await this.client.get<Record<string, unknown>>(
      `/users;use_login=1/games;game_codes=nfl;seasons=${season}/leagues`,
    );

    const users = collection((payload['fantasy_content'] as Record<string, unknown>)?.['users']);
    const refs: LeagueRef[] = [];

    for (const user of users) {
      const games = collection(mergeFragments((user as Record<string, unknown>)['user'])['games']);
      for (const game of games) {
        const leagues = collection(mergeFragments((game as Record<string, unknown>)['game'])['leagues']);
        for (const entry of leagues) {
          const league = mergeFragments((entry as Record<string, unknown>)['league']);
          const key = asString(league['league_key']);
          if (key === '') continue;

          refs.push({
            platform: 'yahoo',
            platformLeagueId: key,
            name: asString(league['name'], 'Yahoo league'),
            season: asNumber(league['season'], season),
          });
        }
      }
    }

    return refs;
  }

  async loadSnapshot(platformLeagueId: string, asOfWeek?: number): Promise<LeagueSnapshot> {
    const [settingsPayload, standingsPayload] = await Promise.all([
      this.client.get<Record<string, unknown>>(`/league/${platformLeagueId}/settings`),
      this.client.get<Record<string, unknown>>(`/league/${platformLeagueId}/standings`),
    ]);

    const leagueNode = mergeFragments(
      (settingsPayload['fantasy_content'] as Record<string, unknown>)?.['league'],
    );
    const settings = mergeFragments(leagueNode['settings']);

    const currentWeek = asOfWeek ?? asNumber(leagueNode['current_week'], 1);
    const playoffStartWeek = asNumber(settings['playoff_start_week'], 15);

    const rosterSlots: LineupSlot[] = [];
    for (const entry of collection(settings['roster_positions'])) {
      const position = mergeFragments((entry as Record<string, unknown>)['roster_position']);
      const slot = toSlot(asString(position['position']));
      const count = asNumber(position['count'], 1);
      for (let i = 0; i < count; i += 1) rosterSlots.push(slot);
    }

    const league: League = {
      id: `yahoo:${platformLeagueId}`,
      platform: 'yahoo',
      platformLeagueId,
      name: asString(leagueNode['name'], 'Yahoo league'),
      season: asNumber(leagueNode['season']),
      format: toFormat(settings),
      teamCount: asNumber(leagueNode['num_teams']),
      rosterSlots,
      scoring: toScoring(settings['stat_modifiers']),
      playoffTeams: asNumber(settings['num_playoff_teams'], 6),
      playoffStartWeek,
      regularSeasonWeeks: Math.max(1, playoffStartWeek - 1),
      // Yahoo has no median-win format.
      medianWins: false,
      superFlex: rosterSlots.includes('SUPER_FLEX'),
    };

    const { managers, rosters, records } = this.#parseStandings(standingsPayload);

    // Rosters and matchups are per-team and per-week requests. Fetch the ones we
    // need concurrently rather than serially, which is the difference between a
    // snapshot taking one second and thirty.
    const weeks = Array.from({ length: league.regularSeasonWeeks }, (_, i) => i + 1);
    const scoreboards = await Promise.all(
      weeks.map((week) =>
        this.client
          .get<Record<string, unknown>>(`/league/${platformLeagueId}/scoreboard;week=${week}`)
          .catch(() => null),
      ),
    );

    const schedule: Matchup[] = [];
    const weeklyScores: WeeklyScore[] = [];

    scoreboards.forEach((payload, index) => {
      if (payload === null) return;
      const week = weeks[index]!;
      const parsed = this.#parseScoreboard(payload, week);
      schedule.push(...parsed.matchups);
      weeklyScores.push(...parsed.scores);
    });

    return {
      league,
      asOfWeek: currentWeek,
      managers,
      rosters,
      records,
      schedule,
      weeklyScores,
      // Yahoo transactions and traded picks are separate endpoints; dynasty pick
      // trading is rare on the platform, so they are fetched on demand instead
      // of on every snapshot.
      transactions: [],
      draftPicks: [],
    };
  }

  #parseStandings(payload: Record<string, unknown>): {
    managers: Manager[];
    rosters: Roster[];
    records: TeamRecord[];
  } {
    const leagueNode = mergeFragments((payload['fantasy_content'] as Record<string, unknown>)?.['league']);
    const standings = mergeFragments(leagueNode['standings']);

    const managers: Manager[] = [];
    const rosters: Roster[] = [];
    const records: TeamRecord[] = [];

    for (const entry of collection(standings['teams'])) {
      const team = mergeFragments((entry as Record<string, unknown>)['team']);
      const teamId = asString(team['team_key']);
      if (teamId === '') continue;

      const standing = mergeFragments(team['team_standings']);
      const outcome = mergeFragments(standing['outcome_totals']);
      const managerList = collection(team['managers']);
      const firstManager = mergeFragments((managerList[0] as Record<string, unknown>)?.['manager']);

      managers.push({
        id: teamId,
        displayName: asString(firstManager['nickname'], 'Manager'),
        teamName: asString(team['name'], 'Team'),
        platformUserId: asString(firstManager['guid'], '') || null,
        // Yahoo exposes multiple managers per team but no co-owner distinction.
        coOwnerUserIds: managerList
          .slice(1)
          .map((m) => asString(mergeFragments((m as Record<string, unknown>)['manager'])['guid']))
          .filter((guid) => guid !== ''),
      });

      rosters.push({
        teamId,
        managerId: teamId,
        // Rosters come from a separate endpoint; filled by loadRosters when needed.
        playerIds: [],
        starterIds: [],
        taxiIds: [],
        irIds: [],
      });

      records.push({
        teamId,
        wins: asNumber(outcome['wins']),
        losses: asNumber(outcome['losses']),
        ties: asNumber(outcome['ties']),
        pointsFor: asNumber(standing['points_for']),
        pointsAgainst: asNumber(standing['points_against']),
      });
    }

    return { managers, rosters, records };
  }

  #parseScoreboard(
    payload: Record<string, unknown>,
    week: number,
  ): { matchups: Matchup[]; scores: WeeklyScore[] } {
    const leagueNode = mergeFragments((payload['fantasy_content'] as Record<string, unknown>)?.['league']);
    const scoreboard = mergeFragments(leagueNode['scoreboard']);

    const matchups: Matchup[] = [];
    const scores: WeeklyScore[] = [];

    collection(scoreboard['matchups']).forEach((entry, index) => {
      const matchup = mergeFragments((entry as Record<string, unknown>)['matchup']);
      const teams = collection(matchup['teams']).map((teamEntry) =>
        mergeFragments((teamEntry as Record<string, unknown>)['team']),
      );

      const [home, away] = teams;
      if (home === undefined || away === undefined) return;

      const keyOf = (team: Record<string, unknown>) => asString(team['team_key']);
      const pointsOf = (team: Record<string, unknown>) =>
        asNumber(mergeFragments(team['team_points'])['total'], 0);

      const played = asString(matchup['status']) === 'postevent';

      matchups.push({
        week,
        matchupId: `${week}:${index}`,
        teamIds: [keyOf(home), keyOf(away)],
        points: played ? [pointsOf(home), pointsOf(away)] : [null, null],
        playerPoints: {},
      });

      for (const team of [home, away]) {
        scores.push({
          week,
          teamId: keyOf(team),
          points: pointsOf(team),
          playerPoints: {},
          played,
        });
      }
    });

    return { matchups, scores };
  }

  /** Rosters live behind their own endpoint, one call per team per week. */
  async loadRosters(platformLeagueId: string, teamKeys: readonly string[], week: number): Promise<Roster[]> {
    const payloads = await Promise.all(
      teamKeys.map((key) =>
        this.client.get<Record<string, unknown>>(`/team/${key}/roster;week=${week}`).catch(() => null),
      ),
    );

    return payloads.flatMap((payload, index): Roster[] => {
      if (payload === null) return [];
      const teamId = teamKeys[index]!;

      const team = mergeFragments((payload['fantasy_content'] as Record<string, unknown>)?.['team']);
      const roster = mergeFragments(team['roster']);

      const playerIds: string[] = [];
      const starterIds: string[] = [];
      const irIds: string[] = [];

      for (const entry of collection(roster['players'])) {
        const player = mergeFragments((entry as Record<string, unknown>)['player']);
        const playerId = asString(player['player_id']);
        if (playerId === '') continue;

        playerIds.push(playerId);

        const selected = mergeFragments(player['selected_position']);
        const slot = asString(selected['position']);
        if (slot === 'IR' || slot === 'IR+') irIds.push(playerId);
        else if (slot !== 'BN') starterIds.push(playerId);
      }

      return [
        {
          teamId,
          managerId: teamId,
          playerIds: playerIds.map(asPlayerId),
          starterIds: starterIds.map(asPlayerId),
          taxiIds: [],
          irIds: irIds.map(asPlayerId),
        },
      ];
    });
  }
}
