import { z } from "zod";
import {
  type ActivityWeather,
  formatWeatherLine,
  loadActivityWeather,
} from "../activityWeather";
import { hrZoneRangeText, resolveHrZones } from "../activityZones";
import { AerobicAnalysisError, interpretDecoupling } from "../aerobicAnalysis";
import {
  formatDuration,
  formatSigned,
  round,
  STRAVA_STUB_NOTE,
} from "../formatters";
import {
  formatLapLine,
  LAP_MOVING_TIME_NOTE,
  type LapEntry,
  mapIntervalsToLaps,
} from "../intervalLaps";
import {
  getActivity as getActivityClient,
  getSportSettings,
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "../intervalsClient";
import { IntervalsStreamsUnavailableError } from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  assessCadence,
  assessRunningDynamics,
  PACE_ACTIVITY_TYPES,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import {
  type ActivityDetail,
  formatAchievementsLine,
  formatGearLine,
  formatHrRecoveryLine,
  formatLoadLine,
  formatMetricsLine,
  mapActivityDetail,
  resolveActivityGearName,
  truncateDescription,
} from "./getActivity";
import {
  type StreamAerobicResult,
  streamAerobicAnalysis,
} from "./getAerobicAnalysis";
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
- When intervals.icu has no decoupling or efficiency factor, both are
  computed from the streams on the grade-adjusted basis and marked
  computed, as get-aerobic-analysis computes them.
- Weather: temperature, and humidity and dew point from the FIT file when
  it has them.
- HR zones use the activity's own bounds, else the Run sport settings; the
  zone summary is left out, with a note, when neither matches.
- The text lists at most 20 laps; get-activity-laps and structuredContent.laps
  have all of them.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetRunningSummaryInput = z.infer<typeof inputSchema>;

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
  /** Where `decoupling_pct` comes from; null when it is null. */
  decoupling_source: AerobicSource | null;
  /** Where `efficiency_factor` comes from; null when it is null. */
  efficiency_factor_source: AerobicSource | null;
  /** The basis of the computed values ("pace" without elevation data). */
  aerobic_basis: "gap" | "pace" | null;
  /** Why a missing value was not computed, or a warning on a computed one. */
  aerobic_note: string | null;
  cadence_assessment: string | null;
  hr_zone_summary: HrZoneSummary | null;
  hr_zone_note: string | null;
  dynamics_assessment: DynamicsAssessment | null;
  laps: LapEntry[];
}

type AerobicSource = "intervals.icu" | "computed";

/**
 * The stream analysis behind a missing decoupling or efficiency factor:
 * `result` when it ran, `note` when the activity cannot be analysed (no
 * streams, no heart rate). Any other failure propagates, as the stream
 * loader's contract requires.
 */
export interface ComputedAerobic {
  result: StreamAerobicResult | null;
  note: string | null;
}

/**
 * Computes decoupling and efficiency factor from the streams on the gap
 * basis when intervals.icu has either one missing; null when it has both.
 */
async function computeMissingAerobic(
  apiKey: string,
  id: string,
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
): Promise<ComputedAerobic | null> {
  if (activity.decoupling != null && activity.icu_efficiency_factor != null)
    return null;
  try {
    return {
      result: await streamAerobicAnalysis(apiKey, id, activity, sportSettings, {
        basis: "gap",
      }),
      note: null,
    };
  } catch (error) {
    if (error instanceof IntervalsStreamsUnavailableError)
      return {
        result: null,
        note: "not computed: the activity has no streams",
      };
    if (error instanceof AerobicAnalysisError)
      return { result: null, note: `not computed: ${error.message}` };
    throw error;
  }
}

/**
 * The decoupling and efficiency factor fields: intervals.icu's own where it
 * has them, else the computed ones, each with its source.
 */
function aerobicFields(
  detail: Pick<ActivityDetail, "decoupling_pct" | "efficiency_factor">,
  computed: ComputedAerobic | null,
): Pick<
  RunningSummary,
  | "decoupling_pct"
  | "decoupling_source"
  | "efficiency_factor"
  | "efficiency_factor_source"
  | "aerobic_basis"
  | "aerobic_note"
> {
  const result = computed?.result ?? null;
  const decoupling =
    detail.decoupling_pct ??
    (result ? round(result.analysis.decouplingPct, 1) : null);
  const efficiency =
    detail.efficiency_factor ??
    (result ? round(result.analysis.efficiencyFactor, 3) : null);
  const usedComputed =
    result !== null &&
    (detail.decoupling_pct == null || detail.efficiency_factor == null);
  const warnings = result
    ? [...result.warnings, ...result.analysis.warnings]
    : [];
  return {
    decoupling_pct: decoupling,
    decoupling_source:
      detail.decoupling_pct != null
        ? "intervals.icu"
        : decoupling != null
          ? "computed"
          : null,
    efficiency_factor: efficiency,
    efficiency_factor_source:
      detail.efficiency_factor != null
        ? "intervals.icu"
        : efficiency != null
          ? "computed"
          : null,
    aerobic_basis:
      usedComputed && result && result.basis !== "power" ? result.basis : null,
    aerobic_note:
      computed?.note ?? (warnings.length > 0 ? warnings.join(" ") : null),
  };
}

/**
 * HR zone summary from `resolveHrZones`, the bounds `get-activity`'s
 * `hr_zones` use too; only the output shape differs (adds `source` and
 * per-zone `percent`). No summary, with the resolver's note, when no bounds
 * match the recorded zone times.
 */
function buildHrZoneSummary(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  type: string,
): { summary: HrZoneSummary | null; note: string | null } {
  const { set, source, note } = resolveHrZones(activity, sportSettings, type);
  if (!set) return { summary: null, note };
  return {
    summary: {
      source,
      total_seconds: set.totalSeconds,
      zones: set.buckets.map((bucket) => ({
        zone: bucket.zone,
        min_bpm: bucket.min,
        max_bpm: bucket.max,
        seconds: bucket.seconds,
        percent: bucket.pct,
      })),
    },
    note: null,
  };
}

/**
 * Maps one raw intervals.icu activity (with `icu_intervals` populated) plus
 * the athlete's Run sport settings into the running summary: get-activity's
 * `mapActivityDetail` plus run-specific assessments and laps. `gearName` is
 * passed on to `mapActivityDetail` (from `resolveActivityGearName`).
 * Exported for direct testing.
 */
export function mapRunningSummary(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  gearName: string | null = activity.gear?.name ?? null,
  computedAerobic: ComputedAerobic | null = null,
  weather?: ActivityWeather | null,
): RunningSummary {
  const type = activity.type ?? "Workout";
  // `intervals` is dropped: `laps` below carries the same icu_intervals
  // breakdown in the shape this tool wants, and shipping both duplicates it.
  const { intervals: _intervals, ...detail } = mapActivityDetail(
    activity,
    sportSettings,
    gearName,
    weather,
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
    ...aerobicFields(detail, computedAerobic),
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
              ? hrZoneRangeText({ min: z.min_bpm, max: z.max_bpm })
              : `<=${z.max_bpm}`;
        return `Z${z.zone} ${range} ${formatDuration(z.seconds)} (${z.percent}%)`;
      })
      .join(", ");
    return `HR zones: ${zones}`;
  }
  if (d.hr_zone_note) return `HR zones: ${d.hr_zone_note}`;
  return null;
}

const BASIS_TEXT: Record<"gap" | "pace", string> = {
  gap: "grade-adjusted",
  pace: "raw pace, no elevation data",
};

/**
 * The computed decoupling and efficiency factor, on their own line so they
 * never read as intervals.icu's (the load line has those), or why a missing
 * one was not computed. Null when intervals.icu has both.
 */
function formatComputedAerobicLine(d: RunningSummary): string | null {
  const parts: string[] = [];
  if (d.decoupling_source === "computed" && d.decoupling_pct != null)
    parts.push(
      `decoupling ${formatSigned(d.decoupling_pct, 1)}% (${interpretDecoupling(d.decoupling_pct).split(":")[0]})`,
    );
  if (d.efficiency_factor_source === "computed" && d.efficiency_factor != null)
    parts.push(`EF ${d.efficiency_factor} m/min per beat`);
  const note = d.aerobic_note ? ` Note: ${d.aerobic_note}` : "";
  if (parts.length === 0)
    return d.aerobic_note ? `Aerobic: ${d.aerobic_note}` : null;
  const basis = d.aerobic_basis ? `, ${BASIS_TEXT[d.aerobic_basis]}` : "";
  return `Aerobic (computed from the streams${basis}; intervals.icu has none): ${parts.join(", ")}.${note}`;
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

  const achievementsLine = formatAchievementsLine(d);
  if (achievementsLine) lines.push(achievementsLine);

  const loadLine = formatLoadLine(d);
  if (loadLine) lines.push(loadLine);

  const aerobicLine = formatComputedAerobicLine(d);
  if (aerobicLine) lines.push(aerobicLine);

  const hrRecoveryLine = formatHrRecoveryLine(d);
  if (hrRecoveryLine) lines.push(hrRecoveryLine);

  const weatherLine = formatWeatherLine(d.weather);
  if (weatherLine) lines.push(weatherLine);

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
    lines.push(`Laps (${LAP_MOVING_TIME_NOTE}):`);
    const shown = d.laps.slice(0, MAX_LAP_LINES);
    for (const lap of shown) lines.push(formatLapLine(lap, "spm"));
    const remaining = d.laps.length - shown.length;
    if (remaining > 0)
      lines.push(
        `(${remaining} more: get-activity-laps lists all ${d.laps.length})`,
      );
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
      // The one run-type set: runs are the types with a pace.
      if (!PACE_ACTIVITY_TYPES.has(type)) {
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

      // After the run-type check, so a rejected non-run sends no further
      // read. The streams are read only when intervals.icu lacks decoupling
      // or the efficiency factor.
      progress(
        `Reading gear, weather and streams for "${activity.name ?? id}"`,
      );
      const [gearName, computedAerobic, weather] = await Promise.all([
        resolveActivityGearName(apiKey, activity),
        computeMissingAerobic(apiKey, id, activity, sportSettingsResult),
        loadActivityWeather(apiKey, id, activity),
      ]);
      const summary = mapRunningSummary(
        activity,
        sportSettingsResult,
        gearName,
        computedAerobic,
        weather,
      );
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
