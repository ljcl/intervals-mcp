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
  distance: number;
  elapsedTime: number;
  averageSpeed: number | null;
  averageHeartrate: number | null;
  lapIndex: number;
  /** e.g. "WORK", "RECOVERY". `null` when intervals.icu did not set one. */
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
    heartrate?: number[];
    watts?: number[];
    velocity_smooth?: number[];
    altitude?: number[];
    cadence?: number[];
    grade_smooth?: number[];
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

/** Normalized data point for Recharts */
export interface ChartDataPoint {
  time: number;
  timeFormatted: string;
  distance?: number;
  heartrate?: number;
  power?: number;
  pace?: number;
  altitude?: number;
  cadence?: number;
  grade?: number;
}

/** Display metadata for the activity */
export interface ActivityMeta {
  name: string;
  activityType: string;
  isRunning: boolean;
  isSwimming: boolean;
}
