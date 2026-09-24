/**
 * Handler tests for get-aerobic-analysis (#180): dispatch-level, with the
 * Strava client mocked. The math itself is covered in aerobicAnalysis.test.ts;
 * these pin the fetch wiring, FTP fallback, degradation paths, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, stravaApi } from "../fetchClient";
import {
  getActivityById,
  getAuthenticatedAthlete,
  type StravaAthlete,
  type StravaDetailedActivity,
} from "../stravaClient";

vi.mock("../stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stravaClient")>();
  return {
    ...actual,
    getActivityById: vi.fn(),
    getAuthenticatedAthlete: vi.fn(),
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
const mockedAthlete = vi.mocked(getAuthenticatedAthlete);
const mockedApiGet = vi.mocked(stravaApi.get);

function activity(
  overrides: Record<string, unknown> = {},
): StravaDetailedActivity {
  return {
    id: "123",
    name: "Long Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-01T06:00:00Z",
    start_date_local: "2026-07-01T06:00:00Z",
    distance: 20000,
    moving_time: 6000,
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

/** One-hour steady streams: 250 W at 150 bpm. */
function steadyStreams() {
  const n = 3600;
  const time = Array.from({ length: n }, (_, i) => i);
  return [
    { type: "time", data: time },
    { type: "heartrate", data: time.map(() => 150) },
    { type: "watts", data: time.map(() => 250) },
    { type: "velocity_smooth", data: time.map(() => 3.2) },
    { type: "moving", data: time.map(() => true) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get-aerobic-analysis", () => {
  it("analyses a steady run and reports the bands", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: steadyStreams() } as never);
    mockedAthlete.mockResolvedValueOnce(null as unknown as StravaAthlete);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Aerobic Analysis: Long Run");
    expect(text).toContain("Basis: power:HR (Pw:Hr)");
    expect(text).toContain("Decoupling: +0.0%");
    expect(text).toContain("excellent");
    expect(text).toContain("Normalized power: 250 W");

    const structured = result.structuredContent as {
      decoupling_pct: number;
      basis: string;
      intensity_factor: number | null;
    };
    expect(structured.basis).toBe("power");
    expect(structured.decoupling_pct).toBeCloseTo(0, 1);
    // No threshold anywhere → no IF.
    expect(structured.intensity_factor).toBeNull();
  });

  it("uses the athlete profile FTP for IF when no threshold is passed", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: steadyStreams() } as never);
    mockedAthlete.mockResolvedValueOnce({ ftp: 300 } as StravaAthlete);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "Intensity factor: 0.833 (threshold 300 W)",
    );
  });

  it("prefers an explicit thresholdPower and skips the athlete fetch", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: steadyStreams() } as never);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
      thresholdPower: 250,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Intensity factor: 1");
    expect(mockedAthlete).not.toHaveBeenCalled();
  });

  it("degrades to speed:HR with a warning when watts are missing", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({
      data: steadyStreams().filter((s) => s.type !== "watts"),
    } as never);
    mockedAthlete.mockResolvedValueOnce(null as unknown as StravaAthlete);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Basis: speed:HR (Pa:Hr)");
    expect(text).toContain("Warning:");
    expect(text).toContain("speed:HR");
  });

  it("returns an actionable error when HR is missing", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({
      data: steadyStreams().filter((s) => s.type !== "heartrate"),
    } as never);
    mockedAthlete.mockResolvedValueOnce(null as unknown as StravaAthlete);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("heart rate");
  });

  it("errors cleanly for a manual activity with no streams", async () => {
    mockedById.mockResolvedValueOnce(activity({ name: "Manual Yoga" }));
    // Strava answers 404 for an activity that recorded nothing.
    mockedApiGet.mockRejectedValueOnce(
      new HttpError("HTTP 404: Record Not Found", {
        status: 404,
        statusText: "Not Found",
        data: "Record Not Found",
      }),
    );
    mockedAthlete.mockResolvedValueOnce(null as unknown as StravaAthlete);

    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No data streams");
  });

  it("rejects invalid warm-up input via the schema", async () => {
    const result = await dispatchToolCall("get-aerobic-analysis", {
      activityId: "123",
      excludeWarmupMinutes: -5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for get-aerobic-analysis",
    );
  });
});
