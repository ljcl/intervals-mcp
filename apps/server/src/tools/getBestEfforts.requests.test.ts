/**
 * get-best-efforts request counts, over a real client: a real `FetchClient`
 * (real URLs, query params and response cache) in front of a fake `fetch`
 * that records every request. The tool tests mock the client functions, so
 * they cannot see how many requests one call costs; this file can (#82).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import activityFixture from "../__fixtures__/intervals/activity.json";
import paceCurvesFixture from "../__fixtures__/intervals/pace-curves.json";
import paceCurvesSubmaxFixture from "../__fixtures__/intervals/pace-curves-submax.json";
import streamsTimeDistanceFixture from "../__fixtures__/intervals/streams-time-distance.json";
import { intervalsApi } from "../fetchClient";
import { INTERVALS_STREAM_TYPES } from "../intervalsStreams";
import { getBestEffortsTool } from "./getBestEfforts";

/** Same swap as `intervalsClient.test.ts`: a real client with an instant
 * `sleep` and the production cache policy. */
vi.mock("../fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fetchClient")>();
  return {
    ...actual,
    intervalsApi: new actual.FetchClient("https://intervals.icu/api/v1", {
      sleep: async () => {},
      cache: { ttlForPath: actual.intervalsCacheTtl },
    }),
  };
});

const RUN_ID = "i193700503";

/** Answers each request by path and records its URL. */
function routeFetch(routes: Record<string, unknown>): URL[] {
  const urls: URL[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const body = routes[url.pathname];
    if (body === undefined) {
      return new Response(JSON.stringify({ status: 404 }), { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return urls;
}

beforeEach(() => {
  process.env.INTERVALS_ATHLETE_ID = "0";
  intervalsApi.clearResponseCache();
});

describe("get-best-efforts requests", () => {
  it("topN 5 over a window is one request: no per-activity curves, no name lookups", async () => {
    const allTime = {
      ...paceCurvesSubmaxFixture,
      list: paceCurvesSubmaxFixture.list.map((c) => ({ ...c, id: "all" })),
    };
    const urls = routeFetch({ "/api/v1/athlete/0/pace-curves.json": allTime });

    const result = await getBestEffortsTool.execute(
      { window: "all", topN: 5 },
      "k",
    );

    expect(result.isError).toBeUndefined();
    // Before #82 this cost up to 31: the per-activity curves, then one
    // getActivity per winning activity.
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/api/v1/athlete/0/pace-curves.json");
    expect(urls[0]?.searchParams.get("curves")).toBe("all");
    expect(urls[0]?.searchParams.get("subMaxEfforts")).toBe("4");
    const fiveK = (
      result.structuredContent as {
        best_efforts: Record<string, Array<{ activity_name: string }>>;
      }
    ).best_efforts["5km"];
    expect(fiveK).toHaveLength(5);
    expect(fiveK?.every((e) => e.activity_name.startsWith("Run "))).toBe(true);
  });

  it("topN 1 over a window is the plain curve read", async () => {
    const urls = routeFetch({
      "/api/v1/athlete/0/pace-curves.json": paceCurvesFixture,
    });

    await getBestEffortsTool.execute({ topN: 1 }, "k");

    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get("curves")).toBe("1y");
    expect(urls[0]?.searchParams.has("subMaxEfforts")).toBe(false);
  });

  it("one run is two requests: the activity and its streams", async () => {
    const urls = routeFetch({
      [`/api/v1/activity/${RUN_ID}`]: { ...activityFixture, id: RUN_ID },
      [`/api/v1/activity/${RUN_ID}/streams.json`]: streamsTimeDistanceFixture,
    });

    const result = await getBestEffortsTool.execute(
      { id: RUN_ID, topN: 3 },
      "k",
    );

    expect(result.isError).toBeUndefined();
    expect(urls.map((u) => u.pathname)).toEqual([
      `/api/v1/activity/${RUN_ID}`,
      `/api/v1/activity/${RUN_ID}/streams.json`,
    ]);
    // Every stream read asks for the one superset (#71), so this read and
    // any other stream tool on the run share one cache entry.
    expect(urls[1]?.searchParams.get("types")).toBe(
      INTERVALS_STREAM_TYPES.join(","),
    );
  });
});
