import { formatShortDate } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import {
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import {
  buildDataArgs,
  buildLoadBreakdown,
  buildLoadRows,
  buildLoadSubtitle,
  buildScopeNote,
  buildTotalsStats,
  countWarningWeeks,
  formatCurrentFitness,
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

describe("buildDataArgs", () => {
  it("asks the data tool for the scope the view tool was called with", () => {
    expect(buildDataArgs({ days: 56, runOnly: true })).toEqual({
      days: 56,
      runOnly: true,
    });
    expect(buildDataArgs({ days: 56, runOnly: false })).toEqual({
      days: 56,
      runOnly: false,
    });
  });

  it("defaults to 84 days of whole-body load, as the view tool does", () => {
    expect(buildDataArgs({})).toEqual({ days: 84, runOnly: false });
  });
});

describe("buildTotalsStats", () => {
  const totals = {
    runs: 34,
    distanceKm: 312.4,
    timeHours: 27.75,
    elevationM: 2810,
    load: 1850,
  };
  const current = { date: "2026-06-24", ctl: 52, atl: 61, tsb: 4.2 };

  it("shows runs, distance, load, then fitness, fatigue and form", () => {
    const stats = buildTotalsStats(totals, current);
    expect(stats.map((s) => s.label)).toEqual([
      "Runs",
      "Distance",
      "Load",
      "Fitness",
      "Fatigue",
      "Form",
    ]);
    expect(stats.map((s) => s.value)).toEqual([
      "34",
      "312.4 km",
      "1,850",
      "52",
      "61",
      "+4.2",
    ]);
  });

  it("signs form the way the fitness trend card prints it", () => {
    const form = (tsb: number) =>
      buildTotalsStats(totals, { ...current, tsb })[5]!.value;
    expect(form(-9)).toBe("-9");
    expect(form(0)).toBe("0");
  });

  it("shows a dash for the three fitness tiles when there is no current", () => {
    const stats = buildTotalsStats(totals, null);
    expect(stats.slice(3).map((s) => [s.label, s.value])).toEqual([
      ["Fitness", "—"],
      ["Fatigue", "—"],
      ["Form", "—"],
    ]);
    expect(stats.slice(0, 3).map((s) => s.value)).toEqual([
      "34",
      "312.4 km",
      "1,850",
    ]);
  });
});

describe("buildScopeNote", () => {
  it("names the whole-body types and intervals.icu as the source", () => {
    expect(
      buildScopeNote({
        runOnly: false,
        activityTypesIncluded: ["Run", "Ride"],
        current: { date: "2026-10-05", ctl: 52, atl: 61, tsb: -9 },
        source: "intervals.icu",
      }),
    ).toBe(
      `Whole-body load (Run, Ride) · from intervals.icu as of ${formatShortDate("2026-10-05")}`,
    );
  });

  it("says run-only load is computed locally", () => {
    expect(
      buildScopeNote({
        runOnly: true,
        activityTypesIncluded: ["Run", "TrailRun", "VirtualRun"],
        current: { date: "2026-10-05", ctl: 41, atl: 47, tsb: -6 },
        source: "computed",
      }),
    ).toBe(
      `Run-only load · computed locally as of ${formatShortDate("2026-10-05")}`,
    );
  });

  it("drops the as-of date when there is no current", () => {
    expect(
      buildScopeNote({
        runOnly: false,
        activityTypesIncluded: ["Run"],
        current: null,
        source: "intervals.icu",
      }),
    ).toBe("Whole-body load (Run) · from intervals.icu");
    expect(
      buildScopeNote({
        runOnly: true,
        activityTypesIncluded: [],
        current: null,
        source: "computed",
      }),
    ).toBe("Run-only load · computed locally");
  });

  it("leaves the type list out when no activity carried load", () => {
    expect(
      buildScopeNote({
        runOnly: false,
        activityTypesIncluded: [],
        current: null,
        source: "intervals.icu",
      }),
    ).toBe("Whole-body load · from intervals.icu");
  });

  it("reads both fixture scopes", () => {
    expect(buildScopeNote(mockTrainingLoadData)).toContain(
      "Whole-body load (Ride, Run) · from intervals.icu as of 24 Jun",
    );
    expect(buildScopeNote(mockRunOnlyTrainingLoadData)).toContain(
      "Run-only load · computed locally as of 24 Jun",
    );
  });
});

describe("formatCurrentFitness", () => {
  it("prints CTL, ATL and signed TSB with the source", () => {
    expect(
      formatCurrentFitness(
        { date: "2026-10-05", ctl: 52, atl: 61, tsb: -9 },
        "intervals.icu",
      ),
    ).toBe("CTL 52, ATL 61, TSB -9 (from intervals.icu)");
    expect(
      formatCurrentFitness(
        { date: "2026-10-05", ctl: 41, atl: 37.5, tsb: 3.5 },
        "computed",
      ),
    ).toBe("CTL 41, ATL 37.5, TSB +3.5 (computed locally)");
  });
});

describe("buildLoadRows", () => {
  const complete: WeekSummary = {
    weekStarting: "2026-06-01",
    runs: 3,
    distanceKm: 30,
    timeHours: 3,
    elevationM: 100,
    trendKm: 30,
    warning: true,
    warningReasons: ["spike"],
    load: 240,
    loadByType: { Run: 240 },
  };
  const partial: WeekSummary = {
    ...complete,
    weekStarting: "2026-06-08",
    distanceKm: 6,
    trendKm: null,
    inProgress: true,
    warning: false,
    warningReasons: [],
    load: 50,
    loadByType: { Run: 50 },
  };

  it("plots a complete week's load on the solid line", () => {
    const [row] = buildLoadRows([complete]);
    expect(row).toMatchObject({
      weekLabel: formatShortDate("2026-06-01"),
      load: 240,
      loadComplete: 240,
      loadSoFar: null,
    });
  });

  it("keeps the week in progress off the solid line and marks it apart", () => {
    // Its load is only the days so far: on the solid line it would read as
    // a plunge next to the dashed partial bar, as trendKm null avoids for
    // distance.
    const rows = buildLoadRows([complete, partial]);
    expect(rows[1]).toMatchObject({
      load: 50,
      loadComplete: null,
      loadSoFar: 50,
    });
    expect(rows.map((r) => r.loadComplete)).toEqual([240, null]);
  });

  it("keeps the week's own fields for the tooltip", () => {
    const [row] = buildLoadRows([complete]);
    expect(row).toMatchObject({
      warning: true,
      warningReasons: ["spike"],
      loadByType: { Run: 240 },
      distanceKm: 30,
    });
  });
});

describe("buildLoadBreakdown", () => {
  it("lists the load by type, largest first", () => {
    expect(
      buildLoadBreakdown({ loadByType: { Run: 120, Ride: 200, Swim: 45 } }),
    ).toEqual([
      { type: "Ride", load: 200 },
      { type: "Run", load: 120 },
      { type: "Swim", load: 45 },
    ]);
  });

  it("orders equal loads by type so the tooltip does not shuffle", () => {
    expect(buildLoadBreakdown({ loadByType: { Run: 50, Ride: 50 } })).toEqual([
      { type: "Ride", load: 50 },
      { type: "Run", load: 50 },
    ]);
  });

  it("is empty for a week with no load or no breakdown", () => {
    expect(buildLoadBreakdown({ loadByType: {} })).toEqual([]);
    expect(buildLoadBreakdown({})).toEqual([]);
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
    load: 60,
    loadByType: { Run: 60 },
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
