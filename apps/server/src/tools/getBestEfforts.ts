import { z } from "zod";
import { getTimeZone } from "../config";
import { HttpError } from "../fetchClient";
import { formatDuration } from "../formatters";
import {
  getActivity,
  getActivityPaceCurves,
  getAthletePaceCurves,
  type IntervalsActivity,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { mapWithConcurrency } from "../utils/concurrency";
import { addDays, isValidCalendarDate, todayLocal } from "../utils/localDate";
import { paceFromDistanceTime } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { BestEffortsOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-best-efforts";

const TIME_BASIS_NOTE =
  "Best times come from the recorded time stream (a moving-time style curve from intervals.icu's pace curves), not elapsed time.";

const description = `
Returns best times at standard running distances (400 m to marathon by
default) from intervals.icu's pace curves, over all time, the last year, the
last 90 days or a custom range. Use it for "what is my fastest 5K?" or to
check a personal best against a recent race.

For predicted race times or goal pacing, use get-race-prediction.

Notes:
- Times come from the recorded time stream (moving-time style), not elapsed
  time. Ranks are computed here; intervals.icu does not return them.
- A distance with no curve point within 2% (or 50 m) of it is listed in
  missing, not replaced by a nearby distance.
- topN above 1 costs extra requests: per-activity pace curves, plus a name
  lookup for each winning activity.
`;

/** Standard distances, in metres. `half marathon`/`marathon` are matched
 * against the nearest point on intervals.icu's fixed distance grid
 * (21097.5 m and 42195 m are both present on it, verified 2026-09-25). */
const DISTANCE_METERS = {
  "400m": 400,
  "1km": 1000,
  "5km": 5000,
  "10km": 10000,
  "half marathon": 21097.5,
  marathon: 42195,
} as const;

type DistanceLabel = keyof typeof DISTANCE_METERS;
const DISTANCE_LABELS = Object.keys(DISTANCE_METERS) as [
  DistanceLabel,
  ...DistanceLabel[],
];
const DEFAULT_DISTANCES: DistanceLabel[] = [...DISTANCE_LABELS];

/** intervals.icu's own lower bound for its "all" pace curve (verified
 * 2026-09-25: the "all" list item's `start_date_local`). */
const ALL_TIME_START = "1986-01-01";

const WINDOW_RE = /^(all|1y|90d|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/;
const WINDOW_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

const inputSchema = z.object({
  distances: z
    .array(z.enum(DISTANCE_LABELS))
    .min(1)
    .optional()
    .describe(
      "Which distances to report. Default: 400m, 1km, 5km, 10km, half marathon, marathon.",
    ),
  window: z
    .string()
    .regex(WINDOW_RE, 'Must be "all", "1y", "90d", or "YYYY-MM-DD..YYYY-MM-DD"')
    .optional()
    .default("1y")
    .describe(
      '"all", "1y", "90d", or a custom "YYYY-MM-DD..YYYY-MM-DD" range. Default: 1y.',
    ),
  topN: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(1)
    .describe(
      "Top N distinct activities per distance (1-5, default 1). Above 1 fetches per-activity pace curves.",
    ),
});

type GetBestEffortsInput = z.infer<typeof inputSchema>;

export interface BestEffortEntry {
  rank: number;
  time_seconds: number;
  time_formatted: string;
  pace_min_per_km: string | null;
  date: string;
  activity_id: string;
  activity_name: string;
  race: boolean;
}

interface BestEffortsResponse {
  window: { id: string; oldest: string; newest: string };
  top_n: number;
  units: { time: "s"; pace: "min/km" };
  note: string;
  best_efforts: Record<string, BestEffortEntry[]>;
  /** Requested distances with no curve point within tolerance
   * ({@link matchDistance}): 2% of the target or 50 m, whichever is larger.
   * Each also has a matching entry in `warnings`. */
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
  if (window === "1y") {
    return { curveId: "1y", oldest: addDays(today, -365), newest: today };
  }
  if (window === "90d") {
    return { curveId: "90d", oldest: addDays(today, -90), newest: today };
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

/** `topN === 1`: one call to `getAthletePaceCurves`, whose `activities` map
 * already carries the winning activity's name/race flag/date. */
async function buildTopOneEfforts(
  apiKey: string,
  distances: DistanceLabel[],
  resolved: ResolvedWindow,
  progress: ReportProgress,
): Promise<{
  best_efforts: Record<string, BestEffortEntry[]>;
  missing: string[];
  warnings: string[];
}> {
  progress(`Fetching pace curve (${resolved.curveId})…`, { important: true });
  const curves = await getAthletePaceCurves(apiKey, {
    type: "Run",
    curves: [resolved.curveId],
  });
  const list = curves.list.find((c) => c.id === resolved.curveId);

  const missing: string[] = [];
  const warnings: string[] = [];
  const best_efforts: Record<string, BestEffortEntry[]> = {};

  for (const label of distances) {
    const target = DISTANCE_METERS[label];
    const idx = list ? matchDistance(list.distance, target) : null;
    const timeSeconds = idx !== null ? (list?.values[idx] ?? null) : null;
    const activityId = idx !== null ? (list?.activity_id[idx] ?? null) : null;

    if (idx === null || timeSeconds == null || !activityId) {
      best_efforts[label] = [];
      missing.push(label);
      warnings.push(
        `No recorded effort within tolerance near ${label} in this window.`,
      );
      continue;
    }

    const activityRef = curves.activities[activityId];
    best_efforts[label] = [
      {
        rank: 1,
        time_seconds: timeSeconds,
        time_formatted: formatDuration(timeSeconds),
        pace_min_per_km: paceFromDistanceTime(
          list?.distance[idx] ?? target,
          timeSeconds,
        ),
        date: (activityRef?.start_date_local ?? "").split("T")[0] ?? "",
        activity_id: activityId,
        activity_name: activityRef?.name ?? "Unknown activity",
        race: activityRef?.race ?? false,
      },
    ];
  }

  return { best_efforts, missing, warnings };
}

/** Names/race flags for the winning activities are resolved with at most one
 * `getActivity` call per unique id (distances x topN, capped at 30), run
 * through `mapWithConcurrency` so the response cache and the client's own
 * throttle in `fetchClient.ts` do the pacing; never one `listActivities`
 * sweep over the whole window (a 40-year "all" window splits into hundreds
 * of sequential calls). */
const NAME_LOOKUP_CONCURRENCY = 5;

/** `topN > 1`: one `getActivityPaceCurves` call for the per-activity times,
 * then a bounded-concurrency `getActivity` per winning activity id for its
 * name/race flag, never one `listActivities` call per candidate window. */
async function buildTopNEfforts(
  apiKey: string,
  distances: DistanceLabel[],
  topN: number,
  resolved: ResolvedWindow,
  progress: ReportProgress,
): Promise<{
  best_efforts: Record<string, BestEffortEntry[]>;
  missing: string[];
  warnings: string[];
}> {
  const targetMeters = distances
    .map((label) => DISTANCE_METERS[label])
    .sort((a, b) => a - b);

  progress(
    `Fetching activity pace curves ${resolved.oldest} to ${resolved.newest}…`,
    { important: true },
  );
  const curves = await getActivityPaceCurves(apiKey, {
    oldest: resolved.oldest,
    newest: resolved.newest,
    type: "Run",
    distances: targetMeters,
  });

  const missing: string[] = [];
  const warnings: string[] = [];
  const candidatesByLabel = new Map<
    DistanceLabel,
    { activityId: string; timeSeconds: number; date: string }[]
  >();
  const distanceMetersByLabel = new Map<DistanceLabel, number>();

  for (const label of distances) {
    const target = DISTANCE_METERS[label];
    const idx = matchDistance(curves.distances, target);
    if (idx === null) {
      missing.push(label);
      warnings.push(
        `No recorded effort within tolerance near ${label} in this window.`,
      );
      continue;
    }
    const distanceMeters = curves.distances[idx]!;
    distanceMetersByLabel.set(label, distanceMeters);

    const candidates = curves.curves
      .filter((c) => c.secs.length > idx && c.secs[idx] != null)
      .map((c) => ({
        activityId: c.id,
        timeSeconds: c.secs[idx] as number,
        date: (c.start_date_local ?? "").split("T")[0] ?? "",
      }))
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .slice(0, topN);

    if (candidates.length === 0) {
      missing.push(label);
      warnings.push(
        `No recorded effort within tolerance near ${label} in this window.`,
      );
      continue;
    }

    candidatesByLabel.set(label, candidates);
  }

  const winningIds = new Set<string>();
  for (const candidates of candidatesByLabel.values()) {
    for (const c of candidates) winningIds.add(c.activityId);
  }

  progress(`Resolving ${winningIds.size} activity names…`, {
    important: true,
  });
  const activityById = new Map<string, IntervalsActivity>();
  await mapWithConcurrency(
    Array.from(winningIds),
    NAME_LOOKUP_CONCURRENCY,
    async (activityId) => {
      try {
        activityById.set(activityId, await getActivity(apiKey, activityId));
      } catch (error) {
        // A genuinely missing activity (e.g. deleted since the pace curve
        // was computed) falls back to "Unknown activity" rather than
        // failing the whole call; anything else, including a rate limit,
        // is a real failure and should surface as one, not be silently
        // swallowed into a misleading "Unknown activity".
        if (error instanceof HttpError && error.response.status === 404) {
          return;
        }
        throw error;
      }
    },
  );

  const best_efforts: Record<string, BestEffortEntry[]> = {};
  for (const label of distances) {
    const candidates = candidatesByLabel.get(label);
    if (!candidates) {
      best_efforts[label] = [];
      continue;
    }
    const distanceMeters = distanceMetersByLabel.get(label) ?? 0;

    best_efforts[label] = candidates.map((c, i) => {
      const info = activityById.get(c.activityId);
      return {
        rank: i + 1,
        time_seconds: c.timeSeconds,
        time_formatted: formatDuration(c.timeSeconds),
        pace_min_per_km: paceFromDistanceTime(distanceMeters, c.timeSeconds),
        date: c.date,
        activity_id: c.activityId,
        activity_name: info?.name ?? "Unknown activity",
        race: info?.race ?? false,
      };
    });
  }

  return { best_efforts, missing, warnings };
}

export function formatBestEffortsText(
  response: BestEffortsResponse,
  distances: DistanceLabel[],
): string {
  const lines = [
    `Best efforts, ${response.window.oldest} to ${response.window.newest}`,
  ];

  let any = false;
  for (const label of distances) {
    const efforts = response.best_efforts[label];
    if (!efforts || efforts.length === 0) continue;
    any = true;
    lines.push(`${label}:`);
    for (const effort of efforts) {
      const raceLabel = effort.race ? " (race)" : "";
      const paceLabel = effort.pace_min_per_km
        ? `${effort.pace_min_per_km} min/km`
        : "n/a";
      lines.push(
        `  ${effort.rank}. ${effort.time_formatted} (${paceLabel}) - ${effort.date}${raceLabel}`,
      );
      lines.push(`     ${effort.activity_name}`);
    }
  }
  if (!any) lines.push("No best efforts found for the requested distances.");

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
    { distances: rawDistances, window, topN }: GetBestEffortsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const distances = rawDistances ?? DEFAULT_DISTANCES;
    const tz = getTimeZone();
    const resolved = resolveWindow(window, tz);
    if ("error" in resolved) {
      return {
        content: [{ type: "text" as const, text: `❌ ${resolved.error}` }],
        isError: true,
      };
    }

    try {
      const { best_efforts, missing, warnings } =
        topN > 1
          ? await buildTopNEfforts(apiKey, distances, topN, resolved, progress)
          : await buildTopOneEfforts(apiKey, distances, resolved, progress);

      const response: BestEffortsResponse = {
        window: {
          id: resolved.curveId,
          oldest: resolved.oldest,
          newest: resolved.newest,
        },
        top_n: topN,
        units: { time: "s", pace: "min/km" },
        note: TIME_BASIS_NOTE,
        best_efforts,
        missing,
        warnings,
      };

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
  },
};
