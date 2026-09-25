/** The rendered path always comes from an activity. */
export type RouteMapSource = "activity";

/**
 * Metric streams aligned index-for-index with `coordinates`. Present only when
 * the server sourced the coordinates from the activity's latlng stream (all
 * streams in one Strava response share the same sample index). Keys mirror
 * Strava's stream type names.
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
 * Payload returned by the app-only `get-route-map-data` tool. Coordinates are
 * decoded server-side from Strava's encoded polyline into `[lat, lng]` pairs;
 * the app never decodes, keeping the bundle lean.
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
  /** Server notes about optional annotation layers (laps) that could
   * not be fetched — a rate limit, an auth failure — each naming the layer and
   * the reason. Informational, and the map still renders: the geometry was
   * already loaded when the layer failed. Surfaced to the model by the view
   * tool's text, like `waypointWarnings`. */
  layerWarnings?: string[];
}

/**
 * Annotation anchors, as indices into `coordinates`. Resolved server-side
 * (lap distances mapped onto the downsampled stream) so the app only
 * projects and renders.
 */
export interface RouteAnnotations {
  /** Lap boundaries (each lap's end), present when the activity has 2+ laps. */
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
