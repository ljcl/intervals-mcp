/**
 * Handler tests for get-split-analysis: dispatch-level, with intervalsClient
 * mocked. The binning and verdict math is covered in splitAnalysis.test.ts;
 * these pin the fetch wiring, cadence doubling, degradation paths, and text
 * shape, using the hilly and flat intervals.icu fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
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
