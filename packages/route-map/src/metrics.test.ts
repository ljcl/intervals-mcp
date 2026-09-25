import { describe, expect, it } from "vitest";
import { buildMetricSeries, buildTrackSegments } from "./metrics";
import { type Point } from "./normalize";
import { type RouteMapData } from "./types";

function makeData(overrides: Partial<RouteMapData> = {}): RouteMapData {
  const coordinates: Array<[number, number]> = [
    [37.77, -122.51],
    [37.771, -122.505],
    [37.772, -122.5],
    [37.773, -122.495],
  ];
  return {
    source: "activity",
    id: "1",
    name: "Test Run",
    activityType: "Run",
    distance: 4000,
    elevationGain: 40,
    coordinates,
    start: coordinates[0]!,
    end: coordinates[coordinates.length - 1]!,
    ...overrides,
  };
}

describe("buildMetricSeries", () => {
  it("returns an empty list when there are no streams", () => {
    expect(buildMetricSeries(makeData())).toEqual([]);
  });

  it("builds one series per aligned stream, in display order", () => {
    const data = makeData({
      streams: {
        velocity_smooth: [3, 3.2, 3.1, 3.3],
        heartrate: [140, 150, 155, 160],
        watts: [200, 210, 220, 230],
        altitude: [10, 12, 14, 16],
        grade_smooth: [1, 2, -1, 0],
      },
    });
    const series = buildMetricSeries(data);
    expect(series.map((s) => s.key)).toEqual([
      "pace",
      "heartrate",
      "power",
      "altitude",
      "gradient",
    ]);
    // Mobile pill labels stay compact so five pills fit a 360px card row.
    expect(series.map((s) => s.shortLabel)).toEqual([
      "Pace",
      "HR",
      "Power",
      "Elev",
      "Grade",
    ]);
  });

  it("skips streams whose length does not match the coordinates", () => {
    const data = makeData({
      streams: { heartrate: [140, 150], altitude: [10, 12, 14, 16] },
    });
    const keys = buildMetricSeries(data).map((s) => s.key);
    expect(keys).toEqual(["altitude"]);
  });

  it("formats pace for runs and speed for rides", () => {
    const streams = { velocity_smooth: [2.5, 2.5, 2.5, 2.5] };
    const run = buildMetricSeries(makeData({ streams }))[0]!;
    expect(run.label).toBe("Pace");
    expect(run.format(2.5)).toBe("6'40\" /km");

    const ride = buildMetricSeries(
      makeData({ streams, activityType: "Ride" }),
    )[0]!;
    expect(ride.label).toBe("Speed");
    expect(ride.format(10)).toBe("36.0 km/h");
  });

  it("formats near-zero speed as a pause instead of a huge pace", () => {
    const series = buildMetricSeries(
      makeData({ streams: { velocity_smooth: [0, 3, 3, 3] } }),
    )[0]!;
    expect(series.format(0.05)).toBe("—");
  });

  it("keeps null samples and computes the color domain from the rest", () => {
    const series = buildMetricSeries(
      makeData({ streams: { heartrate: [140, null, 150, 160] } }),
    )[0]!;
    expect(series.values).toEqual([140, null, 150, 160]);
    // Domain comes from the three real samples only: a null must not
    // widen or shift it toward zero.
    expect(series.min).toBeGreaterThanOrEqual(140);
  });

  it("degrades to a degenerate domain when every sample is null", () => {
    const series = buildMetricSeries(
      makeData({ streams: { heartrate: [null, null, null, null] } }),
    )[0]!;
    expect(series.min).toBe(0);
    expect(series.max).toBe(0);
  });
});

describe("buildTrackSegments", () => {
  const line = (n: number): Point[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0 }));

  it("returns nothing for fewer than two points or misaligned values", () => {
    expect(
      buildTrackSegments(line(1), { values: [1], min: 0, max: 1 }),
    ).toEqual([]);
    expect(
      buildTrackSegments(line(3), { values: [1, 2], min: 0, max: 2 }),
    ).toEqual([]);
  });

  it("merges consecutive same-color legs into one path", () => {
    const points = line(5);
    const values = [0, 0, 0, 100, 100];
    const segments = buildTrackSegments(points, {
      values,
      min: 0,
      max: 100,
    });
    expect(segments).toHaveLength(3);
    // The first run spans the legs whose midpoints share the cold bin.
    expect(segments[0]!.path).toBe("M0 0 L10 0 L20 0");
    // Cold and hot runs get different hues.
    expect(segments[0]!.color).not.toBe(segments[2]!.color);
  });

  it("covers the whole track with adjacent runs sharing boundary points", () => {
    const points = line(6);
    const values = [0, 20, 40, 60, 80, 100];
    const segments = buildTrackSegments(points, { values, min: 0, max: 100 });
    // Every leg is drawn exactly once: total leg count equals points - 1.
    const legCount = segments.reduce(
      (sum, s) => sum + s.path.split(" L").length - 1,
      0,
    );
    expect(legCount).toBe(points.length - 1);
    // Each run starts where the previous one ended.
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1]!.path.split(" L").at(-1);
      expect(segments[i]!.path.startsWith(`M${prevEnd}`)).toBe(true);
    }
  });

  it("colors a constant series with the single mid-ramp hue", () => {
    const segments = buildTrackSegments(line(4), {
      values: [5, 5, 5, 5],
      min: 5,
      max: 5,
    });
    expect(segments).toHaveLength(1);
  });

  it("breaks the colored track instead of coloring a null leg", () => {
    const points = line(5);
    // Sample at index 2 (x=20) is null: the legs touching it (1-2 and 2-3)
    // must be skipped, not colored from a fabricated midpoint.
    const values = [10, 20, null, 40, 50];
    const segments = buildTrackSegments(points, { values, min: 10, max: 50 });

    expect(segments).toHaveLength(2);
    expect(segments[0]!.path).toBe("M0 0 L10 0");
    expect(segments[1]!.path).toBe("M30 0 L40 0");
    // Neither drawn path touches the null sample's point (x=20).
    for (const s of segments) {
      expect(s.path).not.toContain("20");
    }
  });
});
