/**
 * MapLibre basemap renderer: OpenFreeMap's Liberty style (its dark style in a
 * dark host theme) behind the track, the default view when tiles are
 * reachable (the offline SVG grid is the silent fallback). Owns its own camera — MapLibre's native zoom/pan with
 * cooperative gestures so the conversation keeps scrolling — which the caller
 * can also frame (`set-viewport`) and which reports every move back, so the
 * caller describes the camera the user actually sees. Renders the full
 * feature set as map layers: the metric-colored track (GeoJSON line features
 * per color run), lap/km split dots, and the scrub marker + value tooltip
 * shared with the elevation strip through the scrub index.
 */

import { useDocumentTheme } from "@modelcontextprotocol/ext-apps/react";
import * as maplibregl from "maplibre-gl";
import workerCode from "maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type SplitMarker, type WaypointMarker } from "./annotations";
import {
  BASEMAP_PADDING,
  type CameraFrame,
  type CameraReport,
  createBasemapCamera,
} from "./basemapCamera";
import {
  BASEMAP_COLORS,
  nearestLatLngIndex,
  type PointFeatureCollection,
  rangeToGeoJson,
  splitsToGeoJson,
  stretchesToGeoJson,
  trackBounds,
  trackToGeoJson,
  viasToGeoJson,
  waypointsToGeoJson,
} from "./basemapData";
import { type ColorRun } from "./metrics";
import styles from "./RouteMap.module.css";
import { type StretchMarker } from "./routeLayers";
import { type RouteVia } from "./types";
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

/** OpenFreeMap style per host theme; both stay on the origin `ROUTE_MAP_CSP`
 * allows (their tiles, sprites and glyphs too). */
export const STYLE_URLS = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;
/** If the style hasn't loaded by then, treat tiles as unavailable. */
const LOAD_TIMEOUT_MS = 12000;

/** Plain-track color when no metric is selected (matches the SVG view). */
const FALLBACK_TRACK_COLOR = "#3b82f6";

/** Annotation layer ids, in render order. */
const SPLITS_LAYER = "splits";
const WAYPOINTS_LAYER = "waypoints";
const WAYPOINTS_DOT_LAYER = "waypoints-dot";
const STRETCHES_LAYER = "stretches";
const VIAS_LAYER = "vias";

export interface BasemapLayerVisibility {
  splits: boolean;
  waypoints: boolean;
}

/** Map gestures that change a stored route. */
export interface BasemapEdit {
  /** A tap or click on the map adds a point there (not a scrub). */
  addMode: boolean;
  onPick: (lat: number, lng: number) => void;
  onSelectVia: (id: string) => void;
  /** A via point was dragged and let go here. */
  onMoveVia: (id: string, lat: number, lng: number) => void;
}

/** What a stored route adds to the map. */
export interface BasemapRouteOverlay {
  /** The compared version's line, drawn dashed under the route. */
  compare: Array<[number, number]> | null;
  /** The part that changed from the compared version, as track indices. */
  changed: { startIndex: number; endIndex: number } | null;
  vias: RouteVia[];
  selectedViaId: string | null;
  /** Null when the shown version cannot be changed here. */
  edit: BasemapEdit | null;
}

interface BasemapViewProps {
  /** Accessible name for the map canvas (MapLibre's default is just "Map"). */
  accessibleLabel: string;
  coordinates: Array<[number, number]>;
  colorRuns: ColorRun[];
  /** Resolved annotation markers (already index-anchored). */
  splitMarkers: SplitMarker[];
  waypointMarkers: WaypointMarker[];
  /** Stretch pins, highlighted along the line with the waypoints. */
  stretches?: StretchMarker[];
  /** A stored route's compare line, changed part, vias and edit gestures. */
  route?: BasemapRouteOverlay | null;
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
  /** Bounds to fit the camera to; a new nonce moves it again. */
  frame?: CameraFrame;
  /** Every camera move, the user's own included: the bounds in view and the
   * zoom relative to the whole-route fit. */
  onCamera?: (camera: CameraReport) => void;
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
  stretches = [],
  route = null,
  visibility,
  mode,
  scrubIndex,
  onScrub,
  scrubTip,
  onFail,
  frame,
  onCamera,
}: BasemapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // useHostStyles puts the host theme on the document; this follows it.
  const styleUrl = STYLE_URLS[useDocumentTheme()];
  const styleUrlRef = useRef(styleUrl);
  /** Swaps the style in place, keeping the camera; set by the map effect. */
  const restyleRef = useRef<((url: string) => void) | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const cameraRef = useRef<ReturnType<typeof createBasemapCamera> | null>(null);
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
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;
  const trackRef = useRef(track);
  trackRef.current = track;
  const scrubIndexRef = useRef(scrubIndex);
  scrubIndexRef.current = scrubIndex;
  const annotationsRef = useRef({ splitMarkers, waypointMarkers, stretches });
  annotationsRef.current = { splitMarkers, waypointMarkers, stretches };
  const routeRef = useRef(route);
  routeRef.current = route;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = trackBounds(coordinatesRef.current);
    if (!bounds) return;

    const map = new maplibregl.Map({
      container,
      style: styleUrlRef.current,
      bounds,
      fitBoundsOptions: { padding: BASEMAP_PADDING },
      // Two-finger pan on touch, ctrl/cmd+wheel zoom on desktop: the map sits
      // inside a scrollable conversation and must not trap the scroll.
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    // Registered ahead of the layer setup below, so its load listener reads
    // the whole-route fit zoom before anything else runs on load.
    cameraRef.current = createBasemapCamera(map, (camera) =>
      onCameraRef.current?.(camera),
    );

    let failTimer: ReturnType<typeof setTimeout> | undefined;
    const watchStyleLoad = () => {
      clearTimeout(failTimer);
      failTimer = setTimeout(() => {
        if (!loadedRef.current) onFailRef.current();
      }, LOAD_TIMEOUT_MS);
    };
    watchStyleLoad();

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

    // A new style starts empty, so the overlays go on again with each one.
    const addOverlays = () => {
      loadedRef.current = true;
      clearTimeout(failTimer);

      const coords = coordinatesRef.current;
      const { splitMarkers, waypointMarkers, stretches } =
        annotationsRef.current;
      const overlay = routeRef.current;

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

      // A stored route: the compared version dashed under everything, and
      // a halo under the part that changed.
      if (overlay?.compare && overlay.compare.length > 1) {
        addSourceSafe("compare", {
          type: "geojson",
          data: trackToGeoJson(overlay.compare, [], BASEMAP_COLORS.compare),
        });
        addLayerSafe({
          id: "compare-line",
          type: "line",
          source: "compare",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": BASEMAP_COLORS.compare,
            "line-width": 3,
            "line-opacity": 0.7,
            "line-dasharray": [2, 2],
          },
        });
      }
      if (overlay?.changed) {
        addSourceSafe("changed", {
          type: "geojson",
          data: rangeToGeoJson(
            coords,
            overlay.changed.startIndex,
            overlay.changed.endIndex,
            BASEMAP_COLORS.changed,
          ),
        });
        addLayerSafe({
          id: "changed-halo",
          type: "line",
          source: "changed",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": BASEMAP_COLORS.changed,
            "line-width": 14,
            "line-opacity": 0.55,
          },
        });
      }

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

      // Stretch pins: a wide, light band in the pin's colour over the line.
      addSourceSafe("stretches", {
        type: "geojson",
        data: stretchesToGeoJson(coords, stretches),
      });
      addLayerSafe({
        id: STRETCHES_LAYER,
        type: "line",
        source: "stretches",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 10,
          "line-opacity": 0.4,
        },
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

      // Via points: dark circles, a turnaround in amber; the selected one
      // has a wider ring.
      if (overlay && overlay.vias.length > 0) {
        addSourceSafe("vias", {
          type: "geojson",
          data: viasToGeoJson(overlay.vias, overlay.selectedViaId),
        });
        addLayerSafe({
          id: VIAS_LAYER,
          type: "circle",
          source: "vias",
          paint: {
            // Bigger on a phone, where a finger drags it.
            "circle-radius": modeRef.current === "mobile" ? 10 : 7,
            "circle-color": [
              "match",
              ["get", "kind"],
              "turnaround",
              BASEMAP_COLORS.turnaround,
              BASEMAP_COLORS.via,
            ],
            "circle-stroke-color": [
              "case",
              ["==", ["get", "selected"], 1],
              BASEMAP_COLORS.changed,
              "#ffffff",
            ],
            "circle-stroke-width": [
              "case",
              ["==", ["get", "selected"], 1],
              4,
              2,
            ],
          },
        });
      }

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
    };

    map.on("load", () => {
      addOverlays();

      // Hover popups for the point markers ("Lap 2"). Bound only to layers
      // that actually got added: delegated listeners on a missing layer make
      // maplibre error on every pointer move.
      for (const layerId of [SPLITS_LAYER, WAYPOINTS_LAYER, VIAS_LAYER]) {
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
    });

    // Delegated hover listeners survive a style swap (MapLibre skips layers
    // that are missing meanwhile); the overlays themselves must be re-added.
    // Until the new style loads, an error falls back to the grid as at mount.
    restyleRef.current = (url) => {
      const overlaysLive = loadedRef.current;
      loadedRef.current = false;
      setLoaded(false);
      watchStyleLoad();
      map.setStyle(url, { diff: false });
      // Before the first load, `load` itself adds them to the new style.
      if (overlaysLive) map.once("style.load", addOverlays);
    };

    const scrubAt = (lngLat: maplibregl.LngLat) => {
      if (!loadedRef.current) return;
      onScrubRef.current(
        nearestLatLngIndex(coordinatesRef.current, lngLat.lat, lngLat.lng),
      );
    };
    /** The via point under a map point, when the route can be changed. */
    const viaAt = (point: maplibregl.PointLike): string | null => {
      if (!routeRef.current?.edit || !map.getLayer(VIAS_LAYER)) return null;
      const id = map.queryRenderedFeatures(point, { layers: [VIAS_LAYER] })[0]
        ?.properties?.id;
      return typeof id === "string" ? id : null;
    };

    // Dragging a via point: the map does not pan while the point moves, the
    // point follows the pointer, and letting go asks to move it there.
    let drag: { id: string; at: maplibregl.LngLat | null } | null = null;
    const viaSource = () =>
      map.getSource<maplibregl.GeoJSONSource>("vias") ?? null;
    const onDragMove = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent,
    ) => {
      const overlay = routeRef.current;
      if (!drag || !overlay) return;
      drag.at = e.lngLat;
      viaSource()?.setData(
        viasToGeoJson(overlay.vias, overlay.selectedViaId, {
          id: drag.id,
          point: [e.lngLat.lat, e.lngLat.lng],
        }),
      );
    };
    const onDragEnd = () => {
      map.off("mousemove", onDragMove);
      map.off("touchmove", onDragMove);
      const done = drag;
      drag = null;
      map.getCanvas().style.cursor = "";
      if (done?.at) {
        routeRef.current?.edit?.onMoveVia(done.id, done.at.lat, done.at.lng);
      }
    };
    const onDragStart = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent,
    ) => {
      if ("points" in e && e.points.length !== 1) return;
      const id = viaAt(e.point);
      if (!id) return;
      // Keeps the map from panning under the point.
      e.preventDefault();
      drag = { id, at: null };
      map.getCanvas().style.cursor = "grabbing";
      map.on("mousemove", onDragMove);
      map.on("touchmove", onDragMove);
      map.once("mouseup", onDragEnd);
      map.once("touchend", onDragEnd);
    };
    map.on("mousedown", onDragStart);
    map.on("touchstart", onDragStart);

    map.on("mousemove", (e) => {
      if (!drag) scrubAt(e.lngLat);
    });
    // Touch drags pan the map; a tap is the touch scrub gesture. While the
    // route is being changed, a tap on a via point selects it, and in add
    // mode a tap anywhere else adds a point there.
    map.on("click", (e) => {
      const edit = routeRef.current?.edit;
      if (edit) {
        const id = viaAt(e.point);
        if (id) {
          edit.onSelectVia(id);
          return;
        }
        if (edit.addMode) {
          edit.onPick(e.lngLat.lat, e.lngLat.lng);
          return;
        }
      }
      scrubAt(e.lngLat);
    });
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
      cameraRef.current = null;
      restyleRef.current = null;
      loadedRef.current = false;
      popup.remove();
      map.remove();
    };
    // The map is created once per mount; data changes remount via key.
  }, []);

  // Host theme changes swap the style on the live map, camera untouched.
  useEffect(() => {
    if (styleUrl === styleUrlRef.current) return;
    styleUrlRef.current = styleUrl;
    restyleRef.current?.(styleUrl);
  }, [styleUrl]);

  // Declared after the map-creation effect so the camera exists on mount; a
  // frame that arrives before the style loads is held until it does.
  useEffect(() => {
    if (frame) cameraRef.current?.frame(frame);
  }, [frame]);

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

  // Via points follow the selection (and drop a drag preview once the
  // route reloads).
  const vias = route?.vias;
  const selectedViaId = route?.selectedViaId ?? null;
  useEffect(() => {
    if (!loaded || !vias) return;
    mapRef.current
      ?.getSource<maplibregl.GeoJSONSource>("vias")
      ?.setData(viasToGeoJson(vias, selectedViaId));
  }, [vias, selectedViaId, loaded]);

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
    apply(
      [WAYPOINTS_LAYER, WAYPOINTS_DOT_LAYER, STRETCHES_LAYER],
      visibility.waypoints,
    );
  }, [visibility, loaded]);

  const containerWidth = containerRef.current?.clientWidth ?? 0;

  return (
    <div className={styles.basemapWrap}>
      <div
        ref={containerRef}
        className={styles.basemap}
        data-compact={mode === "mobile" || undefined}
        data-adding={route?.edit?.addMode || undefined}
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
