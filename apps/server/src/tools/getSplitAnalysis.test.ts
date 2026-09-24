/**
 * Handler tests for get-split-analysis (#265): dispatch-level, with the Strava
 * client mocked. The binning and verdict math is covered in
 * splitAnalysis.test.ts; these pin the fetch wiring, unit handling, cadence
 * doubling, degradation paths, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RateLimitError, stravaApi } from "../fetchClient";
import { getActivityById, type StravaDetailedActivity } from "../stravaClient";
import { SplitAnalysisOutputSchema } from "./outputs";

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
    name: "Sunday Long Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-07-05T06:00:00Z",
    start_date_local: "2026-07-05T06:00:00Z",
    distance: 10000,
    moving_time: 3150,
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

/**
 * 1 Hz streams over `legs`: 5 km at 5:00/km then 5 km at 5:30/km, flat — a
 * textbook positive split with no terrain to explain it.
 */
function fadingStreams(
  legs = [
    { lengthM: 5000, secPerKm: 300, grade: 0, hr: 145 },
    { lengthM: 5000, secPerKm: 330, grade: 0, hr: 152 },
  ],
) {
  const time: number[] = [0];
  const distance: number[] = [0];
  const altitude: number[] = [20];
  const grade: number[] = [0];
  const hr: number[] = [140];
  const velocity: number[] = [0];
  const cadence: number[] = [85];
  const moving: boolean[] = [true];

  for (const leg of legs) {
    const speed = 1000 / leg.secPerKm;
    for (let s = 0; s < Math.round(leg.lengthM / speed); s++) {
      time.push(time[time.length - 1]! + 1);
      distance.push(distance[distance.length - 1]! + speed);
      altitude.push(altitude[altitude.length - 1]! + (speed * leg.grade) / 100);
      grade.push(leg.grade);
      hr.push(leg.hr);
      velocity.push(speed);
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

describe("get-split-analysis", () => {
  it("returns per-km splits, a verdict, and valid structured output", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: fadingStreams() } as never);

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      unit: string;
      splits: Array<{
        split: number;
        pace_formatted: string | null;
        avg_hr: number | null;
        avg_cadence: number | null;
      }>;
      verdict: { shape: string; gap_shape: string; delta_pct: number } | null;
      fastest_split: number | null;
      totals: { distance_m: number };
    };

    expect(structured.unit).toBe("km");
    expect(structured.splits).toHaveLength(10);
    expect(structured.splits[0]!.pace_formatted).toBe("5:00 /km");
    expect(structured.verdict!.shape).toBe("positive");
    expect(structured.verdict!.gap_shape).toBe("positive");
    expect(structured.verdict!.delta_pct).toBeGreaterThan(5);
    expect(structured.fastest_split).toBeLessThanOrEqual(5);
    expect(structured.totals.distance_m).toBeCloseTo(10000, -1);
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Split Analysis: Sunday Long Run");
    expect(text).toContain("Verdict: positive split on the clock");
    expect(text).toContain("that is fade, not terrain");
    expect(text).toContain("Splits (km):");
    expect(text).toContain("Fastest split");
  });

  it("splits by mile on request", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: fadingStreams() } as never);

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
      unit: "mile",
    });

    const structured = result.structuredContent as {
      unit: string;
      splits: Array<{ pace_formatted: string | null; partial: boolean }>;
    };
    expect(structured.unit).toBe("mile");
    expect(structured.splits).toHaveLength(7);
    expect(structured.splits[0]!.pace_formatted).toContain("/mile");
    expect(structured.splits[6]!.partial).toBe(true);
    expect(result.content[0]?.text).toContain("Splits (mile):");
  });

  it("doubles run cadence to spm and keeps rpm for rides", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({ data: fadingStreams() } as never);

    const run = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });
    expect(
      (run.structuredContent as { splits: Array<{ avg_cadence: number }> })
        .splits[0]!.avg_cadence,
    ).toBe(170);

    mockedById.mockResolvedValueOnce(
      activity({ type: "Ride", sport_type: "Ride" }),
    );
    mockedApiGet.mockResolvedValueOnce({ data: fadingStreams() } as never);

    const ride = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });
    expect(
      (ride.structuredContent as { splits: Array<{ avg_cadence: number }> })
        .splits[0]!.avg_cadence,
    ).toBe(85);
  });

  it("reads a hilly back half as terrain rather than fade", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({
      data: fadingStreams([
        { lengthM: 5000, secPerKm: 300, grade: 0, hr: 145 },
        { lengthM: 5000, secPerKm: 345, grade: 3, hr: 148 },
      ]),
    } as never);

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });

    const structured = result.structuredContent as {
      verdict: { shape: string; gap_shape: string; terrain_pct: number };
    };
    expect(structured.verdict.shape).toBe("positive");
    expect(structured.verdict.gap_shape).not.toBe("positive");
    expect(structured.verdict.terrain_pct).toBeGreaterThan(2);
    expect(result.content[0]?.text).toContain("terrain accounts for");
  });

  it("says so for a manual activity with no streams", async () => {
    mockedById.mockResolvedValueOnce(activity({ name: "Treadmill" }));
    // Strava answers 404 for an activity that recorded nothing.
    mockedApiGet.mockRejectedValueOnce(
      new HttpError("HTTP 404: Record Not Found", {
        status: 404,
        statusText: "Not Found",
        data: "Record Not Found",
      }),
    );

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No data streams are available");
  });

  it("reports a rate limit rather than claiming there are no streams", async () => {
    // The #237 regression: a quota failure must not read as a manual entry.
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockRejectedValueOnce(
      new RateLimitError(
        "15-minute rate limit reached (100/100 requests).",
        { status: 429, statusText: "Too Many Requests", data: "" },
        { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
        60,
      ),
    );

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
    expect(result.content[0]?.text).not.toContain("No data streams");
  });

  it("errors when the streams carry no distance", async () => {
    mockedById.mockResolvedValueOnce(activity());
    mockedApiGet.mockResolvedValueOnce({
      data: fadingStreams().filter((s) => s.type === "time"),
    } as never);

    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No data streams are available");
  });

  it("rejects an unknown unit via the input schema", async () => {
    const result = await dispatchToolCall("get-split-analysis", {
      activityId: "123",
      unit: "furlong",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid arguments");
    expect(mockedById).not.toHaveBeenCalled();
  });
});
