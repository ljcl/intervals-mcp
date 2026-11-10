import { describe, expect, it } from "vitest";
import {
  buildElevationStripDescription,
  buildRouteMapA11yDescription,
  extentSpansKm,
} from "./a11yDescription";

/** ~1.11 km per 0.01° of latitude; longitude scaled at the equator too. */
const loopTrack: Array<[number, number]> = [
  [0, 0],
  [0.01, 0.005],
  [0.02, 0.01],
  [0.01, 0.02],
  [0.0001, 0.0002],
];

const pointToPointNorthEast: Array<[number, number]> = [
  [0, 0],
  [0.02, 0.01],
  [0.05, 0.05],
];

describe("extentSpansKm", () => {
  it("returns null without at least two points", () => {
    expect(extentSpansKm([])).toBeNull();
    expect(extentSpansKm([[0, 0]])).toBeNull();
  });

  it("measures bounding-box spans in km", () => {
    const spans = extentSpansKm(loopTrack);
    expect(spans).not.toBeNull();
    // 0.02° of both at the equator ≈ 2.23 km.
    expect(spans?.ewKm).toBeCloseTo(2.23, 1);
    expect(spans?.nsKm).toBeCloseTo(2.23, 1);
  });

  it("scales east–west span by latitude", () => {
    const atSixtyNorth: Array<[number, number]> = [
      [60, 0],
      [60, 0.02],
    ];
    const spans = extentSpansKm(atSixtyNorth);
    // cos(60°) = 0.5 halves the equatorial span.
    expect(spans?.ewKm).toBeCloseTo(1.11, 1);
    expect(spans?.nsKm).toBeCloseTo(0, 5);
  });
});

describe("buildRouteMapA11yDescription", () => {
  it("describes a loop activity with altitude and annotations", () => {
    const description = buildRouteMapA11yDescription({
      name: "Morning Run",
      activityType: "Run",
      distanceKm: 10.23,
      elevationGain: 84,
      coordinates: loopTrack,
      altitude: [12.2, 48, 147.9, 90, 14],
      colorMetric: "Heart rate",
      splitCount: 10,
      splitKind: "splits",
    });
    expect(description).toBe(
      'Map of Run activity "Morning Run". 10.2 km with 84 m of climbing. ' +
        "A loop returning to its start, spanning roughly 2.2 km east to west and 2.2 km north to south. " +
        "Altitude ranges from 12 m to 148 m. " +
        "The track is coloured by heart rate. " +
        "Marked along the route: 10 kilometre splits.",
    );
  });

  it("describes a point-to-point activity with its compass direction", () => {
    const description = buildRouteMapA11yDescription({
      name: "Commute",
      activityType: "Ride",
      distanceKm: 8,
      elevationGain: 0,
      coordinates: pointToPointNorthEast,
    });
    expect(description).toContain('Map of Ride activity "Commute".');
    expect(description).toContain("8.0 km.");
    expect(description).not.toContain("climbing");
    expect(description).toContain("Point-to-point heading north-east");
  });

  it("pluralises lap markers", () => {
    const description = buildRouteMapA11yDescription({
      name: "Track Session",
      activityType: "Run",
      distanceKm: 5,
      elevationGain: 2,
      coordinates: loopTrack,
      splitCount: 5,
      splitKind: "laps",
    });
    expect(description).toContain("Marked along the route: 5 lap markers.");
  });

  it("counts caller-pinned waypoints among the annotations", () => {
    const description = buildRouteMapA11yDescription({
      name: "Race Recon",
      activityType: "Run",
      distanceKm: 42.2,
      elevationGain: 320,
      coordinates: loopTrack,
      waypointCount: 3,
    });
    expect(description).toContain("Marked along the route: 3 waypoints.");

    const singular = buildRouteMapA11yDescription({
      name: "Race Recon",
      activityType: "Run",
      distanceKm: 42.2,
      elevationGain: 320,
      coordinates: loopTrack,
      waypointCount: 1,
    });
    expect(singular).toContain("Marked along the route: 1 waypoint.");
  });

  it("omits shape, altitude, metric, and annotation sentences when absent", () => {
    const description = buildRouteMapA11yDescription({
      name: "Bare Activity",
      activityType: null,
      distanceKm: 3.4,
      elevationGain: 12,
      coordinates: loopTrack,
    });
    expect(description).toBe(
      'Map of activity "Bare Activity". 3.4 km with 12 m of climbing. ' +
        "A loop returning to its start, spanning roughly 2.2 km east to west and 2.2 km north to south.",
    );
  });

  it("reports a missing GPS track", () => {
    const description = buildRouteMapA11yDescription({
      name: "Treadmill Run",
      activityType: "Run",
      distanceKm: 5,
      elevationGain: 0,
      coordinates: [],
    });
    expect(description).toBe(
      'Map of Run activity "Treadmill Run". No GPS track is available.',
    );
  });

  it("uses metres for sub-kilometre spans", () => {
    const description = buildRouteMapA11yDescription({
      name: "Parkrun Lap",
      activityType: "Run",
      distanceKm: 0.9,
      elevationGain: 0,
      coordinates: [
        [0, 0],
        [0.003, 0.003],
        [0.0001, 0],
      ],
    });
    expect(description).toContain("330 m east to west");
    expect(description).toContain("330 m north to south");
  });
});

describe("buildRouteMapA11yDescription for a stored route", () => {
  it("names the version, the sections, the vias and the warnings", () => {
    const description = buildRouteMapA11yDescription({
      name: "Bay Run (v2)",
      activityType: "Run",
      distanceKm: 7,
      elevationGain: 0,
      coordinates: loopTrack,
      splitCount: 6,
      splitKind: "km",
      route: {
        version: 2,
        latestVersion: 3,
        sections: [
          { label: "To the bay", fromKm: 0, toKm: 2.5 },
          { label: "Bay Run", fromKm: 2.5, toKm: 7 },
        ],
        viaCount: 1,
        compare: "Compared with version 3: the line is the same.",
        warningCount: 2,
      },
    });
    expect(description).toBe(
      'Map of stored route "Bay Run (v2)", version 2 of 3. 7.0 km. A loop returning to its start, spanning roughly 2.2 km east to west and 2.2 km north to south. Marked along the route: 6 kilometre markers. The line is coloured by section, 2 sections: 0.0 to 2.5 km, To the bay; 2.5 to 7.0 km, Bay Run. 1 via point. Compared with version 3: the line is the same. 2 warnings are listed below the map.',
    );
  });
});

describe("buildRouteMapA11yDescription for a suggested route", () => {
  it("names the planned run and the option, not an activity", () => {
    const description = buildRouteMapA11yDescription({
      name: "Easy 6 km: New loop",
      activityType: "Run",
      distanceKm: 6,
      elevationGain: 0,
      coordinates: [],
      suggestion: {
        run: "Easy 6 km",
        date: "2026-10-20",
        option: 1,
        count: 2,
        label: "New loop",
      },
    });
    expect(description).toBe(
      'Map of suggested route 1 of 2 ("New loop") for planned run "Easy 6 km" on 2026-10-20. No GPS track is available.',
    );
  });
});

describe("buildElevationStripDescription", () => {
  it("narrates the altitude range over the distance", () => {
    expect(buildElevationStripDescription([12.4, 96.2, 40], 8.23)).toBe(
      "Altitude ranges from 12 m to 96 m over 8.2 km.",
    );
  });

  it("handles a missing altitude stream", () => {
    expect(buildElevationStripDescription([], 5)).toBe("No altitude data.");
  });
});
