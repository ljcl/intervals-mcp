import { describe, expect, it } from "vitest";
import {
  buildKmSplits,
  buildSplitMarkers,
  buildWaypointMarkers,
} from "./annotations";
import { type RouteMapData } from "./types";

function makeData(overrides: Partial<RouteMapData> = {}): RouteMapData {
  const coordinates: Array<[number, number]> = Array.from(
    { length: 11 },
    (_, i) => [37.77 + i * 0.001, -122.51],
  );
  return {
    source: "activity",
    id: "1",
    name: "Test Run",
    activityType: "Run",
    distance: 5000,
    elevationGain: 40,
    coordinates,
    start: coordinates[0]!,
    end: coordinates[coordinates.length - 1]!,
    ...overrides,
  };
}

describe("buildKmSplits", () => {
  it("returns nothing for sub-kilometre or empty streams", () => {
    expect(buildKmSplits([])).toEqual([]);
    expect(buildKmSplits([0, 400, 900])).toEqual([]);
  });

  it("marks each kilometre at the first sample reaching it", () => {
    // 0..5000m in 500m steps (11 samples).
    const stream = Array.from({ length: 11 }, (_, i) => i * 500);
    const splits = buildKmSplits(stream);
    // The 5 km mark would sit on the finish sample, so it is dropped.
    expect(splits).toEqual([
      { index: 2, label: "1 km" },
      { index: 4, label: "2 km" },
      { index: 6, label: "3 km" },
      { index: 8, label: "4 km" },
    ]);
  });

  it("respects a non-zero stream start", () => {
    const stream = [2000, 2500, 3000, 3500, 4100];
    const splits = buildKmSplits(stream);
    expect(splits).toEqual([{ index: 2, label: "1 km" }]);
  });

  it("thins long activities to a coarser step", () => {
    // 100 km in 100m samples: a 1 km step would be 100 markers; 5 km gives 20.
    const stream = Array.from({ length: 1001 }, (_, i) => i * 100);
    const splits = buildKmSplits(stream);
    expect(splits.length).toBeLessThanOrEqual(24);
    expect(splits[0]!.label).toBe("5 km");
  });
});

describe("buildSplitMarkers", () => {
  it("prefers lap boundaries when the server resolved any", () => {
    const data = makeData({
      streams: { distance: Array.from({ length: 11 }, (_, i) => i * 500) },
      annotations: {
        laps: [
          { lapIndex: 1, name: "Lap 1", endIndex: 4 },
          { lapIndex: 2, name: "Lap 2", endIndex: 8 },
        ],
      },
    });
    expect(buildSplitMarkers(data)).toEqual([
      { index: 4, label: "Lap 1" },
      { index: 8, label: "Lap 2" },
    ]);
  });

  it("falls back to km splits from the distance stream", () => {
    const data = makeData({
      streams: { distance: Array.from({ length: 11 }, (_, i) => i * 500) },
    });
    expect(buildSplitMarkers(data).map((s) => s.label)).toEqual([
      "1 km",
      "2 km",
      "3 km",
      "4 km",
    ]);
  });

  it("returns nothing without laps or an aligned distance stream", () => {
    expect(buildSplitMarkers(makeData())).toEqual([]);
    expect(
      buildSplitMarkers(makeData({ streams: { distance: [0, 100] } })),
    ).toEqual([]);
  });
});

describe("buildWaypointMarkers", () => {
  it("returns nothing without waypoint annotations", () => {
    expect(buildWaypointMarkers(makeData())).toEqual([]);
    expect(buildWaypointMarkers(makeData({ annotations: {} }))).toEqual([]);
  });

  it("formats the hover title from label and the caller's distance", () => {
    const data = makeData({
      annotations: {
        waypoints: [
          { index: 3, km: 11, label: "Gel 1 (caffeinated)", kind: "fuel" },
          { index: 8, km: 40.2, label: "Botanic Gardens", kind: "climb" },
        ],
      },
    });
    expect(buildWaypointMarkers(data)).toEqual([
      { index: 3, kind: "fuel", title: "Gel 1 (caffeinated) · 11 km" },
      { index: 8, kind: "climb", title: "Botanic Gardens · 40.2 km" },
    ]);
  });
});
