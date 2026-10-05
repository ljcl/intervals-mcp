import {
  formatTime,
  isRunning,
  isSwimming,
  smooth,
  speedDisplay,
} from "@intervals-mcp/data";
import {
  type ActivityMeta,
  type ActivityStreamData,
  type ChartDataPoint,
  type MetricKey,
} from "./types";

export { isRunning, isSwimming };

export interface ChartLap {
  name: string;
  startTime: number;
  endTime: number;
  startDistance: number;
  endDistance: number;
  isRest: boolean;
}

/** Format a lap name with distance for swim activities */
function formatSwimLapName(name: string, distance: number): string {
  const distLabel = `${Math.round(distance)}m`;
  // If the lap has a meaningful name, show "Name · Xm"
  if (name && !/^lap\s*\d*$/i.test(name)) {
    return `${name} · ${distLabel}`;
  }
  return distLabel;
}

export function toLapData(data: ActivityStreamData): ChartLap[] {
  const laps = data.laps;
  if (!laps?.length) return [];
  const timeArr = data.streams.time;
  if (!timeArr?.length) return [];
  const distArr = data.streams.distance;
  const swimming = isSwimming(data.activityType);

  return laps.map((lap) => {
    const startTime = timeArr[lap.startIndex] ?? 0;
    const endTime = timeArr[Math.min(lap.endIndex, timeArr.length - 1)] ?? 0;
    const startDistance = distArr?.[lap.startIndex] ?? 0;
    const endDistance =
      distArr?.[Math.min(lap.endIndex, (distArr?.length ?? 1) - 1)] ?? 0;
    // Keyed off the band's raw type, not the display name ("Recovery" is a
    // name too) or distance (nullable, and a real recovery can be nonzero).
    const isRest = lap.type === "RECOVERY";
    const lapDistance = endDistance - startDistance;
    const name = swimming ? formatSwimLapName(lap.name, lapDistance) : lap.name;
    return { name, startTime, endTime, startDistance, endDistance, isRest };
  });
}

export function extractMeta(data: ActivityStreamData): ActivityMeta {
  return {
    name: data.name,
    activityType: data.activityType,
    isRunning: isRunning(data.activityType),
    isSwimming: isSwimming(data.activityType),
    speed: speedDisplay(data.activityType),
  };
}

/**
 * Convert raw stream data into ChartDataPoint array for Recharts.
 * - velocity_smooth → pace (min/km, min/100m) or speed (km/h) via `speedDisplay`
 * - cadence doubled for running (intervals.icu reports strides/min for
 *   running; see docs/api-notes.md)
 */
export function toChartData(data: ActivityStreamData): ChartDataPoint[] {
  const { streams } = data;
  const timeArr = streams.time ?? [];
  const len = timeArr.length;
  const running = isRunning(data.activityType);
  const display = speedDisplay(data.activityType);
  const points: ChartDataPoint[] = [];

  for (let i = 0; i < len; i += 1) {
    const time = timeArr[i]!;
    const point: ChartDataPoint = {
      time,
      timeFormatted: formatTime(time),
    };

    if (streams.heartrate?.[i] !== undefined) {
      point.heartrate = streams.heartrate[i];
    }

    if (streams.watts?.[i] !== undefined) {
      point.power = streams.watts[i];
    }

    if (streams.velocity_smooth?.[i] !== undefined) {
      // One conversion for every sport (#63): a stopped or missing pace
      // sample is a gap, never a capped value.
      point.pace = display.fromMps(streams.velocity_smooth[i]);
    }

    if (streams.distance?.[i] !== undefined) {
      point.distance = streams.distance[i];
    }

    if (streams.altitude?.[i] !== undefined) {
      point.altitude = streams.altitude[i];
    }

    if (streams.cadence?.[i] !== undefined) {
      const raw = streams.cadence[i];
      // Running cadence: intervals.icu reports strides/min, double for steps/min.
      // A null sample must stay null: never become 0 via `null * 2`.
      point.cadence = raw == null ? null : running ? raw * 2 : raw;
    }

    if (streams.grade_smooth?.[i] !== undefined) {
      point.grade = streams.grade_smooth[i];
    }

    if (streams.stance_time?.[i] !== undefined) {
      point.stanceTime = streams.stance_time[i];
    }

    if (streams.vertical_oscillation?.[i] !== undefined) {
      point.verticalOscillation = streams.vertical_oscillation[i];
    }

    if (streams.vertical_ratio?.[i] !== undefined) {
      point.verticalRatio = streams.vertical_ratio[i];
    }

    if (streams.step_length?.[i] !== undefined) {
      point.stepLength = streams.step_length[i];
    }

    points.push(point);
  }

  // Strip all-zero/all-null altitude/grade streams (common in swimming, or
  // when the device never recorded the metric).
  if (points.length > 0 && points.every((p) => !p.altitude)) {
    for (const p of points) p.altitude = undefined;
  } else if (points.length > 0 && points.every((p) => p.altitude === 0)) {
    for (const p of points) p.altitude = undefined;
  }
  if (points.length > 0 && points.every((p) => !p.grade)) {
    for (const p of points) p.grade = undefined;
  } else if (points.length > 0 && points.every((p) => p.grade === 0)) {
    for (const p of points) p.grade = undefined;
  }

  return points;
}

const SMOOTH_KEYS: MetricKey[] = [
  "heartrate",
  "power",
  "pace",
  "altitude",
  "cadence",
  "grade",
  "stanceTime",
  "verticalOscillation",
  "verticalRatio",
  "stepLength",
];

/**
 * Apply a simple moving average to all metric fields.
 * Window shrinks at boundaries so no data is lost.
 *
 * When windowSize is 0 (default), auto-calculates based on data density
 * to target ~30 seconds of smoothing regardless of sampling rate.
 */
export function smoothData(
  points: ChartDataPoint[],
  windowSize = 0,
): ChartDataPoint[] {
  const len = points.length;
  if (len < 3) return points;

  let effectiveWindow = windowSize;
  if (effectiveWindow <= 0 && len >= 2) {
    const firstTime = points[0]!.time;
    const lastTime = points[len - 1]!.time;
    const avgInterval = (lastTime - firstTime) / (len - 1);
    effectiveWindow = avgInterval > 0 ? Math.round(30 / avgInterval) : 10;
    effectiveWindow = Math.max(3, Math.min(60, effectiveWindow));
  } else if (effectiveWindow <= 0) {
    effectiveWindow = 10;
  }

  return smooth(points, SMOOTH_KEYS, effectiveWindow);
}
