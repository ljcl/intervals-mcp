import { describe, expect, it } from "vitest";
import { buildLoadA11y } from "./a11y";
import { type TrainingLoadData, type WeekSummary } from "./types";

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
  load: distanceKm * 10,
  loadByType: { Run: distanceKm * 10 },
  ...overrides,
});

const data = (
  weeks: WeekSummary[],
  overrides: Partial<TrainingLoadData> = {},
): TrainingLoadData => ({
  days: 14,
  totals: {
    runs: weeks.length * 3,
    distanceKm: weeks.reduce((sum, w) => sum + w.distanceKm, 0),
    timeHours: 5,
    elevationM: 200,
    load: weeks.reduce((sum, w) => sum + w.load, 0),
  },
  weeks,
  activityTypesIncluded: ["Run"],
  runOnly: false,
  current: { date: "2026-06-10", ctl: 52, atl: 61, tsb: -9 },
  source: "intervals.icu",
  ...overrides,
});

describe("buildLoadA11y", () => {
  it("handles no weeks", () => {
    expect(buildLoadA11y(data([]))).toEqual({
      title: "Weekly training volume and load",
      desc: "No runs to display.",
    });
  });

  it("narrates the period, distance range, trend line, load and fitness", () => {
    const a11y = buildLoadA11y(
      data([week("2026-06-01", 20), week("2026-06-08", 30)]),
    );
    expect(a11y.title).toBe("Weekly training volume and load");
    expect(a11y.desc).toBe(
      "2 weeks of running volume from 1 Jun 2026 to 8 Jun 2026. " +
        "Weekly distance ranges from 20 to 30 km; a line shows the 3-week rolling average. " +
        "A second line shows weekly training load on the right axis, from 200 to 300. " +
        "Total training load 500, whole body (Run). " +
        "As of 10 Jun 2026: CTL 52, ATL 61, TSB -9 (from intervals.icu). " +
        "No weeks are flagged as a volume spike.",
    );
  });

  it("names the flagged weeks", () => {
    const a11y = buildLoadA11y(
      data([
        week("2026-06-01", 20),
        week("2026-06-08", 40, { warning: true, warningReasons: ["spike"] }),
      ]),
    );
    expect(a11y.desc).toContain(
      "1 week is highlighted as a volume spike: week of 8 Jun 2026.",
    );
  });

  it("says the last week is still in progress", () => {
    const a11y = buildLoadA11y(
      data([
        week("2026-06-01", 20),
        week("2026-06-08", 6, { inProgress: true, trendKm: null }),
      ]),
    );
    expect(a11y.desc).toContain(
      "The week of 8 Jun 2026 is still in progress, so its distance is only the days so far.",
    );
  });

  it("drops the trend clause when the trend line is hidden (ljcl/strava-mcp#328)", () => {
    const a11y = buildLoadA11y(
      data([week("2026-06-01", 20), week("2026-06-08", 30)]),
      { showTrend: false, showWarnings: true, showLoad: true },
    );
    expect(a11y.desc).toContain("Weekly distance ranges from 20 to 30 km.");
    expect(a11y.desc).not.toContain("rolling average");
  });

  it("drops the load line clause, but keeps the total, when the load line is hidden", () => {
    const a11y = buildLoadA11y(
      data([week("2026-06-01", 20), week("2026-06-08", 30)]),
      { showTrend: true, showWarnings: true, showLoad: false },
    );
    expect(a11y.desc).not.toContain("right axis");
    expect(a11y.desc).toContain("Total training load 500");
  });

  it("says nothing about volume spikes when warnings are hidden", () => {
    const a11y = buildLoadA11y(
      data([
        week("2026-06-01", 20),
        week("2026-06-08", 40, { warning: true, warningReasons: ["spike"] }),
      ]),
      { showTrend: true, showWarnings: false, showLoad: true },
    );
    expect(a11y.desc).not.toContain("volume spike");
  });

  it("names a run-only scope and where its fitness came from", () => {
    const a11y = buildLoadA11y(
      data([week("2026-06-01", 20)], {
        runOnly: true,
        current: { date: "2026-06-10", ctl: 41, atl: 37.5, tsb: 3.5 },
        source: "computed",
      }),
    );
    expect(a11y.desc).toContain("Total training load 200, runs only.");
    expect(a11y.desc).toContain(
      "As of 10 Jun 2026: CTL 41, ATL 37.5, TSB +3.5 (computed locally).",
    );
  });

  it("leaves the fitness sentence out when there is no current", () => {
    const a11y = buildLoadA11y(
      data([week("2026-06-01", 20)], { current: null }),
    );
    expect(a11y.desc).not.toContain("CTL");
  });
});
