import {
  optimalLineup,
  asPlayerId,
  SLOT_ELIGIBILITY,
  type LineupCandidate,
  type LineupSlot,
  type Position,
} from '@ffe/core';

/**
 * A roster in the order the manager actually reads it.
 *
 * Every page that lists your players was sorting by projected points, which is
 * a ranking rather than a roster. A manager does not think "my highest scorer,
 * then my second highest" — he thinks in slots: quarterback, two backs, three
 * receivers, tight end, the flexes, then the bench. Sorting by points scatters
 * the positions and buries the flex decision, which is the one place a lineup
 * page has anything interesting to say.
 *
 * So the order here is the league's own `rosterSlots`, filled optimally, then
 * the bench beneath it. Slots come from the league, not a constant, because
 * these leagues genuinely differ — one is superflex, one runs IDP — and a
 * hard-coded QB/RB/RB/WR order would be wrong in two of the three.
 *
 * The second thing this buys is that the lineup page and the scheme page stop
 * disagreeing. Both were computing "what is this player being started over",
 * and computing it differently: one against the optimal lineup, one against the
 * next man at his position. Two numbers, both defensible, contradicting each
 * other across a tab. Now there is one, and it lives here.
 */

export interface OrderedPlayer {
  readonly playerId: string;
  readonly slot: LineupSlot;
  /** Display label for the slot — `RB1`, `RB2`, `FLEX`, `BN`. */
  readonly slotLabel: string;
  readonly position: string;
  readonly projected: number;
  readonly sd: number;
  readonly starting: boolean;
}

export interface SlotAlternative {
  readonly playerId: string;
  readonly margin: number;
}

export interface RosterOrder {
  readonly rows: readonly OrderedPlayer[];
  /**
   * The best benched player eligible for a starter's slot, and by how much the
   * starter beats him. Null where the bench has nobody who could fill in.
   */
  readonly alternativeFor: (playerId: string) => SlotAlternative | null;
}

export interface OrderInput {
  readonly playerId: string;
  readonly position: string;
  readonly projected: number;
  readonly sd: number;
}

/**
 * Number the repeats.
 *
 * Three receiver slots rendered as three rows all labelled "WR" reads as a
 * mistake even when it is correct. `WR1/WR2/WR3` is what a lineup screen shows
 * and what a manager says out loud. Singletons keep their bare name — "QB1" on
 * a roster with one quarterback is noise.
 */
const labelSlots = (slots: readonly LineupSlot[]): string[] => {
  const totals = new Map<LineupSlot, number>();
  for (const slot of slots) totals.set(slot, (totals.get(slot) ?? 0) + 1);

  const seen = new Map<LineupSlot, number>();
  return slots.map((slot) => {
    const index = (seen.get(slot) ?? 0) + 1;
    seen.set(slot, index);
    return (totals.get(slot) ?? 0) > 1 ? `${slot}${index}` : slot;
  });
};

export const orderRoster = (
  candidates: readonly OrderInput[],
  rosterSlots: readonly LineupSlot[],
): RosterOrder => {
  const byId = new Map(candidates.map((entry) => [entry.playerId, entry]));

  const lineupInput: LineupCandidate[] = candidates.map((entry) => ({
    playerId: asPlayerId(entry.playerId),
    position: entry.position as Position,
    eligiblePositions: [entry.position as Position],
    projectedPoints: entry.projected,
    stddev: entry.sd,
  }));

  const lineup = optimalLineup(lineupInput, rosterSlots);
  const labels = labelSlots(lineup.slots.map((slot) => slot.slot));

  const rows: OrderedPlayer[] = [];
  const started = new Set<string>();

  lineup.slots.forEach((slot, index) => {
    if (slot.playerId === null) return;
    const id = String(slot.playerId);
    const entry = byId.get(id);
    if (entry === undefined) return;

    started.add(id);
    rows.push({
      playerId: id,
      slot: slot.slot,
      slotLabel: labels[index] ?? slot.slot,
      position: entry.position,
      projected: entry.projected,
      sd: entry.sd,
      starting: true,
    });
  });

  // Bench in descending projection: there is no slot order to respect down
  // here, and the useful question on a bench is who is closest to playing.
  const bench = candidates
    .filter((entry) => !started.has(entry.playerId))
    .sort((a, b) => b.projected - a.projected);

  for (const entry of bench) {
    rows.push({
      playerId: entry.playerId,
      slot: 'BN',
      slotLabel: 'BN',
      position: entry.position,
      projected: entry.projected,
      sd: entry.sd,
      starting: false,
    });
  }

  const benchIds = new Set(bench.map((entry) => entry.playerId));

  const alternativeFor = (playerId: string): SlotAlternative | null => {
    const row = rows.find((candidate) => candidate.playerId === playerId);
    if (row === undefined || !row.starting) return null;

    const eligible = SLOT_ELIGIBILITY[row.slot];
    if (eligible === null || eligible === undefined) return null;

    const best = candidates
      .filter(
        (entry) => benchIds.has(entry.playerId) && eligible.includes(entry.position as Position),
      )
      .sort((a, b) => b.projected - a.projected)[0];

    return best === undefined
      ? null
      : { playerId: best.playerId, margin: row.projected - best.projected };
  };

  return { rows, alternativeFor };
};
