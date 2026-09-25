/**
 * Pure mapper from intervals.icu activity + streams + intervals to the
 * activity-chart app's wire shape. The one home for this transform: both
 * `view-activity-chart` and `get-activity-streams-raw` call
 * `buildActivityChartData` in `server.ts` rather than shaping the response
 * inline.
 *
 * Null policy (research note 2026-09-25 section 2, option (a) for axes,
 * (b) for metrics): `time` and `distance` are gap-free and monotonic (the
 * app's x-axes; a null there would break every downstream lookup). `time`
 * is never null (see `intervalsStreams.ts`); `distance` is filled by
 * `fillGaps` (`streamDownsample.ts`) before downsampling, and omitted
 * entirely if it has no non-null sample to fill from. Every other stream
 * keeps `null` samples as `null`: the app draws them as gaps rather than a
 * fabricated zero or spike.
 *
 * Bands: one per `icu_intervals` entry (WORK/RECOVERY, not device laps;
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

import { activityDisplayName } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import {
  type Columns,
  downsampleColumns,
  fillGaps,
  indexAtOrAfterTime,
} from "./streamDownsample";

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
  // `streams.time` is never null (see `intervalsStreams.ts`), so it needs no
  // `fillGaps` pass; `distance` can be entirely absent of real samples, so
  // it's filled (and omitted if that fill has nothing to work from).
  const columns: Columns = { time: streams.time };
  if (streams.distance) {
    const filled = fillGaps(streams.distance);
    if (filled) columns.distance = filled;
  }
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
    name: activityDisplayName(activity),
    streams: outStreams,
    laps: mapBands(intervals, time),
  };
}
