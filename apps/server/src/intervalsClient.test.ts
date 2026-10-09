import { beforeEach, describe, expect, it, vi } from "vitest";
import activities from "./__fixtures__/intervals/activities.json";
import activitiesSimilar from "./__fixtures__/intervals/activities-similar.json";
import activity from "./__fixtures__/intervals/activity.json";
import activityHilly from "./__fixtures__/intervals/activity-hilly.json";
import intervals from "./__fixtures__/intervals/activity-intervals.json";
import activityMultilap from "./__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "./__fixtures__/intervals/activity-multilap-intervals.json";
import activitySwim from "./__fixtures__/intervals/activity-swim.json";
import gearFixture from "./__fixtures__/intervals/gear.json";
import hrCurvesFixture from "./__fixtures__/intervals/hr-curves.json";
import paceCurvesFixture from "./__fixtures__/intervals/pace-curves.json";
import paceCurvesSubmaxFixture from "./__fixtures__/intervals/pace-curves-submax.json";
import sportSettingsListFixture from "./__fixtures__/intervals/sport-settings.json";
import sportSettings from "./__fixtures__/intervals/sport-settings-run.json";
import streams from "./__fixtures__/intervals/streams.json";
import streamsHilly from "./__fixtures__/intervals/streams-hilly.json";
import streamsMultilap from "./__fixtures__/intervals/streams-multilap.json";
import wellness from "./__fixtures__/intervals/wellness.json";
import { intervalsApi, RateLimitError } from "./fetchClient";
import {
  getActivitiesByIds,
  getActivity,
  getActivityIntervals,
  getActivityStreams,
  getAthleteHrCurves,
  getAthletePaceCurves,
  getAthleteTimeZone,
  getSportSettings,
  getWellness,
  IntervalsApiError,
  type IntervalsInterval,
  listActivities,
  listGear,
  listSportSettings,
  searchActivities,
  searchActivitiesByIntervals,
  updateActivity,
} from "./intervalsClient";

/**
 * A real `FetchClient` (so URL/header building and query-param handling
 * match production exactly), but with an instant `sleep` and no
 * `minIntervalMs` spacing, so a 429's retry backoff and the production
 * 200ms request spacing never actually wait: tests stay fast without
 * bypassing the request-building code they assert on. Swapped in by mocking
 * `./fetchClient` to replace the `intervalsApi` instance the module under
 * test imports, because these tests assert against real request/URL
 * construction via a mocked `globalThis.fetch` rather than mocking `.get()`
 * directly.
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
  const calls: Array<{
    url: string;
    headers: Headers;
    method?: string;
    body?: string;
  }> = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
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
    const parsedIntervals = (await getActivityIntervals("k", "i189807578"))
      .icu_intervals;
    expect(parsedIntervals.length).toBeGreaterThan(0);
    const firstInterval: IntervalsInterval | undefined = parsedIntervals[0];
    expect(firstInterval?.average_vertical_ratio).toBeCloseTo(8.869921);
    expect(firstInterval?.average_stride).toBeCloseTo(1.219285);
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
    mockJson(activityMultilap);
    expect((await getActivity("k", activityMultilap.id)).id).toBe(
      activityMultilap.id,
    );
    mockJson(activityHilly);
    expect((await getActivity("k", activityHilly.id)).id).toBe(
      activityHilly.id,
    );
    mockJson(multilapIntervals);
    expect(
      (await getActivityIntervals("k", activityMultilap.id)).icu_intervals
        .length,
    ).toBe(multilapIntervals.icu_intervals.length);
    mockJson(streamsMultilap);
    expect(
      (await getActivityStreams("k", activityMultilap.id, ["time"])).length,
    ).toBe(streamsMultilap.length);
    mockJson(streamsHilly);
    expect(
      (await getActivityStreams("k", activityHilly.id, ["time"])).length,
    ).toBe(streamsHilly.length);
  });

  it("searches all history through search-full, newest first, with tags", async () => {
    const older = {
      ...activities[0],
      id: "i1",
      start_date_local: "2024-09-26T07:00:00",
      tags: null,
    };
    const newer = {
      ...activities[0],
      id: "i2",
      start_date_local: "2026-09-26T07:00:00",
      tags: ["race", "club"],
    };
    const calls = mockJson([older, newer]);

    const found = await searchActivities("k", "club 10k", 200);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/athlete/0/activities/search-full");
    expect(url.searchParams.get("q")).toBe("club 10k");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(found.map((a) => a.id)).toEqual(["i2", "i1"]);
    expect(found[0]?.tags).toEqual(["race", "club"]);
    expect(found[1]?.tags).toBeNull();
  });

  it("sends a # tag query percent-encoded in the raw URL", async () => {
    const calls = mockJson([]);

    await searchActivities("k", "#race", 200);

    expect(calls[0]!.url).toContain("q=%23race");
  });

  describe("searchActivitiesByIntervals", () => {
    it("sends exactly the seven band fields and sorts newest first", async () => {
      const older = {
        ...activities[0],
        id: "i1",
        start_date_local: "2025-11-14T18:54:16",
      };
      const newer = {
        ...activities[0],
        id: "i2",
        start_date_local: "2026-05-10T08:09:41",
      };
      const calls = mockJson([older, newer]);

      // The tool passes its search band, which also carries intensityUsed.
      const found = await searchActivitiesByIntervals("k", {
        minSecs: 225,
        maxSecs: 309,
        minIntensity: 92,
        maxIntensity: 107,
        minReps: 3,
        maxReps: 7,
        limit: 100,
        intensityUsed: true,
      } as Parameters<typeof searchActivitiesByIntervals>[1]);

      const url = new URL(calls[0]!.url);
      expect(url.pathname).toBe("/api/v1/athlete/0/activities/interval-search");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        minSecs: "225",
        maxSecs: "309",
        minIntensity: "92",
        maxIntensity: "107",
        minReps: "3",
        maxReps: "7",
        limit: "100",
      });
      expect(found.map((a) => a.id)).toEqual(["i2", "i1"]);
    });

    it("keeps a 422 status, such as a limit over 100", async () => {
      mockJson({ status: 422, error: "limit must be <= 100" }, 422);
      const error = await searchActivitiesByIntervals("k", {
        minSecs: 1,
        maxSecs: 2,
        minIntensity: 0,
        maxIntensity: 300,
        minReps: 2,
        maxReps: 4,
        limit: 400,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(IntervalsApiError);
      expect(error.response.status).toBe(422);
    });
  });

  describe("getActivitiesByIds", () => {
    it("reads comma-separated ids in one request, with intervals when asked", async () => {
      const calls = mockJson(activitiesSimilar);

      const rows = await getActivitiesByIds("k", ["i1", "i2"], {
        intervals: true,
      });

      const url = new URL(calls[0]!.url);
      expect(url.pathname).toBe("/api/v1/athlete/0/activities/i1,i2");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        intervals: "true",
      });
      // Rows come back as the API sends them (oldest first), not sorted.
      expect(rows.map((a) => a.id)).toEqual(activitiesSimilar.map((a) => a.id));
      expect(rows[0]?.icu_intervals?.[0]?.intensity).toBe(
        activitiesSimilar[0]!.icu_intervals[0]!.intensity,
      );
    });

    it("sends no query without intervals", async () => {
      const calls = mockJson([]);
      await getActivitiesByIds("k", ["i1"]);
      expect(new URL(calls[0]!.url).search).toBe("");
    });

    it("makes no request for no ids", async () => {
      const calls = mockJson([]);
      expect(await getActivitiesByIds("k", [])).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  it("types the fields the read tools use from a detailed activity", async () => {
    mockJson(activity);
    const result = await getActivity("k", "i189807578");
    expect(result.average_cadence).toBeCloseTo(83.15543);
    expect(result.average_stance_time).toBeCloseTo(233.21266);
    expect(result.average_vertical_oscillation).toBeCloseTo(108.36414);
    expect(result.average_vertical_ratio).toBeCloseTo(8.848502);
    expect(result.average_step_length).toBeCloseTo(1225.9629);
    expect(result.average_heartrate).toBe(171);
    expect(result.max_heartrate).toBe(185);
    expect(result.icu_hr_zone_times).toEqual([103, 146, 330, 1684, 111]);
    expect(result.trimp).toBeCloseTo(97.54981);
    expect(result.icu_rpe).toBe(7);
    expect(result.total_elevation_gain).toBeCloseTo(85.052216);
    expect(result.elapsed_time).toBe(2373);
    expect(result.device_name).toBe("Watch7,5");
    expect(result.source).toBe("OAUTH_CLIENT");
    expect(result.stream_types).toContain("heartrate");
    expect(result.gear).toEqual({
      id: "71459",
      name: null,
      distance: null,
      primary: null,
    });
    expect(result.pace_load).toBe(activity.pace_load);
    expect(result.power_load).toBe(activity.power_load);
    expect(result.session_rpe).toBe(activity.session_rpe);
    expect(result.strain_score).toBe(activity.strain_score);
  });

  it("types a pool swim's lengths, HR recovery and achievements", async () => {
    // The swim fixture sets no achievement; this LTHR_UP is synthetic, in
    // the shape seen live (docs/api-notes.md).
    const lthrUp = {
      id: "lthr",
      type: "LTHR_UP",
      message: "1h at 172 bpm",
      value: 172,
      secs: null,
      point: { start_index: 0, end_index: 3600, secs: 3600, value: 172 },
    };
    mockJson({ ...activitySwim, icu_achievements: [lthrUp] });
    const result = await getActivity("k", activitySwim.id);
    expect(result.lengths).toBe(30);
    expect(result.pool_length).toBe(50);
    expect(result.icu_hrr).toMatchObject({
      start_time: 1458,
      end_time: 1518,
      start_bpm: 153,
      end_bpm: 140,
      hrr: 13,
    });
    expect(result.icu_achievements).toEqual([lthrUp]);
  });

  it.each([
    ["a string", "oops"],
    ["an entry with a numeric type", [{ type: 5 }]],
  ])(
    "reads icu_achievements as null, not a failure, when it is %s",
    async (_label, bad) => {
      mockJson({ ...activitySwim, icu_achievements: bad });
      const result = await getActivity("k", activitySwim.id);
      expect(result.id).toBe(activitySwim.id);
      expect(result.icu_achievements).toBeNull();
    },
  );

  it("reads a malformed icu_hrr as null, not a failure", async () => {
    mockJson({ ...activitySwim, icu_hrr: "oops" });
    const result = await getActivity("k", activitySwim.id);
    expect(result.id).toBe(activitySwim.id);
    expect(result.icu_hrr).toBeNull();
  });

  it("types ctlLoad, atlLoad, and sportInfo on a wellness row", async () => {
    mockJson([
      {
        ...wellness[0],
        ctlLoad: 74,
        atlLoad: 21,
        sportInfo: [{ type: "Ride", eftp: null, wPrime: null, pMax: null }],
      },
    ]);
    const result = await getWellness("k", {
      oldest: "2026-09-24",
      newest: "2026-09-24",
    });
    expect(result[0]?.ctlLoad).toBe(74);
    expect(result[0]?.atlLoad).toBe(21);
    expect(result[0]?.sportInfo).toEqual([
      { type: "Ride", eftp: null, wPrime: null, pMax: null },
    ]);
  });

  it("sends fields= as a comma-joined query param on getWellness", async () => {
    const calls = mockJson(wellness);
    await getWellness(
      "k",
      { oldest: "2026-09-10", newest: "2026-09-24" },
      { fields: ["id", "ctl", "atl", "ctlLoad", "atlLoad"] },
    );
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("fields")).toBe("id,ctl,atl,ctlLoad,atlLoad");
  });

  it("omits fields= when no fields are requested", async () => {
    const calls = mockJson(wellness);
    await getWellness("k", { oldest: "2026-09-10", newest: "2026-09-24" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.has("fields")).toBe(false);
  });

  it("skipCache bypasses a warm cache entry on getActivity", async () => {
    let calls = mockJson(activity);
    await getActivity("k", "i189807578");
    expect(calls).toHaveLength(1);

    // Cache hit: same body, no new fetch.
    await getActivity("k", "i189807578");
    expect(calls).toHaveLength(1);

    // skipCache: bypasses the warm entry and hits the wire again.
    calls = mockJson(activity);
    await getActivity("k", "i189807578", { skipCache: true });
    expect(calls).toHaveLength(1);
  });

  describe("updateActivity", () => {
    it("sends PUT with only the provided keys and returns the parsed activity", async () => {
      const calls = mockJson(activity);
      const result = await updateActivity("k", "i189807578", {
        name: "New name",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PUT");
      expect(new URL(calls[0]?.url ?? "").pathname).toBe(
        "/api/v1/activity/i189807578",
      );
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
        name: "New name",
      });
      expect(result.id).toBe(activity.id);
    });

    it("is not retried on a transient 5xx (one fetch call) and wraps it in IntervalsApiError", async () => {
      let count = 0;
      globalThis.fetch = vi.fn(async () => {
        count += 1;
        return new Response("boom", { status: 503 });
      }) as unknown as typeof fetch;

      await expect(
        updateActivity("k", "i189807578", { name: "x" }),
      ).rejects.toBeInstanceOf(IntervalsApiError);
      expect(count).toBe(1);
    });

    it("rethrows RateLimitError on 429", async () => {
      mockJson({}, 429);
      await expect(
        updateActivity("k", "i189807578", { name: "x" }),
      ).rejects.toBeInstanceOf(RateLimitError);
    });

    it("invalidates that activity's cached read so a subsequent getActivity misses the cache", async () => {
      let calls = mockJson(activity);
      await getActivity("k", "i189807578");
      expect(calls).toHaveLength(1);

      calls = mockJson(activity);
      await updateActivity("k", "i189807578", { name: "Updated" });
      expect(calls).toHaveLength(1);

      await getActivity("k", "i189807578");
      expect(calls).toHaveLength(2);
    });

    it("invalidates the activity cache after a failed PUT, so a subsequent getActivity misses the cache", async () => {
      let calls = mockJson(activity);
      await getActivity("k", "i189807578");
      expect(calls).toHaveLength(1);

      globalThis.fetch = vi.fn(async () => {
        return new Response("boom", { status: 503 });
      }) as unknown as typeof fetch;
      await expect(
        updateActivity("k", "i189807578", { name: "x" }),
      ).rejects.toBeInstanceOf(IntervalsApiError);

      calls = mockJson(activity);
      await getActivity("k", "i189807578");
      expect(calls).toHaveLength(1);
    });

    it("invalidates the athlete's activities list and gear list on success", async () => {
      let calls = mockJson([]);
      await listActivities("k", {
        oldest: "2026-09-01",
        newest: "2026-09-24",
      });
      await listGear("k");
      expect(calls).toHaveLength(2);

      calls = mockJson(activity);
      await updateActivity("k", "i189807578", { name: "x" });
      expect(calls).toHaveLength(1);

      calls = mockJson([]);
      await listActivities("k", {
        oldest: "2026-09-01",
        newest: "2026-09-24",
      });
      await listGear("k");
      expect(calls).toHaveLength(2);
    });

    // The pace curves' `activities` map carries the names get-best-efforts
    // and get-race-prediction show, so a rename must not wait out the TTL.
    const curves = { type: "Run", curves: ["1y"] };

    it("invalidates the athlete pace curves on success", async () => {
      let calls = mockJson(paceCurvesFixture);
      await getAthletePaceCurves("k", curves);
      await getAthletePaceCurves("k", curves);
      expect(calls).toHaveLength(1);

      calls = mockJson(activity);
      await updateActivity("k", "i189807578", { name: "Renamed" });

      calls = mockJson(paceCurvesFixture);
      await getAthletePaceCurves("k", curves);
      expect(calls).toHaveLength(1);
    });

    it("invalidates the athlete pace curves after a failed PUT", async () => {
      let calls = mockJson(paceCurvesFixture);
      await getAthletePaceCurves("k", curves);
      expect(calls).toHaveLength(1);

      mockJson({}, 503);
      await expect(
        updateActivity("k", "i189807578", { name: "Renamed" }),
      ).rejects.toBeInstanceOf(IntervalsApiError);

      calls = mockJson(paceCurvesFixture);
      await getAthletePaceCurves("k", curves);
      expect(calls).toHaveLength(1);
    });
  });

  it("parses the multi-lap fixture and types the widened activity fields", async () => {
    mockJson(activityMultilap);
    const result = await getActivity("k", activityMultilap.id);
    expect(result.icu_lap_count).toBe(12);
    expect(result.icu_intervals_edited).toBe(true);
    expect(result.average_speed).toBeCloseTo(3.372);
    expect(result.icu_hr_zones).toEqual([142, 154, 163, 171, 190]);
    expect(result.icu_power_zones).toBeNull();
    expect(result.pace_zones).toBeNull();
    expect(result.race).toBe(false);
    expect(result.sub_type).toBeNull();
    expect(result.recording_stops).toEqual([164, 431, 530, 2215, 3023, 3283]);
    expect(result.icu_warmup_time).toBe(300);
    expect(result.icu_average_watts).toBeNull();
    expect(result.icu_ftp).toBeNull();
  });

  it("parses the hilly fixture (largest total_elevation_gain in range)", async () => {
    mockJson(activityHilly);
    const result = await getActivity("k", activityHilly.id);
    expect(result.icu_lap_count).toBe(43);
    expect(result.total_elevation_gain).toBeCloseTo(692.83905);
    expect(result.average_speed).toBeCloseTo(3.077);
    expect(result.recording_stops).toBeNull();
  });

  it("types the widened interval fields from the multi-lap intervals fixture", async () => {
    mockJson(multilapIntervals);
    const result = await getActivityIntervals("k", activityMultilap.id);
    const firstInterval: IntervalsInterval | undefined =
      result.icu_intervals[0];
    expect(firstInterval?.gap).toBeCloseTo(3.427648);
    expect(firstInterval?.total_elevation_gain).toBeCloseTo(4.2);
    expect(firstInterval?.average_gradient).toBeCloseTo(0.0039488245);
    // Rewritten against the synthetic LTHR: floor(139 x 100 / 172).
    expect(firstInterval?.intensity).toBe(80);
    expect(firstInterval?.decoupling).toBeNull();
    expect(firstInterval?.group_id).toBe("311s@139bpm81rpm");
    expect(firstInterval?.start_time).toBe(0);
    expect(firstInterval?.end_time).toBe(311);
    expect(firstInterval?.max_heartrate).toBe(157);
    expect(firstInterval?.average_speed).toBeCloseTo(3.2055695);
    expect(firstInterval?.average_watts).toBeNull();
  });

  it("parses the multi-lap and hilly stream fixtures, including grade_smooth and watts", async () => {
    mockJson(streamsMultilap);
    const multilapStreams = await getActivityStreams("k", activityMultilap.id, [
      "time",
    ]);
    expect(multilapStreams.map((s) => s.type)).toEqual(
      streamsMultilap.map((s) => s.type),
    );
    expect(multilapStreams.map((s) => s.type)).toContain("grade_smooth");
    expect(multilapStreams.map((s) => s.type)).toContain("watts");
    for (const s of multilapStreams) {
      expect(s.data.length).toBeLessThanOrEqual(600);
    }

    mockJson(streamsHilly);
    const hillyStreams = await getActivityStreams("k", activityHilly.id, [
      "time",
    ]);
    expect(hillyStreams.map((s) => s.type)).toContain("grade_smooth");
    for (const s of hillyStreams) {
      expect(s.data.length).toBeLessThanOrEqual(600);
    }
  });

  it("types sport-settings ftp and warmup_time", async () => {
    mockJson(sportSettings);
    const result = await getSportSettings("k", "Run");
    expect(result.warmup_time).toBe(300);
    expect(result.ftp).toBeNull();
    expect(result.threshold_pace).toBeNull();
  });

  it("lists every sport settings group in one request", async () => {
    const calls = mockJson(sportSettingsListFixture);
    const result = await listSportSettings("k");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/athlete/0/sport-settings");
    expect(result).toHaveLength(sportSettingsListFixture.length);
    const run = result.find((group) => group.types?.includes("Run"));
    expect(run?.other).toBe(false);
    expect(run?.pace_units).toBe("MINS_KM");
    expect(run?.hr_zone_names).toHaveLength(5);
    expect(result.find((group) => group.other === true)?.types).toEqual([
      "Other",
    ]);
  });

  it("does not fail the settings parse on a bad display-only field", async () => {
    const [ride, ...rest] = structuredClone(sportSettingsListFixture);
    mockJson([
      {
        ...ride,
        hr_zone_names: ["Recovery", null, "Tempo"],
        pace_zone_names: "not a list",
        pace_units: 7,
      },
      ...rest,
    ]);
    const result = await listSportSettings("k");
    expect(result).toHaveLength(sportSettingsListFixture.length);
    expect(result[0]?.hr_zone_names).toEqual(["Recovery", null, "Tempo"]);
    expect(result[0]?.pace_zone_names).toBeNull();
    expect(result[0]?.pace_units).toBeNull();
  });

  it("fetches athlete HR curves with the requested curve ids, parsing the fixture", async () => {
    const calls = mockJson(hrCurvesFixture);
    const result = await getAthleteHrCurves("k", {
      type: "Run",
      curves: ["90d", "1y"],
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/athlete/0/hr-curves.json");
    expect(url.searchParams.get("type")).toBe("Run");
    expect(url.searchParams.get("curves")).toBe("90d,1y");
    // f1/f2/f3 are not needed (docs/api-notes.md).
    expect([...url.searchParams.keys()].sort()).toEqual(["curves", "type"]);
    expect(result.list.map((curve) => curve.id)).toEqual(["90d", "1y"]);
    expect(result.activities.i300000002?.start_date_local).toBe(
      "2026-08-30T07:00:00",
    );
  });

  it("parses HR curves for windows with no activities", async () => {
    mockJson({ list: [], activities: {} });
    expect(
      await getAthleteHrCurves("k", { type: "Run", curves: ["90d"] }),
    ).toEqual({ list: [], activities: {} });
  });

  it("parses the real gear fixture", async () => {
    mockJson(gearFixture);
    const gear = await listGear("k");
    expect(gear.length).toBe(gearFixture.length);
    expect(gear[0]?.id).toBe(gearFixture[0]?.id);
    expect(gear[0]?.name).toBe(gearFixture[0]?.name);
    expect(gear[0]?.distance).toBe(gearFixture[0]?.distance);
    // The owner, which get-activity matches against icu_athlete_id.
    expect(gear[0]?.athlete_id).toBe("i0");
  });

  it("types a gear reminder's known fields and keeps an unknown one via passthrough", async () => {
    mockJson([
      {
        ...gearFixture[0],
        retired: "2026-01-01T00:00:00",
        reminders: [
          {
            name: "Replace soon",
            distance: 500000,
            days: 180,
            percent_used: 92,
            extra_field: 3,
          },
        ],
      },
    ]);
    const gear = await listGear("k");
    expect(gear[0]?.retired).toBe("2026-01-01T00:00:00");
    expect(gear[0]?.reminders?.[0]).toMatchObject({
      name: "Replace soon",
      distance: 500000,
      days: 180,
      percent_used: 92,
      extra_field: 3,
    });
  });

  it("types the wellness subjective/misc fields the get-wellness tool reads", async () => {
    mockJson([
      {
        ...wellness[0],
        sleepScore: 82,
        readiness: 75,
        soreness: 3,
        fatigue: 2,
        stress: 1,
        mood: 4,
        motivation: 5,
        spO2: 96,
        respiration: 14,
        comments: "Felt good",
      },
    ]);
    const result = await getWellness("k", {
      oldest: "2026-09-10",
      newest: "2026-09-10",
    });
    expect(result[0]?.sleepScore).toBe(82);
    expect(result[0]?.readiness).toBe(75);
    expect(result[0]?.soreness).toBe(3);
    expect(result[0]?.fatigue).toBe(2);
    expect(result[0]?.stress).toBe(1);
    expect(result[0]?.mood).toBe(4);
    expect(result[0]?.motivation).toBe(5);
    expect(result[0]?.spO2).toBe(96);
    expect(result[0]?.respiration).toBe(14);
    expect(result[0]?.comments).toBe("Felt good");
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

  it("reports progress once per window on a multi-window scan (#51)", async () => {
    mockJson([]);
    const progress = vi.fn();
    await listActivities(
      "k",
      { oldest: "2026-01-01", newest: "2026-03-11" },
      progress,
    );
    expect(progress.mock.calls.map(([message]) => message)).toEqual([
      "Listing activities 2026-01-01 to 2026-01-31 (window 1 of 3)…",
      "Listing activities 2026-02-01 to 2026-03-03 (window 2 of 3)…",
      "Listing activities 2026-03-04 to 2026-03-11 (window 3 of 3)…",
    ]);
  });

  it("reports no window progress for a single-window range", async () => {
    mockJson([]);
    const progress = vi.fn();
    await listActivities(
      "k",
      { oldest: "2026-09-01", newest: "2026-09-24" },
      progress,
    );
    expect(progress).not.toHaveBeenCalled();
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

  it("fetches athlete pace curves with the requested curve ids, parsing the real fixture", async () => {
    const calls = mockJson(paceCurvesFixture);
    const result = await getAthletePaceCurves("k", {
      type: "Run",
      curves: ["all", "1y", "90d"],
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/athlete/0/pace-curves.json");
    expect(url.searchParams.get("type")).toBe("Run");
    expect(url.searchParams.get("curves")).toBe("all,1y,90d");
    expect(result.list.length).toBe(paceCurvesFixture.list.length);
    expect(result.activities[Object.keys(result.activities)[0]!]?.name).toBe(
      paceCurvesFixture.activities[
        Object.keys(
          paceCurvesFixture.activities,
        )[0] as keyof typeof paceCurvesFixture.activities
      ]?.name,
    );
  });

  it("asks for subMaxEfforts only when above 0, and parses the ranks it adds", async () => {
    const calls = mockJson(paceCurvesSubmaxFixture);
    const result = await getAthletePaceCurves("k", {
      type: "Run",
      curves: ["r.2026-08-01.2026-09-30"],
      subMaxEfforts: 4,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v1/athlete/0/pace-curves.json");
    expect(url.searchParams.get("curves")).toBe("r.2026-08-01.2026-09-30");
    expect(url.searchParams.get("subMaxEfforts")).toBe("4");

    const list = result.list[0];
    expect(list?.submax_values).toHaveLength(4);
    expect(list?.submax_activity_id).toHaveLength(4);
    // Rows are truncated where fewer activities reach the distance.
    expect(list?.submax_values?.map((row) => row.length)).toEqual([
      124, 108, 94, 94,
    ]);

    intervalsApi.clearResponseCache();
    const plain = mockJson(paceCurvesFixture);
    await getAthletePaceCurves("k", {
      type: "Run",
      curves: ["1y"],
      subMaxEfforts: 0,
    });
    expect(new URL(plain[0]?.url ?? "").searchParams.has("subMaxEfforts")).toBe(
      false,
    );
  });

  describe("getAthleteTimeZone", () => {
    it("returns only the zone from GET /athlete/0, with Basic auth", async () => {
      const calls = mockJson({
        id: "999999",
        timezone: "Australia/Sydney",
        icu_api_key: "should-not-leak",
      });
      expect(await getAthleteTimeZone("k")).toBe("Australia/Sydney");
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/athlete/0");
      expect(calls[0]!.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("API_KEY:k").toString("base64")}`,
      );
    });

    it("reads the configured athlete, so a coach key gets that athlete's zone", async () => {
      process.env.INTERVALS_ATHLETE_ID = "i12345";
      const calls = mockJson({ timezone: "Europe/London" });
      expect(await getAthleteTimeZone("k")).toBe("Europe/London");
      expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/athlete/i12345");
    });

    it.each([
      ["null", { timezone: null }],
      ["missing", {}],
      ["blank", { timezone: "  " }],
    ])("returns null when the zone is %s", async (_, body) => {
      mockJson(body);
      expect(await getAthleteTimeZone("k")).toBeNull();
    });

    // The record carries icu_api_key, so it must never sit in the cache.
    it("is never cached", async () => {
      const calls = mockJson({ timezone: "Australia/Sydney" });
      await getAthleteTimeZone("k");
      await getAthleteTimeZone("k");
      expect(calls).toHaveLength(2);
    });

    it("rejects a 401 as an IntervalsApiError with the status", async () => {
      mockJson({}, 401);
      const error = await getAthleteTimeZone("k").catch((e) => e);
      expect(error).toBeInstanceOf(IntervalsApiError);
      expect(error.response.status).toBe(401);
    });

    it("throws a plain Error naming the field for a non-string zone", async () => {
      mockJson({ timezone: 42 });
      const error = await getAthleteTimeZone("k").catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(IntervalsApiError);
      expect((error as Error).message).toMatch(
        /invalid intervals\.icu response at timezone/,
      );
    });
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

  it("keeps an upstream HTML error page out of the error message (#52)", async () => {
    const page = `<!DOCTYPE html><html><head><title>intervals.icu | 522: Connection timed out</title><style>${"x".repeat(6000)}</style></head><body>...</body></html>`;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(page, {
        status: 522,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;

    const error = await getActivity("k", "i0").catch((e) => e);

    expect(error).toBeInstanceOf(IntervalsApiError);
    expect(error.message).toBe(
      'getActivity for ID i0: 522 HTML error page "intervals.icu | 522: Connection timed out"',
    );
    // The raw page is still there for anyone who needs it.
    expect(error.response.data).toBe(page);
    expect(error.response.contentType).toBe("text/html; charset=UTF-8");
    // 522 is transient, so the GET was retried like a 502.
    expect(calls).toHaveLength(3);
  });

  it("carries the Cloudflare challenge flag through the translation", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Just a moment...</title></head></html>",
          {
            status: 403,
            headers: {
              "content-type": "text/html",
              "cf-mitigated": "challenge",
            },
          },
        ),
    ) as unknown as typeof fetch;

    const error = await getActivity("k", "i0").catch((e) => e);

    expect(error).toBeInstanceOf(IntervalsApiError);
    expect(error.response).toMatchObject({
      status: 403,
      cloudflareChallenge: true,
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
