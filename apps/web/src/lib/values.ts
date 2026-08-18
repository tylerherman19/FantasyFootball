import type { LeagueFormat } from '@ffe/core';

/**
 * Market values.
 *
 * FantasyCalc computes these from real trades executed in real Sleeper leagues,
 * which makes them a market price rather than one analyst's opinion. That is the
 * "will they accept" half of a trade — the half our simulation cannot answer,
 * because a manager's willingness depends on consensus, not on our model.
 *
 * Values are format-specific: a 24-year-old receiver is worth far more in
 * dynasty than in redraft, and superflex reprices every quarterback in the
 * league. Fetching the wrong variant produces confidently wrong fairness
 * judgements, so the league's own settings select it.
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

/** Cached for an hour: the market moves, but not minute to minute. */
let cache: { key: string; at: number; values: Map<string, MarketValue> } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export const loadMarketValues = async (
  format: LeagueFormat,
  superFlex: boolean,
): Promise<Map<string, MarketValue>> => {
  const isDynasty = format === 'dynasty' || format === 'keeper';
  const numQbs = superFlex ? 2 : 1;
  const key = `${isDynasty}-${numQbs}`;

  if (cache !== null && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.values;
  }

  const url = `${API}?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=12&ppr=1`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    // A missing market is a degraded experience, not a broken page: odds still
    // work, only the fairness check goes quiet.
    return cache?.values ?? new Map();
  }

  const raw = (await response.json()) as RawValue[];
  const values = new Map<string, MarketValue>();

  for (const entry of raw) {
    const sleeperId = entry.player.sleeperId;
    if (sleeperId === undefined || sleeperId === null) continue;

    values.set(String(sleeperId), {
      sleeperId: String(sleeperId),
      name: entry.player.name ?? '',
      position: entry.player.position ?? '',
      value: entry.value,
      overallRank: entry.overallRank,
      rosteredPct: entry.maybeRosterPercent ?? null,
    });
  }

  cache = { key, at: Date.now(), values };
  return values;
};
