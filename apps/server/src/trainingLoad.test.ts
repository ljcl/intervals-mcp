import { describe, expect, it } from "vitest";
import {
  aggregateWeeks,
  baselineWeeks,
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
  weekDistanceKm,
} from "./trainingLoad";
import { addDays } from "./utils/localDate";

describe("trainingLoadWindow", () => {
  it("rounds days up to whole weeks and adds this week so far (Saturday)", () => {
    // 2026-09-26 is a Saturday: the issue's example day.
    expect(trainingLoadWindow(28, "2026-09-26")).toEqual({
      baselineStartDate: "2026-07-27",
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
  /** Consecutive complete weeks from Monday 2026-06-01, one per distance. */
  const weeks = (...km: number[]) =>
    km.map((distance_km, i) => ({
      week_starting: addDays("2026-06-01", 7 * i),
      distance_km,
    }));

  it("needs 3 complete weeks before a week to compare it with", () => {
    expect(computeWeekWarnings(weeks(20, 60))).toEqual([]);
    expect(computeWeekWarnings(weeks(20, 20, 60))).toEqual([]);
  });

  it("does not flag a return to normal volume after a recovery week (#60)", () => {
    // The old rule said "Volume increased 300% from previous week".
    expect(computeWeekWarnings(weeks(40, 40, 40, 10, 40))).toEqual([]);
    // The issue's live case: a race week, a short recovery week, then an
    // easy week at about half the usual volume ("increased 243%").
    expect(computeWeekWarnings(weeks(60, 60, 50, 8.5, 29.2))).toEqual([]);
  });

  it("flags a week at 1.6 times the previous 4-week average, and states the ratio", () => {
    expect(computeWeekWarnings(weeks(40, 40, 40, 40, 64))).toEqual([
      {
        week_starting: "2026-06-29",
        reason:
          "Volume spike: 64 km is 1.6 times the 40 km average of the previous 4 weeks",
      },
    ]);
  });

  it("does not flag a week at exactly 1.5 times the average", () => {
    expect(computeWeekWarnings(weeks(40, 40, 40, 40, 60))).toEqual([]);
  });

  it("averages only the 4 weeks before, and says so with 3", () => {
    // The 100 km week is 5 weeks back: it is not part of the average.
    expect(computeWeekWarnings(weeks(100, 40, 40, 40, 40, 64))).toHaveLength(1);
    expect(computeWeekWarnings(weeks(30, 30, 30, 48))).toEqual([
      {
        week_starting: "2026-06-22",
        reason:
          "Volume spike: 48 km is 1.6 times the 30 km average of the previous 3 weeks",
      },
    ]);
  });

  it("never flags a week because of a layoff after it", () => {
    expect(computeWeekWarnings(weeks(50, 50, 50, 50, 0, 0))).toEqual([]);
  });

  it("flags a return to full volume after a layoff, not the week before the layoff", () => {
    expect(computeWeekWarnings(weeks(40, 0, 0, 0, 42))).toEqual([
      {
        week_starting: "2026-06-29",
        reason:
          "Volume spike: 42 km is 4.2 times the 10 km average of the previous 4 weeks",
      },
    ]);
  });

  it("gives no ratio when the previous 4 weeks have no volume", () => {
    expect(computeWeekWarnings(weeks(40, 0, 0, 0, 0, 42))).toEqual([]);
  });

  const inProgress = (week_starting: string, distance_km: number) => ({
    week_starting,
    distance_km,
    in_progress: true,
  });

  it("does not flag a week in progress for being lower so far", () => {
    expect(
      computeWeekWarnings([...weeks(60, 60, 60), inProgress("2026-06-22", 16)]),
    ).toEqual([]);
  });

  it("warns early when the week in progress is already a spike", () => {
    expect(
      computeWeekWarnings([...weeks(30, 30, 30), inProgress("2026-06-22", 48)]),
    ).toEqual([
      {
        week_starting: "2026-06-22",
        reason:
          "Volume spike so far: 48 km is already 1.6 times the 30 km average of the previous 3 weeks",
      },
    ]);
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
    // The 45 km week against the 3 weeks before it, the empty ones included.
    expect(warnings).toEqual([
      {
        week_starting: "2026-06-22",
        reason:
          "Volume spike: 45 km is 4.5 times the 10 km average of the previous 3 weeks",
      },
    ]);
  });

  it("compares the first weeks with the weeks before the window, which it never flags (#60)", () => {
    // Before the window: 3 steady weeks and a spike week of its own.
    const before = [
      bucket("2026-05-04", 30),
      bucket("2026-05-11", 30),
      bucket("2026-05-18", 30),
      bucket("2026-05-25", 60),
    ];
    const window = [bucket("2026-06-01", 60), bucket("2026-06-08", 40)];

    expect(selectRunWeeks(window, "2026-06-15").warnings).toEqual([]);
    const { span, complete, warnings } = selectRunWeeks(
      window,
      "2026-06-15",
      before,
    );
    expect(span).toEqual(window);
    expect(complete).toEqual(window);
    expect(warnings).toEqual([
      {
        week_starting: "2026-06-01",
        reason:
          "Volume spike: 60 km is 1.6 times the 37.5 km average of the previous 4 weeks",
      },
    ]);
  });

  it("counts the weeks between the baseline and the first run in the window as zero weeks", () => {
    // The window starts on 2026-06-01, but its first run is on 2026-06-15.
    const before = [
      bucket("2026-05-04", 40),
      bucket("2026-05-11", 40),
      bucket("2026-05-18", 40),
      bucket("2026-05-25", 40),
    ];
    const { span, warnings } = selectRunWeeks(
      [bucket("2026-06-15", 64)],
      "2026-06-22",
      before,
    );
    expect(span.map((b) => b.weekStarting)).toEqual(["2026-06-15"]);
    expect(warnings).toEqual([
      {
        week_starting: "2026-06-15",
        reason:
          "Volume spike: 64 km is 3.2 times the 20 km average of the previous 4 weeks",
      },
    ]);
  });

  it("keeps zero-run weeks after the last run, a layoff still going on", () => {
    // 2 weeks of 50 km, then 2 complete weeks with no runs; the week in
    // progress has none yet either.
    const { span, complete, warnings } = selectRunWeeks(
      [
        bucket("2026-06-01", 50),
        bucket("2026-06-08", 50),
        bucket("2026-06-15", 0),
        bucket("2026-06-22", 0),
        bucket("2026-06-29", 0),
      ],
      "2026-06-29",
    );
    expect(span).toHaveLength(5);
    expect(complete.map(weekDistanceKm)).toEqual([50, 50, 0, 0]);
    expect(volumeTrend(complete).label).toBe("decreasing significantly");
    expect(warnings).toEqual([]);
  });

  it("trims load-only weeks before the first run and leaves the week in progress out of complete", () => {
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

  it("says so when a layoff covers all of the last 4 complete weeks", () => {
    expect(volumeTrend(weeks(50, 50, 0, 0, 0, 0))).toEqual({
      label: "no running volume in the last 4 complete weeks",
      weeks: [],
    });
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
    // Both in the week of Mon 2026-06-08. The timeline runs on to the
    // current week, which has no run yet.
    const data = buildTrainingLoadData(
      [run("2026-06-09", 10), run("2026-06-11", 5)],
      until("2026-06-15"),
    );
    expect(data.weeks).toHaveLength(2);
    expect(data.weeks[1]).toMatchObject({
      weekStarting: "2026-06-15",
      runs: 0,
      distanceKm: 0,
      inProgress: true,
    });
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
      "2026-06-22",
    ]);
    expect(data.weeks[1]).toMatchObject({ runs: 0, distanceKm: 0 });
  });

  it("computes the rolling trend over the filled series", () => {
    const data = buildTrainingLoadData(
      [run("2026-06-01", 30), run("2026-06-15", 30)],
      until("2026-06-22"),
    );
    // Middle (zero) week averages its neighbours: (30 + 0 + 30) / 3 = 20.
    // The current week, empty so far, gets no trend point.
    expect(data.weeks.map((w) => w.trendKm)).toEqual([15, 20, 15, null]);
  });

  it("runs the timeline on through a layoff that is still going on", () => {
    // 2 weeks of 50 km, then 2 complete weeks with no runs, called on a
    // Wednesday with no run yet this week.
    const data = buildTrainingLoadData(
      [run("2026-06-02", 50), run("2026-06-09", 50)],
      until("2026-07-01"),
    );
    expect(
      data.weeks.map((w) => [w.weekStarting, w.distanceKm, w.inProgress]),
    ).toEqual([
      ["2026-06-01", 50, false],
      ["2026-06-08", 50, false],
      ["2026-06-15", 0, false],
      ["2026-06-22", 0, false],
      ["2026-06-29", 0, true],
    ]);
    // The line falls with the layoff instead of ending at the last run.
    expect(data.weeks.map((w) => w.trendKm)).toEqual([
      50,
      33.33,
      16.67,
      0,
      null,
    ]);
    expect(data.weeks.some((w) => w.warning)).toBe(false);
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
      [
        run("2026-06-01", 20),
        run("2026-06-08", 20),
        run("2026-06-15", 20),
        run("2026-06-22", 45),
      ],
      until("2026-06-25"),
    );
    expect(data.weeks[3]!.warningReasons).toEqual([
      "Volume spike so far: 45 km is already 2.25 times the 20 km average of the previous 3 weeks",
    ]);
  });

  it("attaches warning flags and reasons to the offending week", () => {
    const data = buildTrainingLoadData(
      [
        run("2026-06-01", 20),
        run("2026-06-08", 20),
        run("2026-06-15", 20),
        run("2026-06-22", 40),
      ],
      until("2026-06-29"),
    );
    const spikeWeek = data.weeks.find((w) => w.weekStarting === "2026-06-22")!;
    expect(spikeWeek.warning).toBe(true);
    expect(spikeWeek.warningReasons).toEqual([
      "Volume spike: 40 km is 2 times the 20 km average of the previous 3 weeks",
    ]);
    expect(data.weeks.filter((w) => w.warning)).toEqual([spikeWeek]);
  });

  it("compares the first weeks with baselineRuns, and reports none of them (#60)", () => {
    // A 14-day window from Monday 2026-06-01. Before it: 3 normal weeks and
    // a 10 km recovery week. The 40 km week after it is no spike; the
    // 65 km week after that is.
    const lookback = until("2026-06-15", 14);
    const baselineRuns = [
      run("2026-05-04", 40),
      run("2026-05-11", 40),
      run("2026-05-18", 40),
      run("2026-05-25", 10),
    ];
    const data = buildTrainingLoadData(
      [run("2026-06-01", 40), run("2026-06-08", 65)],
      lookback,
      { baselineRuns },
    );

    expect(data.weeks.map((w) => w.weekStarting)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
    expect(data.totals.distanceKm).toBe(105);
    expect(data.weeks.map((w) => w.warningReasons)).toEqual([
      [],
      [
        "Volume spike: 65 km is 2 times the 32.5 km average of the previous 4 weeks",
      ],
      [],
    ]);
    // Without the baseline there is no average for either week.
    expect(
      buildTrainingLoadData(
        [run("2026-06-01", 40), run("2026-06-08", 65)],
        lookback,
      ).weeks.some((w) => w.warning),
    ).toBe(false);
  });

  it("baselineWeeks runs from the first baseline run to the week before the window", () => {
    expect(
      baselineWeeks([run("2026-05-13", 30)], { startDate: "2026-06-01" }).map(
        (b) => [b.weekStarting, weekDistanceKm(b)],
      ),
    ).toEqual([
      ["2026-05-11", 30],
      ["2026-05-18", 0],
      ["2026-05-25", 0],
    ]);
    expect(baselineWeeks([], { startDate: "2026-06-01" })).toEqual([]);
  });

  it("keeps zero weeks inside the run span for warnings, like the text tool (#43)", () => {
    // 40 km, three empty weeks, 42 km. The app used to drop the empty weeks
    // (average 41 km, no warning) while the text tool kept them (average
    // 16.4 km). Both now read the same weeks from selectRunWeeks: a return
    // to full volume after a 3-week layoff is flagged, and the 40 km week
    // before the layoff is not.
    const runs = [run("2026-06-01", 40), run("2026-06-29", 42)];
    const lookback = until("2026-07-06", 42);
    const data = buildTrainingLoadData(runs, lookback);

    // 5 complete weeks, then the current week with no run yet.
    expect(data.weeks).toHaveLength(6);
    const returnWeek = data.weeks.find((w) => w.weekStarting === "2026-06-29")!;
    expect(returnWeek.warningReasons).toEqual([
      "Volume spike: 42 km is 4.2 times the 10 km average of the previous 4 weeks",
    ]);
    expect(data.weeks[0]!.warning).toBe(false);
    const shared = selectRunWeeks(
      aggregateWeeks(runs, runs, lookback.currentWeekStart),
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
    // The strength week, then the current week, empty so far.
    expect(data.weeks).toHaveLength(2);
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
    // Weeks before the first activity may be missing data, so with no
    // activity at all there is no timeline, not a row of empty weeks.
    expect(aggregateWeeks([], [], "2026-06-22")).toEqual([]);
  });

  it("runs on to the current week with empty weeks after the last activity", () => {
    const buckets = aggregateWeeks(
      [run("2026-06-02", 50), run("2026-06-09", 50)],
      [],
      "2026-06-29",
    );
    expect(buckets.map((b) => [b.weekStarting, b.runs])).toEqual([
      ["2026-06-01", 1],
      ["2026-06-08", 1],
      ["2026-06-15", 0],
      ["2026-06-22", 0],
      ["2026-06-29", 0],
    ]);
  });

  it("gives the run rules the same weeks whether or not a load-only week follows the last run (runOnly)", () => {
    const runs = [run("2026-06-02", 50), run("2026-06-09", 50)];
    const ride = run("2026-06-16", 0, { type: "Ride", icu_training_load: 60 });
    const runOnly = selectRunWeeks(
      aggregateWeeks(runs, runs, "2026-06-22"),
      "2026-06-22",
    );
    const wholeBody = selectRunWeeks(
      aggregateWeeks(runs, [...runs, ride], "2026-06-22"),
      "2026-06-22",
    );
    const starts = (weeks: WeekBucket[]) => weeks.map((b) => b.weekStarting);

    expect(starts(runOnly.span)).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
    expect(starts(wholeBody.span)).toEqual(starts(runOnly.span));
    expect(starts(wholeBody.complete)).toEqual(starts(runOnly.complete));
    expect(wholeBody.warnings).toEqual(runOnly.warnings);
  });

  it("still reaches an activity dated after the current week (a time-zone mismatch)", () => {
    const buckets = aggregateWeeks([run("2026-06-30", 8)], [], "2026-06-22");
    expect(buckets.map((b) => b.weekStarting)).toEqual(["2026-06-29"]);
  });

  it("unions run weeks and load-only weeks, extending the timeline past the run range", () => {
    const buckets = aggregateWeeks(
      [run("2026-06-08", 10)],
      [
        run("2026-06-08", 0, { type: "Run", icu_training_load: 50 }),
        run("2026-06-22", 0, { type: "WeightTraining", icu_training_load: 20 }),
      ],
      "2026-06-22",
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
    const a = aggregateWeeks(runs, loadActivities, "2026-06-15");
    const b = aggregateWeeks(runs, loadActivities, "2026-06-15");
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
