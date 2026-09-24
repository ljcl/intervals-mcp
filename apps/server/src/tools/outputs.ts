import { z } from "zod";

// ---------- get-athlete-stats ----------
const RunTotalsSchema = z.object({
  runs: z.number().int(),
  distance_km: z.number(),
  moving_time_s: z.number().int(),
  moving_time: z.string(),
  elevation_gain_m: z.number(),
  load: z.number(),
  average_pace_min_per_km: z.string().nullable(),
});
export const AthleteStatsOutputSchema = z.object({
  this_week: RunTotalsSchema,
  last_4_weeks: RunTotalsSchema,
  this_month: RunTotalsSchema,
  ytd: RunTotalsSchema,
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    elevation: z.literal("m"),
  }),
});
export type AthleteStatsOutput = z.infer<typeof AthleteStatsOutputSchema>;

// ---------- get-training-load ----------
const TrainingActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  distance_km: z.number(),
});
export const TrainingLoadOutputSchema = z.object({
  period: z.object({
    days: z.number().int(),
    start_date: z.string(),
    end_date: z.string(),
  }),
  totals: z.object({
    runs: z.number().int(),
    distance_km: z.number(),
    time_hours: z.number(),
    elevation_m: z.number(),
  }),
  averages: z.object({
    runs_per_week: z.number(),
    distance_km_per_week: z.number(),
    time_hours_per_week: z.number(),
  }),
  trend: z.string().describe("Human-readable trend label"),
  weekly_breakdown: z.array(
    z.object({
      week_starting: z.string(),
      runs: z.number().int(),
      distance_km: z.number(),
      time_hours: z.number(),
      time_formatted: z.string(),
      elevation_m: z.number(),
      activities: z.array(TrainingActivitySchema),
    }),
  ),
  warnings: z.array(z.string()),
});

// get-running-summary's output schema is defined near the end of this file
// (RunningSummaryOutputSchema), after ActivityDetailOutputSchema and
// IntervalsLapEntrySchema, which it extends/reuses.

// ---------- compare-activities ----------
const CompareRunningDynamicsSchema = z.object({
  stance_time_ms: z.number().nullable(),
  vertical_oscillation_mm: z.number().nullable(),
  vertical_ratio_pct: z.number().nullable(),
  step_length_mm: z.number().nullable(),
  stride_m: z.number().nullable(),
});
const CompareSideSchema = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  distance_km: z.number(),
  moving_time: z.number().describe("Moving time in seconds"),
  pace_min_per_km: z.string().nullable(),
  gap_min_per_km: z.string().nullable(),
  average_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  cadence_spm: z.number().nullable(),
  elevation_gain_m: z.number(),
  load: z.number().nullable().describe("icu_training_load"),
  decoupling_pct: z.number().nullable(),
  efficiency_factor: z.number().nullable(),
  running_dynamics: CompareRunningDynamicsSchema.nullable(),
});
export const CompareActivitiesOutputSchema = z.object({
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
    elevation: z.literal("m"),
    cadence: z.literal("spm"),
  }),
  activity_1: CompareSideSchema,
  activity_2: CompareSideSchema,
  differences: z.object({
    distance_km: z.number(),
    pace: z
      .object({
        seconds_per_km: z.number(),
        min_per_km: z.string(),
        interpretation: z.string(),
      })
      .nullable(),
    avg_hr: z.number().nullable(),
    cadence_spm: z.number().nullable(),
    elevation_gain_m: z.number(),
  }),
  efficiency: z
    .object({
      activity_1: z.number(),
      activity_2: z.number(),
      change_percent: z.number(),
      interpretation: z.string(),
      note: z.string(),
    })
    .nullable(),
  warnings: z.array(z.string()).optional(),
});

const AerobicHalfSchema = z.object({
  avg_output: z
    .number()
    .describe("m/s on the pace basis, W on the power basis"),
  avg_pace_formatted: z
    .string()
    .nullable()
    .describe("m:ss /km on the pace basis; null on the power basis"),
  avg_hr: z.number(),
  output_per_beat: z
    .number()
    .describe("m/min per beat on the pace basis, W/beat on the power basis"),
  minutes: z.number(),
});

const AerobicSourceEnum = z.enum(["intervals.icu", "computed"]);

export const AerobicAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  basis: z.enum(["pace", "power"]),
  decoupling_pct: z.number(),
  decoupling_source: AerobicSourceEnum,
  interpretation: z.string(),
  /** m/min per beat on the pace basis, W/beat on the power basis. */
  efficiency_factor: z.number(),
  efficiency_factor_source: AerobicSourceEnum,
  intensity_factor: z.number().nullable(),
  threshold_power_w: z.number().nullable(),
  breakdown: z
    .object({
      first_half: AerobicHalfSchema,
      second_half: AerobicHalfSchema,
      normalized_output: z
        .number()
        .describe(
          "m/s on the pace basis, W (normalized power) on the power basis",
        ),
      normalized_output_formatted: z.string().nullable(),
      moving_minutes: z.number(),
      excluded_stopped_minutes: z.number(),
      excluded_warmup_minutes: z.number(),
    })
    .nullable()
    .describe(
      "Null when both decoupling and efficiency factor came from intervals.icu and includeBreakdown was not set",
    ),
  units: z.object({
    pace: z.literal("m:ss /km"),
    power: z.literal("W"),
    efficiency_factor: z.string(),
  }),
  warnings: z.array(z.string()),
});

// ---------- get-fitness-trend ----------
const FitnessTrendDaySchema = z.object({
  date: z.string().describe("ISO date YYYY-MM-DD the values were computed for"),
  load: z.number().describe("Total relative effort recorded that day"),
  ctl: z.number().describe("Chronic training load ('fitness'), 42-day EWA"),
  atl: z.number().describe("Acute training load ('fatigue'), 7-day EWA"),
  tsb: z.number().describe("Training stress balance ('form'): CTL − ATL"),
});
const TaperWeekSchema = z.object({
  week: z.number().int().describe("1-based week of the plan"),
  start_date: z.string(),
  end_date: z.string(),
  days: z
    .number()
    .int()
    .describe("Days in this week (the last week can be short)"),
  daily_load: z.number().describe("Relative effort to average per day"),
  week_load: z.number().describe("Total relative effort for the week"),
  pct_of_recent: z
    .number()
    .nullable()
    .describe("Week's load as a % of the trailing 28-day average, if any"),
});
const TaperPlanSchema = z.object({
  target_date: z.string(),
  target_tsb: z.number(),
  achieved_tsb: z
    .number()
    .describe("TSB the plan lands on — equals target_tsb unless clamped"),
  feasible: z.boolean().describe("False when the target is out of reach"),
  note: z.string().nullable().describe("Why the plan was clamped, if it was"),
  weeks: z.array(TaperWeekSchema),
  days: z
    .array(FitnessTrendDaySchema)
    .describe("Day-by-day CTL/ATL/TSB under the plan"),
  total_load: z.number(),
  recent_daily_load: z
    .number()
    .describe("Trailing 28-day average daily load, the pct_of_recent basis"),
});
export const FitnessTrendOutputSchema = z.object({
  period: z.object({
    days: z.number().int(),
    start_date: z.string(),
    end_date: z.string(),
  }),
  current: FitnessTrendDaySchema.omit({ load: true }).nullable(),
  trend: z
    .object({
      ctl_7d_delta: z.number(),
      tsb_7d_delta: z.number(),
    })
    .nullable(),
  flags: z.array(z.string()),
  bands: z
    .array(
      z.object({
        kind: z.enum(["deep-fatigue", "fresh", "steep-ramp"]),
        start_date: z.string(),
        end_date: z.string(),
        days: z.number().int(),
        reason: z.string(),
      }),
    )
    .describe(
      "Dated stretches worth annotating: deep fatigue, freshness, steep CTL ramps. `flags` is the subset running to end_date",
    ),
  warnings: z.array(z.string()),
  daily: z.array(FitnessTrendDaySchema),
  projection: z
    .array(FitnessTrendDaySchema)
    .describe(
      "Decay projection past end_date (zero load unless planned); empty if none",
    ),
  tsb_positive_date: z
    .string()
    .nullable()
    .describe("First projected date TSB crosses ≥ 0, if projected"),
  taper: TaperPlanSchema.nullable().describe(
    "Solved load taper to the requested target date, or null if none was requested",
  ),
  activities_included: z.number().int(),
  activities_missing_load: z.number().int(),
});

// ---------- get-hill-analysis ----------
const HillSegmentSchema = z.object({
  start_km: z.number(),
  end_km: z.number(),
  length_m: z.number(),
  elevation_change_m: z
    .number()
    .describe("Positive on climbs, negative on descents"),
  avg_grade_pct: z.number(),
  moving_time_s: z.number().int(),
  pace_sec_per_km: z.number().nullable(),
  pace_formatted: z.string().nullable(),
  gap_pace_sec_per_km: z
    .number()
    .nullable()
    .describe("Grade-adjusted (flat-equivalent) pace"),
  gap_pace_formatted: z.string().nullable(),
  avg_hr: z.number().nullable(),
  avg_cadence: z
    .number()
    .nullable()
    .describe("spm (doubled) for runs, rpm for rides"),
  avg_watts: z.number().nullable(),
  hr_per_gap_speed: z
    .number()
    .nullable()
    .describe("Normalised climb cost: HR per m/s of grade-adjusted speed"),
});
export const HillAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  grade_source: z
    .enum(["grade_smooth", "computed"])
    .describe(
      "grade_smooth when intervals.icu's smoothed-grade stream was used, computed when derived from altitude",
    ),
  drift: z
    .object({
      basis: z.enum(["hr_per_gap", "gap_pace"]),
      early_value: z.number(),
      late_value: z.number(),
      drift_pct: z
        .number()
        .describe("Positive = climbing cost more late in the run"),
      early_climbs: z.number().int(),
      late_climbs: z.number().int(),
    })
    .nullable(),
  climbs: z.array(HillSegmentSchema),
  descents: z.array(HillSegmentSchema),
  totals: z.object({
    climb_count: z.number().int(),
    descent_count: z.number().int(),
    climb_distance_m: z.number(),
    climb_gain_m: z.number(),
  }),
  units: z.object({
    distance: z.literal("km"),
    length: z.literal("m"),
    elevation: z.literal("m"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    grade: z.literal("%"),
    hr: z.literal("bpm"),
    cadence: z.union([z.literal("spm"), z.literal("rpm")]),
    power: z.literal("W"),
  }),
  warnings: z.array(z.string()),
});

// ---------- zones, writes ----------
export const ActivityZonesOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  zone_sets: z.array(
    z.object({
      type: z.string().describe("heartrate or power"),
      sensor_based: z.boolean().nullable(),
      total_seconds: z.number().int(),
      buckets: z.array(
        z.object({
          zone: z.number().int().describe("1-based zone number"),
          min: z.number().nullable(),
          max: z
            .number()
            .nullable()
            .describe(
              "the zone's recorded upper bound; null only for an open-ended top bucket",
            ),
          seconds: z.number().int(),
          pct: z.number(),
        }),
      ),
    }),
  ),
  units: z.object({
    heartrate: z.literal("bpm"),
    power: z.literal("W"),
  }),
});

/** Minimal slice of a written activity the mapper reads. */
interface WrittenActivityLike {
  id: string | number;
  name: string;
  sport_type?: string | null;
  type?: string | null;
  start_date_local?: string | null;
  distance?: number | null;
  elapsed_time?: number | null;
  description?: string | null;
  gear_id?: string | null;
  commute?: boolean | null;
  trainer?: boolean | null;
}

/** Both write tools return the activity Strava echoed back, in one shape. */
export function toActivityWriteOutput(activity: WrittenActivityLike) {
  return {
    activity_id: activity.id,
    name: activity.name,
    sport_type: activity.sport_type ?? activity.type ?? null,
    start_date_local: activity.start_date_local ?? null,
    distance_m: activity.distance ?? null,
    elapsed_time_s: activity.elapsed_time ?? null,
    description: activity.description ?? null,
    gear_id: activity.gear_id ?? null,
    commute: activity.commute ?? null,
    trainer: activity.trainer ?? null,
    url: `https://www.strava.com/activities/${activity.id}`,
  };
}

export const ActivityWriteOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  sport_type: z.string().nullable(),
  start_date_local: z.string().nullable(),
  distance_m: z.number().nullable(),
  elapsed_time_s: z.number().int().nullable(),
  description: z.string().nullable(),
  gear_id: z.string().nullable(),
  commute: z.boolean().nullable(),
  trainer: z.boolean().nullable(),
  url: z.string().describe("Strava web URL for the activity"),
});

// ---------- get-split-analysis ----------
const SplitShapeSchema = z.enum(["even", "positive", "negative"]);
const SplitSchema = z.object({
  split: z.number().int().describe("1-based split number"),
  start_m: z.number(),
  end_m: z.number(),
  distance_m: z.number(),
  partial: z
    .boolean()
    .describe("True on a trailing split shorter than a full km"),
  moving_time_s: z.number().int(),
  elapsed_time_s: z.number().int(),
  pace_sec_per_km: z
    .number()
    .nullable()
    .describe("Moving pace per km (extrapolated on a partial split)"),
  pace_formatted: z.string().nullable(),
  gap_pace_sec_per_km: z
    .number()
    .nullable()
    .describe("Grade-adjusted (flat-equivalent) pace per km"),
  gap_pace_formatted: z.string().nullable(),
  elevation_change_m: z.number().nullable(),
  avg_grade_pct: z.number().nullable(),
  avg_hr: z.number().nullable(),
  avg_cadence: z
    .number()
    .nullable()
    .describe("spm (doubled) for runs, rpm for rides"),
  avg_watts: z.number().nullable(),
});
export const SplitAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  grade_source: z
    .enum(["grade_smooth", "computed"])
    .describe(
      "grade_smooth when intervals.icu's smoothed-grade stream was used, computed when derived from altitude",
    ),
  verdict: z
    .object({
      shape: SplitShapeSchema.describe(
        "On the clock: positive = second half slower",
      ),
      gap_shape: SplitShapeSchema.describe("Same, corrected for grade"),
      first_half_pace_sec_per_km: z.number(),
      second_half_pace_sec_per_km: z.number(),
      first_half_pace_formatted: z.string().nullable(),
      second_half_pace_formatted: z.string().nullable(),
      first_half_gap_pace_sec_per_km: z.number().nullable(),
      second_half_gap_pace_sec_per_km: z.number().nullable(),
      delta_pct: z
        .number()
        .describe("Pace change second half vs first; positive = slower"),
      gap_delta_pct: z.number().nullable().describe("Same, grade-adjusted"),
      terrain_pct: z
        .number()
        .nullable()
        .describe(
          "Percentage points of delta_pct the terrain accounts for (delta − gap delta)",
        ),
      first_half_elevation_change_m: z.number().nullable(),
      second_half_elevation_change_m: z.number().nullable(),
      interpretation: z.string(),
    })
    .nullable()
    .describe("Null when either half is too short for a verdict to mean much"),
  splits: z.array(SplitSchema),
  fastest_split: z
    .number()
    .int()
    .nullable()
    .describe("Split number, ignoring a trailing partial split"),
  slowest_split: z.number().int().nullable(),
  totals: z.object({
    distance_m: z.number(),
    moving_time_s: z.number().int(),
    elapsed_time_s: z.number().int(),
    elevation_gain_m: z.number(),
    avg_pace_sec_per_km: z.number().nullable(),
    avg_pace_formatted: z.string().nullable(),
    avg_gap_pace_sec_per_km: z.number().nullable(),
  }),
  units: z.object({
    distance: z.literal("km"),
    elevation: z.literal("m"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    grade: z.literal("%"),
    hr: z.literal("bpm"),
    cadence: z.union([z.literal("spm"), z.literal("rpm")]),
    power: z.literal("W"),
  }),
  warnings: z.array(z.string()),
});

// ---------- get-interval-analysis ----------
const IntervalRepSchema = z.object({
  index: z.number().int(),
  start_km: z.number(),
  distance_m: z.number(),
  moving_time_s: z.number().int(),
  moving_time_formatted: z.string(),
  pace_sec_per_km: z.number().nullable(),
  pace_formatted: z.string().nullable(),
  avg_hr: z.number().nullable(),
  avg_cadence: z
    .number()
    .nullable()
    .describe("spm (doubled) for runs, rpm for rides"),
  avg_watts: z.number().nullable(),
});
export const IntervalAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  is_intervals: z.boolean(),
  source: z
    .enum(["laps", "streams", "none"])
    .describe(
      "Where the reps came from: clean device laps or stream reconstruction",
    ),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z
    .string()
    .describe("Audit trail: rest counts by classification and rep source"),
  reps: z.array(IntervalRepSchema),
  rests: z.array(
    z.object({
      start_time_s: z.number().int(),
      at_km: z.number(),
      duration_s: z.number().int(),
      kind: z.enum(["traffic_light", "recovery", "long_stop", "other_stop"]),
      reason: z.string(),
    }),
  ),
  fade: z
    .object({
      pace_drift_pct: z
        .number()
        .nullable()
        .describe("Positive = last rep slower than first"),
      hr_drift_bpm: z.number().nullable(),
      cadence_drift_pct: z.number().nullable(),
      summary: z.string(),
    })
    .nullable(),
  hr_signal: z
    .object({
      max_hr: z.number(),
      high_intensity_share_pct: z
        .number()
        .describe("% of moving time at ≥ 88% of the activity's max HR"),
      assessment: z.string(),
    })
    .nullable(),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
    cadence: z.union([z.literal("spm"), z.literal("rpm")]),
    power: z.literal("W"),
  }),
  warnings: z.array(z.string()),
});

// ---------- intervals.icu reads ----------
const ActivitySummarySchema = z.object({
  id: z.string(),
  date: z
    .string()
    .describe("ISO date YYYY-MM-DD, the date part of start_date_local"),
  start_local: z.string().describe("Full local start timestamp"),
  type: z.string(),
  name: z.string(),
  distance_km: z
    .number()
    .nullable()
    .describe("2 dp; null when the activity recorded no distance"),
  moving_time_s: z.number().int(),
  moving_time: z.string().describe("h:mm:ss, or mm:ss under an hour"),
  pace_min_per_km: z
    .string()
    .nullable()
    .describe("Set for Run/TrailRun/VirtualRun only"),
  average_hr: z.number().nullable(),
  load: z.number().nullable().describe("icu_training_load"),
  gear_id: z.string().nullable(),
  source: z.string().nullable(),
  is_strava_stub: z
    .boolean()
    .describe(
      "True when source is STRAVA: details are unavailable through the API",
    ),
});
export const ActivityListOutputSchema = z.object({
  oldest: z.string().describe("ISO date YYYY-MM-DD, inclusive lower bound"),
  newest: z.string().describe("ISO date YYYY-MM-DD, inclusive upper bound"),
  count: z.number().int().describe("Activities included in this response"),
  matched: z
    .number()
    .int()
    .describe("Activities matching the filters before limit truncated them"),
  truncated: z.boolean().describe("True when matched > limit"),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
  }),
  activities: z.array(ActivitySummarySchema),
});

// ---------- get-activity ----------
const ActivityLoadSchema = z.object({
  training_load: z.number().nullable().describe("icu_training_load"),
  hr_load: z.number().nullable(),
  pace_load: z.number().nullable(),
  trimp: z.number().nullable(),
  intensity: z.number().nullable().describe("icu_intensity, %"),
});
const HrZoneEntrySchema = z.object({
  zone: z.number().int().describe("1-based zone number"),
  min_bpm: z.number().nullable().describe("0 for zone 1"),
  max_bpm: z.number().nullable(),
  seconds: z.number().int(),
});
const RunningDynamicsSchema = z.object({
  stance_time_ms: z.number().nullable(),
  vertical_oscillation_mm: z.number().nullable(),
  vertical_ratio_pct: z.number().nullable(),
  step_length_mm: z.number().nullable(),
  stride_m: z.number().nullable(),
});
const ActivityIntervalEntrySchema = z.object({
  type: z.string().nullable().describe("e.g. WORK, RECOVERY"),
  label: z.string().nullable(),
  distance_km: z.number().nullable(),
  moving_time_s: z.number().int().nullable(),
  pace_min_per_km: z.string().nullable().describe("Set for runs only"),
  average_hr: z.number().nullable(),
  average_cadence_spm: z
    .number()
    .nullable()
    .describe("Strides doubled to steps/min, runs only"),
  stance_time_ms: z.number().nullable(),
  vertical_oscillation_mm: z.number().nullable(),
  step_length_mm: z.number().nullable(),
});
export const ActivityDetailOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  date: z
    .string()
    .describe("ISO date YYYY-MM-DD, the date part of start_date_local"),
  start_local: z.string().describe("Full local start timestamp"),
  source: z.string().nullable(),
  is_strava_stub: z
    .boolean()
    .describe(
      "True when source is STRAVA: details are unavailable through the API",
    ),
  device: z.string().nullable(),
  distance_km: z
    .number()
    .nullable()
    .describe("2 dp; null when the activity recorded no distance"),
  moving_time_s: z.number().int(),
  moving_time: z.string().describe("h:mm:ss, or mm:ss under an hour"),
  elapsed_time_s: z.number().int().nullable(),
  pace_min_per_km: z
    .string()
    .nullable()
    .describe("Set for Run/TrailRun/VirtualRun only"),
  gap_min_per_km: z
    .string()
    .nullable()
    .describe(
      "Grade-adjusted pace, from the activity's gap field (m/s, same unit as average_speed); runs only",
    ),
  average_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  average_cadence_spm: z
    .number()
    .nullable()
    .describe("Strides doubled to steps/min, runs only"),
  elevation_gain_m: z.number().nullable(),
  load: ActivityLoadSchema,
  decoupling_pct: z.number().nullable(),
  efficiency_factor: z.number().nullable(),
  rpe: z.number().nullable(),
  feel: z.number().nullable(),
  hr_zones: z
    .array(HrZoneEntrySchema)
    .describe("Empty when sport settings or icu_hr_zone_times are unavailable"),
  pace_zone_seconds: z.array(z.number()).nullable(),
  running_dynamics: RunningDynamicsSchema.nullable(),
  intervals: z
    .array(ActivityIntervalEntrySchema)
    .nullable()
    .describe("Null when not requested or the activity has none"),
  gear_id: z.string().nullable(),
  gear_name: z
    .string()
    .nullable()
    .describe(
      "Resolved from the activity payload alone, never an extra list-gear call; null in practice since intervals.icu doesn't populate it on the activity today",
    ),
  weather_temp_c: z.number().nullable(),
  description: z.string().nullable(),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
    elevation: z.literal("m"),
    cadence: z.literal("spm"),
    temp: z.literal("C"),
  }),
});

// ---------- get-activity-streams ----------
/** A downsampled sample: a plain value, `null` where every sample in its
 * bucket was null, or a `[lat, lng]` pair for the `latlng` stream. */
const StreamValueSchema = z.union([
  z.number(),
  z.null(),
  z.tuple([z.number(), z.number()]),
]);
export const ActivityStreamsOutputSchema = z.object({
  activity_id: z.string(),
  type: z.string(),
  original_points: z.number().int(),
  returned_points: z.number().int(),
  requested: z.array(z.string()),
  missing: z
    .array(z.string())
    .describe("Requested types the activity's streams don't include"),
  units: z.record(z.string(), z.string()),
  streams: z.record(z.string(), z.array(StreamValueSchema)),
});

// ---------- list-gear ----------
const GearReminderEntrySchema = z
  .object({
    name: z.string().nullable(),
    distance_km: z.number().optional().describe("1 dp"),
    days: z.number().optional(),
    percent_used: z.number().optional(),
  })
  .catchall(z.number())
  .describe(
    "Known reminder fields mapped; any other numeric field the API sends passes through raw",
  );
export const GearListOutputSchema = z.object({
  count: z.number().int(),
  units: z.object({ distance: z.literal("km") }),
  gear: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      distance_km: z
        .number()
        .describe(
          "1 dp; includes any starting distance entered in the UI, not just distance logged through this API",
        ),
      activities: z.number().int(),
      retired: z.union([z.string(), z.boolean()]).nullable(),
      reminders: z.array(GearReminderEntrySchema),
    }),
  ),
});

// ---------- get-wellness ----------
const WellnessDayEntrySchema = z.object({
  date: z.string().describe("ISO date YYYY-MM-DD"),
  hrv_sdnn_ms: z.number().nullable(),
  hrv_rmssd_ms: z.number().nullable(),
  resting_hr: z.number().nullable(),
  sleep_hours: z.number().nullable().describe("1 dp"),
  sleep_score: z.number().nullable(),
  weight_kg: z.number().nullable(),
  ctl: z.number().nullable(),
  atl: z.number().nullable(),
  tsb: z.number().nullable().describe("ctl minus atl, 1 dp"),
  ramp_rate: z.number().nullable(),
  readiness: z.number().nullable(),
  soreness: z.number().nullable(),
  fatigue: z.number().nullable(),
  stress: z.number().nullable(),
  mood: z.number().nullable(),
  motivation: z.number().nullable(),
  spo2: z.number().nullable(),
  respiration: z.number().nullable(),
  comments: z.string().nullable(),
});
export const WellnessOutputSchema = z.object({
  oldest: z.string().describe("ISO date YYYY-MM-DD, inclusive lower bound"),
  newest: z.string().describe("ISO date YYYY-MM-DD, inclusive upper bound"),
  count: z.number().int(),
  units: z.object({
    hrv: z.literal("ms"),
    resting_hr: z.literal("bpm"),
    sleep: z.literal("hours"),
    weight: z.literal("kg"),
    spo2: z.literal("%"),
    respiration: z.literal("breaths/min"),
  }),
  hrv_note: z.string(),
  days: z.array(WellnessDayEntrySchema),
});

// ---------- dev-only schema drift guard ----------
export function warnOnSchemaDrift<T>(
  toolName: string,
  schema: z.ZodType<T>,
  value: unknown,
): void {
  if (process.env.NODE_ENV === "production") return;
  const result = schema.safeParse(value);
  if (!result.success) {
    console.error(
      `[${toolName}] structuredContent schema drift:`,
      result.error,
    );
  }
}

// ---------- get-best-efforts ----------
const BestEffortEntrySchema = z.object({
  rank: z.number().int(),
  time_seconds: z.number(),
  time_formatted: z.string(),
  pace: z.string().describe("m:ss min/km"),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  activity_id: z.string(),
  activity_name: z.string(),
  race: z.boolean(),
});
export const BestEffortsOutputSchema = z.object({
  window: z.object({
    id: z.string().describe('"all", "1y", "90d", or "r.<oldest>.<newest>"'),
    oldest: z.string().describe("ISO date YYYY-MM-DD"),
    newest: z.string().describe("ISO date YYYY-MM-DD"),
  }),
  top_n: z.number().int(),
  units: z.object({
    time: z.literal("seconds"),
    pace: z.literal("min/km"),
  }),
  note: z
    .string()
    .describe(
      "Time-basis note: best times come from the recorded time stream (a moving-time style curve), not elapsed time",
    ),
  best_efforts: z.record(z.string(), z.array(BestEffortEntrySchema)),
  missing: z
    .array(z.string())
    .describe(
      "Requested distances with no curve point within tolerance (2% of the target or 50m, whichever is larger)",
    ),
  warnings: z.array(z.string()),
});

// ---------- get-race-prediction ----------
/** km-only pace: get-race-prediction dropped mile paces and splits in
 * favour of km-only output. */
const KmPaceSchema = z.object({
  min_per_km: z.string(),
});
const PredictionSourceSchema = z.object({
  name: z.string().describe("A label for the effort, e.g. '5000 m'"),
  distance_m: z.number(),
  elapsed_time_seconds: z.number().int(),
  elapsed_time_formatted: z.string(),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  activity_id: z.string(),
  activity_name: z.string(),
});
const PredictionContributionSchema = z.object({
  source: PredictionSourceSchema,
  predicted_seconds: z.number().int(),
  predicted_formatted: z.string(),
  age_days: z.number().int(),
  weight: z
    .number()
    .describe("Recency x extrapolation weight in the consensus"),
});
const CriticalSpeedPredictionSchema = z
  .object({
    predicted_seconds: z.number().int(),
    predicted_formatted: z.string(),
    pace: KmPaceSchema,
    within_model_range: z
      .boolean()
      .describe(
        "True when the predicted time falls inside the model's roughly 3-60 minute validity window",
      ),
  })
  .nullable()
  .describe(
    "intervals.icu's critical-speed prediction at this distance; null when no CS model is available or the target does not exceed dPrime",
  );
const RacePredictionEntrySchema = z.object({
  distance: z.string(),
  distance_m: z.number(),
  predicted_seconds: z.number().int(),
  predicted_formatted: z.string(),
  pace: KmPaceSchema,
  confidence: z.enum(["high", "medium", "low"]),
  confidence_notes: z.array(z.string()),
  primary_source: PredictionSourceSchema.describe(
    "The pace-curve point driving the estimate",
  ),
  spread: z
    .object({
      fastest_seconds: z.number().int(),
      slowest_seconds: z.number().int(),
      range_seconds: z.number().int(),
      range_pct: z.number(),
    })
    .nullable()
    .describe("Disagreement across sources; null with a single source"),
  contributions: z.array(PredictionContributionSchema),
  critical_speed: CriticalSpeedPredictionSchema,
});
const SplitRowSchema = z.object({
  index: z.number().int(),
  cumulative_m: z.number(),
  segment_m: z
    .number()
    .describe("Length of this split; the last may be partial"),
  split_seconds: z.number(),
  split_formatted: z.string(),
  cumulative_seconds: z.number(),
  cumulative_formatted: z.string(),
  pace_per_unit: z.string().describe("Pace over this split, per full km"),
});
const SplitPlanSchema = z.object({
  unit: z.enum(["km"]),
  strategy: z.enum(["even", "negative"]),
  negative_split_pct: z.number(),
  total_seconds: z.number().int(),
  total_formatted: z.string(),
  splits: z.array(SplitRowSchema),
});
export const RacePredictionOutputSchema = z.object({
  predictions: z.array(RacePredictionEntrySchema),
  target: z
    .object({
      distance: z.string(),
      distance_m: z.number(),
      /** "goal" when the caller supplied a goal time, else "predicted". */
      basis: z.enum(["goal", "predicted"]),
      total_seconds: z.number().int(),
      total_formatted: z.string(),
      pace: KmPaceSchema,
      /** Seconds the goal is faster (negative) or slower than the prediction. */
      goal_vs_predicted_seconds: z.number().int().nullable(),
      goal_assessment: z.string().nullable(),
      splits: z.array(SplitPlanSchema),
    })
    .nullable()
    .describe("Set only when raceDistance was supplied"),
  sources: z
    .array(PredictionSourceSchema)
    .describe("Pace-curve points used as prediction inputs, shortest first"),
  critical_speed_model: z
    .object({
      critical_speed_min_per_km: z.string(),
      d_prime_m: z.number(),
      r2: z.number(),
      source: z
        .enum(["90d", "all"])
        .describe(
          "Which pace curve the fit came from: 90d (current fitness) preferred, all as fallback",
        ),
    })
    .nullable()
    .describe(
      "intervals.icu's type: CS model from the athlete's pace curve; null when no fit is available",
    ),
  warnings: z.array(z.string()),
  method: z.string(),
});

// ---------- get-activity-laps ----------
const IntervalsLapEntrySchema = z.object({
  lap_index: z
    .number()
    .int()
    .describe("1-based; icu_intervals carry no lap number of their own"),
  type: z.string().nullable().describe("e.g. WORK, RECOVERY"),
  label: z.string().nullable(),
  distance_km: z.number().nullable(),
  moving_time_s: z.number().int().nullable(),
  moving_time: z.string().describe("h:mm:ss, or mm:ss under an hour"),
  elapsed_time_s: z.number().int().nullable(),
  pace_min_per_km: z
    .string()
    .nullable()
    .describe("Set for Run/TrailRun/VirtualRun only"),
  gap_min_per_km: z
    .string()
    .nullable()
    .describe(
      "Grade-adjusted pace from the interval's gap field (m/s, same unit as average_speed); runs only",
    ),
  speed_kmh: z.number().nullable().describe("Set for non-pace distance sports"),
  average_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  average_cadence: z
    .number()
    .nullable()
    .describe(
      "Strides doubled to steps/min for a step-cadence type, raw rpm otherwise; see units.cadence",
    ),
  average_watts: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  average_gradient_pct: z.number().nullable(),
});
export const ActivityLapsOutputSchema = z.object({
  activity_id: z.string(),
  activity_name: z.string(),
  sport_type: z.string(),
  lap_count: z.number().int(),
  lap_source: z
    .literal("intervals.icu intervals")
    .describe("icu_intervals, usually mirroring the device's laps"),
  device_lap_count: z
    .number()
    .int()
    .nullable()
    .describe("icu_lap_count; may differ from lap_count"),
  intervals_edited: z.boolean().nullable().describe("icu_intervals_edited"),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    speed: z.literal("km/h"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
    elevation: z.literal("m"),
    cadence: z.union([z.literal("spm"), z.literal("rpm")]),
    gradient: z.literal("%"),
  }),
  laps: z.array(IntervalsLapEntrySchema),
});

// ---------- get-running-summary ----------
// A thin wrapper over get-activity: every ActivityDetailOutputSchema field,
// plus run-specific assessments and a lap breakdown. No power fields.
const HrZoneSummaryEntrySchema = z.object({
  zone: z.number().int().describe("1-based zone number"),
  min_bpm: z.number().nullable().describe("0 for zone 1"),
  max_bpm: z.number(),
  seconds: z.number().int(),
  percent: z.number().describe("Share of recorded zone time, 1 dp"),
});
export const RunningSummaryOutputSchema = ActivityDetailOutputSchema.extend({
  cadence_assessment: z
    .string()
    .nullable()
    .describe("From average_cadence_spm via assessCadence"),
  hr_zone_summary: z
    .object({
      source: z
        .union([z.literal("activity"), z.literal("sport_settings")])
        .describe(
          "Bounds from the activity's own icu_hr_zones when present, else the Run sport settings group",
        ),
      total_seconds: z.number().int(),
      zones: z.array(HrZoneSummaryEntrySchema),
    })
    .nullable()
    .describe(
      "Null when no zone bounds match the recorded zone time count; see hr_zone_note",
    ),
  hr_zone_note: z
    .string()
    .nullable()
    .describe("Set when hr_zone_summary is omitted, explaining why"),
  dynamics_assessment: z
    .object({
      vertical_oscillation: z.string().nullable(),
      ground_contact_time: z.string().nullable(),
    })
    .nullable()
    .describe("Only set when running_dynamics is present"),
  laps: z.array(IntervalsLapEntrySchema).describe("From mapIntervalsToLaps"),
});
