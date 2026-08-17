import type { LeagueSnapshot, Platform } from '@ffe/core/domain';

/**
 * The seam between platforms and the engine.
 *
 * Sleeper implements this first; Yahoo drops in behind the same interface in
 * Phase 9 without the engine noticing. Anything platform-specific — pagination,
 * auth, weird slot names, ids — is absorbed here and never leaks past it.
 */
export interface PlatformAdapter {
  readonly platform: Platform;

  /** Leagues a user belongs to in a given season. */
  listLeagues(userHandle: string, season: number): Promise<LeagueRef[]>;

  /**
   * Everything the simulator needs for one league, as of a given week.
   * `asOfWeek` exists so backtests can reconstruct what was knowable then —
   * the same point-in-time discipline the feature store uses.
   */
  loadSnapshot(platformLeagueId: string, asOfWeek?: number): Promise<LeagueSnapshot>;
}

export interface LeagueRef {
  readonly platform: Platform;
  readonly platformLeagueId: string;
  readonly name: string;
  readonly season: number;
}

/** Thrown when a platform returns something we can't map. Never swallowed silently. */
export class AdapterError extends Error {
  constructor(
    override readonly message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
