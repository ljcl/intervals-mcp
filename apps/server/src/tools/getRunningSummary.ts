import { z } from "zod";
import { hrZoneMismatchWarning, mapIntervalsZones } from "../activityZones";
import { formatDuration, round, STRAVA_STUB_NOTE } from "../formatters";
import { type LapEntry, mapIntervalsToLaps } from "../intervalLaps";
import {
  getActivity as getActivityClient,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { assessCadence } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import {
  type ActivityDetail,
  formatGearLine,
  formatLoadLine,
  formatMetricsLine,
  mapActivityDetail,
  truncateDescription,
} from "./getActivity";
import { RunningSummaryOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-running-summary";

const description = `
Returns a run-focused summary of one intervals.icu activity: get-activity's detail fields plus cadence, HR zone, and dynamics assessments and a lap breakdown.

A thin wrapper over get-activity's mapper (one activity fetch, plus the
athlete's Run sport settings) with running-specific additions: a cadence
assessment, an HR zone time/percent summary, ground contact time and
vertical oscillation assessments, and laps (from the interval breakdown, the
same source as get-activity-laps). No power fields.

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")

Notes:
- Only Run, TrailRun and VirtualRun are accepted; any other type returns an
  error naming the type and pointing to get-activity
- The HR zone summary prefers the activity's own recorded icu_hr_zones as
  zone bounds, falling back to the Run sport settings group when its types
  include this activity's type; it is omitted (with a note) when no bounds
  match the recorded zone time count
- The text response caps the lap list at 20 lines; structuredContent.laps
  always has the full list
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetRunningSummaryInput = z.infer<typeof inputSchema>;

/** Run types this tool covers; anything else is rejected in favour of get-activity. */
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

const MAX_LAP_LINES = 20;

interface HrZoneSummaryEntry {
  zone: number;
  min_bpm: number | null;
  max_bpm: number;
  seconds: number;
  percent: number;
}

interface HrZoneSummary {
  source: "activity" | "sport_settings";
  total_seconds: number;
  zones: HrZoneSummaryEntry[];
}

interface DynamicsAssessment {
  vertical_oscillation: string | null;
  ground_contact_time: string | null;
}

export interface RunningSummary extends ActivityDetail {
  cadence_assessment: string | null;
  hr_zone_summary: HrZoneSummary | null;
  hr_zone_note: string | null;
  dynamics_assessment: DynamicsAssessment | null;
  laps: LapEntry[];
}

/**
 * HR zone bounds for the zone summary, distinct from get-activity's
 * `hr_zones` only in output shape (adds `source` and per-zone `percent`):
 * both read the activity's own recorded `icu_hr_zones` through
 * `mapIntervalsZones` first, falling back to the Run sport settings group's
 * `hr_zones` only when the activity has no bounds of its own and its
 * `types` names this activity's type. Omits the summary (with an
 * explanatory note) whenever no bounds are available, or a bounds count
 * doesn't match the recorded zone time count, rather than mislabelling zone
 * times under the wrong boundaries.
 */
function buildHrZoneSummary(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  type: string,
): { summary: HrZoneSummary | null; note: string | null } {
  const times = activity.icu_hr_zone_times;
  if (!times || times.length === 0) return { summary: null, note: null };

  const hrSet = mapIntervalsZones(activity).find(
    (set) => set.type === "heartrate",
  );
  if (hrSet) {
    const zones = hrSet.buckets.map((bucket) => ({
      zone: bucket.zone,
      min_bpm: bucket.min,
      max_bpm: bucket.max ?? 0,
      seconds: bucket.seconds,
      percent: bucket.pct,
    }));
    return {
      summary: {
        source: "activity",
        total_seconds: hrSet.totalSeconds,
        zones,
      },
      note: null,
    };
  }

  // The activity carries its own bounds but `mapIntervalsZones` dropped
  // them (a bounds/times count mismatch, or nothing recorded): surface why
  // rather than silently falling through to sport settings, which would
  // mislabel these zone times under a different settings group's bounds.
  if (activity.icu_hr_zones && activity.icu_hr_zones.length > 0) {
    return {
      summary: null,
      note: hrZoneMismatchWarning(activity) ?? "No time recorded in HR zones.",
    };
  }

  const bounds =
    sportSettings?.types?.includes(type) &&
    sportSettings.hr_zones &&
    sportSettings.hr_zones.length > 0
      ? sportSettings.hr_zones
      : null;

  if (!bounds) {
    return {
      summary: null,
      note: "HR zone bounds are unavailable; recorded zone times could not be labelled.",
    };
  }

  if (bounds.length !== times.length) {
    return {
      summary: null,
      note: `HR zone bounds (${bounds.length} zones) do not match the recorded zone times (${times.length} zones); omitted.`,
    };
  }

  const totalSeconds = times.reduce((a, b) => a + (b ?? 0), 0);
  if (totalSeconds <= 0) {
    return { summary: null, note: "No time recorded in HR zones." };
  }

  const zones = bounds.map((maxBpm, i) => ({
    zone: i + 1,
    min_bpm: i === 0 ? 0 : (bounds[i - 1] ?? null),
    max_bpm: maxBpm,
    seconds: times[i] ?? 0,
    percent: round(((times[i] ?? 0) / totalSeconds) * 100, 1),
  }));

  return {
    summary: { source: "sport_settings", total_seconds: totalSeconds, zones },
    note: null,
  };
}

/** Vertical oscillation target from the spec: under 100 mm. */
function assessVerticalOscillation(voMm: number | null): string | null {
  if (voMm == null) return null;
  return voMm < 100
    ? "good - under the 100 mm target"
    : "high - above the 100 mm target";
}

/** Ground contact time target range from the spec: 200-260 ms. */
function assessGroundContactTime(gctMs: number | null): string | null {
  if (gctMs == null) return null;
  if (gctMs < 200) return "fast - below the 200-260 ms target range";
  if (gctMs <= 260) return "good - within the 200-260 ms target range";
  return "long - above the 200-260 ms target range";
}

/**
 * Maps one raw intervals.icu activity (with `icu_intervals` populated) plus
 * the athlete's Run sport settings into the running summary: get-activity's
 * `mapActivityDetail` plus run-specific assessments and laps. Exported for
 * direct testing.
 */
export function mapRunningSummary(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
): RunningSummary {
  const type = activity.type ?? "Workout";
  const detail = mapActivityDetail(activity, sportSettings);

  const { summary: hrZoneSummary, note: hrZoneNote } = buildHrZoneSummary(
    activity,
    sportSettings,
    type,
  );

  const dyn = detail.running_dynamics;
  const dynamicsAssessment: DynamicsAssessment | null = dyn
    ? {
        vertical_oscillation: assessVerticalOscillation(
          dyn.vertical_oscillation_mm,
        ),
        ground_contact_time: assessGroundContactTime(dyn.stance_time_ms),
      }
    : null;

  const laps =
    activity.icu_intervals && activity.icu_intervals.length > 0
      ? mapIntervalsToLaps(activity, activity.icu_intervals)
      : [];

  return {
    ...detail,
    cadence_assessment: assessCadence(detail.average_cadence_spm),
    hr_zone_summary: hrZoneSummary,
    hr_zone_note: hrZoneNote,
    dynamics_assessment: dynamicsAssessment,
    laps,
  };
}

function formatHrZoneSummaryLine(d: RunningSummary): string | null {
  if (d.hr_zone_summary) {
    const zones = d.hr_zone_summary.zones
      .map((z) => {
        const range =
          z.min_bpm != null ? `${z.min_bpm}-${z.max_bpm}` : `<=${z.max_bpm}`;
        return `Z${z.zone} ${range} ${formatDuration(z.seconds)} (${z.percent}%)`;
      })
      .join(", ");
    return `HR zones: ${zones}`;
  }
  if (d.hr_zone_note) return `HR zones: ${d.hr_zone_note}`;
  return null;
}

function formatDynamicsAssessmentLine(d: RunningSummary): string | null {
  if (!d.dynamics_assessment) return null;
  const parts: string[] = [];
  if (d.dynamics_assessment.vertical_oscillation)
    parts.push(`VO ${d.dynamics_assessment.vertical_oscillation}`);
  if (d.dynamics_assessment.ground_contact_time)
    parts.push(`GCT ${d.dynamics_assessment.ground_contact_time}`);
  if (parts.length === 0) return null;
  return `Dynamics assessment: ${parts.join("; ")}`;
}

function formatLapLine(lap: LapEntry): string {
  const parts: string[] = [];
  if (lap.distance_km != null) parts.push(`${lap.distance_km.toFixed(2)} km`);
  parts.push(lap.moving_time);
  if (lap.pace_min_per_km) parts.push(`${lap.pace_min_per_km} /km`);
  if (lap.gap_min_per_km) parts.push(`GAP ${lap.gap_min_per_km} /km`);
  if (lap.average_hr != null) {
    const max = lap.max_hr != null ? `/${Math.round(lap.max_hr)}` : "";
    parts.push(`HR ${Math.round(lap.average_hr)}${max}`);
  }
  if (lap.average_cadence != null)
    parts.push(`cadence ${lap.average_cadence} spm`);
  if (lap.elevation_gain_m != null && lap.elevation_gain_m > 0)
    parts.push(`+${Math.round(lap.elevation_gain_m)} m`);
  const label = lap.label ?? lap.type ?? "lap";
  return `${lap.lap_index}. ${label}: ${parts.join(", ")}`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatRunningSummaryText(d: RunningSummary): string {
  const lines = [`${d.date} ${d.type} ${d.name} [${d.id}]`];
  if (d.is_strava_stub) lines.push(STRAVA_STUB_NOTE);

  lines.push(formatMetricsLine(d));

  const loadLine = formatLoadLine(d);
  if (loadLine) lines.push(loadLine);

  if (d.cadence_assessment)
    lines.push(`Cadence assessment: ${d.cadence_assessment}`);

  const dynamicsLine = formatDynamicsAssessmentLine(d);
  if (dynamicsLine) lines.push(dynamicsLine);

  const hrZonesLine = formatHrZoneSummaryLine(d);
  if (hrZonesLine) lines.push(hrZonesLine);

  const gearLine = formatGearLine(d);
  if (gearLine) lines.push(gearLine);

  if (d.description) {
    lines.push(`Description: ${truncateDescription(d.description)}`);
  }

  if (d.laps.length > 0) {
    lines.push("Laps:");
    const shown = d.laps.slice(0, MAX_LAP_LINES);
    for (const lap of shown) lines.push(formatLapLine(lap));
    const remaining = d.laps.length - shown.length;
    if (remaining > 0) lines.push(`(${remaining} more)`);
  }

  return lines.join("\n");
}

export const getRunningSummaryTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: RunningSummaryOutputSchema,
  execute: async (
    { id }: GetRunningSummaryInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      // Same independent-fetch shape as get-activity: sport settings degrade
      // to null on failure rather than failing the call.
      const [activity, sportSettingsResult] = await Promise.all([
        getActivityClient(apiKey, id, { intervals: true }),
        getSportSettings(apiKey, "Run").catch(
          (): IntervalsSportSettings | null => null,
        ),
      ]);

      const type = activity.type ?? "Workout";
      if (!RUN_TYPES.has(type)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Activity "${activity.name ?? id}" [${id}] is a ${type}, not a run. get-running-summary covers Run, TrailRun and VirtualRun only; use get-activity for other activity types.`,
            },
          ],
          isError: true,
        };
      }

      const summary = mapRunningSummary(activity, sportSettingsResult);
      warnOnSchemaDrift(name, RunningSummaryOutputSchema, summary);

      return {
        content: [
          { type: "text" as const, text: formatRunningSummaryText(summary) },
        ],
        structuredContent: summary,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `summarise run ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
