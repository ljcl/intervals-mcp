import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities,
} from "../intervalsClient";
import { getFitnessTrendTool } from "./getFitnessTrend";
import { FitnessTrendOutputSchema } from "./outputs";

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
const DEFAULT_INPUT = { days: 90, runOnly: false, targetTsb: 10 };

/** YYYY-MM-DD `days` from TODAY, for taper/planned-load dates. */
function inDays(days: number): string {
  return addDays(TODAY, days);
}

/** One wellness row with explicit, directly-read ctl/atl (never a recurrence). */
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

/**
 * `days` consecutive rows ending at `endDate`, values from `valueOf(daysAgo)`.
 * Not derived from the CTL/ATL recurrence: whole-body reads these numbers
 * straight off the row, so a test fixture never needs to reproduce the model.
 */
function wellnessWindow(
  endDate: string,
  days: number,
  atDaysAgo: (daysAgo: number) => {
    ctl: number;
    atl: number;
    ctlLoad?: number;
    atlLoad?: number;
  },
): IntervalsWellness[] {
  const start = addDays(endDate, -(days - 1));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    return wellnessRow(date, atDaysAgo(days - 1 - i));
  });
}

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
    icu_training_load: 60,
    ...overrides,
  } as IntervalsActivity;
}

describe("get-fitness-trend execute (whole-body, default)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    mockedWellness.mockReset();
    mockedListActivities.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads whole-body CTL/ATL directly from wellness, never recomputing the recurrence", async () => {
    // These ctl/atl jumps are impossible from the standard 42/7-day
    // recurrence fed ctlLoad/atlLoad (a real model could never move ATL from
    // 60.1 to 25.0, or CTL from 39.9 to 91.2, in a single day from these
    // loads); the assertions below only pass if the tool reads `ctl`/`atl`
    // straight off each row instead of recomputing them.
    const wellness = [
      wellnessRow(addDays(TODAY, -2), {
        ctl: 38.4,
        atl: 60.1,
        ctlLoad: 70,
        atlLoad: 95,
      }),
      wellnessRow(addDays(TODAY, -1), {
        ctl: 39.9,
        atl: 25.0,
        ctlLoad: 0,
        atlLoad: 0,
      }),
      wellnessRow(TODAY, { ctl: 91.2, atl: 84.7, ctlLoad: 65, atlLoad: 110 }),
    ];
    mockedWellness.mockResolvedValueOnce(wellness);
    mockedListActivities.mockResolvedValueOnce([run(1), run(3)]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 3 },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      period: { days: number };
      source: string;
      as_of: string | null;
      current: { date: string; ctl: number; atl: number; tsb: number } | null;
      daily: {
        date: string;
        load: number;
        ctl: number;
        atl: number;
        tsb: number;
      }[];
      activity_types_included: string[];
      activities_included: number;
      activities_missing_load: number;
      units: { load: string };
    };
    expect(structured.period.days).toBe(3);
    expect(structured.source).toBe("intervals.icu");
    expect(structured.as_of).toBe(TODAY);
    expect(structured.units.load).toContain("training load");

    expect(structured.daily).toEqual([
      { date: addDays(TODAY, -2), load: 95, ctl: 38.4, atl: 60.1, tsb: -21.7 },
      { date: addDays(TODAY, -1), load: 0, ctl: 39.9, atl: 25, tsb: 14.9 },
      { date: TODAY, load: 110, ctl: 91.2, atl: 84.7, tsb: 6.5 },
    ]);
    expect(structured.current).toEqual({
      date: TODAY,
      ctl: 91.2,
      atl: 84.7,
      tsb: 6.5,
    });

    expect(structured.activity_types_included).toEqual(["Run"]);
    expect(structured.activities_included).toBe(2);
    expect(structured.activities_missing_load).toBe(0);
    expect(FitnessTrendOutputSchema.safeParse(structured).success).toBe(true);

    expect(mockedWellness).toHaveBeenCalledTimes(1);
    expect(mockedListActivities).toHaveBeenCalledTimes(1);
    const [, range] = mockedListActivities.mock.calls[0]!;
    expect(range).toEqual({ oldest: addDays(TODAY, -2), newest: TODAY });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Fitness Trend (CTL/ATL/TSB)");
    expect(text).toContain("source: intervals.icu");
    expect(text).toContain(`as of ${TODAY}`);
  });

  it("excludes activity types with zero or missing load from activity_types_included", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 50, atl: 50 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([
      run(0, { type: "Run", icu_training_load: 60 }),
      run(0, { id: "rest-day", type: "Yoga", icu_training_load: 0 }),
      run(0, { id: "no-load", type: "Swim", icu_training_load: null }),
    ]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1 },
      "test-key",
    );

    const structured = result.structuredContent as {
      activity_types_included: string[];
    };
    expect(structured.activity_types_included).toEqual(["Run"]);
  });

  it("notes activities with no training load as informational only", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 50, atl: 50 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([
      run(0),
      run(0, { id: "no-load", icu_training_load: null }),
    ]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1 },
      "test-key",
    );

    const structured = result.structuredContent as {
      activities_missing_load: number;
      warnings: string[];
    };
    expect(structured.activities_missing_load).toBe(1);
    expect(structured.warnings.join(" ")).toContain(
      "no training load recorded",
    );
    expect(structured.warnings.join(" ")).toContain("fatigue (ATL) only");
  });

  it("reports a wellness gap as missing, not zero-load, days", async () => {
    const wellness = [
      wellnessRow(addDays(TODAY, -2), { ctl: 40, atl: 45 }),
      // addDays(TODAY, -1) is missing entirely: a gap, not a rest day.
      wellnessRow(TODAY, { ctl: 41, atl: 44 }),
    ];
    mockedWellness.mockResolvedValueOnce(wellness);
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 3 },
      "test-key",
    );

    const structured = result.structuredContent as {
      daily: unknown[];
      current: { date: string } | null;
      warnings: string[];
    };
    expect(structured.daily).toHaveLength(2);
    expect(structured.current!.date).toBe(TODAY);
    expect(structured.warnings.join(" ")).toContain(
      "no wellness CTL/ATL recorded",
    );
  });

  it("handles an empty window without erroring", async () => {
    mockedWellness.mockResolvedValueOnce([]);
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(DEFAULT_INPUT, "test-key");

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      current: unknown;
      as_of: string | null;
      warnings: string[];
    };
    expect(structured.current).toBeNull();
    expect(structured.as_of).toBeNull();
    expect(structured.warnings.join(" ")).toContain("No activities");
    expect(FitnessTrendOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("defaults projectDays to the span of sparse plannedLoads, capped at 60", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 50, atl: 50 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([]);

    const plannedLoads = [
      { date: inDays(7), load: 55 },
      { date: inDays(10), load: 42 },
    ];
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1, plannedLoads },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      projection: { date: string; load: number }[];
    };
    expect(structured.projection).toHaveLength(10);
    expect(structured.projection[6]).toMatchObject({
      date: inDays(7),
      load: 55,
    });
    expect(structured.projection[9]).toMatchObject({
      date: inDays(10),
      load: 42,
    });
    // Unlisted days inside the projection are rest.
    expect(structured.projection[0]!.load).toBe(0);
  });

  it("warns about plannedLoads entries on/before today or beyond the projection", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 50, atl: 50 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([]);

    const plannedLoads = [
      { date: TODAY, load: 10 },
      { date: inDays(3), load: 30 },
      { date: inDays(10), load: 30 },
    ];
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1, projectDays: 5, plannedLoads },
      "test-key",
    );

    const structured = result.structuredContent as {
      warnings: string[];
      projection: { date: string; load: number }[];
    };
    expect(structured.projection).toHaveLength(5);
    expect(structured.projection[2]).toMatchObject({
      date: inDays(3),
      load: 30,
    });
    expect(structured.warnings.join(" ")).toContain("on or before today");
    expect(structured.warnings.join(" ")).toContain(
      "beyond the 5-day projection",
    );
  });

  it("projects through an unsynced trailing gap, always ending at today + resolvedProjectDays", async () => {
    // Wellness has synced through yesterday only; today itself is a gap.
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(addDays(TODAY, -1), { ctl: 50, atl: 60 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([]);

    const plannedLoads = [
      { date: TODAY, load: 999 }, // stale: not after today, must not apply
      { date: inDays(7), load: 55 },
      { date: inDays(10), load: 42 },
    ];
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 2, plannedLoads },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      as_of: string | null;
      projection: { date: string; load: number }[];
      warnings: string[];
    };
    expect(structured.as_of).toBe(addDays(TODAY, -1));
    // 1 unsynced day (today) + the 10-day span to the last planned date.
    expect(structured.projection).toHaveLength(11);
    expect(structured.projection[0]).toMatchObject({ date: TODAY, load: 0 });
    expect(structured.projection[7]).toMatchObject({
      date: inDays(7),
      load: 55,
    });
    expect(
      structured.projection[structured.projection.length - 1],
    ).toMatchObject({ date: inDays(10), load: 42 });
    expect(structured.warnings.join(" ")).toContain("has not synced for 1 day");
    expect(structured.warnings.join(" ")).toContain("on or before today");
  });

  it("solves a taper plan to a target date and prints the weekly plan", async () => {
    mockedWellness.mockResolvedValueOnce(
      wellnessWindow(TODAY, 30, (daysAgo) => ({
        ctl: daysAgo === 0 ? 50 : 45,
        atl: daysAgo === 0 ? 70 : 40,
        atlLoad: daysAgo < 28 ? 80 : 0,
      })),
    );
    mockedListActivities.mockResolvedValueOnce([]);

    const targetDate = inDays(21);
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 30, targetDate },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      taper: {
        target_date: string;
        achieved_tsb: number;
        feasible: boolean;
        weeks: unknown[];
        days: unknown[];
      } | null;
    };
    expect(structured.taper).not.toBeNull();
    const taper = structured.taper!;
    expect(taper.target_date).toBe(targetDate);
    expect(taper.achieved_tsb).toBeCloseTo(10, 1);
    expect(taper.feasible).toBe(true);
    expect(taper.weeks).toHaveLength(3);
    expect(taper.days).toHaveLength(21);

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`Taper plan to ${targetDate} (target TSB +10)`);
    expect(text).toContain("Week 1 (");
  });

  it("says so when even rest cannot reach the target in time", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 30, atl: 230 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1, targetDate: inDays(2), targetTsb: 25 },
      "test-key",
    );

    const taper = (
      result.structuredContent as {
        taper: { feasible: boolean; note: string; total_load: number };
      }
    ).taper;
    expect(taper.feasible).toBe(false);
    expect(taper.note).toContain("complete rest");
    expect(result.content[0]?.text).toContain("complete rest");
  });

  it("warns that a long plan is a training block, not a taper", async () => {
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(TODAY, { ctl: 50, atl: 50 }),
    ]);
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 1, targetDate: inDays(60) },
      "test-key",
    );

    const structured = result.structuredContent as { warnings: string[] };
    expect(structured.warnings.join(" ")).toContain("training block");
  });

  it("surfaces API failures as tool errors", async () => {
    mockedWellness.mockRejectedValueOnce(new Error("intervals.icu blew up"));

    const result = await getFitnessTrendTool.execute(DEFAULT_INPUT, "test-key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("intervals.icu blew up");
  });
});

describe("get-fitness-trend execute (runOnly: true)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    mockedWellness.mockReset();
    mockedListActivities.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes CTL/ATL/TSB locally from run load only, with a long runway", async () => {
    const days = 30;
    const runway = days + 150;
    const activities = Array.from({ length: 20 }, (_, i) =>
      run(i + 1, { icu_training_load: 70 }),
    );
    mockedListActivities.mockResolvedValueOnce(activities);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days, runOnly: true },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedWellness).not.toHaveBeenCalled();
    expect(mockedListActivities).toHaveBeenCalledTimes(1);
    const [, range] = mockedListActivities.mock.calls[0]!;
    expect(range).toEqual({
      oldest: addDays(TODAY, -(runway - 1)),
      newest: TODAY,
    });

    const structured = result.structuredContent as {
      period: { days: number };
      source: string;
      daily: unknown[];
      current: { ctl: number; atl: number } | null;
      activity_types_included: string[];
      activities_included: number;
      warnings: string[];
    };
    expect(structured.period.days).toBe(days);
    expect(structured.source).toBe("computed");
    expect(structured.daily).toHaveLength(days);
    expect(structured.current!.ctl).toBeGreaterThan(0);
    expect(structured.activity_types_included).toEqual([
      "Run",
      "TrailRun",
      "VirtualRun",
    ]);
    expect(structured.activities_included).toBe(20);
    expect(structured.warnings.join(" ")).toContain("zero-seeded");
    expect(FitnessTrendOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("only sums Run/TrailRun/VirtualRun load, ignoring other types", async () => {
    mockedListActivities.mockResolvedValueOnce([
      run(0, { type: "Run", icu_training_load: 60 }),
      run(0, { id: "ride-1", type: "Ride", icu_training_load: 200 }),
    ]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days: 5, runOnly: true },
      "test-key",
    );

    const structured = result.structuredContent as {
      daily: { date: string; load: number }[];
    };
    const today = structured.daily[structured.daily.length - 1]!;
    expect(today.load).toBe(60);
  });

  it("settles CTL from the runway, so the displayed window can start with fitness already built up", async () => {
    const days = 10;
    // The only load is well before the displayed window, deep in the
    // zero-seeded runway.
    const activities = [run(days + 50, { icu_training_load: 300 })];
    mockedListActivities.mockResolvedValueOnce(activities);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, days, runOnly: true },
      "test-key",
    );

    const structured = result.structuredContent as {
      daily: { date: string; ctl: number }[];
    };
    expect(structured.daily).toHaveLength(days);
    expect(structured.daily[0]!.ctl).toBeGreaterThan(0);
  });
});
