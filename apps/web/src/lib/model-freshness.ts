export const PROJECTION_STALE_AFTER_MINUTES = 24 * 60;

export const projectionAgeMinutes = (
  generatedAt: string | null,
  nowMs: number = Date.now(),
): number | null => {
  if (generatedAt === null) return null;

  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return null;

  return Math.max(0, Math.round((nowMs - generatedAtMs) / 60_000));
};

export const projectionWarning = (
  generatedAt: string | null,
  nowMs: number = Date.now(),
): "stale" | "unknown" | null => {
  const ageMinutes = projectionAgeMinutes(generatedAt, nowMs);
  if (ageMinutes === null) return "unknown";
  return ageMinutes > PROJECTION_STALE_AFTER_MINUTES ? "stale" : null;
};
