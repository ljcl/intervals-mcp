/**
 * Route suggestion candidates: the shared shape, the athlete's terrain
 * bands, past-run matching, ranking, out-and-back folding and duplicate
 * detection. Pure; the engine (routeSuggestions.ts) does the I/O.
 */
import { type RepeatHill } from "./hillAnalysis";
import {
  cumulativeDistances,
  haversineMeters,
  indexAtDistance,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { CLUSTER_RADIUS_M, type RunStart } from "./startClusters";
import { daysBetween } from "./utils/localDate";

export type RouteShape = "loop" | "out-and-back" | "point-to-point";
export type Terrain = "any" | "flat" | "rolling" | "hilly" | "hill-repeats";

export interface RouteCandidate {
  kind: "past" | "generated";
  /** The past run's activity id; null for a generated route. */
  activity_id: string | null;
  name: string;
  /** The past run's date; null for a generated route. */
  date: string | null;
  shape: RouteShape;
  distance_m: number;
  climb_m: number;
  /** Generated routes only: share on paths, footways, tracks, cycleways. */
  path_share: number | null;
  /** Crossings and signals per km (OpenStreetMap); null when not counted. */
  crossings_per_km: number | null;
  /** Set by the engine for terrain hill-repeats. */
  hill: RepeatHill | null;
  summary: string;
  track: RouteTrack;
}

export const PAST_DISTANCE_TOLERANCE = 0.1;
export const MAX_PAST_CANDIDATES = 2;
/** Past runs kept before crossings are counted and the best two chosen. */
export const PAST_POOL = 6;
export const RECENT_REPEAT_DAYS = 7;
/** A rise counts once it reaches this far above the last low, so elevation noise does not add up. */
export const CLIMB_HYSTERESIS_M = 3;

/** Climb per km (m) cut points between flat, rolling and hilly. */
export interface TerrainBands {
  /** Flat at or below this. */
  flatBelow: number;
  hillyAbove: number;
}

/** For an athlete with too few runs to calibrate from. */
export const DEFAULT_TERRAIN_BANDS: TerrainBands = {
  flatBelow: 8,
  hillyAbove: 20,
};
export const MIN_RUNS_FOR_BANDS = 10;

/** Two routes this close at 25%, 50% and 75% of the way are the same route. */
const SAME_ROUTE_M = 200;
const SAME_ROUTE_LENGTH = 0.03;

export function climbPerKm(climb_m: number, distance_m: number): number {
  return distance_m > 0 ? climb_m / (distance_m / 1000) : 0;
}

/**
 * The athlete's own terrain thirds by climb per km: flat is their flattest
 * third of recent runs, hilly their hilliest. Runs with no recorded climb
 * are left out. Fixed defaults with fewer than {@link MIN_RUNS_FOR_BANDS}
 * runs.
 */
export function terrainBands(runs: RunStart[]): TerrainBands {
  const perKm = runs
    .flatMap((r) =>
      r.climb_m === null ? [] : [climbPerKm(r.climb_m, r.distance_m)],
    )
    .sort((a, b) => a - b);
  if (perKm.length < MIN_RUNS_FOR_BANDS) return DEFAULT_TERRAIN_BANDS;
  const at = (q: number) => perKm[Math.floor(q * (perKm.length - 1))]!;
  return { flatBelow: at(1 / 3), hillyAbove: at(2 / 3) };
}

export function terrainFits(
  terrain: Terrain,
  climb_m: number,
  distance_m: number,
  bands: TerrainBands,
): boolean {
  if (terrain === "any" || terrain === "hill-repeats") return true;
  const perKm = climbPerKm(climb_m, distance_m);
  if (terrain === "flat") return perKm <= bands.flatBelow;
  if (terrain === "hilly") return perKm > bands.hillyAbove;
  return perKm >= bands.flatBelow && perKm <= bands.hillyAbove;
}

/** Climb along an altitude column with {@link CLIMB_HYSTERESIS_M} hysteresis, gaps skipped. */
export function trackClimb(altitude: (number | null)[]): number {
  let climb = 0;
  let low: number | null = null;
  for (const value of altitude) {
    if (value === null) continue;
    if (low === null || value < low) {
      low = value;
    } else if (value - low >= CLIMB_HYSTERESIS_M) {
      climb += value - low;
      low = value;
    }
  }
  return Math.round(climb);
}

export function isLoop(track: RouteTrack): boolean {
  const first = track.coordinates[0];
  const last = track.coordinates.at(-1);
  return !!first && !!last && haversineMeters(first, last) <= CLUSTER_RADIUS_M;
}

function pointAt(track: RouteTrack, fraction: number): LatLng {
  const index = indexAtDistance(
    track.distance,
    (track.distance.at(-1) ?? 0) * fraction,
  );
  return track.coordinates[Math.max(0, index)]!;
}

/** The same route, either way round (a loop run in reverse is the same loop). */
export function sameRoute(a: RouteTrack, b: RouteTrack): boolean {
  const lengthA = a.distance.at(-1) ?? 0;
  const lengthB = b.distance.at(-1) ?? 0;
  if (
    Math.abs(lengthA - lengthB) >
    Math.max(lengthA, lengthB) * SAME_ROUTE_LENGTH
  )
    return false;
  const along = (reversed: boolean) =>
    [0.25, 0.5, 0.75].every(
      (f) =>
        haversineMeters(pointAt(a, f), pointAt(b, reversed ? 1 - f : f)) <=
        SAME_ROUTE_M,
    );
  return along(false) || along(true);
}

/** Candidates with later duplicates of an earlier route removed. */
export function dedupeRoutes(candidates: RouteCandidate[]): RouteCandidate[] {
  const kept: RouteCandidate[] = [];
  for (const candidate of candidates) {
    if (!kept.some((k) => sameRoute(k.track, candidate.track)))
      kept.push(candidate);
  }
  return kept;
}

/** Lower first, unknown last. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/** Past runs: not repeated in the last 7 days first, then fewer crossings, then closest distance. */
export function rankPast(
  candidates: RouteCandidate[],
  target_m: number,
  today: string,
): RouteCandidate[] {
  const recent = (c: RouteCandidate) =>
    c.date !== null && daysBetween(c.date, today) <= RECENT_REPEAT_DAYS ? 1 : 0;
  return [...candidates].sort(
    (a, b) =>
      recent(a) - recent(b) ||
      compareNullable(a.crossings_per_km, b.crossings_per_km) ||
      Math.abs(a.distance_m - target_m) - Math.abs(b.distance_m - target_m),
  );
}

/**
 * Past runs from one start that could fit a planned run: loops (they end
 * where they start) within 10% of the distance that fit the terrain, not
 * already used, duplicates removed (runs come newest first, so each route
 * keeps its latest recording and "not repeated in 7 days" is judged per
 * route), ranked by {@link rankPast}. The engine
 * keeps {@link PAST_POOL}, counts their crossings, ranks again and keeps
 * {@link MAX_PAST_CANDIDATES}. Point-to-point plans get none.
 */
export function matchPastRuns(
  runs: RunStart[],
  options: {
    target_m: number;
    shape: RouteShape;
    terrain: Terrain;
    today: string;
    exclude: ReadonlySet<string>;
    bands: TerrainBands;
  },
): RouteCandidate[] {
  const { target_m, shape, terrain, today, exclude, bands } = options;
  if (shape === "point-to-point") return [];
  const matching = runs
    .filter(
      (run) =>
        !exclude.has(run.id) &&
        isLoop(run.track) &&
        Math.abs(run.distance_m - target_m) <=
          target_m * PAST_DISTANCE_TOLERANCE &&
        terrainFits(terrain, run.climb_m ?? 0, run.distance_m, bands),
    )
    .map(
      (run): RouteCandidate => ({
        kind: "past",
        activity_id: run.id,
        name: run.name,
        date: run.date,
        shape: "loop",
        distance_m: run.distance_m,
        climb_m: run.climb_m ?? 0,
        path_share: null,
        crossings_per_km: null,
        hill: null,
        summary: `Your run "${run.name}" on ${run.date}`,
        track: run.track,
      }),
    );
  return rankPast(dedupeRoutes(matching), target_m, today);
}

/** The first half of a track, then back the same way: an out-and-back as long as the track. */
export function outAndBack(track: RouteTrack): RouteTrack {
  if (track.coordinates.length < 2) return track;
  const half = (track.distance.at(-1) ?? 0) / 2;
  // Nearest sample to the half, not the first past it, so the fold is not a sample long.
  const next = Math.max(1, indexAtDistance(track.distance, half));
  const turn = Math.max(
    1,
    half - track.distance[next - 1]! < track.distance[next]! - half
      ? next - 1
      : next,
  );
  const out = track.coordinates.slice(0, turn + 1);
  const outAltitude = track.altitude.slice(0, turn + 1);
  const coordinates = [...out, ...out.slice(0, -1).reverse()];
  return {
    coordinates,
    distance: cumulativeDistances(coordinates),
    altitude: [...outAltitude, ...outAltitude.slice(0, -1).reverse()],
  };
}

/**
 * Generated candidates best first: within {@link PAST_DISTANCE_TOLERANCE}
 * of the distance, then terrain fit, then (hill repeats) a hill found, then
 * fewer crossings, then the share on paths, then climb in the asked
 * direction (least for flat, most for hilly), then distance.
 */
export function rankGenerated(
  candidates: RouteCandidate[],
  terrain: Terrain,
  target_m: number,
  bands: TerrainBands,
): RouteCandidate[] {
  const misfit = (c: RouteCandidate) =>
    terrainFits(terrain, c.climb_m, c.distance_m, bands) ? 0 : 1;
  const offTarget = (c: RouteCandidate) =>
    Math.abs(c.distance_m - target_m) <= target_m * PAST_DISTANCE_TOLERANCE
      ? 0
      : 1;
  const perKm = (c: RouteCandidate) => climbPerKm(c.climb_m, c.distance_m);
  return [...candidates].sort(
    (a, b) =>
      offTarget(a) - offTarget(b) ||
      misfit(a) - misfit(b) ||
      (terrain === "hill-repeats" ? Number(!a.hill) - Number(!b.hill) : 0) ||
      compareNullable(a.crossings_per_km, b.crossings_per_km) ||
      (b.path_share ?? 0) - (a.path_share ?? 0) ||
      (terrain === "flat"
        ? perKm(a) - perKm(b)
        : terrain === "hilly"
          ? perKm(b) - perKm(a)
          : 0) ||
      Math.abs(a.distance_m - target_m) - Math.abs(b.distance_m - target_m),
  );
}
