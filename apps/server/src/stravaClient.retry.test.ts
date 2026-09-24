import { beforeEach, describe, expect, it, vi } from "vitest";
import { basicRunActivity } from "./__fixtures__";
import { HttpError, RateLimitError, stravaApi } from "./fetchClient";
import {
  exportRouteGpx,
  getActivityById,
  getActivityLaps,
  getActivityStreams,
  getAllActivities,
  listSegmentEfforts,
  StravaApiError,
} from "./stravaClient";
import { refreshAccessToken } from "./tokenManager";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    stravaApi: { get: vi.fn(), put: vi.fn() },
  };
});

vi.mock("./tokenManager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tokenManager")>();
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
  };
});

const mockedGet = vi.mocked(stravaApi.get);
const mockedRefresh = vi.mocked(refreshAccessToken);

const unauthorized = () =>
  new HttpError("Strava API Error (401): Authorization Error", {
    status: 401,
    statusText: "Unauthorized",
    data: '{"message":"Authorization Error"}',
  });

describe("401 refresh-retry", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedRefresh.mockReset();
    mockedRefresh.mockImplementation(async () => {
      return {
        access_token: "refreshed-token",
        refresh_token: "refreshed-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    });
  });

  it("retries listSegmentEfforts once with all original filters preserved", async () => {
    mockedGet
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ data: [] });

    const result = await listSegmentEfforts("stale-token", "55", {
      startDateLocal: "2026-01-01T00:00:00Z",
      endDateLocal: "2026-02-01T00:00:00Z",
      perPage: 50,
    });

    expect(result).toEqual([]);
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(2);
    // Regression (#112): the retry used to drop filter params.
    expect(mockedGet).toHaveBeenLastCalledWith("/segment_efforts", {
      headers: { Authorization: "Bearer refreshed-token" },
      params: {
        segment_id: "55",
        start_date_local: "2026-01-01T00:00:00Z",
        end_date_local: "2026-02-01T00:00:00Z",
        per_page: 50,
      },
    });
  });

  it("fails after one refresh attempt when the 401 persists", async () => {
    // A scope-stripped token refreshes successfully but keeps returning 401;
    // this must terminate instead of looping refresh+request forever.
    mockedGet.mockRejectedValue(unauthorized());

    await expect(listSegmentEfforts("stale-token", "55")).rejects.toThrow(
      /401/,
    );

    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("refreshes and retries a stream fetch, which used to swallow the 401", async () => {
    // #237: the seven local stream fetchers called stravaApi.get behind a bare
    // `catch {}`, so an expired token never reached the refresh path at all.
    mockedGet.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({
      data: [{ type: "time", data: [0, 1, 2] }],
    });

    const streams = await getActivityStreams("stale-token", "123", ["time"]);

    expect(streams.get("time")).toEqual([0, 1, 2]);
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenLastCalledWith("/activities/123/streams/time", {
      headers: { Authorization: "Bearer refreshed-token" },
    });
  });

  it("passes a string activity id above 2^53 through to the request untouched", async () => {
    const bigActivityId = "3503400000123456789";
    mockedGet.mockRejectedValue(unauthorized());

    await expect(
      getActivityLaps("stale-token", bigActivityId),
    ).rejects.toThrow();

    expect(mockedGet).toHaveBeenCalledWith(
      `/activities/${bigActivityId}/laps`,
      expect.anything(),
    );
  });
});

/**
 * What a client call throws once `handleApiError` has interpreted it. Both
 * shapes were being flattened to a plain `Error`, which quietly killed the two
 * places that branch on them: the scan tools' rate-limit abort and
 * `loadRouteProfile`'s 404 fallback.
 */
describe("handled error shapes", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedRefresh.mockReset();
    mockedRefresh.mockResolvedValue({
      access_token: "refreshed-token",
      refresh_token: "refreshed-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  const rateLimited = () =>
    new RateLimitError(
      "15-minute rate limit reached (100/100 requests).",
      { status: 429, statusText: "Too Many Requests", data: "" },
      { observedAt: Date.now(), shortTerm: { limit: 100, usage: 100 } },
      60,
    );

  it("keeps a 429 typed so a scan can stop on it", async () => {
    mockedGet.mockRejectedValue(rateLimited());

    const error = await getActivityById("token", "123").catch((e) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.message).toBe(
      "Strava rate limit exceeded in getActivityById for ID 123. 15-minute rate limit reached (100/100 requests).",
    );
    // The window description survives without the context in front of it, so a
    // tool can quote it in its own sentence.
    expect(error.detail).toBe(
      "15-minute rate limit reached (100/100 requests).",
    );
    expect(error.rateLimit.shortTerm).toEqual({ limit: 100, usage: 100 });
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  it("keeps the status on a 404 so a caller can degrade on it", async () => {
    mockedGet.mockRejectedValue(
      new HttpError("HTTP 404", {
        status: 404,
        statusText: "Not Found",
        data: '{"message":"Record Not Found"}',
      }),
    );

    const error = await exportRouteGpx("token", "456").catch((e) => e);

    expect(error).toBeInstanceOf(StravaApiError);
    expect(error.response.status).toBe(404);
    expect(error.message).toBe(
      "Strava API Error in exporting route 456 as GPX (404): Record Not Found",
    );
  });

  it("refreshes on a 401 that lands after the first page of a scan", async () => {
    // The guard used to be `currentPage === 1`, so a token expiring part-way
    // through a long history scan surfaced the raw 401 with no refresh and no
    // mention of /auth/start. Retrying restarts pagination from page 1.
    mockedGet
      .mockResolvedValueOnce({ data: [{ ...basicRunActivity, id: 1 }] })
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ data: [{ ...basicRunActivity, id: 1 }] })
      .mockResolvedValueOnce({ data: [] });

    const activities = await getAllActivities("stale-token", { perPage: 1 });

    expect(activities).toHaveLength(1);
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(4);
    expect(mockedGet).toHaveBeenLastCalledWith("/athlete/activities", {
      headers: { Authorization: "Bearer refreshed-token" },
      params: { page: 2, per_page: 1 },
    });
  });
});
