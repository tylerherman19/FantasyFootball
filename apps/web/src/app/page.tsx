import Link from 'next/link';
import { signOut, switchSeason } from './actions';
import { SignIn } from '@/components/SignIn';
import { ThemeToggle } from '@/components/ThemeToggle';
import { listLeagues } from '@/lib/league-data';
import { defaultSeason, readSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const FORMAT_LABEL: Record<string, string> = {
  dynasty: 'Dynasty',
  keeper: 'Keeper',
  redraft: 'Redraft',
  guillotine: 'Guillotine',
};

const FORMAT_COLOR: Record<string, string> = {
  dynasty: 'var(--pos-qb)',
  keeper: 'var(--pos-wr)',
  redraft: 'var(--pos-rb)',
  guillotine: 'var(--pos-def)',
};

const scoringLabel = (ppr: number | undefined): string => {
  if (ppr === undefined || ppr === 0) return 'Standard';
  if (ppr >= 1) return 'PPR';
  if (ppr >= 0.5) return 'Half PPR';
  return `${ppr} PPR`;
};

const seasonOptions = (current: number): number[] => {
  const now = new Date();
  const latest = Math.max(current, now.getMonth() < 6 ? now.getFullYear() : now.getFullYear() + 1);
  return Array.from({ length: 6 }, (_, index) => latest - index);
};

export default async function Home() {
  const session = await readSession();

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Fantasy Football Edge</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--ink-muted)' }}>
            Every decision priced in championship probability.
          </p>
        </div>
        <ThemeToggle />
      </header>

      {session === null ? (
        <>
          <SignIn defaultSeason={defaultSeason()} />

          <section className="mt-8">
            <h2 className="eyebrow mb-3">What you get</h2>
            <ul className="grid gap-px overflow-hidden rounded border sm:grid-cols-2"
              style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}>
              {[
                ['Title odds, simulated', 'Ten thousand seasons with correlated player scoring, not a rating gap and a coin flip.'],
                ['Usage behind every number', 'Targets, carries, shares and touchdown dependence — the volume that makes a projection repeatable.'],
                ['Trades in one currency', 'Model value and championship probability side by side, never averaged into a grade.'],
                ['Your own league’s rules', 'Scoring is applied per league, so a superflex dynasty and a redraft PPR get different answers.'],
              ].map(([title, body]) => (
                <li key={title} className="p-4" style={{ background: 'var(--surface)' }}>
                  <div className="text-sm font-semibold">{title}</div>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                    {body}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <LeagueList session={session} />
      )}
    </div>
  );
}

const LeagueList = async ({
  session,
}: {
  session: { username: string; userId: string; season: number };
}) => {
  const leagues = await listLeagues(session.username, session.season);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">Signed in as</span>
          <span className="text-sm font-semibold">{session.username}</span>
        </div>

        <div className="flex items-center gap-2">
          <form action={switchSeason} className="flex items-center gap-1.5">
            <input type="hidden" name="username" value={session.username} />
            <input type="hidden" name="userId" value={session.userId} />
            <select
              name="season"
              defaultValue={session.season}
              aria-label="Season"
              className="rounded px-2 py-1 text-xs outline-none"
              style={{
                background: 'var(--surface-sunk)',
                border: '1px solid var(--rule)',
                color: 'var(--ink)',
              }}
            >
              {seasonOptions(session.season).map((season) => (
                <option key={season} value={season}>
                  {season}
                </option>
              ))}
            </select>
            <button type="submit" className="text-xs underline" style={{ color: 'var(--ink-muted)' }}>
              go
            </button>
          </form>

          <form action={signOut}>
            <button type="submit" className="text-xs underline" style={{ color: 'var(--ink-muted)' }}>
              switch account
            </button>
          </form>
        </div>
      </div>

      {leagues.length === 0 ? (
        <div className="panel p-5 text-sm" style={{ color: 'var(--ink-muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>No leagues in {session.season}.</strong> Sleeper
          creates a fresh league id every season, so last year&apos;s leagues live under last
          year&apos;s number — try an earlier season above.
        </div>
      ) : (
        <ul className="grid gap-2">
          {leagues.map((league) => (
            <li key={league.platformLeagueId}>
              <Link
                href={`/league/${league.platformLeagueId}`}
                className="panel flex items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:border-[color:var(--rule-strong)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold">{league.name}</span>
                    {league.format !== undefined && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                        style={{ background: FORMAT_COLOR[league.format] ?? 'var(--ink-faint)' }}
                      >
                        {FORMAT_LABEL[league.format] ?? league.format}
                      </span>
                    )}
                  </div>

                  <div className="tabular mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {league.teamCount !== undefined && <span>{league.teamCount} teams</span>}
                    <span>{scoringLabel(league.ppr)}</span>
                    {league.superFlex === true && <span style={{ color: 'var(--pos-qb)' }}>superflex</span>}
                    {league.startingSlots !== undefined && <span>{league.startingSlots} starters</span>}
                    {league.rosterSize !== undefined && <span>{league.rosterSize}-man rosters</span>}
                    {league.drafted === false && (
                      <span style={{ color: 'var(--warn)' }}>not drafted</span>
                    )}
                  </div>
                </div>

                <span aria-hidden="true" style={{ color: 'var(--ink-faint)' }}>
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};
