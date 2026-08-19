'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from '@/app/actions';

/**
 * Naming yourself, which is all Sleeper requires.
 *
 * The season picker sits next to the username on purpose. "No leagues found"
 * is almost always a season problem rather than a name problem — Sleeper rolls
 * leagues over in the winter, so a handle that works perfectly returns nothing
 * for the year you assumed — and the fix has to be reachable from the error.
 */

const seasons = (): number[] => {
  const now = new Date();
  const latest = now.getMonth() < 6 ? now.getFullYear() : now.getFullYear() + 1;
  return Array.from({ length: 6 }, (_, index) => latest - index);
};

const initial: SignInState = { error: null };

export const SignIn = ({ defaultSeason }: { defaultSeason: number }) => {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="panel p-5" style={{ boxShadow: 'var(--shadow)' }}>
      <label htmlFor="username" className="eyebrow">
        Sleeper username
      </label>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="username"
          name="username"
          defaultValue={state.username ?? ''}
          placeholder="your Sleeper handle"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="min-w-0 flex-1 rounded px-3 py-2 text-sm outline-none"
          style={{
            background: 'var(--surface-sunk)',
            border: '1px solid var(--rule-strong)',
            color: 'var(--ink)',
          }}
        />

        <select
          name="season"
          defaultValue={state.season ?? defaultSeason}
          aria-label="Season"
          className="rounded px-2 py-2 text-sm outline-none"
          style={{
            background: 'var(--surface-sunk)',
            border: '1px solid var(--rule-strong)',
            color: 'var(--ink)',
          }}
        >
          {seasons().map((season) => (
            <option key={season} value={season}>
              {season}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={pending}
          className="rounded px-4 py-2 text-sm font-semibold transition-opacity disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          {pending ? 'Looking…' : 'Load leagues'}
        </button>
      </div>

      {state.error !== null && (
        <p
          className="mt-3 rounded px-3 py-2 text-sm"
          style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
          role="alert"
        >
          {state.error}
        </p>
      )}

      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        No password — Sleeper&apos;s league data is public, so your username is enough to read it.
        Nothing is written back to your account, and nothing here can act on your behalf.
      </p>
    </form>
  );
};
