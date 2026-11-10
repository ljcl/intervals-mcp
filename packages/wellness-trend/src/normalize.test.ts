import { describe, expect, it } from "vitest";
import {
  dailyData,
  emptyData,
  sdnnNoSleepData,
  weeklyData,
} from "./__fixtures__/wellness";
import {
  buildSubtitle,
  chartedSeries,
  pointLabel,
  seriesStats,
} from "./normalize";

describe("chartedSeries", () => {
  it("charts all three series when each has a value", () => {
    expect(chartedSeries(dailyData).map((s) => s.label)).toEqual([
      "HRV (rMSSD)",
      "Resting HR",
      "Sleep",
    ]);
  });

  it("names SDNN and leaves out a series with no value", () => {
    expect(chartedSeries(sdnnNoSleepData).map((s) => s.label)).toEqual([
      "HRV (SDNN)",
      "Resting HR",
    ]);
  });

  it("charts nothing when no day has HRV, resting HR or sleep", () => {
    expect(chartedSeries(emptyData)).toEqual([]);
  });
});

describe("seriesStats", () => {
  it("skips gap days for count, range, first and last", () => {
    const stats = seriesStats(dailyData, "sleepHours")!;
    expect(stats.count).toBe(25);
    expect(stats.first.date).toBe("2026-10-01");
    expect(stats.last.date).toBe("2026-10-30");
    expect(stats.min).toBeLessThanOrEqual(stats.max);
  });

  it("is null for a series with no value", () => {
    expect(seriesStats(emptyData, "hrv")).toBeNull();
  });
});

describe("labels", () => {
  it("subtitles a daily range and a weekly one", () => {
    expect(buildSubtitle(dailyData)).toBe("1 Oct to 30 Oct 2026");
    expect(buildSubtitle(weeklyData)).toBe(
      "11 May to 8 Nov 2026 · weekly averages",
    );
  });

  it("names the year on both ends when they differ", () => {
    expect(
      buildSubtitle({
        ...dailyData,
        oldest: "2025-12-20",
        newest: "2026-01-10",
      }),
    ).toBe("20 Dec 2025 to 10 Jan 2026");
  });

  it("labels a week with its day count", () => {
    expect(pointLabel(weeklyData, weeklyData.points[0]!)).toBe(
      "Week of 11 May 2026 (7 days)",
    );
    expect(pointLabel(dailyData, dailyData.points[0]!)).toBe("1 Oct 2026");
  });
});
