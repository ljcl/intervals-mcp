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

import { activityDisplayName, round } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import {
  cumulativeDistances,
  haversineMeters,
  indexAtDistance,
  type ResolvedWaypoint,
  type RouteTrack,
  resolveWaypoints,
  type WaypointInput,
} from "./mapAnchors";
import {
  compareVersions,
  layoutSegments,
  summarizeRoute,
  type VersionChange,
  versionTrack,
} from "./routeBuilder";
import { mapDistance, trackDiff, trackLength } from "./routeGeometry";
import {
  findVersion,
  type StoredRoute,
  type StoredVersion,
  versionSegments,
} from "./routeStore";
import { type RunSuggestion } from "./routeSuggestions";
import {
  type Columns,
  downsampleColumns,
  fillGaps,
  indexAtOrAfterTime,
  lastValuePerBucket,
} from "./streamDownsample";
import {
  LATLNG_DECIMALS,
  rawUnitDecimals,
  roundColumn,
  STREAM_DECIMALS,
} from "./streamPrecision";

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

/** A stored route's sections, via points and km markers, as indices into `coordinates`. */
export interface RouteMapRoute {
  route_id: string;
  version: number;
  latest_version: number;
  versions: Array<{ version: number; change: string }>;
  /** Edits apply to the latest version only. */
  editable: boolean;
  segments: Array<{
    index: number;
    kind: string;
    label: string;
    from_km: number;
    to_km: number;
    startIndex: number;
    endIndex: number;
    climb_m: number | null;
    path_share: number | null;
    notes: string[];
  }>;
  vias: Array<{
    id: string;
    km: number;
    label: string;
    kind: "via" | "turnaround";
    index: number;
    point: [number, number];
  }>;
  kmMarkers: Array<{ km: number; index: number }>;
  /** Sections with an estimated or uncertain value, by km. */
  warnings: Array<{ from_km: number; to_km: number; text: string }>;
  /** Another version drawn under this one, and the part that differs. */
  compare?: {
    version: number;
    coordinates: Array<[number, number]>;
    change: VersionChange;
    /** The changed part, as indices into this version's `coordinates`. */
    startIndex: number;
    endIndex: number;
  };
}

export interface RouteMapData {
  source: "activity" | "suggestion" | "route";
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
  /** A stored route's sections and versions (source "route"). */
  route?: RouteMapRoute;
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
 * Rounds the payload for the wire: each coordinate to
 * {@link LATLNG_DECIMALS}, each stream with `rawUnitDecimals`
 * (`streamPrecision.ts`). It runs last, so lap markers and waypoints anchor
 * on full-precision values. `start` and `end` come from the rounded
 * coordinates, so they stay equal to the first and last points.
 */
function roundForWire(data: RouteMapData): RouteMapData {
  if (data.coordinates.length === 0) return data;

  const coordinates = data.coordinates.map(([lat, lng]): [number, number] => [
    round(lat, LATLNG_DECIMALS),
    round(lng, LATLNG_DECIMALS),
  ]);

  const source = data.streams ?? {};
  const streams: RouteMapStreams = {};
  if (source.time) {
    streams.time = roundColumn(source.time, STREAM_DECIMALS.time);
  }
  if (source.distance) {
    streams.distance = roundColumn(source.distance, STREAM_DECIMALS.distance);
  }
  for (const key of METRIC_KEYS) {
    const values = source[key];
    if (values) streams[key] = roundColumn(values, rawUnitDecimals(key));
  }

  return {
    ...data,
    coordinates,
    start: coordinates[0] ?? null,
    end: coordinates.at(-1) ?? null,
    streams,
  };
}

/**
 * Builds the route-map app's wire shape from a fetched activity, its loaded
 * streams (`loadIntervalsStreams`, or `null` for a stream-less activity,
 * e.g. a manual entry), its intervals (`activity.icu_intervals ?? []`,
 * passed separately so this stays pure and testable without threading the
 * whole activity through), and any caller-supplied waypoints. Every stream
 * value carries at most 2 decimals; coordinates keep 5 (see
 * {@link roundForWire}).
 */
export function buildRouteMapData(
  activity: IntervalsActivity,
  streams: IntervalsStreams | null,
  intervals: readonly IntervalsInterval[],
  waypoints?: WaypointInput[],
): RouteMapData {
  return roundForWire(
    attachWaypoints(buildGeometry(activity, streams, intervals), waypoints),
  );
}

/**
 * A route-map payload for a suggested route: the same downsampling and wire
 * rounding as an activity, from a track whose only metric is altitude.
 */
export function buildTrackMapData(
  id: string,
  name: string,
  track: RouteTrack,
  climb_m: number,
  waypoints: WaypointInput[],
): RouteMapData {
  const lat = lastValuePerBucket(
    track.coordinates.map((c) => c[0]),
    MAX_ROUTE_MAP_POINTS,
  ) as number[];
  const lng = lastValuePerBucket(
    track.coordinates.map((c) => c[1]),
    MAX_ROUTE_MAP_POINTS,
  ) as number[];
  const columns = downsampleColumns(
    { distance: track.distance, altitude: track.altitude },
    MAX_ROUTE_MAP_POINTS,
  );
  const coordinates = lat.map((la, i): [number, number] => [
    la,
    lng[i] as number,
  ]);
  const data: RouteMapData = {
    source: "suggestion",
    id,
    name,
    activityType: "Run",
    distance: track.distance.at(-1) ?? 0,
    elevationGain: climb_m,
    coordinates,
    start: coordinates[0] ?? null,
    end: coordinates.at(-1) ?? null,
    streams: {
      distance: columns.distance as number[],
      altitude: columns.altitude,
    },
  };
  return roundForWire(attachWaypoints(data, waypoints));
}

export interface RouteSuggestionsMapData {
  source: "suggestion";
  date: string;
  name: string;
  startLabel: string;
  candidates: Array<{ label: string; summary: string; map: RouteMapData }>;
  warnings: string[];
}

/** One planned run's candidates as route-map payloads, with hill and via-point markers. */
export function buildSuggestionsMapData(
  run: RunSuggestion,
  warnings: string[],
): RouteSuggestionsMapData {
  const seen = new Map<string, number>();
  const candidates = run.candidates.map((c, index) => {
    const base = c.kind === "past" ? `Past run ${c.date}` : c.name;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const waypoints: WaypointInput[] = [];
    if (c.hill) {
      waypoints.push({
        km: c.hill.start_m / 1000,
        label: `Hill: ${c.hill.length_m} m at ${c.hill.grade_pct}%`,
        kind: "climb",
      });
    }
    for (const via of run.via) {
      let nearest = 0;
      c.track.coordinates.forEach((point, i) => {
        if (
          haversineMeters(point, via.point) <
          haversineMeters(c.track.coordinates[nearest]!, via.point)
        )
          nearest = i;
      });
      waypoints.push({
        km: (c.track.distance[nearest] ?? 0) / 1000,
        label: via.label,
        kind: "custom",
      });
    }
    return {
      label: `${count > 1 ? `${base} ${count}` : base}${c.score === undefined ? "" : `, score ${c.score}`}`,
      summary: c.summary,
      map: buildTrackMapData(
        `${run.date}-${index}`,
        `${run.name}: ${base}`,
        c.track,
        c.climb_m,
        waypoints,
      ),
    };
  });
  return {
    source: "suggestion",
    date: run.date,
    name: run.name,
    startLabel: run.start.label,
    candidates,
    warnings: [...warnings, ...run.warnings],
  };
}

/** Points the compared version is drawn with: a faint line needs fewer. */
const MAX_COMPARE_POINTS = 500;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Downsampled lat, lng and distance columns of a track. */
function downsampleTrack(track: RouteTrack, maxPoints: number) {
  const lat = lastValuePerBucket(
    track.coordinates.map((c) => c[0]),
    maxPoints,
  ) as number[];
  const lng = lastValuePerBucket(
    track.coordinates.map((c) => c[1]),
    maxPoints,
  ) as number[];
  const coordinates = lat.map((la, i): [number, number] => [
    round(la, LATLNG_DECIMALS),
    round(lng[i] as number, LATLNG_DECIMALS),
  ]);
  return { coordinates };
}

/**
 * Pins whose km refer to version `from` moved onto `to`: unchanged before
 * the change, shifted after it, and inside it placed at the nearest point,
 * with a warning when none is near (`mapDistance`).
 */
function carryWaypoints(
  waypoints: WaypointInput[],
  before: RouteTrack,
  after: RouteTrack,
  fromVersion: number,
  toVersion: number,
): { waypoints: WaypointInput[]; warnings: string[] } {
  const diff = trackDiff(before, after);
  const warnings: string[] = [];
  const moved = waypoints.map((w) => {
    const start = mapDistance(w.km * 1000, before, after, diff);
    const end =
      w.end_km === undefined
        ? null
        : mapDistance(w.end_km * 1000, before, after, diff);
    const km = round3(start.distance_m / 1000);
    const endKm = end ? round3(end.distance_m / 1000) : undefined;
    if (start.uncertain || end?.uncertain) {
      warnings.push(
        `Pin "${w.label}" was at km ${w.km} on version ${fromVersion}; that part changed in version ${toVersion}, so km ${km} may be wrong.`,
      );
    } else if (Math.abs(km - w.km) >= 0.01) {
      warnings.push(
        `Pin "${w.label}" moved from km ${w.km} (version ${fromVersion}) to km ${km} (version ${toVersion}).`,
      );
    }
    return endKm === undefined ? { ...w, km } : { ...w, km, end_km: endKm };
  });
  return { waypoints: moved, warnings };
}

/**
 * The route-map payload for one version of a stored route: one line, its
 * sections with their km and source, via points, a marker every km, the
 * sections with an estimated value, and optionally another version under
 * it with the part that changed. Waypoints given for another version
 * (`waypointsVersion`) are carried onto this one first.
 */
export function buildStoredRouteMapData(
  route: StoredRoute,
  version: StoredVersion,
  options: {
    compareTo?: StoredVersion;
    waypoints?: WaypointInput[];
    waypointsVersion?: StoredVersion;
  } = {},
): RouteMapData {
  const summary = summarizeRoute(route, version);
  const segments = versionSegments(route, version);
  const { track } = layoutSegments(segments);
  let waypoints = options.waypoints ?? [];
  const carried: string[] = [];
  const from = options.waypointsVersion;
  if (from && from.version !== version.version && waypoints.length > 0) {
    const moved = carryWaypoints(
      waypoints,
      versionTrack(route, from),
      track,
      from.version,
      version.version,
    );
    waypoints = moved.waypoints;
    carried.push(...moved.warnings);
  }
  const data = buildTrackMapData(
    route.route_id,
    `${route.name} (v${version.version})`,
    track,
    summary.climb_m,
    waypoints,
  );
  data.source = "route";
  data.activityType = "Run";
  const distanceColumn = data.streams?.distance ?? [];
  const at = (km: number) =>
    Math.max(0, indexAtDistance(distanceColumn, km * 1000));
  const length = trackLength(track);
  const kmMarkers: RouteMapRoute["kmMarkers"] = [];
  for (let k = 1; k * 1000 < length; k++)
    kmMarkers.push({ km: k, index: at(k) });
  const routeData: RouteMapRoute = {
    route_id: route.route_id,
    version: version.version,
    latest_version: summary.latest_version,
    versions: summary.versions.map((v) => ({
      version: v.version,
      change: v.change,
    })),
    editable: version.version === summary.latest_version,
    segments: summary.segments.map((s) => ({
      index: s.index,
      kind: s.kind,
      label: s.label,
      from_km: s.from_km,
      to_km: s.to_km,
      startIndex: at(s.from_km),
      endIndex: at(s.to_km),
      climb_m: s.climb_m,
      path_share: s.path_share,
      notes: s.notes,
    })),
    vias: summary.segments.flatMap((s, i) =>
      s.vias.map((via) => {
        const point = segments[i]!.vias.find((v) => v.id === via.id)!.point;
        return {
          ...via,
          index: at(via.km),
          point: [
            round(point[0], LATLNG_DECIMALS),
            round(point[1], LATLNG_DECIMALS),
          ] as [number, number],
        };
      }),
    ),
    kmMarkers,
    warnings: summary.segments.flatMap((s) =>
      s.notes.map((text) => ({ from_km: s.from_km, to_km: s.to_km, text })),
    ),
  };
  const other = options.compareTo;
  if (other && other.version !== version.version) {
    // The change reads older to newer; the indices are on this version's side of it.
    const shownIsNewer = other.version < version.version;
    const diff = shownIsNewer
      ? compareVersions(route, other, version)
      : compareVersions(route, version, other);
    const mine = shownIsNewer
      ? { from_km: diff.from_km, to_km: diff.to_km }
      : { from_km: diff.old_from_km, to_km: diff.old_to_km };
    routeData.compare = {
      version: other.version,
      coordinates: downsampleTrack(
        versionTrack(route, other),
        MAX_COMPARE_POINTS,
      ).coordinates,
      change: diff,
      startIndex: at(mine.from_km),
      endIndex: at(mine.to_km),
    };
  }
  data.route = routeData;
  const warnings = [...(data.waypointWarnings ?? []), ...carried];
  if (warnings.length > 0) data.waypointWarnings = warnings;
  return data;
}

/** A version of a stored route by number, for the map's compare and waypoint options. */
export function routeVersionOrNull(
  route: StoredRoute,
  version: number | undefined,
): StoredVersion | undefined {
  return version === undefined ? undefined : findVersion(route, version);
}
