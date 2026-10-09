/**
 * The startup lookup of the athlete's time zone (#56): when it runs, how long
 * startup waits for it, and which failures earn a re-run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  handledSubscriptionRequired,
} from "./__fixtures__/errors";
import {
  initAthleteTimeZone,
  resetAthleteTimeZone,
  TIME_ZONE_STARTUP_WAIT_MS,
} from "./athleteTimeZone";
import { apiKeyConfigured, timeZoneSetting } from "./config";
import { HttpError, RequestTimeoutError } from "./fetchClient";
import { getAthleteTimeZone } from "./intervalsClient";

vi.mock("./intervalsClient", () => ({ getAthleteTimeZone: vi.fn() }));

// The key comes from the mock, never from process.env.
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  apiKeyConfigured: vi.fn(() => true),
  getIntervalsApiKey: vi.fn(() => "k-secret"),
}));

const ORIGINAL_TZ = process.env.TZ;
const MINUTE_MS = 60_000;
const TWO_HOURS_MS = 2 * 60 * MINUTE_MS;

const mockedRead = vi.mocked(getAthleteTimeZone);
const log = vi.fn<(message: string) => void>();

function logged(): string {
  return log.mock.calls.map(([message]) => message).join("\n");
}

function warnings(): string[] {
  return log.mock.calls
    .map(([message]) => message)
    .filter((message) => message.startsWith("WARNING:"));
}

function serviceUnavailable(): HttpError {
  return new HttpError("HTTP 503: Service Unavailable", {
    status: 503,
    statusText: "Service Unavailable",
    data: "",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.TZ;
  resetAthleteTimeZone();
  mockedRead.mockReset();
  vi.mocked(apiKeyConfigured).mockReturnValue(true);
  log.mockReset();
});

afterEach(() => {
  const messages = logged();
  resetAthleteTimeZone();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  vi.useRealTimers();
  // Every case's messages, success or failure, must keep the key out. The
  // check runs last, so a failure here cannot skip the cleanup.
  expect(messages).not.toContain("k-secret");
});

describe("initAthleteTimeZone", () => {
  it("skips the lookup when TZ names a zone", async () => {
    process.env.TZ = "Australia/Brisbane";
    await initAthleteTimeZone({ log });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(timeZoneSetting().source).toBe("env");
  });

  it("applies the athlete's zone when TZ is unset", async () => {
    mockedRead.mockResolvedValue("Australia/Sydney");
    await initAthleteTimeZone({ log });
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Sydney",
      source: "intervals.icu",
    });
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith("k-secret");
    expect(logged()).toContain("from intervals.icu");
  });

  it("looks the zone up for TZ=UTC, compose's default", async () => {
    process.env.TZ = "UTC";
    mockedRead.mockResolvedValue("Australia/Sydney");
    await initAthleteTimeZone({ log });
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(timeZoneSetting().zone).toBe("Australia/Sydney");
  });

  it("skips the lookup for TZ=Etc/UTC, which pins UTC", async () => {
    process.env.TZ = "Etc/UTC";
    await initAthleteTimeZone({ log });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(timeZoneSetting()).toEqual({ zone: "Etc/UTC", source: "env" });
  });

  it("skips the lookup without an API key", async () => {
    vi.mocked(apiKeyConfigured).mockReturnValue(false);
    await initAthleteTimeZone({ log });
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("keeps the fallback, with one WARNING, when the athlete has no zone", async () => {
    mockedRead.mockResolvedValue(null);
    await initAthleteTimeZone({ log });
    await vi.advanceTimersByTimeAsync(TWO_HOURS_MS);
    expect(timeZoneSetting().source).toBe("fallback");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("set TZ");
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback, quoting the zone, for one Intl does not know", async () => {
    mockedRead.mockResolvedValue("Mars/Olympus");
    await initAthleteTimeZone({ log });
    await vi.advanceTimersByTimeAsync(TWO_HOURS_MS);
    expect(timeZoneSetting().source).toBe("fallback");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('"Mars/Olympus"');
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["404", handledNotFound("getAthleteTimeZone")],
    ["402", handledSubscriptionRequired("getAthleteTimeZone")],
  ])(
    "stops after a definite %s refusal, with one WARNING",
    async (_, error) => {
      mockedRead.mockRejectedValue(error);
      await initAthleteTimeZone({ log });
      await vi.advanceTimersByTimeAsync(TWO_HOURS_MS);
      expect(timeZoneSetting().source).toBe("fallback");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("refused");
      expect(warnings()[0]).toContain("INTERVALS_API_KEY");
      expect(warnings()[0]).toContain("INTERVALS_ATHLETE_ID");
      expect(mockedRead).toHaveBeenCalledTimes(1);
    },
  );

  it("runs again a minute after a rate limit, then stops once it has the zone", async () => {
    mockedRead
      .mockRejectedValueOnce(handledRateLimit("getAthleteTimeZone"))
      .mockResolvedValueOnce("Australia/Sydney");
    await initAthleteTimeZone({ log });
    expect(timeZoneSetting().source).toBe("fallback");
    expect(warnings()[0]).toContain("trying again in 1 min");

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(mockedRead).toHaveBeenCalledTimes(2);
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Sydney",
      source: "intervals.icu",
    });

    await vi.advanceTimersByTimeAsync(TWO_HOURS_MS);
    expect(mockedRead).toHaveBeenCalledTimes(2);
  });

  it("backs off 1, 5 and 15 minutes after a 5xx, then runs hourly", async () => {
    mockedRead.mockRejectedValue(serviceUnavailable());
    await initAthleteTimeZone({ log });
    expect(mockedRead).toHaveBeenCalledTimes(1);

    const counts: number[] = [];
    for (const minutes of [1, 5, 15, 60, 60]) {
      await vi.advanceTimersByTimeAsync(minutes * MINUTE_MS);
      counts.push(mockedRead.mock.calls.length);
    }
    expect(counts).toEqual([2, 3, 4, 5, 6]);
    expect(timeZoneSetting().source).toBe("fallback");
  });

  it("runs again a minute after a timeout", async () => {
    mockedRead
      .mockRejectedValueOnce(
        new RequestTimeoutError(
          "https://intervals.icu/api/v1/athlete/0",
          20000,
        ),
      )
      .mockResolvedValueOnce("Australia/Sydney");
    await initAthleteTimeZone({ log });
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(mockedRead).toHaveBeenCalledTimes(2);
    expect(timeZoneSetting().zone).toBe("Australia/Sydney");
  });

  // Cloudflare stopped the request before intervals.icu saw the key, so the
  // 403 says nothing about the key and is worth another try.
  it("runs again a minute after a Cloudflare challenge", async () => {
    mockedRead
      .mockRejectedValueOnce(
        new HttpError("HTTP 403: Just a moment...", {
          status: 403,
          statusText: "Forbidden",
          data: "",
          cloudflareChallenge: true,
        }),
      )
      .mockResolvedValueOnce("Australia/Sydney");
    await initAthleteTimeZone({ log });
    expect(logged()).not.toContain("refused");
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(mockedRead).toHaveBeenCalledTimes(2);
    expect(timeZoneSetting().zone).toBe("Australia/Sydney");
  });

  // No waitMs, as in index.ts, so this pins the default wait.
  it("stops waiting after the default wait and applies a late answer", async () => {
    let answer: (zone: string | null) => void = () => {};
    mockedRead.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    let returned = false;
    const init = initAthleteTimeZone({ log }).then(() => {
      returned = true;
    });

    expect(TIME_ZONE_STARTUP_WAIT_MS).toBe(5_000);
    await vi.advanceTimersByTimeAsync(TIME_ZONE_STARTUP_WAIT_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await init;
    expect(logged()).toContain(
      "has not answered the time zone lookup after 5 s",
    );
    expect(timeZoneSetting().source).toBe("fallback");

    answer("Australia/Sydney");
    await vi.advanceTimersByTimeAsync(0);
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Sydney",
      source: "intervals.icu",
    });
  });

  it("logs to stderr by default", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedRead.mockResolvedValue("Australia/Sydney");
    await initAthleteTimeZone();
    expect(stderr).toHaveBeenCalledWith(
      "Time zone Australia/Sydney, from intervals.icu.",
    );
    stderr.mockRestore();
  });

  it("reads the zone only once however often it is called", async () => {
    mockedRead.mockResolvedValue("Australia/Sydney");
    await initAthleteTimeZone({ log });
    await initAthleteTimeZone({ log });
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });
});
