import { describe, expect, it } from "vitest";
import {
  cumulativeDistances,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import {
  DEFAULT_TERRAIN_BANDS,
  moveBy,
  type RouteCandidate,
} from "./routeCandidates";
import { moveToward, trackFromPoints } from "./routeGeometry";
import {
  knownLines,
  routeNotes,
  SCORE_WEIGHTS,
  scoreLosses,
  scoreRoute,
} from "./routeScore";
import { type RunStart } from "./startClusters";

const CTX = {
  target_m: 10_000,
  terrain: "any" as const,
  bands: DEFAULT_TERRAIN_BANDS,
  today: "2026-11-08",
};

const TRACK: RouteTrack = {
  coordinates: [[0, 0]],
  distance: [0],
  altitude: [null],
};

/** A perfect 10 km loop: all paths, no crossings or main roads, all green. */
function candidate(over: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    kind: "generated",
    activity_id: null,
    name: "New loop",
    date: null,
    shape: "loop",
    distance_m: 10_000,
    climb_m: 50,
    path_share: 1,
    crossings_per_km: 0,
    signals_per_km: 0,
    main_road_km: 0,
    green_share: 1,
    hill: null,
    summary: "",
    track: TRACK,
    ...over,
  };
}

const sum = (b: Record<string, number | null>) =>
  Object.values(b).reduce<number>((s, v) => s + (v ?? 0), 0);

describe("scoreRoute", () => {
  it("gives a perfect route 100 and each factor its weight", () => {
    const { score, breakdown } = scoreRoute(candidate(), 1, 0, CTX);
    expect(score).toBe(100);
    expect(breakdown).toEqual({ ...SCORE_WEIGHTS, recency: 0 });
  });

  it("takes each factor to 0 at its cap and half at its midpoint", () => {
    const capped = scoreRoute(
      candidate({
        path_share: 0,
        crossings_per_km: 6,
        signals_per_km: 2,
        main_road_km: 2.5,
        green_share: 0,
        distance_m: 12_500,
      }),
      0,
      2000,
      { ...CTX, target_m: 10_000 },
    ).breakdown;
    expect(capped).toEqual({
      paths: 0,
      known_lines: 0,
      crossings: 0,
      // 2.5 km of a 12.5 km route is 20%: 15 x (1 - 0.2 / 0.25) = 3.
      main_roads: 3,
      backtracking: 0,
      green: 0,
      fit: 0,
      recency: 0,
    });
    const mid = scoreRoute(
      candidate({
        path_share: 0.5,
        crossings_per_km: 3,
        signals_per_km: 1,
        main_road_km: 1.25,
        green_share: 0.5,
        distance_m: 11_250,
      }),
      0.5,
      1000,
      { ...CTX, target_m: 10_000 },
    ).breakdown;
    expect(mid.paths).toBe(12.5);
    expect(mid.known_lines).toBe(10);
    expect(mid.crossings).toBe(7.5);
    expect(mid.backtracking).toBe(5);
    expect(mid.green).toBe(5);
    expect(mid.fit).toBe(2.5);
  });

  it("scales out factors the OSM index could not measure", () => {
    const { score, breakdown } = scoreRoute(
      candidate({
        crossings_per_km: null,
        signals_per_km: null,
        main_road_km: null,
        green_share: null,
      }),
      1,
      0,
      CTX,
    );
    expect(breakdown.crossings).toBeNull();
    expect(breakdown.main_roads).toBeNull();
    expect(breakdown.green).toBeNull();
    expect(score).toBe(100);
    // paths 25 of the 60 points left, scaled to 100.
    expect(breakdown.paths).toBeCloseTo(41.7, 1);
  });

  it("gives an out-and-back full backtracking points", () => {
    const { breakdown } = scoreRoute(
      candidate({ shape: "out-and-back" }),
      1,
      5000,
      CTX,
    );
    expect(breakdown.backtracking).toBe(SCORE_WEIGHTS.backtracking);
  });

  it("takes 10 off a past run from the last week, never below 0", () => {
    const recent = candidate({ kind: "past", date: "2026-11-05" });
    const old = candidate({ kind: "past", date: "2026-10-01" });
    expect(
      scoreRoute(old, 1, 0, CTX).score - scoreRoute(recent, 1, 0, CTX).score,
    ).toBe(10);
    expect(scoreRoute(recent, 1, 0, CTX).breakdown.recency).toBe(-10);
    const worst = candidate({
      kind: "past",
      date: "2026-11-07",
      path_share: 0,
      crossings_per_km: 9,
      main_road_km: 5,
      green_share: 0,
      distance_m: 20_000,
    });
    expect(scoreRoute(worst, 0, 5000, CTX).score).toBe(0);
  });

  it("halves fit on a terrain miss and gives full fit without a target", () => {
    const hilly = candidate({ climb_m: 400 });
    expect(
      scoreRoute(hilly, 1, 0, { ...CTX, terrain: "flat" }).breakdown.fit,
    ).toBe(2.5);
    expect(
      scoreRoute(candidate(), 1, 0, { ...CTX, target_m: 0 }).breakdown.fit,
    ).toBe(5);
  });

  it("sums its breakdown to its score within 1", () => {
    const { score, breakdown } = scoreRoute(
      candidate({
        path_share: 0.37,
        crossings_per_km: 2.3,
        signals_per_km: 0.7,
        main_road_km: 0.9,
        green_share: 0.61,
        distance_m: 10_420,
      }),
      0.43,
      330,
      CTX,
    );
    expect(Math.abs(sum(breakdown) - score)).toBeLessThanOrEqual(1);
  });
});

describe("scoreLosses", () => {
  it("lists the biggest losses of 2 points or more, at most 3", () => {
    const { breakdown } = scoreRoute(
      candidate({
        kind: "past",
        date: "2026-11-06",
        crossings_per_km: 4,
        signals_per_km: 0,
        path_share: 0.9,
        green_share: 0.95,
      }),
      0.7,
      0,
      CTX,
    );
    expect(scoreLosses(breakdown)).toEqual([
      { label: "recent run", points: 10 },
      { label: "crossings", points: 7.5 },
      { label: "known lines", points: 6 },
    ]);
  });
});

/** A straight 1 km line north from `from`, sampled every 10 m. */
function northLine(from: LatLng): RouteTrack {
  const points: LatLng[] = [];
  for (let d = 0; d <= 1000; d += 10) points.push(moveToward(from, 0, d));
  return trackFromPoints(points);
}
const run = (id: string, track: RouteTrack): RunStart => ({
  id,
  date: "2026-10-01",
  name: id,
  distance_m: 1000,
  climb_m: 0,
  track,
});
const reversed = (t: RouteTrack): RouteTrack => {
  const coordinates = [...t.coordinates].reverse();
  return {
    coordinates,
    distance: cumulativeDistances(coordinates),
    altitude: coordinates.map(() => null),
  };
};

describe("knownLines", () => {
  const A: LatLng = [-33.88, 151.18];
  const line = northLine(A);

  it("needs 3 runs on a line, either way, and ignores a crossing street", () => {
    const two = knownLines([run("a", line), run("b", line)]);
    expect(two(line)).toBe(0);
    const three = knownLines([
      run("a", line),
      run("b", line),
      run("c", reversed(line)),
    ]);
    expect(three(line)).toBeGreaterThan(0.95);
    // Three runs crossing the line at right angles: close, but another street.
    const across: LatLng[] = [];
    const mid = moveToward(A, 0, 500);
    for (let d = -200; d <= 200; d += 10) across.push(moveBy(mid, d, 0));
    const street = trackFromPoints(across);
    const crossing = knownLines([
      run("a", street),
      run("b", street),
      run("c", street),
    ]);
    expect(crossing(line)).toBe(0);
  });

  it("is 0 with fewer than 3 runs or for a track under one sample", () => {
    expect(knownLines([])(line)).toBe(0);
    const three = knownLines([run("a", line), run("b", line), run("c", line)]);
    expect(three({ coordinates: [A], distance: [0], altitude: [null] })).toBe(
      0,
    );
  });
});

describe("routeNotes", () => {
  it("notes a dead end on a loop, nothing on an out-and-back", () => {
    const base: LatLng = [-33.86, 151.17];
    const corner = moveToward(base, 90, 500);
    const points: LatLng[] = [];
    for (let d = 0; d <= 500; d += 10) points.push(moveToward(base, 90, d));
    for (let d = 10; d <= 60; d += 10) points.push(moveToward(corner, 0, d));
    for (let d = 50; d >= 0; d -= 10) points.push(moveToward(corner, 0, d));
    for (let d = 10; d <= 500; d += 10) points.push(moveToward(corner, 90, d));
    const track = trackFromPoints(points);
    expect(routeNotes(track, "loop")).toEqual([
      expect.stringMatching(
        /^Goes back the way it came at km 0\.5-0\.6, \d+ m each way\.$/,
      ),
    ]);
    expect(routeNotes(track, "out-and-back")).toEqual([]);
  });
});
