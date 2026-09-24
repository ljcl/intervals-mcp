/**
 * Running-specific utility functions for transforming Strava data.
 *
 * These functions address common issues with Strava's API:
 * - Cadence is returned as strides/min but runners think in steps/min
 * - Speed is returned as m/s but runners think in pace (min/km or min/mile)
 */

import { formatDuration } from "../formatters";

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
 * Cadence transformation result.
 */
export interface CadenceResult {
  raw: number;
  spm: number | null; // steps per minute (running)
  rpm: number | null; // revolutions per minute (cycling)
  display: string;
}

/**
 * Transform cadence based on activity type.
 * Running activities get doubled to show steps per minute (Strava returns strides).
 */
export function transformCadence(
  rawCadence: number | null | undefined,
  activityType: string,
): CadenceResult | null {
  if (rawCadence === null || rawCadence === undefined) {
    return null;
  }

  if (isRunningActivity(activityType)) {
    const spm = rawCadence * 2;
    return {
      raw: rawCadence,
      spm,
      rpm: null,
      display: `${Math.round(spm)} spm`,
    };
  }

  // Cycling, swimming, etc. - return as-is
  return {
    raw: rawCadence,
    spm: null,
    rpm: rawCadence,
    display: `${Math.round(rawCadence)} rpm`,
  };
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
 * Format seconds as M:SS pace string.
 */
function formatPaceString(totalSeconds: number): string {
  // Round first, then split, so 359.5s carries into 6:00 rather than
  // flooring to 5 minutes and rounding the remainder to an invalid ":60".
  const rounded = Math.round(totalSeconds);
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
    minPerKm: formatPaceString(secondsPerKm),
    minPerKmRaw: Math.round((secondsPerKm / 60) * 100) / 100,
    minPerMile: formatPaceString(secondsPerMile),
    minPerMileRaw: Math.round((secondsPerMile / 60) * 100) / 100,
    display: `${formatPaceString(secondsPerKm)} /km`,
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
 * hikes, matching {@link RUNNING_ACTIVITY_TYPES} above (the Strava-era set
 * `transformCadence` already uses) rather than {@link PACE_ACTIVITY_TYPES}.
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
 * Power-to-weight result.
 */
export interface WattsPerKgResult {
  watts: number;
  weightKg: number;
  wattsPerKg: number;
  intensity: "easy" | "moderate" | "tempo" | "high";
}

/**
 * Compute power-to-weight ratio.
 * Returns null if either value is missing or invalid.
 */
export function computeWattsPerKg(
  watts: number | null | undefined,
  weightKg: number | null | undefined,
): WattsPerKgResult | null {
  if (!watts || !weightKg || weightKg <= 0) {
    return null;
  }

  const wattsPerKg = watts / weightKg;

  // Basic intensity interpretation for running
  let intensity: WattsPerKgResult["intensity"];
  if (wattsPerKg < 3.0) {
    intensity = "easy";
  } else if (wattsPerKg < 4.0) {
    intensity = "moderate";
  } else if (wattsPerKg < 5.0) {
    intensity = "tempo";
  } else {
    intensity = "high";
  }

  return {
    watts: Math.round(watts * 10) / 10,
    weightKg: Math.round(weightKg * 10) / 10,
    wattsPerKg: Math.round(wattsPerKg * 100) / 100,
    intensity,
  };
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
 * Heart rate zone boundaries from athlete profile.
 */
export interface ZoneBoundary {
  min: number;
  max: number;
}

/**
 * Determine which HR zone a heart rate falls into.
 */
export function getZoneForHr(
  hr: number,
  zoneBoundaries: ZoneBoundary[],
): number {
  for (let i = 0; i < zoneBoundaries.length; i += 1) {
    const zone = zoneBoundaries[i]!;
    const zoneMin = zone.min ?? 0;
    const zoneMax = zone.max ?? 999;
    // Handle Strava's -1 for unbounded max
    const effectiveMax = zoneMax === -1 ? 999 : zoneMax;

    if (hr >= zoneMin && hr < effectiveMax) {
      return i + 1;
    }
  }
  return 5; // Default to zone 5 if above all boundaries
}

/**
 * Time-in-zone result for a single zone.
 */
export interface ZoneTime {
  seconds: number;
  formatted: string;
  percentage: number;
}

/**
 * Complete time-in-zones result.
 */
export interface TimeInZonesResult {
  totalTimeSeconds: number;
  zones: {
    zone_1: ZoneTime;
    zone_2: ZoneTime;
    zone_3: ZoneTime;
    zone_4: ZoneTime;
    zone_5: ZoneTime;
  };
  distribution: {
    easy_1_2: number;
    moderate_3: number;
    hard_4_5: number;
  };
}

/**
 * Compute time spent in each heart rate zone.
 */
export function computeTimeInZones(
  hrStream: number[],
  timeStream: number[],
  zoneBoundaries: ZoneBoundary[],
): TimeInZonesResult | null {
  if (
    !hrStream ||
    !timeStream ||
    hrStream.length !== timeStream.length ||
    hrStream.length < 2 ||
    !zoneBoundaries ||
    zoneBoundaries.length === 0
  ) {
    return null;
  }

  const zones: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (let i = 1; i < hrStream.length; i += 1) {
    const hr = hrStream[i]!;
    const timeDelta = timeStream[i]! - timeStream[i - 1]!;
    const zone = getZoneForHr(hr, zoneBoundaries);
    zones[zone]! += timeDelta;
  }

  const totalTime = Object.values(zones).reduce((a, b) => a + b, 0);

  if (totalTime <= 0) {
    return null;
  }

  const makeZoneTime = (seconds: number): ZoneTime => ({
    seconds,
    formatted: formatDuration(seconds),
    percentage: Math.round((seconds / totalTime) * 1000) / 10,
  });

  return {
    totalTimeSeconds: totalTime,
    zones: {
      zone_1: makeZoneTime(zones[1]!),
      zone_2: makeZoneTime(zones[2]!),
      zone_3: makeZoneTime(zones[3]!),
      zone_4: makeZoneTime(zones[4]!),
      zone_5: makeZoneTime(zones[5]!),
    },
    distribution: {
      easy_1_2: Math.round(((zones[1]! + zones[2]!) / totalTime) * 1000) / 10,
      moderate_3: Math.round((zones[3]! / totalTime) * 1000) / 10,
      hard_4_5: Math.round(((zones[4]! + zones[5]!) / totalTime) * 1000) / 10,
    },
  };
}
