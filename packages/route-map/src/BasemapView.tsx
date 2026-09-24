/**
 * MapLibre basemap renderer: OpenFreeMap's Liberty style behind the
 * track, the default view when tiles are reachable (the offline SVG grid is
 * the silent fallback). Owns its own camera — MapLibre's native zoom/pan with
 * cooperative gestures so the conversation keeps scrolling — and renders the
 * full feature set as map layers: the metric-colored track (GeoJSON line
 * features per color run), lap/km split dots, and the scrub marker + value
 * tooltip shared with the elevation strip through the scrub index.
 */

import * as maplibregl from "maplibre-gl";
import workerCode from "maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type SplitMarker, type WaypointMarker } from "./annotations";
import {
  BASEMAP_COLORS,
  nearestLatLngIndex,
  type PointFeatureCollection,
  splitsToGeoJson,
  trackBounds,
  trackToGeoJson,
  waypointsToGeoJson,
} from "./basemapData";
import { type ColorRun } from "./metrics";
import styles from "./RouteMap.module.css";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre runs all source processing in a Web Worker, and by default (v6)
// spawns it from `new URL("./maplibre-gl-worker.mjs", import.meta.url)` — a
// sibling ES module importing a shared chunk. Inside the single HTML file
// vite-plugin-singlefile produces there are no sibling files, and a worker
// re-bundled naively by the app build historically lost its GeoJSON code path
// (geojson-vt ended up referenced from a scope the worker cannot see), so
// vector tiles still rendered but every GeoJSON overlay — the track, markers
// — threw in the worker and silently vanished. v5's answer was
// its pre-built self-contained CSP worker; v6 dropped that build, so the
// `?bundled-raw` import (the `bundledRawWorker` plugin in
// @intervals-mcp/vite-config) flattens the worker's import graph into one
// self-contained script in a dedicated build, which we hand over as a Blob
// URL exactly as before. The blob's origin matches the document's, so
// MapLibre spawns it directly as a module worker.
maplibregl.setWorkerUrl(
  URL.createObjectURL(
    new Blob([workerCode], { type: "application/javascript" }),
  ),
);

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
/** If the style hasn't loaded by then, treat tiles as unavailable. */
const LOAD_TIMEOUT_MS = 12000;

/** Plain-track color when no metric is selected (matches the SVG view). */
const FALLBACK_TRACK_COLOR = "#3b82f6";

/** Annotation layer ids, in render order. */
const SPLITS_LAYER = "splits";
const WAYPOINTS_LAYER = "waypoints";
const WAYPOINTS_DOT_LAYER = "waypoints-dot";

export interface BasemapLayerVisibility {
  splits: boolean;
  waypoints: boolean;
}

interface BasemapViewProps {
  /** Accessible name for the map canvas (MapLibre's default is just "Map"). */
  accessibleLabel: string;
  coordinates: Array<[number, number]>;
  colorRuns: ColorRun[];
  /** Resolved annotation markers (already index-anchored). */
  splitMarkers: SplitMarker[];
  waypointMarkers: WaypointMarker[];
  /** Footer legend toggles, applied as layer visibility. */
  visibility: BasemapLayerVisibility;
  mode: "mobile" | "desktop";
  scrubIndex: number | null;
  /** Scrub from map hover/tap; null clears. */
  onScrub: (index: number | null) => void;
  /** Value tooltip content for the current scrub index, rendered at the
   * scrubbed point; the caller owns the content, this view owns position. */
  scrubTip?: ReactNode;
  /** Tiles failed to load — the caller falls back to the offline grid. */
  onFail: () => void;
}

function scrubPointGeoJson(
  coordinates: Array<[number, number]>,
  index: number | null,
): PointFeatureCollection {
  const pair = index != null ? coordinates[index] : undefined;
  return {
    type: "FeatureCollection",
    features: pair
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [pair[1], pair[0]] },
          },
        ]
      : [],
  };
}

export function BasemapView({
  accessibleLabel,
  coordinates,
  colorRuns,
  splitMarkers,
  waypointMarkers,
  visibility,
  mode,
  scrubIndex,
  onScrub,
  scrubTip,
  onFail,
}: BasemapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  // Tooltip anchor in container pixels, recomputed on scrub and camera moves.
  const [tipPoint, setTipPoint] = useState<{ x: number; y: number } | null>(
    null,
  );

  const track = useMemo(
    () => trackToGeoJson(coordinates, colorRuns, FALLBACK_TRACK_COLOR),
    [coordinates, colorRuns],
  );

  // Latest values for handlers bound once at map creation.
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;
  const trackRef = useRef(track);
  trackRef.current = track;
  const scrubIndexRef = useRef(scrubIndex);
  scrubIndexRef.current = scrubIndex;
  const annotationsRef = useRef({ splitMarkers, waypointMarkers });
  annotationsRef.current = { splitMarkers, waypointMarkers };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = trackBounds(coordinatesRef.current);
    if (!bounds) return;

    const map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      bounds,
      fitBoundsOptions: { padding: 36 },
      // Two-finger pan on touch, ctrl/cmd+wheel zoom on desktop: the map sits
      // inside a scrollable conversation and must not trap the scroll.
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    const failTimer = setTimeout(() => {
      if (!loadedRef.current) onFailRef.current();
    }, LOAD_TIMEOUT_MS);

    map.on("error", (e) => {
      // An error before the style itself loads means no usable basemap
      // (blocked origin, offline, bad style) — fall back. Once the style is
      // in, individual tile/sprite errors are cosmetic and must not nuke the
      // map back to the grid.
      if (!loadedRef.current && !map.isStyleLoaded()) {
        clearTimeout(failTimer);
        onFailRef.current();
      } else {
        console.warn("route-map basemap: maplibre error", e.error);
      }
    });

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
    });

    map.on("load", () => {
      loadedRef.current = true;
      clearTimeout(failTimer);

      const coords = coordinatesRef.current;
      const { splitMarkers, waypointMarkers } = annotationsRef.current;

      // Guard every add individually: maplibre's addSource throws
      // synchronously (e.g. on a duplicate id), and an unguarded throw here
      // aborted the whole handler — one bad call blanked every layer while
      // the basemap kept rendering. Failures are logged with their id so a
      // report from the host console pins the root cause.
      const addSourceSafe = (
        id: string,
        spec: maplibregl.SourceSpecification,
      ) => {
        try {
          map.addSource(id, spec);
        } catch (error) {
          console.error(`route-map basemap: addSource "${id}" failed`, error);
        }
      };
      const addLayerSafe = (spec: maplibregl.AddLayerObject) => {
        try {
          map.addLayer(spec);
        } catch (error) {
          console.error(
            `route-map basemap: addLayer "${spec.id}" failed`,
            error,
          );
        }
      };

      addSourceSafe("track", { type: "geojson", data: trackRef.current });
      addLayerSafe({
        id: "track-casing",
        type: "line",
        source: "track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 6,
          "line-opacity": 0.9,
        },
      });
      addLayerSafe({
        id: "track-line",
        type: "line",
        source: "track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 3.5 },
      });

      addSourceSafe("splits", {
        type: "geojson",
        data: splitsToGeoJson(coords, splitMarkers),
      });
      addLayerSafe({
        id: SPLITS_LAYER,
        type: "circle",
        source: "splits",
        paint: {
          "circle-radius": 4,
          "circle-color": "#ffffff",
          "circle-stroke-color": BASEMAP_COLORS.split,
          "circle-stroke-width": 2,
        },
      });

      // Waypoints: caller-pinned markers, colored per kind (fuel/climb/…).
      addSourceSafe("waypoints", {
        type: "geojson",
        data: waypointsToGeoJson(coords, waypointMarkers),
      });
      addLayerSafe({
        id: WAYPOINTS_LAYER,
        type: "circle",
        source: "waypoints",
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      addLayerSafe({
        id: WAYPOINTS_DOT_LAYER,
        type: "circle",
        source: "waypoints",
        paint: { "circle-radius": 2, "circle-color": "#ffffff" },
      });

      const endpoints: PointFeatureCollection = {
        type: "FeatureCollection",
        features: [
          { kind: "start", pair: coords[0] },
          { kind: "end", pair: coords[coords.length - 1] },
        ].flatMap(({ kind, pair }) =>
          pair
            ? [
                {
                  type: "Feature" as const,
                  properties: { kind },
                  geometry: {
                    type: "Point" as const,
                    coordinates: [pair[1], pair[0]] as [number, number],
                  },
                },
              ]
            : [],
        ),
      };
      addSourceSafe("endpoints", { type: "geojson", data: endpoints });
      addLayerSafe({
        id: "endpoints",
        type: "circle",
        source: "endpoints",
        paint: {
          "circle-radius": 6,
          "circle-color": [
            "match",
            ["get", "kind"],
            "start",
            "#275b19",
            "#7f2c28",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      addSourceSafe("scrub", {
        type: "geojson",
        data: scrubPointGeoJson(coords, scrubIndexRef.current),
      });
      addLayerSafe({
        id: "scrub",
        type: "circle",
        source: "scrub",
        paint: {
          "circle-radius": 5,
          "circle-color": "#14141a",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      // Hover popups for the point markers ("Lap 2"). Bound only to layers
      // that actually got added: delegated listeners on a missing layer make
      // maplibre error on every pointer move.
      for (const layerId of [SPLITS_LAYER, WAYPOINTS_LAYER]) {
        if (!map.getLayer(layerId)) continue;
        map.on("mousemove", layerId, (e) => {
          const title = e.features?.[0]?.properties?.title;
          if (typeof title !== "string" || title.length === 0) return;
          map.getCanvas().style.cursor = "pointer";
          popup.setLngLat(e.lngLat).setText(title).addTo(map);
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
          popup.remove();
        });
      }

      // One summary line for bug reports: which overlay layers are live.
      const missing = [
        "track-line",
        "track-casing",
        "endpoints",
        "scrub",
        SPLITS_LAYER,
        WAYPOINTS_LAYER,
      ].filter((id) => !map.getLayer(id));
      if (missing.length > 0) {
        console.error(
          `route-map basemap: ${missing.length} overlay layer(s) missing after load: ${missing.join(", ")}`,
        );
      }

      setLoaded(true);
    });

    const scrubAt = (lngLat: maplibregl.LngLat) => {
      if (!loadedRef.current) return;
      onScrubRef.current(
        nearestLatLngIndex(coordinatesRef.current, lngLat.lat, lngLat.lng),
      );
    };
    map.on("mousemove", (e) => scrubAt(e.lngLat));
    // Touch drags pan the map; a tap is the touch scrub gesture.
    map.on("click", (e) => scrubAt(e.lngLat));
    map.on("mouseout", () => onScrubRef.current(null));

    // Keep the tooltip glued to the scrubbed point while the camera moves.
    const repositionTip = () => {
      const index = scrubIndexRef.current;
      const pair = index != null ? coordinatesRef.current[index] : undefined;
      setTipPoint(pair ? map.project([pair[1], pair[0]]) : null);
    };
    map.on("move", repositionTip);

    return () => {
      clearTimeout(failTimer);
      mapRef.current = null;
      loadedRef.current = false;
      popup.remove();
      map.remove();
    };
    // The map is created once per mount; data changes remount via key.
  }, []);

  // MapLibre exposes the canvas as a region labelled just "Map"; give it the
  // route's name instead (the visually-hidden narration sits alongside).
  useEffect(() => {
    mapRef.current?.getCanvas().setAttribute("aria-label", accessibleLabel);
  }, [accessibleLabel]);

  // Keep the track + scrub sources in sync without recreating the map.
  useEffect(() => {
    if (!loaded) return;
    const source = mapRef.current?.getSource<maplibregl.GeoJSONSource>("track");
    source?.setData(track);
  }, [track, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current;
    if (!map) return;
    map
      .getSource<maplibregl.GeoJSONSource>("scrub")
      ?.setData(scrubPointGeoJson(coordinates, scrubIndex));
    const pair = scrubIndex != null ? coordinates[scrubIndex] : undefined;
    setTipPoint(pair ? map.project([pair[1], pair[0]]) : null);
  }, [scrubIndex, coordinates, loaded]);

  // Footer legend toggles map onto layer visibility.
  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current;
    if (!map) return;
    const apply = (layerIds: string[], visible: boolean) => {
      for (const id of layerIds) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        }
      }
    };
    apply([SPLITS_LAYER], visibility.splits);
    apply([WAYPOINTS_LAYER, WAYPOINTS_DOT_LAYER], visibility.waypoints);
  }, [visibility, loaded]);

  const containerWidth = containerRef.current?.clientWidth ?? 0;

  return (
    <div className={styles.basemapWrap}>
      <div
        ref={containerRef}
        className={styles.basemap}
        data-compact={mode === "mobile" || undefined}
      />
      {scrubTip && tipPoint && (
        <div
          className={styles.scrubTip}
          data-flip={
            (containerWidth > 0 && tipPoint.x > containerWidth * 0.55) ||
            undefined
          }
          style={{ left: tipPoint.x, top: tipPoint.y }}
        >
          {scrubTip}
        </div>
      )}
    </div>
  );
}
