import { z } from "zod";
import { round } from "../formatters";
import {
  getActivity as getActivityClient,
  type IntervalsActivity,
  type IntervalsInterval,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  activityCadenceSpm,
  assessRunningDynamics,
  buildRunningDynamics,
  cadenceSpm,
  type DynamicsMetricAssessment,
  type DynamicsStatus,
  GCT_TARGET,
  isPaceActivity,
  isStepCadenceActivity,
  paceFromDistanceTime,
  paceSecPerKmFromDistanceTime,
  VO_TARGET,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { RunningDynamicsOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-running-dynamics";

const MAX_INTERVAL_LINES = 20;

const description = `
Returns one activity's running dynamics: ground contact time (GCT), vertical
oscillation (VO), vertical ratio, step length, stride and cadence. It gives
activity averages with a within/high/low status against common targets (VO
under 100 mm, GCT 200 to 260 ms), plus a row per WORK interval.

get-activity and get-running-summary already show the activity averages. Use
this tool for the per-interval rows and the status, for example to see
whether form held up across repeats.

Notes:
- Vertical ratio is a value only, with no status (under about 8% is commonly
  called efficient).
- Accepts any activity type. A type without step cadence (not Run, TrailRun,
  VirtualRun, Walk or Hike), or a device that recorded no dynamics, returns
  has_dynamics: false with a message, not an error.
- The text lists at most 20 intervals; structuredContent.intervals has all.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
  includeIntervals: z
    .boolean()
    .default(true)
    .describe("Include per-WORK-interval dynamics rows; default true"),
});

type GetRunningDynamicsInput = z.infer<typeof inputSchema>;

interface DynamicsMetricOutput {
  value: number | null;
  target: string;
  status: DynamicsStatus | null;
  message: string | null;
}

interface RunningDynamicsAverages {
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
  cadence_spm: number | null;
}

interface RunningDynamicsIntervalRow {
  lap_index: number;
  label: string | null;
  distance_km: number | null;
  pace_sec_per_km: number | null;
  pace_min_per_km: string | null;
  stance_time_ms: number | null;
  stance_time_status: DynamicsStatus | null;
  vertical_oscillation_mm: number | null;
  vertical_oscillation_status: DynamicsStatus | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
  cadence_spm: number | null;
}

interface RunningDynamicsUnits {
  stance_time: "ms";
  vertical_oscillation: "mm";
  vertical_ratio: "%";
  step_length: "mm";
  stride: "m";
  cadence: "spm";
  pace: "min/km";
}

const UNITS: RunningDynamicsUnits = {
  stance_time: "ms",
  vertical_oscillation: "mm",
  vertical_ratio: "%",
  step_length: "mm",
  stride: "m",
  cadence: "spm",
  pace: "min/km",
};

export interface RunningDynamicsResponse {
  activity_id: string;
  activity_name: string;
  type: string;
  has_dynamics: boolean;
  message: string | null;
  averages: RunningDynamicsAverages | null;
  assessments: {
    vertical_oscillation: DynamicsMetricOutput;
    ground_contact_time: DynamicsMetricOutput;
  } | null;
  intervals: RunningDynamicsIntervalRow[];
  units: RunningDynamicsUnits;
}

function toMetricOutput(
  value: number | null,
  target: string,
  assessment: DynamicsMetricAssessment | null,
): DynamicsMetricOutput {
  return {
    value,
    target,
    status: assessment?.status ?? null,
    message: assessment?.message ?? null,
  };
}

function mapIntervalRow(
  interval: IntervalsInterval,
  lapIndex: number,
  type: string,
): RunningDynamicsIntervalRow {
  const voMm =
    interval.average_vertical_oscillation == null
      ? null
      : round(interval.average_vertical_oscillation);
  const gctMs =
    interval.average_stance_time == null
      ? null
      : round(interval.average_stance_time);
  const rd = assessRunningDynamics(voMm, gctMs);
  const cadence = cadenceSpm(interval.average_cadence, type);

  return {
    lap_index: lapIndex,
    label: interval.label ?? null,
    distance_km:
      interval.distance != null ? round(interval.distance / 1000, 2) : null,
    pace_sec_per_km: isPaceActivity(type)
      ? paceSecPerKmFromDistanceTime(interval.distance, interval.moving_time)
      : null,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(interval.distance, interval.moving_time)
      : null,
    stance_time_ms: gctMs,
    stance_time_status: rd.ground_contact_time?.status ?? null,
    vertical_oscillation_mm: voMm,
    vertical_oscillation_status: rd.vertical_oscillation?.status ?? null,
    // Vertical ratio (VO as a percentage of stride length) has no target as
    // firm as VO/GCT's above, but under ~8% is commonly cited as efficient
    // (e.g. Garmin's vertical-ratio colour gauge): reported as a value
    // only, no status computed, per the spec.
    vertical_ratio_pct:
      interval.average_vertical_ratio == null
        ? null
        : round(interval.average_vertical_ratio, 1),
    step_length_mm:
      interval.average_step_length == null
        ? null
        : round(interval.average_step_length),
    stride_m:
      interval.average_stride == null
        ? null
        : round(interval.average_stride, 2),
    cadence_spm: cadence == null ? null : Math.round(cadence),
  };
}

/**
 * Maps one raw intervals.icu activity (with `icu_intervals` populated when
 * `includeIntervals`) into the running-dynamics response. Exported for
 * direct testing.
 */
export function mapRunningDynamics(
  activity: IntervalsActivity,
  includeIntervals: boolean,
): RunningDynamicsResponse {
  const type = activity.type ?? "Workout";
  const activityId = activity.id;
  const activityName = activity.name ?? type;

  if (!isStepCadenceActivity(type)) {
    return {
      activity_id: activityId,
      activity_name: activityName,
      type,
      has_dynamics: false,
      message: `${type} is not a step-cadence activity type; running dynamics apply to Run, TrailRun, VirtualRun, Walk and Hike only.`,
      averages: null,
      assessments: null,
      intervals: [],
      units: UNITS,
    };
  }

  const dyn = buildRunningDynamics(activity, type);
  if (!dyn) {
    return {
      activity_id: activityId,
      activity_name: activityName,
      type,
      has_dynamics: false,
      message:
        "This activity has no running dynamics recorded; the device did not report ground contact time or vertical oscillation.",
      averages: null,
      assessments: null,
      intervals: [],
      units: UNITS,
    };
  }

  const rd = assessRunningDynamics(
    dyn.vertical_oscillation_mm,
    dyn.stance_time_ms,
  );
  const cadence = activityCadenceSpm(activity.average_cadence, type);

  const averages: RunningDynamicsAverages = {
    stance_time_ms: dyn.stance_time_ms,
    vertical_oscillation_mm: dyn.vertical_oscillation_mm,
    vertical_ratio_pct: dyn.vertical_ratio_pct,
    step_length_mm: dyn.step_length_mm,
    stride_m: dyn.stride_m,
    cadence_spm: cadence,
  };

  const workRows = includeIntervals
    ? (activity.icu_intervals ?? [])
        .map((interval, index): [IntervalsInterval, number] => [
          interval,
          index + 1,
        ])
        .filter(([interval]) => interval.type === "WORK")
        .map(([interval, lapIndex]) => mapIntervalRow(interval, lapIndex, type))
    : [];

  return {
    activity_id: activityId,
    activity_name: activityName,
    type,
    has_dynamics: true,
    message: null,
    averages,
    assessments: {
      vertical_oscillation: toMetricOutput(
        dyn.vertical_oscillation_mm,
        VO_TARGET,
        rd.vertical_oscillation,
      ),
      ground_contact_time: toMetricOutput(
        dyn.stance_time_ms,
        GCT_TARGET,
        rd.ground_contact_time,
      ),
    },
    intervals: workRows,
    units: UNITS,
  };
}

function formatIntervalRow(row: RunningDynamicsIntervalRow): string {
  const parts: string[] = [];
  if (row.distance_km != null) parts.push(`${row.distance_km.toFixed(2)} km`);
  if (row.pace_min_per_km) parts.push(`${row.pace_min_per_km} /km`);
  if (row.stance_time_ms != null) {
    const status = row.stance_time_status ? ` (${row.stance_time_status})` : "";
    parts.push(`GCT ${row.stance_time_ms} ms${status}`);
  }
  if (row.vertical_oscillation_mm != null) {
    const status = row.vertical_oscillation_status
      ? ` (${row.vertical_oscillation_status})`
      : "";
    parts.push(`VO ${row.vertical_oscillation_mm} mm${status}`);
  }
  if (row.vertical_ratio_pct != null)
    parts.push(`VR ${row.vertical_ratio_pct}%`);
  if (row.step_length_mm != null) parts.push(`step ${row.step_length_mm} mm`);
  if (row.stride_m != null) parts.push(`stride ${row.stride_m} m`);
  if (row.cadence_spm != null) parts.push(`cadence ${row.cadence_spm} spm`);
  const label = row.label ?? `lap ${row.lap_index}`;
  return `${row.lap_index}. ${label}: ${parts.join(", ")}`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatRunningDynamicsText(d: RunningDynamicsResponse): string {
  const lines = [
    `${d.type} running dynamics for "${d.activity_name}" [${d.activity_id}]`,
  ];

  if (!d.has_dynamics) {
    lines.push(d.message ?? "No running dynamics available.");
    return lines.join("\n");
  }

  const a = d.averages;
  if (a) {
    const parts: string[] = [];
    if (a.stance_time_ms != null) parts.push(`GCT ${a.stance_time_ms} ms`);
    if (a.vertical_oscillation_mm != null)
      parts.push(`VO ${a.vertical_oscillation_mm} mm`);
    if (a.vertical_ratio_pct != null)
      parts.push(`vertical ratio ${a.vertical_ratio_pct}%`);
    if (a.step_length_mm != null)
      parts.push(`step length ${a.step_length_mm} mm`);
    if (a.stride_m != null) parts.push(`stride ${a.stride_m} m`);
    if (a.cadence_spm != null) parts.push(`cadence ${a.cadence_spm} spm`);
    if (parts.length > 0) lines.push(`Averages: ${parts.join(", ")}`);
  }

  if (d.assessments) {
    const parts: string[] = [];
    if (d.assessments.vertical_oscillation.message)
      parts.push(`VO ${d.assessments.vertical_oscillation.message}`);
    if (d.assessments.ground_contact_time.message)
      parts.push(`GCT ${d.assessments.ground_contact_time.message}`);
    if (parts.length > 0) lines.push(`Assessment: ${parts.join("; ")}`);
  }

  if (d.intervals.length > 0) {
    lines.push("WORK intervals:");
    const shown = d.intervals.slice(0, MAX_INTERVAL_LINES);
    for (const row of shown) lines.push(formatIntervalRow(row));
    const remaining = d.intervals.length - shown.length;
    if (remaining > 0) lines.push(`(${remaining} more)`);
  }

  return lines.join("\n");
}

export const getRunningDynamicsTool = {
  name,
  title: "Running dynamics",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: RunningDynamicsOutputSchema,
  execute: async (
    { id, includeIntervals }: GetRunningDynamicsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivityClient(apiKey, id, {
        intervals: true,
      });

      const response = mapRunningDynamics(activity, includeIntervals);
      warnOnSchemaDrift(name, RunningDynamicsOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatRunningDynamicsText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch running dynamics for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
