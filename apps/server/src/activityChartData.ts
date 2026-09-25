/**
 * Pure mapper from intervals.icu activity + streams + intervals to the
 * activity-chart app's wire shape. The one home for this transform: both
 * `view-activity-chart` and `get-activity-streams-raw` call
 * `buildActivityChartData` in `server.ts` rather than shaping the response
 * inline.
 *
 * Null policy (research note 2026-09-25 section 2, option (a) for axes,
 * (b) for metrics): `time` and `distance` are gap-free and monotonic (the
 * app's x-axes; a null there would break every downstream lookup), filled
 * by `fillGaps` before downsampling. Every other stream keeps `null`
 * samples as `null` — the app draws them as gaps rather than a fabricated
 * zero or spike; null-safe rendering is a later task.
 *
 * Bands: one per `icu_intervals` entry (WORK/RECOVERY, not device laps —
 * see docs/api-notes.md). `start_index`/`end_index` are recomputed against
 * the *downsampled* time array from the interval's `start_time`/`end_time`
 * (seconds since activity start), because raw stream indices shift once
 * auto-pause gaps are dropped and the stream is bucketed; a downsampled
 * array is also shorter than the raw one. The band's displayed `name`
 * falls back to "Recovery" for a RECOVERY interval with no label (the
 * app's existing rest heuristic matches on that word) or "Lap N"
 * otherwise; `type`/`label` are carried through unmodified (both nullable)
 * for callers that want the raw values instead of the display name.
 */

import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import { type Columns, downsampleColumns } from "./streamDownsample";

/** Points per stream after downsampling; matches Strava's old "medium" resolution. */
export const MAX_CHART_POINTS = 1000;

/** One interval-derived band, drawn over the chart and used for lap labels. */
export interface ActivityChartBand {
  /** e.g. "WORK", "RECOVERY". `null` when intervals.icu did not set one. */
  type: string | null;
  /** Raw interval label; `null` when intervals.icu did not set one. */
  label: string | null;
  /** Display name: `label`, else "Recovery" for a RECOVERY interval, else "Lap N". */
  name: string;
  /** Index into the downsampled `time`/metric arrays where the band starts. */
  startIndex: number;
  /** Index into the downsampled `time`/metric arrays where the band ends. */
  endIndex: number;
  distance: number | null;
  elapsedTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  /** 1-based position in `icu_intervals`; intervals carry no lap number of their own. */
  lapIndex: number;
}

/** Downsampled, gap-free/nullable streams plus interval bands for the activity-chart app. */
export interface ActivityChartData {
  activityId: string;
  activityType: string;
  name: string;
  streams: {
    /** Seconds since activity start. Gap-free and monotonic. */
    time: number[];
    /** Metres. Gap-free and monotonic (see module doc). */
    distance?: number[];
    heartrate?: (number | null)[];
    watts?: (number | null)[];
    velocity_smooth?: (number | null)[];
    altitude?: (number | null)[];
    grade_smooth?: (number | null)[];
    /** Raw strides/min; the app doubles this for step-cadence activity types. */
    cadence?: (number | null)[];
    /** Ground contact time, ms. */
    stance_time?: (number | null)[];
    /** Vertical oscillation, mm. */
    vertical_oscillation?: (number | null)[];
    /** Vertical ratio, %. */
    vertical_ratio?: (number | null)[];
    /** Step length, mm. */
    step_length?: (number | null)[];
  };
  laps: ActivityChartBand[];
}

/** Stream keys `buildActivityChartData` copies from `streams` onto the wire, in order. */
const METRIC_KEYS = [
  "heartrate",
  "watts",
  "velocity_smooth",
  "altitude",
  "grade_smooth",
  "cadence",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
] as const satisfies ReadonlyArray<keyof IntervalsStreams>;

/**
 * Fills every `null` in `data` so the result is gap-free: leading nulls take
 * the first known value, trailing nulls take the last known value, and an
 * interior run of nulls is linearly interpolated between its neighbours.
 * Monotonic input (time, cumulative distance) stays monotonic (non-decreasing
 * — a flat leading/trailing fill repeats a value rather than decreasing).
 * A column with no non-null sample at all degrades to all zeros: there is
 * nothing to fill from, and every consumer of this axis needs numbers.
 */
export function fillGaps(data: ReadonlyArray<number | null>): number[] {
  const result: Array<number | null> = data.slice();
  const n = result.length;

  let first = -1;
  for (let i = 0; i < n; i += 1) {
    if (result[i] != null) {
      first = i;
      break;
    }
  }
  if (first === -1) return result.map(() => 0);

  let last = n - 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (result[i] != null) {
      last = i;
      break;
    }
  }

  const firstValue = result[first] as number | null;
  const lastValue = result[last] as number | null;
  for (let i = 0; i < first; i += 1) result[i] = firstValue;
  for (let i = last + 1; i < n; i += 1) result[i] = lastValue;

  let i = first;
  while (i < last) {
    if (result[i] != null) {
      i += 1;
      continue;
    }
    let j = i;
    while (result[j] == null) j += 1;
    const prev = result[i - 1] as number;
    const next = result[j] as number;
    const span = j - (i - 1);
    for (let k = i; k < j; k += 1) {
      const t = (k - (i - 1)) / span;
      result[k] = prev + (next - prev) * t;
    }
    i = j;
  }

  return result as number[];
}

/**
 * The first index in `time` whose value is `>= target`, or the last index
 * when every sample is below `target` (an interval that runs to the
 * recording's end). `time` is assumed sorted ascending (guaranteed: it is
 * gap-filled and monotonic by the time this runs). Empty `time` returns 0.
 */
function indexAtOrAfterTime(time: readonly number[], target: number): number {
  if (time.length === 0) return 0;
  for (let i = 0; i < time.length; i += 1) {
    if ((time[i] as number) >= target) return i;
  }
  return time.length - 1;
}

function bandName(interval: IntervalsInterval, lapIndex: number): string {
  if (interval.label) return interval.label;
  if (interval.type === "RECOVERY") return "Recovery";
  return `Lap ${lapIndex}`;
}

function mapBands(
  intervals: readonly IntervalsInterval[],
  downsampledTime: readonly number[],
): ActivityChartBand[] {
  return intervals.map((interval, i) => {
    const lapIndex = i + 1;
    const startTime = interval.start_time ?? 0;
    const endTime = interval.end_time ?? startTime;
    const startIndex = indexAtOrAfterTime(downsampledTime, startTime);
    const endIndex = Math.max(
      startIndex,
      indexAtOrAfterTime(downsampledTime, endTime),
    );
    return {
      type: interval.type ?? null,
      label: interval.label ?? null,
      name: bandName(interval, lapIndex),
      startIndex,
      endIndex,
      distance: interval.distance ?? null,
      elapsedTime: interval.elapsed_time ?? interval.moving_time ?? null,
      averageSpeed: interval.average_speed ?? null,
      averageHeartrate: interval.average_heartrate ?? null,
      lapIndex,
    };
  });
}

/**
 * Builds the activity-chart app's wire shape from a fetched activity, its
 * loaded streams (`loadIntervalsStreams`), and its intervals
 * (`activity.icu_intervals ?? []`, passed separately so this stays pure and
 * testable without threading the whole activity through). Downsamples every
 * stream jointly to at most {@link MAX_CHART_POINTS} points via
 * `downsampleColumns`, then remaps each interval's `start_time`/`end_time`
 * onto the downsampled `time` array.
 */
export function buildActivityChartData(
  activity: IntervalsActivity,
  streams: IntervalsStreams,
  intervals: readonly IntervalsInterval[],
): ActivityChartData {
  const columns: Columns = { time: fillGaps(streams.time) };
  if (streams.distance) columns.distance = fillGaps(streams.distance);
  for (const key of METRIC_KEYS) {
    const values = streams[key];
    if (values) columns[key] = values as Array<number | null>;
  }

  const downsampled = downsampleColumns(columns, MAX_CHART_POINTS);
  const time = downsampled.time as number[];

  const outStreams: ActivityChartData["streams"] = { time };
  if (downsampled.distance)
    outStreams.distance = downsampled.distance as number[];
  for (const key of METRIC_KEYS) {
    if (downsampled[key]) outStreams[key] = downsampled[key];
  }

  return {
    activityId: activity.id,
    activityType: activity.type ?? "Workout",
    name: activity.name ?? activity.type ?? "Workout",
    streams: outStreams,
    laps: mapBands(intervals, time),
  };
}
