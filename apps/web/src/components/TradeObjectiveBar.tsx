'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const OBJECTIVES = [
  { key: 'balanced', label: 'Balanced', hint: 'Rank on title odds and starter points' },
  { key: 'winNow', label: 'Win now', hint: "Prefer this season's points and title odds" },
  { key: 'rebuild', label: 'Rebuild', hint: 'Prefer youth and model value' },
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

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());

    Object.entries(changes).forEach(([key, value]) => {
      if (value === '') next.delete(key);
      else next.set(key, value);
    });

    if (changes.pos !== undefined && changes.pos !== '') next.delete('target');
    if (changes.target !== undefined && changes.target !== '') next.delete('pos');

    const query = next.toString();
    router.push(query === '' ? pathname : pathname + '?' + query);
  };

  return (
    <section
      className="panel mb-8 p-4 sm:p-5"
      aria-label="Trade request"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--rule)' }}>
        <div>
          <div className="eyebrow mb-1">Trade request</div>
          <h2 className="text-lg font-semibold">What do you want to get?</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Choose a position for a target-first search, or name the exact player. The offer side
            will be generated for you.
          </p>
        </div>
        <div>
          <div className="eyebrow mb-1">Decision mode</div>
          <div className="flex" role="group" aria-label="Decision mode">
            {OBJECTIVES.map((option) => {
              const isActive = option.key === objective;
              return (
                <button
                  key={option.key}
                  type="button"
                  title={option.hint}
                  onClick={() =>
                    update({ objective: option.key === 'balanced' ? '' : option.key })
                  }
                  className="border px-3 py-2 text-xs font-semibold transition-colors"
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
      </div>

      <div className="grid gap-4 pt-4 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow mb-1 block">Get me a position</span>
          <select
            value={targetPosition}
            onChange={(event) => update({ pos: event.target.value, target: '' })}
            className="w-full border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <option value="">Any position</option>
            {POSITIONS.map((position) => (
              <option key={position} value={position}>
                {position}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="eyebrow mb-1 block">Or get this specific player</span>
          <select
            value={targetPlayer}
            onChange={(event) => update({ target: event.target.value, pos: '' })}
            className="w-full border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}
          >
            <option value="">Any player at the selected position</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name} · {player.position} · {player.teamName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs" style={{ borderColor: 'var(--rule)' }}>
        <span style={{ color: 'var(--ink-muted)' }}>
          {targetPlayer !== ''
            ? 'The exact player is locked as the acquisition target.'
            : targetPosition !== ''
              ? 'Every proposal below must acquire a ' + targetPosition + '.'
              : 'Choose a position to make the finder target-first.'}
        </span>
        {(targetPlayer !== '' || targetPosition !== '' || objective !== 'balanced') && (
          <button
            type="button"
            onClick={() => update({ target: '', pos: '', objective: '' })}
            className="font-semibold underline underline-offset-2"
          >
            Clear request
          </button>
        )}
      </div>
    </section>
  );
};
