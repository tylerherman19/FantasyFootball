'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * What the manager is trying to do, stated rather than inferred.
 *
 * The finder previously guessed intent from a depth heuristic, which is a weak
 * signal and was the reason it so often had nothing to say. A contender and a
 * rebuilding team want opposite trades from the same roster, and "get me this
 * specific player" is a question no heuristic can answer. Asking is better than
 * inferring, and the answer lives in the URL so a proposal can be shared.
 */

const OBJECTIVES = [
  { key: 'balanced', label: 'Balanced', hint: 'Rank on odds, then starter points' },
  { key: 'winNow', label: 'Win now', hint: 'Buy this season — points and title odds' },
  { key: 'rebuild', label: 'Rebuild', hint: 'Buy market value and youth; accept fewer points now' },
] as const;

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

export interface TargetablePlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly teamName: string;
}

export const TradeObjectiveBar = ({ players }: { readonly players: readonly TargetablePlayer[] }) => {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const objective = params.get('objective') ?? 'balanced';
  const targetPlayer = params.get('target') ?? '';
  const targetPosition = params.get('pos') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === '') next.delete(key);
    else next.set(key, value);

    // Targeting a specific player and a whole position at once is ambiguous, so
    // choosing one clears the other rather than silently ranking them.
    if (key === 'target' && value !== '') next.delete('pos');
    if (key === 'pos' && value !== '') next.delete('target');

    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div
      className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3 border-b pb-4"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div>
        <div className="kicker mb-1">Objective</div>
        <div className="flex">
          {OBJECTIVES.map((option) => {
            const isActive = option.key === objective;
            return (
              <button
                key={option.key}
                type="button"
                title={option.hint}
                onClick={() => setParam('objective', option.key === 'balanced' ? '' : option.key)}
                className="border px-3 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  borderColor: isActive ? 'var(--ink)' : 'var(--rule)',
                  background: isActive ? 'var(--ink)' : 'var(--surface)',
                  color: isActive ? '#fff' : 'var(--ink-muted)',
                  marginLeft: -1,
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="kicker mb-1">Target a player</div>
        <select
          value={targetPlayer}
          onChange={(event) => setParam('target', event.target.value)}
          className="border px-2 py-1.5 text-xs"
          style={{ borderColor: 'var(--rule)', background: 'var(--surface)', minWidth: '15rem' }}
        >
          <option value="">Anyone</option>
          {players.map((player) => (
            <option key={player.id} value={player.id}>
              {player.name} · {player.position} · {player.teamName}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="kicker mb-1">Or a position</div>
        <div className="flex">
          {POSITIONS.map((position) => {
            const isActive = position === targetPosition;
            return (
              <button
                key={position}
                type="button"
                onClick={() => setParam('pos', isActive ? '' : position)}
                className="border px-2.5 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  borderColor: isActive ? 'var(--ink)' : 'var(--rule)',
                  background: isActive ? 'var(--ink)' : 'var(--surface)',
                  color: isActive ? '#fff' : 'var(--ink-muted)',
                  marginLeft: -1,
                }}
              >
                {position}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
