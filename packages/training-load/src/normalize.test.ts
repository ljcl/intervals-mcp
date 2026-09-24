import { formatShortDate } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import { mockTrainingLoadData } from "./__fixtures__/weeks";
import {
  buildLoadSubtitle,
  buildTotalsStats,
  countWarningWeeks,
  formatHours,
} from "./normalize";
import { type WeekSummary } from "./types";

describe("formatHours", () => {
  it("formats hours and minutes", () => {
    expect(formatHours(27.75)).toBe("27h 45m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatHours(3)).toBe("3h");
  });

  it("shows only minutes under an hour", () => {
    expect(formatHours(0.5)).toBe("30m");
  });

  it("rounds to the nearest minute", () => {
    expect(formatHours(1.999)).toBe("2h");
  });

  it("pads single-digit minutes, matching the sibling cards", () => {
    expect(formatHours(65 / 60)).toBe("1h 05m");
  });
});

describe("buildTotalsStats", () => {
  it("formats the four totals in order", () => {
    const stats = buildTotalsStats({
      runs: 34,
      distanceKm: 312.4,
      timeHours: 27.75,
      elevationM: 2810,
    });
    expect(stats.map((s) => s.label)).toEqual([
      "Runs",
      "Distance",
      "Time",
      "Elevation",
    ]);
    expect(stats[0]!.value).toBe("34");
    expect(stats[1]!.value).toBe("312.4 km");
    expect(stats[2]!.value).toBe("27h 45m");
    expect(stats[3]!.value).toBe("2,810 m");
  });
});

describe("countWarningWeeks", () => {
  const week = (warning: boolean): WeekSummary => ({
    weekStarting: "2026-06-01",
    runs: 1,
    distanceKm: 10,
    timeHours: 1,
    elevationM: 50,
    trendKm: 10,
    warning,
    warningReasons: warning ? ["reason"] : [],
  });

  it("counts only flagged weeks", () => {
    expect(countWarningWeeks([week(true), week(false), week(true)])).toBe(2);
  });
});

describe("buildLoadSubtitle", () => {
  it("spans the charted weeks", () => {
    expect(buildLoadSubtitle(mockTrainingLoadData)).toBe(
      `${mockTrainingLoadData.weeks.length} weeks · ${formatShortDate(
        mockTrainingLoadData.weeks[0]!.weekStarting,
      )} – ${formatShortDate(
        mockTrainingLoadData.weeks[mockTrainingLoadData.weeks.length - 1]!
          .weekStarting,
      )}`,
    );
  });

  it("collapses a single week to one date and singular noun", () => {
    const oneWeek = {
      ...mockTrainingLoadData,
      weeks: [mockTrainingLoadData.weeks[0]!],
    };

    expect(buildLoadSubtitle(oneWeek)).toBe(
      `1 week · ${formatShortDate(mockTrainingLoadData.weeks[0]!.weekStarting)}`,
    );
  });

  it("falls back to the requested window when no weeks came back", () => {
    expect(
      buildLoadSubtitle({ ...mockTrainingLoadData, days: 84, weeks: [] }),
    ).toBe("Last 84 days");
  });
});
