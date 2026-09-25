/**
 * Handler tests for get-hill-analysis: dispatch-level, with intervalsClient
 * mocked. The detection and drift math is covered in hillAnalysis.test.ts;
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

beforeEach(() => {
  mockedGetActivity.mockReset();
  mockedGetActivityStreams.mockReset();
});

describe("get-hill-analysis", () => {
  it("detects descents on the hilly fixture with pace strings, grade source, and cadence in spm", async () => {
    mockedGetActivity.mockResolvedValue(hillyActivity);
    mockedGetActivityStreams.mockResolvedValue(hillyStreams);

    const result = await getHillAnalysisTool.execute(
      { id: "i189757207" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Hill Analysis:");
    expect(text).toContain("Grade source: grade_smooth");
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
    expect(structured.grade_source).toBe("grade_smooth");
    expect(structured.totals.descent_count).toBeGreaterThan(0);
    expect(structured.descents[0]!.pace_min_per_km).toMatch(/^\d+:\d{2}$/);
    // Run cadence is doubled to spm for display.
    expect(structured.descents[1]!.avg_cadence).toBeGreaterThan(100);
    expect(HillAnalysisOutputSchema.safeParse(structured).success).toBe(true);
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
});
