/**
 * Stored routes: every route stitch-route makes, every version amend-route
 * adds, and the routes suggest-run-route generates, kept as one JSON file
 * per route under `<DATA_DIR>/routes` (docs/architecture.md, "Stored
 * routes"). The one module that reads or writes those files.
 *
 * A version lists the ids of its segments; the segments live once in the
 * route's pool, so a version that changes one section adds that section
 * only. Versions are never rewritten: a change, an undo or a restore adds
 * one. A file is replaced whole through a temporary file and a rename, and
 * the changes to one route run one at a time in this process.
 *
 * Retention: a file not read or changed for ROUTE_RETENTION_DAYS (a
 * suggested route: {@link SUGGESTION_RETENTION_DAYS}) is deleted by
 * {@link sweepRoutes}, which runs at most every {@link SWEEP_INTERVAL_MS}.
 * A read sets the file's modified time, so the file's own time is the last
 * use.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDataDir, getRouteRetentionDays } from "./config";
import { type LatLng, type RouteTrack } from "./mapAnchors";
import { type PlaceMatch } from "./orsClient";

/** Days a suggested route nobody stitched, viewed or exported is kept. */
export const SUGGESTION_RETENTION_DAYS = 3;
/** Versions one route may hold; a longer history is stitched into a new route. */
export const MAX_ROUTE_VERSIONS = 100;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FORMAT = 1;

/** "r" for a route stitch-route made, "s" for one suggest-run-route generated, then 10 base32 characters. */
const ROUTE_ID_RE = /^[rs][a-z2-7]{10}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type RouteKind = "draft" | "suggestion";

/** Where a segment's geometry came from. */
export type SegmentSource =
  | {
      type: "activity";
      activity_id: string;
      /** The activity's own km the segment starts at; above to_km when run the other way. */
      from_km: number;
      to_km: number;
    }
  | {
      type: "route";
      route_id: string;
      version: number;
      from_km: number;
      to_km: number;
    }
  | {
      type: "ors";
      /** route: between points; out_and_back: there and back; join: a gap between two segments. */
      purpose: "route" | "out_and_back" | "join";
    };

export type SegmentKind =
  | "activity"
  | "route"
  | "generated"
  | "out_and_back"
  | "join";

/** A point a section was routed through, which amend-route can move or remove. */
export interface SegmentVia {
  id: string;
  /** Metres from the segment's start. */
  offset_m: number;
  point: LatLng;
  label: string;
  /** turnaround: the far end of an out-and-back. */
  kind: "via" | "turnaround";
  /** The place lookup that gave `point`; absent for a lat,lng, a shift or a turnaround. */
  match?: PlaceMatch;
  /** Where the via was asked for, when snap through moved it to `point`. */
  requested?: LatLng;
}

export type ClimbSource = "recorded" | "elevation_model" | "none";

export interface StoredSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  source: SegmentSource;
  /** Distances from the segment's own start. */
  track: RouteTrack;
  climb_m: number | null;
  /** recorded: the activity's altitude; elevation_model: OpenRouteService's; none: no altitude. */
  climb_source: ClimbSource;
  /** Share (0-1) on paths, from OpenRouteService; null where unknown (a recorded run). */
  path_share: number | null;
  vias: SegmentVia[];
  /** fit_distance may change this section. */
  flexible: boolean;
  /** Why a value of this section is estimated or uncertain. */
  notes: string[];
}

export interface StoredVersion {
  version: number;
  /** The version this one was made from; null for the first. */
  parent: number | null;
  created_at: string;
  /** What made it, for the athlete ("Moved Iron Cove turnaround 200 m west"). */
  change: string;
  segment_ids: string[];
  warnings: string[];
}

export interface StoredRoute {
  format: typeof FORMAT;
  route_id: string;
  name: string;
  kind: RouteKind;
  created_at: string;
  /** Next free number for segment and via ids. */
  next_id: number;
  segments: Record<string, StoredSegment>;
  versions: StoredVersion[];
}

/** A route id the store could hold (it also keeps a crafted id out of the file path). */
export function isRouteId(text: string): boolean {
  return ROUTE_ID_RE.test(text);
}

function base32(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes.subarray(0, 10)) out += BASE32[byte % 32];
  return out;
}

/**
 * A route id: from `key` when given, so the same request makes the same id
 * (stitch-route is idempotent), else random.
 */
export function makeRouteId(kind: RouteKind, key?: string): string {
  const bytes = key
    ? createHash("sha256").update(key).digest()
    : randomBytes(10);
  return `${kind === "draft" ? "r" : "s"}${base32(bytes)}`;
}

function routesDir(): string {
  return join(getDataDir(), "routes");
}

function routePath(routeId: string): string {
  if (!isRouteId(routeId)) throw new Error("Not a route id.");
  return join(routesDir(), `${routeId}.json`);
}

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** A track rounded for the file: 6 decimals of degree (about 0.1 m), 0.1 m of distance and altitude. */
function compactTrack(track: RouteTrack): RouteTrack {
  return {
    coordinates: track.coordinates.map(([lat, lng]) => [
      round(lat, 6),
      round(lng, 6),
    ]),
    distance: track.distance.map((d) => round(d, 1)),
    altitude: track.altitude.map((a) => (a === null ? null : round(a, 1))),
  };
}

/** The latest version of a route. */
export function latestVersion(route: StoredRoute): StoredVersion {
  return route.versions.at(-1)!;
}

export function findVersion(
  route: StoredRoute,
  version: number,
): StoredVersion | undefined {
  return route.versions.find((v) => v.version === version);
}

/** A version's segments in order. */
export function versionSegments(
  route: StoredRoute,
  version: StoredVersion,
): StoredSegment[] {
  return version.segment_ids.map((id) => route.segments[id]!);
}

/** Reads a route, or null when there is no such route (or it expired). A read counts as a use. */
export async function readRoute(routeId: string): Promise<StoredRoute | null> {
  if (!isRouteId(routeId)) return null;
  void maybeSweep();
  const path = routePath(routeId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const route = JSON.parse(text) as StoredRoute;
  const now = new Date();
  // Best effort: a read-only volume still serves the route.
  await utimes(path, now, now).catch(() => {});
  return route;
}

async function writeRoute(route: StoredRoute): Promise<void> {
  await mkdir(routesDir(), { recursive: true });
  const path = routePath(route.route_id);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(route));
  await rename(temp, path);
}

/** Changes to one route, one at a time. */
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(routeId: string, work: () => Promise<T>) {
  const before = locks.get(routeId) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.catch(() => {});
  locks.set(routeId, settled);
  try {
    return await run;
  } finally {
    if (locks.get(routeId) === settled) locks.delete(routeId);
  }
}

/** Segments as the file keeps them. */
function compactSegments(
  segments: StoredSegment[],
): Record<string, StoredSegment> {
  const out: Record<string, StoredSegment> = {};
  for (const segment of segments)
    out[segment.id] = { ...segment, track: compactTrack(segment.track) };
  return out;
}

/**
 * Stores a new route as version 1, unless a route with this id is already
 * stored (the same stitch asked again): then that route is returned as it
 * is, with `created: false`.
 */
export async function createRoute(input: {
  route_id: string;
  name: string;
  kind: RouteKind;
  next_id: number;
  segments: StoredSegment[];
  change: string;
  warnings: string[];
}): Promise<{ route: StoredRoute; created: boolean }> {
  void maybeSweep();
  return withLock(input.route_id, async () => {
    const existing = await readRoute(input.route_id);
    if (existing) return { route: existing, created: false };
    const now = new Date().toISOString();
    const route: StoredRoute = {
      format: FORMAT,
      route_id: input.route_id,
      name: input.name,
      kind: input.kind,
      created_at: now,
      next_id: input.next_id,
      segments: compactSegments(input.segments),
      versions: [
        {
          version: 1,
          parent: null,
          created_at: now,
          change: input.change,
          segment_ids: input.segments.map((s) => s.id),
          warnings: input.warnings,
        },
      ],
    };
    await writeRoute(route);
    return { route, created: true };
  });
}

/** Why a new version was not stored. */
export class RouteVersionConflictError extends Error {
  constructor(
    message: string,
    readonly latest: number,
  ) {
    super(message);
    this.name = "RouteVersionConflictError";
  }
}

/**
 * Adds a version made from `base`, which must still be the latest: a change
 * made from an older version would drop what came after it. `build` gets
 * the route as stored and returns the new version's segments (new ones and
 * kept ones) and the next free id.
 */
export async function appendVersion(
  routeId: string,
  base: number,
  build: (route: StoredRoute) => Promise<{
    segments: StoredSegment[];
    next_id: number;
    change: string;
    warnings: string[];
  }>,
): Promise<{ route: StoredRoute; version: StoredVersion }> {
  return withLock(routeId, async () => {
    const route = await readRoute(routeId);
    if (!route) throw new RouteNotFoundError(routeId);
    const latest = latestVersion(route).version;
    if (base !== latest) {
      throw new RouteVersionConflictError(
        `Version ${base} is not the latest version of route ${routeId}; version ${latest} is. Read version ${latest} and apply the change to it.`,
        latest,
      );
    }
    if (route.versions.length >= MAX_ROUTE_VERSIONS) {
      throw new RouteVersionConflictError(
        `Route ${routeId} has ${MAX_ROUTE_VERSIONS} versions, the most one route keeps. Stitch it into a new route with stitch-route (one "route" segment) and change that.`,
        latest,
      );
    }
    const made = await build(route);
    const version: StoredVersion = {
      version: latest + 1,
      parent: latest,
      created_at: new Date().toISOString(),
      change: made.change,
      segment_ids: made.segments.map((s) => s.id),
      warnings: made.warnings,
    };
    const fresh = made.segments.filter((s) => !(s.id in route.segments));
    const updated: StoredRoute = {
      ...route,
      next_id: made.next_id,
      segments: { ...route.segments, ...compactSegments(fresh) },
      versions: [...route.versions, version],
    };
    await writeRoute(updated);
    return { route: updated, version };
  });
}

/** No stored route has this id: it never existed, or it expired. */
/**
 * What startup logs about the store: its directory, how many routes it
 * holds, and whether it sits on the root filesystem. In a container that
 * means no volume is mounted there, so recreating the container loses it.
 */
export async function routeStoreInfo(): Promise<{
  dir: string;
  routes: number;
  onRootFs: boolean;
}> {
  const dir = resolve(getDataDir());
  const names = await readdir(routesDir()).catch(() => [] as string[]);
  const routes = names.filter(
    (name) => name.endsWith(".json") && isRouteId(name.slice(0, -5)),
  ).length;
  const [own, root] = await Promise.all([
    stat(dir).catch(() => null),
    stat("/"),
  ]);
  return { dir, routes, onRootFs: own !== null && own.dev === root.dev };
}

export class RouteNotFoundError extends Error {
  constructor(readonly routeId: string) {
    super(
      `No stored route has id ${routeId}. Routes not used for ${getRouteRetentionDays()} days are deleted (suggested routes after ${SUGGESTION_RETENTION_DAYS}); stitch it again with stitch-route.`,
    );
    this.name = "RouteNotFoundError";
  }
}

let lastSweep = 0;

function maybeSweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return Promise.resolve();
  lastSweep = now;
  return sweepRoutes(now).then(
    () => {},
    () => {},
  );
}

/**
 * Deletes every route file unused past its retention, and temporary files
 * left by a write that never finished. Returns how many routes it deleted.
 */
export async function sweepRoutes(now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(routesDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const draftCutoff = now - getRouteRetentionDays() * DAY_MS;
  const suggestionCutoff = now - SUGGESTION_RETENTION_DAYS * DAY_MS;
  let deleted = 0;
  for (const name of names) {
    const path = join(routesDir(), name);
    const temp = name.endsWith(".tmp");
    const id = name.replace(/\.json$/, "");
    if (!temp && (!name.endsWith(".json") || !isRouteId(id))) continue;
    try {
      const { mtimeMs } = await stat(path);
      const cutoff = temp
        ? now - DAY_MS
        : id.startsWith("s")
          ? suggestionCutoff
          : draftCutoff;
      if (mtimeMs < cutoff) {
        await unlink(path);
        if (!temp) deleted++;
      }
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return deleted;
}
