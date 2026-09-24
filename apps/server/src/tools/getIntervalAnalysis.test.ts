/**
 * Handler tests for get-interval-analysis (#183): dispatch-level, with the
 * Strava client mocked. Classification and reconstruction math is covered in
 * intervalAnalysis.test.ts; these pin the fetch wiring (including the
 * `moving` stream type and the lap fetch), degradation paths, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, stravaApi } from "../fetchClient";
import {
  getActivityById,
  getActivityLaps,
  type StravaDetailedActivity,
  type StravaLap,
} from "../stravaClient";
import { IntervalAnalysisOutputSchema } from "./outputs";

vi.mock("../stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stravaClient")>();
  return {
    ...actual,
    getActivityById: vi.fn(),
    getActivityLaps: vi.fn(),
  };
});

vi.mock("../fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fetchClient")>();
  return {
    ...actual,
    stravaApi: { get: vi.fn() },
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("../server");

const mockedById = vi.mocked(getActivityById);
const mockedLaps = vi.mocked(getActivityLaps);
const mockedApiGet = vi.mocked(stravaApi.get);

function activity(
  overrides: Record<string, unknown> = {},
): StravaDetailedActivity {
  return {
    id: "123",
    name: "Track Repeats",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-01T06:00:00Z",
    start_date_local: "2026-07-01T06:00:00Z",
    distance: 9000,
    moving_time: 2800,
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

/** 1 Hz streams from legs; speed 0 + moving false = stopped. */
function buildStreams(
  legs: Array<{
    seconds: number;
    speedMs: number;
    hr: number;
    moving?: boolean;
  }>,
) {
  const time: number[] = [0];
  const distance: number[] = [0];
  const hr: number[] = [legs[0]!.hr];
  const velocity: number[] = [legs[0]!.speedMs];
  const cadence: number[] = [88];
  const moving: boolean[] = [true];
  for (const leg of legs) {
    for (let s = 0; s < leg.seconds; s++) {
      time.push(time[time.length - 1]! + 1);
      distance.push(distance[distance.length - 1]! + leg.speedMs);
      hr.push(leg.hr);
      velocity.push(leg.speedMs);
      cadence.push(leg.speedMs > 0.3 ? 88 : 0);
      moving.push(leg.moving ?? leg.speedMs > 0.3);
    }
  }
  return [
    { type: "time", data: time },
    { type: "distance", data: distance },
    { type: "heartrate", data: hr },
    { type: "velocity_smooth", data: velocity },
    { type: "cadence", data: cadence },
    { type: "moving", data: moving },
  ];
}

const repeatsSession = () =>
  buildStreams([
    { seconds: 600, speedMs: 2.8, hr: 140 },
    { seconds: 30, speedMs: 0, hr: 120, moving: false },
    { seconds: 190, speedMs: 4.2, hr: 170 },
    { seconds: 90, speedMs: 0, hr: 130, moving: false },
    { seconds: 190, speedMs: 4.2, hr: 173 },
    { seconds: 90, speedMs: 0, hr: 130, moving: false },
    { seconds: 190, speedMs: 4.0, hr: 178 },
    { seconds: 90, speedMs: 0, hr: 130, moving: false },
    { seconds: 400, speedMs: 2.8, hr: 145 },
  ]);

const urbanLongRun = () =>
  buildStreams([
    { seconds: 900, speedMs: 3.0, hr: 142 },
    { seconds: 30, speedMs: 0, hr: 125, moving: false },
    { seconds: 900, speedMs: 3.0, hr: 144 },
    { seconds: 45, speedMs: 0, hr: 124, moving: false },
    { seconds: 900, speedMs: 3.0, hr: 146 },
    { seconds: 400, speedMs: 0, hr: 110, moving: false }, // café
    { seconds: 900, speedMs: 3.0, hr: 143 },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLaps.mockResolvedValue([]);
});

describe("get-interval-analysis", () => {
  it("reconstructs a repeats session with fade and doubled run cadence", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: repeatsSession() } as never);

    const result = await dispatchToolCall("get-interval-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Verdict: interval session — 3 work reps");
    expect(text).toContain("Fade: rep 3 was");
    expect(text).toContain("Rests:");

    const structured = result.structuredContent as {
      is_intervals: boolean;
      source: string;
      reps: Array<{ avg_cadence: number | null }>;
      rests: Array<{ kind: string }>;
      fade: { pace_drift_pct: number } | null;
    };
    expect(structured.is_intervals).toBe(true);
    expect(structured.source).toBe("streams");
    expect(structured.reps).toHaveLength(3);
    expect(structured.reps[0]!.avg_cadence).toBe(176);
    expect(structured.fade!.pace_drift_pct).toBeGreaterThan(3);
    expect(IntervalAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("classifies an urban long run as not intervals", async () => {
    mockedById.mockResolvedValueOnce(activity({ name: "City Long Run" }));
    mockedApiGet.mockResolvedValueOnce({ data: urbanLongRun() } as never);

    const result = await dispatchToolCall("get-interval-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Verdict: not an interval session");
    expect(text).toContain("traffic lights");

    const structured = result.structuredContent as {
      is_intervals: boolean;
      rests: Array<{ kind: string }>;
    };
    expect(structured.is_intervals).toBe(false);
    expect(
      structured.rests.filter((r) => r.kind === "traffic_light"),
    ).toHaveLength(2);
    expect(structured.rests.filter((r) => r.kind === "long_stop")).toHaveLength(
      1,
    );
  });

  it("requests the moving stream type and the laps endpoint", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: repeatsSession() } as never);

    await dispatchToolCall("get-interval-analysis", { activityId: "123" });

    const endpoint = mockedApiGet.mock.calls[0]![0] as string;
    expect(endpoint).toContain("moving");
    expect(mockedLaps).toHaveBeenCalledWith("test-token", "123");
  });

  it("prefers clean structured laps for jog-recovery sessions", async () => {
    const lap = (
      lap_index: number,
      distance: number,
      moving_time: number,
      average_heartrate: number,
    ) =>
      ({
        lap_index,
        distance,
        moving_time,
        average_speed: distance / moving_time,
        average_heartrate,
      }) as unknown as StravaLap;

    mockedById.mockResolvedValueOnce(activity());
    // Continuous easy movement: the stream path sees nothing.
    mockedApiGet.mockResolvedValueOnce({
      data: buildStreams([{ seconds: 2400, speedMs: 3.0, hr: 150 }]),
    } as never);
    mockedLaps.mockResolvedValueOnce([
      lap(1, 2000, 700, 138),
      lap(2, 800, 190, 170),
      lap(3, 400, 240, 148),
      lap(4, 800, 192, 174),
      lap(5, 400, 240, 150),
      lap(6, 800, 191, 176),
      lap(7, 1500, 520, 142),
    ]);

    const result = await dispatchToolCall("get-interval-analysis", {
      activityId: "123",
    });

    const structured = result.structuredContent as {
      is_intervals: boolean;
      source: string;
      reps: unknown[];
    };
    expect(structured.is_intervals).toBe(true);
    expect(structured.source).toBe("laps");
    expect(structured.reps).toHaveLength(3);
    expect(result.content[0]?.text).toContain("clean structured laps");
  });

  it("survives a failing laps fetch", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: repeatsSession() } as never);
    mockedLaps.mockRejectedValueOnce(new Error("laps endpoint down"));

    const result = await dispatchToolCall("get-interval-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { source: string };
    expect(structured.source).toBe("streams");
  });

  it("errors cleanly for a manual activity with no streams", async () => {
    mockedById.mockResolvedValueOnce(activity({ name: "Manual Entry" }));
    // Strava answers 404 for an activity that recorded nothing.
    mockedApiGet.mockRejectedValueOnce(
      new HttpError("HTTP 404: Record Not Found", {
        status: 404,
        statusText: "Not Found",
        data: "Record Not Found",
      }),
    );

    const result = await dispatchToolCall("get-interval-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No data streams");
  });
});
