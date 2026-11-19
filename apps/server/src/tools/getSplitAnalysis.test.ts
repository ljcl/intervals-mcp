/**
 * Handler tests for get-split-analysis: dispatch-level, with intervalsClient
 * mocked. The binning and verdict math is covered in splitAnalysis.test.ts;
 * these pin the fetch wiring, cadence doubling, degradation paths, and text
 * shape, using the hilly and flat intervals.icu fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  syntheticStreams,
  withCorrectedAltitude,
  withGaVelocity,
} from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityHilly from "../__fixtures__/intervals/activity-hilly.json";
import streamsFixture from "../__fixtures__/intervals/streams.json";
import streamsHilly from "../__fixtures__/intervals/streams-hilly.json";
import { ELEVATION_SENSITIVITY } from "../elevationSource";
import {
  getActivity,
  getActivityStreams,
  type IntervalsActivity,
  type IntervalsStream,
} from "../intervalsClient";
import { getSplitAnalysisTool } from "./getSplitAnalysis";
import { SplitAnalysisOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn(), getActivityStreams: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);

const hillyActivity = activityHilly as unknown as IntervalsActivity;
const hillyStreams = streamsHilly as unknown as IntervalsStream[];
const flatActivity = activityFixture as unknown as IntervalsActivity;
const flatStreams = streamsFixture as unknown as IntervalsStream[];

/**
 * #297: a segment's GAP must lean the way its reported grade does. A GAP
 * slower than pace on ground reported flat or uphill, or faster than pace on
 * ground reported 1% or more downhill, means grade and GAP read different
 * elevation sources.
 */
function gapAgreesWithGrade(segment: {
  avg_grade_pct: number | null;
  pace_sec_per_km: number | null;
  gap_pace_sec_per_km: number | null;
}): boolean {
  const { avg_grade_pct: grade, pace_sec_per_km: pace } = segment;
  const gap = segment.gap_pace_sec_per_km;
  if (grade == null || pace == null || gap == null) return true;
  if (grade >= 0 && gap > pace) return false;
  if (grade <= -1 && gap < pace) return false;
  return true;
}

beforeEach(() => {
  mockedGetActivity.mockReset();
  mockedGetActivityStreams.mockReset();
});

describe("get-split-analysis", () => {
  it("splits the hilly fixture into km splits with pace strings, grade source, and cadence in spm", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Split Analysis:");
    expect(text).toContain("Grade source: computed");
    expect(text).toContain("Splits (km):");
    expect(text).toMatch(/\d+:\d{2} \/km/);

    const structured = result.structuredContent as {
      grade_source: string;
      splits: Array<{
        avg_cadence: number | null;
        pace_min_per_km: string | null;
      }>;
      totals: { distance_m: number };
    };
    expect(structured.grade_source).toBe("computed");
    expect(structured.splits.length).toBeGreaterThan(0);
    expect(structured.splits[0]!.pace_min_per_km).toMatch(/^\d+:\d{2}$/);
    expect(structured.totals.distance_m).toBeGreaterThan(1800);
    const cadenced = structured.splits.find((s) => s.avg_cadence != null);
    // Run cadence is doubled to spm for display.
    expect(cadenced?.avg_cadence).toBeGreaterThan(100);
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("gives every hilly-fixture split a GAP on the side of pace its grade says (#297)", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as {
      splits: Parameters<typeof gapAgreesWithGrade>[0][];
    };
    expect(structured.splits.length).toBeGreaterThan(1);
    expect(structured.splits.filter((s) => !gapAgreesWithGrade(s))).toEqual([]);
  });

  it("streams request includes grade, altitude, and cadence types", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    await getSplitAnalysisTool.execute({ id: "i189757207" }, "test-key");

    const requestedTypes = mockedGetActivityStreams.mock.calls[0]![2];
    for (const type of [
      "distance",
      "altitude",
      "grade_smooth",
      "heartrate",
      "cadence",
      "watts",
      "time",
    ]) {
      expect(requestedTypes).toContain(type);
    }
  });

  it("reports average watts on a split when the activity recorded power", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as {
      splits: Array<{ avg_watts: number | null }>;
    };
    expect(structured.splits.some((s) => s.avg_watts != null)).toBe(true);
  });

  it("reports a computed grade source for a flat activity without grade_smooth", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(flatStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { grade_source: string };
    expect(structured.grade_source).toBe("computed");
  });

  it("reports the activity's own elevation gain, as get-activity does", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(flatStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    const structured = result.structuredContent as {
      totals: { elevation_gain_m: number; elevation_gain_source: string };
    };
    // activity.json's total_elevation_gain is 85.052216.
    expect(structured.totals.elevation_gain_m).toBe(85);
    expect(structured.totals.elevation_gain_source).toBe("intervals.icu");
    expect(result.content[0]?.text).toContain("+85 m gain (intervals.icu)");
  });

  it("sums the altitude samples when the activity has no gain of its own", async () => {
    mockedGetActivity.mockResolvedValue({
      ...flatActivity,
      total_elevation_gain: null,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(flatStreams);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    const structured = result.structuredContent as {
      totals: { elevation_gain_m: number; elevation_gain_source: string };
    };
    expect(structured.totals.elevation_gain_source).toBe("computed");
    expect(structured.totals.elevation_gain_m).toBeGreaterThan(0);
  });

  it("warns on a noisy elevation track", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([{ metres: 6000, speed: 3.5 }], {
        altitudeNoise: (i) => (i % 2 === 0 ? 1 : -1),
      }),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { warnings: string[] };
    expect(structured.warnings.join(" ")).toContain("elevation track is noisy");
    expect(result.content[0]?.text).toContain(
      "Warning: The elevation track is noisy",
    );
  });

  it("gives the verdict on the clock only when the run has no elevation data", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams(
        [
          { metres: 3000, speed: 1000 / 300 },
          { metres: 3000, speed: 1000 / 330 },
        ],
        { withAltitude: false },
      ),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    const structured = result.structuredContent as {
      grade_source: string;
      verdict: { gap_shape: string | null; gap_delta_pct: number | null };
      totals: { avg_gap_pace_sec_per_km: number | null };
    };
    expect(structured.grade_source).toBe("none");
    expect(structured.verdict.gap_shape).toBeNull();
    expect(structured.verdict.gap_delta_pct).toBeNull();
    expect(structured.totals.avg_gap_pace_sec_per_km).toBeNull();
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Grade source: none");
    expect(text).toContain("no grade-adjusted verdict");
    expect(text).not.toContain("GAP");
  });

  it("prints GAP on every split, even where it equals the pace", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    // Flat altitude: grade 0, so GAP equals the clock pace on every split.
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([
        { metres: 2000, speed: 1000 / 300 },
        { metres: 1000, speed: 1000 / 330 },
      ]),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    const text = result.content[0]?.text ?? "";
    const rows = text.split("\n").filter((line) => /^ {2}\d+\. {2}/.test(line));
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatch(/\d:\d{2} \/km, GAP \d:\d{2} \/km/);
    expect(rows[0]).toContain("5:00 /km, GAP 5:00 /km");
  });

  it("names the streams as its moving-time source, and intervals.icu's own moving time when it differs", async () => {
    mockedGetActivity.mockResolvedValue({
      ...flatActivity,
      distance: 3000,
      moving_time: 960,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([{ metres: 3000, speed: 1000 / 300 }]),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    const structured = SplitAnalysisOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.totals.moving_time_source).toBe("streams");
    expect(structured.totals.intervals_icu_moving_time_s).toBe(960);
    const text = result.content[0]?.text ?? "";
    expect(structured.totals.moving_time_s).toBe(900);
    expect(text).toContain("Moving time 15:00 (streams: stops left out)");
    expect(text).toContain(
      "intervals.icu's own moving time is 16:00, 5:20 /km, which get-running-summary uses",
    );
  });

  it("refuses a ride before reading its streams, naming get-activity (#300)", async () => {
    mockedGetActivity.mockResolvedValue({
      ...hillyActivity,
      name: "Hill reps",
      type: "Ride",
    } as IntervalsActivity);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      '❌ Activity "Hill reps" [i189757207] is a Ride, not a run. get-split-analysis covers Run, TrailRun and VirtualRun only; use get-activity for other activity types.',
    );
    expect(mockedGetActivityStreams).not.toHaveBeenCalled();
  });

  it("errors cleanly for an activity with no recorded streams, naming it", async () => {
    mockedGetActivity.mockResolvedValue({
      ...hillyActivity,
      name: "Pilates",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue([]);

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Pilates");
    expect(text).toContain("no GPS streams");
  });

  it("reports an exhausted rate limit instead of claiming there are no streams", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockRejectedValue(
      handledRateLimit("getActivityStreams for ID i189757207"),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Rate limit");
    expect(text).not.toContain("no GPS streams");
  });

  it("returns not-found text when the activity does not exist", async () => {
    mockedGetActivity.mockRejectedValue(
      handledNotFound("getActivity for ID i999"),
    );

    const result = await getSplitAnalysisTool.execute(
      { id: "i999" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });

  describe("elevation source", () => {
    type SourceResult = {
      elevation_gain_m: number | null;
      verdict: { gap_delta_pct: number | null } | null;
      splits: Array<{
        split: number;
        gap_pace_min_per_km: string | null;
        elevation_change_m: number | null;
      }>;
    };
    type Structured = {
      elevation_source: string | null;
      elevation_note: string | null;
      splits: Array<{
        elevation_change_m: number | null;
        gap_pace_min_per_km: string | null;
      }>;
      verdict: { gap_delta_pct: number | null } | null;
      totals: {
        elevation_gain_m: number | null;
        elevation_gain_source: string | null;
      };
      warnings: string[];
      elevation_comparison: {
        corrected: SourceResult | null;
        barometric: SourceResult | null;
        gap_delta_difference_pts: number | null;
        note: string | null;
        sensitivity_warning: string | null;
      } | null;
    };
    const run = async (
      streams: IntervalsStream[],
      args: { elevationSource?: "corrected" | "barometric" | "both" } = {},
    ) => {
      mockedGetActivity.mockResolvedValue(hillyActivity);
      mockedGetActivityStreams.mockResolvedValue(streams);
      const result = await getSplitAnalysisTool.execute(
        { id: "i189757207", ...args },
        "test-key",
      );
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as Structured;
      expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(
        true,
      );
      return { structured, text: result.content[0]?.text ?? "" };
    };
    const firstChange = (s: Structured) => s.splits[0]?.elevation_change_m ?? 0;

    it("reads the corrected stream by default and keeps intervals.icu's gain", async () => {
      const corrected = await run(withCorrectedAltitude(hillyStreams));
      const recorded = await run(withCorrectedAltitude(hillyStreams), {
        elevationSource: "barometric",
      });

      expect(corrected.structured.elevation_source).toBe("corrected");
      expect(corrected.structured.elevation_note).toBeNull();
      expect(corrected.text).toContain("Elevation source: corrected");
      expect(corrected.structured.totals.elevation_gain_source).toBe(
        "intervals.icu",
      );
      // The corrected fixture doubles every altitude change.
      expect(firstChange(corrected.structured)).toBeCloseTo(
        firstChange(recorded.structured) * 2,
        0,
      );
    });

    it("sums the gain from the recorded altitude when asked for it on a corrected activity", async () => {
      const { structured } = await run(withCorrectedAltitude(hillyStreams), {
        elevationSource: "barometric",
      });

      expect(structured.elevation_source).toBe("barometric");
      expect(structured.elevation_note).toBeNull();
      expect(structured.totals.elevation_gain_source).toBe("computed");
    });

    it("puts both sources' splits and verdicts side by side", async () => {
      const { structured, text } = await run(
        withCorrectedAltitude(hillyStreams, 4),
        { elevationSource: "both" },
      );
      const barometricOnly = await run(withCorrectedAltitude(hillyStreams, 4), {
        elevationSource: "barometric",
      });
      const comparison = structured.elevation_comparison;
      const corrected = comparison?.corrected;
      const barometric = comparison?.barometric;

      // The headline is the corrected source's; the barometric column is
      // what a barometric call reports.
      expect(structured.elevation_source).toBe("corrected");
      expect(corrected?.verdict?.gap_delta_pct).toBe(
        structured.verdict?.gap_delta_pct,
      );
      expect(corrected?.splits.map((s) => s.elevation_change_m)).toEqual(
        structured.splits.map((s) => s.elevation_change_m),
      );
      expect(barometric?.verdict?.gap_delta_pct).toBe(
        barometricOnly.structured.verdict?.gap_delta_pct,
      );
      expect(barometric?.splits.map((s) => s.gap_pace_min_per_km)).toEqual(
        barometricOnly.structured.splits.map((s) => s.gap_pace_min_per_km),
      );
      expect(corrected?.elevation_gain_m).toBeGreaterThan(
        barometric?.elevation_gain_m ?? Infinity,
      );
      const difference = Math.abs(
        (corrected?.verdict?.gap_delta_pct ?? 0) -
          (barometric?.verdict?.gap_delta_pct ?? 0),
      );
      expect(comparison?.gap_delta_difference_pts).toBeCloseTo(difference, 1);
      expect(difference).toBeGreaterThan(ELEVATION_SENSITIVITY.gapDeltaPts);
      expect(comparison?.sensitivity_warning).toContain(
        "Do not trust the grade-adjusted verdict",
      );
      expect(structured.warnings).toContain(comparison?.sensitivity_warning);
      expect(text).toMatch(/Gain: corrected \+\d+ m, barometric \+\d+ m/);
      expect(text).toContain("By elevation source (corrected | barometric):");
      expect(text).toMatch(/ {2}1\. +GAP \d+:\d\d \| \d+:\d\d \/km/);
    });

    it("gives the barometric result, not an error, when both is asked without a corrected stream", async () => {
      const { structured, text } = await run(hillyStreams, {
        elevationSource: "both",
      });
      const comparison = structured.elevation_comparison;

      expect(structured.elevation_source).toBe("barometric");
      expect(comparison?.corrected).toBeNull();
      expect(comparison?.barometric?.verdict?.gap_delta_pct).toBe(
        structured.verdict?.gap_delta_pct,
      );
      expect(comparison?.gap_delta_difference_pts).toBeNull();
      expect(comparison?.sensitivity_warning).toBeNull();
      expect(comparison?.note).toContain(
        "corrected elevation stream is not available",
      );
      expect(text).toContain("Gain: corrected n/a, barometric +");
      expect(text).toContain("Grade-adjusted verdict: n/a |");
    });

    it("leaves elevation_comparison null for one source", async () => {
      const { structured } = await run(withCorrectedAltitude(hillyStreams));

      expect(structured.elevation_comparison).toBeNull();
    });

    it("falls back to the recorded altitude, and says so, without a corrected stream", async () => {
      const { structured, text } = await run(hillyStreams);

      expect(structured.elevation_source).toBe("barometric");
      expect(structured.elevation_note).toContain(
        "no corrected altitude stream",
      );
      expect(structured.totals.elevation_gain_source).toBe("intervals.icu");
      expect(text).toContain("Elevation source: barometric");
    });
  });
});

describe("get-split-analysis GAP model (#508)", () => {
  type Structured = {
    gap_model: string | null;
    gap_source: string;
    gap_note: string | null;
    totals: { avg_gap_pace_sec_per_km: number | null };
    splits: Array<{ gap_pace_sec_per_km: number | null }>;
  };
  const run = async (args: Record<string, unknown> = {}) => {
    const result = await getSplitAnalysisTool.execute(
      { id: "i189757207", ...args },
      "test-key",
    );
    return {
      text: result.content[0]?.text ?? "",
      structured: result.structuredContent as Structured,
    };
  };

  it("uses intervals.icu's GAP speed, so the whole-run GAP is the activity's own", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    // activity-hilly.json's gap is 3.2872841 m/s, 5:04 /km.
    mockedGetActivityStreams.mockResolvedValue(
      withGaVelocity(withCorrectedAltitude(hillyStreams), 3.2872841),
    );

    const { text, structured } = await run();

    expect(structured.gap_model).toBe("strava");
    expect(structured.gap_source).toBe("intervals.icu");
    expect(structured.gap_note).toBeNull();
    expect(structured.totals.avg_gap_pace_sec_per_km).toBe(304);
    expect(structured.splits.every((s) => s.gap_pace_sec_per_km === 304)).toBe(
      true,
    );
    expect(text).toContain(
      "GAP model: Strava (the intervals.icu number for this activity)",
    );
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("uses Minetti, and says why, on the recorded altitude of a corrected activity", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(
      withGaVelocity(withCorrectedAltitude(hillyStreams), 3.2872841),
    );

    const { text, structured } = await run({ elevationSource: "barometric" });

    expect(structured.gap_model).toBe("minetti");
    expect(structured.gap_source).toBe("model");
    expect(structured.gap_note).toContain("corrected elevation");
    expect(structured.totals.avg_gap_pace_sec_per_km).not.toBe(304);
    expect(text).toContain("GAP model: Minetti (computed here from grade).");
  });

  it("uses Minetti, and says why, when the activity has no GAP stream", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const { structured } = await run();

    expect(structured.gap_model).toBe("minetti");
    expect(structured.gap_note).toContain(
      "no intervals.icu grade-adjusted speed",
    );
  });

  it("uses Minetti with no note when the activity's gap_model is NONE", async () => {
    mockedGetActivity.mockResolvedValue({
      ...hillyActivity,
      gap_model: "NONE",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(
      withGaVelocity(hillyStreams, 3.2872841),
    );

    const { structured } = await run();

    expect(structured.gap_model).toBe("minetti");
    expect(structured.gap_note).toBeNull();
  });

  it("has no model and no note when there is no grade-adjusted pace", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(
      hillyStreams.filter(
        (s) => s.type !== "altitude" && s.type !== "grade_smooth",
      ),
    );

    const { text, structured } = await run();

    expect(structured.gap_model).toBeNull();
    expect(structured.gap_note).toBeNull();
    expect(text).not.toContain("GAP model:");
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });
});
