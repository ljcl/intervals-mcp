/**
 * #238: every MCP App is a `view-` tool plus a `get-…-data` tool running the
 * same loader, so an uncached endpoint costs double the upstream requests for
 * one app open. These run the real client against the real cache policy with only
 * `fetch` stubbed, and count round-trips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detailedSegment } from "./__fixtures__";
import { stravaApi } from "./fetchClient";
import {
  getActivityLaps,
  getActivityZones,
  getSegmentById,
  listSegmentEfforts,
} from "./stravaClient";

const realFetch = globalThis.fetch;

/** Stubs `fetch` with a body chosen per request path. */
function stubFetch(bodyForUrl: (url: string) => unknown) {
  const fn = vi.fn(
    async (input: string) =>
      new Response(JSON.stringify(bodyForUrl(String(input))), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const bodyByPath = (url: string) =>
  url.includes("/segments/") ? detailedSegment : [];

beforeEach(() => {
  // The client is a module-level singleton with a shared cache.
  stravaApi.clearResponseCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  stravaApi.clearResponseCache();
});

describe("view/data tool pairs share one upstream fetch", () => {
  it("costs 2 requests, not 4, to load segment-progress twice", async () => {
    const fetchMock = stubFetch(bodyByPath);

    // What loadSegmentProgressData does, once for `view-` and once for `get-`.
    for (let i = 0; i < 2; i++) {
      await getSegmentById("token", "55");
      await listSegmentEfforts("token", "55", { perPage: 200 });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses the pair's concurrent segment reads onto one upstream fetch (#355)", async () => {
    const fetchMock = stubFetch(bodyByPath);

    // An MCP App fires its `view-` and `get-…-data` calls together on open, so
    // the second read arrives before the first has populated the cache.
    const [a, b] = await Promise.all([
      getSegmentById("token", "55"),
      getSegmentById("token", "55"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("keeps differently-parameterised effort queries distinct", async () => {
    const fetchMock = stubFetch(bodyByPath);

    await listSegmentEfforts("token", "55", { perPage: 200 });
    await listSegmentEfforts("token", "55", {
      perPage: 200,
      startDateLocal: "2026-01-01T00:00:00Z",
    });

    // The cache key is the full URL, so a date-windowed query is its own entry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves an activity's zones and laps from cache on the second load", async () => {
    const fetchMock = stubFetch(bodyByPath);

    await getActivityZones("token", "123");
    await getActivityLaps("token", "123");
    await getActivityZones("token", "123");
    await getActivityLaps("token", "123");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
