/**
 * Anchor-point resolution for route-map annotations. Lap boundaries arrive
 * with distances, while the map app renders by index into the (downsampled)
 * latlng stream — Strava's `start_index`/`end_index` fields refer to the
 * full-resolution stream, so they cannot be used against a
 * `resolution=medium` response. These helpers map distance anchors onto
 * stream indices server-side, keeping the app's bundle lean. Pure math,
 * unit-tested next to `polyline.ts`.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * First index whose cumulative distance reaches `target` metres. The distance
 * stream is non-decreasing, so binary search. Clamps to the last index when
 * the target exceeds the stream (e.g. lap distances summing past the recorded
 * total). Returns -1 for an empty stream.
 */
export function indexAtDistance(
  distanceStream: number[],
  target: number,
): number {
  if (distanceStream.length === 0) return -1;
  let lo = 0;
  let hi = distanceStream.length - 1;
  if (distanceStream[hi]! < target) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distanceStream[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance in metres between two `[lat, lng]` points. The one
 * haversine in the server: `cumulativeDistances` below sums it.
 */
export function haversineMeters(
  a: [number, number],
  b: [number, number],
): number {
  const dLat = (b[0] - a[0]) * DEG_TO_RAD;
  const dLng = (b[1] - a[1]) * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * DEG_TO_RAD) *
      Math.cos(b[0] * DEG_TO_RAD) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Cumulative haversine distance (metres) along a `[lat, lng]` track, aligned
 * index-for-index with the coordinates. The distance-anchor fallback when no
 * recorded distance stream exists: saved routes and polyline-only activities
 * arrive as bare geometry, so anchors like waypoints need a synthetic
 * cumulative stream to resolve against.
 */
export function cumulativeDistances(
  coordinates: Array<[number, number]>,
): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < coordinates.length; i++) {
    if (i > 0) {
      total += haversineMeters(coordinates[i - 1]!, coordinates[i]!);
    }
    out.push(total);
  }
  return out;
}

/** Marker styles a waypoint can request; `custom` is the schema default. */
export type WaypointKind = "fuel" | "climb" | "water" | "custom";

/** A distance-anchored waypoint as supplied on the tool input. */
export interface WaypointInput {
  km: number;
  label: string;
  kind: WaypointKind;
}

/** A waypoint resolved onto the coordinate stream. */
export interface ResolvedWaypoint extends WaypointInput {
  /** Index into the (downsampled) coordinates. */
  index: number;
}

/**
 * Waypoints may overshoot the declared total by this fraction before being
 * dropped: a race plan says "gel at 42.2" while the recorded track measures
 * 42.16, and clamping such near-misses to the finish beats losing them.
 */
export const WAYPOINT_OVERSHOOT_FRACTION = 0.01;

/**
 * Anchor tool-input waypoints onto the coordinate stream by cumulative
 * distance. `distanceStream` is the recorded distance stream when the
 * activity has one, else `cumulativeDistances` of the geometry. Waypoints
 * past the track length (beyond the overshoot tolerance against
 * `declaredTotalMeters`, falling back to the stream's total) are returned in
 * `dropped` for the caller to warn about rather than erroring or rendering
 * off-track markers. Resolved waypoints come back sorted by distance.
 */
export function resolveWaypoints(
  waypoints: WaypointInput[],
  distanceStream: number[],
  declaredTotalMeters: number,
): { resolved: ResolvedWaypoint[]; dropped: WaypointInput[] } {
  const streamTotal = distanceStream[distanceStream.length - 1] ?? 0;
  const total = declaredTotalMeters > 0 ? declaredTotalMeters : streamTotal;
  const maxMeters = total * (1 + WAYPOINT_OVERSHOOT_FRACTION);

  const resolved: ResolvedWaypoint[] = [];
  const dropped: WaypointInput[] = [];
  for (const waypoint of waypoints) {
    const targetMeters = waypoint.km * 1000;
    if (targetMeters > maxMeters) {
      dropped.push(waypoint);
      continue;
    }
    const index = indexAtDistance(distanceStream, targetMeters);
    if (index < 0) {
      dropped.push(waypoint);
      continue;
    }
    resolved.push({ ...waypoint, index });
  }
  resolved.sort((a, b) => a.km - b.km);
  return { resolved, dropped };
}
