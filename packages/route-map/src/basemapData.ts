/**
 * Pure data preparation for the MapLibre basemap view: GeoJSON builders and
 * coordinate math, kept free of maplibre-gl so they unit-test without a map.
 * GeoJSON uses [lng, lat] ordering — the reverse of the `[lat, lng]` pairs
 * the rest of the app passes around. Colors here are concrete hex values:
 * MapLibre paints onto canvas and cannot resolve CSS custom properties.
 */

import {
  type SplitMarker,
  WAYPOINT_COLORS,
  type WaypointMarker,
} from "./annotations";
import { type ColorRun } from "./metrics";

/** Mirrors the grid view's split-marker color. */
export const BASEMAP_COLORS = {
  split: "#3266ad",
} as const;

export interface TrackFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { color: string };
    geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  }>;
}

/**
 * Minimal point FeatureCollection (markers, scrub dot). Structurally
 * assignable to GeoJSON's FeatureCollection without importing the types-only
 * `geojson` package, which the bundler cannot resolve at runtime.
 */
export interface PointFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, string>;
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

/**
 * The track as one LineString feature per color run (or a single feature in
 * `fallbackColor` when there are no runs), colored via a `color` property so
 * one MapLibre layer with a `['get', 'color']` paint expression draws it all.
 */
export function trackToGeoJson(
  coordinates: Array<[number, number]>,
  runs: ColorRun[],
  fallbackColor: string,
): TrackFeatureCollection {
  const toLngLat = (pairs: Array<[number, number]>) =>
    pairs.map(([lat, lng]) => [lng, lat] as [number, number]);

  if (runs.length === 0) {
    return {
      type: "FeatureCollection",
      features:
        coordinates.length < 2
          ? []
          : [
              {
                type: "Feature",
                properties: { color: fallbackColor },
                geometry: {
                  type: "LineString",
                  coordinates: toLngLat(coordinates),
                },
              },
            ],
    };
  }

  return {
    type: "FeatureCollection",
    features: runs.map((run) => ({
      type: "Feature",
      properties: { color: run.color },
      geometry: {
        type: "LineString",
        coordinates: toLngLat(
          coordinates.slice(run.startIndex, run.endIndex + 1),
        ),
      },
    })),
  };
}

/**
 * Bounding box of the track as [[west, south], [east, north]] for
 * `map.fitBounds`, or null when there is no geometry.
 */
export function trackBounds(
  coordinates: Array<[number, number]>,
): [[number, number], [number, number]] | null {
  if (coordinates.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lat, lng] of coordinates) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [
    [west, south],
    [east, north],
  ];
}

/** Point features with a `title` property for the hover popup. Waypoint
 * features also carry a `color` for the per-kind circle paint. */
export interface TitledPointFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { title: string; color?: string };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

/** Lap / km split markers as point features. */
export function splitsToGeoJson(
  coordinates: Array<[number, number]>,
  splits: SplitMarker[],
): TitledPointFeatureCollection {
  return {
    type: "FeatureCollection",
    features: splits.flatMap((split) => {
      const pair = coordinates[split.index];
      if (!pair) return [];
      return [
        {
          type: "Feature" as const,
          properties: { title: split.label },
          geometry: {
            type: "Point" as const,
            coordinates: [pair[1], pair[0]] as [number, number],
          },
        },
      ];
    }),
  };
}

/** Waypoint markers as point features, colored by kind via a `color`
 * property (one layer with a `['get', 'color']` paint draws every kind). */
export function waypointsToGeoJson(
  coordinates: Array<[number, number]>,
  waypoints: WaypointMarker[],
): TitledPointFeatureCollection {
  return {
    type: "FeatureCollection",
    features: waypoints.flatMap((waypoint) => {
      const pair = coordinates[waypoint.index];
      if (!pair) return [];
      return [
        {
          type: "Feature" as const,
          properties: {
            title: waypoint.title,
            color: WAYPOINT_COLORS[waypoint.kind],
          },
          geometry: {
            type: "Point" as const,
            coordinates: [pair[1], pair[0]] as [number, number],
          },
        },
      ];
    }),
  };
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Index of the track sample nearest to (lat, lng); the basemap scrub maps the
 * pointer's geographic position straight onto a sample. Equirectangular
 * comparison with cos-scaled longitude, accurate at activity scale. -1 when
 * the track is empty.
 */
export function nearestLatLngIndex(
  coordinates: Array<[number, number]>,
  lat: number,
  lng: number,
): number {
  const lngScale = Math.cos(lat * DEG_TO_RAD);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < coordinates.length; i++) {
    const dLat = coordinates[i]![0] - lat;
    const dLng = (coordinates[i]![1] - lng) * lngScale;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
