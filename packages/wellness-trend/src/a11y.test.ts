import { describe, expect, it } from "vitest";
import { dailyData, emptyData, weeklyData } from "./__fixtures__/wellness";
import { buildSeriesA11y } from "./a11y";
import { seriesSpecs } from "./normalize";

const [hrv, restingHr, sleep] = seriesSpecs(dailyData);

describe("buildSeriesA11y", () => {
  it("narrates a daily series with its gaps, range, first and latest", () => {
    const a11y = buildSeriesA11y(dailyData, sleep!);
    expect(a11y.title).toBe("Sleep by day, 1 Oct to 30 Oct 2026");
    expect(a11y.desc).toContain("Line chart of Sleep in h.");
    expect(a11y.desc).toContain("25 of 30 days recorded.");
    expect(a11y.desc).toContain("5 with no record show as gaps.");
    expect(a11y.desc).toMatch(/First [\d.]+ h \(1 Oct 2026\)/);
    expect(a11y.desc).toMatch(/latest [\d.]+ h \(30 Oct 2026\)/);
  });

  it("says weekly averages and counts weeks", () => {
    const a11y = buildSeriesA11y(weeklyData, restingHr!);
    expect(a11y.title).toBe("Resting HR by week, 11 May to 8 Nov 2026");
    expect(a11y.desc).toContain("weekly averages (Monday start)");
    expect(a11y.desc).toContain("25 of 26 weeks recorded.");
    expect(a11y.desc).toContain("(Week of 2 Nov 2026 (6 days))");
  });

  it("says when a series has nothing recorded", () => {
    expect(buildSeriesA11y(emptyData, hrv!).desc).toBe(
      "No HRV (rMSSD) recorded.",
    );
  });
});
