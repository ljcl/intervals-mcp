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
import {
  isPaceActivity,
  matchesTypeFilter,
  paceFromDistanceTime,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { RESPONSE_BUDGET_CHARS, responseSize } from "./_responseBudget";
import { ActivityListOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "list-activities";

const description = `
Lists intervals.icu activities in a local date range, newest first. Start
here: each entry carries the activity id that every per-activity tool needs,
plus distance, time, pace (runs only), heart rate and training load.

For the most recent run, call it with type "runs" and limit 1.

For run totals (this week, month, year) use get-athlete-stats instead of
adding up this list; for weekly volume trends, get-training-load.

Notes:
- Defaults to the last 28 days, ending today. A range cannot exceed 366 days.
- An activity synced from Strava (source STRAVA) is a stub: intervals.icu has
  no more detail for it through this API.
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
      'Activity type filter, case-insensitive: "runs" for Run, TrailRun and VirtualRun, one type ("Ride"), or a comma-separated list ("Run, Hike").',
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

/**
 * Builds the tool's text response. `budgetCut` says the page was cut below
 * `limit` to fit the response budget. Exported for direct testing.
 */
export function formatActivityListText(
  response: ActivityListResponse,
  budgetCut = false,
): string {
  const { oldest, newest, count, matched, truncated } = response;
  const summary = truncated
    ? `showing ${count} of ${matched}, truncated`
    : `showing ${count} of ${matched}`;
  const lines = [`Activities ${oldest} to ${newest}: ${summary}`];

  for (const entry of response.activities)
    lines.push(formatActivityLine(entry));

  if (budgetCut)
    lines.push(
      "Fewer than limit were returned to stay under the response size limit.",
    );
  // Newest first, so what was cut is older; name the call that fetches it.
  const oldestShown = response.activities.at(-1)?.date;
  if (truncated && oldestShown)
    lines.push(
      `For the ${matched - count} older matches, call again with oldest: ${oldest}, newest: ${oldestShown}.`,
    );

  if (response.activities.some((entry) => entry.is_strava_stub)) {
    lines.push(STRAVA_STUB_NOTE);
  }

  return lines.join("\n");
}

export const listActivitiesTool = {
  name,
  title: "List activities",
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
      const activities = await listActivitiesClient(
        apiKey,
        { oldest, newest },
        progress,
      );

      let filtered = activities;
      if (type) {
        filtered = filtered.filter((a) =>
          matchesTypeFilter(a.type ?? "", type),
        );
      }
      if (nameContains) {
        const needle = nameContains.toLowerCase();
        filtered = filtered.filter((a) =>
          (a.name ?? "").toLowerCase().includes(needle),
        );
      }

      const matched = filtered.length;
      const entries = filtered.map(mapActivitySummary);
      const build = (size: number): ActivityListResponse => {
        const page = entries.slice(0, size);
        return {
          oldest,
          newest,
          count: page.length,
          matched,
          truncated: matched > page.length,
          units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
          activities: page,
        };
      };

      // Held to the response budget like get-activity-streams: a year of
      // daily activities at limit 200 was 72 KB (#40). Each pass scales the
      // page by the measured overshoot.
      let size = limit;
      let response = build(size);
      let text = formatActivityListText(response);
      for (let pass = 0; pass < 5; pass += 1) {
        const chars = responseSize(text, response);
        if (chars <= RESPONSE_BUDGET_CHARS || size <= 1) break;
        size = Math.max(
          1,
          Math.min(
            response.count - 1,
            Math.floor(response.count * (RESPONSE_BUDGET_CHARS / chars) * 0.95),
          ),
        );
        response = build(size);
        text = formatActivityListText(response, true);
      }

      warnOnSchemaDrift(name, ActivityListOutputSchema, response);

      return {
        content: [{ type: "text" as const, text }],
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
