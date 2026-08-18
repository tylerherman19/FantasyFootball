import Link from 'next/link';
import { listLeagues } from '@/lib/league-data';

export const dynamic = 'force-dynamic';

const USERNAME = process.env.SLEEPER_USERNAME ?? 'tylerherman';
const SEASON = Number(process.env.SEASON ?? new Date().getFullYear());

const FORMAT_LABEL: Record<string, string> = {
  dynasty: 'Dynasty',
  keeper: 'Keeper',
  redraft: 'Redraft',
  guillotine: 'Guillotine',
};

export default async function Home() {
  const leagues = await listLeagues(USERNAME, SEASON);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">Fantasy Football Edge</h1>
        <p className="mt-3 text-lg" style={{ color: 'var(--ink-muted)' }}>
          Every decision priced in championship probability.
        </p>
      </header>

      <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
        Your leagues · {SEASON}
      </h2>

      <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
        {leagues.map((league) => (
          <li key={league.platformLeagueId}>
            <Link
              href={`/league/${league.platformLeagueId}`}
              className="flex items-baseline justify-between gap-4 py-4 transition-opacity hover:opacity-60"
            >
              <span className="text-lg font-medium">{league.name}</span>
              <span className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                {league.platform}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {leagues.length === 0 && (
        <p style={{ color: 'var(--ink-muted)' }}>No leagues found for {USERNAME} in {SEASON}.</p>
      )}
    </main>
  );
}

export { FORMAT_LABEL };
