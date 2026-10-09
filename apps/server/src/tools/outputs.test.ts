import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AthleteStatsOutputSchema,
  AthleteZonesOutputSchema,
  BestEffortsOutputSchema,
  CompareActivitiesOutputSchema,
  RunningSummaryOutputSchema,
  TrainingLoadOutputSchema,
} from "./outputs";

describe("schemas align with the real tool rawObjects", () => {
  it("AthleteStatsOutputSchema matches the athlete-stats object", () => {
    const runs = {
      runs: 2,
      distance_km: 14.07,
      moving_time_s: 4277,
      moving_time: "1:11:17",
      elevation_gain_m: 156,
      load: 93,
      average_pace_min_per_km: "5:04",
    };
    const empty = {
      total: { count: 0, moving_time_s: 0, load: 0 },
      by_type: {},
    };
    const response = {
      this_week: runs,
      last_4_weeks: runs,
      this_month: runs,
      ytd: runs,
      all_sports: {
        this_week: {
          total: { count: 3, moving_time_s: 7627, load: 111 },
          by_type: {
            Run: {
              count: 2,
              moving_time_s: 4277,
              distance_km: 14.07,
              load: 93,
            },
            WeightTraining: {
              count: 1,
              moving_time_s: 3350,
              distance_km: null,
              load: 18,
            },
          },
        },
        last_4_weeks: empty,
        this_month: empty,
        ytd: empty,
      },
      units: { distance: "km", pace: "min/km", time: "s", elevation: "m" },
    };
    expect(AthleteStatsOutputSchema.safeParse(response).success).toBe(true);

    const badDistance = structuredClone(response);
    badDistance.all_sports.this_week.by_type.WeightTraining = {
      ...response.all_sports.this_week.by_type.WeightTraining,
      distance_km: "n/a" as unknown as null,
    };
    expect(AthleteStatsOutputSchema.safeParse(badDistance).success).toBe(false);
  });

  it("TrainingLoadOutputSchema matches the training-load result object", () => {
    const result = {
      period: { days: 28, start_date: "2026-05-09", end_date: "2026-06-06" },
      run_only: false,
      source: "intervals.icu",
      current: { date: "2026-06-06", ctl: 42.1, atl: 38.4, tsb: 3.7 },
      activity_types_included: ["Run", "WeightTraining"],
      totals: {
        runs: 8,
        distance_km: 64.2,
        time_s: 21960,
        time_hours: 6.1,
        elevation_m: 420,
        load: 540,
      },
      averages: {
        runs_per_week: 2,
        distance_km_per_week: 16.05,
        time_hours_per_week: 1.53,
      },
      trend: "stable",
      weekly_breakdown: [
        {
          week_starting: "2026-05-11",
          runs: 3,
          distance_km: 24.1,
          time_s: 7920,
          time_hours: 2.2,
          time_formatted: "2h 12m",
          elevation_m: 150,
          load: 210,
          load_by_type: { Run: 180, WeightTraining: 30 },
          activities: [
            {
              id: "123",
              name: "Morning Run",
              date: "2026-05-11",
              distance_km: 8.03,
            },
          ],
        },
      ],
      warnings: [
        "Week of 2026-05-11: Volume spike: 54 km is 1.8 times the 30 km average of the previous 4 weeks",
      ],
      units: {
        load: "intervals.icu training load",
        distance: "km",
        time: "s",
        time_hours: "h",
        elevation: "m",
      },
    };
    expect(TrainingLoadOutputSchema.safeParse(result).success).toBe(true);
  });

  it("RunningSummaryOutputSchema matches the running-summary object", () => {
    const summary = {
      id: "i123456",
      name: "Tempo Run",
      type: "Run",
      date: "2026-05-11",
      start_local: "2026-05-11T06:00:00",
      source: "OAUTH_CLIENT",
      is_strava_stub: false,
      device: "Watch7,5",
      distance_km: 10,
      moving_time_s: 3000,
      moving_time: "50:00",
      elapsed_time_s: 3100,
      pace_min_per_km: "5:00",
      gap_min_per_km: "4:55",
      gap_source: "intervals.icu",
      average_hr: 150,
      max_hr: 172,
      average_cadence_spm: 176,
      elevation_gain_m: 120,
      load: {
        training_load: 60,
        hr_load: 60,
        pace_load: null,
        trimp: 100,
        intensity: 90,
      },
      decoupling_pct: 2.1,
      efficiency_factor: 1.5,
      rpe: 5,
      feel: 4,
      hr_zones: [{ zone: 1, min_bpm: 0, max_bpm: 142, seconds: 60 }],
      pace_zone_seconds: null,
      running_dynamics: {
        stance_time_ms: 233,
        vertical_oscillation_mm: 90,
        vertical_ratio_pct: 7.2,
        step_length_mm: 1200,
        stride_m: 1.2,
      },
      intervals: null,
      gear_id: "g1",
      gear_name: "Pegasus",
      weather_temp_c: 15,
      description: "Tempo run",
      units: {
        distance: "km",
        pace: "min/km",
        time: "s",
        hr: "bpm",
        elevation: "m",
        cadence: "spm",
        temp: "C",
      },
      cadence_assessment: "good",
      hr_zone_summary: {
        source: "activity",
        total_seconds: 60,
        zones: [
          { zone: 1, min_bpm: 0, max_bpm: 142, seconds: 60, percent: 100 },
        ],
      },
      hr_zone_note: null,
      dynamics_assessment: {
        vertical_oscillation: "good - under the 100 mm target",
        ground_contact_time: "good - within the 200-260 ms target range",
      },
      laps: [
        {
          lap_index: 1,
          type: "WORK",
          label: null,
          distance_km: 1,
          moving_time_s: 300,
          moving_time: "5:00",
          elapsed_time_s: 300,
          pace_min_per_km: "5:00",
          gap_min_per_km: "4:55",
          gap_source: "intervals.icu",
          speed_kmh: null,
          average_hr: 150,
          max_hr: 160,
          average_cadence: 176,
          average_watts: null,
          elevation_gain_m: 10,
          average_gradient_pct: 1.2,
        },
      ],
    };
    expect(RunningSummaryOutputSchema.safeParse(summary).success).toBe(true);
  });

  it("CompareActivitiesOutputSchema matches the compare-activities object", () => {
    const side = {
      id: "111",
      name: "Run A",
      date: "2026-05-01",
      type: "Run",
      distance_km: 10,
      moving_time: "50:00",
      moving_time_s: 3000,
      pace_min_per_km: "5:00",
      gap_min_per_km: "4:58",
      gap_source: "intervals.icu",
      average_hr: 150,
      max_hr: 172,
      cadence_spm: 176,
      elevation_gain_m: 100,
      load: 60,
      decoupling_pct: 3.5,
      efficiency_factor: 1.3,
      running_dynamics: {
        stance_time_ms: 230,
        vertical_oscillation_mm: 100,
        vertical_ratio_pct: 8.5,
        step_length_mm: 1200,
        stride_m: 1.2,
      },
    };
    const result = {
      units: {
        distance: "km",
        pace: "min/km",
        time: "s",
        hr: "bpm",
        elevation: "m",
        cadence: "spm",
      },
      activity_1: side,
      activity_2: { ...side, id: "222", name: "Run B" },
      differences: {
        distance_km: 0,
        pace_delta_sec_per_km: -10,
        pace_delta_min_per_km: "-0:10",
        pace_delta_interpretation: "faster",
        avg_hr: -2,
        cadence_spm: 1,
        elevation_gain_m: 5,
      },
      efficiency: {
        activity_1: 1.333,
        activity_2: 1.358,
        change_percent: 1.9,
        interpretation: "unchanged",
        note: "Efficiency factor in metres per minute per heartbeat. Higher is better.",
      },
      warnings: ["Activity 1 (Run A) is not a running activity (Ride)"],
    };
    expect(CompareActivitiesOutputSchema.safeParse(result).success).toBe(true);
  });

  it("BestEffortsOutputSchema matches the best-efforts response in both modes", () => {
    const entry = {
      rank: 1,
      time_seconds: 1080,
      time_formatted: "18:00",
      pace_min_per_km: "3:36",
      distance_m: 5000,
      date: "2026-05-01",
      activity_id: "i123",
      activity_name: "5K Race",
      race: true,
      start_km: null,
      end_km: null,
      stopped_seconds: null,
    };
    const windowResponse = {
      mode: "window",
      window: { id: "1y", oldest: "2025-09-25", newest: "2026-09-25" },
      activity: null,
      top_n: 1,
      units: { time: "s", pace: "min/km" },
      note: "Each time is the elapsed time across the fastest stretch.",
      best_efforts: { "5km": [entry] },
      missing: [],
      warnings: [],
    };
    expect(BestEffortsOutputSchema.safeParse(windowResponse).success).toBe(
      true,
    );

    const activityResponse = {
      ...windowResponse,
      mode: "activity",
      window: null,
      activity: {
        id: "i123",
        name: "5K Race",
        date: "2026-05-01",
        type: "Run",
        covered_km: 5.12,
      },
      best_efforts: {
        "5km": [{ ...entry, start_km: 0.06, end_km: 5.06, stopped_seconds: 0 }],
        "10km": [],
      },
      missing: ["10km"],
    };
    expect(BestEffortsOutputSchema.safeParse(activityResponse).success).toBe(
      true,
    );

    // Every entry carries start_km: null over a window, never absent.
    expect(
      BestEffortsOutputSchema.safeParse({
        ...windowResponse,
        best_efforts: { "5km": [{ ...entry, start_km: undefined }] },
      }).success,
    ).toBe(false);
  });
});

describe("output schemas convert to JSON schema", () => {
  const schemas = {
    AthleteStatsOutputSchema,
    TrainingLoadOutputSchema,
    RunningSummaryOutputSchema,
    CompareActivitiesOutputSchema,
    BestEffortsOutputSchema,
    AthleteZonesOutputSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`converts ${name}`, () => {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    });
  }

  it("inlines AthleteZonesOutputSchema's reused parts (no $ref)", () => {
    // ThresholdCheckSchema and HrBestSchema appear more than once.
    const json = JSON.stringify(z.toJSONSchema(AthleteZonesOutputSchema));
    expect(json).not.toContain("$ref");
    expect(json).not.toContain("$defs");
  });
});
