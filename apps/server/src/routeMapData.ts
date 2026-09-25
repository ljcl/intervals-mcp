/**
 * Pure mapper from intervals.icu activity + streams + intervals to the
 * route-map app's wire shape. The one home for this transform: both
 * `view-route-map` and `get-route-map-data` call `buildRouteMapData` in
 * `server.ts` rather than shaping the response inline.
 *
 * intervals.icu has no encoded-polyline endpoint (research note 2026-09-25
 * section 6: `/activity/{id}/map` returns the same latlng stream at the
 * same resolution, nothing more), so the geometry always comes from the
 * latlng stream. Samples whose latlng is `null` are dropped from every
 * aligned stream at the same index (a `[number, number]` coordinate cannot
 * carry a gap), then every remaining stream is jointly downsampled: lat,
 * lng, time, and distance take the bucket's last sample (monotonic axes
 * stay gap-free), other metrics take the bucket mean of non-null samples
 * and may still be `null`: the app draws a gap, matching
 * `activityChartData.ts`'s null policy for the same reason.
 *
 * Annotations mark the end of every WORK interval (`activity.icu_intervals`)
 * on the downsampled coordinate stream, so a one-lap run's single WORK
 * interval gives one finish marker. RECOVERY intervals get no marker: the
 * app only marks the splits a runner planned, not intervals.icu's rest/
 * auto-pause segmentation. Waypoints anchor onto the downsampled distance
 * stream via `mapAnchors.ts`.
 */

import { activityDisplayName } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import {
  cumulativeDistances,
  type ResolvedWaypoint,
  resolveWaypoints,
  type WaypointInput,
} from "./mapAnchors";
import {
  type Columns,
  downsampleColumns,
  fillGaps,
  indexAtOrAfterTime,
  lastValuePerBucket,
} from "./streamDownsample";

/** Points after downsampling; matches the other apps' `MAX_CHART_POINTS`. */
export const MAX_ROUTE_MAP_POINTS = 1000;

/** Metric streams aligned index-for-index with `coordinates`. */
export interface RouteMapStreams {
  /** Seconds since activity start. Gap-free and monotonic. */
  time?: number[];
  /** Cumulative metres. Gap-free and monotonic. */
  distance?: number[];
  altitude?: (number | null)[];
  heartrate?: (number | null)[];
  watts?: (number | null)[];
  velocity_smooth?: (number | null)[];
  grade_smooth?: (number | null)[];
}

/** One WORK interval's end, as an index into the downsampled `coordinates`. */
export interface RouteMapLapMarker {
  /** 1-based position among WORK intervals; intervals carry no lap number. */
  lapIndex: number;
  /** `label`, else "Lap N". */
  name: string;
  endIndex: number;
}

/** Annotation anchors, as indices into `coordinates`. */
export interface RouteMapAnnotations {
  /** One marker per WORK interval's end. */
  laps?: RouteMapLapMarker[];
  /** Caller-supplied waypoints anchored by cumulative distance. */
  waypoints?: ResolvedWaypoint[];
}

export interface RouteMapData {
  source: "activity";
  id: string;
  name: string;
  activityType: string | null;
  distance: number;
  elevationGain: number;
  coordinates: Array<[number, number]>;
  start: [number, number] | null;
  end: [number, number] | null;
  streams?: RouteMapStreams;
  annotations?: RouteMapAnnotations;
  /** Human-readable notes about waypoints that could not be placed. */
  waypointWarnings?: string[];
}

/** Stream keys `buildRouteMapData` copies from `streams` onto the wire, besides `time`/`distance`. */
const METRIC_KEYS = [
  "altitude",
  "heartrate",
  "watts",
  "velocity_smooth",
  "grade_smooth",
] as const satisfies ReadonlyArray<keyof IntervalsStreams>;

function lapName(interval: IntervalsInterval, lapIndex: number): string {
  return interval.label ?? `Lap ${lapIndex}`;
}

/**
 * WORK-interval end markers, mapped onto the downsampled time array via
 * {@link indexAtOrAfterTime}, the same remap `activityChartData.ts` uses
 * for interval bands, reused here rather than re-derived.
 */
function buildLapMarkers(
  intervals: readonly IntervalsInterval[],
  downsampledTime: readonly number[],
): RouteMapLapMarker[] {
  const markers: RouteMapLapMarker[] = [];
  let lapIndex = 0;
  for (const interval of intervals) {
    if (interval.type !== "WORK") continue;
    lapIndex += 1;
    const endTime = interval.end_time ?? interval.start_time ?? 0;
    markers.push({
      lapIndex,
      name: lapName(interval, lapIndex),
      endIndex: indexAtOrAfterTime(downsampledTime, endTime),
    });
  }
  return markers;
}

/** Geometry + metrics + lap markers, before waypoints are attached. */
function buildGeometry(
  activity: IntervalsActivity,
  streams: IntervalsStreams | null,
  intervals: readonly IntervalsInterval[],
): RouteMapData {
  const base = {
    source: "activity" as const,
    id: activity.id,
    name: activityDisplayName(activity),
    activityType: activity.type ?? null,
    distance: activity.distance ?? 0,
    elevationGain: activity.total_elevation_gain ?? 0,
  };

  const latlng = streams?.latlng;
  const keep: number[] = [];
  if (latlng) {
    for (let i = 0; i < latlng.length; i += 1) {
      if (latlng[i] != null) keep.push(i);
    }
  }
  if (!streams || keep.length === 0) {
    return { ...base, coordinates: [], start: null, end: null };
  }

  const time = keep.map((i) => streams.time[i] as number);
  const lat = keep.map((i) => (latlng![i] as [number, number])[0]);
  const lng = keep.map((i) => (latlng![i] as [number, number])[1]);

  const columns: Columns = {};
  if (streams.distance) {
    const filled = fillGaps(keep.map((i) => streams.distance![i] ?? null));
    if (filled) columns.distance = filled;
  }
  for (const key of METRIC_KEYS) {
    const values = streams[key];
    if (values) columns[key] = keep.map((i) => values[i] ?? null);
  }

  const maxPoints = MAX_ROUTE_MAP_POINTS;
  const downsampledLat = lastValuePerBucket(lat, maxPoints) as number[];
  const downsampledLng = lastValuePerBucket(lng, maxPoints) as number[];
  const downsampledTime = lastValuePerBucket(time, maxPoints) as number[];
  const downsampledColumns = downsampleColumns(columns, maxPoints);

  const coordinates: Array<[number, number]> = downsampledLat.map((la, i) => [
    la,
    downsampledLng[i] as number,
  ]);

  const outStreams: RouteMapStreams = { time: downsampledTime };
  if (downsampledColumns.distance) {
    outStreams.distance = downsampledColumns.distance as number[];
  }
  for (const key of METRIC_KEYS) {
    if (downsampledColumns[key]) outStreams[key] = downsampledColumns[key];
  }

  const laps = buildLapMarkers(intervals, downsampledTime);

  return {
    ...base,
    coordinates,
    start: coordinates[0] ?? null,
    end: coordinates[coordinates.length - 1] ?? null,
    streams: outStreams,
    ...(laps.length > 0 ? { annotations: { laps } } : {}),
  };
}

/**
 * Anchor caller-supplied waypoints onto the loaded geometry. Uses the
 * downsampled distance stream when present, else a synthetic haversine
 * cumulative stream (`cumulativeDistances`) for a geometry with no distance
 * stream. Out-of-range waypoints become a `waypointWarnings` note (surfaced
 * by the view tool's text) instead of an error or an off-track marker.
 */
function attachWaypoints(
  data: RouteMapData,
  waypoints: WaypointInput[] | undefined,
): RouteMapData {
  if (!waypoints || waypoints.length === 0) return data;
  if (data.coordinates.length === 0) return data;

  const recorded = data.streams?.distance;
  const distanceStream =
    recorded && recorded.length === data.coordinates.length
      ? recorded
      : cumulativeDistances(data.coordinates);
  const { resolved, dropped } = resolveWaypoints(
    waypoints,
    distanceStream,
    data.distance,
  );

  if (resolved.length > 0) {
    data.annotations = { ...data.annotations, waypoints: resolved };
  }
  if (dropped.length > 0) {
    const labels = dropped.map((w) => `"${w.label}" (${w.km} km)`).join(", ");
    data.waypointWarnings = [
      `Dropped ${dropped.length} waypoint${dropped.length === 1 ? "" : "s"} beyond the ${(data.distance / 1000).toFixed(1)} km track: ${labels}.`,
    ];
  }
  return data;
}

/**
 * Builds the route-map app's wire shape from a fetched activity, its loaded
 * streams (`loadIntervalsStreams`, or `null` for a stream-less activity,
 * e.g. a manual entry), its intervals (`activity.icu_intervals ?? []`,
 * passed separately so this stays pure and testable without threading the
 * whole activity through), and any caller-supplied waypoints.
 */
export function buildRouteMapData(
  activity: IntervalsActivity,
  streams: IntervalsStreams | null,
  intervals: readonly IntervalsInterval[],
  waypoints?: WaypointInput[],
): RouteMapData {
  return attachWaypoints(
    buildGeometry(activity, streams, intervals),
    waypoints,
  );
}
