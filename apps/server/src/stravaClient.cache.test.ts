/**
 * #238: every MCP App is a `view-` tool plus a `get-…-data` tool running the
 * same loader, so an uncached endpoint costs double the upstream requests for
 * one app open. These run the real client against the real cache policy with only
 * `fetch` stubbed, and count round-trips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stravaApi } from "./fetchClient";
import { getActivityLaps, getActivityStreams } from "./stravaClient";

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

/** Laps parse fine as an empty array; a streams response must carry at
 * least one entry or the client treats it as StreamsUnavailableError. */
const bodyByPath = (url: string) =>
  url.includes("/streams/") ? [{ type: "time", data: [0, 1, 2] }] : [];

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
  it("serves an activity's streams and laps from cache on the second load", async () => {
    const fetchMock = stubFetch(bodyByPath);

    await getActivityStreams("token", "123", ["time", "heartrate"]);
    await getActivityLaps("token", "123");
    await getActivityStreams("token", "123", ["time", "heartrate"]);
    await getActivityLaps("token", "123");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
