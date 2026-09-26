import { z } from "zod";
import { round } from "../formatters";
import {
  getActivity as getActivityClient,
  type IntervalsActivity,
} from "../intervalsClient";
import {
  type IntervalsStreams,
  IntervalsStreamsUnavailableError,
  type IntervalsStreamType,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { downsampleColumns, lastValuePerBucket } from "../streamDownsample";
import { cadenceSpm, isStepCadenceActivity } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { ActivityStreamsOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-activity-streams";

const STREAM_TYPES = [
  "time",
  "distance",
  "heartrate",
  "cadence",
  "velocity_smooth",
  "altitude",
  "latlng",
  "watts",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
] as const;

export type StreamType = (typeof STREAM_TYPES)[number];

const DEFAULT_TYPES: StreamType[] = [
  "time",
  "distance",
  "heartrate",
  "cadence",
  "velocity_smooth",
  "altitude",
];

const description = `
Returns time-series streams for one activity (heart rate, speed, cadence,
altitude, GPS track, power and running dynamics), downsampled to at most
maxPoints per stream, as index-aligned arrays with a unit per type. The text
repeats the data as a CSV block.

Use it only when you need the raw series: the analysis tools already turn
streams into answers (get-split-analysis for km splits, get-hill-analysis for
climbs, get-interval-analysis for reps, get-aerobic-analysis for decoupling),
and view-activity-chart shows them. Ask only for the types you need: a high
maxPoints with many types makes a very large response.

Notes:
- Each downsampled point is its bucket's mean, except time, distance and
  latlng, which take the bucket's last sample.
- A missing sample is null. A heart-rate dropout (the sensor lost contact)
  is null too, never 0 bpm, and a bucket mean skips it.
- time is always fetched but only returned when requested.
- A requested type the activity lacks is listed in missing, not an error.
- Cadence is steps per minute (spm) for Run, TrailRun, VirtualRun, Walk and
  Hike, rpm otherwise.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
  types: z
    .array(z.enum(STREAM_TYPES))
    .min(1)
    .default(DEFAULT_TYPES)
    .describe(`Stream types to return. Default: ${DEFAULT_TYPES.join(", ")}.`),
  maxPoints: z
    .number()
    .int()
    .min(10)
    .max(2000)
    .default(120)
    .describe(
      "Cap on points per stream after downsampling, 10 to 2000. Default 120.",
    ),
});

type GetActivityStreamsInput = z.infer<typeof inputSchema>;

/** Decimal places each non-latlng stream is rounded to in the response. */
const DECIMALS: Record<Exclude<StreamType, "latlng">, number> = {
  time: 0,
  distance: 1,
  heartrate: 0,
  cadence: 0,
  velocity_smooth: 2,
  altitude: 1,
  watts: 0,
  stance_time: 1,
  vertical_oscillation: 1,
  vertical_ratio: 2,
  step_length: 0,
};

/**
 * Default per-type unit. `cadence`'s default ("spm") applies only when the
 * activity is a step-cadence type; {@link buildActivityStreamsResult}
 * overrides it to "rpm" otherwise (see {@link isStepCadenceActivity}).
 */
const UNITS: Record<StreamType, string> = {
  time: "s",
  distance: "m",
  heartrate: "bpm",
  cadence: "spm",
  velocity_smooth: "m/s",
  altitude: "m",
  latlng: "deg",
  watts: "W",
  stance_time: "ms",
  vertical_oscillation: "mm",
  vertical_ratio: "%",
  step_length: "mm",
};

const LATLNG_DECIMALS = 5;

export type StreamValue = number | null | [number, number];

export interface ActivityStreamsResult {
  activity_id: string;
  type: string;
  original_points: number;
  returned_points: number;
  requested: StreamType[];
  missing: StreamType[];
  units: Record<string, string>;
  streams: Record<string, StreamValue[]>;
}

/**
 * Downsamples `loaded` (the streams as `loadIntervalsStreams` returns them,
 * so a heart-rate dropout is already `null`) to at most `maxPoints` points
 * per requested stream, and shapes the result into the tool's compact
 * column format. Pure: no I/O. Exported for direct testing.
 */
export function buildActivityStreamsResult(
  activity: IntervalsActivity,
  loaded: IntervalsStreams,
  requestedTypes: StreamType[],
  maxPoints: number,
): ActivityStreamsResult {
  const type = activity.type ?? "Workout";
  const cadenceUnit = isStepCadenceActivity(type) ? "spm" : "rpm";

  const originalPoints = loaded.length;

  const missing = requestedTypes.filter((t) => loaded[t] === undefined);

  // Scalar columns (everything but latlng, which isn't a single numeric
  // array) for downsampleColumns. `time` is always included internally, even
  // when not requested, so returned_points can be read off any column and
  // the bucket boundaries used for latlng below line up with it.
  const columns: Record<string, (number | null)[]> = {};
  for (const t of requestedTypes) {
    if (t === "latlng") continue;
    const values = loaded[t];
    if (values) columns[t] = values;
  }
  if (!("time" in columns)) columns.time = loaded.time;

  const downsampled = downsampleColumns(columns, maxPoints);
  const returnedPoints =
    Object.values(downsampled)[0]?.length ??
    Math.min(originalPoints, maxPoints);

  const streams: Record<string, StreamValue[]> = {};

  for (const t of requestedTypes) {
    if (t === "latlng") {
      const pairs = loaded.latlng;
      if (!pairs) continue;
      const lat = lastValuePerBucket(
        pairs.map((pair) => pair?.[0] ?? null),
        maxPoints,
      );
      const lng = lastValuePerBucket(
        pairs.map((pair) => pair?.[1] ?? null),
        maxPoints,
      );
      streams.latlng = lat.map((la, i): StreamValue => {
        const lo = lng[i] ?? null;
        if (la == null || lo == null) return null;
        return [round(la, LATLNG_DECIMALS), round(lo, LATLNG_DECIMALS)];
      });
      continue;
    }

    const values = downsampled[t];
    if (!values) continue;
    const decimals = DECIMALS[t];
    streams[t] = values.map((v): StreamValue => {
      if (v == null) return null;
      const scaled = t === "cadence" ? (cadenceSpm(v, type) ?? v) : v;
      return round(scaled, decimals);
    });
  }

  return {
    activity_id: activity.id,
    type,
    original_points: originalPoints,
    returned_points: returnedPoints,
    requested: requestedTypes,
    missing,
    units: Object.fromEntries(
      Object.keys(streams).map((t) => [
        t,
        t === "cadence" ? cadenceUnit : UNITS[t as StreamType],
      ]),
    ),
    streams,
  };
}

/**
 * `units` is the result's own per-type unit map, not the static `UNITS`
 * constant: `cadence`'s actual unit depends on the activity type (`spm` for
 * a step-cadence type, `rpm` otherwise, see `buildActivityStreamsResult`),
 * and reading it from the static table here would print "spm" on a Ride's
 * summary line even though its CSV column and structuredContent both say
 * "rpm".
 */
function statsLine(
  type: StreamType,
  values: StreamValue[],
  units: Record<string, string>,
): string | null {
  if (type === "latlng") {
    const count = values.filter((v) => v != null).length;
    return count > 0 ? `latlng: ${count} points` : null;
  }

  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((sum, v) => sum + v, 0) / nums.length;
  return `${type}: ${round(min, 2)}-${round(max, 2)} ${units[type]} (avg ${round(avg, 2)})`;
}

/**
 * Header names and value-producing types for the CSV block, in `requested`
 * order, restricted to types actually present in `streams` (a `missing` type
 * has no column). `latlng` expands into two columns, `lat` and `lng`, since
 * it isn't a single scalar value; every other type's header is
 * `type_unit` (e.g. `heartrate_bpm`).
 */
function csvColumns(
  requestedTypes: StreamType[],
  streams: Record<string, StreamValue[]>,
  units: Record<string, string>,
): { header: string[]; types: StreamType[] } {
  const header: string[] = [];
  const types: StreamType[] = [];
  for (const t of requestedTypes) {
    if (!(t in streams)) continue;
    types.push(t);
    if (t === "latlng") {
      header.push("lat", "lng");
    } else {
      const unit = units[t];
      header.push(unit ? `${t}_${unit}` : t);
    }
  }
  return { header, types };
}

/**
 * Renders the returned columns as a compact CSV block: a header row, then
 * one row per point. A host may pass only a tool call's `content` text to
 * the model and drop `structuredContent` entirely, so the stream data has to
 * be readable from the text response too -- this is that. Empty (`[]`) when
 * every requested type is missing, so the caller can skip the block
 * entirely rather than emit a header with no rows.
 */
function buildCsvLines(result: ActivityStreamsResult): string[] {
  const { header, types } = csvColumns(
    result.requested,
    result.streams,
    result.units,
  );
  if (types.length === 0) return [];

  const rows: string[] = [header.join(",")];
  for (let i = 0; i < result.returned_points; i += 1) {
    const cells: string[] = [];
    for (const t of types) {
      const value = result.streams[t]?.[i] ?? null;
      if (t === "latlng") {
        const pair = value as [number, number] | null;
        cells.push(pair ? String(pair[0]) : "", pair ? String(pair[1]) : "");
      } else {
        cells.push(value == null ? "" : String(value));
      }
    }
    rows.push(cells.join(","));
  }
  return rows;
}

/**
 * Builds the tool's text response: summary lines, then a CSV block of the
 * actual returned columns (see {@link buildCsvLines}) -- some hosts pass
 * only this text to the model, never `structuredContent`. Exported for
 * direct testing.
 */
export function formatActivityStreamsText(
  result: ActivityStreamsResult,
): string {
  const lines = [
    `${result.activity_id} ${result.type}: ${result.returned_points} of ${result.original_points} points, ${result.requested.length} types`,
  ];

  for (const t of result.requested) {
    const values = result.streams[t];
    if (!values) continue;
    const line = statsLine(t, values, result.units);
    if (line) lines.push(line);
  }

  if (result.missing.length > 0)
    lines.push(`missing: ${result.missing.join(", ")}`);

  const csv = buildCsvLines(result);
  if (csv.length > 0) {
    lines.push("", "CSV:", ...csv);
  }

  return lines.join("\n");
}

export const getActivityStreamsTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: ActivityStreamsOutputSchema,
  execute: async (
    { id, types, maxPoints }: GetActivityStreamsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivityClient(apiKey, id);

      const typesToFetch = Array.from(
        new Set<IntervalsStreamType>([...types, "time"]),
      );
      progress(`Fetching streams for activity ${id}`);
      let streams: IntervalsStreams;
      try {
        streams = await loadIntervalsStreams(apiKey, id, typesToFetch);
      } catch (error) {
        if (error instanceof IntervalsStreamsUnavailableError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ Activity ${id} has no data streams.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      const result = buildActivityStreamsResult(
        activity,
        streams,
        types,
        maxPoints,
      );
      warnOnSchemaDrift(name, ActivityStreamsOutputSchema, result);

      return {
        content: [
          { type: "text" as const, text: formatActivityStreamsText(result) },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch activity streams for ${id}`,
              notFound: `Activity ${id} was not found, or has no data streams.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
