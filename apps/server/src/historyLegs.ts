/**
 * Stitched via routes: a via route built from sections of the athlete's own
 * past runs between consecutive anchors (start, via points, end), with
 * OpenRouteService filling only what no run covers. ORS joins via points by
 * the shortest foot path; the athlete's runs are the lines they chose.
 * Pure; the engine (routeSuggestions.ts) routes the fills.
 */
import { linesOverlap } from "./corridors";
import { haversineMeters, type LatLng, type RouteTrack } from "./mapAnchors";
import {
  dedupeRoutes,
  isLoop,
  nearVia,
  PAST_POOL,
  type RouteCandidate,
  type RouteSection,
  type RouteShape,
  sameRoute,
  thereAndBack,
  trackClimb,
  type Via,
  viaPoint,
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
  /** Distances along the run the section starts and ends at; from_m above to_m when run backwards. */
  from_m: number;
  to_m: number;
}

/** A line between two anchors: its newest run's section, and every run on it, newest first; or a saved corridor (no runs). */
export interface LegOption {
  track: RouteTrack;
  runs: RunRef[];
  /** The newest run's span (from_m above to_m when run backwards); 0 and 0 for a corridor. */
  from_m: number;
  to_m: number;
  corridor?: {
    route_id: string;
    name: string;
    version: number;
    reversed: boolean;
  };
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
  via: Via[],
  shape: RouteShape,
  end: LatLng | null,
): Via[] {
  if (shape === "loop") return [start, ...via, start];
  if (shape === "out-and-back") return [start, ...via];
  return [start, ...via, ...(end ? [end] : [])];
}

/** Where a track passes `anchor` ({@link nearVia}): per visit, the distance along it of the spot nearest its point. */
export function passes(track: RouteTrack, anchor: Via): number[] {
  const { coordinates, distance } = track;
  const point = viaPoint(anchor);
  const out: number[] = [];
  let i = 0;
  while (i < coordinates.length) {
    if (!nearVia(coordinates[i]!, anchor)) {
      i++;
      continue;
    }
    const first = i;
    while (i + 1 < coordinates.length && nearVia(coordinates[i + 1]!, anchor))
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
export function legSection(run: RunStart, a: Via, b: Via): Section | null {
  const limit =
    SECTION_DETOUR_FACTOR * haversineMeters(viaPoint(a), viaPoint(b)) +
    SECTION_DETOUR_SLACK_M;
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
    from_m: best.from,
    to_m: best.to,
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
export function legOptions(runs: RunStart[], a: Via, b: Via): LegOption[] {
  const groups: LegOption[] = [];
  for (const run of runs) {
    const section = legSection(run, a, b);
    if (!section) continue;
    // Against each group's first section only, so grouping stays linear in runs.
    const group = groups.find((g) => sameLine(g.track, section.track));
    if (group) group.runs.push(section.run);
    else
      groups.push({
        track: section.track,
        runs: [section.run],
        from_m: section.from_m,
        to_m: section.to_m,
      });
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
  anchors: Via[],
  shape: RouteShape,
): StitchPiece[] {
  const pieces: StitchPiece[] = [];
  let at = viaPoint(anchors[0]!);
  // Anchors of uncovered legs a fill must still pass, in order.
  let pending: LatLng[] = [];
  choice.forEach((option, leg) => {
    if (!option) {
      const [from, to] = [viaPoint(anchors[leg]!), viaPoint(anchors[leg + 1]!)];
      // Two anchors at one spot (a corridor ending where the next starts) leave nothing to fill.
      if (haversineMeters(from, to) > JOIN_GAP_M) pending.push(to);
      return;
    }
    const first = option.track.coordinates[0]!;
    if (pending.length > 0 || haversineMeters(at, first) > JOIN_GAP_M)
      // The section starts where it passes the last pending anchor, so the fill goes to the section instead.
      pieces.push({
        kind: "fill",
        waypoints: [at, ...pending.slice(0, -1), first],
      });
    pending = [];
    pieces.push({ kind: "section", option });
    at = option.track.coordinates.at(-1)!;
  });
  const end = viaPoint(anchors.at(-1)!);
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
  anchors: Via[],
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
            haversineMeters(viaPoint(anchors[i]!), viaPoint(anchors[i + 1]!)) *
            FILL_STREET_FACTOR;
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
  const sections: RouteSection[] = [];
  // Climb is summed per piece: the seam between two devices' or ORS's altitudes is not climb.
  let climb_m = 0;
  const runs = new Map<string, RunRef>();
  const corridors = new Set<string>();
  let section_m = 0;
  let fill_m = 0;
  let next = 0;
  for (const piece of plan.pieces) {
    if (piece.kind === "fill") {
      const fill = fills[next++];
      if (!fill) return null;
      tracks.push(fill);
      sections.push({ kind: "fill", track: fill });
      climb_m += trackClimb(fill.altitude);
      fill_m += trackLength(fill);
    } else {
      tracks.push(piece.option.track);
      climb_m += trackClimb(piece.option.track.altitude);
      section_m += trackLength(piece.option.track);
      const run = piece.option.runs[0];
      const { corridor, from_m, to_m } = piece.option;
      if (run) runs.set(run.id, run);
      if (corridor) {
        corridors.add(corridor.name);
        sections.push({
          kind: "corridor",
          track: piece.option.track,
          ...corridor,
        });
      } else if (run)
        sections.push({
          kind: "run",
          track: piece.option.track,
          run: { id: run.id, name: run.name },
          from_m,
          to_m,
        });
    }
  }
  const way = concatTracks(tracks);
  const track = shape === "out-and-back" ? thereAndBack(way) : way;
  const laps = shape === "out-and-back" ? 2 : 1;
  const used = [...runs.values()];
  const names = [...corridors];
  const from =
    used.length === 0
      ? "From your corridors"
      : `From ${used.length} past run${used.length === 1 ? "" : "s"}: ${used.map((r) => `${r.name} ${r.date}`).join(", ")}`;
  const corridorText =
    names.length > 0
      ? `; corridor${names.length === 1 ? "" : "s"}: ${names.join(", ")}`
      : "";
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
    summary: `${from}${corridorText}${routed}`,
    track,
    // shortcut: an out-and-back stays one section, split it if its map should list both ways
    ...(shape === "out-and-back" ? {} : { sections }),
  };
}

/**
 * Out-and-backs along past runs from a start, for a plan no past run fits
 * (#461): the first `target_m / 2` of each run long enough, then back the
 * same way; a loop also the other way round. Newest run first, duplicates
 * removed, at most {@link PAST_POOL}. No routing call.
 */
export function outAndBacksAlong(
  runs: RunStart[],
  target_m: number,
): RouteCandidate[] {
  const half = target_m / 2;
  const made: RouteCandidate[] = [];
  for (const run of runs) {
    if (trackLength(run.track) < half) continue;
    const ways = isLoop(run.track)
      ? [run.track, reverseTrack(run.track)]
      : [run.track];
    for (const way of ways) {
      const out = sliceTrack(way, 0, half);
      const track = thereAndBack(out);
      made.push({
        kind: "stitched",
        activity_id: null,
        name: "Out and back on a past run",
        date: null,
        shape: "out-and-back",
        distance_m: Math.round(trackLength(track)),
        climb_m: trackClimb(track.altitude),
        path_share: null,
        history_share: 1,
        crossings_per_km: null,
        hill: null,
        summary: `Out and back on your run "${run.name}" ${run.date}${way === run.track ? "" : " the other way"}, turning at ${km(half)} km`,
        track,
      });
    }
  }
  return dedupeRoutes(made).slice(0, PAST_POOL);
}

/** A loop's end and the next piece's start this close are joined directly (starts from one place wander by tens of metres). */
const LOOP_JOIN_M = 100;

/**
 * Plans no past run fits, from loops at the start (#461): two past loops
 * one after the other, together within `max_miss_m` of the target; then a
 * loop and an out-and-back along another run ({@link outAndBacksAlong}) for
 * the rest. Pieces that overlap ({@link linesOverlap}) or do not meet within
 * {@link LOOP_JOIN_M} are not joined. Newest loops first, at most
 * {@link PAST_POOL}. No routing call.
 */
export function loopsJoined(
  runs: RunStart[],
  target_m: number,
  max_miss_m: number,
): RouteCandidate[] {
  const loops: RunStart[] = [];
  for (const r of runs)
    if (isLoop(r.track) && !loops.some((l) => sameRoute(l.track, r.track)))
      loops.push(r);
  const meets = (a: RouteTrack, b: RouteTrack) =>
    haversineMeters(a.coordinates.at(-1)!, b.coordinates[0]!) <= LOOP_JOIN_M &&
    !linesOverlap(a, b);
  const made: RouteCandidate[] = [];
  const add = (
    a: RunStart,
    next: RouteTrack,
    climb_m: number,
    fields: Pick<RouteCandidate, "name" | "summary" | "sections">,
  ) => {
    const track = concatTracks([a.track, next]);
    made.push({
      kind: "stitched",
      activity_id: null,
      date: null,
      shape: "loop",
      distance_m: Math.round(trackLength(track)),
      climb_m: trackClimb(a.track.altitude) + climb_m,
      path_share: null,
      // Below 1 only by the seam between the pieces.
      history_share:
        (trackLength(a.track) + trackLength(next)) / trackLength(track),
      crossings_per_km: null,
      hill: null,
      track,
      ...fields,
    });
  };
  const runSection = (r: RunStart): RouteSection => ({
    kind: "run",
    track: r.track,
    run: { id: r.id, name: r.name },
    from_m: 0,
    to_m: trackLength(r.track),
  });
  for (const [i, a] of loops.entries())
    for (const b of loops.slice(i + 1)) {
      const sum = trackLength(a.track) + trackLength(b.track);
      if (Math.abs(sum - target_m) > max_miss_m || !meets(a.track, b.track))
        continue;
      add(a, b.track, trackClimb(b.track.altitude), {
        name: "Two past loops",
        summary: `Your loops "${a.name}" ${a.date}, then "${b.name}" ${b.date}`,
        sections: [runSection(a), runSection(b)],
      });
    }
  for (const a of loops) {
    if (made.length >= PAST_POOL) break;
    const rest = target_m - trackLength(a.track);
    if (rest <= 0) continue;
    const back = outAndBacksAlong(runs, rest).find((o) =>
      meets(a.track, o.track),
    );
    // shortcut: no sections, as for any out-and-back; add them if the map should list the pieces
    if (back)
      add(a, back.track, back.climb_m, {
        name: "Past loop and out-and-back",
        summary: `Your loop "${a.name}" ${a.date}, then o${back.summary.slice(1)}`,
      });
  }
  return dedupeRoutes(made).slice(0, PAST_POOL);
}
