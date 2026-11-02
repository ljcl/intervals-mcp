/**
 * Activity-list requests per aggregate call, counted at the wire (#321). The
 * real FetchClient runs with its production cache policy, so these counts are
 * what each call costs intervals.icu: a year or more in one listing request,
 * a second only for a run-only runway longer than 366 days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activities from "./__fixtures__/intervals/activities.json";
import { intervalsApi } from "./fetchClient";

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

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-key") };
});

const { dispatchToolCall } = await import("./server");

/** Every request that reached the fake fetch, in order. */
let wire: URL[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function router(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  wire.push(url);
  return json(url.pathname.endsWith("/activities") ? activities : []);
}

const listingReads = () =>
  wire.filter(({ pathname }) => pathname === "/api/v1/athlete/0/activities");

beforeEach(() => {
  wire = [];
  vi.stubEnv("INTERVALS_ATHLETE_ID", "0");
  vi.stubGlobal("fetch", vi.fn(router));
  vi.spyOn(console, "error").mockImplementation(() => {});
  intervalsApi.clearResponseCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("activity-list requests per aggregate call (#321)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["get-athlete-stats", {}],
    ["list-activities", { days: 366 }],
    ["get-training-load", { days: 365 }],
    ["get-training-load", { days: 365, runOnly: true }],
    ["get-fitness-trend", { runOnly: true }],
    ["get-fitness-trend", { days: 365 }],
    ["get-fitness-trend", { days: 365, runOnly: true }],
  ])("%s %j makes at most 2", async (name, args) => {
    const result = await dispatchToolCall(name, args);

    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(listingReads().length).toBeGreaterThan(0);
    expect(listingReads().length).toBeLessThanOrEqual(2);
  });
});
