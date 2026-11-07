/**
 * Builds the local OpenStreetMap index (osmIndex.ts) from an .osm.pbf in
 * three passes: the outer ways of park and water multipolygons, the nodes
 * inside the area (crossings among them), then the ways, stored as runs of
 * their in-area points. Memory grows with the nodes inside the area (about
 * 16 bytes each), not with the size of the extract.
 */
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  areaKey,
  cellOf,
  cellsIn,
  inArea,
  METERS_PER_DEG_LAT,
  METERS_PER_DEG_LNG_AT_EQUATOR,
  OSM_SCHEMA_VERSION,
  type OsmArea,
  STOP_MERGE_M,
  type WayClass,
} from "./osmIndex";
import { readOsmPbf, type Tags } from "./osmPbf";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ways (id INTEGER PRIMARY KEY, class TEXT NOT NULL, ring INTEGER NOT NULL, points BLOB NOT NULL);
CREATE TABLE way_cells (cell INTEGER NOT NULL, way_id INTEGER NOT NULL);
CREATE INDEX way_cells_cell ON way_cells (cell);
CREATE TABLE stop_nodes (cell INTEGER NOT NULL, stop_id INTEGER NOT NULL, signal INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
CREATE INDEX stop_nodes_cell ON stop_nodes (cell);
`;

const PATH_HIGHWAYS = new Set(["footway", "path", "pedestrian", "track"]);
const MAIN_ROADS = new Set([
  "trunk",
  "primary",
  "secondary",
  "trunk_link",
  "primary_link",
  "secondary_link",
]);
const NO_FOOT = new Set(["no", "private"]);

function isGreen(t: Tags): boolean {
  return (
    t.leisure === "park" ||
    t.natural === "water" ||
    t.natural === "coastline" ||
    t.waterway !== undefined
  );
}

function isPath(t: Tags): boolean {
  if (!t.highway) return false;
  // foot= overrides access=, so a private road open to walkers still counts.
  if (NO_FOOT.has(t.foot ?? t.access ?? "")) return false;
  // Australian tagging: a footway beside a road is the street footpath, not an off-road path.
  if (t.footway === "sidewalk" || t.footway === "crossing") return false;
  if (PATH_HIGHWAYS.has(t.highway)) return true;
  if (t.designation === "shared_path") return true;
  return (
    t.highway === "cycleway" && (t.foot === "designated" || t.foot === "yes")
  );
}

export function wayClass(t: Tags): WayClass | null {
  if (t.highway && MAIN_ROADS.has(t.highway)) return "main_road";
  if (isPath(t)) return "path";
  if (isGreen(t)) return "green_edge";
  return null;
}

/** Null when the node is not a crossing; else whether it is signalised. */
function crossingOf(t: Tags): boolean | null {
  if (t.highway !== "crossing" && t.highway !== "traffic_signals") return null;
  return (
    t.highway === "traffic_signals" ||
    t.crossing === "traffic_signals" ||
    t["crossing:signals"] === "yes"
  );
}

interface Crossing {
  lat: number;
  lng: number;
  signal: boolean;
}

/** A stop id per crossing: single-link groups of crossings under STOP_MERGE_M apart. */
export function mergeStops(crossings: Crossing[]): number[] {
  const parent = crossings.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const kx =
    Math.cos(((crossings[0]?.lat ?? 0) * Math.PI) / 180) *
    METERS_PER_DEG_LNG_AT_EQUATOR;
  const xy = crossings.map(
    (c) => [c.lng * kx, c.lat * METERS_PER_DEG_LAT] as const,
  );
  const cell = (v: number) => Math.floor(v / STOP_MERGE_M);
  const grid = new Map<string, number[]>();
  xy.forEach(([x, y], i) => {
    const key = `${cell(x)},${cell(y)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  xy.forEach(([x, y], i) => {
    for (let a = cell(x) - 1; a <= cell(x) + 1; a++)
      for (let b = cell(y) - 1; b <= cell(y) + 1; b++)
        for (const j of grid.get(`${a},${b}`) ?? []) {
          const [xj, yj] = xy[j]!;
          if (j > i && Math.hypot(xj - x, yj - y) < STOP_MERGE_M)
            parent[find(j)] = find(i);
        }
  });
  return crossings.map((_, i) => find(i));
}

/** Coordinates of the in-area nodes by id; ids arrive sorted, so a lookup is a binary search. */
class NodeTable {
  private ids = new Float64Array(1 << 20);
  private lats = new Int32Array(1 << 20);
  private lngs = new Int32Array(1 << 20);
  private size = 0;

  add(id: number, lat: number, lng: number): void {
    if (this.size > 0 && id <= this.ids[this.size - 1]!)
      throw new Error(
        "The extract's nodes are not sorted by id; use a Geofabrik or BBBike .osm.pbf",
      );
    if (this.size === this.ids.length) this.grow();
    this.ids[this.size] = id;
    this.lats[this.size] = Math.round(lat * 1e7);
    this.lngs[this.size] = Math.round(lng * 1e7);
    this.size++;
  }

  get(id: number): [number, number] | null {
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.ids[mid]!;
      if (v === id) return [this.lats[mid]! / 1e7, this.lngs[mid]! / 1e7];
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  private grow(): void {
    const n = this.ids.length * 2;
    const ids = new Float64Array(n);
    const lats = new Int32Array(n);
    const lngs = new Int32Array(n);
    ids.set(this.ids);
    lats.set(this.lats);
    lngs.set(this.lngs);
    this.ids = ids;
    this.lats = lats;
    this.lngs = lngs;
  }
}

/** Runs of consecutive in-area points, flat [lat, lng, ...], each with at least 2 points. */
function inAreaRuns(refs: number[], nodes: NodeTable): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (const ref of refs) {
    const p = nodes.get(ref);
    if (p) run.push(p[0], p[1]);
    else {
      if (run.length >= 4) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 4) runs.push(run);
  return runs;
}

export interface BuildResult {
  ways: number;
  stops: number;
  data_date: string;
}

export async function buildOsmIndex(
  pbfPath: string,
  dbPath: string,
  area: OsmArea,
  source: { url: string; etag: string; last_modified: string },
  now: number = Date.now(),
): Promise<BuildResult> {
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);

    const greenOuter = new Set<number>();
    await readOsmPbf(pbfPath, {
      relation(r) {
        if (r.tags.type !== "multipolygon" || !isGreen(r.tags)) return;
        for (const m of r.members)
          if (m.type === "way" && (m.role === "outer" || m.role === ""))
            greenOuter.add(m.ref);
      },
    });

    const nodes = new NodeTable();
    const crossings: Crossing[] = [];
    let replication = null as number | null;
    await readOsmPbf(pbfPath, {
      header(h) {
        replication = h.replication_timestamp;
      },
      node(n) {
        if (!inArea(area, n.lat, n.lon)) return;
        nodes.add(n.id, n.lat, n.lon);
        const signal = crossingOf(n.tags);
        if (signal !== null) crossings.push({ lat: n.lat, lng: n.lon, signal });
      },
    });

    const insertWay = db.prepare(
      "INSERT INTO ways (class, ring, points) VALUES (?, ?, ?)",
    );
    const insertCell = db.prepare(
      "INSERT INTO way_cells (cell, way_id) VALUES (?, ?)",
    );
    let ways = 0;
    const store = (cls: WayClass, ring: boolean, run: number[]) => {
      const { lastInsertRowid } = insertWay.run(
        cls,
        ring ? 1 : 0,
        new Uint8Array(new Float64Array(run).buffer),
      );
      let south = Infinity;
      let west = Infinity;
      let north = -Infinity;
      let east = -Infinity;
      for (let i = 0; i < run.length; i += 2) {
        south = Math.min(south, run[i]!);
        north = Math.max(north, run[i]!);
        west = Math.min(west, run[i + 1]!);
        east = Math.max(east, run[i + 1]!);
      }
      for (const cell of cellsIn(south, west, north, east))
        insertCell.run(cell, lastInsertRowid);
      ways++;
    };

    db.exec("BEGIN");
    await readOsmPbf(pbfPath, {
      way(w) {
        const cls = wayClass(w.tags);
        const green = greenOuter.has(w.id);
        if (!cls && !green) return;
        const closed = w.refs.length >= 4 && w.refs[0] === w.refs.at(-1);
        for (const run of inAreaRuns(w.refs, nodes)) {
          // Inside an island (a closed coastline) is land, not water.
          const ring =
            closed &&
            run.length === w.refs.length * 2 &&
            w.tags.natural !== "coastline";
          if (cls) store(cls, cls === "green_edge" && ring, run);
          if (green && cls !== "green_edge") store("green_edge", ring, run);
        }
      },
    });

    const stopIds = mergeStops(crossings);
    const signalStops = new Set(stopIds.filter((_, i) => crossings[i]!.signal));
    const insertStop = db.prepare(
      "INSERT INTO stop_nodes (cell, stop_id, signal, lat, lng) VALUES (?, ?, ?, ?, ?)",
    );
    crossings.forEach((c, i) => {
      const stop = stopIds[i]!;
      insertStop.run(
        cellOf(c.lat, c.lng),
        stop,
        signalStops.has(stop) ? 1 : 0,
        c.lat,
        c.lng,
      );
    });

    const iso = (ms: number) => new Date(ms).toISOString();
    const data_date = iso(
      replication !== null
        ? replication * 1000
        : Date.parse(source.last_modified) || now,
    );
    const insertMeta = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of Object.entries({
      schema_version: OSM_SCHEMA_VERSION,
      area: areaKey(area),
      source_url: source.url,
      etag: source.etag,
      last_modified: source.last_modified,
      data_date,
      built_at: iso(now),
      checked_at: iso(now),
    }))
      insertMeta.run(key, value);
    db.exec("COMMIT");
    return { ways, stops: new Set(stopIds).size, data_date };
  } finally {
    db.close();
  }
}
