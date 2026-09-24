import { type ZoneSet } from "@intervals-mcp/data";
import { z } from "zod";
import { hrZoneMismatchWarning, mapIntervalsZones } from "../activityZones";
import { formatDuration } from "../formatters";
import { getActivity } from "../intervalsClient";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { ActivityZonesOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-activity-zones";

const description = `
Retrieves the time-in-zone distribution for a specific intervals.icu
activity: how long it spent in each heart rate and/or power zone, using the
activity's own recorded zone bounds (not the athlete's current sport
settings).

Use Cases:
- See how a workout was distributed across HR or power zones
- Quantify time spent in each training zone for a single activity
- Compare effort distribution between activities

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")

Notes:
- Not all activities have zone data (e.g. no HR or power sensor, or the
  activity carries no recorded zone bounds); those return a message and an
  empty zone_sets list, not an error
- Power zones are included only when the activity recorded both zone bounds
  and zone times; pace zones are not covered by this tool
- If HR zone bounds and zone times were recorded with different zone
  counts, heart rate is omitted and the text response says so
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetActivityZonesInput = z.infer<typeof inputSchema>;

const ZONE_META: Record<ZoneSet["type"], string> = {
  heartrate: "Heart Rate Zones",
  power: "Power Zones",
};

function formatZoneSet(set: ZoneSet): string {
  const lines = set.buckets.map(
    (bucket) =>
      `   Z${bucket.zone} (${bucket.min}–${bucket.max} ${set.unit}): ${formatDuration(bucket.seconds)} (${bucket.pct}%)`,
  );
  return `**${ZONE_META[set.type]}**\n${lines.join("\n")}`;
}

/**
 * Builds the human-readable per-zone summary for an activity's mapped zone
 * sets. Exported for direct testing.
 */
export function formatActivityZones(zoneSets: ZoneSet[]): string {
  return zoneSets.map(formatZoneSet).join("\n\n");
}

export const getActivityZonesTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: ActivityZonesOutputSchema,
  execute: async ({ id }: GetActivityZonesInput, apiKey: string) => {
    try {
      const activity = await getActivity(apiKey, id);
      const zoneSets = mapIntervalsZones(activity);
      const warning = hrZoneMismatchWarning(activity);

      const units = { heartrate: "bpm" as const, power: "W" as const };

      if (zoneSets.length === 0) {
        const empty = { activity_id: id, zone_sets: [], units };
        warnOnSchemaDrift(
          "get-activity-zones",
          ActivityZonesOutputSchema,
          empty,
        );
        const lines = [`No zone data found for activity ID: ${id}`];
        if (warning) lines.push(warning);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: empty,
        };
      }

      const summaryLines = [
        `**Activity Zones (ID: ${id}):**`,
        "",
        formatActivityZones(zoneSets),
      ];
      if (warning) summaryLines.push("", warning);

      // Same mapper the activity-zones app reads (`mapIntervalsZones`), so
      // the structured payload and the chart cannot describe different
      // zones.
      const structured = {
        activity_id: id,
        zone_sets: zoneSets.map((set) => ({
          type: set.type,
          sensor_based: set.sensorBased,
          total_seconds: set.totalSeconds,
          buckets: set.buckets,
        })),
        units,
      };
      warnOnSchemaDrift(
        "get-activity-zones",
        ActivityZonesOutputSchema,
        structured,
      );

      // The summary is the only text block: `structuredContent` is the
      // machine-readable copy, and a pretty-printed dump of the raw response
      // alongside it only cost the model tokens.
      return {
        content: [{ type: "text" as const, text: summaryLines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch zones for activity ${id}`,
              notFound: `Activity with ID ${id} not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
