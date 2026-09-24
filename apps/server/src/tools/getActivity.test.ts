import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityIntervalsFixture from "../__fixtures__/intervals/activity-intervals.json";
import sportSettingsRunFixture from "../__fixtures__/intervals/sport-settings-run.json";
import {
  getActivity,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "../intervalsClient";
import {
  formatActivityDetailText,
  getActivityTool,
  mapActivityDetail,
} from "./getActivity";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn(), getSportSettings: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetSportSettings = vi.mocked(getSportSettings);

const runActivity = activityFixture as unknown as IntervalsActivity;
const sportSettingsRun =
  sportSettingsRunFixture as unknown as IntervalsSportSettings;

/** The run fixture with its intervals merged in, as `getActivity(..., {intervals: true})` returns it. */
const runActivityWithIntervals: IntervalsActivity = {
  ...runActivity,
  icu_intervals: activityIntervalsFixture.icu_intervals,
};

const strengthActivity = (
  activitiesFixture as unknown as IntervalsActivity[]
).find((a) => a.id === "i189757177");
if (!strengthActivity) throw new Error("fixture missing i189757177");

describe("mapActivityDetail", () => {
  it("maps a run with intervals and sport settings", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    expect(detail.id).toBe("i189807578");
    expect(detail.name).toBe("Run 1");
    expect(detail.type).toBe("Run");
    expect(detail.date).toBe("2026-09-24");
    expect(detail.start_local).toBe("2026-09-24T16:25:25");
    expect(detail.source).toBe("OAUTH_CLIENT");
    expect(detail.is_strava_stub).toBe(false);
    expect(detail.device).toBe("Watch7,5");
    expect(detail.distance_km).toBe(8.03);
    expect(detail.moving_time_s).toBe(2372);
    expect(detail.moving_time).toBe("39:32");
    expect(detail.elapsed_time_s).toBe(2373);
    expect(detail.pace_min_per_km).toBe("4:55");
    // gap (3.4783862) is m/s, same unit as average_speed; see getActivity.ts's
    // gapPace() comment for the fixture evidence this rests on.
    expect(detail.gap_min_per_km).toBe("4:47");
    expect(detail.average_hr).toBe(171);
    expect(detail.max_hr).toBe(185);
    // cadence doubling: 83.15543 strides/min -> ~166 spm.
    expect(detail.average_cadence_spm).toBe(166);
    expect(detail.elevation_gain_m).toBe(85);
    expect(detail.load).toEqual({
      training_load: 56,
      hr_load: 56,
      pace_load: null,
      trimp: 97.5,
      intensity: 92.2,
    });
    expect(detail.decoupling_pct).toBeNull();
    expect(detail.efficiency_factor).toBeNull();
    expect(detail.rpe).toBe(7);
    expect(detail.feel).toBeNull();
    expect(detail.gear_id).toBe("71459");
    expect(detail.weather_temp_c).toBeNull();
    expect(detail.description).toBeNull();
    expect(detail.units).toEqual({
      distance: "km",
      pace: "min/km",
      time: "s",
      hr: "bpm",
      elevation: "m",
      cadence: "spm",
      temp: "C",
    });
  });

  it("builds HR zones from sport settings bounds and activity zone times", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    expect(detail.hr_zones).toEqual([
      { zone: 1, min_bpm: 0, max_bpm: 147, seconds: 103 },
      { zone: 2, min_bpm: 147, max_bpm: 160, seconds: 146 },
      { zone: 3, min_bpm: 160, max_bpm: 169, seconds: 330 },
      { zone: 4, min_bpm: 169, max_bpm: 178, seconds: 1684 },
      { zone: 5, min_bpm: 178, max_bpm: 197, seconds: 111 },
    ]);
    expect(detail.pace_zone_seconds).toBeNull();
  });

  it("returns empty hr_zones when sport settings are unavailable", () => {
    const detail = mapActivityDetail(runActivityWithIntervals, null);
    expect(detail.hr_zones).toEqual([]);
  });

  it("returns empty hr_zones when icu_hr_zone_times is missing", () => {
    const noZoneTimes: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zone_times: null,
    };
    const detail = mapActivityDetail(noZoneTimes, sportSettingsRun);
    expect(detail.hr_zones).toEqual([]);
  });

  it("maps running dynamics (mm/ms) from the activity averages", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    expect(detail.running_dynamics).toEqual({
      stance_time_ms: 233,
      vertical_oscillation_mm: 108,
      vertical_ratio_pct: 8.8,
      step_length_mm: 1226,
      stride_m: 1.22,
    });
  });

  it("maps the WORK/RECOVERY interval breakdown", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    expect(detail.intervals).toEqual([
      {
        type: "WORK",
        label: null,
        distance_km: 7.01,
        moving_time_s: 2075,
        pace_min_per_km: "4:56",
        average_hr: 169,
        average_cadence_spm: 166,
        stance_time_ms: 234,
        vertical_oscillation_mm: 108,
        step_length_mm: 1224,
      },
      {
        type: "RECOVERY",
        label: null,
        distance_km: 1.02,
        moving_time_s: 299,
        pace_min_per_km: "4:54",
        average_hr: 179,
        average_cadence_spm: 167,
        stance_time_ms: 230,
        vertical_oscillation_mm: 108,
        step_length_mm: 1242,
      },
    ]);
  });

  it("returns null intervals when the activity has none", () => {
    const detail = mapActivityDetail(runActivity, sportSettingsRun);
    expect(detail.intervals).toBeNull();
  });

  it("maps a strength activity with no pace, no cadence doubling, and null dynamics", () => {
    // execute() only ever passes sport settings for a run-type activity, so
    // the pure mapper is exercised here the same way: null settings for a
    // non-run type.
    const detail = mapActivityDetail(strengthActivity, null);

    expect(detail.type).toBe("WeightTraining");
    expect(detail.distance_km).toBeNull();
    expect(detail.moving_time_s).toBe(3350);
    expect(detail.moving_time).toBe("55:50");
    expect(detail.pace_min_per_km).toBeNull();
    expect(detail.gap_min_per_km).toBeNull();
    expect(detail.average_cadence_spm).toBeNull();
    expect(detail.average_hr).toBe(114);
    expect(detail.max_hr).toBe(149);
    expect(detail.running_dynamics).toBeNull();
    expect(detail.hr_zones).toEqual([]);
    expect(detail.intervals).toBeNull();
    expect(detail.gear_id).toBeNull();
    expect(detail.load).toEqual({
      training_load: 18,
      hr_load: 18,
      pace_load: null,
      trimp: 30,
      intensity: 44,
    });
    expect(detail.rpe).toBeNull();
  });
});

describe("formatActivityDetailText", () => {
  it("renders title, metrics, load, dynamics, zones, and interval lines", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    const lines = text.split("\n");

    expect(lines[0]).toBe("2026-09-24 Run Run 1 [i189807578]");
    expect(lines[1]).toContain("8.03 km");
    expect(lines[1]).toContain("4:55 /km");
    expect(lines[1]).toContain("GAP 4:47 /km");
    expect(text).toContain("Load:");
    expect(text).toContain("Dynamics:");
    expect(text).toContain("GCT 233 ms");
    expect(text).toContain("HR zones:");
    expect(text).toContain("Z1 0-147");
    expect(text).toContain("Intervals:");
    expect(text).toContain("1. WORK:");
    expect(text).toContain("2. RECOVERY:");
    expect(text).not.toContain("(");
  });

  it("stays well under the size bound for the fixture activity", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text.length).toBeLessThan(6000);
  });

  it("caps interval lines at 20 and adds a '(n more)' summary", () => {
    const manyIntervals = Array.from({ length: 23 }, (_, i) => ({
      type: i % 2 === 0 ? "WORK" : "RECOVERY",
      label: null,
      distance_km: 1,
      moving_time_s: 300,
      pace_min_per_km: "5:00",
      average_hr: 160,
      average_cadence_spm: 170,
      stance_time_ms: null,
      vertical_oscillation_mm: null,
      step_length_mm: null,
    }));
    const detail = {
      ...mapActivityDetail(runActivity, sportSettingsRun),
      intervals: manyIntervals,
    };

    const text = formatActivityDetailText(detail);
    expect(text).toContain("20. RECOVERY:");
    expect(text).not.toContain("21.");
    expect(text).toContain("(3 more)");
  });

  it("adds a stub note when the activity is a Strava stub", () => {
    const detail = {
      ...mapActivityDetail(runActivity, sportSettingsRun),
      is_strava_stub: true,
    };
    const text = formatActivityDetailText(detail);
    expect(text).toContain(
      "stub: details unavailable through the API; use the HealthFit copy.",
    );
  });
});

describe("getActivityTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedGetSportSettings.mockReset();
  });

  it("fetches the activity and Run sport settings, and returns structured content", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivityWithIntervals);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("key", "i189807578", {
      intervals: true,
    });
    expect(mockedGetSportSettings).toHaveBeenCalledWith("key", "Run");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.id).toBe("i189807578");
    expect(result.structuredContent?.hr_zones).toHaveLength(5);
    expect(result.structuredContent?.intervals).toHaveLength(2);
  });

  it("passes includeIntervals through to the client", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    await getActivityTool.execute(
      { id: "i189807578", includeIntervals: false },
      "key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("key", "i189807578", {
      intervals: false,
    });
  });

  it("degrades to empty hr_zones when sport settings fail, without failing the call", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetSportSettings.mockRejectedValueOnce(
      handledNotFound("getSportSettings"),
    );

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hr_zones).toEqual([]);
  });

  it("ignores sport settings for a non-run activity type", async () => {
    mockedGetActivity.mockResolvedValueOnce(strengthActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189757177", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hr_zones).toEqual([]);
    expect(result.structuredContent?.average_cadence_spm).toBeNull();
  });

  it("fails with the notFound text on a genuine 404", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID i0"),
    );
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i0", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(result.content[0]?.text).toContain("i0 was not found");
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledRateLimit("getActivity for ID i189807578"),
    );
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
  });
});
