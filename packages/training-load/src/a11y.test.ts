import { describe, expect, it } from "vitest";
import { buildLoadA11y } from "./a11y";
import { type WeekSummary } from "./types";

const week = (
  weekStarting: string,
  distanceKm: number,
  overrides: Partial<WeekSummary> = {},
): WeekSummary => ({
  weekStarting,
  runs: 3,
  distanceKm,
  timeHours: distanceKm / 10,
  elevationM: 100,
  trendKm: distanceKm,
  warning: false,
  warningReasons: [],
  ...overrides,
});

describe("buildLoadA11y", () => {
  it("handles no weeks", () => {
    expect(buildLoadA11y([])).toEqual({
      title: "Weekly training volume",
      desc: "No runs to display.",
    });
  });

  it("narrates the period, distance range, and trend line", () => {
    const a11y = buildLoadA11y([
      week("2026-06-01", 20),
      week("2026-06-08", 30),
    ]);
    expect(a11y.title).toBe("Weekly training volume");
    expect(a11y.desc).toBe(
      "2 weeks of running volume from 1 Jun 2026 to 8 Jun 2026. " +
        "Weekly distance ranges from 20 to 30 km; a line shows the 3-week rolling average. " +
        "No weeks are flagged for injury risk.",
    );
  });

  it("names the flagged weeks", () => {
    const a11y = buildLoadA11y([
      week("2026-06-01", 20),
      week("2026-06-08", 40, { warning: true, warningReasons: ["spike"] }),
    ]);
    expect(a11y.desc).toContain(
      "1 week is highlighted for injury risk: week of 8 Jun 2026.",
    );
  });

  it("says the last week is still in progress", () => {
    const a11y = buildLoadA11y([
      week("2026-06-01", 20),
      week("2026-06-08", 6, { inProgress: true, trendKm: null }),
    ]);
    expect(a11y.desc).toContain(
      "The week of 8 Jun 2026 is still in progress, so its distance is only the days so far.",
    );
  });

  it("drops the trend clause when the trend line is hidden (#328)", () => {
    const a11y = buildLoadA11y(
      [week("2026-06-01", 20), week("2026-06-08", 30)],
      { showTrend: false, showWarnings: true },
    );
    expect(a11y.desc).toContain("Weekly distance ranges from 20 to 30 km.");
    expect(a11y.desc).not.toContain("rolling average");
  });

  it("says nothing about injury risk when warnings are hidden", () => {
    const a11y = buildLoadA11y(
      [
        week("2026-06-01", 20),
        week("2026-06-08", 40, { warning: true, warningReasons: ["spike"] }),
      ],
      { showTrend: true, showWarnings: false },
    );
    expect(a11y.desc).not.toContain("injury risk");
  });
});
