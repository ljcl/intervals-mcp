import { describe, expect, it } from "vitest";
import {
  emptyZonesData,
  hrAndPaceData,
  hrOnlyData,
  hrZoneMismatchData,
  mockZonesData,
  paceWithHrZoneWarningData,
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

  it("names the set on screen, the first until another is picked", () => {
    expect(buildZonesContextSummary(hrAndPaceData)).toMatch(
      /On screen: Heart rate zones\.$/,
    );
    expect(buildZonesContextSummary(hrAndPaceData, "pace")).toMatch(
      /On screen: Pace zones \(GAP\)\.$/,
    );
  });

  it("falls back to the first set for a type the activity lacks", () => {
    expect(buildZonesContextSummary(hrOnlyData, "pace")).toMatch(
      /On screen: Heart rate zones\.$/,
    );
  });

  it("closes with the reason heart rate zones were dropped", () => {
    const summary = buildZonesContextSummary(paceWithHrZoneWarningData);
    expect(summary).toContain("Pace (GAP): mostly Z2");
    expect(summary).toMatch(
      /On screen: Pace zones \(GAP\)\. Heart rate zones omitted: .*\.$/,
    );
  });

  it("reports the reason even with no set to chart", () => {
    expect(buildZonesContextSummary(hrZoneMismatchData)).toBe(
      `No zone data to show for Tempo Run (Run). ${hrZoneMismatchData.hrZoneWarning}`,
    );
  });
});
