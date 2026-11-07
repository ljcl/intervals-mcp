import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import { CallCancelledError } from "./callScope";
import { RequestTimeoutError } from "./fetchClient";
import { type IntervalsEvent, listPlannedWorkouts } from "./intervalsClient";
import {
  cumulativeDistances,
  haversineMeters,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { geocode, OrsApiError, type OrsRoute, orsRoute } from "./orsClient";
import { loadCrossings } from "./overpassClient";
import { passesInOrder } from "./routeCandidates";
import {
  loadRouteSuggestions,
  RouteSuggestionError,
  type SuggestionEnv,
} from "./routeSuggestions";
import { loadRunStarts, type RunStart } from "./startClusters";

vi.mock("./intervalsClient", async (o) => ({
  ...(await o<typeof import("./intervalsClient")>()),
  listPlannedWorkouts: vi.fn(),
}));
vi.mock("./orsClient", async (o) => ({
  ...(await o<typeof import("./orsClient")>()),
  geocode: vi.fn(),
  orsRoute: vi.fn(),
}));
vi.mock("./overpassClient", async (o) => ({
  ...(await o<typeof import("./overpassClient")>()),
  loadCrossings: vi.fn(),
}));
vi.mock("./startClusters", async (o) => ({
  ...(await o<typeof import("./startClusters")>()),
  loadRunStarts: vi.fn(),
}));

const SF: LatLng = [37.7955, -122.3937];
const ENV: SuggestionEnv = {
  orsKey: "ors",
  homeStart: null,
  today: "2026-11-03",
};

function square(
  lat0: number,
  lng0: number,
  side: number,
  rise = 0,
  lngSide = side,
): RouteTrack {
  const corners: LatLng[] = [
    [lat0, lng0],
    [lat0 + side, lng0],
    [lat0 + side, lng0 + lngSide],
    [lat0, lng0 + lngSide],
    [lat0, lng0],
  ];
  const coordinates: LatLng[] = [];
  // 100 points a side (about 15 m apart) so the test hill is resolved finely.
  for (let c = 0; c < 4; c++)
    for (let k = 0; k < 100; k++) {
      const [a, b] = [corners[c]!, corners[c + 1]!];
      coordinates.push([
        a[0] + ((b[0] - a[0]) * k) / 100,
        a[1] + ((b[1] - a[1]) * k) / 100,
      ]);
    }
  coordinates.push(corners[4]!);
  // A 150 m section at about 6% early in the loop when rise > 0.
  const distance = cumulativeDistances(coordinates);
  const altitude = distance.map((d) =>
    d < 200 ? 10 : d < 350 ? 10 + ((d - 200) / 150) * rise : 10 + rise,
  );
  return { coordinates, distance, altitude };
}

function event(
  id: number,
  date: string,
  distance: number | null,
  name = "Easy run",
): IntervalsEvent {
  return {
    id,
    start_date_local: `${date}T00:00:00`,
    category: "WORKOUT",
    type: "Run",
    name,
    description: "Flat foreshore",
    distance,
    moving_time: 2000,
  };
}

function route(
  track: RouteTrack,
  distance_m = track.distance.at(-1)!,
): OrsRoute {
  return {
    track,
    distance_m,
    ascent_m: 10,
    path_share: 0.7,
    ferry_m: 0,
    way_names: ["Foreshore Walk", "Park Road"],
  };
}

/** The n-th generated loop: 2.2 km further south each time, so no two are the same route. */
const generatedLoop = (n: number) => square(SF[0] - 0.02 * n, SF[1], 0.0135);

const homeLoop = square(SF[0], SF[1], 0.0135);
const history: RunStart[] = [
  {
    id: "i1",
    date: "2026-10-01",
    name: "Home loop",
    distance_m: homeLoop.distance.at(-1)!,
    climb_m: 20,
    track: homeLoop,
  },
];

/** ORS through the waypoints in straight lines, `streets` times their length. */
function straightRoute(waypoints: LatLng[], streets = 1): OrsRoute {
  const coordinates: LatLng[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [a, b] = [waypoints[i - 1]!, waypoints[i]!];
    for (let k = 0; k < 50; k++)
      coordinates.push([
        a[0] + ((b[0] - a[0]) * k) / 50,
        a[1] + ((b[1] - a[1]) * k) / 50,
      ]);
  }
  coordinates.push(waypoints.at(-1)!);
  const distance = cumulativeDistances(coordinates).map((d) => d * streets);
  return route({ coordinates, distance, altitude: distance.map(() => 10) });
}

/** 1.5 km north of the usual start: homeLoop's first corner, so the past loop passes it. */
const VIA: LatLng = [SF[0] + 0.0135, SF[1]];
/** 1.5 km east of VIA. */
const VIA_EAST: LatLng = [SF[0] + 0.0135, SF[1] + 0.017];
const text = (point: LatLng) => `${point[0]},${point[1]}`;
const km = (meters: number) => meters / 1000;

beforeEach(() => {
  vi.mocked(listPlannedWorkouts).mockResolvedValue([
    event(10, "2026-11-04", homeLoop.distance.at(-1)!),
  ]);
  vi.mocked(loadRunStarts).mockResolvedValue({ runs: history, skipped: 0 });
  vi.mocked(loadCrossings).mockReset().mockResolvedValue([]);
  vi.mocked(geocode).mockReset();
  vi.mocked(orsRoute).mockReset();
  let n = 0;
  vi.mocked(orsRoute).mockImplementation(async () => route(generatedLoop(++n)));
});

describe("loadRouteSuggestions", () => {
  it("offers past runs then one new loop from the usual start", async () => {
    const result = await loadRouteSuggestions("k", {}, ENV);
    const run = result.runs[0]!;
    expect(run).toMatchObject({
      event_id: 10,
      date: "2026-11-04",
      distance_source: "event",
      description: "Flat foreshore",
    });
    expect(run.start).toMatchObject({
      source: "inferred",
      point: SF,
      history_runs: 1,
      label: "Usual start (1 recent run)",
    });
    expect(run.candidates.map((c) => c.kind)).toEqual(["past", "generated"]);
    expect(run.candidates[1]!.summary).toBe("via Foreshore Walk, Park Road");
    expect(run.candidates.every((c) => c.crossings_per_km === 0)).toBe(true);
    expect(result.generation_available).toBe(true);
  });

  it("labels an argument distance and plans without an event", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([]);
    const result = await loadRouteSuggestions("k", { distanceKm: 6 }, ENV);
    expect(result.runs[0]).toMatchObject({
      event_id: null,
      name: "Run",
      distance_m: 6000,
      distance_source: "argument",
    });
  });

  it("says so when nothing is planned and no distance was given", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([]);
    await expect(loadRouteSuggestions("k", {}, ENV)).rejects.toThrow(
      /No planned run from 2026-11-03 to 2026-11-16/,
    );
  });

  it("offers three generated routes away from home, with the geocoded label", async () => {
    vi.mocked(geocode).mockResolvedValue({
      label: "Embarcadero, San Francisco, CA, USA",
      point: [37.8, -122.3],
    });
    const run = (
      await loadRouteSuggestions(
        "k",
        { start: "Embarcadero, San Francisco" },
        ENV,
      )
    ).runs[0]!;
    expect(run.start).toMatchObject({
      label: "Embarcadero, San Francisco, CA, USA",
      source: "argument",
      history_runs: 0,
    });
    expect(run.candidates.map((c) => c.kind)).toEqual([
      "generated",
      "generated",
      "generated",
    ]);
  });

  it("drops the generated route with the most crossings", async () => {
    // A crossing node on loop 2's start: of the 4 seeds tried away from home, loop 2 ranks last.
    const busyStart = generatedLoop(2).coordinates[0]!;
    vi.mocked(loadCrossings).mockResolvedValue([busyStart]);
    const run = (await loadRouteSuggestions("k", { start: "37.8,-122.3" }, ENV))
      .runs[0]!;
    expect(vi.mocked(loadCrossings)).toHaveBeenCalledTimes(1);
    expect(
      run.candidates.map((c) => c.track.coordinates[0]),
    ).not.toContainEqual(busyStart);
  });

  it("warns once and still answers when crossings cannot be counted", async () => {
    vi.mocked(loadCrossings).mockResolvedValue(null);
    const result = await loadRouteSuggestions("k", {}, ENV);
    expect(result.warnings).toContain(
      "Road crossings could not be counted (OpenStreetMap Overpass did not answer), so new routes were ranked by their share on paths and past runs by recency and distance.",
    );
    expect(result.runs[0]!.candidates.map((c) => c.crossings_per_km)).toEqual([
      null,
      null,
    ]);
  });

  it("offers past runs only without an ORS key and refuses place names", async () => {
    const result = await loadRouteSuggestions(
      "k",
      {},
      { ...ENV, orsKey: null },
    );
    expect(result.generation_available).toBe(false);
    expect(result.runs[0]!.candidates.map((c) => c.kind)).toEqual(["past"]);
    await expect(
      loadRouteSuggestions(
        "k",
        { start: "Embarcadero" },
        { ...ENV, orsKey: null },
      ),
    ).rejects.toBeInstanceOf(RouteSuggestionError);
  });

  it("rescales a loop that misses the distance once, by at most a quarter", async () => {
    const target = homeLoop.distance.at(-1)!;
    // Always twice the target: never fits, so every seed makes both calls.
    vi.mocked(orsRoute).mockImplementation(async () =>
      route(homeLoop, target * 2),
    );
    await loadRouteSuggestions("k", {}, ENV);
    const firstSeed = vi.mocked(orsRoute).mock.calls[0]![1].roundTrip!.seed;
    const lengths = vi
      .mocked(orsRoute)
      .mock.calls.filter((c) => c[1].roundTrip?.seed === firstSeed)
      .map((c) => Math.round(c[1].roundTrip!.length_m));
    expect(lengths).toEqual([Math.round(target), Math.round(target * 0.75)]);
  });

  it("does not rescale a loop far off the distance, and drops it with a warning", async () => {
    const target = homeLoop.distance.at(-1)!;
    // About 35 km for a 5.4 km run, as ORS once gave 39 km for 6 km.
    const huge = square(SF[0] - 0.02, SF[1], 0.0135 * 6.5);
    vi.mocked(orsRoute).mockImplementation(async () => route(huge));
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    // One call per seed, each at the target: no rescale toward a 1 km loop.
    expect(
      vi
        .mocked(orsRoute)
        .mock.calls.map((c) => Math.round(c[1].roundTrip!.length_m)),
    ).toEqual([Math.round(target), Math.round(target)]);
    expect(run.candidates.map((c) => c.kind)).toEqual(["past"]);
    expect(run.warnings).toContain(
      "No new loop close to 5.4 km was found from this start.",
    );
  });

  it("drops a generated loop more than 25% off the distance", async () => {
    // 30% long after both tries: within the rescale window, still too far.
    vi.mocked(orsRoute).mockImplementation(async () =>
      route(square(SF[0] - 0.02, SF[1], 0.0135 * 1.3)),
    );
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    expect(run.candidates.every((c) => c.kind === "past")).toBe(true);
    expect(run.warnings.join(" ")).toMatch(/No new loop close to/);
    // Each seed still tried its one rescale.
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(4);
  });

  it("drops a route that goes by ferry and tries the next seed", async () => {
    let n = 0;
    vi.mocked(orsRoute).mockImplementation(async () => {
      n += 1;
      return { ...route(generatedLoop(n)), ferry_m: n === 1 ? 2400 : 0 };
    });
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    const generated = run.candidates.filter((c) => c.kind === "generated");
    expect(generated.map((c) => c.track.coordinates[0])).toEqual([
      generatedLoop(2).coordinates[0],
    ]);
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(2);
  });

  it("drops a point-to-point route that goes by ferry", async () => {
    vi.mocked(orsRoute).mockResolvedValue({
      ...route(generatedLoop(1)),
      ferry_m: 900,
    });
    const run = (
      await loadRouteSuggestions(
        "k",
        { start: "37.8,-122.3", end: "37.82,-122.36" },
        ENV,
      )
    ).runs[0]!;
    expect(run.candidates).toEqual([]);
  });

  it.each([
    ["a rate limit", handledRateLimit("orsRoute"), /rate limit/],
    [
      "a rejected key",
      new OrsApiError("x", { status: 403, statusText: "", data: "" }),
      /rejected ORS_API_KEY/,
    ],
    [
      "no path",
      new OrsApiError("x", { status: 404, statusText: "", data: "" }),
      /no walkable path/,
    ],
    [
      "a timeout",
      new RequestTimeoutError("https://ors/v2/directions", 10_000),
      /request to OpenRouteService failed/,
    ],
    [
      "a malformed response",
      new Error("invalid OpenRouteService response"),
      /request to OpenRouteService failed/,
    ],
  ])("keeps past runs and warns on %s", async (_label, error, warning) => {
    vi.mocked(orsRoute).mockRejectedValue(error);
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    expect(run.candidates.map((c) => c.kind)).toEqual(["past"]);
    expect(run.warnings.join(" ")).toMatch(warning);
    // The first failure stops generation: the second seed is never tried.
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(1);
  });

  it("keeps a route made before ORS failed, and warns once for the call", async () => {
    vi.mocked(orsRoute)
      .mockResolvedValueOnce(route(generatedLoop(1)))
      .mockRejectedValue(handledRateLimit("orsRoute"));
    const result = await loadRouteSuggestions("k", {}, ENV);
    expect(result.runs[0]!.candidates.map((c) => c.kind)).toEqual([
      "past",
      "generated",
    ]);
    expect(result.runs[0]!.warnings.join(" ")).not.toMatch(/rate limit/);
    expect(result.warnings.join(" ")).toMatch(
      /Route generation stopped: .*rate limit/,
    );
  });

  it("stops calling a failing ORS for later runs", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    vi.mocked(orsRoute).mockRejectedValue(
      new OrsApiError("x", { status: 403, statusText: "", data: "" }),
    );
    const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(1);
    expect(result.warnings.filter((w) => /rejected/.test(w))).toHaveLength(1);
    expect(result.runs[1]!.warnings).toEqual([]);
  });

  it("offers one recording of a loop across a week, not the next one too", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    // The same loop recorded twice, its GPS about 10 m apart.
    const again = square(SF[0] + 0.0001, SF[1], 0.0135);
    vi.mocked(loadRunStarts).mockResolvedValue({
      runs: [
        ...history,
        { ...history[0]!, id: "i2", date: "2026-10-08", track: again },
      ],
      skipped: 0,
    });
    const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
    const past = result.runs.map((r) =>
      r.candidates.filter((c) => c.kind === "past").map((c) => c.activity_id),
    );
    expect(past[0]).toHaveLength(1);
    expect(past[1]).toEqual([]);
  });

  it("picks a past run with a hill for hill repeats over better-ranked flat ones", async () => {
    const run = (id: string, date: string, track: RouteTrack): RunStart => ({
      id,
      date,
      name: id,
      distance_m: track.distance.at(-1)!,
      climb_m: 0,
      track,
    });
    vi.mocked(loadRunStarts).mockResolvedValue({
      runs: [
        // Run 3 days ago, so it ranks last on recency.
        run("hilly", "2026-10-31", square(SF[0], SF[1], 0.0135, 9, -0.0135)),
        run("flat-ne", "2026-10-01", homeLoop),
        run("flat-sw", "2026-10-02", square(SF[0], SF[1], -0.0135)),
      ],
      skipped: 0,
    });
    const result = await loadRouteSuggestions(
      "k",
      { terrain: "hill-repeats" },
      ENV,
    );
    const past = result.runs[0]!.candidates.filter((c) => c.kind === "past");
    expect(past.map((c) => c.activity_id)).toContain("hilly");
  });

  it("finds a hill on the 7th matching loop for hill repeats", async () => {
    const run = (id: string, date: string, track: RouteTrack): RunStart => ({
      id,
      date,
      name: id,
      distance_m: track.distance.at(-1)!,
      climb_m: 0,
      track,
    });
    // Six flat loops of about the same length, all different routes.
    const flat: Array<[number, number]> = [
      [0.0135, 0.0135],
      [0.0135, -0.0135],
      [-0.0135, 0.0135],
      [-0.0135, -0.0135],
      [0.009, 0.0192],
      [0.018, -0.0078],
    ];
    vi.mocked(loadRunStarts).mockResolvedValue({
      runs: [
        // Run 2 days ago, so it ranks 7th of 7 on recency.
        run("hilly", "2026-11-01", square(SF[0], SF[1], -0.009, 9, -0.0192)),
        ...flat.map(([lat, lng], i) =>
          run(
            `flat-${i}`,
            `2026-10-0${i + 1}`,
            square(SF[0], SF[1], lat, 0, lng),
          ),
        ),
      ],
      skipped: 0,
    });
    const result = await loadRouteSuggestions(
      "k",
      { terrain: "hill-repeats" },
      ENV,
    );
    const past = result.runs[0]!.candidates.filter((c) => c.kind === "past");
    expect(past[0]!.activity_id).toBe("hilly");
    expect(past[0]!.hill).not.toBeNull();
  });

  it("derives seeds from the run's date, alone or in a week", async () => {
    const seeds = () =>
      vi.mocked(orsRoute).mock.calls.map((c) => c[1].roundTrip!.seed);
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    await loadRouteSuggestions("k", { date: "2026-11-06" }, ENV);
    const alone = seeds();

    vi.mocked(orsRoute).mockClear();
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    await loadRouteSuggestions("k", { days: 7 }, ENV);
    const week = seeds();

    expect(alone).toHaveLength(2);
    expect(week.slice(2)).toEqual(alone);
    expect(week.slice(0, 2)).not.toEqual(alone);
  });

  it("gives a second run on the same day its own seeds", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-04", homeLoop.distance.at(-1)!),
    ]);
    await loadRouteSuggestions("k", { days: 2 }, ENV);
    const seeds = vi
      .mocked(orsRoute)
      .mock.calls.map((c) => c[1].roundTrip!.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("says why recent runs were left out of the start history", async () => {
    vi.mocked(loadRunStarts).mockResolvedValue({ runs: history, skipped: 2 });
    const result = await loadRouteSuggestions("k", {}, ENV);
    expect(result.warnings).toContain(
      "2 recent runs had no GPS track or could not be read and were left out of the start history.",
    );
  });

  it("asks Overpass once after it fails", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    vi.mocked(loadCrossings).mockResolvedValue(null);
    const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
    expect(vi.mocked(loadCrossings)).toHaveBeenCalledTimes(1);
    expect(
      result.warnings.filter((w) => /crossings could not be counted/.test(w)),
    ).toHaveLength(1);
  });

  it.each([
    ["a place name start", { start: "Embarcadero" }],
    ["a place name via", { via: "Ferry Building" }],
    ["a place name in a via list", { via: ["37.8,-122.3", "Ferry Building"] }],
    ["a place name end", { end: "Ferry Building" }],
  ])(
    "refuses %s without an ORS key before reading history",
    async (_label, args) => {
      vi.mocked(loadRunStarts).mockClear();
      await expect(
        loadRouteSuggestions("k", args, { ...ENV, orsKey: null }),
      ).rejects.toThrow(/needs ORS_API_KEY/);
      expect(vi.mocked(loadRunStarts)).not.toHaveBeenCalled();
    },
  );

  it("refuses point-to-point without an end before reading history", async () => {
    vi.mocked(loadRunStarts).mockClear();
    await expect(
      loadRouteSuggestions("k", { shape: "point-to-point" }, ENV),
    ).rejects.toBeInstanceOf(RouteSuggestionError);
    expect(vi.mocked(loadRunStarts)).not.toHaveBeenCalled();
  });

  it("finds hills for hill repeats and warns when there are none", async () => {
    vi.mocked(orsRoute).mockResolvedValue(
      route(square(SF[0] + 0.01, SF[1], 0.0135, 9)),
    );
    const run = (
      await loadRouteSuggestions("k", { terrain: "hill-repeats" }, ENV)
    ).runs[0]!;
    expect(run.candidates[0]!.hill).not.toBeNull();
    vi.mocked(orsRoute).mockResolvedValue(
      route(square(SF[0] + 0.01, SF[1], 0.0135)),
    );
    const flat = (
      await loadRouteSuggestions("k", { terrain: "hill-repeats" }, ENV)
    ).runs[0]!;
    expect(flat.warnings.join(" ")).toMatch(/hill repeats/);
  });

  it("uses a past run once across a week and varies seeds", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
    const past = result.runs.flatMap((r) =>
      r.candidates.filter((c) => c.kind === "past").map((c) => c.activity_id),
    );
    expect(past).toEqual(["i1"]);
    const seeds = new Set(
      vi.mocked(orsRoute).mock.calls.map((c) => c[1].roundTrip?.seed),
    );
    expect(seeds.size).toBe(4);
  });

  it("takes every outdoor run in a days window, skipping treadmill and other sports", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", 5000),
      { ...event(11, "2026-11-04", 30000), type: "Ride" },
      { ...event(13, "2026-11-04", 5000), type: "VirtualRun" },
      event(12, "2026-11-05", 5000),
    ]);
    const result = await loadRouteSuggestions(
      "k",
      { days: 3 },
      { ...ENV, orsKey: null },
    );
    expect(vi.mocked(listPlannedWorkouts)).toHaveBeenLastCalledWith("k", {
      oldest: "2026-11-03",
      newest: "2026-11-05",
    });
    expect(result.runs.map((r) => r.event_id)).toEqual([10, 12]);
  });

  it("starts from HOME_START, and needs a start when there is no history", async () => {
    const home = await loadRouteSuggestions("k", {}, { ...ENV, homeStart: SF });
    expect(home.runs[0]!.start).toMatchObject({
      source: "env",
      point: SF,
      history_runs: 1,
    });
    vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
    await expect(loadRouteSuggestions("k", {}, ENV)).rejects.toThrow(
      /infer your usual start/,
    );
  });

  it.each([
    [
      "a server error",
      new OrsApiError("look up 37.8,-122.3", {
        status: 500,
        statusText: "",
        data: "",
      }),
      /HTTP 500/,
    ],
    [
      "a timeout",
      new RequestTimeoutError(
        "https://ors/geocode?focus.point.lat=37.8",
        10_000,
      ),
      /request to OpenRouteService failed/,
    ],
  ])(
    "words a geocode failure on %s without its coordinates",
    async (_label, error, wording) => {
      vi.mocked(geocode).mockRejectedValue(error);
      const failure = loadRouteSuggestions("k", { start: "Embarcadero" }, ENV);
      await expect(failure).rejects.toBeInstanceOf(RouteSuggestionError);
      await expect(failure).rejects.toThrow(wording);
      await expect(failure).rejects.not.toThrow(/37\.8/);
    },
  );

  it("names the text when no place matches", async () => {
    vi.mocked(geocode).mockResolvedValue(null);
    await expect(
      loadRouteSuggestions("k", { start: "Nowhere Park" }, ENV),
    ).rejects.toThrow(/No place matched "Nowhere Park"/);
  });

  it("refuses a via that matches only a suburb or city", async () => {
    vi.mocked(geocode).mockResolvedValue({
      label: "Sydney, NSW, Australia",
      point: [-33.87, 151.21],
      match: { query: "Anzac Bridge", name: "Sydney", type: "locality" },
    });
    await expect(
      loadRouteSuggestions("k", { distanceKm: 6, via: "Anzac Bridge" }, ENV),
    ).rejects.toThrow(
      '"Anzac Bridge" matched only Sydney (a locality), so it was not routed; try the place name without its suburb or city, or pass lat,lng.',
    );
    expect(vi.mocked(orsRoute)).not.toHaveBeenCalled();
  });

  it("names the first of two coarse vias in the order asked", async () => {
    vi.mocked(geocode).mockImplementation(async (_key, t) => ({
      label: `${t}, NSW, Australia`,
      point: [-33.87, 151.21],
      match: { query: t, name: "Sydney", type: "locality" },
    }));
    await expect(
      loadRouteSuggestions(
        "k",
        { distanceKm: 6, via: ["First Place", "Second Place"] },
        ENV,
      ),
    ).rejects.toThrow(/^"First Place" matched only/);
  });

  it("routes through a via that matches a street", async () => {
    vi.mocked(geocode).mockResolvedValue({
      label: "Anzac Bridge, Pyrmont, NSW, Australia",
      point: VIA,
      match: { query: "Anzac Bridge", name: "Anzac Bridge", type: "street" },
    });
    const run = (
      await loadRouteSuggestions(
        "k",
        { distanceKm: 6, via: "Anzac Bridge" },
        ENV,
      )
    ).runs[0]!;
    expect(run.via[0]!.point).toEqual(VIA);
  });

  it("still starts from a suburb", async () => {
    vi.mocked(geocode).mockResolvedValue({
      label: "Glebe, NSW, Australia",
      point: SF,
      match: { query: "Glebe", name: "Glebe", type: "locality" },
    });
    const run = (await loadRouteSuggestions("k", { start: "Glebe" }, ENV))
      .runs[0]!;
    expect(run.start.point).toEqual(SF);
  });

  it("fills the new-route slot past a duplicate of a past run", async () => {
    let n = 0;
    // The first loop ORS returns is the past run itself, and ranks first on distance.
    vi.mocked(orsRoute).mockImplementation(async () =>
      route(n++ === 0 ? homeLoop : generatedLoop(n)),
    );
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    expect(run.candidates.map((c) => c.kind)).toEqual(["past", "generated"]);
  });

  it("stops generating when the call's ORS budget is spent", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue(
      [
        "2026-11-04",
        "2026-11-05",
        "2026-11-06",
        "2026-11-07",
        "2026-11-08",
      ].map((d, i) => event(20 + i, d, homeLoop.distance.at(-1)!)),
    );
    // Away from home: 4 seeds a run, so three runs spend the 12 calls.
    const result = await loadRouteSuggestions(
      "k",
      { days: 7, start: "37.8,-122.3" },
      ENV,
    );
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(12);
    expect(result.runs[2]!.warnings.join(" ")).toMatch(/budget is spent/);
    const unrouted = result.runs.filter(
      (r) => !r.candidates.some((c) => c.kind === "generated"),
    );
    expect(unrouted.map((r) => r.event_id)).toEqual([23, 24]);
    for (const r of unrouted)
      expect(r.warnings.join(" ")).toMatch(/budget is spent/);
  });

  describe("via routes", () => {
    beforeEach(() => {
      vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
        straightRoute(request.waypoints),
      );
    });
    const generated = (candidates: { kind: string }[]) =>
      candidates.filter((c) => c.kind === "generated");
    /** A loop from SF heading south and west: it never passes VIA, so nothing is stitched. */
    const awayFromVia: RunStart[] = [
      { ...history[0]!, id: "i2", track: square(SF[0], SF[1], -0.0135) },
    ];

    it("stretches a via loop to the distance through the via point", async () => {
      const run = (
        await loadRouteSuggestions("k", { distanceKm: 6, via: text(VIA) }, ENV)
      ).runs[0]!;
      const waypoints = vi
        .mocked(orsRoute)
        .mock.calls.map((c) => c[1].waypoints);
      // The via point alone (3 km), then a detour per seed.
      expect(waypoints[0]).toEqual([SF, VIA, SF]);
      expect(waypoints.slice(1).every((w) => w.length === 4)).toBe(true);
      const routes = generated(run.candidates) as typeof run.candidates;
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({ shape: "loop", name: "New loop" });
      expect(Math.abs(routes[0]!.distance_m - 6000)).toBeLessThan(300);
      expect(passesInOrder(routes[0]!.track, [VIA])).toBe(true);
      expect(run.warnings).toEqual([]);
    });

    it("rescales a stretch once when the streets wander more than the base", async () => {
      vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
        straightRoute(
          request.waypoints,
          request.waypoints.length > 3 ? 1.15 : 1,
        ),
      );
      const run = (
        await loadRouteSuggestions("k", { distanceKm: 6, via: text(VIA) }, ENV)
      ).runs[0]!;
      // One base call, then two tries for each of the two seeds.
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(5);
      const route = generated(run.candidates)[0] as (typeof run.candidates)[0];
      expect(Math.abs(route.distance_m - 6000)).toBeLessThan(300);
    });

    it("keeps the via route already at the distance without stretching it", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: awayFromVia,
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions("k", { distanceKm: 3, via: text(VIA) }, ENV)
      ).runs[0]!;
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(1);
      expect(generated(run.candidates)).toHaveLength(1);
    });

    it("runs an out-and-back through the via point to a turnaround and back", async () => {
      const run = (
        await loadRouteSuggestions(
          "k",
          { distanceKm: 6, via: text(VIA), shape: "out-and-back" },
          ENV,
        )
      ).runs[0]!;
      expect(run.shape).toBe("out-and-back");
      expect(vi.mocked(orsRoute).mock.calls[0]![1].waypoints).toEqual([
        SF,
        VIA,
      ]);
      const routes = generated(run.candidates) as typeof run.candidates;
      expect(routes.length).toBeGreaterThan(0);
      for (const c of routes) {
        expect(c).toMatchObject({
          shape: "out-and-back",
          name: "New out-and-back",
        });
        expect(Math.abs(c.distance_m - 6000)).toBeLessThan(300);
        expect(c.track.coordinates.at(-1)).toEqual(SF);
        expect(passesInOrder(c.track, [VIA])).toBe(true);
      }
    });

    it("passes several via points in the order given", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: awayFromVia,
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions(
          "k",
          { distanceKm: 8, via: [text(VIA), text(VIA_EAST)] },
          ENV,
        )
      ).runs[0]!;
      expect(run.via.map((p) => p.point)).toEqual([VIA, VIA_EAST]);
      for (const [, request] of vi.mocked(orsRoute).mock.calls) {
        const at = (p: LatLng) =>
          request.waypoints.findIndex((w) => w[0] === p[0] && w[1] === p[1]);
        expect(at(VIA)).toBeGreaterThan(0);
        expect(at(VIA_EAST)).toBeGreaterThan(at(VIA));
      }
      const routes = generated(run.candidates) as typeof run.candidates;
      expect(routes.length).toBeGreaterThan(0);
      for (const c of routes) {
        expect(passesInOrder(c.track, [VIA, VIA_EAST])).toBe(true);
        expect(Math.abs(c.distance_m - 8000)).toBeLessThan(400);
      }
    });

    it("offers a past run through the via point outside the distance tolerance", async () => {
      const run = (
        await loadRouteSuggestions("k", { distanceKm: 8, via: text(VIA) }, ENV)
      ).runs[0]!;
      const past = run.candidates.find((c) => c.kind === "past")!;
      expect(past.activity_id).toBe("i1");
      expect(km(past.distance_m - run.distance_m)).toBeCloseTo(-2.6, 1);
    });

    it("keeps the nearest via route with a warning when no stretch reaches the distance", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: awayFromVia,
        skipped: 0,
      });
      // Every detour point is unroutable (in the harbour, say): ORS answers 404.
      vi.mocked(orsRoute).mockImplementation(async (_key, request) => {
        if (request.waypoints.length > 3)
          throw new OrsApiError("x", { status: 404, statusText: "", data: "" });
        return straightRoute(request.waypoints);
      });
      const result = await loadRouteSuggestions(
        "k",
        { distanceKm: 6, via: text(VIA) },
        ENV,
      );
      const run = result.runs[0]!;
      // A missed detour costs its try, not the rest of the call.
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(3);
      expect(result.warnings.join(" ")).not.toMatch(/generation stopped/);
      const routes = generated(run.candidates) as typeof run.candidates;
      expect(routes.map((c) => Math.round(km(c.distance_m)))).toEqual([3]);
      expect(run.warnings).toContain(
        "No route through the via points came within 25% of 6.0 km; the nearest, 3.0 km, is offered: no detour from it came closer.",
      );
    });

    it("warns when passing the via point alone is too long", async () => {
      const far: LatLng = [SF[0] + 0.045, SF[1]];
      const run = (
        await loadRouteSuggestions("k", { distanceKm: 6, via: text(far) }, ENV)
      ).runs[0]!;
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(1);
      expect(run.warnings.join(" ")).toMatch(
        /within 25% of 6\.0 km; the nearest, 10\.0 km, is offered: passing the via points alone takes that far/,
      );
    });

    describe("stitched from past runs", () => {
      /** About 1 km north of SF, then about 1 km east of that. */
      const N: LatLng = [SF[0] + 0.009, SF[1]];
      const NE: LatLng = [SF[0] + 0.009, SF[1] + 0.0114];
      const NORTH_MORE: LatLng = [SF[0] + 0.018, SF[1]];
      function runOn(id: string, points: LatLng[]): RunStart {
        const { track, distance_m } = straightRoute(points);
        return {
          id,
          date: "2026-10-01",
          name: `Run ${id}`,
          distance_m,
          climb_m: 5,
          track,
        };
      }
      const fromStart = (w: LatLng[]) =>
        w[0]![0] === SF[0] && w[0]![1] === SF[1];
      const args = {
        distanceKm: 3.5,
        start: text(SF),
        via: [text(N), text(NE)],
      };

      it("builds a via loop from past runs, before the ORS route, with no fill", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints, 1.2),
        );
        const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).toEqual([
          "stitched",
          "generated",
        ]);
        const stitched = run.candidates[0]!;
        expect(passesInOrder(stitched.track, [N, NE])).toBe(true);
        expect(stitched.history_share).toBeGreaterThan(0.99);
        expect(stitched.summary).toBe(
          "From 2 past runs: Run a 2026-10-01, Run b 2026-10-01",
        );
        for (const [, request] of vi.mocked(orsRoute).mock.calls)
          expect(fromStart(request.waypoints)).toBe(true);
      });

      it("routes the legs no run covers once, through the via points between", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints),
        );
        const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
        const fills = vi
          .mocked(orsRoute)
          .mock.calls.map(([, r]) => r.waypoints)
          .filter((w) => !fromStart(w));
        expect(fills).toHaveLength(1);
        expect(haversineMeters(fills[0]![0]!, N)).toBeLessThan(100);
        expect(fills[0]!.slice(1)).toEqual([NE, SF]);
        const stitched = run.candidates.find((c) => c.kind === "stitched")!;
        expect(stitched.history_share).toBeGreaterThan(0.2);
        expect(stitched.history_share).toBeLessThan(0.4);
        expect(stitched.summary).toBe(
          "From 1 past run: Run a 2026-10-01; 2.4 km routed by OpenRouteService",
        );
      });

      it("offers a stitched route without an ORS key when no join needs routing", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        const run = (
          await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
        ).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).toEqual(["stitched"]);
        expect(vi.mocked(orsRoute)).not.toHaveBeenCalled();
      });

      it("drops a stitched route whose fill ORS cannot route, and keeps generating", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) => {
          if (!fromStart(request.waypoints))
            throw new OrsApiError("x", {
              status: 404,
              statusText: "",
              data: "",
            });
          return straightRoute(request.waypoints);
        });
        const result = await loadRouteSuggestions("k", args, ENV);
        const fills = vi
          .mocked(orsRoute)
          .mock.calls.map(([, r]) => r.waypoints)
          .filter((w) => !fromStart(w));
        expect(fills).toHaveLength(1);
        expect(result.runs[0]!.candidates.map((c) => c.kind)).toEqual([
          "generated",
        ]);
        expect(result.warnings.join(" ")).not.toMatch(/generation stopped/);
      });

      it("keeps the stitched routes already made when ORS fails", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockRejectedValue(handledRateLimit("orsRoute"));
        const result = await loadRouteSuggestions("k", args, ENV);
        expect(result.runs[0]!.candidates.map((c) => c.kind)).toEqual([
          "stitched",
        ]);
        expect(result.warnings.join(" ")).toMatch(/Route generation stopped/);
      });

      it("does not let a stitched duplicate of a past run open an extra generated slot", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NE, SF])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints),
        );
        // 3.8 km is over 5% past the 3.4 km base route, so ORS stretches it into several routes.
        const run = (
          await loadRouteSuggestions("k", { ...args, distanceKm: 3.8 }, ENV)
        ).runs[0]!;
        expect(
          run.candidates.filter((c) => c.kind === "generated"),
        ).toHaveLength(1);
      });

      it("drops a stitched route whose fill misses a via point by more than 100 m", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          // The fill from N passes 330 m north of NE, as ORS does when it snaps a via away.
          fromStart(request.waypoints)
            ? straightRoute(request.waypoints)
            : straightRoute([
                request.waypoints[0]!,
                [NE[0] + 0.003, NE[1]],
                SF,
              ]),
        );
        const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).not.toContain("stitched");
      });

      it("drops a stitched route whose fill goes by ferry", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) => ({
          ...straightRoute(request.waypoints),
          ferry_m: fromStart(request.waypoints) ? 0 : 50,
        }));
        const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).not.toContain("stitched");
      });

      it("warns with the nearest stitched route when only ORS routes meet the distance", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        // ORS loops from the start come out at 8 km; fills stay as routed.
        vi.mocked(orsRoute).mockImplementation(async (_key, request) => {
          const base = straightRoute(request.waypoints);
          return fromStart(request.waypoints)
            ? straightRoute(request.waypoints, 8000 / base.distance_m)
            : base;
        });
        const run = (
          await loadRouteSuggestions("k", { ...args, distanceKm: 8 }, ENV)
        ).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).toEqual(["generated"]);
        expect(run.warnings).toContainEqual(
          expect.stringMatching(
            /^A route along your past runs through the via points is \d\.\d km; ask for about \d\.\d km to see it\.$/,
          ),
        );
      });

      it("ranks stitched routes within 5% of the same share by distance to the target", async () => {
        // Two lines to a via 5.5 km north; each run starts a little off SF, so each has a short fill.
        const VIA_FAR: LatLng = [SF[0] + 0.0495, SF[1]];
        const bulge = (east: number): LatLng => [SF[0] + 0.02475, SF[1] + east];
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [
            // Longer line, longer gap (higher fill share), 14.1 km out and back.
            runOn("a", [[SF[0] + 0.0004, SF[1]], bulge(0.0246), VIA_FAR]),
            // Shorter line, shorter gap, 11.5 km out and back.
            runOn("b", [[SF[0] + 0.00029, SF[1]], bulge(0.0096), VIA_FAR]),
          ],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints),
        );
        const run = (
          await loadRouteSuggestions(
            "k",
            {
              distanceKm: 14,
              start: text(SF),
              via: [text(VIA_FAR)],
              shape: "out-and-back",
            },
            ENV,
          )
        ).runs[0]!;
        const own = run.candidates.filter((c) => c.kind === "stitched");
        expect(own.map((c) => c.distance_m / 1000)).toEqual([
          expect.closeTo(14.1, 0),
          expect.closeTo(11.5, 0),
        ]);
        expect(own[0]!.history_share!).toBeLessThan(own[1]!.history_share!);
      });

      it("offers the stitched route as the nearest when none reaches the distance", async () => {
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        // Every stretch is unroutable, so ORS offers only its 3.4 km base route; run b out and back
        // (SF, NE, N, NE, SF) is the 4.8 km stitched route, nearest to 8 km but over 25% short.
        vi.mocked(orsRoute).mockImplementation(async (_key, request) => {
          if (request.waypoints.length > 4)
            throw new OrsApiError("x", {
              status: 404,
              statusText: "",
              data: "",
            });
          return straightRoute(request.waypoints);
        });
        const run = (
          await loadRouteSuggestions("k", { ...args, distanceKm: 8 }, ENV)
        ).runs[0]!;
        expect(run.candidates.map((c) => c.kind)).toEqual(["stitched"]);
        expect(run.warnings).toContain(
          "No route through the via points came within 25% of 8.0 km; the nearest, 4.8 km, is offered: it follows your past runs between the via points, which cannot be stretched.",
        );
      });
    });
  });

  it("lets a cancellation through", async () => {
    vi.mocked(orsRoute).mockRejectedValue(new CallCancelledError("Request"));
    await expect(loadRouteSuggestions("k", {}, ENV)).rejects.toBeInstanceOf(
      CallCancelledError,
    );
  });
});
