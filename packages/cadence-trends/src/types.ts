/** Summary data for a single run, returned by get-cadence-trend-data */
export interface RunSummary {
  /** intervals.icu activity id, e.g. "i189807578". */
  id: string;
  name: string;
  /** Local calendar date (`YYYY-MM-DD`); read as-is, never through a `Date`
   * whose own time zone could shift the day. */
  date: string;
  distance: number;
  duration: number;
  averageCadence: number;
  averagePace: number;
  type: string;
}

/** Response from get-cadence-trend-data tool */
export interface CadenceTrendData {
  weeks: number;
  activities: RunSummary[];
  /** Run-type activities in the window with no recorded cadence, left out
   * of `activities` rather than plotted at a fabricated 0 spm. Optional so
   * an older feed shape still parses. */
  excludedNoCadence?: number;
}

/** Stream data for a single run used in overlay view (reuses activity-chart shape) */
export interface OverlayStreamData {
  activityId: string;
  activityType: string;
  name: string;
  streams: {
    time?: number[];
    distance?: number[];
    cadence?: number[];
    velocity_smooth?: number[];
  };
}

/** A single point in the overlay chart */
export interface OverlayPoint {
  distance: number;
  time: number;
  cadence?: number;
  pace?: number;
}

/**
 * One selected run's overlay stream and the state of its fetch. The
 * overlay draws a run only once `points` arrives, and reports `error` with a
 * retry rather than dropping the run silently.
 */
export interface RunStreamState {
  run: RunSummary;
  /** Resampled cadence points; null while loading or after a failure. */
  points: OverlayPoint[] | null;
  loading: boolean;
  error: string | null;
}

/** Pace zone definition */
export interface PaceZone {
  label: string;
  minPace: number;
  maxPace: number;
}

/** View identifiers */
export type ViewId = "trend" | "scatter" | "zones" | "overlay";

/** Palette for overlay comparison lines — distinct from metric colors */
export const COMPARISON_COLORS = [
  "#e11d48", // rose
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
];
