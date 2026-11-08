/**
 * The running score of a route suggestion: 0-100 from off-road paths, known
 * lines, crossings, main roads, backtracking, green and fit to the plan, less
 * 10 for a past run repeated within a week. The one home of the weights, of
 * known lines and of the per-route notes. Pure; the engine
 * (routeSuggestions.ts) applies it to every candidate. docs/tools.md,
 * suggest-run-route.
 */
import { type LatLng, type RouteTrack } from "./mapAnchors";
import {
  eastNorth,
  RECENT_REPEAT_DAYS,
  type RouteCandidate,
  type RouteShape,
  type Terrain,
  type TerrainBands,
  terrainFits,
} from "./routeCandidates";
import { findSpurs, pointAtDistance, trackLength } from "./routeGeometry";
import { type RunStart } from "./startClusters";
import { daysBetween } from "./utils/localDate";

/** The most each factor gives; they add up to 100. */
export const SCORE_WEIGHTS = {
  paths: 25,
  known_lines: 20,
  crossings: 15,
  main_roads: 15,
  backtracking: 10,
  green: 10,
  fit: 5,
} as const;
/** Taken off a past run done within RECENT_REPEAT_DAYS. */
export const RECENT_PENALTY = 10;
/** Weighted stops per km (a signal counts twice) that cost every crossing point. */
const CROSSINGS_CAP = 8;
/** Share of the route on main roads that costs every main-road point. */
const MAIN_ROAD_CAP = 0.25;
/** Retraced km that cost every backtracking point. */
const RETRACED_CAP_KM = 2;
/** Distance miss, as a share of the target, that costs every fit point. */
const FIT_CAP = 0.25;
/** A factor that lost less than this is left out of the text's "lost" list. */
const LOSS_SHOWN = 2;
const LOSSES_SHOWN = 3;

export type ScoreFactor = keyof typeof SCORE_WEIGHTS;
/** Scaled points per factor (null: not measured), plus recency (0 or -10). */
export type ScoreBreakdown = Record<ScoreFactor, number | null> & {
  recency: number;
};

export interface ScoreContext {
  target_m: number;
  terrain: Terrain;
  /** The asked shape: an out-and-back request goes back by design. */
  shape: RouteShape;
  bands: TerrainBands;
  today: string;
}

const LABELS: Record<ScoreFactor | "recency", string> = {
  paths: "paths",
  known_lines: "known lines",
  crossings: "crossings",
  main_roads: "main roads",
  backtracking: "backtracking",
  green: "green",
  fit: "fit",
  recency: "recent run",
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const FACTORS = Object.keys(SCORE_WEIGHTS) as ScoreFactor[];

/** Each factor's share (0-1) of its points; null when its measure is unknown. */
function shares(
  c: RouteCandidate,
  known_share: number | null,
  retraced_m: number,
  ctx: ScoreContext,
): Record<ScoreFactor, number | null> {
  const km = c.distance_m / 1000;
  const fits = terrainFits(ctx.terrain, c.climb_m, c.distance_m, ctx.bands);
  const distanceFit =
    ctx.target_m > 0
      ? clamp01(
          1 - Math.abs(c.distance_m - ctx.target_m) / (FIT_CAP * ctx.target_m),
        )
      : 1;
  return {
    paths: c.path_share === null ? null : clamp01(c.path_share),
    known_lines: known_share === null ? null : clamp01(known_share),
    // crossings_per_km already counts signalised stops; adding signals counts each twice.
    crossings:
      c.crossings_per_km === null
        ? null
        : clamp01(
            1 - (c.crossings_per_km + (c.signals_per_km ?? 0)) / CROSSINGS_CAP,
          ),
    main_roads:
      c.main_road_km == null || km <= 0
        ? null
        : clamp01(1 - c.main_road_km / km / MAIN_ROAD_CAP),
    backtracking:
      ctx.shape === "out-and-back" || c.shape === "out-and-back"
        ? 1
        : clamp01(1 - retraced_m / 1000 / RETRACED_CAP_KM),
    green: c.green_share == null ? null : clamp01(c.green_share),
    fit: distanceFit * (fits ? 1 : 0.5),
  };
}

/**
 * The score (0-100) and its breakdown. A factor the OSM index could not
 * measure is left out and the rest are scaled to 100, so a route outside the
 * index still scores out of 100; recency is never scaled.
 */
export function scoreRoute(
  c: RouteCandidate,
  known_share: number | null,
  retraced_m: number,
  ctx: ScoreContext,
): { score: number; breakdown: ScoreBreakdown } {
  const s = shares(c, known_share, retraced_m, ctx);
  const possible = FACTORS.reduce(
    (sum, f) => sum + (s[f] === null ? 0 : SCORE_WEIGHTS[f]),
    0,
  );
  const scale = 100 / possible;
  const recent =
    c.kind === "past" &&
    c.date !== null &&
    daysBetween(c.date, ctx.today) <= RECENT_REPEAT_DAYS;
  const breakdown = {
    recency: recent ? -RECENT_PENALTY : 0,
  } as ScoreBreakdown;
  let total = breakdown.recency;
  for (const f of FACTORS) {
    const share = s[f];
    if (share === null) {
      breakdown[f] = null;
      continue;
    }
    const points = share * SCORE_WEIGHTS[f] * scale;
    breakdown[f] = round1(points);
    total += points;
  }
  return { score: Math.max(0, Math.round(total)), breakdown };
}

/** What cost a route the most: factors that lost at least LOSS_SHOWN points against their scaled maximum, biggest first. */
export function scoreLosses(
  breakdown: ScoreBreakdown,
): Array<{ label: string; points: number }> {
  const possible = FACTORS.reduce(
    (sum, f) => sum + (breakdown[f] === null ? 0 : SCORE_WEIGHTS[f]),
    0,
  );
  const scale = 100 / possible;
  const losses = FACTORS.flatMap((f) => {
    const points = breakdown[f];
    return points === null
      ? []
      : [
          {
            label: LABELS[f],
            points: round1(SCORE_WEIGHTS[f] * scale - points),
          },
        ];
  });
  if (breakdown.recency < 0)
    losses.push({ label: LABELS.recency, points: -breakdown.recency });
  return losses
    .filter((l) => l.points >= LOSS_SHOWN)
    .sort((a, b) => b.points - a.points)
    .slice(0, LOSSES_SHOWN);
}

/** A line followed by at least this many distinct runs is known. */
export const KNOWN_RUNS = 3;
/** A run's sample this close (and heading the same line) follows it. */
export const KNOWN_MATCH_M = 20;
const KNOWN_STEP_M = 10;
/** Headings within 30 degrees, either way. */
const KNOWN_HEADING_COS = Math.cos(Math.PI / 6);

interface Sample {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** 10 m samples with unit headings, in metres east and north of `origin`. */
function samples(track: RouteTrack, origin: LatLng): Sample[] {
  const n = Math.floor(trackLength(track) / KNOWN_STEP_M);
  if (n < 1) return [];
  const xy = Array.from({ length: n + 1 }, (_, i) =>
    eastNorth(origin, pointAtDistance(track, i * KNOWN_STEP_M).point),
  );
  return xy.map(([x, y], i) => {
    const [ax, ay] = xy[Math.max(0, i - 1)]!;
    const [bx, by] = xy[Math.min(n, i + 1)]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    return { x, y, dx: (bx - ax) / len, dy: (by - ay) / len };
  });
}

/**
 * Known lines from the loaded runs, built once per call: the returned
 * function gives a track's share (0-1) of 10 m samples that at least
 * KNOWN_RUNS distinct runs follow (a sample within KNOWN_MATCH_M heading
 * within 30 degrees either way). The 20 m radius keeps a road from matching
 * the footpath beside it; the heading separates crossing streets, and a line
 * run the other way is the same line.
 */
export function knownLines(runs: RunStart[]): (track: RouteTrack) => number {
  const origin = runs[0]?.track.coordinates[0];
  if (!origin || runs.length < KNOWN_RUNS) return () => 0;
  const cell = (v: number) => Math.floor(v / KNOWN_MATCH_M);
  const grid = new Map<string, Array<Sample & { run: number }>>();
  runs.forEach((run, r) => {
    for (const s of samples(run.track, origin)) {
      const key = `${cell(s.x)},${cell(s.y)}`;
      const item = { ...s, run: r };
      const list = grid.get(key);
      if (list) list.push(item);
      else grid.set(key, [item]);
    }
  });
  return (track) => {
    const own = samples(track, origin);
    if (own.length === 0) return 0;
    let known = 0;
    for (const s of own) {
      const seen = new Set<number>();
      for (let i = cell(s.x) - 1; i <= cell(s.x) + 1; i++)
        for (let j = cell(s.y) - 1; j <= cell(s.y) + 1; j++)
          for (const o of grid.get(`${i},${j}`) ?? [])
            if (
              seen.size < KNOWN_RUNS &&
              !seen.has(o.run) &&
              Math.hypot(o.x - s.x, o.y - s.y) <= KNOWN_MATCH_M &&
              Math.abs(o.dx * s.dx + o.dy * s.dy) >= KNOWN_HEADING_COS
            )
              seen.add(o.run);
      if (seen.size >= KNOWN_RUNS) known++;
    }
    return known / own.length;
  };
}

const km1 = (m: number) => (m / 1000).toFixed(1);

/** Slack on a dead end's span (way in plus way back) for the turn itself. */
const DEAD_END_SLACK_M = 50;

/**
 * Notes on a route: each dead-end spur, where the return starts right after the
 * stretch. A shared start street or lollipop stick spans the whole loop and is
 * left to `retracedM`. None for an out-and-back, which goes back by design.
 */
export function routeNotes(track: RouteTrack, asked: RouteShape): string[] {
  if (asked === "out-and-back") return [];
  return findSpurs(track)
    .filter((s) => s.to_m - s.from_m <= 2 * s.length_m + DEAD_END_SLACK_M)
    .map(
      (s) =>
        `Goes back the way it came from km ${km1(s.from_m)}, ${Math.round(s.length_m)} m each way.`,
    );
}
