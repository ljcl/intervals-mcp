import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_ONLY_RUNWAY_DAYS } from "./fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities,
} from "./intervalsClient";
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

    const [, options] = mockedList.mock.calls[0]!;
    expect(options.oldest).toBe(addDays(TODAY, -27));
    expect(options.newest).toBe(TODAY);
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
