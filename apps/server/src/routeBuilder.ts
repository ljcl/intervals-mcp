/**
 * Builds stored routes: stitch-route joins sections of past runs, stored
 * routes and routes OpenRouteService makes into one route, and amend-route
 * changes one part of a stored route into a new version. One home for the
 * rules (docs/tools.md, "Stored routes"); the tools format and the map
 * draws. Geometry math lives in `routeGeometry.ts`, the files in
 * `routeStore.ts`.
 *
 * A route is an ordered list of segments, each with its own track and
 * source. Two adjacent segments whose ends are within {@link JOIN_GAP_M}
 * are joined with a straight line; a wider gap is routed with
 * OpenRouteService as a `join` segment, and a gap it cannot route is an
 * error that names where the gap is. A change cuts the route at the km
 * where it starts and ends and routes only that part again, so the rest
 * keeps its segments (and its ids, so the store holds them once).
 *
 * Every OpenRouteService routing call is charged to one budget per tool
 * call ({@link ORS_CALL_BUDGET}); a call that would need more stores
 * nothing.
 */
import { CallCancelledError } from "./callScope";
import {
  corridorHint,
  corridorKey,
  MIN_CORRIDOR_M,
  matchCorridor,
} from "./corridors";
import { isAbortError } from "./fetchClient";
import { activityDisplayName } from "./formatters";
import { passes } from "./historyLegs";
import { getActivity } from "./intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "./intervalsStreams";
import {
  haversineMeters,
  type LatLng,
  parseLatLng,
  type RouteTrack,
} from "./mapAnchors";
import { OrsApiError, type OrsRoute, orsRoute, type Place } from "./orsClient";
import { routeOsmStats } from "./osmIndex";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import {
  climbPerKm,
  DEFAULT_TERRAIN_BANDS,
  eastNorth,
  type RouteSection,
  stretchWaypoints,
  thereAndBack,
  trackClimb,
  VIA_MATCH_M,
  type Via,
  viaPoint,
} from "./routeCandidates";
import {
  concatTracks,
  findSpurs,
  JOIN_GAP_M,
  moveToward,
  nearestOnTrack,
  parseHeading,
  pointAtDistance,
  reverseTrack,
  sliceTrack,
  thinTrack,
  trackDiff,
  trackLength,
} from "./routeGeometry";
import {
  appendVersion,
  createRoute,
  findVersion,
  latestVersion,
  listCorridors,
  makeRouteId,
  RouteNotFoundError,
  readRoute,
  type SegmentSource,
  type SegmentVia,
  type StoredRoute,
  type StoredSegment,
  type StoredVersion,
  versionSegments,
} from "./routeStore";
import {
  type Budget,
  coarseVia,
  fitToTarget,
  GENERATED_DISTANCE_TOLERANCE,
  ORS_CALL_BUDGET,
  orsProblem,
  RouteSuggestionError,
  resolvePlace,
  viaTarget,
} from "./routeSuggestions";

/** Sections one stitch-route call may join. */
export const MAX_STITCH_SEGMENTS = 10;
/** Operations one amend-route call may apply. */
export const MAX_AMEND_OPERATIONS = 10;
/** insert_via routes again at most this far either side of the new point, so a point on a long past run does not replace all of it. */
export const VIA_REROUTE_HALF_M = 1000;
/** A km past a track's end by up to this share still reads as its end (a plan's 12.03 against a 12.02 recording). */
const KM_OVERSHOOT = 0.01;
/** Seeds fit_distance tries when it stretches a section. */
const FIT_SEEDS = [0, 1];
/** Two km positions closer than this are the same place. */
const SAME_M = 0.5;

/** What the builder reads from config, passed in so tests need no env. */
export interface BuildEnv {
  orsKey: string | null;
  homeStart: LatLng | null;
}

/** A request the builder cannot carry out, worded for the athlete. */
export class RouteBuildError extends Error {
  constructor(
    message: string,
    /** budget: the routing budget ran out; nothing was stored. */
    readonly kind: "input" | "unroutable" | "budget" | "ors" = "input",
  ) {
    super(message);
    this.name = "RouteBuildError";
  }
}

export type SegmentInput =
  | { type: "activity"; id: string; from_km?: number; to_km?: number }
  | {
      type: "route";
      route_id: string;
      version?: number;
      from_km?: number;
      to_km?: number;
    }
  | {
      type: "generated";
      start?: string;
      end?: string;
      via?: string[];
      flexible?: boolean;
    }
  | {
      type: "corridor";
      name: string;
      reversed?: boolean;
      from_km?: number;
      to_km?: number;
      version?: number;
      route_id?: string;
    }
  | {
      type: "out_and_back";
      at?: string;
      toward: string;
      distance_km: number;
      flexible?: boolean;
    };

export type AmendOperation =
  | { op: "insert_via"; km: number; place: string; label?: string }
  | { op: "remove_via"; via_id: string }
  | {
      op: "move_via";
      via_id: string;
      to?: string;
      shift?: { direction: string; distance_m: number };
    }
  | {
      op: "replace_section";
      from_km: number;
      to_km: number;
      through?: string;
      activity?: { id: string; from_km?: number; to_km?: number };
      corridor?: { name: string; reversed?: boolean };
    }
  | { op: "add_out_and_back"; km: number; toward: string; distance_km: number }
  | { op: "trim"; from_km: number; to_km: number }
  | { op: "fit_distance"; target_km: number; from_km?: number; to_km?: number }
  | { op: "reverse" }
  | { op: "undo" }
  | { op: "restore"; version: number };

const km = (meters: number) => (meters / 1000).toFixed(2);

/** About 100 m: enough to find a gap on a map, not a front door. */
const near = ([lat, lng]: LatLng) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

interface Ctx {
  apiKey: string;
  env: BuildEnv;
  budget: Budget;
  progress: ReportProgress;
  nextId: number;
  /** Activity tracks read in this call, by id. */
  activities: Map<string, Promise<LoadedActivity>>;
  /** Where a place name is looked up near. */
  focus: LatLng | null;
  snap: Snap;
}

/**
 * How a via meets the route: nearest, where OpenRouteService puts it; or
 * through, moved off a dead end to where the route passes it.
 */
export type Snap = "nearest" | "through";

export interface LoadedActivity {
  name: string;
  track: RouteTrack;
}

function newCtx(
  apiKey: string,
  env: BuildEnv,
  progress: ReportProgress,
  nextId: number,
  focus: LatLng | null,
  snap: Snap = "nearest",
): Ctx {
  return {
    apiKey,
    env,
    budget: { calls: ORS_CALL_BUDGET, failure: null },
    progress,
    nextId,
    activities: new Map(),
    focus: focus ?? env.homeStart,
    snap,
  };
}

const segmentId = (ctx: Ctx) => `g${ctx.nextId++}`;
const viaId = (ctx: Ctx) => `v${ctx.nextId++}`;

// ---------- layout ----------

export interface Span {
  start_m: number;
  end_m: number;
}

/** A version's segments as one track, with where each segment starts and ends on it. */
export function layoutSegments(segments: StoredSegment[]): {
  track: RouteTrack;
  spans: Span[];
} {
  const spans: Span[] = [];
  let end = 0;
  let last: LatLng | null = null;
  for (const segment of segments) {
    const first = segment.track.coordinates[0];
    const seam = last && first ? haversineMeters(last, first) : 0;
    const start = end + seam;
    end = start + trackLength(segment.track);
    spans.push({ start_m: start, end_m: end });
    last = segment.track.coordinates.at(-1) ?? last;
  }
  return { track: concatTracks(segments.map((s) => s.track)), spans };
}

// ---------- places ----------

async function place(ctx: Ctx, text: string): Promise<Place> {
  try {
    // The athlete's words name the place; what the lookup matched is in `match`.
    const found = await resolvePlace(text, ctx.env, ctx.focus);
    return { ...found, label: text.trim() };
  } catch (error) {
    if (error instanceof RouteSuggestionError)
      throw new RouteBuildError(error.message);
    throw error;
  }
}

/** A via point: refused when the lookup placed it no better than a suburb (`coarseVia`). */
async function viaPlace(ctx: Ctx, text: string): Promise<Place> {
  // `place` swaps the label for the asked text; the match keeps what was found.
  const found = await place(ctx, text);
  const problem = coarseVia(found, text);
  if (problem) throw new RouteBuildError(problem);
  return found;
}

/** A "toward" text: a compass direction or degrees, else a place. */
async function toward(
  ctx: Ctx,
  text: string,
): Promise<
  { heading: number; label: string } | { point: LatLng; label: string }
> {
  const heading = parseHeading(text);
  if (heading !== null && !parseLatLng(text))
    return { heading, label: text.trim() };
  return place(ctx, text);
}

// ---------- OpenRouteService ----------

/** One routing call charged to the budget; `what` names the section for the athlete. */
async function ors(
  ctx: Ctx,
  waypoints: LatLng[],
  what: string,
): Promise<OrsRoute> {
  if (!ctx.env.orsKey)
    throw new RouteBuildError(
      `Routing ${what} needs OpenRouteService, and ORS_API_KEY is not set on this server.`,
    );
  if (ctx.budget.calls <= 0)
    throw new RouteBuildError(
      `Routing ${what} needs more than this call's ${ORS_CALL_BUDGET} routing calls.`,
      "budget",
    );
  ctx.budget.calls -= 1;
  ctx.progress(`Routing ${what}`);
  let route: OrsRoute;
  try {
    route = await orsRoute(ctx.env.orsKey, { waypoints });
  } catch (error) {
    if (error instanceof CallCancelledError || isAbortError(error)) throw error;
    if (error instanceof OrsApiError && error.response.status === 404)
      throw new RouteBuildError(
        `OpenRouteService found no walkable path for ${what}.`,
        "unroutable",
      );
    throw new RouteBuildError(
      `Could not route ${what}: ${orsProblem(error)}.`,
      "ors",
    );
  }
  if (route.ferry_m > 0)
    throw new RouteBuildError(
      `OpenRouteService could only route ${what} by ferry.`,
      "unroutable",
    );
  return route;
}

// ---------- segments ----------

function climbOf(
  track: RouteTrack,
  source: "recorded" | "elevation_model",
): Pick<StoredSegment, "climb_m" | "climb_source"> & { note: string | null } {
  if (!track.altitude.some((a) => a !== null))
    return {
      climb_m: null,
      climb_source: "none",
      note: "No altitude for this section, so its climb is unknown.",
    };
  return {
    climb_m: trackClimb(track.altitude),
    climb_source: source,
    note: null,
  };
}

async function loadActivity(ctx: Ctx, id: string): Promise<LoadedActivity> {
  let loaded = ctx.activities.get(id);
  if (!loaded) {
    loaded = readActivityTrack(ctx.apiKey, id);
    ctx.activities.set(id, loaded);
  }
  return loaded;
}

/** A past run's GPS track, distances from its start, with its display name (export-route reads it too). */
export async function readActivityTrack(
  apiKey: string,
  id: string,
): Promise<LoadedActivity> {
  const activity = await getActivity(apiKey, id);
  let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
  try {
    streams = await loadIntervalsStreams(apiKey, id, [
      "latlng",
      "distance",
      "altitude",
    ]);
  } catch (error) {
    if (error instanceof IntervalsStreamsUnavailableError)
      throw new RouteBuildError(
        `Activity ${id} has no recorded streams, so it has no track to use.`,
      );
    throw error;
  }
  const coordinates: LatLng[] = [];
  const distance: number[] = [];
  const altitude: (number | null)[] = [];
  for (let i = 0; i < streams.length; i++) {
    const point = streams.latlng?.[i];
    if (!point) continue;
    const last = coordinates.at(-1);
    const recorded = streams.distance?.[i];
    const walked = last
      ? distance.at(-1)! + haversineMeters(last, point)
      : (recorded ?? 0);
    // The recorded distance, never running backwards; measured where it is missing.
    const d =
      recorded == null ? walked : Math.max(recorded, distance.at(-1) ?? 0);
    coordinates.push(point);
    distance.push(d);
    altitude.push(streams.altitude?.[i] ?? null);
  }
  if (coordinates.length < 2)
    throw new RouteBuildError(`Activity ${id} has no GPS track.`);
  // Distances from the activity's start, as its km are counted.
  const origin = distance[0]!;
  return {
    name: activityDisplayName(activity),
    track: {
      coordinates,
      distance: distance.map((d) => d - origin),
      altitude,
    },
  };
}

/** A section of a past run, between two of its own km (from above to runs it the other way). */
async function activitySegment(
  ctx: Ctx,
  id: string,
  from_km: number | undefined,
  to_km: number | undefined,
): Promise<StoredSegment> {
  const { name, track } = await loadActivity(ctx, id);
  const length = trackLength(track);
  const limit = length * (1 + KM_OVERSHOOT) + 10;
  const from = Math.min((from_km ?? 0) * 1000, length);
  const to = Math.min(to_km === undefined ? length : to_km * 1000, length);
  for (const value of [from_km, to_km]) {
    if (value !== undefined && value * 1000 > limit)
      throw new RouteBuildError(
        `Activity ${id} is ${km(length)} km long, so km ${value} is past its end.`,
      );
  }
  if (Math.abs(to - from) < 1)
    throw new RouteBuildError(
      `Activity ${id} from km ${km(from)} to km ${km(to)} is empty.`,
    );
  const reversed = from > to;
  let part = sliceTrack(track, Math.min(from, to), Math.max(from, to));
  if (reversed) part = reverseTrack(part);
  // Climb from every sample, before the stored track is thinned.
  const { note, ...climb } = climbOf(part, "recorded");
  part = thinTrack(part);
  return {
    id: segmentId(ctx),
    kind: "activity",
    label: `${name} km ${km(from)}-${km(to)}`,
    source: {
      type: "activity",
      activity_id: id,
      from_km: Math.round(from) / 1000,
      to_km: Math.round(to) / 1000,
    },
    track: part,
    ...climb,
    path_share: null,
    vias: [],
    flexible: false,
    notes: note ? [note] : [],
  };
}

type ViaInput = Pick<SegmentVia, "point" | "label" | "match" | "requested"> & {
  id?: string;
  /** snap through left it where it was; it is not looked at again. */
  held?: boolean;
};

/** Vias placed along a track in order, each at its nearest point after the one before. */
function placeVias(
  ctx: Ctx,
  track: RouteTrack,
  vias: ViaInput[],
): SegmentVia[] {
  let from = 0;
  return vias.map((via) => {
    const at = nearestOnTrack(track, via.point, from);
    from = at.distance_m;
    return {
      id: via.id ?? viaId(ctx),
      offset_m: at.distance_m,
      point: via.point,
      label: via.label,
      kind: "via" as const,
      ...(via.match ? { match: via.match } : {}),
      ...(via.requested ? { requested: via.requested } : {}),
    };
  });
}

/** A section OpenRouteService routes from `start` through `vias` to `end`. */
async function generatedSegment(
  ctx: Ctx,
  start: LatLng,
  end: LatLng,
  vias: ViaInput[],
  options: { flexible?: boolean; kind?: "generated" | "join" } = {},
): Promise<StoredSegment> {
  const kind = options.kind ?? "generated";
  const what =
    kind === "join"
      ? `the gap near ${near(start)}`
      : vias.length > 0
        ? `a section through ${vias.map((v) => v.label).join(", ")}`
        : `a section from ${near(start)} to ${near(end)}`;
  let placed = vias;
  let route = await ors(ctx, [start, ...placed.map((v) => v.point), end], what);
  const notes: string[] = [];
  if (ctx.snap === "through") {
    // A move can land on another dead end, so the new track is checked again.
    for (let pass = 0; pass < SNAP_THROUGH_PASSES; pass++) {
      const step = throughVias(route.track, placed);
      notes.push(...step.notes);
      placed = step.vias;
      if (!step.moved) break;
      if (ctx.budget.calls <= 0) {
        notes.push(
          "snap through stopped with no routing calls left, so a via it moved was not routed through.",
        );
        break;
      }
      route = await ors(ctx, [start, ...placed.map((v) => v.point), end], what);
    }
    for (const via of placed)
      if (via.requested)
        notes.push(
          `Via ${via.label} was on a way the route went along and back, so it was moved ${Math.round(haversineMeters(via.requested, via.point))} m to where the route passes it (snap through).`,
        );
  }
  const track = thinTrack(route.track);
  const { note, ...climb } = climbOf(track, "elevation_model");
  if (note) notes.push(note);
  const label =
    kind === "join"
      ? "Join"
      : route.way_names.length > 0
        ? `New section via ${route.way_names.slice(0, 2).join(", ")}`
        : "New section";
  return {
    id: segmentId(ctx),
    kind,
    label,
    source: { type: "ors", purpose: kind === "join" ? "join" : "route" },
    track,
    ...climb,
    path_share: route.path_share,
    vias: placeVias(ctx, track, placed),
    flexible: options.flexible ?? false,
    notes,
  };
}

/** snap through moves a via at most this far from where it was asked for. */
const SNAP_THROUGH_MAX_M = 50;
/** Times snap through reroutes one section. */
const SNAP_THROUGH_PASSES = 2;
/** Two vias this close are at one point. */
const SAME_VIA_M = 10;

/**
 * One snap-through pass: each via the route reaches by going along a way
 * and back moved to where the route turns onto that way, if that is within
 * {@link SNAP_THROUGH_MAX_M} of where it was asked for, else held with a
 * note. A via moved onto the one before it is merged into it.
 */
function throughVias(
  track: RouteTrack,
  vias: ViaInput[],
): { vias: ViaInput[]; notes: string[]; moved: boolean } {
  const spurs = findSpurs(track);
  const notes: string[] = [];
  let from = 0;
  const next = vias.map((via): ViaInput => {
    const at = nearestOnTrack(track, via.point, from).distance_m;
    from = at;
    const spur = via.held
      ? undefined
      : spurs.find((s) => at > s.from_m && at < s.to_m);
    if (!spur) return via;
    const asked = via.requested ?? via.point;
    const point = pointAtDistance(track, spur.from_m).point;
    const far = Math.round(haversineMeters(asked, point));
    if (far > SNAP_THROUGH_MAX_M) {
      notes.push(
        `Via ${via.label} is on a way the route goes along and back; the nearest point it passes through is ${far} m away, more than the ${SNAP_THROUGH_MAX_M} m snap through moves a via, so it was kept. Move it with move_via.`,
      );
      return { ...via, held: true };
    }
    return { ...via, point, requested: asked };
  });
  const moved = new Set(next.filter((via, i) => via.point !== vias[i]!.point));
  const merged: ViaInput[] = [];
  for (const via of next) {
    const before = merged.at(-1);
    if (
      before &&
      (moved.has(via) || moved.has(before)) &&
      haversineMeters(before.point, via.point) <= SAME_VIA_M
    ) {
      notes.push(
        `Via ${via.label} was merged into via ${before.label}: snap through put both at one point.`,
      );
      continue;
    }
    merged.push(via);
  }
  return { vias: merged, notes, moved: moved.size > 0 };
}

/**
 * An out-and-back from `at`: routed toward a place or a compass heading
 * and turned at half of `distance_m`, then back the same way; with
 * `distance_m` null it turns at the place itself.
 */
async function outAndBackSegment(
  ctx: Ctx,
  at: LatLng,
  target: { heading: number; label: string } | { point: LatLng; label: string },
  distance_m: number | null,
  options: { flexible?: boolean; via?: { id: string; label: string } } = {},
): Promise<StoredSegment> {
  const half = distance_m === null ? null : distance_m / 2;
  const point =
    "point" in target ? target.point : moveToward(at, target.heading, half!);
  const route = await ors(
    ctx,
    [at, point],
    `an out-and-back toward ${target.label}`,
  );
  const length = trackLength(route.track);
  const turn = half === null ? length : Math.min(half, length);
  const out = sliceTrack(route.track, 0, turn);
  const track = thinTrack(thereAndBack(out));
  const notes: string[] = [];
  if (half !== null && length < half * (1 - GENERATED_DISTANCE_TOLERANCE)) {
    notes.push(
      `The way toward ${target.label} is ${km(length)} km, so this out-and-back is ${km(2 * length)} km, not ${km(distance_m!)} km.`,
    );
  }
  const { note, ...climb } = climbOf(track, "elevation_model");
  if (note) notes.push(note);
  const perKm =
    climb.climb_m === null ? 0 : climbPerKm(climb.climb_m, trackLength(track));
  if (perKm > DEFAULT_TERRAIN_BANDS.flatBelow)
    notes.push(
      `It climbs ${climb.climb_m} m in ${km(trackLength(track))} km (${Math.round(perKm)} m per km), so it is not flat; another direction may be flatter.`,
    );
  const turnaround = out.coordinates.at(-1)!;
  return {
    id: segmentId(ctx),
    kind: "out_and_back",
    label: `Out-and-back toward ${target.label}`,
    source: { type: "ors", purpose: "out_and_back" },
    track,
    ...climb,
    path_share: route.path_share,
    vias: [
      {
        id: options.via?.id ?? viaId(ctx),
        offset_m: trackLength(out),
        point: turnaround,
        label: options.via?.label ?? `Turnaround toward ${target.label}`,
        kind: "turnaround",
      },
    ],
    flexible: options.flexible ?? false,
    notes,
  };
}

/** The activity km at `offset` metres into a segment cut from it. */
function activityKmAt(
  source: Extract<SegmentSource, { type: "activity" }>,
  length: number,
  offset: number,
): number {
  const t = length > 0 ? offset / length : 0;
  return (
    Math.round((source.from_km + (source.to_km - source.from_km) * t) * 1000) /
    1000
  );
}

/** The part of a segment from `from` to `to` metres into it, as a new segment with its source kept. */
function clipSegment(
  ctx: Ctx,
  segment: StoredSegment,
  from: number,
  to: number,
): StoredSegment {
  const length = trackLength(segment.track);
  const track = sliceTrack(segment.track, from, to);
  let source = segment.source;
  let label = segment.label;
  if (source.type === "activity") {
    source = {
      ...source,
      from_km: activityKmAt(source, length, from),
      to_km: activityKmAt(source, length, to),
    };
    label = label.replace(
      / km [\d.]+-[\d.]+$/,
      ` km ${source.from_km.toFixed(2)}-${source.to_km.toFixed(2)}`,
    );
  } else if (source.type === "route") {
    source = {
      ...source,
      from_km: source.from_km + from / 1000,
      to_km: source.from_km + to / 1000,
    };
  }
  const climb =
    segment.climb_source === "none"
      ? { climb_m: null, climb_source: "none" as const }
      : {
          climb_m: trackClimb(track.altitude),
          climb_source: segment.climb_source,
        };
  return {
    ...segment,
    id: segmentId(ctx),
    label,
    source,
    track,
    ...climb,
    // A via on the cut stays on both sides; duplicates are dropped when the route is put together.
    vias: segment.vias
      .filter((v) => v.offset_m >= from - SAME_M && v.offset_m <= to + SAME_M)
      .map((v) => ({ ...v, offset_m: Math.max(0, v.offset_m - from) })),
  };
}

function reverseSegment(ctx: Ctx, segment: StoredSegment): StoredSegment {
  const length = trackLength(segment.track);
  const track = reverseTrack(segment.track);
  const source: SegmentSource =
    segment.source.type === "ors"
      ? segment.source
      : {
          ...segment.source,
          from_km: segment.source.to_km,
          to_km: segment.source.from_km,
        };
  const label =
    source.type === "activity"
      ? segment.label.replace(
          / km [\d.]+-[\d.]+$/,
          ` km ${source.from_km.toFixed(2)}-${source.to_km.toFixed(2)}`,
        )
      : segment.label;
  return {
    ...segment,
    id: segmentId(ctx),
    label,
    source,
    track,
    climb_m:
      segment.climb_source === "none" ? null : trackClimb(track.altitude),
    vias: segment.vias
      .map((v) => ({ ...v, offset_m: length - v.offset_m }))
      .reverse(),
  };
}

/** Copies of a stored route's segments between two of its km, each keeping its own source. */
async function routeSegments(
  ctx: Ctx,
  routeId: string,
  versionNumber: number | undefined,
  from_km: number | undefined,
  to_km: number | undefined,
): Promise<StoredSegment[]> {
  const route = await readRoute(routeId);
  if (!route)
    throw new RouteBuildError(new RouteNotFoundError(routeId).message);
  const version =
    versionNumber === undefined
      ? latestVersion(route)
      : findVersion(route, versionNumber);
  if (!version)
    throw new RouteBuildError(
      `Route ${routeId} has no version ${versionNumber}; its latest is ${latestVersion(route).version}.`,
    );
  const segments = versionSegments(route, version);
  const { spans, track } = layoutSegments(segments);
  const length = trackLength(track);
  const limit = length * (1 + KM_OVERSHOOT) + 10;
  for (const value of [from_km, to_km]) {
    if (value !== undefined && value * 1000 > limit)
      throw new RouteBuildError(
        `Route ${routeId} version ${version.version} is ${km(length)} km long, so km ${value} is past its end.`,
      );
  }
  const from = Math.min((from_km ?? 0) * 1000, length);
  const to = Math.min(to_km === undefined ? length : to_km * 1000, length);
  if (Math.abs(to - from) < 1)
    throw new RouteBuildError(
      `Route ${routeId} from km ${km(from)} to km ${km(to)} is empty.`,
    );
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const parts: StoredSegment[] = [];
  segments.forEach((segment, i) => {
    const span = spans[i]!;
    if (span.end_m <= lo + SAME_M || span.start_m >= hi - SAME_M) return;
    const part = clipSegment(
      ctx,
      segment,
      Math.max(0, lo - span.start_m),
      Math.min(span.end_m, hi) - span.start_m,
    );
    // Via ids are this route's own.
    part.vias = part.vias.map((v) => ({ ...v, id: viaId(ctx) }));
    parts.push(part);
  });
  return from <= to
    ? parts
    : parts.reverse().map((part) => reverseSegment(ctx, part));
}

/** A saved corridor, by name, for stitch-route and amend-route. */
export interface CorridorPiece {
  name: string;
  reversed?: boolean;
  from_km?: number;
  to_km?: number;
}

/** The saved corridor a name means, else a refusal that suggests a near name. */
async function findCorridor(name: string) {
  const corridors = await listCorridors();
  const route = matchCorridor(name, corridors);
  if (route) return route;
  const hint = corridorHint(name, corridors);
  throw new RouteBuildError(
    `No saved corridor is named "${name}"${hint ? `; did you mean "${hint.name}"?` : ""}. list-corridors lists them.`,
  );
}

/**
 * A saved corridor's sections (its own km from-to), labelled with its name:
 * reversed when asked, or when `near` is nearer its far end; a one-way
 * corridor runs stored only.
 */
async function corridorSegments(
  ctx: Ctx,
  piece: CorridorPiece,
  near: LatLng | null,
  versionNumber?: number,
): Promise<StoredSegment[]> {
  const route = await findCorridor(piece.name);
  if (piece.reversed && route.one_way)
    throw new RouteBuildError(
      `Corridor "${route.name}" is one-way, so it cannot be run reversed.`,
    );
  const version = versionNumber ?? latestVersion(route).version;
  const track = versionTrack(
    route,
    findVersion(route, version) ?? latestVersion(route),
  );
  const length_km = trackLength(track) / 1000;
  // The km are a range, not a direction: only reversed or near sets that.
  const a0 = piece.from_km ?? 0;
  const b0 = piece.to_km ?? length_km;
  const lo = Math.min(a0, b0);
  const hi = Math.max(a0, b0);
  let reversed = piece.reversed ?? false;
  if (piece.reversed === undefined && near && !route.one_way) {
    const a = pointAtDistance(track, lo * 1000).point;
    const b = pointAtDistance(track, hi * 1000).point;
    reversed = haversineMeters(near, b) < haversineMeters(near, a);
  }
  const parts = await routeSegments(
    ctx,
    route.route_id,
    version,
    reversed ? hi : lo,
    reversed ? lo : hi,
  );
  return parts.map((part) => ({ ...part, label: route.name }));
}

// ---------- corridors ----------

export type CorridorSource =
  | {
      type: "activity";
      id: string;
      from_km?: number;
      to_km?: number;
      from?: string;
      to?: string;
    }
  | {
      type: "route";
      route_id: string;
      version?: number;
      from_km?: number;
      to_km?: number;
    };

/**
 * Saves a corridor: a stored route of kind corridor with the source's
 * sections. Its id comes from the source and range, so the same add
 * returns the saved corridor (created false); refused with nothing stored
 * when the name is taken or the stretch is under MIN_CORRIDOR_M.
 */
export async function addCorridor(
  apiKey: string,
  input: { name: string; one_way?: boolean; source: CorridorSource },
  env: BuildEnv,
  progress: ReportProgress = NO_PROGRESS,
): Promise<{ route: StoredRoute; created: boolean }> {
  const name = input.name.trim();
  const key = corridorKey(name);
  if (!key)
    throw new RouteBuildError("A corridor name needs at least one word.");
  const ctx = newCtx(apiKey, env, progress, 1, null, undefined);
  let source = input.source;
  if (
    source.type === "activity" &&
    (source.from !== undefined || source.to !== undefined)
  ) {
    if (source.from_km !== undefined || source.to_km !== undefined)
      throw new RouteBuildError(
        "Give the run's km range or two places it passes, not both.",
      );
    if (source.from === undefined || source.to === undefined)
      throw new RouteBuildError(
        "Give both from and to, the places the corridor starts and ends at.",
      );
    const { track } = await loadActivity(ctx, source.id);
    ctx.focus = track.coordinates[0] ?? null;
    const { id, from: fromText, to: toText } = source;
    const at = async (text: string) => viaTarget(await viaPlace(ctx, text));
    const [from, to] = [await at(fromText), await at(toText)];
    const miss = (text: string, via: Via) => {
      const { distance_m, offset_m } = nearestOnTrack(track, viaPoint(via));
      return `Activity ${id} does not pass "${text}" (within ${VIA_MATCH_M} m): it comes closest at km ${km(distance_m)}, ${Math.round(offset_m)} m away.`;
    };
    const into = passes(track, from)[0];
    if (into === undefined) throw new RouteBuildError(miss(fromText, from));
    const toPasses = passes(track, to);
    const out = toPasses.find((d) => d > into);
    if (out === undefined) {
      const before = toPasses[0];
      throw new RouteBuildError(
        before === undefined
          ? miss(toText, to)
          : `Activity ${id} passes "${toText}" at km ${km(before)}, before "${fromText}" at km ${km(into)}: it ran them the other way, so swap from and to.`,
      );
    }
    source = {
      type: "activity",
      id: source.id,
      from_km: Math.round(into) / 1000,
      to_km: Math.round(out) / 1000,
    };
  }
  if (source.type === "route" && source.version === undefined) {
    const stored = await readRoute(source.route_id);
    if (!stored)
      throw new RouteBuildError(
        new RouteNotFoundError(source.route_id).message,
      );
    source = { ...source, version: latestVersion(stored).version };
  }
  const routeId = makeRouteId("corridor", JSON.stringify(source));
  const existing = await readRoute(routeId);
  if (existing) {
    if (corridorKey(existing.name) === key)
      return { route: existing, created: false };
    throw new RouteBuildError(
      `This stretch is already saved as corridor "${existing.name}" (${routeId}).`,
    );
  }
  const taken = (await listCorridors()).find(
    (c) => corridorKey(c.name) === key,
  );
  if (taken)
    throw new RouteBuildError(
      `A corridor named "${taken.name}" is already saved (${taken.route_id}); rename or delete it first.`,
    );
  const segments =
    source.type === "activity"
      ? [await activitySegment(ctx, source.id, source.from_km, source.to_km)]
      : await routeSegments(
          ctx,
          source.route_id,
          source.version,
          source.from_km,
          source.to_km,
        );
  const length = trackLength(layoutSegments(segments).track);
  if (length < MIN_CORRIDOR_M)
    throw new RouteBuildError(
      `That stretch is ${Math.round(length)} m; a corridor is at least ${MIN_CORRIDOR_M} m.`,
    );
  return createRoute({
    route_id: routeId,
    name,
    kind: "corridor",
    one_way: input.one_way ?? false,
    next_id: ctx.nextId,
    segments,
    change: `Saved as corridor from ${source.type === "activity" ? `activity ${source.id}` : `route ${source.route_id}`} km ${km((source.from_km ?? 0) * 1000)}-${source.to_km === undefined ? "end" : km(source.to_km * 1000)}`,
    warnings: [],
  });
}

// ---------- joining ----------

/** Route ends further apart than {@link JOIN_GAP_M} get a routed `join` segment between them. */
async function joinGaps(
  ctx: Ctx,
  segments: StoredSegment[],
): Promise<StoredSegment[]> {
  const out: StoredSegment[] = [];
  for (const segment of segments) {
    const before = out.at(-1);
    if (before) {
      const end = before.track.coordinates.at(-1)!;
      const start = segment.track.coordinates[0]!;
      const gap = haversineMeters(end, start);
      if (gap > JOIN_GAP_M) {
        const at = layoutSegments(out).track;
        try {
          out.push(
            await generatedSegment(ctx, end, start, [], { kind: "join" }),
          );
        } catch (error) {
          if (error instanceof RouteBuildError && error.kind !== "budget") {
            throw new RouteBuildError(
              `The ${Math.round(gap)} m gap between "${before.label}" and "${segment.label}" at km ${km(trackLength(at))} (from ${near(end)} to ${near(start)}) could not be routed: ${error.message}`,
              error.kind,
            );
          }
          throw error;
        }
      }
    }
    out.push(segment);
  }
  return out;
}

/** Vias on a cut appear on both sides; the first stays. */
function dedupeVias(segments: StoredSegment[]): StoredSegment[] {
  const seen = new Set<string>();
  return segments.map((segment) => {
    const vias = segment.vias.filter((v) => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
    return vias.length === segment.vias.length ? segment : { ...segment, vias };
  });
}

// ---------- stitch-route ----------

export interface StitchInput {
  name?: string;
  segments: SegmentInput[];
  snap?: Snap;
}

export interface BuildResult {
  route: StoredRoute;
  version: StoredVersion;
  /** False when the same stitch was already stored, so nothing was routed. */
  created: boolean;
  ors_calls: number;
}

function endsOf(segment: StoredSegment): { start: LatLng; end: LatLng } {
  return {
    start: segment.track.coordinates[0]!,
    end: segment.track.coordinates.at(-1)!,
  };
}

/**
 * Joins the sections in order into one stored route (see the module
 * comment). Past runs and stored routes are read first, so a generated
 * section or out-and-back can start where the section before it ends and
 * end where the next one starts.
 */
export async function stitchRoute(
  apiKey: string,
  input: StitchInput,
  env: BuildEnv,
  progress: ReportProgress = NO_PROGRESS,
): Promise<BuildResult> {
  if (input.segments.length === 0)
    throw new RouteBuildError("Pass at least one segment.");
  // Stored routes named without a version are pinned to their latest first, so the same request makes the same route only while its sources stand still.
  const pinned: SegmentInput[] = [];
  for (const segment of input.segments) {
    if (segment.type === "route" && segment.version === undefined) {
      const source = await readRoute(segment.route_id);
      if (!source)
        throw new RouteBuildError(
          new RouteNotFoundError(segment.route_id).message,
        );
      pinned.push({ ...segment, version: latestVersion(source).version });
    } else if (segment.type === "corridor") {
      const source = await findCorridor(segment.name);
      // route_id too: a corridor deleted and saved again under the name restarts at version 1.
      pinned.push({
        ...segment,
        route_id: source.route_id,
        version: segment.version ?? latestVersion(source).version,
      });
    } else pinned.push(segment);
  }
  const name = input.name?.trim() || "Stitched route";
  // snap joins the key only when set, so ids made before it stay the same.
  const routeId = makeRouteId(
    "draft",
    JSON.stringify({
      name,
      segments: pinned,
      ...(input.snap === "through" ? { snap: input.snap } : {}),
    }),
  );
  const existing = await readRoute(routeId);
  if (existing)
    return {
      route: existing,
      version: latestVersion(existing),
      created: false,
      ors_calls: 0,
    };

  const ctx = newCtx(apiKey, env, progress, 1, null, input.snap);
  const built: Array<StoredSegment[] | null> = pinned.map(() => null);
  const isBuilt = (s: StoredSegment | null | undefined): s is StoredSegment =>
    Boolean(s);
  const endOfPrevious = (i: number): LatLng | null => {
    const before = built.slice(0, i).flat().filter(isBuilt).at(-1);
    return before ? endsOf(before).end : null;
  };
  for (const [i, segment] of pinned.entries()) {
    if (segment.type === "activity") {
      progress(`Reading activity ${segment.id}`);
      built[i] = [
        await activitySegment(ctx, segment.id, segment.from_km, segment.to_km),
      ];
    } else if (segment.type === "route") {
      built[i] = await routeSegments(
        ctx,
        segment.route_id,
        segment.version,
        segment.from_km,
        segment.to_km,
      );
    } else if (segment.type === "corridor") {
      built[i] = await corridorSegments(
        ctx,
        segment,
        endOfPrevious(i),
        segment.version,
      );
    }
  }
  const firstPoint = built.flat().find(isBuilt)?.track.coordinates[0];
  if (firstPoint) ctx.focus = firstPoint;

  for (const [i, segment] of pinned.entries()) {
    if (segment.type === "generated") {
      const start = segment.start
        ? (await place(ctx, segment.start)).point
        : endOfPrevious(i);
      if (!start)
        throw new RouteBuildError(
          `Segment ${i + 1} is generated and comes first, so it needs a start.`,
        );
      ctx.focus = ctx.focus ?? start;
      let end: LatLng | null = null;
      if (segment.end) end = (await place(ctx, segment.end)).point;
      else {
        const next = pinned[i + 1];
        const nextBuilt = built[i + 1]?.[0];
        if (nextBuilt) end = endsOf(nextBuilt).start;
        else if (next?.type === "generated" && next.start)
          end = (await place(ctx, next.start)).point;
        else if (next?.type === "out_and_back" && next.at)
          end = (await place(ctx, next.at)).point;
        else if (!next && i > 0) {
          // The last section with no end goes back to where the route starts.
          end = built.flat().find(isBuilt)?.track.coordinates[0] ?? null;
        }
      }
      if (!end)
        throw new RouteBuildError(
          `Segment ${i + 1} is generated and nothing after it says where it ends, so it needs an end.`,
        );
      const vias = await Promise.all(
        (segment.via ?? []).map(async (text) => {
          const found = await viaPlace(ctx, text);
          return { point: found.point, label: found.label, match: found.match };
        }),
      );
      if (vias.length === 0 && haversineMeters(start, end) <= JOIN_GAP_M) {
        built[i] = [];
        continue;
      }
      built[i] = [
        await generatedSegment(ctx, start, end, vias, {
          flexible: segment.flexible,
        }),
      ];
    } else if (segment.type === "out_and_back") {
      const at = segment.at
        ? (await place(ctx, segment.at)).point
        : endOfPrevious(i);
      if (!at)
        throw new RouteBuildError(
          `Segment ${i + 1} is an out-and-back and comes first, so it needs at.`,
        );
      ctx.focus = ctx.focus ?? at;
      built[i] = [
        await outAndBackSegment(
          ctx,
          at,
          await toward(ctx, segment.toward),
          segment.distance_km * 1000,
          { flexible: segment.flexible },
        ),
      ];
    }
  }

  const segments = dedupeVias(
    await joinGaps(
      ctx,
      built.flatMap((b) => b ?? []),
    ),
  );
  if (segments.length === 0)
    throw new RouteBuildError(
      "These segments make no route: every one is empty.",
    );
  const { route, created } = await createRoute({
    route_id: routeId,
    name,
    kind: "draft",
    next_id: ctx.nextId,
    segments,
    change: `Stitched from ${input.segments.length} segment${input.segments.length === 1 ? "" : "s"}`,
    warnings: [],
  });
  return {
    route,
    version: latestVersion(route),
    created,
    ors_calls: ORS_CALL_BUDGET - ctx.budget.calls,
  };
}

function sectionSegment(section: RouteSection, index: number): StoredSegment {
  const known = section.track.altitude.some((a) => a !== null);
  const base = {
    id: `g${index + 1}`,
    track: thinTrack(section.track),
    climb_m: known ? trackClimb(section.track.altitude) : null,
    path_share: null,
    vias: [],
    flexible: false,
    notes: [],
  };
  if (section.kind === "fill")
    return {
      ...base,
      kind: "generated",
      label: "Routed join",
      source: { type: "ors", purpose: "route" },
      climb_source: known ? "elevation_model" : "none",
    };
  const climb_source = known ? ("recorded" as const) : ("none" as const);
  if (section.kind === "run") {
    const [from_km, to_km] = [
      Math.round(section.from_m) / 1000,
      Math.round(section.to_m) / 1000,
    ];
    return {
      ...base,
      kind: "activity",
      label: `${section.run.name} km ${from_km.toFixed(2)}-${to_km.toFixed(2)}`,
      source: { type: "activity", activity_id: section.run.id, from_km, to_km },
      climb_source,
    };
  }
  const length_km = Math.round(trackLength(section.track)) / 1000;
  return {
    ...base,
    kind: "route",
    label: section.name,
    source: {
      type: "route",
      route_id: section.route_id,
      version: section.version,
      from_km: section.reversed ? length_km : 0,
      to_km: section.reversed ? 0 : length_km,
    },
    climb_source,
  };
}

/**
 * Stores a route suggest-run-route generated, so stitch-route,
 * view-route-map and export-route can use it by route_id. Its id comes
 * from its track, so the same route is stored once.
 */
export async function storeSuggestedRoute(input: {
  name: string;
  track: RouteTrack;
  climb_m: number;
  path_share: number | null;
  shape: string;
  sections?: RouteSection[];
}): Promise<string> {
  const routeId = makeRouteId(
    "suggestion",
    JSON.stringify(
      input.track.coordinates
        .filter((_, i) => i % 10 === 0)
        .map(([a, b]) => [a.toFixed(5), b.toFixed(5)]),
    ),
  );
  const known = input.track.altitude.some((a) => a !== null);
  await createRoute({
    route_id: routeId,
    name: input.name,
    kind: "suggestion",
    next_id: (input.sections?.length || 1) + 1,
    segments: input.sections?.length
      ? input.sections.map(sectionSegment)
      : [
          {
            id: "g1",
            kind: "generated",
            label: input.name,
            source: { type: "ors", purpose: "route" },
            track: thinTrack(input.track),
            climb_m: known ? input.climb_m : null,
            climb_source: known ? "elevation_model" : "none",
            path_share: input.path_share,
            vias: [],
            flexible: false,
            notes: [],
          },
        ],
    change: `Generated by suggest-run-route (${input.shape})`,
    warnings: [],
  });
  return routeId;
}

// ---------- amend-route ----------

export interface AmendResult extends BuildResult {
  base: StoredVersion;
}

function findVia(
  segments: StoredSegment[],
  spans: Span[],
  id: string,
): { index: number; via: SegmentVia; at_m: number } {
  for (const [index, segment] of segments.entries()) {
    const via = segment.vias.find((v) => v.id === id);
    if (via) return { index, via, at_m: spans[index]!.start_m + via.offset_m };
  }
  const ids = segments.flatMap((s) =>
    s.vias.map((v) => `${v.id} (${v.label})`),
  );
  throw new RouteBuildError(
    ids.length > 0
      ? `This version has no via point ${id}; its via points are ${ids.join(", ")}.`
      : `This version has no via point ${id}; it has none. Use insert_via to add one.`,
  );
}

/** Every km a change may start or end at: the ends, the segment ends and the via points. */
function anchors(segments: StoredSegment[], spans: Span[], skip?: string) {
  const out = new Set<number>();
  for (const [i, span] of spans.entries()) {
    out.add(span.start_m);
    out.add(span.end_m);
    for (const via of segments[i]!.vias)
      if (via.id !== skip) out.add(span.start_m + via.offset_m);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * An out-and-back still whole: it ends where it starts. An edit inside one
 * leaves parts of it, whose turnaround is then moved or removed like any
 * via point.
 */
function isWholeOutAndBack(segment: StoredSegment): boolean {
  return (
    segment.kind === "out_and_back" &&
    haversineMeters(
      segment.track.coordinates[0]!,
      segment.track.coordinates.at(-1)!,
    ) <= JOIN_GAP_M
  );
}

/** The segments with one cut at `at_m` (none on a segment end or a seam). */
function splitAt(
  ctx: Ctx,
  segments: StoredSegment[],
  at_m: number,
): StoredSegment[] {
  const { spans } = layoutSegments(segments);
  const i = spans.findIndex(
    (s) => at_m > s.start_m + SAME_M && at_m < s.end_m - SAME_M,
  );
  if (i < 0) return segments;
  const segment = segments[i]!;
  const offset = at_m - spans[i]!.start_m;
  return [
    ...segments.slice(0, i),
    clipSegment(ctx, segment, 0, offset),
    clipSegment(ctx, segment, offset, trackLength(segment.track)),
    ...segments.slice(i + 1),
  ];
}

/**
 * The segments with the part from `from_m` to `to_m` replaced by what
 * `make` builds between the points there (nothing removes it). The parts
 * either side keep their segments.
 */
async function replaceRange(
  ctx: Ctx,
  segments: StoredSegment[],
  from_m: number,
  to_m: number,
  make: (start: LatLng, end: LatLng) => Promise<StoredSegment[]>,
): Promise<StoredSegment[]> {
  const whole = layoutSegments(segments).track;
  const start = pointAtDistance(whole, from_m).point;
  const end = pointAtDistance(whole, to_m).point;
  const cut = splitAt(ctx, splitAt(ctx, segments, from_m), to_m);
  const { spans } = layoutSegments(cut);
  const inside = spans
    .map((s, i) =>
      s.start_m >= from_m - SAME_M && s.end_m <= to_m + SAME_M ? i : -1,
    )
    .filter((i) => i >= 0);
  const at = inside[0] ?? spans.findIndex((s) => s.start_m >= from_m - SAME_M);
  const position = at < 0 ? cut.length : at;
  const made = await make(start, end);
  return [
    ...cut.slice(0, position),
    ...made,
    ...cut.slice(position + inside.length),
  ];
}

function kmToM(value: number, length: number, name: string): number {
  const m = value * 1000;
  if (m < 0 || m > length * (1 + KM_OVERSHOOT) + 10)
    throw new RouteBuildError(
      `${name} ${value} is outside this route, which is ${km(length)} km long.`,
    );
  return Math.min(m, length);
}

function rangeOf(
  from_km: number,
  to_km: number,
  length: number,
): [number, number] {
  const from = kmToM(from_km, length, "from_km");
  const to = kmToM(to_km, length, "to_km");
  if (to - from < 1)
    throw new RouteBuildError(
      `from_km ${from_km} must be before to_km ${to_km}.`,
    );
  return [from, to];
}

/** A point text, or the old point moved by `shift`. */
async function movedPoint(
  ctx: Ctx,
  op: Extract<AmendOperation, { op: "move_via" }>,
  from: LatLng,
): Promise<Pick<Place, "point" | "match">> {
  if (op.to) return viaPlace(ctx, op.to);
  if (op.shift) {
    const heading = parseHeading(op.shift.direction);
    if (heading === null)
      throw new RouteBuildError(
        `"${op.shift.direction}" is not a direction; use north, north-east, east, … or degrees.`,
      );
    return { point: moveToward(from, heading, op.shift.distance_m) };
  }
  throw new RouteBuildError("move_via needs to (a place) or shift.");
}

function headingFrom(a: LatLng, b: LatLng): number {
  const [east, north] = eastNorth(a, b);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

async function applyOperation(
  ctx: Ctx,
  segments: StoredSegment[],
  op: AmendOperation,
): Promise<{ segments: StoredSegment[]; change: string }> {
  const { spans, track } = layoutSegments(segments);
  const length = trackLength(track);
  switch (op.op) {
    case "insert_via": {
      const at = kmToM(op.km, length, "km");
      const found = await viaPlace(ctx, op.place);
      const marks = anchors(segments, spans);
      const before = Math.max(
        ...marks.filter((m) => m < at - SAME_M),
        at - VIA_REROUTE_HALF_M,
        0,
      );
      const after = Math.min(
        ...marks.filter((m) => m > at + SAME_M),
        at + VIA_REROUTE_HALF_M,
        length,
      );
      const label = op.label ?? found.label;
      return {
        segments: await replaceRange(ctx, segments, before, after, (a, b) =>
          generatedSegment(ctx, a, b, [
            { point: found.point, label, match: found.match },
          ]).then((s) => [s]),
        ),
        change: `Added via point ${label} near km ${km(at)}`,
      };
    }
    case "remove_via": {
      const { index, via, at_m } = findVia(segments, spans, op.via_id);
      if (via.kind === "turnaround" && isWholeOutAndBack(segments[index]!)) {
        const span = spans[index]!;
        return {
          segments: segments.filter((_, i) => i !== index),
          change: `Removed the out-and-back to ${via.label} at km ${km(span.start_m)}`,
        };
      }
      const marks = anchors(segments, spans, via.id);
      const before = Math.max(0, ...marks.filter((m) => m < at_m - SAME_M));
      const after = Math.min(length, ...marks.filter((m) => m > at_m + SAME_M));
      return {
        segments: await replaceRange(ctx, segments, before, after, (a, b) =>
          haversineMeters(a, b) <= JOIN_GAP_M
            ? Promise.resolve([])
            : generatedSegment(ctx, a, b, []).then((s) => [s]),
        ),
        change: `Removed via point ${via.label}`,
      };
    }
    case "move_via": {
      const { index, via, at_m } = findVia(segments, spans, op.via_id);
      const { point, match } = await movedPoint(ctx, op, via.point);
      const moved = `Moved ${via.label} ${op.shift ? `${op.shift.distance_m} m ${op.shift.direction}` : `to ${op.to}`}`;
      if (via.kind === "turnaround" && isWholeOutAndBack(segments[index]!)) {
        const segment = segments[index]!;
        const rebuilt = await outAndBackSegment(
          ctx,
          segment.track.coordinates[0]!,
          { point, label: via.label.replace(/^Turnaround toward /, "") },
          null,
          { flexible: segment.flexible, via: { id: via.id, label: via.label } },
        );
        rebuilt.label = segment.label;
        return {
          segments: segments.map((s, i) => (i === index ? rebuilt : s)),
          change: moved,
        };
      }
      const marks = anchors(segments, spans, via.id);
      const before = Math.max(0, ...marks.filter((m) => m < at_m - SAME_M));
      const after = Math.min(length, ...marks.filter((m) => m > at_m + SAME_M));
      return {
        segments: await replaceRange(ctx, segments, before, after, (a, b) =>
          generatedSegment(ctx, a, b, [
            { point, label: via.label, id: via.id, match },
          ]).then((s) => [s]),
        ),
        change: moved,
      };
    }
    case "replace_section": {
      const [from, to] = rangeOf(op.from_km, op.to_km, length);
      if ([op.through, op.activity, op.corridor].filter(Boolean).length > 1)
        throw new RouteBuildError("Pass one of through, activity or corridor.");
      let what = "a new section";
      const updated = await replaceRange(
        ctx,
        segments,
        from,
        to,
        async (a, b) => {
          if (op.activity) {
            what = `activity ${op.activity.id}`;
            return [
              await activitySegment(
                ctx,
                op.activity.id,
                op.activity.from_km,
                op.activity.to_km,
              ),
            ];
          }
          if (op.corridor) {
            what = `corridor ${op.corridor.name}`;
            return corridorSegments(ctx, op.corridor, a);
          }
          if (op.through) {
            const found = await viaPlace(ctx, op.through);
            what = `a section through ${found.label}`;
            return [
              await generatedSegment(ctx, a, b, [
                { point: found.point, label: found.label, match: found.match },
              ]),
            ];
          }
          return [await generatedSegment(ctx, a, b, [])];
        },
      );
      return {
        segments: updated,
        change: `Replaced km ${km(from)}-${km(to)} with ${what}`,
      };
    }
    case "add_out_and_back": {
      const at = kmToM(op.km, length, "km");
      const target = await toward(ctx, op.toward);
      return {
        segments: await replaceRange(ctx, segments, at, at, async (a) => [
          await outAndBackSegment(ctx, a, target, op.distance_km * 1000),
        ]),
        change: `Added a ${op.distance_km} km out-and-back toward ${target.label} at km ${km(at)}`,
      };
    }
    case "trim": {
      const [from, to] = rangeOf(op.from_km, op.to_km, length);
      if (from <= SAME_M && to >= length - SAME_M)
        throw new RouteBuildError("trim would remove the whole route.");
      return {
        segments: await replaceRange(ctx, segments, from, to, async () => []),
        change: `Removed km ${km(from)}-${km(to)}`,
      };
    }
    case "fit_distance":
      return fitDistance(ctx, segments, spans, length, op);
    case "reverse":
      return {
        segments: [...segments]
          .reverse()
          .map((segment) => reverseSegment(ctx, segment)),
        change: "Reversed the route",
      };
    case "undo":
    case "restore":
      throw new RouteBuildError(`${op.op} must be the only operation.`);
  }
}

/** The section fit_distance changes: the km range given, else the flexible segments (one run of them). */
function fitSection(
  segments: StoredSegment[],
  spans: Span[],
  length: number,
  op: Extract<AmendOperation, { op: "fit_distance" }>,
): [number, number] {
  if (op.from_km !== undefined || op.to_km !== undefined) {
    if (op.from_km === undefined || op.to_km === undefined)
      throw new RouteBuildError(
        "fit_distance needs both from_km and to_km, or neither.",
      );
    return rangeOf(op.from_km, op.to_km, length);
  }
  const flexible = segments
    .map((s, i) => (s.flexible ? i : -1))
    .filter((i) => i >= 0);
  if (flexible.length === 0)
    throw new RouteBuildError(
      "No section is marked flexible; pass from_km and to_km for the section to change.",
    );
  const first = flexible[0]!;
  const last = flexible.at(-1)!;
  if (last - first + 1 !== flexible.length)
    throw new RouteBuildError(
      "More than one section is marked flexible; pass from_km and to_km for the one to change.",
    );
  return [spans[first]!.start_m, spans[last]!.end_m];
}

async function fitDistance(
  ctx: Ctx,
  segments: StoredSegment[],
  spans: Span[],
  length: number,
  op: Extract<AmendOperation, { op: "fit_distance" }>,
): Promise<{ segments: StoredSegment[]; change: string }> {
  const [from, to] = fitSection(segments, spans, length, op);
  const target = op.target_km * 1000;
  const want = target - (length - (to - from));
  if (want < 50)
    throw new RouteBuildError(
      `The rest of the route is already ${km(length - (to - from))} km, so this section cannot make it ${op.target_km} km.`,
    );
  const change = `Fitted km ${km(from)}-${km(to)} to make the route ${op.target_km} km`;
  // One out-and-back: change how far it goes.
  const inside = spans
    .map((s, i) =>
      s.start_m >= from - SAME_M && s.end_m <= to + SAME_M ? i : -1,
    )
    .filter((i) => i >= 0);
  const only = inside.length === 1 ? segments[inside[0]!]! : null;
  if (only && isWholeOutAndBack(only)) {
    const turn = only.vias.find((v) => v.kind === "turnaround");
    const at = only.track.coordinates[0]!;
    const heading = headingFrom(at, turn?.point ?? only.track.coordinates[1]!);
    const rebuilt = await outAndBackSegment(
      ctx,
      at,
      { heading, label: only.label.replace(/^Out-and-back toward /, "") },
      want,
      {
        flexible: only.flexible,
        via: turn ? { id: turn.id, label: turn.label } : undefined,
      },
    );
    rebuilt.label = only.label;
    return {
      segments: segments.map((s) => (s === only ? rebuilt : s)),
      change,
    };
  }
  const keepVias = inside.flatMap((i) =>
    segments[i]!.vias.filter((v) => v.kind === "via").map((v) => ({
      point: v.point,
      label: v.label,
      id: v.id,
    })),
  );
  return {
    segments: await replaceRange(ctx, segments, from, to, async (a, b) => {
      const direct = await generatedSegment(ctx, a, b, keepVias, {
        flexible: true,
      });
      const floor = trackLength(direct.track);
      if (floor > want * (1 + GENERATED_DISTANCE_TOLERANCE))
        throw new RouteBuildError(
          `This section is at least ${km(floor)} km through its via points, so the route cannot be ${op.target_km} km; remove a via point or trim another part.`,
        );
      if (Math.abs(floor - want) <= want * GENERATED_DISTANCE_TOLERANCE)
        return [direct];
      const waypoints = [a, ...keepVias.map((v) => v.point), b];
      let straight = 0;
      for (let i = 1; i < waypoints.length; i++)
        straight += haversineMeters(waypoints[i - 1]!, waypoints[i]!);
      const streets =
        straight > 0 ? Math.min(2, Math.max(1, floor / straight)) : 2;
      let best: OrsRoute | null = null;
      for (const seed of FIT_SEEDS) {
        if (!ctx.env.orsKey || ctx.budget.calls <= 0) break;
        const route = await fitToTarget(
          ctx.env.orsKey,
          {
            target_m: want,
            floor_m: floor,
            knob: (want - floor) / streets,
            request: (extra_m) => ({
              waypoints: stretchWaypoints(waypoints, "loop", extra_m, seed),
            }),
            length: (r) => r.distance_m,
            missable: true,
          },
          ctx.budget,
          ctx.progress,
        );
        if (
          route &&
          (!best ||
            Math.abs(route.distance_m - want) <
              Math.abs(best.distance_m - want))
        )
          best = route;
        if (
          best &&
          Math.abs(best.distance_m - want) <=
            want * GENERATED_DISTANCE_TOLERANCE
        )
          break;
      }
      if (ctx.budget.failure)
        throw new RouteBuildError(
          `Could not fit the section: ${ctx.budget.failure}.`,
          "ors",
        );
      if (!best) {
        if (ctx.budget.calls <= 0)
          throw new RouteBuildError(
            `Fitting the section needs more than this call's ${ORS_CALL_BUDGET} routing calls.`,
            "budget",
          );
        return [direct];
      }
      const track = thinTrack(best.track);
      const { note, ...climb } = climbOf(track, "elevation_model");
      const notes = note ? [note] : [];
      const got = trackLength(track);
      if (Math.abs(got - want) > want * GENERATED_DISTANCE_TOLERANCE)
        notes.push(
          `Fitting made this section ${km(got)} km rather than ${km(want)} km.`,
        );
      return [
        {
          ...direct,
          id: segmentId(ctx),
          label:
            best.way_names.length > 0
              ? `New section via ${best.way_names.slice(0, 2).join(", ")}`
              : "New section",
          track,
          ...climb,
          path_share: best.path_share,
          vias: placeVias(ctx, track, keepVias),
          notes,
        },
      ];
    }),
    change,
  };
}

/**
 * Applies the operations in order to version `base` and stores the result
 * as a new version, or restores an earlier version as a new one. Nothing
 * is stored unless every operation worked; see the module comment.
 */
export async function amendRoute(
  apiKey: string,
  input: {
    route_id: string;
    base_version: number;
    operations: AmendOperation[];
    snap?: Snap;
  },
  env: BuildEnv,
  progress: ReportProgress = NO_PROGRESS,
): Promise<AmendResult> {
  const { operations } = input;
  if (operations.length === 0)
    throw new RouteBuildError("Pass at least one operation.");
  const restoring = operations.find(
    (op) => op.op === "undo" || op.op === "restore",
  );
  if (restoring && operations.length > 1)
    throw new RouteBuildError(`${restoring.op} must be the only operation.`);
  const seen: { base?: StoredVersion; ctx?: Ctx } = {};
  const { route, version } = await appendVersion(
    input.route_id,
    input.base_version,
    async (stored) => {
      const base = latestVersion(stored);
      seen.base = base;
      const segments = versionSegments(stored, base);
      const local = newCtx(
        apiKey,
        env,
        progress,
        stored.next_id,
        segments[0]?.track.coordinates[0] ?? null,
        input.snap,
      );
      seen.ctx = local;
      if (restoring) {
        const target =
          restoring.op === "undo" ? base.parent : restoring.version;
        if (target === null)
          throw new RouteBuildError(
            `Version ${base.version} is the first version, so there is nothing to undo.`,
          );
        const restored = findVersion(stored, target);
        if (!restored)
          throw new RouteBuildError(
            `Route ${stored.route_id} has no version ${target}.`,
          );
        return {
          segments: versionSegments(stored, restored),
          next_id: local.nextId,
          change: `Restored version ${target}${restoring.op === "undo" ? " (undo)" : ""}`,
          warnings: [],
        };
      }
      let working = segments;
      const changes: string[] = [];
      for (const op of operations) {
        const done = await applyOperation(local, working, op);
        working = done.segments;
        changes.push(done.change);
      }
      working = dedupeVias(await joinGaps(local, working));
      if (working.length === 0)
        throw new RouteBuildError("These operations leave no route.");
      return {
        segments: working,
        next_id: local.nextId,
        change: changes.join("; "),
        warnings: [],
      };
    },
  );
  return {
    route,
    version,
    base: seen.base!,
    created: true,
    ors_calls: seen.ctx ? ORS_CALL_BUDGET - seen.ctx.budget.calls : 0,
  };
}

// ---------- summaries ----------

export interface ViaSummary {
  id: string;
  km: number;
  label: string;
  kind: "via" | "turnaround";
  lat: number;
  lng: number;
  /** Where the route passes it, and how far that is from lat,lng. */
  snapped_lat: number;
  snapped_lng: number;
  snap_m: number;
  /** How far snap through moved it from lat,lng; 0 when it did not. */
  moved_m: number;
  match_name: string | null;
  match_type: string | null;
}

export interface SegmentSummary {
  index: number;
  kind: StoredSegment["kind"];
  label: string;
  source: SegmentSource;
  from_km: number;
  to_km: number;
  distance_m: number;
  climb_m: number | null;
  climb_source: StoredSegment["climb_source"];
  path_share: number | null;
  flexible: boolean;
  vias: ViaSummary[];
  notes: string[];
}

export interface RouteSummary {
  route_id: string;
  name: string;
  kind: StoredRoute["kind"];
  version: number;
  latest_version: number;
  change: string;
  distance_m: number;
  /** Sum of the sections' climbs; sections with no altitude add nothing (climb_complete false). */
  climb_m: number;
  climb_complete: boolean;
  /** The whole route's share from the OpenStreetMap index, else the OpenRouteService share over the sections where it is known; null where none is. */
  path_share: number | null;
  /** Share (0-1) of the distance whose path share is known; 1 from the index. */
  path_share_coverage: number;
  /** From the OpenStreetMap index (routeOsmStats); null without it or outside it. */
  crossings_per_km: number | null;
  signals_per_km: number | null;
  main_road_km: number | null;
  green_share: number | null;
  segments: SegmentSummary[];
  versions: Array<{ version: number; change: string; created_at: string }>;
  warnings: string[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Pelias layers precise enough to route through without a second look. */
// Warns on more than orsClient's PRECISE_LAYERS, which refuses (a street routes but may be off); thresholds differ on purpose.
const PRECISE_MATCHES = new Set(["venue", "address"]);
/** Two looked-up vias this close probably matched the same thing. */
const SAME_LOOKUP_M = 50;

/** Warnings for vias whose place lookup may have gone wrong. */
function viaMatchWarnings(segments: StoredSegment[]): string[] {
  const looked = segments.flatMap((s) => s.vias.filter((v) => v.match));
  const warnings: string[] = [];
  for (const via of looked)
    if (!PRECISE_MATCHES.has(via.match!.type))
      warnings.push(
        `Via ${via.id} "${via.match!.query}" matched ${via.match!.name}, a ${via.match!.type}, not a venue or address, so it may be off; pass lat,lng to place it exactly.`,
      );
  looked.forEach((a, i) => {
    for (const b of looked.slice(i + 1))
      if (
        a.match!.query !== b.match!.query &&
        haversineMeters(a.point, b.point) <= SAME_LOOKUP_M
      )
        warnings.push(
          `Vias ${a.id} "${a.match!.query}" and ${b.id} "${b.match!.query}" resolved within ${SAME_LOOKUP_M} m of each other, so one is probably wrong; pass lat,lng for it.`,
        );
  });
  return warnings;
}

/** The one warning line that points at the sections with notes. */
function sectionNotesWarning(indices: number[]): string {
  const sections =
    indices.length === 1
      ? `Section ${indices[0]} has notes`
      : `${indices.length} sections have notes (${indices.join(", ")})`;
  return `${sections}; read them with each section.`;
}

/** A version's numbers and sections, without geometry. */
export function summarizeRoute(
  route: StoredRoute,
  version: StoredVersion,
): RouteSummary {
  const segments = versionSegments(route, version);
  const { spans, track } = layoutSegments(segments);
  const distance = trackLength(track);
  let climb = 0;
  let climbComplete = true;
  let shareKnown = 0;
  let onPaths = 0;
  const summaries = segments.map((segment, index): SegmentSummary => {
    const span = spans[index]!;
    const length = span.end_m - span.start_m;
    if (segment.climb_m === null) climbComplete = false;
    else climb += segment.climb_m;
    if (segment.path_share !== null) {
      shareKnown += length;
      onPaths += length * segment.path_share;
    }
    return {
      index: index + 1,
      kind: segment.kind,
      label: segment.label,
      source: segment.source,
      from_km: round3(span.start_m / 1000),
      to_km: round3(span.end_m / 1000),
      distance_m: Math.round(length),
      climb_m: segment.climb_m,
      climb_source: segment.climb_source,
      path_share:
        segment.path_share === null ? null : round2(segment.path_share),
      flexible: segment.flexible,
      vias: segment.vias.map((via) => {
        const snapped = pointAtDistance(
          track,
          span.start_m + via.offset_m,
        ).point;
        const asked = via.requested ?? via.point;
        return {
          id: via.id,
          km: round3((span.start_m + via.offset_m) / 1000),
          label: via.label,
          kind: via.kind,
          lat: round6(asked[0]),
          lng: round6(asked[1]),
          snapped_lat: round6(snapped[0]),
          snapped_lng: round6(snapped[1]),
          snap_m: Math.round(haversineMeters(asked, snapped)),
          moved_m: Math.round(haversineMeters(asked, via.point)),
          match_name: via.match?.name ?? null,
          match_type: via.match?.type ?? null,
        };
      }),
      notes: segment.notes,
    };
  });
  const warnings = [...version.warnings, ...viaMatchWarnings(segments)];
  segments.forEach((segment, index) => {
    // An out-and-back doubles back by design; a past run is what was run.
    if (
      segment.source.type !== "ors" ||
      segment.source.purpose === "out_and_back"
    )
      return;
    const start = spans[index]!.start_m;
    for (const spur of findSpurs(segment.track)) {
      const inside = segment.vias
        .filter((v) => v.offset_m > spur.from_m && v.offset_m < spur.to_m)
        .map((v) => v.id);
      warnings.push(
        `Section ${index + 1} goes back the way it came at km ${km(start + spur.from_m)}-${km(start + spur.to_m)}, ${Math.round((spur.to_m - spur.from_m) / 2)} m each way${inside.length > 0 ? `, around ${inside.join(", ")}` : ""}: usually a via on a dead end or the far side of a pier; move it (move_via) or route with snap "through".`,
      );
    }
  });
  const ordered = summaries.flatMap((s, i) =>
    s.vias.map((v, j) => ({ ...v, point: segments[i]!.vias[j]!.point })),
  );
  ordered.forEach((v, i) => {
    const prev = ordered[i - 1];
    if (
      prev &&
      prev.id !== v.id &&
      haversineMeters(prev.point, v.point) <= SAME_VIA_M
    )
      warnings.push(
        `Vias ${prev.id} and ${v.id} are at one point (km ${v.km.toFixed(2)}), so the route between them goes nowhere; remove one (remove_via) or move it.`,
      );
  });
  // A section's notes stay with the section; the warnings only count them.
  const noted = summaries.filter((s) => s.notes.length > 0);
  if (noted.length > 0)
    warnings.push(sectionNotesWarning(noted.map((s) => s.index)));
  // One meaning for the whole route when the index covers it; sections keep theirs.
  const osm = routeOsmStats(track);
  return {
    route_id: route.route_id,
    name: route.name,
    kind: route.kind,
    version: version.version,
    latest_version: latestVersion(route).version,
    change: version.change,
    distance_m: Math.round(distance),
    climb_m: Math.round(climb),
    climb_complete: climbComplete,
    path_share: osm
      ? osm.path_share
      : shareKnown > 0
        ? round2(onPaths / shareKnown)
        : null,
    path_share_coverage: osm
      ? 1
      : distance > 0
        ? round2(shareKnown / distance)
        : 0,
    crossings_per_km: osm?.crossings_per_km ?? null,
    signals_per_km: osm?.signals_per_km ?? null,
    main_road_km: osm?.main_road_km ?? null,
    green_share: osm?.green_share ?? null,
    segments: summaries,
    versions: route.versions.map((v) => ({
      version: v.version,
      change: v.change,
      created_at: v.created_at,
    })),
    warnings,
  };
}

/** The whole track of one version of a stored route. */
export function versionTrack(
  route: StoredRoute,
  version: StoredVersion,
): RouteTrack {
  return layoutSegments(versionSegments(route, version)).track;
}

export interface VersionChange {
  from_version: number;
  to_version: number;
  distance_change_m: number;
  changed: boolean;
  /** The changed part on the newer version, km. */
  from_km: number;
  to_km: number;
  /** The same part on the older version, km. */
  old_from_km: number;
  old_to_km: number;
}

/** What changed between two versions of a route. */
export function compareVersions(
  route: StoredRoute,
  older: StoredVersion,
  newer: StoredVersion,
): VersionChange {
  const before = versionTrack(route, older);
  const after = versionTrack(route, newer);
  const diff = trackDiff(before, after);
  return {
    from_version: older.version,
    to_version: newer.version,
    distance_change_m: Math.round(trackLength(after) - trackLength(before)),
    changed: diff.changed,
    from_km: round3(diff.new_from_m / 1000),
    to_km: round3(diff.new_to_m / 1000),
    old_from_km: round3(diff.old_from_m / 1000),
    old_to_km: round3(diff.old_to_m / 1000),
  };
}

/** A stored route and one of its versions (the latest by default), or an error worded for the athlete. */
export async function loadRouteVersion(
  routeId: string,
  versionNumber?: number,
): Promise<{ route: StoredRoute; version: StoredVersion }> {
  const route = await readRoute(routeId);
  if (!route)
    throw new RouteBuildError(new RouteNotFoundError(routeId).message);
  const version =
    versionNumber === undefined
      ? latestVersion(route)
      : findVersion(route, versionNumber);
  if (!version)
    throw new RouteBuildError(
      `Route ${routeId} has no version ${versionNumber}; its versions are 1 to ${latestVersion(route).version}.`,
    );
  return { route, version };
}
