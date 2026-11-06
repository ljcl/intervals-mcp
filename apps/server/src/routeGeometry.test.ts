import { describe, expect, it } from "vitest";
import { haversineMeters, type LatLng } from "./mapAnchors";
import {
  concatTracks,
  findSpurs,
  mapDistance,
  moveToward,
  nearestOnTrack,
  parseHeading,
  pointAtDistance,
  reverseTrack,
  simplifyTrack,
  sliceTrack,
  thinTrack,
  trackDiff,
  trackFromPoints,
  trackLength,
} from "./routeGeometry";

/** A straight line east from Rozelle, one point every `step` metres. */
function eastLine(metres: number, step = 10, from: LatLng = [-33.86, 151.17]) {
  const points: LatLng[] = [];
  for (let d = 0; d <= metres; d += step) points.push(moveToward(from, 90, d));
  return trackFromPoints(
    points,
    points.map((_, i) => 10 + i),
  );
}

describe("pointAtDistance and sliceTrack", () => {
  const line = eastLine(1000);

  it("interpolates between samples", () => {
    const at = pointAtDistance(line, 15);
    expect(haversineMeters(line.coordinates[0]!, at.point)).toBeCloseTo(15, 0);
    expect(at.altitude).toBeCloseTo(11.5, 1);
  });

  it("clamps to the ends", () => {
    expect(pointAtDistance(line, -5).point).toEqual(line.coordinates[0]);
    expect(pointAtDistance(line, 5000).point).toEqual(line.coordinates.at(-1));
  });

  it("cuts a part with exact ends and distances from its own start", () => {
    const part = sliceTrack(line, 105, 455);
    expect(trackLength(part)).toBeCloseTo(350, 3);
    expect(part.distance[0]).toBe(0);
    expect(
      haversineMeters(part.coordinates[0]!, pointAtDistance(line, 105).point),
    ).toBeLessThan(0.01);
  });

  it("gives one point for an empty range", () => {
    expect(sliceTrack(line, 200, 200).coordinates).toHaveLength(1);
  });
});

describe("concatTracks and reverseTrack", () => {
  it("adds the straight seam between two tracks", () => {
    const a = eastLine(100);
    const b = eastLine(100, 10, moveToward(a.coordinates.at(-1)!, 90, 20));
    const joined = concatTracks([a, b]);
    expect(trackLength(joined)).toBeCloseTo(220, 0);
  });

  it("keeps one point where two tracks meet", () => {
    const a = eastLine(100);
    const b = eastLine(100, 10, a.coordinates.at(-1)!);
    expect(concatTracks([a, b]).coordinates).toHaveLength(21);
  });

  it("reverses distances and order", () => {
    const line = eastLine(100);
    const back = reverseTrack(line);
    expect(back.coordinates[0]).toEqual(line.coordinates.at(-1));
    expect(back.distance[0]).toBe(0);
    expect(trackLength(back)).toBeCloseTo(trackLength(line), 6);
    expect(back.altitude[0]).toBe(line.altitude.at(-1));
  });
});

describe("thinTrack and simplifyTrack", () => {
  it("drops points closer than the spacing, keeping the last", () => {
    const line = eastLine(100, 1);
    const thin = thinTrack(line, 5);
    const gaps = thin.distance
      .slice(1, -1)
      .map((d, i) => d - thin.distance[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(thin.coordinates.length).toBeLessThan(line.coordinates.length / 4);
    expect(thin.distance.at(-1)).toBe(line.distance.at(-1));
  });

  it("keeps only the ends of a straight line", () => {
    expect(simplifyTrack(eastLine(1000), 1).coordinates).toHaveLength(2);
  });

  it("keeps a corner", () => {
    const corner = moveToward([-33.86, 151.17], 90, 500);
    const track = trackFromPoints([
      [-33.86, 151.17],
      corner,
      moveToward(corner, 0, 500),
    ]);
    expect(simplifyTrack(track, 5).coordinates).toHaveLength(3);
  });
});

describe("nearestOnTrack", () => {
  const line = eastLine(1000);

  it("projects a point off the line onto it", () => {
    const off = moveToward(pointAtDistance(line, 333).point, 0, 40);
    const near = nearestOnTrack(line, off);
    expect(near.distance_m).toBeCloseTo(333, 0);
    expect(near.offset_m).toBeCloseTo(40, 0);
  });

  it("searches only the range asked", () => {
    const near = nearestOnTrack(line, line.coordinates[10]!, 500, 900);
    expect(near.distance_m).toBe(500);
  });
});

describe("trackDiff and mapDistance", () => {
  const before = eastLine(3000);
  // The same line with a 200 m detour north between 1000 and 1200 m.
  const detour = (() => {
    const a = sliceTrack(before, 0, 1000);
    const turn = moveToward(a.coordinates.at(-1)!, 0, 100);
    const mid = trackFromPoints([
      a.coordinates.at(-1)!,
      turn,
      moveToward(turn, 90, 200),
      pointAtDistance(before, 1200).point,
    ]);
    const c = sliceTrack(before, 1200, 3000);
    return concatTracks([a, mid, c]);
  })();

  it("finds the changed part on both versions", () => {
    const diff = trackDiff(before, detour);
    expect(diff.changed).toBe(true);
    expect(diff.old_from_m).toBeGreaterThan(980);
    expect(diff.old_from_m).toBeLessThanOrEqual(1000);
    // Within one comparison step of the 1200 m mark.
    expect(diff.old_to_m).toBeGreaterThan(1190);
    expect(diff.old_to_m).toBeLessThan(1220);
    expect(diff.new_to_m - diff.new_from_m).toBeGreaterThan(390);
  });

  it("finds no change between equal tracks", () => {
    expect(trackDiff(before, thinTrack(before, 25)).changed).toBe(false);
  });

  it("carries a place after the change by the length change", () => {
    const diff = trackDiff(before, detour);
    const mapped = mapDistance(2500, before, detour, diff);
    expect(mapped.uncertain).toBe(false);
    expect(mapped.distance_m).toBeCloseTo(
      2500 + trackLength(detour) - trackLength(before),
      0,
    );
    expect(mapDistance(500, before, detour, diff)).toEqual({
      distance_m: 500,
      uncertain: false,
    });
  });

  it("marks a place inside the change uncertain when the new track is not near it", () => {
    const diff = trackDiff(before, detour);
    expect(mapDistance(1100, before, detour, diff).uncertain).toBe(true);
  });
});

describe("parseHeading", () => {
  it.each([
    ["west", 270],
    ["NE", 45],
    ["north-east", 45],
    ["South West", 225],
    ["90", 90],
    ["-90", 270],
    ["400°", 40],
  ])("%s is %d degrees", (text, degrees) => {
    expect(parseHeading(text)).toBe(degrees);
  });

  it("reads a place as no heading", () => {
    expect(parseHeading("Iron Cove, Sydney")).toBeNull();
  });
});

describe("moveToward", () => {
  it("moves the distance asked", () => {
    const from: LatLng = [-33.86, 151.17];
    expect(haversineMeters(from, moveToward(from, 270, 200))).toBeCloseTo(
      200,
      0,
    );
    expect(moveToward(from, 270, 200)[1]).toBeLessThan(from[1]);
  });
});

describe("findSpurs", () => {
  it("finds a dead end the track goes into and back out of", () => {
    // East 500 m, north 60 m into a stub and back, then east 500 m more.
    const base: LatLng = [-33.86, 151.17];
    const corner = moveToward(base, 90, 500);
    const points: LatLng[] = [];
    for (let d = 0; d <= 500; d += 10) points.push(moveToward(base, 90, d));
    for (let d = 10; d <= 60; d += 10) points.push(moveToward(corner, 0, d));
    for (let d = 50; d >= 0; d -= 10) points.push(moveToward(corner, 0, d));
    for (let d = 10; d <= 500; d += 10) points.push(moveToward(corner, 90, d));
    const spurs = findSpurs(trackFromPoints(points));
    expect(spurs).toHaveLength(1);
    expect(Math.abs(spurs[0]!.from_m - 500)).toBeLessThanOrEqual(10);
    expect(Math.abs(spurs[0]!.to_m - 620)).toBeLessThanOrEqual(10);
  });

  /** North `up` m on one path, across `gap` m east at the top, back down beside it, then east. */
  function upAndBack(up: number, gap: number) {
    const base: LatLng = [-33.86, 151.17];
    const points: LatLng[] = [];
    for (let d = 0; d <= up; d += 10) points.push(moveToward(base, 0, d));
    const top = moveToward(base, 0, up);
    points.push(moveToward(top, 90, gap));
    const down = moveToward(base, 90, gap);
    for (let d = up - 10; d >= 0; d -= 10) points.push(moveToward(down, 0, d));
    for (let d = 10; d <= 300; d += 10) points.push(moveToward(down, 90, d));
    return trackFromPoints(points);
  }

  it("finds a return along the path beside the way out, with no mirror-image turn", () => {
    const spurs = findSpurs(upAndBack(200, 10));
    expect(spurs).toHaveLength(1);
    expect(spurs[0]!.from_m).toBeLessThanOrEqual(10);
    expect(spurs[0]!.to_m).toBeGreaterThanOrEqual(390);
  });

  it("finds none round a block wider than the match distance", () => {
    expect(findSpurs(upAndBack(200, 30))).toEqual([]);
  });

  it("finds none on a straight line or a right-angle corner", () => {
    expect(findSpurs(eastLine(1000))).toEqual([]);
    const corner = moveToward([-33.86, 151.17], 90, 300);
    const points: LatLng[] = [];
    for (let d = 0; d <= 300; d += 10)
      points.push(moveToward([-33.86, 151.17], 90, d));
    for (let d = 10; d <= 300; d += 10) points.push(moveToward(corner, 0, d));
    expect(findSpurs(trackFromPoints(points))).toEqual([]);
  });
});
