import { describe, expect, it } from "vitest";
import { cadenceLabel, isRunning, isSwimming } from "./activity-types";

describe("isRunning", () => {
  it("covers all run-like types including walks and hikes", () => {
    for (const type of ["Run", "VirtualRun", "TrailRun", "Walk", "Hike"]) {
      expect(isRunning(type), type).toBe(true);
    }
  });

  it("rejects rides and swims", () => {
    expect(isRunning("Ride")).toBe(false);
    expect(isRunning("Swim")).toBe(false);
    expect(isRunning("")).toBe(false);
  });
});

describe("isSwimming", () => {
  it("matches every swim type", () => {
    expect(isSwimming("Swim")).toBe(true);
    expect(isSwimming("OpenWaterSwim")).toBe(true);
    expect(isSwimming("Run")).toBe(false);
    expect(isSwimming("VirtualSwim")).toBe(false);
  });
});

describe("cadenceLabel", () => {
  it("is spm for the step-cadence types, walks and hikes included", () => {
    for (const type of ["Run", "VirtualRun", "TrailRun", "Walk", "Hike"]) {
      expect(cadenceLabel(type), type).toBe("spm");
    }
  });

  it("is strokes/min for a swim and rpm for everything else", () => {
    expect(cadenceLabel("Swim")).toBe("strokes/min");
    expect(cadenceLabel("OpenWaterSwim")).toBe("strokes/min");
    expect(cadenceLabel("Ride")).toBe("rpm");
    expect(cadenceLabel("WeightTraining")).toBe("rpm");
    expect(cadenceLabel("")).toBe("rpm");
  });
});
