import { z } from "zod";
import {
  type Achievement,
  formatAchievement,
  mapAchievements,
} from "../achievements";
import { hrZoneRangeText, resolveHrZones } from "../activityZones";
import {
  formatDuration,
  formatFeel,
  round,
  STRAVA_STUB_NOTE,
} from "../formatters";
import { SWIM_INTERVAL_PACE_NOTE } from "../intervalLaps";
import {
  getActivity as getActivityClient,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsInterval,
  type IntervalsSportSettings,
  listGear,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { findGear } from "../utils/activityWrite";
import {
  activityCadenceSpm,
  buildRunningDynamics,
  gapPace,
  isPaceActivity,
  isStepCadenceActivity,
  paceFromDistanceTime,
  type RunningDynamicsAvg,
  sportSpeed,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { ActivityDetailOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-activity";

const description = `
Returns one intervals.icu activity in detail: core metrics, training load, HR
time in zone, running-dynamics averages, each WORK/RECOVERY interval, gear
name, description, heart-rate recovery, and any best or threshold rise
intervals.icu marked on it. Works for any sport: runs show pace per km, swims
pace per 100 m, other sports speed in km/h. Use it after list-activities.

For a run, prefer get-running-summary: the same detail plus cadence, HR zone
and dynamics assessments and a lap table, in one call. Use get-activity-laps
for lap GAP, power or elevation, and the analysis tools (get-split-analysis,
get-hill-analysis, get-interval-analysis, get-aerobic-analysis) for deeper
questions. For best times across all runs, use get-best-efforts.

Notes:
- HR zones use the activity's own recorded bounds, else the Run sport
  settings when they cover this type; hr_zones is empty when neither applies.
- Running dynamics (ground contact time, vertical oscillation, step length)
  show for runs, walks and hikes only. A swim's stroke data is not a step,
  so it is left out.
- A swim interval's pace includes the rests inside it, so it can be slower
  than the activity's pace.
- achievements lists only what intervals.icu marked on this activity. Only
  threshold rises (LTHR_UP) have been seen: an estimate from this effort,
  which may not be in the sport settings. An empty list does not prove there
  was no best. For a run PB, use get-best-efforts.
- The text cuts the description at 200 characters; structuredContent has it
  in full.
- An activity synced from Strava (source STRAVA) is a stub with no detail.
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

interface HrRecovery {
  drop_bpm: number;
  start_bpm: number;
  end_bpm: number;
  window_s: number | null;
  start_time_s: number | null;
}

interface ActivityIntervalEntry {
  type: string | null;
  label: string | null;
  distance_km: number | null;
  moving_time_s: number | null;
  pace_min_per_km: string | null;
  pace_min_per_100m: string | null;
  speed_kmh: number | null;
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
  /** From `sportSpeed`: swims only. */
  pace_min_per_100m: string | null;
  /** From `sportSpeed`: every type that is neither a run nor a swim. */
  speed_kmh: number | null;
  gap_min_per_km: string | null;
  /** GAP here always comes from intervals.icu's own recorded `gap` field,
   * distinct from get-hill-analysis/get-split-analysis's locally-modelled
   * GAP (their `gap_source: "model"`). */
  gap_source: "intervals.icu";
  average_hr: number | null;
  max_hr: number | null;
  average_cadence_spm: number | null;
  elevation_gain_m: number | null;
  /** Pool swims only. */
  pool_length_m: number | null;
  lengths: number | null;
  load: ActivityLoad;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
  rpe: number | null;
  feel: number | null;
  achievements: Achievement[];
  hr_recovery: HrRecovery | null;
  hr_zones: HrZoneEntry[];
  pace_zone_seconds: number[] | null;
  running_dynamics: RunningDynamicsAvg | null;
  intervals: ActivityIntervalEntry[] | null;
  gear_id: string | null;
  /**
   * From the athlete's gear list (`resolveActivityGearName`): the activity
   * sends only the gear id (docs/api-notes.md). Null when there is no gear
   * or the read fails.
   */
  gear_name: string | null;
  weather_temp_c: number | null;
  description: string | null;
  units: {
    distance: "km";
    pace: "min/km";
    swim_pace: "min/100m";
    speed: "km/h";
    time: "s";
    hr: "bpm";
    elevation: "m";
    cadence: "spm";
    temp: "C";
  };
}

/**
 * `hr_zones` from `resolveHrZones` (the activity's own bounds, else the Run
 * sport settings group when it covers this type), shared with
 * `get-running-summary`. `[]` when neither source is usable, rather than
 * mislabelling the athlete's own recorded zone times under the wrong bounds.
 */
function buildHrZones(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  type: string,
): HrZoneEntry[] {
  const { set } = resolveHrZones(activity, sportSettings, type);
  return (
    set?.buckets.map((bucket) => ({
      zone: bucket.zone,
      min_bpm: bucket.min,
      max_bpm: bucket.max,
      seconds: bucket.seconds,
    })) ?? []
  );
}

function mapInterval(
  interval: IntervalsInterval,
  type: string,
): ActivityIntervalEntry {
  const speed = sportSpeed(type, interval.distance, interval.moving_time);
  // A swim's step length is not a step (docs/api-notes.md): step-based
  // fields only for a step-cadence type, as buildRunningDynamics does for
  // the whole activity.
  const steps = isStepCadenceActivity(type);
  return {
    type: interval.type ?? null,
    label: interval.label ?? null,
    distance_km:
      interval.distance != null ? round(interval.distance / 1000, 2) : null,
    moving_time_s: interval.moving_time ?? null,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(interval.distance, interval.moving_time)
      : null,
    pace_min_per_100m: speed.pace_min_per_100m,
    speed_kmh: speed.speed_kmh,
    average_hr: interval.average_heartrate ?? null,
    average_cadence_spm: activityCadenceSpm(interval.average_cadence, type),
    stance_time_ms:
      !steps || interval.average_stance_time == null
        ? null
        : round(interval.average_stance_time),
    vertical_oscillation_mm:
      !steps || interval.average_vertical_oscillation == null
        ? null
        : round(interval.average_vertical_oscillation),
    step_length_mm:
      !steps || interval.average_step_length == null
        ? null
        : round(interval.average_step_length),
  };
}

/**
 * intervals.icu's `icu_hrr` as the tools report it. Null when there is none
 * or a bpm is missing. `drop_bpm` is intervals.icu's own `hrr`, which equals
 * `start_bpm - end_bpm` on every activity checked (docs/api-notes.md).
 */
function mapHrRecovery(hrr: IntervalsActivity["icu_hrr"]): HrRecovery | null {
  if (hrr?.start_bpm == null || hrr.end_bpm == null) return null;
  return {
    drop_bpm: hrr.hrr ?? hrr.start_bpm - hrr.end_bpm,
    start_bpm: hrr.start_bpm,
    end_bpm: hrr.end_bpm,
    window_s:
      hrr.start_time != null && hrr.end_time != null
        ? hrr.end_time - hrr.start_time
        : null,
    start_time_s: hrr.start_time ?? null,
  };
}

/**
 * The activity's gear name. The activity sends only the gear id
 * (`gear.name` is null, docs/api-notes.md), so this reads the athlete's
 * gear list through the response cache (10 minutes, shared with list-gear)
 * and matches the id. When the id is not in the cached list, it reads the
 * list once more past the cache: gear added in the last 10 minutes is not
 * in the cached copy, and a `skipCache` read (update-activity's) does not
 * refresh it. Null when the activity has no gear, the id is not in the
 * list, the item belongs to another athlete, or a read fails: the name is a
 * nice-to-have and never fails the call. It reads nothing when the activity
 * has no gear or already names it. Shared by get-activity and
 * get-running-summary.
 */
export async function resolveActivityGearName(
  apiKey: string,
  activity: IntervalsActivity,
): Promise<string | null> {
  const ref = activity.gear;
  if (!ref?.id) return null;
  if (ref.name) return ref.name;
  try {
    const item =
      findGear(ref.id, await listGear(apiKey)) ??
      findGear(ref.id, await listGear(apiKey, { skipCache: true }));
    if (!item) return null;
    // `/activity/{id}` is not athlete-scoped, so the key's own gear list
    // must not name another athlete's gear (docs/api-notes.md).
    if (
      item.athlete_id &&
      activity.icu_athlete_id &&
      item.athlete_id !== activity.icu_athlete_id
    )
      return null;
    return item.name ?? null;
  } catch (error) {
    console.error(
      `Gear name for activity ${activity.id} not read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Maps one raw intervals.icu activity (optionally with `icu_intervals`
 * populated) plus the athlete's Run sport settings into the compact detail
 * view. `sportSettings` is `null` for a non-step-cadence activity, or when
 * the settings fetch failed; `hr_zones` further degrades to `[]` (see
 * `buildHrZones`) unless the fetched settings group's `types` actually names
 * this activity's type, since the Run group's bounds do not apply to every
 * step-cadence type (a Walk or Hike uses a different settings group this
 * tool does not fetch). `gearName` comes from `resolveActivityGearName`;
 * it defaults to the payload's own `gear.name`. Exported for direct testing.
 */
export function mapActivityDetail(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  gearName: string | null = activity.gear?.name ?? null,
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

  const speed = sportSpeed(type, activity.distance, activity.moving_time);

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
    pace_min_per_100m: speed.pace_min_per_100m,
    speed_kmh: speed.speed_kmh,
    gap_min_per_km: gapPace(activity.gap, type),
    gap_source: "intervals.icu",
    average_hr: activity.average_heartrate ?? null,
    max_hr: activity.max_heartrate ?? null,
    average_cadence_spm: activityCadenceSpm(activity.average_cadence, type),
    elevation_gain_m:
      activity.total_elevation_gain == null
        ? null
        : round(activity.total_elevation_gain),
    pool_length_m: activity.pool_length ?? null,
    lengths: activity.lengths ?? null,
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
    achievements: mapAchievements(activity.icu_achievements),
    hr_recovery: mapHrRecovery(activity.icu_hrr),
    hr_zones: buildHrZones(activity, sportSettings, type),
    pace_zone_seconds: activity.pace_zone_times ?? null,
    running_dynamics: buildRunningDynamics(activity, type),
    intervals,
    gear_id: activity.gear?.id ?? null,
    gear_name: gearName,
    weather_temp_c: activity.average_weather_temp ?? null,
    description: activity.description ?? null,
    units: {
      distance: "km",
      pace: "min/km",
      swim_pace: "min/100m",
      speed: "km/h",
      time: "s",
      hr: "bpm",
      elevation: "m",
      cadence: "spm",
      temp: "C",
    },
  };
}

/** Exported for reuse by get-running-summary, which composes its own text response from the same building blocks. */
export function formatMetricsLine(
  d: Omit<ActivityDetail, "intervals">,
): string {
  const parts: string[] = [];
  if (d.distance_km != null) parts.push(`${d.distance_km.toFixed(2)} km`);
  parts.push(d.moving_time);
  if (d.pace_min_per_km != null) parts.push(`${d.pace_min_per_km} /km`);
  if (d.gap_min_per_km != null) parts.push(`GAP ${d.gap_min_per_km} /km`);
  if (d.pace_min_per_100m != null) parts.push(`${d.pace_min_per_100m} /100m`);
  if (d.speed_kmh != null) parts.push(`${d.speed_kmh} km/h`);
  if (d.lengths != null && d.pool_length_m != null)
    parts.push(`${d.lengths} lengths of ${d.pool_length_m} m`);
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

/** The achievements line, or null when there are none. Exported for reuse by get-running-summary. */
export function formatAchievementsLine(
  d: Pick<ActivityDetail, "achievements" | "type">,
): string | null {
  if (d.achievements.length === 0) return null;
  return `Achievements: ${d.achievements.map((a) => formatAchievement(a, d.type)).join("; ")}`;
}

/** The HR recovery line, or null when there is none. Exported for reuse by get-running-summary. */
export function formatHrRecoveryLine(
  d: Pick<ActivityDetail, "hr_recovery">,
): string | null {
  const hrr = d.hr_recovery;
  if (!hrr) return null;
  const window = hrr.window_s != null ? ` in ${hrr.window_s} s` : "";
  const from =
    hrr.start_time_s != null
      ? `, from ${formatDuration(hrr.start_time_s)}`
      : "";
  return `HR recovery: ${hrr.start_bpm} to ${hrr.end_bpm} bpm${window} (drop ${hrr.drop_bpm} bpm)${from}`;
}

/** Exported for reuse by get-running-summary. */
export function formatLoadLine(
  d: Omit<ActivityDetail, "intervals">,
): string | null {
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
  if (d.feel != null) parts.push(formatFeel(d.feel));
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
  // No "stride": stride_m is distance per step too (see RunningDynamicsAvg),
  // so printing both reads as two different measures.
  if (dyn.step_length_mm != null) parts.push(`step ${dyn.step_length_mm} mm`);
  if (parts.length === 0) return null;
  return `Dynamics: ${parts.join(", ")}`;
}

function formatZonesLine(d: ActivityDetail): string | null {
  if (d.hr_zones.length === 0) return null;
  const zones = d.hr_zones
    .map((z) => {
      const range =
        z.min_bpm != null && z.max_bpm != null
          ? hrZoneRangeText({ min: z.min_bpm, max: z.max_bpm })
          : `<=${z.max_bpm}`;
      return `Z${z.zone} ${range} ${formatDuration(z.seconds)}`;
    })
    .join(", ");
  return `HR zones: ${zones}`;
}

/** Exported for reuse by get-running-summary. */
export function formatGearLine(
  d: Omit<ActivityDetail, "intervals">,
): string | null {
  if (!d.gear_id) return null;
  return d.gear_name
    ? `Gear: ${d.gear_name} [${d.gear_id}]`
    : `Gear: ${d.gear_id}`;
}

/** Truncates `text` to `DESCRIPTION_MAX_CHARS`, appending `ELLIPSIS` when it was cut. Exported for reuse by get-running-summary. */
export function truncateDescription(text: string): string {
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
  if (entry.pace_min_per_100m != null)
    parts.push(`${entry.pace_min_per_100m} /100m`);
  if (entry.speed_kmh != null) parts.push(`${entry.speed_kmh} km/h`);
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

  const achievementsLine = formatAchievementsLine(d);
  if (achievementsLine) lines.push(achievementsLine);

  const loadLine = formatLoadLine(d);
  if (loadLine) lines.push(loadLine);

  const hrRecoveryLine = formatHrRecoveryLine(d);
  if (hrRecoveryLine) lines.push(hrRecoveryLine);

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
    lines.push(
      d.intervals.some((iv) => iv.pace_min_per_100m != null)
        ? `Intervals (${SWIM_INTERVAL_PACE_NOTE}):`
        : "Intervals:",
    );
    const shown = d.intervals.slice(0, MAX_INTERVAL_LINES);
    for (const [i, entry] of shown.entries())
      lines.push(formatIntervalLine(entry, i));
    const remaining = d.intervals.length - shown.length;
    if (remaining > 0)
      lines.push(
        `(${remaining} more: get-activity-laps lists all ${d.intervals.length})`,
      );
  }

  return lines.join("\n");
}

export const getActivityTool = {
  name,
  title: "Activity details",
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

      // The gear read waits for the activity on purpose: only the activity
      // names the gear id, and most activities have none, so a concurrent
      // read would cost a request on nearly every call. It never fails the
      // call, and the list is cached for 10 minutes.
      const gearName = await resolveActivityGearName(apiKey, activity);
      const detail = mapActivityDetail(activity, sportSettings, gearName);
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
