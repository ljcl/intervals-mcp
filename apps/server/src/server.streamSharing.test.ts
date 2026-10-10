/**
 * One streams read per activity across tools and apps (#71), counted at the
 * wire. The real FetchClient runs with its cache and in-flight map, so these
 * tests pin what a chat really costs intervals.icu: every stream read asks
 * for the one superset URL (`loadIntervalsStreams`), and compare reads each
 * activity with the same `?intervals=true` URL as the app's streams calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFitFile } from "./__fixtures__/fitFile";
import activityHilly from "./__fixtures__/intervals/activity-hilly.json";
import activityMultilap from "./__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "./__fixtures__/intervals/activity-multilap-intervals.json";
import sportSettingsRun from "./__fixtures__/intervals/sport-settings-run.json";
import streamsHilly from "./__fixtures__/intervals/streams-hilly.json";
import streamsMultilap from "./__fixtures__/intervals/streams-multilap.json";
import { intervalsApi } from "./fetchClient";

// A real FetchClient with the production cache policy, no pacing and an
// instant sleep, so the counts below are the requests production would send.
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

const MULTILAP_ID = "i189757183";
const HILLY_ID = "i189757207";

/** What the fake intervals.icu serves for each activity id. */
const ACTIVITIES: Record<
  string,
  {
    activity: { name?: string | null };
    intervals: { icu_intervals: unknown[]; icu_groups: unknown[] };
    streams: unknown;
  }
> = {
  [MULTILAP_ID]: {
    activity: activityMultilap,
    intervals: multilapIntervals,
    streams: streamsMultilap,
  },
  [HILLY_ID]: {
    activity: activityHilly,
    intervals: { icu_intervals: [], icu_groups: [] },
    streams: streamsHilly,
  },
};

interface WireRequest {
  method: string;
  url: URL;
}

/** Every request that reached the fake fetch, in order. */
let wire: WireRequest[] = [];
/** Requests the router does not know; each test expects none. */
let unrouted: string[] = [];
/** Names written by update-activity, served by later reads. */
let renamed = new Map<string, string>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function activityBody(id: string, withIntervals: boolean): unknown {
  const entry = ACTIVITIES[id]!;
  const name = renamed.get(id) ?? entry.activity.name;
  return withIntervals
    ? {
        ...entry.activity,
        name,
        icu_intervals: entry.intervals.icu_intervals,
        icu_groups: entry.intervals.icu_groups,
      }
    : { ...entry.activity, name };
}

async function router(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  wire.push({ method, url });
  const path = url.pathname.replace(/^\/api\/v1/, "");

  const detail = /^\/activity\/(i\d+)$/.exec(path);
  if (detail && detail[1]! in ACTIVITIES) {
    const id = detail[1]!;
    if (method === "PUT") {
      const patch = JSON.parse(String(init?.body)) as { name?: string };
      if (patch.name !== undefined) renamed.set(id, patch.name);
      return json(activityBody(id, false));
    }
    return json(activityBody(id, url.searchParams.get("intervals") === "true"));
  }

  const streams = /^\/activity\/(i\d+)\/streams\.json$/.exec(path);
  if (streams && streams[1]! in ACTIVITIES) {
    return json(ACTIVITIES[streams[1]!]!.streams);
  }

  // The original file, read for its weather: a FIT file with no humidity.
  const file = /^\/activity\/(i\d+)\/file$/.exec(path);
  if (file && file[1]! in ACTIVITIES) {
    return new Response(new Blob([buildFitFile([]) as BlobPart]), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  if (/^\/athlete\/[^/]+\/sport-settings\/Run$/.test(path)) {
    return json(sportSettingsRun);
  }

  unrouted.push(`${method} ${url.pathname}${url.search}`);
  return json({ status: 404, error: "Not Found" }, 404);
}

const streamReads = () =>
  wire.filter(({ url }) => url.pathname.includes("/streams.json"));

/** GETs of `/activity/{id}` itself, not its sub-resources. */
const detailReads = (id: string) =>
  wire.filter(
    ({ method, url }) =>
      method === "GET" && url.pathname === `/api/v1/activity/${id}`,
  );

/**
 * Every tool and app that reads one activity's streams: the chart view and
 * its data tool, the four analysis tools (aerobic on its default basis, then
 * on pace), the route map and get-activity-streams.
 */
const ONE_ACTIVITY_CALLS: Array<[string, Record<string, unknown>]> = [
  ["get-activity-streams-raw", { id: MULTILAP_ID }],
  ["view-activity-chart", { id: MULTILAP_ID }],
  ["get-hill-analysis", { id: MULTILAP_ID }],
  ["get-split-analysis", { id: MULTILAP_ID }],
  ["get-interval-analysis", { id: MULTILAP_ID }],
  ["get-aerobic-analysis", { id: MULTILAP_ID }],
  ["get-aerobic-analysis", { id: MULTILAP_ID, basis: "pace" }],
  ["get-route-map-data", { id: MULTILAP_ID }],
  ["get-activity-streams", { id: MULTILAP_ID }],
];

async function dispatchInSequence(
  calls: Array<[string, Record<string, unknown>]>,
): Promise<void> {
  for (const [name, args] of calls) {
    const result = await dispatchToolCall(name, args);
    expect(result.isError, `${name} ${JSON.stringify(args)}`).toBeUndefined();
  }
}

beforeEach(() => {
  wire = [];
  unrouted = [];
  renamed = new Map();
  vi.stubEnv("INTERVALS_ATHLETE_ID", "0");
  vi.stubGlobal("fetch", vi.fn(router));
  vi.spyOn(console, "error").mockImplementation(() => {});
  intervalsApi.clearResponseCache();
});

afterEach(() => {
  expect(unrouted).toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("one streams read per activity (#71)", () => {
  it("serves every stream tool and app from one request, called in sequence", async () => {
    await dispatchInSequence(ONE_ACTIVITY_CALLS);

    expect(streamReads()).toHaveLength(1);
  });

  it("serves every stream tool and app from one request, called together", async () => {
    const results = await Promise.all(
      ONE_ACTIVITY_CALLS.map(([name, args]) => dispatchToolCall(name, args)),
    );

    for (const [index, result] of results.entries()) {
      expect(result.isError, ONE_ACTIVITY_CALLS[index]![0]).toBeUndefined();
    }
    expect(streamReads()).toHaveLength(1);
  });

  it("reads the streams again, once, after update-activity writes the activity", async () => {
    await dispatchInSequence(ONE_ACTIVITY_CALLS);
    expect(streamReads()).toHaveLength(1);

    await dispatchInSequence([
      ["update-activity", { id: MULTILAP_ID, name: "Renamed run" }],
    ]);
    expect(
      wire
        .filter(({ method }) => method === "PUT")
        .map(({ url }) => url.pathname),
    ).toEqual([`/api/v1/activity/${MULTILAP_ID}`]);

    await dispatchInSequence([["get-hill-analysis", { id: MULTILAP_ID }]]);

    expect(streamReads()).toHaveLength(2);
  });
});

describe("opening compare-activities (#71)", () => {
  it("reads each activity and its streams once", async () => {
    const compareArgs = { activityId1: MULTILAP_ID, activityId2: HILLY_ID };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["view-compare-activities", compareArgs],
      ["get-activity-streams-raw", { id: MULTILAP_ID }],
      ["get-activity-streams-raw", { id: HILLY_ID }],
      ["get-compare-activities-data", compareArgs],
    ];

    const results = await Promise.all(
      calls.map(([name, args]) => dispatchToolCall(name, args)),
    );

    for (const [index, result] of results.entries()) {
      expect(result.isError, calls[index]![0]).toBeUndefined();
    }
    for (const id of [MULTILAP_ID, HILLY_ID]) {
      const reads = detailReads(id);
      expect(reads, id).toHaveLength(1);
      expect(reads[0]?.url.searchParams.get("intervals"), id).toBe("true");
      expect(
        streamReads().filter(({ url }) => url.pathname.includes(`/${id}/`)),
        id,
      ).toHaveLength(1);
      // The weather's file read is shared the same way.
      expect(
        wire.filter(
          ({ url }) => url.pathname === `/api/v1/activity/${id}/file`,
        ),
        id,
      ).toHaveLength(1);
    }
  });
});
