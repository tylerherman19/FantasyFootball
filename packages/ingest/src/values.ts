/**
 * Market value snapshots.
 *
 * Buy-low and sell-high are the most valuable signals in a dynasty league, and
 * both are differences over time: a player whose market price is falling while
 * his projection holds is the trade to make. Neither is computable from a single
 * reading, and nobody publishes yesterday's values — so the history only exists
 * if we start recording it.
 *
 * Same reasoning as the projection snapshots: the deadline-bound half is
 * capture, not analysis.
 */

const API = 'https://api.fantasycalc.com/values/current';

export interface ValueSnapshot {
  readonly sleeperId: string;
  readonly name: string;
  readonly position: string;
  readonly isDynasty: boolean;
  readonly superFlex: boolean;
  readonly value: number;
  readonly overallRank: number;
  readonly positionRank: number | null;
  readonly rosteredPct: number | null;
  readonly capturedAt: string;
}

interface RawValue {
  readonly player: {
    readonly sleeperId?: number | string | null;
    readonly name?: string;
    readonly position?: string;
  };
  readonly value: number;
  readonly overallRank: number;
  readonly positionRank?: number | null;
  readonly maybeRosterPercent?: number | null;
}

/**
 * Capture one market configuration.
 *
 * Dynasty and redraft price the same player very differently, and superflex
 * reprices every quarterback, so each combination is a separate series rather
 * than something to average.
 */
export const fetchValues = async (
  isDynasty: boolean,
  superFlex: boolean,
): Promise<ValueSnapshot[]> => {
  const url = `${API}?isDynasty=${isDynasty}&numQbs=${superFlex ? 2 : 1}&numTeams=12&ppr=1`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`FantasyCalc ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const raw = (await response.json()) as RawValue[];
  const capturedAt = new Date().toISOString();

  return raw.flatMap((entry): ValueSnapshot[] => {
    const sleeperId = entry.player.sleeperId;
    if (sleeperId === undefined || sleeperId === null) return [];

    return [
      {
        sleeperId: String(sleeperId),
        name: entry.player.name ?? '',
        position: entry.player.position ?? '',
        isDynasty,
        superFlex,
        value: entry.value,
        overallRank: entry.overallRank,
        positionRank: entry.positionRank ?? null,
        rosteredPct: entry.maybeRosterPercent ?? null,
        capturedAt,
      },
    ];
  });
};

/** Every configuration our leagues need, captured together. */
export const fetchAllValueConfigurations = async (): Promise<ValueSnapshot[]> => {
  const configurations: [boolean, boolean][] = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ];

  const results = await Promise.all(
    configurations.map(([isDynasty, superFlex]) => fetchValues(isDynasty, superFlex)),
  );

  return results.flat();
};
