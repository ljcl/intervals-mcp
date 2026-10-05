/**
 * The basemap's camera, driven from outside the map: `set-viewport` and its
 * reset hand `BasemapView` a frame to fit, and every camera move (the model's
 * or the user's own pan and zoom) reports back how far in the map is. Kept
 * free of maplibre-gl, against the few map methods it needs, so it
 * unit-tests with a fake map.
 */

/** The slice of a MapLibre `Map` the camera drives. */
export interface CameraMap {
  fitBounds(
    bounds: [[number, number], [number, number]],
    options: { padding: number; maxZoom: number },
  ): void;
  getZoom(): number;
  on(type: "load" | "moveend", listener: () => void): void;
}

export interface CameraFrame {
  /** [[west, south], [east, north]], as `trackBounds` returns it. */
  bounds: [[number, number], [number, number]];
  /** Changes on every request, so framing the same stretch twice still moves. */
  nonce: number;
}

/** Pixels kept clear around a fitted frame, the initial fit included. */
export const BASEMAP_PADDING = 36;
/** Street level: a short stretch is not framed past this. */
const MAX_FRAME_ZOOM = 17;

/**
 * Wire a camera onto `map`. A frame sent before the style loads is held and
 * applied once on `load`; afterwards each frame is fitted at once, each nonce
 * only once. `onCamera` hears every `moveend` as a zoom factor relative to
 * the whole-route fit the map loads with (MapLibre zoom is log2 scale).
 */
export function createBasemapCamera(
  map: CameraMap,
  onCamera: (camera: { zoomFactor: number }) => void,
): { frame(next: CameraFrame): void } {
  let loaded = false;
  let fitZoom: number | null = null;
  let pending: CameraFrame | null = null;
  let applied: number | null = null;

  const apply = (frame: CameraFrame) => {
    if (frame.nonce === applied) return;
    applied = frame.nonce;
    map.fitBounds(frame.bounds, {
      padding: BASEMAP_PADDING,
      maxZoom: MAX_FRAME_ZOOM,
    });
  };

  map.on("load", () => {
    loaded = true;
    // The map is constructed fitted to the whole route, so the zoom it
    // loads at is the 1x every later zoom is measured against.
    fitZoom = map.getZoom();
    if (pending) apply(pending);
    pending = null;
  });
  map.on("moveend", () => {
    if (fitZoom === null) return;
    onCamera({ zoomFactor: 2 ** (map.getZoom() - fitZoom) });
  });

  return {
    frame(next) {
      if (loaded) apply(next);
      else pending = next;
    },
  };
}

/** Below this factor the view still reads as the whole route. */
const WHOLE_ROUTE_BELOW = 1.05;

/** Whether `zoomFactor` is zoomed in far enough to describe as a zoom. */
export function isZoomedIn(zoomFactor: number): boolean {
  return zoomFactor >= WHOLE_ROUTE_BELOW;
}

/** One wording for both views, so the model hears the same thing. */
export function describeZoom(zoomFactor: number): string {
  return isZoomedIn(zoomFactor)
    ? `Zoomed to ${zoomFactor.toFixed(1)}×`
    : "Showing the whole route";
}
