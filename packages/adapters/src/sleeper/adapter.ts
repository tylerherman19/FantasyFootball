import {
  asPlayerId,
  type DraftPickAsset,
  type League,
  type LeagueFormat,
  type LeagueSnapshot,
  type LineupSlot,
  type Manager,
  type Matchup,
  type Roster,
  type ScoringRules,
  type TeamRecord,
  type Transaction,
  type TransactionKind,
  type WeeklyScore,
} from '@ffe/core/domain';
import { AdapterError, type LeagueRef, type PlatformAdapter } from '../platform-adapter.js';
import {
  SleeperClient,
  type SleeperLeague,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
  type SleeperTransaction,
} from './client.js';

/** Sleeper's slot names happen to line up with ours except for a couple of aliases. */
const SLOT_MAP: Readonly<Record<string, LineupSlot>> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DEF: 'DEF',
  FLEX: 'FLEX',
  WRRB_FLEX: 'WRRB_FLEX',
  REC_FLEX: 'REC_FLEX',
  SUPER_FLEX: 'SUPER_FLEX',
  DL: 'DL',
  LB: 'LB',
  DB: 'DB',
  IDP_FLEX: 'IDP_FLEX',
  BN: 'BN',
  IR: 'IR',
  TAXI: 'TAXI',
};

const toSlot = (raw: string): LineupSlot => {
  const slot = SLOT_MAP[raw];
  if (slot === undefined) throw new AdapterError('Unknown Sleeper roster slot', { raw });
  return slot;
};

/**
 * Sleeper stores league type in `settings.type`: 0 redraft, 1 keeper, 2 dynasty,
 * 3 guillotine. Missing means redraft — plenty of old leagues predate the field.
 * Some guillotine leagues only set `last_chopped_leg`, so we check both.
 */
export const toFormat = (league: SleeperLeague): LeagueFormat => {
  if (league.settings.type === 3 || league.settings.last_chopped_leg !== undefined) return 'guillotine';
  switch (league.settings.type) {
    case 2:
      return 'dynasty';
    case 1:
      return 'keeper';
    default:
      return 'redraft';
  }
};

/**
 * How many weeks are actually scored.
 *
 * Normal leagues: everything before the playoffs. Guillotine leagues have no
 * playoffs at all — `playoff_week_start` is 0 — and run until the last chop,
 * so a naive `playoffStartWeek - 1` yields -1 and silently fetches no matchups.
 */
export const regularSeasonWeeks = (league: SleeperLeague): number => {
  const playoffStart = league.settings.playoff_week_start ?? 0;
  if (playoffStart > 0) return playoffStart - 1;

  const lastChop = league.settings.last_chopped_leg;
  if (lastChop !== undefined && lastChop > 0) return lastChop;

  return 17;
};

const toScoring = (raw: Readonly<Record<string, number>>): ScoringRules => {
  const known = new Set(['rec', 'pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec_yd', 'rec_td', 'fum_lost']);
  const extra: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) extra[key] = value;
  }

  return {
    rec: raw.rec ?? 0,
    passYd: raw.pass_yd ?? 0,
    passTd: raw.pass_td ?? 0,
    passInt: raw.pass_int ?? 0,
    rushYd: raw.rush_yd ?? 0,
    rushTd: raw.rush_td ?? 0,
    recYd: raw.rec_yd ?? 0,
    recTd: raw.rec_td ?? 0,
    fumbleLost: raw.fum_lost ?? 0,
    extra,
  };
};

const toTransactionKind = (raw: string): TransactionKind => {
  switch (raw) {
    case 'trade':
      return 'trade';
    case 'waiver':
      return 'waiver';
    case 'free_agent':
      return 'free_agent';
    default:
      return 'commissioner';
  }
};

/**
 * Which week the simulation should start from.
 *
 * Sleeper's `state.week` counts preseason weeks too, so in August it happily
 * reports week 2 of a season that hasn't kicked off. Starting a season sim from
 * "week 2" then silently skips week 1 — so preseason and offseason both mean
 * "start from week 1".
 */
export const currentWeekFor = (
  league: Pick<League, 'season' | 'regularSeasonWeeks'>,
  state: { season: string; week: number; season_type: string },
): number => {
  if (Number(league.season) !== Number(state.season)) return league.regularSeasonWeeks;
  if (state.season_type !== 'regular') return 1;
  return Math.max(1, state.week);
};

/** Sleeper reports points as an int part plus a decimal part in roster settings. */
const combineFpts = (whole: number | undefined, decimal: number | undefined): number =>
  (whole ?? 0) + (decimal ?? 0) / 100;

export class SleeperAdapter implements PlatformAdapter {
  readonly platform = 'sleeper' as const;
  readonly #client: SleeperClient;
  readonly #userIds = new Map<string, string>();

  constructor(client: SleeperClient = new SleeperClient()) {
    this.#client = client;
  }

  /** Resolve a username to the platform's account id. Cached per adapter. */
  async resolveUserId(userHandle: string): Promise<string> {
    const cached = this.#userIds.get(userHandle.toLowerCase());
    if (cached !== undefined) return cached;

    const user = await this.#client.getUser(userHandle);
    this.#userIds.set(userHandle.toLowerCase(), user.user_id);
    return user.user_id;
  }

  async listLeagues(userHandle: string, season: number): Promise<LeagueRef[]> {
    const user = await this.#client.getUser(userHandle);
    const leagues = await this.#client.getUserLeagues(user.user_id, season);

    return leagues.map((l) => ({
      platform: 'sleeper' as const,
      platformLeagueId: l.league_id,
      name: l.name,
      season: Number(l.season),
    }));
  }

  async loadSnapshot(platformLeagueId: string, asOfWeek?: number): Promise<LeagueSnapshot> {
    const [raw, rosters, users, state, tradedPicks] = await Promise.all([
      this.#client.getLeague(platformLeagueId),
      this.#client.getRosters(platformLeagueId),
      this.#client.getLeagueUsers(platformLeagueId),
      this.#client.getNflState(),
      this.#client.getTradedPicks(platformLeagueId),
    ]);

    const league = this.#toLeague(raw);
    const currentWeek = asOfWeek ?? currentWeekFor(league, state);

    // Sleeper exposes matchups and transactions one week at a time. Fetch the
    // full regular season plus playoff weeks in parallel, bounded by the
    // client's concurrency cap.
    const weeks = Array.from({ length: league.regularSeasonWeeks }, (_, i) => i + 1);
    const [weeklyMatchups, weeklyTransactions] = await Promise.all([
      Promise.all(weeks.map((w) => this.#client.getMatchups(platformLeagueId, w))),
      Promise.all(weeks.map((w) => this.#client.getTransactions(platformLeagueId, w))),
    ]);

    const rosterIdToTeamId = new Map(rosters.map((r) => [r.roster_id, String(r.roster_id)]));

    return {
      league,
      asOfWeek: currentWeek,
      managers: this.#toManagers(users, rosters),
      rosters: rosters.map(toRoster),
      records: rosters.map(toRecord),
      schedule: weeklyMatchups.flatMap((weekRows, i) => toMatchups(weekRows, i + 1, rosterIdToTeamId)),
      weeklyScores: weeklyMatchups.flatMap((weekRows, i) => toWeeklyScores(weekRows, i + 1, rosterIdToTeamId)),
      transactions: weeklyTransactions.flatMap((weekRows, i) => weekRows.map((t) => toTransaction(t, i + 1))),
      draftPicks: tradedPicks.map(
        (p): DraftPickAsset => ({
          season: Number(p.season),
          round: p.round,
          originalTeamId: String(p.roster_id),
          ownerTeamId: String(p.owner_id),
        }),
      ),
    };
  }

  #toLeague(raw: SleeperLeague): League {
    const rosterSlots = raw.roster_positions.map(toSlot);
    const playoffStartWeek = raw.settings.playoff_week_start ?? 0;

    return {
      id: `sleeper:${raw.league_id}`,
      platform: 'sleeper',
      platformLeagueId: raw.league_id,
      name: raw.name,
      season: Number(raw.season),
      format: toFormat(raw),
      teamCount: raw.total_rosters,
      rosterSlots,
      scoring: toScoring(raw.scoring_settings),
      playoffTeams: raw.settings.playoff_teams ?? 6,
      playoffStartWeek,
      regularSeasonWeeks: regularSeasonWeeks(raw),
      medianWins: (raw.settings.league_average_match ?? 0) === 1,
      superFlex: rosterSlots.includes('SUPER_FLEX'),
    };
  }

  #toManagers(users: readonly SleeperLeagueUser[], rosters: readonly SleeperRoster[]): Manager[] {
    const byUserId = new Map(users.map((u) => [u.user_id, u]));

    return rosters.map((r) => {
      const user = r.owner_id === null ? undefined : byUserId.get(r.owner_id);
      return {
        id: String(r.roster_id),
        displayName: user?.display_name ?? 'Orphan team',
        teamName: user?.metadata?.team_name ?? user?.display_name ?? `Team ${r.roster_id}`,
        platformUserId: r.owner_id,
        coOwnerUserIds: r.co_owners ?? [],
      };
    });
  }
}

const toRoster = (r: SleeperRoster): Roster => ({
  teamId: String(r.roster_id),
  managerId: String(r.roster_id),
  playerIds: (r.players ?? []).map(asPlayerId),
  starterIds: (r.starters ?? []).filter((p) => p !== '0').map(asPlayerId),
  taxiIds: (r.taxi ?? []).map(asPlayerId),
  irIds: (r.reserve ?? []).map(asPlayerId),
});

const toRecord = (r: SleeperRoster): TeamRecord => ({
  teamId: String(r.roster_id),
  wins: r.settings.wins,
  losses: r.settings.losses,
  ties: r.settings.ties,
  pointsFor: combineFpts(r.settings.fpts, r.settings.fpts_decimal),
  pointsAgainst: combineFpts(r.settings.fpts_against, r.settings.fpts_against_decimal),
});

/**
 * Sleeper returns one row per team per week, paired by `matchup_id`. Rows with a
 * null matchup id are byes and are dropped rather than half-paired.
 */
const toMatchups = (rows: readonly SleeperMatchup[], week: number, teamIds: Map<number, string>): Matchup[] => {
  const byMatchupId = new Map<number, SleeperMatchup[]>();
  for (const row of rows) {
    if (row.matchup_id === null) continue;
    const bucket = byMatchupId.get(row.matchup_id) ?? [];
    bucket.push(row);
    byMatchupId.set(row.matchup_id, bucket);
  }

  const out: Matchup[] = [];
  for (const [matchupId, pair] of byMatchupId) {
    const [a, b] = pair;
    if (a === undefined || b === undefined) continue;

    const teamA = teamIds.get(a.roster_id) ?? String(a.roster_id);
    const teamB = teamIds.get(b.roster_id) ?? String(b.roster_id);

    out.push({
      week,
      matchupId: `${week}:${matchupId}`,
      teamIds: [teamA, teamB],
      points: [a.points, b.points],
      playerPoints: {
        [teamA]: a.players_points ?? {},
        [teamB]: b.players_points ?? {},
      },
    });
  }

  return out;
};

/**
 * Per-team weekly scores, kept separately from the pairing.
 *
 * Guillotine leagues return `matchup_id: null` for every row because nobody
 * plays anybody — so the schedule is legitimately empty and this is the only
 * record of what happened. Head-to-head leagues get it too, since lineup
 * efficiency and median-win scoring both need scores without pairings.
 *
 * Sleeper reports zeros rather than nulls for future weeks, so a week counts as
 * played only when some player actually scored.
 */
const toWeeklyScores = (rows: readonly SleeperMatchup[], week: number, teamIds: Map<number, string>): WeeklyScore[] =>
  rows.map((row) => {
    const playerPoints = row.players_points ?? {};
    return {
      week,
      teamId: teamIds.get(row.roster_id) ?? String(row.roster_id),
      points: row.points ?? 0,
      playerPoints,
      played: Object.values(playerPoints).some((p) => p !== 0),
    };
  });

const toTransaction = (t: SleeperTransaction, week: number): Transaction => {
  const adds: Record<string, ReturnType<typeof asPlayerId>[]> = {};
  const drops: Record<string, ReturnType<typeof asPlayerId>[]> = {};

  for (const [playerId, rosterId] of Object.entries(t.adds ?? {})) {
    (adds[String(rosterId)] ??= []).push(asPlayerId(playerId));
  }
  for (const [playerId, rosterId] of Object.entries(t.drops ?? {})) {
    (drops[String(rosterId)] ??= []).push(asPlayerId(playerId));
  }

  const bid = t.settings?.waiver_bid;
  const faabSpent: Record<string, number> =
    bid === undefined || t.roster_ids[0] === undefined ? {} : { [String(t.roster_ids[0])]: bid };

  return {
    id: t.transaction_id,
    kind: toTransactionKind(t.type),
    week,
    timestampMs: t.created,
    teamIds: t.roster_ids.map(String),
    adds,
    drops,
    faabSpent,
    draftPicks: t.draft_picks.map(
      (p): DraftPickAsset => ({
        season: Number(p.season),
        round: p.round,
        originalTeamId: String(p.roster_id),
        ownerTeamId: String(p.owner_id),
      }),
    ),
  };
};
