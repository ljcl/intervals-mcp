/**
 * Raw data from the server's get-activity-streams-raw tool (cross-app reuse;
 * the compare overlay ignores the lap payload that tool also returns).
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
  };
}

/** Running dynamics averages, present only for step-cadence types with device support. */
export interface CompareRunningDynamics {
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
}

/** One side of the get-compare-activities-data payload. */
export interface CompareSide {
  id: string;
  name: string;
  date: string;
  type: string;
  distance_km: number;
  /** `h:mm:ss` (or `m:ss` under an hour). */
  moving_time: string;
  /** Moving time in seconds. */
  moving_time_s: number;
  pace_min_per_km: string | null;
  gap_min_per_km: string | null;
  average_hr: number | null;
  max_hr: number | null;
  cadence_spm: number | null;
  elevation_gain_m: number;
  /** icu_training_load. */
  load: number | null;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
  running_dynamics: CompareRunningDynamics | null;
}

/** Aggregate comparison from the server's get-compare-activities-data tool. */
export interface CompareData {
  units: {
    distance: "km";
    pace: "min/km";
    time: "s";
    hr: "bpm";
    elevation: "m";
    cadence: "spm";
  };
  activity_1: CompareSide;
  activity_2: CompareSide;
  differences: {
    distance_km: number;
    pace_delta_sec_per_km: number | null;
    pace_delta_min_per_km: string | null;
    pace_delta_interpretation: string | null;
    avg_hr: number | null;
    cadence_spm: number | null;
    elevation_gain_m: number;
  };
  efficiency: {
    activity_1: number;
    activity_2: number;
    change_percent: number;
    interpretation: string;
    note: string;
  } | null;
  warnings?: string[];
}

/** Metrics the overlay can plot (must be present in both activities). */
export type MetricKey = "pace" | "heartrate" | "power" | "cadence" | "altitude";

/** Shared x-axis the two activities are aligned on. */
export type AxisKey = "distance" | "time";

/** One resampled point on the shared axis; `a` = activity 1, `b` = activity 2. */
export interface AlignedPoint {
  x: number;
  aPace?: number;
  bPace?: number;
  aHeartrate?: number;
  bHeartrate?: number;
  aPower?: number;
  bPower?: number;
  aCadence?: number;
  bCadence?: number;
  aAltitude?: number;
  bAltitude?: number;
}
