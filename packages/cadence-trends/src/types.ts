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
  /** `null` when the device recorded no speed: never a fabricated 0 min/km.
   * The run still counts toward cadence-based views; pace-based views
   * (pace zones, scatter, a11y pace ranges) exclude it. */
  averagePace: number | null;
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
  /** Runs in `activities` with no recorded speed (`averagePace: null`),
   * excluded from pace-based views only. Optional so an older feed shape
   * still parses. */
  noPaceCount?: number;
}

/** Stream data for a single run used in overlay view (reuses activity-chart shape) */
export interface OverlayStreamData {
  activityId: string;
  activityType: string;
  name: string;
  streams: {
    time?: number[];
    distance?: number[];
    cadence?: (number | null)[];
  };
  /**
   * `true` when the run recorded no streams (`streams: { time: [] }`): the
   * server sends that as data, not an error (#65).
   */
  noStreams?: boolean;
}

/** A single point in the overlay chart */
export interface OverlayPoint {
  distance: number;
  time: number;
  cadence?: number;
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
  /** Latest progress message from the server while loading, else null. */
  progress: string | null;
  /**
   * The run loaded but recorded no streams. It is left out of the overlay
   * lines and named in a note instead: a retry cannot succeed, so none is
   * offered (#65).
   */
  noStreams?: boolean;
}

/**
 * What the overlay is doing with one selected run, which decides what the
 * model may be told: only a `drawn` run is a line on screen (#68). `hidden`
 * is a loaded run the legend has switched off.
 */
export type OverlayRunStatus =
  | "drawn"
  | "hidden"
  | "loading"
  | "noStreams"
  | "failed";

/** Pace zone definition */
export interface PaceZone {
  label: string;
  minPace: number;
  maxPace: number;
}

/** View identifiers */
export type ViewId = "trend" | "scatter" | "zones" | "overlay";

/** What the overlay's x-axis measures. */
export type OverlayXMode = "distance" | "time";

/**
 * Overlay comparison cap, shared by the dot-click toggle, the run picker and
 * the `set-view` tool's `runIds` bound.
 */
export const MAX_COMPARE_RUNS = 4;

/** Palette for overlay comparison lines — distinct from metric colors */
export const COMPARISON_COLORS = [
  "#e11d48", // rose
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
];
