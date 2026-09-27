/**
 * Handler tests for get-aerobic-analysis: dispatch-level, with intervalsClient
 * mocked. The decoupling/EF math itself is covered in aerobicAnalysis.test.ts;
 * these pin the intervals.icu-vs-computed source selection, stream fetch
 * skipping, basis selection, threshold/warm-up resolution, and text shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  syntheticStreams,
} from "../__fixtures__";
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
  it("computes from streams on the base fixture (null API decoupling/EF) on the pace basis", async () => {
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
    // The caller chose pace: no "missing power stream" warning.
    expect(text).not.toContain("No power stream");

    const structured = result.structuredContent as {
      basis: string;
      decoupling_source: string;
      efficiency_factor_source: string;
      breakdown: unknown;
      intervals_icu: unknown;
    };
    expect(structured.basis).toBe("pace");
    expect(structured.decoupling_source).toBe("computed");
    expect(structured.efficiency_factor_source).toBe("computed");
    expect(structured.breakdown).not.toBeNull();
    expect(structured.intervals_icu).toBeNull();
    expect(AerobicAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("defaults to the grade-adjusted basis when intervals.icu has no values", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity);
    mockedGetActivityStreams.mockResolvedValue(baseStreams);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const requestedTypes = mockedGetActivityStreams.mock.calls[0]![2];
    for (const type of ["distance", "altitude", "grade_smooth"]) {
      expect(requestedTypes).toContain(type);
    }
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Basis: grade-adjusted pace:HR (GAP:Hr)");
    expect(text).toContain("Normalized grade-adjusted pace:");
    const structured = result.structuredContent as {
      basis: string;
      units: { efficiency_factor: string };
    };
    expect(structured.basis).toBe("gap");
    expect(structured.units.efficiency_factor).toContain("grade-adjusted");
    expect(AerobicAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("takes intervals.icu's own decoupling/EF when no basis is asked for, labelled with no basis", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      decoupling: 3.2,
      icu_efficiency_factor: 1.45,
    } as IntervalsActivity);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedGetActivityStreams).not.toHaveBeenCalled();

    const structured = result.structuredContent as {
      basis: string | null;
      decoupling_pct: number;
      decoupling_source: string;
      efficiency_factor: number;
      efficiency_factor_source: string;
      breakdown: unknown;
      intervals_icu: { decoupling_pct: number; efficiency_factor: number };
      units: { efficiency_factor: string };
    };
    expect(structured.basis).toBeNull();
    expect(structured.decoupling_pct).toBeCloseTo(3.2, 5);
    expect(structured.decoupling_source).toBe("intervals.icu");
    expect(structured.efficiency_factor).toBeCloseTo(1.45, 5);
    expect(structured.efficiency_factor_source).toBe("intervals.icu");
    expect(structured.intervals_icu).toEqual({
      decoupling_pct: 3.2,
      efficiency_factor: 1.45,
    });
    expect(structured.units.efficiency_factor).toBe("not reported");
    expect(structured.breakdown).toBeNull();
    expect(AerobicAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Basis: not reported (intervals.icu's own values)");
    expect(text).not.toMatch(/Pa:Hr|Pw:Hr|GAP:Hr|W\/beat|m\/min per beat/);
  });

  it.each(["pace", "power", "gap"] as const)(
    "computes an explicitly requested %s basis from streams and keeps intervals.icu's values apart",
    async (basis) => {
      mockedGetActivity.mockResolvedValue({
        ...baseActivity,
        decoupling: 3.2,
        icu_efficiency_factor: 1.45,
      } as IntervalsActivity);
      mockedGetActivityStreams.mockResolvedValue(
        basis === "power" ? powerStreams() : baseStreams,
      );

      const result = await getAerobicAnalysisTool.execute(
        { id: "i189807578", basis, includeBreakdown: false },
        "test-key",
      );

      expect(result.isError).toBeUndefined();
      expect(mockedGetActivityStreams).toHaveBeenCalled();
      const structured = result.structuredContent as {
        basis: string;
        decoupling_pct: number;
        decoupling_source: string;
        efficiency_factor_source: string;
        breakdown: unknown;
        intervals_icu: { decoupling_pct: number; efficiency_factor: number };
      };
      expect(structured.basis).toBe(basis);
      expect(structured.decoupling_source).toBe("computed");
      expect(structured.efficiency_factor_source).toBe("computed");
      expect(structured.breakdown).not.toBeNull();
      expect(structured.intervals_icu).toEqual({
        decoupling_pct: 3.2,
        efficiency_factor: 1.45,
      });

      const text = result.content[0]?.text ?? "";
      // intervals.icu's value sits on its own line, never under the basis.
      expect(text).not.toMatch(/Decoupling: \+3\.2%/);
      expect(text).toContain(
        "intervals.icu's own values (basis and unit not reported, so not comparable with the above): decoupling +3.2%, efficiency factor 1.45.",
      );
    },
  );

  it("computes from streams when includeBreakdown is set, on the grade-adjusted basis", async () => {
    mockedGetActivity.mockResolvedValue({
      ...baseActivity,
      decoupling: 3.2,
      icu_efficiency_factor: 1.45,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(baseStreams);

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", includeBreakdown: true },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      basis: string;
      decoupling_source: string;
      breakdown: unknown;
      intervals_icu: unknown;
    };
    expect(structured.basis).toBe("gap");
    expect(structured.decoupling_source).toBe("computed");
    expect(structured.breakdown).not.toBeNull();
    expect(structured.intervals_icu).not.toBeNull();
  });

  describe("an out-and-back course at a steady 150 bpm (#74)", () => {
    const outAndBack = (upFirst: boolean) => {
      const up = { metres: 5000, speed: 2.8, gradePct: 1.8, hr: 150 };
      const down = { metres: 5000, speed: 3.4, gradePct: -1.8, hr: 150 };
      return syntheticStreams(upFirst ? [up, down] : [down, up]);
    };

    it.each([
      { label: "uphill first", upFirst: true, rawSign: -1 },
      { label: "downhill first", upFirst: false, rawSign: 1 },
    ])(
      "reads the $label course as about 0% on the gap basis, and as drift on raw pace",
      async ({ upFirst, rawSign }) => {
        mockedGetActivity.mockResolvedValue(baseActivity);
        mockedGetActivityStreams.mockResolvedValue(outAndBack(upFirst));

        const run = async (basis: "gap" | "pace") =>
          (
            await getAerobicAnalysisTool.execute(
              {
                id: "i189807578",
                basis,
                excludeWarmupMinutes: 0,
                includeBreakdown: false,
              },
              "test-key",
            )
          ).structuredContent as { decoupling_pct: number };

        expect(Math.abs((await run("gap")).decoupling_pct)).toBeLessThan(1);
        expect((await run("pace")).decoupling_pct * rawSign).toBeGreaterThan(
          10,
        );
      },
    );
  });

  it("falls back to raw pace, and says so, when the gap basis has no elevation data", async () => {
    mockedGetActivity.mockResolvedValue(baseActivity);
    mockedGetActivityStreams.mockResolvedValue(
      syntheticStreams([{ metres: 8000, speed: 3.2, hr: 150 }], {
        withAltitude: false,
      }),
    );

    const result = await getAerobicAnalysisTool.execute(
      { id: "i189807578", basis: "gap", includeBreakdown: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      basis: string;
      warnings: string[];
    };
    expect(structured.basis).toBe("pace");
    expect(structured.warnings.join(" ")).toContain(
      "grade-adjusted basis is unavailable",
    );
    expect(result.content[0]?.text).toContain("Basis: pace:HR (Pa:Hr)");
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

  it("accepts excludeWarmupMinutes at the 0-120 bounds and rejects outside them", () => {
    const parse = (excludeWarmupMinutes: number) =>
      getAerobicAnalysisTool.inputSchema.safeParse({
        id: "i189807578",
        excludeWarmupMinutes,
      });

    expect(parse(0).success).toBe(true);
    expect(parse(120).success).toBe(true);
    expect(parse(-1).success).toBe(false);
    expect(parse(121).success).toBe(false);
  });
});
