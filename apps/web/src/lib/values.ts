import type { LeagueFormat } from '@ffe/core';

/**
 * Market values — an OPTIONAL sanity comparison, never a dependency.
 *
 * The model prices players itself (lib/edge-values.ts); every decision path —
 * trades, waivers, dynasty, picks — runs on that internal price. What remains
 * here is the outside view: FantasyCalc computes values from real trades
 * executed in real Sleeper leagues, which makes it a market price rather than
 * one analyst's opinion. That is useful as a calibration check ("does the
 * model's ordering look like the market's, and where do they disagree?") and
 * as display context on the player page, and for nothing else. If this feed is
 * down, nothing on the product degrades.
 *
 * Values are format-specific: a 24-year-old receiver is worth far more in
 * dynasty than in redraft, and superflex reprices every quarterback in the
 * league, so the league's own settings select the variant.
 */

const API = 'https://api.fantasycalc.com/values/current';

export interface MarketValue {
  readonly sleeperId: string;
  readonly name: string;
  readonly position: string;
  readonly value: number;
  readonly overallRank: number;
  /** Percent of leagues rostering the player, when FantasyCalc reports it. */
  readonly rosteredPct: number | null;
}

interface RawValue {
  readonly player: {
    readonly sleeperId?: number | string | null;
    readonly name?: string;
    readonly position?: string;
  };
  readonly value: number;
  readonly overallRank: number;
  readonly maybeRosterPercent?: number | null;
}

export interface MarketData {
  readonly players: Map<string, MarketValue>;
  /** Draft picks, keyed by their market label ("2027 1st (Early)"). */
  readonly picks: Map<string, number>;
}

export interface MarketQueryOptions {
  /** Number of teams in the actual league, not a hard-coded 12-team default. */
  readonly teamCount?: number;
  /** League reception scoring: 0, 0.5, or 1 in the common formats. */
  readonly ppr?: number;
}

/**
 * Cached for an hour: the market moves, but not minute to minute.
 *
 * One entry per variant rather than one entry total — a manager with a dynasty
 * superflex league and a redraft league in the same session would otherwise
 * evict and re-fetch the whole price list on every navigation between them.
 */
const cache = new Map<string, { at: number; data: MarketData }>();
const CACHE_MS = 60 * 60 * 1000;

export const loadMarketData = async (
  format: LeagueFormat,
  superFlex: boolean,
  options: MarketQueryOptions = {},
): Promise<MarketData> => {
  const isDynasty = format === 'dynasty' || format === 'keeper';
  const numQbs = superFlex ? 2 : 1;
  const numTeams = Math.max(2, Math.min(32, Math.round(options.teamCount ?? 12)));
  const ppr = Math.max(0, Math.min(1, options.ppr ?? 1));
  const key = `${isDynasty}-${numQbs}-${numTeams}-${ppr}`;

  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.data;

  const url = `${API}?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);

  if (response === null || !response.ok) {
    // A missing market is a degraded experience, not a broken page: odds still
    // work, only the fairness check goes quiet. Stale prices beat none.
    return hit?.data ?? { players: new Map(), picks: new Map() };
  }

  const raw = (await response.json()) as RawValue[];
  const players = new Map<string, MarketValue>();
  const picks = new Map<string, number>();

  for (const entry of raw) {
    const name = entry.player.name ?? '';
    const sleeperId = entry.player.sleeperId;

    // Picks are carried in the same feed with synthetic ids (DP_/FP_ prefixes)
    // and are keyed by label, since that is how a pick is identified.
    if (typeof sleeperId === 'string' && /^(DP|FP)_/.test(sleeperId)) {
      picks.set(name, entry.value);
      continue;
    }

    if (sleeperId === undefined || sleeperId === null) continue;

    players.set(String(sleeperId), {
      sleeperId: String(sleeperId),
      name,
      position: entry.player.position ?? '',
      value: entry.value,
      overallRank: entry.overallRank,
      rosteredPct: entry.maybeRosterPercent ?? null,
    });
  }

  const data: MarketData = { players, picks };
  cache.set(key, { at: Date.now(), data });
  return data;
};

/** Player values only, for callers that don't deal in picks. */
export const loadMarketValues = async (
  format: LeagueFormat,
  superFlex: boolean,
  options: MarketQueryOptions = {},
): Promise<Map<string, MarketValue>> => (await loadMarketData(format, superFlex, options)).players;
