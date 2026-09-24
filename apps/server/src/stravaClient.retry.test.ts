import { beforeEach, describe, expect, it, vi } from "vitest";
import { basicRunActivity } from "./__fixtures__";
import { HttpError, RateLimitError, stravaApi } from "./fetchClient";
import {
  getActivityById,
  getActivityLaps,
  getAllActivities,
  StravaApiError,
} from "./stravaClient";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    stravaApi: { get: vi.fn(), put: vi.fn() },
  };
});

const mockedGet = vi.mocked(stravaApi.get);

const unauthorized = () =>
  new HttpError("Strava API Error (401): Authorization Error", {
    status: 401,
    statusText: "Unauthorized",
    data: '{"message":"Authorization Error"}',
  });

/**
 * What a client call throws once `handleApiError` has interpreted it. All
 * shapes were being flattened to a plain `Error`, which quietly killed the
 * callers that branch on them, e.g. the scan tools' rate-limit abort.
 */
describe("handled error shapes", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("names INTERVALS_API_KEY on a 401", async () => {
    mockedGet.mockRejectedValue(unauthorized());

    const error = await getActivityLaps("bad-key", "55").catch((e) => e);

    expect(error).toBeInstanceOf(StravaApiError);
    expect(error.response.status).toBe(401);
    expect(error.message).toBe(
      "getActivityLaps(55): intervals.icu rejected the API key (401). Check INTERVALS_API_KEY.",
    );
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("passes a string activity id above 2^53 through to the request untouched", async () => {
    const bigActivityId = "3503400000123456789";
    mockedGet.mockRejectedValue(unauthorized());

    await expect(getActivityLaps("bad-key", bigActivityId)).rejects.toThrow();

    expect(mockedGet).toHaveBeenCalledWith(
      `/activities/${bigActivityId}/laps`,
      expect.anything(),
    );
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
  });

  it("keeps the status on a 404 so a caller can degrade on it", async () => {
    mockedGet.mockRejectedValue(
      new HttpError("HTTP 404", {
        status: 404,
        statusText: "Not Found",
        data: '{"message":"Record Not Found"}',
      }),
    );

    const error = await getActivityLaps("token", "456").catch((e) => e);

    expect(error).toBeInstanceOf(StravaApiError);
    expect(error.response.status).toBe(404);
    expect(error.message).toBe(
      "Strava API Error in getActivityLaps(456) (404): Record Not Found",
    );
  });

  it("pagination stops cleanly on a 401 mid-scan", async () => {
    // A token that goes bad part-way through a long history scan surfaces the
    // 401 immediately — there is no refresh path to fall back to.
    mockedGet
      .mockResolvedValueOnce({ data: [{ ...basicRunActivity, id: 1 }] })
      .mockRejectedValueOnce(unauthorized());

    await expect(getAllActivities("bad-key", { perPage: 1 })).rejects.toThrow(
      /INTERVALS_API_KEY/,
    );

    expect(mockedGet).toHaveBeenCalledTimes(2);
  });
});
