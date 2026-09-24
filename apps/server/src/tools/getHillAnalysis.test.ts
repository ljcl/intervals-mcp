/**
 * Handler tests for get-hill-analysis (#182): dispatch-level, with the
 * Strava client mocked. The detection and drift math is covered in
 * hillAnalysis.test.ts; these pin the fetch wiring, cadence doubling,
 * degradation paths, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RateLimitError, stravaApi } from "../fetchClient";
import { getActivityById, type StravaDetailedActivity } from "../stravaClient";
import { HillAnalysisOutputSchema } from "./outputs";

vi.mock("../stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stravaClient")>();
  return {
    ...actual,
    getActivityById: vi.fn(),
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
const mockedApiGet = vi.mocked(stravaApi.get);

function activity(
  overrides: Record<string, unknown> = {},
): StravaDetailedActivity {
  return {
    id: "123",
    name: "Hilly Long Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-01T06:00:00Z",
    start_date_local: "2026-07-01T06:00:00Z",
    distance: 10000,
    moving_time: 3000,
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

/**
 * 1 Hz streams: flat 1 km, 500 m climb at 6%, flat 3 km, 500 m climb at 6%
 * with higher HR, flat 1 km. Speed 2.5 m/s everywhere for simple maths.
 */
function hillyStreams() {
  const legs = [
    { lengthM: 1000, grade: 0, hr: 140 },
    { lengthM: 500, grade: 6, hr: 150 },
    { lengthM: 3000, grade: 0, hr: 140 },
    { lengthM: 500, grade: 6, hr: 168 },
    { lengthM: 1000, grade: 0, hr: 140 },
  ];
  const time: number[] = [0];
  const distance: number[] = [0];
  const altitude: number[] = [10];
  const grade: number[] = [0];
  const hr: number[] = [140];
  const velocity: number[] = [2.5];
  const cadence: number[] = [85];
  const moving: boolean[] = [true];
  for (const leg of legs) {
    for (let s = 0; s < leg.lengthM / 2.5; s++) {
      time.push(time[time.length - 1]! + 1);
      distance.push(distance[distance.length - 1]! + 2.5);
      altitude.push(altitude[altitude.length - 1]! + (2.5 * leg.grade) / 100);
      grade.push(leg.grade);
      hr.push(leg.hr);
      velocity.push(2.5);
      cadence.push(85);
      moving.push(true);
    }
  }
  return [
    { type: "time", data: time },
    { type: "distance", data: distance },
    { type: "altitude", data: altitude },
    { type: "grade_smooth", data: grade },
    { type: "heartrate", data: hr },
    { type: "velocity_smooth", data: velocity },
    { type: "cadence", data: cadence },
    { type: "moving", data: moving },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get-hill-analysis", () => {
  it("detects climbs and reports positive late-run drift", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: hillyStreams() } as never);

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Hill Analysis: Hilly Long Run");
    expect(text).toContain("Late-vs-early climb drift: +");
    expect(text).toContain("late-race hill fatigue");
    expect(text).toContain("Climbs:");

    const structured = result.structuredContent as {
      climbs: Array<{ avg_cadence: number | null; avg_grade_pct: number }>;
      drift: { basis: string; drift_pct: number } | null;
      totals: { climb_count: number };
    };
    expect(structured.totals.climb_count).toBe(2);
    expect(structured.drift?.basis).toBe("hr_per_gap");
    expect(structured.drift!.drift_pct).toBeGreaterThan(5);
    // Run cadence is doubled to spm for display.
    expect(structured.climbs[0]!.avg_cadence).toBe(170);
    expect(HillAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("streams request includes cadence and grade types", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: hillyStreams() } as never);

    await dispatchToolCall("get-hill-analysis", { activityId: "123" });

    const endpoint = mockedApiGet.mock.calls[0]![0] as string;
    for (const type of ["grade_smooth", "cadence", "altitude", "moving"]) {
      expect(endpoint).toContain(type);
    }
  });

  it("reports a flat activity without erroring", async () => {
    const flat = hillyStreams().map((s) =>
      s.type === "grade_smooth"
        ? { ...s, data: (s.data as number[]).map(() => 0) }
        : s.type === "altitude"
          ? { ...s, data: (s.data as number[]).map(() => 10) }
          : s,
    );
    mockedById.mockResolvedValueOnce(activity({ name: "Flat Run" }));
    mockedApiGet.mockResolvedValueOnce({ data: flat } as never);

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("flat activity");
    const structured = result.structuredContent as {
      climbs: unknown[];
      drift: unknown;
    };
    expect(structured.climbs).toHaveLength(0);
    expect(structured.drift).toBeNull();
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

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No data streams");
  });

  it("reports an exhausted rate limit instead of claiming there are no streams", async () => {
    // #237: the bare `catch {}` used to turn any stream failure into "manual
    // activities have no recorded samples", which told the user their
    // GPS-recorded run was a manual entry and hid the actual one-line fix.
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockRejectedValueOnce(
      new RateLimitError(
        "15-minute rate limit reached (100/100 requests).",
        { status: 429, statusText: "Too Many Requests", data: "" },
        { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
        60,
      ),
    );

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("rate limit");
    expect(text).not.toContain("No data streams");
  });

  it("surfaces an auth failure instead of claiming there are no streams", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockRejectedValue(
      new HttpError("HTTP 401: Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
        data: '{"message":"Authorization Error"}',
      }),
    );

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("No data streams");
  });

  it("surfaces analysis errors as actionable messages", async () => {
    // Distance + time only: no grade or altitude to work with.
    const bare = hillyStreams().filter(
      (s) => s.type === "time" || s.type === "distance",
    );
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: bare } as never);

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("elevation");
  });

  it("keeps rpm cadence for rides", async () => {
    mockedById.mockResolvedValueOnce(
      activity({ type: "Ride", sport_type: "Ride" }),
    );
    mockedApiGet.mockResolvedValueOnce({ data: hillyStreams() } as never);

    const result = await dispatchToolCall("get-hill-analysis", {
      activityId: "123",
    });

    const structured = result.structuredContent as {
      climbs: Array<{ avg_cadence: number | null }>;
    };
    expect(structured.climbs[0]!.avg_cadence).toBe(85);
  });
});
