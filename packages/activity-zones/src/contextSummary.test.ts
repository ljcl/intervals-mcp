import { describe, expect, it } from "vitest";
import {
  emptyZonesData,
  hrAndPaceData,
  hrOnlyData,
  mockZonesData,
} from "./__fixtures__/zones";
import { buildZonesContextSummary } from "./contextSummary";

describe("buildZonesContextSummary", () => {
  it("summarises every zone set in one line", () => {
    const summary = buildZonesContextSummary(mockZonesData);
    expect(summary).toContain("Time-in-zone for Threshold Intervals (Run).");
    expect(summary).toContain("Heart rate: mostly Z2 (45%)");
    expect(summary).toContain("Power: mostly Z2 (35%)");
    expect(summary).toContain("60% easy");
  });

  it("handles a single-set activity", () => {
    const summary = buildZonesContextSummary(hrOnlyData);
    expect(summary).toContain("Heart rate:");
    expect(summary).not.toContain("Power:");
  });

  it("labels a pace set with its basis", () => {
    const summary = buildZonesContextSummary(hrAndPaceData);
    expect(summary).toContain("Pace (GAP): mostly Z2 (41%)");
  });

  it("returns null with no zone data", () => {
    expect(buildZonesContextSummary(emptyZonesData)).toBeNull();
  });
});
