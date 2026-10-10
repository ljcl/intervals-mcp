import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  type SyntheticLeg,
  syntheticStreams,
} from "../__fixtures__";
import {
  buildFitFile,
  FIT_TYPES,
  fitFieldDescription,
} from "../__fixtures__/fitFile";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import { speedEfficiencyFactor } from "../aerobicAnalysis";
import {
  getActivity,
  getActivityFile,
  getActivityStreams,
  type IntervalsActivity,
} from "../intervalsClient";
import { buildComparison, compareActivitiesTool } from "./compareActivities";
import { CompareActivitiesOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getActivityFile: vi.fn(),
  };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);
const mockedGetActivityFile = vi.mocked(getActivityFile);

/** A HealthFit-style FIT file: session humidity and temperature. */
function weatherFile(temperature: number, humidity: number): Uint8Array {
  return buildFitFile([
    fitFieldDescription(0, 3, "SESSION WEATHER HUMIDITY", FIT_TYPES.uint16),
    {
      global: 18,
      fields: [{ num: 57, type: FIT_TYPES.sint8, value: temperature }],
      devFields: [
        { num: 3, devIndex: 0, type: FIT_TYPES.uint16, value: humidity * 100 },
      ],
    },
  ]);
}

/** `km` 1 km legs at 5:00/km, with the heart rate `hr(k)` on km k (1-based). */
function kmLegs(km: number, hr: (k: number) => number): SyntheticLeg[] {
  return Array.from({ length: km }, (_, i) => ({
    metres: 1000,
    speed: 1000 / 300,
    hr: hr(i + 1),
  }));
}

/**
 * Build a minimal intervals.icu activity from a partial. Only the fields the
 * comparison reads matter; we cast through unknown so tests stay terse
 * rather than constructing every required schema field.
 */
function fakeActivity(
  overrides: Partial<IntervalsActivity>,
): IntervalsActivity {
  return {
    id: "i100",
    name: "Morning Run",
    type: "Run",
    start_date_local: "2026-06-01T07:00:00",
    distance: 10000,
    moving_time: 3200,
    average_heartrate: 150,
    max_heartrate: 172,
    average_cadence: 84,
    total_elevation_gain: 80,
    icu_training_load: 60,
    ...overrides,
  } as unknown as IntervalsActivity;
}

/** A committed activity row, e.g. the two 1,500 m pool swims. */
function byId(id: string): IntervalsActivity {
  const found = (activitiesFixture as unknown as IntervalsActivity[]).find(
    (a) => a.id === id,
  );
  if (!found) throw new Error(`fixture missing ${id}`);
  return found;
}

const faster = fakeActivity({
  id: "i200",
  name: "Race Day",
  start_date_local: "2026-06-15T07:00:00",
  moving_time: 3000, // 5:00 min/km over 10000m
  average_heartrate: 160,
  average_cadence: 87,
  total_elevation_gain: 78,
  icu_training_load: 70,
});

describe("buildComparison", () => {
  it("computes activity2 - activity1 differences with interpretations", () => {
    const result = buildComparison(fakeActivity({}), faster);

    expect(result.activity_1.name).toBe("Morning Run");
    expect(result.activity_2.name).toBe("Race Day");
    expect(result.differences.pace_delta_sec_per_km).toBeLessThan(-5);
    expect(result.differences.pace_delta_interpretation).toBe("faster");
    expect(result.differences.pace_delta_min_per_km).toMatch(/^-\d+:\d{2}$/);
    expect(result.differences.avg_hr).toBe(10);
    expect(result.differences.cadence_spm).toBe(6);
    expect(result.differences.elevation_gain_m).toBe(-2);
    expect(result.warnings).toBeUndefined();
  });

  it("formats the per-side pace as m:ss, moving_time as h:mm:ss/m:ss, and moving_time_s as raw seconds", () => {
    const result = buildComparison(fakeActivity({}), faster);

    expect(result.activity_1.pace_min_per_km).toBe("5:20");
    expect(result.activity_1.moving_time).toBe("53:20");
    expect(result.activity_1.moving_time_s).toBe(3200);
    expect(result.activity_2.pace_min_per_km).toBe("5:00");
  });

  it("computes the efficiency analysis when pace and HR exist on both sides", () => {
    const result = buildComparison(fakeActivity({}), faster);

    // 6.7% faster at 6.7% higher HR: both runs cover 1.25 m/min per beat,
    // so the second run was harder, not more efficient.
    expect(result.efficiency?.activity_1).toBe(1.25);
    expect(result.efficiency?.activity_2).toBe(1.25);
    expect(result.efficiency?.change_percent).toBeCloseTo(0, 5);
    expect(result.efficiency?.interpretation).toBe("unchanged");
  });

  it("skips pace, HR, and efficiency when the data is missing", () => {
    const bare = fakeActivity({
      distance: null,
      moving_time: null,
      average_heartrate: null,
      average_cadence: null,
    });
    const result = buildComparison(bare, faster);

    expect(result.activity_1.pace_min_per_km).toBeNull();
    expect(result.differences.pace_delta_sec_per_km).toBeNull();
    expect(result.differences.pace_delta_min_per_km).toBeNull();
    expect(result.differences.pace_delta_interpretation).toBeNull();
    expect(result.differences.avg_hr).toBeNull();
    expect(result.differences.cadence_spm).toBeNull();
    expect(result.efficiency).toBeNull();
  });

  it("carries load, decoupling_pct, efficiency_factor, and running dynamics when present", () => {
    const withDynamics = fakeActivity({
      decoupling: 4.2,
      icu_efficiency_factor: 1.35,
      average_stance_time: 230,
      average_vertical_oscillation: 100,
      average_vertical_ratio: 8.5,
      average_step_length: 1200,
      average_stride: 1.2,
    });
    const result = buildComparison(withDynamics, faster);

    expect(result.activity_1.load).toBe(60);
    expect(result.activity_1.decoupling_pct).toBe(4.2);
    expect(result.activity_1.efficiency_factor).toBe(1.35);
    expect(result.activity_1.running_dynamics).toEqual({
      stance_time_ms: 230,
      vertical_oscillation_mm: 100,
      vertical_ratio_pct: 8.5,
      step_length_mm: 1200,
      stride_m: 1.2,
    });
    // faster has no running-dynamics fields set.
    expect(result.activity_2.running_dynamics).toBeNull();
  });

  it("warns when an activity is not a run", () => {
    const ride = fakeActivity({ name: "Commute", type: "Ride" });
    const result = buildComparison(ride, faster);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("Commute");
  });

  it("matches the compare-activities structured output schema", () => {
    const result = buildComparison(fakeActivity({}), faster);
    expect(CompareActivitiesOutputSchema.safeParse(result).success).toBe(true);
    expect(result.units).toMatchObject({
      swim_pace: "min/100m",
      speed: "km/h",
    });
  });

  it("gives each swim side a pace per 100 m, with no pace difference or efficiency", () => {
    const swim1 = byId("i189757185");
    const swim2 = byId("i189757197");
    const result = buildComparison(swim1, swim2);

    // 1,500 m in 1,489 s and in 1,420 s.
    expect(result.activity_1.pace_min_per_100m).toBe("1:39");
    expect(result.activity_2.pace_min_per_100m).toBe("1:35");
    expect(result.activity_1.pace_min_per_km).toBeNull();
    expect(result.activity_1.speed_kmh).toBeNull();
    expect(result.differences.pace_delta_sec_per_km).toBeNull();
    expect(result.efficiency).toBeNull();
    expect(result.warnings).toHaveLength(2);
    expect(CompareActivitiesOutputSchema.safeParse(result).success).toBe(true);
  });

  it("gives a ride side km/h and a run side neither speed field", () => {
    const ride = fakeActivity({
      name: "Commute",
      type: "Ride",
      distance: 20000,
      moving_time: 2400,
    });
    const result = buildComparison(fakeActivity({}), ride);

    expect(result.activity_2.speed_kmh).toBe(30);
    expect(result.activity_2.pace_min_per_100m).toBeNull();
    expect(result.activity_1.speed_kmh).toBeNull();
    expect(result.activity_1.pace_min_per_100m).toBeNull();
  });
});

describe("buildComparison efficiency factor", () => {
  /** A 10 km run at `secPerKm` pace and `hr` average heart rate. */
  const run = (
    secPerKm: number,
    hr: number,
    over: Partial<IntervalsActivity> = {},
  ) =>
    fakeActivity({
      distance: 10000,
      moving_time: secPerKm * 10,
      average_heartrate: hr,
      ...over,
    });

  it("calls the same speed per beat unchanged, however pace and heart rate split it", () => {
    // #42's worked example: 5:00/km at 150 and 6:00/km at 125 both cover
    // 1.333 m/min per beat (750 beats per km). Pace divided by heart rate
    // called this "+44%, declined".
    const result = buildComparison(run(300, 150), run(360, 125));

    expect(result.efficiency?.activity_1).toBe(1.333);
    expect(result.efficiency?.activity_2).toBe(1.333);
    expect(result.efficiency?.change_percent).toBeCloseTo(0, 5);
    expect(result.efficiency?.interpretation).toBe("unchanged");
  });

  it("calls a faster pace at the same heart rate improved, as a positive change", () => {
    const result = buildComparison(run(330, 150), run(300, 150));

    expect(result.efficiency).toMatchObject({
      activity_1: 1.212,
      activity_2: 1.333,
      change_percent: 10,
      interpretation: "improved",
    });
  });

  it("calls the same pace at a higher heart rate declined", () => {
    const result = buildComparison(run(300, 150), run(300, 165));

    expect(result.efficiency?.change_percent).toBe(-9.1);
    expect(result.efficiency?.interpretation).toBe("declined");
  });

  it("uses get-aerobic-analysis's efficiency factor, not a copy of it", () => {
    const result = buildComparison(run(300, 150), run(330, 140));

    expect(result.efficiency?.activity_2).toBeCloseTo(
      speedEfficiencyFactor(10000 / 3300, 140),
      3,
    );
  });

  it("uses grade-adjusted speed when both runs have it, and says so", () => {
    // The hilly run is 30 s/km slower on the clock, but the same 5:00/km
    // grade-adjusted, at the same heart rate: the same fitness.
    const flat = run(300, 150, { gap: 10 / 3 });
    const hilly = run(330, 150, { gap: 10 / 3 });

    const result = buildComparison(flat, hilly);

    expect(result.efficiency?.change_percent).toBeCloseTo(0, 5);
    expect(result.efficiency?.interpretation).toBe("unchanged");
    expect(result.efficiency?.note).toContain(
      "grade-adjusted pace (intervals.icu gap) on both runs",
    );
  });

  it("uses moving speed on both sides when one run has no gap, and says so", () => {
    const flat = run(300, 150);
    const hilly = run(330, 150, { gap: 10 / 3 });

    const result = buildComparison(flat, hilly);

    // One basis for both sides: the hills now count against the hilly run.
    expect(result.efficiency?.change_percent).toBe(-9.1);
    expect(result.efficiency?.interpretation).toBe("declined");
    expect(result.efficiency?.note).toContain("from moving pace");
  });

  it("omits efficiency rather than dividing by a zero heart rate", () => {
    const result = buildComparison(run(300, 0), run(300, 150));

    expect(result.efficiency).toBeNull();
  });
});

describe("compare-activities execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedGetActivityStreams.mockReset();
    // No streams by default: the per-km table says why it is missing.
    mockedGetActivityStreams.mockResolvedValue([]);
    mockedGetActivityFile.mockReset();
  });

  it("pairs the km and calls a gap that is there from km 1 a constant offset", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(faster);
    mockedGetActivityStreams.mockImplementation(async (_key, id) =>
      syntheticStreams(kmLegs(6, () => (id === "i100" ? 150 : 159))),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    const structured = CompareActivitiesOutputSchema.parse(
      result.structuredContent,
    );
    const km = structured.km_comparison;
    expect(km?.basis).toBe("gap");
    expect(km?.rows).toHaveLength(6);
    expect(km?.rows[0]).toMatchObject({
      km: 1,
      pace_1_min_per_km: "5:00",
      pace_2_min_per_km: "5:00",
      pace_delta_sec_per_km: 0,
      hr_1: 150,
      hr_2: 159,
      hr_delta_bpm: 9,
      efficiency_delta_pct: -5.7,
    });
    expect(km?.verdict).toBe("constant offset");
    expect(km?.hr_gap_first_km_bpm).toBe(9);
    expect(km?.hr_gap_last_km_bpm).toBe(9);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "Per km at the same distance (activity 2 minus activity 1; efficiency on grade-adjusted pace):",
    );
    expect(text).toContain(
      "  1.   pace 5:00 vs 5:00 (0 s), HR 150 vs 159 (+9), efficiency -5.7%",
    );
    expect(text).toMatch(/^Verdict: Constant offset: /m);
  });

  it("calls a gap that grows over the run growing drift, naming the run that lost efficiency", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(faster);
    mockedGetActivityStreams.mockImplementation(async (_key, id) =>
      syntheticStreams(kmLegs(8, (k) => (id === "i100" ? 150 : 150 + 2 * k))),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    const km = CompareActivitiesOutputSchema.parse(
      result.structuredContent,
    ).km_comparison;
    expect(km?.verdict).toBe("growing drift");
    expect(km?.hr_gap_first_km_bpm).toBe(2);
    expect(km?.hr_gap_last_km_bpm).toBe(16);
    expect(km?.interpretation).toContain(
      "Activity 2 lost efficiency as the run went on",
    );
  });

  it("says why there is no per-km table when a run has no streams", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(faster);

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    const structured = CompareActivitiesOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.km_comparison).toBeNull();
    expect(structured.km_comparison_note).toBe("activity 1 has no streams");
    expect(result.content[0]?.text).toContain(
      "No per-km table: activity 1 has no streams.",
    );
  });

  it("reads no streams when either side is not a run, and names that side", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(
      fakeActivity({ id: "i200", type: "Ride" }),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    expect(mockedGetActivityStreams).not.toHaveBeenCalled();
    expect(
      CompareActivitiesOutputSchema.parse(result.structuredContent)
        .km_comparison_note,
    ).toBe("activity 2 is not a run");
  });

  it("fails on a rate limit from a stream read rather than reading it as no streams", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(faster);
    mockedGetActivityStreams.mockRejectedValue(
      handledRateLimit("getActivityStreams"),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    expect(result.isError).toBe(true);
  });

  it("reports each run's weather, the difference, and a note when the dew point differs by more than 5 °C", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      fakeActivity({ file_type: "fit", average_temp: 12 }),
    );
    mockedGetActivity.mockResolvedValueOnce({
      ...faster,
      file_type: "fit",
      average_temp: 26,
    });
    mockedGetActivityFile.mockImplementation(async (_key, id) =>
      id === "i100" ? weatherFile(12, 60) : weatherFile(26, 75),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    const structured = CompareActivitiesOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.activity_1.weather).toMatchObject({
      temperature_c: 12,
      humidity_pct: 60,
      dew_point_c: 4.5,
    });
    expect(structured.activity_2.weather).toMatchObject({
      temperature_c: 26,
      humidity_pct: 75,
      dew_point_c: 21.2,
    });
    expect(structured.differences.weather).toEqual({
      temperature_c: 14,
      humidity_pct: 15,
      dew_point_c: 16.7,
    });
    expect(structured.weather_note).toMatch(
      /^The dew point differs by \+16\.7 °C/,
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "  Weather: 12 °C, humidity 60%, dew point 4.5 °C (activity file)",
    );
    expect(text).toContain(
      "  Weather: 12 to 26 °C (+14.0), dew point 4.5 to 21.2 °C (+16.7), humidity 60 to 75% (+15)",
    );
    expect(text).toMatch(/^Weather note: The dew point differs by \+16\.7 °C/m);
  });

  it("gives no weather note when the dew points are within 5 °C", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      fakeActivity({ file_type: "fit", average_temp: 18 }),
    );
    mockedGetActivity.mockResolvedValueOnce({
      ...faster,
      file_type: "fit",
      average_temp: 20,
    });
    mockedGetActivityFile.mockImplementation(async (_key, id) =>
      id === "i100" ? weatherFile(18, 70) : weatherFile(20, 70),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i100", activityId2: "i200" },
      "test-token",
    );

    expect(
      CompareActivitiesOutputSchema.parse(result.structuredContent)
        .weather_note,
    ).toBeNull();
    expect(result.content[0]?.text).not.toContain("Weather note");
  });

  it("fetches both activities and returns text plus structured output", async () => {
    mockedGetActivity.mockResolvedValueOnce(fakeActivity({}));
    mockedGetActivity.mockResolvedValueOnce(faster);

    const result = await compareActivitiesTool.execute(
      {
        activityId1: "i100",
        activityId2: "i200",
      },
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    // The compare app's URL (`?intervals=true`), so a chat using both reads
    // each activity once.
    expect(mockedGetActivity).toHaveBeenCalledWith("test-token", "i100", {
      intervals: true,
    });
    expect(mockedGetActivity).toHaveBeenCalledWith("test-token", "i200", {
      intervals: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Activity 1: Morning Run");
    expect(text).toContain("Activity 2: Race Day");
    expect(text).toContain("faster");
    const structured = result.structuredContent as {
      differences: { avg_hr: number };
      efficiency: { activity_1: number; interpretation: string };
    };
    expect(structured.differences.avg_hr).toBe(10);
    // The app's tile reads the same efficiency object the text prints.
    expect(text).toContain(
      `Activity 1: ${structured.efficiency.activity_1} m/min per beat`,
    );
    expect(text).toContain(`(${structured.efficiency.interpretation})`);
  });

  it("prints a swim side's pace per 100 m and a ride side's speed", async () => {
    mockedGetActivity.mockResolvedValueOnce(byId("i189757185"));
    mockedGetActivity.mockResolvedValueOnce(
      fakeActivity({
        name: "Commute",
        type: "Ride",
        distance: 20000,
        moving_time: 2400,
      }),
    );

    const result = await compareActivitiesTool.execute(
      { activityId1: "i189757185", activityId2: "i100" },
      "test-token",
    );

    const lines = (result.content[0]?.text ?? "").split("\n");
    expect(lines).toContain("  Pace: 1:39 /100m");
    expect(lines).toContain("  Speed: 30 km/h");
    expect(lines.some((l) => l.endsWith(" /km"))).toBe(false);
  });

  it("leaves max HR out of the HR line when the activity recorded none", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      fakeActivity({ max_heartrate: null }),
    );
    mockedGetActivity.mockResolvedValueOnce(faster);

    const result = await compareActivitiesTool.execute(
      {
        activityId1: "i100",
        activityId2: "i200",
      },
      "test-token",
    );

    const lines = (result.content[0]?.text ?? "").split("\n");
    expect(lines.filter((l) => l.startsWith("  HR:"))).toEqual([
      "  HR: 150 avg",
      "  HR: 160 avg, 172 max",
    ]);
    expect(lines.join("\n")).not.toMatch(/null|undefined/);
  });

  it("maps a 404 to a not-found message", async () => {
    mockedGetActivity.mockRejectedValue(handledNotFound("getActivity"));

    const result = await compareActivitiesTool.execute(
      {
        activityId1: "i100",
        activityId2: "i200",
      },
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ One or both activities not found. Please verify the activity IDs.",
    );
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedGetActivity.mockRejectedValue(handledRateLimit("getActivity"));

    const result = await compareActivitiesTool.execute(
      {
        activityId1: "i100",
        activityId2: "i200",
      },
      "test-token",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("❌")).toBe(true);
    expect(text).toContain("rate limit");
    expect(text).toContain("15-minute rate limit reached (100/100 requests).");
  });

  it("reports other failures with details", async () => {
    mockedGetActivity.mockRejectedValue(new Error("Bad Gateway"));

    const result = await compareActivitiesTool.execute(
      {
        activityId1: "i100",
        activityId2: "i200",
      },
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ Failed to compare activities i100 and i200: Bad Gateway",
    );
  });
});
