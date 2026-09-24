import { describe, expect, it } from "vitest";
import { formatDuration, round } from "./formatters";

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
