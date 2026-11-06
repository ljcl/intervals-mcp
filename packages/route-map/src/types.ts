/** Where the rendered path comes from: a recorded activity, a suggested
 * route, or a stored route (one version of it). */
export type RouteMapSource = "activity" | "suggestion" | "route";

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
  /** A stored route's sections, via points and versions. Set only when
   * `source` is "route". */
  route?: RouteMapRoute;
}

/** How a section of a stored route was made. */
export type RouteSegmentKind =
  | "activity"
  | "route"
  | "generated"
  | "out_and_back"
  | "join";

/** One section of a stored route. Indices point into `coordinates`. */
export interface RouteSegment {
  index: number;
  kind: RouteSegmentKind;
  label: string;
  from_km: number;
  to_km: number;
  startIndex: number;
  endIndex: number;
  climb_m: number | null;
  path_share: number | null;
  notes: string[];
}

/** A point the route goes through, or the turnaround of an out-and-back. */
export interface RouteVia {
  /** Id that amend-route takes, e.g. "v3". */
  id: string;
  km: number;
  label: string;
  kind: "via" | "turnaround";
  /** Index into `coordinates`. */
  index: number;
  /** Where the point is, `[lat, lng]`. */
  point: [number, number];
}

/** What changed between two versions of a stored route. */
export interface RouteVersionChange {
  from_version: number;
  to_version: number;
  distance_change_m: number;
  changed: boolean;
  /** The changed part on the newer version, km. */
  from_km: number;
  to_km: number;
  /** The same part on the older version, km. */
  old_from_km: number;
  old_to_km: number;
}

/** A stored route's version, sections and edit state (`source` "route"). */
export interface RouteMapRoute {
  route_id: string;
  version: number;
  latest_version: number;
  versions: Array<{ version: number; change: string }>;
  /** True only for the latest version: edits apply to it alone. */
  editable: boolean;
  segments: RouteSegment[];
  vias: RouteVia[];
  kmMarkers: Array<{ km: number; index: number }>;
  /** Sections with an estimated or uncertain value, by km. */
  warnings: Array<{ from_km: number; to_km: number; text: string }>;
  /** Another version drawn under this one, and the part that differs. */
  compare?: {
    version: number;
    coordinates: Array<[number, number]>;
    change: RouteVersionChange;
    /** The changed part, as indices into this version's `coordinates`. */
    startIndex: number;
    endIndex: number;
  };
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
    /** Where a stretch pin (a climb from km to end_km) ends. */
    end_km?: number;
    /** Index where a stretch pin ends; set only with `end_km`. */
    endIndex?: number;
    label: string;
    kind: WaypointKind;
  }>;
}

/** Marker styles a waypoint can request; the server defaults to `custom`. */
export type WaypointKind = "fuel" | "climb" | "water" | "custom";

/** A waypoint as supplied on the `view-route-map` tool input. */
export interface WaypointArg {
  km: number;
  end_km?: number;
  label: string;
  kind?: WaypointKind;
}

/** Tool input for `view-route-map`, normalised by `parseToolArgs`.
 * Waypoints ride along unchanged so `get-route-map-data` can anchor them. */
export interface ToolArgs {
  id: string;
  waypoints?: WaypointArg[];
}

/** Payload of the app-only `get-route-suggestions-data` tool: one planned run's candidates. */
export interface RouteSuggestionsData {
  source: "suggestion";
  date: string;
  name: string;
  startLabel: string;
  candidates: Array<{ label: string; summary: string; map: RouteMapData }>;
  warnings: string[];
}

/** Tool input for `view-route-suggestions`: every field optional, passed through for the server to validate. */
export interface SuggestionArgs {
  kind: "suggestion";
  args: Record<string, unknown>;
}

/** Tool input for `view-route-map` with a `route_id`: one stored route. */
export interface RouteArgs {
  kind: "route";
  route_id: string;
  version?: number;
  compare_to_version?: number;
  waypoints?: WaypointArg[];
  /** The version the waypoints' km were read on. */
  waypoints_version?: number;
}

export type AppArgs = ToolArgs | SuggestionArgs | RouteArgs;
