import { formatTime } from "@intervals-mcp/data";
import {
  CardHeader,
  EmptyState,
  Legend,
  LegendItem,
  type ModelContextApp,
  Pill,
  PillGroup,
  RampLegend,
  TooltipEntry,
  Tooltip as UiTooltip,
  useModelContextSync,
  useViewTool,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildElevationStripDescription,
  buildRouteMapA11yDescription,
} from "./a11yDescription";
import {
  buildSplitMarkers,
  buildWaypointMarkers,
  type SplitMarker,
  WAYPOINT_COLORS,
} from "./annotations";
import { BasemapView } from "./BasemapView";
import { type CameraFrame, type CameraReport } from "./basemapCamera";
import { boundsContain, frameBoundsForRange, trackBounds } from "./basemapData";
import { buildRouteMapContextSummary } from "./contextSummary";
import { buildElevationProfile, nearestXIndex } from "./elevationProfile";
import {
  buildColorRuns,
  buildMetricSeries,
  buildTrackSegments,
  colorForValue,
  type MetricKey,
  RAMP_GRADIENT_CSS,
} from "./metrics";
import {
  nearestPointIndex,
  type Point,
  pointsPath,
  projectRoute,
} from "./normalize";
import {
  canZoomIn,
  isZoomed,
  KEYBOARD_PAN_FRACTION,
  KEYBOARD_ZOOM_FACTOR,
  panByFraction,
  panViewBox,
  type ViewBox,
  zoomAboutCenter,
  zoomLevel,
  zoomViewBox,
} from "./panZoom";
import { RouteDetails } from "./RouteDetails";
import { RouteEditPanel } from "./RouteEditPanel";
import styles from "./RouteMap.module.css";
import { formatLatLng, nearestRouteKm } from "./routeEdit";
import {
  buildSectionRuns,
  buildStretchMarkers,
  compareText,
  routeKmMarkers,
  routeWarnings,
  sectionColorRuns,
} from "./routeLayers";
import { type RouteMapData, type SuggestionPosition } from "./types";
import { type RouteAmend } from "./useRouteAmend";
import {
  describeView,
  frameForIndexRange,
  gridViewForRange,
  type IndexRange,
  visibleRoute,
} from "./viewport";
import { resolveViewportRequest } from "./viewportRequest";

interface RouteMapProps {
  data: RouteMapData;
  mode?: "mobile" | "desktop";
  app?: ModelContextApp;
  /** Where `set-viewport`'s implementation is installed. */
  viewToolRegistry?: ViewToolRegistry | null;
  /** Set false to force the offline grid view (stories — the basemap renders
   * live tiles, which need the network and can't render deterministically). */
  basemapEnabled?: boolean;
  /** Rendered right after the card header, before the map (suggestion picker). */
  beforeMap?: ReactNode;
  /** A stored route's edit wiring (`useRouteAmend`). The controls show only
   * with it and when the shown version is the latest. */
  routeEdit?: RouteAmend | null;
  /** A line the model context starts with, e.g. the edit just applied. */
  contextNote?: string | null;
  /** A suggested route's place among its planned run's options. */
  suggestion?: SuggestionPosition | null;
}

/** Frame geometry per layout. All values are SVG viewBox units. */
const DIMS = {
  desktop: {
    width: 640,
    height: 380,
    padding: 28,
    stroke: 3,
    marker: 6,
    strip: 64,
  },
  mobile: {
    width: 340,
    height: 300,
    padding: 22,
    stroke: 3.5,
    marker: 7,
    strip: 56,
  },
} as const;

/** Headroom above the elevation strip's highest point, in viewBox units. */
const STRIP_PAD_TOP = 8;

/** Wheel-step zoom factor. */
const WHEEL_ZOOM_FACTOR = 1.2;

/** A via point moves only after the pointer travels this far (viewBox units,
 * at base zoom), so a tap selects it instead. */
const VIA_DRAG_THRESHOLD = 4;

const GRID_ID = "route-map-grid";

type LayerKey = "splits" | "waypoints";

const LAYER_COLORS: Record<LayerKey, string> = {
  splits: "var(--color-text-info)",
  waypoints: WAYPOINT_COLORS.custom,
};

/** Diamond path centred on (cx, cy) — waypoint pins read distinctly from the
 * circular split markers. */
function diamondPath(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`;
}

/** Line-icon glyphs for the grid view's zoom buttons (plus / minus / fit). */
const ZOOM_ICON_PATHS: Record<"in" | "out" | "reset", string> = {
  in: "M7 3.5v7 M3.5 7h7",
  out: "M3.5 7h7",
  reset: "M2.5 5V2.5H5 M9 2.5h2.5V5 M2.5 9v2.5H5 M11.5 9v2.5H9",
};

function ZoomIcon({ kind }: { kind: "in" | "out" | "reset" }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ZOOM_ICON_PATHS[kind]} />
    </svg>
  );
}

function formatKm(metres: number): string {
  const km = metres / 1000;
  return km >= 10 ? km.toFixed(1) : km.toFixed(2);
}

export function RouteMap({
  data,
  mode = "desktop",
  app,
  viewToolRegistry = null,
  basemapEnabled = true,
  beforeMap,
  routeEdit = null,
  contextNote = null,
  suggestion = null,
}: RouteMapProps) {
  const isMobile = mode === "mobile";
  const dims = isMobile ? DIMS.mobile : DIMS.desktop;
  const distanceKm = data.distance / 1000;
  /** A stored route: drawn by section, with vias, versions and edits. */
  const route = data.route ?? null;
  const compareCoordinates = route?.compare?.coordinates;

  const projected = useMemo(
    () =>
      projectRoute(
        data.coordinates,
        {
          width: dims.width,
          height: dims.height,
          padding: dims.padding,
        },
        // The compared version shares the frame, so both lines fit.
        compareCoordinates,
      ),
    [
      data.coordinates,
      compareCoordinates,
      dims.width,
      dims.height,
      dims.padding,
    ],
  );

  const sections = useMemo(
    () => (route ? buildSectionRuns(route, data.coordinates.length) : []),
    [route, data.coordinates.length],
  );
  const stretches = useMemo(() => buildStretchMarkers(data), [data]);
  /** A stored route's warnings, its sections' and its pins'. */
  const warnings = useMemo(
    () => (data.route ? routeWarnings(data) : []),
    [data],
  );

  const series = useMemo(() => buildMetricSeries(data), [data]);
  const [metricKey, setMetricKey] = useState<MetricKey | null>(
    () => series[0]?.key ?? null,
  );
  // Fall back to the first series if the selected metric vanishes (e.g. the
  // data refreshes without that stream), so the track stays colored.
  const activeSeries =
    series.find((s) => s.key === metricKey) ?? series[0] ?? null;

  // A stored route is coloured by section; the metric (altitude) then only
  // feeds the scrub tooltip.
  const segments = useMemo(
    () =>
      projected && activeSeries && !route
        ? buildTrackSegments(projected.points, activeSeries)
        : [],
    [projected, activeSeries, route],
  );

  // Same color binning as the SVG segments, as index runs for the basemap.
  const colorRuns = useMemo(
    () =>
      route
        ? sectionColorRuns(sections)
        : activeSeries
          ? buildColorRuns(activeSeries, data.coordinates.length)
          : [],
    [route, sections, activeSeries, data.coordinates.length],
  );

  /* ── Basemap ─────────────────────────────────────────────────── */

  // The basemap is the default view; a failed style load (blocked origin,
  // offline host, …) quietly falls back to the offline SVG grid.
  const [basemapFailed, setBasemapFailed] = useState(false);
  const showBasemap = basemapEnabled && !basemapFailed && projected !== null;

  const profile = useMemo(() => {
    const altitude = data.streams?.altitude;
    if (!altitude || altitude.length !== data.coordinates.length) return null;
    return buildElevationProfile(altitude, data.streams?.distance, {
      width: dims.width,
      height: dims.strip,
      padTop: STRIP_PAD_TOP,
    });
  }, [data.streams, data.coordinates.length, dims.width, dims.strip]);

  /* ── Annotation layers ───────────────────────────────────────── */

  const splitMarkers = useMemo(
    () => (data.route ? routeKmMarkers(data.route) : buildSplitMarkers(data)),
    [data],
  );
  const waypointMarkers = useMemo(() => buildWaypointMarkers(data), [data]);

  const layers = useMemo(() => {
    const out: Array<{ key: LayerKey; label: string }> = [];
    if (splitMarkers.length > 0) {
      out.push({
        key: "splits",
        label: data.route
          ? "Km markers"
          : data.annotations?.laps?.length
            ? "Laps"
            : "Splits",
      });
    }
    if (waypointMarkers.length > 0)
      out.push({ key: "waypoints", label: "Waypoints" });
    return out;
  }, [splitMarkers, waypointMarkers, data.annotations?.laps, data.route]);

  const [hiddenLayers, setHiddenLayers] = useState<Set<LayerKey>>(new Set());
  const layerVisible = (key: LayerKey) => !hiddenLayers.has(key);
  const toggleLayer = (key: LayerKey) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ── Zoom / pan ──────────────────────────────────────────────── */

  const base = useMemo<ViewBox>(
    () => ({ x: 0, y: 0, w: dims.width, h: dims.height }),
    [dims.width, dims.height],
  );
  const [view, setView] = useState<ViewBox>(base);
  useEffect(() => setView(base), [base]);
  // Handlers registered outside React (wheel) and gesture branches read the
  // live view through a ref to avoid re-binding per frame.
  const viewRef = useRef(view);
  viewRef.current = view;

  const zoomed = isZoomed(view, base);
  /** Screen-constant sizing: marker/stroke sizes shrink with the viewport. */
  const k = view.w / base.w;

  // State rather than a ref so the wheel effect re-runs when the SVG
  // unmounts/remounts (e.g. toggling the basemap off again).
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  /** Active pointers by id, in client coordinates (pan/pinch tracking). */
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const canZoom = projected !== null;
  useEffect(() => {
    const svg = svgEl;
    if (!svg || !canZoom) return;
    const onWheel = (e: WheelEvent) => {
      const zoomingOut = e.deltaY > 0;
      // Fully zoomed out: let the page scroll instead of trapping the wheel.
      if (zoomingOut && !isZoomed(viewRef.current, base)) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const factor = zoomingOut ? 1 / WHEEL_ZOOM_FACTOR : WHEEL_ZOOM_FACTOR;
      setView((v) => {
        const cx = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
        const cy = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
        return zoomViewBox(v, base, factor, cx, cy);
      });
    };
    // React's onWheel can't preventDefault (passive); bind directly.
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [canZoom, base, svgEl]);

  // What a view shows, in the one wording (`describeView`) the live region
  // and the model context share: the whole route exactly when every point is
  // in view, otherwise the stretches in view by km.
  const describeVisible = (
    isVisible: (index: number) => boolean,
    zoomFactor: number,
  ) => {
    const visible = visibleRoute(
      data.coordinates.length,
      isVisible,
      data.streams?.distance,
    );
    return { text: describeView(visible, zoomFactor), whole: visible.whole };
  };
  const describeGrid = (v: ViewBox) =>
    describeVisible(
      (i) => {
        const p = projected?.points[i];
        return (
          p !== undefined &&
          p.x >= v.x &&
          p.x <= v.x + v.w &&
          p.y >= v.y &&
          p.y <= v.y + v.h
        );
      },
      zoomLevel(v, base),
    );

  // Polite screen-reader narration of view changes (the SVG's <desc> is
  // static; this announces the button / keyboard zoom actions and the
  // basemap's camera moves as they happen).
  const [viewMessage, setViewMessage] = useState("");
  const applyView = (next: ViewBox) => {
    setView(next);
    setViewMessage(describeGrid(next).text);
  };
  const zoomByCenter = (factor: number) =>
    applyView(zoomAboutCenter(viewRef.current, base, factor));
  const resetView = () => applyView(base);

  // The basemap owns its camera: `set-viewport` hands it a frame to fit, and
  // every move (the model's or the user's own pan, zoom or resize) reports
  // the bounds in view back here.
  const [frame, setFrame] = useState<CameraFrame | undefined>();
  const frameNonce = useRef(0);
  // The stretch the last frame asked for (null: the whole route) until the
  // camera reports. Reports start on load, which applies a held frame, so
  // one still here when the basemap fails never applied.
  const [unapplied, setUnapplied] = useState<{
    range: IndexRange | null;
  } | null>(null);
  const frameBasemap = (
    bounds: CameraFrame["bounds"],
    range: IndexRange | null,
  ) => {
    frameNonce.current += 1;
    setFrame({ bounds, nonce: frameNonce.current });
    setUnapplied({ range });
  };
  /** What the basemap camera last showed, when not the whole route. */
  const [basemapPartial, setBasemapPartial] = useState<string | null>(null);
  const handleCamera = ({ zoomFactor, bounds }: CameraReport) => {
    const seen = describeVisible(
      (i) => boundsContain(bounds, data.coordinates[i]!),
      zoomFactor,
    );
    setBasemapPartial(seen.whole ? null : seen.text);
    setViewMessage(seen.text);
    setUnapplied(null);
  };

  // The fallback grid starts from the whole route, so a camera the basemap
  // reported must not outlive it. A frame it never got to apply (sent before
  // a failed load, #144) is framed and announced on the grid instead.
  const [cameraView, setCameraView] = useState(showBasemap);
  if (cameraView !== showBasemap) {
    setCameraView(showBasemap);
    setBasemapPartial(null);
    setFrame(undefined);
    setUnapplied(null);
    const pending =
      !showBasemap && projected && unapplied
        ? gridViewForRange(projected.points, unapplied.range, base)
        : null;
    if (pending) applyView(pending);
    else setViewMessage("");
  }

  /**
   * `set-viewport`: the model frames a stretch of the course by
   * distance, so "show me the climb at 14 km" moves the map instead of
   * describing it. Installed here rather than declared here — the tool is
   * registered before `connect()`, which is long before this component exists.
   *
   * It moves whichever view is showing: the basemap's camera, or the grid
   * through `applyView`, so a model-driven move clamps, counter-scales, and
   * announces itself exactly as the zoom buttons do. Either way the reply is
   * the same.
   */
  useViewTool(viewToolRegistry, "set-viewport", (args) => {
    const request = resolveViewportRequest(
      args,
      data.streams?.distance,
      distanceKm,
    );
    if (request.kind === "error") return { text: request.text, isError: true };

    if (request.kind === "reset") {
      const whole = showBasemap ? trackBounds(data.coordinates) : null;
      if (whole) frameBasemap(whole, null);
      else resetView();
      return { text: `Showing the whole route (${distanceKm.toFixed(1)} km).` };
    }

    if (!projected) {
      return {
        text: "This track has no GPS geometry to frame.",
        isError: true,
      };
    }

    if (showBasemap) {
      const bounds = frameBoundsForRange(data.coordinates, request.range);
      if (!bounds) {
        return {
          text: "That stretch has no geometry to frame.",
          isError: true,
        };
      }
      frameBasemap(bounds, request.range);
    } else {
      const next = frameForIndexRange(projected.points, request.range, base);
      if (!next) {
        return {
          text: "That stretch has no geometry to frame.",
          isError: true,
        };
      }
      applyView(next);
    }
    return {
      text: `Framed ${request.fromKm.toFixed(1)}–${request.toKm.toFixed(1)} km of ${data.name}.`,
    };
  });

  // Arrow keys pan (only meaningful when zoomed), +/- zoom about the centre,
  // 0 resets — reusing the same clamping/counter-scaling as the pointer paths.
  // Every key move goes through `applyView`, so a pan is announced as a zoom is.
  const handleMapKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!canZoom) return;
    const panIfZoomed = (fx: number, fy: number) => {
      // At base zoom there is nothing to pan; let the arrow scroll the page.
      if (!isZoomed(viewRef.current, base)) return;
      e.preventDefault();
      applyView(panByFraction(viewRef.current, base, fx, fy));
    };
    switch (e.key) {
      case "ArrowUp":
        panIfZoomed(0, -KEYBOARD_PAN_FRACTION);
        break;
      case "ArrowDown":
        panIfZoomed(0, KEYBOARD_PAN_FRACTION);
        break;
      case "ArrowLeft":
        panIfZoomed(-KEYBOARD_PAN_FRACTION, 0);
        break;
      case "ArrowRight":
        panIfZoomed(KEYBOARD_PAN_FRACTION, 0);
        break;
      case "+":
      case "=":
        e.preventDefault();
        zoomByCenter(KEYBOARD_ZOOM_FACTOR);
        break;
      case "-":
      case "_":
        e.preventDefault();
        zoomByCenter(1 / KEYBOARD_ZOOM_FACTOR);
        break;
      case "0":
        e.preventDefault();
        resetView();
        break;
      default:
        break;
    }
  };

  /* ── Route edits ─────────────────────────────────────────────── */

  const busy = routeEdit?.busy ?? false;
  /** The controls and map gestures exist only on the latest version. */
  const editable = route?.editable === true && routeEdit !== null;
  const vias = route?.vias ?? [];
  const [addMode, setAddMode] = useState(false);
  const [selectedViaId, setSelectedViaId] = useState<string | null>(null);
  // A new version may not have the selected point any more.
  const selectedVia = vias.find((v) => v.id === selectedViaId) ?? null;

  /** A point put on the map joins the route at the nearest km. */
  const pickPoint = (lat: number, lng: number) => {
    if (!editable || busy || !routeEdit) return;
    const km = nearestRouteKm(data, lat, lng);
    if (km === null) return;
    routeEdit.amend({ op: "insert_via", km, place: formatLatLng(lat, lng) });
    setAddMode(false);
  };
  const moveVia = (id: string, lat: number, lng: number) => {
    if (!editable || busy || !routeEdit) return;
    setSelectedViaId(id);
    routeEdit.amend({ op: "move_via", via_id: id, to: formatLatLng(lat, lng) });
  };

  // Grid drag of a via point. The preview stays where it was let go until
  // the change is done, then the new version (or the old point) shows.
  const viaDrag = useRef<{
    id: string;
    pointerId: number;
    start: Point;
    moved: boolean;
  } | null>(null);
  const [dragPoint, setDragPoint] = useState<{
    id: string;
    point: Point;
  } | null>(null);
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setDragPoint(null);
  }
  /** The click that ends a via tap or drag is not an add-point tap. */
  const suppressClick = useRef(false);

  const svgPointAt = (clientX: number, clientY: number, rect: DOMRect) => {
    const v = viewRef.current;
    return {
      x: v.x + ((clientX - rect.left) / rect.width) * v.w,
      y: v.y + ((clientY - rect.top) / rect.height) * v.h,
    };
  };

  const startViaDrag = (id: string) => (e: PointerEvent<SVGGElement>) => {
    if (!editable || busy || !svgEl) return;
    // The map must not pan or scrub under the point.
    e.stopPropagation();
    suppressClick.current = false;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    try {
      svgEl.setPointerCapture(e.pointerId);
    } catch {
      // No active pointer to capture (synthetic events); the drag still works
      // while the pointer stays over the map.
    }
    viaDrag.current = {
      id,
      pointerId: e.pointerId,
      start: svgPointAt(e.clientX, e.clientY, rect),
      moved: false,
    };
  };

  /** Ends a via drag: a move asks for the point there, a tap selects it. */
  const finishViaDrag = (e: PointerEvent<SVGSVGElement>): boolean => {
    const drag = viaDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return false;
    viaDrag.current = null;
    suppressClick.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    if (drag.moved && projected && rect.width > 0 && rect.height > 0) {
      const point = svgPointAt(e.clientX, e.clientY, rect);
      const [lat, lng] = projected.frame.unproject(point);
      setDragPoint({ id: drag.id, point });
      moveVia(drag.id, lat, lng);
    } else {
      setDragPoint(null);
      setSelectedViaId(drag.id);
    }
    return true;
  };

  const handleMapClick = (e: MouseEvent<SVGSVGElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!addMode || !projected) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const [lat, lng] = projected.frame.unproject(
      svgPointAt(e.clientX, e.clientY, rect),
    );
    pickPoint(lat, lng);
  };

  /* ── Scrub ───────────────────────────────────────────────────── */

  // One scrub index drives the markers on both the track and the elevation
  // strip; either surface's pointer can set it.
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const canScrub = projected !== null && activeSeries !== null;

  const scrubAt = (clientX: number, clientY: number, rect: DOMRect) => {
    if (!canScrub || !projected) return;
    const v = viewRef.current;
    const x = v.x + ((clientX - rect.left) / rect.width) * v.w;
    const y = v.y + ((clientY - rect.top) / rect.height) * v.h;
    const idx = nearestPointIndex(projected.points, x, y);
    setScrubIndex(idx >= 0 ? idx : null);
  };

  /* ── Map pointer gestures ────────────────────────────────────── */

  const handleMapPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    suppressClick.current = false;
    if (!canZoom) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const handleMapPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const drag = viaDrag.current;
    if (drag && drag.pointerId === e.pointerId) {
      const point = svgPointAt(e.clientX, e.clientY, rect);
      const travel = Math.hypot(point.x - drag.start.x, point.y - drag.start.y);
      if (!drag.moved && travel < VIA_DRAG_THRESHOLD * k) return;
      drag.moved = true;
      setScrubIndex(null);
      setDragPoint({ id: drag.id, point });
      return;
    }

    const tracked = pointers.current.get(e.pointerId);

    if (tracked && pointers.current.size === 2) {
      // Pinch: zoom by the finger-distance ratio around the midpoint, then
      // pan by the midpoint's movement.
      const other = [...pointers.current.entries()].find(
        ([id]) => id !== e.pointerId,
      )?.[1];
      if (!other) return;
      const prevDist = Math.hypot(tracked.x - other.x, tracked.y - other.y);
      const currDist = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const prevMid = {
        x: (tracked.x + other.x) / 2,
        y: (tracked.y + other.y) / 2,
      };
      const currMid = {
        x: (e.clientX + other.x) / 2,
        y: (e.clientY + other.y) / 2,
      };
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      setScrubIndex(null);
      setView((v) => {
        const cx = v.x + ((currMid.x - rect.left) / rect.width) * v.w;
        const cy = v.y + ((currMid.y - rect.top) / rect.height) * v.h;
        const scaled =
          prevDist > 0 ? zoomViewBox(v, base, currDist / prevDist, cx, cy) : v;
        return panViewBox(
          scaled,
          base,
          (-(currMid.x - prevMid.x) / rect.width) * scaled.w,
          (-(currMid.y - prevMid.y) / rect.height) * scaled.h,
        );
      });
      return;
    }

    if (tracked && pointers.current.size === 1) {
      const dragPans =
        e.pointerType !== "touch" || isZoomed(viewRef.current, base);
      if (dragPans) {
        const dx = e.clientX - tracked.x;
        const dy = e.clientY - tracked.y;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (isZoomed(viewRef.current, base)) {
          setScrubIndex(null);
          setView((v) =>
            panViewBox(
              v,
              base,
              (-dx / rect.width) * v.w,
              (-dy / rect.height) * v.h,
            ),
          );
          return;
        }
        // Mouse drag at base zoom has nothing to pan; fall through to scrub.
      }
      // Touch drag at base zoom scrubs (and the browser still owns vertical
      // scrolling via touch-action: pan-y).
    }

    scrubAt(e.clientX, e.clientY, rect);
  };

  const releasePointer = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };

  const handleMapPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    finishViaDrag(e);
    releasePointer(e);
  };

  /** A cancelled gesture (the browser took it) moves nothing. */
  const handleMapPointerCancel = (e: PointerEvent<SVGSVGElement>) => {
    if (viaDrag.current?.pointerId === e.pointerId) {
      viaDrag.current = null;
      setDragPoint(null);
    }
    releasePointer(e);
  };

  const clearScrub = (e: PointerEvent<SVGSVGElement>) => {
    if (viaDrag.current?.pointerId !== e.pointerId) releasePointer(e);
    setScrubIndex(null);
  };

  const handleStripPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!canScrub || !profile) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * dims.width;
    const idx = nearestXIndex(profile.xs, x);
    setScrubIndex(idx >= 0 ? idx : null);
  };

  /* ── Stored route layers (grid view) ─────────────────────────── */

  const routePaths = useMemo(() => {
    if (!projected || !route) return null;
    const { points, frame } = projected;
    const slice = (from: number, to: number) =>
      pointsPath(points.slice(from, to + 1));
    const compare = route.compare;
    return {
      sections: sections
        .filter((section) => section.endIndex > section.startIndex)
        .map((section) => ({
          key: section.index,
          color: section.color.css,
          path: slice(section.startIndex, section.endIndex),
        })),
      compare:
        compare && compare.coordinates.length > 1
          ? pointsPath(compare.coordinates.map(frame.project))
          : null,
      changed:
        compare?.change.changed && compare.endIndex > compare.startIndex
          ? slice(compare.startIndex, compare.endIndex)
          : null,
    };
  }, [projected, route, sections]);

  const stretchPaths = useMemo(
    () =>
      projected
        ? stretches.map((stretch) => ({
            ...stretch,
            path: pointsPath(
              projected.points.slice(stretch.startIndex, stretch.endIndex + 1),
            ),
          }))
        : [],
    [projected, stretches],
  );

  /* ── Accessibility ───────────────────────────────────────────── */

  // One rich screen-reader narration shared by both views: the basemap
  // renders it as visually-hidden text beside the canvas, the SVG grid as its
  // <desc>. Canvas has no accessible representation of its own.
  const a11yDescription = useMemo(
    () =>
      buildRouteMapA11yDescription({
        name: data.name,
        activityType: data.activityType,
        distanceKm,
        elevationGain: data.elevationGain,
        coordinates: data.coordinates,
        altitude: data.streams?.altitude,
        colorMetric: route ? null : (activeSeries?.label ?? null),
        // Counts reflect the layers actually drawn: a toggled-off layer
        // narrates as absent. Reads hiddenLayers directly (not the
        // layerVisible closure) so the dependency list stays honest.
        splitCount: hiddenLayers.has("splits") ? 0 : splitMarkers.length,
        splitKind: route
          ? "km"
          : data.annotations?.laps?.length
            ? "laps"
            : "splits",
        waypointCount: hiddenLayers.has("waypoints")
          ? 0
          : waypointMarkers.length,
        route: route
          ? {
              version: route.version,
              latestVersion: route.latest_version,
              sections: sections.map((section) => ({
                label: section.label,
                fromKm: section.fromKm,
                toKm: section.toKm,
              })),
              viaCount: route.vias.length,
              compare: compareText(route),
              warningCount: warnings.length,
            }
          : undefined,
        suggestion,
      }),
    [
      data,
      suggestion,
      route,
      sections,
      warnings,
      distanceKm,
      activeSeries?.label,
      splitMarkers,
      waypointMarkers,
      hiddenLayers,
    ],
  );
  const uid = useId();
  const mapTitleId = `${uid}-map-title`;
  const mapDescId = `${uid}-map-desc`;
  const stripDescId = `${uid}-strip-desc`;

  // What the view that is showing shows, when not the whole route: the
  // basemap's camera as it last reported, or the grid's viewBox (which wheel,
  // pinch and drag move too, without an announcement).
  const gridSeen = showBasemap ? null : describeGrid(view);
  const partialView = showBasemap
    ? basemapPartial
    : gridSeen && !gridSeen.whole
      ? gridSeen.text
      : null;

  useModelContextSync(
    app,
    () =>
      buildRouteMapContextSummary({
        name: data.name,
        activityType: data.activityType,
        distanceKm,
        elevationGain: data.elevationGain,
        hasGeometry: projected !== null,
        colorMetric: activeSeries?.label ?? null,
        // `describeView` is the phrasing the screen reader hears, so the
        // model and the narration cannot describe different views.
        visible: partialView,
        route: route
          ? {
              routeId: route.route_id,
              version: route.version,
              latestVersion: route.latest_version,
              sectionCount: route.segments.length,
              compare: compareText(route),
            }
          : null,
        note: contextNote,
        suggestion,
      }),
    [
      data.name,
      suggestion,
      data.source,
      route,
      contextNote,
      distanceKm,
      data.elevationGain,
      projected !== null,
      activeSeries?.label,
      partialView,
    ],
  );

  const subtitle = route
    ? `Stored route · version ${route.version} of ${route.latest_version}`
    : data.source === "suggestion"
      ? "Suggested route"
      : [data.activityType, "Activity"].filter(Boolean).join(" · ");

  const scrubPoint =
    scrubIndex != null ? (projected?.points[scrubIndex] ?? null) : null;
  const scrubValue =
    scrubIndex != null && activeSeries
      ? (activeSeries.values[scrubIndex] ?? null)
      : null;
  // Tooltip anchor as a fraction of the current viewport; hidden when the
  // scrubbed point is panned/zoomed out of view.
  const scrubFraction = scrubPoint
    ? {
        x: (scrubPoint.x - view.x) / view.w,
        y: (scrubPoint.y - view.y) / view.h,
      }
    : null;
  const scrubInView =
    scrubFraction !== null &&
    scrubFraction.x >= 0 &&
    scrubFraction.x <= 1 &&
    scrubFraction.y >= 0 &&
    scrubFraction.y <= 1;

  const scrubPosition = (() => {
    if (scrubIndex == null) return undefined;
    const parts: string[] = [];
    const d = data.streams?.distance?.[scrubIndex];
    if (d != null) parts.push(`${formatKm(d)} km`);
    const t = data.streams?.time?.[scrubIndex];
    if (t != null) parts.push(formatTime(t));
    return parts.length > 0 ? parts.join(" · ") : undefined;
  })();

  const markerAt = (index: number): Point | null =>
    projected?.points[index] ?? null;

  const hasMetric = scrubValue != null && activeSeries != null;

  // Shared scrub tooltip content: the grid view positions it by viewport
  // fraction, the basemap by projected pixel point.
  const scrubTipContent =
    scrubIndex != null && hasMetric ? (
      <UiTooltip timestamp={scrubPosition}>
        {scrubValue != null && activeSeries && (
          <TooltipEntry
            color={colorForValue(activeSeries, scrubValue)}
            label={activeSeries.label}
            value={activeSeries.format(scrubValue)}
          />
        )}
      </UiTooltip>
    ) : null;

  return (
    <div className={styles.container} data-compact={isMobile || undefined}>
      <CardHeader
        title={data.name}
        subtitle={subtitle || undefined}
        compact={isMobile}
      />

      {beforeMap}

      {projected && showBasemap && (
        <div className={styles.mapArea}>
          <p className={styles.srOnly}>{a11yDescription}</p>
          <BasemapView
            // The map draws its overlays once per mount, so a new version
            // (or compare) is a new map.
            key={`${data.id}:${route?.version ?? ""}:${route?.compare?.version ?? ""}`}
            accessibleLabel={`Map of ${data.name}`}
            coordinates={data.coordinates}
            colorRuns={colorRuns}
            splitMarkers={splitMarkers}
            waypointMarkers={waypointMarkers}
            stretches={stretches}
            route={
              route
                ? {
                    compare: compareCoordinates ?? null,
                    changed:
                      route.compare?.change.changed &&
                      route.compare.endIndex > route.compare.startIndex
                        ? {
                            startIndex: route.compare.startIndex,
                            endIndex: route.compare.endIndex,
                          }
                        : null,
                    vias,
                    selectedViaId: selectedVia?.id ?? null,
                    edit:
                      editable && !busy
                        ? {
                            addMode,
                            onPick: pickPoint,
                            onSelectVia: setSelectedViaId,
                            onMoveVia: moveVia,
                          }
                        : null,
                  }
                : null
            }
            visibility={{
              splits: layerVisible("splits"),
              waypoints: layerVisible("waypoints"),
            }}
            mode={mode}
            scrubIndex={scrubIndex}
            onScrub={(index) => {
              if (canScrub) setScrubIndex(index);
            }}
            scrubTip={scrubTipContent}
            onFail={() => setBasemapFailed(true)}
            frame={frame}
            onCamera={handleCamera}
          />
          {/* Polite narration of camera moves for screen-reader users. */}
          <p className={styles.srOnly} aria-live="polite">
            {viewMessage}
          </p>
        </div>
      )}

      {projected && !showBasemap && (
        <div className={styles.mapArea}>
          <div className={styles.mapWrap}>
            <svg
              ref={setSvgEl}
              className={styles.svg}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-labelledby={mapTitleId}
              aria-describedby={mapDescId}
              tabIndex={canZoom ? 0 : undefined}
              aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Plus Minus"
              data-zoomed={zoomed || undefined}
              onKeyDown={handleMapKeyDown}
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={handleMapPointerEnd}
              onPointerCancel={handleMapPointerCancel}
              onPointerLeave={clearScrub}
              onClick={handleMapClick}
              data-adding={(editable && addMode) || undefined}
            >
              <title id={mapTitleId}>
                {`Map of ${data.name}, ${formatKm(data.distance)} kilometres`}
              </title>
              <desc id={mapDescId}>{a11yDescription}</desc>
              <defs>
                <pattern
                  id={GRID_ID}
                  width={40}
                  height={40}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M40 0 L0 0 0 40"
                    fill="none"
                    stroke="var(--color-border-tertiary)"
                    strokeWidth={1}
                  />
                </pattern>
              </defs>

              <rect
                x={0}
                y={0}
                width={dims.width}
                height={dims.height}
                rx={12}
                fill="var(--color-background-secondary)"
              />
              <rect
                x={0}
                y={0}
                width={dims.width}
                height={dims.height}
                rx={12}
                fill={`url(#${GRID_ID})`}
              />

              {/* A stored route: the compared version dashed under it, and
                  a halo under the part that changed. */}
              {routePaths?.compare && (
                <path
                  d={routePaths.compare}
                  data-layer="compare"
                  fill="none"
                  stroke="var(--color-text-tertiary)"
                  strokeWidth={2 * k}
                  strokeDasharray={`${6 * k} ${5 * k}`}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {routePaths?.changed && (
                <path
                  d={routePaths.changed}
                  data-layer="changed"
                  fill="none"
                  stroke="var(--chart-overlay-4)"
                  strokeOpacity={0.35}
                  strokeWidth={dims.stroke * 4 * k}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {routePaths ? (
                routePaths.sections.map((section) => (
                  <path
                    key={`section-${section.key}`}
                    d={section.path}
                    data-layer="section"
                    fill="none"
                    stroke={section.color}
                    strokeWidth={dims.stroke * k}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))
              ) : segments.length > 0 ? (
                segments.map((segment, i) => (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are derived, static per render, and an out-and-back track can repeat an identical path string
                    key={i}
                    d={segment.path}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={dims.stroke * k}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))
              ) : (
                <path
                  d={projected.path}
                  fill="none"
                  stroke="var(--chart-pace)"
                  strokeWidth={dims.stroke * k}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}

              {/* Stretch pins: a wide, light band along the line. */}
              {layerVisible("waypoints") &&
                stretchPaths.map((stretch) => (
                  <path
                    key={`stretch-${stretch.startIndex}-${stretch.title}`}
                    d={stretch.path}
                    data-layer="stretch"
                    fill="none"
                    stroke={stretch.color}
                    strokeOpacity={0.4}
                    strokeWidth={dims.stroke * 3 * k}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  >
                    <title>{stretch.title}</title>
                  </path>
                ))}

              {/* Lap / km split dots. */}
              {layerVisible("splits") &&
                splitMarkers.map((split: SplitMarker) => {
                  const p = markerAt(split.index);
                  if (!p) return null;
                  return (
                    <circle
                      key={`split-${split.index}`}
                      cx={p.x}
                      cy={p.y}
                      r={dims.marker * 0.65 * k}
                      fill="var(--color-background-primary)"
                      stroke={LAYER_COLORS.splits}
                      strokeWidth={2 * k}
                    >
                      <title>{split.label}</title>
                    </circle>
                  );
                })}

              {/* Caller-pinned waypoints as per-kind coloured diamonds. */}
              {layerVisible("waypoints") &&
                waypointMarkers.map((waypoint) => {
                  const p = markerAt(waypoint.index);
                  if (!p) return null;
                  return (
                    <path
                      key={`waypoint-${waypoint.index}-${waypoint.title}`}
                      d={diamondPath(p.x, p.y, dims.marker * 0.9 * k)}
                      fill={WAYPOINT_COLORS[waypoint.kind]}
                      stroke="var(--color-background-primary)"
                      strokeWidth={2 * k}
                      strokeLinejoin="round"
                    >
                      <title>{waypoint.title}</title>
                    </path>
                  );
                })}

              {projected.start && (
                <circle
                  cx={projected.start.x}
                  cy={projected.start.y}
                  r={dims.marker * k}
                  fill="var(--color-text-success)"
                  stroke="var(--color-background-primary)"
                  strokeWidth={2 * k}
                />
              )}
              {projected.end && (
                <circle
                  cx={projected.end.x}
                  cy={projected.end.y}
                  r={dims.marker * k}
                  fill="var(--color-text-danger)"
                  stroke="var(--color-background-primary)"
                  strokeWidth={2 * k}
                />
              )}

              {/* Via points: a circle, a turnaround as a square. On the
                  latest version they drag to move and tap to select. */}
              {vias.map((via) => {
                const p =
                  dragPoint?.id === via.id
                    ? dragPoint.point
                    : projected.frame.project(via.point);
                const r = dims.marker * (isMobile ? 1.1 : 0.95) * k;
                const selected = via.id === selectedVia?.id;
                const name =
                  via.kind === "turnaround" ? "Turnaround" : via.label;
                return (
                  <g
                    key={`via-${via.id}`}
                    className={styles.via}
                    data-via={via.id}
                    data-editable={(editable && !busy) || undefined}
                    data-selected={selected || undefined}
                    onPointerDown={editable ? startViaDrag(via.id) : undefined}
                  >
                    <title>{`${name} (${via.id}) · ${via.km.toFixed(1)} km`}</title>
                    {editable && (
                      // A larger, unseen target for a finger.
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={r * 2.4}
                        fill="transparent"
                      />
                    )}
                    {via.kind === "turnaround" ? (
                      <rect
                        x={p.x - r}
                        y={p.y - r}
                        width={2 * r}
                        height={2 * r}
                        rx={1.5 * k}
                        fill="var(--chart-overlay-4)"
                        stroke={
                          selected
                            ? "var(--color-text-info)"
                            : "var(--color-background-primary)"
                        }
                        strokeWidth={(selected ? 4 : 2) * k}
                      />
                    ) : (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill="var(--color-text-primary)"
                        stroke={
                          selected
                            ? "var(--color-text-info)"
                            : "var(--color-background-primary)"
                        }
                        strokeWidth={(selected ? 4 : 2) * k}
                      />
                    )}
                  </g>
                );
              })}

              {scrubPoint && scrubValue != null && activeSeries && (
                <circle
                  cx={scrubPoint.x}
                  cy={scrubPoint.y}
                  r={(dims.marker - 1) * k}
                  fill={colorForValue(activeSeries, scrubValue)}
                  stroke="var(--color-background-primary)"
                  strokeWidth={2 * k}
                />
              )}
            </svg>
          </div>

          {canZoom && (
            <div
              className={styles.zoomControls}
              role="toolbar"
              aria-label="Zoom map"
            >
              <button
                type="button"
                className={styles.zoomButton}
                aria-label="Zoom in"
                disabled={!canZoomIn(view, base)}
                onClick={() => zoomByCenter(KEYBOARD_ZOOM_FACTOR)}
              >
                <ZoomIcon kind="in" />
              </button>
              <button
                type="button"
                className={styles.zoomButton}
                aria-label="Zoom out"
                disabled={!zoomed}
                onClick={() => zoomByCenter(1 / KEYBOARD_ZOOM_FACTOR)}
              >
                <ZoomIcon kind="out" />
              </button>
              <button
                type="button"
                className={styles.zoomButton}
                aria-label="Reset zoom"
                disabled={!zoomed}
                onClick={resetView}
              >
                <ZoomIcon kind="reset" />
              </button>
            </div>
          )}

          {/* Polite narration of view changes for screen-reader users. */}
          <p className={styles.srOnly} aria-live="polite">
            {viewMessage}
          </p>

          {scrubInView && scrubTipContent && (
            <div
              className={styles.scrubTip}
              data-flip={scrubFraction.x > 0.55 || undefined}
              style={{
                left: `${scrubFraction.x * 100}%`,
                top: `${scrubFraction.y * 100}%`,
              }}
            >
              {scrubTipContent}
            </div>
          )}
        </div>
      )}

      {!projected && (
        <EmptyState>
          No GPS track is available for this {data.source}.
        </EmptyState>
      )}

      {projected && profile && (
        <svg
          className={styles.strip}
          viewBox={`0 0 ${dims.width} ${dims.strip}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Elevation profile of ${data.name}`}
          aria-describedby={stripDescId}
          data-scrub={canScrub || undefined}
          onPointerMove={handleStripPointerMove}
          onPointerLeave={() => setScrubIndex(null)}
        >
          <desc id={stripDescId}>
            {buildElevationStripDescription(
              data.streams?.altitude ?? [],
              distanceKm,
            )}
          </desc>
          <path
            d={profile.areaPath}
            fill="var(--chart-altitude)"
            fillOpacity={0.25}
          />
          <path
            d={profile.linePath}
            fill="none"
            stroke="var(--chart-altitude)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {/* Waypoints pinned onto the profile, mirroring the track layer. */}
          {layerVisible("waypoints") &&
            waypointMarkers.map((waypoint) => {
              const x = profile.xs[waypoint.index];
              const y = profile.ys[waypoint.index];
              if (x == null || y == null) return null;
              return (
                <path
                  key={`strip-waypoint-${waypoint.index}-${waypoint.title}`}
                  d={diamondPath(x, y, 4)}
                  fill={WAYPOINT_COLORS[waypoint.kind]}
                  stroke="var(--color-background-primary)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                >
                  <title>{waypoint.title}</title>
                </path>
              );
            })}
          {scrubIndex != null && profile.xs[scrubIndex] != null && (
            <>
              <line
                x1={profile.xs[scrubIndex]}
                y1={0}
                x2={profile.xs[scrubIndex]}
                y2={dims.strip}
                stroke="var(--color-border-secondary)"
                strokeWidth={1}
              />
              {/* No altitude sample at this index (a gap): skip the dot
                  rather than place it at a made-up altitude. The line above
                  still marks the scrub position on the time axis. */}
              {profile.ys[scrubIndex] != null && (
                <circle
                  cx={profile.xs[scrubIndex]}
                  cy={profile.ys[scrubIndex]}
                  r={3.5}
                  fill="var(--chart-altitude)"
                  stroke="var(--color-background-primary)"
                  strokeWidth={1.5}
                />
              )}
            </>
          )}
        </svg>
      )}

      {projected && series.length > 0 && !route && (
        <div className={styles.controls}>
          {series.length > 1 && (
            <PillGroup>
              {series.map((s) => (
                <Pill
                  key={s.key}
                  active={s.key === activeSeries?.key}
                  onClick={() => setMetricKey(s.key)}
                >
                  {isMobile ? s.shortLabel : s.label}
                </Pill>
              ))}
            </PillGroup>
          )}
          {activeSeries && (
            <RampLegend
              gradient={RAMP_GRADIENT_CSS}
              minLabel={activeSeries.format(activeSeries.min)}
              maxLabel={activeSeries.format(activeSeries.max)}
              label={activeSeries.label.toLowerCase()}
            />
          )}
        </div>
      )}

      <div className={styles.footer}>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.label}>Distance</span>
            <span className={styles.value}>{formatKm(data.distance)} km</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.label}>Elevation</span>
            <span className={styles.value}>
              {Math.round(data.elevationGain)} m
            </span>
          </div>
        </div>
        {projected && (
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.dot} data-marker="start" />
              Start
            </span>
            <span className={styles.legendItem}>
              <span className={styles.dot} data-marker="end" />
              Finish
            </span>
            {layers.length > 0 && (
              <Legend size={isMobile ? "touch" : "default"}>
                {layers.map((layer) => (
                  <LegendItem
                    key={layer.key}
                    color={LAYER_COLORS[layer.key]}
                    label={layer.label}
                    hidden={hiddenLayers.has(layer.key)}
                    onClick={() => toggleLayer(layer.key)}
                  />
                ))}
              </Legend>
            )}
          </div>
        )}
      </div>

      {route && (
        <RouteDetails route={route} sections={sections} warnings={warnings} />
      )}

      {route && editable && routeEdit && (
        <RouteEditPanel
          route={route}
          routeKm={distanceKm}
          busy={busy}
          notice={routeEdit.notice}
          addMode={addMode}
          onAddModeChange={setAddMode}
          selectedViaId={selectedVia?.id ?? null}
          onSelectVia={setSelectedViaId}
          onAmend={routeEdit.amend}
          compact={isMobile}
        />
      )}
    </div>
  );
}
