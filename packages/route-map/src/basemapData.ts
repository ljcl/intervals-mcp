/**
 * Pure data preparation for the MapLibre basemap view: GeoJSON builders and
 * coordinate math, kept free of maplibre-gl so they unit-test without a map.
 * GeoJSON uses [lng, lat] ordering — the reverse of the `[lat, lng]` pairs
 * the rest of the app passes around. Colors here are concrete hex values:
 * MapLibre paints onto canvas and cannot resolve CSS custom properties.
 */

import { TIER_COLORS } from "@intervals-mcp/design-system";
import {
  type PhotoMarker,
  type SplitMarker,
  WAYPOINT_COLORS,
  type WaypointMarker,
} from "./annotations";
import { type ColorRun } from "./metrics";
import { type RouteAnnotations } from "./types";

/** Mirrors the grid view's halo colors (gold = PR, light purple = top-10). */
export const BASEMAP_COLORS = {
  segmentPr: TIER_COLORS.pr,
  segmentTop10: TIER_COLORS.top10,
  segment: "#8b5cf6",
  split: "#3266ad",
  photo: "#f97316",
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

/** Line features for segment-effort halos, colored by achievement tier. */
export interface SegmentHaloFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { color: string; title: string };
    geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  }>;
}

/**
 * Segment-effort spans as halo line features. The `title` property feeds the
 * hover popup ("name · PR" / "name · Top 10").
 */
export function segmentsToGeoJson(
  coordinates: Array<[number, number]>,
  segments: NonNullable<RouteAnnotations["segments"]>,
): SegmentHaloFeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.flatMap((segment) => {
      const span = coordinates.slice(segment.startIndex, segment.endIndex + 1);
      if (span.length < 2) return [];
      return [
        {
          type: "Feature" as const,
          properties: {
            color: segment.isPr
              ? BASEMAP_COLORS.segmentPr
              : segment.isTop10
                ? BASEMAP_COLORS.segmentTop10
                : BASEMAP_COLORS.segment,
            title: `${segment.name}${
              segment.isPr ? " · PR" : segment.isTop10 ? " · Top 10" : ""
            }`,
          },
          geometry: {
            type: "LineString" as const,
            coordinates: span.map(
              ([lat, lng]) => [lng, lat] as [number, number],
            ),
          },
        },
      ];
    }),
  };
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

/** Grouped photo markers as point features. */
export function photosToGeoJson(
  coordinates: Array<[number, number]>,
  photos: PhotoMarker[],
): TitledPointFeatureCollection {
  return {
    type: "FeatureCollection",
    features: photos.flatMap((photo) => {
      const pair = coordinates[photo.index];
      if (!pair) return [];
      const title = [
        photo.count === 1 ? "1 photo" : `${photo.count} photos`,
        photo.caption,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          type: "Feature" as const,
          properties: { title },
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
