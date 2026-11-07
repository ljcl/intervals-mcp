/**
 * Local OpenStreetMap index: road crossings, off-road paths, main roads and
 * park and water edges within OSM_INDEX_RADIUS_KM of HOME_START, built from
 * an .osm.pbf (osmIndexBuild.ts) and refreshed weekly (osmIndexRefresh.ts).
 * Route suggestions measure every candidate here and never ask OpenStreetMap
 * live. docs/architecture.md, "OpenStreetMap index".
 */
import { join } from "node:path";
import { getDataDir } from "./config";
import { type LatLng } from "./mapAnchors";

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
