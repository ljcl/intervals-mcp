import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import { CallCancelledError } from "./callScope";
import { followsCorridor } from "./corridors";
import { RequestTimeoutError } from "./fetchClient";
import { type IntervalsEvent, listPlannedWorkouts } from "./intervalsClient";
import {
  cumulativeDistances,
  haversineMeters,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { geocode, OrsApiError, type OrsRoute, orsRoute } from "./orsClient";
import { osmIndexInfo, parkReach, routeOsmStats } from "./osmIndex";
import { passesInOrder, type RouteCandidate } from "./routeCandidates";
import { concatTracks } from "./routeGeometry";
import { listCorridors, type StoredRoute } from "./routeStore";
import {
  loadRouteSuggestions,
  nameDistanceM,
  RouteSuggestionError,
  routesNote,
  type SuggestionEnv,
  terrainMiss,
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
vi.mock("./osmIndex", async (o) => ({
  ...(await o<typeof import("./osmIndex")>()),
  routeOsmStats: vi.fn(),
  osmIndexInfo: vi.fn(),
  parkReach: vi.fn(),
}));
vi.mock("./routeStore", async (o) => ({
  ...(await o<typeof import("./routeStore")>()),
  listCorridors: vi.fn(),
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
  const last = track.coordinates.length - 1;
  const half = Math.floor(last / 2);
  return {
    track,
    distance_m,
    ascent_m: 10,
    path_share: 0.7,
    ferry_m: 0,
    way_names: ["Foreshore Walk", "Park Road"],
    // The first half on a path along Foreshore Walk, the second on Park Road.
    named_spans: [
      [0, half, "Foreshore Walk"],
      [half, last, "Park Road"],
    ],
    waytype_spans: [
      [0, half, 7],
      [half, last, 3],
    ],
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

const STATS = {
  crossings_per_km: 0,
  signals_per_km: 0,
  path_share: 0.7,
  main_road_km: 0,
  green_share: 0.4,
};

beforeEach(() => {
  vi.mocked(listPlannedWorkouts).mockResolvedValue([
    event(10, "2026-11-04", homeLoop.distance.at(-1)!),
  ]);
  vi.mocked(loadRunStarts).mockResolvedValue({ runs: history, skipped: 0 });
  vi.mocked(routeOsmStats).mockReset().mockReturnValue(STATS);
  vi.mocked(parkReach).mockReset().mockReturnValue(null);
  vi.mocked(osmIndexInfo).mockReset().mockReturnValue({
    state: "ready",
    data_date: "2026-11-01T00:00:00.000Z",
    age_days: 1,
  });
  vi.mocked(listCorridors).mockReset().mockResolvedValue([]);
  vi.mocked(geocode).mockReset();
  vi.mocked(orsRoute).mockReset();
  let n = 0;
  vi.mocked(orsRoute).mockImplementation(async () => route(generatedLoop(++n)));
});

describe("loadRouteSuggestions", () => {
  describe("scored", () => {
    const pastRun = (id: string, date: string, lat: number): RunStart => {
      const track = square(lat, SF[1], 0.0135);
      return {
        id,
        date,
        name: `Loop ${id}`,
        distance_m: track.distance.at(-1)!,
        climb_m: 20,
        track,
      };
    };

    it("gives every route a score and breakdown", async () => {
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      for (const c of run.candidates) {
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score_breakdown).toMatchObject({
          recency: expect.any(Number),
        });
        expect(c.known_share).toBeGreaterThanOrEqual(0);
        expect(c.retraced_km).toBeGreaterThanOrEqual(0);
        expect(c.notes).toEqual(expect.any(Array));
      }
    });

    it("puts a quiet new route ahead of a busy past run", async () => {
      vi.mocked(routeOsmStats).mockImplementation((t) =>
        t === homeLoop
          ? { ...STATS, crossings_per_km: 6, signals_per_km: 2 }
          : STATS,
      );
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      expect(run.candidates.map((c) => c.kind)).toEqual(["generated", "past"]);
      expect(run.candidates[0]!.score!).toBeGreaterThan(
        run.candidates[1]!.score!,
      );
    });

    it("drops a run from this week behind an equal older one", async () => {
      // Distinct loops from the same start (east and west of it), or dedupeRoutes keeps one.
      const older = pastRun("old", "2026-10-01", SF[0]);
      const recent = {
        ...pastRun("new", "2026-10-31", SF[0]),
        track: square(SF[0], SF[1], 0.0135, 0, -0.0135),
      };
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [recent, older],
        skipped: 0,
      });
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      const past = run.candidates.filter((c) => c.kind === "past");
      expect(past.map((c) => c.activity_id)).toEqual(["old", "new"]);
      expect(past[1]!.score_breakdown!.recency).toBe(-10);
    });

    it("keeps at most 2 past runs so a new route still comes back", async () => {
      // East, west and south of the start: three different loops of the same length.
      const shapes = [
        square(SF[0], SF[1], 0.0135),
        square(SF[0], SF[1], 0.0135, 0, -0.0135),
        square(SF[0], SF[1], -0.0135),
      ];
      const runs = ["a", "b", "c"].map((id, i) => ({
        ...pastRun(id, "2026-10-01", SF[0]),
        track: shapes[i]!,
      }));
      vi.mocked(loadRunStarts).mockResolvedValue({ runs, skipped: 0 });
      vi.mocked(routeOsmStats).mockImplementation((t) =>
        runs.some((r) => r.track === t)
          ? STATS
          : { ...STATS, crossings_per_km: 4 },
      );
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      expect(run.candidates.map((c) => c.kind)).toEqual([
        "past",
        "past",
        "generated",
      ]);
    });

    it("keeps one generated route though two seeds beat a past run", async () => {
      vi.mocked(routeOsmStats).mockImplementation((t) =>
        t === homeLoop
          ? { ...STATS, crossings_per_km: 6, signals_per_km: 2 }
          : STATS,
      );
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      expect(run.candidates.filter((c) => c.kind === "generated")).toHaveLength(
        1,
      );
      expect(run.candidates.map((c) => c.kind)).toContain("past");
    });

    /** The first seed (both of its tries) gives `first`, later seeds `second`; `first` scores better. */
    const twoSeeds = (first: OrsRoute, second: OrsRoute) => {
      let firstSeed: number | undefined;
      vi.mocked(orsRoute).mockImplementation(async (_key, req) => {
        const seed = req.roundTrip?.seed;
        firstSeed ??= seed;
        return seed === firstSeed ? first : second;
      });
      vi.mocked(routeOsmStats).mockImplementation((t) =>
        t === first.track ? STATS : { ...STATS, crossings_per_km: 6 },
      );
    };

    it("returns the flat seed for a flat request though the hilly one scores higher", async () => {
      const hilly = route(square(SF[0] - 0.02, SF[1], 0.0135, 300));
      const flat = route(generatedLoop(2));
      twoSeeds(hilly, flat);
      const run = (await loadRouteSuggestions("k", { terrain: "flat" }, ENV))
        .runs[0]!;
      const generated = run.candidates.filter((c) => c.kind === "generated");
      expect(generated).toHaveLength(1);
      expect(generated[0]!.track).toBe(flat.track);
    });

    it("returns the on-target seed without vias though a 20% short one scores higher", async () => {
      const short = route(square(SF[0] - 0.02, SF[1], 0.0108));
      const onTarget = route(generatedLoop(2));
      twoSeeds(short, onTarget);
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      const generated = run.candidates.filter((c) => c.kind === "generated");
      expect(generated).toHaveLength(1);
      expect(generated[0]!.track).toBe(onTarget.track);
    });

    it("leaves known lines unmeasured with fewer than 3 runs loaded", async () => {
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      for (const c of run.candidates) {
        expect(c.known_share).toBe(0);
        expect(c.score_breakdown!.known_lines).toBeNull();
      }
    });

    it("scores routes the OSM index cannot measure", async () => {
      vi.mocked(routeOsmStats).mockReturnValue(null);
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      expect(run.candidates.length).toBeGreaterThan(0);
      for (const c of run.candidates) {
        expect(c.score_breakdown!.crossings).toBeNull();
        expect(c.score).toBeGreaterThan(0);
      }
    });
  });

  it("offers a past run and one new loop from the usual start", async () => {
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

  it("describes a new out-and-back by its out leg only", async () => {
    // Off the OSM index, so path share is ORS's.
    vi.mocked(routeOsmStats).mockReturnValue(null);
    const run = (
      await loadRouteSuggestions("k", { shape: "out-and-back" }, ENV)
    ).runs[0]!;
    const made = run.candidates.find((c) => c.kind === "generated")!;
    expect(made.summary).toBe("via Foreshore Walk");
    expect(made.path_share).toBe(1);
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

  it("plans a one-off run today for a distance with no date, without reading the calendar", async () => {
    vi.mocked(listPlannedWorkouts).mockClear();
    const result = await loadRouteSuggestions("k", { distanceKm: 6 }, ENV);
    expect(vi.mocked(listPlannedWorkouts)).not.toHaveBeenCalled();
    expect(result.runs[0]).toMatchObject({
      event_id: null,
      name: "Run",
      date: ENV.today,
      distance_source: "argument",
    });
  });

  it("reads the calendar for a distance with a date or days above 1", async () => {
    vi.mocked(listPlannedWorkouts).mockClear();
    const dated = await loadRouteSuggestions(
      "k",
      { distanceKm: 6, date: "2026-11-04" },
      ENV,
    );
    expect(dated.runs[0]!.event_id).toBe(10);
    await loadRouteSuggestions("k", { distanceKm: 6, days: 2 }, ENV);
    expect(vi.mocked(listPlannedWorkouts)).toHaveBeenCalledTimes(2);
  });

  describe("a planned run's name and stored distance (#457)", () => {
    it("reads the first run distance a name gives, not a rep's", () => {
      expect(nameDistanceM("Easy 6.5 km with light fartlek")).toBe(6500);
      expect(nameDistanceM("10K race")).toBe(10_000);
      expect(nameDistanceM("Long 5 mi")).toBeCloseTo(8046.7, 1);
      expect(nameDistanceM("Tempo 8km incl. 3x1km")).toBe(8000);
      expect(nameDistanceM("6x1km reps")).toBeNull();
      expect(nameDistanceM("6 x 1 km reps")).toBeNull();
      expect(nameDistanceM("Intervals 6x800m")).toBeNull();
      expect(nameDistanceM("Easy run")).toBeNull();
    });

    const named = (name: string) =>
      vi
        .mocked(listPlannedWorkouts)
        .mockResolvedValue([event(10, "2026-11-04", 3126, name)]);
    const mismatch =
      '"Easy 6.5 km with light fartlek" names 6.5 km, but the planned run is stored as 3.1 km, which this plan uses; pass distanceKm to plan for the named distance.';

    it("warns with both distances when they disagree", async () => {
      named("Easy 6.5 km with light fartlek");
      const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
      expect(run.distance_m).toBe(3126);
      expect(run.warnings).toContain(mismatch);
    });

    it("does not warn when the name agrees, has no distance, or distanceKm is passed", async () => {
      for (const name of ["Easy 3 km", "Easy run"]) {
        named(name);
        const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
        expect(run.warnings.some((w) => w.includes("names"))).toBe(false);
      }
      named("Easy 6.5 km with light fartlek");
      const run = (await loadRouteSuggestions("k", { distanceKm: 6.5 }, ENV))
        .runs[0]!;
      expect(run.warnings).not.toContain(mismatch);
    });
  });

  describe("terrain no route fits (#458)", () => {
    const bands = { flatBelow: 10, hillyAbove: 20 };
    const climbing = (...perKm: number[]) =>
      perKm.map(
        (c) => ({ climb_m: c * 6, distance_m: 6000 }) as RouteCandidate,
      );

    it("names the terrain, its band and the climb on offer", () => {
      expect(terrainMiss("flat", climbing(33.7, 43.3), bands)).toBe(
        "No route offered is flat (at most 10 m of climb per km); they climb 33.7-43.3 m per km.",
      );
      expect(terrainMiss("hilly", climbing(12), bands)).toBe(
        "No route offered is hilly (over 20 m of climb per km); they climb 12 m per km.",
      );
      expect(terrainMiss("rolling", climbing(4, 25), bands)).toBe(
        "No route offered is rolling (10-20 m of climb per km); they climb 4-25 m per km.",
      );
    });

    it("is quiet when one route fits, for any and hill-repeats, and with none offered", () => {
      expect(terrainMiss("flat", climbing(30, 8), bands)).toBeNull();
      expect(terrainMiss("any", climbing(30), bands)).toBeNull();
      expect(terrainMiss("hill-repeats", climbing(2), bands)).toBeNull();
      expect(terrainMiss("flat", [], bands)).toBeNull();
    });

    it("warns on the run", async () => {
      const run = (await loadRouteSuggestions("k", { terrain: "hilly" }, ENV))
        .runs[0]!;
      expect(
        run.warnings.some((w) => w.startsWith("No route offered is hilly")),
      ).toBe(true);
    });
  });

  describe("planned runs already done (#386)", () => {
    const loop = homeLoop.distance.at(-1)!;
    const doneEvent = (id: number, date: string, name: string) => ({
      ...event(id, date, loop, name),
      paired_activity_id: `i${id}`,
    });

    it("plans the next run when today's is already done", async () => {
      vi.mocked(listPlannedWorkouts).mockResolvedValue([
        doneEvent(10, "2026-11-03", "Easy 6 km"),
        event(11, "2026-11-05", loop, "Long run"),
        doneEvent(12, "2026-11-08", "Later"),
      ]);
      const result = await loadRouteSuggestions("k", {}, ENV);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ event_id: 11, name: "Long run" });
      // Only the done run the plan passed over is named.
      expect(result.warnings).toContain(
        "Left out a planned run already done: Easy 6 km (2026-11-03).",
      );
    });

    it("still chooses a run planned for today that is not done", async () => {
      vi.mocked(listPlannedWorkouts).mockResolvedValue([
        { ...event(10, "2026-11-03", loop), paired_activity_id: null },
        event(11, "2026-11-05", loop),
      ]);
      const result = await loadRouteSuggestions("k", {}, ENV);
      expect(result.runs[0]!.event_id).toBe(10);
      expect(result.warnings.filter((w) => /already done/.test(w))).toEqual([]);
    });

    it("leaves done runs out of a week and names them", async () => {
      vi.mocked(listPlannedWorkouts).mockResolvedValue([
        doneEvent(10, "2026-11-03", "Easy 6 km"),
        event(11, "2026-11-05", loop),
        doneEvent(12, "2026-11-06", "Tempo"),
      ]);
      const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
      expect(result.runs.map((r) => r.event_id)).toEqual([11]);
      expect(result.warnings).toContain(
        "Left out 2 planned runs already done: Easy 6 km (2026-11-03), Tempo (2026-11-06).",
      );
    });

    it("says every planned run is done when none is left", async () => {
      vi.mocked(listPlannedWorkouts).mockResolvedValue([
        doneEvent(10, "2026-11-03", "Easy 6 km"),
      ]);
      await expect(loadRouteSuggestions("k", {}, ENV)).rejects.toThrow(
        "No planned run from 2026-11-03 to 2026-11-16 is still to do: Easy 6 km (2026-11-03) is already done. Pass distanceKm to plan a route anyway.",
      );
      // A date makes it read the calendar; distanceKm alone is a one-off.
      const result = await loadRouteSuggestions(
        "k",
        { distanceKm: 6, date: ENV.today },
        ENV,
      );
      expect(result.runs[0]).toMatchObject({ event_id: null, name: "Run" });
      expect(result.warnings.some((w) => /already done/.test(w))).toBe(true);
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
    vi.mocked(routeOsmStats).mockImplementation((t) =>
      t.coordinates[0]![0] === busyStart[0] &&
      t.coordinates[0]![1] === busyStart[1]
        ? { ...STATS, crossings_per_km: 9 }
        : STATS,
    );
    const run = (await loadRouteSuggestions("k", { start: "37.8,-122.3" }, ENV))
      .runs[0]!;
    expect(
      run.candidates.map((c) => c.track.coordinates[0]),
    ).not.toContainEqual(busyStart);
  });

  it.each([
    [
      { state: "unconfigured" } as const,
      "Road crossings, signals and main roads were not counted: no OpenStreetMap index is configured (OSM_EXTRACT_URL and HOME_START), so route scores leave out crossings, main roads and green.",
    ],
    [
      { state: "missing" } as const,
      "Road crossings, signals and main roads were not counted: the OpenStreetMap index has not been built yet (see the server log), so route scores leave out crossings, main roads and green.",
    ],
    [
      {
        state: "ready",
        data_date: "2026-11-01T00:00:00.000Z",
        age_days: 1,
      } as const,
      "Road crossings, signals and main roads were not counted for routes outside the OpenStreetMap index (25 km around HOME_START), so route scores leave out crossings, main roads and green.",
    ],
  ])("warns once when routes are not indexed (%o)", async (info, warning) => {
    vi.mocked(routeOsmStats).mockReturnValue(null);
    vi.mocked(osmIndexInfo).mockReturnValue(info);
    const result = await loadRouteSuggestions("k", {}, ENV);
    expect(result.warnings.filter((w) => /were not counted/.test(w))).toEqual([
      warning,
    ]);
    const { candidates } = result.runs[0]!;
    const past = candidates.find((c) => c.kind === "past");
    const generated = candidates.find((c) => c.kind === "generated");
    expect(past!.crossings_per_km).toBeNull();
    expect(past!.path_share).toBeNull();
    expect(generated!.path_share).toBe(0.7);
    expect(generated!.signals_per_km ?? null).toBeNull();
  });

  it("measures every candidate kind from the index", async () => {
    vi.mocked(routeOsmStats).mockReturnValue({
      ...STATS,
      path_share: 0.91,
      signals_per_km: 1.5,
    });
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    for (const c of run.candidates)
      expect(c).toMatchObject({
        path_share: 0.91,
        signals_per_km: 1.5,
        main_road_km: 0,
        green_share: 0.4,
      });
  });

  it("warns when the index has not been refreshed in two weeks", async () => {
    vi.mocked(osmIndexInfo).mockReturnValue({
      state: "ready",
      data_date: "2026-10-01T00:00:00.000Z",
      age_days: 15,
    });
    const result = await loadRouteSuggestions("k", {}, ENV);
    expect(result.warnings).toContain(
      "The OpenStreetMap index was last refreshed 15 days ago; its weekly refresh is failing (see the server log).",
    );
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
      "2 recent runs had no GPS track and were left out of the start history.",
    );
  });

  it("warns once per call across runs when routes are not indexed", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", homeLoop.distance.at(-1)!),
      event(11, "2026-11-06", homeLoop.distance.at(-1)!),
    ]);
    vi.mocked(routeOsmStats).mockReturnValue(null);
    const result = await loadRouteSuggestions("k", { days: 7 }, ENV);
    expect(
      result.warnings.filter((w) => /were not counted/.test(w)),
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

  it("refuses a via whose match lacks words of the text", async () => {
    vi.mocked(geocode).mockResolvedValue({
      label: "Foreshore Promenade, Pyrmont, NSW, Australia",
      point: VIA,
      match: {
        query: "Glebe Foreshore Walk",
        name: "Foreshore Promenade",
        type: "street",
        missing: ["glebe", "walk"],
      },
    });
    await expect(
      loadRouteSuggestions(
        "k",
        { distanceKm: 6, via: "Glebe Foreshore Walk" },
        ENV,
      ),
    ).rejects.toThrow(
      '"Glebe Foreshore Walk" matched only Foreshore Promenade, which has no "glebe" or "walk", so it was not routed; check the name, or pass lat,lng.',
    );
    expect(vi.mocked(orsRoute)).not.toHaveBeenCalled();
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

    it("orders a route within 25% of the distance before a past run far over it (#459)", async () => {
      // The 6 km home loop passes the via and scores far better; the plan is 3.2 km.
      vi.mocked(routeOsmStats).mockImplementation((t) =>
        t === homeLoop
          ? STATS
          : { ...STATS, crossings_per_km: 6, signals_per_km: 2 },
      );
      const run = (
        await loadRouteSuggestions(
          "k",
          { distanceKm: 3.2, via: text(VIA) },
          ENV,
        )
      ).runs[0]!;
      expect(run.candidates.map((c) => c.kind)).toEqual(["generated", "past"]);
      expect(run.candidates[1]!.score!).toBeGreaterThan(
        run.candidates[0]!.score!,
      );
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

      it("returns the 3 best of more routes than that, cutting the lowest score", async () => {
        const SE: LatLng = [SF[0] - 0.009, SF[1] + 0.0114];
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [
            runOn("a", [SF, N, NORTH_MORE]),
            runOn("b", [N, NE, SF]),
            runOn("c", [SF, N, NE, SF]),
            runOn("d", [SF, N, NE, SE, SF]),
          ],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints, 1.2),
        );
        const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
        // Four routes pass the per-kind caps (2 past, 1 generated, 1 stitched); the lowest score, run d, is cut.
        expect(run.candidates).toHaveLength(3);
        const scores = run.candidates.map((c) => c.score!);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        const ids = run.candidates.map((c) => c.activity_id);
        expect(ids).toContain("c");
        expect(ids).not.toContain("d");
      });

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

      it("counts a named park as passed at its edge", async () => {
        // The park's looked-up point is about 300 m off every run; both runs pass the park at N.
        const parkPoint: LatLng = [N[0] - 0.0027, N[1] + 0.0033];
        vi.mocked(geocode).mockResolvedValue({
          label: "Jubilee Park, Glebe, NSW, Australia",
          point: parkPoint,
          match: {
            query: "Jubilee Park",
            name: "Jubilee Park",
            type: "venue",
            missing: [],
          },
        });
        vi.mocked(parkReach).mockReturnValue(
          (p) => haversineMeters(p, N) <= 100,
        );
        vi.mocked(loadRunStarts).mockResolvedValue({
          runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
          skipped: 0,
        });
        vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
          straightRoute(request.waypoints, 1.2),
        );
        const run = (
          await loadRouteSuggestions(
            "k",
            { ...args, via: ["Jubilee Park", text(NE)] },
            ENV,
          )
        ).runs[0]!;
        expect(vi.mocked(parkReach)).toHaveBeenCalledWith(
          parkPoint,
          "Jubilee Park",
          100,
        );
        const stitched = run.candidates.find((c) => c.kind === "stitched")!;
        expect(stitched).toBeDefined();
        // The two runs pass the park 140 m apart; the join between them skips its point.
        expect(stitched.history_share).toBeGreaterThan(0.9);
        const fills = vi
          .mocked(orsRoute)
          .mock.calls.map(([, r]) => r.waypoints)
          .filter((w) => !fromStart(w));
        expect(fills).toHaveLength(1);
        expect(fills[0]).not.toContainEqual(parkPoint);
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

  describe("corridor vias", () => {
    /** About 1 km north of SF, about 1 km east of that, and 2 km north. */
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
    /** A saved corridor from `a` to `b`, stored as two segments. */
    function corridor(
      name: string,
      a: LatLng,
      b: LatLng,
      one_way = false,
    ): StoredRoute {
      const mid: LatLng = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const segment = (id: string, points: LatLng[]) => ({
        id,
        kind: "activity" as const,
        label: name,
        source: {
          type: "activity" as const,
          activity_id: "i9",
          from_km: 0,
          to_km: 1,
        },
        track: straightRoute(points).track,
        climb_m: 0,
        climb_source: "recorded" as const,
        path_share: null,
        vias: [],
        flexible: false,
        notes: [],
      });
      return {
        format: 1,
        route_id: `c-${name}`,
        name,
        kind: "corridor",
        one_way,
        created_at: "2026-10-01T00:00:00.000Z",
        next_id: 3,
        segments: { g1: segment("g1", [a, mid]), g2: segment("g2", [mid, b]) },
        versions: [
          {
            version: 1,
            parent: null,
            created_at: "2026-10-01T00:00:00.000Z",
            change: "Saved",
            segment_ids: ["g1", "g2"],
            warnings: [],
          },
        ],
      };
    }
    const trackOf = (route: StoredRoute) =>
      concatTracks(Object.values(route.segments).map((s) => s.track));
    const bayRun = corridor("Bay Run", N, NE);
    const bayLeg = { track: trackOf(bayRun), entry: N, exit: NE };
    const args = { distanceKm: 3.5, start: text(SF), via: "bay run" };

    beforeEach(() => {
      vi.mocked(listCorridors).mockResolvedValue([bayRun]);
      vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
        straightRoute(request.waypoints, 1.2),
      );
    });

    it("runs a corridor named like a real place, with no ORS key and no lookup", async () => {
      vi.mocked(geocode).mockResolvedValue({
        label: "Bay Run, Sydney, NSW, Australia",
        point: [-33.86, 151.15],
        match: { query: "Bay Run", name: "Bay Run", type: "street" },
      });
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("a", [SF, N, NORTH_MORE]), runOn("b", [N, NE, SF])],
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(vi.mocked(geocode)).not.toHaveBeenCalled();
      expect(vi.mocked(orsRoute)).not.toHaveBeenCalled();
      expect(run.via).toEqual([
        {
          label: "Bay Run",
          point: N,
          corridor: { route_id: "c-Bay Run", name: "Bay Run", reversed: false },
        },
      ]);
      const stitched = run.candidates.find((c) => c.kind === "stitched")!;
      expect(stitched.summary).toBe(
        "From 2 past runs: Run a 2026-10-01, Run b 2026-10-01; corridor: Bay Run",
      );
      expect(followsCorridor(stitched.track, bayLeg)).toBe(true);
      expect(stitched.history_share).toBeGreaterThan(0.99);
    });

    it("routes only the fills, and generates no route", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("a", [SF, N, NORTH_MORE])],
        skipped: 0,
      });
      const result = await loadRouteSuggestions("k", args, ENV);
      const run = result.runs[0]!;
      expect(vi.mocked(orsRoute).mock.calls.map(([, r]) => r)).toEqual([
        { waypoints: [NE, SF] },
        { waypoints: [SF, NE] },
      ]);
      expect(run.candidates.map((c) => c.kind)).toEqual(["stitched"]);
      expect(passesInOrder(run.candidates[0]!.track, [N, NE])).toBe(true);
      expect([...run.warnings, ...result.warnings].join(" ")).not.toMatch(
        /generated|generation/,
      );
    });

    it("shares fills between planned runs", async () => {
      vi.mocked(listPlannedWorkouts).mockResolvedValue([
        event(10, "2026-11-04", 3500),
        event(11, "2026-11-06", 3500),
      ]);
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("a", [SF, N, NORTH_MORE])],
        skipped: 0,
      });
      const result = await loadRouteSuggestions(
        "k",
        { days: 7, start: text(SF), via: "bay run" },
        ENV,
      );
      expect(result.runs).toHaveLength(2);
      // One fill per direction, routed once across both runs.
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(2);
    });

    it("says why a corridor run has no route when there is no ORS key", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(run.candidates).toEqual([]);
      expect(run.warnings.join(" ")).toContain(
        "Joining a corridor to the rest of the route needs ORS_API_KEY",
      );
    });

    it("names an ORS failure, not the budget, when a corridor cannot be joined", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
      vi.mocked(orsRoute).mockRejectedValue(
        new OrsApiError("x", { status: 403, statusText: "", data: "" }),
      );
      const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
      expect(run.candidates).toEqual([]);
      const text = run.warnings.join(" ");
      expect(text).toContain("No route along the corridor could be joined: ");
      expect(text).not.toContain("budget is spent");
    });

    it("keeps a $ in a corridor name literal in the refusal hint", async () => {
      vi.mocked(listCorridors).mockResolvedValue([
        corridor("Bay $& Run", N, NE),
      ]);
      vi.mocked(geocode).mockResolvedValue({
        label: "Bay, NSW, Australia",
        point: SF,
        match: { query: "Bay", name: "Bay", type: "locality" },
      });
      await expect(
        loadRouteSuggestions("k", { ...args, via: "Bay" }, ENV),
      ).rejects.toThrow('or use the saved corridor "Bay $& Run".');
    });

    it("may spend more than the stitch fill share of the budget on fills", async () => {
      // Four corridors round a 1 km square, 100 m short of each corner: five fills.
      const E: LatLng = [SF[0], SF[1] + 0.0114];
      const lat = 0.0009;
      const lng = 0.00114;
      const sides = [
        corridor("Alpha path", [SF[0] + lat, SF[1]], [N[0] - lat, N[1]]),
        corridor("Bravo path", [N[0], N[1] + lng], [NE[0], NE[1] - lng]),
        corridor("Charlie path", [NE[0] - lat, NE[1]], [E[0] + lat, E[1]]),
        corridor("Delta path", [E[0], E[1] - lng], [SF[0], SF[1] + lng]),
      ];
      vi.mocked(listCorridors).mockResolvedValue(sides);
      vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
      vi.mocked(orsRoute).mockImplementation(async (_key, request) =>
        straightRoute(request.waypoints),
      );
      const run = (
        await loadRouteSuggestions(
          "k",
          {
            distanceKm: 4,
            start: text(SF),
            via: ["Alpha path", "Bravo path", "Charlie path", "Delta path"],
          },
          ENV,
        )
      ).runs[0]!;
      // Five for the stored directions, the rest for the 3 next-cheapest combinations.
      expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(11);
      const stitched = run.candidates.find((c) => c.kind === "stitched")!;
      expect(stitched.summary).toBe(
        "From your corridors; corridors: Alpha path, Bravo path, Charlie path, Delta path; 0.6 km routed by OpenRouteService",
      );
      for (const side of sides) {
        const track = trackOf(side);
        expect(
          followsCorridor(stitched.track, {
            track,
            entry: track.coordinates[0]!,
            exit: track.coordinates.at(-1)!,
          }),
        ).toBe(true);
      }
    });

    it("runs a corridor from its nearer end, unless it is one-way", async () => {
      // Stored from NE to N; an out-and-back from SF reaches N first.
      const westward = corridor("Bay Run", NE, N);
      vi.mocked(listCorridors).mockResolvedValue([westward]);
      const outAndBack = { ...args, shape: "out-and-back" as const };
      const run = (await loadRouteSuggestions("k", outAndBack, ENV)).runs[0]!;
      expect(run.via[0]).toMatchObject({
        point: N,
        corridor: { reversed: true },
      });
      vi.mocked(listCorridors).mockResolvedValue([
        corridor("Bay Run", NE, N, true),
      ]);
      const oneWay = (await loadRouteSuggestions("k", outAndBack, ENV))
        .runs[0]!;
      expect(oneWay.via[0]).toMatchObject({
        point: NE,
        corridor: { reversed: false },
      });
    });

    it("keeps a past run only when it runs the whole corridor", async () => {
      const detour: LatLng = [N[0] + 0.003, N[1] + 0.0057];
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [
          runOn("full", [SF, N, NE, SF]),
          runOn("leaves", [SF, N, detour, NE, SF]),
        ],
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(
        run.candidates
          .filter((c) => c.kind === "past")
          .map((c) => c.activity_id),
      ).toEqual(["full"]);
    });

    it("takes the other direction when the straight-line best one's join retraces the corridor", async () => {
      // North of the corridor's middle. Out of NE the streets run back along the corridor to N first: a bay the straight line crosses.
      const P: LatLng = [N[0] + 0.0045, N[1] + 0.0057];
      vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
      vi.mocked(orsRoute).mockImplementation(async (_key, { waypoints }) =>
        straightRoute(
          haversineMeters(waypoints[0]!, NE) < 1
            ? [NE, N, ...waypoints.slice(1)]
            : waypoints,
        ),
      );
      const run = (
        await loadRouteSuggestions(
          "k",
          { distanceKm: 5, start: text(SF), via: ["bay run", text(P)] },
          ENV,
        )
      ).runs[0]!;
      const [first, second] = run.candidates;
      expect(run.via[0]).toMatchObject({
        point: NE,
        corridor: { reversed: true },
      });
      expect(passesInOrder(first!.track, [NE, N, P])).toBe(true);
      expect(second!.retraced_km).toBeGreaterThan(0.5);
      expect(first!.retraced_km).toBeLessThan(second!.retraced_km!);
    });

    it("finds a past run that takes the corridor the other way", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("rev", [SF, NE, N, SF])],
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(run.candidates.map((c) => c.activity_id)).toEqual(["rev"]);
      expect(run.via[0]).toMatchObject({ corridor: { reversed: true } });
    });

    it("reports the likeliest direction when no route comes back", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(run.candidates).toEqual([]);
      expect(run.via[0]).toMatchObject({ corridor: { reversed: false } });
    });

    it("says why a corridor run has only one route", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("full", [SF, N, NE, SF])],
        skipped: 0,
      });
      const run = (
        await loadRouteSuggestions("k", args, { ...ENV, orsKey: null })
      ).runs[0]!;
      expect(run.candidates).toHaveLength(1);
      expect(run.routes_note).toMatch(
        /^Only 1 route: a corridor is run as saved/,
      );
    });

    it("returns the same routes for the same call", async () => {
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("a", [SF, N, NORTH_MORE])],
        skipped: 0,
      });
      const first = await loadRouteSuggestions("k", args, ENV);
      const second = await loadRouteSuggestions("k", args, ENV);
      expect(first.runs[0]!.candidates.length).toBeGreaterThan(0);
      expect(second.runs[0]!.candidates).toEqual(first.runs[0]!.candidates);
    });

    it("names a saved corridor when a looked-up via is refused", async () => {
      vi.mocked(listCorridors).mockResolvedValue([
        corridor("Glebe foreshore", N, NE),
      ]);
      vi.mocked(geocode).mockResolvedValue({
        label: "Glebe, NSW, Australia",
        point: SF,
        match: { query: "Glebe", name: "Glebe", type: "locality" },
      });
      await expect(
        loadRouteSuggestions("k", { ...args, via: "Glebe" }, ENV),
      ).rejects.toThrow(
        '"Glebe" matched only Glebe (a locality), so it was not routed; try the place name without its suburb or city, or pass lat,lng, or use the saved corridor "Glebe foreshore".',
      );
    });

    it("scores a corridor route outside the OpenStreetMap index", async () => {
      vi.mocked(routeOsmStats).mockReturnValue(null);
      vi.mocked(loadRunStarts).mockResolvedValue({
        runs: [runOn("a", [SF, N, NORTH_MORE])],
        skipped: 0,
      });
      const run = (await loadRouteSuggestions("k", args, ENV)).runs[0]!;
      const stitched = run.candidates.find((c) => c.kind === "stitched")!;
      expect(stitched.score).toBeGreaterThan(0);
      expect(stitched.score_breakdown).toMatchObject({
        crossings: null,
        main_roads: null,
        green: null,
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

describe("routesNote", () => {
  const of = (...kinds: string[]) =>
    kinds.map((kind) => ({ kind })) as unknown as Parameters<
      typeof routesNote
    >[0];

  it("is null at none or three", () => {
    expect(routesNote(of(), false)).toBeNull();
    expect(routesNote(of("past", "past", "generated"), false)).toBeNull();
  });

  it("counts each kind that came back, leaving out zeros", () => {
    expect(routesNote(of("past", "generated"), false)).toBe(
      "Only 2 routes: 1 past run fit, 1 new route was kept.",
    );
    expect(routesNote(of("stitched"), false)).toBe(
      "Only 1 route: 1 route built from your runs.",
    );
    expect(routesNote(of("past", "past"), false)).toBe(
      "Only 2 routes: 2 past runs fit.",
    );
  });

  it("explains a corridor via", () => {
    expect(routesNote(of("past"), true)).toBe(
      "Only 1 route: a corridor is run as saved, so no new route is generated; only past runs along it and routes joined from your runs count.",
    );
  });
});
