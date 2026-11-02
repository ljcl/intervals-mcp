import { describe, expect, it } from "vitest";
import {
  cumulativeDistances,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import {
  DEFAULT_TERRAIN_BANDS,
  matchPastRuns,
  outAndBack,
  type RouteCandidate,
  rankGenerated,
  rankPast,
  sameRoute,
  terrainBands,
  terrainFits,
  trackClimb,
} from "./routeCandidates";
import { type RunStart } from "./startClusters";

/** A square loop from (lat0, lng0) with side `side` degrees. */
function square(lat0: number, lng0: number, side: number): RouteTrack {
  const corners: LatLng[] = [
    [lat0, lng0],
    [lat0 + side, lng0],
    [lat0 + side, lng0 + side],
    [lat0, lng0 + side],
    [lat0, lng0],
  ];
  const coordinates: LatLng[] = [];
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 10; k++) {
      const [a, b] = [corners[c]!, corners[c + 1]!];
      coordinates.push([
        a[0] + ((b[0] - a[0]) * k) / 10,
        a[1] + ((b[1] - a[1]) * k) / 10,
      ]);
    }
  }
  coordinates.push(corners[4]!);
  return {
    coordinates,
    distance: cumulativeDistances(coordinates),
    altitude: coordinates.map(() => 10),
  };
}

function run(
  id: string,
  date: string,
  track: RouteTrack,
  climb_m = 20,
): RunStart {
  return {
    id,
    date,
    name: id,
    distance_m: track.distance.at(-1)!,
    climb_m,
    track,
  };
}

function candidate(overrides: Partial<RouteCandidate>): RouteCandidate {
  return {
    kind: "generated",
    activity_id: null,
    name: "n",
    date: null,
    shape: "loop",
    distance_m: 6000,
    climb_m: 20,
    path_share: 0.5,
    crossings_per_km: null,
    hill: null,
    summary: "",
    track: loopA,
    ...overrides,
  };
}

const loopA = square(37.79, -122.39, 0.0135);
const loopB = square(37.79, -122.39, -0.0135);
const BANDS = { flatBelow: 4, hillyAbove: 8 };

describe("terrainBands", () => {
  it("takes the athlete's thirds, defaults with few runs", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
      ...run(`r${i}`, "2026-10-01", loopA),
      distance_m: 1000,
      climb_m: i + 1,
    }));
    expect(terrainBands(runs)).toEqual({ flatBelow: 4, hillyAbove: 8 });
    expect(terrainBands(runs.slice(0, 9))).toEqual(DEFAULT_TERRAIN_BANDS);
  });
});

describe("terrainFits", () => {
  it("bands climb per km by the athlete's thirds", () => {
    expect(terrainFits("flat", 3, 1000, BANDS)).toBe(true);
    expect(terrainFits("flat", 5, 1000, BANDS)).toBe(false);
    expect(terrainFits("rolling", 5, 1000, BANDS)).toBe(true);
    expect(terrainFits("hilly", 9, 1000, BANDS)).toBe(true);
    expect(terrainFits("any", 99, 1000, BANDS)).toBe(true);
    expect(terrainFits("hill-repeats", 0, 1000, BANDS)).toBe(true);
  });
});

describe("trackClimb", () => {
  it("counts rises of 3 m or more and skips gaps", () => {
    expect(trackClimb([10, 12, null, 11, 15, 14])).toBe(5);
  });
});

describe("matchPastRuns", () => {
  const target = loopA.distance.at(-1)!;
  const options = {
    target_m: target,
    shape: "loop" as const,
    terrain: "any" as const,
    today: "2026-11-03",
    exclude: new Set<string>(),
    bands: BANDS,
  };

  it("prefers runs not repeated this week, without duplicate routes", () => {
    const runs = [
      run("recent", "2026-11-01", loopA),
      run("old-a", "2026-10-01", loopA),
      run("old-b", "2026-09-01", loopB),
    ];
    const picked = matchPastRuns(runs, options);
    expect(picked.map((c) => c.activity_id)).toEqual(["old-a", "old-b"]);
    expect(picked[0]).toMatchObject({
      kind: "past",
      shape: "loop",
      date: "2026-10-01",
      crossings_per_km: null,
    });
  });

  it("drops excluded runs, non-loops, wrong distance and wrong terrain", () => {
    const line: RouteTrack = {
      coordinates: [
        [37.79, -122.39],
        [37.85, -122.39],
      ],
      distance: [0, 6600],
      altitude: [1, 1],
    };
    const runs = [
      run("excluded", "2026-10-01", loopA),
      run("line", "2026-10-01", line),
      run("short", "2026-10-01", square(37.79, -122.39, 0.009)),
      run("steep", "2026-10-01", loopB, 200),
    ];
    expect(
      matchPastRuns(runs, {
        ...options,
        terrain: "flat",
        exclude: new Set(["excluded"]),
      }),
    ).toEqual([]);
  });

  it("offers nothing for point-to-point", () => {
    expect(
      matchPastRuns([run("a", "2026-10-01", loopA)], {
        ...options,
        shape: "point-to-point",
      }),
    ).toEqual([]);
  });
});

describe("rankPast", () => {
  it("ranks fewer crossings ahead of a closer distance", () => {
    const busy = candidate({
      kind: "past",
      name: "busy",
      date: "2026-10-01",
      distance_m: 6000,
      crossings_per_km: 30,
    });
    const quiet = candidate({
      kind: "past",
      name: "quiet",
      date: "2026-10-02",
      distance_m: 6300,
      crossings_per_km: 20,
    });
    const recent = candidate({
      kind: "past",
      name: "recent",
      date: "2026-11-01",
      distance_m: 6000,
      crossings_per_km: 1,
    });
    expect(
      rankPast([recent, busy, quiet], 6000, "2026-11-03").map((c) => c.name),
    ).toEqual(["quiet", "busy", "recent"]);
  });
});

describe("rankGenerated", () => {
  it("puts terrain fit first, then crossings, then path share", () => {
    const steep = candidate({
      name: "steep",
      climb_m: 60,
      crossings_per_km: 1,
    });
    const busy = candidate({
      name: "busy",
      climb_m: 20,
      crossings_per_km: 30,
      path_share: 0.9,
    });
    const quiet = candidate({
      name: "quiet",
      climb_m: 20,
      crossings_per_km: 10,
      path_share: 0.2,
    });
    expect(
      rankGenerated([steep, busy, quiet], "flat", 6000, BANDS).map(
        (c) => c.name,
      ),
    ).toEqual(["quiet", "busy", "steep"]);
  });

  it("falls back to path share when crossings are unknown", () => {
    const roads = candidate({ name: "roads", path_share: 0.2 });
    const paths = candidate({ name: "paths", path_share: 0.8 });
    expect(
      rankGenerated([roads, paths], "any", 6000, BANDS).map((c) => c.name),
    ).toEqual(["paths", "roads"]);
  });
});

describe("outAndBack", () => {
  it("runs the first half out and back", () => {
    const folded = outAndBack(loopA);
    expect(folded.coordinates[0]).toEqual(loopA.coordinates[0]);
    expect(folded.coordinates.at(-1)).toEqual(loopA.coordinates[0]);
    expect(
      Math.abs(folded.distance.at(-1)! - loopA.distance.at(-1)!),
    ).toBeLessThan(loopA.distance.at(-1)! * 0.05);
  });
});

describe("sameRoute", () => {
  it("matches the same loop, not a different one or another length", () => {
    expect(sameRoute(loopA, square(37.79, -122.39, 0.0135))).toBe(true);
    expect(sameRoute(loopA, loopB)).toBe(false);
    expect(sameRoute(loopA, square(37.79, -122.39, 0.015))).toBe(false);
  });
});
