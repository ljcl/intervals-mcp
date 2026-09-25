import { z } from "zod";
import {
  cadenceUnit,
  formatLapLine,
  type LapEntry,
  mapIntervalsToLaps,
} from "../intervalLaps";
import { getActivity as getActivityClient } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { ActivityLapsOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-activity-laps";

const description = `
Returns one intervals.icu activity's laps, derived from its interval breakdown; use after list-activities or get-activity.

intervals.icu has no separate lap list: its intervals (icu_intervals) are
what this tool reports as laps, and usually mirror the device's own laps,
typically one WORK interval per lap, sometimes with a short RECOVERY
inserted between them. Works for any sport. Runs report pace (min/km) and
grade-adjusted pace (GAP); other distance sports report speed (km/h).
Cadence is spm (doubled from strides) for Run/TrailRun/VirtualRun/Walk/Hike,
rpm otherwise.

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")

Notes:
- The interval count can differ from the device's recorded lap count
  (device_lap_count, from icu_lap_count) when intervals.icu edited or split
  laps (intervals_edited, from icu_intervals_edited); both are in the
  response, and the text flags it when either applies
- An activity with no intervals returns a valid payload with lap_count: 0
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetActivityLapsInput = z.infer<typeof inputSchema>;

interface ActivityLapsResponse {
  activity_id: string;
  activity_name: string;
  sport_type: string;
  lap_count: number;
  lap_source: "intervals.icu intervals";
  device_lap_count: number | null;
  intervals_edited: boolean | null;
  units: {
    distance: "km";
    pace: "min/km";
    speed: "km/h";
    time: "s";
    hr: "bpm";
    elevation: "m";
    cadence: "spm" | "rpm";
    gradient: "%";
  };
  laps: LapEntry[];
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatActivityLapsText(response: ActivityLapsResponse): string {
  const lines = [
    `${response.sport_type} laps for "${response.activity_name}" [${response.activity_id}]`,
  ];

  if (response.lap_count === 0) {
    lines.push("No intervals recorded for this activity.");
    return lines.join("\n");
  }

  lines.push(
    `${response.lap_count} laps from ${response.lap_source} (usually the device's own laps)`,
  );

  const flags: string[] = [];
  if (response.intervals_edited)
    flags.push("intervals were edited in intervals.icu");
  if (
    response.device_lap_count != null &&
    response.device_lap_count !== response.lap_count
  ) {
    flags.push(
      `the device recorded ${response.device_lap_count} laps, not ${response.lap_count}`,
    );
  }
  if (flags.length > 0) lines.push(`Note: ${flags.join("; ")}.`);

  for (const lap of response.laps)
    lines.push(formatLapLine(lap, response.units.cadence));

  return lines.join("\n");
}

export const getActivityLapsTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: ActivityLapsOutputSchema,
  execute: async (
    { id }: GetActivityLapsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching laps for activity ${id}`);
      const activity = await getActivityClient(apiKey, id, {
        intervals: true,
      });

      const sportType = activity.type ?? "Workout";
      const intervals = activity.icu_intervals ?? [];
      const laps = mapIntervalsToLaps(activity, intervals);

      const response: ActivityLapsResponse = {
        activity_id: activity.id,
        activity_name: activity.name ?? sportType,
        sport_type: sportType,
        lap_count: laps.length,
        lap_source: "intervals.icu intervals",
        device_lap_count: activity.icu_lap_count ?? null,
        intervals_edited: activity.icu_intervals_edited ?? null,
        units: {
          distance: "km",
          pace: "min/km",
          speed: "km/h",
          time: "s",
          hr: "bpm",
          elevation: "m",
          cadence: cadenceUnit(sportType),
          gradient: "%",
        },
        laps,
      };

      warnOnSchemaDrift(name, ActivityLapsOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatActivityLapsText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch laps for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
