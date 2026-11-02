import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import { CallCancelledError } from "./callScope";
import { RequestTimeoutError } from "./fetchClient";
import { type IntervalsEvent, listPlannedWorkouts } from "./intervalsClient";
import {
  cumulativeDistances,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { geocode, OrsApiError, type OrsRoute, orsRoute } from "./orsClient";
import { loadCrossings } from "./overpassClient";
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
): RouteTrack {
  const corners: LatLng[] = [
    [lat0, lng0],
    [lat0 + side, lng0],
    [lat0 + side, lng0 + side],
    [lat0, lng0 + side],
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
    expect(result.warnings.join(" ")).toMatch(/crossings could not be counted/);
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

  it("rescales a loop that misses the distance once", async () => {
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
    expect(lengths).toEqual([Math.round(target), Math.round(target / 2)]);
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
  ])("keeps past runs and warns on %s", async (_label, error, warning) => {
    vi.mocked(orsRoute).mockRejectedValue(error);
    const run = (await loadRouteSuggestions("k", {}, ENV)).runs[0]!;
    expect(run.candidates.map((c) => c.kind)).toEqual(["past"]);
    expect(run.warnings.join(" ")).toMatch(warning);
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

  it("takes every run in a days window and skips other sports", async () => {
    vi.mocked(listPlannedWorkouts).mockResolvedValue([
      event(10, "2026-11-04", 5000),
      { ...event(11, "2026-11-04", 30000), type: "Ride" },
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
      /did not answer in time/,
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
      ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map((d, i) =>
        event(20 + i, d, homeLoop.distance.at(-1)!),
      ),
    );
    // Away from home: 4 seeds a run, so three runs spend the 12 calls.
    const result = await loadRouteSuggestions(
      "k",
      { days: 7, start: "37.8,-122.3" },
      ENV,
    );
    expect(vi.mocked(orsRoute)).toHaveBeenCalledTimes(12);
    expect(result.runs[2]!.warnings.join(" ")).toMatch(/budget is spent/);
    expect(result.runs[3]!.candidates).toEqual([]);
  });

  it("lets a cancellation through", async () => {
    vi.mocked(orsRoute).mockRejectedValue(new CallCancelledError("Request"));
    await expect(loadRouteSuggestions("k", {}, ENV)).rejects.toBeInstanceOf(
      CallCancelledError,
    );
  });
});
