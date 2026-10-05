import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration, STRAVA_STUB_NOTE } from "../formatters";
import {
  type IntervalsActivity,
  listActivities as listActivitiesClient,
  searchActivities as searchActivitiesClient,
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
import { prefixedErrorText, toolErrorText } from "./_errors";
import { RESPONSE_BUDGET_CHARS, responseSize } from "./_responseBudget";
import { ActivityListOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "list-activities";

const description = `
Lists intervals.icu activities in a local date range, newest first. Start
here: each entry carries the activity id that every per-activity tool needs,
plus distance, time, pace (runs only), heart rate and training load.

For the most recent run, call it with type "runs" and limit 1.

search finds activities by name or #tag across all history, beyond the
366-day window (for example "when did I last run the club 10K?").

For run totals (this week, month, year) use get-athlete-stats instead of
adding up this list; for weekly volume trends, get-training-load.

Notes:
- Without search, defaults to the last 28 days ending today, and a range cannot exceed 366 days.
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
  search: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Search all history instead of a date window: a name substring (case-insensitive), or "#tag" for an exact tag. type, oldest and newest still filter the matches.',
    ),
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
/** The most matches search-full is asked for, and the cap the text warns about. */
const SEARCH_RESULT_CAP = 200;

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
  tags: string[];
  race: boolean;
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
    tags: a.tags ?? [],
    race: a.race ?? false,
  };
}

interface ActivityListResponse {
  oldest: string;
  newest: string;
  count: number;
  matched: number;
  truncated: boolean;
  search: string | null;
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

interface ListTextOptions {
  /** The page was cut below `limit` to fit the response budget. */
  budgetCut?: boolean;
  /** Scope shown in a search header; defaults to "all history". */
  windowLabel?: string;
  /** The caller gave `oldest` with a search, so a paging hint keeps it. */
  keepOldest?: boolean;
  /** The `type` filter in effect, repeated in the paging hint. */
  typeFilter?: string;
  /** Extra lines after the activities, before the budget and paging lines. */
  notes?: string[];
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatActivityListText(
  response: ActivityListResponse,
  options: ListTextOptions = {},
): string {
  const { oldest, newest, count, matched, truncated } = response;
  const summary = truncated
    ? `showing ${count} of ${matched}, truncated`
    : `showing ${count} of ${matched}`;
  const scope = response.search
    ? `Activities matching ${JSON.stringify(response.search)} (${options.windowLabel ?? "all history"})`
    : `Activities ${oldest} to ${newest}`;
  const lines = [`${scope}: ${summary}`];

  for (const entry of response.activities)
    lines.push(formatActivityLine(entry));

  for (const note of options.notes ?? []) lines.push(note);

  if (options.budgetCut)
    lines.push(
      "Fewer than limit were returned to stay under the response size limit.",
    );
  // Newest first, so what was cut is older; name the call that fetches it.
  const oldestShown = response.activities.at(-1)?.date;
  if (truncated && oldestShown) {
    const typePart = options.typeFilter
      ? `type: ${JSON.stringify(options.typeFilter)}, `
      : "";
    const call = response.search
      ? `search: ${JSON.stringify(response.search)}, ${typePart}${options.keepOldest ? `oldest: ${oldest}, ` : ""}newest: ${oldestShown}`
      : `${typePart}oldest: ${oldest}, newest: ${oldestShown}`;
    lines.push(
      `For the ${matched - count} older matches, call again with ${call}.`,
    );
  }

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
      search,
      limit,
    }: ListActivitiesInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const tz = getTimeZone();
    const today = todayLocal(tz);
    const notes: string[] = [];
    let oldest: string;
    let newest: string;
    let windowLabel: string | undefined;

    let rangeError: { message: string } | null;
    if (!search) {
      newest = rawNewest ?? today;
      oldest = rawOldest ?? addDays(newest, -27);
      rangeError = validateRange(oldest, newest, MAX_RANGE_DAYS);
    } else {
      // Provisional: a search sets the real span once the matches are known.
      oldest = rawOldest ?? today;
      newest = rawNewest ?? today;
      // No length cap, but a reversed window is still an error.
      rangeError =
        rawOldest && rawNewest
          ? validateRange(rawOldest, rawNewest, Number.POSITIVE_INFINITY)
          : null;
    }
    if (rangeError) {
      return {
        content: [
          {
            type: "text" as const,
            text: prefixedErrorText(rangeError.message),
          },
        ],
        isError: true,
      };
    }

    try {
      let activities: IntervalsActivity[];
      if (search) {
        // The window and nameContains do not apply: search reaches all
        // history, and oldest/newest only filter what it found.
        if (nameContains)
          notes.push(
            "nameContains is ignored with search; put the text in search.",
          );
        progress(`Searching activities for ${JSON.stringify(search)}`);
        const found = await searchActivitiesClient(
          apiKey,
          search,
          SEARCH_RESULT_CAP,
        );
        if (found.length >= SEARCH_RESULT_CAP)
          notes.push(
            `search returns at most ${SEARCH_RESULT_CAP} matches, the most recent first; narrow the query, or list a date window without search (oldest/newest, up to ${MAX_RANGE_DAYS} days) with nameContains to reach older ones.`,
          );
        activities = found.filter((a) => {
          const date = a.start_date_local.slice(0, 10);
          return (
            (!rawOldest || date >= rawOldest) &&
            (!rawNewest || date <= rawNewest)
          );
        });
      } else {
        progress(`Fetching activities ${oldest} to ${newest}`);
        activities = await listActivitiesClient(
          apiKey,
          { oldest, newest },
          progress,
        );
      }

      let filtered = activities;
      if (type) {
        filtered = filtered.filter((a) =>
          matchesTypeFilter(a.type ?? "", type),
        );
      }
      if (search) {
        // With no window given, the span is what the matches cover.
        const dates = filtered.map((a) => a.start_date_local.slice(0, 10));
        oldest = rawOldest ?? dates.at(-1) ?? today;
        newest = rawNewest ?? dates[0] ?? today;
        windowLabel =
          rawOldest || rawNewest ? `${oldest} to ${newest}` : "all history";
      }
      if (nameContains && !search) {
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
          search: search ?? null,
          units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
          activities: page,
        };
      };

      // Held to the response budget like get-activity-streams: a year of
      // daily activities at limit 200 was 72 KB (#40). Each pass scales the
      // page by the measured overshoot.
      let size = limit;
      let response = build(size);
      let text = formatActivityListText(response, {
        windowLabel,
        notes,
        keepOldest: Boolean(rawOldest),
        typeFilter: type,
      });
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
        text = formatActivityListText(response, {
          budgetCut: true,
          windowLabel,
          notes,
          keepOldest: Boolean(rawOldest),
          typeFilter: type,
        });
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
              context: search
                ? `search activities for ${JSON.stringify(search)}`
                : `list activities from ${oldest} to ${newest}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
