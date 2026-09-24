import { formatShortDate } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import {
  mockFitnessTrendData,
  mockNoLoadData,
  mockRestProjectionData,
} from "./__fixtures__/trend";
import {
  BAND_COLORS,
  BAND_LABELS,
  buildChartRows,
  buildSummaryStats,
  buildTrendSubtitle,
  countBandKinds,
  formatTaperWeek,
  handoverLabel,
  hasRecordedLoad,
  isPlanned,
  planDays,
  signedTsb,
} from "./normalize";

describe("signedTsb", () => {
  it("signs a positive value and leaves a negative one alone", () => {
    expect(signedTsb(12)).toBe("+12");
    expect(signedTsb(-8.4)).toBe("-8.4");
  });

  it("prints zero without a sign", () => {
    expect(signedTsb(0)).toBe("0");
  });

  it("rounds to one decimal", () => {
    expect(signedTsb(4.06)).toBe("+4.1");
  });
});

describe("planDays / isPlanned", () => {
  it("prefers the taper over the rest projection", () => {
    expect(planDays(mockFitnessTrendData)).toBe(
      mockFitnessTrendData.taper!.days,
    );
    expect(isPlanned(mockFitnessTrendData)).toBe(true);
  });

  it("falls back to the rest projection with no taper", () => {
    expect(planDays(mockRestProjectionData)).toBe(
      mockRestProjectionData.projection,
    );
    expect(isPlanned(mockRestProjectionData)).toBe(false);
  });

  it("falls back when a taper came back empty", () => {
    const data = {
      ...mockFitnessTrendData,
      taper: { ...mockFitnessTrendData.taper!, days: [], weeks: [] },
    };
    expect(planDays(data)).toBe(data.projection);
    expect(isPlanned(data)).toBe(false);
  });
});

describe("buildChartRows", () => {
  it("lays recorded days first, then the plan", () => {
    const rows = buildChartRows(mockFitnessTrendData);
    const { series, taper } = mockFitnessTrendData;
    expect(rows).toHaveLength(series.length + taper!.days.length);
    expect(rows[0]!.date).toBe(series[0]!.date);
    expect(rows[rows.length - 1]!.date).toBe(
      taper!.days[taper!.days.length - 1]!.date,
    );
  });

  it("keeps recorded and planned values on separate keys", () => {
    const rows = buildChartRows(mockFitnessTrendData);
    const recorded = rows[0]!;
    expect(recorded.ctl).not.toBeNull();
    expect(recorded.planCtl).toBeNull();

    const planned = rows[rows.length - 1]!;
    expect(planned.ctl).toBeNull();
    expect(planned.planCtl).not.toBeNull();
    expect(planned.planLoad).toBe(
      mockFitnessTrendData.taper!.days[
        mockFitnessTrendData.taper!.days.length - 1
      ]!.load,
    );
  });

  it("carries both on the handover day so the dashed line joins up", () => {
    const rows = buildChartRows(mockFitnessTrendData);
    const handover = rows[mockFitnessTrendData.series.length - 1]!;
    expect(handover.ctl).not.toBeNull();
    expect(handover.planCtl).toBe(handover.ctl);
    expect(handover.planAtl).toBe(handover.atl);
    expect(handover.planTsb).toBe(handover.tsb);
  });

  it("leaves the handover clean when there is no forward half", () => {
    const rows = buildChartRows({
      ...mockFitnessTrendData,
      taper: null,
      projection: [],
    });
    const last = rows[rows.length - 1]!;
    expect(last.planCtl).toBeNull();
  });

  it("labels every row with its axis date", () => {
    const rows = buildChartRows(mockFitnessTrendData);
    expect(rows[0]!.label).toBe(
      formatShortDate(mockFitnessTrendData.series[0]!.date),
    );
  });
});

describe("hasRecordedLoad", () => {
  it("is true when any day carries load", () => {
    expect(hasRecordedLoad(mockFitnessTrendData)).toBe(true);
  });

  it("is false for a zero-filled series that would chart a flat line", () => {
    expect(hasRecordedLoad(mockNoLoadData)).toBe(false);
    expect(mockNoLoadData.series.length).toBeGreaterThan(0);
  });
});

describe("handoverLabel", () => {
  it("names the last recorded day", () => {
    expect(handoverLabel(mockFitnessTrendData)).toBe(
      formatShortDate(
        mockFitnessTrendData.series[mockFitnessTrendData.series.length - 1]!
          .date,
      ),
    );
  });

  it("is null with no recorded days", () => {
    expect(handoverLabel({ ...mockFitnessTrendData, series: [] })).toBeNull();
  });
});

describe("buildSummaryStats", () => {
  it("leads with fitness, fatigue, and form", () => {
    const stats = buildSummaryStats(mockFitnessTrendData);
    expect(stats.slice(0, 3).map((s) => s.label)).toEqual([
      "Fitness",
      "Fatigue",
      "Form",
    ]);
    const current = mockFitnessTrendData.current!;
    expect(stats[0]!.value).toBe(`${current.ctl}`);
    expect(stats[2]!.value).toBe(signedTsb(current.tsb));
  });

  it("closes with the taper's landing form when one was solved", () => {
    const stats = buildSummaryStats(mockFitnessTrendData);
    const taper = mockFitnessTrendData.taper!;
    expect(stats[3]!.label).toBe(
      `Form on ${formatShortDate(taper.targetDate)}`,
    );
    expect(stats[3]!.value).toBe(signedTsb(taper.achievedTsb));
  });

  it("closes with the fresh date when only resting", () => {
    const stats = buildSummaryStats(mockRestProjectionData);
    expect(stats[3]!.label).toBe("Fresh on");
    expect(stats[3]!.value).toBe(
      formatShortDate(mockRestProjectionData.tsbPositiveDate!),
    );
  });

  it("falls back to the activity count when form never turns positive", () => {
    const stats = buildSummaryStats({
      ...mockRestProjectionData,
      tsbPositiveDate: null,
    });
    expect(stats[3]).toEqual({
      label: "Activities",
      value: `${mockRestProjectionData.activitiesIncluded}`,
    });
  });

  it("dashes the values out with no current day", () => {
    const stats = buildSummaryStats({
      ...mockFitnessTrendData,
      current: null,
    });
    expect(stats.slice(0, 3).map((s) => s.value)).toEqual(["—", "—", "—"]);
  });
});

describe("buildTrendSubtitle", () => {
  it("spans the recorded window and names the taper target", () => {
    const { series, taper } = mockFitnessTrendData;
    expect(buildTrendSubtitle(mockFitnessTrendData)).toBe(
      `90 days · ${formatShortDate(series[0]!.date)} – ${formatShortDate(
        series[series.length - 1]!.date,
      )} · taper to ${formatShortDate(taper!.targetDate)}`,
    );
  });

  it("drops the taper clause with no plan", () => {
    expect(buildTrendSubtitle(mockRestProjectionData)).not.toContain("taper");
  });

  it("collapses a single day and falls back on an empty window", () => {
    const oneDay = {
      ...mockRestProjectionData,
      days: 1,
      series: [mockFitnessTrendData.series[0]!],
    };
    expect(buildTrendSubtitle(oneDay)).toBe(
      `1 day · ${formatShortDate(mockFitnessTrendData.series[0]!.date)}`,
    );
    expect(buildTrendSubtitle({ ...mockRestProjectionData, series: [] })).toBe(
      "Last 90 days",
    );
  });
});

describe("formatTaperWeek", () => {
  it("reads as a daily load with its share of recent training", () => {
    const week = mockFitnessTrendData.taper!.weeks[0]!;
    expect(formatTaperWeek(week)).toBe(
      `${week.dailyLoad}/day, ${week.pctOfRecent}% of recent`,
    );
  });

  it("drops the share when there is no recent load to compare to", () => {
    const week = {
      ...mockFitnessTrendData.taper!.weeks[0]!,
      pctOfRecent: null,
    };
    expect(formatTaperWeek(week)).toBe(`${week.dailyLoad}/day`);
  });
});

describe("countBandKinds", () => {
  it("counts each kind once, in the order the server sent them", () => {
    expect(countBandKinds(mockFitnessTrendData.bands)).toEqual([
      { kind: "deep-fatigue", count: 3 },
      { kind: "steep-ramp", count: 3 },
    ]);
  });

  it("is empty for a window with no bands", () => {
    expect(countBandKinds([])).toEqual([]);
  });
});

describe("band presentation", () => {
  it("covers every band kind in both maps", () => {
    for (const kind of ["deep-fatigue", "fresh", "steep-ramp"] as const) {
      expect(BAND_COLORS[kind]).toMatch(/^var\(--/);
      expect(BAND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it("keeps fatigue and freshness visually distinct", () => {
    expect(BAND_COLORS["deep-fatigue"]).not.toBe(BAND_COLORS.fresh);
  });
});
