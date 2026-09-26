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
Returns one intervals.icu activity's heart rate time in zone: time and
percent in each zone, from the activity's own recorded zone bounds (not
today's sport settings).

get-activity and get-running-summary already include HR zone time. Use this
tool when zones are all you need, or to compare zone distribution between
activities; use view-activity-zones to show it as a chart.

Notes:
- Power and pace zones are not covered.
- An activity with no zone data (no HR sensor, no recorded bounds) returns an
  empty zone_sets list and a message, not an error.
- If the zone bounds and zone times have different zone counts, heart rate is
  left out and the text says so.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetActivityZonesInput = z.infer<typeof inputSchema>;

const ZONE_META: Partial<Record<ZoneSet["type"], string>> = {
  heartrate: "Heart Rate Zones",
};

function formatZoneSet(set: ZoneSet): string {
  const lines = set.buckets.map(
    (bucket) =>
      `   Z${bucket.zone} (${bucket.min}-${bucket.max} ${set.unit}): ${formatDuration(bucket.seconds)} (${bucket.pct}%)`,
  );
  return `${ZONE_META[set.type] ?? set.type}\n${lines.join("\n")}`;
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

      const units = { heartrate: "bpm" as const };

      if (zoneSets.length === 0) {
        const empty = { activity_id: activity.id, zone_sets: [], units };
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
        `Activity Zones (ID: ${id}):`,
        "",
        formatActivityZones(zoneSets),
      ];
      if (warning) summaryLines.push("", warning);

      // Same mapper the activity-zones app reads (`mapIntervalsZones`), so
      // the structured payload and the chart cannot describe different
      // zones.
      const structured = {
        activity_id: activity.id,
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
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
