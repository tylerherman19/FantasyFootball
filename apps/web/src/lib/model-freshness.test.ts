import { describe, expect, it } from "vitest";
import { projectionAgeMinutes, projectionWarning } from "./model-freshness";

const NOW = Date.parse("2026-08-28T12:00:00Z");

describe("projection freshness warning", () => {
  it("warns once projections are more than 24 hours old", () => {
    expect(projectionWarning("2026-08-27T11:59:00Z", NOW)).toBe("stale");
  });

  it("does not warn at exactly 24 hours", () => {
    expect(projectionWarning("2026-08-27T12:00:00Z", NOW)).toBeNull();
  });

  it("fails safe when the projection timestamp is missing or invalid", () => {
    expect(projectionWarning(null, NOW)).toBe("unknown");
    expect(projectionWarning("not-a-date", NOW)).toBe("unknown");
    expect(projectionAgeMinutes("not-a-date", NOW)).toBeNull();
  });
});
