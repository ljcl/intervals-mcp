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
  load: 150,
  loadByType: { Run: 150 },
  ...overrides,
});

const data = (weeks: WeekSummary[]): TrainingLoadData => ({
  days: 84,
  totals: {
    runs: 12,
    distanceKm: 120,
    timeHours: 12,
    elevationM: 800,
    load: 900,
  },
  weeks,
  activityTypesIncluded: ["Ride", "Run"],
  runOnly: false,
  current: { date: "2026-06-10", ctl: 52, atl: 61, tsb: -9 },
  source: "intervals.icu",
});

describe("buildTrainingLoadContextSummary", () => {
  it("summarizes period, totals, and a clean bill of health", () => {
    const summary = buildTrainingLoadContextSummary(
      data([week("2026-06-01"), week("2026-06-08")]),
    );
    expect(summary).toBe(
      "Training load, last 84 days. 12 runs, 120 km over 2 weeks. " +
        "Total training load 900, whole body (Ride, Run); runs, distance and volume-spike warnings count runs only. " +
        "As of 2026-06-10: CTL 52, ATL 61, TSB -9 (from intervals.icu). " +
        "No volume-spike warnings.",
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
        "Total training load 900, whole body (Ride, Run); runs, distance and volume-spike warnings count runs only. " +
        "As of 2026-06-10: CTL 52, ATL 61, TSB -9 (from intervals.icu). " +
        "The week of 2026-06-08 is still in progress, so its volume and load are only the days so far. " +
        "No volume-spike warnings.",
    );
  });

  it("calls a past window's last week partial, not in progress (#80)", () => {
    const summary = buildTrainingLoadContextSummary({
      ...data([
        week("2026-04-06", { distanceKm: 12, inProgress: true, trendKm: null }),
      ]),
      startDate: "2026-01-12",
      endDate: "2026-04-08",
      endsToday: false,
    });
    expect(summary).toContain(
      "The week of 2026-04-06 is partial: the window ends on 2026-04-08, so its volume and load count only the days up to then.",
    );
    expect(summary).not.toContain("in progress");
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

  it("says run-only load and computed fitness when the scope is runs only", () => {
    const summary = buildTrainingLoadContextSummary({
      ...data([week("2026-06-01")]),
      runOnly: true,
      activityTypesIncluded: ["Run", "TrailRun", "VirtualRun"],
      current: { date: "2026-06-10", ctl: 41, atl: 37.5, tsb: 3.5 },
      source: "computed",
    });
    expect(summary).toContain("Total training load 900, runs only.");
    expect(summary).toContain(
      "As of 2026-06-10: CTL 41, ATL 37.5, TSB +3.5 (computed locally).",
    );
    expect(summary).not.toContain("whole body");
  });

  it("leaves the fitness sentence out when there is no current", () => {
    const summary = buildTrainingLoadContextSummary({
      ...data([week("2026-06-01")]),
      current: null,
    });
    expect(summary).toContain("Total training load 900");
    expect(summary).not.toContain("CTL");
  });

  it("reports the series hidden, by the values set-scope accepts", () => {
    const summary = buildTrainingLoadContextSummary(
      data([
        week("2026-06-01"),
        week("2026-06-08", { warning: true, warningReasons: ["spike"] }),
      ]),
      ["trend", "warnings"],
    );
    expect(summary).toMatch(
      /Volume-spike warnings on week of 2026-06-08\. Hidden series: trend, warnings\.$/,
    );
  });

  it("says nothing about hidden series when every series shows", () => {
    expect(
      buildTrainingLoadContextSummary(data([week("2026-06-01")]), []),
    ).not.toContain("Hidden series");
  });

  it("returns null when there is no period", () => {
    expect(
      buildTrainingLoadContextSummary({ ...data([]), days: 0 }),
    ).toBeNull();
  });
});
