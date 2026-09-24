import { z } from "zod";
import { type StravaStats } from "../stravaClient";

// ---------- get-athlete-stats ----------
const TotalSchema = z.object({
  count: z.number().int(),
  distance_m: z.number().describe("Distance in meters"),
  moving_time_s: z.number().int(),
  elevation_gain_m: z.number(),
});
export const AthleteStatsOutputSchema = z.object({
  recent_run_totals: TotalSchema.nullable(),
  ytd_run_totals: TotalSchema.nullable(),
  all_run_totals: TotalSchema.nullable(),
  recent_ride_totals: TotalSchema.nullable(),
  ytd_ride_totals: TotalSchema.nullable(),
  all_ride_totals: TotalSchema.nullable(),
  recent_swim_totals: TotalSchema.nullable(),
  ytd_swim_totals: TotalSchema.nullable(),
  all_swim_totals: TotalSchema.nullable(),
  biggest_ride_distance_m: z.number().nullable(),
  biggest_climb_elevation_gain_m: z.number().nullable(),
});
export type AthleteStatsOutput = z.infer<typeof AthleteStatsOutputSchema>;

type RawTotal =
  | {
      count: number;
      distance: number;
      moving_time: number;
      elevation_gain: number;
    }
  | null
  | undefined;

function mapTotal(t: RawTotal) {
  return t
    ? {
        count: t.count,
        distance_m: t.distance,
        moving_time_s: t.moving_time,
        elevation_gain_m: t.elevation_gain,
      }
    : null;
}

export function buildAthleteStatsOutput(s: StravaStats): AthleteStatsOutput {
  return {
    recent_run_totals: mapTotal(s.recent_run_totals),
    ytd_run_totals: mapTotal(s.ytd_run_totals),
    all_run_totals: mapTotal(s.all_run_totals),
    recent_ride_totals: mapTotal(s.recent_ride_totals),
    ytd_ride_totals: mapTotal(s.ytd_ride_totals),
    all_ride_totals: mapTotal(s.all_ride_totals),
    recent_swim_totals: mapTotal(s.recent_swim_totals),
    ytd_swim_totals: mapTotal(s.ytd_swim_totals),
    all_swim_totals: mapTotal(s.all_swim_totals),
    biggest_ride_distance_m: s.biggest_ride_distance ?? null,
    biggest_climb_elevation_gain_m: s.biggest_climb_elevation_gain ?? null,
  };
}

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

// ---------- get-running-summary ----------
const PaceSchema = z.object({
  min_per_km: z.string(),
  min_per_mile: z.string(),
});
export const RunningSummaryOutputSchema = z.object({
  activity_id: z
    .union([z.number(), z.string()])
    .describe("The requested Strava activity id (as supplied to the tool)"),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  distance: z.object({
    meters: z.number(),
    km: z.number(),
    miles: z.number(),
  }),
  time: z.object({
    moving_seconds: z.number().int(),
    moving_formatted: z.string(),
    elapsed_seconds: z.number().int(),
    elapsed_formatted: z.string(),
  }),
  pace: PaceSchema.extend({ display: z.string() }).nullable(),
  elevation: z.object({ gain_m: z.number(), gain_ft: z.number() }),
  cadence: z
    .object({
      average_spm: z.number(),
      assessment: z.string().nullable(),
    })
    .nullable(),
  heart_rate: z
    .object({
      average: z.number().nullable(),
      max: z.number().nullable(),
      zones: z.unknown().nullable(),
    })
    .nullable(),
  power: z
    .object({
      average_watts: z.number(),
      max_watts: z.number().nullable(),
    })
    .nullable(),
  laps: z.array(z.unknown()),
  gear: z.string().nullable(),
});

// ---------- compare-activities ----------
const CompareSideSchema = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  distance_km: z.number(),
  time_formatted: z.string(),
  pace: PaceSchema.extend({ raw_min_per_km: z.number() }).nullable(),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  cadence_spm: z.number().nullable(),
  elevation_gain_m: z.number(),
});
export const CompareActivitiesOutputSchema = z.object({
  activity_1: CompareSideSchema,
  activity_2: CompareSideSchema,
  differences: z.object({
    distance_km: z.number(),
    pace: z
      .object({
        seconds_per_km: z.number(),
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
  avg_output: z.number(),
  avg_hr: z.number(),
  output_per_beat: z.number(),
  minutes: z.number(),
});

export const AerobicAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  /** power = Pw:Hr from the watts stream; speed = Pa:Hr fallback. */
  basis: z.enum(["power", "speed"]),
  decoupling_pct: z.number(),
  interpretation: z.string(),
  first_half: AerobicHalfSchema,
  second_half: AerobicHalfSchema,
  /** Normalized power (W) on the power basis, avg speed (m/s) otherwise. */
  normalized_output: z.number(),
  /** W/beat on the power basis, metres-per-minute/beat on the speed basis. */
  efficiency_factor: z.number(),
  intensity_factor: z.number().nullable(),
  threshold_power_w: z.number().nullable(),
  moving_minutes: z.number(),
  excluded_stopped_minutes: z.number(),
  excluded_warmup_minutes: z.number(),
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
            .describe("null on the open-ended top bucket"),
          seconds: z.number().int(),
          pct: z.number(),
        }),
      ),
    }),
  ),
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

// ---------- export-activity-gpx ----------
/**
 * `mode` is what actually happened, not what was asked for: with no `output`
 * argument the tool picks by whether the server has an export directory, and
 * a caller chaining on the result needs to know which it got.
 */
export const ExportOutputSchema = z.object({
  resource_id: z
    .string()
    .describe("Route or activity id the export was produced from"),
  format: z.enum(["gpx", "tcx"]),
  mode: z
    .enum(["file", "content"])
    .describe("How the export was delivered — file path, or inline content"),
  filename: z.string(),
  path: z
    .string()
    .nullable()
    .describe("Absolute server-side path in file mode; null in content mode"),
  bytes: z.number().int().describe("Size of the document delivered"),
  truncated: z
    .boolean()
    .describe("True when content mode cut the document at the size cap"),
  note: z
    .string()
    .optional()
    .describe("Caveat about the export's completeness, when one applies"),
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
    .describe("True on a trailing split shorter than a full unit"),
  moving_time_s: z.number().int(),
  elapsed_time_s: z.number().int(),
  pace_sec_per_unit: z
    .number()
    .nullable()
    .describe("Moving pace per split unit (extrapolated on a partial split)"),
  pace_formatted: z.string().nullable(),
  gap_pace_sec_per_unit: z
    .number()
    .nullable()
    .describe("Grade-adjusted (flat-equivalent) pace per split unit"),
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
  unit: z.enum(["km", "mile"]),
  verdict: z
    .object({
      shape: SplitShapeSchema.describe(
        "On the clock: positive = second half slower",
      ),
      gap_shape: SplitShapeSchema.describe("Same, corrected for grade"),
      first_half_pace_sec_per_unit: z.number(),
      second_half_pace_sec_per_unit: z.number(),
      first_half_pace_formatted: z.string().nullable(),
      second_half_pace_formatted: z.string().nullable(),
      first_half_gap_pace_sec_per_unit: z.number().nullable(),
      second_half_gap_pace_sec_per_unit: z.number().nullable(),
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
    avg_pace_sec_per_unit: z.number().nullable(),
    avg_pace_formatted: z.string().nullable(),
    avg_gap_pace_sec_per_unit: z.number().nullable(),
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
  activity_id: z.string(),
  activity_name: z.string(),
  date: z.string(),
  elapsed_time_seconds: z.number().int(),
  elapsed_time_formatted: z.string(),
  moving_time_seconds: z.number().int(),
  moving_time_formatted: z.string(),
  pace: PaceSchema.nullable(),
  pr_rank: z.number().int().nullable(),
});
export const BestEffortsOutputSchema = z.object({
  best_efforts: z.record(z.string(), z.array(BestEffortEntrySchema)),
  activities_analyzed: z.number().int(),
  activities_with_efforts: z.number().int(),
  activities_skipped: z
    .number()
    .int()
    .describe(
      "Activities whose detail could not be fetched, so their efforts are absent from the table",
    ),
  warnings: z
    .array(z.string())
    .describe(
      "Reasons the scan is incomplete (e.g. rate limit reached part-way)",
    ),
  note: z.string(),
});

// ---------- get-race-prediction ----------
const PredictionSourceSchema = z.object({
  name: z.string().describe("Strava's label for the effort, e.g. '10K'"),
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
    .describe("Recency × extrapolation weight in the consensus"),
});
const RacePredictionEntrySchema = z.object({
  distance: z.string(),
  distance_m: z.number(),
  predicted_seconds: z.number().int(),
  predicted_formatted: z.string(),
  pace: PaceSchema,
  confidence: z.enum(["high", "medium", "low"]),
  confidence_notes: z.array(z.string()),
  primary_source: PredictionSourceSchema.describe(
    "The effort driving the estimate",
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
  pace_per_unit: z
    .string()
    .describe("Pace over this split, per full km or mile"),
});
const SplitPlanSchema = z.object({
  unit: z.enum(["km", "mile"]),
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
      pace: PaceSchema,
      /** Seconds the goal is faster (negative) or slower than the prediction. */
      goal_vs_predicted_seconds: z.number().int().nullable(),
      goal_assessment: z.string().nullable(),
      splits: z.array(SplitPlanSchema),
    })
    .nullable()
    .describe("Set only when raceDistance was supplied"),
  sources: z
    .array(PredictionSourceSchema)
    .describe("Efforts used as prediction inputs, shortest first"),
  activities_analyzed: z.number().int(),
  activities_with_efforts: z.number().int(),
  activities_skipped: z
    .number()
    .int()
    .describe(
      "Activities whose detail could not be fetched, so their efforts are absent",
    ),
  warnings: z.array(z.string()),
  method: z.string(),
});

// ---------- get-activity-laps ----------
const LapEntrySchema = z.object({
  lap_index: z.number().int(),
  name: z.string(),
  distance_km: z.number(),
  elapsed_time_seconds: z.number().int(),
  elapsed_time_formatted: z.string(),
  moving_time_seconds: z.number().int(),
  moving_time_formatted: z.string(),
  pace: PaceSchema.nullable().describe("Set for runs; null for other sports"),
  speed_kmh: z.number().nullable().describe("Set for non-run sports"),
  average_watts: z.number().nullable(),
  device_watts: z.boolean().nullable(),
  average_cadence: z
    .number()
    .nullable()
    .describe("spm (doubled) for runs, rpm for rides"),
  average_heartrate: z.number().nullable(),
  max_heartrate: z.number().nullable(),
  total_elevation_gain_m: z.number().nullable(),
});
export const ActivityLapsOutputSchema = z.object({
  activity_id: z.string(),
  activity_name: z.string(),
  sport_type: z.string(),
  lap_count: z.number().int(),
  laps: z.array(LapEntrySchema),
});
