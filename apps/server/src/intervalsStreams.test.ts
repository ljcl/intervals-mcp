/**
 * loadIntervalsStreams: the intervals.icu counterpart to the Strava
 * client's `getActivityStreams`/`StreamsUnavailableError` pair.
 * Turns the raw stream array into named, index-aligned arrays and derives
 * `moving`, which intervals.icu never returns (docs research 2026-09-24).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import streamsFixture from "./__fixtures__/intervals/streams.json";
import streamsHillyFixture from "./__fixtures__/intervals/streams-hilly.json";
import { HttpError, intervalsApi, RateLimitError } from "./fetchClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
  MOVING_GAP_THRESHOLD_SECONDS,
  MOVING_MIN_VELOCITY_MPS,
} from "./intervalsStreams";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return { ...actual, intervalsApi: { get: vi.fn() } };
});

const mockedGet = vi.mocked(intervalsApi.get);

const notFound = () =>
  new HttpError("HTTP 404: Not Found", {
    status: 404,
    statusText: "Not Found",
    data: "Not Found",
  });

const rateLimited = () =>
  new RateLimitError(
    "15-minute rate limit reached (100/100 requests).",
    { status: 429, statusText: "Too Many Requests", data: "" },
    { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
    60,
  );

const serverError = () =>
  new HttpError("HTTP 500", {
    status: 500,
    statusText: "Internal Server Error",
    data: "",
  });

beforeEach(() => {
  mockedGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadIntervalsStreams", () => {
  it("returns the named-array shape from a real fixture", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsFixture });

    const streams = await loadIntervalsStreams("key", "i1", [
      "time",
      "distance",
      "heartrate",
      "altitude",
      "velocity_smooth",
      "cadence",
      "latlng",
    ]);

    expect(streams.time).toHaveLength(600);
    expect(streams.time[0]).toBe(0);
    expect(streams.distance).toHaveLength(600);
    expect(streams.heartrate).toHaveLength(600);
    expect(streams.altitude).toHaveLength(600);
    expect(streams.velocity_smooth).toHaveLength(600);
    expect(streams.cadence).toHaveLength(600);
    expect(streams.latlng).toHaveLength(600);
    expect(streams.latlng?.[0]).toBeNull();
    expect(streams.latlng?.[2]).toEqual([-33.8568, 151.2153]);
    expect(streams.moving).toHaveLength(600);
    expect(streams.length).toBe(600);
    // Not requested: absent, not present-with-undefined.
    expect(Object.hasOwn(streams, "watts")).toBe(false);
    expect(Object.hasOwn(streams, "grade_smooth")).toBe(false);
  });

  it("keeps nulls in the requested arrays other than time", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsFixture });

    const streams = await loadIntervalsStreams("key", "i1", [
      "time",
      "distance",
    ]);

    // streams.json's distance stream carries nulls (verified in fixture).
    expect(streams.distance?.some((v) => v === null)).toBe(true);
  });

  it("only requests the types passed in, always including time", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { type: "time", data: [0, 1, 2] },
        { type: "heartrate", data: [100, 110, 120] },
      ],
    });

    await loadIntervalsStreams("key", "i1", ["heartrate"]);

    expect(mockedGet).toHaveBeenCalledWith(
      "/activity/i1/streams.json?types=time,heartrate",
      expect.anything(),
    );
  });

  it("does not duplicate time when the caller already requested it", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ type: "time", data: [0, 1, 2] }],
    });

    await loadIntervalsStreams("key", "i1", ["time"]);

    expect(mockedGet).toHaveBeenCalledWith(
      "/activity/i1/streams.json?types=time",
      expect.anything(),
    );
  });

  describe("derived moving", () => {
    it("marks the sample after a recording gap as not moving", async () => {
      // Gap from t=10 to t=70: a 60 s auto-pause, well past the 5 s
      // threshold, so the resume sample (index 2) is stopped.
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [9, 10, 70, 71] }],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, false, true]);
    });

    it("does not flag a normal 1 s cadence gap", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [0, 1, 2, 3] }],
      });

      const streams = await loadIntervalsStreams("key", "i1", ["time"]);

      expect(streams.moving).toEqual([true, true, true, true]);
    });

    it("marks a low-velocity stop as not moving even without a time gap", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1, 2, 3] },
          {
            type: "velocity_smooth",
            data: [3, 3, 0.2, 3],
          },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving).toEqual([true, true, false, true]);
    });

    it("treats moving[0] as true when velocity at 0 is unknown or at/above threshold", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1] },
          { type: "velocity_smooth", data: [MOVING_MIN_VELOCITY_MPS, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving[0]).toBe(true);
    });

    it("treats moving[0] as false when velocity at 0 is below threshold", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1] },
          { type: "velocity_smooth", data: [0.1, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving[0]).toBe(false);
    });

    it("does not flag a null velocity sample as stopped by itself", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, 1, 2] },
          { type: "velocity_smooth", data: [3, null, 3] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "velocity_smooth",
      ]);

      expect(streams.moving).toEqual([true, true, true]);
    });

    it("respects the exported threshold constants", () => {
      expect(MOVING_GAP_THRESHOLD_SECONDS).toBe(5);
      expect(MOVING_MIN_VELOCITY_MPS).toBe(0.5);
    });
  });

  describe("null time samples", () => {
    it("drops indices where time is null and keeps other arrays aligned", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [
          { type: "time", data: [0, null, 2, 3] },
          { type: "heartrate", data: [100, 105, 110, 115] },
        ],
      });

      const streams = await loadIntervalsStreams("key", "i1", [
        "time",
        "heartrate",
      ]);

      expect(streams.time).toEqual([0, 2, 3]);
      expect(streams.heartrate).toEqual([100, 110, 115]);
      expect(streams.length).toBe(3);
    });

    it("throws IntervalsStreamsUnavailableError when every time sample is null", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "time", data: [null, null] }],
      });

      await expect(
        loadIntervalsStreams("key", "i1", ["time"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });
  });

  describe("unavailable streams", () => {
    it("throws IntervalsStreamsUnavailableError on a 404", async () => {
      mockedGet.mockRejectedValueOnce(notFound());

      const error = await loadIntervalsStreams("key", "i189807578", [
        "time",
      ]).catch((e) => e);

      expect(error).toBeInstanceOf(IntervalsStreamsUnavailableError);
      expect((error as IntervalsStreamsUnavailableError).activityId).toBe(
        "i189807578",
      );
    });

    it("throws IntervalsStreamsUnavailableError on an empty response", async () => {
      mockedGet.mockResolvedValueOnce({ data: [] });

      await expect(
        loadIntervalsStreams("key", "i1", ["time"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });

    it("throws IntervalsStreamsUnavailableError when the response has no time stream", async () => {
      mockedGet.mockResolvedValueOnce({
        data: [{ type: "heartrate", data: [100, 110] }],
      });

      await expect(
        loadIntervalsStreams("key", "i1", ["heartrate"]),
      ).rejects.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });
  });

  describe("other failures propagate", () => {
    it("propagates a rate-limit failure intact", async () => {
      mockedGet.mockRejectedValueOnce(rateLimited());

      const error = await loadIntervalsStreams("key", "i1", ["time"]).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(RateLimitError);
      expect(error).not.toBeInstanceOf(IntervalsStreamsUnavailableError);
    });

    it("propagates a server error rather than reporting unavailable streams", async () => {
      mockedGet.mockRejectedValueOnce(serverError());

      const error = await loadIntervalsStreams("key", "i1", ["time"]).catch(
        (e) => e,
      );

      expect(error).not.toBeInstanceOf(IntervalsStreamsUnavailableError);
      expect((error as Error).message).toContain("500");
    });
  });

  it("calls getActivityStreams once", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ type: "time", data: [0, 1] }],
    });

    await loadIntervalsStreams("key", "i1", ["time"]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("produces the hilly fixture's shape too (no nulls in that fixture)", async () => {
    mockedGet.mockResolvedValueOnce({ data: streamsHillyFixture });

    const streams = await loadIntervalsStreams("key", "i2", [
      "time",
      "grade_smooth",
      "watts",
    ]);

    expect(streams.grade_smooth).toHaveLength(600);
    expect(streams.watts).toHaveLength(600);
  });
});
