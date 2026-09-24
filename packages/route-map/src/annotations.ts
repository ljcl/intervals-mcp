/**
 * Annotation-layer preparation: turns the server's annotation anchors (plus
 * the distance stream) into renderable marker lists. The server resolves lap
 * boundaries into coordinate indices; this module picks the split source
 * (laps when the activity has them, kilometre marks otherwise) and thins
 * dense km marks. Pure data, unit-tested.
 */

import { type RouteMapData, type WaypointKind } from "./types";

export interface SplitMarker {
  /** Index into the track coordinates. */
  index: number;
  /** Marker title, e.g. "Lap 2" or "5 km". */
  label: string;
}

export interface WaypointMarker {
  /** Index into the track coordinates. */
  index: number;
  kind: WaypointKind;
  /** Marker title, e.g. "Gel 1 (caffeinated) · 11 km". */
  title: string;
}

/**
 * Per-kind waypoint marker colors. Concrete hex (not CSS vars) because the
 * MapLibre basemap paints canvas and shares these with the SVG grid;
 * theme-invariant for the same reason as TIER_COLORS — pins must read
 * identically over multi-hue metric tracks in both themes.
 */
export const WAYPOINT_COLORS: Record<WaypointKind, string> = {
  fuel: "#ec4899",
  climb: "#ef4444",
  water: "#0ea5e9",
  custom: "#14b8a6",
};

/** Keep split dots readable: thin km marks beyond this count. */
const MAX_SPLIT_MARKERS = 24;

/** Candidate km steps, coarsest last. */
const KM_STEPS = [1, 2, 5, 10, 20, 50];

/**
 * Kilometre markers from the cumulative distance stream, thinned to a 1/2/5…
 * km step so long rides don't drown the track in dots. The final mark is
 * dropped when it would sit on the finish marker.
 */
export function buildKmSplits(distanceStream: number[]): SplitMarker[] {
  const n = distanceStream.length;
  if (n < 2) return [];
  const start = distanceStream[0]!;
  const total = distanceStream[n - 1]! - start;
  const kmTotal = Math.floor(total / 1000);
  if (kmTotal < 1) return [];

  const step =
    KM_STEPS.find((s) => kmTotal / s <= MAX_SPLIT_MARKERS) ??
    KM_STEPS[KM_STEPS.length - 1]!;

  const markers: SplitMarker[] = [];
  let searchFrom = 0;
  for (let km = step; km <= kmTotal; km += step) {
    const target = start + km * 1000;
    // The stream is non-decreasing, so resume scanning where the last
    // marker landed.
    while (searchFrom < n - 1 && distanceStream[searchFrom]! < target) {
      searchFrom++;
    }
    // Skip a mark that collapses onto the finish.
    if (searchFrom >= n - 1) break;
    markers.push({ index: searchFrom, label: `${km} km` });
  }
  return markers;
}

/**
 * The split markers to render: lap boundaries when the server resolved any
 * (multi-lap activities), kilometre marks otherwise.
 */
export function buildSplitMarkers(data: RouteMapData): SplitMarker[] {
  const laps = data.annotations?.laps;
  if (laps && laps.length > 0) {
    return laps.map((lap) => ({ index: lap.endIndex, label: lap.name }));
  }
  const distance = data.streams?.distance;
  if (distance && distance.length === data.coordinates.length) {
    return buildKmSplits(distance);
  }
  return [];
}

/**
 * Caller-supplied waypoints as renderable markers. The server already
 * resolved indices and sorted by km; this just formats the hover title
 * (label plus the caller's distance, so "Gel 1 · 11 km" survives even when
 * the marker is tapped without the scrub tooltip).
 */
export function buildWaypointMarkers(data: RouteMapData): WaypointMarker[] {
  const waypoints = data.annotations?.waypoints;
  if (!waypoints || waypoints.length === 0) return [];
  return waypoints.map((waypoint) => ({
    index: waypoint.index,
    kind: waypoint.kind,
    title: `${waypoint.label} · ${Number(waypoint.km.toFixed(1))} km`,
  }));
}
