import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_ONLY_RUNWAY_DAYS } from "./fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities,
} from "./intervalsClient";
import { trainingLoadWindow } from "./trainingLoad";
import { loadTrainingLoadInputs } from "./trainingLoadInputs";
import { addDays } from "./utils/localDate";

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return { ...actual, listActivities: vi.fn(), getWellness: vi.fn() };
});

const mockedList = vi.mocked(listActivities);
const mockedWellness = vi.mocked(getWellness);

const TODAY = "2026-08-19";

function activity(
  date: string,
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: `a-${date}`,
    name: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: 8000,
    moving_time: 2400,
    total_elevation_gain: 60,
    icu_training_load: 50,
    ...overrides,
  } as IntervalsActivity;
}

function wellnessRow(
  date: string,
  values: Partial<IntervalsWellness> = {},
): IntervalsWellness {
  return {
    id: date,
    ctl: 50,
    atl: 40,
    ctlLoad: 0,
    atlLoad: 0,
    ...values,
  } as IntervalsWellness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("loadTrainingLoadInputs", () => {
  it("whole-body: reads current CTL/ATL/TSB from wellness and classifies types with typesWithLoad", async () => {
    mockedList.mockResolvedValueOnce([
      activity(TODAY, { type: "Run", icu_training_load: 40 }),
      activity(addDays(TODAY, -1), {
        type: "Ride",
        icu_training_load: 30,
      }),
      activity(addDays(TODAY, -2), {
        type: "WeightTraining",
        icu_training_load: 0,
      }),
    ]);
    mockedWellness.mockResolvedValueOnce([
      wellnessRow(addDays(TODAY, -1), { ctl: 44, atl: 38 }),
      wellnessRow(TODAY, { ctl: 45, atl: 39 }),
    ]);

    const result = await loadTrainingLoadInputs(
      "key",
      { days: 28, runOnly: false },
      () => {},
    );

    expect(result.source).toBe("intervals.icu");
    expect(result.current).toEqual({
      date: TODAY,
      ctl: 45,
      atl: 39,
      tsb: 6,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.loadActivities).toHaveLength(3);
    expect(result.activityTypesIncluded).toEqual(["Ride", "Run"]);

    // TODAY is a Wednesday: 4 complete weeks from Monday 2026-07-20, plus
    // this week so far, instead of a window that starts mid-week. The
    // listing starts 4 weeks earlier, for the volume-spike baseline;
    // wellness does not need it.
    expect(result.lookback).toEqual(trainingLoadWindow(28, TODAY));
    const [, options] = mockedList.mock.calls[0]!;
    expect(options.oldest).toBe("2026-06-22");
    expect(options.newest).toBe(TODAY);
    const [, wellnessOptions] = mockedWellness.mock.calls[0]!;
    expect(wellnessOptions).toEqual({ oldest: "2026-07-20", newest: TODAY });
  });

  it("whole-body: keeps the 4 weeks before the window as baseline runs only (#60)", async () => {
    mockedList.mockResolvedValueOnce([
      activity(TODAY, { id: "window-run" }),
      activity("2026-07-19", { id: "baseline-run" }),
      activity("2026-07-19", {
        id: "baseline-ride",
        type: "Ride",
        icu_training_load: 90,
      }),
      activity("2026-06-22", { id: "first-baseline-day" }),
    ]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await loadTrainingLoadInputs(
      "key",
      { days: 28, runOnly: false },
      () => {},
    );

    expect(result.runs.map((a) => a.id)).toEqual(["window-run"]);
    expect(result.loadActivities.map((a) => a.id)).toEqual(["window-run"]);
    expect(result.activityTypesIncluded).toEqual(["Run"]);
    expect(result.baselineRuns.map((a) => a.id)).toEqual([
      "baseline-run",
      "first-baseline-day",
    ]);
  });

  it("run-only: fetches a runway, computes CTL/ATL locally, and labels it computed", async () => {
    const days = 28;
    const runwayDays = days + RUN_ONLY_RUNWAY_DAYS;
    mockedList.mockResolvedValueOnce([
      activity(TODAY, { type: "Run" }),
      activity(addDays(TODAY, -1), { type: "Ride" }), // filtered out (not a run type)
    ]);

    const result = await loadTrainingLoadInputs(
      "key",
      { days, runOnly: true },
      () => {},
    );

    expect(result.source).toBe("computed");
    expect(result.activityTypesIncluded).toEqual([
      "Run",
      "TrailRun",
      "VirtualRun",
    ]);
    expect(result.runs).toHaveLength(1);
    expect(result.loadActivities).toBe(result.runs);
    expect(mockedWellness).not.toHaveBeenCalled();

    const [, options] = mockedList.mock.calls[0]!;
    expect(options.oldest).toBe(addDays(TODAY, -(runwayDays - 1)));
    expect(options.newest).toBe(TODAY);
  });

  it("run-only: keeps runs from the whole first week of the window", async () => {
    // A 28-day count back from TODAY starts on Thursday 2026-07-23; the
    // window starts on Monday 2026-07-20, so the Tuesday run is inside it
    // and the first week is complete. The run before it is runway only.
    mockedList.mockResolvedValueOnce([
      activity("2026-07-21", { id: "first-week" }),
      activity("2026-07-19", { id: "runway" }),
      activity("2026-06-21", { id: "before-baseline" }),
    ]);

    const result = await loadTrainingLoadInputs(
      "key",
      { days: 28, runOnly: true },
      () => {},
    );

    expect(result.runs.map((a) => a.id)).toEqual(["first-week"]);
    // The 4 weeks before the window (from Monday 2026-06-22) are the
    // volume-spike baseline; the rest of the runway only feeds CTL/ATL.
    expect(result.baselineRuns.map((a) => a.id)).toEqual(["runway"]);
  });

  it("returns a null current when there is no wellness data in the window", async () => {
    mockedList.mockResolvedValueOnce([]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await loadTrainingLoadInputs(
      "key",
      { days: 28, runOnly: false },
      () => {},
    );

    expect(result.current).toBeNull();
    expect(result.activityTypesIncluded).toEqual([]);
  });
});
