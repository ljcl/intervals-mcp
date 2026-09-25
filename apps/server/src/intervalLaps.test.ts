import { describe, expect, it } from "vitest";
import activityMultilap from "./__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "./__fixtures__/intervals/activity-multilap-intervals.json";
import {
  cadenceUnit,
  formatLapLine,
  type LapEntry,
  mapIntervalsToLaps,
} from "./intervalLaps";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";

const runActivity = activityMultilap as unknown as IntervalsActivity;
const runIntervals =
  multilapIntervals.icu_intervals as unknown as IntervalsInterval[];

describe("mapIntervalsToLaps", () => {
  it("maps the multi-lap fixture in order with pace, GAP, and doubled cadence", () => {
    const laps = mapIntervalsToLaps(runActivity, runIntervals);

    expect(laps).toHaveLength(runIntervals.length);
    expect(laps.map((lap) => lap.lap_index)).toEqual(
      Array.from({ length: runIntervals.length }, (_, i) => i + 1),
    );

    const first = laps[0]!;
    expect(first.type).toBe("WORK");
    expect(first.distance_km).toBe(0.76);
    expect(first.moving_time_s).toBe(237);
    expect(first.moving_time).toBe("3:57");
    expect(first.elapsed_time_s).toBe(311);
    // 759.72 m / 237 s -> 3.2056 m/s -> 5:12 /km.
    expect(first.pace_min_per_km).toBe("5:12");
    // gap 3.427648 m/s -> 4:52 /km.
    expect(first.gap_min_per_km).toBe("4:52");
    expect(first.speed_kmh).toBeNull();
    // 80.65126 strides/min doubled -> 161 spm (Run is a step-cadence type).
    expect(first.average_cadence).toBe(161);
    expect(first.average_hr).toBe(139);
    expect(first.max_hr).toBe(157);
    expect(first.average_watts).toBeNull();
    expect(first.elevation_gain_m).toBe(4);
    expect(first.average_gradient_pct).toBe(0.39);

    const second = laps[1]!;
    expect(second.type).toBe("RECOVERY");
  });

  it("leaves pace and distance null when an interval carries no distance", () => {
    const laps = mapIntervalsToLaps(runActivity, runIntervals);
    const last = laps[laps.length - 1]!;

    expect(last.distance_km).toBeNull();
    expect(last.pace_min_per_km).toBeNull();
    expect(last.moving_time_s).toBe(4);
    expect(last.moving_time).toBe("0:04");
  });

  it("reports speed and rpm cadence for a non-pace distance sport (Ride)", () => {
    const rideActivity: Pick<IntervalsActivity, "type"> = { type: "Ride" };
    const rideIntervals = [
      {
        type: "WORK",
        label: null,
        distance: 5000,
        moving_time: 500,
        elapsed_time: 500,
        average_heartrate: 150,
        max_heartrate: 160,
        average_cadence: 88,
        average_speed: 10,
        gap: 9.5,
        total_elevation_gain: 20,
        average_watts: 220,
        average_gradient: 0.01,
      } as unknown as IntervalsInterval,
    ];

    const laps = mapIntervalsToLaps(rideActivity, rideIntervals);
    const lap = laps[0]!;

    expect(lap.pace_min_per_km).toBeNull();
    expect(lap.gap_min_per_km).toBeNull();
    // 10 m/s -> 36 km/h.
    expect(lap.speed_kmh).toBe(36);
    // rpm, not doubled.
    expect(lap.average_cadence).toBe(88);
    expect(lap.average_watts).toBe(220);
    expect(cadenceUnit("Ride")).toBe("rpm");
  });

  it("falls back to distance/moving_time for speed when average_speed is absent", () => {
    const rideActivity: Pick<IntervalsActivity, "type"> = { type: "Ride" };
    const rideIntervals = [
      {
        type: "WORK",
        distance: 5000,
        moving_time: 500,
        average_speed: null,
      } as unknown as IntervalsInterval,
    ];

    const laps = mapIntervalsToLaps(rideActivity, rideIntervals);

    expect(laps[0]!.speed_kmh).toBe(36);
  });

  it("returns an empty array for an activity with no intervals", () => {
    expect(mapIntervalsToLaps(runActivity, [])).toEqual([]);
  });
});

describe("cadenceUnit", () => {
  it("is spm for step-cadence types and rpm otherwise", () => {
    expect(cadenceUnit("Run")).toBe("spm");
    expect(cadenceUnit("Walk")).toBe("spm");
    expect(cadenceUnit("Ride")).toBe("rpm");
    expect(cadenceUnit("WeightTraining")).toBe("rpm");
  });
});

describe("formatLapLine", () => {
  function lap(overrides: Partial<LapEntry> = {}): LapEntry {
    return {
      lap_index: 1,
      type: "WORK",
      label: null,
      distance_km: 1.2,
      moving_time_s: 300,
      moving_time: "5:00",
      elapsed_time_s: 300,
      pace_min_per_km: "4:10",
      gap_min_per_km: "4:05",
      gap_source: "intervals.icu",
      speed_kmh: null,
      average_hr: 165,
      max_hr: 172,
      average_cadence: 170,
      average_watts: null,
      elevation_gain_m: 5,
      average_gradient_pct: null,
      ...overrides,
    };
  }

  it("includes pace/GAP/HR/cadence/elevation for a run lap", () => {
    expect(formatLapLine(lap(), "spm")).toBe(
      "1. WORK: 1.20 km, 5:00, 4:10 /km, GAP 4:05 /km, HR 165/172, cadence 170 spm, +5 m",
    );
  });

  it("includes speed/watts/grade when present (a cycling lap)", () => {
    expect(
      formatLapLine(
        lap({
          type: "WORK",
          pace_min_per_km: null,
          gap_min_per_km: null,
          speed_kmh: 32,
          average_watts: 210,
          average_cadence: 88,
          average_gradient_pct: 3.2,
        }),
        "rpm",
      ),
    ).toBe(
      "1. WORK: 1.20 km, 5:00, 32 km/h, 210 W, HR 165/172, cadence 88 rpm, +5 m, 3.2% grade",
    );
  });

  it("falls back to type, then the literal lap, when label is missing", () => {
    expect(formatLapLine(lap({ label: "Sprint" }), "spm")).toMatch(
      /^1\. Sprint:/,
    );
    expect(formatLapLine(lap({ label: null, type: null }), "spm")).toMatch(
      /^1\. lap:/,
    );
  });
});
