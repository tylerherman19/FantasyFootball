'use client';

import { useMemo, useState, useTransition } from 'react';
import { SLOT_ELIGIBILITY, type LineupSlot, type Position } from '@ffe/core';
import { evaluateSwapClient, type SwapVerdict } from '@/lib/client-sim';
import type { WireLeague } from '@/lib/serialize';

/**
 * Lineup, with every start/sit decision priced.
 *
 * The optimal lineup is solved server-side, but the useful part is what happens
 * when you disagree with it. Selecting a starter shows the bench players who
 * could legally take that slot and what each swap does to your title odds —
 * including, often, that it does nothing worth thinking about.
 */

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

export interface LineupSlotView {
  readonly slot: string;
  readonly playerId: string | null;
  readonly name: string;
  readonly position: string;
  readonly team: string;
  readonly projected: number;
  readonly sd: number;
  readonly injuryStatus: string | null;
}

export const LineupBoard = ({
  league,
  myTeamId,
  slots,
  bench,
}: {
  league: WireLeague;
  myTeamId: string;
  slots: readonly LineupSlotView[];
  bench: readonly LineupSlotView[];
}) => {
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, SwapVerdict>>({});
  const [pending, startTransition] = useTransition();

  const active = selectedSlot === null ? null : slots[selectedSlot] ?? null;

  /** Bench players who could legally fill the selected slot. */
  const alternatives = useMemo(() => {
    if (active === null) return [];
    const eligible = SLOT_ELIGIBILITY[active.slot as LineupSlot];
    if (eligible === null || eligible === undefined) return [];
    return bench.filter((player) => eligible.includes(player.position as Position));
  }, [active, bench]);

  const evaluate = (challenger: LineupSlotView) => {
    if (active === null || active.playerId === null || challenger.playerId === null) return;
    const key = `${active.playerId}:${challenger.playerId}`;

    startTransition(() => {
      const verdict = evaluateSwapClient(league, myTeamId, active.playerId!, challenger.playerId!);
      setVerdicts((current) => ({ ...current, [key]: verdict }));
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
          Optimal lineup — tap a slot to test alternatives
        </h2>

        <ul className="rounded border" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
          {slots.map((slot, index) => {
            const isSelected = selectedSlot === index;
            return (
              <li key={`${slot.slot}-${index}`} className="border-b last:border-b-0" style={{ borderColor: 'var(--rule)' }}>
                <button
                  type="button"
                  onClick={() => setSelectedSlot(isSelected ? null : index)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm"
                  style={{ background: isSelected ? 'var(--surface-sunk)' : 'transparent' }}
                >
                  <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-widest"
                    style={{ color: 'var(--ink-faint)' }}>
                    {slot.slot}
                  </span>
                  <span className="flex-1 truncate">
                    <span className="font-medium">{slot.name}</span>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {slot.position} {slot.team}
                    </span>
                    {slot.injuryStatus !== null && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--neg)' }}>
                        {slot.injuryStatus}
                      </span>
                    )}
                  </span>
                  <span className="tabular shrink-0 text-right">
                    <span className="font-medium">{slot.projected.toFixed(1)}</span>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {Math.max(0, slot.projected - slot.sd).toFixed(0)}–{(slot.projected + slot.sd).toFixed(0)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
          {active === null ? 'Alternatives' : `Instead of ${active.name}`}
        </h2>

        {active === null && (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Select a lineup slot to see which bench players could legally fill it and what each swap
            does to your championship odds.
          </p>
        )}

        {active !== null && alternatives.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Nobody on your bench is eligible for {active.slot}. There is no decision to make here.
          </p>
        )}

        {active !== null && alternatives.length > 0 && (
          <ul className="space-y-2">
            {alternatives.map((challenger) => {
              const key = `${active.playerId}:${challenger.playerId}`;
              const verdict = verdicts[key];

              return (
                <li key={challenger.playerId ?? challenger.name}
                  className="rounded border p-3"
                  style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm">
                      <span className="font-medium">{challenger.name}</span>
                      <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {challenger.position} {challenger.team}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-sm" style={{ color: 'var(--ink-muted)' }}>
                      {challenger.projected.toFixed(1)}
                    </span>
                  </div>

                  {verdict === undefined ? (
                    <button
                      type="button"
                      onClick={() => evaluate(challenger)}
                      disabled={pending}
                      className="mt-2 rounded px-2 py-1 text-xs font-medium disabled:opacity-40"
                      style={{ background: 'var(--ground)', color: 'var(--ink)', border: '1px solid var(--rule-strong)' }}
                    >
                      {pending ? 'Simulating…' : 'Price this swap'}
                    </button>
                  ) : (
                    <div className="mt-2">
                      <div className="flex flex-wrap gap-x-4 text-xs">
                        <span>
                          <span style={{ color: 'var(--ink-faint)' }}>Title </span>
                          <strong className="tabular"
                            style={{
                              color: verdict.negligible
                                ? 'var(--ink-muted)'
                                : verdict.titleDelta > 0
                                  ? 'var(--pos)'
                                  : 'var(--neg)',
                            }}>
                            {pct(verdict.titleDelta)}
                          </strong>
                        </span>
                        <span>
                          <span style={{ color: 'var(--ink-faint)' }}>Playoffs </span>
                          <strong className="tabular" style={{ color: 'var(--ink-muted)' }}>
                            {pct(verdict.playoffDelta)}
                          </strong>
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                        {verdict.explanation}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
