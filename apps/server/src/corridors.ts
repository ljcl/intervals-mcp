/**
 * Corridors: named lines the athlete runs, saved as stored routes of kind
 * corridor (routeStore.ts). The one home of corridor names, the stretches
 * found in history, covering runs, a corridor via's direction and whether
 * a run follows a corridor. Pure; the tools and engine read and store.
 */
import { legSection, passes, sameLine } from "./historyLegs";
import {
  haversineMeters,
  type LatLng,
  parseLatLng,
  type RouteTrack,
} from "./mapAnchors";
import { placeWords } from "./orsClient";
import { type Via } from "./routeCandidates";
import { sliceTrack, trackLength } from "./routeGeometry";
import {
  KNOWN_RUNS,
  KNOWN_STEP_M,
  knownSamples,
  lineFollowers,
} from "./routeScore";
import { type RunStart } from "./startClusters";

/** Unknown stretch a found stretch is carried across (GPS noise at a junction). */
export const FOUND_GAP_M = 30;
export const FOUND_MIN_M = 1000;
/** A stretch this much on a saved corridor or a kept stretch repeats it. */
export const FOUND_OVERLAP = 0.8;

/** Share of a line that follows another for the two to overlap. */
export const OVERLAP_MARK = 0.2;

function followedShare(track: RouteTrack, other: RouteTrack): number {
  const sets = lineFollowers([other])(track, 1);
  return sets.length === 0
    ? 0
    : sets.filter((s) => s.size > 0).length / sets.length;
}

/** Whether 20% or more of either line follows the other. */
export function linesOverlap(a: RouteTrack, b: RouteTrack): boolean {
  return (
    followedShare(a, b) >= OVERLAP_MARK || followedShare(b, a) >= OVERLAP_MARK
  );
}
export const MAX_FOUND = 10;
export const FOUND_NEAR_M = 5000;
/** A run covers a line when it follows this share of its samples. */
export const COVER_SHARE = 0.8;
export const MIN_CORRIDOR_M = 200;

/** The words of a name as a set, so "Glebe  foreshore" and "glebe Foreshore" are one name. */
export function corridorKey(text: string): string {
  return [...new Set(placeWords(text))].sort().join(" ");
}

/** The corridor named by `text` (the same words), or null; a lat,lng names none. */
export function matchCorridor<T extends { name: string }>(
  text: string,
  corridors: T[],
): T | null {
  if (parseLatLng(text)) return null;
  const key = corridorKey(text);
  if (!key) return null;
  return corridors.find((c) => corridorKey(c.name) === key) ?? null;
}

/** The first corridor, by name, whose name has every word of `text`; null when none. */
export function corridorHint<T extends { name: string }>(
  text: string,
  corridors: T[],
): T | null {
  const words = new Set(placeWords(text));
  if (words.size === 0) return null;
  return (
    [...corridors]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((c) => {
        const own = new Set(placeWords(c.name));
        return [...words].every((w) => own.has(w));
      }) ?? null
  );
}

/** Loaded runs (indices of the follower index) that follow at least {@link COVER_SHARE} of a track. */
export function coveringRuns(
  track: RouteTrack,
  followers: (track: RouteTrack, cap?: number) => Set<number>[],
): number {
  const sets = followers(track);
  if (sets.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const s of sets)
    for (const r of s) counts.set(r, (counts.get(r) ?? 0) + 1);
  let n = 0;
  for (const c of counts.values()) if (c >= COVER_SHARE * sets.length) n++;
  return n;
}

/** From per-sample known flags: [from_m, to_m] of each stretch of at least FOUND_MIN_M, gaps of up to FOUND_GAP_M carried. */
export function knownStretches(flags: boolean[]): Array<[number, number]> {
  const maxGap = Math.floor(FOUND_GAP_M / KNOWN_STEP_M);
  const out: Array<[number, number]> = [];
  let first = -1;
  let last = -1;
  const close = () => {
    if (first >= 0 && (last - first) * KNOWN_STEP_M >= FOUND_MIN_M)
      out.push([first * KNOWN_STEP_M, last * KNOWN_STEP_M]);
  };
  flags.forEach((known, i) => {
    if (!known) return;
    if (first >= 0 && i - last - 1 <= maxGap) last = i;
    else {
      close();
      first = i;
      last = i;
    }
  });
  close();
  return out;
}

export interface FoundStretch {
  activity_id: string;
  name: string;
  date: string;
  /** The run's own km. */
  from_km: number;
  to_km: number;
  length_m: number;
  /** Loaded runs covering it ({@link coveringRuns}). */
  runs: number;
  start: LatLng;
  end: LatLng;
  track: RouteTrack;
}

/** Whether FOUND_OVERLAP of a track's samples follow one of `others`. */
function repeats(track: RouteTrack, others: RouteTrack[]): boolean {
  if (others.length === 0) return false;
  const sets = lineFollowers(others)(track, 1);
  return (
    sets.length > 0 &&
    sets.filter((s) => s.size > 0).length >= FOUND_OVERLAP * sets.length
  );
}

/**
 * Stretches run KNOWN_RUNS or more times and not saved: per loaded run,
 * newest first, its known stretches ({@link knownStretches}); one that
 * repeats a saved corridor or a kept stretch is dropped, so a line comes
 * from its newest run once. Those within FOUND_NEAR_M of `near`, longest
 * first, at most MAX_FOUND.
 */
export function foundStretches(
  runs: RunStart[],
  saved: RouteTrack[],
  near: LatLng,
): FoundStretch[] {
  if (runs.length < KNOWN_RUNS) return [];
  const known = knownSamples(runs);
  const followers = lineFollowers(runs.map((r) => r.track));
  const kept: FoundStretch[] = [];
  const newest = [...runs].sort((a, b) => b.date.localeCompare(a.date));
  for (const run of newest) {
    for (const [from_m, to_m] of knownStretches(known(run.track))) {
      const track = sliceTrack(run.track, from_m, to_m);
      if (repeats(track, [...saved, ...kept.map((k) => k.track)])) continue;
      kept.push({
        activity_id: run.id,
        name: run.name,
        date: run.date,
        from_km: Math.round(from_m / 10) / 100,
        to_km: Math.round(to_m / 10) / 100,
        length_m: Math.round(trackLength(track)),
        runs: coveringRuns(track, followers),
        start: track.coordinates[0]!,
        end: track.coordinates.at(-1)!,
        track,
      });
    }
  }
  return kept
    .filter((k) =>
      k.track.coordinates.some((p) => haversineMeters(p, near) <= FOUND_NEAR_M),
    )
    .sort((a, b) => b.length_m - a.length_m)
    .slice(0, MAX_FOUND);
}

/** A corridor as a via: its track in the direction run, and its ends. */
export interface CorridorLeg {
  track: RouteTrack;
  entry: LatLng;
  exit: LatLng;
}

export const MAX_DIRECTION_TRIES = 4;

/**
 * Directions to try for the vias, per combination whether each corridor is
 * run reversed: cheapest straight-line joins first (a tie keeps stored on the
 * earliest via that differs), a one-way corridor stored only. A straight line
 * cannot see water or a dead end, so the engine builds several and the score
 * chooses.
 */
export function directionCombos(
  start: LatLng,
  items: Array<LatLng | { track: RouteTrack; one_way: boolean }>,
  end: LatLng | null,
  max = MAX_DIRECTION_TRIES,
): boolean[][] {
  const corridors = items.flatMap((item, i) =>
    Array.isArray(item) ? [] : [i],
  );
  const combos: Array<{ reversed: boolean[]; cost: number }> = [];
  for (let mask = 0; mask < 2 ** corridors.length; mask++) {
    const reversed = items.map(() => false);
    corridors.forEach((index, k) => {
      reversed[index] = Boolean(mask & (1 << (corridors.length - 1 - k)));
    });
    if (
      items.some(
        (item, i) => reversed[i] && !Array.isArray(item) && item.one_way,
      )
    )
      continue;
    let cost = 0;
    let at = start;
    items.forEach((item, i) => {
      if (Array.isArray(item)) {
        cost += haversineMeters(at, item);
        at = item;
        return;
      }
      const a = item.track.coordinates[0]!;
      const b = item.track.coordinates.at(-1)!;
      const [entry, exit] = reversed[i] ? [b, a] : [a, b];
      cost += haversineMeters(at, entry);
      at = exit;
    });
    if (end) cost += haversineMeters(at, end);
    combos.push({ reversed, cost });
  }
  // sort is stable, so a tie keeps the smaller mask.
  return combos
    .sort((x, y) => x.cost - y.cost)
    .slice(0, max)
    .map((c) => c.reversed);
}

/** Whether a track passes the corridor's entry, then its exit, and runs its line between (sameLine, 30 m). */
export function followsCorridor(track: RouteTrack, leg: CorridorLeg): boolean {
  const exits = passes(track, leg.exit);
  return passes(track, leg.entry).some((into) => {
    const out = exits.find((d) => d > into);
    return (
      out !== undefined && sameLine(sliceTrack(track, into, out), leg.track)
    );
  });
}

export const MAX_THROUGH = 10;

export interface RunThrough {
  activity_id: string;
  name: string;
  date: string;
  from_km: number;
  to_km: number | null;
}

/** Recent runs through one place, or through two (the shortest part between them), newest first. */
export function runsThrough(runs: RunStart[], places: Via[]): RunThrough[] {
  const km = (m: number) => Math.round(m / 10) / 100;
  const out: RunThrough[] = [];
  for (const run of [...runs].sort((a, b) => b.date.localeCompare(a.date))) {
    if (out.length >= MAX_THROUGH) break;
    const ids = { activity_id: run.id, name: run.name, date: run.date };
    if (places.length === 1) {
      const first = passes(run.track, places[0]!)[0];
      if (first !== undefined)
        out.push({ ...ids, from_km: km(first), to_km: null });
      continue;
    }
    const section = legSection(run, places[0]!, places[1]!);
    if (section)
      out.push({
        ...ids,
        from_km: km(section.from_m),
        to_km: km(section.to_m),
      });
  }
  return out;
}
