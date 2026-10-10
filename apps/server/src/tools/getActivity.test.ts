import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import activityFixture from "../__fixtures__/intervals/activity.json";
import activityIntervalsFixture from "../__fixtures__/intervals/activity-intervals.json";
import activitySwimFixture from "../__fixtures__/intervals/activity-swim.json";
import activitySwimIntervalsFixture from "../__fixtures__/intervals/activity-swim-intervals.json";
import sportSettingsRunFixture from "../__fixtures__/intervals/sport-settings-run.json";
import {
  getActivity,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsGear,
  type IntervalsSportSettings,
  listGear,
} from "../intervalsClient";
import {
  formatActivityDetailText,
  getActivityTool,
  mapActivityDetail,
  resolveActivityGearName,
} from "./getActivity";
import { ActivityDetailOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return {
    ...actual,
    getActivity: vi.fn(),
    getSportSettings: vi.fn(),
    listGear: vi.fn(),
  };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetSportSettings = vi.mocked(getSportSettings);
const mockedListGear = vi.mocked(listGear);

const runActivity = activityFixture as unknown as IntervalsActivity;
const sportSettingsRun =
  sportSettingsRunFixture as unknown as IntervalsSportSettings;

/** The run fixture with its intervals merged in, as `getActivity(..., {intervals: true})` returns it. */
const runActivityWithIntervals: IntervalsActivity = {
  ...runActivity,
  icu_intervals: activityIntervalsFixture.icu_intervals,
};

/** A pool swim (30 x 50 m) with its first four intervals merged in. */
const swimActivity = {
  ...activitySwimFixture,
  icu_intervals: activitySwimIntervalsFixture.icu_intervals,
} as unknown as IntervalsActivity;

const strengthActivity = (
  activitiesFixture as unknown as IntervalsActivity[]
).find((a) => a.id === "i189757177");
if (!strengthActivity) throw new Error("fixture missing i189757177");

/** Synthetic gear list: the run fixture's gear id, owned by its athlete "i0". */
const GEAR: IntervalsGear[] = [
  {
    id: "71459",
    name: "Trainer A",
    type: "Shoes",
    distance: 115197.44,
    activities: 7,
    retired: null,
    reminders: [],
    athlete_id: "i0",
  },
];

/** Synthetic LTHR_UP from a 1 h effort, in intervals.icu's shape (docs/api-notes.md). */
const LTHR_UP_1H = {
  id: "lthr",
  type: "LTHR_UP",
  message: "1h at 172 bpm",
  watts: null,
  secs: null,
  value: 172,
  distance: null,
  pace: null,
  point: { start_index: 3038, end_index: 6638, secs: 3600, value: 172 },
};

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
    // A run has pace_min_per_km, so neither sportSpeed field.
    expect(detail.pace_min_per_100m).toBeNull();
    expect(detail.speed_kmh).toBeNull();
    // gap (3.4783862) is m/s, same unit as average_speed; see
    // utils/running.ts's gapPace() comment for the fixture evidence this
    // rests on.
    expect(detail.gap_min_per_km).toBe("4:47");
    expect(detail.average_hr).toBe(171);
    expect(detail.max_hr).toBe(185);
    // cadence doubling: 83.15543 strides/min -> ~166 spm.
    expect(detail.average_cadence_spm).toBe(166);
    expect(detail.elevation_gain_m).toBe(85);
    expect(detail.pool_length_m).toBeNull();
    expect(detail.lengths).toBeNull();
    expect(detail.achievements).toEqual([]);
    expect(detail.hr_recovery).toBeNull();
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
    // The fixture's gear entry carries name: null (intervals.icu does not
    // populate it on the activity today; see docs/api-notes.md).
    expect(detail.gear_name).toBeNull();
    // The file's own average temperature; get-activity reads no file, so
    // there is no humidity or dew point.
    expect(detail.weather).toEqual({
      temperature_c: 22,
      temperature_source: "file",
      feels_like_c: null,
      humidity_pct: null,
      dew_point_c: null,
    });
    expect(detail.description).toBeNull();
    expect(detail.units).toEqual({
      distance: "km",
      pace: "min/km",
      swim_pace: "min/100m",
      speed: "km/h",
      time: "s",
      hr: "bpm",
      elevation: "m",
      cadence: "spm",
      temp: "C",
    });
  });

  it("builds HR zones from the activity's own icu_hr_zones and zone times", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );

    expect(detail.hr_zones).toEqual([
      { zone: 1, min_bpm: 0, max_bpm: 142, seconds: 103 },
      { zone: 2, min_bpm: 142, max_bpm: 154, seconds: 146 },
      { zone: 3, min_bpm: 154, max_bpm: 163, seconds: 330 },
      { zone: 4, min_bpm: 163, max_bpm: 171, seconds: 1684 },
      { zone: 5, min_bpm: 171, max_bpm: 190, seconds: 111 },
    ]);
    expect(detail.pace_zone_seconds).toBeNull();
  });

  it("still builds hr_zones from the activity's own zones when sport settings are unavailable", () => {
    // The fixture's own icu_hr_zones now beats sport settings, so a null
    // sportSettings no longer blanks hr_zones (#task-6).
    const detail = mapActivityDetail(runActivityWithIntervals, null);
    expect(detail.hr_zones).toHaveLength(5);
  });

  it("falls back to sport settings bounds when the activity has no icu_hr_zones of its own", () => {
    const noOwnBounds: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: null,
    };
    const detail = mapActivityDetail(noOwnBounds, sportSettingsRun);
    expect(detail.hr_zones).toEqual([
      { zone: 1, min_bpm: 0, max_bpm: 142, seconds: 103 },
      { zone: 2, min_bpm: 142, max_bpm: 154, seconds: 146 },
      { zone: 3, min_bpm: 154, max_bpm: 163, seconds: 330 },
      { zone: 4, min_bpm: 163, max_bpm: 171, seconds: 1684 },
      { zone: 5, min_bpm: 171, max_bpm: 190, seconds: 111 },
    ]);
  });

  it("returns empty hr_zones when neither the activity nor sport settings have bounds", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, icu_hr_zones: null },
      null,
    );
    expect(detail.hr_zones).toEqual([]);
  });

  it("returns empty hr_zones when icu_hr_zone_times is missing, even with sport settings available", () => {
    const noZoneTimes: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: null,
      icu_hr_zone_times: null,
    };
    const detail = mapActivityDetail(noZoneTimes, sportSettingsRun);
    expect(detail.hr_zones).toEqual([]);
  });

  it("does not fall back to sport settings when the activity's own bounds/times counts mismatch", () => {
    const mismatched: IntervalsActivity = {
      ...runActivityWithIntervals,
      icu_hr_zones: [142, 154, 163],
    };
    const detail = mapActivityDetail(mismatched, sportSettingsRun);
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
        moving_time_source: "lap",
        pace_min_per_km: "4:56",
        pace_min_per_100m: null,
        speed_kmh: null,
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
        moving_time_source: "lap",
        pace_min_per_km: "4:54",
        pace_min_per_100m: null,
        speed_kmh: null,
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

  it("doubles cadence and includes dynamics for a Walk, but reports no pace", () => {
    // A Walk is a step-cadence type (cadence doubled, dynamics included) but
    // not a pace type (intervals.icu reports no pace for it).
    const walkActivity: IntervalsActivity = {
      ...runActivityWithIntervals,
      type: "Walk",
    };

    const detail = mapActivityDetail(walkActivity, sportSettingsRun);

    expect(detail.type).toBe("Walk");
    expect(detail.pace_min_per_km).toBeNull();
    expect(detail.gap_min_per_km).toBeNull();
    // A walk gets km/h instead (sportSpeed): 8,030 m in 2,372 s.
    expect(detail.speed_kmh).toBe(12.2);
    expect(detail.pace_min_per_100m).toBeNull();
    // Interval dynamics stay for a step-cadence type.
    expect(detail.intervals?.[0]?.stance_time_ms).toBe(234);
    // 7,010.97 m in 2,075 s.
    expect(detail.intervals?.[0]?.speed_kmh).toBe(12.2);
    // Same raw cadence (83.15543 strides/min) as the run fixture, doubled the
    // same way: ~166 spm.
    expect(detail.average_cadence_spm).toBe(166);
    expect(detail.running_dynamics).not.toBeNull();
    expect(detail.running_dynamics?.stance_time_ms).toBe(233);
    // The activity's own icu_hr_zones (present on this fixture regardless
    // of type) are the correct settings group for any activity type, so a
    // Walk still gets hr_zones; the fetched sport settings are the Run
    // group and are never even consulted here.
    expect(detail.hr_zones).toHaveLength(5);
  });

  it("takes gear_name from its third argument", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
      "Trainer A",
    );

    expect(detail.gear_id).toBe("71459");
    expect(detail.gear_name).toBe("Trainer A");
  });

  it("defaults gear_name to the name the payload sends", () => {
    const withGearName: IntervalsActivity = {
      ...runActivityWithIntervals,
      gear: { id: "71459", name: "Trainer B" },
    };
    const detail = mapActivityDetail(withGearName, sportSettingsRun);

    expect(detail.gear_name).toBe("Trainer B");
  });

  it("maps a pool swim's lengths and HR recovery", () => {
    const detail = mapActivityDetail(swimActivity, null);

    expect(detail.type).toBe("Swim");
    expect(detail.pace_min_per_km).toBeNull();
    // 1,500 m in 1,489 s.
    expect(detail.pace_min_per_100m).toBe("1:39");
    expect(detail.speed_kmh).toBeNull();
    expect(detail.lengths).toBe(30);
    expect(detail.pool_length_m).toBe(50);
    expect(detail.average_cadence_spm).toBeNull();
    expect(detail.running_dynamics).toBeNull();
    expect(detail.achievements).toEqual([]);
    // intervals.icu's own icu_hrr: a 60 s window, start_time 1458 s.
    expect(detail.hr_recovery).toEqual({
      drop_bpm: 13,
      start_bpm: 153,
      end_bpm: 140,
      window_s: 60,
      start_time_s: 1458,
    });
  });

  it("gives swim intervals a pace per 100 m and no step-based dynamics", () => {
    const detail = mapActivityDetail(swimActivity, null);

    expect(detail.intervals).toHaveLength(4);
    const [work, recovery, work2] = detail.intervals ?? [];
    // 503.33 m in 520 s. intervals.icu sends average_step_length 1342.4 mm
    // on this interval, but on a swim it is not a step (docs/api-notes.md).
    expect(work).toMatchObject({
      type: "WORK",
      pace_min_per_km: null,
      pace_min_per_100m: "1:43",
      speed_kmh: null,
      average_cadence_spm: null,
      stance_time_ms: null,
      vertical_oscillation_mm: null,
      step_length_mm: null,
    });
    // A RECOVERY interval has no distance, so no pace either.
    expect(recovery).toMatchObject({
      type: "RECOVERY",
      pace_min_per_100m: null,
      speed_kmh: null,
    });
    expect(work2?.pace_min_per_100m).toBe("1:44");
    // intervals.icu sends a step length on the WORK intervals; no interval
    // reports one, or any other step-based field.
    expect(
      swimActivity.icu_intervals?.filter((iv) => iv.average_step_length != null)
        .length,
    ).toBeGreaterThan(0);
    for (const iv of detail.intervals ?? [])
      expect([
        iv.stance_time_ms,
        iv.vertical_oscillation_mm,
        iv.step_length_mm,
      ]).toEqual([null, null, null]);
  });

  it("gives a ride km/h for the activity and its intervals", () => {
    const ride = {
      ...strengthActivity,
      type: "Ride",
      distance: 20000,
      moving_time: 2400,
      icu_intervals: [{ type: "WORK", distance: 10000, moving_time: 1200 }],
    } as IntervalsActivity;

    const detail = mapActivityDetail(ride, null);

    expect(detail.speed_kmh).toBe(30);
    expect(detail.pace_min_per_100m).toBeNull();
    expect(detail.intervals?.[0]?.speed_kmh).toBe(30);
  });

  it("drops an HR recovery with a missing bpm, and computes a missing drop", () => {
    const noEnd = mapActivityDetail(
      { ...swimActivity, icu_hrr: { start_bpm: 153, end_bpm: null } },
      null,
    );
    expect(noEnd.hr_recovery).toBeNull();

    const noDrop = mapActivityDetail(
      { ...swimActivity, icu_hrr: { start_bpm: 153, end_bpm: 140 } },
      null,
    );
    expect(noDrop.hr_recovery).toEqual({
      drop_bpm: 13,
      start_bpm: 153,
      end_bpm: 140,
      window_s: null,
      start_time_s: null,
    });
  });

  it("maps intervals.icu's achievements", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, icu_achievements: [LTHR_UP_1H] },
      sportSettingsRun,
    );

    expect(detail.achievements).toEqual([
      {
        type: "LTHR_UP",
        message: "1h at 172 bpm",
        value: 172,
        duration_s: 3600,
        distance_m: null,
        watts: null,
        pace_mps: null,
      },
    ]);
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
    // The activity's own icu_hr_zones (a 7-zone WeightTraining settings
    // group, distinct from the Run group's 5) is used even with no sport
    // settings passed in at all.
    expect(detail.hr_zones).toEqual([
      { zone: 1, min_bpm: 0, max_bpm: 146, seconds: 3351 },
      { zone: 2, min_bpm: 146, max_bpm: 154, seconds: 0 },
      { zone: 3, min_bpm: 154, max_bpm: 163, seconds: 0 },
      { zone: 4, min_bpm: 163, max_bpm: 171, seconds: 0 },
      { zone: 5, min_bpm: 171, max_bpm: 176, seconds: 0 },
      { zone: 6, min_bpm: 176, max_bpm: 181, seconds: 0 },
      { zone: 7, min_bpm: 181, max_bpm: 190, seconds: 0 },
    ]);
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
    expect(text).toContain("Z1 up to 142");
    expect(lines[1]).toContain("moving (intervals.icu)");
    expect(text).toContain(
      "Intervals (lap moving times are intervals.icu's own per lap and can differ from the activity's):",
    );
    expect(text).toContain("1. WORK:");
    expect(text).toContain("2. RECOVERY:");
    expect(text).not.toContain("more: get-activity-laps");
    expect(text).not.toContain("swim paces");
  });

  it("prints a pool swim's pace, lengths and HR recovery", () => {
    const text = formatActivityDetailText(
      mapActivityDetail(swimActivity, null),
    );
    const lines = text.split("\n");

    expect(lines[1]).toBe(
      "1.50 km, 24:49 moving (intervals.icu), 1:39 /100m, 30 lengths of 50 m, HR 149/165",
    );
    // The interval paces count the rests at the wall; the activity's does
    // not, so the header says so.
    expect(lines).toContain(
      "Intervals (lap moving times are intervals.icu's own per lap and can differ from the activity's; swim paces include the rests inside each interval):",
    );
    expect(text).toContain("1. WORK: 0.50 km, 8:40, 1:43 /100m, HR 136");
    expect(text).toContain("2. RECOVERY: 1:48, HR 131");
    // After the load line, before the zones.
    expect(lines[2]).toMatch(/^Load: /);
    expect(lines[3]).toBe(
      "HR recovery: 153 to 140 bpm in 60 s (drop 13 bpm), from 24:18",
    );
  });

  it("prints a ride's km/h on the metrics and interval lines", () => {
    const ride = {
      ...strengthActivity,
      type: "Ride",
      distance: 20000,
      moving_time: 2400,
      icu_intervals: [{ type: "WORK", distance: 10000, moving_time: 1200 }],
    } as IntervalsActivity;
    const lines = formatActivityDetailText(mapActivityDetail(ride, null)).split(
      "\n",
    );

    expect(lines[1]).toMatch(
      /^20\.00 km, 40:00 moving \(intervals\.icu\), 30 km\/h, HR /,
    );
    expect(lines).toContain("1. WORK: 10.00 km, 20:00, 30 km/h");
  });

  it("prints the achievements on the line after the metrics", () => {
    const text = formatActivityDetailText(
      mapActivityDetail(
        { ...runActivityWithIntervals, icu_achievements: [LTHR_UP_1H] },
        sportSettingsRun,
      ),
    );

    expect(text.split("\n")[2]).toBe(
      "Achievements: Run LTHR up: 172 bpm estimated (1h at 172 bpm)",
    );
  });

  it("prints no achievements or HR recovery line when there are none", () => {
    const text = formatActivityDetailText(
      mapActivityDetail(runActivityWithIntervals, sportSettingsRun),
    );

    expect(text).not.toContain("Achievements:");
    expect(text).not.toContain("HR recovery:");
  });

  it("prints feel with intervals.icu's scale, so 1 does not read as the worst", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, feel: 1 },
      sportSettingsRun,
    );
    const loadLine = formatActivityDetailText(detail)
      .split("\n")
      .find((l) => l.startsWith("Load:"));

    // On intervals.icu 1 is "Strong" and 5 the weakest (docs/api-notes.md).
    expect(loadLine).toMatch(/, feel 1 \(1 strongest to 5 weakest\)$/);
    // structuredContent keeps the bare number.
    expect(detail.feel).toBe(1);
  });

  it("prints step length but not stride, which is the same per-step distance", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const dynamicsLine = formatActivityDetailText(detail)
      .split("\n")
      .find((l) => l.startsWith("Dynamics:"));

    expect(dynamicsLine).toBe(
      "Dynamics: GCT 233 ms, VO 108 mm, VR 8.8%, step 1226 mm",
    );
    // structuredContent keeps stride_m; only the text leaves it out.
    expect(detail.running_dynamics?.stride_m).toBe(1.22);
  });

  it("stays well under the size bound for the fixture activity", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text.length).toBeLessThan(6000);
  });

  it("caps interval lines at 20 and points at get-activity-laps for the rest", () => {
    const manyIntervals = Array.from({ length: 23 }, (_, i) => ({
      type: i % 2 === 0 ? "WORK" : "RECOVERY",
      label: null,
      distance_km: 1,
      moving_time_s: 300,
      moving_time_source: "lap" as const,
      pace_min_per_km: "5:00",
      pace_min_per_100m: null,
      speed_kmh: null,
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
    expect(text).toContain("(3 more: get-activity-laps lists all 23)");
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

  it("shows the gear id alone when no name is resolvable", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text).toContain("Gear: 71459");
  });

  it("shows the gear name and id when a name is resolvable from the payload", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, gear: { id: "71459", name: "My Shoes" } },
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text).toContain("Gear: My Shoes [71459]");
  });

  it("omits the gear line when the activity has no gear", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, gear: null },
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text).not.toContain("Gear:");
  });

  it("shows the full description when under 200 characters", () => {
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, description: "Felt strong today." },
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text).toContain("Description: Felt strong today.");
  });

  it("truncates a description over 200 characters with an ellipsis marker", () => {
    const longDescription = "x".repeat(250);
    const detail = mapActivityDetail(
      { ...runActivityWithIntervals, description: longDescription },
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    const line = text.split("\n").find((l) => l.startsWith("Description:"));

    expect(line).toBe(`Description: ${"x".repeat(200)}...`);
    // structuredContent keeps the full, untruncated text.
    expect(detail.description).toBe(longDescription);
  });

  it("omits the description line when the activity has none", () => {
    const detail = mapActivityDetail(
      runActivityWithIntervals,
      sportSettingsRun,
    );
    const text = formatActivityDetailText(detail);
    expect(text).not.toContain("Description:");
  });
});

describe("resolveActivityGearName", () => {
  beforeEach(() => {
    mockedListGear.mockReset();
    mockedListGear.mockResolvedValue(GEAR);
  });

  it("reads the name from the cached gear list", async () => {
    await expect(resolveActivityGearName("key", runActivity)).resolves.toBe(
      "Trainer A",
    );
    // One read with no options: the cached read, not update-activity's
    // skipCache one.
    expect(mockedListGear).toHaveBeenCalledTimes(1);
    expect(mockedListGear).toHaveBeenCalledWith("key");
  });

  it("reads nothing for an activity with no gear", async () => {
    await expect(
      resolveActivityGearName("key", strengthActivity),
    ).resolves.toBeNull();
    expect(mockedListGear).not.toHaveBeenCalled();
  });

  it("uses the name the payload sends without a read", async () => {
    await expect(
      resolveActivityGearName("key", {
        ...runActivity,
        gear: { id: "71459", name: "Trainer B" },
      }),
    ).resolves.toBe("Trainer B");
    expect(mockedListGear).not.toHaveBeenCalled();
  });

  it("is null when the id is not in the list, after one read past the cache", async () => {
    await expect(
      resolveActivityGearName("key", {
        ...runActivity,
        gear: { id: "99999", name: null },
      }),
    ).resolves.toBeNull();
    expect(mockedListGear).toHaveBeenCalledTimes(2);
  });

  it("reads past the cache once when the id is not in the cached list (gear added in the last 10 minutes)", async () => {
    const NEW_GEAR: IntervalsGear = {
      ...GEAR[0]!,
      id: "g2",
      name: "Trainer B",
    };
    mockedListGear
      .mockResolvedValueOnce(GEAR)
      .mockResolvedValueOnce([...GEAR, NEW_GEAR]);

    await expect(
      resolveActivityGearName("key", {
        ...runActivity,
        gear: { id: "g2", name: null },
      }),
    ).resolves.toBe("Trainer B");
    expect(mockedListGear).toHaveBeenNthCalledWith(1, "key");
    expect(mockedListGear).toHaveBeenNthCalledWith(2, "key", {
      skipCache: true,
    });
  });

  it("is null when the gear belongs to another athlete", async () => {
    mockedListGear.mockResolvedValue([{ ...GEAR[0]!, athlete_id: "i9" }]);
    await expect(
      resolveActivityGearName("key", runActivity),
    ).resolves.toBeNull();
    // Found, so no second read.
    expect(mockedListGear).toHaveBeenCalledTimes(1);
  });

  it("is null when the gear has no name", async () => {
    mockedListGear.mockResolvedValue([{ ...GEAR[0]!, name: null }]);
    await expect(
      resolveActivityGearName("key", runActivity),
    ).resolves.toBeNull();
  });

  it("is null, not an error, when the gear read fails", async () => {
    mockedListGear.mockRejectedValue(handledRateLimit("listGear"));
    await expect(
      resolveActivityGearName("key", runActivity),
    ).resolves.toBeNull();
  });
});

describe("getActivityTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedGetSportSettings.mockReset();
    mockedListGear.mockReset();
    mockedListGear.mockResolvedValue(GEAR);
  });

  it("names the gear from the gear list", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "test-key",
    );

    expect(mockedListGear).toHaveBeenCalledTimes(1);
    expect(mockedListGear).toHaveBeenCalledWith("test-key");
    expect(result.structuredContent?.gear_name).toBe("Trainer A");
    expect(result.content[0]?.text).toContain("Gear: Trainer A [71459]");
  });

  it("keeps the gear id alone when the gear read fails", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);
    mockedListGear.mockRejectedValueOnce(handledRateLimit("listGear"));

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.gear_name).toBeNull();
    expect(result.content[0]?.text).toContain("Gear: 71459");
  });

  it("returns a pool swim that matches the output schema", async () => {
    mockedGetActivity.mockResolvedValueOnce(swimActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189757185", includeIntervals: true },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedListGear).not.toHaveBeenCalled();
    expect(
      ActivityDetailOutputSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
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

  it("still builds hr_zones from the activity's own zones when sport settings fail", async () => {
    mockedGetActivity.mockResolvedValueOnce(runActivity);
    mockedGetSportSettings.mockRejectedValueOnce(
      handledNotFound("getSportSettings"),
    );

    const result = await getActivityTool.execute(
      { id: "i189807578", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hr_zones).toHaveLength(5);
  });

  it("degrades to empty hr_zones when neither the activity nor sport settings have bounds", async () => {
    mockedGetActivity.mockResolvedValueOnce({
      ...runActivity,
      icu_hr_zones: null,
    });
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

  it("uses a non-run activity's own zones rather than the fetched Run sport settings", async () => {
    mockedGetActivity.mockResolvedValueOnce(strengthActivity);
    mockedGetSportSettings.mockResolvedValueOnce(sportSettingsRun);

    const result = await getActivityTool.execute(
      { id: "i189757177", includeIntervals: true },
      "key",
    );

    expect(result.isError).toBeUndefined();
    // 7 zones, not the Run group's 5 - proves it came from the activity's
    // own icu_hr_zones, not the fetched sport settings.
    expect(result.structuredContent?.hr_zones).toHaveLength(7);
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
