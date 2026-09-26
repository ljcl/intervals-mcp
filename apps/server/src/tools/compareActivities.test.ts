import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import { speedEfficiencyFactor } from "../aerobicAnalysis";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import { buildComparison, compareActivitiesTool } from "./compareActivities";
import { CompareActivitiesOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return { ...actual, getActivity: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);

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
    expect(mockedGetActivity).toHaveBeenCalledWith("test-token", "i100");
    expect(mockedGetActivity).toHaveBeenCalledWith("test-token", "i200");
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
