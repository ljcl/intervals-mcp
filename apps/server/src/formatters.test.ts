import { describe, expect, it } from "vitest";
import { formatDuration } from "./formatters";

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
