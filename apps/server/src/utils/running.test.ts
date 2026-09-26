import { describe, expect, it } from "vitest";
import { type IntervalsActivity } from "../intervalsClient";
import {
  activityCadenceSpm,
  assessCadence,
  assessRunningDynamics,
  buildRunningDynamics,
  cadenceSpm,
  formatPaceSeconds,
  gapPace,
  isPaceActivity,
  isRunningActivity,
  isStepCadenceActivity,
  metersPerSecToPace,
  paceFromDistanceTime,
} from "./running";

describe("formatPaceSeconds", () => {
  it("formats 282 seconds as 4:42", () => {
    expect(formatPaceSeconds(282)).toBe("4:42");
  });

  it("rounds 299.6 seconds up into the next minute as 5:00", () => {
    expect(formatPaceSeconds(299.6)).toBe("5:00");
  });

  it("returns 0:00 for zero seconds rather than throwing", () => {
    expect(formatPaceSeconds(0)).toBe("0:00");
  });

  it("returns 0:00 for NaN rather than emitting NaN:NaN", () => {
    expect(formatPaceSeconds(Number.NaN)).toBe("0:00");
  });

  it("returns 0:00 for Infinity rather than throwing", () => {
    expect(formatPaceSeconds(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  it("returns 0:00 for a negative input", () => {
    expect(formatPaceSeconds(-5)).toBe("0:00");
  });
});

describe("isRunningActivity", () => {
  it("returns true for Run", () => {
    expect(isRunningActivity("Run")).toBe(true);
  });

  it("returns true for VirtualRun", () => {
    expect(isRunningActivity("VirtualRun")).toBe(true);
  });

  it("returns true for TrailRun", () => {
    expect(isRunningActivity("TrailRun")).toBe(true);
  });

  it("returns true for Walk", () => {
    expect(isRunningActivity("Walk")).toBe(true);
  });

  it("returns true for Hike", () => {
    expect(isRunningActivity("Hike")).toBe(true);
  });

  it("returns false for Ride", () => {
    expect(isRunningActivity("Ride")).toBe(false);
  });

  it("returns false for Swim", () => {
    expect(isRunningActivity("Swim")).toBe(false);
  });
});

describe("metersPerSecToPace", () => {
  it("converts 3.33 m/s to approximately 5:00/km pace", () => {
    const result = metersPerSecToPace(3.333);
    expect(result?.minPerKm).toBe("5:00");
  });

  it("calculates km/h correctly", () => {
    const result = metersPerSecToPace(3.333);
    expect(result?.kmh).toBeCloseTo(12.0, 1);
  });

  it("returns null for zero speed", () => {
    expect(metersPerSecToPace(0)).toBeNull();
  });

  it("returns null for negative speed", () => {
    expect(metersPerSecToPace(-1)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(metersPerSecToPace(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(metersPerSecToPace(undefined)).toBeNull();
  });

  it("calculates mile pace correctly", () => {
    const result = metersPerSecToPace(3.333);
    // 1609.34m / 3.333 m/s ≈ 483 seconds ≈ 8:03 per mile
    expect(result?.minPerMile).toBe("8:03");
  });

  it("carries seconds rollover in km pace instead of emitting :60", () => {
    // 1000 / 2.7816 ≈ 359.5 s/km; naive rounding would render "5:60".
    const result = metersPerSecToPace(2.7816);
    expect(result?.minPerKm).toBe("6:00");
    expect(result?.display).toBe("6:00 /km");
  });

  it("carries seconds rollover in mile pace instead of emitting :60", () => {
    // 1609.34 / 2.684 ≈ 599.6 s/mile; naive rounding would render "9:60".
    const result = metersPerSecToPace(2.684);
    expect(result?.minPerMile).toBe("10:00");
  });
});

describe("isPaceActivity", () => {
  it("returns true for Run, TrailRun, VirtualRun", () => {
    expect(isPaceActivity("Run")).toBe(true);
    expect(isPaceActivity("TrailRun")).toBe(true);
    expect(isPaceActivity("VirtualRun")).toBe(true);
  });

  it("returns false for Walk and Hike (cadence but no pace)", () => {
    expect(isPaceActivity("Walk")).toBe(false);
    expect(isPaceActivity("Hike")).toBe(false);
  });

  it("returns false for a non-foot sport", () => {
    expect(isPaceActivity("Ride")).toBe(false);
  });
});

describe("isStepCadenceActivity", () => {
  it("returns true for runs, walks, and hikes", () => {
    expect(isStepCadenceActivity("Run")).toBe(true);
    expect(isStepCadenceActivity("TrailRun")).toBe(true);
    expect(isStepCadenceActivity("VirtualRun")).toBe(true);
    expect(isStepCadenceActivity("Walk")).toBe(true);
    expect(isStepCadenceActivity("Hike")).toBe(true);
  });

  it("returns false for a non-foot sport", () => {
    expect(isStepCadenceActivity("Ride")).toBe(false);
    expect(isStepCadenceActivity("Swim")).toBe(false);
  });
});

describe("cadenceSpm", () => {
  it("doubles strides to steps for a run", () => {
    expect(cadenceSpm(85, "Run")).toBe(170);
  });

  it("doubles strides to steps for a walk", () => {
    expect(cadenceSpm(60, "Walk")).toBe(120);
  });

  it("doubles strides to steps for a hike", () => {
    expect(cadenceSpm(50, "Hike")).toBe(100);
  });

  it("returns the raw rate unchanged for a non-step-cadence type", () => {
    expect(cadenceSpm(90, "Ride")).toBe(90);
  });

  it("returns null when strides is null or undefined", () => {
    expect(cadenceSpm(null, "Run")).toBeNull();
    expect(cadenceSpm(undefined, "Run")).toBeNull();
  });
});

describe("paceFromDistanceTime", () => {
  it("computes a pace string from distance and moving time", () => {
    // 5000m in 1500s = 5:00/km.
    expect(paceFromDistanceTime(5000, 1500)).toBe("5:00");
  });

  it("returns null when distance is missing or non-positive", () => {
    expect(paceFromDistanceTime(null, 1500)).toBeNull();
    expect(paceFromDistanceTime(0, 1500)).toBeNull();
    expect(paceFromDistanceTime(-5, 1500)).toBeNull();
  });

  it("returns null when moving time is missing or non-positive", () => {
    expect(paceFromDistanceTime(5000, null)).toBeNull();
    expect(paceFromDistanceTime(5000, 0)).toBeNull();
    expect(paceFromDistanceTime(5000, -5)).toBeNull();
  });

  it("does not gate on activity type: the caller decides via isPaceActivity", () => {
    // No type parameter at all -- a Walk's distance/time still produces a
    // pace string here; get-activity/list-activities decide whether to show
    // it by checking isPaceActivity(type) before calling this.
    expect(paceFromDistanceTime(3000, 1800)).toBe("10:00");
  });
});

describe("gapPace", () => {
  it("converts a pace type's gap (m/s) to a min/km string", () => {
    // 3.4783862 m/s -> 4:47/km; the fixture value get-activity's
    // gap_min_per_km rests on.
    expect(gapPace(3.4783862, "Run")).toBe("4:47");
  });

  it("returns null for a non-pace sport, even with a gap value", () => {
    expect(gapPace(9.5, "Ride")).toBeNull();
    expect(gapPace(9.5, "WeightTraining")).toBeNull();
  });

  it("returns null when gap is missing", () => {
    expect(gapPace(null, "Run")).toBeNull();
    expect(gapPace(undefined, "Run")).toBeNull();
  });
});

describe("assessCadence", () => {
  it("returns low assessment for cadence under 160", () => {
    expect(assessCadence(155)).toContain("low");
  });

  it("returns moderate for cadence 160-169", () => {
    expect(assessCadence(165)).toContain("moderate");
  });

  it("returns good for cadence 170-179", () => {
    expect(assessCadence(175)).toBe("good");
  });

  it("returns very good for cadence 180-189", () => {
    expect(assessCadence(185)).toBe("very good");
  });

  it("returns excellent for cadence 190+", () => {
    expect(assessCadence(195)).toBe("excellent");
  });

  it("returns null for null input", () => {
    expect(assessCadence(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(assessCadence(undefined)).toBeNull();
  });
});

describe("activityCadenceSpm", () => {
  it("doubles strides/min to steps/min and rounds for a step-cadence type", () => {
    expect(activityCadenceSpm(83.6, "Run")).toBe(167);
  });

  it("returns null for a non-step-cadence type (e.g. Ride)", () => {
    expect(activityCadenceSpm(90, "Ride")).toBeNull();
  });

  it("returns null when raw cadence is missing", () => {
    expect(activityCadenceSpm(null, "Run")).toBeNull();
  });
});

describe("buildRunningDynamics", () => {
  function activity(
    overrides: Partial<IntervalsActivity> = {},
  ): IntervalsActivity {
    return {
      average_stance_time: 233.21266,
      average_vertical_oscillation: 108.36414,
      average_vertical_ratio: 8.5,
      average_step_length: 1200,
      average_stride: 1.2,
      ...overrides,
    } as IntervalsActivity;
  }

  it("rounds each field for a step-cadence type with device support", () => {
    expect(buildRunningDynamics(activity(), "Run")).toEqual({
      stance_time_ms: 233,
      vertical_oscillation_mm: 108,
      vertical_ratio_pct: 8.5,
      step_length_mm: 1200,
      stride_m: 1.2,
    });
  });

  it("returns null for a non-step-cadence type", () => {
    expect(buildRunningDynamics(activity(), "Ride")).toBeNull();
  });

  it("returns null when the device recorded no stance time", () => {
    expect(
      buildRunningDynamics(activity({ average_stance_time: null }), "Run"),
    ).toBeNull();
  });
});

describe("assessRunningDynamics", () => {
  it("flags a vertical oscillation of 108 mm as high, above the 100 mm target", () => {
    const rd = assessRunningDynamics(108, 233);
    expect(rd.vertical_oscillation).toEqual({
      status: "high",
      target: "under 100 mm",
      message: "high - at or above the 100 mm target",
    });
  });

  it("flags a ground contact time of 233 ms as within the 200-260 ms target range", () => {
    const rd = assessRunningDynamics(108, 233);
    expect(rd.ground_contact_time).toEqual({
      status: "within",
      target: "200-260 ms",
      message: "good - within the 200-260 ms target range",
    });
  });

  it("treats a vertical oscillation under 100 mm as within target", () => {
    expect(assessRunningDynamics(95, null).vertical_oscillation).toEqual({
      status: "within",
      target: "under 100 mm",
      message: "good - under the 100 mm target",
    });
  });

  it("flags a ground contact time under 200 ms as low", () => {
    expect(assessRunningDynamics(null, 190).ground_contact_time).toEqual({
      status: "low",
      target: "200-260 ms",
      message: "fast - below the 200-260 ms target range",
    });
  });

  it("flags a ground contact time over 260 ms as high", () => {
    expect(assessRunningDynamics(null, 270).ground_contact_time).toEqual({
      status: "high",
      target: "200-260 ms",
      message: "long - above the 200-260 ms target range",
    });
  });

  it("returns null per metric when its input is null", () => {
    expect(assessRunningDynamics(null, null)).toEqual({
      vertical_oscillation: null,
      ground_contact_time: null,
    });
  });

  describe("boundaries", () => {
    it("flags a vertical oscillation of exactly 100 mm as high (the target is strictly under 100)", () => {
      expect(
        assessRunningDynamics(100, null).vertical_oscillation?.status,
      ).toBe("high");
    });

    it("says 'at or above' for exactly 100 mm, never 'above' a value it equals", () => {
      expect(assessRunningDynamics(100, null).vertical_oscillation).toEqual({
        status: "high",
        target: "under 100 mm",
        message: "high - at or above the 100 mm target",
      });
    });

    it("treats a ground contact time of exactly 200 ms as within (the range's lower bound is inclusive)", () => {
      expect(assessRunningDynamics(null, 200).ground_contact_time?.status).toBe(
        "within",
      );
    });

    it("treats a ground contact time of exactly 260 ms as within (the range's upper bound is inclusive)", () => {
      expect(assessRunningDynamics(null, 260).ground_contact_time?.status).toBe(
        "within",
      );
    });

    it("flags a ground contact time of 199 ms as low", () => {
      expect(assessRunningDynamics(null, 199).ground_contact_time?.status).toBe(
        "low",
      );
    });

    it("flags a ground contact time of 261 ms as high", () => {
      expect(assessRunningDynamics(null, 261).ground_contact_time?.status).toBe(
        "high",
      );
    });
  });
});
