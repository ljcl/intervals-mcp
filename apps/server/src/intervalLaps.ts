/**
 * Maps intervals.icu `icu_intervals` to lap entries, the one home for this
 * transform. intervals.icu has no lap list of its own: `icu_intervals`
 * (fetched via `getActivity(apiKey, id, { intervals: true })`) is what
 * mirrors the device's laps, usually one WORK interval per recorded lap plus
 * any auto-inserted RECOVERY between them (a 12-lap run can come back as 18
 * intervals; see docs/api-notes.md). `get-activity-laps` is the first
 * consumer; a later phase's activity-chart lap markers reuse this same
 * mapper rather than re-deriving laps from intervals a second time.
 */
import { formatDuration, round } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import {
  cadenceSpm,
  gapPace,
  isPaceActivity,
  isStepCadenceActivity,
  paceFromDistanceTime,
  sportSpeed,
} from "./utils/running";

/**
 * The text note for swim intervals and laps. intervals.icu counts the rests
 * at the wall inside a swim interval as moving time (its `moving_time`
 * equals its `elapsed_time`), while the activity's `moving_time` leaves them
 * out. So an interval's pace per 100 m can be slower than every pace the
 * activity line shows (docs/api-notes.md). Shared by get-activity and
 * get-activity-laps.
 */
export const SWIM_INTERVAL_PACE_NOTE =
  "swim paces include the rests inside each interval";

/**
 * The text note for every lap and interval list. intervals.icu's moving time
 * for a lap follows its own rule, so the laps can add up to more or less
 * than the activity's moving time, and a one-lap run's lap pace can differ
 * from the activity's (docs/api-notes.md, "Moving time"). Shared by
 * get-activity, get-activity-laps and get-running-summary.
 */
export const LAP_MOVING_TIME_NOTE =
  "lap moving times are intervals.icu's own per lap and can differ from the activity's";

export interface LapEntry {
  /** 1-based position in `icu_intervals`; intervals carry no lap number of their own. */
  lap_index: number;
  /** e.g. WORK, RECOVERY. */
  type: string | null;
  label: string | null;
  distance_km: number | null;
  moving_time_s: number | null;
  moving_time: string;
  /** intervals.icu's own moving time for this lap, not the activity's. */
  moving_time_source: "lap";
  elapsed_time_s: number | null;
  /** Set for Run/TrailRun/VirtualRun only. */
  pace_min_per_km: string | null;
  /** Grade-adjusted pace from the interval's `gap` field (m/s, same unit as `average_speed`); runs only. */
  gap_min_per_km: string | null;
  /** GAP here is always intervals.icu's own `gap` field, distinct from
   * get-hill-analysis/get-split-analysis's locally-modelled GAP. */
  gap_source: "intervals.icu";
  /** `m:ss` per 100 m for a swim (`sportSpeed`). */
  pace_min_per_100m: string | null;
  /** km/h for every sport except runs and swims (`sportSpeed`). */
  speed_kmh: number | null;
  average_hr: number | null;
  max_hr: number | null;
  /** Strides doubled to steps/min for a step-cadence type, raw rate otherwise; see `units.cadence` for which. */
  average_cadence: number | null;
  average_watts: number | null;
  elevation_gain_m: number | null;
  average_gradient_pct: number | null;
}

function mapOneInterval(
  interval: IntervalsInterval,
  lapIndex: number,
  type: string,
): LapEntry {
  const isPace = isPaceActivity(type);
  const cadence = cadenceSpm(interval.average_cadence, type);
  // Distance over moving time, as get-activity's intervals, so a lap and the
  // same interval there always agree. intervals.icu's interval
  // `average_speed` equals it (docs/api-notes.md).
  const speed = sportSpeed(type, interval.distance, interval.moving_time);
  return {
    lap_index: lapIndex,
    type: interval.type ?? null,
    label: interval.label ?? null,
    distance_km:
      interval.distance != null ? round(interval.distance / 1000, 2) : null,
    moving_time_s: interval.moving_time ?? null,
    moving_time: formatDuration(interval.moving_time),
    moving_time_source: "lap",
    elapsed_time_s: interval.elapsed_time ?? null,
    pace_min_per_km: isPace
      ? paceFromDistanceTime(interval.distance, interval.moving_time)
      : null,
    gap_min_per_km: gapPace(interval.gap, type),
    gap_source: "intervals.icu",
    pace_min_per_100m: speed.pace_min_per_100m,
    speed_kmh: speed.speed_kmh,
    average_hr: interval.average_heartrate ?? null,
    max_hr: interval.max_heartrate ?? null,
    average_cadence: cadence == null ? null : Math.round(cadence),
    average_watts: interval.average_watts ?? null,
    elevation_gain_m:
      interval.total_elevation_gain == null
        ? null
        : round(interval.total_elevation_gain),
    // `average_gradient` is a fraction, not already a percent: confirmed
    // against the multi-lap fixture's first interval, whose
    // average_gradient (0.0039488245) times its distance (759.72 m) gives
    // about 3.0 m of net rise, in line with its recorded
    // total_elevation_gain (4.2 m, ascent-only so slightly higher). A
    // percent reading (0.0039%) would be two orders of magnitude too flat
    // for that climb.
    average_gradient_pct:
      interval.average_gradient == null
        ? null
        : round(interval.average_gradient * 100, 2),
  };
}

/**
 * Maps `icu_intervals` (index order, as returned) to ordered lap entries.
 * `activity` supplies the sport type deciding pace vs. speed and the
 * cadence unit; `intervals` is usually `activity.icu_intervals`, passed
 * separately so a caller that already split the two (e.g. one fetch reused
 * across lap and interval-analysis views) does not need to reassemble the
 * activity object. Exported for direct testing.
 */
export function mapIntervalsToLaps(
  activity: Pick<IntervalsActivity, "type">,
  intervals: IntervalsInterval[],
): LapEntry[] {
  const type = activity.type ?? "Workout";
  return intervals.map((interval, index) =>
    mapOneInterval(interval, index + 1, type),
  );
}

/** The unit `average_cadence` is reported in for a given activity type. */
export function cadenceUnit(type: string): "spm" | "rpm" {
  return isStepCadenceActivity(type) ? "spm" : "rpm";
}

/**
 * One text line for a lap: `<index>. <label>: <comma-separated metrics>`.
 * The one home for this rendering, shared by `get-activity-laps` and
 * `get-running-summary`, which each previously hand-rolled a near-identical
 * copy (the running-summary one hardcoded "spm" and omitted speed/watts/
 * grade, fields that just never applied to its runs-only laps).
 */
export function formatLapLine(lap: LapEntry, cadence: "spm" | "rpm"): string {
  const parts: string[] = [];
  if (lap.distance_km != null) parts.push(`${lap.distance_km.toFixed(2)} km`);
  parts.push(lap.moving_time);
  if (lap.pace_min_per_km) parts.push(`${lap.pace_min_per_km} /km`);
  if (lap.gap_min_per_km) parts.push(`GAP ${lap.gap_min_per_km} /km`);
  if (lap.pace_min_per_100m) parts.push(`${lap.pace_min_per_100m} /100m`);
  if (lap.speed_kmh != null) parts.push(`${lap.speed_kmh} km/h`);
  if (lap.average_watts != null)
    parts.push(`${Math.round(lap.average_watts)} W`);
  if (lap.average_hr != null) {
    const max = lap.max_hr != null ? `/${Math.round(lap.max_hr)}` : "";
    parts.push(`HR ${Math.round(lap.average_hr)}${max}`);
  }
  if (lap.average_cadence != null)
    parts.push(`cadence ${lap.average_cadence} ${cadence}`);
  if (lap.elevation_gain_m != null && lap.elevation_gain_m > 0)
    parts.push(`+${Math.round(lap.elevation_gain_m)} m`);
  if (lap.average_gradient_pct != null)
    parts.push(`${lap.average_gradient_pct}% grade`);
  const label = lap.label ?? lap.type ?? "lap";
  return `${lap.lap_index}. ${label}: ${parts.join(", ")}`;
}
