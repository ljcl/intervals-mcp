import { z } from "zod";
import {
  type IntervalsGear,
  type IntervalsGearReminder,
  listGear as listGearClient,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { GearListOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "list-gear";

const description = `
Lists the athlete's intervals.icu gear (shoes) with mileage and retirement status.

Returns each item's total distance and activity count, plus any usage
reminders, so a caller can see which pair of shoes is racking up mileage
without opening the intervals.icu Gear page.

Parameters:
- includeRetired (optional): include retired gear. Default false

Notes:
- distance_km includes any starting distance entered in the UI when the item
  was added, not just distance logged through activities
`;

const inputSchema = z.object({
  includeRetired: z
    .boolean()
    .default(false)
    .describe("Include retired gear. Default false."),
});

type ListGearInput = z.infer<typeof inputSchema>;

const round = (value: number, decimals = 0) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export interface GearReminderEntry {
  name: string | null;
  distance_km?: number;
  days?: number;
  percent_used?: number;
  [key: string]: unknown;
}

export interface GearEntry {
  id: string;
  name: string;
  type: string;
  distance_km: number;
  activities: number;
  retired: string | boolean | null;
  reminders: GearReminderEntry[];
}

/** `retired` is `null` (or `false`) when the item is active; anything else marks it retired. */
export function isRetired(gear: IntervalsGear): boolean {
  return gear.retired != null && gear.retired !== false;
}

/**
 * Maps one raw reminder. `distance`, `days`, and `percent_used` are the
 * fields the OpenAPI spec's `GearReminder` documents, converted to
 * `distance_km`/`days`/`percent_used`; any other numeric field the API sends
 * (the real account has none to verify the shape against) passes through
 * under its own key rather than being silently dropped. Exported for direct
 * testing.
 */
export function mapGearReminder(
  reminder: IntervalsGearReminder,
): GearReminderEntry {
  const { name, distance, days, percent_used, ...rest } = reminder as Record<
    string,
    unknown
  > &
    IntervalsGearReminder;
  const entry: GearReminderEntry = {
    name: typeof name === "string" ? name : null,
  };
  if (typeof distance === "number")
    entry.distance_km = round(distance / 1000, 1);
  if (typeof days === "number") entry.days = days;
  if (typeof percent_used === "number") entry.percent_used = percent_used;
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "number") entry[key] = value;
  }
  return entry;
}

/** Maps one raw intervals.icu gear item to the compact entry. Exported for direct testing. */
export function mapGear(gear: IntervalsGear): GearEntry {
  return {
    id: gear.id,
    name: gear.name ?? "Gear",
    type: gear.type ?? "Equipment",
    distance_km: round((gear.distance ?? 0) / 1000, 1),
    activities: gear.activities ?? 0,
    retired: gear.retired ?? null,
    reminders: (gear.reminders ?? []).map(mapGearReminder),
  };
}

interface GearListResponse {
  count: number;
  units: { distance: "km" };
  gear: GearEntry[];
}

const EMPTY_TEXT =
  "No gear in intervals.icu. Add shoes on the intervals.icu Gear page to track mileage.";

function formatGearLine(g: GearEntry): string {
  const parts: string[] = [
    `${g.distance_km.toFixed(1)} km`,
    `${g.activities} activities`,
  ];
  if (g.retired != null && g.retired !== false) parts.push("retired");
  if (g.reminders.length > 0) {
    const noun = g.reminders.length === 1 ? "reminder" : "reminders";
    parts.push(`${g.reminders.length} ${noun}`);
  }
  return `${g.name} (${g.type}): ${parts.join(", ")} [${g.id}]`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatGearListText(response: GearListResponse): string {
  if (response.count === 0) return EMPTY_TEXT;
  const lines = [`Gear: ${response.count}`];
  for (const g of response.gear) lines.push(formatGearLine(g));
  return lines.join("\n");
}

export const listGearTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: GearListOutputSchema,
  execute: async (
    { includeRetired }: ListGearInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress("Fetching gear");
      const gear = await listGearClient(apiKey);
      const filtered = includeRetired
        ? gear
        : gear.filter((g) => !isRetired(g));
      const mapped = filtered.map(mapGear);

      const response: GearListResponse = {
        count: mapped.length,
        units: { distance: "km" },
        gear: mapped,
      };

      warnOnSchemaDrift(name, GearListOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatGearListText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, { context: "list gear" }),
          },
        ],
        isError: true,
      };
    }
  },
};
