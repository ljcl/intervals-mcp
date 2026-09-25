import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, RUN_TYPES } from "../fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities,
} from "../intervalsClient";
import { buildTrainingLoadData } from "../trainingLoad";
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
      period: { days: number };
      totals: { runs: number; distance_km: number; load: number };
      weekly_breakdown: unknown[];
      run_only: boolean;
      source: string;
      current: unknown;
    };
    expect(structured.period.days).toBe(28);
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
    const appData = buildTrainingLoadData(runActivities, 28, {
      loadActivities: activities,
      runOnly: false,
    });

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
