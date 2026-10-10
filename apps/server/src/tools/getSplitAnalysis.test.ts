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
} from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityHilly from "../__fixtures__/intervals/activity-hilly.json";
import streamsFixture from "../__fixtures__/intervals/streams.json";
import streamsHilly from "../__fixtures__/intervals/streams-hilly.json";
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
    expect(text).toContain("Grade source: grade_smooth");
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
    expect(structured.grade_source).toBe("grade_smooth");
    expect(structured.splits.length).toBeGreaterThan(0);
    expect(structured.splits[0]!.pace_min_per_km).toMatch(/^\d+:\d{2}$/);
    expect(structured.totals.distance_m).toBeGreaterThan(1800);
    const cadenced = structured.splits.find((s) => s.avg_cadence != null);
    // Run cadence is doubled to spm for display.
    expect(cadenced?.avg_cadence).toBeGreaterThan(100);
    expect(SplitAnalysisOutputSchema.safeParse(structured).success).toBe(true);
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
});
