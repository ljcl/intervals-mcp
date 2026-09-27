import { describe, expect, it } from "vitest";
import { buildTrainingLoadContextSummary } from "./contextSummary";
import { type TrainingLoadData, type WeekSummary } from "./types";

const week = (
  weekStarting: string,
  overrides: Partial<WeekSummary> = {},
): WeekSummary => ({
  weekStarting,
  runs: 3,
  distanceKm: 30,
  timeHours: 3,
  elevationM: 200,
  trendKm: 30,
  warning: false,
  warningReasons: [],
  ...overrides,
});

const data = (weeks: WeekSummary[]): TrainingLoadData => ({
  days: 84,
  totals: { runs: 12, distanceKm: 120, timeHours: 12, elevationM: 800 },
  weeks,
});

describe("buildTrainingLoadContextSummary", () => {
  it("summarizes period, totals, and a clean bill of health", () => {
    const summary = buildTrainingLoadContextSummary(
      data([week("2026-06-01"), week("2026-06-08")]),
    );
    expect(summary).toBe(
      "Training load, last 84 days. 12 runs, 120 km over 2 weeks. No volume-spike warnings.",
    );
  });

  it("names the window's dates and the week in progress", () => {
    const summary = buildTrainingLoadContextSummary({
      ...data([
        week("2026-06-01"),
        week("2026-06-08", { distanceKm: 12, inProgress: true, trendKm: null }),
      ]),
      startDate: "2026-03-16",
      endDate: "2026-06-10",
    });
    expect(summary).toBe(
      "Training load from 2026-03-16 to 2026-06-10. 12 runs, 120 km over 2 weeks. " +
        "The week of 2026-06-08 is still in progress, so its volume is only the days so far. " +
        "No volume-spike warnings.",
    );
  });

  it("names the flagged weeks", () => {
    const summary = buildTrainingLoadContextSummary(
      data([
        week("2026-06-01"),
        week("2026-06-08", { warning: true, warningReasons: ["spike"] }),
      ]),
    );
    expect(summary).toContain("Volume-spike warnings on week of 2026-06-08.");
  });

  it("returns null when there is no period", () => {
    expect(
      buildTrainingLoadContextSummary({ ...data([]), days: 0 }),
    ).toBeNull();
  });
});
