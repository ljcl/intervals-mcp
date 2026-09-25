import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AthleteStatsOutputSchema,
  BestEffortsOutputSchema,
  CompareActivitiesOutputSchema,
  RunningSummaryOutputSchema,
  TrainingLoadOutputSchema,
} from "./outputs";

describe("schemas align with the real tool rawObjects", () => {
  it("TrainingLoadOutputSchema matches the training-load result object", () => {
    const result = {
      period: { days: 28, start_date: "2026-05-09", end_date: "2026-06-06" },
      totals: { runs: 8, distance_km: 64.2, time_hours: 6.1, elevation_m: 420 },
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
          time_hours: 2.2,
          time_formatted: "2h 12m",
          elevation_m: 150,
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
        "Week of 2026-05-11: Volume increased 35% - consider injury risk",
      ],
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
      hr_zones: [{ zone: 1, min_bpm: 0, max_bpm: 147, seconds: 60 }],
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
          { zone: 1, min_bpm: 0, max_bpm: 147, seconds: 60, percent: 100 },
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
        activity_1: 3.333,
        activity_2: 3.27,
        change_percent: -1.9,
        interpretation: "improved",
        note: "Lower efficiency number = better fitness",
      },
      warnings: ["Activity 1 (Run A) is not a running activity (Ride)"],
    };
    expect(CompareActivitiesOutputSchema.safeParse(result).success).toBe(true);
  });

  it("BestEffortsOutputSchema matches the best-efforts response object", () => {
    const response = {
      window: { id: "1y", oldest: "2025-09-25", newest: "2026-09-25" },
      top_n: 1,
      units: { time: "s", pace: "min/km" },
      note: "Best times come from the recorded time stream (a moving-time style curve), not elapsed time.",
      best_efforts: {
        "5km": [
          {
            rank: 1,
            time_seconds: 1080,
            time_formatted: "18m 0s",
            pace_min_per_km: "3:36",
            date: "2026-05-01",
            activity_id: "i123",
            activity_name: "5K Race",
            race: true,
          },
        ],
      },
      missing: [],
      warnings: [],
    };
    expect(BestEffortsOutputSchema.safeParse(response).success).toBe(true);
  });
});

describe("output schemas convert to JSON schema", () => {
  const schemas = {
    AthleteStatsOutputSchema,
    TrainingLoadOutputSchema,
    RunningSummaryOutputSchema,
    CompareActivitiesOutputSchema,
    BestEffortsOutputSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`converts ${name}`, () => {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    });
  }
});
