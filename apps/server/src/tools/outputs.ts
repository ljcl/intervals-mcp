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
const SportTotalsSchema = z.object({
  count: z.number().int().describe("Activities of this type in the period"),
  moving_time_s: z.number().int().describe("Moving time in seconds"),
  distance_km: z
    .number()
    .nullable()
    .describe(
      "Distance in km. Null when no activity of this type in the period has a distance above 0, for example WeightTraining",
    ),
  load: z
    .number()
    .describe(
      "intervals.icu training load (icu_training_load). An activity with no load adds 0",
    ),
});
const AllSportsPeriodSchema = z.object({
  total: z
    .object({
      count: z.number().int(),
      moving_time_s: z.number().int(),
      load: z.number(),
    })
    .describe(
      "All types together. Each field is the sum of by_type, so load is the whole-body load",
    ),
  by_type: z
    .record(z.string(), SportTotalsSchema)
    .describe(
      "Totals per intervals.icu activity type (for example Run, TrailRun, WeightTraining, Swim), highest load first",
    ),
});
export const AthleteStatsOutputSchema = z.object({
  this_week: RunTotalsSchema,
  last_4_weeks: RunTotalsSchema,
  this_month: RunTotalsSchema,
  ytd: RunTotalsSchema,
  all_sports: z
    .object({
      this_week: AllSportsPeriodSchema,
      last_4_weeks: AllSportsPeriodSchema,
      this_month: AllSportsPeriodSchema,
      ytd: AllSportsPeriodSchema,
    })
    .describe(
      "Totals for every activity type except Strava stubs, for the same periods as the run totals. This load is whole-body and the run totals' load is run-only: say which load a number is",
    ),
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
    ends_today: z
      .boolean()
      .describe(
        "False for a past window (newest before today). Its last week is partial unless newest is a Sunday",
      ),
  }),
  run_only: z
    .boolean()
    .describe(
      "Whether load/activity_types_included are run-only. Volume/warnings are always run-based regardless",
    ),
  source: z
    .enum(["intervals.icu", "computed"])
    .describe(
      "'intervals.icu' for whole-body CTL/ATL read from wellness, 'computed' for the locally-computed run-only series",
    ),
  current: z
    .object({
      date: z.string().describe("ISO date CTL/ATL/TSB were computed for"),
      ctl: z.number(),
      atl: z.number(),
      tsb: z.number(),
    })
    .nullable()
    .describe(
      "CTL/ATL/TSB on the last day of the window with data; null when no data is available",
    ),
  activity_types_included: z
    .array(z.string())
    .describe(
      "Activity types load/load_by_type are summed over: run-only is Run/TrailRun/VirtualRun; " +
        "whole-body is every distinct type carrying load in the window",
    ),
  totals: z.object({
    runs: z.number().int(),
    distance_km: z.number(),
    time_s: z.number().int(),
    time_hours: z.number(),
    elevation_m: z.number(),
    load: z.number(),
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
      time_s: z.number().int(),
      time_hours: z.number(),
      time_formatted: z.string(),
      elevation_m: z.number(),
      load: z
        .number()
        .describe("Sum of icu_training_load over the included types this week"),
      load_by_type: z.record(z.string(), z.number()),
      activities: z.array(TrainingActivitySchema),
    }),
  ),
  warnings: z.array(z.string()),
  units: z.object({
    load: z.literal("intervals.icu training load"),
    distance: z.literal("km"),
    time: z.literal("s"),
    time_hours: z.literal("h"),
    elevation: z.literal("m"),
  }),
});

// get-running-summary's output schema is defined near the end of this file
// (RunningSummaryOutputSchema), after ActivityDetailOutputSchema and
// IntervalsLapEntrySchema, which it extends/reuses.

// ---------- moving time source ----------
// One run can carry three moving times: intervals.icu's own for the
// activity, the one the stream tools count, and intervals.icu's own per lap.
// They differ by tens of seconds (docs/api-notes.md, "Moving time"), so
// every pace and moving time names which it is.
const MOVING_TIME_SOURCE_TEXT =
  "Where the moving time behind this pace comes from. intervals.icu: the activity's own moving_time, as intervals.icu shows it; streams: counted from the streams, leaving out stops (an auto-pause gap, or slower than 0.5 m/s), as the split, hill and aerobic tools do; lap: intervals.icu's moving time for that lap. They can differ by tens of seconds on one run";
const movingTimeSourceField = <T extends "intervals.icu" | "streams" | "lap">(
  source: T,
) => z.literal(source).describe(MOVING_TIME_SOURCE_TEXT);

// ---------- swim pace and speed (sportSpeed) ----------
// One wording for the two sportSpeed fields, in every schema that has them:
// list-activities, get-activity, compare-activities, and get-activity's
// intervals and the laps (with the interval wording for swim pace).
const swimPaceField = () =>
  z
    .string()
    .nullable()
    .describe(
      "m:ss per 100 m, from distance over moving time; Swim and OpenWaterSwim only",
    );
// An interval's (and so a lap's) swim pace: intervals.icu counts the rests
// at the wall inside a swim interval as moving time (docs/api-notes.md).
const swimIntervalPaceField = () =>
  z
    .string()
    .nullable()
    .describe(
      "m:ss per 100 m, from distance over the interval's moving time; Swim and OpenWaterSwim only. intervals.icu counts the rests inside a swim interval as moving time, so this pace includes them and can be slower than the activity's own pace_min_per_100m, which leaves them out",
    );
const speedKmhField = () =>
  z
    .number()
    .nullable()
    .describe(
      "km/h to 1 dp, from distance over moving time; every sport except Run, TrailRun, VirtualRun and swims, when a distance was recorded",
    );

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
  moving_time: z.string(),
  moving_time_s: z.number().int(),
  moving_time_source: movingTimeSourceField("intervals.icu"),
  pace_min_per_km: z.string().nullable(),
  pace_min_per_100m: swimPaceField(),
  speed_kmh: speedKmhField(),
  gap_min_per_km: z.string().nullable(),
  gap_source: z
    .literal("intervals.icu")
    .describe(
      "GAP here is intervals.icu's own gap field, distinct from get-hill-analysis/get-split-analysis's locally-modelled GAP",
    ),
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
    swim_pace: z.literal("min/100m"),
    speed: z.literal("km/h"),
    time: z.literal("s"),
    hr: z.literal("bpm"),
    elevation: z.literal("m"),
    cadence: z.literal("spm"),
  }),
  activity_1: CompareSideSchema,
  activity_2: CompareSideSchema,
  differences: z.object({
    distance_km: z.number(),
    pace_delta_sec_per_km: z.number().nullable(),
    pace_delta_min_per_km: z.string().nullable(),
    pace_delta_interpretation: z.string().nullable(),
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
    .describe(
      "m/s on the gap and pace bases (grade-adjusted on gap), W on the power basis",
    ),
  avg_pace_min_per_km: z
    .string()
    .nullable()
    .describe(
      "m:ss on the gap and pace bases (grade-adjusted on gap); null on the power basis",
    ),
  avg_hr: z.number(),
  output_per_beat: z
    .number()
    .describe(
      "m/min per beat on the gap and pace bases, W/beat on the power basis",
    ),
  minutes: z.number(),
});

const AerobicSourceEnum = z.enum(["intervals.icu", "computed"]);

export const AerobicAnalysisOutputSchema = z.object({
  activity_id: z.union([z.string(), z.number()]),
  name: z.string(),
  date: z.string(),
  type: z.string(),
  basis: z
    .enum(["gap", "pace", "power"])
    .nullable()
    .describe(
      "Basis decoupling_pct and efficiency_factor were computed on; null when both are intervals.icu's own values, whose basis it does not report",
    ),
  decoupling_pct: z.number(),
  decoupling_source: AerobicSourceEnum,
  interpretation: z.string(),
  /** m/min per beat on the gap and pace bases, W/beat on the power basis. */
  efficiency_factor: z.number(),
  efficiency_factor_source: AerobicSourceEnum,
  intensity_factor: z.number().nullable(),
  threshold_power_w: z.number().nullable(),
  intervals_icu: z
    .object({
      decoupling_pct: z.number().nullable(),
      efficiency_factor: z.number().nullable(),
    })
    .nullable()
    .describe(
      "intervals.icu's own values for the activity, kept apart from the computed ones: it does not report their basis or unit. Null when it has neither",
    ),
  breakdown: z
    .object({
      first_half: AerobicHalfSchema,
      second_half: AerobicHalfSchema,
      normalized_output: z
        .number()
        .describe(
          "m/s on the gap and pace bases, W (normalized power) on the power basis",
        ),
      normalized_pace_min_per_km: z.string().nullable(),
      moving_minutes: z.number(),
      excluded_stopped_minutes: z.number(),
      excluded_warmup_minutes: z.number(),
    })
    .nullable()
    .describe("Null when both values are intervals.icu's own (basis is null)"),
  units: z.object({
    pace: z.literal("min/km"),
    power: z.literal("W"),
    efficiency_factor: z.string(),
  }),
  warnings: z.array(z.string()),
});

// ---------- get-fitness-trend ----------
const FitnessTrendDaySchema = z.object({
  date: z.string().describe("ISO date YYYY-MM-DD the values were computed for"),
  load: z.number().describe("Total training load recorded that day"),
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
  daily_load: z.number().describe("Training load to average per day"),
  week_load: z.number().describe("Total training load for the week"),
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
    .describe("TSB the plan lands on; equals target_tsb unless clamped"),
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
    ends_today: z
      .boolean()
      .describe(
        "False for a past window (newest before today): no projection or taper",
      ),
  }),
  source: z
    .enum(["intervals.icu", "computed"])
    .describe(
      "'intervals.icu' for whole-body CTL/ATL read from wellness, 'computed' for the locally-computed run-only series",
    ),
  as_of: z
    .string()
    .nullable()
    .describe(
      "Date current/the projection seed are known for. For whole-body this can trail end_date when wellness has not synced yet; null when no data is available",
    ),
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
    .describe(
      "If projected: end_date when TSB is already ≥ 0 today, else the first projected date TSB reaches 0; null if it does not",
    ),
  taper: TaperPlanSchema.nullable().describe(
    "Solved load taper to the requested target date, or null if none was requested",
  ),
  activity_types_included: z
    .array(z.string())
    .describe(
      "Whole-body: distinct activity types with load in the window. Run-only: the run types (Run, TrailRun, VirtualRun); some types may count toward fatigue only, per intervals.icu settings",
    ),
  activities_included: z
    .number()
    .int()
    .describe(
      "Activities logged in the window. Whole-body: informational only (CTL/ATL is read from wellness, not summed from these). Run-only: the activities the series is built from",
    ),
  activities_missing_load: z
    .number()
    .int()
    .describe(
      "Of activities_included, how many have no icu_training_load recorded. Whole-body: informational only. Run-only: these contributed zero to the computed series",
    ),
  units: z.object({
    load: z.literal("intervals.icu training load"),
  }),
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
  pace_min_per_km: z.string().nullable(),
  gap_pace_sec_per_km: z
    .number()
    .nullable()
    .describe("Grade-adjusted (flat-equivalent) pace"),
  gap_pace_min_per_km: z.string().nullable(),
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
  gap_source: z
    .literal("model")
    .describe(
      "GAP here is locally modelled from grade, distinct from get-activity/compare-activities/get-activity-laps' gap_source: 'intervals.icu'",
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
      type: z
        .string()
        .describe(
          "heartrate (power zones are dropped for now; see docs/api-notes.md)",
        ),
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
  }),
});

/** Minimal slice of a written activity the mapper reads. */
interface WrittenActivityLike {
  id: string;
  name?: string | null;
  description?: string | null;
  gear?: { id?: string | null; name?: string | null } | null;
  icu_rpe?: number | null;
  feel?: number | null;
}

/** One field update-activity changed, echoing the pre-write and post-write
 * values (the post-write value comes from a fresh re-read). */
const ActivityWriteChangeSchema = z.object({
  field: z.string(),
  before: z.union([z.string(), z.number(), z.null()]),
  after: z.union([z.string(), z.number(), z.null()]),
  before_name: z
    .string()
    .nullable()
    .optional()
    .describe("Gear change only: the gear's name before the write"),
  after_name: z
    .string()
    .nullable()
    .optional()
    .describe("Gear change only: the name of the gear the activity now has"),
});

/**
 * update-activity's structured output: the activity as freshly re-read after
 * the write, the fields that actually changed, and any warnings (e.g. a
 * field whose re-read value does not match what was sent).
 *
 * `gearName` is passed separately because the activity payload never carries
 * the assigned gear's name (`gear.name` is always `null`; see
 * docs/api-notes.md). update-activity resolves it from the gear list for
 * every write, the fresh list when `gearId` was part of the request.
 */
export function toActivityWriteOutput(
  activity: WrittenActivityLike,
  changes: {
    field: string;
    before: string | number | null;
    after: string | number | null;
    before_name?: string | null;
    after_name?: string | null;
  }[],
  warnings: string[],
  gearName?: string | null,
) {
  return {
    activity_id: activity.id,
    name: activity.name ?? null,
    description: activity.description ?? null,
    gear_id: activity.gear?.id ?? null,
    gear_name:
      gearName !== undefined ? gearName : (activity.gear?.name ?? null),
    rpe: activity.icu_rpe ?? null,
    feel: activity.feel ?? null,
    changes,
    warnings,
    url: `https://intervals.icu/activities/${activity.id}`,
  };
}

export const ActivityWriteOutputSchema = z.object({
  activity_id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  gear_id: z.string().nullable(),
  gear_name: z.string().nullable(),
  rpe: z.number().nullable(),
  feel: z.number().nullable(),
  changes: z.array(ActivityWriteChangeSchema),
  warnings: z.array(z.string()),
  url: z.string().describe("intervals.icu web URL for the activity"),
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
  pace_min_per_km: z.string().nullable(),
  gap_pace_sec_per_km: z
    .number()
    .nullable()
    .describe("Grade-adjusted (flat-equivalent) pace per km"),
  gap_pace_min_per_km: z.string().nullable(),
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
    .enum(["grade_smooth", "computed", "none"])
    .describe(
      "grade_smooth when intervals.icu's smoothed-grade stream was used, computed when derived from altitude, none without elevation data (every grade-adjusted field is then null)",
    ),
  gap_source: z
    .literal("model")
    .describe(
      "GAP here is locally modelled from grade, distinct from get-activity/compare-activities/get-activity-laps' gap_source: 'intervals.icu'",
    ),
  verdict: z
    .object({
      shape: SplitShapeSchema.describe(
        "On the clock: positive = second half slower",
      ),
      gap_shape: SplitShapeSchema.nullable().describe(
        "Same, corrected for grade; null without elevation data",
      ),
      first_half_pace_sec_per_km: z.number(),
      second_half_pace_sec_per_km: z.number(),
      first_half_pace_min_per_km: z.string().nullable(),
      second_half_pace_min_per_km: z.string().nullable(),
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
    moving_time_source: movingTimeSourceField("streams"),
    intervals_icu_moving_time_s: z
      .number()
      .int()
      .nullable()
      .describe(
        "The activity's own moving_time, which get-activity and get-running-summary report; null when intervals.icu has none",
      ),
    elapsed_time_s: z.number().int(),
    elevation_gain_m: z
      .number()
      .nullable()
      .describe(
        "Total ascent in whole metres; null with neither a recorded value nor an altitude stream",
      ),
    elevation_gain_source: z
      .enum(["intervals.icu", "computed"])
      .nullable()
      .describe(
        "intervals.icu: the activity's own total_elevation_gain, as get-activity reports it; computed: summed from the altitude samples with a 3 m hysteresis",
      ),
    avg_pace_sec_per_km: z.number().nullable(),
    avg_pace_min_per_km: z.string().nullable(),
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
  pace_min_per_km: z.string().nullable(),
  avg_hr: z.number().nullable(),
  avg_cadence: z
    .number()
    .nullable()
    .describe("spm (doubled) for runs, rpm for rides"),
  avg_watts: z.number().nullable(),
  intensity_pct: z
    .number()
    .int()
    .nullable()
    .describe(
      "intervals.icu interval intensity: % of the sport's threshold (HR or pace, per the athlete's settings). Null for reps from streams or laps with no intensity",
    ),
});
const RepStructureSchema = z.object({
  rep_count: z
    .number()
    .int()
    .describe("Number of typical reps (within 20% of the median rep time)"),
  rep_time_s: z
    .number()
    .int()
    .describe("Median moving time of the typical reps"),
  rep_distance_m: z
    .number()
    .int()
    .describe("Median distance of the typical reps"),
  pace_sec_per_km: z
    .number()
    .int()
    .nullable()
    .describe("Total time over total distance of the typical reps"),
  pace_min_per_km: z.string().nullable(),
  avg_hr: z
    .number()
    .int()
    .nullable()
    .describe("Time-weighted across the typical reps"),
  intensity_pct: z
    .number()
    .int()
    .nullable()
    .describe(
      "Time-weighted intervals.icu interval intensity; null for reps from streams",
    ),
  pace_drift_pct: z
    .number()
    .nullable()
    .describe("Last typical rep against the first; positive = slower"),
  hr_drift_bpm: z
    .number()
    .nullable()
    .describe("Last typical rep against the first"),
});
const SimilarSessionSchema = RepStructureSchema.extend({
  activity_id: z.string(),
  name: z.string(),
  date: z.string().describe("Local start time"),
  type: z.string(),
  pace_delta_sec_per_km: z
    .number()
    .int()
    .nullable()
    .describe("pace_sec_per_km minus this_session's; positive = slower"),
  hr_delta_bpm: z
    .number()
    .int()
    .nullable()
    .describe("avg_hr minus this_session's; positive = higher"),
});
const SimilarSessionsSchema = z.object({
  status: z
    .enum(["found", "none_found", "not_intervals", "mixed_reps", "unavailable"])
    .describe(
      "not_intervals and mixed_reps make no search; unavailable: the search or the read of the candidates failed, and the rest of the response is still complete",
    ),
  reason: z
    .string()
    .nullable()
    .describe("Why sessions is empty; null when status is found"),
  this_session: RepStructureSchema.nullable().describe(
    "This activity's typical reps, the basis of every comparison",
  ),
  search: z
    .object({
      rep_time_min_s: z.number().int(),
      rep_time_max_s: z.number().int(),
      intensity_min_pct: z
        .number()
        .int()
        .nullable()
        .describe(
          "null: the reps carry no intensity, so any intensity was searched",
        ),
      intensity_max_pct: z.number().int().nullable(),
      rep_count_min: z.number().int(),
      rep_count_max: z.number().int(),
    })
    .nullable()
    .describe(
      "The band sent to intervals.icu's interval search; null when no search ran",
    ),
  candidates: z
    .number()
    .int()
    .describe("Earlier sessions of the same sport the search returned"),
  checked: z
    .number()
    .int()
    .describe("Candidates read and checked from their own laps, newest first"),
  skipped: z.object({
    no_clean_reps: z.number().int().describe("Laps show no clean reps"),
    different_reps: z
      .number()
      .int()
      .describe("Typical rep time or count differs"),
  }),
  sessions: z.array(SimilarSessionSchema).describe("Up to 5, newest first"),
});
export type SimilarSessionsOutput = z.infer<typeof SimilarSessionsSchema>;
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
      max_hr: z.number().describe("Max HR the share is measured against"),
      max_hr_source: z
        .enum(["athlete_max_hr", "hr_zones", "activity_peak"])
        .describe(
          "athlete_max_hr or the top icu_hr_zones bound; activity_peak (this run's own peak) is a fallback that cannot tell easy from hard",
        ),
      high_intensity_share_pct: z
        .number()
        .describe("% of moving time at ≥ 88% of max_hr"),
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
  similar: SimilarSessionsSchema.optional().describe(
    "Present only with findSimilar: true",
  ),
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
  pace_min_per_100m: swimPaceField(),
  speed_kmh: speedKmhField(),
  average_hr: z.number().nullable(),
  load: z.number().nullable().describe("icu_training_load"),
  gear_id: z.string().nullable(),
  source: z.string().nullable(),
  is_strava_stub: z
    .boolean()
    .describe(
      "True when source is STRAVA: details are unavailable through the API",
    ),
  tags: z.array(z.string()).describe("intervals.icu tags; empty when none"),
  race: z.boolean().describe("Marked as a race in intervals.icu"),
  achievement_types: z
    .array(z.string())
    .describe(
      "intervals.icu achievement types this activity set (BEST_PACE, BEST_POWER, LTHR_UP, FTP_UP); empty when none. get-activity has the detail",
    ),
});
export const ActivityListOutputSchema = z.object({
  oldest: z
    .string()
    .describe(
      "ISO date YYYY-MM-DD, inclusive lower bound: the window, or with search and no window the span the matches cover",
    ),
  newest: z
    .string()
    .describe(
      "ISO date YYYY-MM-DD, inclusive upper bound: the window, or with search and no window the span the matches cover",
    ),
  search: z
    .string()
    .nullable()
    .describe("The search query, or null for a date-window listing"),
  count: z.number().int().describe("Activities included in this response"),
  matched: z
    .number()
    .int()
    .describe("Activities matching the filters before limit truncated them"),
  truncated: z.boolean().describe("True when matched > limit"),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    swim_pace: z.literal("min/100m"),
    speed: z.literal("km/h"),
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
const AchievementSchema = z.object({
  type: z
    .string()
    .describe(
      "intervals.icu achievement type: BEST_PACE, BEST_POWER, LTHR_UP or FTP_UP. LTHR_UP and FTP_UP concern the sport settings of this activity's type: a swim's LTHR_UP is about the swim LTHR, not the run LTHR",
    ),
  message: z
    .string()
    .nullable()
    .describe('intervals.icu\'s own summary, e.g. "1h at 172 bpm"'),
  value: z
    .number()
    .nullable()
    .describe(
      "intervals.icu's value as sent. For LTHR_UP, the LTHR in bpm that intervals.icu estimated from this effort, above the LTHR this activity was analysed with. It does not show that the sport settings changed",
    ),
  duration_s: z
    .number()
    .nullable()
    .describe("Length of the effort behind it, in seconds"),
  distance_m: z
    .number()
    .nullable()
    .describe("Distance of the effort in metres, when intervals.icu sends one"),
  watts: z
    .number()
    .nullable()
    .describe(
      "Power of the effort in W, as sent (BEST_POWER, FTP_UP); not seen live",
    ),
  pace_mps: z
    .number()
    .nullable()
    .describe(
      "Pace of the effort as sent, a speed in m/s like intervals.icu's other pace fields (BEST_PACE); not seen live",
    ),
});
const HrRecoverySchema = z.object({
  drop_bpm: z
    .number()
    .describe("HR fall across the window: start_bpm minus end_bpm"),
  start_bpm: z.number(),
  end_bpm: z.number(),
  window_s: z
    .number()
    .nullable()
    .describe("Window length in seconds; 60 on every activity checked"),
  start_time_s: z
    .number()
    .nullable()
    .describe("Where the window starts, in seconds from the activity start"),
});
const ActivityIntervalEntrySchema = z.object({
  type: z.string().nullable().describe("e.g. WORK, RECOVERY"),
  label: z.string().nullable(),
  distance_km: z.number().nullable(),
  moving_time_s: z.number().int().nullable(),
  moving_time_source: movingTimeSourceField("lap"),
  pace_min_per_km: z.string().nullable().describe("Set for runs only"),
  pace_min_per_100m: swimIntervalPaceField(),
  speed_kmh: speedKmhField(),
  average_hr: z.number().nullable(),
  average_cadence_spm: z
    .number()
    .nullable()
    .describe("Strides doubled to steps/min, runs only"),
  stance_time_ms: z
    .number()
    .nullable()
    .describe("Ground contact time, ms; runs, walks and hikes only"),
  vertical_oscillation_mm: z
    .number()
    .nullable()
    .describe("mm; runs, walks and hikes only"),
  step_length_mm: z
    .number()
    .nullable()
    .describe("mm; runs, walks and hikes only"),
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
  moving_time_source: movingTimeSourceField("intervals.icu"),
  elapsed_time_s: z.number().int().nullable(),
  pace_min_per_km: z
    .string()
    .nullable()
    .describe("Set for Run/TrailRun/VirtualRun only"),
  pace_min_per_100m: swimPaceField(),
  speed_kmh: speedKmhField(),
  gap_min_per_km: z
    .string()
    .nullable()
    .describe(
      "Grade-adjusted pace, from the activity's gap field (m/s, same unit as average_speed); runs only",
    ),
  gap_source: z
    .literal("intervals.icu")
    .describe(
      "GAP here is intervals.icu's own gap field, distinct from get-hill-analysis/get-split-analysis's locally-modelled GAP",
    ),
  average_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  average_cadence_spm: z
    .number()
    .nullable()
    .describe("Strides doubled to steps/min, runs only"),
  elevation_gain_m: z.number().nullable(),
  pool_length_m: z
    .number()
    .nullable()
    .describe("Pool length in metres; pool swims only"),
  lengths: z
    .number()
    .int()
    .nullable()
    .describe("Pool lengths swum; pool swims only"),
  load: ActivityLoadSchema,
  decoupling_pct: z.number().nullable(),
  efficiency_factor: z.number().nullable(),
  rpe: z.number().nullable(),
  feel: z.number().nullable(),
  achievements: z
    .array(AchievementSchema)
    .describe(
      "Bests and threshold rises intervals.icu marked on this activity; empty when none",
    ),
  hr_recovery: HrRecoverySchema.nullable().describe(
    "intervals.icu's heart-rate recovery: the HR drop over a window it picked in this activity (60 s on every activity checked). The window can start before an effort ends; null when it found none",
  ),
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
      "From the athlete's gear list (list-gear's source, cached 10 minutes); the activity sends only the gear id. Null when the activity has no gear or the gear read fails",
    ),
  weather_temp_c: z.number().nullable(),
  description: z.string().nullable(),
  units: z.object({
    distance: z.literal("km"),
    pace: z.literal("min/km"),
    swim_pace: z.literal("min/100m"),
    speed: z.literal("km/h"),
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
  time_seconds: z
    .number()
    .describe("Elapsed seconds across the stretch; a stop inside it counts"),
  time_formatted: z.string(),
  pace_min_per_km: z.string().nullable(),
  distance_m: z
    .number()
    .describe(
      "Metres the time covers: the requested distance with id, or over a window the matched curve point",
    ),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  activity_id: z.string(),
  activity_name: z.string(),
  race: z.boolean(),
  start_km: z
    .number()
    .nullable()
    .describe(
      "With id: km into the run where the stretch starts; null over a window",
    ),
  end_km: z
    .number()
    .nullable()
    .describe(
      "With id: km into the run where the stretch ends; null over a window",
    ),
  stopped_seconds: z
    .number()
    .int()
    .nullable()
    .describe(
      "With id: seconds of the time spent stopped (an auto-pause gap, or speed under 0.5 m/s); null over a window",
    ),
});
export const BestEffortsOutputSchema = z.object({
  mode: z
    .enum(["window", "activity"])
    .describe(
      '"window" searched your history; "activity" searched the one run in activity',
    ),
  window: z
    .object({
      id: z.string().describe('"all", "1y", "90d", or "r.<oldest>.<newest>"'),
      oldest: z.string().describe("ISO date YYYY-MM-DD"),
      newest: z.string().describe("ISO date YYYY-MM-DD"),
    })
    .nullable()
    .describe("The searched range; null with id"),
  activity: z
    .object({
      id: z.string(),
      name: z.string(),
      date: z.string().describe("ISO date YYYY-MM-DD"),
      type: z.string(),
      covered_km: z
        .number()
        .describe(
          "Distance the run's distance stream covers, km, rounded down",
        ),
    })
    .nullable()
    .describe("The searched run; null over a window"),
  top_n: z.number().int(),
  units: z.object({
    time: z.literal("s"),
    pace: z.literal("min/km"),
  }),
  note: z
    .string()
    .describe(
      "Time basis: elapsed time across the fastest stretch (intervals.icu's pace-curve rule); a stop inside it counts",
    ),
  best_efforts: z.record(z.string(), z.array(BestEffortEntrySchema)),
  missing: z
    .array(z.string())
    .describe(
      "Requested distances with no result: over a window, no curve point within tolerance (2% of the target or 50m, whichever is larger); with id, longer than the run or only inside parts marked to ignore for pace",
    ),
  warnings: z.array(z.string()),
});

// ---------- get-race-prediction ----------
const PredictionSourceSchema = z.object({
  name: z.string().describe("A label for the effort, e.g. '5000 m'"),
  distance_m: z.number(),
  time_seconds: z.number().int(),
  time_formatted: z.string(),
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
    pace_sec_per_km: z.number().nullable(),
    pace_min_per_km: z.string().nullable(),
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
  pace_sec_per_km: z.number().nullable(),
  pace_min_per_km: z.string().nullable(),
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
  pace_sec_per_km: z.number().describe("Pace over this split, per full km"),
  pace_min_per_km: z.string().describe("Pace over this split, per full km"),
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
      pace_sec_per_km: z.number().nullable(),
      pace_min_per_km: z.string().nullable(),
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
  units: z.object({
    distance: z.literal("m"),
    pace: z.literal("min/km"),
    time: z.literal("s"),
  }),
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
  moving_time_source: movingTimeSourceField("lap"),
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
  gap_source: z
    .literal("intervals.icu")
    .describe(
      "GAP here is intervals.icu's own gap field, distinct from get-hill-analysis/get-split-analysis's locally-modelled GAP",
    ),
  pace_min_per_100m: swimIntervalPaceField(),
  speed_kmh: speedKmhField(),
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
    swim_pace: z.literal("min/100m"),
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
  max_bpm: z
    .number()
    .nullable()
    .describe("null only for an open-ended top bucket"),
  seconds: z.number().int(),
  percent: z.number().describe("Share of recorded zone time, 1 dp"),
});
const AerobicSourceSchema = z
  .enum(["intervals.icu", "computed"])
  .nullable()
  .describe(
    "intervals.icu: its own value (basis not reported); computed: from the streams, as get-aerobic-analysis computes it, because intervals.icu has none; null when there is no value",
  );
export const RunningSummaryOutputSchema = ActivityDetailOutputSchema.omit({
  intervals: true,
}).extend({
  decoupling_source: AerobicSourceSchema,
  efficiency_factor_source: AerobicSourceSchema,
  aerobic_basis: z
    .enum(["gap", "pace"])
    .nullable()
    .describe(
      "Basis of the computed values: gap (grade-adjusted; efficiency factor in m/min per beat) or pace when the activity has no elevation data; null when nothing was computed",
    ),
  aerobic_note: z
    .string()
    .nullable()
    .describe(
      "Why a missing value was not computed (no streams, no heart rate), or a warning on the computed values",
    ),
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

// ---------- get-running-dynamics ----------
const DynamicsStatusSchema = z.union([
  z.literal("within"),
  z.literal("high"),
  z.literal("low"),
]);
const DynamicsMetricAssessmentSchema = z.object({
  value: z.number().nullable(),
  target: z.string(),
  status: DynamicsStatusSchema.nullable().describe("Null when value is null"),
  message: z.string().nullable(),
});
const RunningDynamicsAveragesSchema = z.object({
  stance_time_ms: z.number().nullable(),
  vertical_oscillation_mm: z.number().nullable(),
  vertical_ratio_pct: z
    .number()
    .nullable()
    .describe("No assessed status; reported for context only"),
  step_length_mm: z.number().nullable(),
  stride_m: z.number().nullable(),
  cadence_spm: z.number().nullable(),
});
const RunningDynamicsIntervalRowSchema = z.object({
  lap_index: z
    .number()
    .int()
    .describe("1-based position in icu_intervals, WORK rows only"),
  label: z.string().nullable(),
  distance_km: z.number().nullable(),
  pace_sec_per_km: z.number().nullable(),
  pace_min_per_km: z.string().nullable(),
  stance_time_ms: z.number().nullable(),
  stance_time_status: DynamicsStatusSchema.nullable(),
  vertical_oscillation_mm: z.number().nullable(),
  vertical_oscillation_status: DynamicsStatusSchema.nullable(),
  vertical_ratio_pct: z.number().nullable(),
  step_length_mm: z.number().nullable(),
  stride_m: z.number().nullable(),
  cadence_spm: z.number().nullable(),
});
export const RunningDynamicsOutputSchema = z.object({
  activity_id: z.string(),
  activity_name: z.string(),
  type: z.string(),
  has_dynamics: z.boolean(),
  message: z
    .string()
    .nullable()
    .describe("Set when the device/activity type recorded no running dynamics"),
  averages: RunningDynamicsAveragesSchema.nullable(),
  assessments: z
    .object({
      vertical_oscillation: DynamicsMetricAssessmentSchema,
      ground_contact_time: DynamicsMetricAssessmentSchema,
    })
    .nullable(),
  intervals: z
    .array(RunningDynamicsIntervalRowSchema)
    .describe("WORK intervals only; empty when includeIntervals is false"),
  units: z.object({
    stance_time: z.literal("ms"),
    vertical_oscillation: z.literal("mm"),
    vertical_ratio: z.literal("%"),
    step_length: z.literal("mm"),
    stride: z.literal("m"),
    cadence: z.literal("spm"),
    pace: z.literal("min/km"),
  }),
});

// ---------- get-athlete-zones ----------
const AthleteHrZoneSchema = z.object({
  zone: z.number().int().describe("1-based zone number"),
  name: z.string().nullable(),
  min_bpm: z
    .number()
    .describe(
      "The previous zone's upper bound; this zone starts above it. 0 for zone 1",
    ),
  max_bpm: z.number().describe("Upper bound, inclusive"),
});
const AthletePaceZoneSchema = z.object({
  zone: z.number().int().describe("1-based zone number"),
  name: z.string().nullable(),
  min_pct: z
    .number()
    .describe("% of threshold speed where the zone starts; 0 for zone 1"),
  max_pct: z
    .number()
    .nullable()
    .describe(
      "% of threshold speed where the zone ends; null for the open top zone",
    ),
  slowest_min_per_km: z
    .string()
    .nullable()
    .describe(
      "Pace at min_pct, m:ss; null for zone 1 or with no threshold pace",
    ),
  fastest_min_per_km: z
    .string()
    .nullable()
    .describe(
      "Pace at max_pct, m:ss; null for the top zone or with no threshold pace",
    ),
  slowest_min_per_100m: z
    .string()
    .nullable()
    .describe("As slowest_min_per_km, per 100 m; swim groups only"),
  fastest_min_per_100m: z
    .string()
    .nullable()
    .describe("As fastest_min_per_km, per 100 m; swim groups only"),
});
const HrCurveWindowSchema = z
  .enum(["90d", "1y"])
  .describe("intervals.icu HR curve: the last 90 days or the last year");
const HrBestSchema = z.object({
  window: HrCurveWindowSchema,
  duration_s: z.number().int(),
  bpm: z.number().describe("Best average heart rate over duration_s"),
  activity_id: z.string().nullable(),
  date: z
    .string()
    .nullable()
    .describe("Local start date of that activity, YYYY-MM-DD"),
});
const ThresholdCheckSchema = z.object({
  status: z
    .enum(["above", "not_above", "unknown"])
    .describe(
      "above: the estimate is above the setting, which may be out of date. not_above does not show that the setting is too high",
    ),
  setting_bpm: z.number().nullable(),
  estimate_bpm: z
    .number()
    .nullable()
    .describe("What the heart rate bests point to; null when not known"),
  basis: HrBestSchema.nullable().describe(
    "The heart rate best behind estimate_bpm",
  ),
  message: z.string(),
});
export const AthleteZonesOutputSchema = z.object({
  sport: z.string().describe("Activity type the settings were matched on"),
  settings_types: z
    .array(z.string())
    .describe("Every activity type this settings group covers"),
  default_group: z
    .boolean()
    .describe(
      "True when no group lists the sport and intervals.icu's default Other group applies",
    ),
  lthr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  hr_zones: z.array(AthleteHrZoneSchema),
  threshold_speed_mps: z
    .number()
    .nullable()
    .describe("intervals.icu's threshold_pace, which is a speed in m/s"),
  threshold_pace_min_per_km: z.string().nullable().describe("m:ss per km"),
  threshold_pace_min_per_100m: z
    .string()
    .nullable()
    .describe("m:ss per 100 m; swim groups only"),
  pace_units: z
    .string()
    .nullable()
    .describe(
      "The athlete's pace display setting in intervals.icu, e.g. MINS_KM or SECS_100M",
    ),
  pace_zones: z.array(AthletePaceZoneSchema),
  ftp_watts: z.number().nullable(),
  hr_bests: z
    .array(HrBestSchema)
    .describe(
      "Best 20-, 30- and 60-min heart rate of the last 90 days and best 60-s of the last year, when known",
    ),
  threshold_checks: z.object({
    lthr: ThresholdCheckSchema.describe(
      "intervals.icu's own rule: the higher of the best 60-min HR and 98% of the best 20-min HR, last 90 days",
    ),
    max_hr: ThresholdCheckSchema.describe(
      "The best 60-s HR of the last year against max HR",
    ),
  }),
  other_groups: z
    .array(z.array(z.string()))
    .describe("The types of each other settings group"),
  warnings: z.array(z.string()),
  units: z.object({
    hr: z.literal("bpm"),
    time: z.literal("s"),
    pace: z.literal("min/km"),
    swim_pace: z.literal("min/100m"),
    power: z.literal("W"),
    pace_zones: z.literal("% of threshold speed"),
  }),
});
