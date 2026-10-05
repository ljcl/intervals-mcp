import { describe, expect, it } from "vitest";
import {
  MIN_MOVING_SPEED_MPS,
  speedDisplay,
  speedDisplayForSport,
  speedSport,
} from "./speed";

describe("speedSport", () => {
  it("groups run-like, swim and other types", () => {
    for (const t of ["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]) {
      expect(speedSport(t), t).toBe("run");
    }
    expect(speedSport("Swim")).toBe("swim");
    expect(speedSport("OpenWaterSwim")).toBe("swim");
    expect(speedSport("Ride")).toBe("other");
    expect(speedSport("")).toBe("other");
    expect(speedSport(null)).toBe("other");
    expect(speedSport(undefined)).toBe("other");
  });
});

describe("speedDisplay: run", () => {
  const run = speedDisplay("Run");
  it("labels pace in min/km on a reversed axis", () => {
    expect(run).toMatchObject({
      sport: "run",
      label: "Pace",
      unit: "min/km",
      reversed: true,
    });
  });
  it("converts m/s to minutes per km with no cap", () => {
    expect(run.fromMps(4)).toBeCloseTo(4.1667, 4);
    expect(speedDisplay("Walk").fromMps(1000 / 1200)).toBeCloseTo(20, 6);
    expect(speedDisplay("Hike").fromMps(0.5)).toBeCloseTo(33.333, 2);
  });
  it("treats a stopped or missing sample as a gap", () => {
    expect(run.fromMps(0)).toBeNull();
    expect(run.fromMps(MIN_MOVING_SPEED_MPS - 0.01)).toBeNull();
    expect(run.fromMps(null)).toBeNull();
    expect(run.fromMps(undefined)).toBeNull();
    expect(run.fromMps(Number.NaN)).toBeNull();
  });
  it("formats values and raw speeds", () => {
    expect(run.format(5.5)).toBe(`5'30"`);
    expect(run.formatMps(4)).toBe(`4'10" /km`);
    expect(run.formatMps(3.125)).toBe(`5'20" /km`);
    expect(run.formatMps(0.2)).toBe("—");
    expect(run.formatMps(null)).toBe("—");
  });
});

describe("speedDisplay: swim", () => {
  it("uses pace per 100 m for every swim type", () => {
    for (const t of ["Swim", "OpenWaterSwim"]) {
      const swim = speedDisplay(t);
      expect(swim).toMatchObject({
        sport: "swim",
        label: "Pace",
        unit: "/100m",
        reversed: true,
      });
      expect(swim.fromMps(1)).toBeCloseTo(100 / 60, 6);
      expect(swim.fromMps(0)).toBeNull();
      expect(swim.formatMps(1)).toBe(`1'40" /100m`);
    }
  });
});

describe("speedDisplay: other sports", () => {
  const ride = speedDisplay("Ride");
  it("labels speed in km/h on a normal axis", () => {
    expect(ride).toMatchObject({
      sport: "other",
      label: "Speed",
      unit: "km/h",
      reversed: false,
    });
  });
  it("keeps a stopped sample as 0 km/h, a true reading", () => {
    expect(ride.fromMps(0)).toBe(0);
    expect(ride.fromMps(7.9)).toBeCloseTo(28.44, 2);
    expect(ride.fromMps(null)).toBeNull();
    expect(ride.fromMps(-1)).toBeNull();
  });
  it("formats km/h to one decimal", () => {
    expect(ride.format(28.44)).toBe("28.4");
    expect(ride.formatMps(7.9)).toBe("28.4 km/h");
    expect(ride.formatMps(0)).toBe("0.0 km/h");
    expect(ride.formatMps(undefined)).toBe("—");
  });
});

describe("speedDisplayForSport", () => {
  it("returns the same display as the type lookup", () => {
    expect(speedDisplayForSport("swim")).toBe(speedDisplay("Swim"));
    expect(speedDisplayForSport("other")).toBe(speedDisplay("Ride"));
  });
});
