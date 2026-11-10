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

  it("says which stretch of the route is in view", () => {
    const summary = buildRouteMapContextSummary({
      name: "Morning Run",
      activityType: "Run",
      distanceKm: 20,
      elevationGain: 0,
      hasGeometry: true,
      visible: "Showing 12.0–16.0 km of the route",
    });
    expect(summary).toBe(
      'Viewing the map for Run activity "Morning Run". Distance 20.0 km. Showing 12.0–16.0 km of the route.',
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

  it("summarises a stored route, after the edit just made", () => {
    const summary = buildRouteMapContextSummary({
      name: "Bay Run (v4)",
      activityType: "Run",
      distanceKm: 13.24,
      elevationGain: 120,
      hasGeometry: true,
      colorMetric: "Altitude",
      route: {
        routeId: "r1",
        version: 4,
        latestVersion: 4,
        sectionCount: 1,
        compare: "Compared with version 3: the line is the same.",
      },
      note: "Route r1 is now version 4.",
    });
    expect(summary).toBe(
      'Route r1 is now version 4. Viewing the map for stored route "Bay Run (v4)" (route_id r1), version 4 of 4. Distance 13.2 km. Elevation gain 120 m. It has 1 section. Compared with version 3: the line is the same.',
    );
  });

  it("names a suggested route's planned run and place among the options", () => {
    const summary = buildRouteMapContextSummary({
      name: "Easy 6 km: New loop",
      activityType: "Run",
      distanceKm: 6.12,
      elevationGain: 25,
      hasGeometry: true,
      colorMetric: "Altitude",
      suggestion: {
        run: "Easy 6 km",
        date: "2026-10-20",
        option: 2,
        count: 3,
        label: "New loop, score 79",
      },
    });
    expect(summary).toBe(
      'Viewing the map for suggested route 2 of 3 ("New loop, score 79") for planned run "Easy 6 km" on 2026-10-20. Distance 6.1 km. Elevation gain 25 m.',
    );
  });
});
