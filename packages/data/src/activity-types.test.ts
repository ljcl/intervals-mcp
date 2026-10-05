import { describe, expect, it } from "vitest";
import { isRunning, isSwimming } from "./activity-types";

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
