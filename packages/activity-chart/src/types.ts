/**
 * Lap/interval-band data from the server's get-activity-streams-raw tool.
 * One entry per intervals.icu `icu_intervals` entry (WORK/RECOVERY, not a
 * device lap); `type`/`label` are additive and nullable (raw values from
 * intervals.icu, distinct from the already-computed `name`).
 */
export interface Lap {
  name: string;
  startIndex: number;
  endIndex: number;
  distance: number | null;
  elapsedTime: number | null;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  lapIndex: number;
  /** e.g. "WORK", "RECOVERY". `null` when intervals.icu did not set one.
   * Rest/recovery bands are identified by `type === "RECOVERY"`, never by
   * matching the display name or by `distance === 0` (distance is nullable
   * and a real recovery interval can have a nonzero distance). */
  type?: string | null;
  /** Raw intervals.icu label. `null` when intervals.icu did not set one. */
  label?: string | null;
}

/**
 * Raw data from the server's get-activity-streams-raw tool. Streams are
 * downsampled to at most about 1,000 points; `time`/`distance` are gap-free,
 * every other metric may carry `null` samples (a later task makes the chart
 * render those as gaps). The running-dynamics fields are additive.
 */
export interface ActivityStreamData {
  activityId: string;
  activityType: string;
  name: string;
  streams: {
    time?: number[];
    heartrate?: (number | null)[];
    watts?: (number | null)[];
    velocity_smooth?: (number | null)[];
    altitude?: (number | null)[];
    cadence?: (number | null)[];
    grade_smooth?: (number | null)[];
    distance?: number[];
    /** Ground contact time, ms. */
    stance_time?: (number | null)[];
    /** Vertical oscillation, mm. */
    vertical_oscillation?: (number | null)[];
    /** Vertical ratio, %. */
    vertical_ratio?: (number | null)[];
    /** Step length, mm. */
    step_length?: (number | null)[];
  };
  laps?: Lap[];
}

/** The 6 chart metric keys */
export type MetricKey =
  | "heartrate"
  | "power"
  | "pace"
  | "altitude"
  | "cadence"
  | "grade";

/**
 * Normalized data point for Recharts. Metric fields are `number | null`:
 * `null` is a genuine gap in the recording (Recharts breaks the line there
 * with `connectNulls={false}`); the key is absent entirely (`undefined`) only
 * when the activity never recorded that metric at all.
 */
export interface ChartDataPoint {
  time: number;
  timeFormatted: string;
  distance?: number;
  heartrate?: number | null;
  power?: number | null;
  pace?: number | null;
  altitude?: number | null;
  cadence?: number | null;
  grade?: number | null;
}

/** Display metadata for the activity */
export interface ActivityMeta {
  name: string;
  activityType: string;
  isRunning: boolean;
  isSwimming: boolean;
}
