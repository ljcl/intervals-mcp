import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type StravaStats } from "../stravaClient";
import {
  AthleteStatsOutputSchema,
  BestEffortsOutputSchema,
  buildAthleteStatsOutput,
  CompareActivitiesOutputSchema,
  RunningSummaryOutputSchema,
  TrainingLoadOutputSchema,
} from "./outputs";

describe("buildAthleteStatsOutput", () => {
  it("flattens totals to schema-valid shape", () => {
    const stats = {
      recent_run_totals: {
        count: 4,
        distance: 40000,
        moving_time: 12000,
        elevation_gain: 300,
      },
      biggest_ride_distance: 80000,
    } as unknown as StravaStats;

    const out = buildAthleteStatsOutput(stats);
    expect(out.recent_run_totals).toEqual({
      count: 4,
      distance_m: 40000,
      moving_time_s: 12000,
      elevation_gain_m: 300,
    });
    expect(out.ytd_run_totals).toBeNull();
    expect(out.biggest_ride_distance_m).toBe(80000);
    expect(AthleteStatsOutputSchema.safeParse(out).success).toBe(true);
  });
});

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
      time_formatted: "50m 0s",
      pace: { min_per_km: "5:00", min_per_mile: "8:03", raw_min_per_km: 5 },
      avg_hr: 150,
      max_hr: 172,
      cadence_spm: 176,
      elevation_gain_m: 100,
    };
    const result = {
      activity_1: side,
      activity_2: { ...side, id: "222", name: "Run B" },
      differences: {
        distance_km: 0,
        pace: { seconds_per_km: -10, interpretation: "faster" },
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
      best_efforts: {
        "5K": [
          {
            activity_id: "123",
            activity_name: "5K Race",
            date: "2026-05-01",
            elapsed_time_seconds: 1080,
            elapsed_time_formatted: "18m 0s",
            moving_time_seconds: 1075,
            moving_time_formatted: "17m 55s",
            pace: { min_per_km: "3:36", min_per_mile: "5:48" },
            pr_rank: 1,
          },
        ],
      },
      activities_analyzed: 42,
      activities_with_efforts: 30,
      activities_skipped: 0,
      warnings: [],
      note: "Times use elapsed time (includes stops), matching Strava's Best Efforts behavior",
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
