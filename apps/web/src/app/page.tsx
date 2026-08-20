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
    <div className="mx-auto max-w-4xl px-6 py-14">
      <header className="mb-10 border-b pb-6" style={{ borderColor: 'var(--rule)' }}>
        <p className="kicker mb-2">Fantasy Football Edge · {SEASON}</p>
        <h1 className="text-4xl leading-tight">
          Every decision priced in
          <br />
          championship probability.
        </h1>
        <p className="standfirst mt-3">
          Start/sit, waiver claim, trade, rebuild-or-contend — measured in the same two currencies:
          what the market will pay, and what it does to your odds of winning the league. The model
          owns its projections, simulates the season, and says out loud when a difference is too
          small to call.
        </p>
      </header>

      <h2 className="kicker mb-3">Your leagues</h2>

      {leagues.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          No leagues found for {USERNAME} in {SEASON}.
        </p>
      ) : (
        <ul>
          {leagues.map((league) => (
            <li key={league.platformLeagueId} className="border-b" style={{ borderColor: 'var(--rule)' }}>
              <Link
                href={`/league/${league.platformLeagueId}`}
                className="group flex items-baseline justify-between gap-4 py-3.5 transition-colors hover:bg-[var(--surface-sunk)]"
              >
                <span className="display text-lg">{league.name}</span>
                <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {FORMAT_LABEL[league.platform] ?? league.platform} · {league.season}
                  <span className="ml-3" style={{ color: 'var(--accent)' }}>
                    →
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { FORMAT_LABEL };
