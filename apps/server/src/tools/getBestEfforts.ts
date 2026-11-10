import { z } from "zod";
import {
  bestEffortWindows,
  coveredDistanceM,
  paceIgnoredMask,
} from "../activityBestEfforts";
import { getTimeZone } from "../config";
import { activityDisplayName, formatDuration, round } from "../formatters";
import {
  getActivity,
  getAthletePaceCurves,
  type IntervalsAthletePaceCurves,
} from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { criticalSpeedModel, pickDistances } from "../racePrediction";
import { addDays, isValidCalendarDate, todayLocal } from "../utils/localDate";
import {
  formatPaceSeconds,
  isPaceActivity,
  paceFromDistanceTime,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { noteToolFailure, prefixedErrorText, toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { BestEffortsOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-best-efforts";

/** Both modes: the pace-curve rule counts elapsed time (verified 2026-10-08,
 * docs/api-notes.md), and `bestEffortWindows` uses the same rule. */
const TIME_BASIS_NOTE =
  "Each time is the elapsed time across the fastest stretch, the rule intervals.icu's pace curves use. A stop inside a stretch counts toward its time.";

const description = `
Returns best times at standard running distances (400 m to marathon by
default). Over your history it reads intervals.icu's pace curves for all
time, the last year, the last 90 days or a custom range: "what is my
fastest 5K?". With an id it searches one run instead and says where each
effort starts and ends: "what was my fastest 5K inside Sunday's half?" or
"my 3 fastest km today" (id "latest" is your newest run). With progression
it also splits the window into months, quarters or years and gives each
one's best and critical speed: "how has my 5K best moved this year?". Over
your history, gap: true reads grade-adjusted bests instead, for hilly or
trail running.

For predicted race times or goal pacing, use get-race-prediction. For even
1 km splits of one run, use get-split-analysis.

Notes:
- Each time is the elapsed time across the fastest stretch, the rule
  intervals.icu's pace curves use. A stop inside the stretch counts. With
  an id, each effort also gives its stopped seconds.
- Over a window, a distance with no curve point within 2% (or 50 m) of it
  is listed in missing, not replaced by a nearby distance.
- With an id, a distance you ask for that is longer than the run is listed
  in missing.
- With an id, only runs (Run, TrailRun, VirtualRun) are searched. Parts
  the athlete marked in intervals.icu to ignore for pace are left out. An
  activity with no recorded streams returns an error.
`;

/** Standard distances, in metres, matched against the nearest point on
 * intervals.icu's fixed distance grid (every one is on it, verified
 * 2026-09-25 and 2026-11-10). */
const DISTANCE_METERS = pickDistances([
  "400m",
  "1km",
  "1 mile",
  "3km",
  "5km",
  "10km",
  "15km",
  "10 mile",
  "half marathon",
  "marathon",
]);

type DistanceLabel = keyof typeof DISTANCE_METERS;
const DISTANCE_LABELS = Object.keys(DISTANCE_METERS) as [
  DistanceLabel,
  ...DistanceLabel[],
];
const DEFAULT_DISTANCES: DistanceLabel[] = [...DISTANCE_LABELS];

/** intervals.icu's own lower bound for its "all" pace curve (verified
 * 2026-09-25: the "all" list item's `start_date_local`). */
const ALL_TIME_START = "1986-01-01";

const PROGRESSION_UNITS = ["month", "quarter", "year"] as const;
type ProgressionUnit = (typeof PROGRESSION_UNITS)[number];
/** Most periods one progression reports, all read in one request. */
const MAX_PERIODS = 12;

const WINDOW_RE = /^(all|1y|90d|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/;
const WINDOW_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

const inputSchema = z
  .object({
    id: intervalsActivityIdInput(
      "One run to search instead of your history. Do not send window with it.",
    ).optional(),
    distances: z
      .array(z.enum(DISTANCE_LABELS))
      .min(1)
      .optional()
      .describe(
        "Which distances to report. Default: all of them; with id, only the ones the run is long enough for.",
      ),
    // No zod default: a default would make every id call also carry a
    // window, so the refine below could not refuse the pair. The handler
    // applies "1y".
    window: z
      .string()
      .regex(
        WINDOW_RE,
        'Must be "all", "1y", "90d", or "YYYY-MM-DD..YYYY-MM-DD"',
      )
      .optional()
      .describe(
        '"all", "1y", "90d", or a custom "YYYY-MM-DD..YYYY-MM-DD" range. Default: 1y. Do not send it with id.',
      ),
    topN: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(1)
      .describe(
        "How many efforts per distance (1-5, default 1): over a window, the fastest distinct activities; with id, the fastest stretches of that run that do not overlap.",
      ),
    progression: z
      .enum(PROGRESSION_UNITS)
      .optional()
      .describe(
        "Also split the window into calendar months, quarters or years (the first and last cut to the window) and give each one's best per distance and intervals.icu's critical speed. At most the 12 most recent; with window \"all\", the last 12. topN applies only to the whole window; each period gives its best. Not with id.",
      ),
    gap: z
      .boolean()
      .optional()
      .describe(
        "true: grade-adjusted times from intervals.icu's GAP pace curve, progression periods included. Over a window only; do not send it with id.",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.id !== undefined && data.window !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message:
          "Send id or window, not both: id searches one run, window searches your history.",
      });
    }
    if (data.id !== undefined && data.progression !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["progression"],
        message:
          "progression splits a window of your history; send it without id.",
      });
    }
    if (data.id !== undefined && data.gap !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["gap"],
        message:
          "gap reads grade-adjusted bests over your history only. Send it without id.",
      });
    }
  });

type GetBestEffortsInput = z.infer<typeof inputSchema>;

export interface BestEffortEntry {
  rank: number;
  time_seconds: number;
  time_formatted: string;
  pace_min_per_km: string | null;
  /** Metres the time covers: the requested distance with an id, the
   * matched curve point over a window. */
  distance_m: number;
  date: string;
  activity_id: string;
  activity_name: string;
  race: boolean;
  /** With an id: km into the run, from its first distance sample. Null
   * over a window. */
  start_km: number | null;
  end_km: number | null;
  /** With an id: the stopped seconds inside `time_seconds`. Null over a
   * window. */
  stopped_seconds: number | null;
}

/** One calendar period of a progression, read as its own `r.` curve. */
interface ProgressionPeriodResult {
  id: string;
  oldest: string;
  newest: string;
  /** False when intervals.icu returned no curve for the period: it holds
   * no runs (docs/api-notes.md). */
  has_runs: boolean;
  best_efforts: Record<string, BestEffortEntry[]>;
  missing: string[];
  critical_speed: { meters_per_sec: number; pace_min_per_km: string } | null;
}

interface BestEffortsResponse {
  mode: "window" | "activity";
  window: { id: string; oldest: string; newest: string } | null;
  activity: {
    id: string;
    name: string;
    date: string;
    type: string;
    covered_km: number;
  } | null;
  top_n: number;
  /** Times and paces are grade-adjusted (`gap: true` over a window). */
  grade_adjusted: boolean;
  units: { time: "s"; pace: "min/km" };
  note: string;
  best_efforts: Record<string, BestEffortEntry[]>;
  /** Requested distances with no result: over a window, no curve point
   * within tolerance ({@link matchDistance}, 2% of the target or 50 m,
   * whichever is larger); with an id, longer than the run (or only inside
   * ignored parts). Each also has a matching entry in `warnings`. */
  missing: string[];
  warnings: string[];
  progression?: {
    unit: ProgressionUnit;
    periods: ProgressionPeriodResult[];
    /** Older periods of the window not reported (over {@link MAX_PERIODS}). */
    left_out: number;
  };
}

interface EffortsResult {
  best_efforts: Record<string, BestEffortEntry[]>;
  missing: string[];
  warnings: string[];
}

interface ResolvedWindow {
  /** `"all"`, `"1y"`, `"90d"`, or `r.<oldest>.<newest>`: the athlete
   * pace-curves `curves` id this window maps to. */
  curveId: string;
  oldest: string;
  newest: string;
}

/** Maps `window` to a concrete date range plus the matching athlete
 * pace-curves curve id, or an athlete-facing error for an invalid range. */
export function resolveWindow(
  window: string,
  tz: string,
): ResolvedWindow | { error: string } {
  const today = todayLocal(tz);
  if (window === "all") {
    return { curveId: "all", oldest: ALL_TIME_START, newest: today };
  }
  // Each curve's `start_date_local` is today - 364 / today - 89: the curve
  // covers 365 / 90 days including today (docs/api-notes.md).
  if (window === "1y") {
    return { curveId: "1y", oldest: addDays(today, -364), newest: today };
  }
  if (window === "90d") {
    return { curveId: "90d", oldest: addDays(today, -89), newest: today };
  }

  const match = WINDOW_RANGE_RE.exec(window);
  if (!match) {
    return {
      error: 'window must be "all", "1y", "90d", or "YYYY-MM-DD..YYYY-MM-DD"',
    };
  }
  const oldest = match[1]!;
  const newest = match[2]!;
  if (!isValidCalendarDate(oldest) || !isValidCalendarDate(newest)) {
    return { error: "window dates must be real calendar dates" };
  }
  if (oldest > newest) {
    return {
      error: `window oldest (${oldest}) is after newest (${newest}). Swap them.`,
    };
  }
  return { curveId: `r.${oldest}.${newest}`, oldest, newest };
}

function periodStart(ymd: string, unit: ProgressionUnit): string {
  const [year, month] = ymd.split("-");
  if (unit === "year") return `${year}-01-01`;
  if (unit === "month") return `${year}-${month}-01`;
  const q = Math.floor((Number(month) - 1) / 3) * 3 + 1;
  return `${year}-${String(q).padStart(2, "0")}-01`;
}

/**
 * Splits `oldest..newest` into calendar months, quarters or years, the first
 * and last cut to the range, oldest first. Only the {@link MAX_PERIODS} most
 * recent are returned; `total` counts them all, so the caller can say how
 * many were left out.
 */
export function progressionPeriods(
  oldest: string,
  newest: string,
  unit: ProgressionUnit,
): { periods: { oldest: string; newest: string }[]; total: number } {
  const periods: { oldest: string; newest: string }[] = [];
  let total = 0;
  for (let end = newest; end >= oldest; ) {
    const start = periodStart(end, unit);
    total += 1;
    if (periods.length < MAX_PERIODS) {
      periods.push({ oldest: start < oldest ? oldest : start, newest: end });
    }
    end = addDays(start, -1);
  }
  return { periods: periods.reverse(), total };
}

/** Index of the point in `distances` closest to `target`, or `null` for an
 * empty array. intervals.icu's distance grid is dense near every standard
 * race distance, so a nearest match (rather than an exact one) is always
 * within a few metres, but this alone has no notion of "too far": see
 * {@link matchDistance}, which every caller uses instead. */
export function nearestIndex(
  distances: number[],
  target: number,
): number | null {
  let bestIdx: number | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < distances.length; i += 1) {
    const diff = Math.abs(distances[i]! - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** How far a curve's nearest point may sit from the requested distance and
 * still count as a match: 2% of the target, or 50 m, whichever is larger. */
const TOLERANCE_PCT = 0.02;
const TOLERANCE_MIN_METERS = 50;

function toleranceMeters(target: number): number {
  return Math.max(target * TOLERANCE_PCT, TOLERANCE_MIN_METERS);
}

/** {@link nearestIndex}, bounded: `null` when the closest point is further
 * than {@link toleranceMeters} from `target`. `nearestIndex` alone always
 * returns *some* point for a non-empty array, even a wildly distant one, so
 * without this bound a short custom window containing only, say, a 3 km
 * effort would get labelled as that window's "marathon" best effort: the
 * closest point on a nearly-empty curve is still "closest", just not close.
 */
export function matchDistance(
  distances: number[],
  target: number,
): number | null {
  const idx = nearestIndex(distances, target);
  if (idx === null) return null;
  const diff = Math.abs(distances[idx]! - target);
  return diff <= toleranceMeters(target) ? idx : null;
}

/** One rank at one grid index: the time and the activity that set it. */
interface CurveRank {
  secs: number;
  activityId: string;
}

/**
 * Ranks 1..`topN` at curve index `idx`: rank 1 from `values`, the rest from
 * the `submax_values` rows that `subMaxEfforts` adds. A row truncated before
 * `idx` (fewer activities reach the distance) adds no rank. An activity that
 * already holds a rank is never listed twice (not seen live, but cheap to
 * guard).
 */
function ranksAt(
  list: IntervalsAthletePaceCurves["list"][number],
  idx: number,
  topN: number,
): CurveRank[] {
  const raw = [
    { secs: list.values[idx], activityId: list.activity_id[idx] },
    ...(list.submax_values ?? []).map((row, r) => ({
      secs: row[idx],
      activityId: list.submax_activity_id?.[r]?.[idx],
    })),
  ];
  const ranks: CurveRank[] = [];
  const seen = new Set<string>();
  for (const { secs, activityId } of raw) {
    if (secs == null || !activityId || seen.has(activityId)) continue;
    seen.add(activityId);
    ranks.push({ secs, activityId });
    if (ranks.length >= topN) break;
  }
  return ranks;
}

/** Each distance's ranks on one curve, or the distance in `missing`. */
function curveEfforts(
  curves: IntervalsAthletePaceCurves,
  list: IntervalsAthletePaceCurves["list"][number] | undefined,
  distances: DistanceLabel[],
  topN: number,
): EffortsResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const best_efforts: Record<string, BestEffortEntry[]> = {};

  if (topN > 1 && list && list.submax_values == null) {
    warnings.push(
      "intervals.icu returned no ranks below the best for this window, so only the best is shown.",
    );
  }

  for (const label of distances) {
    const target = DISTANCE_METERS[label];
    const idx = list ? matchDistance(list.distance, target) : null;
    const ranks = list && idx !== null ? ranksAt(list, idx, topN) : [];

    if (!list || idx === null || ranks.length === 0) {
      best_efforts[label] = [];
      missing.push(label);
      warnings.push(
        `No recorded effort within tolerance near ${label} in this window.`,
      );
      continue;
    }

    const distanceM = list.distance[idx] ?? target;
    best_efforts[label] = ranks.map(({ secs, activityId }, k) => {
      const ref = curves.activities[activityId];
      return {
        rank: k + 1,
        time_seconds: secs,
        time_formatted: formatDuration(secs),
        pace_min_per_km: paceFromDistanceTime(distanceM, secs),
        distance_m: distanceM,
        date: (ref?.start_date_local ?? "").split("T")[0] ?? "",
        activity_id: activityId,
        activity_name: ref?.name ?? "Unknown activity",
        race: ref?.race ?? false,
        start_km: null,
        end_km: null,
        stopped_seconds: null,
      };
    });
  }

  return { best_efforts, missing, warnings };
}

/**
 * Over a window: one `getAthletePaceCurves` call for every `topN`. The
 * `activities` map carries each ranked activity's name, race flag and date,
 * and with `topN` above 1, `subMaxEfforts: topN - 1` adds the next ranks in
 * the same response (#82). Before, ranks below 1 cost a per-activity curve
 * read plus one `getActivity` call per winning activity, up to 30. With
 * `progression`, each period's `r.` curve rides in the same request (#400);
 * a period with no runs has no curve in the response.
 */
async function buildWindowEfforts(
  apiKey: string,
  distances: DistanceLabel[],
  topN: number,
  resolved: ResolvedWindow,
  gap: boolean,
  progress: ReportProgress,
  periods: { oldest: string; newest: string }[] = [],
): Promise<EffortsResult & { periods: ProgressionPeriodResult[] }> {
  const curve = `${gap ? "GAP pace" : "pace"} curve (${resolved.curveId})`;
  progress(
    topN > 1
      ? `Fetching ${curve} with the top ${topN} per distance…`
      : `Fetching ${curve}…`,
    { important: true },
  );
  const periodIds = periods.map((p) => `r.${p.oldest}.${p.newest}`);
  const curves = await getAthletePaceCurves(apiKey, {
    type: "Run",
    // A window inside one period is the same curve twice: ask once.
    curves: [...new Set([resolved.curveId, ...periodIds])],
    ...(topN > 1 ? { subMaxEfforts: topN - 1 } : {}),
    // One request, so every progression period reads the same (GAP) curve.
    ...(gap ? { gap } : {}),
  });
  const byId = (id: string) => curves.list.find((c) => c.id === id);

  const whole = curveEfforts(curves, byId(resolved.curveId), distances, topN);
  const periodResults = periods.map((p, i): ProgressionPeriodResult => {
    const id = periodIds[i]!;
    const list = byId(id);
    const { best_efforts, missing } = curveEfforts(curves, list, distances, 1);
    const cs = criticalSpeedModel(list);
    return {
      id,
      oldest: p.oldest,
      newest: p.newest,
      has_runs: list !== undefined,
      best_efforts,
      missing,
      critical_speed: cs
        ? {
            meters_per_sec: round(cs.criticalSpeedMetersPerSec, 3),
            pace_min_per_km: formatPaceSeconds(
              1000 / cs.criticalSpeedMetersPerSec,
            ),
          }
        : null,
    };
  });
  return { ...whole, periods: periodResults };
}

/** The searched run, as `BestEffortsResponse.activity` reports it. */
type SearchedActivity = NonNullable<BestEffortsResponse["activity"]>;

/**
 * With an id: two requests, the activity and its streams (time, distance
 * and smoothed speed). `bestEffortWindows` (`activityBestEfforts.ts`) finds
 * the stretches with the pace curve's own rule, so rank 1 at a distance
 * equals intervals.icu's activity pace curve there. An `error` is an
 * athlete-facing reason this run cannot be searched; the caller prefixes it.
 */
async function buildActivityEfforts(
  apiKey: string,
  id: string,
  rawDistances: DistanceLabel[] | undefined,
  topN: number,
  progress: ReportProgress,
): Promise<
  | { error: string }
  | (EffortsResult & { activity: SearchedActivity; distances: DistanceLabel[] })
> {
  progress(`Fetching activity ${id}…`);
  const activity = await getActivity(apiKey, id);
  const activityName = activityDisplayName(activity);
  const type = activity.type ?? "Workout";
  if (!isPaceActivity(type)) {
    return {
      error: `get-best-efforts searches runs only (Run, TrailRun, VirtualRun). Activity ${id} ("${activityName}") is a ${type}.`,
    };
  }

  progress(`Fetching the streams for "${activityName}"…`);
  let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
  try {
    // `velocity_smooth` only feeds the loader's `moving` stream. Without it,
    // only a gap in the time stream (an auto-pause) is a stop, and a stand
    // at a light with auto-pause off counts as moving. With it, a stop here
    // is a stop in get-split-analysis too. It is in the same request.
    streams = await loadIntervalsStreams(apiKey, id, [
      "distance",
      "velocity_smooth",
    ]);
  } catch (error) {
    if (error instanceof IntervalsStreamsUnavailableError) {
      // This branch answers without toolErrorText, so it notes the failure
      // for the call's log line itself, as the other stream tools do.
      noteToolFailure(error);
      return {
        error: `No data streams are recorded for "${activityName}" (activity ${id}), so there are no best efforts to find. This looks like a manual entry.`,
      };
    }
    throw error;
  }

  const distance = streams.distance ?? [];
  const covered = coveredDistanceM(distance);
  if (covered <= 0) {
    return {
      error: `"${activityName}" (activity ${id}) has no distance stream, so there are no best efforts to find.`,
    };
  }
  // Rounded down: a run 3 m short of 5 km reads "4.99 km", never "5.00 km",
  // so the text never says a run of "5.00 km" is too short for 5km.
  const coveredKm = Math.floor(covered / 10) / 100;
  const coveredLabel = `${coveredKm.toFixed(2)} km`;

  const missing: string[] = [];
  const warnings: string[] = [];
  const best_efforts: Record<string, BestEffortEntry[]> = {};

  // A distance the athlete did not ask for and the run cannot hold is
  // dropped; one they asked for is reported in `missing` below. A dropped
  // distance the run nearly covers (within the window-mode tolerance, such
  // as a GPS-short parkrun or half marathon) gets a warning, so the model
  // does not lose it without a word.
  let distances = rawDistances;
  if (!distances) {
    distances = DEFAULT_DISTANCES.filter(
      (label) => DISTANCE_METERS[label] <= covered,
    );
    if (distances.length === 0) {
      warnings.push(
        `This run covers ${coveredLabel}, shorter than the shortest distance (400m).`,
      );
    } else {
      for (const label of DEFAULT_DISTANCES) {
        const short = DISTANCE_METERS[label] - covered;
        if (short > 0 && short <= toleranceMeters(DISTANCE_METERS[label])) {
          warnings.push(
            `${label} was not searched: this run covers ${coveredLabel}, ${Math.ceil(short)} m short of it.`,
          );
        }
      }
    }
  }

  // `ignore_parts` indices point into the raw streams. The loader drops a
  // sample with no time, and after a drop the indices point at the wrong
  // samples, so the parts are then reported but not applied.
  const ignored = paceIgnoredMask(activity.ignore_parts, streams.length);
  let excluded: boolean[] | undefined;
  if (ignored) {
    const parts = `${ignored.parts} ${ignored.parts === 1 ? "part" : "parts"}`;
    const dropped = streams.droppedSamples ?? 0;
    if (dropped === 0) {
      excluded = ignored.mask;
      warnings.push(
        `Left out ${parts} of this run that you marked in intervals.icu to ignore for pace.`,
      );
    } else {
      warnings.push(
        `This run has ${parts} marked in intervals.icu to ignore for pace. They were not left out: ${dropped} ${dropped === 1 ? "sample has" : "samples have"} no time, so their positions in the streams are not certain.`,
      );
    }
  }
  if (activity.ignore_pace === true) {
    warnings.push(
      "This run is marked in intervals.icu to ignore its pace, so intervals.icu may leave it out of your pace curves.",
    );
  }

  progress("Finding the fastest stretches…", { important: true });
  const date = activity.start_date_local.split("T")[0] ?? "";
  const race = activity.race ?? false;
  for (const label of distances) {
    const target = DISTANCE_METERS[label];
    if (target > covered) {
      best_efforts[label] = [];
      missing.push(label);
      warnings.push(`${label} is longer than this run (${coveredLabel}).`);
      continue;
    }
    const windows = bestEffortWindows(
      { time: streams.time, distance, moving: streams.moving },
      target,
      topN,
      excluded,
    );
    // The run covers the target, so with nothing excluded the stretch from
    // the first distance sample always reaches it: only ignored parts can
    // leave no stretch.
    if (windows.length === 0) {
      best_efforts[label] = [];
      missing.push(label);
      warnings.push(`No ${label} stretch outside the ignored parts.`);
      continue;
    }
    best_efforts[label] = windows.map((w, k) => {
      const timeSeconds = Math.round(w.seconds);
      return {
        rank: k + 1,
        time_seconds: timeSeconds,
        time_formatted: formatDuration(timeSeconds),
        pace_min_per_km: paceFromDistanceTime(target, timeSeconds),
        distance_m: target,
        date,
        activity_id: id,
        activity_name: activityName,
        race,
        start_km: round(w.startM / 1000, 2),
        end_km: round(w.endM / 1000, 2),
        stopped_seconds: Math.round(w.stoppedSeconds),
      };
    });
  }

  return {
    best_efforts,
    missing,
    warnings,
    distances,
    activity: { id, name: activityName, date, type, covered_km: coveredKm },
  };
}

/** One effort's lines: where in the run (with an id) or when (over a
 * window). */
function effortLines(
  effort: BestEffortEntry,
  mode: BestEffortsResponse["mode"],
): string[] {
  const pace = effort.pace_min_per_km
    ? `${effort.pace_min_per_km} min/km`
    : "n/a";
  const head = `  ${effort.rank}. ${effort.time_formatted} (${pace})`;
  if (mode === "activity") {
    const where =
      effort.start_km != null && effort.end_km != null
        ? ` from km ${effort.start_km.toFixed(2)} to ${effort.end_km.toFixed(2)}`
        : "";
    const stopped = effort.stopped_seconds
      ? `, ${formatDuration(effort.stopped_seconds)} stopped`
      : "";
    return [`${head}${where}${stopped}`];
  }
  const raceLabel = effort.race ? " (race)" : "";
  return [
    `${head} - ${effort.date}${raceLabel}`,
    `     ${effort.activity_name}`,
  ];
}

export function formatBestEffortsText(
  response: BestEffortsResponse,
  distances: DistanceLabel[],
): string {
  const { activity, window } = response;
  const lines = [
    activity
      ? `Best efforts inside ${activity.name} (${activity.id}), ${activity.date}, ${activity.covered_km.toFixed(2)} km`
      : `${response.grade_adjusted ? "Grade-adjusted best efforts" : "Best efforts"}, ${window?.oldest} to ${window?.newest}`,
  ];

  let any = false;
  for (const label of distances) {
    const efforts = response.best_efforts[label];
    if (!efforts || efforts.length === 0) continue;
    any = true;
    // Over a window the matched curve point can sit up to the tolerance
    // away from the label: say which distance the times are for.
    const covers = efforts[0]!.distance_m;
    lines.push(
      Math.abs(covers - DISTANCE_METERS[label]) >= 1
        ? `${label} (${(covers / 1000).toFixed(2)} km):`
        : `${label}:`,
    );
    for (const effort of efforts) {
      lines.push(...effortLines(effort, response.mode));
    }
  }
  if (!any) lines.push("No best efforts found for the requested distances.");

  if (response.progression) {
    lines.push(`By ${response.progression.unit}:`);
    for (const period of response.progression.periods) {
      const range = `${period.oldest} to ${period.newest}`;
      if (!period.has_runs) {
        lines.push(`${range}: no runs`);
        continue;
      }
      lines.push(`${range}:`);
      for (const label of distances) {
        const best = period.best_efforts[label]?.[0];
        lines.push(
          best
            ? `  ${label}: ${best.time_formatted} (${best.pace_min_per_km ?? "n/a"} min/km) - ${best.date}, ${best.activity_name} (${best.activity_id})`
            : `  ${label}: none`,
        );
      }
      if (period.critical_speed) {
        lines.push(
          `  Critical speed: ${period.critical_speed.pace_min_per_km} min/km (${period.critical_speed.meters_per_sec} m/s)`,
        );
      }
    }
  }

  for (const warning of response.warnings) lines.push(warning);
  lines.push(response.note);

  return lines.join("\n");
}

export const getBestEffortsTool = {
  name,
  title: "Best efforts",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: BestEffortsOutputSchema,
  execute: async (
    {
      id,
      distances: rawDistances,
      window,
      topN,
      progression,
      gap,
    }: GetBestEffortsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    let response: BestEffortsResponse;
    let distances: DistanceLabel[];

    if (id !== undefined) {
      try {
        const outcome = await buildActivityEfforts(
          apiKey,
          id,
          rawDistances,
          topN,
          progress,
        );
        if ("error" in outcome) {
          return {
            content: [
              { type: "text" as const, text: prefixedErrorText(outcome.error) },
            ],
            isError: true,
          };
        }
        distances = outcome.distances;
        response = {
          mode: "activity",
          window: null,
          activity: outcome.activity,
          top_n: topN,
          grade_adjusted: false,
          units: { time: "s", pace: "min/km" },
          note: TIME_BASIS_NOTE,
          best_efforts: outcome.best_efforts,
          missing: outcome.missing,
          warnings: outcome.warnings,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: toolErrorText(error, {
                context: `fetch best efforts for activity ${id}`,
                notFound: `Activity ${id} was not found.`,
              }),
            },
          ],
          isError: true,
        };
      }
    } else {
      const resolved = resolveWindow(window ?? "1y", getTimeZone());
      if ("error" in resolved) {
        return {
          content: [
            { type: "text" as const, text: prefixedErrorText(resolved.error) },
          ],
          isError: true,
        };
      }
      distances = rawDistances ?? DEFAULT_DISTANCES;
      const split = progression
        ? progressionPeriods(resolved.oldest, resolved.newest, progression)
        : { periods: [], total: 0 };
      try {
        const { best_efforts, missing, warnings, periods } =
          await buildWindowEfforts(
            apiKey,
            distances,
            topN,
            resolved,
            gap === true,
            progress,
            split.periods,
          );
        const leftOut = split.total - split.periods.length;
        if (leftOut > 0) {
          warnings.push(
            `The window holds ${split.total} ${progression}s; only the most recent ${split.periods.length} are shown, from ${split.periods[0]?.oldest}. Send a narrower window for older ones.`,
          );
        }
        response = {
          mode: "window",
          window: {
            id: resolved.curveId,
            oldest: resolved.oldest,
            newest: resolved.newest,
          },
          activity: null,
          top_n: topN,
          grade_adjusted: gap === true,
          units: { time: "s", pace: "min/km" },
          note: TIME_BASIS_NOTE,
          best_efforts,
          missing,
          warnings,
          ...(progression
            ? { progression: { unit: progression, periods, left_out: leftOut } }
            : {}),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: toolErrorText(error, {
                context: `fetch best efforts for ${resolved.oldest} to ${resolved.newest}`,
                notFound: "No pace curve data was found for this athlete.",
              }),
            },
          ],
          isError: true,
        };
      }
    }

    warnOnSchemaDrift(name, BestEffortsOutputSchema, response);

    return {
      content: [
        {
          type: "text" as const,
          text: formatBestEffortsText(response, distances),
        },
      ],
      structuredContent: response,
    };
  },
};
