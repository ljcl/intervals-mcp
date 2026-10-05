/**
 * The basemap's camera, driven from outside the map: `set-viewport` and its
 * reset hand `BasemapView` a frame to fit, and every camera move (the model's
 * or the user's own pan and zoom) reports back what is in view. Kept free of
 * maplibre-gl, against the few map methods it needs, so it unit-tests with a
 * fake map.
 */

/** The slice of a MapLibre `Map` the camera drives. */
export interface CameraMap {
  fitBounds(
    bounds: [[number, number], [number, number]],
    options: { padding: number; maxZoom: number },
  ): void;
  getZoom(): number;
  getBounds(): { toArray(): [[number, number], [number, number]] };
  on(type: "load" | "moveend", listener: () => void): void;
}

/** What the camera shows after a move. */
export interface CameraReport {
  /** Zoom relative to the whole-route fit the map loaded with. */
  zoomFactor: number;
  /** The area in view, [[west, south], [east, north]]. */
  bounds: [[number, number], [number, number]];
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
 * only once. `onCamera` hears every `moveend` (a pan, a zoom, a resize) with
 * the bounds in view and the zoom relative to the whole-route fit the map
 * loads with (MapLibre zoom is log2 scale).
 */
export function createBasemapCamera(
  map: CameraMap,
  onCamera: (camera: CameraReport) => void,
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
    onCamera({
      zoomFactor: 2 ** (map.getZoom() - fitZoom),
      bounds: map.getBounds().toArray(),
    });
  });

  return {
    frame(next) {
      if (loaded) apply(next);
      else pending = next;
    },
  };
}
