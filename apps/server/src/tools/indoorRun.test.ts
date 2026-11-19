/**
 * An indoor run through the analysis tools (#517): each says the run is
 * indoors, or drops the outdoor-only wording, and none reports outdoor
 * weather as the conditions of the run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { indoorActivity, indoorStreams } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import {
  getActivity,
  getActivityFile,
  getActivityStreams,
  type IntervalsActivity,
} from "../intervalsClient";
import { getActivityTool } from "./getActivity";
import { getHillAnalysisTool } from "./getHillAnalysis";
import { getIntervalAnalysisTool } from "./getIntervalAnalysis";
import { getRunningSummaryTool } from "./getRunningSummary";
import { getSplitAnalysisTool } from "./getSplitAnalysis";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getActivityFile: vi.fn(),
    getSportSettings: vi.fn(async () => null),
    listGear: vi.fn(async () => []),
    searchActivitiesByIntervals: vi.fn(async () => []),
  };
});

const outdoor = activityFixture as unknown as IntervalsActivity;
const indoor = indoorActivity(outdoor);
const NOTE =
  "Indoor activity (treadmill or trainer): no GPS, elevation, grade-adjusted pace or weather.";

const textOf = (result: { content: Array<{ text?: string }> }) =>
  result.content[0]?.text ?? "";

beforeEach(() => {
  vi.mocked(getActivity).mockReset();
  vi.mocked(getActivityStreams).mockReset();
  vi.mocked(getActivityFile).mockReset();
  vi.mocked(getActivity).mockResolvedValue(indoor);
  vi.mocked(getActivityStreams).mockResolvedValue(indoorStreams());
});

describe("an indoor run (#517)", () => {
  it("get-activity says the run is indoors and reports no weather", async () => {
    const result = await getActivityTool.execute(
      { id: indoor.id, includeIntervals: false },
      "key",
    );

    const structured = result.structuredContent as {
      indoor: boolean;
      weather: unknown;
      elevation_gain_m: number | null;
    };
    expect(structured.indoor).toBe(true);
    expect(structured.weather).toBeNull();
    expect(structured.elevation_gain_m).toBeNull();
    expect(textOf(result)).toContain(NOTE);
    expect(textOf(result)).not.toContain("Weather:");
    // No weather to report, so the activity file is not read.
    expect(getActivityFile).not.toHaveBeenCalled();
  });

  it("get-activity leaves an outdoor run as it was", async () => {
    vi.mocked(getActivity).mockResolvedValue(outdoor);
    vi.mocked(getActivityFile).mockResolvedValue(new Uint8Array());

    const result = await getActivityTool.execute(
      { id: outdoor.id, includeIntervals: false },
      "key",
    );

    expect((result.structuredContent as { indoor: boolean }).indoor).toBe(
      false,
    );
    expect(textOf(result)).not.toContain("Indoor activity");
  });

  it("get-running-summary says the run is indoors and prints no weather line", async () => {
    const result = await getRunningSummaryTool.execute(
      { id: indoor.id },
      "key",
    );

    const structured = result.structuredContent as {
      indoor: boolean;
      weather: unknown;
    };
    expect(structured.indoor).toBe(true);
    expect(structured.weather).toBeNull();
    expect(textOf(result)).toContain(NOTE);
    expect(textOf(result)).not.toContain("Weather:");
  });

  it("get-interval-analysis calls a short stop a short stop, not a traffic light", async () => {
    const result = await getIntervalAnalysisTool.execute(
      { id: indoor.id, findSimilar: false },
      "key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      rests: Array<{ kind: string; reason: string }>;
      reasoning: string;
    };
    // The kind is a published value and does not change.
    expect(structured.rests.map((rest) => rest.kind)).toEqual([
      "traffic_light",
    ]);
    expect(structured.rests[0]!.reason).toContain("short stop, excluded");
    expect(JSON.stringify(structured)).not.toMatch(/traffic light/i);
    expect(textOf(result)).not.toMatch(/traffic light/i);
    expect(structured.reasoning).toContain("1 short stops");
  });

  it("get-interval-analysis keeps the traffic light on an outdoor run", async () => {
    vi.mocked(getActivity).mockResolvedValue({
      ...indoor,
      trainer: null,
    } as IntervalsActivity);

    const result = await getIntervalAnalysisTool.execute(
      { id: indoor.id, findSimilar: false },
      "key",
    );

    const structured = result.structuredContent as {
      rests: Array<{ reason: string }>;
    };
    expect(structured.rests[0]!.reason).toContain("traffic light, excluded");
  });

  it("get-hill-analysis refuses and says the run is indoors", async () => {
    const result = await getHillAnalysisTool.execute({ id: indoor.id }, "key");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "❌ Neither a grade nor an altitude stream is available: hill analysis needs elevation data. This run is indoors (intervals.icu's trainer flag), so it has no elevation data.",
    );
  });

  it("get-split-analysis gives clock-only splits with no GAP model", async () => {
    const result = await getSplitAnalysisTool.execute({ id: indoor.id }, "key");

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      grade_source: string;
      gap_model: string | null;
      gap_note: string | null;
      elevation_source: string | null;
    };
    expect(structured).toMatchObject({
      grade_source: "none",
      gap_model: null,
      gap_note: null,
      elevation_source: null,
    });
  });
});
