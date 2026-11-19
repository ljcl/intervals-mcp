/**
 * Handler tests for get-hill-analysis: dispatch-level, with intervalsClient
 * mocked. The detection and drift math is covered in hillAnalysis.test.ts;
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
import { getHillAnalysisTool } from "./getHillAnalysis";
import { HillAnalysisOutputSchema } from "./outputs";

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

describe("get-hill-analysis", () => {
  it("detects the hilly fixture's climb and descent with pace strings, grade source, and cadence in spm", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Hill Analysis:");
    expect(text).toContain("Grade source: computed");
    expect(text).toContain("Descents:");
    expect(text).toMatch(/pace \d+:\d{2} \/km/);

    const structured = result.structuredContent as {
      grade_source: string;
      descents: Array<{
        avg_cadence: number | null;
        pace_min_per_km: string | null;
      }>;
      totals: { descent_count: number };
    };
    expect(structured.grade_source).toBe("computed");
    expect(structured.totals.descent_count).toBeGreaterThan(0);
    expect(structured.descents[0]!.pace_min_per_km).toMatch(/^\d+:\d{2}$/);
    // Run cadence is doubled to spm for display.
    expect(structured.descents[0]!.avg_cadence).toBeGreaterThan(100);
    expect(HillAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("gives every hilly-fixture climb and descent a GAP on the side of pace its grade says (#297)", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as {
      climbs: Parameters<typeof gapAgreesWithGrade>[0][];
      descents: Parameters<typeof gapAgreesWithGrade>[0][];
    };
    const segments = [...structured.climbs, ...structured.descents];
    expect(structured.climbs.length).toBeGreaterThan(0);
    expect(segments.filter((s) => !gapAgreesWithGrade(s))).toEqual([]);
  });

  it("streams request includes grade, altitude, and cadence types", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    await getHillAnalysisTool.execute({ id: "i189757207" }, "test-key");

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

  it("reports average watts on a segment when the activity recorded power", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as {
      climbs: Array<{ avg_watts: number | null }>;
      descents: Array<{ avg_watts: number | null }>;
    };
    const anyWatts = [...structured.climbs, ...structured.descents].some(
      (segment) => segment.avg_watts != null,
    );
    expect(anyWatts).toBe(true);
  });

  it("reports a computed grade source and no climbs for a flat activity without grade_smooth", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(flatStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      grade_source: string;
    };
    expect(structured.grade_source).toBe("computed");
  });

  it("warns on a noisy elevation track", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([{ metres: 6000, speed: 3.5 }], {
        altitudeNoise: (i) => (i % 2 === 0 ? 1 : -1),
      }),
    );

    const result = await getHillAnalysisTool.execute(
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

  it("errors rather than calling a run with no elevation data flat", async () => {
    mockedGetActivity.mockResolvedValue(flatActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([{ metres: 3000, speed: 3.5 }], {
        withAltitude: false,
      }),
    );

    const result = await getHillAnalysisTool.execute(
      { id: "i189807578" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("needs elevation data");
  });

  it("refuses a ride before reading its streams, naming get-activity (#300)", async () => {
    mockedGetActivity.mockResolvedValue({
      ...hillyActivity,
      name: "Hill reps",
      type: "Ride",
    } as IntervalsActivity);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      '❌ Activity "Hill reps" [i189757207] is a Ride, not a run. get-hill-analysis covers Run, TrailRun and VirtualRun only; use get-activity for other activity types.',
    );
    expect(mockedGetActivityStreams).not.toHaveBeenCalled();
  });

  it("errors cleanly for an activity with no recorded streams, naming it", async () => {
    mockedGetActivity.mockResolvedValue({
      ...hillyActivity,
      name: "Pilates",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue([]);

    const result = await getHillAnalysisTool.execute(
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

    const result = await getHillAnalysisTool.execute(
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

    const result = await getHillAnalysisTool.execute(
      { id: "i999" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });

  describe("elevation source", () => {
    type SourceResult = {
      elevation_gain_m: number | null;
      climb_gain_m: number;
      climbs: Record<string, number>[];
    };
    type Structured = {
      elevation_source: string | null;
      elevation_note: string | null;
      totals: { climb_gain_m: number };
      warnings: string[];
      elevation_comparison: {
        corrected: SourceResult | null;
        barometric: SourceResult | null;
        climb_gain_difference_pct: number | null;
        note: string | null;
        sensitivity_warning: string | null;
      } | null;
    };
    const run = async (
      streams: IntervalsStream[],
      args: { elevationSource?: "corrected" | "barometric" | "both" } = {},
      activity: IntervalsActivity = hillyActivity,
    ) => {
      mockedGetActivity.mockResolvedValue(activity);
      mockedGetActivityStreams.mockResolvedValue(streams);
      const result = await getHillAnalysisTool.execute(
        { id: "i189757207", ...args },
        "test-key",
      );
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as Structured;
      expect(HillAnalysisOutputSchema.safeParse(structured).success).toBe(true);
      return { structured, text: result.content[0]?.text ?? "" };
    };

    it("reads the corrected stream by default and the recorded one on request", async () => {
      const corrected = await run(withCorrectedAltitude(hillyStreams));
      const recorded = await run(withCorrectedAltitude(hillyStreams), {
        elevationSource: "barometric",
      });

      expect(corrected.structured.elevation_source).toBe("corrected");
      expect(corrected.structured.elevation_note).toBeNull();
      expect(corrected.text).toContain("Elevation source: corrected");
      expect(recorded.structured.elevation_source).toBe("barometric");
      expect(recorded.structured.elevation_note).toBeNull();
      // The corrected fixture doubles every altitude change.
      expect(corrected.structured.totals.climb_gain_m).toBeGreaterThan(
        recorded.structured.totals.climb_gain_m,
      );
    });

    it("falls back to the recorded altitude, and says so, without a corrected stream", async () => {
      const { structured, text } = await run(hillyStreams);

      expect(structured.elevation_source).toBe("barometric");
      expect(structured.elevation_note).toContain(
        "no corrected altitude stream",
      );
      expect(text).toContain("Elevation source: barometric");
      expect(text).toContain("no corrected altitude stream");
    });

    it("ignores a corrected stream when the activity has correction off", async () => {
      const { structured } = await run(
        withCorrectedAltitude(hillyStreams),
        {},
        { ...hillyActivity, use_elevation_correction: false },
      );

      expect(structured.elevation_source).toBe("barometric");
      expect(structured.elevation_note).toContain("correction is off");
    });

    it("accepts the three elevation sources and nothing else", () => {
      const parse = (elevationSource?: string) =>
        getHillAnalysisTool.inputSchema.safeParse({
          id: "i1",
          elevationSource,
        });
      for (const choice of ["corrected", "barometric", "both", undefined]) {
        expect(parse(choice).success).toBe(true);
      }
      expect(parse("gps").success).toBe(false);
    });

    it("leaves elevation_comparison null for one source", async () => {
      const { structured, text } = await run(
        withCorrectedAltitude(hillyStreams),
      );

      expect(structured.elevation_comparison).toBeNull();
      expect(text).not.toContain("Gain: corrected");
    });

    it("puts both sources' climbs side by side and warns when they disagree", async () => {
      const { structured, text } = await run(
        withCorrectedAltitude(hillyStreams),
        { elevationSource: "both" },
      );
      const comparison = structured.elevation_comparison;
      const corrected = comparison?.corrected;
      const barometric = comparison?.barometric;

      // The headline is the corrected source's.
      expect(structured.elevation_source).toBe("corrected");
      expect(corrected?.climb_gain_m).toBe(structured.totals.climb_gain_m);
      expect(corrected?.climbs[0]).toEqual({
        start_km: expect.any(Number),
        end_km: expect.any(Number),
        length_m: expect.any(Number),
        avg_grade_pct: expect.any(Number),
        elevation_change_m: expect.any(Number),
      });
      // The corrected fixture doubles every altitude change.
      expect(barometric?.climb_gain_m).toBeLessThan(
        corrected?.climb_gain_m ?? 0,
      );
      expect(corrected?.elevation_gain_m).toBeGreaterThan(
        barometric?.elevation_gain_m ?? Infinity,
      );
      expect(comparison?.note).toBeNull();
      expect(comparison?.climb_gain_difference_pct).toBeGreaterThan(
        ELEVATION_SENSITIVITY.climbGainPct,
      );
      expect(comparison?.sensitivity_warning).toContain(
        "Do not trust the climb list",
      );
      expect(structured.warnings).toContain(comparison?.sensitivity_warning);
      expect(text).toMatch(/Gain: corrected \+\d+ m, barometric \+\d+ m/);
      expect(text).toContain("Climbs by elevation source:");
      expect(text).toContain("Warning: Climb gain differs");
    });

    it("does not warn when the two sources agree", async () => {
      const { structured } = await run(withCorrectedAltitude(hillyStreams, 1), {
        elevationSource: "both",
      });
      const comparison = structured.elevation_comparison;

      expect(comparison?.climb_gain_difference_pct).toBe(0);
      expect(comparison?.sensitivity_warning).toBeNull();
    });

    it("gives the barometric result, not an error, when both is asked without a corrected stream", async () => {
      const { structured, text } = await run(hillyStreams, {
        elevationSource: "both",
      });
      const comparison = structured.elevation_comparison;

      expect(structured.elevation_source).toBe("barometric");
      expect(comparison?.corrected).toBeNull();
      expect(comparison?.barometric?.climb_gain_m).toBe(
        structured.totals.climb_gain_m,
      );
      expect(comparison?.note).toContain(
        "corrected elevation stream is not available",
      );
      expect(comparison?.sensitivity_warning).toBeNull();
      expect(text).toContain("Gain: corrected n/a, barometric +");
      expect(text).toContain("corrected: not available");
    });
  });
});

describe("get-hill-analysis GAP model (#508)", () => {
  type Structured = {
    gap_model: string;
    gap_source: string;
    gap_note: string | null;
    climbs: Array<{ gap_pace_min_per_km: string | null }>;
  };

  it("gives every climb intervals.icu's GAP when the activity has its stream", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(
      withGaVelocity(withCorrectedAltitude(hillyStreams), 4),
    );

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as Structured;
    expect(structured.gap_model).toBe("strava");
    expect(structured.gap_source).toBe("intervals.icu");
    expect(structured.gap_note).toBeNull();
    expect(structured.climbs.length).toBeGreaterThan(0);
    expect(
      structured.climbs.every((c) => c.gap_pace_min_per_km === "4:10"),
    ).toBe(true);
    expect(result.content[0]?.text).toContain(
      "GAP model: Strava (the intervals.icu number for this activity)",
    );
    expect(HillAnalysisOutputSchema.safeParse(structured).success).toBe(true);
  });

  it("names Minetti and the reason without the stream", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    const structured = result.structuredContent as Structured;
    expect(structured.gap_model).toBe("minetti");
    expect(structured.gap_source).toBe("model");
    expect(structured.gap_note).toContain(
      "no intervals.icu grade-adjusted speed",
    );
    expect(result.content[0]?.text).toContain(
      "GAP model: Minetti (computed here from grade).",
    );
  });
});
