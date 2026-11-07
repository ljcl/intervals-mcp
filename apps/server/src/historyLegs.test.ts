import { describe, expect, it } from "vitest";
import {
  legOptions,
  legSection,
  passes,
  planStitches,
  sameLine,
  stitchAnchors,
  stitchedCandidate,
} from "./historyLegs";
import {
  cumulativeDistances,
  haversineMeters,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { passesInOrder } from "./routeCandidates";
import { trackLength } from "./routeGeometry";
import { type RunStart } from "./startClusters";

/** Start, about 1 km north of it, about 1 km east of that, and 2 km north. */
const S: LatLng = [-33.88, 151.18];
const A: LatLng = [-33.871, 151.18];
const B: LatLng = [-33.871, 151.1908];
const FAR: LatLng = [-33.862, 151.18];

/** A point `m` metres east of `p`. */
const east = (p: LatLng, m: number): LatLng => [
  p[0],
  p[1] + m / (111_320 * Math.cos((p[0] * Math.PI) / 180)),
];

/** A track along the points in straight lines, a sample about every 10 m. */
function line(points: LatLng[]): RouteTrack {
  const coordinates: LatLng[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / 10));
    for (let k = 1; k <= steps; k++)
      coordinates.push([
        a[0] + ((b[0] - a[0]) * k) / steps,
        a[1] + ((b[1] - a[1]) * k) / steps,
      ]);
  }
  const distance = cumulativeDistances(coordinates);
  return { coordinates, distance, altitude: distance.map(() => 10) };
}

function run(id: string, points: LatLng[], date = "2026-10-01"): RunStart {
  const track = line(points);
  return {
    id,
    date,
    name: `Run ${id}`,
    distance_m: trackLength(track),
    climb_m: 0,
    track,
  };
}

describe("passes", () => {
  it("finds every visit within 100 m, at the nearest spot of each", () => {
    const outAndBack = line([S, A, S]);
    const atS = passes(outAndBack, S);
    expect(atS).toHaveLength(2);
    expect(atS[0]).toBeCloseTo(0, 0);
    expect(atS[1]).toBeCloseTo(trackLength(outAndBack), 0);
    const atA = passes(outAndBack, A);
    expect(atA).toHaveLength(1);
    expect(Math.abs(atA[0]! - trackLength(outAndBack) / 2)).toBeLessThan(5);
    expect(passes(outAndBack, B)).toEqual([]);
  });
});

describe("legSection", () => {
  it("cuts the shortest section between the two points, either way along the run", () => {
    const forward = legSection(run("r1", [S, A, B]), S, A)!;
    expect(trackLength(forward.track)).toBeCloseTo(haversineMeters(S, A), -1);
    const backward = legSection(run("r2", [B, A, S]), S, A)!;
    expect(haversineMeters(backward.track.coordinates[0]!, S)).toBeLessThan(1);
    expect(haversineMeters(backward.track.coordinates.at(-1)!, A)).toBeLessThan(
      1,
    );
    expect(backward.run).toEqual({
      id: "r2",
      name: "Run r2",
      date: "2026-10-01",
    });
  });

  it("is null when the run misses a point or reaches it only by a detour", () => {
    expect(legSection(run("r1", [S, A]), S, B)).toBeNull();
    // About 6 km around for a 1 km leg: over 2 x 1 km + 500 m.
    const detour = run("r2", [S, east(S, 1500), east(FAR, 1500), FAR, A]);
    expect(legSection(detour, S, A)).toBeNull();
  });

  it("handles two anchors closer together than the pass radius", () => {
    const close = east(A, 50);
    const section = legSection(run("r1", [S, A, close, B]), A, close);
    expect(section).not.toBeNull();
    expect(trackLength(section!.track)).toBeLessThan(100);
  });
});

describe("sameLine", () => {
  it("treats two recordings of one street as one line, a street 60 m over as another", () => {
    const one = line([S, A]);
    expect(sameLine(one, line([east(S, 10), east(A, 10)]))).toBe(true);
    expect(sameLine(one, line([east(S, 60), east(A, 60)]))).toBe(false);
    expect(sameLine(one, line([S, FAR]))).toBe(false);
  });
});

describe("legOptions", () => {
  it("groups runs on one line, heaviest first, the newest run's section representing it", () => {
    const runs = [
      run("new", [S, A, FAR], "2026-10-20"),
      run("mid", [east(S, 10), east(A, 10)], "2026-10-10"),
      run("other", [S, east(S, 400), east(A, 400), A], "2026-10-05"),
      run("old", [S, A], "2026-09-01"),
    ];
    const options = legOptions(runs, S, A);
    expect(options.map((o) => o.runs.map((r) => r.id))).toEqual([
      ["new", "mid", "old"],
      ["other"],
    ]);
    expect(options[0]!.track.coordinates[0]).toEqual(S);
  });

  it("keeps the three heaviest lines, shortest first among equals", () => {
    const runs = [0, 150, 300, 450].map((d) =>
      run(`d${d}`, [S, east(S, d), east(A, d), A]),
    );
    expect(legOptions(runs, S, A).map((o) => o.runs[0]!.id)).toEqual([
      "d0",
      "d150",
      "d300",
    ]);
  });
});

describe("planStitches", () => {
  it("orders the anchors for each shape", () => {
    expect(stitchAnchors(S, [A, B], "loop", null)).toEqual([S, A, B, S]);
    expect(stitchAnchors(S, [A, B], "out-and-back", null)).toEqual([S, A, B]);
    expect(stitchAnchors(S, [A], "point-to-point", B)).toEqual([S, A, B]);
  });

  it("routes only the uncovered legs, through the anchors between", () => {
    const anchors = stitchAnchors(S, [A, B], "loop", null);
    const options = [legOptions([run("r1", [S, A])], S, A), [], []];
    const plans = planStitches(options, anchors, 3500, 1);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.pieces.map((p) => p.kind)).toEqual(["section", "fill"]);
    const fill = plans[0]!.pieces[1]!;
    if (fill.kind !== "fill") throw new Error("expected a fill");
    expect(haversineMeters(fill.waypoints[0]!, A)).toBeLessThan(1);
    expect(fill.waypoints.slice(1)).toEqual([B, S]);
  });

  it("makes nothing when no leg is covered", () => {
    expect(planStitches([[], []], [S, A, S], 2000, 1)).toEqual([]);
  });

  it("joins sections that meet within 30 m and fills a wider gap", () => {
    const anchors = [S, A, B, S];
    const options = [
      legOptions([run("r1", [S, A])], S, A),
      legOptions([run("r2", [east(A, 20), B])], A, B),
      legOptions([run("r3", [east(B, 60), S])], B, S),
    ];
    const [plan] = planStitches(options, anchors, 3500, 1);
    expect(plan!.pieces.map((p) => p.kind)).toEqual([
      "section",
      "section",
      "fill",
      "section",
    ]);
  });

  it("keeps the two combinations closest to the distance, an out-and-back counted twice", () => {
    const options = legOptions(
      [
        run("direct", [S, A]),
        run("wide", [S, east(S, 150), east(A, 150), A]),
        run("wider", [S, east(S, 450), east(A, 450), A]),
      ],
      S,
      A,
    );
    // Way out 1.0, 1.3 or 1.9 km: there and back 2.0, 2.6 or 3.8 km.
    const plans = planStitches([options], [S, A], 2600, 2);
    expect(plans.map((p) => Math.round(p.estimate_m / 100) / 10)).toEqual([
      2.6, 2.0,
    ]);
  });
});

describe("stitchedCandidate", () => {
  it("joins sections and fills in order, with the share from runs and the runs named", () => {
    const anchors = [S, A, B, S];
    const options = [
      legOptions([run("r1", [S, A])], S, A),
      [],
      legOptions([run("r3", [B, S], "2026-10-02")], B, S),
    ];
    const [plan] = planStitches(options, anchors, 3500, 1);
    expect(plan!.pieces.map((p) => p.kind)).toEqual([
      "section",
      "fill",
      "section",
    ]);
    const c = stitchedCandidate(plan!, [line([A, B])], "loop")!;
    expect(c).toMatchObject({
      kind: "stitched",
      name: "From your runs",
      activity_id: null,
      date: null,
      path_share: null,
      shape: "loop",
    });
    expect(passesInOrder(c.track, [A, B])).toBe(true);
    expect(c.history_share!).toBeGreaterThan(0.65);
    expect(c.history_share!).toBeLessThan(0.75);
    expect(c.summary).toBe(
      "From 2 past runs: Run r1 2026-10-01, Run r3 2026-10-02; 1.0 km routed by OpenRouteService",
    );
    expect(stitchedCandidate(plan!, [null], "loop")).toBeNull();
    expect(stitchedCandidate(plan!, [], "loop")).toBeNull();
  });

  it("runs an out-and-back's way out there and back", () => {
    const [plan] = planStitches(
      [legOptions([run("r1", [S, A])], S, A)],
      [S, A],
      2000,
      2,
    );
    const c = stitchedCandidate(plan!, [], "out-and-back")!;
    expect(c.distance_m).toBeCloseTo(2 * haversineMeters(S, A), -1);
    expect(c.track.coordinates.at(-1)).toEqual(S);
    expect(c.history_share).toBeCloseTo(1, 2);
    expect(c.summary).toBe("From 1 past run: Run r1 2026-10-01");
  });
});
