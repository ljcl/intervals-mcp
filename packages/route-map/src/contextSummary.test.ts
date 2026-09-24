import { describe, expect, it } from "vitest";
import { buildRouteMapContextSummary } from "./contextSummary";

describe("buildRouteMapContextSummary", () => {
  it("returns null without a name", () => {
    expect(
      buildRouteMapContextSummary({
        name: null,
        activityType: "Run",
        distanceKm: 5,
        elevationGain: 20,
        hasGeometry: true,
      }),
    ).toBeNull();
  });

  it("summarises an activity with geometry", () => {
    const summary = buildRouteMapContextSummary({
      name: "Morning Run",
      activityType: "Run",
      distanceKm: 10.23,
      elevationGain: 84,
      hasGeometry: true,
    });
    expect(summary).toBe(
      'Viewing the map for Run activity "Morning Run". Distance 10.2 km. Elevation gain 84 m.',
    );
  });

  it("omits zero elevation gain", () => {
    const summary = buildRouteMapContextSummary({
      name: "Flat Loop",
      activityType: "Ride",
      distanceKm: 40,
      elevationGain: 0,
      hasGeometry: true,
    });
    expect(summary).toBe(
      'Viewing the map for Ride activity "Flat Loop". Distance 40.0 km.',
    );
  });

  it("mentions the metric the track is coloured by", () => {
    const summary = buildRouteMapContextSummary({
      name: "Morning Run",
      activityType: "Run",
      distanceKm: 10,
      elevationGain: 84,
      hasGeometry: true,
      colorMetric: "Heart rate",
    });
    expect(summary).toBe(
      'Viewing the map for Run activity "Morning Run". Distance 10.0 km. Elevation gain 84 m. The track is coloured by heart rate.',
    );
  });

  it("notes when there is no GPS track", () => {
    const summary = buildRouteMapContextSummary({
      name: "Treadmill",
      activityType: "Run",
      distanceKm: 0,
      elevationGain: 0,
      hasGeometry: false,
    });
    expect(summary).toBe(
      'Viewing the map for Run activity "Treadmill". No GPS track is available for it.',
    );
  });
});
