import { describe, expect, it } from "vitest";
import { activityDisplayName, formatDuration, round } from "./formatters";

describe("formatDuration", () => {
  it("formats seconds to HH:MM:SS with hours", () => {
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("formats seconds to MM:SS without hours", () => {
    expect(formatDuration(125)).toBe("2:05");
  });

  it("pads single digit values", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("returns N/A for null", () => {
    expect(formatDuration(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(formatDuration(undefined)).toBe("N/A");
  });

  it("returns N/A for negative values", () => {
    expect(formatDuration(-10)).toBe("N/A");
  });

  it("returns N/A for NaN", () => {
    expect(formatDuration(NaN)).toBe("N/A");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("round", () => {
  it("rounds to a whole number by default", () => {
    expect(round(1.6)).toBe(2);
    expect(round(1.4)).toBe(1);
  });

  it("rounds to the given number of decimal places", () => {
    expect(round(62030.29 / 1000, 1)).toBe(62);
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.2355, 2)).toBe(1.24);
  });

  it("handles negative numbers", () => {
    expect(round(-1.5)).toBe(-1);
    expect(round(-1.25, 1)).toBe(-1.2);
  });
});

describe("activityDisplayName", () => {
  it("prefers the activity's own name", () => {
    expect(activityDisplayName({ name: "Tempo Run", type: "Run" })).toBe(
      "Tempo Run",
    );
  });

  it("falls back to type when name is missing", () => {
    expect(activityDisplayName({ name: null, type: "Run" })).toBe("Run");
    expect(activityDisplayName({ type: "Run" })).toBe("Run");
  });

  it("falls back to Workout when neither name nor type is set", () => {
    expect(activityDisplayName({})).toBe("Workout");
    expect(activityDisplayName({ name: null, type: null })).toBe("Workout");
  });

  it("keeps an empty-string name as-is (only null/undefined fall through)", () => {
    expect(activityDisplayName({ name: "", type: "Ride" })).toBe("");
  });
});
