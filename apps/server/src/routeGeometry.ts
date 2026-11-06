/**
 * Track geometry for stored routes (stitch-route, amend-route,
 * view-route-map with a route_id, export-route): cut a track at a distance,
 * join tracks, reverse one, find where a point lies along one, and find
 * where two versions of a route differ. Pure math on {@link RouteTrack};
 * the one home for these rules, so the builder, the map and the export
 * agree on every km.
 */
import {
  cumulativeDistances,
  haversineMeters,
  indexAtDistance,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { eastNorth, moveBy } from "./routeCandidates";

/** Two route ends this close are joined with a straight line; further apart, the gap is routed. */
export const JOIN_GAP_M = 30;
/** Points closer than this to the last kept one are dropped from a stored track. */
export const STORED_POINT_SPACING_M = 5;
/** Two versions agree where their points along the same distance are this close. */
export const SAME_PLACE_M = 8;
/** How often {@link trackDiff} compares two tracks along their length. */
const DIFF_STEP_M = 10;

export const EMPTY_TRACK: RouteTrack = {
  coordinates: [],
  distance: [],
  altitude: [],
};

export function trackLength(track: RouteTrack): number {
  return track.distance.at(-1) ?? 0;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpAltitude(
  a: number | null,
  b: number | null,
  t: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return lerp(a, b, t);
}

/** The point and altitude `distance_m` along a track, interpolated; clamped to its ends. */
export function pointAtDistance(
  track: RouteTrack,
  distance_m: number,
): { point: LatLng; altitude: number | null } {
  const { coordinates, distance, altitude } = track;
  if (coordinates.length === 0) throw new Error("pointAtDistance: empty track");
  const target = Math.min(Math.max(distance_m, 0), trackLength(track));
  const i = Math.max(0, indexAtDistance(distance, target));
  if (i === 0 || distance[i]! <= target) {
    return { point: coordinates[i]!, altitude: altitude[i] ?? null };
  }
  const span = distance[i]! - distance[i - 1]!;
  const t = span > 0 ? (target - distance[i - 1]!) / span : 0;
  const a = coordinates[i - 1]!;
  const b = coordinates[i]!;
  return {
    point: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)],
    altitude: lerpAltitude(altitude[i - 1] ?? null, altitude[i] ?? null, t),
  };
}

/**
 * The part of a track from `from_m` to `to_m` (clamped, in order), with
 * interpolated end points and distances counted from its own start.
 */
export function sliceTrack(
  track: RouteTrack,
  from_m: number,
  to_m: number,
): RouteTrack {
  const length = trackLength(track);
  const from = Math.min(Math.max(from_m, 0), length);
  const to = Math.min(Math.max(to_m, from), length);
  if (track.coordinates.length === 0) return EMPTY_TRACK;
  const start = pointAtDistance(track, from);
  const coordinates: LatLng[] = [start.point];
  const distance: number[] = [0];
  const altitude: (number | null)[] = [start.altitude];
  for (let i = 0; i < track.coordinates.length; i++) {
    const d = track.distance[i]!;
    if (d <= from || d >= to) continue;
    coordinates.push(track.coordinates[i]!);
    distance.push(d - from);
    altitude.push(track.altitude[i] ?? null);
  }
  if (to > from) {
    const end = pointAtDistance(track, to);
    coordinates.push(end.point);
    distance.push(to - from);
    altitude.push(end.altitude);
  }
  return { coordinates, distance, altitude };
}

/** A track run the other way: distances from the old end. */
export function reverseTrack(track: RouteTrack): RouteTrack {
  const length = trackLength(track);
  return {
    coordinates: [...track.coordinates].reverse(),
    distance: [...track.distance].reverse().map((d) => length - d),
    altitude: [...track.altitude].reverse(),
  };
}

/**
 * Tracks one after another as one track. Each seam adds the straight
 * distance from one track's end to the next one's start, so a gap the
 * caller chose to join directly is counted.
 */
export function concatTracks(tracks: RouteTrack[]): RouteTrack {
  const coordinates: LatLng[] = [];
  const distance: number[] = [];
  const altitude: (number | null)[] = [];
  let offset = 0;
  for (const track of tracks) {
    if (track.coordinates.length === 0) continue;
    const last = coordinates.at(-1);
    let skipFirst = false;
    if (last) {
      const seam = haversineMeters(last, track.coordinates[0]!);
      // A seam on the same spot keeps one point, not two.
      if (seam < 0.5) skipFirst = true;
      offset = distance.at(-1)! + seam;
    }
    for (let i = skipFirst ? 1 : 0; i < track.coordinates.length; i++) {
      coordinates.push(track.coordinates[i]!);
      distance.push(offset + track.distance[i]!);
      altitude.push(track.altitude[i] ?? null);
    }
  }
  return { coordinates, distance, altitude };
}

/** A track from points alone, its distances measured along them. */
export function trackFromPoints(
  coordinates: LatLng[],
  altitude: (number | null)[] = coordinates.map(() => null),
): RouteTrack {
  return { coordinates, distance: cumulativeDistances(coordinates), altitude };
}

/**
 * A track with points closer than `spacing_m` to the last kept point
 * dropped (the last point always stays), so a 1 s recording does not fill
 * the store. Distances keep their values.
 */
export function thinTrack(
  track: RouteTrack,
  spacing_m: number = STORED_POINT_SPACING_M,
): RouteTrack {
  const n = track.coordinates.length;
  if (n <= 2) return track;
  const keep = [0];
  for (let i = 1; i < n - 1; i++) {
    // A hair under the spacing still counts: haversine sums are not exact.
    if (track.distance[i]! - track.distance[keep.at(-1)!]! >= spacing_m - 1e-6)
      keep.push(i);
  }
  keep.push(n - 1);
  return {
    coordinates: keep.map((i) => track.coordinates[i]!),
    distance: keep.map((i) => track.distance[i]!),
    altitude: keep.map((i) => track.altitude[i] ?? null),
  };
}

/**
 * Where `point` lies along a track: the distance along it of the nearest
 * spot on the line between samples, and how far off the line the point is.
 * `from_m`/`to_m` limit the search to part of the track.
 */
export function nearestOnTrack(
  track: RouteTrack,
  point: LatLng,
  from_m = 0,
  to_m = Number.POSITIVE_INFINITY,
): { distance_m: number; offset_m: number } {
  let best = { distance_m: from_m, offset_m: Number.POSITIVE_INFINITY };
  const { coordinates, distance } = track;
  for (let i = 0; i < coordinates.length; i++) {
    const d0 = distance[i]!;
    if (i + 1 < coordinates.length) {
      const d1 = distance[i + 1]!;
      if (d1 < from_m || d0 > to_m) continue;
      // Project onto the segment in a flat frame around its first point.
      const a = coordinates[i]!;
      const [bx, by] = eastNorth(a, coordinates[i + 1]!);
      const [px, py] = eastNorth(a, point);
      const len2 = bx * bx + by * by;
      const t =
        len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
      const along = Math.min(to_m, Math.max(from_m, d0 + t * (d1 - d0)));
      const offset = Math.hypot(px - t * bx, py - t * by);
      if (offset < best.offset_m)
        best = { distance_m: along, offset_m: offset };
    } else if (d0 >= from_m && d0 <= to_m) {
      const offset = haversineMeters(coordinates[i]!, point);
      if (offset < best.offset_m) best = { distance_m: d0, offset_m: offset };
    }
  }
  return best;
}

/** Ramer-Douglas-Peucker in a flat frame: the indexes to keep within `tolerance_m`. */
function simplifyIndexes(coordinates: LatLng[], tolerance_m: number): number[] {
  const n = coordinates.length;
  if (n <= 2) return coordinates.map((_, i) => i);
  const origin = coordinates[0]!;
  const xy = coordinates.map((c) => eastNorth(origin, c));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = xy[first]!;
    const [bx, by] = xy[last]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstOffset = tolerance_m;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = xy[i]!;
      const offset =
        len > 0
          ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len
          : Math.hypot(px - ax, py - ay);
      if (offset > worstOffset) {
        worst = i;
        worstOffset = offset;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => {
    if (k) out.push(i);
  });
  return out;
}

/** A track with the points a line within `tolerance_m` does not need dropped (export). */
export function simplifyTrack(
  track: RouteTrack,
  tolerance_m: number,
): RouteTrack {
  const keep = simplifyIndexes(track.coordinates, tolerance_m);
  return {
    coordinates: keep.map((i) => track.coordinates[i]!),
    distance: keep.map((i) => track.distance[i]!),
    altitude: keep.map((i) => track.altitude[i] ?? null),
  };
}

/** Where two tracks of the same route differ: the shared start and end, in metres. */
export interface TrackDiff {
  /** Both tracks match from their starts for this many metres. */
  same_start_m: number;
  /** Both tracks match up to their ends for this many metres. */
  same_end_m: number;
  /** The changed part of the old track, metres from its start. */
  old_from_m: number;
  old_to_m: number;
  /** The changed part of the new track, metres from its start. */
  new_from_m: number;
  new_to_m: number;
  /** False when the tracks match end to end. */
  changed: boolean;
}

/**
 * How far two tracks match from their starts and from their ends, compared
 * every {@link DIFF_STEP_M} along both, a place matching when the points
 * are within {@link SAME_PLACE_M}. Sampling by distance rather than by
 * point, so a track cut and joined again at a new point still matches.
 */
export function trackDiff(before: RouteTrack, after: RouteTrack): TrackDiff {
  const lengthA = trackLength(before);
  const lengthB = trackLength(after);
  const shorter = Math.min(lengthA, lengthB);
  const matches = (da: number, db: number) =>
    haversineMeters(
      pointAtDistance(before, da).point,
      pointAtDistance(after, db).point,
    ) <= SAME_PLACE_M;
  const empty =
    before.coordinates.length === 0 || after.coordinates.length === 0;
  /** The furthest distance up to `limit` where `at(d)` still matches, every step from 0. */
  const matchedFor = (limit: number, at: (d: number) => boolean) => {
    if (empty) return 0;
    let last = 0;
    for (let d = 0; d < limit; d += DIFF_STEP_M) {
      if (!at(d)) return last;
      last = d;
    }
    return at(limit) ? limit : last;
  };
  const start = matchedFor(shorter, (d) => matches(d, d));
  const end = matchedFor(shorter - start, (d) =>
    matches(lengthA - d, lengthB - d),
  );
  const changed = !(
    Math.abs(lengthA - lengthB) < 1 && start + end >= shorter - 1
  );
  return {
    same_start_m: start,
    same_end_m: end,
    old_from_m: start,
    old_to_m: Math.max(start, lengthA - end),
    new_from_m: start,
    new_to_m: Math.max(start, lengthB - end),
    changed,
  };
}

/** A pin carried from one version of a route to another. */
export interface MappedDistance {
  distance_m: number;
  /** The pin was inside the changed part and no point of the new track is near its old place. */
  uncertain: boolean;
}

/**
 * Where a place `old_m` along the old track is on the new one: unchanged
 * before the change, shifted by the length change after it, and inside it
 * the nearest point of the new changed part, uncertain when that is over
 * {@link JOIN_GAP_M} away.
 */
export function mapDistance(
  old_m: number,
  before: RouteTrack,
  after: RouteTrack,
  diff: TrackDiff,
): MappedDistance {
  if (!diff.changed || old_m <= diff.old_from_m)
    return {
      distance_m: Math.min(old_m, trackLength(after)),
      uncertain: false,
    };
  if (old_m >= diff.old_to_m)
    return {
      distance_m: Math.max(0, old_m + (diff.new_to_m - diff.old_to_m)),
      uncertain: false,
    };
  const place = pointAtDistance(before, old_m).point;
  const near = nearestOnTrack(after, place, diff.new_from_m, diff.new_to_m);
  return { distance_m: near.distance_m, uncertain: near.offset_m > JOIN_GAP_M };
}

const COMPASS: Record<string, number> = {
  n: 0,
  north: 0,
  nne: 22.5,
  ne: 45,
  northeast: 45,
  ene: 67.5,
  e: 90,
  east: 90,
  ese: 112.5,
  se: 135,
  southeast: 135,
  sse: 157.5,
  s: 180,
  south: 180,
  ssw: 202.5,
  sw: 225,
  southwest: 225,
  wsw: 247.5,
  w: 270,
  west: 270,
  wnw: 292.5,
  nw: 315,
  northwest: 315,
  nnw: 337.5,
};

/**
 * A compass heading in degrees from text: a direction ("west", "NE",
 * "north-east") or a number of degrees. Null when the text is neither, so
 * the caller can read it as a place.
 */
export function parseHeading(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const key = trimmed.replace(/[\s_-]+/g, "");
  if (key in COMPASS) return COMPASS[key]!;
  const degrees = /^(-?\d+(?:\.\d+)?)\s*(?:°|deg|degrees)?$/.exec(trimmed);
  if (!degrees) return null;
  const value = Number(degrees[1]);
  return ((value % 360) + 360) % 360;
}

/** `point` moved `distance_m` toward compass `heading` degrees. */
export function moveToward(
  point: LatLng,
  heading: number,
  distance_m: number,
): LatLng {
  const rad = (heading * Math.PI) / 180;
  return moveBy(point, distance_m * Math.sin(rad), distance_m * Math.cos(rad));
}

/** Doubling back shorter than this each way is a corner, not a dead end. */
const SPUR_MIN_M = 25;
/** Sample spacing for {@link findSpurs}. */
const SPUR_STEP_M = 5;
/** A return this close counts as the same way: a footway, or the path on its other side. */
const SPUR_MATCH_M = 12;
/** Directions at least this far apart (cosine) are opposite. */
const OPPOSITE_COS = -0.7;

/**
 * Where a track goes back the way it came: a stretch going one way with a
 * later stretch within 12 m of it going the other way, for at least 25 m.
 * Each is `from_m`, where it turns in, to `to_m`, where it is back out; a
 * dead end's tip is between them, wherever the turn is.
 */
export function findSpurs(
  track: RouteTrack,
): Array<{ from_m: number; to_m: number }> {
  const n = Math.floor(trackLength(track) / SPUR_STEP_M);
  if (n < 3) return [];
  const origin = track.coordinates[0]!;
  const xy = Array.from({ length: n + 1 }, (_, i) =>
    eastNorth(origin, pointAtDistance(track, i * SPUR_STEP_M).point),
  );
  const dir = xy.map(([x, y], i) => {
    const [nx, ny] = xy[Math.min(i + 1, n)]!;
    const [px, py] = i === n ? xy[i - 1]! : [x, y];
    const dx = nx - px;
    const dy = ny - py;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len] as const;
  });
  const cell = (x: number, y: number) =>
    `${Math.floor(x / SPUR_MATCH_M)},${Math.floor(y / SPUR_MATCH_M)}`;
  const grid = new Map<string, number[]>();
  xy.forEach(([x, y], i) => {
    const key = cell(x, y);
    grid.set(key, [...(grid.get(key) ?? []), i]);
  });
  // The furthest later sample going back over each one, or -1.
  const back = xy.map(([x, y], i) => {
    let best = -1;
    const cx = Math.floor(x / SPUR_MATCH_M);
    const cy = Math.floor(y / SPUR_MATCH_M);
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++)
        for (const j of grid.get(`${gx},${gy}`) ?? []) {
          if (j <= i + 2 || j <= best) continue;
          const [jx, jy] = xy[j]!;
          const opposite =
            dir[i]![0] * dir[j]![0] + dir[i]![1] * dir[j]![1] < OPPOSITE_COS;
          if (opposite && Math.hypot(jx - x, jy - y) <= SPUR_MATCH_M) best = j;
        }
    return best;
  });
  const spurs: Array<{ from_m: number; to_m: number }> = [];
  for (let i = 0; i <= n; i++) {
    if (back[i]! < 0) continue;
    // A run of samples that each have a way back; gaps of one sample are noise.
    let end = i;
    let out = back[i]!;
    while (
      end + 1 <= n &&
      (back[end + 1]! >= 0 || (end + 2 <= n && back[end + 2]! >= 0))
    ) {
      end++;
      out = Math.max(out, back[end]!);
    }
    if ((end - i) * SPUR_STEP_M >= SPUR_MIN_M)
      spurs.push({ from_m: i * SPUR_STEP_M, to_m: out * SPUR_STEP_M });
    i = Math.max(end, out);
  }
  return spurs;
}
