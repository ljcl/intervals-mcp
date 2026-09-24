/**
 * getActivityStreams (#237): the single stream-fetch path. Seven near-identical
 * fetchers used to call `stravaApi.get` behind a bare `catch {}`, so every
 * failure — expired token, exhausted quota, Strava outage — was reported to the
 * user as "this activity has no samples". These pin which failures degrade and
 * which propagate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RateLimitError, stravaApi } from "./fetchClient";
import {
  getActivityStreams,
  getRouteStreams,
  StreamsUnavailableError,
} from "./stravaClient";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return { ...actual, stravaApi: { get: vi.fn() } };
});

vi.mock("./tokenManager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tokenManager")>();
  return { ...actual, refreshAccessToken: vi.fn() };
});

const mockedGet = vi.mocked(stravaApi.get);

const notFound = () =>
  new HttpError("HTTP 404: Record Not Found", {
    status: 404,
    statusText: "Not Found",
    data: "Record Not Found",
  });

const rateLimited = () =>
  new RateLimitError(
    "15-minute rate limit reached (100/100 requests).",
    { status: 429, statusText: "Too Many Requests", data: "" },
    { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
    60,
  );

beforeEach(() => {
  mockedGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getActivityStreams", () => {
  it("returns each requested type keyed by name", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { type: "time", data: [0, 1, 2] },
        { type: "heartrate", data: [120, 130, 140] },
      ],
    });

    const streams = await getActivityStreams("token", "123", [
      "time",
      "heartrate",
    ]);

    expect(streams.get("time")).toEqual([0, 1, 2]);
    expect(streams.get("heartrate")).toEqual([120, 130, 140]);
    expect(mockedGet).toHaveBeenCalledWith(
      "/activities/123/streams/time,heartrate",
      { headers: { Authorization: "Bearer token" } },
    );
  });

  it("appends series_type and resolution when asked", async () => {
    mockedGet.mockResolvedValueOnce({ data: [{ type: "time", data: [0] }] });

    await getActivityStreams("token", "123", ["time"], {
      seriesType: "time",
      resolution: "medium",
    });

    expect(mockedGet).toHaveBeenCalledWith(
      "/activities/123/streams/time?series_type=time&resolution=medium",
      expect.anything(),
    );
  });

  it("throws StreamsUnavailableError on a 404", async () => {
    mockedGet.mockRejectedValueOnce(notFound());

    const error = await getActivityStreams("token", "123", ["time"]).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(StreamsUnavailableError);
    expect(error.resourceId).toBe("123");
    expect(error.kind).toBe("activity");
  });

  it("throws StreamsUnavailableError on an empty stream set", async () => {
    mockedGet.mockResolvedValueOnce({ data: [] });

    await expect(
      getActivityStreams("token", "123", ["time"]),
    ).rejects.toBeInstanceOf(StreamsUnavailableError);
  });

  it("propagates a rate-limit failure as an actionable message", async () => {
    mockedGet.mockRejectedValueOnce(rateLimited());

    const error = await getActivityStreams("token", "123", ["time"]).catch(
      (e) => e,
    );

    expect(error).not.toBeInstanceOf(StreamsUnavailableError);
    expect(error.message).toContain("rate limit");
    expect(error.message).toContain("15-minute rate limit reached");
  });

  it("propagates the subscription sentinel on a 402", async () => {
    mockedGet.mockRejectedValueOnce(
      new HttpError("HTTP 402", {
        status: 402,
        statusText: "Payment Required",
        data: "",
      }),
    );

    await expect(getActivityStreams("token", "123", ["time"])).rejects.toThrow(
      /SUBSCRIPTION_REQUIRED/,
    );
  });

  it("propagates a server error rather than reporting no samples", async () => {
    mockedGet.mockRejectedValueOnce(
      new HttpError("HTTP 500", {
        status: 500,
        statusText: "Internal Server Error",
        data: "",
      }),
    );

    const error = await getActivityStreams("token", "123", ["time"]).catch(
      (e) => e,
    );

    expect(error).not.toBeInstanceOf(StreamsUnavailableError);
    expect(error.message).toContain("500");
  });

  it("rejects a response that is not a stream set", async () => {
    mockedGet.mockResolvedValueOnce({ data: { unexpected: true } });

    await expect(getActivityStreams("token", "123", ["time"])).rejects.toThrow(
      /Invalid data format/,
    );
  });
});

/**
 * The route and segment stream reads (#264, #266) share `getActivityStreams`'
 * fetch core, so they inherit the same degrade-on-404-only contract. These pin
 * that the sharing is real rather than three copies that will drift.
 */
describe("getRouteStreams", () => {
  it("requests the route's stored streams", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        { type: "distance", data: [0, 100] },
        { type: "altitude", data: [10, 20] },
      ],
    });

    const streams = await getRouteStreams("token", "456");

    expect(streams.get("altitude")).toEqual([10, 20]);
    expect(mockedGet).toHaveBeenCalledWith("/routes/456/streams", {
      headers: { Authorization: "Bearer token" },
    });
  });

  it("reports an older route with no stored profile as unavailable", async () => {
    mockedGet.mockRejectedValueOnce(notFound());

    const error = await getRouteStreams("token", "456").catch((e) => e);

    expect(error).toBeInstanceOf(StreamsUnavailableError);
    expect(error.kind).toBe("route");
    expect(error.resourceId).toBe("456");
  });

  it("propagates a rate-limit failure rather than claiming no profile", async () => {
    mockedGet.mockRejectedValueOnce(rateLimited());

    const error = await getRouteStreams("token", "456").catch((e) => e);

    expect(error).not.toBeInstanceOf(StreamsUnavailableError);
    expect(error.message).toContain("rate limit");
  });

  it("requires a route id", async () => {
    await expect(getRouteStreams("token", "")).rejects.toThrow(
      /Route ID is required/,
    );
  });
});
