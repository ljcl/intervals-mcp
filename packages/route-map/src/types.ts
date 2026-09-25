/** The rendered path always comes from an activity. */
export type RouteMapSource = "activity";

/**
 * Metric streams aligned index-for-index with `coordinates`. Present only when
 * the activity has a recorded GPS track: the server sources `coordinates`
 * from the intervals.icu latlng stream, jointly downsampled with these
 * metric streams so they share one sample index. `time` and `distance` are
 * gap-free and monotonic; every other stream may carry `null` samples.
 */
export interface RouteStreams {
  /** Seconds since activity start. */
  time?: number[];
  /** Cumulative metres. */
  distance?: number[];
  /** Metres above sea level. `null` samples are gaps, drawn as breaks. */
  altitude?: (number | null)[];
  /** Beats per minute. `null` samples are gaps, drawn as breaks. */
  heartrate?: (number | null)[];
  /** Power in watts. `null` samples are gaps, drawn as breaks. */
  watts?: (number | null)[];
  /** Smoothed speed in m/s. `null` samples are gaps, drawn as breaks. */
  velocity_smooth?: (number | null)[];
  /** Smoothed grade in percent. `null` samples are gaps, drawn as breaks. */
  grade_smooth?: (number | null)[];
}

/**
 * Payload returned by the app-only `get-route-map-data` tool. Coordinates
 * come from the intervals.icu activity's latlng stream, server-side, as
 * `[lat, lng]` pairs; an activity with no recorded GPS track (e.g. a manual
 * entry) comes back with empty `coordinates`.
 */
export interface RouteMapData {
  source: RouteMapSource;
  id: string;
  name: string;
  /** Activity type ("Run", "Ride", …). */
  activityType: string | null;
  /** Total distance in metres. */
  distance: number;
  /** Total elevation gain in metres. */
  elevationGain: number;
  /** Ordered `[lat, lng]` pairs tracing the path. */
  coordinates: Array<[number, number]>;
  /** First point of the path, or null when there is no geometry. */
  start: [number, number] | null;
  /** Last point of the path, or null when there is no geometry. */
  end: [number, number] | null;
  /** Metric streams aligned with `coordinates`. Absent for activities without
   * GPS streams. */
  streams?: RouteStreams;
  /** Annotation anchors resolved server-side. Laps need stream data;
   * waypoints resolve for any geometry. */
  annotations?: RouteAnnotations;
  /** Server notes about caller-supplied waypoints that could not be placed
   * (e.g. beyond the track length). Informational; the view tool's text
   * surfaces them to the model. */
  waypointWarnings?: string[];
}

/**
 * Annotation anchors, as indices into `coordinates`. Resolved server-side
 * (WORK-interval end times mapped onto the downsampled stream) so the app
 * only projects and renders.
 */
export interface RouteAnnotations {
  /** One marker per WORK interval's end (a one-lap run gets one finish
   * marker). RECOVERY intervals get no marker: only the splits a runner
   * planned are shown, not intervals.icu's rest/auto-pause segmentation. */
  laps?: Array<{ lapIndex: number; name: string; endIndex: number }>;
  /** Caller-supplied waypoints anchored by cumulative distance, sorted by
   * km. */
  waypoints?: Array<{
    index: number;
    /** Distance from the start, in kilometres, as supplied by the caller. */
    km: number;
    label: string;
    kind: WaypointKind;
  }>;
}

/** Marker styles a waypoint can request; the server defaults to `custom`. */
export type WaypointKind = "fuel" | "climb" | "water" | "custom";

/** A waypoint as supplied on the `view-route-map` tool input. */
export interface WaypointArg {
  km: number;
  label: string;
  kind?: WaypointKind;
}

/** Tool input for `view-route-map`. Waypoints ride along unchanged so
 * `get-route-map-data` can anchor them. */
export interface ToolArgs {
  activity_id: string;
  waypoints?: WaypointArg[];
}
