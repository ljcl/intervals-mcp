import { describe, expect, it } from "vitest";
import {
  aggregateWeeks,
  buildTrainingLoadData,
  computeWeekWarnings,
  getWeekStart,
  rollingTrend,
  selectRunWeeks,
  type TrainingLoadActivity,
  trainingLoadWindow,
  typesWithLoad,
  volumeTrend,
  type WeekBucket,
} from "./trainingLoad";
import { addDays } from "./utils/localDate";

describe("trainingLoadWindow", () => {
  it("rounds days up to whole weeks and adds this week so far (Saturday)", () => {
    // 2026-09-26 is a Saturday: the issue's example day.
    expect(trainingLoadWindow(28, "2026-09-26")).toEqual({
      startDate: "2026-08-24",
      endDate: "2026-09-26",
      currentWeekStart: "2026-09-21",
      completeWeeks: 4,
      currentWeekDays: 6,
      spanDays: 34,
    });
  });

  it("keeps 4 complete weeks for days 28 on a Sunday, when this week has all 7 days", () => {
    expect(trainingLoadWindow(28, "2026-09-27")).toMatchObject({
      startDate: "2026-08-24",
      currentWeekStart: "2026-09-21",
      completeWeeks: 4,
      currentWeekDays: 7,
      spanDays: 35,
    });
  });

  it("starts the current week on a Monday", () => {
    expect(trainingLoadWindow(28, "2026-09-28")).toMatchObject({
      startDate: "2026-08-31",
      currentWeekStart: "2026-09-28",
      currentWeekDays: 1,
      spanDays: 29,
    });
  });

  it("starts on a Monday with the same complete weeks on every weekday", () => {
    for (let i = 0; i < 7; i += 1) {
      const lookback = trainingLoadWindow(28, addDays("2026-09-21", i));
      expect(getWeekStart(lookback.startDate)).toBe(lookback.startDate);
      expect(lookback.completeWeeks).toBe(4);
      expect(lookback.currentWeekDays).toBe(i + 1);
    }
  });

  it.each([
    [1, 1],
    [7, 1],
    [8, 2],
    [30, 5],
    [56, 8],
    [84, 12],
    [365, 53],
  ])("reads %i days as %i complete weeks", (days, weeks) => {
    expect(trainingLoadWindow(days, "2026-09-26").completeWeeks).toBe(weeks);
  });
});

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

  const inProgress = (week_starting: string, distance_km: number) => ({
    week_starting,
    distance_km,
    in_progress: true,
  });

  it("never uses a week in progress as the baseline for a rise", () => {
    // 5 km so far is not a week's volume: 20 km after it is no 300% rise.
    expect(
      computeWeekWarnings([
        inProgress("2026-06-01", 5),
        week("2026-06-08", 20),
      ]),
    ).toEqual([]);
  });

  it("does not flag a week in progress for being lower so far", () => {
    expect(
      computeWeekWarnings([
        week("2026-06-01", 60),
        week("2026-06-08", 60),
        inProgress("2026-06-15", 16),
      ]),
    ).toEqual([]);
  });

  it("warns early when the week in progress is already over 30% up", () => {
    const warnings = computeWeekWarnings([
      week("2026-06-01", 30),
      inProgress("2026-06-08", 45),
    ]);
    expect(warnings).toContainEqual({
      week_starting: "2026-06-08",
      reason:
        "Volume so far is already 50% above the previous week - consider injury risk",
    });
  });

  it("leaves the week in progress out of the unusually-high average", () => {
    // Over all four weeks the average is 23 km and 38 km is over 150% of it;
    // over the three complete weeks it is 30.7 km, and 38 km is not.
    expect(
      computeWeekWarnings([
        week("2026-06-01", 24),
        week("2026-06-08", 30),
        week("2026-06-15", 38),
        inProgress("2026-06-22", 0),
      ]),
    ).toEqual([]);
  });

  it("flags unusually high volume so far in the week in progress", () => {
    const warnings = computeWeekWarnings([
      week("2026-06-01", 20),
      week("2026-06-08", 20),
      inProgress("2026-06-15", 45),
    ]);
    expect(warnings).toContainEqual({
      week_starting: "2026-06-15",
      reason: "Unusually high volume so far (45 km vs 20 km average)",
    });
  });
});

/** A week's bucket with only the fields the run-based rules read. */
function bucket(
  weekStarting: string,
  distanceKm: number,
  runs = 1,
): WeekBucket {
  return {
    weekStarting,
    runs: distanceKm > 0 ? runs : 0,
    distanceM: distanceKm * 1000,
    timeS: 0,
    elevationM: 0,
    load: 0,
    loadByType: {},
  };
}

describe("selectRunWeeks", () => {
  it("gives the issue's 30, 0, 0, 45 km weeks one warning, over the kept zero weeks", () => {
    const { span, warnings } = selectRunWeeks(
      [
        bucket("2026-06-01", 30),
        bucket("2026-06-08", 0),
        bucket("2026-06-15", 0),
        bucket("2026-06-22", 45),
      ],
      "2026-06-29",
    );
    expect(span).toHaveLength(4);
    // The average is 18.75 km over the 4 weeks. No "increased 50%": the week
    // before the 45 km week had no volume, so there is no rise to measure.
    expect(warnings).toEqual([
      {
        week_starting: "2026-06-22",
        reason: "Unusually high volume (45 km vs 19 km average)",
      },
    ]);
  });

  it("trims load-only weeks outside the runs and leaves the week in progress out of complete", () => {
    const loadOnly = { ...bucket("2026-06-01", 0), load: 40 };
    const { span, complete } = selectRunWeeks(
      [
        loadOnly,
        bucket("2026-06-08", 20),
        bucket("2026-06-15", 0),
        bucket("2026-06-22", 22),
        bucket("2026-06-29", 8),
      ],
      "2026-06-29",
    );
    expect(span.map((b) => b.weekStarting)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
    ]);
    expect(complete.map((b) => b.weekStarting)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
  });

  it("returns nothing when no week has a run", () => {
    expect(
      selectRunWeeks([{ ...bucket("2026-06-01", 0), load: 30 }], "2026-06-08"),
    ).toEqual({ span: [], complete: [], warnings: [] });
  });
});

describe("volumeTrend", () => {
  const weeks = (...km: number[]) =>
    km.map((d, i) => bucket(addDays("2026-06-01", 7 * i), d));

  it("needs 2 complete weeks for any answer and 4 for a verdict", () => {
    expect(volumeTrend(weeks(30))).toEqual({
      label: "insufficient data",
      weeks: [],
    });
    expect(volumeTrend(weeks(30, 30, 30)).label).toBe(
      "limited data - need 4+ complete weeks for trend",
    );
  });

  it("compares the last 2 weeks with the 2 before and names them", () => {
    expect(volumeTrend(weeks(10, 60, 60, 60, 60))).toEqual({
      label: "stable",
      weeks: ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"],
    });
  });

  it.each([
    [[40, 40, 50, 50], "increasing significantly"],
    [[40, 40, 44, 44], "increasing"],
    [[40, 40, 36, 36], "decreasing"],
    [[40, 40, 30, 30], "decreasing significantly"],
  ])("reads %j as %s", (km, label) => {
    expect(volumeTrend(weeks(...km)).label).toBe(label);
  });

  it("gives no verdict when the earlier 2 weeks have no volume", () => {
    expect(volumeTrend(weeks(0, 0, 20, 20)).label).toBe("insufficient data");
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

  /** The window ending `endDate`; most tests end it after their last run week, so every week is complete. */
  const until = (endDate: string, days = 28) =>
    trainingLoadWindow(days, endDate);

  it("returns an empty payload for no activities", () => {
    // 2026-06-10 is a Wednesday: 12 complete weeks plus 3 days.
    const data = buildTrainingLoadData([], until("2026-06-10", 84));
    expect(data).toEqual({
      days: 87,
      startDate: "2026-03-16",
      endDate: "2026-06-10",
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
      until("2026-06-15"),
    );
    expect(data.weeks).toHaveLength(1);
    expect(data.weeks[0]).toMatchObject({
      weekStarting: "2026-06-08",
      runs: 2,
      distanceKm: 15,
      timeHours: 1.5,
      elevationM: 150,
      inProgress: false,
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
      until("2026-06-15"),
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
    const data = buildTrainingLoadData(
      [run("2026-06-09", 10)],
      until("2026-06-15"),
      {
        current: { date: "2026-06-11", ctl: 42, atl: 30, tsb: 12 },
        source: "intervals.icu",
        runOnly: false,
      },
    );
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
      until("2026-06-22"),
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
      until("2026-06-22"),
    );
    // Middle (zero) week averages its neighbours: (30 + 0 + 30) / 3 = 20.
    expect(data.weeks.map((w) => w.trendKm)).toEqual([15, 20, 15]);
  });

  it("marks the week in progress, and ends the trend line on the last complete week", () => {
    // Three 30 km weeks, then 5 km so far on Tuesday of the fourth.
    const data = buildTrainingLoadData(
      [
        run("2026-06-01", 30),
        run("2026-06-08", 30),
        run("2026-06-15", 30),
        run("2026-06-22", 5),
      ],
      until("2026-06-23"),
    );
    expect(data.weeks.map((w) => w.inProgress)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // Smoothing the partial week in would drag the line down to
    // [30, 30, 21.67, 17.5]; a steady runner's trend stays flat.
    expect(data.weeks.map((w) => w.trendKm)).toEqual([30, 30, 30, null]);
    expect(data.weeks.some((w) => w.warning)).toBe(false);
  });

  it("flags the week in progress only on the volume it already has", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-08", 20), run("2026-06-15", 45)],
      until("2026-06-18"),
    );
    expect(data.weeks[2]!.warningReasons).toEqual([
      "Volume so far is already 125% above the previous week - consider injury risk",
      "Unusually high volume so far (45 km vs 20 km average)",
    ]);
  });

  it("attaches warning flags and reasons to the offending week", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-08", 40)],
      until("2026-06-15"),
    );
    const spikeWeek = data.weeks.find((w) => w.weekStarting === "2026-06-08")!;
    expect(spikeWeek.warning).toBe(true);
    expect(spikeWeek.warningReasons).toEqual([
      "Volume increased 100% from previous week - consider injury risk",
    ]);
    expect(data.weeks[0]!.warning).toBe(false);
  });

  it("keeps zero weeks inside the run span for warnings, like the text tool (#43)", () => {
    // 40 km, three empty weeks, 42 km. The app used to drop the empty weeks
    // (average 41 km, no warning) while the text tool kept them (average
    // 16.4 km). Both now read the same weeks from selectRunWeeks: a return
    // to full volume after a 3-week layoff is flagged.
    const runs = [run("2026-06-01", 40), run("2026-06-29", 42)];
    const lookback = until("2026-07-06", 42);
    const data = buildTrainingLoadData(runs, lookback);

    expect(data.weeks).toHaveLength(5);
    const lastWeek = data.weeks[data.weeks.length - 1]!;
    expect(lastWeek.warningReasons).toEqual([
      "Unusually high volume (42 km vs 16 km average)",
    ]);
    const shared = selectRunWeeks(
      aggregateWeeks(runs, runs),
      lookback.currentWeekStart,
    ).warnings;
    expect(
      data.weeks.flatMap((w) =>
        w.warningReasons.map((reason) => ({
          week_starting: w.weekStarting,
          reason,
        })),
      ),
    ).toEqual(shared);
  });

  it("carries a strength-only week inside the run window, run fields zeroed", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 20), run("2026-06-15", 20)],
      until("2026-06-22", 42),
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
    const data = buildTrainingLoadData([], until("2026-06-08"), {
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

describe("typesWithLoad", () => {
  it("returns distinct types with nonzero load, sorted", () => {
    const types = typesWithLoad([
      { type: "Run", icu_training_load: 40 },
      { type: "Ride", icu_training_load: 30 },
      { type: "Run", icu_training_load: 20 },
      { type: "WeightTraining", icu_training_load: 0 },
      { type: null, icu_training_load: 10 },
      { type: "Swim" },
    ]);
    expect(types).toEqual(["Ride", "Run", "Unknown"]);
  });

  it("returns an empty array for no activities", () => {
    expect(typesWithLoad([])).toEqual([]);
  });
});
