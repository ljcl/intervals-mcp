import { beforeEach, describe, expect, it, vi } from "vitest";
import activities from "./__fixtures__/intervals/activities.json";
import activity from "./__fixtures__/intervals/activity.json";
import intervals from "./__fixtures__/intervals/activity-intervals.json";
import gearFixture from "./__fixtures__/intervals/gear.json";
import sportSettings from "./__fixtures__/intervals/sport-settings-run.json";
import streams from "./__fixtures__/intervals/streams.json";
import wellness from "./__fixtures__/intervals/wellness.json";
import { intervalsApi, RateLimitError } from "./fetchClient";
import {
  getActivity,
  getActivityIntervals,
  getActivityStreams,
  getSportSettings,
  getWellness,
  IntervalsApiError,
  listActivities,
  listGear,
} from "./intervalsClient";

/**
 * A real `FetchClient` (so URL/header building and query-param handling
 * match production exactly), but with an instant `sleep` and no
 * `minIntervalMs` spacing, so a 429's retry backoff and the production
 * 200ms request spacing never actually wait — tests stay fast without
 * bypassing the request-building code they assert on. This mirrors how
 * `stravaClient.errors.test.ts` avoids backoff (mocking `./fetchClient` to
 * swap out the client instance the module under test imports), adapted
 * because these tests assert against real request/URL construction via a
 * mocked `globalThis.fetch` rather than mocking `.get()` directly.
 */
vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    intervalsApi: new actual.FetchClient("https://intervals.icu/api/v1", {
      sleep: async () => {},
      cache: { ttlForPath: actual.intervalsCacheTtl },
    }),
  };
});

function mockJson(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  ) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.INTERVALS_ATHLETE_ID = "0";
  // The response cache must not leak a success from one test into the next.
  intervalsApi.clearResponseCache();
});

describe("intervalsClient", () => {
  it("sends Basic auth and a descriptive User-Agent to intervals.icu", async () => {
    const calls = mockJson(activity);
    await getActivity("k", "i189807578");
    const call = calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    expect(new URL(call.url).host).toBe("intervals.icu");
    expect(call.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("API_KEY:k").toString("base64")}`,
    );
    expect(call.headers.get("user-agent")).toMatch(
      /^intervals-mcp\/\S+ \(\+https:\/\/github.com\/ljcl\/intervals-mcp\)$/,
    );
  });

  it("parses every fixture", async () => {
    mockJson(activities);
    expect(
      (
        await listActivities("k", {
          oldest: "2026-09-01",
          newest: "2026-09-24",
        })
      ).length,
    ).toBe(activities.length);
    mockJson(activity);
    expect((await getActivity("k", "i189807578", { intervals: true })).id).toBe(
      activity.id,
    );
    mockJson(intervals);
    expect(
      (await getActivityIntervals("k", "i189807578")).icu_intervals.length,
    ).toBeGreaterThan(0);
    mockJson(streams);
    expect((await getActivityStreams("k", "i189807578", ["time"])).length).toBe(
      streams.length,
    );
    mockJson(wellness);
    expect(
      (await getWellness("k", { oldest: "2026-09-10", newest: "2026-09-24" }))
        .length,
    ).toBe(wellness.length);
    mockJson(sportSettings);
    expect((await getSportSettings("k", "Run")).lthr).toBe(sportSettings.lthr);
    mockJson([]);
    expect(await listGear("k")).toEqual([]);
  });

  it("parses the real gear fixture", async () => {
    mockJson(gearFixture);
    const gear = await listGear("k");
    expect(gear.length).toBe(gearFixture.length);
    expect(gear[0]?.id).toBe(gearFixture[0]?.id);
    expect(gear[0]?.name).toBe(gearFixture[0]?.name);
    expect(gear[0]?.distance).toBe(gearFixture[0]?.distance);
  });

  it("splits ranges longer than 31 days into sequential windows", async () => {
    const calls = mockJson([]);
    await listActivities("k", { oldest: "2026-01-01", newest: "2026-03-11" });
    const windows = calls.map((c) => {
      const u = new URL(c.url);
      return [u.searchParams.get("oldest"), u.searchParams.get("newest")];
    });
    expect(windows).toEqual([
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-03-03"],
      ["2026-03-04", "2026-03-11"],
    ]);
  });

  it("does not split a range of 31 days or fewer", async () => {
    const calls = mockJson([]);
    await listActivities("k", { oldest: "2026-09-01", newest: "2026-09-24" });
    expect(calls).toHaveLength(1);
  });

  it("de-duplicates by id and sorts by start_date_local descending", async () => {
    mockJson([
      { ...activity, id: "a", start_date_local: "2026-09-01T00:00:00" },
      { ...activity, id: "b", start_date_local: "2026-09-10T00:00:00" },
      { ...activity, id: "a", start_date_local: "2026-09-01T00:00:00" },
    ]);
    const result = await listActivities("k", {
      oldest: "2026-09-01",
      newest: "2026-09-24",
    });
    expect(result.map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("maps 404 and 401 to IntervalsApiError with the status", async () => {
    mockJson({ status: 404 }, 404);
    await expect(getActivity("k", "i0")).rejects.toMatchObject({
      response: { status: 404 },
    });
    await expect(getActivity("k", "i0")).rejects.toBeInstanceOf(
      IntervalsApiError,
    );
    mockJson({}, 401);
    await expect(getActivity("k", "i0")).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it("surfaces 429 as RateLimitError", async () => {
    mockJson({}, 429);
    await expect(getActivity("k", "i0")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws a plain Error naming the function and the bad field on a schema mismatch", async () => {
    mockJson({ start_date_local: "2026-09-24T16:25:25" }); // missing required `id`
    const error = await getActivity("k", "i0").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IntervalsApiError);
    expect((error as Error).message).toContain("getActivity for ID i0");
    expect((error as Error).message).toContain("id");
  });

  it("refuses an empty key without calling fetch", async () => {
    const calls = mockJson(activity);
    await expect(getActivity("", "i1")).rejects.toThrow(/API key/);
    expect(calls).toHaveLength(0);
  });
});
