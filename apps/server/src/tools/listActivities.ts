import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration, STRAVA_STUB_NOTE } from "../formatters";
import {
  type IntervalsActivity,
  listActivities as listActivitiesClient,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  addDays,
  dateInputSchema,
  todayLocal,
  validateRange,
} from "../utils/localDate";
import { isPaceActivity, paceFromDistanceTime } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { ActivityListOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "list-activities";

const description = `
Lists intervals.icu activities in a local date range; start here to find activity ids for the other tools.

Returns a compact, date-bounded activity list with units, sorted newest
first. Each entry carries the id the other tools need, plus distance, time,
pace (runs only), heart rate, and training load.

Parameters:
- oldest (optional): inclusive lower bound (YYYY-MM-DD). Defaults to newest minus 27 days
- newest (optional): inclusive upper bound (YYYY-MM-DD). Defaults to today
- type (optional): exact intervals.icu activity type, case-insensitive (e.g. "Run", "WeightTraining")
- nameContains (optional): case-insensitive substring match against the activity name
- limit (optional): max activities to return, 1 to 200 (default 30)

Notes:
- The date range cannot exceed 366 days
- An activity synced from Strava (source STRAVA) is a stub: intervals.icu has
  no detail for it through this API, only the summary fields this tool
  already returns
`;

const inputSchema = z.object({
  oldest: dateInputSchema
    .optional()
    .describe(
      "Inclusive lower bound (YYYY-MM-DD). Defaults to newest minus 27 days.",
    ),
  newest: dateInputSchema
    .optional()
    .describe("Inclusive upper bound (YYYY-MM-DD). Defaults to today."),
  type: z
    .string()
    .optional()
    .describe(
      'Exact intervals.icu activity type, case-insensitive (e.g. "Run", "WeightTraining").',
    ),
  nameContains: z
    .string()
    .optional()
    .describe("Case-insensitive substring match against the activity name."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(30)
    .describe("Max activities to return, 1 to 200 (default 30)."),
});

type ListActivitiesInput = z.infer<typeof inputSchema>;

const MAX_RANGE_DAYS = 366;

export interface ActivitySummaryEntry {
  id: string;
  date: string;
  start_local: string;
  type: string;
  name: string;
  distance_km: number | null;
  moving_time_s: number;
  moving_time: string;
  pace_min_per_km: string | null;
  average_hr: number | null;
  load: number | null;
  gear_id: string | null;
  source: string | null;
  is_strava_stub: boolean;
}

/** Maps one raw intervals.icu activity to the compact list entry. Exported for direct testing. */
export function mapActivitySummary(a: IntervalsActivity): ActivitySummaryEntry {
  const type = a.type ?? "Workout";
  const distanceM = a.distance ?? 0;
  const movingTimeS = a.moving_time ?? 0;

  const distanceKm =
    distanceM > 0 ? Math.round((distanceM / 1000) * 100) / 100 : null;

  const pace = isPaceActivity(type)
    ? paceFromDistanceTime(distanceM, movingTimeS)
    : null;

  return {
    id: a.id,
    date: a.start_date_local.split("T")[0] ?? a.start_date_local,
    start_local: a.start_date_local,
    type,
    name: a.name ?? type,
    distance_km: distanceKm,
    moving_time_s: movingTimeS,
    moving_time: formatDuration(movingTimeS),
    pace_min_per_km: pace,
    average_hr: a.average_heartrate ?? null,
    load: a.icu_training_load ?? null,
    gear_id: a.gear?.id ?? null,
    source: a.source ?? null,
    is_strava_stub: a.source === "STRAVA",
  };
}

interface ActivityListResponse {
  oldest: string;
  newest: string;
  count: number;
  matched: number;
  truncated: boolean;
  units: { distance: "km"; pace: "min/km"; time: "s"; hr: "bpm" };
  activities: ActivitySummaryEntry[];
}

function formatActivityLine(entry: ActivitySummaryEntry): string {
  const parts: string[] = [];
  if (entry.distance_km != null)
    parts.push(`${entry.distance_km.toFixed(2)} km`);
  parts.push(entry.moving_time);
  if (entry.pace_min_per_km != null) parts.push(`${entry.pace_min_per_km} /km`);
  if (entry.average_hr != null)
    parts.push(`HR ${Math.round(entry.average_hr)}`);
  if (entry.load != null) parts.push(`load ${Math.round(entry.load)}`);
  return `${entry.date} ${entry.type} ${entry.name}, ${parts.join(", ")} [${entry.id}]`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatActivityListText(response: ActivityListResponse): string {
  const { oldest, newest, count, matched, truncated } = response;
  const summary = truncated
    ? `showing ${count} of ${matched}, truncated`
    : `showing ${count} of ${matched}`;
  const lines = [`Activities ${oldest} to ${newest}: ${summary}`];

  for (const entry of response.activities)
    lines.push(formatActivityLine(entry));

  if (response.activities.some((entry) => entry.is_strava_stub)) {
    lines.push(STRAVA_STUB_NOTE);
  }

  return lines.join("\n");
}

export const listActivitiesTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: ActivityListOutputSchema,
  execute: async (
    {
      oldest: rawOldest,
      newest: rawNewest,
      type,
      nameContains,
      limit,
    }: ListActivitiesInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const tz = getTimeZone();
    const newest = rawNewest ?? todayLocal(tz);
    const oldest = rawOldest ?? addDays(newest, -27);

    const rangeError = validateRange(oldest, newest, MAX_RANGE_DAYS);
    if (rangeError) {
      return {
        content: [{ type: "text" as const, text: `❌ ${rangeError.message}` }],
        isError: true,
      };
    }

    try {
      progress(`Fetching activities ${oldest} to ${newest}`);
      const activities = await listActivitiesClient(apiKey, { oldest, newest });

      let filtered = activities;
      if (type) {
        const wanted = type.toLowerCase();
        filtered = filtered.filter(
          (a) => (a.type ?? "").toLowerCase() === wanted,
        );
      }
      if (nameContains) {
        const needle = nameContains.toLowerCase();
        filtered = filtered.filter((a) =>
          (a.name ?? "").toLowerCase().includes(needle),
        );
      }

      const matched = filtered.length;
      const truncated = matched > limit;
      const page = filtered.slice(0, limit).map(mapActivitySummary);

      const response: ActivityListResponse = {
        oldest,
        newest,
        count: page.length,
        matched,
        truncated,
        units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
        activities: page,
      };

      warnOnSchemaDrift(name, ActivityListOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatActivityListText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `list activities from ${oldest} to ${newest}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
