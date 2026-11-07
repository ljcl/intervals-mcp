/**
 * Local OpenStreetMap index: road crossings, off-road paths, main roads and
 * park and water edges within OSM_INDEX_RADIUS_KM of HOME_START, built from
 * an .osm.pbf (osmIndexBuild.ts) and refreshed weekly (osmIndexRefresh.ts).
 * Route suggestions measure every candidate here, and stored route summaries
 * their whole track; nothing asks OpenStreetMap live. docs/architecture.md,
 * "OpenStreetMap index".
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir, getHomeStart, getOsmExtractUrl } from "./config";
import { type LatLng, type RouteTrack } from "./mapAnchors";

export const OSM_SCHEMA_VERSION = "1";
export const OSM_INDEX_RADIUS_KM = 25;
export const OSM_STALE_DAYS = 14;
/** Crossing and signal nodes this close are one stop: a junction's signal node and its crossings. */
export const STOP_MERGE_M = 25;
export const STOP_MATCH_M = 12;
export const SAMPLE_M = 10;
export const PATH_MATCH_M = 15;
/** Wider than a path match: a footpath beside a main road counts as on it. */
export const ROAD_MATCH_M = 20;
export const GREEN_MATCH_M = 50;
export const HEADING_TOLERANCE_DEG = 30;
/** The lookup grid, in degrees (about 1 km). */
export const CELL_DEG = 0.01;

export const METERS_PER_DEG_LAT = 110_540;
export const METERS_PER_DEG_LNG_AT_EQUATOR = 111_320;

export type WayClass = "path" | "main_road" | "green_edge";

export interface OsmArea {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The square reaching `radiusKm` from `center` along each axis. */
export function areaAround([lat, lng]: LatLng, radiusKm: number): OsmArea {
  const dLat = (radiusKm * 1000) / METERS_PER_DEG_LAT;
  const dLng =
    (radiusKm * 1000) /
    (METERS_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
  };
}

/** The area as stored in meta, "s,w,n,e" to 5 decimals. */
export function areaKey(a: OsmArea): string {
  return [a.south, a.west, a.north, a.east].map((v) => v.toFixed(5)).join(",");
}

export function inArea(a: OsmArea, lat: number, lng: number): boolean {
  return lat >= a.south && lat <= a.north && lng >= a.west && lng <= a.east;
}

const cellRow = (lat: number) => Math.floor((lat + 90) / CELL_DEG);
const cellCol = (lng: number) => Math.floor((lng + 180) / CELL_DEG);

export function cellOf(lat: number, lng: number): number {
  return cellRow(lat) * 100_000 + cellCol(lng);
}

/** Every cell a box touches. */
export function cellsIn(
  south: number,
  west: number,
  north: number,
  east: number,
): number[] {
  const cells: number[] = [];
  for (let r = cellRow(south); r <= cellRow(north); r++)
    for (let c = cellCol(west); c <= cellCol(east); c++)
      cells.push(r * 100_000 + c);
  return cells;
}

export function osmIndexDir(): string {
  return join(getDataDir(), "osm");
}

export function osmIndexPath(): string {
  return join(osmIndexDir(), "index.sqlite");
}

export interface OsmStats {
  /** Merged crossing stops with a node within STOP_MATCH_M of the track, per km. */
  crossings_per_km: number;
  /** The signalised stops among them, per km. */
  signals_per_km: number;
  path_share: number;
  main_road_km: number;
  green_share: number;
}

export type OsmIndexInfo =
  | { state: "unconfigured" }
  | { state: "missing" }
  | { state: "ready"; data_date: string; age_days: number };

const DAY_MS = 86_400_000;
const HEADING_TOLERANCE_RAD = (HEADING_TOLERANCE_DEG * Math.PI) / 180;

interface OpenIndex {
  db: DatabaseSync;
  /** The part of the area the extract covers; reads outside it are not measured. */
  coverage: OsmArea;
  meta: Record<string, string>;
}

/** undefined: not opened yet; null: no usable index file. */
let current: OpenIndex | null | undefined;
let reportedUnreadable = false;

function openIndex(): OpenIndex | null {
  if (!getOsmExtractUrl() || !getHomeStart()) return null;
  if (current !== undefined) return current;
  const path = osmIndexPath();
  // Not cached: a build that lands later must be seen without a restart.
  if (!existsSync(path)) return null;
  current = null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const [south, west, north, east] = (meta.coverage ?? meta.area ?? "")
      .split(",")
      .map(Number);
    if (meta.schema_version !== OSM_SCHEMA_VERSION || east === undefined) {
      db.close();
      return null;
    }
    current = {
      db,
      coverage: { south: south!, west: west!, north: north!, east },
      meta,
    };
  } catch (error) {
    if (!reportedUnreadable) {
      reportedUnreadable = true;
      console.error(
        `OpenStreetMap index: cannot read ${path} (${error instanceof Error ? error.message : String(error)}); treating it as absent until the next rebuild.`,
      );
    }
  }
  return current;
}

/** Drops the open handle, so the next read opens the file again (after a rebuild or a check). */
export function closeOsmIndex(): void {
  current?.db.close();
  current = undefined;
}

/** The live index's meta rows, or null without one (osmIndexRefresh.ts compares them with the settings). */
export function osmIndexMeta(): Record<string, string> | null {
  return openIndex()?.meta ?? null;
}

export function osmIndexInfo(now: number = Date.now()): OsmIndexInfo {
  if (!getOsmExtractUrl() || !getHomeStart()) return { state: "unconfigured" };
  const index = openIndex();
  if (!index) return { state: "missing" };
  return {
    state: "ready",
    data_date: index.meta.data_date ?? "",
    age_days: Math.floor(
      (now - Date.parse(index.meta.checked_at ?? "")) / DAY_MS,
    ),
  };
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dir: number;
}
interface Ring {
  points: Array<[number, number]>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function segmentsOf(points: Array<[number, number]>): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    if (x1 === x2 && y1 === y2) continue;
    out.push({ x1, y1, x2, y2, dir: Math.atan2(y2 - y1, x2 - x1) });
  }
  return out;
}

function distanceToSegment(x: number, y: number, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const t = Math.max(
    0,
    Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(s.x1 + t * dx - x, s.y1 + t * dy - y);
}

/** Angle between two undirected headings, 0 to pi/2. */
function headingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/** Segments bucketed by GREEN_MATCH_M cells; every radius asked is at most that. */
class SegmentGrid {
  private readonly cells = new Map<string, Segment[]>();

  add(s: Segment): void {
    const c = (v: number) => Math.floor(v / GREEN_MATCH_M);
    for (let i = c(Math.min(s.x1, s.x2)); i <= c(Math.max(s.x1, s.x2)); i++)
      for (let j = c(Math.min(s.y1, s.y2)); j <= c(Math.max(s.y1, s.y2)); j++) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        if (list) list.push(s);
        else this.cells.set(key, [s]);
      }
  }

  /** Whether a segment lies within `radius` of (x, y), and within the heading tolerance of `dir` when given. */
  near(x: number, y: number, radius: number, dir?: number): boolean {
    const cx = Math.floor(x / GREEN_MATCH_M);
    const cy = Math.floor(y / GREEN_MATCH_M);
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++)
        for (const s of this.cells.get(`${i},${j}`) ?? [])
          if (
            distanceToSegment(x, y, s) <= radius &&
            (dir === undefined ||
              headingDiff(dir, s.dir) <= HEADING_TOLERANCE_RAD)
          )
            return true;
    return false;
  }
}

function insideRing(x: number, y: number, r: Ring): boolean {
  if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) return false;
  let inside = false;
  const p = r.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!;
    const [xj, yj] = p[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

const round = (v: number, places: number) =>
  Math.round(v * 10 ** places) / 10 ** places;

/**
 * The OpenStreetMap measures of one route; null without an index, when any
 * point lies outside its coverage, or for a track shorter than one sample.
 */
export function routeOsmStats(track: RouteTrack): OsmStats | null {
  const index = openIndex();
  if (!index) return null;
  const coords = track.coordinates;
  if (coords.some(([lat, lng]) => !inArea(index.coverage, lat, lng)))
    return null;
  const [lat0, lng0] = coords[0] ?? [0, 0];
  const kx = Math.cos((lat0 * Math.PI) / 180) * METERS_PER_DEG_LNG_AT_EQUATOR;
  const project = (lat: number, lng: number): [number, number] => [
    (lng - lng0) * kx,
    (lat - lat0) * METERS_PER_DEG_LAT,
  ];

  const route = segmentsOf(coords.map(([lat, lng]) => project(lat, lng)));
  const samples: Array<{ x: number; y: number; dir: number }> = [];
  let walked = 0;
  let next = SAMPLE_M / 2;
  for (const s of route) {
    const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    for (; next <= walked + length; next += SAMPLE_M) {
      const t = (next - walked) / length;
      samples.push({
        x: s.x1 + t * (s.x2 - s.x1),
        y: s.y1 + t * (s.y2 - s.y1),
        dir: s.dir,
      });
    }
    walked += length;
  }
  if (samples.length === 0) return null;

  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lng] of coords) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  const padLat = GREEN_MATCH_M / METERS_PER_DEG_LAT;
  const padLng = GREEN_MATCH_M / kx;
  const cells = JSON.stringify(
    cellsIn(south - padLat, west - padLng, north + padLat, east + padLng),
  );
  const ways = index.db
    .prepare(
      "SELECT DISTINCT w.id, w.class, w.ring, w.points FROM way_cells c JOIN ways w ON w.id = c.way_id WHERE c.cell IN (SELECT value FROM json_each(?))",
    )
    .all(cells) as Array<{ class: WayClass; ring: number; points: Uint8Array }>;
  const stopNodes = index.db
    .prepare(
      "SELECT stop_id, signal, lat, lng FROM stop_nodes WHERE cell IN (SELECT value FROM json_each(?))",
    )
    .all(cells) as Array<{
    stop_id: number;
    signal: number;
    lat: number;
    lng: number;
  }>;

  const grids: Record<WayClass, SegmentGrid> = {
    path: new SegmentGrid(),
    main_road: new SegmentGrid(),
    green_edge: new SegmentGrid(),
  };
  const rings: Ring[] = [];
  for (const way of ways) {
    // slice(): a BLOB's bytes may not sit on an 8-byte boundary.
    const flat = new Float64Array(way.points.slice().buffer);
    const points: Array<[number, number]> = [];
    for (let i = 0; i < flat.length; i += 2)
      points.push(project(flat[i]!, flat[i + 1]!));
    for (const s of segmentsOf(points)) grids[way.class].add(s);
    if (way.ring) {
      // A loop, not Math.min(...): a harbour ring can exceed the argument limit.
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [px, py] of points) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      rings.push({ points, minX, maxX, minY, maxY });
    }
  }

  let onPath = 0;
  let onRoad = 0;
  let green = 0;
  for (const { x, y, dir } of samples) {
    if (grids.path.near(x, y, PATH_MATCH_M, dir)) onPath++;
    if (grids.main_road.near(x, y, ROAD_MATCH_M, dir)) onRoad++;
    if (
      grids.green_edge.near(x, y, GREEN_MATCH_M) ||
      rings.some((r) => insideRing(x, y, r))
    )
      green++;
  }

  const routeGrid = new SegmentGrid();
  for (const s of route) routeGrid.add(s);
  const stops = new Map<number, boolean>();
  for (const n of stopNodes) {
    const [x, y] = project(n.lat, n.lng);
    if (routeGrid.near(x, y, STOP_MATCH_M))
      stops.set(n.stop_id, n.signal === 1);
  }
  const km = walked / 1000;
  const signals = [...stops.values()].filter(Boolean).length;
  return {
    crossings_per_km: round(stops.size / km, 1),
    signals_per_km: round(signals / km, 1),
    path_share: round(onPath / samples.length, 2),
    main_road_km: round((onRoad * SAMPLE_M) / 1000, 1),
    green_share: round(green / samples.length, 2),
  };
}
