import { z } from "zod";
import { round } from "../formatters";
import {
  type IntervalsActivityFilter,
  type IntervalsGear,
  type IntervalsGearReminder,
  listGear as listGearClient,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { isGearRetired } from "../utils/activityWrite";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { GearListOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "list-gear";

const description = `
Lists the athlete's intervals.icu gear (shoes) with total distance, activity
count, purchase date, notes, retirement status, usage reminders and
auto-assign rules. Use it to see which shoes are racking up mileage, to find
a gear id for update-activity, or a gear or reminder id for update-gear.

Notes:
- Retired gear is left out unless includeRetired is true.
- Auto-assign rules are why intervals.icu puts the gear on some new
  activities and not others.
- distance_km includes any starting distance entered when the item was added,
  not only distance from activities.
`;

const inputSchema = z.object({
  includeRetired: z
    .boolean()
    .default(false)
    .describe("Include retired gear. Default false."),
});

type ListGearInput = z.infer<typeof inputSchema>;

export interface GearReminderEntry {
  /** The id update-gear's resetReminderId takes. */
  id?: number;
  name: string | null;
  distance_km?: number;
  distance_used_km?: number;
  last_reset?: string | null;
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
  purchased: string | null;
  notes: string | null;
  reminders: GearReminderEntry[];
  auto_assign: GearAutoAssignRule[];
}

/** One auto-assign rule: new activities whose `field` matches `value` get
 * the gear. */
export interface GearAutoAssignRule {
  field: string | null;
  operator: string | null;
  value: unknown;
  not: boolean;
}

/** True for retired gear, by `isGearRetired`'s rule: `null`, `false` and
 * `""` (what un-retiring writes, docs/api-notes.md) all mean in use. */
export function isRetired(gear: IntervalsGear): boolean {
  return isGearRetired(gear.retired);
}

/**
 * Maps one raw reminder. `id`, `distance`, `distance_used`, `days`,
 * `last_reset` and `percent_used` are fields the OpenAPI spec's
 * `GearReminder` documents, converted to `id`/`distance_km`/
 * `distance_used_km`/`days`/`last_reset`/`percent_used`; any other numeric
 * field the API sends (the real account has none to verify the shape
 * against) passes through under its own key rather than being silently
 * dropped. Exported for direct testing.
 */
export function mapGearReminder(
  reminder: IntervalsGearReminder,
): GearReminderEntry {
  const {
    id,
    name,
    distance,
    distance_used,
    days,
    last_reset,
    percent_used,
    ...rest
  } = reminder as Record<string, unknown> & IntervalsGearReminder;
  const entry: GearReminderEntry = {
    name: typeof name === "string" ? name : null,
  };
  if (typeof id === "number") entry.id = id;
  if (typeof distance === "number")
    entry.distance_km = round(distance / 1000, 1);
  if (typeof distance_used === "number")
    entry.distance_used_km = round(distance_used / 1000, 1);
  if (typeof days === "number") entry.days = days;
  if (last_reset !== undefined) entry.last_reset = last_reset ?? null;
  if (typeof percent_used === "number") entry.percent_used = percent_used;
  // Only numeric extras are carried through; a non-numeric unknown field
  // (string, boolean, object) is intentionally dropped rather than passed
  // raw, since the output schema's catchall only models numeric values.
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "number") entry[key] = value;
  }
  return entry;
}

/** `2026-09-01T00:00:00` and `2026-09-24` both become YYYY-MM-DD; the API
 * sends either (docs/api-notes.md). Anything else passes through. */
function toDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function mapAutoAssignRule(rule: IntervalsActivityFilter): GearAutoAssignRule {
  return {
    field: rule.field_id ?? null,
    operator: rule.operator ?? null,
    value: rule.value ?? null,
    not: rule.not === true,
  };
}

/** Maps one raw intervals.icu gear item to the compact entry. Exported for direct testing. */
export function mapGear(gear: IntervalsGear): GearEntry {
  return {
    id: gear.id,
    name: gear.name ?? "Gear",
    type: gear.type ?? "Equipment",
    distance_km: round((gear.distance ?? 0) / 1000, 1),
    activities: gear.activities ?? 0,
    retired: isRetired(gear) ? (gear.retired ?? null) : null,
    purchased: toDate(gear.purchased),
    notes: gear.notes || null,
    reminders: (gear.reminders ?? []).map(mapGearReminder),
    auto_assign: (gear.activity_filters ?? []).map(mapAutoAssignRule),
  };
}

interface GearListResponse {
  count: number;
  units: { distance: "km" };
  gear: GearEntry[];
}

const EMPTY_TEXT =
  "No gear in intervals.icu. Add shoes on the intervals.icu Gear page to track mileage.";

/** "type Run", "type not Run, Walk": one rule as text. */
function formatAutoAssignRule(rule: GearAutoAssignRule): string {
  const value = Array.isArray(rule.value)
    ? rule.value.join(", ")
    : String(rule.value ?? "");
  const parts = [rule.field ?? "?"];
  if (rule.not) parts.push("not");
  if (rule.operator) parts.push(rule.operator);
  if (value) parts.push(value);
  return parts.join(" ");
}

/** '  reminder 3 "New shoes": 700.0 km, 210.4 km used (30%)'. */
function formatReminderLine(r: GearReminderEntry): string {
  const label = r.id !== undefined ? `reminder ${r.id}` : "reminder";
  const parts: string[] = [];
  if (r.distance_km !== undefined && r.distance_km > 0)
    parts.push(`${r.distance_km.toFixed(1)} km`);
  if (r.days !== undefined && r.days > 0) parts.push(`${r.days} days`);
  if (r.distance_used_km !== undefined) {
    const percent =
      r.percent_used !== undefined ? ` (${Math.round(r.percent_used)}%)` : "";
    parts.push(`${r.distance_used_km.toFixed(1)} km used${percent}`);
  } else if (r.percent_used !== undefined) {
    parts.push(`${Math.round(r.percent_used)}% used`);
  }
  const name = r.name ? ` "${r.name}"` : "";
  return `  ${label}${name}: ${parts.length > 0 ? parts.join(", ") : "no limit"}`;
}

function formatGearLine(g: GearEntry): string {
  const parts: string[] = [
    `${g.distance_km.toFixed(1)} km`,
    `${g.activities} activities`,
  ];
  if (g.purchased) parts.push(`purchased ${g.purchased}`);
  if (g.retired !== null && g.retired !== false) {
    parts.push(
      typeof g.retired === "string"
        ? `retired ${toDate(g.retired)}`
        : "retired",
    );
  }
  if (g.auto_assign.length > 0) {
    parts.push(
      `auto-assign: ${g.auto_assign.map(formatAutoAssignRule).join("; ")}`,
    );
  }
  const lines = [`${g.name} (${g.type}): ${parts.join(", ")} [${g.id}]`];
  if (g.notes) lines.push(`  notes: ${g.notes}`);
  for (const r of g.reminders) lines.push(formatReminderLine(r));
  return lines.join("\n");
}

/**
 * Builds the tool's text response. `retiredHiddenCount` is the number of
 * items `includeRetired: false` filtered out before `response` was built
 * (0 when `includeRetired` was true, or when nothing was filtered), so an
 * account that does have gear but only retired gear gets a message that says
 * so, rather than the account-has-no-gear message. Exported for direct
 * testing.
 */
export function formatGearListText(
  response: GearListResponse,
  retiredHiddenCount = 0,
): string {
  if (response.count === 0) {
    return retiredHiddenCount > 0
      ? `No active gear (${retiredHiddenCount} retired hidden; pass includeRetired: true to show them).`
      : EMPTY_TEXT;
  }
  const lines = [`Gear: ${response.count}`];
  for (const g of response.gear) lines.push(formatGearLine(g));
  return lines.join("\n");
}

export const listGearTool = {
  name,
  title: "List gear",
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
      const retiredHiddenCount = gear.length - filtered.length;
      const mapped = filtered.map(mapGear);

      const response: GearListResponse = {
        count: mapped.length,
        units: { distance: "km" },
        gear: mapped,
      };

      warnOnSchemaDrift(name, GearListOutputSchema, response);

      return {
        content: [
          {
            type: "text" as const,
            text: formatGearListText(response, retiredHiddenCount),
          },
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
