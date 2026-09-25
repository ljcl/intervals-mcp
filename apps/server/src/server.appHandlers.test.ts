/**
 * Success and error paths for the MCP App tool handlers in server.ts (#115).
 * Table-driven through dispatchToolCall — the same path the host uses — with
 * the Strava client mocked. The missing-key table pins the regression where
 * those early returns lacked `isError: true` and surfaced as ordinary content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import { HttpError, RateLimitError, stravaApi } from "./fetchClient";
import {
  ATL_TIME_CONSTANT_DAYS,
  addDays,
  CTL_TIME_CONSTANT_DAYS,
} from "./fitnessTrend";
import {
  getActivity as getIntervalsActivityFn,
  getWellness as getWellnessFn,
  type IntervalsActivity,
  type IntervalsWellness,
  listActivities as listActivitiesFn,
} from "./intervalsClient";
import {
  getActivityById,
  getActivityLaps,
  getAllActivities,
  type StravaDetailedActivity,
  type StravaLap,
  type StravaSummaryActivity,
} from "./stravaClient";

vi.mock("./stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stravaClient")>();
  return {
    ...actual,
    getActivityById: vi.fn(),
    getActivityLaps: vi.fn(),
    getAllActivities: vi.fn(),
  };
});

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getWellness: vi.fn(),
    listActivities: vi.fn(),
  };
});

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    stravaApi: { get: vi.fn() },
  };
});

// dispatchToolCall resolves the API key once per call (#240), so the
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

const mockedById = vi.mocked(getActivityById);
const mockedLaps = vi.mocked(getActivityLaps);
const mockedIntervalsActivity = vi.mocked(getIntervalsActivityFn);
const mockedWellness = vi.mocked(getWellnessFn);
const mockedIntervalsList = vi.mocked(listActivitiesFn);
const mockedList = vi.mocked(getAllActivities);
const mockedApiGet = vi.mocked(stravaApi.get);

// Google's polyline example: three points near (38.5, -120.2).
const POLYLINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

function detailedActivity(
  overrides: Record<string, unknown> = {},
): StravaDetailedActivity {
  return {
    id: "123",
    name: "Morning Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-06-01T07:00:00Z",
    start_date_local: "2026-06-01T07:00:00Z",
    distance: 10000,
    moving_time: 3000,
    total_elevation_gain: 120,
    average_speed: 3.33,
    average_heartrate: 150,
    map: { summary_polyline: POLYLINE },
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

function summaryRun(
  overrides: Record<string, unknown> = {},
): StravaSummaryActivity {
  return {
    id: "1",
    name: "Easy Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-06-01T07:00:00Z",
    start_date_local: "2026-06-01T07:00:00Z",
    distance: 8000,
    moving_time: 2400,
    average_cadence: 42.5,
    average_speed: 3.33,
    total_elevation_gain: 60,
    ...overrides,
  } as unknown as StravaSummaryActivity;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedToken.mockReturnValue("test-token");
});

/** Every app tool with args that pass its input schema. */
const APP_TOOL_CALLS: Array<[string, Record<string, unknown>]> = [
  ["view-activity-chart", { activity_id: "123" }],
  ["get-activity-streams-raw", { activity_id: "123" }],
  ["view-cadence-trends", {}],
  ["get-cadence-trend-data", {}],
  ["view-route-map", { activity_id: "123" }],
  ["get-route-map-data", { activity_id: "123" }],
  ["view-training-load", {}],
  ["get-training-load-data", {}],
  ["view-activity-zones", { activity_id: "123" }],
  ["get-activity-zones-data", { activity_id: "123" }],
  ["view-compare-activities", { activity_id_1: "1", activity_id_2: "2" }],
  ["get-compare-activities-data", { activity_id_1: "1", activity_id_2: "2" }],
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
      // One message for every tool, naming the one recovery (#240).
      expect(result.content[0]?.text).toContain("INTERVALS_API_KEY");
    },
  );

  it("resolves the key once per call and hands it to the handler", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());

    await dispatchToolCall("view-activity-chart", { activity_id: "123" });

    expect(mockedToken).toHaveBeenCalledTimes(1);
    expect(mockedById).toHaveBeenCalledWith("test-token", "123");
  });

  it("does not run the handler when the key cannot be resolved", async () => {
    mockedToken.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    await dispatchToolCall("view-activity-chart", { activity_id: "123" });

    expect(mockedById).not.toHaveBeenCalled();
  });
});

describe("view-activity-chart", () => {
  it("summarises the activity for the model", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());

    const result = await dispatchToolCall("view-activity-chart", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity: Morning Run");
    expect(text).toContain("Distance: 10.00 km");
    expect(mockedById).toHaveBeenCalledWith("test-token", "123");
  });

  it("surfaces a Strava failure as a structured tool error", async () => {
    mockedById.mockRejectedValueOnce(new Error("Record Not Found"));

    const result = await dispatchToolCall("view-activity-chart", {
      activity_id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Record Not Found");
  });
});

describe("get-activity-streams-raw", () => {
  it("returns streams keyed by type plus mapped laps", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockResolvedValueOnce({
      data: [
        { type: "time", data: [0, 1, 2] },
        { type: "heartrate", data: [140, 150, 160] },
      ],
    } as never);
    mockedLaps.mockResolvedValueOnce([
      {
        name: "Lap 1",
        start_index: 0,
        end_index: 2,
        distance: 1000,
        elapsed_time: 300,
        moving_time: 290,
        average_speed: 3.3,
        average_heartrate: 152,
        lap_index: 1,
      } as unknown as StravaLap,
    ]);

    const result = await dispatchToolCall("get-activity-streams-raw", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    // A string, not a number: ids are 64-bit and `Number()` here used to
    // round anything past 2^53 (#270).
    expect(parsed.activityId).toBe("123");
    expect(parsed.streams.heartrate).toEqual([140, 150, 160]);
    expect(parsed.laps).toEqual([
      {
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
  });

  it("returns isError when the stream fetch fails", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockRejectedValueOnce(new Error("Rate limited"));
    mockedLaps.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-activity-streams-raw", {
      activity_id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rate limited");
  });
});

describe("cadence trends handlers", () => {
  it("view-cadence-trends reports run count and doubled cadence", async () => {
    mockedList.mockResolvedValueOnce([
      summaryRun(),
      summaryRun({ id: "2", type: "Ride" }), // filtered out
    ]);

    const result = await dispatchToolCall("view-cadence-trends", { weeks: 4 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Cadence Trends (last 4 weeks)");
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Average cadence: 85 spm");
  });

  it("get-cadence-trend-data maps runs to per-activity summaries", async () => {
    mockedList.mockResolvedValueOnce([summaryRun()]);

    const result = await dispatchToolCall("get-cadence-trend-data", {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.weeks).toBe(6);
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.activities[0]).toMatchObject({
      id: "1",
      name: "Easy Run",
      distance: 8,
      averageCadence: 85,
    });
  });

  it("a view-/get-…-data pair builds one quantized window, so the cached scan is shared (#329)", async () => {
    // The two calls of one app open land seconds apart; a raw Date.now()
    // per call gave them different `after` values, two URLs, and two full
    // history scans. The bounds are floored to the minute so the pair keys
    // onto one cached listing.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-19T10:00:05Z"));
      mockedList.mockResolvedValue([summaryRun()]);

      await dispatchToolCall("view-cadence-trends", { weeks: 4 });
      vi.setSystemTime(new Date("2026-08-19T10:00:35Z")); // 30 s later
      await dispatchToolCall("get-cadence-trend-data", { weeks: 4 });

      const [viewCall, dataCall] = mockedList.mock.calls.slice(-2);
      expect(viewCall?.[1]?.after).toBeDefined();
      expect(viewCall?.[1]?.after).toBe(dataCall?.[1]?.after);
      expect((viewCall?.[1]?.after ?? 0) % 60).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the fitness-trend pair shares both window bounds (#329)", async () => {
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
  it("view-training-load summarises totals and warning weeks", async () => {
    mockedList.mockResolvedValueOnce([summaryRun()]);

    const result = await dispatchToolCall("view-training-load", {});

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Training Load (last 84 days)");
    expect(text).toContain("Runs: 1");
    expect(text).toContain("Distance: 8 km");
  });

  it("get-training-load-data returns the weekly aggregation", async () => {
    mockedList.mockResolvedValueOnce([summaryRun()]);

    const result = await dispatchToolCall("get-training-load-data", {
      days: 84,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.days).toBe(84);
    expect(parsed.totals.runs).toBe(1);
    expect(parsed.weeks.length).toBeGreaterThan(0);
  });
});

describe("fitness trend handlers", () => {
  const TODAY = "2026-08-19";
  const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
  const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);

  /**
   * A self-consistent synthetic wellness series (own ctl/atl reproduces the
   * same recurrence the app handler recomputes from ctlLoad/atlLoad): `days`
   * rows ending at `endDate`, load `recentLoad` for the most recent
   * `activeDays` of them, else zero.
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

  it("view-fitness-trend prints the same headline numbers as the chart", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 21, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);
    const targetDate = inDays(14);

    const result = await dispatchToolCall("view-fitness-trend", {
      targetDate,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Fitness Trend (last 90 days)");
    expect(text).toContain("Fitness (CTL)");
    expect(text).toContain(`Taper to ${targetDate}`);
    expect(text).toContain("week 1");
    expect(text).toContain("[Interactive fitness trend chart rendered above]");
  });

  it("view-fitness-trend reports the fresh date when only resting", async () => {
    mockedWellness.mockResolvedValueOnce(wellnessSeries(TODAY, 91, 10, 80));
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("view-fitness-trend", {});

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("form turns positive on");
    expect(text).not.toContain("Taper to");
  });

  it("rejects a malformed target date via the input schema", async () => {
    const result = await dispatchToolCall("get-fitness-trend-data", {
      targetDate: "next Sunday",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid target date");
    expect(mockedWellness).not.toHaveBeenCalled();
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });
});

describe("route map handlers", () => {
  it("view-route-map decodes an activity polyline", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());

    const result = await dispatchToolCall("view-route-map", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity: Morning Run");
    expect(text).toContain("Distance: 10.00 km");
    expect(text).not.toContain("No GPS track");
  });

  it("view-route-map flags an empty track", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity({ map: {} }));

    const result = await dispatchToolCall("view-route-map", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No GPS track is available");
  });

  it("get-route-map-data prefers latlng streams over the polyline", async () => {
    const coords: Array<[number, number]> = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockResolvedValueOnce({
      data: [
        { type: "latlng", data: coords },
        { type: "distance", data: [0, 5000, 10000] },
      ],
    } as never);
    mockedLaps.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-route-map-data", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.source).toBe("activity");
    expect(parsed.coordinates).toEqual(coords);
    expect(parsed.streams.distance).toEqual([0, 5000, 10000]);
  });

  it("get-route-map-data still renders the map when the lap layer hits a rate limit", async () => {
    // The lap layer sat behind a bare `catch {}`, so an exhausted quota lost
    // the markers with nothing said — #237 again, one layer down. The
    // geometry is already fetched by then, so the fix is a warning naming
    // the exhausted window, not the loss of the whole map.
    const coords: Array<[number, number]> = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockResolvedValueOnce({
      data: [
        { type: "latlng", data: coords },
        { type: "distance", data: [0, 5000, 10000] },
      ],
    } as never);
    mockedLaps.mockRejectedValueOnce(handledRateLimit("getActivityLaps(123)"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchToolCall("get-route-map-data", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.coordinates).toEqual(coords);
    expect(parsed.annotations?.laps).toBeUndefined();
    expect(parsed.layerWarnings).toEqual([
      "Dropped lap markers: 15-minute rate limit reached (100/100 requests). The map renders without them.",
    ]);
    // The bare window description, not the internal call that hit it.
    expect(parsed.layerWarnings[0]).not.toContain("getActivityLaps");
    logged.mockRestore();
  });

  it("get-route-map-data falls back to the polyline for a stream-less activity", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());
    // Strava answers 404 for an activity that recorded no samples.
    mockedApiGet.mockRejectedValueOnce(
      new HttpError("HTTP 404: Record Not Found", {
        status: 404,
        statusText: "Not Found",
        data: "Record Not Found",
      }),
    );

    const result = await dispatchToolCall("get-route-map-data", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.coordinates).toHaveLength(3);
    expect(parsed.streams).toBeUndefined();
  });

  it("get-route-map-data reports a rate limit rather than silently dropping streams", async () => {
    // #237: an exhausted quota used to be swallowed into the polyline path,
    // so the user got a metric-less map with no hint that waiting would fix it.
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockRejectedValueOnce(
      new RateLimitError(
        "15-minute rate limit reached (100/100 requests).",
        { status: 429, statusText: "Too Many Requests", data: "" },
        { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
        60,
      ),
    );

    const result = await dispatchToolCall("get-route-map-data", {
      activity_id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
  });

  it("get-route-map-data anchors waypoints on the distance stream and drops out-of-range ones", async () => {
    const coords: Array<[number, number]> = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    mockedById.mockResolvedValueOnce(detailedActivity());
    mockedApiGet.mockResolvedValueOnce({
      data: [
        { type: "latlng", data: coords },
        { type: "distance", data: [0, 5000, 10000] },
      ],
    } as never);
    mockedLaps.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-route-map-data", {
      activity_id: "123",
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

  it("view-route-map reports pinned waypoints and warns about dropped ones", async () => {
    mockedById.mockResolvedValueOnce(detailedActivity());

    const result = await dispatchToolCall("view-route-map", {
      activity_id: "123",
      waypoints: [
        { km: 5, label: "Gel 1", kind: "fuel" },
        { km: 42.2, label: "Finish gel", kind: "fuel" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Waypoints: 1 pinned");
    expect(text).toContain("Warning: Dropped 1 waypoint");
    expect(text).toContain('"Finish gel" (42.2 km)');
  });

  it("rejects malformed waypoints via the input schema", async () => {
    const result = await dispatchToolCall("view-route-map", {
      activity_id: "123",
      waypoints: [{ km: -2, label: "" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-route-map",
    );
  });

  it("get-route-map-data errors when activity_id is not provided", async () => {
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
      activity_id_1: "i1",
      activity_id_2: "i2",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity 1: Morning Run");
    expect(text).toContain("Activity 2: Race Day");
    expect(text).toContain("faster");
  });

  it("propagates a fetch failure as isError", async () => {
    mockedIntervalsActivity.mockRejectedValueOnce(
      new Error("Record Not Found"),
    );

    const result = await dispatchToolCall("get-compare-activities-data", {
      activity_id_1: "i1",
      activity_id_2: "i2",
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
      activity_id: "123",
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

  it("view-activity-zones summarises the dominant zone for the model", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(intervalsActivity());

    const result = await dispatchToolCall("view-activity-zones", {
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity Zones: Morning Run");
    expect(text).toContain("Heart rate: mostly Z2 (60% of 50 min)");
    expect(text).toContain(
      "[Interactive zone distribution chart rendered above]",
    );
  });

  it("view-activity-zones handles an activity with no zone data", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce(
      intervalsActivity({ icu_hr_zones: null, icu_hr_zone_times: null }),
    );

    const result = await dispatchToolCall("view-activity-zones", {
      activity_id: "123",
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
      activity_id: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Heart rate zones omitted");
  });

  it("propagates a zones fetch failure as isError", async () => {
    mockedIntervalsActivity.mockRejectedValueOnce(
      new Error("Record Not Found"),
    );

    const result = await dispatchToolCall("get-activity-zones-data", {
      activity_id: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Record Not Found");
  });
});
