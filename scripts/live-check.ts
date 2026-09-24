/**
 * Live check: calls the five intervals.icu read tools' executors directly
 * against a real account, using the key from the root `.env`.
 *
 * Prints only a short summary per tool (ok/error plus a handful of numbers)
 * so this is safe to run and paste output from in a public repo. It never
 * prints the API key, and never prints a raw tool payload (names,
 * descriptions, comments, coordinates) since those are the athlete's data,
 * not ours to publish. No write calls are made.
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

async function checkListActivities(): Promise<void> {
  const name = "list-activities";
  const newest = "2026-09-24";
  const oldest = "2026-09-20";
  try {
    const result = (await listActivitiesTool.execute(
      { oldest, newest, limit: 30 },
      apiKey,
      NO_PROGRESS,
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    if (result.isError || !result.structuredContent) {
      fail(name, "tool returned isError");
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
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

async function checkGetActivity(): Promise<void> {
  const name = "get-activity";
  try {
    const result = (await getActivityTool.execute(
      { id: activityId, includeIntervals: true },
      apiKey,
      NO_PROGRESS,
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    if (result.isError || !result.structuredContent) {
      fail(name, "tool returned isError");
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
    fail(name, error instanceof Error ? error.message : String(error));
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
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    if (result.isError || !result.structuredContent) {
      fail(name, "tool returned isError");
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
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

async function checkListGear(): Promise<void> {
  const name = "list-gear";
  try {
    const result = (await listGearTool.execute(
      { includeRetired: false },
      apiKey,
      NO_PROGRESS,
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    if (result.isError || !result.structuredContent) {
      fail(name, "tool returned isError");
      return;
    }
    ok(name, `count=${result.structuredContent.count}`);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
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
    )) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    if (result.isError || !result.structuredContent) {
      fail(name, "tool returned isError");
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
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

await checkListActivities();
await checkGetActivity();
await checkGetActivityStreams();
await checkListGear();
await checkGetWellness();

if (failures > 0) {
  console.log(`${failures} tool(s) failed.`);
  process.exit(1);
}
console.log("All tools ok.");
