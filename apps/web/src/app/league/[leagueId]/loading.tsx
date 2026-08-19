/**
 * What a league page looks like while it is being built.
 *
 * The first view of a league is genuinely expensive — thirty-odd Sleeper
 * endpoints and a few thousand simulated seasons — and there is no honest way
 * to make that instant. What there is no excuse for is showing nothing while it
 * happens. This lays out the shape the page is about to take, so the wait reads
 * as loading rather than as broken.
 *
 * Deliberately not a spinner: a skeleton that matches the real layout means the
 * content arrives *into* the space it already occupies, instead of shoving the
 * page around at the moment the reader starts looking at it.
 */

const Shimmer = ({ className = '', style }: { className?: string; style?: React.CSSProperties }) => (
  <div
    className={`animate-pulse rounded ${className}`}
    style={{ background: 'var(--surface-sunk)', ...style }}
  />
);

export default function LoadingLeague() {
  return (
    <>
      <header className="mb-6 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="mx-auto max-w-6xl px-5 pt-4">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="mt-2 h-7 w-64" />
          <Shimmer className="mt-2 h-3 w-80" />
          <div className="mt-4 flex gap-3 pb-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <Shimmer key={index} className="h-4 w-14" />
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-20">
        <Shimmer className="mb-3 h-3 w-28" />
        <div
          className="mb-9 grid grid-cols-2 gap-px overflow-hidden rounded border sm:grid-cols-5"
          style={{ borderColor: 'var(--rule)', background: 'var(--rule)' }}
        >
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="p-3" style={{ background: 'var(--surface)' }}>
              <Shimmer className="h-2.5 w-16" />
              <Shimmer className="mt-2 h-6 w-20" />
            </div>
          ))}
        </div>

        <Shimmer className="mb-3 h-3 w-36" />
        <div className="panel overflow-hidden">
          {Array.from({ length: 10 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b px-3 py-2.5"
              style={{ borderColor: 'var(--rule)' }}
            >
              <Shimmer className="h-3 w-5" />
              <Shimmer className="h-3 w-32" />
              <Shimmer className="h-3.5 flex-1" style={{ opacity: 1 - index * 0.06 }} />
              <Shimmer className="h-3 w-12" />
              <Shimmer className="h-3 w-20" />
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Loading the league and simulating the rest of the season…
        </p>
      </main>
    </>
  );
}
