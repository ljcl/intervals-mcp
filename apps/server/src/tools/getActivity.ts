import { z } from "zod";
import { formatDuration, round, STRAVA_STUB_NOTE } from "../formatters";
import {
  getActivity as getActivityClient,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsInterval,
  type IntervalsSportSettings,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  cadenceSpm,
  gapPace,
  isPaceActivity,
  isStepCadenceActivity,
  paceFromDistanceTime,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { ActivityDetailOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-activity";

const description = `
Returns one intervals.icu activity in detail (metrics, load, HR zones, running dynamics, intervals); use after list-activities.

Returns core metrics, training load, HR zone time-in-zone, running dynamics
(for Run/TrailRun/VirtualRun/Walk/Hike activities with device support), the
WORK/RECOVERY interval breakdown, gear id (and name when the activity
payload carries one), and the description (truncated in the text response,
full in structured content), all with units.

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")
- includeIntervals (optional): include the interval breakdown; default true

Notes:
- An activity synced from Strava (source STRAVA) is a stub: intervals.icu has
  no detail for it through this API
- HR zones come from the athlete's Run sport settings group (types Run,
  VirtualRun, TrailRun); hr_zones is an empty array for any other activity
  type, including Walk/Hike, or if that settings group isn't configured,
  rather than failing the call
- The text response truncates description to 200 characters with a "..."
  marker; structuredContent.description is always the full text
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
  includeIntervals: z
    .boolean()
    .default(true)
    .describe("Include the WORK/RECOVERY interval breakdown. Default true."),
});

type GetActivityInput = z.infer<typeof inputSchema>;

const MAX_INTERVAL_LINES = 20;
/** Longest description shown in the text response, past which it is cut with an ellipsis marker. */
const DESCRIPTION_MAX_CHARS = 200;
const ELLIPSIS = "...";

interface ActivityLoad {
  training_load: number | null;
  hr_load: number | null;
  pace_load: number | null;
  trimp: number | null;
  intensity: number | null;
}

interface HrZoneEntry {
  zone: number;
  min_bpm: number | null;
  max_bpm: number | null;
  seconds: number;
}

interface RunningDynamics {
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
}

interface ActivityIntervalEntry {
  type: string | null;
  label: string | null;
  distance_km: number | null;
  moving_time_s: number | null;
  pace_min_per_km: string | null;
  average_hr: number | null;
  average_cadence_spm: number | null;
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  step_length_mm: number | null;
}

export interface ActivityDetail {
  id: string;
  name: string;
  type: string;
  date: string;
  start_local: string;
  source: string | null;
  is_strava_stub: boolean;
  device: string | null;
  distance_km: number | null;
  moving_time_s: number;
  moving_time: string;
  elapsed_time_s: number | null;
  pace_min_per_km: string | null;
  gap_min_per_km: string | null;
  average_hr: number | null;
  max_hr: number | null;
  average_cadence_spm: number | null;
  elevation_gain_m: number | null;
  load: ActivityLoad;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
  rpe: number | null;
  feel: number | null;
  hr_zones: HrZoneEntry[];
  pace_zone_seconds: number[] | null;
  running_dynamics: RunningDynamics | null;
  intervals: ActivityIntervalEntry[] | null;
  gear_id: string | null;
  /**
   * Resolved from the activity payload alone, never an extra `list-gear`
   * call: intervals.icu does not populate this on the activity today (see
   * docs/api-notes.md), so it is `null` in practice, but a future response
   * that does carry it is picked up here for free.
   */
  gear_name: string | null;
  weather_temp_c: number | null;
  description: string | null;
  units: {
    distance: "km";
    pace: "min/km";
    time: "s";
    hr: "bpm";
    elevation: "m";
    cadence: "spm";
    temp: "C";
  };
}

/**
 * `average_cadence_spm` is `null` for anything but a step-cadence type: the
 * field is always in steps/min, and a non-step-cadence type's raw rate would
 * otherwise be mislabelled as one (a swim's `average_cadence` is a stroke
 * rate, not steps/min). Rounds to a whole step. Wraps the shared
 * `cadenceSpm` (`utils/running.ts`), which itself only decides raw vs.
 * doubled by type; the null-for-non-step-cadence-types gate is specific to
 * this field's fixed "spm" unit, so it stays here rather than in the shared
 * helper (get-activity-streams' cadence stream wants the raw, un-nulled rate
 * for a non-step-cadence type instead).
 */
function activityCadenceSpm(
  rawCadence: number | null | undefined,
  type: string,
): number | null {
  if (!isStepCadenceActivity(type)) return null;
  const spm = cadenceSpm(rawCadence, type);
  return spm == null ? null : Math.round(spm);
}

/**
 * `sportSettings` only applies to this activity's `hr_zones` when its
 * `types` list actually names the activity's type: `get-activity` always
 * fetches the *Run* sport settings group (`types` on this athlete is
 * `["Run","VirtualRun","TrailRun"]`), but a Walk or Hike is a different
 * settings group with its own zone bounds and zone count (this tool does not
 * fetch that group), and a non-step-cadence type's zone count need not even
 * match (7 zones for WeightTraining on this athlete, not the Run group's 5).
 * Applying the Run group's bounds to any activity type it doesn't cover
 * would mislabel the athlete's own recorded zone times under the wrong
 * boundaries. `hr_zones` degrades to `[]` whenever the settings group's
 * `types` doesn't name this activity's type, the same degrade as settings
 * being entirely unavailable.
 */
function buildHrZones(
  sportSettings: IntervalsSportSettings | null,
  type: string,
  hrZoneTimes: number[] | null | undefined,
): HrZoneEntry[] {
  if (!sportSettings?.types?.includes(type)) return [];

  const hrZoneBounds = sportSettings.hr_zones;
  if (!hrZoneBounds || hrZoneBounds.length === 0) return [];
  if (!hrZoneTimes || hrZoneTimes.length === 0) return [];

  return hrZoneBounds.map((maxBpm, i) => ({
    zone: i + 1,
    min_bpm: i === 0 ? 0 : (hrZoneBounds[i - 1] ?? null),
    max_bpm: maxBpm,
    seconds: hrZoneTimes[i] ?? 0,
  }));
}

function buildRunningDynamics(
  a: IntervalsActivity,
  type: string,
): RunningDynamics | null {
  if (!isStepCadenceActivity(type) || a.average_stance_time == null)
    return null;
  return {
    stance_time_ms:
      a.average_stance_time == null ? null : round(a.average_stance_time),
    vertical_oscillation_mm:
      a.average_vertical_oscillation == null
        ? null
        : round(a.average_vertical_oscillation),
    vertical_ratio_pct:
      a.average_vertical_ratio == null
        ? null
        : round(a.average_vertical_ratio, 1),
    step_length_mm:
      a.average_step_length == null ? null : round(a.average_step_length),
    stride_m: a.average_stride == null ? null : round(a.average_stride, 2),
  };
}

function mapInterval(
  interval: IntervalsInterval,
  type: string,
): ActivityIntervalEntry {
  return {
    type: interval.type ?? null,
    label: interval.label ?? null,
    distance_km:
      interval.distance != null ? round(interval.distance / 1000, 2) : null,
    moving_time_s: interval.moving_time ?? null,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(interval.distance, interval.moving_time)
      : null,
    average_hr: interval.average_heartrate ?? null,
    average_cadence_spm: activityCadenceSpm(interval.average_cadence, type),
    stance_time_ms:
      interval.average_stance_time == null
        ? null
        : round(interval.average_stance_time),
    vertical_oscillation_mm:
      interval.average_vertical_oscillation == null
        ? null
        : round(interval.average_vertical_oscillation),
    step_length_mm:
      interval.average_step_length == null
        ? null
        : round(interval.average_step_length),
  };
}

/**
 * Maps one raw intervals.icu activity (optionally with `icu_intervals`
 * populated) plus the athlete's Run sport settings into the compact detail
 * view. `sportSettings` is `null` for a non-step-cadence activity, or when
 * the settings fetch failed; `hr_zones` further degrades to `[]` (see
 * `buildHrZones`) unless the fetched settings group's `types` actually names
 * this activity's type, since the Run group's bounds do not apply to every
 * step-cadence type (a Walk or Hike uses a different settings group this
 * tool does not fetch). Exported for direct testing.
 */
export function mapActivityDetail(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
): ActivityDetail {
  const type = activity.type ?? "Workout";
  const movingTimeS = activity.moving_time ?? 0;

  const distanceKm =
    activity.distance != null && activity.distance > 0
      ? round(activity.distance / 1000, 2)
      : null;

  const intervals =
    activity.icu_intervals && activity.icu_intervals.length > 0
      ? activity.icu_intervals.map((iv) => mapInterval(iv, type))
      : null;

  return {
    id: activity.id,
    name: activity.name ?? type,
    type,
    date: activity.start_date_local.split("T")[0] ?? activity.start_date_local,
    start_local: activity.start_date_local,
    source: activity.source ?? null,
    is_strava_stub: activity.source === "STRAVA",
    device: activity.device_name ?? null,
    distance_km: distanceKm,
    moving_time_s: movingTimeS,
    moving_time: formatDuration(movingTimeS),
    elapsed_time_s: activity.elapsed_time ?? null,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(activity.distance, activity.moving_time)
      : null,
    gap_min_per_km: gapPace(activity.gap, type),
    average_hr: activity.average_heartrate ?? null,
    max_hr: activity.max_heartrate ?? null,
    average_cadence_spm: activityCadenceSpm(activity.average_cadence, type),
    elevation_gain_m:
      activity.total_elevation_gain == null
        ? null
        : round(activity.total_elevation_gain),
    load: {
      training_load: activity.icu_training_load ?? null,
      hr_load: activity.hr_load ?? null,
      pace_load: activity.pace_load ?? null,
      trimp: activity.trimp == null ? null : round(activity.trimp, 1),
      intensity:
        activity.icu_intensity == null
          ? null
          : round(activity.icu_intensity, 1),
    },
    decoupling_pct:
      activity.decoupling == null ? null : round(activity.decoupling, 1),
    efficiency_factor:
      activity.icu_efficiency_factor == null
        ? null
        : round(activity.icu_efficiency_factor, 2),
    rpe: activity.icu_rpe ?? null,
    feel: activity.feel ?? null,
    hr_zones: buildHrZones(sportSettings, type, activity.icu_hr_zone_times),
    pace_zone_seconds: activity.pace_zone_times ?? null,
    running_dynamics: buildRunningDynamics(activity, type),
    intervals,
    gear_id: activity.gear?.id ?? null,
    gear_name: activity.gear?.name ?? null,
    weather_temp_c: activity.average_weather_temp ?? null,
    description: activity.description ?? null,
    units: {
      distance: "km",
      pace: "min/km",
      time: "s",
      hr: "bpm",
      elevation: "m",
      cadence: "spm",
      temp: "C",
    },
  };
}

function formatMetricsLine(d: ActivityDetail): string {
  const parts: string[] = [];
  if (d.distance_km != null) parts.push(`${d.distance_km.toFixed(2)} km`);
  parts.push(d.moving_time);
  if (d.pace_min_per_km != null) parts.push(`${d.pace_min_per_km} /km`);
  if (d.gap_min_per_km != null) parts.push(`GAP ${d.gap_min_per_km} /km`);
  if (d.average_hr != null) {
    const max = d.max_hr != null ? `/${Math.round(d.max_hr)}` : "";
    parts.push(`HR ${Math.round(d.average_hr)}${max}`);
  }
  if (d.average_cadence_spm != null)
    parts.push(`cadence ${d.average_cadence_spm} spm`);
  if (d.elevation_gain_m != null)
    parts.push(`+${Math.round(d.elevation_gain_m)} m`);
  return parts.join(", ");
}

function formatLoadLine(d: ActivityDetail): string | null {
  const parts: string[] = [];
  if (d.load.training_load != null)
    parts.push(`load ${Math.round(d.load.training_load)}`);
  if (d.load.hr_load != null)
    parts.push(`hr load ${Math.round(d.load.hr_load)}`);
  if (d.load.pace_load != null)
    parts.push(`pace load ${Math.round(d.load.pace_load)}`);
  if (d.load.trimp != null) parts.push(`TRIMP ${d.load.trimp}`);
  if (d.load.intensity != null) parts.push(`intensity ${d.load.intensity}%`);
  if (d.decoupling_pct != null) parts.push(`decoupling ${d.decoupling_pct}%`);
  if (d.efficiency_factor != null) parts.push(`EF ${d.efficiency_factor}`);
  if (d.rpe != null) parts.push(`RPE ${d.rpe}`);
  if (d.feel != null) parts.push(`feel ${d.feel}`);
  if (parts.length === 0) return null;
  return `Load: ${parts.join(", ")}`;
}

function formatDynamicsLine(d: ActivityDetail): string | null {
  const dyn = d.running_dynamics;
  if (!dyn) return null;
  const parts: string[] = [];
  if (dyn.stance_time_ms != null) parts.push(`GCT ${dyn.stance_time_ms} ms`);
  if (dyn.vertical_oscillation_mm != null)
    parts.push(`VO ${dyn.vertical_oscillation_mm} mm`);
  if (dyn.vertical_ratio_pct != null)
    parts.push(`VR ${dyn.vertical_ratio_pct}%`);
  if (dyn.step_length_mm != null) parts.push(`step ${dyn.step_length_mm} mm`);
  if (dyn.stride_m != null) parts.push(`stride ${dyn.stride_m} m`);
  if (parts.length === 0) return null;
  return `Dynamics: ${parts.join(", ")}`;
}

function formatZonesLine(d: ActivityDetail): string | null {
  if (d.hr_zones.length === 0) return null;
  const zones = d.hr_zones
    .map((z) => {
      const range =
        z.min_bpm != null ? `${z.min_bpm}-${z.max_bpm}` : `<=${z.max_bpm}`;
      return `Z${z.zone} ${range} ${formatDuration(z.seconds)}`;
    })
    .join(", ");
  return `HR zones: ${zones}`;
}

function formatGearLine(d: ActivityDetail): string | null {
  if (!d.gear_id) return null;
  return d.gear_name
    ? `Gear: ${d.gear_name} [${d.gear_id}]`
    : `Gear: ${d.gear_id}`;
}

/** Truncates `text` to `DESCRIPTION_MAX_CHARS`, appending `ELLIPSIS` when it was cut. */
function truncateDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  return `${text.slice(0, DESCRIPTION_MAX_CHARS)}${ELLIPSIS}`;
}

function formatIntervalLine(entry: ActivityIntervalEntry, i: number): string {
  const parts: string[] = [];
  if (entry.distance_km != null)
    parts.push(`${entry.distance_km.toFixed(2)} km`);
  if (entry.moving_time_s != null)
    parts.push(formatDuration(entry.moving_time_s));
  if (entry.pace_min_per_km != null) parts.push(`${entry.pace_min_per_km} /km`);
  if (entry.average_hr != null)
    parts.push(`HR ${Math.round(entry.average_hr)}`);
  if (entry.average_cadence_spm != null)
    parts.push(`cadence ${entry.average_cadence_spm} spm`);
  const label = entry.label ?? entry.type ?? "interval";
  return `${i + 1}. ${label}: ${parts.join(", ")}`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatActivityDetailText(d: ActivityDetail): string {
  const lines = [`${d.date} ${d.type} ${d.name} [${d.id}]`];
  if (d.is_strava_stub) lines.push(STRAVA_STUB_NOTE);

  lines.push(formatMetricsLine(d));

  const loadLine = formatLoadLine(d);
  if (loadLine) lines.push(loadLine);

  const dynamicsLine = formatDynamicsLine(d);
  if (dynamicsLine) lines.push(dynamicsLine);

  const zonesLine = formatZonesLine(d);
  if (zonesLine) lines.push(zonesLine);

  const gearLine = formatGearLine(d);
  if (gearLine) lines.push(gearLine);

  if (d.description) {
    lines.push(`Description: ${truncateDescription(d.description)}`);
  }

  if (d.intervals && d.intervals.length > 0) {
    lines.push("Intervals:");
    const shown = d.intervals.slice(0, MAX_INTERVAL_LINES);
    for (const [i, entry] of shown.entries())
      lines.push(formatIntervalLine(entry, i));
    const remaining = d.intervals.length - shown.length;
    if (remaining > 0) lines.push(`(${remaining} more)`);
  }

  return lines.join("\n");
}

export const getActivityTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: ActivityDetailOutputSchema,
  execute: async (
    { id, includeIntervals }: GetActivityInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      // getActivity and getSportSettings("Run") are independent requests,
      // fired concurrently rather than gating the sport-settings fetch on
      // first learning the activity's type from the activity response.
      // getSportSettings is a nice-to-have (HR zone labels): its result is
      // used only when the fetched activity turns out to be a run type, and
      // a failure here (including "not configured") degrades to `hr_zones:
      // []` rather than failing the call; only a genuine failure fetching
      // the activity itself does that.
      const [activity, sportSettingsResult] = await Promise.all([
        getActivityClient(apiKey, id, { intervals: includeIntervals }),
        getSportSettings(apiKey, "Run").catch(
          (): IntervalsSportSettings | null => null,
        ),
      ]);

      const type = activity.type ?? "Workout";
      const sportSettings = isStepCadenceActivity(type)
        ? sportSettingsResult
        : null;

      const detail = mapActivityDetail(activity, sportSettings);
      warnOnSchemaDrift(name, ActivityDetailOutputSchema, detail);

      return {
        content: [
          { type: "text" as const, text: formatActivityDetailText(detail) },
        ],
        structuredContent: detail,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
