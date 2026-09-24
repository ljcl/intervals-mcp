/**
 * Handler tests for get-aerobic-analysis: dispatch-level, with intervalsClient
 * mocked. The decoupling/EF math itself is covered in aerobicAnalysis.test.ts;
 * these pin the intervals.icu-vs-computed source selection, stream fetch
 * skipping, basis selection, threshold/warm-up resolution, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import sportSettingsRunFixture from "../__fixtures__/intervals/sport-settings-run.json";
import streamsFixture from "../__fixtures__/intervals/streams.json";
import {
  getActivity,
  getActivityStreams,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsSportSettings,
  type IntervalsStream,
} from "../intervalsClient";
import { getAerobicAnalysisTool } from "./getAerobicAnalysis";
import { AerobicAnalysisOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getSportSettings: vi.fn(),
  };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);
const mockedGetSportSettings = vi.mocked(getSportSettings);

const baseActivity = activityFixture as unknown as IntervalsActivity;
const baseStreams = streamsFixture as unknown as IntervalsStream[];
const sportSettingsRun =
  sportSettingsRunFixture as unknown as IntervalsSportSettings;

/** 1 Hz synthetic streams with watts, for power-basis tests. */
function powerStreams() {
  const n = 3600;
  const time = Array.from({ length: n }, (_, i) => i);
  return [
    { type: "time", data: time },
    { type: "heartrate", data: time.map(() => 150) },
    { type: "watts", data: time.map(() => 250) },
    { type: "velocity_smooth", data: time.map(() => 3.2) },
  ] as IntervalsStream[];
}

beforeEach(() => {
  mockedGetActivity.mockReset();
  mockedGetActivityStreams.mockReset();
  mockedGetSportSettings.mockReset();
  mockedGetSportSettings.mockResolvedValue(sportSettingsRun);
});

describe("get-aerobic-analysis", () => {
  it("computes from streams on the base fixture (null API decoupling/EF), pace basis by default", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity);
    mockedGetActivityStreams.mockResolvedValue(baseStreams);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Aerobic Analysis: Run 1");
    expect(text).toContain("Basis: pace:HR (Pa:Hr)");
    expect(text).toMatch(/\[computed\]/);

    const structured = result.structuredContent as {
      basis: string;
      decoupling_source: string;
      efficiency_factor_source: string;
      breakdown: unknown;
    };
    expect(structured.basis).toBe("pace");
    expect(structured.decoupling_source).toBe("computed");
    expect(structured.efficiency_factor_source).toBe("computed");
    expect(structured.breakdown).not.toBeNull();
    expect(AerobicAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("prefers intervals.icu's decoupling/EF and skips the stream fetch", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      decoupling: 3.2,
      icu_efficiency_factor: 1.45,
    } as IntervalsActivity);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedGetActivityStreams).not.toHaveBeenCalled();

    const structured = result.structuredContent as {
      decoupling_pct: number;
      decoupling_source: string;
      efficiency_factor: number;
      efficiency_factor_source: string;
      breakdown: unknown;
    };
    expect(structured.decoupling_pct).toBeCloseTo(3.2, 5);
    expect(structured.decoupling_source).toBe("intervals.icu");
    expect(structured.efficiency_factor).toBeCloseTo(1.45, 5);
    expect(structured.efficiency_factor_source).toBe("intervals.icu");
    expect(structured.breakdown).toBeNull();
    expect(AerobicAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("fetches streams for the breakdown when includeBreakdown is set, keeping the intervals.icu decoupling/EF values", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      decoupling: 3.2,
      icu_efficiency_factor: 1.45,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(baseStreams);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: true },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedGetActivityStreams).toHaveBeenCalled();

    const structured = result.structuredContent as {
      decoupling_pct: number;
      decoupling_source: string;
      efficiency_factor_source: string;
      breakdown: unknown;
    };
    expect(structured.decoupling_pct).toBeCloseTo(3.2, 5);
    expect(structured.decoupling_source).toBe("intervals.icu");
    expect(structured.breakdown).not.toBeNull();
  });

  it("analyses the power basis from the watts stream and notes an Apple Watch power estimate", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      device_name: "Watch7,5",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(powerStreams());

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "power", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Basis: power:HR (Pw:Hr)");
    expect(text).toContain("Apple Watch");
    const structured = result.structuredContent as { basis: string };
    expect(structured.basis).toBe("power");
  });

  it("resolves threshold power from Run sport settings ftp for intensity factor", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity);
    mockedGetActivityStreams.mockResolvedValue(powerStreams());
    mockedGetSportSettings.mockResolvedValue({
      ...sportSettingsRun,
      ftp: 300,
    });

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "power", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      threshold_power_w: number | null;
      intensity_factor: number | null;
    };
    expect(structured.threshold_power_w).toBe(300);
    expect(structured.intensity_factor).toBeCloseTo(250 / 300, 3);
  });

  it("falls back to the activity's icu_ftp when sport settings have no ftp", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      icu_ftp: 280,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(powerStreams());
    mockedGetSportSettings.mockResolvedValue(sportSettingsRun); // ftp: null

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "power", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      threshold_power_w: number | null;
    };
    expect(structured.threshold_power_w).toBe(280);
  });

  it("warns when no threshold power is configured anywhere", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity); // icu_ftp: null
    mockedGetActivityStreams.mockResolvedValue(powerStreams());
    mockedGetSportSettings.mockResolvedValue(sportSettingsRun); // ftp: null

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "power", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No threshold power is set");
    const structured = result.structuredContent as {
      intensity_factor: number | null;
    };
    expect(structured.intensity_factor).toBeNull();
  });

  it("uses the activity's icu_warmup_time as the default warm-up exclusion", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      icu_warmup_time: 120,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(baseStreams);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      breakdown: { excluded_warmup_minutes: number } | null;
    };
    expect(
      structured.breakdown?.excluded_warmup_minutes,
    ).toBeGreaterThanOrEqual(2);
  });

  it("errors cleanly for an activity with no recorded streams", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      name: "Manual Yoga",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue([]);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Manual Yoga");
  });

  it("reports an exhausted rate limit instead of a generic failure", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity);
    mockedGetActivityStreams.mockRejectedValue(
      handledRateLimit("getActivityStreams for ID i189807578"),
    );

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rate limit");
  });

  it("returns not-found text when the activity does not exist", async () => {
    mockedGetActivity.mockRejectedValue(
      handledNotFound("getActivity for ID i999"),
    );

    const result = await getAerobicAnalysisTool.execute(
      { id: "i999", basis: "pace", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });
});
