import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATL_TIME_CONSTANT_DAYS,
  addDays,
  CTL_TIME_CONSTANT_DAYS,
} from "../fitnessTrend";
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

const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);
const round1 = (value: number) => Math.round(value * 10) / 10;

const TODAY = "2026-06-28";
const DEFAULT_INPUT = { days: 90, runOnly: false, targetTsb: 10 };

/** YYYY-MM-DD `days` from TODAY, for taper target dates. */
function inDays(days: number): string {
  return addDays(TODAY, days);
}

/**
 * A self-consistent synthetic wellness series (own ctl/atl field reproduces
 * the same recurrence `getFitnessTrendTool` recomputes from ctlLoad/atlLoad),
 * so "current matches wellness exactly" can be asserted directly. `days`
 * consecutive rows ending at `endDate`, load from `loadOf(daysAgo)`.
 */
function wellnessSeries(
  endDate: string,
  days: number,
  loadOf: (daysAgo: number) => number,
  seed = { ctl: 0, atl: 0 },
): IntervalsWellness[] {
  const start = addDays(endDate, -(days - 1));
  let ctl = seed.ctl;
  let atl = seed.atl;
  const rows: IntervalsWellness[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const load = loadOf(days - 1 - i);
    ctl = load * (1 - CTL_DECAY) + ctl * CTL_DECAY;
    atl = load * (1 - ATL_DECAY) + atl * ATL_DECAY;
    rows.push({ id: date, ctl, atl, ctlLoad: load, atlLoad: load });
  }
  return rows;
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

  it("reads whole-body CTL/ATL from wellness and matches it exactly", async () => {
    const wellness = wellnessSeries(TODAY, 91, (daysAgo) =>
      daysAgo < 10 ? 80 : 0,
    );
    mockedWellness.mockResolvedValueOnce(wellness);
    mockedListActivities.mockResolvedValueOnce([run(1), run(3)]);

    const result = await getFitnessTrendTool.execute(DEFAULT_INPUT, "test-key");

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      period: { days: number };
      source: string;
      current: { date: string; ctl: number; atl: number; tsb: number } | null;
      daily: unknown[];
      activity_types_included: string[];
      activities_included: number;
      activities_missing_load: number;
      units: { load: string };
    };
    expect(structured.period.days).toBe(90);
    expect(structured.source).toBe("intervals.icu");
    expect(structured.daily).toHaveLength(90);
    expect(structured.units.load).toContain("training load");

    const lastFixtureRow = wellness[wellness.length - 1]!;
    expect(structured.current!.ctl).toBe(round1(lastFixtureRow.ctl!));
    expect(structured.current!.atl).toBe(round1(lastFixtureRow.atl!));
    expect(structured.current!.tsb).toBe(
      round1(lastFixtureRow.ctl! - lastFixtureRow.atl!),
    );

    expect(structured.activity_types_included).toEqual(["Run"]);
    expect(structured.activities_included).toBe(2);
    expect(structured.activities_missing_load).toBe(0);
    expect(FitnessTrendOutputSchema.safeParse(structured).success).toBe(true);

    // The seed request (window start - 1) plus the 90-day window is one
    // wellness call; the type/count read is one listActivities call.
    expect(mockedWellness).toHaveBeenCalledTimes(1);
    expect(mockedListActivities).toHaveBeenCalledTimes(1);
    const [, range] = mockedListActivities.mock.calls[0]!;
    expect(range).toEqual({
      oldest: addDays(TODAY, -89),
      newest: TODAY,
    });

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Fitness Trend (CTL/ATL/TSB)");
    expect(text).toContain("source: intervals.icu");
  });

  it("notes activities with no training load as informational only", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, () => 0));
    mockedListActivities.mockResolvedValueOnce([
      run(1),
      run(2, { icu_training_load: null }),
    ]);

    const result = await getFitnessTrendTool.execute(DEFAULT_INPUT, "test-key");

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

  it("handles an empty window without erroring", async () => {
    mockedWellness.mockResolvedValueOnce([]);
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(DEFAULT_INPUT, "test-key");

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      current: { ctl: number; atl: number } | null;
      warnings: string[];
    };
    expect(structured.current).toEqual({
      date: TODAY,
      ctl: 0,
      atl: 0,
      tsb: 0,
    });
    expect(structured.warnings.join(" ")).toContain("No activities");
    expect(FitnessTrendOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("projects forward with plannedLoads and infers projectDays from it", async () => {
    mockedWellness.mockResolvedValueOnce(
      wellnessSeries(TODAY, 91, (daysAgo) => (daysAgo < 30 ? 80 : 0)),
    );
    mockedListActivities.mockResolvedValueOnce([]);

    const plannedLoads = [
      { date: inDays(1), load: 40 },
      { date: inDays(2), load: 40 },
      { date: inDays(3), load: 40 },
    ];
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, plannedLoads },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { projection: unknown[] };
    expect(structured.projection).toHaveLength(3);
  });

  it("solves a taper plan to a target date and prints the weekly plan", async () => {
    mockedWellness.mockResolvedValueOnce(
      wellnessSeries(TODAY, 91, (daysAgo) => (daysAgo < 21 ? 80 : 0)),
    );
    mockedListActivities.mockResolvedValueOnce([]);

    const targetDate = inDays(21);
    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, targetDate },
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
    mockedWellness.mockResolvedValueOnce(
      wellnessSeries(TODAY, 91, (daysAgo) => (daysAgo < 10 ? 200 : 0)),
    );
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, targetDate: inDays(2), targetTsb: 25 },
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
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, () => 40));
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await getFitnessTrendTool.execute(
      { ...DEFAULT_INPUT, targetDate: inDays(60) },
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
});
