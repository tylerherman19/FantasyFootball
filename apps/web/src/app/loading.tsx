/**
 * The front page, mid-flight.
 *
 * Listing leagues is one Sleeper request, so this is usually on screen for a
 * few hundred milliseconds — but that is exactly the window where a blank page
 * reads as a broken one.
 */
export default function LoadingHome() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
      <div className="animate-pulse rounded h-8 w-72" style={{ background: 'var(--surface-sunk)' }} />
      <div className="mt-3 animate-pulse rounded h-3 w-80" style={{ background: 'var(--surface-sunk)' }} />

      <div className="mt-9 grid gap-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="panel px-4 py-3.5">
            <div className="animate-pulse rounded h-4 w-48" style={{ background: 'var(--surface-sunk)' }} />
            <div className="mt-2 animate-pulse rounded h-3 w-64" style={{ background: 'var(--surface-sunk)' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
