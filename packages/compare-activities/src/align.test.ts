import { speedDisplayForSport } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import {
  alignSeries,
  type MetricSeries,
  paceCategory,
  sharedAxes,
  sharedMetrics,
  toMetricSeries,
} from "./align";
import { type ActivityStreamData } from "./types";

function streamData(
  overrides: Partial<ActivityStreamData["streams"]>,
  activityType = "Run",
): ActivityStreamData {
  return {
    activityId: "1",
    activityType,
    name: "Test",
    streams: { time: [0, 10, 20, 30], ...overrides },
  };
}

describe("paceCategory", () => {
  it("is run only when both activities are pace-per-km sports", () => {
    expect(paceCategory("Run", "TrailRun")).toBe("run");
    expect(paceCategory("Run", "Walk")).toBe("run");
    expect(paceCategory("Run", "Ride")).toBe("other");
    expect(paceCategory("Ride", "Ride")).toBe("other");
  });

  it("is swim only when both are swims", () => {
    expect(paceCategory("Swim", "Swim")).toBe("swim");
    expect(paceCategory("Swim", "OpenWaterSwim")).toBe("swim");
    expect(paceCategory("Swim", "Run")).toBe("other");
  });

  it("labels and units follow the category", () => {
    const run = speedDisplayForSport(paceCategory("Run", "TrailRun"));
    expect([run.label, run.unit]).toEqual(["Pace", "min/km"]);
    const swim = speedDisplayForSport(paceCategory("Swim", "Swim"));
    expect([swim.label, swim.unit]).toEqual(["Pace", "/100m"]);
    const mixed = speedDisplayForSport(paceCategory("Run", "Ride"));
    expect([mixed.label, mixed.unit]).toEqual(["Speed", "km/h"]);
  });
});

describe("toMetricSeries", () => {
  it("converts velocity to min/km pace for runs, with a stop as a gap", () => {
    const series = toMetricSeries(
      streamData({ velocity_smooth: [3.3333, 0, 5, 0.2] }),
      "run",
    );
    expect(series.values.pace?.[0]).toBeCloseTo(5, 2);
    expect(series.values.pace?.[1]).toBeNull();
    expect(series.values.pace?.[2]).toBeCloseTo(1000 / 5 / 60, 4);
    expect(series.values.pace?.[3]).toBeNull();
  });

  it("converts velocity to min/100m for swims, with no cap", () => {
    const series = toMetricSeries(
      streamData({ velocity_smooth: [1, 0.3, 0, 1.25] }, "Swim"),
      "swim",
    );
    expect(series.values.pace?.[0]).toBeCloseTo(100 / 1 / 60, 4);
    // Slower than the old 5 min/100m cap, and still plotted at its real value.
    expect(series.values.pace?.[1]).toBeCloseTo(100 / 0.3 / 60, 4);
    expect(series.values.pace?.[2]).toBeNull();
  });

  it("converts velocity to km/h for the other category", () => {
    const series = toMetricSeries(
      streamData({ velocity_smooth: [10, 10, 10, 0] }, "Ride"),
      "other",
    );
    expect(series.values.pace?.[0]).toBeCloseTo(36, 5);
    expect(series.values.pace?.[3]).toBe(0);
  });

  it("doubles cadence for runs but not rides", () => {
    const run = toMetricSeries(
      streamData({ cadence: [80, 82, 84, 86] }),
      "run",
    );
    expect(run.values.cadence?.[0]).toBe(160);

    const ride = toMetricSeries(
      streamData({ cadence: [80, 82, 84, 86] }, "Ride"),
      "other",
    );
    expect(ride.values.cadence?.[0]).toBe(80);
  });

  it("drops all-zero altitude and length-mismatched streams", () => {
    const series = toMetricSeries(
      streamData({ altitude: [0, 0, 0, 0], heartrate: [140, 141] }),
      "run",
    );
    expect(series.values.altitude).toBeUndefined();
    expect(series.values.heartrate).toBeUndefined();
  });

  it("keeps a null velocity sample as a gap, not a capped pace spike", () => {
    const series = toMetricSeries(
      streamData({ velocity_smooth: [3.3333, null, 5, 0.5] }),
      "run",
    );
    expect(series.values.pace?.[1]).toBeNull();
  });

  it("keeps a null cadence sample as null, not 0", () => {
    const run = toMetricSeries(
      streamData({ cadence: [80, null, 84, 86] }),
      "run",
    );
    expect(run.values.cadence?.[1]).toBeNull();
  });

  it("keeps the distance axis only when aligned with time", () => {
    const withDistance = toMetricSeries(
      streamData({ distance: [0, 50, 100, 150] }),
      "run",
    );
    expect(withDistance.distance).toEqual([0, 50, 100, 150]);

    const without = toMetricSeries(streamData({}), "run");
    expect(without.distance).toBeUndefined();
  });
});

describe("sharedMetrics / sharedAxes", () => {
  const withHrAndPace: MetricSeries = {
    time: [0, 10],
    distance: [0, 50],
    values: { heartrate: [140, 150], pace: [5, 5.2] },
  };
  const hrOnly: MetricSeries = {
    time: [0, 10],
    values: { heartrate: [130, 135] },
  };

  it("intersects the metrics available on both sides, pace first", () => {
    expect(sharedMetrics(withHrAndPace, withHrAndPace)).toEqual([
      "pace",
      "heartrate",
    ]);
    expect(sharedMetrics(withHrAndPace, hrOnly)).toEqual(["heartrate"]);
  });

  it("offers the distance axis only when both activities recorded it", () => {
    expect(sharedAxes(withHrAndPace, withHrAndPace)).toEqual([
      "distance",
      "time",
    ]);
    expect(sharedAxes(withHrAndPace, hrOnly)).toEqual(["time"]);
  });
});

describe("alignSeries", () => {
  const linear = (start: number, slope: number): MetricSeries => ({
    time: [0, 100],
    distance: [0, 1000],
    values: { heartrate: [start, start + slope * 100] },
  });

  it("resamples both series onto one grid of the requested size", () => {
    const points = alignSeries(linear(100, 1), linear(120, 1), "time", 11);
    expect(points).toHaveLength(11);
    expect(points[0]?.x).toBe(0);
    expect(points[10]?.x).toBe(100);
  });

  it("linearly interpolates values on the grid", () => {
    // Window smoothing averages symmetric neighbours, so interior points of a
    // straight line stay exact.
    const points = alignSeries(linear(100, 1), linear(120, 1), "time", 11);
    expect(points[5]?.aHeartrate).toBeCloseTo(150, 6);
    expect(points[5]?.bHeartrate).toBeCloseTo(170, 6);
  });

  it("ends the shorter activity's line instead of extrapolating", () => {
    const short: MetricSeries = {
      time: [0, 50],
      values: { heartrate: [100, 100] },
    };
    const points = alignSeries(short, linear(120, 1), "time", 11);
    expect(points[5]?.aHeartrate).toBeDefined();
    expect(points[6]?.aHeartrate).toBeUndefined();
    expect(points[10]?.bHeartrate).toBeDefined();
  });

  it("aligns on distance when asked", () => {
    const points = alignSeries(linear(100, 1), linear(120, 1), "distance", 11);
    expect(points[10]?.x).toBe(1000);
    // linear() maps hr 100→200 across 0–1000 m, so the midpoint is 150.
    expect(points[5]?.aHeartrate).toBeCloseTo(150, 6);
  });

  it("returns empty when an activity lacks the requested axis", () => {
    const noDistance: MetricSeries = {
      time: [0, 100],
      values: { heartrate: [100, 110] },
    };
    expect(alignSeries(noDistance, linear(120, 1), "distance")).toEqual([]);
  });

  it("leaves a null sample as a gap instead of interpolating a fake value", () => {
    // A real dropout mid-recording: any grid point bracketed by the null
    // sample must come back undefined (Recharts gap), not a fabricated
    // number blended from the surrounding readings.
    const withGap: MetricSeries = {
      time: [0, 25, 50, 75, 100],
      values: { heartrate: [100, 110, null, 130, 140] },
    };
    const points = alignSeries(withGap, withGap, "time", 5);
    expect(points[2]?.aHeartrate).toBeUndefined();
  });
});
