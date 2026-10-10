/**
 * Success and error paths for the MCP App tool handlers in server.ts (ljcl/strava-mcp#115).
 * Table-driven through dispatchToolCall, the same path the host uses, with
 * the intervals.icu client mocked. The missing-key table pins the regression
 * where those early returns lacked `isError: true` and surfaced as ordinary
 * content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sportSettingsFixture from "./__fixtures__/intervals/sport-settings.json";
import { viewHeader } from "./clientCapabilities";
import { RateLimitError } from "./fetchClient";
import {
  ATL_TIME_CONSTANT_DAYS,
  CTL_TIME_CONSTANT_DAYS,
  RUN_TYPES,
} from "./fitnessTrend";
import {
  getActivity as getIntervalsActivityFn,
  getActivityStreams as getIntervalsStreamsFn,
  getSportSettings as getSportSettingsFn,
  getWellness as getWellnessFn,
  type IntervalsActivity,
  type IntervalsSportSettings,
  type IntervalsWellness,
  listActivities as listActivitiesFn,
} from "./intervalsClient";
import { addDays } from "./utils/localDate";

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    // No streams and no file unless a test serves them: compare reads both
    // for its per-km table and weather. An implementation passed to vi.fn
    // survives vi.clearAllMocks and mockReset.
    getActivityStreams: vi.fn(async () => []),
    getActivityFile: vi.fn(async () => new Uint8Array()),
    // The cadence trends read the Run pace zones; none unless a test serves
    // them, so the fixed zones apply.
    getSportSettings: vi.fn(async () => null),
    getWellness: vi.fn(),
    listActivities: vi.fn(),
  };
});

// dispatchToolCall resolves the API key once per call (ljcl/strava-mcp#240), so the
// key source is mocked here rather than the env var each handler used to read.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    getIntervalsApiKey: vi.fn(),
    getTimeZone: vi.fn(() => "UTC"),
  };
});

// Import after the mocks so server.ts's modules see the mocked client.
const { dispatchToolCall } = await import("./server");
const { getIntervalsApiKey, MissingApiKeyError } = await import("./config");
const mockedToken = vi.mocked(getIntervalsApiKey);

const mockedIntervalsActivity = vi.mocked(getIntervalsActivityFn);
const mockedIntervalsStreams = vi.mocked(getIntervalsStreamsFn);
const mockedWellness = vi.mocked(getWellnessFn);
const mockedIntervalsList = vi.mocked(listActivitiesFn);

function intervalsActivity(
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: "i123",
    name: "Morning Run",
    type: "Run",
    start_date_local: "2026-06-01T07:00:00",
    distance: 10000,
    moving_time: 3000,
    ...overrides,
  } as IntervalsActivity;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedToken.mockReturnValue("test-token");
});

/** Every app tool with args that pass its input schema. */
const APP_TOOL_CALLS: Array<[string, Record<string, unknown>]> = [
  ["view-activity-chart", { id: "123" }],
  ["get-activity-streams-raw", { id: "123" }],
  ["view-cadence-trends", {}],
  ["get-cadence-trend-data", {}],
  ["view-route-map", { id: "123" }],
  ["get-route-map-data", { id: "123" }],
  ["view-training-load", {}],
  ["get-training-load-data", {}],
  ["view-activity-zones", { id: "123" }],
  ["get-activity-zones-data", { id: "123" }],
  ["view-compare-activities", { activityId1: "1", activityId2: "2" }],
  ["get-compare-activities-data", { activityId1: "1", activityId2: "2" }],
];

describe("app handlers with no key configured", () => {
  it.each(APP_TOOL_CALLS)(
    "%s returns isError: true instead of plain content",
    async (name, args) => {
      mockedToken.mockImplementationOnce(() => {
        throw new MissingApiKeyError();
      });

      const result = await dispatchToolCall(name, args);

      expect(result.isError).toBe(true);
      // One message for every tool, naming the one recovery (ljcl/strava-mcp#240).
      expect(result.content[0]?.text).toContain("INTERVALS_API_KEY");
    },
  );

  it("resolves the key once per call and hands it to the handler", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());

    await dispatchToolCall("view-activity-chart", { id: "i123" });

    expect(mockedToken).toHaveBeenCalledTimes(1);
    expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i123", {
      intervals: true,
    });
  });

  it("does not run the handler when the key cannot be resolved", async () => {
    mockedToken.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    await dispatchToolCall("view-activity-chart", { id: "i123" });

    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
  });
});

describe("view-activity-chart", () => {
  it("summarises the activity for the model", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 1, 2] },
    ]);

    const result = await dispatchToolCall("view-activity-chart", {
      id: "i123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity: Morning Run");
    expect(text).toContain("Distance: 10.00 km");
    expect(text).not.toContain("No recorded streams");
    // Same fetch options as get-activity-streams-raw (intervals: true), so
    // the two share one cache entry.
    expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i123", {
      intervals: true,
    });
  });

  it("surfaces an intervals.icu failure as a structured tool error", async () => {
    mockedIntervalsActivity.mockRejectedValueOnce(
      new Error("Record Not Found"),
    );

    const result = await dispatchToolCall("view-activity-chart", {
      id: "i123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Record Not Found");
  });

  it("says so when the activity has no recorded streams", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    // intervals.icu returns no streams for a manual entry.
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall(
      "view-activity-chart",
      { id: "i123" },
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(
      text.startsWith(
        "Interactive activity chart shown. Its data follows.\n\nActivity: Morning Run",
      ),
    ).toBe(true);
    expect(text).toContain(
      "No recorded streams; the chart has nothing to plot.",
    );
    expect(text.endsWith("For detail, call get-activity.")).toBe(true);
  });

  it("gives a host without MCP Apps the plain fact and no dead-end twin (#77)", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall(
      "view-activity-chart",
      { id: "i123" },
      { client: { rendersApps: false } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("This activity has no recorded streams.");
    expect(text).not.toContain("nothing to plot");
    // get-activity-streams would only repeat that there are no streams.
    expect(text).not.toContain("get-activity-streams");
    expect(
      text.startsWith(
        "This client did not report MCP Apps support, so the interactive activity chart may not show. Its data follows.",
      ),
    ).toBe(true);
    expect(text.endsWith("For detail, call get-activity.")).toBe(true);
  });

  it("reports a stream fetch failure rather than calling the chart empty", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockRejectedValueOnce(new Error("Rate limited"));

    const result = await dispatchToolCall("view-activity-chart", {
      id: "i123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rate limited");
    expect(result.content[0]?.text).not.toContain("No recorded streams");
  });
});

describe("get-activity-streams-raw", () => {
  it("returns downsampled streams keyed by type plus interval bands", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({
        icu_intervals: [
          {
            type: "WORK",
            label: null,
            start_time: 0,
            end_time: 2,
            distance: 1000,
            elapsed_time: 300,
            moving_time: 290,
            average_speed: 3.3,
            average_heartrate: 152,
          },
        ],
      }),
    );
    mockedIntervalsStreams.mockResolvedValueOnce([
      { type: "time", data: [0, 1, 2] },
      { type: "heartrate", data: [140, 150, 160] },
    ]);

    const result = await dispatchToolCall("get-activity-streams-raw", {
      id: "i123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.activityId).toBe("i123");
    expect(parsed.streams.time).toEqual([0, 1, 2]);
    expect(parsed.streams.heartrate).toEqual([140, 150, 160]);
    expect(parsed.laps).toEqual([
      {
        type: "WORK",
        label: null,
        name: "Lap 1",
        startIndex: 0,
        endIndex: 2,
        distance: 1000,
        elapsedTime: 300,
        averageSpeed: 3.3,
        averageHeartrate: 152,
        lapIndex: 1,
      },
    ]);
    expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i123", {
      intervals: true,
    });
  });

  it("returns a valid empty payload for an activity with no streams", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({
        icu_intervals: [{ type: "WORK", start_time: 0, end_time: 60 }],
      }),
    );
    // intervals.icu returns no streams for a manual/no-GPS entry (#65).
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-activity-streams-raw", {
      id: "i123",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      activityId: "i123",
      activityType: "Run",
      name: "Morning Run",
      streams: { time: [] },
      laps: [],
      noStreams: true,
    });
  });

  it("returns isError when the stream fetch fails", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockRejectedValueOnce(new Error("Rate limited"));

    const result = await dispatchToolCall("get-activity-streams-raw", {
      id: "i123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rate limited");
  });
});

describe("cadence trends handlers", () => {
  it("view-cadence-trends reports run count and doubled cadence", async () => {
    mockedIntervalsList.mockResolvedValueOnce([
      intervalsActivity({ average_cadence: 42.5, average_speed: 3.33 }),
      intervalsActivity({ id: "i2", type: "Ride" }), // filtered out
    ]);

    const result = await dispatchToolCall("view-cadence-trends", { days: 28 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Cadence Trends (last 4 weeks)");
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Average cadence: 85 spm");
  });

  it("buckets by the Run sport settings' pace zones, and says so", async () => {
    const runGroup = (
      sportSettingsFixture as unknown as IntervalsSportSettings[]
    ).find((g) => g.types?.includes("Run"))!;
    vi.mocked(getSportSettingsFn).mockResolvedValueOnce(runGroup);
    vi.mocked(getSportSettingsFn).mockResolvedValueOnce(runGroup);
    mockedIntervalsList.mockResolvedValue([
      intervalsActivity({ average_cadence: 85, average_speed: 3.33 }),
    ]);

    const data = JSON.parse(
      (await dispatchToolCall("get-cadence-trend-data", {})).content[0]?.text ??
        "",
    );
    const text =
      (await dispatchToolCall("view-cadence-trends", {})).content[0]?.text ??
      "";

    expect(data.paceZoneSource).toBe("athlete");
    expect(data.paceZones).toHaveLength(7);
    expect(vi.mocked(getSportSettingsFn)).toHaveBeenCalledWith(
      "test-token",
      "Run",
    );
    expect(text).toContain(
      "Cadence by pace zone (the Run sport settings' pace zones):",
    );
    expect(text).toContain("  Zone 5c (faster than 4:11 /km): no runs");
  });

  it("view-cadence-trends names a window that is not whole weeks in days", async () => {
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("view-cadence-trends", { days: 30 });

    expect(result.content[0]?.text).toContain("Cadence Trends (last 30 days)");
  });

  it("get-cadence-trend-data maps runs to per-activity summaries with string ids", async () => {
    mockedIntervalsList.mockResolvedValueOnce([
      intervalsActivity({
        id: "i189807578",
        name: "Easy Run",
        distance: 8000,
        average_cadence: 42.5,
      }),
    ]);

    const result = await dispatchToolCall("get-cadence-trend-data", {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.days).toBe(42);
    expect(parsed).not.toHaveProperty("weeks");
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.activities[0]).toMatchObject({
      id: "i189807578",
      name: "Easy Run",
      distance: 8,
      averageCadence: 85,
    });
  });

  it("narrates the local calendar date for a late-evening run, not a UTC-shifted one", async () => {
    mockedIntervalsList.mockResolvedValueOnce([
      intervalsActivity({
        start_date_local: "2026-06-01T23:30:00",
        average_cadence: 84,
      }),
    ]);

    const result = await dispatchToolCall("get-cadence-trend-data", {});

    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.activities[0]?.date).toBe("2026-06-01");
  });

  it("excludes runs with no recorded cadence and reports the count on both surfaces", async () => {
    mockedIntervalsList.mockResolvedValue([
      intervalsActivity({ id: "i1", average_cadence: 84 }),
      intervalsActivity({ id: "i2", average_cadence: null }),
    ]);

    const dataResult = await dispatchToolCall("get-cadence-trend-data", {});
    const parsed = JSON.parse(dataResult.content[0]?.text ?? "");
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.excludedNoCadence).toBe(1);

    const viewResult = await dispatchToolCall("view-cadence-trends", {});
    const text = viewResult.content[0]?.text ?? "";
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Excluded (no cadence recorded): 1");
  });

  it("a view-/get-…-data pair shares one local-date window (ljcl/strava-mcp#329)", async () => {
    // The two calls of one app open land seconds apart. Cadence-trends now
    // windows on calendar dates (`todayLocal`), which are already the same
    // for calls seconds apart on the same day, so the pair builds the same
    // `oldest`/`newest` bounds and the cached listing is shared.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-19T10:00:05Z"));
      mockedIntervalsList.mockResolvedValue([]);

      await dispatchToolCall("view-cadence-trends", { days: 28 });
      vi.setSystemTime(new Date("2026-08-19T10:00:35Z")); // 30 s later
      await dispatchToolCall("get-cadence-trend-data", { days: 28 });

      const [viewCall, dataCall] = mockedIntervalsList.mock.calls.slice(-2);
      expect(viewCall?.[1]).toEqual(dataCall?.[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the fitness-trend pair shares both window bounds (ljcl/strava-mcp#329)", async () => {
    // The two calls of one app open land seconds apart. Unlike the epoch
    // `after`/`before` the other apps quantize, fitness-trend windows on
    // calendar dates (`todayLocal`), which are already the same for calls
    // seconds apart on the same day, so no quantum is needed.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-19T10:00:05Z"));
      mockedWellness.mockResolvedValue([]);
      mockedIntervalsList.mockResolvedValue([]);

      await dispatchToolCall("view-fitness-trend", {});
      vi.setSystemTime(new Date("2026-08-19T10:00:35Z"));
      await dispatchToolCall("get-fitness-trend-data", {});

      const [viewWellnessCall, dataWellnessCall] =
        mockedWellness.mock.calls.slice(-2);
      expect(viewWellnessCall?.[1]).toEqual(dataWellnessCall?.[1]);
      const [viewListCall, dataListCall] =
        mockedIntervalsList.mock.calls.slice(-2);
      expect(viewListCall?.[1]).toEqual(dataListCall?.[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("training load handlers", () => {
  const TL_TODAY = "2026-06-01";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TL_TODAY}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function intervalsRun(
    overrides: Partial<IntervalsActivity> = {},
  ): IntervalsActivity {
    return {
      id: "1",
      name: "Easy Run",
      type: "Run",
      start_date_local: `${TL_TODAY}T07:00:00`,
      distance: 8000,
      moving_time: 2400,
      total_elevation_gain: 60,
      icu_training_load: 50,
      ...overrides,
    } as IntervalsActivity;
  }

  it("view-training-load summarises totals and warning weeks when its twin fails", async () => {
    mockedIntervalsList.mockResolvedValueOnce([intervalsRun()]);
    mockedWellness.mockResolvedValueOnce([]);
    // The twin's own read fails, so the text is the view's own summary.
    mockedIntervalsList.mockRejectedValueOnce(new Error("twin down"));

    const result = await dispatchToolCall(
      "view-training-load",
      {},
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    // TL_TODAY is a Monday: 12 complete weeks plus today.
    expect(text).toContain(
      "Training Load (2026-03-09 to 2026-06-01, CTL/ATL source: intervals.icu)",
    );
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Distance: 8 km");
    expect(text).toContain("Week of 2026-06-01 is in progress (partial).");
  });

  it("view-training-load prints the whole-body scope and the current fitness line when its twin fails", async () => {
    mockedIntervalsList.mockResolvedValueOnce([
      intervalsRun(),
      intervalsRun({
        id: "2",
        type: "Ride",
        icu_training_load: 30,
        distance: 20000,
      }),
    ]);
    mockedWellness.mockResolvedValueOnce([
      {
        id: TL_TODAY,
        ctl: 52,
        atl: 61,
        ctlLoad: 0,
        atlLoad: 0,
      } as IntervalsWellness,
    ]);
    // The twin's own read fails, so the text is the view's own summary.
    mockedIntervalsList.mockRejectedValueOnce(new Error("twin down"));

    const result = await dispatchToolCall(
      "view-training-load",
      {},
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "Scope: whole-body load (Ride, Run), CTL/ATL from intervals.icu.",
    );
    expect(text).toContain(
      `Current (as of ${TL_TODAY}): CTL 52 / ATL 61 / TSB -9`,
    );
    // The ride counts toward load but not toward the run totals.
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Load: 80");
  });

  it("view-training-load prints the run-only scope and the locally computed current when its twin fails", async () => {
    const run = intervalsRun();
    mockedIntervalsList.mockResolvedValueOnce([run]);
    // The twin's own read fails, so the text is the view's own summary.
    mockedIntervalsList.mockRejectedValueOnce(new Error("twin down"));
    const viewResult = await dispatchToolCall(
      "view-training-load",
      { runOnly: true },
      { client: { rendersApps: true } },
    );
    mockedIntervalsList.mockResolvedValueOnce([run]);
    const dataResult = await dispatchToolCall("get-training-load-data", {
      runOnly: true,
    });

    expect(viewResult.isError).toBeUndefined();
    const text = viewResult.content[0]?.text ?? "";
    const data = JSON.parse(dataResult.content[0]?.text ?? "");
    expect(text).toContain("Scope: run-only load, CTL/ATL computed locally.");
    // The text prints the numbers the app draws: same total, same current.
    expect(text).toContain(`Load: ${data.totals.load}`);
    const { date, ctl, atl, tsb } = data.current;
    expect(text).toContain(
      `Current (as of ${date}): CTL ${ctl} / ATL ${atl} / TSB ${tsb >= 0 ? "+" : ""}${tsb}`,
    );
  });

  it("view-training-load leaves the Current line out when there is no fitness to read and its twin fails", async () => {
    mockedIntervalsList.mockResolvedValueOnce([intervalsRun()]);
    mockedWellness.mockResolvedValueOnce([]);
    // The twin's own read fails, so the text is the view's own summary.
    mockedIntervalsList.mockRejectedValueOnce(new Error("twin down"));

    const result = await dispatchToolCall(
      "view-training-load",
      {},
      { client: { rendersApps: true } },
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "Scope: whole-body load (Run), CTL/ATL from intervals.icu.",
    );
    expect(text).not.toContain("Current (as of");
  });

  it("get-training-load-data returns the weekly aggregation, whole-body by default", async () => {
    mockedIntervalsList.mockResolvedValueOnce([intervalsRun()]);
    mockedWellness.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-training-load-data", {
      days: 84,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.days).toBe(85);
    expect(parsed.startDate).toBe("2026-03-09");
    expect(parsed.endDate).toBe(TL_TODAY);
    expect(parsed.runOnly).toBe(false);
    expect(parsed.source).toBe("intervals.icu");
    expect(parsed.totals.runs).toBe(1);
    expect(parsed.totals.load).toBe(50);
    expect(parsed.weeks).toEqual([
      expect.objectContaining({
        weekStarting: TL_TODAY,
        inProgress: true,
        trendKm: null,
      }),
    ]);
  });

  it("get-training-load-data computes run-only load/current in one listActivities call", async () => {
    mockedIntervalsList.mockResolvedValueOnce([intervalsRun()]);

    const result = await dispatchToolCall("get-training-load-data", {
      days: 84,
      runOnly: true,
    });

    expect(result.isError).toBeUndefined();
    expect(mockedIntervalsList).toHaveBeenCalledTimes(1);
    expect(mockedWellness).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.runOnly).toBe(true);
    expect(parsed.source).toBe("computed");
    expect(parsed.activityTypesIncluded).toEqual([
      "Run",
      "TrailRun",
      "VirtualRun",
    ]);
  });

  it("get-training-load and get-training-load-data agree on current and activityTypesIncluded (#loadTrainingLoadInputs)", async () => {
    const activities = [
      intervalsRun(),
      intervalsRun({
        id: "2",
        type: "WeightTraining",
        icu_training_load: 20,
        distance: 0,
      }),
    ];
    const wellness = [
      {
        id: TL_TODAY,
        ctl: 45,
        atl: 39,
        ctlLoad: 0,
        atlLoad: 0,
      } as IntervalsWellness,
    ];

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce(wellness);
    const appResult = await dispatchToolCall("get-training-load-data", {
      days: 84,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "");

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce(wellness);
    const textResult = await dispatchToolCall("get-training-load", {
      days: 84,
    });
    const textData = textResult.structuredContent as {
      current: { ctl: number; atl: number; tsb: number } | null;
      activity_types_included: string[];
    };

    // Both paths call the same `loadTrainingLoadInputs`/wellness read with
    // identical mocked inputs here, and `current`'s shape is `{date, ctl,
    // atl, tsb}` on both sides (no extra fields to trip up a structural
    // comparison), so an exact `toEqual` is the right claim: same shared
    // function, same floats, not merely close.
    expect(textData.current).toEqual(appData.current);
    expect(textData.activity_types_included).toEqual(
      appData.activityTypesIncluded,
    );
  });

  it("get-training-load and get-training-load-data give the same warnings for 30, 0, 0, 45 km weeks (#43)", async () => {
    // The app used to drop the two empty weeks and warn "Volume increased
    // 50%"; the text tool kept them and warned "Unusually high volume". Both
    // now give the one volume-spike warning (#60).
    const activities = [
      intervalsRun({
        id: "1",
        start_date_local: "2026-05-06T07:00:00",
        distance: 30000,
      }),
      intervalsRun({
        id: "2",
        start_date_local: "2026-05-27T07:00:00",
        distance: 45000,
      }),
    ];

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const appResult = await dispatchToolCall("get-training-load-data", {
      days: 28,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "") as {
      weeks: Array<{ weekStarting: string; warningReasons: string[] }>;
    };

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-training-load", {
      days: 28,
    });
    const textWarnings = (
      textResult.structuredContent as { warnings: string[] }
    ).warnings.filter((w) => /Volume spike/.test(w));

    expect(textWarnings).toEqual([
      "Week of 2026-05-25: Volume spike: 45 km is 4.5 times the 10 km average of the previous 3 weeks",
    ]);
    expect(
      appData.weeks.flatMap((w) =>
        w.warningReasons.map((r) => `Week of ${w.weekStarting}: ${r}`),
      ),
    ).toEqual(textWarnings);
  });

  it("get-training-load and get-training-load-data compare with the 4 weeks before the window alike (#60)", async () => {
    // TL_TODAY is a Monday: the window starts on 2026-05-04. Before it, 3
    // weeks of 40 km and a 10 km recovery week. The return to 40 km is no
    // spike (the old rule said "increased 300%"); the 52 km week is.
    const km = [
      ["2026-04-08", 40],
      ["2026-04-15", 40],
      ["2026-04-22", 40],
      ["2026-04-29", 10],
      ["2026-05-06", 40],
      ["2026-05-13", 40],
      ["2026-05-20", 40],
      ["2026-05-27", 52],
    ] as const;
    const activities = km.map(([date, distanceKm], i) =>
      intervalsRun({
        id: String(i + 1),
        start_date_local: `${date}T07:00:00`,
        distance: distanceKm * 1000,
      }),
    );

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const appResult = await dispatchToolCall("get-training-load-data", {
      days: 28,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "") as {
      totals: { distanceKm: number };
      weeks: Array<{ weekStarting: string; warningReasons: string[] }>;
    };

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-training-load", {
      days: 28,
    });
    const textData = textResult.structuredContent as {
      totals: { distance_km: number };
      warnings: string[];
    };
    const textWarnings = textData.warnings.filter((w) =>
      /Volume spike/.test(w),
    );

    expect(textWarnings).toEqual([
      "Week of 2026-05-25: Volume spike: 52 km is 1.6 times the 32.5 km average of the previous 4 weeks",
    ]);
    expect(
      appData.weeks.flatMap((w) =>
        w.warningReasons.map((r) => `Week of ${w.weekStarting}: ${r}`),
      ),
    ).toEqual(textWarnings);
    // The baseline weeks are not reported.
    expect(appData.weeks[0]!.weekStarting).toBe("2026-05-04");
    expect(appData.totals.distanceKm).toBe(172);
    expect(textData.totals.distance_km).toBe(172);
  });

  it("get-training-load and get-training-load-data both count a layoff that is still going on", async () => {
    // A Wednesday: 2 weeks of 50 km, then 2 complete weeks and this week so
    // far with no runs.
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    const activities = [
      intervalsRun({
        id: "1",
        start_date_local: "2026-05-05T07:00:00",
        distance: 50000,
      }),
      intervalsRun({
        id: "2",
        start_date_local: "2026-05-12T07:00:00",
        distance: 50000,
      }),
    ];

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const appResult = await dispatchToolCall("get-training-load-data", {
      days: 28,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "") as {
      weeks: Array<{
        weekStarting: string;
        distanceKm: number;
        inProgress: boolean;
        warning: boolean;
      }>;
    };

    mockedIntervalsList.mockResolvedValueOnce(activities);
    mockedWellness.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-training-load", {
      days: 28,
    });
    const textData = textResult.structuredContent as {
      trend: string;
      averages: { distance_km_per_week: number };
      warnings: string[];
      weekly_breakdown: Array<{ week_starting: string; distance_km: number }>;
    };

    const weeks = [
      ["2026-05-04", 50],
      ["2026-05-11", 50],
      ["2026-05-18", 0],
      ["2026-05-25", 0],
      ["2026-06-01", 0],
    ];
    expect(
      textData.weekly_breakdown.map((w) => [w.week_starting, w.distance_km]),
    ).toEqual(weeks);
    expect(appData.weeks.map((w) => [w.weekStarting, w.distanceKm])).toEqual(
      weeks,
    );
    expect(appData.weeks.map((w) => w.inProgress)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(textData.trend).toBe("decreasing significantly");
    expect(textData.averages.distance_km_per_week).toBe(25);
    expect(textData.warnings.filter((w) => /Volume spike/.test(w))).toEqual([]);
    expect(appData.weeks.some((w) => w.warning)).toBe(false);
  });

  describe("with newest (#80)", () => {
    /** A past Sunday and a past Wednesday, before TL_TODAY. */
    const PAST_SUNDAY = "2026-04-12";
    const PAST_WEDNESDAY = "2026-04-08";
    /** One 8 km run every Wednesday from 2026-01-07 to 2026-05-27. */
    const weeklyRuns = Array.from({ length: 21 }, (_, i) =>
      intervalsRun({
        id: `w${i}`,
        start_date_local: `${addDays("2026-01-07", 7 * i)}T07:00:00`,
      }),
    );

    /** Serves only the rows inside the requested range, as intervals.icu does. */
    function serve(wellness: IntervalsWellness[] = []) {
      mockedIntervalsList.mockImplementation(async (_key, { oldest, newest }) =>
        weeklyRuns.filter((a) => {
          const date = a.start_date_local.split("T")[0]!;
          return date >= oldest && date <= newest;
        }),
      );
      mockedWellness.mockImplementation(async (_key, { oldest, newest }) =>
        wellness.filter((row) => row.id >= oldest && row.id <= newest),
      );
    }

    afterEach(() => {
      mockedIntervalsList.mockReset();
      mockedWellness.mockReset();
    });

    it("get-training-load-data ends a past Sunday's window on a complete week", async () => {
      serve();

      const result = await dispatchToolCall("get-training-load-data", {
        days: 84,
        newest: PAST_SUNDAY,
      });

      const parsed = JSON.parse(result.content[0]?.text ?? "");
      expect(parsed).toMatchObject({
        days: 84,
        startDate: "2026-01-19",
        endDate: PAST_SUNDAY,
        endsToday: false,
      });
      expect(parsed.weeks).toHaveLength(12);
      expect(
        parsed.weeks.some((w: { inProgress: boolean }) => w.inProgress),
      ).toBe(false);
      expect(mockedIntervalsList.mock.calls[0]![1].newest).toBe(PAST_SUNDAY);
    });

    it("view-training-load gives get-training-load's past-window text: End of window and the partial week", async () => {
      serve([
        {
          id: PAST_WEDNESDAY,
          ctl: 45,
          atl: 39,
          ctlLoad: 0,
          atlLoad: 0,
        } as IntervalsWellness,
      ]);

      const result = await dispatchToolCall(
        "view-training-load",
        { newest: PAST_WEDNESDAY },
        { client: { rendersApps: true } },
      );

      const text = result.content[0]?.text ?? "";
      expect(
        text.startsWith(
          "Interactive training load chart shown. The same data from get-training-load follows.",
        ),
      ).toBe(true);
      expect(text).toContain(`2026-01-12 to ${PAST_WEDNESDAY}`);
      expect(text).toContain(`End of window (as of ${PAST_WEDNESDAY})`);
      expect(text).toContain("Form (TSB): +6");
      expect(text).toContain(
        `This window ends on ${PAST_WEDNESDAY}, before today`,
      );
      expect(text).toContain(
        `Week of 2026-04-06 is partial (3 of 7 days, to ${PAST_WEDNESDAY})`,
      );
      expect(text).not.toContain("in progress");
      expect(text).not.toContain("Current (as of");
    });

    it("the training-load pair reads the same window for the same newest", async () => {
      serve();

      await dispatchToolCall("view-training-load", { newest: PAST_SUNDAY });
      await dispatchToolCall("get-training-load-data", {
        newest: PAST_SUNDAY,
      });
      await dispatchToolCall("get-training-load", {
        days: 84,
        newest: PAST_SUNDAY,
      });

      const [view, data, text] = mockedIntervalsList.mock.calls;
      expect(data![1]).toEqual(view![1]);
      expect(text![1]).toEqual(view![1]);
      const [viewWellness, dataWellness] = mockedWellness.mock.calls;
      expect(dataWellness![1]).toEqual(viewWellness![1]);
    });

    it("get-training-load-data with newest equal to today is the same call as no newest", async () => {
      serve([
        {
          id: TL_TODAY,
          ctl: 45,
          atl: 39,
          ctlLoad: 0,
          atlLoad: 0,
        } as IntervalsWellness,
      ]);

      const omitted = await dispatchToolCall("get-training-load-data", {
        days: 84,
      });
      const today = await dispatchToolCall("get-training-load-data", {
        days: 84,
        newest: TL_TODAY,
      });

      expect(today.content[0]?.text).toBe(omitted.content[0]?.text);
      const parsed = JSON.parse(today.content[0]?.text ?? "");
      expect(parsed.endsToday).toBe(true);
      expect(parsed.endDate).toBe(TL_TODAY);
      // TL_TODAY is a Monday: its week is in progress.
      expect(parsed.weeks.at(-1)).toMatchObject({
        weekStarting: TL_TODAY,
        inProgress: true,
      });
      const [listOmitted, listToday] = mockedIntervalsList.mock.calls;
      expect(listToday![1]).toEqual(listOmitted![1]);
      const [wellnessOmitted, wellnessToday] = mockedWellness.mock.calls;
      expect(wellnessToday![1]).toEqual(wellnessOmitted![1]);
    });

    it.each(["view-training-load", "get-training-load-data"])(
      "%s refuses a newest after today before any fetch",
      async (tool) => {
        const result = await dispatchToolCall(tool, {
          newest: addDays(TL_TODAY, 1),
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
          `❌ newest 2026-06-02 is after today (${TL_TODAY}). Use today or an earlier date, or leave newest out to end the window today.`,
        );
        expect(mockedIntervalsList).not.toHaveBeenCalled();
        expect(mockedWellness).not.toHaveBeenCalled();
      },
    );
  });
});

describe("fitness trend handlers", () => {
  const TODAY = "2026-08-19";
  const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
  const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);

  /**
   * A synthetic wellness series with a realistic CTL/ATL shape (built via
   * the same recurrence the app handler used to recompute, purely so the
   * numbers look plausible; the app handler now reads `ctl`/`atl` straight
   * off each row rather than recomputing them): `days` rows ending at
   * `endDate`, load `recentLoad` for the most recent `activeDays` of them,
   * else zero.
   */
  function wellnessSeries(
    endDate: string,
    days: number,
    activeDays: number,
    recentLoad: number,
  ): IntervalsWellness[] {
    const start = addDays(endDate, -(days - 1));
    let ctl = 0;
    let atl = 0;
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(start, i);
      const load = days - 1 - i < activeDays ? recentLoad : 0;
      ctl = load * (1 - CTL_DECAY) + ctl * CTL_DECAY;
      atl = load * (1 - ATL_DECAY) + atl * ATL_DECAY;
      return { id: date, ctl, atl, ctlLoad: load, atlLoad: load };
    });
  }

  /**
   * `days` rows of a deeply TSB-positive (ctl=50, atl=10) wellness series,
   * but stopping `lagDays` short of `endDate`, the asOfDate-trails-endDate
   * shape a sync lag produces. TSB stays positive well past `lagDays` of
   * rest (see fitnessTrend.test.ts's own hand-verified simulation), so the
   * only question this exercises is whether the reported crossing date is
   * the lagging asOfDate (a past date, the old bug) or `endDate` itself.
   */
  function laggingPositiveWellnessSeries(
    endDate: string,
    days: number,
    lagDays: number,
  ): IntervalsWellness[] {
    const asOf = addDays(endDate, -lagDays);
    const start = addDays(asOf, -(days - 1));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(start, i);
      return { id: date, ctl: 50, atl: 10, ctlLoad: 0, atlLoad: 0 };
    });
  }

  /** YYYY-MM-DD `days` from TODAY, for taper target dates. */
  function inDays(days: number): string {
    return addDays(TODAY, days);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("get-fitness-trend-data returns the series, projection, and bands", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-fitness-trend-data", {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.days).toBe(90);
    expect(parsed.series).toHaveLength(90);
    // projectDays defaults to a fortnight for the chart, not the text tool's 0.
    expect(parsed.projection).toHaveLength(14);
    expect(parsed.taper).toBeNull();
    expect(parsed.current.ctl).toBeGreaterThan(0);
    expect(Array.isArray(parsed.bands)).toBe(true);
  });

  it("get-fitness-trend-data solves a taper in camelCase for the app", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const targetDate = inDays(21);

    const result = await dispatchToolCall("get-fitness-trend-data", {
      targetDate,
      targetTsb: 12,
    });

    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.taper.targetDate).toBe(targetDate);
    expect(parsed.taper.targetTsb).toBe(12);
    expect(parsed.taper.achievedTsb).toBeCloseTo(12, 1);
    expect(parsed.taper.days).toHaveLength(21);
    expect(parsed.taper.weeks).toHaveLength(3);
    expect(parsed.taper.weeks[0].dailyLoad).toBeGreaterThan(0);
    expect(parsed.taper.weeks[0].startDate).toBeTruthy();
  });

  it("view-fitness-trend prints the same headline numbers as the chart when its twin fails", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    // The twin's own read fails, so the text is the view's own summary.
    mockedWellness.mockRejectedValueOnce(new Error("twin down"));
    const targetDate = inDays(14);

    const result = await dispatchToolCall(
      "view-fitness-trend",
      { targetDate },
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Fitness Trend (last 90 days)");
    expect(text).toContain("Fitness (CTL)");
    expect(text).toContain(`Taper to ${targetDate}`);
    expect(text).toContain("week 1");
    expect(
      text.startsWith(
        "Interactive fitness trend chart shown. Its data follows.",
      ),
    ).toBe(true);
    expect(
      text.endsWith(
        "For detail, call get-fitness-trend with the same arguments.",
      ),
    ).toBe(true);
  });

  it("view-fitness-trend reports the fresh date when only resting", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 10, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("view-fitness-trend", {});

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("form turns positive on");
    expect(text).not.toContain("Taper to");
  });

  it("view-fitness-trend reports today, not a past catch-up date, when already positive", async () => {
    mockedWellness.mockResolvedValueOnce(
      laggingPositiveWellnessSeries(TODAY, 91, 2),
    );
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("view-fitness-trend", {});

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`Form is already positive today (${TODAY})`);
    expect(text).not.toContain(`form turns positive on ${addDays(TODAY, -1)}`);
  });

  it("view-fitness-trend and its data feed say already positive when synced and positive", async () => {
    // The view, its twin (get-fitness-trend) and the data feed each read.
    for (let call = 0; call < 3; call++) {
      mockedWellness.mockResolvedValueOnce(
        laggingPositiveWellnessSeries(TODAY, 91, 0),
      );
      mockedIntervalsList.mockResolvedValueOnce([]);
    }

    const view = await dispatchToolCall(
      "view-fitness-trend",
      {},
      { client: { rendersApps: true } },
    );
    expect(view.content[0]?.text).toContain(
      `TSB is already positive today (${TODAY})`,
    );
    const data = JSON.parse(
      (await dispatchToolCall("get-fitness-trend-data", {})).content[0]?.text ??
        "",
    );
    expect(data.tsbPositiveDate).toBe(TODAY);
    expect(data.endDate).toBe(TODAY);
  });

  it.each(["view-fitness-trend", "get-fitness-trend-data"])(
    "%s rejects a target date past the taper horizon before any fetch",
    async (tool) => {
      const result = await dispatchToolCall(tool, { targetDate: "2062-10-17" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("at most 180 days");
      expect(mockedWellness).not.toHaveBeenCalled();
      expect(mockedIntervalsList).not.toHaveBeenCalled();
    },
  );

  it("get-fitness-trend-data rejects a target date on or before today", async () => {
    const result = await dispatchToolCall("get-fitness-trend-data", {
      targetDate: TODAY,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not after today");
    expect(mockedWellness).not.toHaveBeenCalled();
  });

  it("rejects a malformed target date via the input schema", async () => {
    const result = await dispatchToolCall("get-fitness-trend-data", {
      targetDate: "next Sunday",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("YYYY-MM-DD");
    expect(mockedWellness).not.toHaveBeenCalled();
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  it("rejects a target date that is not a real calendar date via the shared dateInputSchema", async () => {
    const result = await dispatchToolCall("get-fitness-trend-data", {
      targetDate: "2026-02-30",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("real calendar date");
    expect(mockedWellness).not.toHaveBeenCalled();
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  it("rejects a plannedLoads entry that is not a real calendar date via the shared dateInputSchema", async () => {
    const result = await dispatchToolCall("get-fitness-trend", {
      plannedLoads: [{ date: "2026-02-30", load: 40 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("real calendar date");
    expect(mockedWellness).not.toHaveBeenCalled();
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  it("get-fitness-trend and get-fitness-trend-data agree on current, projection, and taper (#projectFromWellness)", async () => {
    const targetDate = inDays(21);

    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const appResult = await dispatchToolCall("get-fitness-trend-data", {
      projectDays: 14,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "");

    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-fitness-trend", {
      projectDays: 14,
    });
    const textData = textResult.structuredContent as {
      current: { date: string; ctl: number; atl: number; tsb: number };
      projection: { date: string; ctl: number; atl: number; tsb: number }[];
    };

    // Both paths call the same `loadFitnessTrend` with identical mocked
    // wellness here, so the floats must match exactly, not merely be close;
    // compared field by field (not a structural `current` toEqual) since the
    // app's `current` is a `FitnessTrendDay` and carries an extra `load`
    // field the text tool's `current` does not.
    expect(textData.current?.ctl).toBe(appData.current.ctl);
    expect(textData.current?.atl).toBe(appData.current.atl);
    expect(textData.current?.tsb).toBe(appData.current.tsb);
    expect(textData.projection).toHaveLength(appData.projection.length);
    expect(textData.projection.at(-1)?.tsb).toBe(
      appData.projection.at(-1)!.tsb,
    );

    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const appTaperResult = await dispatchToolCall("get-fitness-trend-data", {
      targetDate,
      targetTsb: 12,
    });
    const appTaper = JSON.parse(appTaperResult.content[0]?.text ?? "").taper;

    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const textTaperResult = await dispatchToolCall("get-fitness-trend", {
      targetDate,
      targetTsb: 12,
    });
    const textTaper = (
      textTaperResult.structuredContent as {
        taper: { target_date: string; achieved_tsb: number };
      }
    ).taper;

    expect(textTaper.target_date).toBe(appTaper.targetDate);
    // Same shared `solveTaperPlan` (closed-form, no bisection/tolerance) via
    // the same `loadFitnessTrend`, so exact rather than close.
    expect(textTaper.achieved_tsb).toBe(appTaper.achievedTsb);
  });

  it("get-fitness-trend and the app payload give the same 7-day CTL change on a gappy series (#75)", async () => {
    // Two days of the last week have no wellness: 7 rows back is 9 calendar
    // days back, which is what the app's narration used to read.
    const gappy = () =>
      wellnessSeries(TODAY, 91, 21, 80).filter(
        (row) => row.id !== inDays(-3) && row.id !== inDays(-4),
      );

    mockedWellness.mockResolvedValueOnce(gappy());
    mockedIntervalsList.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-fitness-trend", {});
    const textData = textResult.structuredContent as {
      trend: { ctl_7d_delta: number } | null;
      daily: { date: string; ctl: number }[];
    };

    mockedWellness.mockResolvedValueOnce(gappy());
    mockedIntervalsList.mockResolvedValueOnce([]);
    const appData = JSON.parse(
      (await dispatchToolCall("get-fitness-trend-data", {})).content[0]?.text ??
        "",
    );

    const weekAgo = textData.daily.find((d) => d.date === inDays(-7))!;
    const expected =
      Math.round((textData.daily.at(-1)!.ctl - weekAgo.ctl) * 10) / 10;
    expect(textData.trend?.ctl_7d_delta).toBe(expected);
    expect(appData.ctl7dDelta).toBe(expected);
    const byRows =
      Math.round(
        (textData.daily.at(-1)!.ctl - textData.daily.at(-8)!.ctl) * 10,
      ) / 10;
    expect(byRows).not.toBe(expected);
    expect(textResult.content[0]?.text).toContain(
      `**Last 7 days**: CTL ${expected >= 0 ? "+" : ""}${expected}`,
    );
  });

  it("projectDays: 0 gives an empty projection in both, even with unsynced wellness days (#catch-up bug)", async () => {
    // Drop the trailing 2 synced days so asOfDate trails endDate (TODAY) by
    // 2 unsynced days, the shape that used to make the app keep rolling a
    // "catch-up" projection forward even when projectDays: 0 asked for none.
    const gapped = wellnessSeries(TODAY, 91, 21, 80).slice(0, -2);

    mockedWellness.mockResolvedValueOnce(gapped);
    mockedIntervalsList.mockResolvedValueOnce([]);
    const appResult = await dispatchToolCall("get-fitness-trend-data", {
      projectDays: 0,
    });
    const appData = JSON.parse(appResult.content[0]?.text ?? "");
    expect(appData.projection).toEqual([]);
    expect(appData.tsbPositiveDate).toBeNull();

    mockedWellness.mockResolvedValueOnce(gapped);
    mockedIntervalsList.mockResolvedValueOnce([]);
    const textResult = await dispatchToolCall("get-fitness-trend", {
      projectDays: 0,
    });
    const textData = textResult.structuredContent as {
      projection: unknown[];
      tsb_positive_date: string | null;
    };
    expect(textData.projection).toEqual([]);
    expect(textData.tsb_positive_date).toBeNull();
  });

  it("tsbPositiveDate is never in the past (fully synced, no crossing)", async () => {
    // A fully-synced series (asOfDate === TODAY) with heavy recent load, so
    // TSB is well negative today; the projection should only ever cross
    // positive on a date after TODAY.
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 200));
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-fitness-trend-data", {
      projectDays: 60,
    });
    const data = JSON.parse(result.content[0]?.text ?? "");

    expect(data.tsbPositiveDate).not.toBeNull();
    expect(data.tsbPositiveDate > TODAY).toBe(true);
  });

  it("reports TODAY, not a past catch-up date, when a lagging series is already positive", async () => {
    // asOfDate trails TODAY by 2 days; TSB is deeply positive throughout the
    // catch-up. The old bug reported the first catch-up day (asOf + 1, two
    // days before TODAY) as "returns positive on".
    mockedWellness.mockResolvedValueOnce(
      laggingPositiveWellnessSeries(TODAY, 91, 2),
    );
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-fitness-trend-data", {
      projectDays: 7,
    });
    const data = JSON.parse(result.content[0]?.text ?? "");

    expect(data.tsbPositiveDate).toBe(TODAY);
  });

  /** A run activity `daysAgo` days before TODAY, carrying `load`. */
  function runActivity(daysAgo: number, load: number): IntervalsActivity {
    const date = addDays(TODAY, -daysAgo);
    return {
      id: `run-${daysAgo}`,
      name: `Run ${daysAgo}d ago`,
      type: "Run",
      start_date_local: `${date}T07:00:00`,
      icu_training_load: load,
    } as IntervalsActivity;
  }

  /** The trailing `activeDays` days before (and including) TODAY, each with `load`. */
  function runActivities(
    activeDays: number,
    load: number,
  ): IntervalsActivity[] {
    return Array.from({ length: activeDays }, (_, i) => runActivity(i, load));
  }

  it("get-fitness-trend-data with runOnly reports the computed source and run activity types, never touching wellness", async () => {
    mockedIntervalsList.mockResolvedValueOnce(runActivities(21, 80));

    const result = await dispatchToolCall("get-fitness-trend-data", {
      runOnly: true,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.source).toBe("computed");
    expect(parsed.runOnly).toBe(true);
    expect(parsed.activityTypesIncluded).toEqual(RUN_TYPES);
    expect(mockedWellness).not.toHaveBeenCalled();
  });

  it(
    "get-fitness-trend-data (runOnly) equals get-fitness-trend's run-only " +
      "series for the same inputs (the shared loader, not two computations)",
    async () => {
      mockedIntervalsList.mockResolvedValueOnce(runActivities(21, 80));
      const appResult = await dispatchToolCall("get-fitness-trend-data", {
        runOnly: true,
        projectDays: 14,
      });
      const appData = JSON.parse(appResult.content[0]?.text ?? "");

      mockedIntervalsList.mockResolvedValueOnce(runActivities(21, 80));
      const textResult = await dispatchToolCall("get-fitness-trend", {
        runOnly: true,
        projectDays: 14,
      });
      const textData = textResult.structuredContent as {
        source: string;
        daily: { date: string; ctl: number; atl: number; tsb: number }[];
        current: { ctl: number; atl: number; tsb: number };
        projection: { date: string; tsb: number }[];
      };

      expect(appData.source).toBe(textData.source);
      expect(appData.series).toHaveLength(textData.daily.length);
      for (const [i, day] of (
        appData.series as {
          date: string;
          ctl: number;
          atl: number;
          tsb: number;
        }[]
      ).entries()) {
        const textDay = textData.daily[i]!;
        expect(day.date).toBe(textDay.date);
        // Same shared `loadFitnessTrend`, same mocked activities on both
        // calls: exact, not merely close.
        expect(day.ctl).toBe(textDay.ctl);
        expect(day.atl).toBe(textDay.atl);
        expect(day.tsb).toBe(textDay.tsb);
      }
      expect(appData.current.ctl).toBe(textData.current.ctl);
      expect(appData.current.atl).toBe(textData.current.atl);
      expect(appData.current.tsb).toBe(textData.current.tsb);
      expect(appData.projection).toHaveLength(textData.projection.length);
      expect(appData.projection.at(-1)?.tsb).toBe(
        textData.projection.at(-1)!.tsb,
      );
    },
  );

  it("get-fitness-trend-data defaults runOnly to false (whole-body, unchanged)", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-fitness-trend-data", {});

    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.source).toBe("intervals.icu");
    expect(parsed.runOnly).toBe(false);
    expect(parsed.endsToday).toBe(true);
  });

  describe("with newest (#80)", () => {
    /** A past day, before TODAY. */
    const NEWEST = "2026-04-12";
    const PAST_NOTE = `This window ends on ${NEWEST}, before today (${TODAY}). It is a past block: CTL/ATL/TSB are as of its last day with data, and there is no projection or taper plan.`;

    it("get-fitness-trend-data has no projection for a past window, though projectDays defaults to 14", async () => {
      mockedWellness.mockResolvedValueOnce(wellnessSeries(NEWEST, 90, 21, 80));
      mockedIntervalsList.mockResolvedValueOnce([]);

      const result = await dispatchToolCall("get-fitness-trend-data", {
        newest: NEWEST,
      });

      const parsed = JSON.parse(result.content[0]?.text ?? "");
      expect(parsed.endsToday).toBe(false);
      expect(parsed.endDate).toBe(NEWEST);
      expect(parsed.series).toHaveLength(90);
      expect(parsed.projection).toEqual([]);
      expect(parsed.taper).toBeNull();
      expect(parsed.tsbPositiveDate).toBeNull();
      expect(parsed.warnings[0]).toBe(PAST_NOTE);
      expect(mockedWellness.mock.calls[0]![1]).toEqual({
        oldest: "2026-01-13",
        newest: NEWEST,
      });
    });

    it("view-fitness-trend titles a past window with its last day", async () => {
      mockedWellness.mockResolvedValueOnce(wellnessSeries(NEWEST, 90, 21, 80));
      mockedIntervalsList.mockResolvedValueOnce([]);

      const result = await dispatchToolCall("view-fitness-trend", {
        newest: NEWEST,
      });

      const text = result.content[0]?.text ?? "";
      expect(text).toContain(`Fitness Trend (90 days to ${NEWEST})`);
      expect(text).toContain("Past window: no projection or taper.");
      expect(text).not.toContain("last 90 days");
      expect(text).not.toContain("form turns positive");
    });

    it("get-fitness-trend-data with newest equal to today is the same call as no newest", async () => {
      for (let call = 0; call < 2; call++) {
        mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 90, 21, 80));
        mockedIntervalsList.mockResolvedValueOnce([]);
      }

      const omitted = await dispatchToolCall("get-fitness-trend-data", {});
      const today = await dispatchToolCall("get-fitness-trend-data", {
        newest: TODAY,
      });

      expect(today.content[0]?.text).toBe(omitted.content[0]?.text);
      const parsed = JSON.parse(today.content[0]?.text ?? "");
      expect(parsed.endsToday).toBe(true);
      expect(parsed.endDate).toBe(TODAY);
      // The app's default fortnight projection is still there.
      expect(parsed.projection).toHaveLength(14);
      const [wellnessOmitted, wellnessToday] = mockedWellness.mock.calls;
      expect(wellnessToday![1]).toEqual(wellnessOmitted![1]);
      expect(mockedIntervalsList.mock.calls[1]![1]).toEqual(
        mockedIntervalsList.mock.calls[0]![1],
      );
    });

    it.each(["view-fitness-trend", "get-fitness-trend-data"])(
      "%s refuses a newest after today before any fetch",
      async (tool) => {
        const result = await dispatchToolCall(tool, { newest: inDays(1) });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
          `❌ newest ${inDays(1)} is after today (${TODAY}). Use today or an earlier date, or leave newest out to end the window today.`,
        );
        expect(mockedWellness).not.toHaveBeenCalled();
        expect(mockedIntervalsList).not.toHaveBeenCalled();
      },
    );

    it.each(["view-fitness-trend", "get-fitness-trend-data"])(
      "%s ignores targetDate for a past window instead of rejecting it",
      async (tool) => {
        // Past the taper horizon: an error for a window that ends today.
        mockedWellness.mockResolvedValueOnce(
          wellnessSeries(NEWEST, 90, 21, 80),
        );
        mockedIntervalsList.mockResolvedValueOnce([]);

        const result = await dispatchToolCall(tool, {
          newest: NEWEST,
          targetDate: "2062-10-17",
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).not.toContain("Taper to");
        if (tool === "get-fitness-trend-data") {
          const parsed = JSON.parse(text);
          expect(parsed.taper).toBeNull();
          expect(parsed.projection).toEqual([]);
          expect(parsed.endsToday).toBe(false);
        }
      },
    );

    it("get-fitness-trend and get-fitness-trend-data agree on a past window", async () => {
      mockedWellness.mockResolvedValueOnce(wellnessSeries(NEWEST, 90, 21, 80));
      mockedIntervalsList.mockResolvedValueOnce([]);
      const appData = JSON.parse(
        (
          await dispatchToolCall("get-fitness-trend-data", {
            newest: NEWEST,
          })
        ).content[0]?.text ?? "",
      );

      mockedWellness.mockResolvedValueOnce(wellnessSeries(NEWEST, 90, 21, 80));
      mockedIntervalsList.mockResolvedValueOnce([]);
      const textData = (
        await dispatchToolCall("get-fitness-trend", { newest: NEWEST })
      ).structuredContent as {
        as_of: string;
        current: { ctl: number; atl: number; tsb: number };
        flags: string[];
        bands: Array<{ reason: string }>;
        warnings: string[];
        period: { ends_today: boolean };
      };

      expect(textData.period.ends_today).toBe(appData.endsToday);
      expect(textData.as_of).toBe(appData.asOf);
      expect(textData.current.ctl).toBe(appData.current.ctl);
      expect(textData.current.tsb).toBe(appData.current.tsb);
      expect(textData.flags).toEqual(appData.flags);
      expect(textData.bands.map((b) => b.reason)).toEqual(
        appData.bands.map((b: { reason: string }) => b.reason),
      );
      expect(textData.warnings).toEqual(appData.warnings);
    });
  });
});

/** A minimal intervals.icu raw stream set: latlng plus distance, index-aligned to `time`. */
function routeMapStreamsFixture(
  overrides: Partial<{
    time: number[];
    lat: Array<number | null>;
    lng: Array<number | null>;
    distance: number[];
  }> = {},
) {
  const time = overrides.time ?? [0, 1, 2];
  const lat = overrides.lat ?? [38.5, 40.7, 43.252];
  const lng = overrides.lng ?? [-120.2, -120.95, -126.453];
  return [
    { type: "time", data: time },
    { type: "latlng", data: lat, data2: lng },
    { type: "distance", data: overrides.distance ?? [0, 5000, 10000] },
  ];
}

describe("route map handlers", () => {
  it("view-route-map summarises distance and elevation for the model", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({ total_elevation_gain: 120 }),
    );
    mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

    const result = await dispatchToolCall("view-route-map", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity: Morning Run");
    expect(text).toContain("Distance: 10.00 km");
    expect(text).not.toContain("No GPS track");
  });

  it("view-route-map flags an empty track on a host that renders the map", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    // intervals.icu returns no streams for a manual/no-GPS entry.
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall(
      "view-route-map",
      { id: "123" },
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "No GPS track is available, so the map will be empty.",
    );
  });

  it("view-route-map states a missing track plainly to a host without MCP Apps (#77)", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall(
      "view-route-map",
      { id: "123" },
      { client: { rendersApps: false } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("No GPS track is recorded for this activity.");
    expect(text).not.toContain("map will be empty");
  });

  it("get-route-map-data returns coordinates from the latlng stream with aligned metrics", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.source).toBe("activity");
    expect(parsed.coordinates).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
    expect(parsed.streams.distance).toEqual([0, 5000, 10000]);
  });

  it("get-route-map-data drops samples whose latlng is null", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce(
      routeMapStreamsFixture({
        time: [0, 1, 2, 3],
        lat: [null, 38.5, 40.7, null],
        lng: [null, -120.2, -120.95, null],
        distance: [0, 100, 5000, 9000],
      }),
    );

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.coordinates).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
    ]);
  });

  it("get-route-map-data marks only WORK interval ends, one finish marker for a one-lap run", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({
        icu_intervals: [{ type: "WORK", start_time: 0, end_time: 2 }],
      }),
    );
    mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.annotations.laps).toEqual([
      { lapIndex: 1, name: "Lap 1", endIndex: 2 },
    ]);
  });

  it("get-route-map-data skips RECOVERY intervals when marking laps", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({
        icu_intervals: [
          { type: "WORK", start_time: 0, end_time: 1 },
          { type: "RECOVERY", start_time: 1, end_time: 2 },
        ],
      }),
    );
    mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.annotations.laps).toHaveLength(1);
    expect(parsed.annotations.laps[0].name).toBe("Lap 1");
  });

  it("get-route-map-data returns empty coordinates for a stream-less activity", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    // intervals.icu returns no streams for a manual/no-GPS entry.
    mockedIntervalsStreams.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.coordinates).toEqual([]);
    expect(parsed.streams).toBeUndefined();
  });

  it("get-route-map-data reports a rate limit rather than silently dropping streams", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockRejectedValueOnce(
      new RateLimitError(
        "15-minute rate limit reached (100/100 requests).",
        { status: 429, statusText: "Too Many Requests", data: "" },
        { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
        60,
      ),
    );

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
  });

  it("get-route-map-data anchors waypoints on the distance stream and drops out-of-range ones", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

    const result = await dispatchToolCall("get-route-map-data", {
      id: "123",
      waypoints: [
        { km: 4, label: "Gel 1", kind: "fuel" },
        { km: 42, label: "Botanic Gardens climb", kind: "climb" },
        { km: 8, label: "Water stop" }, // kind defaults to custom
      ],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.annotations.waypoints).toEqual([
      { km: 4, label: "Gel 1", kind: "fuel", index: 1 },
      { km: 8, label: "Water stop", kind: "custom", index: 2 },
    ]);
    expect(parsed.waypointWarnings).toHaveLength(1);
    expect(parsed.waypointWarnings[0]).toContain("Botanic Gardens climb");
    expect(parsed.waypointWarnings[0]).toContain("10.0 km");
  });

  it.each([
    [
      true,
      "Waypoints: 1 pinned along the track (toggleable via the map legend):",
    ],
    [false, "Waypoints: 1 placed along the track:"],
  ])(
    "view-route-map lists each waypoint with its km and label (renders apps: %s) and warns about dropped ones",
    async (rendersApps, waypointLine) => {
      mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
      mockedIntervalsStreams.mockResolvedValueOnce(routeMapStreamsFixture());

      const result = await dispatchToolCall(
        "view-route-map",
        {
          id: "123",
          waypoints: [
            { km: 5, label: "Gel 1", kind: "fuel" },
            { km: 42.2, label: "Finish gel", kind: "fuel" },
          ],
        },
        { client: { rendersApps } },
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain(`${waypointLine}\n  km 5: Gel 1 (fuel)`);
      if (!rendersApps) expect(text).not.toContain("legend");
      expect(text).toContain("Warning: Dropped 1 waypoint");
      expect(text).toContain('"Finish gel" (42.2 km)');
    },
  );

  it("rejects malformed waypoints via the input schema", async () => {
    const result = await dispatchToolCall("view-route-map", {
      id: "123",
      waypoints: [{ km: -2, label: "" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-route-map",
    );
  });

  it("get-route-map-data errors when id is not provided", async () => {
    const result = await dispatchToolCall("get-route-map-data", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for get-route-map-data",
    );
  });
});

describe("compare activities handlers", () => {
  function compareActivity(
    overrides: Partial<IntervalsActivity> = {},
  ): IntervalsActivity {
    return {
      id: "i1",
      name: "Morning Run",
      type: "Run",
      start_date_local: "2026-06-01T07:00:00",
      distance: 10000,
      moving_time: 3200,
      average_heartrate: 150,
      max_heartrate: 172,
      average_cadence: 84,
      total_elevation_gain: 80,
      icu_training_load: 60,
      ...overrides,
    } as unknown as IntervalsActivity;
  }

  it("view-compare-activities reports both sides and the pace delta", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      compareActivity({ id: "i1" }),
    );
    mockedIntervalsActivity.mockResolvedValueOnce(
      compareActivity({
        id: "i2",
        name: "Race Day",
        moving_time: 3000,
        average_heartrate: 160,
      }),
    );

    const result = await dispatchToolCall("view-compare-activities", {
      activityId1: "i1",
      activityId2: "i2",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity 1: Morning Run");
    expect(text).toContain("Activity 2: Race Day");
    expect(text).toContain("faster");
  });

  it.each(["view-compare-activities", "get-compare-activities-data"])(
    "%s reads each activity with the app's streams URL (intervals: true)",
    async (tool) => {
      // The view's own reads, then its twin's; the data tool has no twin.
      const reads = tool === "view-compare-activities" ? 2 : 1;
      for (let read = 0; read < reads; read++)
        mockedIntervalsActivity
          .mockResolvedValueOnce(compareActivity({ id: "i1" }))
          .mockResolvedValueOnce(compareActivity({ id: "i2" }));

      const result = await dispatchToolCall(
        tool,
        { activityId1: "i1", activityId2: "i2" },
        { client: { rendersApps: true } },
      );

      // Same options as get-activity-streams-raw, so opening the app reads
      // each activity once (#71); server.streamSharing.test.ts counts that
      // at the wire. Here the mocked client has no cache, so the view's
      // twin (compare-activities) reads both again.
      expect(result.isError).toBeUndefined();
      expect(mockedIntervalsActivity).toHaveBeenCalledTimes(2 * reads);
      for (const call of mockedIntervalsActivity.mock.calls)
        expect(call[2]).toEqual({ intervals: true });
      expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i1", {
        intervals: true,
      });
      expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i2", {
        intervals: true,
      });
    },
  );

  it("propagates a fetch failure as isError", async () => {
    mockedIntervalsActivity.mockRejectedValueOnce(
      new Error("Record Not Found"),
    );

    const result = await dispatchToolCall("get-compare-activities-data", {
      activityId1: "i1",
      activityId2: "i2",
    });

    expect(result.isError).toBe(true);
  });
});

describe("activity zones handlers", () => {
  function intervalsActivity(
    overrides: Partial<IntervalsActivity> = {},
  ): IntervalsActivity {
    return {
      id: "123",
      name: "Morning Run",
      type: "Run",
      start_date_local: "2026-06-01T07:00:00",
      icu_hr_zones: [130, 155, 190],
      icu_hr_zone_times: [600, 1800, 600],
      ...overrides,
    } as unknown as IntervalsActivity;
  }

  it("get-activity-zones-data returns the mapped zone payload", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());

    const result = await dispatchToolCall("get-activity-zones-data", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.activityId).toBe("123");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.zoneSets).toHaveLength(1);
    expect(parsed.zoneSets[0].type).toBe("heartrate");
    expect(parsed.zoneSets[0].totalSeconds).toBe(3000);
    expect(parsed.zoneSets[0].buckets[1]).toEqual({
      zone: 2,
      min: 130,
      max: 155,
      seconds: 1800,
      pct: 60,
    });
    // The top bucket keeps its real recorded bound, not an open-ended sentinel.
    expect(parsed.zoneSets[0].buckets[2].max).toBe(190);
  });

  it("view-activity-zones summarises the dominant zone for the model when its twin fails", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());
    // The twin's own read fails, so the text is the view's own summary.
    mockedIntervalsActivity.mockRejectedValueOnce(new Error("twin down"));

    const result = await dispatchToolCall(
      "view-activity-zones",
      { id: "123" },
      { client: { rendersApps: true } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity Zones: Morning Run");
    expect(text).toContain("Heart rate: mostly Z2 (60% of 50 min)");
    expect(
      text.startsWith(
        "Interactive zone distribution chart shown. Its data follows.",
      ),
    ).toBe(true);
    expect(text.endsWith("For detail, call get-activity-zones.")).toBe(true);
  });

  it("view-activity-zones handles an activity with no zone data", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({ icu_hr_zones: null, icu_hr_zone_times: null }),
    );

    const result = await dispatchToolCall("view-activity-zones", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No zone data recorded");
  });

  it("view-activity-zones warns when HR bounds and zone times counts don't match", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({
        icu_hr_zones: [130, 155, 190],
        icu_hr_zone_times: [600, 1800],
      }),
    );

    const result = await dispatchToolCall("view-activity-zones", {
      id: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Heart rate zones omitted");
  });

  it("get-activity-zones-data carries the reason the text tool prints", async () => {
    // The app's empty state shows hrZoneWarning as its reason, so it must be
    // the line get-activity-zones prints for the same activity.
    const mismatched = intervalsActivity({
      icu_hr_zones: [130, 155, 190],
      icu_hr_zone_times: [600, 1800],
    });
    mockedIntervalsActivity
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(mismatched);

    const data = await dispatchToolCall("get-activity-zones-data", {
      id: "123",
    });
    const text = await dispatchToolCall("get-activity-zones", { id: "123" });

    const parsed = JSON.parse(data.content[0]?.text ?? "");
    expect(parsed.zoneSets).toEqual([]);
    expect(parsed.hrZoneWarning).toContain("Heart rate zones omitted");
    expect(text.content[0]?.text).toContain(parsed.hrZoneWarning);
  });

  it("propagates a zones fetch failure as isError", async () => {
    mockedIntervalsActivity.mockRejectedValueOnce(
      new Error("Record Not Found"),
    );

    const result = await dispatchToolCall("get-activity-zones-data", {
      id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Record Not Found");
  });
});

describe("view tools and hosts that cannot render MCP Apps (#77)", () => {
  const TODAY = "2026-06-01";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
    // The table answers every read, so a text twin's reads see data too;
    // reset so those answers end with the test.
    for (const mock of [
      mockedIntervalsActivity,
      mockedIntervalsStreams,
      mockedWellness,
      mockedIntervalsList,
    ]) {
      mock.mockReset();
    }
  });

  const run = (overrides: Partial<IntervalsActivity> = {}) =>
    intervalsActivity({
      icu_hr_zones: [130, 155, 190],
      icu_hr_zone_times: [600, 1800, 600],
      average_cadence: 42.5,
      average_speed: 3.33,
      icu_training_load: 50,
      ...overrides,
    });

  /** 2.3 km at 3.3 m/s: enough distance for get-split-analysis. */
  const runStreams = () => {
    const time = Array.from({ length: 701 }, (_, i) => i);
    return [
      { type: "time", data: time },
      { type: "distance", data: time.map((t) => t * 3.3) },
      { type: "heartrate", data: time.map(() => 150) },
    ];
  };

  /**
   * Each view tool, its mocks (they answer every read), the footer it gives
   * when it has no text twin or the twin fails, and its text twin with the
   * arguments the view's own defaults give it.
   */
  const VIEW_TOOLS: Array<{
    name: string;
    args: Record<string, unknown>;
    arrange: () => void;
    kind: string;
    /** The call the fallback text names; none when the lines are the data. */
    footer?: string;
    twin?: { name: string; args: Record<string, unknown> };
    /** The view's own lines come ahead of the twin's text. */
    keepLines?: boolean;
  }> = [
    {
      name: "view-activity-chart",
      args: { id: "123" },
      arrange: () => {
        mockedIntervalsActivity.mockResolvedValue(run());
        mockedIntervalsStreams.mockImplementation(async () => runStreams());
      },
      kind: "activity chart",
      footer: "get-activity-streams",
      twin: { name: "get-split-analysis", args: { id: "123" } },
    },
    {
      name: "view-cadence-trends",
      args: {},
      arrange: () => {
        mockedIntervalsList.mockResolvedValue([run()]);
      },
      // Its lines are the data (per-run cadence, zones, slope): no footer.
      kind: "cadence trends chart",
    },
    {
      name: "view-training-load",
      args: {},
      arrange: () => {
        mockedIntervalsList.mockResolvedValue([
          run({ start_date_local: `${TODAY}T07:00:00` }),
        ]);
        mockedWellness.mockResolvedValue([]);
      },
      kind: "training load chart",
      // runOnly must carry over: never mix whole-body and run-only numbers.
      footer: "get-training-load with the same arguments",
      // The view's default window is 84 days; the twin's own is 28.
      twin: { name: "get-training-load", args: { days: 84 } },
    },
    {
      name: "view-fitness-trend",
      args: {},
      arrange: () => {
        mockedWellness.mockResolvedValue(
          Array.from({ length: 91 }, (_, i) => ({
            id: addDays(TODAY, i - 90),
            ctl: 50,
            atl: 40,
            ctlLoad: 0,
            atlLoad: 0,
          })),
        );
        mockedIntervalsList.mockResolvedValue([]);
      },
      kind: "fitness trend chart",
      footer: "get-fitness-trend with the same arguments",
      // The view projects 14 days by default; the twin's own default is 0.
      twin: { name: "get-fitness-trend", args: { days: 90, projectDays: 14 } },
    },
    {
      name: "view-activity-zones",
      args: { id: "123" },
      arrange: () => {
        mockedIntervalsActivity.mockResolvedValue(run());
      },
      kind: "zone distribution chart",
      footer: "get-activity-zones",
      twin: { name: "get-activity-zones", args: { id: "123" } },
    },
    {
      name: "view-route-map",
      args: { id: "123" },
      arrange: () => {
        mockedIntervalsActivity.mockResolvedValue(run());
        // A track with altitude, so get-hill-analysis has elevation to read.
        mockedIntervalsStreams.mockImplementation(async () => [
          ...runStreams(),
          {
            type: "latlng",
            data: Array.from({ length: 701 }, (_, i) => -33.9 + i * 1e-5),
            data2: Array.from({ length: 701 }, (_, i) => 151.2 + i * 1e-5),
          },
          {
            type: "altitude",
            data: Array.from({ length: 701 }, (_, i) => 10 + i * 0.06),
          },
        ]);
      },
      kind: "route map",
      footer: "get-activity",
      twin: { name: "get-hill-analysis", args: { id: "123" } },
      keepLines: true,
    },
    {
      name: "view-compare-activities",
      args: { activityId1: "i1", activityId2: "i2" },
      arrange: () => {
        mockedIntervalsActivity.mockImplementation(async (_key, id) =>
          run({ id, moving_time: id === "i2" ? 2900 : 3000 }),
        );
      },
      kind: "activity comparison",
      footer: "compare-activities",
      twin: {
        name: "compare-activities",
        args: { activityId1: "i1", activityId2: "i2" },
      },
    },
  ];

  it("covers every view-* tool the server advertises", async () => {
    const { TOOL_DEFS } = await import("./server");
    const advertised = TOOL_DEFS.map((tool) => tool.name)
      .filter((name) => name.startsWith("view-"))
      .sort();
    expect(VIEW_TOOLS.map((tool) => tool.name).sort()).toEqual(advertised);
  });

  describe.each(VIEW_TOOLS)(
    "$name",
    ({ name, args, arrange, kind, footer, twin, keepLines }) => {
      const then = twin
        ? keepLines
          ? `Its data follows, then the text of ${twin.name}.`
          : `The same data from ${twin.name} follows.`
        : "Its data follows.";

      it("says the chart is shown to a client that advertises MCP Apps", async () => {
        arrange();

        const result = await dispatchToolCall(name, args, {
          client: { rendersApps: true },
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text.startsWith(`${viewHeader(kind, true, then)}\n\n`)).toBe(
          true,
        );
        expect(text).not.toContain("may not show");
      });

      it("gives any other client a first line that is true whether or not its host shows the card", async () => {
        arrange();

        const result = await dispatchToolCall(name, args, {
          client: { rendersApps: false },
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text.startsWith(`${viewHeader(kind, false, then)}\n\n`)).toBe(
          true,
        );
        expect(text).not.toContain("cannot display");
        expect(text).not.toContain("rendered above");
      });

      if (twin) {
        it.each([true, false])(
          "gives the text twin's own text in the same call (renders apps: %s)",
          async (rendersApps) => {
            arrange();
            const direct = await dispatchToolCall(twin.name, twin.args);

            const result = await dispatchToolCall(name, args, {
              client: { rendersApps },
            });

            expect(direct.isError).toBeUndefined();
            expect(result.isError).toBeUndefined();
            const twinText = direct.content
              .map((block) => block.text)
              .join("\n");
            const text = result.content[0]?.text ?? "";
            if (keepLines) expect(text.endsWith(`\n\n${twinText}`)).toBe(true);
            else
              expect(text).toBe(
                `${viewHeader(kind, rendersApps, then)}\n\n${twinText}`,
              );
          },
        );
      }

      it("names only tools the server advertises", async () => {
        const { TOOL_DEFS } = await import("./server");
        const advertised = new Set(TOOL_DEFS.map((tool) => tool.name));

        const named = [
          ...(footer?.match(/\b[a-z]+(?:-[a-z]+)+\b/g) ?? []),
          ...(twin ? [twin.name] : []),
        ];
        for (const tool of named) expect(advertised).toContain(tool);
      });

      it("reads a call with no client information as a client that did not advertise MCP Apps", async () => {
        arrange();

        const result = await dispatchToolCall(name, args);

        const text = result.content[0]?.text ?? "";
        expect(text.startsWith(viewHeader(kind, false, then))).toBe(true);
      });
    },
  );

  it("names the text tool instead when the twin fails", async () => {
    // The view's own read succeeds; the twin's read of the same activity
    // fails, so the view keeps its summary and points at the tool.
    mockedIntervalsActivity
      .mockResolvedValueOnce(run())
      .mockRejectedValueOnce(new Error("upstream down"));

    const result = await dispatchToolCall(
      "view-activity-zones",
      { id: "123" },
      { client: { rendersApps: false } },
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Heart rate: mostly Z2");
    expect(text).not.toContain("upstream down");
    expect(
      text.startsWith(
        "This client did not report MCP Apps support, so the interactive zone distribution chart may not show. Its data follows.",
      ),
    ).toBe(true);
    expect(text.endsWith("For detail, call get-activity-zones.")).toBe(true);
    expect(mockedIntervalsActivity).toHaveBeenCalledTimes(2);
  });

  it("passes runOnly to get-training-load, so the text never mixes scopes", async () => {
    mockedIntervalsList.mockResolvedValue([
      run({ start_date_local: `${TODAY}T07:00:00` }),
    ]);
    mockedWellness.mockResolvedValue([]);
    const direct = await dispatchToolCall("get-training-load", {
      days: 84,
      runOnly: true,
    });

    const result = await dispatchToolCall(
      "view-training-load",
      { runOnly: true },
      { client: { rendersApps: false } },
    );

    const text = result.content[0]?.text ?? "";
    expect(text.endsWith(direct.content[0]?.text ?? "")).toBe(true);
  });

  it("gives a ride no per-km twin and names get-activity-streams", async () => {
    mockedIntervalsActivity.mockResolvedValue(run({ type: "Ride" }));
    mockedIntervalsStreams.mockImplementation(async () => runStreams());

    const result = await dispatchToolCall(
      "view-activity-chart",
      { id: "123" },
      { client: { rendersApps: false } },
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Type: Ride");
    expect(text).not.toContain("get-split-analysis");
    expect(text.endsWith("For detail, call get-activity-streams.")).toBe(true);
  });
});
