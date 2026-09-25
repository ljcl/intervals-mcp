import { describe, expect, it } from "vitest";
import {
  aggregateWeeks,
  buildTrainingLoadData,
  computeWeekWarnings,
  getWeekStart,
  rollingTrend,
  type TrainingLoadActivity,
} from "./trainingLoad";

describe("getWeekStart", () => {
  it("returns the Monday of the week", () => {
    // 2026-06-10 is a Wednesday.
    expect(getWeekStart("2026-06-10")).toBe("2026-06-08");
  });

  it("keeps a Monday as-is", () => {
    expect(getWeekStart("2026-06-08")).toBe("2026-06-08");
  });

  it("maps Sunday back to the preceding Monday", () => {
    // 2026-06-14 is a Sunday.
    expect(getWeekStart("2026-06-14")).toBe("2026-06-08");
  });

  it("uses only the date portion of a start_date_local datetime string", () => {
    expect(getWeekStart("2026-06-10T23:45:00")).toBe("2026-06-08");
  });
});

describe("computeWeekWarnings", () => {
  const week = (week_starting: string, distance_km: number) => ({
    week_starting,
    distance_km,
  });

  it("returns nothing for fewer than two weeks", () => {
    expect(computeWeekWarnings([week("2026-06-01", 100)])).toEqual([]);
  });

  it("flags a >30% week-over-week increase", () => {
    const warnings = computeWeekWarnings([
      week("2026-06-01", 20),
      week("2026-06-08", 28),
    ]);
    expect(warnings).toEqual([
      {
        week_starting: "2026-06-08",
        reason:
          "Volume increased 40% from previous week - consider injury risk",
      },
    ]);
  });

  it("does not flag a 30%-or-smaller increase", () => {
    expect(
      computeWeekWarnings([week("2026-06-01", 20), week("2026-06-08", 26)]),
    ).toEqual([]);
  });

  it("flags an unusually high week (>150% of average and over 30 km)", () => {
    const warnings = computeWeekWarnings([
      week("2026-05-25", 20),
      week("2026-06-01", 21),
      week("2026-06-08", 19),
      week("2026-06-15", 62),
    ]);
    const high = warnings.find((w) => w.reason.startsWith("Unusually"));
    expect(high).toEqual({
      week_starting: "2026-06-15",
      reason: "Unusually high volume (62 km vs 31 km average)",
    });
  });

  it("can flag the same week under both rules", () => {
    const warnings = computeWeekWarnings([
      week("2026-06-01", 20),
      week("2026-06-08", 22),
      week("2026-06-15", 65),
    ]);
    const forSpike = warnings.filter((w) => w.week_starting === "2026-06-15");
    expect(forSpike).toHaveLength(2);
  });
});

describe("rollingTrend", () => {
  it("averages a centered window", () => {
    expect(rollingTrend([10, 20, 30], 3)).toEqual([15, 20, 25]);
  });

  it("counts zero weeks toward the average", () => {
    expect(rollingTrend([30, 0, 30], 3)).toEqual([15, 20, 15]);
  });

  it("handles a single value", () => {
    expect(rollingTrend([42], 3)).toEqual([42]);
  });
});

describe("buildTrainingLoadData", () => {
  const run = (
    date: string,
    distanceKm: number,
    overrides: Partial<TrainingLoadActivity> = {},
  ): TrainingLoadActivity => ({
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: distanceKm * 1000,
    moving_time: distanceKm * 360, // 6 min/km
    total_elevation_gain: distanceKm * 10,
    ...overrides,
  });

  it("returns an empty payload for no activities", () => {
    const data = buildTrainingLoadData([], 84);
    expect(data).toEqual({
      days: 84,
      activityTypesIncluded: ["Run", "TrailRun", "VirtualRun"],
      runOnly: true,
      current: null,
      source: null,
      totals: { runs: 0, distanceKm: 0, timeHours: 0, elevationM: 0, load: 0 },
      weeks: [],
    });
  });

  it("aggregates runs into Monday-start weeks with totals", () => {
    // Both in the week of Mon 2026-06-08.
    const data = buildTrainingLoadData(
      [run("2026-06-09", 10), run("2026-06-11", 5)],
      28,
    );
    expect(data.weeks).toHaveLength(1);
    expect(data.weeks[0]).toMatchObject({
      weekStarting: "2026-06-08",
      runs: 2,
      distanceKm: 15,
      timeHours: 1.5,
      elevationM: 150,
      warning: false,
      warningReasons: [],
    });
    expect(data.totals).toEqual({
      runs: 2,
      distanceKm: 15,
      timeHours: 1.5,
      elevationM: 150,
      load: 0,
    });
  });

  it("sums load per week from a separate loadActivities set (whole-body)", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-09", 10), run("2026-06-11", 5)],
      28,
      {
        runOnly: false,
        loadActivities: [
          run("2026-06-09", 10, { type: "Run", icu_training_load: 60 }),
          run("2026-06-10", 0, {
            type: "WeightTraining",
            icu_training_load: 20,
          }),
        ],
      },
    );
    expect(data.activityTypesIncluded).toEqual(["Run", "WeightTraining"]);
    expect(data.runOnly).toBe(false);
    expect(data.weeks[0]).toMatchObject({
      load: 80,
      loadByType: { Run: 60, WeightTraining: 20 },
    });
    expect(data.totals.load).toBe(80);
  });

  it("attaches the caller-supplied current CTL/ATL/TSB and source", () => {
    const data = buildTrainingLoadData([run("2026-06-09", 10)], 28, {
      current: { date: "2026-06-11", ctl: 42, atl: 30, tsb: 12 },
      source: "intervals.icu",
      runOnly: false,
    });
    expect(data.current).toEqual({
      date: "2026-06-11",
      ctl: 42,
      atl: 30,
      tsb: 12,
    });
    expect(data.source).toBe("intervals.icu");
  });

  it("fills gap weeks with zero rows so the timeline is continuous", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-15", 22)],
      28,
    );
    expect(data.weeks.map((w) => w.weekStarting)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
    expect(data.weeks[1]).toMatchObject({ runs: 0, distanceKm: 0 });
  });

  it("computes the rolling trend over the filled series", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 30), run("2026-06-15", 30)],
      28,
    );
    // Middle (zero) week averages its neighbours: (30 + 0 + 30) / 3 = 20.
    expect(data.weeks.map((w) => w.trendKm)).toEqual([15, 20, 15]);
  });

  it("attaches warning flags and reasons to the offending week", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-08", 40)],
      28,
    );
    const spikeWeek = data.weeks.find((w) => w.weekStarting === "2026-06-08")!;
    expect(spikeWeek.warning).toBe(true);
    expect(spikeWeek.warningReasons).toEqual([
      "Volume increased 100% from previous week - consider injury risk",
    ]);
    expect(data.weeks[0]!.warning).toBe(false);
  });

  it("ignores gap weeks when computing warnings, matching the text tool", () => {
    // 40 km, three empty weeks, 42 km. Over the NON-EMPTY weeks (like the
    // text tool) the average is 41 km, so 42 km is not >150% of it. Counting
    // the filled zero weeks would drop the average to 16.4 km and wrongly
    // flag the last week as unusually high.
    const data = buildTrainingLoadData(
      [run("2026-06-01", 40), run("2026-06-29", 42)],
      42,
    );
    expect(data.weeks).toHaveLength(5);
    const lastWeek = data.weeks[data.weeks.length - 1]!;
    expect(lastWeek.warning).toBe(false);
    expect(lastWeek.warningReasons).toEqual([]);
  });

  it("carries a strength-only week inside the run window, run fields zeroed", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-15", 20)],
      42,
      {
        runOnly: false,
        loadActivities: [
          run("2026-06-01", 0, { type: "Run", icu_training_load: 40 }),
          run("2026-06-08", 0, {
            type: "WeightTraining",
            icu_training_load: 25,
          }),
          run("2026-06-15", 0, { type: "Run", icu_training_load: 40 }),
        ],
      },
    );
    // Week of 2026-06-08 has no run but the strength load still appears.
    const midWeek = data.weeks.find((w) => w.weekStarting === "2026-06-08")!;
    expect(midWeek).toMatchObject({
      runs: 0,
      distanceKm: 0,
      load: 25,
      loadByType: { WeightTraining: 25 },
    });
    expect(data.totals.load).toBe(105);
  });

  it("returns the whole-body load for a window with no runs at all", () => {
    const data = buildTrainingLoadData([], 28, {
      runOnly: false,
      loadActivities: [
        run("2026-06-01", 0, { type: "WeightTraining", icu_training_load: 30 }),
      ],
    });
    expect(data.weeks).toHaveLength(1);
    expect(data.weeks[0]).toMatchObject({
      weekStarting: "2026-06-01",
      runs: 0,
      distanceKm: 0,
      load: 30,
      loadByType: { WeightTraining: 30 },
    });
    expect(data.totals.load).toBe(30);
    expect(data.totals.runs).toBe(0);
  });
});

describe("aggregateWeeks", () => {
  const run = (
    date: string,
    distanceKm: number,
    overrides: Partial<TrainingLoadActivity> = {},
  ): TrainingLoadActivity => ({
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: distanceKm * 1000,
    moving_time: distanceKm * 360,
    total_elevation_gain: distanceKm * 10,
    ...overrides,
  });

  it("returns nothing for no activities on either side", () => {
    expect(aggregateWeeks([], [])).toEqual([]);
  });

  it("unions run weeks and load-only weeks, extending the timeline past the run range", () => {
    const buckets = aggregateWeeks(
      [run("2026-06-08", 10)],
      [
        run("2026-06-08", 0, { type: "Run", icu_training_load: 50 }),
        run("2026-06-22", 0, { type: "WeightTraining", icu_training_load: 20 }),
      ],
    );
    expect(buckets.map((b) => b.weekStarting)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
    expect(buckets[2]).toMatchObject({
      runs: 0,
      distanceM: 0,
      load: 20,
      loadByType: { WeightTraining: 20 },
    });
  });

  it("gives the same weekly load whichever surface calls it with the same input", () => {
    const runs = [run("2026-06-01", 10), run("2026-06-08", 12)];
    const loadActivities = [
      run("2026-06-01", 0, { type: "Run", icu_training_load: 55 }),
      run("2026-06-08", 0, { type: "Run", icu_training_load: 60 }),
      run("2026-06-08", 0, { type: "WeightTraining", icu_training_load: 15 }),
    ];
    const a = aggregateWeeks(runs, loadActivities);
    const b = aggregateWeeks(runs, loadActivities);
    expect(a).toEqual(b);
    expect(a.reduce((sum, w) => sum + w.load, 0)).toBe(130);
  });
});
