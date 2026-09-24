import { describe, expect, it } from "vitest";
import {
  cumulativeDistances,
  indexAtDistance,
  resolveWaypoints,
  type WaypointInput,
} from "./mapAnchors";

describe("indexAtDistance", () => {
  const stream = [0, 100, 250, 500, 1000];

  it("returns -1 for an empty stream", () => {
    expect(indexAtDistance([], 100)).toBe(-1);
  });

  it("finds the first index reaching the target", () => {
    expect(indexAtDistance(stream, 0)).toBe(0);
    expect(indexAtDistance(stream, 100)).toBe(1);
    expect(indexAtDistance(stream, 101)).toBe(2);
    expect(indexAtDistance(stream, 999)).toBe(4);
  });

  it("clamps past the end of the stream", () => {
    expect(indexAtDistance(stream, 5000)).toBe(4);
  });
});

describe("cumulativeDistances", () => {
  it("returns an empty stream for empty coordinates", () => {
    expect(cumulativeDistances([])).toEqual([]);
  });

  it("starts at zero for a single point", () => {
    expect(cumulativeDistances([[37.77, -122.51]])).toEqual([0]);
  });

  it("accumulates haversine distance along the track", () => {
    // 0.01° of latitude is ~1.11 km; longitude held constant.
    const coords: Array<[number, number]> = [
      [37.77, -122.51],
      [37.78, -122.51],
      [37.8, -122.51],
    ];
    const out = cumulativeDistances(coords);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThan(1100);
    expect(out[1]).toBeLessThan(1130);
    // Non-decreasing, and the second leg is twice the first.
    expect(out[2]! / out[1]!).toBeCloseTo(3, 1);
  });

  it("scales longitude legs by latitude", () => {
    const atEquator = cumulativeDistances([
      [0, 10],
      [0, 10.01],
    ])[1]!;
    const atSixty = cumulativeDistances([
      [60, 10],
      [60, 10.01],
    ])[1]!;
    expect(atSixty / atEquator).toBeCloseTo(0.5, 1);
  });
});

describe("resolveWaypoints", () => {
  const stream = [0, 1000, 2000, 3000, 4000, 5000];
  const wp = (km: number, label = `${km} km mark`): WaypointInput => ({
    km,
    label,
    kind: "custom",
  });

  it("anchors waypoints at their cumulative distance, sorted by km", () => {
    const { resolved, dropped } = resolveWaypoints(
      [wp(4, "Late"), wp(1.5, "Early")],
      stream,
      5000,
    );
    expect(dropped).toEqual([]);
    expect(resolved.map((w) => w.label)).toEqual(["Early", "Late"]);
    expect(resolved.map((w) => w.index)).toEqual([2, 4]);
  });

  it("drops waypoints beyond the track length instead of erroring", () => {
    const { resolved, dropped } = resolveWaypoints(
      [wp(2), wp(9, "Too far")],
      stream,
      5000,
    );
    expect(resolved).toHaveLength(1);
    expect(dropped.map((w) => w.label)).toEqual(["Too far"]);
  });

  it("clamps a near-miss overshoot to the finish rather than dropping it", () => {
    // 5.04 km against a 5.00 km track is within the 1% tolerance.
    const { resolved, dropped } = resolveWaypoints([wp(5.04)], stream, 5000);
    expect(dropped).toEqual([]);
    expect(resolved[0]?.index).toBe(5);
  });

  it("uses the stream total when no declared distance is available", () => {
    const { resolved, dropped } = resolveWaypoints(
      [wp(4), wp(9, "Too far")],
      stream,
      0,
    );
    expect(resolved).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("drops everything against an empty stream", () => {
    const { resolved, dropped } = resolveWaypoints([wp(1)], [], 0);
    expect(resolved).toEqual([]);
    expect(dropped).toHaveLength(1);
  });
});
