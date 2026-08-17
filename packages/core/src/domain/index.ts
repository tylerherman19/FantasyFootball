/**
 * Platform-neutral domain model.
 *
 * Everything downstream (projections, sim, valuation, decisions) speaks only
 * these types. Sleeper and Yahoo are translated into this shape at the edge by
 * the adapters in @ffe/adapters, so the engine never learns which platform a
 * league came from.
 */

/** Our internal player id. Platform ids are mapped onto it via the crosswalk. */
export type PlayerId = string & { readonly __brand: 'PlayerId' };

export const asPlayerId = (raw: string): PlayerId => raw as PlayerId;

export type Platform = 'sleeper' | 'yahoo';

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | 'DL' | 'LB' | 'DB';

/** Individual defensive players. Separated because they price and project differently. */
export const IDP_POSITIONS: readonly Position[] = ['DL', 'LB', 'DB'];

/**
 * Lineup slots, normalized across platforms. Sleeper and Yahoo spell several of
 * these differently (Yahoo says `W/R/T`, Sleeper says `FLEX`); adapters map to
 * these names so the lineup solver only has one vocabulary.
 */
export type LineupSlot =
  | 'QB'
  | 'RB'
  | 'WR'
  | 'TE'
  | 'K'
  | 'DEF'
  | 'DL'
  | 'LB'
  | 'DB'
  | 'FLEX' // RB/WR/TE
  | 'WRRB_FLEX' // RB/WR
  | 'REC_FLEX' // WR/TE
  | 'SUPER_FLEX' // QB/RB/WR/TE
  | 'IDP_FLEX' // DL/LB/DB
  | 'BN'
  | 'IR'
  | 'TAXI';

/** Which positions may fill each starting slot. Bench-ish slots map to null. */
export const SLOT_ELIGIBILITY: Readonly<Record<LineupSlot, readonly Position[] | null>> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  BN: null,
  IR: null,
  TAXI: null,
} as const;

export const isStartingSlot = (slot: LineupSlot): boolean => SLOT_ELIGIBILITY[slot] !== null;

/**
 * League format. Drives which analyses are even meaningful: pick equity and
 * long-term windows matter in dynasty and are noise in redraft.
 *
 * `guillotine` is a genuinely different game — no playoffs, the lowest scorer is
 * eliminated each week and their roster returns to the pool. Playoff odds are
 * meaningless there; survival odds and the waiver pool are everything.
 */
export type LeagueFormat = 'dynasty' | 'keeper' | 'redraft' | 'guillotine';

export interface ScoringRules {
  /** Points per reception. 0 = standard, 0.5 = half-PPR, 1 = full PPR. */
  readonly rec: number;
  readonly passYd: number;
  readonly passTd: number;
  readonly passInt: number;
  readonly rushYd: number;
  readonly rushTd: number;
  readonly recYd: number;
  readonly recTd: number;
  readonly fumbleLost: number;
  /** Anything platform-specific we haven't modeled explicitly, keyed by raw stat name. */
  readonly extra: Readonly<Record<string, number>>;
}

export interface League {
  readonly id: string;
  readonly platform: Platform;
  /** Platform-native id, kept for API calls and debugging. */
  readonly platformLeagueId: string;
  readonly name: string;
  readonly season: number;
  readonly format: LeagueFormat;
  readonly teamCount: number;
  readonly rosterSlots: readonly LineupSlot[];
  readonly scoring: ScoringRules;
  readonly playoffTeams: number;
  readonly playoffStartWeek: number;
  readonly regularSeasonWeeks: number;
  /** Leagues where you also earn a win for beating the weekly median. */
  readonly medianWins: boolean;
  /** True when a QB can fill a flex slot — changes valuation more than anything else. */
  readonly superFlex: boolean;
}

export interface Manager {
  readonly id: string;
  readonly displayName: string;
  readonly teamName: string;
}

export interface Roster {
  readonly teamId: string;
  readonly managerId: string;
  readonly playerIds: readonly PlayerId[];
  readonly starterIds: readonly PlayerId[];
  readonly taxiIds: readonly PlayerId[];
  readonly irIds: readonly PlayerId[];
}

export interface TeamRecord {
  readonly teamId: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
}

export interface Matchup {
  readonly week: number;
  readonly matchupId: string;
  readonly teamIds: readonly [string, string];
  /** Null until the game is played. */
  readonly points: readonly [number | null, number | null];
  /** Per-player actual points, used to measure lineup efficiency after the fact. */
  readonly playerPoints: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export type TransactionKind = 'trade' | 'waiver' | 'free_agent' | 'commissioner';

export interface Transaction {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly week: number;
  readonly timestampMs: number;
  readonly teamIds: readonly string[];
  /** teamId -> players gained. */
  readonly adds: Readonly<Record<string, readonly PlayerId[]>>;
  /** teamId -> players lost. */
  readonly drops: Readonly<Record<string, readonly PlayerId[]>>;
  readonly faabSpent: Readonly<Record<string, number>>;
  readonly draftPicks: readonly DraftPickAsset[];
}

/** A future draft pick as a tradeable asset. */
export interface DraftPickAsset {
  readonly season: number;
  readonly round: number;
  /** Team the pick originally belonged to — determines how good it will be. */
  readonly originalTeamId: string;
  readonly ownerTeamId: string;
}

/**
 * One team's score in one week, independent of any pairing.
 *
 * Head-to-head leagues get this for free from the schedule, but guillotine
 * leagues have no pairings at all — every team scores against the field and the
 * lowest is eliminated — so the weekly score IS the game. Also what lineup
 * efficiency and median-win leagues are computed from.
 */
export interface WeeklyScore {
  readonly week: number;
  readonly teamId: string;
  readonly points: number;
  readonly playerPoints: Readonly<Record<string, number>>;
  /** False for weeks that haven't been played yet, where platforms report zeros. */
  readonly played: boolean;
}

/** A full league snapshot at a point in time. This is the sim's input. */
export interface LeagueSnapshot {
  readonly league: League;
  readonly asOfWeek: number;
  readonly managers: readonly Manager[];
  readonly rosters: readonly Roster[];
  readonly records: readonly TeamRecord[];
  /** Empty for guillotine leagues, which have no head-to-head pairings. */
  readonly schedule: readonly Matchup[];
  readonly weeklyScores: readonly WeeklyScore[];
  readonly transactions: readonly Transaction[];
  readonly draftPicks: readonly DraftPickAsset[];
}
