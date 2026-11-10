import { describe, expect, it } from "vitest";
import {
  dailyData,
  emptyData,
  sdnnNoSleepData,
  weeklyData,
} from "./__fixtures__/wellness";
import { buildWellnessContextSummary } from "./contextSummary";

describe("buildWellnessContextSummary", () => {
  it("summarises each charted series in one line", () => {
    const summary = buildWellnessContextSummary(dailyData)!;
    expect(summary).toContain(
      "Wellness trend chart 2026-10-01 to 2026-10-30 (daily).",
    );
    expect(summary).toMatch(/HRV \(rMSSD\): latest [\d.]+ ms on 2026-10-30/);
    expect(summary).toContain("Resting HR: latest");
    expect(summary).toContain("Sleep: latest");
  });

  it("names weekly averages and leaves out an empty series", () => {
    expect(buildWellnessContextSummary(weeklyData)).toContain(
      "(weekly averages)",
    );
    expect(buildWellnessContextSummary(sdnnNoSleepData)).not.toContain("Sleep");
  });

  it("returns null with nothing to chart", () => {
    expect(buildWellnessContextSummary(emptyData)).toBeNull();
  });
});
