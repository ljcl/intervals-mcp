/**
 * Running-specific utility functions for transforming Strava data.
 *
 * These functions address common issues with Strava's API:
 * - Cadence is returned as strides/min but runners think in steps/min
 * - Speed is returned as m/s but runners think in pace (min/km or min/mile)
 */
import { round } from "../formatters";
import { type IntervalsActivity } from "../intervalsClient";

/** Activity types that use steps-per-minute cadence */
export const RUNNING_ACTIVITY_TYPES = [
  "Run",
  "VirtualRun",
  "TrailRun",
  "Walk",
  "Hike",
];

/**
 * Check if an activity type is a running activity.
 */
export function isRunningActivity(activityType: string): boolean {
  return RUNNING_ACTIVITY_TYPES.includes(activityType);
}

/**
 * Pace conversion result.
 */
export interface PaceResult {
  metersPerSecond: number;
  kmh: number;
  minPerKm: string;
  minPerKmRaw: number; // decimal minutes for calculations
  minPerMile: string;
  minPerMileRaw: number;
  display: string;
}

/**
 * Formats a pace given in seconds-per-kilometre as `m:ss`, rounding to the
 * nearest second first so a value like 299.6 carries into `5:00` rather than
 * flooring to 4 minutes and rendering an invalid `4:60`.
 *
 * The one home for seconds -> pace-string formatting: {@link metersPerSecToPace}
 * and (transitively) {@link paceFromDistanceTime} both render their `m:ss`
 * strings through this function rather than each rounding independently.
 *
 * Null-safe by returning a value, never throwing or emitting `NaN:NaN`: zero
 * or a non-finite input (`NaN`, `Infinity`, `-Infinity`) returns `"0:00"`.
 * Callers that need to distinguish "no pace" from a genuine zero pace decide
 * that before calling this, the same way {@link metersPerSecToPace} already
 * returns `null` for `mps <= 0` instead of calling through.
 */
export function formatPaceSeconds(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "0:00";
  const rounded = Math.round(secPerKm);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Convert meters per second to running pace formats.
 * Returns null if speed is zero or invalid.
 */
export function metersPerSecToPace(
  mps: number | null | undefined,
): PaceResult | null {
  if (mps === null || mps === undefined || mps <= 0) {
    return null;
  }

  const secondsPerKm = 1000 / mps;
  const secondsPerMile = 1609.34 / mps;

  return {
    metersPerSecond: Math.round(mps * 100) / 100,
    kmh: Math.round(mps * 3.6 * 10) / 10,
    minPerKm: formatPaceSeconds(secondsPerKm),
    minPerKmRaw: Math.round((secondsPerKm / 60) * 100) / 100,
    minPerMile: formatPaceSeconds(secondsPerMile),
    minPerMileRaw: Math.round((secondsPerMile / 60) * 100) / 100,
    display: `${formatPaceSeconds(secondsPerKm)} /km`,
  };
}

/**
 * Activity types intervals.icu reports a pace string for: runs only, not
 * walks or hikes (those get a cadence but no pace_min_per_km in the
 * intervals.icu tools). Distinct from {@link STEP_CADENCE_ACTIVITY_TYPES}
 * below on purpose; see that set's comment.
 */
export const PACE_ACTIVITY_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

/**
 * Activity types whose cadence (and step-based running dynamics: ground
 * contact time, vertical oscillation, step length, stride) intervals.icu
 * tools report in steps/min, doubled from strides/min: runs, plus walks and
 * hikes, matching {@link RUNNING_ACTIVITY_TYPES} above (the same
 * Strava-era set) rather than {@link PACE_ACTIVITY_TYPES}.
 * A Walk or Hike has a step cadence worth doubling even though intervals.icu
 * doesn't compute a pace for it.
 */
export const STEP_CADENCE_ACTIVITY_TYPES = new Set([
  "Run",
  "TrailRun",
  "VirtualRun",
  "Walk",
  "Hike",
]);

/** True when `type` gets a pace string (Run/TrailRun/VirtualRun only). */
export function isPaceActivity(type: string): boolean {
  return PACE_ACTIVITY_TYPES.has(type);
}

/**
 * True when `type` reports cadence (and step-based dynamics) in steps/min,
 * doubled from strides/min: Run/TrailRun/VirtualRun/Walk/Hike.
 */
export function isStepCadenceActivity(type: string): boolean {
  return STEP_CADENCE_ACTIVITY_TYPES.has(type);
}

/**
 * Cadence in the unit `type` reports it in: strides/min doubled to
 * steps/min for a step-cadence type (see {@link isStepCadenceActivity}), or
 * the raw rate unchanged for anything else (cycling rpm, a swim's stroke
 * rate, ...). `null` when `strides` is missing.
 *
 * The one home for the strides-to-steps doubling used by the intervals.icu
 * tools' own cadence fields: `get-activity`'s activity- and interval-level
 * `average_cadence_spm`, and `get-activity-streams`' `cadence` stream. Both
 * previously hand-rolled this (a bespoke `cadenceSpm` in getActivity.ts, an
 * inline `v * 2` in getActivityStreams.ts) against two different activity-type
 * sets, so a Walk's cadence was doubled in one tool and left as raw
 * strides/min in the other. Doubling here does not gate on the field being
 * present *at all* for a non-step-cadence type; a caller like `get-activity`
 * that wants `null` rather than a mislabelled raw rate for those types (e.g.
 * a swim's stroke rate is not steps/min) checks {@link isStepCadenceActivity}
 * itself before deciding whether to call this.
 */
export function cadenceSpm(
  strides: number | null | undefined,
  type: string,
): number | null {
  if (strides == null) return null;
  return isStepCadenceActivity(type) ? strides * 2 : strides;
}

/**
 * Pace as an `m:ss` string from distance (metres) and moving time (seconds),
 * or `null` when either is missing or non-positive. Does not gate on
 * activity type: a caller decides whether `type` should show a pace at all
 * via {@link isPaceActivity} before calling this, the same way
 * {@link cadenceSpm}'s callers decide with {@link isStepCadenceActivity}.
 *
 * The one home for distance/time -> pace-string, shared by `list-activities`
 * (which previously computed the m/s intermediate inline) and `get-activity`
 * (activity- and interval-level, which previously had its own `pace()`).
 */
export function paceFromDistanceTime(
  distanceM: number | null | undefined,
  movingTimeS: number | null | undefined,
): string | null {
  if (!distanceM || distanceM <= 0 || !movingTimeS || movingTimeS <= 0) {
    return null;
  }
  return metersPerSecToPace(distanceM / movingTimeS)?.minPerKm ?? null;
}

/**
 * Grade-adjusted pace from an activity's or interval's `gap` field (m/s,
 * the same unit as `average_speed`, both typed on `IntervalsActivity`/
 * `IntervalsInterval` in `intervalsClient.ts`). This is undocumented by the
 * spec, but confirmed against the fixture: the activity's `gap` (3.478)
 * sits in the same range as its `average_speed` (3.384), and each interval's
 * `gap` tracks its `average_speed` up or down with the interval's grade, the
 * signature of a grade-adjusted speed, not a pace-per-metre value. Converted
 * with the same `metersPerSecToPace` used for on-the-clock pace.
 *
 * `null` for a non-pace activity type (see {@link isPaceActivity}), the same
 * way {@link paceFromDistanceTime} gates on distance/time being present: a
 * grade-adjusted pace is meaningless for a sport that doesn't get an
 * on-the-clock pace either.
 *
 * The one home for this transform, shared by `get-activity` (activity-level
 * `gap_min_per_km`), `intervalLaps.ts` (per-lap `gap_min_per_km`, shared by
 * `get-activity-laps` and `get-running-summary`), and `compare-activities`
 * (per-side `gap_min_per_km`), which previously each hand-rolled an
 * identical copy.
 */
export function gapPace(
  gapMps: number | null | undefined,
  type: string,
): string | null {
  if (!isPaceActivity(type) || gapMps == null) return null;
  return metersPerSecToPace(gapMps)?.minPerKm ?? null;
}

/**
 * Cadence assessment for running.
 */
export function assessCadence(spm: number | null | undefined): string | null {
  if (spm === null || spm === undefined) {
    return null;
  }

  if (spm < 160) {
    return "low - consider increasing for efficiency";
  }
  if (spm < 170) {
    return "moderate - room for improvement";
  }
  if (spm < 180) {
    return "good";
  }
  if (spm < 190) {
    return "very good";
  }
  return "excellent";
}

/**
 * Cadence in steps/min (doubled from intervals.icu's strides/min for a
 * step-cadence type, see {@link isStepCadenceActivity}), rounded to a whole
 * step, or `null` for a non-step-cadence type.
 *
 * The one home for this field, shared by `get-activity`'s activity- and
 * interval-level `average_cadence_spm` and `compare-activities`' per-side
 * `cadence_spm`, which each previously hand-rolled an identical copy.
 */
export function activityCadenceSpm(
  rawCadence: number | null | undefined,
  type: string,
): number | null {
  if (!isStepCadenceActivity(type)) return null;
  const spm = cadenceSpm(rawCadence, type);
  return spm == null ? null : Math.round(spm);
}

/** `within` the target (VO's only band, or GCT's middle band); `high`/`low`
 * on the wrong side of a target or range. */
export type DynamicsStatus = "within" | "high" | "low";

export interface DynamicsMetricAssessment {
  status: DynamicsStatus;
  target: string;
  message: string;
}

export interface RunningDynamicsAssessment {
  vertical_oscillation: DynamicsMetricAssessment | null;
  ground_contact_time: DynamicsMetricAssessment | null;
}

/** Vertical oscillation target from the spec: under 100 mm. */
function assessVerticalOscillation(
  voMm: number | null,
): DynamicsMetricAssessment | null {
  if (voMm == null) return null;
  return voMm < 100
    ? {
        status: "within",
        target: "under 100 mm",
        message: "good - under the 100 mm target",
      }
    : {
        status: "high",
        target: "under 100 mm",
        message: "high - above the 100 mm target",
      };
}

/** Ground contact time target range from the spec: 200-260 ms. */
function assessGroundContactTime(
  gctMs: number | null,
): DynamicsMetricAssessment | null {
  if (gctMs == null) return null;
  if (gctMs < 200)
    return {
      status: "low",
      target: "200-260 ms",
      message: "fast - below the 200-260 ms target range",
    };
  if (gctMs <= 260)
    return {
      status: "within",
      target: "200-260 ms",
      message: "good - within the 200-260 ms target range",
    };
  return {
    status: "high",
    target: "200-260 ms",
    message: "long - above the 200-260 ms target range",
  };
}

/**
 * Vertical oscillation and ground contact time target assessments, the one
 * home for these thresholds (VO under 100 mm; GCT 200-260 ms). Shared by
 * `get-running-summary` (which renders only `.message`) and
 * `get-running-dynamics` (which also uses `.status`/`.target`); each metric
 * is `null` when its input is `null` rather than the pair being all-or-
 * nothing, since a device can report one dynamic without the other.
 */
export function assessRunningDynamics(
  voMm: number | null,
  gctMs: number | null,
): RunningDynamicsAssessment {
  return {
    vertical_oscillation: assessVerticalOscillation(voMm),
    ground_contact_time: assessGroundContactTime(gctMs),
  };
}

export interface RunningDynamicsAvg {
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
}

/**
 * Averaged running-dynamics fields (ground contact time, vertical
 * oscillation/ratio, step length, stride), present only for a step-cadence
 * type with device support (`average_stance_time` recorded). `null`
 * otherwise, rather than an object of nulls.
 *
 * The one home for this shape, shared by `get-activity` and
 * `compare-activities`, which each previously hand-rolled an identical copy.
 */
export function buildRunningDynamics(
  a: IntervalsActivity,
  type: string,
): RunningDynamicsAvg | null {
  if (!isStepCadenceActivity(type) || a.average_stance_time == null)
    return null;
  return {
    stance_time_ms: round(a.average_stance_time),
    vertical_oscillation_mm:
      a.average_vertical_oscillation == null
        ? null
        : round(a.average_vertical_oscillation),
    vertical_ratio_pct:
      a.average_vertical_ratio == null
        ? null
        : round(a.average_vertical_ratio, 1),
    step_length_mm:
      a.average_step_length == null ? null : round(a.average_step_length),
    stride_m: a.average_stride == null ? null : round(a.average_stride, 2),
  };
}
