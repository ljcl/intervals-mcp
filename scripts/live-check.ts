/**
 * Live check: calls every Phase 1 and Phase 2 intervals.icu read tool's
 * executor directly against a real account, using the key from the root
 * `.env`.
 *
 * Prints only a short summary per tool (ok/error plus a handful of numbers)
 * so this is safe to run and paste output from in a public repo. It never
 * prints the API key, and never prints a raw tool payload (names,
 * descriptions, comments, coordinates, or any id other than the activity id
 * argument) since those are the athlete's data, not ours to publish. A
 * failure prints only an error class or a known status category
 * (`errorSummary`/`throwSummary` below), never the error's own message
 * text, which can interpolate an activity name. No write calls are made.
 *
 * Usage: `bun scripts/live-check.ts [activityId]` (default i189807578).
 */

import path from "node:path";
import * as dotenv from "dotenv";

const root = path.resolve(import.meta.dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const { getIntervalsApiKey } = await import("../apps/server/src/config");
const { getActivityTool } = await import(
  "../apps/server/src/tools/getActivity"
);
const { getActivityStreamsTool } = await import(
  "../apps/server/src/tools/getActivityStreams"
);
const { getWellnessTool } = await import(
  "../apps/server/src/tools/getWellness"
);
const { listActivitiesTool } = await import(
  "../apps/server/src/tools/listActivities"
);
const { listGearTool } = await import("../apps/server/src/tools/listGear");
const { getActivityLapsTool } = await import(
  "../apps/server/src/tools/getActivityLaps"
);
const { getRunningSummaryTool } = await import(
  "../apps/server/src/tools/getRunningSummary"
);
const { getActivityZonesTool } = await import(
  "../apps/server/src/tools/getActivityZones"
);
const { compareActivitiesTool } = await import(
  "../apps/server/src/tools/compareActivities"
);
const { getHillAnalysisTool } = await import(
  "../apps/server/src/tools/getHillAnalysis"
);
const { getSplitAnalysisTool } = await import(
  "../apps/server/src/tools/getSplitAnalysis"
);
const { getAerobicAnalysisTool } = await import(
  "../apps/server/src/tools/getAerobicAnalysis"
);
const { getIntervalAnalysisTool } = await import(
  "../apps/server/src/tools/getIntervalAnalysis"
);
const { getBestEffortsTool } = await import(
  "../apps/server/src/tools/getBestEfforts"
);
const { getRacePredictionTool } = await import(
  "../apps/server/src/tools/getRacePrediction"
);
const { getAthleteStatsTool } = await import(
  "../apps/server/src/tools/getAthleteStats"
);
const { NO_PROGRESS } = await import("../apps/server/src/progress");

const activityId = process.argv[2] ?? "i189807578";
const apiKey = getIntervalsApiKey();

let failures = 0;

function ok(name: string, detail: string): void {
  console.log(`${name}: ok - ${detail}`);
}

function fail(name: string, detail: string): void {
  failures += 1;
  console.log(`${name}: error - ${detail}`);
}

/**
 * Known `toolErrorText` (`tools/_errors.ts`) categories, matched by the
 * fixed prefix each branch always uses. A tool's own inline error text
 * (e.g. a streams-unavailable message naming the activity) matches none of
 * these and falls to "unclassified" rather than being printed in full.
 */
const KNOWN_ERROR_CATEGORIES: Array<[RegExp, string]> = [
  [/rate limit/i, "rate limited"],
  [/was not found/i, "not found"],
  [/subscription/i, "subscription required"],
  [/not yet ported/i, "not yet ported"],
  [/rejected the API key|not configured/i, "auth/config error"],
];

/**
 * A short, safe-to-print category for the tool's own `isError` text
 * (content[0].text), never the text itself: that text can interpolate the
 * activity's name (e.g. a streams-unavailable message), which is the
 * athlete's data, not ours to print (see the module doc comment above).
 */
function errorSummary(result: { content?: Array<{ text?: unknown }> }): string {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return "tool returned isError";
  for (const [pattern, label] of KNOWN_ERROR_CATEGORIES) {
    if (pattern.test(text)) return label;
  }
  return "tool error (unclassified)";
}

/**
 * A short, safe-to-print summary for a thrown error: its class name plus an
 * HTTP status when the error carries one (`HttpError`'s `response.status`),
 * never `error.message`, which can carry interpolated context (e.g. an
 * activity id or name) from deep in the call stack.
 */
function throwSummary(error: unknown): string {
  if (error instanceof Error) {
    const response = (error as { response?: { status?: unknown } }).response;
    const status =
      response && typeof response === "object" && "status" in response
        ? response.status
        : undefined;
    return status != null ? `${error.name} (${status})` : error.name;
  }
  return "unknown error";
}

async function checkListActivities(): Promise<void> {
  const name = "list-activities";
  const newest = "2026-09-24";
  const oldest = "2026-09-20";
  try {
    const result = (await listActivitiesTool.execute(
      { oldest, newest, limit: 30 },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const activities = result.structuredContent.activities as Array<{
      id: string;
      is_strava_stub: boolean;
    }>;
    const matches = activities.filter((a) => a.id === activityId);
    const count = result.structuredContent.count;
    ok(
      name,
      `count=${count} target_occurrences=${matches.length} target_is_strava_stub=${matches[0]?.is_strava_stub}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetActivity(): Promise<void> {
  const name = "get-activity";
  try {
    const result = (await getActivityTool.execute(
      { id: activityId, includeIntervals: true },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      distance_km: number | null;
      average_cadence_spm: number | null;
      running_dynamics: {
        stance_time_ms: number | null;
        vertical_oscillation_mm: number | null;
      } | null;
      intervals: unknown[] | null;
    };
    ok(
      name,
      `distance_km=${d.distance_km} cadence_spm=${d.average_cadence_spm} gct_ms=${d.running_dynamics?.stance_time_ms} vo_mm=${d.running_dynamics?.vertical_oscillation_mm} intervals=${d.intervals?.length ?? 0}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetActivityStreams(): Promise<void> {
  const name = "get-activity-streams";
  try {
    const result = (await getActivityStreamsTool.execute(
      {
        id: activityId,
        types: ["heartrate", "cadence", "stance_time", "vertical_oscillation"],
        maxPoints: 100,
      },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const streams = result.structuredContent.streams as Record<
      string,
      unknown[]
    >;
    const lengths = Object.entries(streams)
      .map(([type, values]) => `${type}=${values.length}`)
      .join(" ");
    ok(
      name,
      `returned_points=${result.structuredContent.returned_points} ${lengths}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkListGear(): Promise<void> {
  const name = "list-gear";
  try {
    const result = (await listGearTool.execute(
      { includeRetired: false },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    ok(name, `count=${result.structuredContent.count}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetWellness(): Promise<void> {
  const name = "get-wellness";
  const date = "2026-09-24";
  try {
    const result = (await getWellnessTool.execute(
      { date },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const days = result.structuredContent.days as Array<{
      resting_hr: number | null;
      hrv_sdnn_ms: number | null;
    }>;
    const day = days[0];
    ok(
      name,
      `resting_hr=${day?.resting_hr} hrv_sdnn_ms=${day?.hrv_sdnn_ms != null ? "present" : "null"}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetActivityLaps(): Promise<void> {
  const name = "get-activity-laps";
  try {
    const result = (await getActivityLapsTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      lap_count: number;
      device_lap_count: number | null;
    };
    ok(name, `lap_count=${d.lap_count} device_lap_count=${d.device_lap_count}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetRunningSummary(): Promise<void> {
  const name = "get-running-summary";
  try {
    const result = (await getRunningSummaryTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      laps: unknown[];
      hr_zone_summary: { total_seconds: number } | null;
    };
    ok(
      name,
      `laps=${d.laps.length} hr_zone_total_s=${d.hr_zone_summary?.total_seconds ?? "n/a"}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetActivityZones(): Promise<void> {
  const name = "get-activity-zones";
  try {
    const result = (await getActivityZonesTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const zoneSets = result.structuredContent.zone_sets as Array<{
      type: string;
      total_seconds: number;
    }>;
    const totalSeconds = zoneSets.reduce((sum, z) => sum + z.total_seconds, 0);
    ok(name, `zone_sets=${zoneSets.length} total_seconds=${totalSeconds}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkCompareActivities(): Promise<void> {
  const name = "compare-activities";
  try {
    const result = (await compareActivitiesTool.execute(
      { activityId1: activityId, activityId2: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      differences: { distance_km: number };
      efficiency: unknown;
    };
    ok(
      name,
      `distance_km_diff=${d.differences.distance_km} efficiency=${d.efficiency ? "present" : "null"}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetHillAnalysis(): Promise<void> {
  const name = "get-hill-analysis";
  try {
    const result = (await getHillAnalysisTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      grade_source: string;
      totals: { climb_count: number; descent_count: number };
    };
    ok(
      name,
      `grade_source=${d.grade_source} climbs=${d.totals.climb_count} descents=${d.totals.descent_count}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetSplitAnalysis(): Promise<void> {
  const name = "get-split-analysis";
  try {
    const result = (await getSplitAnalysisTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      splits: unknown[];
      verdict: { shape: string } | null;
    };
    ok(name, `splits=${d.splits.length} shape=${d.verdict?.shape ?? "n/a"}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetAerobicAnalysis(): Promise<void> {
  const name = "get-aerobic-analysis";
  try {
    const result = (await getAerobicAnalysisTool.execute(
      { id: activityId, basis: "pace", includeBreakdown: false },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      decoupling_source: string;
      decoupling_pct: number;
    };
    ok(
      name,
      `decoupling_source=${d.decoupling_source} decoupling_pct=${d.decoupling_pct}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetIntervalAnalysis(): Promise<void> {
  const name = "get-interval-analysis";
  try {
    const result = (await getIntervalAnalysisTool.execute(
      { id: activityId },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      reps: unknown[];
      source: string;
      confidence: string;
    };
    ok(
      name,
      `reps=${d.reps.length} source=${d.source} confidence=${d.confidence}`,
    );
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetBestEfforts(): Promise<void> {
  const name = "get-best-efforts";
  try {
    const result = (await getBestEffortsTool.execute(
      { distances: ["5km"], window: "1y", topN: 1 },
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const bestEfforts = result.structuredContent.best_efforts as Record<
      string,
      Array<{ time_formatted: string }>
    >;
    const best5k = bestEfforts["5km"]?.[0];
    ok(name, `best_5km=${best5k?.time_formatted ?? "none"}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetRacePrediction(): Promise<void> {
  const name = "get-race-prediction";
  try {
    const result = (await getRacePredictionTool.execute(
      {},
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const predictions = result.structuredContent.predictions as Array<{
      distance: string;
      predicted_formatted: string;
    }>;
    const tenK = predictions.find((p) => p.distance === "10K");
    ok(name, `predicted_10k=${tenK?.predicted_formatted ?? "none"}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

async function checkGetAthleteStats(): Promise<void> {
  const name = "get-athlete-stats";
  try {
    const result = (await getAthleteStatsTool.execute(
      {},
      apiKey,
      NO_PROGRESS,
    )) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text?: unknown }>;
    };
    if (result.isError || !result.structuredContent) {
      fail(name, errorSummary(result));
      return;
    }
    const d = result.structuredContent as {
      ytd: { runs: number; distance_km: number };
    };
    ok(name, `ytd_runs=${d.ytd.runs} ytd_distance_km=${d.ytd.distance_km}`);
  } catch (error) {
    fail(name, throwSummary(error));
  }
}

await checkListActivities();
await checkGetActivity();
await checkGetActivityStreams();
await checkListGear();
await checkGetWellness();
await checkGetActivityLaps();
await checkGetRunningSummary();
await checkGetActivityZones();
await checkCompareActivities();
await checkGetHillAnalysis();
await checkGetSplitAnalysis();
await checkGetAerobicAnalysis();
await checkGetIntervalAnalysis();
await checkGetBestEfforts();
await checkGetRacePrediction();
await checkGetAthleteStats();

if (failures > 0) {
  console.log(`${failures} tool(s) failed.`);
  process.exit(1);
}
console.log("All tools ok.");
