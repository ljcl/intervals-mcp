import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_TYPES } from "../fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities,
} from "../intervalsClient";
import { buildTrainingLoadData, trainingLoadWindow } from "../trainingLoad";
import { addDays, daysBetween, startOfWeekMonday } from "../utils/localDate";
import { getTrainingLoadTool } from "./getTrainingLoad";
import { TrainingLoadOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getWellness: vi.fn(), listActivities: vi.fn() };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedWellness = vi.mocked(getWellness);
const mockedListActivities = vi.mocked(listActivities);

const TODAY = "2026-06-28";
const DEFAULT_INPUT = { days: 28, runOnly: false };

function run(
  daysAgo: number,
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  const date = addDays(TODAY, -daysAgo);
  return {
    id: `run-${daysAgo}`,
    name: `Run ${daysAgo}d ago`,
    type: "Run",
    start_date_local: `${date}T07:00:00`,
    distance: 10000,
    moving_time: 3600,
    total_elevation_gain: 100,
    icu_training_load: 60,
    ...overrides,
  } as IntervalsActivity;
}

function wellnessRow(
  date: string,
  values: { ctl: number; atl: number; ctlLoad?: number; atlLoad?: number },
): IntervalsWellness {
  return {
    id: date,
    ctl: values.ctl,
    atl: values.atl,
    ctlLoad: values.ctlLoad ?? 0,
    atlLoad: values.atlLoad ?? 0,
  } as IntervalsWellness;
}

describe("get-training-load execute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    mockedWellness.mockReset();
    mockedListActivities.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates runs into weekly totals and structured output (whole-body)", async () => {
    mockedListActivities.mockResolvedValueOnce([run(2), run(9), run(9.5)]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      period: { days: number; start_date: string; end_date: string };
      totals: { runs: number; distance_km: number; load: number };
      weekly_breakdown: unknown[];
      run_only: boolean;
      source: string;
      current: unknown;
    };
    // TODAY is a Sunday: 4 complete weeks plus all 7 days of this week.
    expect(structured.period).toEqual({
      days: 35,
      start_date: "2026-05-25",
      end_date: TODAY,
    });
    expect(structured.totals.runs).toBe(3);
    expect(structured.totals.distance_km).toBe(30);
    expect(structured.totals.load).toBe(180);
    expect(structured.run_only).toBe(false);
    expect(structured.source).toBe("intervals.icu");
    expect(structured.current).toBeNull();
    expect(structured.weekly_breakdown.length).toBeGreaterThanOrEqual(1);
    expect(TrainingLoadOutputSchema.safeParse(structured).success).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Training Load Summary");
    expect(text).toContain("Runs: 3");
  });

  it("prints total time from the seconds total, in the weekly lines' h:mm:ss form", async () => {
    // One 1:00:17 run in each of four weeks. Each week rounds to 1.00 h, so
    // minutes split out of the rounded hours printed "4h 0m" for 4:01:08.
    mockedListActivities.mockResolvedValueOnce(
      [0, 7, 14, 21].map((daysAgo) => run(daysAgo, { moving_time: 3617 })),
    );
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("  Time: 4:01:08\n");
    expect(text).toContain("1 runs, 10 km, 1:00:17, load 60");
    expect(text).not.toMatch(/\d+h \d+m/);
  });

  it("filters weekly volume/warnings to run types but sums load over every type (whole-body)", async () => {
    mockedListActivities.mockResolvedValueOnce([
      run(2),
      run(3, {
        id: "ride",
        type: "Ride",
        icu_training_load: 40,
        distance: 20000,
      }),
    ]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const structured = result.structuredContent as {
      totals: { runs: number; load: number };
      activity_types_included: string[];
    };
    expect(structured.totals.runs).toBe(1);
    expect(structured.totals.load).toBe(100);
    expect(structured.activity_types_included.sort()).toEqual(["Ride", "Run"]);
  });

  it("averages/numWeeks/trend are run-based: a load-only week outside the run span does not dilute them", async () => {
    const runs = [run(2), run(9)];

    mockedListActivities.mockResolvedValueOnce(runs);
    mockedWellness.mockResolvedValueOnce([]);
    const baseline = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );
    const baselineStructured = baseline.structuredContent as {
      averages: { runs_per_week: number; distance_km_per_week: number };
      trend: string;
      weekly_breakdown: unknown[];
    };

    // Same two runs, plus a load-only activity three weeks before the
    // earliest run week: aggregateWeeks fills the gap weeks in between
    // (see AGENTS.md's "derived numbers have exactly one home"), so the
    // weekly timeline grows, but the run-based averages/trend must not.
    mockedListActivities.mockResolvedValueOnce([
      ...runs,
      run(23, {
        id: "ride",
        type: "Ride",
        icu_training_load: 40,
        distance: 20000,
      }),
    ]);
    mockedWellness.mockResolvedValueOnce([]);
    const withRide = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );
    const withRideStructured = withRide.structuredContent as {
      averages: { runs_per_week: number; distance_km_per_week: number };
      trend: string;
      weekly_breakdown: unknown[];
    };

    expect(withRideStructured.weekly_breakdown.length).toBeGreaterThan(
      baselineStructured.weekly_breakdown.length,
    );
    expect(withRideStructured.averages).toEqual(baselineStructured.averages);
    expect(withRideStructured.trend).toBe(baselineStructured.trend);
  });

  it("keeps empty weeks inside the run span (runOnly): averages and trend see the gap", async () => {
    // One 10 km run a week over 6 complete weeks, with the week of
    // 2026-05-25 left empty on purpose, plus a run in this week (TODAY is a
    // Sunday, so the week of 2026-06-22 is still in progress).
    mockedListActivities.mockResolvedValueOnce([
      run(2), // week of 2026-06-22 (in progress)
      run(9), // week of 2026-06-15
      run(16), // week of 2026-06-08
      run(23), // week of 2026-06-01
      // week of 2026-05-25: empty
      run(37), // week of 2026-05-18
      run(44), // week of 2026-05-11 (oldest)
    ]);

    const result = await getTrainingLoadTool.execute(
      { days: 49, runOnly: true },
      "test-token",
    );

    const structured = result.structuredContent as {
      averages: { runs_per_week: number; distance_km_per_week: number };
      trend: string;
      weekly_breakdown: Array<{ week_starting: string; runs: number }>;
    };

    expect(structured.weekly_breakdown).toHaveLength(7);
    expect(
      structured.weekly_breakdown.filter((w) => w.runs === 0),
    ).toHaveLength(1);
    // Averaged over the 6 complete weeks of the run span, the empty one
    // included: 5 runs, 50 km. The week in progress is left out.
    expect(structured.averages.runs_per_week).toBe(0.8);
    expect(structured.averages.distance_km_per_week).toBe(8.33);

    // The last 2 complete weeks (20 km) against the 2 before (the empty week
    // and one run, 10 km): a real 100% increase. Dropping the empty week
    // would compare two 20 km fortnights and report "stable".
    expect(structured.trend).toBe("increasing significantly");
    expect(result.content[0]?.text).toContain(
      "Trend: increasing significantly (weeks of 2026-06-08 and 2026-06-15 vs 2026-05-25 and 2026-06-01)",
    );
  });

  it("reads whole-body current CTL/ATL/TSB from wellness (last available day)", async () => {
    mockedListActivities.mockResolvedValueOnce([run(2)]);
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(addDays(TODAY, -1), { ctl: 40, atl: 35 }),
    ]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const structured = result.structuredContent as {
      current: { date: string; ctl: number; atl: number; tsb: number } | null;
      source: string;
    };
    expect(structured.current).toEqual({
      date: addDays(TODAY, -1),
      ctl: 40,
      atl: 35,
      tsb: 5,
    });
    expect(structured.source).toBe("intervals.icu");
  });

  it("computes run-only load/current locally over the runway, labeled computed", async () => {
    // One listActivities call covers the runway; recent runs give the
    // recurrence something non-zero to land on.
    const runs = Array.from({ length: 10 }, (_, i) =>
      run(i, { icu_training_load: 50 }),
    );
    mockedListActivities.mockResolvedValueOnce([
      ...runs,
      run(3, {
        id: "ride",
        type: "Ride",
        icu_training_load: 999,
        distance: 20000,
      }),
    ]);

    const result = await getTrainingLoadTool.execute(
      { days: 28, runOnly: true },
      "test-token",
    );

    expect(mockedListActivities).toHaveBeenCalledTimes(1);
    expect(mockedWellness).not.toHaveBeenCalled();

    const structured = result.structuredContent as {
      run_only: boolean;
      source: string;
      totals: { load: number };
      current: { ctl: number; atl: number; tsb: number } | null;
      activity_types_included: string[];
    };
    expect(structured.run_only).toBe(true);
    expect(structured.source).toBe("computed");
    expect(structured.activity_types_included).toEqual([
      "Run",
      "TrailRun",
      "VirtualRun",
    ]);
    // The Ride's 999 load must not appear in a run-only total.
    expect(structured.totals.load).toBe(500);
    expect(structured.current).not.toBeNull();
    expect(structured.current!.ctl).toBeGreaterThan(0);

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("computed locally");
  });

  it("reports insufficient data for a short history", async () => {
    mockedListActivities.mockResolvedValueOnce([run(2)]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const structured = result.structuredContent as { trend: string };
    expect(structured.trend).toBe("insufficient data");
  });

  it("always notes that volume/warnings are run-based only", async () => {
    mockedListActivities.mockResolvedValueOnce([run(2)]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const structured = result.structuredContent as { warnings: string[] };
    expect(
      structured.warnings.some((w) => w.includes("Run/TrailRun/VirtualRun")),
    ).toBe(true);
  });

  it("reports load for a window with no runs at all (whole-body)", async () => {
    mockedListActivities.mockResolvedValueOnce([
      run(2, {
        id: "strength",
        type: "WeightTraining",
        icu_training_load: 30,
        distance: 0,
      }),
    ]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    const structured = result.structuredContent as {
      totals: { runs: number; load: number };
      weekly_breakdown: unknown[];
    };
    expect(structured.totals.runs).toBe(0);
    expect(structured.totals.load).toBe(30);
    expect(structured.weekly_breakdown.length).toBe(1);
  });

  it("produces the same weekly load as the training-load app feed for the same activities", async () => {
    const activities = [
      run(2),
      run(9, {
        id: "strength",
        type: "WeightTraining",
        icu_training_load: 25,
        distance: 0,
      }),
    ];
    mockedListActivities.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );
    const structured = result.structuredContent as {
      weekly_breakdown: Array<{ week_starting: string; load: number }>;
      totals: { load: number };
    };

    const runActivities = activities.filter((a) =>
      RUN_TYPES.includes(a.type ?? ""),
    );
    const appData = buildTrainingLoadData(
      runActivities,
      trainingLoadWindow(28, TODAY),
      { loadActivities: activities, runOnly: false },
    );

    const textLoadByWeek = Object.fromEntries(
      structured.weekly_breakdown.map((w) => [w.week_starting, w.load]),
    );
    const appLoadByWeek = Object.fromEntries(
      appData.weeks.map((w) => [w.weekStarting, w.load]),
    );
    expect(textLoadByWeek).toEqual(appLoadByWeek);
    expect(structured.totals.load).toBe(appData.totals.load);
  });

  it("returns isError when the fetch fails", async () => {
    mockedListActivities.mockRejectedValueOnce(new Error("Rate limited"));

    const result = await getTrainingLoadTool.execute(
      DEFAULT_INPUT,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("Rate limited");
  });
});

function runOn(date: string, km: number): IntervalsActivity {
  return {
    id: `run-${date}`,
    name: "Run",
    type: "Run",
    start_date_local: `${date}T07:00:00`,
    distance: km * 1000,
    moving_time: km * 330,
    total_elevation_gain: 0,
    icu_training_load: km * 6,
  } as IntervalsActivity;
}

/**
 * The issue's steady runner: 60 km every week, 8 km Monday to Thursday and
 * Saturday, 20 km Sunday, Friday off.
 */
function steadyRuns(from: string, to: string): IntervalsActivity[] {
  const kmByDay = [8, 8, 8, 8, 0, 8, 20]; // Monday first
  const runs: IntervalsActivity[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const km = kmByDay[daysBetween(startOfWeekMonday(date), date)]!;
    if (km > 0) runs.push(runOn(date, km));
  }
  return runs;
}

describe("get-training-load weeks (#43)", () => {
  interface Structured {
    period: { days: number; start_date: string; end_date: string };
    averages: { runs_per_week: number; distance_km_per_week: number };
    trend: string;
    warnings: string[];
    weekly_breakdown: Array<{ week_starting: string; distance_km: number }>;
  }

  /** Serves only the activities inside the requested range, as intervals.icu does. */
  function serve(activities: IntervalsActivity[]) {
    mockedListActivities.mockImplementation(async (_key, { oldest, newest }) =>
      activities.filter((a) => {
        const date = a.start_date_local.split("T")[0]!;
        return date >= oldest && date <= newest;
      }),
    );
    mockedWellness.mockResolvedValue([]);
  }

  async function callOn(today: string, days: number) {
    vi.setSystemTime(new Date(`${today}T12:00:00Z`));
    const result = await getTrainingLoadTool.execute(
      { days, runOnly: false },
      "test-token",
    );
    return {
      structured: result.structuredContent as Structured,
      text: result.content[0]?.text ?? "",
    };
  }

  const injuryWarnings = (warnings: string[]) =>
    warnings.filter((w) => /injury risk|Unusually high/.test(w));

  beforeEach(() => {
    vi.useFakeTimers();
    mockedWellness.mockReset();
    mockedListActivities.mockReset();
    serve(steadyRuns("2026-07-01", "2026-10-31"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a steady runner as steady on a Saturday: no warnings, stable, 60 km/week", async () => {
    // Before the fix the window started on Sunday 2026-08-30, so the first
    // week held 1 day (20 km): "Volume increased 200%", a "decreasing
    // significantly" trend against the unfinished current week, and an
    // average of 48 km over 5 buckets.
    const { structured, text } = await callOn("2026-09-26", 28);

    expect(structured.period).toEqual({
      days: 34,
      start_date: "2026-08-24",
      end_date: "2026-09-26",
    });
    expect(structured.weekly_breakdown.map((w) => w.distance_km)).toEqual([
      60, 60, 60, 60, 40,
    ]);
    expect(injuryWarnings(structured.warnings)).toEqual([]);
    expect(structured.trend).toBe("stable");
    expect(structured.averages.distance_km_per_week).toBe(60);
    expect(structured.averages.runs_per_week).toBe(6);
    expect(structured.warnings).toContain(
      "Week of 2026-09-21 is in progress (6 of 7 days): averages and the trend leave it out.",
    );
    expect(text).toContain(
      "2026-08-24 to 2026-09-26 (4 complete weeks and this week so far",
    );
    expect(text).toContain("Weekly Averages (4 complete weeks)");
    expect(text).toContain(
      "Week of 2026-09-21 (in progress, 6 of 7 days): 5 runs, 40 km",
    );
  });

  it("reads a steady runner as steady on a Tuesday", async () => {
    // Before the fix: buckets of 44, 60, 60, 60 and 16 km, a "+36%" warning
    // and a "decreasing significantly" trend.
    const { structured } = await callOn("2026-09-29", 28);

    expect(structured.weekly_breakdown.map((w) => w.distance_km)).toEqual([
      60, 60, 60, 60, 16,
    ]);
    expect(injuryWarnings(structured.warnings)).toEqual([]);
    expect(structured.trend).toBe("stable");
    expect(structured.averages.distance_km_per_week).toBe(60);
  });

  it("averages a 56-day window over 8 complete weeks, not 9 buckets", async () => {
    const { structured, text } = await callOn("2026-09-26", 56);

    expect(structured.period.start_date).toBe("2026-07-27");
    expect(structured.weekly_breakdown).toHaveLength(9);
    expect(structured.averages.distance_km_per_week).toBe(60);
    expect(text).toContain("Weekly Averages (8 complete weeks)");
  });

  it("gives every weekday the same verdict for the same training", async () => {
    for (let i = 0; i < 7; i += 1) {
      const { structured } = await callOn(addDays("2026-09-21", i), 28);
      expect(injuryWarnings(structured.warnings)).toEqual([]);
      expect(structured.trend).toBe("stable");
      expect(structured.averages.distance_km_per_week).toBe(60);
    }
  });

  it("gives the same warnings as the app feed for the 30, 0, 0, 45 km weeks", async () => {
    // 2026-06-29 is a Monday with no run yet, so all four weeks are complete.
    const activities = [runOn("2026-06-03", 30), runOn("2026-06-24", 45)];
    serve(activities);

    const { structured } = await callOn("2026-06-29", 28);
    const appData = buildTrainingLoadData(
      activities,
      trainingLoadWindow(28, "2026-06-29"),
      { loadActivities: activities, runOnly: false },
    );

    const textWarnings = injuryWarnings(structured.warnings);
    const appWarnings = appData.weeks.flatMap((w) =>
      w.warningReasons.map((reason) => `Week of ${w.weekStarting}: ${reason}`),
    );
    expect(textWarnings).toEqual([
      "Week of 2026-06-22: Unusually high volume (45 km vs 19 km average up to that week)",
    ]);
    expect(appWarnings).toEqual(textWarnings);
  });

  it("counts a layoff that is still going on: 2 weeks of 50 km, then 2 empty weeks", async () => {
    // 2026-07-01 is a Wednesday with no run yet this week. Before, the
    // weeks after the last run were left out: 50 km/week over 2 weeks and
    // "limited data", while the athlete had not run for 2 weeks.
    const activities = [runOn("2026-06-02", 50), runOn("2026-06-09", 50)];
    serve(activities);

    const { structured, text } = await callOn("2026-07-01", 28);
    const appData = buildTrainingLoadData(
      activities,
      trainingLoadWindow(28, "2026-07-01"),
      { loadActivities: activities, runOnly: false },
    );

    // Text tool: the trend and the averages count all 4 complete weeks.
    expect(structured.weekly_breakdown.map((w) => w.distance_km)).toEqual([
      50, 50, 0, 0, 0,
    ]);
    expect(structured.trend).toBe("decreasing significantly");
    expect(structured.averages.distance_km_per_week).toBe(25);
    expect(structured.averages.runs_per_week).toBe(0.5);
    expect(text).toContain("Weekly Averages (4 complete weeks)");
    expect(text).toContain(
      "Trend: decreasing significantly (weeks of 2026-06-15 and 2026-06-22 vs 2026-06-01 and 2026-06-08)",
    );
    // No "unusually high" warning on the 50 km weeks from the lower
    // average the layoff brings.
    expect(injuryWarnings(structured.warnings)).toEqual([]);

    // App feed: the same weeks, a trend line that falls with the layoff, and
    // the same (no) warnings.
    expect(appData.weeks.map((w) => [w.weekStarting, w.distanceKm])).toEqual(
      structured.weekly_breakdown.map((w) => [w.week_starting, w.distance_km]),
    );
    expect(appData.weeks.map((w) => w.trendKm)).toEqual([
      50,
      33.33,
      16.67,
      0,
      null,
    ]);
    expect(appData.weeks.some((w) => w.warning)).toBe(false);
  });
});
