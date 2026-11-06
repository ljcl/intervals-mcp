/**
 * Pure projection math for the route map. No map tiles, no network: lat/lng
 * pairs are projected into a fixed SVG coordinate frame, fit to the frame's
 * bounds with padding, and centred. Kept side-effect free so it can be
 * unit-tested away from React and Recharts.
 */

export interface Point {
  x: number;
  y: number;
}

export interface ProjectOptions {
  /** SVG viewBox width. */
  width: number;
  /** SVG viewBox height. */
  height: number;
  /** Padding (in viewBox units) kept clear on every edge. */
  padding: number;
}

export interface ProjectedRoute {
  /** Projected polyline points, in draw order. */
  points: Point[];
  /** SVG path `d` string for the polyline. */
  path: string;
  /** Projected first point. */
  start: Point | null;
  /** Projected last point. */
  end: Point | null;
  /** The frame the points were fit to: projects other `[lat, lng]` pairs
   * (a compared version) onto the same map, and maps a point back. */
  frame: ProjectionFrame;
}

/** One fit of `[lat, lng]` space onto the SVG frame, both ways. */
export interface ProjectionFrame {
  project: (pair: [number, number]) => Point;
  /** The `[lat, lng]` pair at a viewBox point (the inverse of `project`). */
  unproject: (point: Point) => [number, number];
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Fit `coordinates` into the SVG frame described by `opts`.
 *
 * Longitude degrees are scaled by `cos(meanLatitude)` so the route keeps its
 * true shape instead of stretching east–west (an equirectangular projection,
 * accurate enough at the scale of a single activity). The path is then scaled
 * uniformly to fit within the padded frame and centred, with latitude flipped
 * so north points up.
 */
function fitFrame(
  coordinates: Array<[number, number]>,
  opts: ProjectOptions,
): ProjectionFrame {
  const { width, height, padding } = opts;

  const meanLat =
    coordinates.reduce((sum, [lat]) => sum + lat, 0) / coordinates.length;
  const lngScale = Math.cos(meanLat * DEG_TO_RAD);

  // Planar coordinates: x grows east, y grows north (flipped to SVG later).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lat, lng] of coordinates) {
    const px = lng * lngScale;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availW = width - 2 * padding;
  const availH = height - 2 * padding;

  // Uniform scale that fits both axes; a degenerate (zero-width or single
  // point) span contributes no constraint, so fall back to the other axis.
  const sx = spanX > 1e-9 ? availW / spanX : Number.POSITIVE_INFINITY;
  const sy = spanY > 1e-9 ? availH / spanY : Number.POSITIVE_INFINITY;
  let scale = Math.min(sx, sy);
  if (!Number.isFinite(scale)) scale = 1;

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = padding + (availW - drawnW) / 2;
  const offsetY = padding + (availH - drawnH) / 2;

  return {
    project: ([lat, lng]) => ({
      x: offsetX + (lng * lngScale - minX) * scale,
      // Flip Y: the northern-most point (maxY) sits at the top of the frame.
      y: offsetY + (maxY - lat) * scale,
    }),
    unproject: ({ x, y }) => [
      maxY - (y - offsetY) / scale,
      ((x - offsetX) / scale + minX) / lngScale,
    ],
  };
}

/**
 * Project `[lat, lng]` coordinates into the SVG frame described by `opts`
 * (see `fitFrame`). `fitAlso` are more pairs the frame must hold (a compared
 * version drawn under the route), so both lines share one map.
 */
export function projectRoute(
  coordinates: Array<[number, number]>,
  opts: ProjectOptions,
  fitAlso: Array<[number, number]> = [],
): ProjectedRoute | null {
  if (coordinates.length === 0) return null;

  const frame = fitFrame([...coordinates, ...fitAlso], opts);
  const points = coordinates.map(frame.project);

  return {
    points,
    path: pointsPath(points),
    start: points[0] ?? null,
    end: points[points.length - 1] ?? null,
    frame,
  };
}

/** SVG path `d` string through `points`, in order. */
export function pointsPath(points: Point[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
    .join(" ");
}

/** Trim coordinates to 2 dp so the generated path string stays compact. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Index of the projected point nearest to (x, y), in viewBox units. Linear
 * scan: tracks top out around a thousand points, and this only runs per
 * pointer-move. Returns -1 for an empty track.
 */
export function nearestPointIndex(
  points: Point[],
  x: number,
  y: number,
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i]!.x - x;
    const dy = points[i]!.y - y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
