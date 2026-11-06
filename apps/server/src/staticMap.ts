/**
 * A static PNG of a route-map payload, for a client that did not report MCP
 * Apps support (view-route-map attaches it): the line in its section
 * colours, km dots, via points, pins, start and finish, and a compared
 * version in grey under the changed part. No basemap and no text, so it
 * needs no tiles or fonts; the tool's text names the colours. Pure: pixels
 * in, PNG bytes out (node:zlib for the deflate).
 */
import { deflateSync } from "node:zlib";
import { type RouteMapData } from "./routeMapData";

export const STATIC_MAP_WIDTH = 640;
export const STATIC_MAP_HEIGHT = 480;
const MARGIN = 28;

/** Palette indexes; the colours are {@link PALETTE}. */
const BACKGROUND = 0;
const GRID = 1;
const COMPARE = 2;
const HALO = 3;
const INK = 4;
const START = 5;
const FINISH = 6;
const WHITE = 7;
const PIN = 8;
/** Section colours start here and repeat. */
const SECTION = 9;

const PALETTE: Array<[number, number, number]> = [
  [255, 255, 255],
  [232, 236, 240],
  [160, 166, 175],
  [255, 214, 120],
  [33, 37, 41],
  [34, 160, 80],
  [214, 48, 49],
  [255, 255, 255],
  [142, 68, 173],
  // Sections, in order.
  [37, 99, 235],
  [234, 88, 12],
  [13, 148, 136],
  [219, 39, 119],
  [101, 163, 13],
  [124, 58, 237],
];

/** The section colours by name, in the order sections use them. */
export const SECTION_COLOUR_NAMES = [
  "blue",
  "orange",
  "teal",
  "pink",
  "green",
  "violet",
];

const SECTION_COLOURS = PALETTE.length - SECTION;

class Canvas {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height).fill(BACKGROUND);
  }

  disc(x: number, y: number, radius: number, colour: number) {
    const r2 = radius * radius;
    for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py++) {
      for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px++) {
        if ((px - x) ** 2 + (py - y) ** 2 <= r2) this.set(px, py, colour);
      }
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    colour: number,
  ) {
    const half = width / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const minX = Math.floor(Math.min(x0, x1) - half);
    const maxX = Math.ceil(Math.max(x0, x1) + half);
    const minY = Math.floor(Math.min(y0, y1) - half);
    const maxY = Math.ceil(Math.max(y0, y1) + half);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const t =
          len2 > 0
            ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2))
            : 0;
        const ex = px - (x0 + t * dx);
        const ey = py - (y0 + t * dy);
        if (ex * ex + ey * ey <= half * half) this.set(px, py, colour);
      }
    }
  }

  private set(x: number, y: number, colour: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = colour;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit palette PNG of the canvas. */
function encodePng(canvas: Canvas): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, canvas.width);
  view.setUint32(4, canvas.height);
  header[8] = 8; // bit depth
  header[9] = 3; // palette
  const palette = new Uint8Array(PALETTE.flat());
  const rows = new Uint8Array((canvas.width + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    rows[y * (canvas.width + 1)] = 0; // no filter
    rows.set(
      canvas.pixels.subarray(y * canvas.width, (y + 1) * canvas.width),
      y * (canvas.width + 1) + 1,
    );
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", new Uint8Array(deflateSync(rows, { level: 9 }))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The route as a PNG, or null when it has fewer than two points. Points
 * are projected flat (fine over a run), scaled to fit with the same scale
 * both ways.
 */
export function renderRoutePng(data: RouteMapData): Uint8Array | null {
  const points = data.coordinates;
  if (points.length < 2) return null;
  const all = [...points, ...(data.route?.compare?.coordinates ?? [])];
  const midLat = all.reduce((sum, p) => sum + p[0], 0) / all.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = all.map((p) => p[1] * k);
  const ys = all.map((p) => p[0]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(
    (STATIC_MAP_WIDTH - 2 * MARGIN) / spanX,
    (STATIC_MAP_HEIGHT - 2 * MARGIN) / spanY,
  );
  const offsetX = (STATIC_MAP_WIDTH - spanX * scale) / 2;
  const offsetY = (STATIC_MAP_HEIGHT - spanY * scale) / 2;
  const project = ([lat, lng]: [number, number]): [number, number] => [
    offsetX + (lng * k - minX) * scale,
    STATIC_MAP_HEIGHT - (offsetY + (lat - minY) * scale),
  ];

  const canvas = new Canvas(STATIC_MAP_WIDTH, STATIC_MAP_HEIGHT);
  for (let x = 0; x < STATIC_MAP_WIDTH; x += 64)
    canvas.line(x, 0, x, STATIC_MAP_HEIGHT, 1, GRID);
  for (let y = 0; y < STATIC_MAP_HEIGHT; y += 64)
    canvas.line(0, y, STATIC_MAP_WIDTH, y, 1, GRID);

  const xy = points.map(project);
  const polyline = (
    path: Array<[number, number]>,
    from: number,
    to: number,
    width: number,
    colour: number,
  ) => {
    for (
      let i = Math.max(1, from + 1);
      i <= Math.min(to, path.length - 1);
      i++
    ) {
      const [x0, y0] = path[i - 1]!;
      const [x1, y1] = path[i]!;
      canvas.line(x0, y0, x1, y1, width, colour);
    }
  };

  const compare = data.route?.compare;
  if (compare) {
    polyline(
      compare.coordinates.map(project),
      0,
      compare.coordinates.length,
      3,
      COMPARE,
    );
    if (compare.change.changed)
      polyline(xy, compare.startIndex, compare.endIndex, 11, HALO);
  }
  const sections = data.route?.segments ?? [];
  if (sections.length > 0) {
    sections.forEach((section, i) => {
      polyline(
        xy,
        section.startIndex,
        section.endIndex,
        4,
        SECTION + (i % SECTION_COLOURS),
      );
    });
  } else {
    polyline(xy, 0, xy.length, 4, SECTION);
  }
  for (const marker of data.route?.kmMarkers ?? []) {
    const [x, y] = xy[marker.index]!;
    canvas.disc(x, y, 3, INK);
  }
  for (const waypoint of data.annotations?.waypoints ?? []) {
    if (waypoint.endIndex !== undefined)
      polyline(xy, waypoint.index, waypoint.endIndex, 2, PIN);
    const [x, y] = xy[waypoint.index]!;
    canvas.disc(x, y, 6, PIN);
    canvas.disc(x, y, 3, WHITE);
  }
  for (const via of data.route?.vias ?? []) {
    const [x, y] = project(via.point);
    canvas.disc(x, y, 6, INK);
    canvas.disc(x, y, 3, WHITE);
  }
  const [sx, sy] = xy[0]!;
  const [fx, fy] = xy.at(-1)!;
  canvas.disc(fx, fy, 7, FINISH);
  canvas.disc(sx, sy, 7, START);
  canvas.disc(sx, sy, 3, WHITE);
  return encodePng(canvas);
}
