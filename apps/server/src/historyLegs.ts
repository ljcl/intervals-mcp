/**
 * Stitched via routes: a via route built from sections of the athlete's own
 * past runs between consecutive anchors (start, via points, end), with
 * OpenRouteService filling only what no run covers. ORS joins via points by
 * the shortest foot path; the athlete's runs are the lines they chose.
 * Pure; the engine (routeSuggestions.ts) routes the fills.
 */
import { haversineMeters, type LatLng, type RouteTrack } from "./mapAnchors";
import {
  type RouteCandidate,
  type RouteShape,
  thereAndBack,
  trackClimb,
  VIA_MATCH_M,
} from "./routeCandidates";
import {
  concatTracks,
  JOIN_GAP_M,
  nearestOnTrack,
  pointAtDistance,
  reverseTrack,
  sliceTrack,
  trackLength,
} from "./routeGeometry";
import { type RunStart } from "./startClusters";

/** A section longer than this many times its leg's straight line (plus the slack) is a detour, not a way between them. */
const SECTION_DETOUR_FACTOR = 2;
const SECTION_DETOUR_SLACK_M = 500;
/** Two sections are one line when every sampled point of each is this close to the other. */
const SAME_LINE_M = 30;
const SAME_LINE_LENGTH = 0.1;
const SAME_LINE_SAMPLES = 10;
const MAX_SECTIONS_PER_LEG = 3;
const STITCHED_COMBINATIONS = 2;
/** Streets wander: an uncovered leg is estimated at its straight line times this. */
const FILL_STREET_FACTOR = 1.3;
/** ORS calls the stitched routes of one planned run may spend on fills. */
export const STITCH_FILL_CALLS = 4;

type RunRef = Pick<RunStart, "id" | "name" | "date">;

interface Section {
  /** In leg direction. */
  track: RouteTrack;
  run: RunRef;
}

/** A line between two anchors: its newest run's section, and every run on it, newest first. */
export interface LegOption {
  track: RouteTrack;
  runs: RunRef[];
}

export type StitchPiece =
  | { kind: "section"; option: LegOption }
  | { kind: "fill"; waypoints: LatLng[] };

export interface StitchPlan {
  pieces: StitchPiece[];
  /** Route length before routing, m (doubled for an out-and-back). */
  estimate_m: number;
}

/** Start, via points, then the start again (loop), the end (point-to-point) or nothing (out-and-back: the way out). */
export function stitchAnchors(
  start: LatLng,
  via: LatLng[],
  shape: RouteShape,
  end: LatLng | null,
): LatLng[] {
  if (shape === "loop") return [start, ...via, start];
  if (shape === "out-and-back") return [start, ...via];
  return [start, ...via, ...(end ? [end] : [])];
}

/** Where a track passes `point`: per visit within {@link VIA_MATCH_M}, the distance along it of the nearest spot. */
export function passes(track: RouteTrack, point: LatLng): number[] {
  const { coordinates, distance } = track;
  const out: number[] = [];
  let i = 0;
  while (i < coordinates.length) {
    if (haversineMeters(coordinates[i]!, point) > VIA_MATCH_M) {
      i++;
      continue;
    }
    const first = i;
    while (
      i + 1 < coordinates.length &&
      haversineMeters(coordinates[i + 1]!, point) <= VIA_MATCH_M
    )
      i++;
    // One sample either side, so the nearest spot can lie on the line into or out of the visit.
    const from = distance[Math.max(0, first - 1)]!;
    const to = distance[Math.min(coordinates.length - 1, i + 1)]!;
    out.push(nearestOnTrack(track, point, from, to).distance_m);
    i++;
  }
  return out;
}

/**
 * The shortest part of `run` from a pass of `a` to a pass of `b`; null when it
 * misses one or only detours between them. A pair in the run's own direction
 * of travel wins over a shorter reversed one (a loop that goes up street A and
 * back down street B must not give both legs street A); the reversed pair is
 * the fallback.
 */
export function legSection(
  run: RunStart,
  a: LatLng,
  b: LatLng,
): Section | null {
  const limit =
    SECTION_DETOUR_FACTOR * haversineMeters(a, b) + SECTION_DETOUR_SLACK_M;
  const atB = passes(run.track, b);
  let forward: { from: number; to: number } | null = null;
  let reversed: { from: number; to: number } | null = null;
  for (const from of passes(run.track, a))
    for (const to of atB) {
      const length = Math.abs(to - from);
      if (length === 0 || length > limit) continue;
      if (from < to) {
        if (!forward || length < forward.to - forward.from)
          forward = { from, to };
      } else if (!reversed || length < reversed.from - reversed.to)
        reversed = { from, to };
    }
  const best = forward ?? reversed;
  if (!best) return null;
  const part = sliceTrack(
    run.track,
    Math.min(best.from, best.to),
    Math.max(best.from, best.to),
  );
  return {
    track: best.from <= best.to ? part : reverseTrack(part),
    run: { id: run.id, name: run.name, date: run.date },
  };
}

/** Whether two sections of one leg follow the same line: lengths within 10%, sampled points of each within {@link SAME_LINE_M} of the other. */
export function sameLine(a: RouteTrack, b: RouteTrack): boolean {
  const la = trackLength(a);
  const lb = trackLength(b);
  if (Math.abs(la - lb) > Math.max(la, lb) * SAME_LINE_LENGTH) return false;
  const near = (x: RouteTrack, y: RouteTrack) => {
    const lx = trackLength(x);
    for (let k = 0; k < SAME_LINE_SAMPLES; k++) {
      const { point } = pointAtDistance(
        x,
        (lx * (k + 0.5)) / SAME_LINE_SAMPLES,
      );
      if (nearestOnTrack(y, point).offset_m > SAME_LINE_M) return false;
    }
    return true;
  };
  return near(a, b) && near(b, a);
}

/** The lines past runs (newest first) take from `a` to `b`: most runs first, then shortest, at most {@link MAX_SECTIONS_PER_LEG}. */
export function legOptions(
  runs: RunStart[],
  a: LatLng,
  b: LatLng,
): LegOption[] {
  const groups: LegOption[] = [];
  for (const run of runs) {
    const section = legSection(run, a, b);
    if (!section) continue;
    // Against each group's first section only, so grouping stays linear in runs.
    const group = groups.find((g) => sameLine(g.track, section.track));
    if (group) group.runs.push(section.run);
    else groups.push({ track: section.track, runs: [section.run] });
  }
  return groups
    .sort(
      (x, y) =>
        y.runs.length - x.runs.length ||
        trackLength(x.track) - trackLength(y.track),
    )
    .slice(0, MAX_SECTIONS_PER_LEG);
}

/** The pieces for one choice of line per leg (null: no run covers it), with the fills between. */
function piecesFor(
  choice: (LegOption | null)[],
  anchors: LatLng[],
  shape: RouteShape,
): StitchPiece[] {
  const pieces: StitchPiece[] = [];
  let at = anchors[0]!;
  // Anchors of uncovered legs a fill must still pass, in order.
  let pending: LatLng[] = [];
  choice.forEach((option, leg) => {
    if (!option) {
      pending.push(anchors[leg + 1]!);
      return;
    }
    const first = option.track.coordinates[0]!;
    if (pending.length > 0 || haversineMeters(at, first) > JOIN_GAP_M)
      // The last pending anchor is where this section starts (within 100 m), so the fill goes to the section instead.
      pieces.push({
        kind: "fill",
        waypoints: [at, ...pending.slice(0, -1), first],
      });
    pending = [];
    pieces.push({ kind: "section", option });
    at = option.track.coordinates.at(-1)!;
  });
  const end = anchors.at(-1)!;
  if (pending.length > 0)
    pieces.push({ kind: "fill", waypoints: [at, ...pending] });
  // An out-and-back turns at its last via, which its last section already reaches.
  else if (shape !== "out-and-back" && haversineMeters(at, end) > JOIN_GAP_M)
    pieces.push({ kind: "fill", waypoints: [at, end] });
  return pieces;
}

/**
 * Up to {@link STITCHED_COMBINATIONS} ways along the athlete's lines: every
 * covered leg takes one of its options (so the fewest legs go to ORS), an
 * uncovered one is a gap. None when no leg is covered. A combination whose
 * later leg runs an earlier leg's line the other way is dropped (no retracing
 * a street out and back as a "loop"). Closest estimate to `target_m` first
 * (doubled for an out-and-back), then more km on sections.
 */
export function planStitches(
  options: LegOption[][],
  anchors: LatLng[],
  target_m: number,
  shape: RouteShape,
): StitchPlan[] {
  if (options.every((o) => o.length === 0)) return [];
  const laps = shape === "out-and-back" ? 2 : 1;
  // retraces.has("l1.i|l2.j"): leg l2's option j repeats leg l1's option i's line (sameLine ignores direction, so either way).
  const retraces = new Set<string>();
  for (let l1 = 0; l1 < options.length; l1++)
    for (let l2 = l1 + 1; l2 < options.length; l2++)
      for (const [i, o1] of options[l1]!.entries())
        for (const [j, o2] of options[l2]!.entries())
          if (sameLine(o1.track, o2.track))
            retraces.add(`${l1}.${i}|${l2}.${j}`);
  const combos: {
    choice: (LegOption | null)[];
    estimate_m: number;
    section_m: number;
  }[] = [];
  const walk = (
    leg: number,
    choice: (LegOption | null)[],
    picked: string[],
  ) => {
    if (leg === options.length) {
      let section_m = 0;
      let gap_m = 0;
      choice.forEach((option, i) => {
        if (option) section_m += trackLength(option.track);
        else
          gap_m +=
            haversineMeters(anchors[i]!, anchors[i + 1]!) * FILL_STREET_FACTOR;
      });
      combos.push({
        choice,
        estimate_m: laps * (section_m + gap_m),
        section_m,
      });
      return;
    }
    const lines = options[leg]!;
    if (lines.length === 0) {
      walk(leg + 1, [...choice, null], picked);
      return;
    }
    lines.forEach((option, i) => {
      if (picked.some((earlier) => retraces.has(`${earlier}|${leg}.${i}`)))
        return;
      walk(leg + 1, [...choice, option], [...picked, `${leg}.${i}`]);
    });
  };
  walk(0, [], []);
  return combos
    .sort(
      (x, y) =>
        Math.abs(x.estimate_m - target_m) - Math.abs(y.estimate_m - target_m) ||
        y.section_m - x.section_m,
    )
    .slice(0, STITCHED_COMBINATIONS)
    .map((c) => ({
      pieces: piecesFor(c.choice, anchors, shape),
      estimate_m: c.estimate_m,
    }));
}

const km = (meters: number) => (meters / 1000).toFixed(1);

/** The route from a plan and its routed fills, in order; null when a fill is missing (unroutable, ferry or out of calls). */
export function stitchedCandidate(
  plan: StitchPlan,
  fills: (RouteTrack | null)[],
  shape: RouteShape,
): RouteCandidate | null {
  const tracks: RouteTrack[] = [];
  // Climb is summed per piece: the seam between two devices' or ORS's altitudes is not climb.
  let climb_m = 0;
  const runs = new Map<string, RunRef>();
  let section_m = 0;
  let fill_m = 0;
  let next = 0;
  for (const piece of plan.pieces) {
    if (piece.kind === "fill") {
      const fill = fills[next++];
      if (!fill) return null;
      tracks.push(fill);
      climb_m += trackClimb(fill.altitude);
      fill_m += trackLength(fill);
    } else {
      tracks.push(piece.option.track);
      climb_m += trackClimb(piece.option.track.altitude);
      section_m += trackLength(piece.option.track);
      const run = piece.option.runs[0]!;
      runs.set(run.id, run);
    }
  }
  const way = concatTracks(tracks);
  const track = shape === "out-and-back" ? thereAndBack(way) : way;
  const laps = shape === "out-and-back" ? 2 : 1;
  const used = [...runs.values()];
  const routed =
    fill_m > 0 ? `; ${km(fill_m * laps)} km routed by OpenRouteService` : "";
  return {
    kind: "stitched",
    activity_id: null,
    name: "From your runs",
    date: null,
    shape,
    distance_m: Math.round(trackLength(track)),
    climb_m: climb_m * laps,
    path_share: null,
    history_share: section_m / trackLength(way),
    crossings_per_km: null,
    hill: null,
    summary: `From ${used.length} past run${used.length === 1 ? "" : "s"}: ${used.map((r) => `${r.name} ${r.date}`).join(", ")}${routed}`,
    track,
  };
}
