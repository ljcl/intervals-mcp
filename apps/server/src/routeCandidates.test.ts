import { describe, expect, it } from "vitest";
import {
  cumulativeDistances,
  haversineMeters,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import {
  DEFAULT_TERRAIN_BANDS,
  matchPastRuns,
  outAndBack,
  passesInOrder,
  type RouteCandidate,
  rankGenerated,
  rankPast,
  sameRoute,
  stretchWaypoints,
  terrainBands,
  terrainFits,
  thereAndBack,
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
  climb_m: number | null = 20,
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

  it("leaves runs with no recorded climb out", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
      ...run(`r${i}`, "2026-10-01", loopA, i < 3 ? null : i + 1),
      distance_m: 1000,
    }));
    // Nine runs with a climb are too few to calibrate from.
    expect(terrainBands(runs)).toEqual(DEFAULT_TERRAIN_BANDS);
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

  it("still admits a dead-flat route when the flat band is 0", () => {
    const zero = { flatBelow: 0, hillyAbove: 5 };
    expect(terrainFits("flat", 0, 1000, zero)).toBe(true);
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

  it("judges a repeat this week per route, keeping each route's latest recording", () => {
    // Loop A was run 2 days ago, so it ranks last even though it has a month-old recording too.
    const runs = [
      run("recent", "2026-11-01", loopA),
      run("old-a", "2026-10-01", loopA),
      run("old-b", "2026-09-01", loopB),
    ];
    const picked = matchPastRuns(runs, options);
    expect(picked.map((c) => c.activity_id)).toEqual(["old-b", "recent"]);
    expect(picked[0]).toMatchObject({
      kind: "past",
      shape: "loop",
      date: "2026-09-01",
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

  it("with via points, offers loops that pass them in order at any distance", () => {
    // loopA's corners, in the order it runs them.
    const north = loopA.coordinates[10]!;
    const northEast = loopA.coordinates[20]!;
    const runs = [
      run("passes", "2026-10-01", loopA),
      run("misses", "2026-10-01", loopB),
    ];
    const picked = matchPastRuns(runs, {
      ...options,
      target_m: target * 2,
      via: [north, northEast],
    });
    expect(picked.map((c) => c.activity_id)).toEqual(["passes"]);
    expect(
      matchPastRuns(runs, { ...options, via: [northEast, north] }),
    ).toEqual([]);
  });

  it("with via points, keeps a run off the asked terrain and says so", () => {
    const north = loopA.coordinates[10]!;
    // About 33 m/km, hilly against the bands.
    const steep = run("steep", "2026-10-01", loopA, 200);
    const [picked] = matchPastRuns([steep], {
      ...options,
      terrain: "rolling",
      target_m: target + 2000,
      via: [north],
    });
    expect(picked).toMatchObject({ activity_id: "steep", climb_m: 200 });
    expect(picked!.summary).toBe(
      'Your run "steep" on 2026-10-01, hilly for you rather than rolling',
    );
    expect(matchPastRuns([steep], { ...options, terrain: "rolling" })).toEqual(
      [],
    );
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

  it("puts a via run off the asked terrain after one on it", () => {
    const steep = candidate({ kind: "past", name: "steep", climb_m: 60 });
    const recent = candidate({
      kind: "past",
      name: "recent",
      date: "2026-11-01",
    });
    expect(
      rankPast([steep, recent], 6000, "2026-11-03", "flat", BANDS).map(
        (c) => c.name,
      ),
    ).toEqual(["recent", "steep"]);
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

  it("puts a route within 10% of the distance ahead of one far off with more path share", () => {
    const onTarget = candidate({
      name: "5.9 km",
      distance_m: 5900,
      path_share: 0.3,
      crossings_per_km: 20,
    });
    const short = candidate({
      name: "1.2 km",
      distance_m: 1200,
      path_share: 0.9,
      crossings_per_km: 1,
    });
    expect(
      rankGenerated([short, onTarget], "any", 6000, BANDS).map((c) => c.name),
    ).toEqual(["5.9 km", "1.2 km"]);
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

describe("passesInOrder", () => {
  it("needs every point within 100 m, in order", () => {
    const [a, b] = [loopA.coordinates[10]!, loopA.coordinates[30]!];
    expect(passesInOrder(loopA, [a, b])).toBe(true);
    expect(passesInOrder(loopA, [b, a])).toBe(false);
    // About 110 m off the track.
    expect(passesInOrder(loopA, [[a[0] + 0.001, a[1]]])).toBe(false);
  });
});

describe("thereAndBack", () => {
  it("runs a track then back the same way", () => {
    const line: RouteTrack = {
      coordinates: loopA.coordinates.slice(0, 11),
      distance: loopA.distance.slice(0, 11),
      altitude: loopA.altitude.slice(0, 11),
    };
    const both = thereAndBack(line);
    expect(both.coordinates.at(-1)).toEqual(line.coordinates[0]);
    expect(both.distance.at(-1)).toBeCloseTo(line.distance.at(-1)! * 2);
  });
});

describe("stretchWaypoints", () => {
  const start: LatLng = [-33.8774, 151.1847];
  const via: LatLng = [-33.86884, 151.18512];
  const chain = (points: LatLng[]) =>
    points
      .slice(1)
      .reduce((sum, p, i) => sum + haversineMeters(points[i]!, p), 0);

  it("puts a loop's detour beside a leg, as far out as adds the extra", () => {
    const base = [start, via, start];
    // Seeds 0 and 1 take the first leg; 2 and 3 the second.
    for (const seed of [0, 1]) {
      const stretched = stretchWaypoints(base, "loop", 2000, seed);
      expect(stretched).toHaveLength(4);
      expect(stretched[0]).toEqual(start);
      expect(stretched.slice(2)).toEqual([via, start]);
      expect(chain(stretched)).toBeCloseTo(chain(base) + 2000, -1);
    }
    // The seed's parity picks the side.
    expect(stretchWaypoints(base, "loop", 2000, 0)[1]).not.toEqual(
      stretchWaypoints(base, "loop", 2000, 1)[1],
    );
    expect(stretchWaypoints(base, "loop", 2000, 2).slice(0, 2)).toEqual([
      start,
      via,
    ]);
  });

  it("puts consecutive seeds' detours on opposite sides of a one-via loop", () => {
    const base = [start, via, start];
    const detour = (seed: number) =>
      stretchWaypoints(base, "loop", 2000, seed).find(
        (p) => p !== start && p !== via,
      )!;
    for (let seed = 0; seed < 6; seed++)
      expect(haversineMeters(detour(seed), detour(seed + 1))).toBeGreaterThan(
        1000,
      );
  });

  it("puts an out-and-back's turnaround past its last point, turned by the seed", () => {
    const turns = [0, 1].map((seed) =>
      stretchWaypoints([start, via], "out-and-back", 1500, seed),
    );
    for (const stretched of turns) {
      expect(stretched.slice(0, 2)).toEqual([start, via]);
      expect(haversineMeters(via, stretched[2]!)).toBeCloseTo(1500, -1);
    }
    // Seed 0 carries straight on, away from the start.
    expect(haversineMeters(start, turns[0]![2]!)).toBeCloseTo(
      haversineMeters(start, via) + 1500,
      -1,
    );
    expect(turns[0]![2]).not.toEqual(turns[1]![2]);
  });
});

describe("sameRoute", () => {
  it("matches the same loop, not a different one or another length", () => {
    expect(sameRoute(loopA, square(37.79, -122.39, 0.0135))).toBe(true);
    expect(sameRoute(loopA, loopB)).toBe(false);
    expect(sameRoute(loopA, square(37.79, -122.39, 0.015))).toBe(false);
  });

  it("matches a loop run the other way round", () => {
    const reversed: RouteTrack = {
      coordinates: [...loopA.coordinates].reverse(),
      distance: cumulativeDistances([...loopA.coordinates].reverse()),
      altitude: [...loopA.altitude].reverse(),
    };
    expect(sameRoute(loopA, reversed)).toBe(true);
    expect(sameRoute(reversed, loopB)).toBe(false);
  });
});
