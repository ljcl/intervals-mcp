import { z } from "zod";
import {
  buildZoneSet,
  hrZoneMismatchWarning,
  mapIntervalsZones,
} from "../activityZones";
import { formatDuration, STRAVA_STUB_NOTE } from "../formatters";
import {
  formatLapLine,
  type LapEntry,
  mapIntervalsToLaps,
} from "../intervalLaps";
import {
  getActivity as getActivityClient,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { assessCadence, assessRunningDynamics } from "../utils/running";
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
Returns a run-focused summary of one intervals.icu activity: get-activity's
detail plus a cadence assessment, HR zone time and percent, ground contact
time and vertical oscillation assessments, and the lap table. The best single
call for "how was my run?".

It already includes the laps and HR zone time, so skip get-activity-laps and
get-activity-zones. Use get-running-dynamics for per-interval dynamics, the
analysis tools (get-split-analysis, get-hill-analysis, get-interval-analysis,
get-aerobic-analysis) for deeper questions, and get-activity for other
sports.

Notes:
- Accepts Run, TrailRun and VirtualRun only; other types return an error
  that points to get-activity.
- HR zones use the activity's own bounds, else the Run sport settings; the
  zone summary is left out, with a note, when neither matches.
- The text lists at most 20 laps; structuredContent.laps has all of them.
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
  max_bpm: number | null;
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

/**
 * `ActivityDetail` minus `intervals`: `laps` (below, from the same
 * `icu_intervals`) replaces it rather than shipping the same interval
 * breakdown twice in different shapes.
 */
export interface RunningSummary extends Omit<ActivityDetail, "intervals"> {
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
      max_bpm: bucket.max,
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

  const fallback = buildZoneSet("heartrate", "bpm", bounds, times);
  if (!fallback) {
    return { summary: null, note: "No time recorded in HR zones." };
  }

  const zones = fallback.buckets.map((bucket) => ({
    zone: bucket.zone,
    min_bpm: bucket.min,
    max_bpm: bucket.max,
    seconds: bucket.seconds,
    percent: bucket.pct,
  }));

  return {
    summary: {
      source: "sport_settings",
      total_seconds: fallback.totalSeconds,
      zones,
    },
    note: null,
  };
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
  // `intervals` is dropped: `laps` below carries the same icu_intervals
  // breakdown in the shape this tool wants, and shipping both duplicates it.
  const { intervals: _intervals, ...detail } = mapActivityDetail(
    activity,
    sportSettings,
  );

  const { summary: hrZoneSummary, note: hrZoneNote } = buildHrZoneSummary(
    activity,
    sportSettings,
    type,
  );

  const dyn = detail.running_dynamics;
  const dynamicsAssessment: DynamicsAssessment | null = dyn
    ? (() => {
        const rd = assessRunningDynamics(
          dyn.vertical_oscillation_mm,
          dyn.stance_time_ms,
        );
        return {
          vertical_oscillation: rd.vertical_oscillation?.message ?? null,
          ground_contact_time: rd.ground_contact_time?.message ?? null,
        };
      })()
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
          z.max_bpm == null
            ? `${z.min_bpm}+`
            : z.min_bpm != null
              ? `${z.min_bpm}-${z.max_bpm}`
              : `<=${z.max_bpm}`;
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
    for (const lap of shown) lines.push(formatLapLine(lap, "spm"));
    const remaining = d.laps.length - shown.length;
    if (remaining > 0) lines.push(`(${remaining} more)`);
  }

  return lines.join("\n");
}

export const getRunningSummaryTool = {
  name,
  title: "Running summary",
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
